// Scoping for POST /api/transcode/stop. Any signed-in user can call it, so the
// no-argument form must only stop the caller's own transcoders — never every
// ffmpeg in the process — and explicit input is validated.
//
// Ownership: transcoders are shared (keyed by title/quality/offset, not by
// viewer), so each entry carries a bounded set of the owner keys that fetched
// its manifest or segments (noteOwner). A caller "owns" a transcoder when its
// owner key is in that set.

const MODE_RE = /^(live|movie|series|disk)$/;
const ID_RE = /^\d+$/;
const MAX_OWNERS = 8;

// Parse the request body. Returns
//   { ok: true, target: null }            — no args: stop the caller's own
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

// Record that `owner` is watching transcoder `t`. Bounded: the least recently
// seen owner is evicted past MAX_OWNERS. Survives respawns (the entry object
// is reused).
function noteOwner(t, owner) {
  if (!t || !owner) return;
  if (!(t.owners instanceof Set)) t.owners = new Set();
  t.owners.delete(owner); // re-insert = most recent
  t.owners.add(owner);
  while (t.owners.size > MAX_OWNERS) t.owners.delete(t.owners.values().next().value);
}

// The caller's own current stream from the admission-control map, as a
// { mode, id } target — or null when the owner has nothing live or was
// displaced (the slot now belongs to whoever displaced them).
function ownStreamTarget(streamEntry) {
  if (!streamEntry || streamEntry.displaced) return null;
  const mode = String(streamEntry.mode || "");
  const id = String(streamEntry.id ?? "");
  if (!MODE_RE.test(mode) || !ID_RE.test(id)) return null;
  return { mode, id };
}

function titleMatches(key, target) {
  return !!target && key.startsWith(`${target.mode}-${target.id}-`);
}

// Pure handler. ctx = { transcoders: Map<key, entry>, streams: Map<owner, entry>,
// owner, stop(t, reason) }. Returns { status, body, error? }.
//  - { mode, id }: every variant of that title, whoever is watching (shared
//    transcoders; e.g. a phone must be able to stop the Chromecast receiver's
//    ffmpeg, which fetched under a different owner key).
//  - no args: the caller's own admission stream's title + every transcoder
//    whose owners include the caller.
function handleStopRequest(body, ctx) {
  const parsed = parseStopRequest(body);
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error }, error: parsed.error };
  const victims = [];
  if (parsed.target) {
    for (const [k, t] of ctx.transcoders) if (titleMatches(k, parsed.target)) victims.push(t);
  } else {
    const own = ownStreamTarget(ctx.streams.get(ctx.owner));
    for (const [k, t] of ctx.transcoders) {
      if (titleMatches(k, own) || (ctx.owner && t?.owners instanceof Set && t.owners.has(ctx.owner))) victims.push(t);
    }
  }
  const reason = parsed.target ? "client-stop" : "client-stop-own";
  for (const t of victims) ctx.stop(t, reason);
  return { status: 200, body: { ok: true, killed: victims.length } };
}

module.exports = { parseStopRequest, noteOwner, ownStreamTarget, handleStopRequest, MAX_OWNERS };
