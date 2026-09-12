// Anchor Contract 조회. Foundry의 cast를 감싸서 web3 의존성을 두지 않는다.
//
// 조회가 실패하면 던진다. 검증자는 이것을 잡아 UNAVAILABLE로 답해야 한다.
// 체인을 못 읽은 것을 차단으로도, 허용으로도 바꾸면 안 된다. 계획서 4.3
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

function cast(args) {
  return execFileSync("cast", args, { encoding: "utf8", timeout: 10_000 }).trim();
}

/** 은행 식별자 문자열의 keccak 해시. 컨트랙트의 bankId다. */
export function bankIdOf(name) {
  return cast(["keccak", name]);
}

export function anchorAddress() {
  if (process.env.ANCHOR_ADDRESS) return process.env.ANCHOR_ADDRESS;
  if (config.anchor.address) return config.anchor.address;
  // 배포 스크립트가 남긴 주소
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "build", "anchor.json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).address;
  throw new Error("Anchor Contract 주소를 찾을 수 없다. script/deploy-anchor.js를 먼저 실행해라");
}

function rpcUrl() {
  return process.env.ANCHOR_RPC_URL || config.anchor.rpcUrl;
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

export function anchorRoot({ bankId, eligibilityRoot, policyHash, rootEpoch, validUntil, meta, privateKey }) {
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
