// nonce 보관소 검사. 시계를 주입해 만료를 실제로 기다리지 않는다.
//
// 실행: node script/test-nonce.js
import assert from "node:assert/strict";
import { createNonceStore } from "../app/lib/nonce.js";

let clock = 1000;
const store = createNonceStore({ ttlSeconds: 10, maxEntries: 3, clock: () => clock });

const first = store.issue();
assert.equal(store.consume(first.requestNonce), null, "방금 발급한 nonce는 통과한다");
assert.equal(store.consume(first.requestNonce), "이미 사용한 nonce", "재사용은 막힌다");
assert.equal(store.consume("0x00dead"), "발급한 적 없는 nonce");

const second = store.issue();
clock += 11;
assert.equal(store.consume(second.requestNonce), "만료된 nonce");

// 만료된 항목은 다음 발급 때 치워진다.
const before = store.size();
store.issue();
assert.ok(store.size() <= before, `만료분이 정리되어야 한다 (이전 ${before}, 지금 ${store.size()})`);

// 상한에 닿으면 발급을 멈춘다. 쓰지 않은 nonce를 밀어내지 않는다.
const fresh = createNonceStore({ ttlSeconds: 10, maxEntries: 2, clock: () => clock });
const keep = fresh.issue();
fresh.issue();
assert.equal(fresh.issue(), null, "상한에서는 발급하지 않는다");
assert.equal(fresh.consume(keep.requestNonce), null, "먼저 발급한 nonce는 살아 있다");

console.log("nonce 보관소 검사 통과");
