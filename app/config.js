// 세 서버가 공유하는 식별자와 포트. IM_PROJECT_PLAN.md 2절과 4절을 따른다.
export const config = {
  protocolVersion: "1",
  senderBankId: "bank-a",
  verifierId: "bank-a-recipient-verifier",
  recipientBankId: "bank-b",
  recipientIssuerId: "bank-b-eligibility-issuer",
  circuitId: "eligible-account-v1",

  // 데모 값. 계획서 2.4 ~ 2.6
  nonceTtlSeconds: 120,
  clockSkewSeconds: 120,
  graceSeconds: 60,
  rootPeriodSeconds: 300,

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
