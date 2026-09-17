// 전체 시나리오 검사. 세 서버를 직접 띄우고 흐름 전체를 돌린다.
//
// 회로 검사(test-circuit.js)는 증명 자체를, 컨트랙트 검사(forge test)는 저장을 본다.
// 이 파일은 그 사이, 즉 서버 세 대가 주고받는 판단을 본다. 정상 흐름보다 실패 흐름이
// 중요하다. 차단해야 할 것을 허용하는 것도 버그지만, 장애를 차단으로 둔갑시키는 것도
// 같은 무게의 버그다. 계획서 4.3
//
// 전제: anvil이 떠 있다. 컨트랙트 배포와 첫 앵커링은 이 파일이 한다.
// 실행: node script/test-e2e.js
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, url } from "../app/config.js";
import { buildRegistry } from "../app/lib/registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNTS = JSON.parse(readFileSync(join(ROOT, "data", "accounts.json"), "utf8"));
const num = (id) => ACCOUNTS.find((a) => a.id === id).accountNumber;

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
  return { status: response.status, body: await response.json() };
}

// ── 서버 관리 ────────────────────────────────────────────────────────────────
const children = new Map();

function start(name, env = {}) {
  const child = spawn(process.execPath, [join(ROOT, "app", name, "server.js")], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    // 예상된 실패 로그는 검사 출력에 섞지 않는다.
    if (/증명 발급 실패|장애:|nonce 보관소|적격인데|하위 호출 실패|error sending request|Context:|Error #/.test(text)) return;
    console.error(`[${name}] ${text}`);
  });
  children.set(name, child);
}

function stop(name) {
  children.get(name)?.kill("SIGKILL");
  children.delete(name);
}

async function waitFor(target, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(target);
      return true;
    } catch {
      await sleep(150);
    }
  }
  throw new Error(`${target} 가 뜨지 않는다`);
}

async function startAll(env = {}) {
  start("recipient-bank", env);
  start("verifier", env);
  start("sender-bank", env);
  await waitFor(`${url.recipientBank}/admin/accounts`);
  await waitFor(`${url.verifier}/nope`);
  await waitFor(`http://127.0.0.1:${config.ports.senderBank}/api/v1/audit-log`);
}

function stopAll() {
  for (const name of [...children.keys()]) stop(name);
}

// ── 호출 도우미 ──────────────────────────────────────────────────────────────
const SENDER = `http://127.0.0.1:${config.ports.senderBank}`;

const transfer = (accountNumber) => post(`${SENDER}/api/v1/transfer/check`, { accountNumber });
const admin = (path, body = {}) => post(`${SENDER}/admin/${path}`, body);
const verifyDirect = (payload) => post(`${url.verifier}/api/v1/recipient/eligibility/verify`, payload);

async function nonce() {
  return (await post(`${url.verifier}/api/v1/recipient/eligibility/nonce`, {})).body.requestNonce;
}

/** 수취은행에서 진짜 증명을 받아 검증자에게 그대로 넘길 수 있는 요청을 만든다. */
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
    recipientAccountRef: issued.body.recipientAccountRef,
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

/** 정상 요청 하나를 만들어 한 군데만 망가뜨린 뒤 검증자에게 보낸다. */
async function mutated(accountId, mutate) {
  const request = await freshRequest(accountId);
  mutate(request);
  return verifyDirect(request);
}

const says = (response, status, decision) =>
  response.body.status === status && response.body.decision === decision;

const shows = (response) => `${response.status} ${response.body.status} ${response.body.decision}`;

/** 검증이 어느 단계에서 멈췄는지. exposeVerificationSteps가 켜져 있어야 보인다. */
const stoppedAt = (response) => response.body.steps?.find((entry) => !entry.ok)?.name ?? "없음";

// ── 1. 체인 준비 ─────────────────────────────────────────────────────────────
console.log("\n[준비] 컨트랙트 배포와 첫 앵커링");
const run = (file) => execFileSync(process.execPath, [join(ROOT, "script", file)], { cwd: ROOT, encoding: "utf8" });
try {
  run("deploy-anchor.js");
  run("anchor-root.js");
} catch (error) {
  console.error("anvil이 떠 있는지 확인해라.", error.message);
  process.exit(1);
}

// ── 2. Registry 단독 검사 ────────────────────────────────────────────────────
console.log("\n[Registry]");
{
  const fixture = JSON.parse(readFileSync(join(ROOT, "app", "fixtures", "registry.sample.json"), "utf8"));
  const built = await buildRegistry({ accounts: ACCOUNTS });
  const again = await buildRegistry({ accounts: ACCOUNTS });

  check("기준값과 같은 Root", built.eligibilityRoot === fixture.eligibilityRoot, built.eligibilityRoot);
  check("두 번 만들어도 같은 Root", built.eligibilityRoot === again.eligibilityRoot);
  check("적격만 트리에", built.inTreeCount === 3 && built.records.length === 6);

  const reasons = Object.fromEntries(
    built.records.filter((r) => !r.inTree).map((r) => [r.id, r.excludedBecause]),
  );
  check(
    "제외 사유가 계좌별로 맞다",
    reasons.D === "SUSPENDED" && reasons.E === "KYC_INCOMPLETE" && reasons.F === "NEW_ACCOUNT",
    JSON.stringify(reasons),
  );

  const revoked = new Map([[num("C"), "REVOKED"]]);
  const afterRevoke = await buildRegistry({ accounts: ACCOUNTS, revoked });
  check("폐기하면 Root가 바뀐다", afterRevoke.eligibilityRoot !== built.eligibilityRoot);
  check("폐기해도 인덱스는 그대로", afterRevoke.records.every((r, i) => r.index === i && r.index === built.records[i].index));
  check(
    "폐기된 자리는 leaf 0으로 남는다",
    afterRevoke.records[2].inTree === false && BigInt(afterRevoke.records[2].leaf) === 0n,
  );
  check(
    "같은 계좌의 참조값은 변하지 않는다",
    afterRevoke.records.every((r, i) => r.recipientAccountRef === built.records[i].recipientAccountRef),
  );

  const otherSecret = await buildRegistry({ accounts: ACCOUNTS, params: { bankSecret: "another" } });
  check("은행 비밀키가 다르면 참조값도 다르다", otherSecret.records[0].recipientAccountRef !== built.records[0].recipientAccountRef);
}

// ── 3. 기본 흐름 ─────────────────────────────────────────────────────────────
await startAll();
console.log("\n[정상 흐름]");
{
  for (const id of ["A", "B", "C"]) {
    const response = await transfer(num(id));
    check(`${id} 적격 계좌 허용`, says(response, "ELIGIBLE", "ALLOW") && response.status === 200, shows(response));
  }
  const first = await transfer(num("A"));
  check("허용 응답에 회차가 실린다", Number(first.body.rootEpoch) >= 1, String(first.body.rootEpoch));
  check("계좌 참조값을 돌려준다", /^0x[0-9a-f]{64}$/.test(first.body.recipientAccountRef ?? ""));
}

console.log("\n[적격 아님]");
{
  const cases = [["D", "정지"], ["E", "고객확인 미완료"], ["F", "개설 직후"]];
  for (const [id, label] of cases) {
    const response = await transfer(num(id));
    check(`${id} ${label} 차단`, says(response, "NOT_ELIGIBLE", "BLOCK") && response.status === 200, shows(response));
  }
  const unknown = await transfer("110-000-000000");
  check("없는 계좌 차단", says(unknown, "NOT_ELIGIBLE", "BLOCK"), shows(unknown));

  const empty = await post(`${SENDER}/api/v1/transfer/check`, {});
  check("계좌번호 없는 요청은 400", empty.status === 400, String(empty.status));
}

console.log("\n[사유 노출 금지]");
{
  const d = await transfer(num("D"));
  const e = await transfer(num("E"));
  const serialized = JSON.stringify([d.body, e.body]);
  check("응답이 NOT_ELIGIBLE 하나로 합쳐진다", d.body.status === e.body.status);
  check(
    "정지·고객확인 같은 내부 사유가 밖으로 안 나간다",
    !/SUSPENDED|KYC|NEW_ACCOUNT|REVOKED/.test(serialized),
  );
}

// ── 4. 요청 형식 ─────────────────────────────────────────────────────────────
console.log("\n[요청 형식 — 잘못된 요청은 장애가 아니라 차단]");
{
  const bad = [
    ["본문이 없음", {}],
    ["본문이 null", null],
    ["증명이 배열", { recipientAccountRef: "0x" + "11".repeat(32), proof: [], publicSignals: [], envelope: {} }],
  ];
  for (const [label, payload] of bad) {
    const response = await verifyDirect(payload);
    check(label, says(response, "UNKNOWN", "BLOCK") && response.status === 200, shows(response));
  }

  const mutations = [
    ["증명이 빈 객체", (r) => { r.proof = {}; }],
    ["pi_b 모양 깨짐", (r) => { r.proof.pi_b = [1, 2]; }],
    ["pi_a 원소가 숫자 아님", (r) => { r.proof.pi_a = ["x", "y", "z"]; }],
    ["공개 신호 개수 부족", (r) => { r.publicSignals.pop(); }],
    ["공개 신호가 hex 아님", (r) => { r.publicSignals[0] = "abc"; }],
    ["계좌 참조값 형식 오류", (r) => { r.recipientAccountRef = "nope"; }],
    ["nonce 형식 오류", (r) => { r.envelope.requestNonce = "1234"; }],
    ["회차가 0", (r) => { r.envelope.rootEpoch = 0; }],
    ["회차가 숫자 아님", (r) => { r.envelope.rootEpoch = "회차"; }],
    ["봉투 없음", (r) => { delete r.envelope; }],
    ["검증키 해시 형식 오류", (r) => { r.envelope.verifyingKeyHash = "0xzz"; }],
  ];
  for (const [label, mutate] of mutations) {
    const response = await mutated("A", mutate);
    check(label, says(response, "UNKNOWN", "BLOCK") && response.status === 200, shows(response));
  }
}

// ── 5. 요청 바인딩 ───────────────────────────────────────────────────────────
console.log("\n[요청 바인딩]");
{
  const request = await freshRequest("A");
  const first = await verifyDirect(clone(request));
  check("정상 검증 통과", says(first, "ELIGIBLE", "ALLOW"), shows(first));

  const replay = await verifyDirect(clone(request));
  check("같은 증명 재사용 차단", says(replay, "UNKNOWN", "BLOCK"), shows(replay));
  check("재사용은 nonce 단계에서 멈춘다", stoppedAt(replay).includes("nonce"), stoppedAt(replay));

  const unissued = await mutated("A", (r) => { r.envelope.requestNonce = "0x00" + "ab".repeat(31); });
  check("발급한 적 없는 nonce 차단", says(unissued, "UNKNOWN", "BLOCK"), shows(unissued));

  // 다른 요청의 nonce로 바꿔치기. 증명이 그 nonce에 묶여 있지 않다.
  const stolen = await nonce();
  const swapped = await mutated("A", (r) => { r.envelope.requestNonce = stolen; });
  check("다른 요청의 nonce로 바꿔치기 차단", says(swapped, "UNKNOWN", "BLOCK"), shows(swapped));
  check("바인딩 단계에서 멈춘다", stoppedAt(swapped).includes("바인딩"), stoppedAt(swapped));

  for (const [label, key, value] of [
    ["다른 송금은행 이름", "senderBankId", "bank-x"],
    ["다른 검증자 이름", "verifierId", "someone-else"],
    ["다른 수취은행 이름", "recipientBankId", "bank-z"],
  ]) {
    const response = await mutated("A", (r) => { r.envelope[key] = value; });
    check(label + " 차단", says(response, "UNKNOWN", "BLOCK"), shows(response));
  }

  const otherRef = await mutated("A", (r) => { r.recipientAccountRef = "0x" + "22".repeat(32); });
  check("물어본 계좌와 다른 증명 차단", says(otherRef, "UNKNOWN", "BLOCK"), shows(otherRef));
  check("계좌 참조값 단계에서 멈춘다", stoppedAt(otherRef).includes("계좌 참조값"), stoppedAt(otherRef));
}

console.log("\n[회로와 검증키]");
{
  const wrongCircuit = await mutated("A", (r) => { r.envelope.circuitId = "other-circuit"; });
  check("다른 회로 이름 차단", says(wrongCircuit, "UNKNOWN", "BLOCK"), shows(wrongCircuit));

  const wrongKey = await mutated("A", (r) => { r.envelope.verifyingKeyHash = "0x" + "33".repeat(32); });
  check("다른 검증키 해시 차단", says(wrongKey, "UNKNOWN", "BLOCK"), shows(wrongKey));
}

console.log("\n[증명 자체]");
{
  const tampered = await mutated("A", (r) => {
    r.proof.pi_a[0] = String(BigInt(r.proof.pi_a[0]) + 1n);
  });
  check("증명 값 훼손 차단", says(tampered, "NOT_ELIGIBLE", "BLOCK"), shows(tampered));
  check("증명 검증 단계까지 간다", stoppedAt(tampered).includes("영지식증명"), stoppedAt(tampered));

  // 공개 신호만 바꾸면 증명과 어긋나므로 검증에서 걸린다.
  const swappedSignal = await mutated("A", (r) => {
    const root = BigInt(r.publicSignals[1]) + 1n;
    r.publicSignals[1] = "0x" + root.toString(16).padStart(64, "0");
  });
  check("공개 Root만 바꾸면 차단", says(swappedSignal, "NOT_ELIGIBLE", "BLOCK"), shows(swappedSignal));
}

console.log("\n[Root 회차]");
{
  const future = await mutated("A", (r) => { r.envelope.rootEpoch = 99; });
  check("없는 회차 차단", says(future, "NOT_ELIGIBLE", "BLOCK"), shows(future));
  check("회차 단계에서 멈춘다", stoppedAt(future).includes("회차"), stoppedAt(future));
}

// ── 6. 폐기와 회차 교체 ──────────────────────────────────────────────────────
console.log("\n[폐기와 회차 교체]");
{
  const before = await admin("rebuild-root");
  const rootBefore = before.body.eligibilityRoot;

  await admin("revoke", { accountNumber: num("C"), status: "REVOKED" });
  const hotBlocked = await transfer(num("C"));
  check("폐기 즉시 차단", says(hotBlocked, "NOT_ELIGIBLE", "BLOCK"), shows(hotBlocked));

  const stillFine = await transfer(num("A"));
  check("다른 계좌는 영향 없음", says(stillFine, "ELIGIBLE", "ALLOW"), shows(stillFine));

  const rebuilt = await admin("rebuild-root");
  check("회차가 1 올라간다", rebuilt.body.rootEpoch === before.body.rootEpoch + 1, JSON.stringify(rebuilt.body));
  check("폐기가 Root에 반영된다", rebuilt.body.eligibilityRoot !== rootBefore, rebuilt.body.eligibilityRoot);
  check("트리에서 한 자리 빠진다", rebuilt.body.inTree === before.body.inTree - 1, String(rebuilt.body.inTree));

  const afterRotate = await transfer(num("A"));
  check("회차 교체 뒤에도 정상 계좌는 허용", says(afterRotate, "ELIGIBLE", "ALLOW"), shows(afterRotate));
  check("새 회차로 판정된다", afterRotate.body.rootEpoch === rebuilt.body.rootEpoch, String(afterRotate.body.rootEpoch));

  await admin("restore", { accountNumber: num("C") });
  const restoredButOutside = await transfer(num("C"));
  check("복구 직후에는 아직 차단", says(restoredButOutside, "NOT_ELIGIBLE", "BLOCK"), shows(restoredButOutside));

  const back = await admin("rebuild-root");
  check("다시 만들면 원래 Root로 돌아온다", back.body.eligibilityRoot === rootBefore, back.body.eligibilityRoot);
  const restored = await transfer(num("C"));
  check("다음 회차부터 다시 허용", says(restored, "ELIGIBLE", "ALLOW"), shows(restored));
}

console.log("\n[트리와 체인의 어긋남]");
{
  // 서버가 모르는 사이에 밖에서 다른 Root를 앵커링한 상황이다.
  await admin("revoke", { accountNumber: num("C"), status: "REVOKED" });
  await admin("rebuild-root");
  run("anchor-root.js"); // 폐기 반영 전 Root를 새 회차로 올린다

  const response = await transfer(num("A"));
  check("체인 Root와 내 트리가 다르면 장애로 답한다", says(response, "UNAVAILABLE", "NO_SAFETY_ASSERTION"), shows(response));
  check("멀쩡한 계좌를 차단으로 만들지 않는다", response.body.status !== "NOT_ELIGIBLE", shows(response));

  await admin("restore", { accountNumber: num("C") });
  await admin("rebuild-root");
  const recovered = await transfer(num("A"));
  check("다시 앵커링하면 복구된다", says(recovered, "ELIGIBLE", "ALLOW"), shows(recovered));
}

console.log("\n[읽을 수 없는 본문]");
{
  const response = await fetch(`${url.verifier}/api/v1/recipient/eligibility/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ 이건 JSON이 아니다",
  });
  check("JSON이 아닌 본문은 400", response.status === 400, String(response.status));
}

console.log("\n[감사 로그]");
{
  const log = await (await fetch(`${SENDER}/api/v1/audit-log`)).json();
  check("판정이 기록된다", log.entries.length > 0, String(log.entries.length));
  check(
    "허용과 차단이 모두 남는다",
    log.entries.some((e) => e.decision === "ALLOW") && log.entries.some((e) => e.decision === "BLOCK"),
  );
  check("50건을 넘기지 않는다", log.entries.length <= 50, String(log.entries.length));
}

// ── 7. 유예 구간 ─────────────────────────────────────────────────────────────
stopAll();
console.log("\n[직전 회차 유예 — GRACE_SECONDS=3]");
await startAll({ GRACE_SECONDS: "3" });
{
  const request = await freshRequest("A");
  await admin("rebuild-root"); // 증명을 만든 사이에 회차가 교체된 상황
  const inGrace = await verifyDirect(clone(request));
  check("교체 직후 직전 회차 증명 허용", says(inGrace, "ELIGIBLE", "ALLOW"), shows(inGrace));

  const late = await freshRequest("A");
  await admin("rebuild-root");
  await sleep(4000);
  const expiredGrace = await verifyDirect(clone(late));
  check("유예가 지나면 차단", says(expiredGrace, "NOT_ELIGIBLE", "BLOCK"), shows(expiredGrace));
  check("회차 단계에서 멈춘다", stoppedAt(expiredGrace).includes("회차"), stoppedAt(expiredGrace));

  const twoBehind = await freshRequest("A");
  await admin("rebuild-root");
  await admin("rebuild-root");
  const tooOld = await verifyDirect(clone(twoBehind));
  check("두 회차 이상 지난 증명 차단", says(tooOld, "NOT_ELIGIBLE", "BLOCK"), shows(tooOld));
}

// ── 8. 검증 시각 오차 ────────────────────────────────────────────────────────
stopAll();
console.log("\n[검증 시각 오차 — CLOCK_SKEW_SECONDS=1]");
await startAll({ CLOCK_SKEW_SECONDS: "1" });
{
  const request = await freshRequest("A");
  await sleep(3000);
  const stale = await verifyDirect(request);
  check("오래된 증명 차단", says(stale, "UNKNOWN", "BLOCK"), shows(stale));
  check("시각 단계에서 멈춘다", stoppedAt(stale).includes("시각"), stoppedAt(stale));
}

// ── 9. Root 유효기간 ─────────────────────────────────────────────────────────
stopAll();
console.log("\n[Root 유효기간 — ROOT_PERIOD_SECONDS=3]");
await startAll({ ROOT_PERIOD_SECONDS: "3" });
{
  await admin("rebuild-root");
  const fresh = await transfer(num("A"));
  check("유효기간 안에는 허용", says(fresh, "ELIGIBLE", "ALLOW"), shows(fresh));

  await sleep(4000);
  const expired = await transfer(num("A"));
  check("유효기간이 지나면 EXPIRED", says(expired, "EXPIRED", "BLOCK"), shows(expired));
  check("EXPIRED도 차단이다", expired.body.decision === "BLOCK");
}

// ── 10. 장애 ────────────────────────────────────────────────────────────────
stopAll();
console.log("\n[장애 — 차단으로 둔갑하면 안 된다]");
await startAll();
{
  // 앞 단계가 3초짜리 Root를 남겼다. 기간이 지난 Root 위에서 장애를 보면 원인이 섞인다.
  await admin("rebuild-root");

  stop("recipient-bank");
  const noBank = await transfer(num("A"));
  check("수취은행이 죽으면 UNAVAILABLE", says(noBank, "UNAVAILABLE", "NO_SAFETY_ASSERTION"), shows(noBank));
  check("장애는 503으로 답한다", noBank.status === 503, String(noBank.status));
  start("recipient-bank");
  await waitFor(`${url.recipientBank}/admin/accounts`);

  stop("verifier");
  const noVerifier = await transfer(num("A"));
  check("검증자가 죽으면 UNAVAILABLE", says(noVerifier, "UNAVAILABLE", "NO_SAFETY_ASSERTION"), shows(noVerifier));
  start("verifier");
  await waitFor(`${url.verifier}/nope`);

  const ok = await transfer(num("A"));
  check("살아나면 다시 허용", says(ok, "ELIGIBLE", "ALLOW"), shows(ok));
}

console.log("\n[체인 장애]");
{
  // 마지막 검사다. anvil을 죽이면 앞의 상태도 같이 사라진다.
  try {
    execFileSync("pkill", ["-f", "anvil"], { stdio: "ignore" });
  } catch {
    /* 이미 죽어 있으면 그대로 진행한다 */
  }
  await sleep(1500);
  const noChain = await transfer(num("A"));
  check("체인을 못 읽으면 UNAVAILABLE", says(noChain, "UNAVAILABLE", "NO_SAFETY_ASSERTION"), shows(noChain));
  check("허용도 차단도 하지 않는다", noChain.body.decision === "NO_SAFETY_ASSERTION", shows(noChain));

  const list = await (await fetch(`${SENDER}/admin/accounts`)).json();
  check("체인이 죽어도 계좌 목록은 보인다", Array.isArray(list.accounts) && list.accounts.length === 6, JSON.stringify(list).slice(0, 80));
  check("회차만 비운다", list.rootEpoch === null, String(list.rootEpoch));
}

stopAll();

console.log("\nanvil은 마지막 검사에서 종료했다. 다시 시연하려면 anvil과 배포부터 다시 한다.");
console.log(`\n${passed}개 통과, ${failures.length}개 실패`);
if (failures.length) {
  for (const line of failures) console.log(`  - ${line}`);
  process.exit(1);
}
process.exit(0);
