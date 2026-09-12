// 송금은행 중계 서버.
//
// 화면을 서빙하고, 화면이 호출하는 요청 하나를 세 단계로 풀어 준다.
// nonce 발급 → 수취은행에 증명 요청 → Verifier에 검증 요청.
// 영지식증명을 다루지 않는다. 증명은 그대로 넘기는 JSON 덩어리다.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, url } from "../config.js";
import { postJson, startServer } from "../lib/http.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

const auditLog = [];

function audit(entry) {
  auditLog.unshift({ at: new Date().toISOString(), ...entry });
  auditLog.length = Math.min(auditLog.length, 50);
}

async function checkTransfer(body) {
  const accountNumber = String(body.accountNumber ?? "").trim();
  if (!accountNumber) {
    return { status: 400, body: { error: "계좌번호가 필요하다" } };
  }

  const timeline = [];
  const mark = (name, detail) => timeline.push({ name, detail });

  // 1. 검증자가 nonce를 발급한다. 계획서 2.4
  const nonce = await postJson(`${url.verifier}/api/v1/recipient/eligibility/nonce`, {});
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
    const status = proofResponse.body.status === "UNAVAILABLE" ? "UNAVAILABLE" : "NOT_ELIGIBLE";
    const decision = status === "UNAVAILABLE" ? "NO_SAFETY_ASSERTION" : "BLOCK";
    mark("수취은행 증명 발급", "거절");
    audit({ accountNumber, status, decision });
    return { status: 200, body: { status, decision, timeline } };
  }
  mark("수취은행 증명 발급", "성공");

  // 3. 검증자에게 넘긴다.
  const verifyResponse = await postJson(`${url.verifier}/api/v1/recipient/eligibility/verify`, {
    recipientAccountRef: proofResponse.body.recipientAccountRef,
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
      recipientAccountRef: proofResponse.body.recipientAccountRef,
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
  "POST /admin/revoke": async (body) =>
    (await postJson(`${url.recipientBank}/admin/revoke`, body)).body,
  "POST /admin/restore": async (body) =>
    (await postJson(`${url.recipientBank}/admin/restore`, body)).body,
  "POST /admin/rebuild-root": async () =>
    (await postJson(`${url.recipientBank}/admin/rebuild-root`, {})).body,
};

startServer({ name: "sender-bank", port: config.ports.senderBank, routes, staticDir: WEB_DIR });
