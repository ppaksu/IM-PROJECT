# ZK 수취계좌 검증 데모

송금 전에 수취계좌가 현재 안전 기준을 통과했는지를, 개인정보를 넘기지 않고 확인하는 은행 간
검증 계층이다. 설계와 인터페이스 계약은 `IM_PROJECT_PLAN.md`에 있다.

## 실행

로컬 체인부터 띄운다. Verifier가 Anchor Contract를 읽어야 하고, 못 읽으면 설계대로
`UNAVAILABLE`로 답한다.

```bash
anvil                            # 별도 터미널
node script/deploy-anchor.js     # 배포와 issuer 등록. 한 번
node script/anchor-root.js       # 현재 Root 기록. 유효기간 5분
node app/dev.js                  # 서버 셋
```

화면은 http://127.0.0.1:8080 이다. Root 유효기간이 지나면 `EXPIRED`가 되므로
`node script/anchor-root.js`를 다시 돌린다.

| 서버 | 포트 | 하는 일 |
|---|---|---|
| 송금은행 중계 | 8080 | 화면 서빙, nonce·증명·검증 호출 순서 |
| Verifier API | 8787 | nonce 발급, 검증 판정 |
| 수취은행 | 8788 | 계좌 record, hot revocation, 증명 발급 |

증명 생성과 검증은 실물이다. 남은 자리는 `// TODO(백엔드)` 주석이 표시한다. Registry가
붙으면 트리의 출처가 기준값 파일에서 실제 Registry로 바뀐다.

인터페이스 계약 샘플은 `app/fixtures/`에 있다. 화면과 중계 서버는 이 파일을 기준으로 만든다.

## 회로

```bash
node script/setup-circuit.js   # 컴파일과 키 생성. 한 번만
node script/test-circuit.js    # 정상 증명 하나와 불일치 13종
```

제약 4271개, 공개 신호 6개, 증명 생성 약 0.3초다.

**`build/`의 산출물은 다시 만들지 마라.** 각자 셋업을 돌리면 검증키가 달라져서, 한 사람이
만든 증명을 다른 사람이 검증할 때 실패한다. 원인이 잘 안 보이는 종류의 실패다. 한 사람이
한 번 만들어 커밋한 것을 그대로 쓴다.

`.ptau`와 `.r1cs`는 셋업에만 쓰이므로 커밋하지 않는다. 증명과 검증에 필요한 것은 `zkey`,
`vkey`, `wasm`, `circuit-meta.json`이다.

현재 ceremony는 이 기계 혼자 돌린 개발용이다. 제출 전에 기존 Powers of Tau 결과를 받아
phase 2만 기여하는 쪽으로 바꾼다.

## Registry 기준값

`app/fixtures/registry.sample.json`은 샘플이 아니라 **테스트 벡터**다. 같은 계좌 데이터로
Registry를 구현했을 때 여기 적힌 `eligibilityRoot`가 그대로 나와야 한다. 다르면 값 표현이나
Poseidon 사용법이 어긋난 것이다. 이 어긋남은 증명이 조용히 실패하는 형태로 나타나서 원인을
찾기 어렵다.

```bash
node script/make-registry-fixture.js
```

파일을 손으로 고치지 말고 이 스크립트로 다시 만든다. 스크립트는 각 record의 Merkle path가
Root를 재현하는지 스스로 확인하고, 실패하면 멈춘다.

값 변환은 `app/lib/field.js` 한 곳에서만 한다. 이 파일은 보안 담당과 백엔드 담당만 고친다.

---

# Eligibility Anchor

ZK 기반 수취계좌 검증 서비스의 Anchor Contract다. 계획서 2.9절에 해당한다.

## 컨트랙트가 하는 일

- 수취은행별로 적격 계좌 목록의 `eligibilityRoot` 저장
- 정책 버전, 회로 ID, verifying key hash 저장
- `rootEpoch`가 은행별로 1부터 시작해 정확히 1씩 증가하도록 강제
- 모든 epoch의 기록 보관
- 은행별 최신 Anchor 조회와 특정 epoch Anchor 조회

## 컨트랙트가 하지 않는 일

- 계좌번호 저장
- KYC 자료 저장
- ZKP 직접 검증
- 계좌 적격성 자체의 판단
- **Root 만료 판단**

ZKP 검증은 송금은행의 Verifier API가 수행한다. 이 컨트랙트는 검증 기준이 되는 Root를
공개적으로 고정하는 역할만 한다.

## 왜 epoch 이력을 남기는가

수취은행이 Root `n`으로 증명을 만들고 송금은행이 검증하는 사이에 Root가 `n+1`로 교체될 수
있다. 최신 Root만 허용하면 이 순간의 정상 계좌가 차단된다.

그래서 Verifier는 직전 epoch까지 짧은 유예를 두고 허용한다. 그 판단에 직전 epoch의 기록이
필요하다. epoch을 건너뛸 수 없게 만든 이유도 같다. 이력이 끊기면 유예 판단이 실패한다.

**유예 정책 자체는 컨트랙트에 넣지 않는다.** 만료된 Anchor도 그대로 반환하고, 허용 범위는
Verifier가 정한다. 정책을 바꿀 때 컨트랙트를 다시 배포하지 않기 위해서다.

## 주요 함수

```solidity
setIssuer(bytes32 bankId, address newIssuer)          // owner만
anchorRoot(bytes32 bankId, ...)                        // 해당 은행 issuer만
latestAnchor(bytes32 bankId)                           // 최신 Anchor
anchorOf(bytes32 bankId, uint64 rootEpoch)             // 특정 epoch Anchor
```

`bankId`는 은행 식별자 문자열의 해시다.

## 테스트

```bash
forge test -vv
```

## 배포 방향

- 로컬 시연: Anvil
- 공개 시연: Ethereum Sepolia
- 운영 확장: Ethereum L2 또는 기관용 네트워크 검토

데모에서는 은행별 issuer를 각각 하나의 주소로 두고, 운영 버전에서는 다중서명과 HSM, 키 회전으로
강화한다.
