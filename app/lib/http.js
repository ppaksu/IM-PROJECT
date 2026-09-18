// node:http 위의 얇은 라우팅 헬퍼. 의존성을 두지 않는다.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const MAX_BODY_BYTES = 1_000_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * routes: { "POST /경로": handler }
 * handler(body, req) 가 { status, body } 또는 평범한 객체를 돌려준다.
 * 경로 끝의 `*` 는 접두사 매칭이다.
 */
export function startServer({ name, port, routes, staticDir = null }) {
  const server = createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    const key = `${req.method} ${path}`;

    const send = (status, payload) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
      });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      return res.end();
    }

    let handler = routes[key];
    let wildcardSuffix = null;
    if (!handler) {
      for (const [pattern, fn] of Object.entries(routes)) {
        if (!pattern.endsWith("*")) continue;
        const [method, prefix] = pattern.slice(0, -1).split(" ");
        if (req.method === method && path.startsWith(prefix)) {
          handler = fn;
          wildcardSuffix = path.slice(prefix.length);
          break;
        }
      }
    }

    try {
      if (handler) {
        let body = {};
        if (req.method === "POST") {
          try {
            body = await readJsonBody(req);
          } catch {
            // 읽을 수 없는 본문은 우리 잘못이 아니다. 장애로 보이는 500을 주지 않는다.
            return send(400, { error: "bad request body" });
          }
        }
        const result = await handler(body, { req, suffix: wildcardSuffix });
        if (result && typeof result.status === "number" && "body" in result) {
          return send(result.status, result.body);
        }
        return send(200, result ?? {});
      }

      if (staticDir && req.method === "GET") {
        const file = path === "/" ? "/index.html" : path;
        if (file.includes("..")) return send(400, { error: "bad path" });
        try {
          const content = await readFile(staticDir + file);
          res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
          return res.end(content);
        } catch {
          /* 아래 404로 떨어진다 */
        }
      }

      return send(404, { error: "not found", path });
    } catch (error) {
      console.error(`[${name}] ${key} 실패:`, error.message);
      return send(500, { error: error.message });
    }
  });

  // 포트를 못 잡으면 Node가 스택 추적을 뱉는다. 원인은 대개 앞서 띄운 서버가 살아 있는
  // 것 하나뿐이라, 무엇을 하면 되는지 한 줄로 알려 준다.
  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[${name}] 포트 ${port}이 이미 쓰이고 있다. 먼저 띄운 서버를 끄고 다시 실행해라.`);
      console.error(`         pkill -f "app/dev.js"; pkill -f "app/.*/server.js"`);
      process.exit(1);
    }
    throw error;
  });

  server.listen(port, () => {
    console.log(`[${name}] http://127.0.0.1:${port}`);
  });
  return server;
}

export async function postJson(target, body) {
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
