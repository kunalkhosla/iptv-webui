// Scoping for POST /api/transcode/stop. Any signed-in user can call it, so it
// must only ever stop transcoders that belong to the caller's own panel
// account, and the no-argument form only the caller's own current stream —
// never every ffmpeg in the process.

const MODE_RE = /^(live|movie|series|disk)$/;
const ID_RE = /^\d+$/;

// Parse the request body. Returns
//   { ok: true, target: null }            — no args: stop the caller's own stream
//   { ok: true, target: { mode, id } }    — stop every variant of that title
//   { ok: false, error }                  — malformed (caller answers 400)
// A body that names either field must name both, validly. Ids may arrive as a
// JSON number (Android) or a string (web).
function parseStopRequest(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const hasMode = b.mode !== undefined && b.mode !== null;
  const hasId = b.id !== undefined && b.id !== null;
  if (!hasMode && !hasId) return { ok: true, target: null };
  const mode = typeof b.mode === "string" ? b.mode : "";
  const id = typeof b.id === "number" && Number.isSafeInteger(b.id) && b.id >= 0
    ? String(b.id)
    : (typeof b.id === "string" ? b.id : "");
  if (!MODE_RE.test(mode)) return { ok: false, error: "invalid mode" };
  if (!ID_RE.test(id)) return { ok: false, error: "invalid id" };
  return { ok: true, target: { mode, id } };
}

// The caller's own current stream from the admission-control map, as a
// { mode, id } target — or null when the owner has nothing live (or was
// displaced: the slot now belongs to whoever displaced them, so a late stop
// from the loser must not touch it).
function ownStreamTarget(streamEntry) {
  if (!streamEntry || streamEntry.displaced) return null;
  const mode = String(streamEntry.mode || "");
  const id = String(streamEntry.id ?? "");
  if (!MODE_RE.test(mode) || !ID_RE.test(id)) return null;
  return { mode, id };
}

// Transcoders (from the key → entry map) for `target` that belong to
// `accountKey`. Prefix-matches every quality/offset/audio variant of the
// title. Entries with no recorded account never match.
function selectTranscodersToStop(transcoders, target, accountKey) {
  if (!target || !accountKey) return [];
  const prefix = `${target.mode}-${target.id}-`;
  const out = [];
  for (const [k, t] of transcoders) {
    if (k.startsWith(prefix) && t && t.accountKey === accountKey) out.push(t);
  }
  return out;
}

module.exports = { parseStopRequest, ownStreamTarget, selectTranscodersToStop };
