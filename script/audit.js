// 공격과 경계값 감사.
//
// test-e2e.js가 정상·실패 흐름을 본다면 이 파일은 일부러 망가뜨린 입력과 공격을 본다.
// 모든 항목의 기준은 하나다. 증명 없이 ALLOW가 나오면 안 되고, 장애가 차단으로,
// 차단이 장애로 둔갑하면 안 된다.
//
// 전제: anvil이 떠 있다. 배포와 앵커링, 서버 기동은 이 파일이 한다.
// 실행: node script/audit.js
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, url } from "../app/config.js";
import { FIELD_PRIME, accountHash, toHex } from "../app/lib/field.js";
import { buildRegistry } from "../app/lib/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNTS = JSON.parse(readFileSync(join(ROOT, "data", "accounts.json"), "utf8"));
const num = (id) => ACCOUNTS.find((a) => a.id === id).accountNumber;
const SENDER = `http://127.0.0.1:${config.ports.senderBank}`;

let passed = 0;
const failures = [];
function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  통과  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  실패  ${name}${detail ? `  (${detail})` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(target, body) {
  const response = await fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = {};
  try {
    parsed = await response.json();
  } catch {
    /* 본문이 JSON이 아닐 수 있다 */
  }
  return { status: response.status, body: parsed };
}

const children = new Map();
function killChildren() {
  for (const child of children.values()) child.kill("SIGKILL");
  children.clear();
}
// 중간에 터져도 띄운 서버를 남기지 않는다. 남으면 다음 실행이 옛 코드를 상대한다.
process.on("exit", killChildren);
for (const signal of ["SIGINT", "SIGTERM", "uncaughtException"]) {
  process.on(signal, (error) => {
    killChildren();
    if (error) console.error(error);
    process.exit(1);
  });
}

function start(name) {
  const child = spawn(process.execPath, [join(ROOT, "app", name, "server.js")], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  children.set(name, child);
}
async function waitFor(target, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(target);
      return;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`${target} 가 뜨지 않는다`);
}

const verify = (payload) => post(`${url.verifier}/api/v1/recipient/eligibility/verify`, payload);
const transfer = (accountNumber) => post(`${SENDER}/api/v1/transfer/check`, { accountNumber });
const nonce = async () =>
  (await post(`${url.verifier}/api/v1/recipient/eligibility/nonce`, {})).body.requestNonce;

async function freshRequest(accountId) {
  const requestNonce = await nonce();
  const issued = await post(`${url.recipientBank}/interbank/v1/recipient/eligibility/proof`, {
    protocolVersion: config.protocolVersion,
    senderBankId: config.senderBankId,
    verifierId: config.verifierId,
    requestNonce,
    recipientBankId: config.recipientBankId,
    accountNumber: num(accountId),
  });
  if (issued.body.result !== "PROOF") throw new Error(`증명을 못 받았다: ${JSON.stringify(issued.body)}`);
  return {
    accountHash: toHex(accountHash(num(accountId))),
    proof: issued.body.proof,
    publicSignals: issued.body.publicSignals,
    envelope: {
      senderBankId: config.senderBankId,
      verifierId: config.verifierId,
      requestNonce,
      recipientBankId: config.recipientBankId,
      ...issued.body.envelope,
    },
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const says = (r, status, decision) => r.body.status === status && r.body.decision === decision;
const shows = (r) => `${r.status} ${r.body.status} ${r.body.decision}`;
const stoppedAt = (r) => r.body.steps?.find((e) => !e.ok)?.name ?? "없음";
/** 어떤 경우에도 이것만은 안 된다. */
const notAllowed = (r) => r.body.decision !== "ALLOW";

async function attacked(accountId, mutate) {
  const request = await freshRequest(accountId);
  mutate(request);
  return verify(request);
}

console.log("\n[준비]");
// 이미 떠 있는 서버가 있으면 새로 띄운 것이 포트를 못 잡고, 검사는 옛 코드를 상대하게 된다.
// 실제로 한 번 그렇게 돌아서 고친 내용이 반영되지 않은 결과를 봤다.
for (const [label, target] of [
  ["수취은행", `${url.recipientBank}/admin/accounts`],
  ["검증자", `${url.verifier}/nope`],
  ["송금은행", `${SENDER}/api/v1/audit-log`],
]) {
  try {
    await fetch(target);
    console.error(`${label} 포트가 이미 쓰이고 있다. 기존 서버를 끄고 다시 실행해라.`);
    process.exit(1);
  } catch {
    /* 비어 있다 */
  }
}

try {
  execFileSync(process.execPath, [join(ROOT, "script", "deploy-anchor.js")], { cwd: ROOT, stdio: "ignore" });
  execFileSync(process.execPath, [join(ROOT, "script", "anchor-root.js")], { cwd: ROOT, stdio: "ignore" });
} catch (error) {
  console.error("anvil이 떠 있는지 확인해라.", error.message);
  process.exit(1);
}
for (const name of ["recipient-bank", "verifier", "sender-bank"]) start(name);
await waitFor(`${url.recipientBank}/admin/accounts`);
await waitFor(`${url.verifier}/nope`);
await waitFor(`${SENDER}/api/v1/audit-log`);
console.log("  서버 세 대 기동");

// ── 증명 위조 ────────────────────────────────────────────────────────────────
console.log("\n[증명 위조]");
{
  const cases = [
    ["퇴화 점 pi_a = (0,0,0)", (r) => { r.proof.pi_a = ["0", "0", "0"]; }],
    ["퇴화 점 pi_c = (0,0,0)", (r) => { r.proof.pi_c = ["0", "0", "0"]; }],
    ["곡선 밖의 pi_b", (r) => { r.proof.pi_b[0] = ["1", "2"]; }],
    ["좌표가 300자리 수", (r) => { r.proof.pi_c = ["9".repeat(300), "1", "1"]; }],
    ["pi_a와 pi_c 뒤바꿈", (r) => { const a = r.proof.pi_a; r.proof.pi_a = r.proof.pi_c; r.proof.pi_c = a; }],
    ["증명 전체를 0으로", (r) => {
      r.proof.pi_a = ["0", "0", "1"];
      r.proof.pi_b = [["0", "0"], ["0", "0"], ["1", "0"]];
      r.proof.pi_c = ["0", "0", "1"];
    }],
    ["다른 곡선이라고 주장", (r) => { r.proof.curve = "bls12381"; }],
    ["groth16이 아니라고 주장", (r) => { r.proof.protocol = "plonk"; }],
    ["방식 표기 누락", (r) => { delete r.proof.protocol; }],
  ];
  for (const [label, mutate] of cases) {
    const response = await attacked("A", mutate);
    check(label, notAllowed(response), shows(response));
  }
}

console.log("\n[공개 신호 조작]");
{
  const canonical = await freshRequest("A");
  // 필드 크기를 더한 값. 같은 원소를 가리키는 다른 표기다.
  const shifted = clone(canonical);
  shifted.publicSignals[0] = "0x" + (BigInt(canonical.publicSignals[0]) + FIELD_PRIME).toString(16);
  shifted.accountHash = shifted.publicSignals[0];
  const shiftedResponse = await verify(shifted);
  check("필드 크기를 더한 표기 거절", notAllowed(shiftedResponse), shows(shiftedResponse));
  check("범위 검사에서 멈춘다", stoppedAt(shiftedResponse).includes("형식"), stoppedAt(shiftedResponse));

  for (const [label, index] of [
    ["Root", 1],
    ["정책 해시", 2],
    ["발급기관", 3],
    ["요청 바인딩", 5],
  ]) {
    const response = await attacked("A", (r) => {
      r.publicSignals[index] = toHex(BigInt(r.publicSignals[index]) + 1n);
    });
    check(`${label} 한 비트 변경 거절`, notAllowed(response), shows(response));
  }

  const future = await attacked("A", (r) => {
    r.publicSignals[4] = toHex(Math.floor(Date.now() / 1000) + 99_999);
  });
  check("검증 시각을 미래로 미는 것 거절", notAllowed(future), shows(future));
  check("시각 단계에서 멈춘다", stoppedAt(future).includes("시각"), stoppedAt(future));

  const zeroed = await attacked("A", (r) => { r.publicSignals = r.publicSignals.map(() => toHex(0)); });
  check("공개 신호 전부 0 거절", notAllowed(zeroed), shows(zeroed));

  const extra = await attacked("A", (r) => { r.publicSignals.push(toHex(1)); });
  check("공개 신호를 하나 더 붙임 거절", notAllowed(extra), shows(extra));
}

console.log("\n[계좌 바꿔치기]");
{
  // 적격한 A의 증명으로 차단돼야 할 계좌들의 답을 만들려는 시도.
  for (const victim of ["D", "E", "F"]) {
    const response = await attacked("A", (r) => { r.accountHash = toHex(accountHash(num(victim))); });
    check(`A의 증명을 ${victim}의 답으로 쓰기 거절`, notAllowed(response), shows(response));
  }
  // 공개 신호까지 맞춰도 leaf가 달라져 트리에 없다.
  const both = await attacked("A", (r) => {
    r.accountHash = toHex(accountHash(num("F")));
    r.publicSignals[0] = r.accountHash;
  });
  check("공개 신호까지 맞춰도 거절", notAllowed(both), shows(both));
  check("증명 검증까지 간다", stoppedAt(both).includes("영지식증명"), stoppedAt(both));

  // 계좌번호 표기만 바꿔 다른 계좌인 척.
  const spaced = await post(`${SENDER}/api/v1/transfer/check`, { accountNumber: " 110 234 567890 " });
  check("구분자만 다른 계좌번호는 같은 계좌", says(spaced, "ELIGIBLE", "ALLOW"), shows(spaced));
  const padded = await post(`${SENDER}/api/v1/transfer/check`, { accountNumber: "0110-234-567890" });
  check("앞에 0을 붙인 계좌번호는 다른 계좌", says(padded, "NOT_ELIGIBLE", "BLOCK"), shows(padded));
}

console.log("\n[요청 재생과 가로채기]");
{
  const request = await freshRequest("A");
  const results = await Promise.all([verify(clone(request)), verify(clone(request)), verify(clone(request))]);
  const allowed = results.filter((r) => r.body.decision === "ALLOW").length;
  check("같은 증명을 동시에 3번 보내도 한 번만 통과", allowed === 1, `${allowed}건 통과`);

  const stale = await freshRequest("A");
  await verify(clone(stale));
  const replayed = await verify(clone(stale));
  check("나중에 다시 보내도 거절", notAllowed(replayed), shows(replayed));

  // 검증자가 발급하지 않은 nonce를 지어냄.
  const forged = await attacked("A", (r) => { r.envelope.requestNonce = "0x00" + "5a".repeat(31); });
  check("서명이 없는 nonce 거절", notAllowed(forged), shows(forged));
  check("nonce 단계에서 멈춘다", stoppedAt(forged).includes("nonce"), stoppedAt(forged));

  // 발급받은 nonce의 서명을 한 글자 고침.
  const tweaked = await attacked("A", (r) => {
    const n = r.envelope.requestNonce;
    r.envelope.requestNonce = n.slice(0, -1) + (n.at(-1) === "0" ? "1" : "0");
  });
  check("nonce 서명을 고치면 거절", notAllowed(tweaked), shows(tweaked));
}

console.log("\n[신원 위장]");
{
  const cases = [
    ["다른 송금은행", (r) => { r.envelope.senderBankId = "bank-x"; }],
    ["다른 검증자", (r) => { r.envelope.verifierId = "bank-a-other"; }],
    ["다른 수취은행", (r) => { r.envelope.recipientBankId = "bank-z"; }],
    ["빈 은행 이름", (r) => { r.envelope.senderBankId = ""; }],
    ["64자를 넘는 이름", (r) => { r.envelope.senderBankId = "a".repeat(65); }],
    ["이름이 객체", (r) => { r.envelope.verifierId = { toString: () => config.verifierId }; }],
    ["다른 회로", (r) => { r.envelope.circuitId = "eligible-account-v2"; }],
    ["다른 검증키", (r) => { r.envelope.verifyingKeyHash = toHex(1); }],
  ];
  for (const [label, mutate] of cases) {
    const response = await attacked("A", mutate);
    check(`${label} 거절`, notAllowed(response), shows(response));
  }
}

console.log("\n[회차 조작]");
{
  const cases = [
    ["회차 0", 0],
    ["음수 회차", -1],
    ["소수 회차", 1.5],
    ["아주 큰 회차", 2 ** 40],
    ["회차가 문자열", "one"],
    ["회차가 배열", [1]],
    ["회차가 참", true],
  ];
  for (const [label, value] of cases) {
    const response = await attacked("A", (r) => { r.envelope.rootEpoch = value; });
    check(`${label} 거절`, notAllowed(response), shows(response));
  }
}

console.log("\n[본문 형태]");
{
  const bodies = [
    ["숫자 본문", 42],
    ["문자열 본문", "hello"],
    ["배열 본문", [1, 2, 3]],
    ["봉투가 배열", { accountHash: toHex(1), proof: {}, publicSignals: [], envelope: [] }],
    ["공개 신호가 객체", { accountHash: toHex(1), proof: {}, publicSignals: {}, envelope: {} }],
    ["프로토타입 오염 시도", { __proto__: { decision: "ALLOW" }, accountHash: toHex(1) }],
  ];
  for (const [label, body] of bodies) {
    const response = await verify(body);
    check(`${label} 거절`, notAllowed(response), shows(response));
  }
  check("프로토타입이 더럽혀지지 않았다", {}.decision === undefined);

  const oversized = await fetch(`${url.verifier}/api/v1/recipient/eligibility/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pad: "x".repeat(1_200_000) }),
  });
  check("1MB를 넘는 본문은 400", oversized.status === 400, String(oversized.status));
  const alive = await fetch(`${url.verifier}/nope`);
  check("그 뒤에도 서버가 살아 있다", alive.status === 404, String(alive.status));
}

// ── 가용성 공격 ──────────────────────────────────────────────────────────────
console.log("\n[가용성]");
{
  // nonce 발급은 인증이 없다. 반복 호출로 정상 요청을 막을 수 있으면 안 된다.
  // 동시 연결을 너무 올리면 OS의 accept 대기열이 넘쳐 클라이언트 쪽이 먼저 끊긴다.
  // 보려는 것은 연결 수가 아니라 발급 누적이므로, 현실적인 동시 수로 나눠 보낸다.
  const before = Date.now();
  let issued = 0;
  let refused = 0;
  for (let round = 0; round < 200; round++) {
    const batch = await Promise.all(
      [...Array(50)].map(() =>
        post(`${url.verifier}/api/v1/recipient/eligibility/nonce`, {}).catch(() => ({ status: 0 })),
      ),
    );
    issued += batch.filter((r) => r.status === 200).length;
    // 연결이 끊긴 것(status 0)은 OS 대기열 문제다. 서버가 발급을 거부한 것만 센다.
    refused += batch.filter((r) => r.status >= 400).length;
  }
  const elapsed = Date.now() - before;
  check(`nonce 1만 건 발급에 거부가 없다 (발급 ${issued}, 거부 ${refused})`, refused === 0, String(refused));
  const after = await transfer(num("A"));
  check(`발급 폭주 뒤에도 정상 송금 허용 (${elapsed}ms)`, says(after, "ELIGIBLE", "ALLOW"), shows(after));

  const parallel = await Promise.all([...Array(5)].map(() => transfer(num("A"))));
  check("동시 송금 5건 모두 허용", parallel.every((r) => r.body.decision === "ALLOW"),
    parallel.map((r) => r.body.status).join(" "));
}

// ── Registry 무결성 ──────────────────────────────────────────────────────────
console.log("\n[Registry 무결성]");
{
  const base = { status: "ELIGIBLE", kycComplete: true, openedDaysAgo: 400 };
  const rejects = async (label, accounts) => {
    try {
      await buildRegistry({ accounts });
      check(label, false, "거절하지 않았다");
    } catch (error) {
      check(label, true, error.message.slice(0, 40));
    }
  };

  await rejects("같은 계좌번호 두 건 거절", [
    { id: "X", accountNumber: "110-234-567890", ...base },
    { id: "Y", accountNumber: "110-234-567890", ...base },
  ]);
  await rejects("표기만 다른 같은 계좌 거절", [
    { id: "X", accountNumber: "110-234-567890", ...base },
    { id: "Y", accountNumber: "110234567890", ...base },
  ]);
  await rejects("숫자가 없는 계좌번호 거절", [{ id: "X", accountNumber: "없음", ...base }]);
  await rejects("트리 용량을 넘는 계좌 수 거절",
    Array.from({ length: 2 ** 16 + 1 }, (_, i) => ({ id: `X${i}`, accountNumber: String(i), ...base })));

  // .env에 항목을 비워 두면 기본값으로 떨어져야 한다. 빈 문자열이 그대로 흘러가면
  // 은행 비밀키가 ""가 되어 아무 오류 없이 다른 Root가 나온다.
  const fixture = JSON.parse(readFileSync(join(ROOT, "app", "fixtures", "registry.sample.json"), "utf8"));
  const before = process.env.BANK_SECRET;
  process.env.BANK_SECRET = "";
  const { buildRegistry: rebuilt } = await import(`../app/lib/registry.js?empty=${Date.now()}`);
  const blank = await rebuilt({ accounts: ACCOUNTS });
  if (before === undefined) delete process.env.BANK_SECRET;
  else process.env.BANK_SECRET = before;
  check("빈 BANK_SECRET은 기본값으로 떨어진다", blank.eligibilityRoot === fixture.eligibilityRoot, blank.eligibilityRoot);

  const empty = await buildRegistry({ accounts: [] });
  check("계좌가 없으면 빈 트리 Root", empty.eligibilityRoot === empty.derived.zeroSubtreeHashes[16], empty.eligibilityRoot);
  check("빈 트리에는 record가 없다", empty.records.length === 0);

  // 폐기 대상이 트리에 하나뿐인 경우에도 자리는 남는다.
  const single = await buildRegistry({
    accounts: [{ id: "X", accountNumber: "110-234-567890", ...base }],
    revoked: new Map([["110-234-567890", "REVOKED"]]),
  });
  check("전부 폐기되면 빈 트리와 같은 Root", single.eligibilityRoot === empty.eligibilityRoot);
  check("폐기돼도 자리는 남는다", single.records.length === 1 && single.records[0].inTree === false);
}

// ── 관리 통로 ────────────────────────────────────────────────────────────────
console.log("\n[관리 통로]");
{
  const unknown = await post(`${SENDER}/admin/revoke`, { accountNumber: "000-000-000000" });
  check("없는 계좌 폐기는 404", unknown.status === 404, String(unknown.status));

  const badStatus = await post(`${SENDER}/admin/revoke`, { accountNumber: num("B"), status: "무엇이든" });
  check("모르는 상태값은 400", badStatus.status === 400, `${badStatus.status} ${JSON.stringify(badStatus.body)}`);

  const ok = await post(`${SENDER}/admin/revoke`, { accountNumber: num("B"), status: "SUSPENDED" });
  check("아는 상태값은 통과", ok.status === 200 && ok.body.status === "SUSPENDED", JSON.stringify(ok.body));
  const blocked = await transfer(num("B"));
  check("폐기한 계좌는 즉시 차단", says(blocked, "NOT_ELIGIBLE", "BLOCK"), shows(blocked));
  await post(`${SENDER}/admin/restore`, { accountNumber: num("B") });
  check("복구하면 다시 허용", says(await transfer(num("B")), "ELIGIBLE", "ALLOW"));

  // 이미 적격이 아닌 계좌를 폐기했다가 복구해도 적격으로 바뀌지 않는다.
  await post(`${SENDER}/admin/revoke`, { accountNumber: num("D") });
  await post(`${SENDER}/admin/restore`, { accountNumber: num("D") });
  const stillBlocked = await transfer(num("D"));
  check("정지 계좌는 복구해도 차단", says(stillBlocked, "NOT_ELIGIBLE", "BLOCK"), shows(stillBlocked));
}

console.log("\n[정보 노출]");
{
  const responses = await Promise.all(["D", "E", "F"].map((id) => transfer(num(id))));
  const text = JSON.stringify(responses.map((r) => ({ ...r.body, timeline: undefined })));
  check("응답에 내부 사유가 없다", !/SUSPENDED|KYC_INCOMPLETE|NEW_ACCOUNT|REVOKED|UNKNOWN_ACCOUNT/.test(text));
  check("세 가지 모두 같은 상태로 합쳐진다", new Set(responses.map((r) => r.body.status)).size === 1);

  const proofOnly = await post(`${url.recipientBank}/interbank/v1/recipient/eligibility/proof`, {
    protocolVersion: config.protocolVersion,
    senderBankId: config.senderBankId,
    verifierId: config.verifierId,
    requestNonce: await nonce(),
    recipientBankId: config.recipientBankId,
    accountNumber: num("E"),
  });
  check("수취은행 응답에도 사유가 없다", !("reason" in proofOnly.body), JSON.stringify(proofOnly.body));

  const list = await (await fetch(`${SENDER}/admin/accounts`)).json();
  check("관리 화면에는 사유가 보인다", list.accounts.some((a) => a.reason === "KYC_INCOMPLETE"));

  const notFound = await fetch(`${SENDER}/../../etc/passwd`);
  check("상위 경로 접근은 막힌다", notFound.status >= 400, String(notFound.status));
}

console.log(`\n${passed}개 통과, ${failures.length}개 실패`);
if (failures.length) {
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
process.exit(0);
