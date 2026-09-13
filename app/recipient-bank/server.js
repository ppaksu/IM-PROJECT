// 수취은행 서버.
//
// 계좌 record와 hot revocation 목록을 들고, 적격한 계좌에만 증명을 발급한다.
// 증명은 회로로 실제 생성한다. 트리와 Merkle path는 아직 기준값 파일에서 읽는다.
// Registry가 붙으면 그 출처만 바뀌고 바깥 계약은 그대로다.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { startServer } from "../lib/http.js";
import { buildInput, circuitMeta, prove, requestContext } from "../lib/circuit.js";
import { anchorRoot, bankIdOf, latestEpoch } from "../lib/anchor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const accounts = JSON.parse(await readFile(join(ROOT, "data", "accounts.json"), "utf8"));

// TODO(백엔드): Registry가 붙으면 build/registry.json을 읽는다. 지금은 기준값 파일을 쓴다.
const registry = JSON.parse(
  await readFile(join(ROOT, "app", "fixtures", "registry.sample.json"), "utf8"),
);

// hot revocation 목록. 계획서 2.8에 따라 수취은행 안에 둔다.
const revoked = new Map(); // accountNumber -> "SUSPENDED" | "REVOKED"

const bankId = bankIdOf(config.recipientBankId);

/**
 * 현재 회차는 체인이 기준이다. 메모리에 따로 세지 않는다.
 * 따로 세면 앵커링하지 않은 회차로 증명을 발급하게 되고, 검증자는 그 회차를 모르므로
 * 멀쩡한 계좌가 차단된다.
 */
function currentEpoch() {
  return latestEpoch(bankId);
}

function normalize(accountNumber) {
  return String(accountNumber ?? "").replace(/[^0-9]/g, "");
}

function findAccount(accountNumber) {
  const wanted = normalize(accountNumber);
  return accounts.find((account) => normalize(account.accountNumber) === wanted) ?? null;
}

/**
 * 증명 발급 가능 여부. 사유는 은행 안에서만 쓰고 밖으로 내보내지 않는다.
 * 계획서 2.7에 따라 응답은 NOT_ELIGIBLE 하나로 합친다.
 */
function eligibility(account) {
  if (!account) return { ok: false, reason: "UNKNOWN_ACCOUNT" };
  const hot = revoked.get(account.accountNumber);
  if (hot) return { ok: false, reason: hot };
  if (account.status !== "ELIGIBLE") return { ok: false, reason: account.status };
  if (!account.kycComplete) return { ok: false, reason: "KYC_INCOMPLETE" };
  if (account.openedDaysAgo < config.minAccountAgeDays) return { ok: false, reason: "NEW_ACCOUNT" };
  return { ok: true, reason: "ELIGIBLE" };
}

/** Registry의 record로 회로 입력을 만들어 증명을 생성한다. */
async function makeProof(account, request) {
  const record = registry.records.find((entry) => entry.id === account.id && entry.inTree);
  if (!record) return null;

  const rootEpoch = currentEpoch();
  if (rootEpoch === 0) return null; // 아직 앵커된 Root가 없다

  const context = await requestContext({
    senderBankId: request.senderBankId,
    verifierId: request.verifierId,
    requestNonce: request.requestNonce,
  });
  const verificationTime = Math.floor(Date.now() / 1000);
  const meta = circuitMeta();

  const { proof, publicSignals } = await prove(
    buildInput({ record, registry, verificationTime, context }),
  );

  return {
    result: "PROOF",
    recipientAccountRef: record.recipientAccountRef,
    proof,
    publicSignals,
    envelope: {
      rootEpoch,
      circuitId: meta.circuitId,
      verifyingKeyHash: meta.verifyingKeyHash,
    },
  };
}

const routes = {
  "POST /interbank/v1/recipient/eligibility/proof": async (body) => {
    if (body.protocolVersion !== config.protocolVersion || !body.requestNonce) {
      return { status: 400, body: { result: "NO_PROOF", status: "NOT_ELIGIBLE" } };
    }

    const account = findAccount(body.accountNumber);
    const verdict = eligibility(account);
    console.log(
      `[recipient-bank] 증명 요청 account=${account?.id ?? "?"} 판정=${verdict.reason}`,
    );
    if (!verdict.ok) {
      return { status: 200, body: { result: "NO_PROOF", status: "NOT_ELIGIBLE" } };
    }

    let issued;
    try {
      issued = await makeProof(account, body);
    } catch (error) {
      // 체인이나 증명기가 죽은 경우다. 적격 아님과 섞으면 안 된다.
      console.error("[recipient-bank] 증명 발급 실패:", error.message);
      return { status: 503, body: { result: "NO_PROOF", status: "UNAVAILABLE" } };
    }
    if (!issued) {
      // 판정은 적격인데 트리에 자리가 없다. 판정과 트리가 어긋난 상태다.
      console.error(`[recipient-bank] 적격인데 record가 없다 account=${account.id}`);
      return { status: 503, body: { result: "NO_PROOF", status: "UNAVAILABLE" } };
    }
    return { status: 200, body: issued };
  },

  // 아래는 시연 조작용이다. 실제 은행 간 API에는 없다.
  "GET /admin/accounts": () => ({
    rootEpoch: currentEpoch(),
    accounts: accounts.map((account) => {
      const verdict = eligibility(account);
      return {
        id: account.id,
        accountNumber: account.accountNumber,
        holderAlias: account.holderAlias,
        note: account.note,
        reason: verdict.reason,
        eligible: verdict.ok,
        // hot revocation으로 막힌 계좌만 화면에서 되돌릴 수 있다
        hot: revoked.has(account.accountNumber),
      };
    }),
  }),

  "POST /admin/revoke": (body) => {
    const account = findAccount(body.accountNumber);
    if (!account) return { status: 404, body: { error: "unknown account" } };
    const status = body.status === "SUSPENDED" ? "SUSPENDED" : "REVOKED";
    revoked.set(account.accountNumber, status);
    console.log(`[recipient-bank] hot revocation 추가 account=${account.id} status=${status}`);
    return { ok: true, account: account.id, status };
  },

  "POST /admin/restore": (body) => {
    const account = findAccount(body.accountNumber);
    if (!account) return { status: 404, body: { error: "unknown account" } };
    revoked.delete(account.accountNumber);
    return { ok: true, account: account.id, status: account.status };
  },

  // TODO(백엔드): Registry가 트리를 다시 만들어 새 Root를 넘기게 바꾼다.
  // 지금은 같은 Root를 다음 회차로 다시 앵커링한다. 회차 교체 자체는 실제로 일어난다.
  "POST /admin/rebuild-root": () => {
    const rootEpoch = currentEpoch() + 1;
    anchorRoot({
      bankId,
      eligibilityRoot: registry.eligibilityRoot,
      policyHash: registry.derived.policyHash,
      rootEpoch,
      validUntil: Math.floor(Date.now() / 1000) + config.rootPeriodSeconds,
      meta: circuitMeta(),
    });
    console.log(`[recipient-bank] Root 앵커링 rootEpoch=${rootEpoch}`);
    return { rootEpoch };
  },
};

startServer({ name: "recipient-bank", port: config.ports.recipientBank, routes });
