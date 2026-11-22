// Low-priority background prefetch queue. Concurrency 1, fixed gap between
// calls, deduped by key, capped (oldest dropped when full), skips items the
// caller reports as already cached, yields while a viewer holds the panel's
// single connection, errors swallowed, no retries. Pure: the fetcher,
// cache probe, yield probe and timer are all injected.
function createPrewarmQueue({
  fetcher,
  isCached = () => false,
  shouldYield = () => false,
  gapMs = 1500,
  yieldMs = 15_000,
  cap = 24,
  failCooldownMs = 20 * 60_000,
  breakerThreshold = 5,
  breakerPauseMs = 10 * 60_000,
  now = Date.now,
  setTimeoutFn = (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; },
} = {}) {
  const queue = [];          // { key, item }
  const queued = new Set();  // keys in `queue`
  let running = false;
  const failedAt = new Map(); // key -> ms of last failure (negative cache)
  let consecutiveErrors = 0;
  let pausedUntil = 0;
  const stats = { fetched: 0, skipped: 0, errors: 0, dropped: 0 };
  const recentlyFailed = (key) => {
    const t = failedAt.get(key);
    if (t === undefined) return false;
    if (now() - t < failCooldownMs) return true;
    failedAt.delete(key);
    return false;
  };

  const sleep = (ms) => new Promise((r) => setTimeoutFn(r, ms));

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (now() < pausedUntil) { queue.length = 0; queued.clear(); break; }
        if (shouldYield()) { await sleep(yieldMs); continue; }
        const { key, item } = queue.shift();
        queued.delete(key);
        let hit = false;
        try { hit = !!isCached(item); } catch {}
        if (hit) { stats.skipped++; continue; }
        try {
          await fetcher(item); stats.fetched++; consecutiveErrors = 0;
        } catch {
          stats.errors++;
          failedAt.set(key, now());
          if (failedAt.size > 500) failedAt.delete(failedAt.keys().next().value);
          if (++consecutiveErrors >= breakerThreshold) {
            consecutiveErrors = 0;
            pausedUntil = now() + breakerPauseMs;
          }
        }
        if (queue.length) await sleep(gapMs);
      }
    } finally {
      running = false;
    }
  }

  // entries: [{ key, ...payload }]; returns number actually queued.
  function enqueue(entries) {
    let added = 0;
    for (const e of entries) {
      if (now() < pausedUntil) break;
      if (!e || !e.key || queued.has(e.key) || recentlyFailed(e.key)) continue;
      try { if (isCached(e)) { stats.skipped++; continue; } } catch {}
      if (queue.length >= cap) { stats.dropped++; continue; } // keep the earliest (hero) entries
      queue.push({ key: e.key, item: e });
      queued.add(e.key);
      added++;
    }
    if (added) setImmediate(() => { drain(); });
    return added;
  }

  return { enqueue, stats, get size() { return queue.length; }, get running() { return running; } };
}

// Validate/dedupe ids into queue entries (max per call). Ids must be numeric.
function buildDetailEntries(mode, ids, actx, accountKey, max = 8) {
  if (mode !== "movie" && mode !== "series") return [];
  const idKey = mode === "series" ? "series_id" : "vod_id";
  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw ?? "");
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ key: `${accountKey}|${mode}|${id}`, mode, idKey, id, actx });
    if (out.length >= max) break;
  }
  return out;
}

module.exports = { createPrewarmQueue, buildDetailEntries };
