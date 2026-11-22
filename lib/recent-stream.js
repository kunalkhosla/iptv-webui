// True when an account has an actively-playing (non-disk, non-displaced)
// stream touched within windowMs. A live stream touches every few seconds;
// a stale previous stream (inside the longer idle grace) does not count.
function streamingRecently(streams, accountKey, windowMs = 60000, now = Date.now()) {
  for (const v of streams.values()) {
    if (v.displaced || now - v.lastSeen >= windowMs) continue;
    if (accountKey && v.accountKey !== accountKey) continue;
    if (v.mode === "disk") continue;
    return true;
  }
  return false;
}
module.exports = { streamingRecently };
