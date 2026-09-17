pragma circom 2.1.6;

include "poseidon.circom";
include "comparators.circom";

// 수취계좌 적격성 증명.
//
// 증명하는 문장은 다음 하나다.
//
//   accountHash가 가리키는 그 계좌의 적격성 record가 eligibilityRoot에 포함되어 있고,
//   상태가 ELIGIBLE이며, 재확인 기한이 지나지 않았고,
//   이번 검증 요청에 묶여 있다.
//
// 계좌 참조값을 회로 안에서 만드는 것이 핵심이다. 참조값을 공개 신호로 받기만 하면,
// 검증자는 요청자가 준 두 값을 견주는 꼴이라 어떤 계좌의 record로 만든 증명이든 다른
// 계좌의 답이라고 내밀 수 있다. 회로가 accountHash에서 참조값을 다시 만들면, 그 자리를
// 바꾸려면 Poseidon의 역상을 찾아야 한다.
//
// 고객확인 자료와 내부 위험 점수는 회로에 들어오지 않는다. 수취은행이 record를 만들 때
// 쓰고, 회로는 그 결과인 record만 다룬다.
//
// 설계는 IM_PROJECT_PLAN.md 2.2와 2.3에 있다.
template EligibilityInclusion(depth) {
    // 공개 신호 여섯 개. 순서가 고정이며 검증자가 같은 순서로 읽는다.
    // accountHash는 검증자가 자기가 물어본 계좌번호로 직접 계산해 대조한다.
    signal input accountHash;
    signal input eligibilityRoot;
    signal input policyHash;
    signal input issuerId;
    signal input verificationTime;
    signal input requestContext;

    // 비공개 입력.
    // validUntil을 비공개로 두는 이유는 계좌마다 다른 기한이 그 자체로 계좌를 구분하는
    // 지문이 되기 때문이다.
    signal input eligibilityStatus;
    signal input validUntil;
    // 은행과 프로토콜마다 하나인 참조값 유도 키. 비공개다. 이 값이 공개되면 아무나
    // 계좌번호로 참조값을 만들어 볼 수 있다.
    signal input refKey;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // 조건 1. 상태가 ELIGIBLE이다.
    eligibilityStatus === 1;

    // 조건 4a. 참조값을 이 계좌의 해시에서 만든다.
    // refKey를 바꿔 다른 계좌의 참조값에 맞추려면 Poseidon의 역상을 찾아야 한다.
    component ref = Poseidon(2);
    ref.inputs[0] <== refKey;
    ref.inputs[1] <== accountHash;

    // 조건 4b. leaf가 이 계좌·정책·발급기관으로 구성된다.
    // leaf 해시의 입력이 공개 신호와 묶여 있으므로, 다른 계좌나 다른 정책의 record로
    // 같은 증명을 만들 수 없다.
    component leaf = Poseidon(5);
    leaf.inputs[0] <== ref.out;
    leaf.inputs[1] <== eligibilityStatus;
    leaf.inputs[2] <== policyHash;
    leaf.inputs[3] <== validUntil;
    leaf.inputs[4] <== issuerId;

    // 조건 2. leaf가 eligibilityRoot에 포함된다.
    component hashes[depth];
    signal node[depth + 1];
    signal left[depth];
    signal right[depth];
    node[0] <== leaf.out;

    for (var i = 0; i < depth; i++) {
        // 방향 비트는 반드시 0 또는 1이다. 이 제약이 없으면 임의의 중간값을 넣어
        // 아무 Root나 맞출 수 있다.
        pathIndices[i] * (pathIndices[i] - 1) === 0;

        // pathIndices[i] = 0 이면 현재 노드가 왼쪽 자식이다.
        left[i] <== node[i] + pathIndices[i] * (pathElements[i] - node[i]);
        right[i] <== pathElements[i] + pathIndices[i] * (node[i] - pathElements[i]);

        hashes[i] = Poseidon(2);
        hashes[i].inputs[0] <== left[i];
        hashes[i].inputs[1] <== right[i];
        node[i + 1] <== hashes[i].out;
    }

    node[depth] === eligibilityRoot;

    // 조건 3. 재확인 기한이 지나지 않았다. 둘 다 유닉스 초이고 2^64 미만이다.
    component notExpired = LessThan(64);
    notExpired.in[0] <== verificationTime;
    notExpired.in[1] <== validUntil;
    notExpired.out === 1;

    // 조건 5. 이번 요청에 묶는다.
    // 값 자체는 검증자가 재계산해 대조한다. 이 제약은 신호가 최적화 과정에서 사라지지
    // 않게 붙잡아 두는 역할이다. 제약이 없으면 바인딩 자체가 없어진다.
    signal contextBound;
    contextBound <== requestContext * requestContext;
}

component main {public [
    accountHash,
    eligibilityRoot,
    policyHash,
    issuerId,
    verificationTime,
    requestContext
]} = EligibilityInclusion(16);
