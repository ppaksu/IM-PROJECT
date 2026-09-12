// 회로 검사. 정상 증명 하나와 불일치 케이스들을 돌린다.
//
// 불일치는 두 가지 방식으로 실패한다. 비공개 입력을 건드리면 증명 생성 자체가 실패하고,
// 공개 신호를 건드리면 검증이 실패한다. 둘 다 확인한다.
//
// 실행: node script/test-circuit.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toDecimal, toHex } from "../app/lib/field.js";
import { buildInput, namedSignals, prove, requestContext, verify } from "../app/lib/circuit.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(readFileSync(join(ROOT, "app", "fixtures", "registry.sample.json"), "utf8"));
const record = registry.records.find((entry) => entry.inTree);

const request = {
  senderBankId: "bank-a",
  verifierId: "bank-a-recipient-verifier",
  requestNonce: "0x000f5a5c0d885588a14ac2ffa84547ee5c6556aa6d2f0920f9c5046b56e0bd8f",
};
const verificationTime = record.validUntil - 3600;

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  통과  ${name}`);
}

/** 비공개 입력이 틀리면 증명 생성 단계에서 막혀야 한다. */
async function mustFailToProve(name, mutate) {
  const input = buildInput({ record, registry, verificationTime, context });
  mutate(input);
  await check(name, async () => {
    await assert.rejects(() => prove(input), "증명이 만들어지면 안 된다");
  });
}

const context = await requestContext(request);
const base = buildInput({ record, registry, verificationTime, context });

console.log("정상 증명");
const started = Date.now();
const { proof, publicSignals } = await prove(base);
const elapsed = Date.now() - started;

await check("증명이 검증된다", async () => {
  assert.equal(await verify(proof, publicSignals), true);
});

await check("공개 신호가 여섯 개이고 순서가 맞다", async () => {
  assert.equal(publicSignals.length, 6);
  const named = namedSignals(publicSignals);
  assert.equal(named.recipientAccountRef, record.recipientAccountRef);
  assert.equal(named.eligibilityRoot, registry.eligibilityRoot);
  assert.equal(named.policyHash, registry.derived.policyHash);
  assert.equal(named.issuerId, registry.derived.issuerId);
  assert.equal(named.verificationTime, toHex(verificationTime));
  assert.equal(named.requestContext, toHex(context));
});

console.log("\n공개 신호를 바꾸면 검증이 실패한다");

for (const [name, index] of [
  ["계좌 참조값 변경", 0],
  ["Root 변경", 1],
  ["정책 해시 변경", 2],
  ["발급기관 변경", 3],
  ["검증 시각 변경", 4],
  ["요청 바인딩 변경", 5],
]) {
  await check(name, async () => {
    const tampered = [...publicSignals];
    tampered[index] = toHex(BigInt(tampered[index]) + 1n);
    assert.equal(await verify(proof, tampered), false);
  });
}

console.log("\n비공개 입력을 바꾸면 증명이 만들어지지 않는다");

await mustFailToProve("적격 상태가 아닌 record", (input) => {
  input.eligibilityStatus = "2";
});

await mustFailToProve("재확인 기한이 지난 record", (input) => {
  input.validUntil = toDecimal(verificationTime - 1);
});

await mustFailToProve("Merkle path 원소 변경", (input) => {
  input.pathElements[3] = toDecimal(BigInt(input.pathElements[3]) + 1n);
});

await mustFailToProve("path 방향 비트 반전", (input) => {
  input.pathIndices[0] = input.pathIndices[0] === "0" ? "1" : "0";
});

await mustFailToProve("방향 비트가 0도 1도 아님", (input) => {
  input.pathIndices[0] = "2";
});

await mustFailToProve("record의 기한만 바꿔 leaf를 흔듦", (input) => {
  input.validUntil = toDecimal(BigInt(input.validUntil) + 1n);
});

console.log(`\n${passed}개 통과. 증명 생성 ${elapsed}ms`);

// snarkjs가 워커 스레드를 남겨 두어 이벤트 루프가 비지 않는다. 명시적으로 끝낸다.
process.exit(0);
