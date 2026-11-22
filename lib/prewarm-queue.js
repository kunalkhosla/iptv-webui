// Low-priority background prefetch queue. Concurrency 1, fixed gap between
// calls, deduped by key, capped (oldest dropped when full), skips items the
// caller reports as already cached, yields while a viewer holds the panel's
// single connection, errors swallowed, no retries. Pure: the fetcher,
// cache probe, yield probe and timer are all injected.
function createPrewarmQueue({
  fetcher,
  isCached = () => false,
  shouldYield = () => false,
  gapMs = 400,
  yieldMs = 15_000,
  cap = 40,
  setTimeoutFn = setTimeout,
} = {}) {
  const queue = [];          // { key, item }
  const queued = new Set();  // keys in `queue`
  let running = false;
  const stats = { fetched: 0, skipped: 0, errors: 0, dropped: 0 };

  const sleep = (ms) => new Promise((r) => setTimeoutFn(r, ms));

  async function drain() {
    if (running) return;
    running = true;
    try {
      while (queue.length) {
        if (shouldYield()) { await sleep(yieldMs); continue; }
        const { key, item } = queue.shift();
        queued.delete(key);
        let hit = false;
        try { hit = !!isCached(item); } catch {}
        if (hit) { stats.skipped++; continue; }
        try { await fetcher(item); stats.fetched++; } catch { stats.errors++; }
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
      if (!e || !e.key || queued.has(e.key)) continue;
      try { if (isCached(e)) { stats.skipped++; continue; } } catch {}
      if (queue.length >= cap) {
        const old = queue.shift();
        queued.delete(old.key);
        stats.dropped++;
      }
      queue.push({ key: e.key, item: e });
      queued.add(e.key);
      added++;
    }
    if (added) setImmediate(() => { drain(); });
    return added;
  }

  return { enqueue, stats, get size() { return queue.length; }, get running() { return running; } };
}

module.exports = { createPrewarmQueue };
