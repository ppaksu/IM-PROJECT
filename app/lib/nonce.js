// 검증자가 발급하는 일회용 nonce.
//
// 발급을 기록하지 않는다. nonce 자체에 발급 시각과 서명을 넣어, 검증자가 자기가 발급한
// 것인지 다시 계산해서 알아낸다. 발급을 기록하면 인증 없는 발급 endpoint를 반복 호출하는
// 것만으로 보관소가 차고, 그 뒤로는 정상 요청이 nonce를 못 받는다. 실제로 9891번 호출에
// 모든 계좌가 차단됐다.
//
// 기록은 실제로 쓰인 nonce만 한다. 재사용을 막으려면 그것만 있으면 되고, 크기는 증명을
// 실제로 검증한 횟수만큼만 자란다.
//
// 형식은 31바이트다. 계획서 2.1의 절단 규칙에 맞춘다.
//   발급시각 5바이트 | 난수 10바이트 | 서명 16바이트
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TIME_BYTES = 5; // 초 단위로 서기 36812년까지 담는다
const RANDOM_BYTES = 10;
const TAG_BYTES = 16;
const HEAD_BYTES = TIME_BYTES + RANDOM_BYTES;

export function createNonceStore({
  ttlSeconds,
  maxUsed = 100_000,
  clock = () => Math.floor(Date.now() / 1000),
  secret = randomBytes(32),
}) {
  const used = new Map(); // nonce -> issuedAt

  const sign = (head) => createHmac("sha256", secret).update(head).digest().subarray(0, TAG_BYTES);

  /** 만료된 항목을 지운다. 만료된 nonce는 서명이 맞아도 거절되므로 지워도 안전하다. */
  function sweep() {
    const cutoff = clock() - ttlSeconds;
    for (const [nonce, issuedAt] of used) {
      if (issuedAt < cutoff) used.delete(nonce);
    }
  }

  function parse(requestNonce) {
    if (typeof requestNonce !== "string" || !/^0x00[0-9a-fA-F]{62}$/.test(requestNonce)) return null;
    const bytes = Buffer.from(requestNonce.slice(4), "hex");
    const head = bytes.subarray(0, HEAD_BYTES);
    const tag = bytes.subarray(HEAD_BYTES);
    // 길이가 고정이라 timingSafeEqual을 그대로 쓸 수 있다.
    if (!timingSafeEqual(tag, sign(head))) return null;
    return { issuedAt: head.readUIntBE(0, TIME_BYTES) };
  }

  return {
    /** 새 nonce를 만든다. 아무것도 기록하지 않으므로 실패하지 않는다. */
    issue() {
      const issuedAt = clock();
      const head = Buffer.alloc(HEAD_BYTES);
      head.writeUIntBE(issuedAt, 0, TIME_BYTES);
      randomBytes(RANDOM_BYTES).copy(head, TIME_BYTES);
      const requestNonce = "0x00" + Buffer.concat([head, sign(head)]).toString("hex");
      return { requestNonce, expiresAt: issuedAt + ttlSeconds };
    },

    /** 통과하면 null, 아니면 사유 문자열. 통과한 nonce는 즉시 사용 처리한다. */
    consume(requestNonce) {
      const parsed = parse(requestNonce);
      if (!parsed) return "발급한 적 없는 nonce";
      if (clock() - parsed.issuedAt > ttlSeconds) return "만료된 nonce";
      if (used.has(requestNonce)) return "이미 사용한 nonce";

      if (used.size >= maxUsed) {
        sweep();
        // 그래도 넘치면 재사용을 막을 수 없다. 통과시키지 않고 거절한다.
        if (used.size >= maxUsed) return "사용 기록 보관소가 가득 참";
      }
      used.set(requestNonce, parsed.issuedAt);
      return null;
    },

    sweep,
    size: () => used.size,
  };
}
