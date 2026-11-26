// Pause keep-alive (POST /api/stream/heartbeat).
//
// The concurrency idle-reaper frees a cap=1 slot once an owner has made no
// media request for LIVE_IDLE_GRACE_MS. A PAUSED VOD player makes none, so a
// pause longer than the grace reaped the session (and its transcode dir) and
// the resume 404'd. While a movie/episode is paused, clients POST
// { mode, id } here about once a minute; this only bumps the idle clocks of a
// session that ALREADY exists for that title and belongs to the caller. It
// never creates a session, never spawns ffmpeg, never touches the upstream.
//
// Caller matching: the web player's segment fetches carry the session cookie
// (owner "s:<token>"), but the Android players fetch media without cookies,
// so their owner is "ip:<ip>:<ua-hash>" with the player's user agent — a
// different key from the cookie-authenticated heartbeat. An entry matches
// when its owner IS the caller's owner key, or is an ip-owner from the
// caller's own IP.
//
// Bounded: a heartbeat is ignored once the session has seen no real media
// request (manifest/segment/bytes) for maxMs — clients stop after 60 min of
// pause on their own; this is the server-side backstop.

const MODE_RE = /^(movie|series|disk)$/;
const ID_RE = /^\d{1,17}$/; // disk ids are up to 17 digits
const DEFAULT_MAX_MS = 65 * 60_000;

function parseHeartbeat(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const mode = typeof b.mode === "string" ? b.mode : "";
  const id = typeof b.id === "number" && Number.isSafeInteger(b.id) && b.id >= 0
    ? String(b.id)
    : (typeof b.id === "string" ? b.id : "");
  if (mode === "live") return { ok: false, error: "live is not kept alive" };
  if (!MODE_RE.test(mode)) return { ok: false, error: "invalid mode" };
  if (!ID_RE.test(id)) return { ok: false, error: "invalid id" };
  return { ok: true, mode, id };
}

// "ip:<ip>:<8 hex>" -> "<ip>" (ip may itself contain ':' for IPv6).
function ipOfOwnerKey(key) {
  if (typeof key !== "string" || !key.startsWith("ip:")) return null;
  const cut = key.lastIndexOf(":");
  if (cut <= 3) return null;
  return key.slice(3, cut);
}

function ownerMatchesCaller(ownerKey, callerOwner, callerIp) {
  if (ownerKey === callerOwner) return true;
  const ip = ipOfOwnerKey(ownerKey);
  return ip != null && !!callerIp && ip === callerIp;
}

function maxMsFrom(env) {
  const n = parseInt(env, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_MS;
}

// ctx = { streams: Map<owner, entry>, transcoders: Map<key, entry>,
//         callerOwner, callerIp, now, maxMs }
// Returns { status, body }. Mutates lastSeen / lastAccess only.
function handleHeartbeat(reqBody, ctx) {
  const p = parseHeartbeat(reqBody);
  if (!p.ok) return { status: 400, body: { ok: false, error: p.error } };
  const now = ctx.now;
  const maxMs = ctx.maxMs || DEFAULT_MAX_MS;
  const matched = [];
  let displaced = false;
  for (const [owner, v] of ctx.streams) {
    if (!v || v.mode !== p.mode || String(v.id) !== p.id) continue;
    if (!ownerMatchesCaller(owner, ctx.callerOwner, ctx.callerIp)) continue;
    if (v.displaced) { displaced = true; continue; }
    matched.push([owner, v]);
  }
  if (!matched.length) {
    if (displaced) return { status: 410, body: { ok: false, error: "displaced" } };
    return { status: 200, body: { ok: true, kept: false, reason: "no-session" } };
  }
  const fresh = matched.filter(([, v]) => now - (v.mediaSeen ?? v.since ?? 0) <= maxMs);
  if (!fresh.length) return { status: 200, body: { ok: true, kept: false, reason: "cap" } };
  const owners = new Set();
  for (const [owner, v] of fresh) { v.lastSeen = now; owners.add(owner); }
  let touched = 0;
  const prefix = `${p.mode}-${p.id}-`;
  for (const [key, t] of ctx.transcoders) {
    if (!t || t.stopping || !String(key).startsWith(prefix)) continue;
    if (!(t.owners instanceof Set)) continue;
    let mine = false;
    for (const o of t.owners) if (owners.has(o)) { mine = true; break; }
    if (!mine) continue;
    t.lastAccess = now;
    touched++;
  }
  return { status: 200, body: { ok: true, kept: true, sessions: fresh.length, transcoders: touched } };
}

module.exports = { parseHeartbeat, ipOfOwnerKey, ownerMatchesCaller, maxMsFrom, handleHeartbeat, DEFAULT_MAX_MS };
