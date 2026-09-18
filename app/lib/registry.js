// Registry. 계좌 목록에서 적격 트리를 만들고 Root와 Merkle path를 낸다.
//
// 적격 판정과 트리 구성이 여기 한 곳에 있다. 둘이 떨어져 있으면 "판정은 적격인데
// 트리에 자리가 없다" 같은 어긋남이 생긴다. 출력 모양은 기준값 파일
// app/fixtures/registry.sample.json 과 같다. IM_PROJECT_PLAN.md 2.2, 2.6.1
import {
  accountHash,
  hashToField,
  normalizeAccountNumber,
  poseidon,
  recipientAccountRef,
  refKeyOf,
  toHex,
} from "./field.js";
import { config, env } from "../config.js";

/** 회로 컴파일 시점에 고정된다. 바꾸면 회로도 같이 바꿔야 한다. 계획서 2.2 */
export const TREE_DEPTH = 16;

/**
 * 기준값과 실행 중 Registry가 같은 Root를 내려면 이 값들이 같아야 한다.
 * validUntil은 재현성을 위해 고정값이다. 운영에서는 발급 시각 + 재확인 기한이다.
 */
export const defaultParams = {
  protocolId: "IM-RECIPIENT-ELIGIBILITY/1",
  recipientBankId: config.recipientBankId,
  policy: "recipient-eligibility-v2",
  issuer: config.recipientIssuerId,
  // 데모 전용 고정 키다. 운영에서는 HSM이나 KMS에 두고 절대 문서에 적지 않는다.
  bankSecret: env("BANK_SECRET", "demo-bank-secret-do-not-use-in-production"),
  validUntil: 1791590400,
  minAccountAgeDays: config.minAccountAgeDays,
};

/**
 * 적격 판정. 사유는 은행 안에서만 쓰고 밖으로 내보내지 않는다. 계획서 2.6.1, 2.7
 * revoked는 accountNumber -> 상태 문자열인 hot revocation 목록이다. 계획서 2.8
 */
export function eligibilityOf(account, { revoked, minAccountAgeDays } = {}) {
  const days = minAccountAgeDays ?? defaultParams.minAccountAgeDays;
  if (!account) return { ok: false, reason: "UNKNOWN_ACCOUNT" };
  const hot = revoked?.get(account.accountNumber);
  if (hot) return { ok: false, reason: hot };
  if (account.status !== "ELIGIBLE") return { ok: false, reason: account.status };
  if (!account.kycComplete) return { ok: false, reason: "KYC_INCOMPLETE" };
  if (account.openedDaysAgo < days) return { ok: false, reason: "NEW_ACCOUNT" };
  return { ok: true, reason: "ELIGIBLE" };
}

/** 빈 서브트리 해시. 빈 자리의 leaf 값은 0이다. */
async function zeroHashes(depth) {
  const zeros = [0n];
  for (let level = 0; level < depth; level++) {
    zeros.push(await poseidon([zeros[level], zeros[level]]));
  }
  return zeros;
}

/**
 * 희소 트리. 실제 계좌가 있는 자리만 계산하고 나머지는 빈 서브트리 해시를 쓴다.
 * 그래서 비용이 트리 크기가 아니라 계좌 수에 비례한다. 계획서 2.2
 * 층을 한 번만 계산해서 모든 path가 같은 층을 공유한다.
 */
async function buildLevels(leafByIndex, depth, zeros) {
  const levels = [new Map(leafByIndex)];
  for (let d = 0; d < depth; d++) {
    const current = levels[d];
    const next = new Map();
    for (const index of current.keys()) {
      const parent = index >> 1;
      if (next.has(parent)) continue;
      const left = current.get(parent * 2) ?? zeros[d];
      const right = current.get(parent * 2 + 1) ?? zeros[d];
      next.set(parent, await poseidon([left, right]));
    }
    levels.push(next);
  }
  return levels;
}

/** 인덱스 자리의 inclusion path. pathIndices[i] = 1 이면 현재 노드가 오른쪽 자식이다. */
function merklePath(levels, index, depth, zeros) {
  const pathElements = [];
  const pathIndices = [];
  let idx = index;
  for (let d = 0; d < depth; d++) {
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    pathElements.push(levels[d].get(sibling) ?? zeros[d]);
    pathIndices.push(idx % 2);
    idx = idx >> 1;
  }
  return { pathElements, pathIndices };
}

/** path를 되짚어 Root를 다시 만든다. 회로가 하는 계산과 같다. */
async function rootFromPath(leaf, pathElements, pathIndices) {
  let node = BigInt(leaf);
  for (let i = 0; i < pathElements.length; i++) {
    node =
      pathIndices[i] === 0
        ? await poseidon([node, pathElements[i]])
        : await poseidon([pathElements[i], node]);
  }
  return node;
}

/**
 * 적격 트리를 만든다.
 *
 * 인덱스는 등록 순서로 영구 배정한다. 적격이 아닌 계좌도 자리를 차지하며 leaf만 0이다.
 * 자리를 재사용하면 폐기된 계좌의 옛 증명이 다른 계좌 자리에서 살아난다. 계획서 2.2
 */
export async function buildRegistry({ accounts, params: overrides, revoked } = {}) {
  const params = { ...defaultParams, ...overrides };

  // 트리 자리보다 계좌가 많으면 인덱스가 넘쳐 엉뚱한 자리의 path가 나온다.
  if (accounts.length > 2 ** TREE_DEPTH) {
    throw new Error(`계좌가 트리 용량 ${2 ** TREE_DEPTH}개를 넘는다: ${accounts.length}개`);
  }

  // 같은 계좌가 두 자리를 차지하면 한쪽을 폐기해도 다른 쪽 leaf로 증명이 계속 나온다.
  // 표기만 다른 같은 계좌도 같은 계좌다.
  const seen = new Set();
  for (const account of accounts) {
    const key = normalizeAccountNumber(account.accountNumber);
    if (seen.has(key)) throw new Error(`계좌번호가 중복이다: ${account.id} (${key})`);
    seen.add(key);
  }

  const zeros = await zeroHashes(TREE_DEPTH);
  const policyHash = hashToField(params.policy);
  const issuerId = hashToField(params.issuer);
  // 은행·프로토콜마다 하나다. 증명을 만들 때 회로의 비공개 입력으로 들어간다.
  const refKey = refKeyOf({
    bankSecret: params.bankSecret,
    protocolId: params.protocolId,
    bankId: params.recipientBankId,
  });

  const leafByIndex = new Map();
  const records = [];

  for (const [index, account] of accounts.entries()) {
    const ref = await recipientAccountRef({ refKey, accountNumber: account.accountNumber });
    const accountField = accountHash(account.accountNumber);
    const verdict = eligibilityOf(account, {
      revoked,
      minAccountAgeDays: params.minAccountAgeDays,
    });

    if (!verdict.ok) {
      records.push({
        id: account.id,
        index,
        accountHash: toHex(accountField),
        recipientAccountRef: toHex(ref),
        inTree: false,
        leaf: toHex(0),
        excludedBecause: verdict.reason,
      });
      continue;
    }

    const leaf = await poseidon([ref, 1n, policyHash, BigInt(params.validUntil), issuerId]);
    leafByIndex.set(index, leaf);
    records.push({
      id: account.id,
      index,
      accountHash: toHex(accountField),
      recipientAccountRef: toHex(ref),
      inTree: true,
      eligibilityStatus: 1,
      validUntil: params.validUntil,
      leaf: toHex(leaf),
    });
  }

  const levels = await buildLevels(leafByIndex, TREE_DEPTH, zeros);
  const root = levels[TREE_DEPTH].get(0) ?? zeros[TREE_DEPTH];

  for (const record of records) {
    if (!record.inTree) continue;
    const { pathElements, pathIndices } = merklePath(levels, record.index, TREE_DEPTH, zeros);

    // 자체 점검. path가 Root를 다시 만들어내지 못하면 트리가 틀린 것이다.
    const rebuilt = await rootFromPath(record.leaf, pathElements, pathIndices);
    if (rebuilt !== root) {
      throw new Error(`record ${record.id}: path가 Root를 재현하지 못한다`);
    }

    record.pathElements = pathElements.map(toHex);
    record.pathIndices = pathIndices;
  }

  return {
    treeDepth: TREE_DEPTH,
    params,
    derived: {
      policyHash: toHex(policyHash),
      issuerId: toHex(issuerId),
      // 데모 값이다. 운영에서는 이 값이 파일로 나가면 안 된다.
      refKey: toHex(refKey),
      zeroLeaf: toHex(0),
      zeroSubtreeHashes: zeros.map(toHex),
    },
    eligibilityRoot: toHex(root),
    records,
    inTreeCount: leafByIndex.size,
  };
}
