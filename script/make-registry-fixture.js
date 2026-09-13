// Registry 출력의 기준값을 만든다.
//
// 이 파일이 만드는 app/fixtures/registry.sample.json 은 샘플이 아니라 테스트 벡터다.
// Registry를 구현한 뒤 같은 입력으로 같은 Root가 나오는지 대조하면, 값 표현이나
// Poseidon 사용법이 어긋났는지 바로 드러난다.
//
// 실행: node script/make-registry-fixture.js
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashToField, poseidon, recipientAccountRef, toHex } from "../app/lib/field.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 계획서 2.2. 회로 컴파일 시점에 고정되는 값이다.
const TREE_DEPTH = 16;

const params = {
  protocolId: "IM-RECIPIENT-ELIGIBILITY/1",
  recipientBankId: "bank-b",
  policy: "recipient-eligibility-v2",
  issuer: "bank-b-eligibility-issuer",
  // 데모 전용 고정 키다. 운영에서는 HSM이나 KMS에 두고 절대 문서에 적지 않는다.
  bankSecret: "demo-bank-secret-do-not-use-in-production",
  // 재현 가능해야 하므로 record 기한을 고정값으로 둔다. 계획서 2.5의 재확인 기한이다.
  validUntil: 1791590400,
  rootEpoch: 1,
  minAccountAgeDays: 30,
};

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
 */
async function buildTree(leafByIndex, depth, zeros) {
  let level = new Map(leafByIndex);
  for (let d = 0; d < depth; d++) {
    const next = new Map();
    for (const index of level.keys()) {
      const parent = index >> 1;
      if (next.has(parent)) continue;
      const left = level.get(parent * 2) ?? zeros[d];
      const right = level.get(parent * 2 + 1) ?? zeros[d];
      next.set(parent, await poseidon([left, right]));
    }
    level = next;
  }
  return level.get(0) ?? zeros[depth];
}

/** 인덱스 자리의 inclusion path. pathIndices[i] = 1 이면 현재 노드가 오른쪽 자식이다. */
async function merklePath(leafByIndex, index, depth, zeros) {
  const pathElements = [];
  const pathIndices = [];
  let level = new Map(leafByIndex);
  let idx = index;

  for (let d = 0; d < depth; d++) {
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    pathElements.push(level.get(siblingIndex) ?? zeros[d]);
    pathIndices.push(idx % 2);

    const next = new Map();
    for (const key of level.keys()) {
      const parent = key >> 1;
      if (next.has(parent)) continue;
      const left = level.get(parent * 2) ?? zeros[d];
      const right = level.get(parent * 2 + 1) ?? zeros[d];
      next.set(parent, await poseidon([left, right]));
    }
    level = next;
    idx = idx >> 1;
  }
  return { pathElements, pathIndices };
}

/** path를 되짚어 Root를 다시 만든다. 회로가 하는 계산과 같다. */
async function rootFromPath(leaf, pathElements, pathIndices) {
  let node = leaf;
  for (let i = 0; i < pathElements.length; i++) {
    node =
      pathIndices[i] === 0
        ? await poseidon([node, pathElements[i]])
        : await poseidon([pathElements[i], node]);
  }
  return node;
}

const accounts = JSON.parse(await readFile(join(ROOT, "data", "accounts.json"), "utf8"));
const zeros = await zeroHashes(TREE_DEPTH);
const policyHash = hashToField(params.policy);
const issuerId = hashToField(params.issuer);

// 인덱스는 등록 시점에 영구 배정한다. 적격이 아닌 계좌도 자리를 차지하며 leaf만 0이다.
// 계획서 2.2
const leafByIndex = new Map();
const records = [];

for (const [index, account] of accounts.entries()) {
  const ref = recipientAccountRef({
    bankSecret: params.bankSecret,
    protocolId: params.protocolId,
    bankId: params.recipientBankId,
    accountNumber: account.accountNumber,
  });
  const eligible =
    account.status === "ELIGIBLE" &&
    account.kycComplete &&
    account.openedDaysAgo >= params.minAccountAgeDays;

  if (!eligible) {
    records.push({
      id: account.id,
      index,
      recipientAccountRef: toHex(ref),
      inTree: false,
      leaf: toHex(0),
      excludedBecause:
        account.status !== "ELIGIBLE"
          ? account.status
          : !account.kycComplete
            ? "KYC_INCOMPLETE"
            : "NEW_ACCOUNT",
    });
    continue;
  }

  const leaf = await poseidon([ref, 1n, policyHash, BigInt(params.validUntil), issuerId]);
  leafByIndex.set(index, leaf);
  records.push({
    id: account.id,
    index,
    recipientAccountRef: toHex(ref),
    inTree: true,
    eligibilityStatus: 1,
    validUntil: params.validUntil,
    leaf: toHex(leaf),
  });
}

const root = await buildTree(leafByIndex, TREE_DEPTH, zeros);

for (const record of records) {
  if (!record.inTree) continue;
  const { pathElements, pathIndices } = await merklePath(
    leafByIndex,
    record.index,
    TREE_DEPTH,
    zeros,
  );

  // 자체 점검. path가 Root를 다시 만들어내지 못하면 기준값이 틀린 것이다.
  const rebuilt = await rootFromPath(BigInt(record.leaf), pathElements, pathIndices);
  if (rebuilt !== root) {
    throw new Error(`record ${record.id}: path가 Root를 재현하지 못한다`);
  }

  record.pathElements = pathElements.map(toHex);
  record.pathIndices = pathIndices;
}

const fixture = {
  note: "Registry 구현이 같은 Root를 내는지 대조하는 기준값이다. 손으로 고치지 말고 이 스크립트로 다시 만든다.",
  treeDepth: TREE_DEPTH,
  params,
  derived: {
    policyHash: toHex(policyHash),
    issuerId: toHex(issuerId),
    zeroLeaf: toHex(0),
    zeroSubtreeHashes: zeros.map(toHex),
  },
  rootEpoch: params.rootEpoch,
  eligibilityRoot: toHex(root),
  records,
};

const out = join(ROOT, "app", "fixtures", "registry.sample.json");
await writeFile(out, JSON.stringify(fixture, null, 2) + "\n");

console.log(`eligibilityRoot ${toHex(root)}`);
console.log(`트리 안 ${leafByIndex.size}개, 제외 ${records.length - leafByIndex.size}개`);
console.log(`기록: ${out}`);
