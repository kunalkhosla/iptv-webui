// Tile previews from the real title stream (GET /api/preview/:mode/:id).
//
// When a focused tile has no cached trailer, the TV may play a short preview
// of the title itself. The provider allows ONE connection for the whole
// household, so a preview is the LOWEST priority user of that connection:
//
//   - admitted only when no real viewer holds it (see decideAdmission);
//   - never displaces anything: a real play, a phone download, any admission
//     of a real owner, or a progress / pause-heartbeat post from another
//     device stops it at once (server.js stopPreviews);
//   - at most one at a time; a new one replaces the previous one;
//   - torn down by an explicit stop, a short idle reap, or its own end.
//
// Pure helpers only; server.js owns the streams map, ffmpeg and the routes.

const PREVIEW_OWNER_PREFIX = "preview:";
const SID_RE = /^p[0-9a-f]{16}$/;

function isPreviewOwner(owner) {
  return typeof owner === "string" && owner.startsWith(PREVIEW_OWNER_PREFIX);
}

// How recent a real play / progress / heartbeat from ANOTHER device must be to
// count as "someone is watching". A direct-play VOD posts progress every 30 s
// while playing and a pause heartbeat every 60 s while paused, so 3 min covers
// both with margin. Live direct play talks to the server only when it starts
// (GET /api/stream) and ends (POST /api/live/health), so a live play counts
// until it ends, capped at liveHoldMs.
const RECENT_MS = 3 * 60_000;
const LIVE_HOLD_MS = 3 * 3600_000;
// A live health report this soon after the same owner's live play request is
// the report of the PREVIOUS session (zap: report and new play race), not the
// end of the new one.
const LIVE_END_RACE_MS = 10_000;
// The asking device's OWN signals: a device has one player, so its older
// signals are of a play it has since left (it is browsing tiles now). But a
// direct-play VOD / live leaves no streams entry, and a preview request can
// arrive a moment after the same device's own play request (focus still on
// the tile as playback starts): that play is the device's real viewer, and a
// preview's connection would displace it. So the requester's own play / activity
// blocks for OWN_GRACE_MS, and its own un-ended live play for OWN_LIVE_GRACE_MS.
const OWN_GRACE_MS = 15_000;
const OWN_LIVE_GRACE_MS = 60_000;

// signals: Map<owner, { at, live, endedAt }>, one record per owner (a device
// has one player). kind: "play-live" | "play-vod" | "activity" | "live-end".
function noteSignal(signals, owner, kind, now) {
  if (!owner || isPreviewOwner(owner)) return;
  const cur = signals.get(owner);
  if (kind === "play-live") signals.set(owner, { at: now, live: true, endedAt: 0 });
  else if (kind === "play-vod") signals.set(owner, { at: now, live: false, endedAt: 0 });
  else if (kind === "activity") {
    // Progress / heartbeat: a VOD player is alive on that device. Never
    // downgrades an un-ended live play (a stray post must not drop its hold).
    if (cur && cur.live && !cur.endedAt && now - cur.at < LIVE_HOLD_MS) return;
    signals.set(owner, { at: now, live: false, endedAt: 0 });
  } else if (kind === "live-end") {
    if (cur && cur.live && now - cur.at > LIVE_END_RACE_MS) cur.endedAt = now;
  }
  // Bounded: drop records too old to matter.
  if (signals.size > 500) {
    for (const [k, v] of signals) if (now - v.at > LIVE_HOLD_MS) signals.delete(k);
  }
}

// Does `rec` (another device's latest signal) mean someone may be watching now?
function signalBusy(rec, now, { recentMs = RECENT_MS, liveHoldMs = LIVE_HOLD_MS } = {}) {
  if (!rec) return false;
  const age = now - rec.at;
  if (age < 0) return true;
  if (rec.live) return !rec.endedAt && age < liveHoldMs;
  return age < recentMs;
}

// May a preview start now for `requester` (the asking device's cookie owner)?
// -> { ok: true } | { ok: false, reason }
//   streams: the server's admission map (owner -> { accountKey, lastSeen, displaced, ... })
//   signals: noteSignal map
// Any live, non-preview, non-displaced stream entry on the account blocks it,
// including Disk transcodes, phone downloads and a paused player kept alive by
// heartbeats (all bump lastSeen). Save-to-Disk transfers do not block (the
// preview preempts them, as a viewer does). The requester's own entries are
// NOT exempt (an Android player's media owner is an "ip:" key that can't be
// told apart from another device behind the same address).
function decideAdmission({ streams, signals, requester, accountKey, now, idleGraceMs, isBackgroundOwner = () => false, isDiskDownloadOwner = () => false, recentMs, liveHoldMs }) {
  for (const [k, v] of streams) {
    if (!v || v.displaced || isPreviewOwner(k)) continue;
    if (accountKey && v.accountKey !== accountKey) continue;
    if (isDiskDownloadOwner(k)) continue; // yields to us
    if (now - Number(v.lastSeen || 0) >= idleGraceMs) continue;
    return { ok: false, reason: isBackgroundOwner(k) ? "download" : "viewer" };
  }
  for (const [owner, rec] of signals) {
    if (owner === requester) {
      const age = now - rec.at;
      if (age < OWN_GRACE_MS) return { ok: false, reason: rec.live ? "live-viewer" : "viewer" };
      if (rec.live && !rec.endedAt && age < OWN_LIVE_GRACE_MS) return { ok: false, reason: "live-viewer" };
      continue;
    }
    if (signalBusy(rec, now, { recentMs, liveHoldMs })) return { ok: false, reason: rec.live ? "live-viewer" : "viewer" };
  }
  return { ok: true };
}

// Where a preview starts (seconds): the profile's resume point when it is a
// real one (past the first minute, not in the last 10 %), else ~10 % in
// (60 s .. 15 min; 5 min when the duration is unknown).
function previewStartSecs({ progressSecs, durationSecs }) {
  const d = Number(durationSecs);
  const known = Number.isFinite(d) && d > 0;
  const p = Number(progressSecs);
  if (Number.isFinite(p) && p >= 60 && (!known || p < d * 0.9)) return Math.floor(p);
  if (!known) return 300;
  return Math.floor(Math.min(900, Math.max(60, d * 0.1)));
}

// The episode a series preview plays: the profile's "continue" pointer
// (lastEpisode, already moved to the next episode when one was finished),
// else the first episode of the lowest season >= 1 (season 0 = specials).
// info: panel get_series_info ({ episodes: { "<season>": [ep...] } }).
// -> { id, season, episodeNum, ext, durationSecs } | null
function pickSeriesEpisode(info, lastEpisode) {
  const seasons = info && info.episodes && typeof info.episodes === "object" ? info.episodes : null;
  if (!seasons) return null;
  const all = [];
  for (const [sn, list] of Object.entries(seasons)) {
    if (!Array.isArray(list)) continue;
    for (const e of list) {
      if (!e || !/^\d{1,12}$/.test(String(e.id))) continue;
      const season = Number(e.season ?? sn);
      all.push({
        id: String(e.id),
        season: Number.isFinite(season) ? season : 0,
        episodeNum: Number(e.episode_num) || 0,
        ext: String(e.container_extension || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4",
        durationSecs: Number(e.info?.duration_secs) || null,
      });
    }
  }
  if (!all.length) return null;
  all.sort((a, b) => a.season - b.season || a.episodeNum - b.episodeNum);
  const le = lastEpisode && lastEpisode.episode_id != null ? String(lastEpisode.episode_id) : null;
  if (le) {
    const hit = all.find((e) => e.id === le);
    if (hit) return hit;
  }
  return all.find((e) => e.season >= 1) || all[0];
}

function newSid(randomHex) {
  return `p${randomHex(8)}`;
}

function isValidSid(sid) {
  return typeof sid === "string" && SID_RE.test(sid);
}

// ffmpeg args for a preview: a low-res H.264 + stereo AAC HLS stream of
// `durationSecs` from `startSecs`. hw = VAAPI decode + scale + encode.
function previewFfmpegArgs({ sourceUrl, startSecs, durationSecs, audioTrack = 0, hw = false, vaapiDevice, reconnectArgs = [], userAgent, dir }) {
  const a = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (userAgent) a.push("-user_agent", userAgent);
  a.push(...reconnectArgs);
  if (hw) a.push("-hwaccel", "vaapi", "-hwaccel_device", vaapiDevice, "-hwaccel_output_format", "vaapi");
  if (startSecs > 0) a.push("-ss", String(Math.floor(startSecs)));
  a.push("-i", sourceUrl, "-t", String(Math.floor(durationSecs)), "-map", "0:v:0", "-map", `0:a:${Math.max(0, audioTrack | 0)}?`, "-sn", "-dn");
  if (hw) {
    a.push("-vf", "scale_vaapi=w='min(854,iw)':h=-2:format=nv12", "-c:v", "h264_vaapi", "-qp", "26",
      "-profile:v", "high", "-level", "41", "-g", "48", "-keyint_min", "48");
  } else {
    // Software: capped threads, so a preview never takes the whole box.
    a.push("-threads", "2", "-filter_threads", "1", "-vf", "scale='min(854,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high",
      "-level", "4.1", "-pix_fmt", "yuv420p", "-crf", "26", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0");
  }
  a.push("-c:a", "aac", "-ac", "2", "-b:a", "128k", "-af", "aresample=async=1000:first_pts=0",
    "-max_muxing_queue_size", "1024", "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_flags", "independent_segments", "-hls_segment_filename", `${dir}/seg_%05d.ts`, `${dir}/index.m3u8`);
  return a;
}

module.exports = {
  PREVIEW_OWNER_PREFIX, RECENT_MS, LIVE_HOLD_MS, LIVE_END_RACE_MS, OWN_GRACE_MS, OWN_LIVE_GRACE_MS,
  isPreviewOwner, noteSignal, signalBusy, decideAdmission,
  previewStartSecs, pickSeriesEpisode, newSid, isValidSid, previewFfmpegArgs,
};
