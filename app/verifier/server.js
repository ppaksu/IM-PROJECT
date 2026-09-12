// 송금은행 Verifier API.
//
// 검증 순서는 IM_PROJECT_PLAN.md 4.4를 따른다. 싼 검사를 앞에 두고 증명 검증을 마지막에 한다.
// 검증 실패와 서비스 장애를 구분한다. 체인을 못 읽은 것을 허용으로도 차단으로도 바꾸지 않는다.
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { startServer } from "../lib/http.js";
import { hashToField, toHex } from "../lib/field.js";
import { circuitMeta, namedSignals, requestContext, verify as verifyProof } from "../lib/circuit.js";
import { anchorOf, bankIdOf, latestAnchor, sha256Bytes32 } from "../lib/anchor.js";

const ALLOW = (rootEpoch) => ({ status: "ELIGIBLE", decision: "ALLOW", rootEpoch });
const BLOCK = (status) => ({ status, decision: "BLOCK" });
const UNAVAILABLE = () => ({ status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION" });

const issuedNonces = new Map(); // nonce -> { issuedAt, used }
const bankIdCache = new Map();

const now = () => Math.floor(Date.now() / 1000);

const isHex = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
const isName = (value) => typeof value === "string" && value.length > 0 && value.length <= 64;

/**
 * 본문이 우리가 다룰 수 있는 모양인지 먼저 본다.
 * 이 검사를 건너뛰고 값을 파싱하면 잘못된 요청이 예외로 터지고, 바깥 catch가 그것을
 * 장애로 답하게 된다. 잘못된 요청은 장애가 아니라 차단이다.
 */
function malformed(body) {
  const { recipientAccountRef, proof, publicSignals, envelope } = body ?? {};
  if (!isHex(recipientAccountRef)) return "계좌 참조값 형식";
  if (!proof || typeof proof !== "object") return "증명 형식";
  if (!Array.isArray(publicSignals) || publicSignals.length !== 6) return "공개 신호 개수";
  if (!publicSignals.every(isHex)) return "공개 신호 형식";
  if (!envelope || typeof envelope !== "object") return "봉투 형식";
  if (!isHex(envelope.requestNonce)) return "nonce 형식";
  for (const key of ["senderBankId", "verifierId", "recipientBankId", "circuitId"]) {
    if (!isName(envelope[key])) return `${key} 형식`;
  }
  if (!isHex(envelope.verifyingKeyHash)) return "검증키 해시 형식";
  if (!Number.isInteger(Number(envelope.rootEpoch)) || Number(envelope.rootEpoch) < 1) {
    return "회차 형식";
  }
  return null;
}

/** 체인 조회 실패를 이 오류로 감싸 UNAVAILABLE과 BLOCK을 섞지 않는다. */
class ChainUnavailable extends Error {}

function bankId(name) {
  if (!bankIdCache.has(name)) bankIdCache.set(name, bankIdOf(name));
  return bankIdCache.get(name);
}

function issueNonce() {
  // 상위 31바이트만 쓰는 계획서 2.1 규칙에 맞춘다.
  const requestNonce = "0x00" + randomBytes(31).toString("hex");
  issuedNonces.set(requestNonce, { issuedAt: now(), used: false });
  return { requestNonce, expiresAt: now() + config.nonceTtlSeconds };
}

function consumeNonce(requestNonce) {
  const entry = issuedNonces.get(requestNonce);
  if (!entry) return "발급한 적 없는 nonce";
  if (entry.used) return "이미 사용한 nonce";
  if (now() - entry.issuedAt > config.nonceTtlSeconds) return "만료된 nonce";
  entry.used = true;
  return null;
}

/**
 * 증명이 기준으로 삼은 Root가 지금 받아들일 수 있는 것인지 본다. 계획서 2.6
 *
 * 최신 Root만 허용하면 증명을 만드는 사이에 Root가 교체된 정상 계좌가 차단된다.
 * 그래서 직전 회차까지 짧은 유예를 둔다. 유예 구간은 hot revocation 목록이 덮는 구간과
 * 같으므로 위험이 늘지 않는다.
 */
function checkAnchor(recipientBankId, rootEpoch) {
  let latest;
  try {
    latest = latestAnchor(bankId(recipientBankId));
  } catch (error) {
    throw new ChainUnavailable(error.message);
  }

  if (rootEpoch === latest.rootEpoch) {
    if (now() >= latest.validUntil) return { ok: false, detail: "Root 유효기간 경과", anchor: latest };
    return { ok: true, detail: `최신 회차 ${latest.rootEpoch}`, anchor: latest };
  }

  if (rootEpoch === latest.rootEpoch - 1) {
    const sinceRotation = now() - latest.anchoredAt;
    if (sinceRotation > config.graceSeconds) {
      return { ok: false, detail: `직전 회차이나 유예 ${config.graceSeconds}초 경과`, anchor: latest };
    }
    let previous;
    try {
      previous = anchorOf(bankId(recipientBankId), rootEpoch);
    } catch (error) {
      throw new ChainUnavailable(error.message);
    }
    if (now() >= previous.validUntil) {
      return { ok: false, detail: "직전 회차 Root 유효기간 경과", anchor: previous };
    }
    return { ok: true, detail: `직전 회차 ${rootEpoch}, 교체 후 ${sinceRotation}초`, anchor: previous };
  }

  return { ok: false, detail: `회차 ${rootEpoch}, 최신 ${latest.rootEpoch}`, anchor: latest };
}

async function runChecks(body) {
  const steps = [];
  const step = (name, ok, detail = "") => {
    steps.push({ name, ok, detail });
    return ok;
  };
  const fail = (status) => ({ result: BLOCK(status), steps });

  // 1. 요청 형식과 공개 신호 개수
  const shapeError = malformed(body);
  if (!step("요청 형식과 공개 신호 6개", !shapeError, shapeError ?? "")) return fail("UNKNOWN");
  const { recipientAccountRef, proof, publicSignals, envelope } = body;

  // 2. nonce 단일 사용
  const nonceError = consumeNonce(envelope.requestNonce);
  if (!step("요청 nonce 단일 사용", !nonceError, nonceError ?? "")) return fail("UNKNOWN");

  // 3. 요청 바인딩 재계산
  const expected = toHex(
    await requestContext({
      senderBankId: envelope.senderBankId,
      verifierId: envelope.verifierId,
      requestNonce: envelope.requestNonce,
    }),
  );
  const signals = namedSignals(publicSignals);
  if (!step("요청 바인딩 일치", signals.requestContext === expected)) return fail("UNKNOWN");

  // 4. 이 증명이 우리가 물어본 계좌의 것인지
  if (!step("계좌 참조값 일치", signals.recipientAccountRef === recipientAccountRef)) {
    return fail("UNKNOWN");
  }

  // 5. 우리 은행, 우리 검증자를 향한 요청인지
  const boundToUs =
    envelope.senderBankId === config.senderBankId && envelope.verifierId === config.verifierId;
  if (!step("송금은행·검증자 식별자 일치", boundToUs)) return fail("UNKNOWN");

  // 수취은행도 우리가 아는 곳이어야 한다. 이 확인이 없으면 아무 은행 이름이나 넣어
  // 그 은행의 Root를 기준으로 검증하게 만들 수 있다. 은행마다 자기 트리를 직접 만들므로,
  // 다른 은행이 남의 발급기관 이름을 단 leaf를 넣어도 통과한다.
  // 은행이 여럿이 되면 이 비교를 아는 은행 목록 조회로 바꾼다.
  const knownRecipient = envelope.recipientBankId === config.recipientBankId;
  if (!step("수취은행 식별자 일치", knownRecipient, envelope.recipientBankId)) {
    return fail("UNKNOWN");
  }

  // 6. 실제로 쓸 검증키와 같은 회로인지
  const meta = circuitMeta();
  const keyOk =
    envelope.circuitId === meta.circuitId && envelope.verifyingKeyHash === meta.verifyingKeyHash;
  if (!step("회로와 검증키 일치", keyOk)) return fail("UNKNOWN");

  // 7. 증명이 방금 만들어진 것인지
  const skew = Math.abs(Number(BigInt(signals.verificationTime)) - now());
  if (!step("검증 시각 오차", skew <= config.clockSkewSeconds, `${skew}초`)) return fail("UNKNOWN");

  // 8. 기준 Root가 지금 받아들일 수 있는 회차인지
  const anchorCheck = checkAnchor(envelope.recipientBankId, Number(envelope.rootEpoch));
  if (!step("Root 회차와 유예", anchorCheck.ok, anchorCheck.detail)) {
    return fail(anchorCheck.detail.includes("유효기간") ? "EXPIRED" : "NOT_ELIGIBLE");
  }
  const anchor = anchorCheck.anchor;

  // 9. 증명이 가리키는 Root와 정책이 체인에 기록된 것과 같은지
  const chainOk =
    signals.eligibilityRoot === anchor.eligibilityRoot &&
    signals.policyHash === anchor.policyHash &&
    sha256Bytes32(meta.circuitId) === anchor.circuitId &&
    meta.verifyingKeyHash === anchor.verifyingKeyHash;
  if (!step("체인 기록과 Root·정책 일치", chainOk)) return fail("NOT_ELIGIBLE");

  // 발급기관이 우리가 아는 기관인지. 다른 기관의 record로 만든 증명을 막는다.
  const issuerOk = signals.issuerId === toHex(hashToField(config.recipientIssuerId));
  if (!step("발급기관 일치", issuerOk)) return fail("NOT_ELIGIBLE");

  // 10. 증명 자체
  let valid;
  try {
    valid = await verifyProof(proof, publicSignals);
  } catch (error) {
    throw new ChainUnavailable(`검증기 오류: ${error.message}`);
  }
  if (!step("영지식증명 검증", valid)) return fail("NOT_ELIGIBLE");

  return { result: ALLOW(Number(envelope.rootEpoch)), steps };
}

const routes = {
  "POST /api/v1/recipient/eligibility/nonce": () => issueNonce(),

  "POST /api/v1/recipient/eligibility/verify": async (body) => {
    try {
      const { result, steps } = await runChecks(body);
      const failed = steps.find((entry) => !entry.ok);
      console.log(
        `[verifier] 판정=${result.status}` + (failed ? ` 멈춘 단계=${failed.name} (${failed.detail})` : ""),
      );
      return { status: 200, body: { ...result, steps } };
    } catch (error) {
      // 체인 조회 실패나 검증기 고장. 차단이 아니라 장애다.
      console.error("[verifier] 장애:", error.message);
      return { status: 503, body: UNAVAILABLE() };
    }
  },
};

startServer({ name: "verifier", port: config.ports.verifier, routes });
