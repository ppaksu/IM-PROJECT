# ZK 수취계좌 검증 데모

송금 전에 수취계좌가 현재 안전 기준을 통과했는지를, 개인정보를 넘기지 않고 확인하는 은행 간
검증 계층이다. 설계와 인터페이스 계약은 `IM_PROJECT_PLAN.md`에 있다.

## 실행

```bash
anvil                            # 별도 터미널
node script/deploy-anchor.js     # 컨트랙트 배포와 issuer 등록. 한 번
node script/anchor-root.js       # 현재 Root 기록. 유효기간 5분
node app/dev.js                  # 서버 셋
```

화면은 http://127.0.0.1:8080 이다. Root 유효기간이 지나면 `EXPIRED`가 되므로
`node script/anchor-root.js`를 다시 돌리거나 화면의 `Root 재생성`을 누른다.

| 서버 | 포트 | 하는 일 |
|---|---|---|
| 송금은행 중계 | 8080 | 화면 서빙, nonce·증명·검증 호출 순서 |
| Verifier API | 8787 | nonce 발급, 검증 10단계 |
| 수취은행 | 8788 | 계좌 record, hot revocation, 증명 발급 |

## 회로

```bash
node script/setup-circuit.js   # 컴파일과 키 생성. 한 번만
node script/test-circuit.js    # 정상 증명 하나와 불일치 13종
```

제약 4271개, 공개 신호 6개, 증명 생성 약 0.3초.

`build/`의 산출물은 다시 만들지 않는다. 각자 셋업을 돌리면 검증키가 달라져서 서로의 증명을
검증하지 못한다. `.ptau`와 `.r1cs`는 셋업에만 쓰이므로 커밋하지 않는다.

## Registry

`app/lib/registry.js`가 `data/accounts.json`에서 적격 트리를 만든다. 적격 판정과 트리 구성이
같은 파일에 있어서 "판정은 적격인데 트리에 자리가 없다" 같은 어긋남이 생기지 않는다.
수취은행 서버와 앵커링 스크립트가 같은 함수를 쓴다.

폐기는 두 단계로 반영된다. hot revocation 목록이 증명 발급을 즉시 막고, 트리에서 빠지는 것은
다음 회차 Root부터다.

```bash
node script/make-registry-fixture.js
```

`app/fixtures/registry.sample.json`은 테스트 벡터다. 다른 언어나 다른 구현으로 Registry를
다시 만들어도 여기 적힌 `eligibilityRoot`가 그대로 나와야 한다. 손으로 고치지 말고 스크립트로
다시 만든다.

값 변환은 `app/lib/field.js` 한 곳에서만 한다.

## 검사

```bash
node script/test-circuit.js   # 회로. 정상 증명과 불일치 14가지
node script/test-nonce.js     # nonce 보관소
forge test                    # Anchor Contract 14가지
node script/test-e2e.js       # 서버 세 대의 전체 흐름 87가지 (anvil 필요)
```

`test-e2e.js`는 서버를 직접 띄우고 배포와 앵커링까지 한다. 유예 만료나 Root 만료처럼
시간이 필요한 경우는 `GRACE_SECONDS`, `ROOT_PERIOD_SECONDS` 같은 환경변수로 줄여서 돌린다.
마지막 검사가 체인 장애를 보느라 anvil을 종료하므로, 이어서 시연하려면 anvil부터 다시 띄운다.

## 인터페이스 계약

`app/fixtures/`에 요청과 응답 샘플이 있다. 화면과 중계 서버는 이 파일을 기준으로 만든다.

## Anchor Contract

수취은행별로 `eligibilityRoot`와 정책 버전, 회로 ID, verifying key hash를 회차별로 저장한다.
계좌번호나 KYC 자료는 저장하지 않고, ZKP 검증도 하지 않는다. Root 만료 판단은 Verifier가 한다.

```solidity
setIssuer(bytes32 bankId, address newIssuer)     // owner만
anchorRoot(bytes32 bankId, ...)                   // 해당 은행 issuer만
latestAnchor(bytes32 bankId)                      // 최신 Anchor
anchorOf(bytes32 bankId, uint64 rootEpoch)        // 특정 회차 Anchor
```

`bankId`는 은행 식별자 문자열의 해시다. `rootEpoch`는 은행별로 1부터 정확히 1씩 증가한다.

```bash
forge test
```
