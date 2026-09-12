// 회로 입력 구성과 증명 생성·검증.
//
// 공개 신호의 순서가 회로와 검증자 사이의 계약이다. 순서가 어긋나면 증명은 만들어지는데
// 검증만 실패하고, 원인이 잘 드러나지 않는다. 그래서 이름 있는 객체와 배열 사이의 변환을
// 이 파일 한 곳에서만 한다.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { groth16 } from "snarkjs";
import { hashToField, poseidon, toDecimal, toHex } from "./field.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUILD = join(ROOT, "build");

export const WASM = join(BUILD, "eligibility_js", "eligibility.wasm");
export const ZKEY = join(BUILD, "eligibility.zkey");
export const VKEY = join(BUILD, "eligibility.vkey.json");

/** 회로의 main 선언과 같은 순서다. 바꾸면 회로도 같이 바꿔야 한다. */
export const PUBLIC_SIGNALS = [
  "recipientAccountRef",
  "eligibilityRoot",
  "policyHash",
  "issuerId",
  "verificationTime",
  "requestContext",
];

export function circuitMeta() {
  return JSON.parse(readFileSync(join(BUILD, "circuit-meta.json"), "utf8"));
}

export function verifyingKey() {
  return JSON.parse(readFileSync(VKEY, "utf8"));
}

/** 증명을 특정 송금은행, 특정 검증자, 특정 요청에 묶는 값. 계획서 2.4 */
export async function requestContext({ senderBankId, verifierId, requestNonce }) {
  return poseidon([hashToField(senderBankId), hashToField(verifierId), BigInt(requestNonce)]);
}

/**
 * Registry의 record와 이번 요청으로 회로 입력을 만든다.
 * record는 registry.sample.json의 항목과 같은 모양이다.
 */
export function buildInput({ record, registry, verificationTime, context }) {
  return {
    recipientAccountRef: toDecimal(record.recipientAccountRef),
    eligibilityRoot: toDecimal(registry.eligibilityRoot),
    policyHash: toDecimal(registry.derived.policyHash),
    issuerId: toDecimal(registry.derived.issuerId),
    verificationTime: toDecimal(verificationTime),
    requestContext: toDecimal(context),
    eligibilityStatus: toDecimal(record.eligibilityStatus),
    validUntil: toDecimal(record.validUntil),
    pathElements: record.pathElements.map(toDecimal),
    pathIndices: record.pathIndices.map(toDecimal),
  };
}

/** 증명과 공개 신호를 만든다. 공개 신호는 경계 표현인 0x hex로 돌려준다. */
export async function prove(input) {
  const { proof, publicSignals } = await groth16.fullProve(input, WASM, ZKEY);
  return { proof, publicSignals: publicSignals.map(toHex) };
}

export async function verify(proof, publicSignals) {
  return groth16.verify(verifyingKey(), publicSignals.map(toDecimal), proof);
}

/** 공개 신호 배열을 이름 있는 객체로 바꾼다. 검증자가 대조할 때 쓴다. */
export function namedSignals(publicSignals) {
  const named = {};
  PUBLIC_SIGNALS.forEach((key, index) => {
    named[key] = toHex(publicSignals[index]);
  });
  return named;
}
