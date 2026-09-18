// 세 서버가 공유하는 식별자와 포트. IM_PROJECT_PLAN.md 2절과 4절을 따른다.

// 레포 루트의 .env를 읽는다. 없으면 그냥 넘어간다. 항목 설명은 .env.example에 있다.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  /* .env가 없으면 기본값으로 동작한다 */
}

// 시간값은 환경변수로 덮을 수 있다. 유예 만료나 Root 만료를 확인하려면 이 값을 줄여야
// 하는데, 그때마다 이 파일을 고치면 되돌리는 것을 잊고 그대로 시연에 들어간다.
const seconds = (name, fallback) => Number(process.env[name]) || fallback;

export const config = {
  protocolVersion: "1",
  senderBankId: "bank-a",
  verifierId: "bank-a-recipient-verifier",
  recipientBankId: "bank-b",
  recipientIssuerId: "bank-b-eligibility-issuer",
  circuitId: "eligible-account-v1",

  // 개설 후 이 기간이 지나야 적격 목록에 들어간다. 대포통장 상당수가 신규 개설 계좌다.
  minAccountAgeDays: 30,

  // 검증 단계 목록을 응답에 실을지. 시연에서만 켠다. 운영에서는 감사 로그에만 남긴다.
  exposeVerificationSteps: true,

  // 데모 값. 계획서 2.4 ~ 2.6
  nonceTtlSeconds: seconds("NONCE_TTL_SECONDS", 120),
  clockSkewSeconds: seconds("CLOCK_SKEW_SECONDS", 120),
  graceSeconds: seconds("GRACE_SECONDS", 60),
  rootPeriodSeconds: seconds("ROOT_PERIOD_SECONDS", 300),

  ports: {
    senderBank: 8080, // 화면과 중계
    verifier: 8787,
    recipientBank: 8788,
  },

  anchor: {
    rpcUrl: "http://127.0.0.1:8545",
    // 배포 스크립트가 build/anchor.json에 주소를 적는다. 환경변수로도 덮어쓸 수 있다.
    address: "",
    // 로컬 anvil의 첫 계정. 로컬 체인 밖에서는 ANCHOR_ISSUER_KEY로 덮어쓴다.
    issuerKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  },
};

export const url = {
  verifier: `http://127.0.0.1:${config.ports.verifier}`,
  recipientBank: `http://127.0.0.1:${config.ports.recipientBank}`,
};
