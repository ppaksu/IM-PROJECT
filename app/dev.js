// 세 서버를 한 번에 띄운다. 통합 담당이 매일 돌리는 진입점이다.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { bankIdOf, latestAnchor } from "./lib/anchor.js";

const APP = dirname(fileURLToPath(import.meta.url));

// 체인이 없거나 Root가 없으면 화면이 "검증 불가"만 띄운다. 그건 설계대로 동작한 것이라
// 화면만 봐서는 고장인지 준비가 덜 된 것인지 알 수 없다. 여기서 먼저 알려 준다.
try {
  const anchor = latestAnchor(bankIdOf(config.recipientBankId));
  if (anchor.rootEpoch === 0) {
    console.error("[dev] 앵커된 Root가 없다. node script/anchor-root.js 를 먼저 실행해라.\n");
  } else {
    const left = anchor.validUntil - Math.floor(Date.now() / 1000);
    console.log(`[dev] rootEpoch ${anchor.rootEpoch}, 유효기간 ${left}초 남음`);
    if (left <= 0) {
      console.error("[dev] Root 유효기간이 지났다. 화면의 Root 재생성을 누르거나 앵커링을 다시 해라.\n");
    }
  }
} catch (error) {
  console.error("[dev] 체인을 못 읽는다. anvil과 배포부터 확인해라.");
  console.error("      anvil &");
  console.error("      node script/deploy-anchor.js && node script/anchor-root.js");
  console.error(`      (${error.message.split("\n")[0]})\n`);
}

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
