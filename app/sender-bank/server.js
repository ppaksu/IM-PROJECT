// 송금은행 중계 서버.
//
// 화면을 서빙하고, 화면이 호출하는 요청 하나를 세 단계로 풀어 준다.
// nonce 발급 → 수취은행에 증명 요청 → Verifier에 검증 요청.
// 영지식증명을 다루지 않는다. 증명은 그대로 넘기는 JSON 덩어리다.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, url } from "../config.js";
import { postJson, startServer } from "../lib/http.js";
import { accountHash, toHex } from "../lib/field.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const auditLog = [];

function audit(entry) {
  // 한국 시간으로 남긴다. 9시간을 더한 뒤 toISOString을 쓰면 안 된다. 끝의 Z가 UTC라고
  // 말하는데 값은 KST라, 감사 기록이 자기 시간대를 두고 거짓말을 하게 된다.
  const at = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }) + "+09:00";
  auditLog.unshift({ at, ...entry });
  auditLog.length = Math.min(auditLog.length, 50);
}

async function checkTransfer(body) {
  const accountNumber = String(body.accountNumber ?? "").trim();
  // 이 값을 우리가 직접 계산하는 것이 요점이다. 수취은행이 준 값을 그대로 쓰면 어떤
  // 계좌의 증명을 받아도 물어본 계좌의 답으로 보인다.
  let asked;
  try {
    asked = toHex(accountHash(accountNumber));
  } catch {
    return { status: 400, body: { error: "계좌번호가 필요하다" } };
  }

  const timeline = [];
  const mark = (name, detail) => timeline.push({ name, detail });

  // 1. 검증자가 nonce를 발급한다. 계획서 2.4
  const nonce = await postJson(`${url.verifier}/api/v1/recipient/eligibility/nonce`, {});
  // nonce를 못 받았는데 그냥 진행하면, 수취은행이 형식 오류로 거절하고 그 거절이
  // "적격 아님"으로 읽힌다. 검증자 장애가 전 계좌 차단으로 둔갑한다.
  if (nonce.status !== 200 || typeof nonce.body.requestNonce !== "string") {
    audit({ accountNumber, status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION" });
    return {
      status: 503,
      body: { status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION", timeline },
    };
  }
  mark("검증 nonce 발급", nonce.body.requestNonce);

  // 2. 수취은행에 증명을 요청한다.
  const proofResponse = await postJson(
    `${url.recipientBank}/interbank/v1/recipient/eligibility/proof`,
    {
      protocolVersion: config.protocolVersion,
      senderBankId: config.senderBankId,
      verifierId: config.verifierId,
      requestNonce: nonce.body.requestNonce,
      recipientBankId: config.recipientBankId,
      accountNumber,
    },
  );

  if (proofResponse.body.result !== "PROOF") {
    // 적격 아님이라고 명시한 경우에만 차단이다. 그 밖의 응답은 장애로 본다.
    // 알아볼 수 없는 응답을 차단으로 읽으면 장애가 정상 계좌의 차단으로 둔갑한다.
    const blocked = proofResponse.body.status === "NOT_ELIGIBLE";
    const status = blocked ? "NOT_ELIGIBLE" : "UNAVAILABLE";
    const decision = blocked ? "BLOCK" : "NO_SAFETY_ASSERTION";
    mark("수취은행 증명 발급", blocked ? "거절" : "응답 없음");
    audit({ accountNumber, status, decision });
    return { status: blocked ? 200 : 503, body: { status, decision, timeline } };
  }
  mark("수취은행 증명 발급", "성공");

  // 3. 검증자에게 넘긴다.
  const verifyResponse = await postJson(`${url.verifier}/api/v1/recipient/eligibility/verify`, {
    accountHash: asked,
    proof: proofResponse.body.proof,
    publicSignals: proofResponse.body.publicSignals,
    envelope: {
      senderBankId: config.senderBankId,
      verifierId: config.verifierId,
      requestNonce: nonce.body.requestNonce,
      recipientBankId: config.recipientBankId,
      ...proofResponse.body.envelope,
    },
  });

  for (const step of verifyResponse.body.steps ?? []) {
    mark(step.name, step.detail || (step.ok ? "통과" : "실패"));
  }

  audit({
    accountNumber,
    status: verifyResponse.body.status,
    decision: verifyResponse.body.decision,
    rootEpoch: verifyResponse.body.rootEpoch,
  });

  return {
    // 장애는 상태 코드로도 구분한다. 계획서 4.3
    status: verifyResponse.body.decision === "NO_SAFETY_ASSERTION" ? 503 : 200,
    body: {
      status: verifyResponse.body.status,
      decision: verifyResponse.body.decision,
      rootEpoch: verifyResponse.body.rootEpoch,
      accountHash: asked,
      timeline,
    },
  };
}

const routes = {
  "POST /api/v1/transfer/check": async (body) => {
    try {
      return await checkTransfer(body);
    } catch (error) {
      // 하위 서버가 죽은 경우다. 차단이 아니라 장애로 답한다. 계획서 4.3
      console.error("[sender-bank] 하위 호출 실패:", error.message);
      audit({ accountNumber: body.accountNumber, status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION" });
      return {
        status: 503,
        body: { status: "UNAVAILABLE", decision: "NO_SAFETY_ASSERTION", timeline: [] },
      };
    }
  },

  "GET /api/v1/audit-log": () => ({ entries: auditLog }),

  // 수취은행 관리 화면이 쓰는 통로. 시연 조작용이다.
  "GET /admin/accounts": async () => {
    const response = await fetch(`${url.recipientBank}/admin/accounts`);
    return response.json();
  },
  // 하위 서버의 상태 코드를 그대로 넘긴다. 삼키면 실패한 조작이 성공으로 보인다.
  "POST /admin/revoke": (body) => postJson(`${url.recipientBank}/admin/revoke`, body),
  "POST /admin/restore": (body) => postJson(`${url.recipientBank}/admin/restore`, body),
  "POST /admin/rebuild-root": () => postJson(`${url.recipientBank}/admin/rebuild-root`, {}),
};

startServer({ name: "sender-bank", port: config.ports.senderBank, routes, staticDir: WEB_DIR });
