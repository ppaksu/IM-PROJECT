// 검증자가 발급하는 일회용 nonce 보관소.
//
// 발급만 하고 지우지 않으면 목록이 계속 자란다. nonce 발급 endpoint에는 인증이 없어서
// 반복 호출하면 그만큼 쌓인다. 그래서 발급할 때마다 만료된 항목을 치우고, 상한을 둔다.
import { randomBytes } from "node:crypto";

export function createNonceStore({ ttlSeconds, maxEntries = 10_000, clock = () => Math.floor(Date.now() / 1000) }) {
  const entries = new Map(); // nonce -> { issuedAt, used }

  /** 만료된 항목을 지운다. 만료된 nonce는 어차피 거절되므로 지워도 안전하다. */
  function sweep() {
    const cutoff = clock() - ttlSeconds;
    for (const [nonce, entry] of entries) {
      if (entry.issuedAt < cutoff) entries.delete(nonce);
    }
  }

  return {
    /**
     * 새 nonce를 발급한다. 상한에 닿으면 발급하지 않는다.
     * 오래된 것을 밀어내면 아직 쓰지 않은 정상 요청의 nonce가 사라질 수 있다.
     */
    issue() {
      sweep();
      if (entries.size >= maxEntries) return null;
      // 상위 31바이트만 쓰는 계획서 2.1 규칙에 맞춘다.
      const requestNonce = "0x00" + randomBytes(31).toString("hex");
      const issuedAt = clock();
      entries.set(requestNonce, { issuedAt, used: false });
      return { requestNonce, expiresAt: issuedAt + ttlSeconds };
    },

    /** 통과하면 null, 아니면 사유 문자열. 통과한 nonce는 즉시 사용 처리한다. */
    consume(requestNonce) {
      const entry = entries.get(requestNonce);
      if (!entry) return "발급한 적 없는 nonce";
      if (entry.used) return "이미 사용한 nonce";
      if (clock() - entry.issuedAt > ttlSeconds) return "만료된 nonce";
      entry.used = true;
      return null;
    },

    size: () => entries.size,
  };
}
