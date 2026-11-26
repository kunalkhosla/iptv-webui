// TMDB collections (belongs_to_collection: Harry Potter, Narnia, MCU, ...)
// grouped over the library. Pure: the caller passes index items and a TMDB
// lookup, and the per-viewer gate.

// Release sort key: full release date when known, else year, else last.
function releaseKey(t, s) {
  const d = t && typeof t.release_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.release_date) ? t.release_date : null;
  if (d) return d;
  const y = parseInt((t && t.year) || (s && s.year), 10);
  return Number.isFinite(y) ? `${y}-99-99` : "9999-99-99";
}

// items: iterable of index items; tmdbOf(s) -> cache entry or null.
// Returns Map<collectionId, { id, name, poster_path, backdrop_path, members: [{ s, t }] }>
// (every library item whose TMDB entry is in that collection, variants included).
function buildCollectionIndex(items, tmdbOf) {
  const out = new Map();
  for (const s of items) {
    const t = tmdbOf(s);
    if (!t || t.source !== "tmdb" || !t.tmdb_id) continue;
    const c = t.collection;
    if (!c || !Number.isFinite(Number(c.id)) || !c.name) continue;
    const id = Number(c.id);
    let col = out.get(id);
    if (!col) {
      col = { id, name: String(c.name), poster_path: c.poster_path || null, backdrop_path: c.backdrop_path || null, members: [] };
      out.set(id, col);
    }
    if (!col.poster_path && c.poster_path) col.poster_path = c.poster_path;
    if (!col.backdrop_path && c.backdrop_path) col.backdrop_path = c.backdrop_path;
    col.members.push({ s, t });
  }
  return out;
}

// One library item per TMDB title that passes the viewer's gate, ordered by
// release. `pass(s, t)` is the per-viewer gate; `prefer(s)` ranks variants of
// the same title (lower = better; e.g. canonical, non-camera copy first).
function visibleMembers(col, pass, prefer = () => 0) {
  const byTitle = new Map();
  for (const m of col.members) {
    let ok = false;
    try { ok = !!pass(m.s, m.t); } catch { ok = false; }
    if (!ok) continue;
    const cur = byTitle.get(m.t.tmdb_id);
    if (!cur || prefer(m.s) < prefer(cur.s)) byTitle.set(m.t.tmdb_id, m);
  }
  return [...byTitle.values()].sort((a, b) => {
    const ka = releaseKey(a.t, a.s), kb = releaseKey(b.t, b.s);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// Rail-ready list of collections with >= minTitles visible titles.
// `affinity(members)` (optional) boosts collections the viewer has played from.
function collectionList(index, pass, { minTitles = 2, prefer, affinity = () => 0 } = {}) {
  const out = [];
  for (const col of index.values()) {
    const vis = visibleMembers(col, pass, prefer);
    if (vis.length < minTitles) continue;
    const years = vis.map((m) => parseInt(m.t.year || m.s.year, 10)).filter(Number.isFinite);
    const votes = vis.reduce((a, m) => a + (m.t.vote_count || 0), 0);
    out.push({ col, vis, aff: affinity(vis) || 0, votes, firstYear: years.length ? Math.min(...years) : null, lastYear: years.length ? Math.max(...years) : null });
  }
  out.sort((a, b) => (b.aff - a.aff) || (b.vis.length >= 3) - (a.vis.length >= 3) || (b.votes - a.votes) || (a.col.id - b.col.id));
  return out;
}

module.exports = { releaseKey, buildCollectionIndex, visibleMembers, collectionList };
