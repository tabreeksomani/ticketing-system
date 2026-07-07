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

module.exports = { safeEquals };
