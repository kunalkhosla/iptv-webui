const { Transform } = require("node:stream");

// Drops the first `n` bytes that flow through, passes the rest unchanged.
// Used when a Range resume is answered with a plain 200: keep the partial
// file and discard the already-have prefix of the full-body response.
function skipBytes(n) {
  let left = Math.max(0, Number(n) || 0);
  return new Transform({
    transform(chunk, _enc, cb) {
      if (left === 0) return cb(null, chunk);
      if (chunk.length <= left) { left -= chunk.length; return cb(); }
      const rest = chunk.subarray(left);
      left = 0;
      cb(null, rest);
    },
  });
}

module.exports = { skipBytes };
