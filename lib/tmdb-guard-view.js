// Read-through "guarded" view over the raw TMDB cache store. Pure: the store,
// overrides, stream lookup and judge function are injected (see server.js).
//
// The view hides implausible matches as no-match WITHOUT touching the raw
// store (serializing the store never contains a synthesized placeholder).

// Coerce data/tmdb-overrides.json into {"movie:123": null | positiveInt}.
// String ids ("1234") are coerced; anything else is dropped.
function normalizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!/^(movie|series):\d+$/.test(k)) continue;
    if (v === null) { out[k] = null; continue; }
    const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? parseInt(v, 10) : v;
    if (Number.isInteger(n) && n > 0) out[k] = n;
  }
  return out;
}

function createGuardedTmdbCache({ store, overrides, getInfo, judge, now = Date.now }) {
  const hasOverride = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const memo = new Map();  // key -> {e, sig, verdict}
  const views = new Map(); // key -> {src, reason, view}   (stable identity per raw entry)

  // Verdict for a raw entry: {ok, reason}. Memoised by entry identity + stream signature.
  function verdict(key, e) {
    if (!e || typeof e !== "object" || e.source !== "tmdb" || !e.tmdb_id) return { ok: true };
    if (hasOverride(key)) return { ok: true, reason: "override" };
    if (e.guard_rejected) return { ok: false, reason: e.guard_rejected };
    const info = getInfo(key);
    if (!info || !info.name) return { ok: true };
    const sig = `${info.name}|${info.year || ""}|${(info.tags || []).join(",")}`;
    const m = memo.get(key);
    if (m && m.e === e && m.sig === sig) return m.verdict;
    const v = judge(key.split(":")[0], info, e);
    memo.set(key, { e, sig, verdict: v });
    return v;
  }

  function invalidate(key) { memo.delete(key); views.delete(key); }

  function rejectedView(key, e, reason, checkedAt) {
    const cur = views.get(key);
    if (cur && cur.src === e && cur.reason === reason) return cur.view;
    const view = { tmdb_id: null, source: "no-match", checked_at: checkedAt, implausible: true, reason };
    views.set(key, { src: e, reason, view });
    return view;
  }

  const cache = new Proxy(store, {
    get(t, k) {
      if (typeof k !== "string") return t[k];
      if (hasOverride(k)) {
        const ov = overrides[k];
        if (ov === null) return { tmdb_id: null, source: "no-match", checked_at: now(), override: true };
        const e = t[k];
        if (!(e && e.source === "tmdb" && e.tmdb_id === ov)) {
          return { tmdb_id: null, source: "no-match", checked_at: 0, override_pending: true };
        }
        return e;
      }
      const e = t[k];
      if (!e || typeof e !== "object") return e;
      if (e.source === "tmdb" && e.tmdb_id) {
        const v = verdict(k, e);
        if (!v.ok) {
          // Guard-rejected on re-resolve: honour its timestamp (negative TTL);
          // never-yet-rechecked implausible entries get checked_at 0 => re-resolve lazily.
          return rejectedView(k, e, v.reason, e.guard_rejected ? (e.rejected_at || now()) : 0);
        }
      }
      return e;
    },
  });
  return { cache, verdict, invalidate, hasOverride };
}

// Mark a raw tmdb entry as rejected by the guard while keeping its data.
function markGuardRejected(entry, reason, rejectedTmdbId, at = Date.now()) {
  return { ...entry, guard_rejected: reason, rejected_at: at, ...(rejectedTmdbId ? { rejected_tmdb_id: rejectedTmdbId } : {}) };
}

module.exports = { createGuardedTmdbCache, normalizeOverrides, markGuardRejected };
