// 현재 Root를 체인에 기록한다.
//
// Registry가 계좌 목록에서 만든 Root를 올린다. 수취은행 서버도 같은 입력으로 같은 트리를
// 만들므로, 서버를 켜기 전에 이걸 한 번 돌리면 체인과 서버의 Root가 맞는다.
//
// 실행: node script/anchor-root.js
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, env } from "../app/config.js";
import { sha256Bytes32 } from "../app/lib/anchor.js";
import { buildRegistry } from "../app/lib/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 기본은 로컬이다. 공개망에 올릴 때는 ANCHOR_INFO로 배포 결과 파일을 지정한다.
//   ANCHOR_INFO=build/anchor.sepolia.example.json node script/anchor-root.js
const anchorInfo = JSON.parse(
  readFileSync(join(ROOT, env("ANCHOR_INFO", "build/anchor.json")), "utf8"),
);
const accounts = JSON.parse(readFileSync(join(ROOT, "data", "accounts.json"), "utf8"));
const registry = await buildRegistry({ accounts });
const meta = JSON.parse(readFileSync(join(ROOT, "build", "circuit-meta.json"), "utf8"));

const DEV_KEY = env(
  "ANCHOR_ISSUER_KEY",
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", cwd: ROOT }).trim();
const rpc = anchorInfo.rpcUrl;

// epoch은 정확히 1씩 증가해야 한다. 현재 값을 읽어서 다음 값을 쓴다.
const latest = Number(
  run("cast", ["call", anchorInfo.address, "latestEpoch(bytes32)(uint64)", anchorInfo.bankId, "--rpc-url", rpc])
    .split(" ")[0],
);
const rootEpoch = latest + 1;
const validUntil = Math.floor(Date.now() / 1000) + config.rootPeriodSeconds;

run("cast", [
  "send",
  anchorInfo.address,
  "anchorRoot(bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64)",
  anchorInfo.bankId,
  registry.eligibilityRoot,
  registry.derived.policyHash,
  sha256Bytes32(meta.circuitId),
  meta.verifyingKeyHash,
  String(rootEpoch),
  String(validUntil),
  "--rpc-url",
  rpc,
  "--private-key",
  DEV_KEY,
]);

console.log(`rootEpoch ${rootEpoch} 기록`);
console.log(`root ${registry.eligibilityRoot}`);
console.log(`유효기간 ${config.rootPeriodSeconds}초, 트리 안 ${registry.inTreeCount}개`);
