// Pure selection for the home "Continue Watching" and "Recently Watched"
// rails. "Continue" means unfinished: a saved position (progress p > 5; the
// server deletes progress at >= 95%), or - series only - an "up next"
// lastEpisode pointer (auto:true, written by advanceToNextEpisode).
// Everything else the profile has played (recents / lastPlayed / watched)
// goes to the history rail, newest first.

const MIN_POSITION_S = 30; // matches /api/progress (below this it deletes progress)
const AUTO_POINTER_TTL_MS = 45 * 24 * 3600 * 1000;

// Direct-play clients may post d=0, so the server never deletes progress at the
// end; treat p >= 95% of a known duration as finished here too.
const isFinishedPos = (p) => !!p && p.d > 0 && p.p >= 0.95 * p.d;
const hasPosition = (p) => !!p && Number.isFinite(p.p) && p.p >= MIN_POSITION_S && !isFinishedPos(p);

// A finished episode with no successor must not leave an up-next pointer behind.
function clearAutoPointer(le) {
  if (le && le.auto) le.auto = false;
  return le;
}

const autoPointerLive = (le, now = Date.now()) =>
  le?.auto === true && !(le.when && now - le.when > AUTO_POINTER_TTL_MS);

// progressById: Map<id, {p,d,t}>; recentIds: id[] (newest first);
// lpForMode: {id: ts}; watchedIds: id[]; lastEpisode: {seriesId: {auto,when,...}}
// Returns { continueIds, historyIds } (ids ordered newest first).
function selectContinueAndHistory({ mode, progressById, recentIds = [], lpForMode = {},
  watchedIds = [], lastEpisode = {} }) {
  const ts = (id) => {
    const p = progressById.get(id);
    if (p?.t) return p.t;
    const lp = lpForMode[String(id)];
    if (lp) return lp;
    const le = mode === "series" ? lastEpisode[String(id)] : null;
    return le?.when || 0;
  };
  const isContinue = (id) => {
    const now = Date.now();
    if (hasPosition(progressById.get(id))) return true;
    return mode === "series" && autoPointerLive(lastEpisode[String(id)], now);
  };
  const all = new Set([...progressById.keys(), ...recentIds,
    ...Object.keys(lpForMode).map(Number).filter(Number.isFinite), ...watchedIds]);
  // Stable newest-first: recents order breaks ties (earlier index = newer).
  const rank = new Map(recentIds.map((id, i) => [id, i]));
  const sorted = [...all].sort((a, b) => (ts(b) - ts(a)) || ((rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9)));
  const continueIds = [], historyIds = [];
  for (const id of sorted) (isContinue(id) ? continueIds : historyIds).push(id);
  return { continueIds, historyIds };
}

module.exports = { selectContinueAndHistory, hasPosition, clearAutoPointer, autoPointerLive, MIN_POSITION_S };
