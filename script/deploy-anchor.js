// Anchor Contract를 올리고 수취은행 issuer를 등록한다.
//
// 로컬:
//   anvil                        (다른 터미널)
//   node script/deploy-anchor.js
//
// Sepolia:
//   ANCHOR_RPC_URL=https://... ANCHOR_ISSUER_KEY=0x... node script/deploy-anchor.js
//
// 로컬 배포 결과는 build/anchor.json, 그 밖의 망은 build/anchor.<host>.json에 적는다.
// 서버는 build/anchor.json만 읽으므로 공개망에 올려도 로컬 시연이 깨지지 않는다.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, env } from "../app/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = env("ANCHOR_RPC_URL", config.anchor.rpcUrl);

// anvil이 항상 같은 값으로 만들어 주는 첫 계정이다. 로컬 체인 밖에서는 쓰지 않는다.
const DEV_KEY = env(
  "ANCHOR_ISSUER_KEY",
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", cwd: ROOT }).trim();
}

const local = /^https?:\/\/(127\.0\.0\.1|localhost)\b/.test(RPC);
const fileName = local ? "anchor.json" : `anchor.${new URL(RPC).hostname}.json`;
const outFile = join(ROOT, "build", fileName);

// 공개망 배포 기록을 덮어쓰면 주소를 잃는다. 컨트랙트는 체인에 남는데 어디 있는지
// 모르게 되고, 가스도 다시 든다. .env에 공개망 RPC를 넣어 두면 이 스크립트를 무심코
// 다시 돌렸을 때 그렇게 된다. 실제로 한 번 그랬다.
if (!local && existsSync(outFile)) {
  console.error(`이미 ${new URL(RPC).hostname}에 배포한 기록이 있다: build/${fileName}`);
  console.error(JSON.parse(readFileSync(outFile, "utf8")).address);
  console.error("정말 새로 배포하려면 ANCHOR_REDEPLOY=1 을 붙여라.");
  if (!env("ANCHOR_REDEPLOY", "")) process.exit(1);
}

const created = run("forge", [
  "create",
  "src/EligibilityAnchor.sol:EligibilityAnchor",
  "--rpc-url",
  RPC,
  "--private-key",
  DEV_KEY,
  "--broadcast",
]);

const address = created.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)?.[1];
if (!address) throw new Error(`배포 주소를 못 읽었다:\n${created}`);

const bankId = run("cast", ["keccak", config.recipientBankId]);
const issuer = run("cast", ["wallet", "address", "--private-key", DEV_KEY]);

run("cast", [
  "send",
  address,
  "setIssuer(bytes32,address)",
  bankId,
  issuer,
  "--rpc-url",
  RPC,
  "--private-key",
  DEV_KEY,
]);

mkdirSync(join(ROOT, "build"), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify({ address, rpcUrl: RPC, bankId, issuer, bankName: config.recipientBankId }, null, 2) + "\n",
);

const deployTx = created.match(/Transaction hash:\s*(0x[0-9a-fA-F]{64})/)?.[1];
console.log(`Anchor Contract ${address}  (build/${fileName})`);
if (deployTx) console.log(`배포 tx ${deployTx}`);
console.log(`issuer ${issuer} (${config.recipientBankId} → ${bankId})`);
