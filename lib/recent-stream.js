// True when an account has an actively-playing (non-disk, non-displaced)
// stream touched within windowMs. A live stream touches every few seconds;
// a stale previous stream (inside the longer idle grace) does not count.
function streamingRecently(streams, accountKey, windowMs = 60000, now = Date.now(), excludeOwner = null) {
  for (const [owner, v] of streams) {
    if (excludeOwner && owner === excludeOwner) continue; // the requester's own stream (a zap) never blocks it
    if (v.displaced || now - v.lastSeen >= windowMs) continue;
    if (accountKey && v.accountKey !== accountKey) continue;
    if (v.mode === "disk") continue;
    return true;
  }
  return false;
}
module.exports = { streamingRecently };
