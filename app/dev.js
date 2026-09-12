// 세 서버를 한 번에 띄운다. 통합 담당이 매일 돌리는 진입점이다.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const APP = dirname(fileURLToPath(import.meta.url));

const servers = [
  ["recipient-bank", join(APP, "recipient-bank", "server.js")],
  ["verifier", join(APP, "verifier", "server.js")],
  ["sender-bank", join(APP, "sender-bank", "server.js")],
];

const children = servers.map(([name, entry]) => {
  const child = spawn(process.execPath, [entry], { stdio: "inherit" });
  child.on("exit", (code) => {
    console.error(`[dev] ${name} 종료 code=${code}`);
    shutdown(code ?? 1);
  });
  return child;
});

function shutdown(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

setTimeout(() => {
  console.log(`\n[dev] 화면: http://127.0.0.1:${config.ports.senderBank}\n`);
}, 400);
