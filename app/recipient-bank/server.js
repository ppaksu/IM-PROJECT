// 수취은행 서버 (1일차 스텁)
//
// 계좌 record와 hot revocation 목록을 들고, 적격한 계좌에만 증명을 발급한다.
// 지금은 증명을 fixtures에서 꺼내 쓴다. Registry와 회로가 나오면 이 파일에서
// makeProof 안쪽만 진짜로 바꾼다. 바깥 계약은 그대로다.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { startServer } from "../lib/http.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const accounts = JSON.parse(await readFile(join(ROOT, "data", "accounts.json"), "utf8"));
const sampleProof = JSON.parse(
  await readFile(join(ROOT, "app", "fixtures", "interbank-proof.response.json"), "utf8"),
);

// hot revocation 목록. 계획서 2.8에 따라 수취은행 안에 둔다.
const revoked = new Map(); // accountNumber -> "SUSPENDED" | "REVOKED"

// 데모용 현재 Root 회차. Registry가 붙으면 그쪽이 관리한다.
let rootEpoch = 1;

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
  return { ok: true, reason: "ELIGIBLE" };
}

// TODO(백엔드): Registry의 Merkle path를 읽어 회로 입력을 만들고 snarkjs로 증명을 생성한다.
function makeProof(account) {
  return {
    result: "PROOF",
    recipientAccountRef: sampleProof.recipientAccountRef,
    proof: sampleProof.proof,
    publicSignals: sampleProof.publicSignals,
    envelope: { ...sampleProof.envelope, rootEpoch },
    stub: { account: account.id },
  };
}

const routes = {
  "POST /interbank/v1/recipient/eligibility/proof": (body) => {
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
    return { status: 200, body: makeProof(account) };
  },

  // 아래는 시연 조작용이다. 실제 은행 간 API에는 없다.
  "GET /admin/accounts": () => ({
    rootEpoch,
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

  // TODO(백엔드): Registry가 트리를 다시 만들고 Root를 앵커링하도록 바꾼다.
  "POST /admin/rebuild-root": () => {
    rootEpoch += 1;
    console.log(`[recipient-bank] Root 회차 증가 rootEpoch=${rootEpoch}`);
    return { rootEpoch };
  },
};

startServer({ name: "recipient-bank", port: config.ports.recipientBank, routes });
