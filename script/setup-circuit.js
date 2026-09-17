// 회로 빌드. 컴파일, Powers of Tau, Groth16 키 생성까지 한 번에 한다.
//
// 여기서 도는 ceremony는 이 기계 혼자 돌리는 개발용이다. 발표에 쓸 버전은 기존
// Powers of Tau 결과를 받아 phase 2만 우리가 기여하는 쪽으로 바꾼다.
//
// 산출물은 한 사람이 한 번 만들어 레포에 커밋한다. 각자 돌리면 검증키가 달라져서
// 한 사람이 만든 증명을 다른 사람이 검증할 때 실패한다. IM_PROJECT_PLAN.md 5.2
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../app/lib/field.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = join(ROOT, "build");
const CIRCUIT_ID = "eligible-account-v1";
const POWER = 13; // 2^13 = 8192. 회로 제약이 4511개라 여유가 있다.

function run(command, args) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd: ROOT });
}

const snarkjs = (args) => run("npx", ["--no-install", "snarkjs", ...args]);

mkdirSync(BUILD, { recursive: true });

run("circom", [
  join(ROOT, "circuits", "eligibility.circom"),
  "--r1cs",
  "--wasm",
  "--O2",
  "-l",
  join(ROOT, "node_modules", "circomlib", "circuits"),
  "-o",
  BUILD,
]);

const ptau = join(BUILD, `pot${POWER}_final.ptau`);
if (!existsSync(ptau)) {
  const start = join(BUILD, `pot${POWER}_0000.ptau`);
  const contributed = join(BUILD, `pot${POWER}_0001.ptau`);
  snarkjs(["powersoftau", "new", "bn128", String(POWER), start, "-v"]);
  snarkjs(["powersoftau", "contribute", start, contributed, "--name=dev", "-v", "-e=im-project-dev"]);
  snarkjs(["powersoftau", "prepare", "phase2", contributed, ptau, "-v"]);
}

const zkey0 = join(BUILD, "eligibility_0000.zkey");
const zkey = join(BUILD, "eligibility.zkey");
const vkey = join(BUILD, "eligibility.vkey.json");

snarkjs(["groth16", "setup", join(BUILD, "eligibility.r1cs"), ptau, zkey0]);
snarkjs(["zkey", "contribute", zkey0, zkey, "--name=dev", "-v", "-e=im-project-dev-phase2"]);
snarkjs(["zkey", "export", "verificationkey", zkey, vkey]);

// circuitId와 verifyingKeyHash는 검증자가 요청 봉투와 대조하고, Anchor Contract에도
// 같은 값이 올라간다. 계획서 4.4의 6단계와 9단계.
writeFileSync(
  join(BUILD, "circuit-meta.json"),
  JSON.stringify(
    {
      circuitId: CIRCUIT_ID,
      circuitIdHash: sha256Hex(CIRCUIT_ID),
      verifyingKeyHash: sha256Hex(readFileSync(vkey)),
      treeDepth: 16,
      builtAt: Math.floor(Date.now() / 1000),
    },
    null,
    2,
  ) + "\n",
);

console.log("\n회로 빌드 완료");
