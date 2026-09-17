// 값 표현 변환은 이 파일 한 곳에서만 한다. IM_PROJECT_PLAN.md 5.1
//
// 같은 값이 세 가지 얼굴로 돌아다닌다. snarkjs는 10진 문자열, 컨트랙트는 bytes32,
// API와 문서는 0x 표기다. 변환이 흩어지면 증명이 조용히 실패한다.
import { createHash, createHmac } from "node:crypto";
import { buildPoseidon } from "circomlibjs";

/** BN254 스칼라 필드. 회로가 쓰는 필드다. */
export const FIELD_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * 해시 출력의 상위 31바이트만 쓴다. mod p 를 쓰지 않는 이유는 온체인 bytes32 값과
 * 회로의 필드 원소를 같은 정수로 유지하기 위해서다. 계획서 2.1
 */
export function truncate31(bytes) {
  return BigInt("0x" + Buffer.from(bytes).subarray(0, 31).toString("hex"));
}

/** 은행 식별자, 정책 문자열 같은 라벨을 필드 원소로 만든다. */
export function hashToField(label) {
  return truncate31(createHash("sha256").update(label).digest());
}

/** 서비스 경계를 넘는 표현. 항상 0x + 64자리다. */
export function toHex(value) {
  return "0x" + BigInt(value).toString(16).padStart(64, "0");
}

/** snarkjs 입력용 10진 문자열. 경계 안쪽에서만 쓴다. */
export function toDecimal(value) {
  return BigInt(value).toString();
}

export function sha256Hex(input) {
  return "0x" + createHash("sha256").update(input).digest("hex");
}

/** 계좌번호 표기는 은행마다 다르다. 숫자만 남긴다. */
export function normalizeAccountNumber(accountNumber) {
  const normalized = String(accountNumber ?? "").replace(/[^0-9]/g, "");
  if (normalized.length === 0) throw new Error("계좌번호에 숫자가 없다");
  return normalized;
}

/**
 * 계좌번호의 공개 표현. 회로의 공개 신호이고, 검증자가 자기가 물어본 계좌로 같은 값을
 * 계산해 대조한다. 계획서 2.1
 *
 * 숫자를 그대로 필드 원소로 쓰지 않는 이유는 앞자리 0이 사라져 서로 다른 계좌가 같은
 * 값이 되기 때문이다.
 */
export function accountHash(accountNumber) {
  return hashToField(normalizeAccountNumber(accountNumber));
}

/**
 * 참조값 유도 키. 은행과 프로토콜마다 하나다. 회로의 비공개 입력이다.
 * 계좌번호별로 나누지 않는 이유는 회로 안에서 계좌 해시와 다시 묶기 때문이다.
 */
export function refKeyOf({ bankSecret, protocolId, bankId }) {
  return truncate31(
    createHmac("sha256", bankSecret).update([protocolId, bankId].join("|")).digest(),
  );
}

/**
 * 계좌번호를 은행 비밀키와 결합한 외부 참조값. 계획서 2.1
 * 계좌번호를 그냥 해시하면 가능한 값을 전부 대입해 원래 값을 알아낼 수 있다.
 *
 * 회로가 같은 식을 다시 계산한다. 그래서 어떤 계좌의 record로 만든 증명을 다른 계좌의
 * 답으로 내밀 수 없다. 그러려면 Poseidon의 역상을 찾아야 한다.
 */
export async function recipientAccountRef({ refKey, accountNumber }) {
  return poseidon([refKey, accountHash(accountNumber)]);
}

let poseidonInstance = null;

/** 회로가 쓰는 것과 같은 Poseidon. 입력과 출력 모두 BigInt다. */
export async function poseidon(inputs) {
  if (!poseidonInstance) poseidonInstance = await buildPoseidon();
  return poseidonInstance.F.toObject(poseidonInstance(inputs.map((value) => BigInt(value))));
}
