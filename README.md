# ZK 수취계좌 검증 데모

송금 전에 수취계좌가 현재 안전 기준을 통과했는지를, 개인정보를 넘기지 않고 확인하는 은행 간
검증 계층이다. 설계와 인터페이스 계약은 `IM_PROJECT_PLAN.md`에 있다.

| 서버 | 포트 | 하는 일 |
|---|---|---|
| 송금은행 중계 | 8080 | 화면 서빙, nonce·증명·검증 호출 순서 |
| Verifier API | 8787 | nonce 발급, 검증 10단계 |
| 수취은행 | 8788 | 계좌 record, hot revocation, 증명 발급 |

## 준비물

Node 22 이상, [Foundry](https://getfoundry.sh) (`anvil`, `forge`, `cast`).
회로를 다시 빌드할 때만 `circom`이 더 필요하다. 증명과 검증에 쓰는 산출물은 `build/`에
이미 들어 있으므로 평소에는 없어도 된다.

```bash
npm install
```

## 띄우기

순서가 있다. anvil이 먼저다. anvil을 재시작하면 컨트랙트가 사라지므로 배포와 앵커링을
다시 해야 한다.

```bash
anvil &
node script/deploy-anchor.js     # 컨트랙트 배포와 issuer 등록
node script/anchor-root.js       # 현재 Root 기록
npm run dev                      # 서버 셋
```

화면은 http://127.0.0.1:8080 이다.

`npm run dev`가 뜨면서 `rootEpoch`와 남은 유효기간을 알려 준다. 체인이 없거나 Root가
없으면 그 자리에서 무엇을 먼저 하라고 알려 준다.

화면이 `확인 불가`만 띄우는 것은 대부분 이 준비가 덜 된 경우다. 고장이 아니라, 판단 근거가
없을 때 허용도 차단도 하지 않는 것이다. 오른쪽에 `체인 연결 없음`이 함께 뜬다.

Root 유효기간이 지나면 멀쩡한 계좌도 `EXPIRED`가 된다. 화면의 `Root 재생성`을 누르거나
`node script/anchor-root.js`를 다시 돌린다. 시연이 길어질 것 같으면 `.env`의
`ROOT_PERIOD_SECONDS`를 늘려 둔다.

## 설정

```bash
cp .env.example .env
```

`.env`가 없어도 돌아간다. 전부 기본값으로 떨어진다. 만료나 유예를 눈으로 확인할 때,
그리고 Root 유효기간을 늘릴 때만 만들어 쓴다. `.env`는 커밋되지 않는다. 쉘에서 준 값이 이 파일보다 우선하므로
일회성으로는 명령 앞에 붙이면 된다.

```bash
GRACE_SECONDS=3 npm run dev
```

## 회로

```bash
node script/setup-circuit.js   # 컴파일과 키 생성
```

제약 4511개, 공개 신호 6개, 증명 생성 약 0.3초.

공개 신호는 `accountHash`, `eligibilityRoot`, `policyHash`, `issuerId`, `verificationTime`,
`requestContext` 순이다. 계좌 참조값은 회로 안에서 `accountHash`로부터 만들어지고 밖으로
나가지 않는다. 그래서 어떤 계좌의 record로 만든 증명을 다른 계좌의 답으로 내밀 수 없다.

**`build/`의 산출물은 다시 만들지 않는다.** 각자 셋업을 돌리면 검증키가 달라져서 서로의
증명을 검증하지 못한다. `.ptau`와 `.r1cs`는 셋업에만 쓰이므로 커밋하지 않는다.

## Registry

`app/lib/registry.js`가 `data/accounts.json`에서 적격 트리를 만든다. 적격 판정과 트리 구성이
같은 파일에 있어서 "판정은 적격인데 트리에 자리가 없다" 같은 어긋남이 생기지 않는다.
수취은행 서버와 앵커링 스크립트가 같은 함수를 쓴다.

폐기는 두 단계로 반영된다. hot revocation 목록이 증명 발급을 즉시 막고, 트리에서 빠지는 것은
다음 회차 Root부터다.

```bash
node script/make-registry-fixture.js
```

`app/fixtures/registry.sample.json`은 테스트 벡터다. 다른 구현으로 Registry를 다시 만들어도
여기 적힌 `eligibilityRoot`가 그대로 나와야 한다. 손으로 고치지 말고 스크립트로 다시 만든다.

값 변환은 `app/lib/field.js` 한 곳에서만 한다.

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

### 공개망 배포

Sepolia에 같은 컨트랙트가 올라가 있다.

| | |
|---|---|
| 네트워크 | Sepolia (chainId 11155111) |
| 컨트랙트 | `0x02A89277C02C4D1B7DE9Ad903f80ABCe0527206f` |
| 발급기관 | `0x98bC48DCB9CD9Cf9696b9bAc5253442B0F72965F` |
| bankId | `0x85b692ac840718c4c20a3acce04167775b2adbf21f59bcf5bd69abd16c1f9512` |

```bash
cast call 0x02A89277C02C4D1B7DE9Ad903f80ABCe0527206f \
  "latestAnchor(bytes32)((bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint64))" \
  0x85b692ac840718c4c20a3acce04167775b2adbf21f59bcf5bd69abd16c1f9512 \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

배포와 앵커링은 `.env.sepolia`로 따로 한다. 로컬 `.env`와 섞으면 로컬 시연이 공개망 주소를
조회하게 되어 전부 UNAVAILABLE이 된다.

```bash
node --env-file=.env.sepolia script/anchor-root.js
```

배포 결과는 `build/anchor.<호스트>.json`에 적힌다. 서버가 어느 배포를 볼지는 `ANCHOR_INFO`
하나로 정해지고, **주소와 RPC를 그 파일에서 함께 읽는다.** 둘은 짝이라 한쪽만 바꾸면 없는
주소를 다른 체인에 조회하게 된다. 이미 배포한 망에 다시 배포하려 하면 멈춘다.

시연은 로컬 anvil로 한다. 공개망은 Root 재생성이 블록을 기다려 십수 초 멈춘다.

## 검사

```bash
node script/test-circuit.js   # 회로 16가지
node script/test-nonce.js     # nonce
forge test                    # Anchor Contract 14가지
node script/test-e2e.js       # 서버 세 대의 전체 흐름 100가지
node script/audit.js          # 공격과 경계값 78가지
```

뒤의 둘은 anvil이 필요하고 서버를 직접 띄운다. **먼저 서버를 끄고 실행한다.** 포트가 이미
쓰이고 있으면 멈춘다. 안 그러면 옛 코드를 상대로 검사하게 된다.

```bash
pkill -f "app/dev.js"; pkill -f "app/.*/server.js"
```

`test-e2e.js`는 배포와 앵커링까지 직접 한다. 마지막 검사가 체인 장애를 보느라 anvil을
종료하므로, 이어서 시연하려면 anvil부터 다시 띄운다.

## 인터페이스 계약

`app/fixtures/`에 요청과 응답 샘플이 있다. 화면과 중계 서버는 이 파일을 기준으로 만든다.
`test-e2e.js`가 매 실행마다 이 샘플이 코드와 같은 모양인지 대조한다. 코드를 바꿔 모양이
달라졌으면 실제 실행값으로 다시 만든다.

```bash
UPDATE_FIXTURES=1 node script/test-e2e.js
```

## 제출용 압축

```bash
git archive --format=zip -o im-project.zip HEAD
```

추적 파일만 나가므로 `.env`와 `node_modules`가 빠지고, 증명에 필요한 `build/` 산출물은
들어간다. 폴더째 압축하면 개인키가 딸려간다.
