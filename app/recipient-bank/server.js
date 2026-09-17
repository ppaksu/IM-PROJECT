// 수취은행 서버.
//
// 계좌 record와 hot revocation 목록을 들고, 적격한 계좌에만 증명을 발급한다.
// 증명은 회로로 실제 생성한다. 트리와 Merkle path는 Registry가 계좌 목록에서 만든다.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { startServer } from "../lib/http.js";
import { buildInput, circuitMeta, prove, requestContext } from "../lib/circuit.js";
import { anchorRoot, bankIdOf, latestAnchor } from "../lib/anchor.js";
import { buildRegistry, eligibilityOf } from "../lib/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const accounts = JSON.parse(await readFile(join(ROOT, "data", "accounts.json"), "utf8"));

// hot revocation 목록. 계획서 2.8에 따라 수취은행 안에 둔다.
// 트리에는 바로 반영하지 않는다. 즉시 차단은 이 목록이 하고, 트리는 다음 회차에 따라온다.
const revoked = new Map(); // accountNumber -> "SUSPENDED" | "REVOKED"

// 현재 앵커된 Root에 대응하는 트리다. 앵커링할 때만 다시 만든다.
// 앵커링 없이 다시 만들면 체인이 모르는 Root로 증명을 내게 되고, 검증자가 전부 거절한다.
let registry = await buildRegistry({ accounts, revoked });

const bankId = bankIdOf(config.recipientBankId);

/**
 * 현재 회차는 체인이 기준이다. 메모리에 따로 세지 않는다.
 * 따로 세면 앵커링하지 않은 회차로 증명을 발급하게 되고, 검증자는 그 회차를 모르므로
 * 멀쩡한 계좌가 차단된다.
 */
function currentAnchor() {
  return latestAnchor(bankId);
}

function currentEpoch() {
  return currentAnchor().rootEpoch;
}

function normalize(accountNumber) {
  return String(accountNumber ?? "").replace(/[^0-9]/g, "");
}

function findAccount(accountNumber) {
  const wanted = normalize(accountNumber);
  return accounts.find((account) => normalize(account.accountNumber) === wanted) ?? null;
}

/**
 * 증명 발급 가능 여부. 판정 규칙 자체는 Registry와 같은 것을 쓴다.
 * 규칙이 두 벌이면 판정과 트리가 어긋난다.
 *
 * 판정을 통과해도 현재 회차 트리에 자리가 없으면 증명을 만들 수 없다. 폐기 뒤 복구한
 * 계좌가 그렇다. 다음 회차 Root가 올라가야 다시 들어온다.
 * 사유는 은행 안에서만 쓰고, 응답은 계획서 2.7에 따라 NOT_ELIGIBLE 하나로 합친다.
 */
function eligibility(account) {
  const verdict = eligibilityOf(account, { revoked, minAccountAgeDays: config.minAccountAgeDays });
  if (!verdict.ok) return verdict;
  if (!recordOf(account)) return { ok: false, reason: "NOT_IN_CURRENT_TREE" };
  return verdict;
}

function recordOf(account) {
  return registry.records.find((entry) => entry.id === account.id && entry.inTree) ?? null;
}

/** Registry의 record로 회로 입력을 만들어 증명을 생성한다. */
async function makeProof(account, request) {
  const record = recordOf(account);
  if (!record) return null;

  const anchor = currentAnchor();
  if (anchor.rootEpoch === 0) return null; // 아직 앵커된 Root가 없다

  // 체인에 올라간 Root가 내 트리와 다르면 증명을 내도 검증자가 거절한다. 밖에서 따로
  // 앵커링했을 때 이렇게 된다. 멀쩡한 계좌를 차단으로 만들지 말고 장애로 답한다.
  if (anchor.eligibilityRoot !== registry.eligibilityRoot) {
    throw new Error(
      `체인 Root ${anchor.eligibilityRoot} 와 내 트리 ${registry.eligibilityRoot} 가 다르다`,
    );
  }

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
      rootEpoch: anchor.rootEpoch,
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
    // 체인이 죽어도 목록 자체는 보여준다. 회차만 비운다.
    rootEpoch: (() => {
      try {
        return currentEpoch();
      } catch {
        return null;
      }
    })(),
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

  // Registry가 트리를 다시 만들고 새 Root를 다음 회차로 앵커링한다.
  // 이때 폐기된 계좌가 트리에서 빠진다. 앵커링에 성공한 뒤에만 메모리를 교체한다.
  "POST /admin/rebuild-root": async () => {
    const rebuilt = await buildRegistry({ accounts, revoked });
    const rootEpoch = currentEpoch() + 1;
    anchorRoot({
      bankId,
      eligibilityRoot: rebuilt.eligibilityRoot,
      policyHash: rebuilt.derived.policyHash,
      rootEpoch,
      validUntil: Math.floor(Date.now() / 1000) + config.rootPeriodSeconds,
      meta: circuitMeta(),
    });
    registry = rebuilt;
    console.log(
      `[recipient-bank] Root 앵커링 rootEpoch=${rootEpoch} root=${rebuilt.eligibilityRoot} 트리 안 ${rebuilt.inTreeCount}개`,
    );
    return { rootEpoch, eligibilityRoot: rebuilt.eligibilityRoot, inTree: rebuilt.inTreeCount };
  },
};

startServer({ name: "recipient-bank", port: config.ports.recipientBank, routes });
