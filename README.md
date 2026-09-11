# Eligibility Anchor

ZK 기반 수취계좌 검증 서비스의 Anchor Contract다.

전체 설계와 구현 계획은 `IM_PROJECT_PLAN.md`에 있다. 이 컨트랙트는 계획서 2.9절에 해당한다.

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
