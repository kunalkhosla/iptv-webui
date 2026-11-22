// Single source of truth for the xtream response-cache key. Every reader and
// writer of the `cache` / `inflight` maps must go through this.
function xtreamKey(accountKey, action, params) {
  return `${accountKey}\0${action}${JSON.stringify(params)}`;
}
module.exports = { xtreamKey };
