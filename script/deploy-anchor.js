// 로컬 체인에 Anchor Contract를 올리고, 수취은행 issuer를 등록한다.
//
// 실행 전에 다른 터미널에서 anvil을 띄워 둔다.
//   anvil
//
// anvil이 찍어 주는 첫 번째 계정을 owner 겸 issuer로 쓴다. 로컬 전용 키다.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../app/config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.ANCHOR_RPC_URL || config.anchor.rpcUrl;

// anvil이 항상 같은 값으로 만들어 주는 첫 계정이다. 로컬 체인 밖에서는 쓰지 않는다.
const DEV_KEY =
  process.env.ANCHOR_ISSUER_KEY ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", cwd: ROOT }).trim();
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
  join(ROOT, "build", "anchor.json"),
  JSON.stringify({ address, rpcUrl: RPC, bankId, issuer, bankName: config.recipientBankId }, null, 2) + "\n",
);

console.log(`Anchor Contract ${address}`);
console.log(`issuer ${issuer} (${config.recipientBankId} → ${bankId})`);
