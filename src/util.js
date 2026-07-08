const crypto = require('crypto');

// Constant-time string comparison, mirroring PHP's hash_equals() usage for
// secrets that aren't hashed (the central hub password, stored in plaintext).
function safeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // timingSafeEqual requires equal-length buffers; hash one against itself
    // so the comparison still takes constant time relative to input length.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Normalizes a scanned/typed ticket code down to its bare number by dropping
// the "MQEBC" prefix and zero padding (e.g. "MQEBC00042" -> "42"). This is the
// canonical form the app stores and compares on, so a full printed code and its
// bare number resolve to the same ticket. Anything without the expected prefix
// is passed through untouched (already trimmed by the caller).
function normalizeCode(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^MQEBC/i.test(s)) return s;
  const rest = s.slice(5).replace(/^0+/, '');
  return rest || '0';
}

module.exports = { safeEquals, normalizeCode };
