// 송금은행 Verifier API (1일차 스텁)
//
// nonce 발급과 소비는 실물로 넣었다. 계획서 4.4의 10단계 중 1~2단계에 해당하고
// 영지식증명과 무관해서 지금 만들어 두는 편이 낫다.
// 3~10단계는 회로와 컨트랙트가 나온 뒤 이 파일에서 채운다.
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { startServer } from "../lib/http.js";

const ALLOW = (rootEpoch) => ({ status: "ELIGIBLE", decision: "ALLOW", rootEpoch });
const BLOCK = (status) => ({ status, decision: "BLOCK" });
const UNAVAILABLE = () => ({ status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION" });

const issuedNonces = new Map(); // nonce -> { issuedAt, used }

function now() {
  return Math.floor(Date.now() / 1000);
}

function issueNonce() {
  // 상위 31바이트만 쓰는 계획서 2.1 규칙에 맞춘다.
  const requestNonce = "0x00" + randomBytes(31).toString("hex");
  issuedNonces.set(requestNonce, { issuedAt: now(), used: false });
  return { requestNonce, expiresAt: now() + config.nonceTtlSeconds };
}

/** 반환값이 null이면 통과다. */
function checkNonce(requestNonce) {
  const entry = issuedNonces.get(requestNonce);
  if (!entry) return "발급한 적 없는 nonce";
  if (entry.used) return "이미 사용한 nonce";
  if (now() - entry.issuedAt > config.nonceTtlSeconds) return "만료된 nonce";
  entry.used = true; // 단일 사용
  return null;
}

function verify(body) {
  const steps = [];
  const record = (name, ok, detail = "") => {
    steps.push({ name, ok, detail });
    return ok;
  };

  // 1단계. 요청 형식과 public signal 개수
  const { recipientAccountRef, proof, publicSignals, envelope } = body ?? {};
  const shapeOk =
    Boolean(recipientAccountRef) &&
    Boolean(proof) &&
    Array.isArray(publicSignals) &&
    publicSignals.length === 6 &&
    Boolean(envelope);
  if (!record("요청 형식과 public signal 6개", shapeOk)) {
    return { result: BLOCK("UNKNOWN"), steps };
  }

  // 2단계. nonce 단일 사용
  const nonceError = checkNonce(envelope.requestNonce);
  if (!record("요청 nonce 단일 사용", !nonceError, nonceError ?? "")) {
    return { result: BLOCK("UNKNOWN"), steps };
  }

  // 5단계. 우리 은행과 우리 검증자를 향한 요청인지
  const boundToUs =
    envelope.senderBankId === config.senderBankId && envelope.verifierId === config.verifierId;
  if (!record("송금은행·검증자 식별자 일치", boundToUs)) {
    return { result: BLOCK("UNKNOWN"), steps };
  }

  // 6단계. 회로 식별자
  if (!record("회로 식별자 일치", envelope.circuitId === config.circuitId)) {
    return { result: BLOCK("UNKNOWN"), steps };
  }

  // TODO(보안): 3단계 requestContext 재계산, 4단계 계좌 참조값 대조,
  // 7단계 verificationTime 오차, 8~9단계 Anchor 조회와 유예,
  // 10단계 Groth16 검증. 아래 세 줄은 그때 실물로 바뀐다.
  record("요청 바인딩 재계산", true, "미구현 (스텁 통과)");
  record("Anchor Root 최신성과 유예", true, "미구현 (스텁 통과)");
  record("영지식증명 검증", true, "미구현 (스텁 통과)");

  return { result: ALLOW(envelope.rootEpoch), steps };
}

const routes = {
  "POST /api/v1/recipient/eligibility/nonce": () => issueNonce(),

  "POST /api/v1/recipient/eligibility/verify": (body) => {
    try {
      const { result, steps } = verify(body);
      console.log(`[verifier] 판정=${result.status} 단계=${steps.length}`);
      return { status: 200, body: { ...result, steps } };
    } catch (error) {
      // 검증 실패와 장애를 구분한다. 계획서 4.3
      console.error("[verifier] 장애:", error.message);
      return { status: 503, body: UNAVAILABLE() };
    }
  },
};

startServer({ name: "verifier", port: config.ports.verifier, routes });
