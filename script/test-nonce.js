// nonce 검사. 시계를 주입해 만료를 실제로 기다리지 않는다.
//
// 실행: node script/test-nonce.js
import assert from "node:assert/strict";
import { createNonceStore } from "../app/lib/nonce.js";

let clock = 1000;
const secret = Buffer.alloc(32, 7);
const store = createNonceStore({ ttlSeconds: 10, clock: () => clock, secret });

const first = store.issue();
assert.match(first.requestNonce, /^0x00[0-9a-f]{62}$/, "31바이트 필드 원소 표기다");
assert.equal(first.expiresAt, 1010);
assert.equal(store.consume(first.requestNonce), null, "방금 발급한 nonce는 통과한다");
assert.equal(store.consume(first.requestNonce), "이미 사용한 nonce", "재사용은 막힌다");

assert.equal(store.consume("0x00" + "de".repeat(31)), "발급한 적 없는 nonce");
assert.equal(store.consume("0xdead"), "발급한 적 없는 nonce", "형식이 틀리면 거절한다");
assert.equal(store.consume(null), "발급한 적 없는 nonce");

// 서명을 한 비트만 바꿔도 통과하면 안 된다.
const forged = store.issue().requestNonce;
const flipped = forged.slice(0, -1) + (forged.at(-1) === "0" ? "1" : "0");
assert.equal(store.consume(flipped), "발급한 적 없는 nonce", "서명을 고치면 거절한다");

// 다른 검증자가 발급한 nonce는 쓸 수 없다.
const other = createNonceStore({ ttlSeconds: 10, clock: () => clock, secret: Buffer.alloc(32, 9) });
assert.equal(store.consume(other.issue().requestNonce), "발급한 적 없는 nonce");

const second = store.issue();
clock += 11;
assert.equal(store.consume(second.requestNonce), "만료된 nonce");

// 핵심. 발급을 아무리 해도 보관소가 자라지 않는다. 발급 endpoint에는 인증이 없다.
const flood = createNonceStore({ ttlSeconds: 10, clock: () => clock, secret });
for (let i = 0; i < 50_000; i++) flood.issue();
assert.equal(flood.size(), 0, "발급만으로는 아무것도 쌓이지 않는다");
assert.equal(flood.consume(flood.issue().requestNonce), null, "발급 폭주 뒤에도 정상 요청은 통과한다");

// 쓰인 nonce는 만료될 때까지만 남는다.
const aging = createNonceStore({ ttlSeconds: 10, clock: () => clock, secret });
aging.consume(aging.issue().requestNonce);
assert.equal(aging.size(), 1);
clock += 11;
aging.sweep();
assert.equal(aging.size(), 0, "만료된 사용 기록은 치워진다");

// 사용 기록이 상한에 닿으면 통과시키지 않고 거절한다.
const tight = createNonceStore({ ttlSeconds: 10, maxUsed: 2, clock: () => clock, secret });
assert.equal(tight.consume(tight.issue().requestNonce), null);
assert.equal(tight.consume(tight.issue().requestNonce), null);
assert.equal(
  tight.consume(tight.issue().requestNonce),
  "사용 기록 보관소가 가득 참",
  "재사용을 막을 수 없으면 통과시키지 않는다",
);

console.log("nonce 검사 통과");
