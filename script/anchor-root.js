// 현재 Root를 체인에 기록한다.
//
// 지금은 기준값 파일의 Root를 올린다. Registry가 붙으면 build/registry.json을 읽도록
// 바꾼다. TODO(백엔드)
//
// 실행: node script/anchor-root.js
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../app/config.js";
import { sha256Bytes32 } from "../app/lib/anchor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// 기본은 로컬이다. 공개망에 올릴 때는 ANCHOR_INFO로 배포 결과 파일을 지정한다.
//   ANCHOR_INFO=build/anchor.sepolia.example.json node script/anchor-root.js
const anchorInfo = JSON.parse(
  readFileSync(join(ROOT, process.env.ANCHOR_INFO ?? "build/anchor.json"), "utf8"),
);
const registry = JSON.parse(readFileSync(join(ROOT, "app", "fixtures", "registry.sample.json"), "utf8"));
const meta = JSON.parse(readFileSync(join(ROOT, "build", "circuit-meta.json"), "utf8"));

const DEV_KEY =
  process.env.ANCHOR_ISSUER_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

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
console.log(`유효기간 ${config.rootPeriodSeconds}초`);
