// 송금은행 Verifier API.
//
// 검증 순서는 IM_PROJECT_PLAN.md 4.4를 따른다. 싼 검사를 앞에 두고 증명 검증을 마지막에 한다.
// 검증 실패와 서비스 장애를 구분한다. 체인을 못 읽은 것을 허용으로도 차단으로도 바꾸지 않는다.
import { config } from "../config.js";
import { startServer } from "../lib/http.js";
import { FIELD_PRIME, hashToField, toHex } from "../lib/field.js";
import { circuitMeta, namedSignals, requestContext, verify as verifyProof } from "../lib/circuit.js";
import { anchorOf, bankIdOf, latestAnchor, sha256Bytes32 } from "../lib/anchor.js";
import { createNonceStore } from "../lib/nonce.js";

const ALLOW = (rootEpoch) => ({ status: "ELIGIBLE", decision: "ALLOW", rootEpoch });
const BLOCK = (status) => ({ status, decision: "BLOCK" });
const UNAVAILABLE = () => ({ status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION" });

const nonces = createNonceStore({ ttlSeconds: config.nonceTtlSeconds });
const bankIdCache = new Map();

const now = () => Math.floor(Date.now() / 1000);

const isHex = (value) => typeof value === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(value);
const isName = (value) => typeof value === "string" && value.length > 0 && value.length <= 64;

// snarkjs는 10진 문자열을 쓴다. 우리 경계 표현인 0x hex도 함께 받아 준다.
const isScalar = (value) => typeof value === "string" && /^([0-9]+|0x[0-9a-fA-F]+)$/.test(value);
const isPoint = (value) => Array.isArray(value) && value.length === 3 && value.every(isScalar);

/**
 * Groth16 증명의 뼈대만 본다. 값이 맞는지는 10단계가 판단한다.
 * 이 검사가 없으면 모양이 깨진 증명에서 검증기가 터지고, 잘못된 요청이 장애로 답해진다.
 */
function malformedProof(proof) {
  // 증명이 스스로 밝히는 방식이 우리가 쓸 검증키와 같아야 한다. 이 확인이 없으면
  // 다른 방식이라고 적힌 증명을 라이브러리 동작에 맡기게 된다. 버전에 따라 예외가
  // 나기도 하고 그냥 무시되기도 하는데, 예외가 나면 잘못된 요청이 장애로 답해진다.
  if (proof.protocol !== "groth16") return "protocol";
  if (proof.curve !== "bn128") return "curve";
  if (!isPoint(proof.pi_a)) return "pi_a";
  if (!isPoint(proof.pi_c)) return "pi_c";
  const b = proof.pi_b;
  const pairOk = (row) => Array.isArray(row) && row.length === 2 && row.every(isScalar);
  if (!Array.isArray(b) || b.length !== 3 || !b.every(pairOk)) return "pi_b";
  return null;
}

/**
 * 본문이 우리가 다룰 수 있는 모양인지 먼저 본다.
 * 이 검사를 건너뛰고 값을 파싱하면 잘못된 요청이 예외로 터지고, 바깥 catch가 그것을
 * 장애로 답하게 된다. 잘못된 요청은 장애가 아니라 차단이다.
 */
function malformed(body) {
  const { accountHash, proof, publicSignals, envelope } = body ?? {};
  if (!isHex(accountHash)) return "계좌 해시 형식";
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return "증명 형식";
  const proofError = malformedProof(proof);
  if (proofError) return `증명 형식 ${proofError}`;
  if (!Array.isArray(publicSignals) || publicSignals.length !== 6) return "공개 신호 개수";
  if (!publicSignals.every(isHex)) return "공개 신호 형식";
  // 필드 밖의 값은 정상 증명에서 나올 수 없다. 여기서 막지 않으면 같은 원소를 가리키는
  // 표기가 여러 개가 되어, 뒤의 값 대조가 표기에 따라 달라진다.
  if (!publicSignals.every((value) => BigInt(value) < FIELD_PRIME)) return "공개 신호 범위";
  if (!envelope || typeof envelope !== "object") return "봉투 형식";
  if (!isHex(envelope.requestNonce)) return "nonce 형식";
  for (const key of ["senderBankId", "verifierId", "recipientBankId", "circuitId"]) {
    if (!isName(envelope[key])) return `${key} 형식`;
  }
  if (!isHex(envelope.verifyingKeyHash)) return "검증키 해시 형식";
  // 숫자나 숫자 문자열만 받는다. Number()에 맡기면 [1]이나 true가 조용히 1이 된다.
  const epoch = envelope.rootEpoch;
  const epochOk =
    (typeof epoch === "number" || typeof epoch === "string") &&
    /^[0-9]+$/.test(String(epoch)) &&
    Number.isSafeInteger(Number(epoch)) &&
    Number(epoch) >= 1;
  if (!epochOk) return "회차 형식";
  return null;
}

/** 체인 조회 실패를 이 오류로 감싸 UNAVAILABLE과 BLOCK을 섞지 않는다. */
class ChainUnavailable extends Error {}

function bankId(name) {
  if (!bankIdCache.has(name)) bankIdCache.set(name, bankIdOf(name));
  return bankIdCache.get(name);
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
    if (now() >= latest.validUntil) {
      return { ok: false, code: "EXPIRED", detail: "Root 유효기간 경과", anchor: latest };
    }
    return { ok: true, code: "CURRENT", detail: `최신 회차 ${latest.rootEpoch}`, anchor: latest };
  }

  if (rootEpoch === latest.rootEpoch - 1) {
    const sinceRotation = now() - latest.anchoredAt;
    if (sinceRotation > config.graceSeconds) {
      return {
        ok: false,
        code: "STALE_EPOCH",
        detail: `직전 회차이나 유예 ${config.graceSeconds}초 경과`,
        anchor: latest,
      };
    }
    let previous;
    try {
      previous = anchorOf(bankId(recipientBankId), rootEpoch);
    } catch (error) {
      throw new ChainUnavailable(error.message);
    }
    if (now() >= previous.validUntil) {
      return { ok: false, code: "EXPIRED", detail: "직전 회차 Root 유효기간 경과", anchor: previous };
    }
    return {
      ok: true,
      code: "GRACE",
      detail: `직전 회차 ${rootEpoch}, 교체 후 ${sinceRotation}초`,
      anchor: previous,
    };
  }

  return {
    ok: false,
    code: "STALE_EPOCH",
    detail: `회차 ${rootEpoch}, 최신 ${latest.rootEpoch}`,
    anchor: latest,
  };
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
  const { accountHash, proof, publicSignals, envelope } = body;

  // 2. nonce 단일 사용
  const nonceError = nonces.consume(envelope.requestNonce);
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

  // 4. 이 증명이 우리가 물어본 계좌의 것인지.
  //
  // accountHash는 송금은행이 사용자가 입력한 계좌번호로 직접 계산한 값이고, 공개 신호의
  // accountHash는 회로가 leaf의 참조값을 만들 때 쓴 값이다. 둘이 같으면 이 증명은
  // 물어본 그 계좌에 대한 것이다. 수취은행이 다른 계좌의 record로 답을 바꿔치기할 수 없다.
  // 표기를 맞춘 뒤 비교한다. 대문자 hex나 앞자리 0을 뗀 표기로 보내는 구현이 있으면
  // 값이 같은데도 막히고, 원인이 잘 드러나지 않는다.
  if (!step("물어본 계좌와 같은 계좌", signals.accountHash === toHex(accountHash))) {
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
    // 사람이 읽는 문구가 아니라 사유 코드로 고른다. 문구를 다듬어도 응답이 바뀌지 않는다.
    return fail(anchorCheck.code === "EXPIRED" ? "EXPIRED" : "NOT_ELIGIBLE");
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
  // 발급은 아무것도 기록하지 않는다. 반복 호출로 발급을 막을 수 없다.
  "POST /api/v1/recipient/eligibility/nonce": () => nonces.issue(),

  "POST /api/v1/recipient/eligibility/verify": async (body) => {
    try {
      const { result, steps } = await runChecks(body);
      const failed = steps.find((entry) => !entry.ok);
      console.log(
        `[verifier] 판정=${result.status}` + (failed ? ` 멈춘 단계=${failed.name} (${failed.detail})` : ""),
      );
      // 어느 단계에서 멈췄는지는 시연에서 보여줘야 하지만, 운영에서는 사유를 밖으로
      // 내보내지 않는다. 반복 조회로 계좌 사정을 추정하지 못하게 하려는 규칙이다.
      // 감사 로그에는 설정과 무관하게 남는다.
      return { status: 200, body: config.exposeVerificationSteps ? { ...result, steps } : result };
    } catch (error) {
      // 체인 조회 실패나 검증기 고장. 차단이 아니라 장애다.
      console.error("[verifier] 장애:", error.message);
      return { status: 503, body: UNAVAILABLE() };
    }
  },
};

startServer({ name: "verifier", port: config.ports.verifier, routes });
