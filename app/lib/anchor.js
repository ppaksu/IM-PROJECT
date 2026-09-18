// Anchor Contract 조회. Foundry의 cast를 감싸서 web3 의존성을 두지 않는다.
//
// 조회가 실패하면 던진다. 검증자는 이것을 잡아 UNAVAILABLE로 답해야 한다.
// 체인을 못 읽은 것을 차단으로도, 허용으로도 바꾸면 안 된다. 계획서 4.3
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, env } from "../config.js";

function cast(args) {
  // stderr를 물려주지 않는다. 물려주면 체인이 죽었을 때 cast의 원문이 서버 로그에 그대로
  // 쏟아져, 우리가 붙인 안내가 묻힌다. 실패는 예외로만 알린다.
  return execFileSync("cast", args, {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** 은행 식별자 문자열의 keccak 해시. 컨트랙트의 bankId다. */
export function bankIdOf(name) {
  return cast(["keccak", name]);
}

/**
 * 어느 배포를 볼지 고른다. 기본은 로컬이다.
 *   ANCHOR_INFO=build/anchor.sepolia....json  으로 공개망 배포를 가리킨다.
 *
 * 주소와 RPC를 한 파일에서 같이 읽는 것이 요점이다. 둘은 짝이라, 한쪽만 환경변수로
 * 바꾸면 없는 주소를 다른 체인에 조회하게 된다. 그러면 전부 UNAVAILABLE이 된다.
 */
function anchorInfo() {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const file = join(ROOT, env("ANCHOR_INFO", "build/anchor.json"));
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

export function anchorAddress() {
  const address = env("ANCHOR_ADDRESS", config.anchor.address || anchorInfo()?.address);
  if (!address) {
    throw new Error("Anchor Contract 주소를 찾을 수 없다. script/deploy-anchor.js를 먼저 실행해라");
  }
  return address;
}

function rpcUrl() {
  // 배포 결과 파일의 RPC가 먼저다. 그 주소가 실제로 있는 체인이기 때문이다.
  return anchorInfo()?.rpcUrl ?? env("ANCHOR_RPC_URL", config.anchor.rpcUrl);
}

function parseAnchor(raw) {
  // cast는 숫자 뒤에 `1789209080 [1.789e9]` 처럼 읽기용 주석을 붙인다. 첫 토큰만 쓴다.
  const parts = raw
    .replace(/^\(+|\)+$/g, "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0]);
  return {
    eligibilityRoot: parts[0],
    policyHash: parts[1],
    circuitId: parts[2],
    verifyingKeyHash: parts[3],
    rootEpoch: Number(parts[4]),
    validUntil: Number(parts[5]),
    anchoredAt: Number(parts[6]),
  };
}

const TUPLE = "((bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint64))";

export function latestAnchor(bankId) {
  return parseAnchor(
    cast(["call", anchorAddress(), `latestAnchor(bytes32)${TUPLE}`, bankId, "--rpc-url", rpcUrl()]),
  );
}

export function anchorOf(bankId, rootEpoch) {
  return parseAnchor(
    cast([
      "call",
      anchorAddress(),
      `anchorOf(bytes32,uint64)${TUPLE}`,
      bankId,
      String(rootEpoch),
      "--rpc-url",
      rpcUrl(),
    ]),
  );
}

/** 은행의 현재 회차. 아직 앵커가 없으면 0이다. */
export function latestEpoch(bankId) {
  const raw = cast([
    "call",
    anchorAddress(),
    "latestEpoch(bytes32)(uint64)",
    bankId,
    "--rpc-url",
    rpcUrl(),
  ]);
  return Number(raw.split(/\s+/)[0]);
}

export function anchorRoot({ bankId, eligibilityRoot, policyHash, rootEpoch, validUntil, meta }) {
  const privateKey = process.env.ANCHOR_ISSUER_KEY || config.anchor.issuerKey;
  return cast([
    "send",
    anchorAddress(),
    "anchorRoot(bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64)",
    bankId,
    eligibilityRoot,
    policyHash,
    sha256Bytes32(meta.circuitId),
    meta.verifyingKeyHash,
    String(rootEpoch),
    String(validUntil),
    "--rpc-url",
    rpcUrl(),
    "--private-key",
    privateKey,
  ]);
}

export function sha256Bytes32(input) {
  return "0x" + createHash("sha256").update(input).digest("hex");
}
