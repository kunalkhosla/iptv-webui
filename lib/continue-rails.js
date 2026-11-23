// Pure selection for the home "Continue Watching" and "Recently Watched"
// rails. "Continue" means unfinished: a saved position (progress p > 5; the
// server deletes progress at >= 95%), or - series only - an "up next"
// lastEpisode pointer (auto:true, written by advanceToNextEpisode).
// Everything else the profile has played (recents / lastPlayed / watched)
// goes to the history rail, newest first.

const MIN_POSITION_S = 5;

const hasPosition = (p) => !!p && Number.isFinite(p.p) && p.p > MIN_POSITION_S;

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
    if (hasPosition(progressById.get(id))) return true;
    return mode === "series" && lastEpisode[String(id)]?.auto === true;
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

module.exports = { selectContinueAndHistory, hasPosition, MIN_POSITION_S };
