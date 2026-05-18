# CLAUDE.md

Working notes and conventions for this repo. Treat as ground truth before
making changes.

## What this is

A self-hosted web UI for an Xtream Codes IPTV panel. Browse 10k+ live
channels, movies, and series; search across the whole catalog; cast to a
Chromecast; preview in-browser when codecs allow.

The project exists because every IPTV reseller's mobile/TV app is bad. The
panel itself is a JSON API (Xtream Codes), so the UI is the only thing
that needs replacing.

## Stack at a glance

- **Backend:** Node 20 + Express, no build step.
- **Frontend:** Vanilla JS, hand-written CSS, hls.js + Cast Web Sender via CDN. No bundler, no framework.
- **Container:** Multi-stage-ish Dockerfile (Alpine + ffmpeg) → ghcr.io.
- **CI:** A GitHub Actions workflow builds and pushes `ghcr.io/<owner>/iptv-webui:latest` on every push to `main`.
- **Deploy:** docker-compose on a VPS, fronted by a host-network Traefik that does Let's Encrypt.

## Companion: Android TV client

A separate repo, **`iptv-android-companion`** (Kotlin + Compose for TV +
ExoPlayer), is being built as a second client of this server. Auth,
profiles, state, transcoding, TMDB enrichment, and concurrency safety
all live on the server — the TV app is a thin presentation client and
does not duplicate that logic.

The same cookie session (`khouch_session` + `khouch_profile`) is
reused on the TV side via an OkHttp `CookieJar` persisted to
DataStore. The TV app calls the same `/api/*` endpoints the web
client uses, so user-state (favorites, my list, recents, watched,
progress, last episode) syncs automatically across the TV and
any browser on the same profile.

**Rule:** when changing any `/api/*` endpoint shape, auth flow,
cookie attributes, or `userState` schema in this repo, update the
companion repo's Retrofit `KhouchApi` interface
(`app/src/main/kotlin/com/khouch/tv/data/api/`) and the relevant
Kotlin model in the same PR. CLAUDE.md in both repos should always
stay current — if a contract changes here, note it in this section
AND in the TV repo's CLAUDE.md.

Cross-link: https://github.com/kunalkhosla/iptv-android-companion

## Top-level architecture

```
Browser ──HTTPS──► Traefik ──HTTP──► Express (server.js)
                                          │
                                          ├── /api/bootstrap, /api/index/*  (panel metadata, auth-gated)
                                          ├── /api/stream/<mode>/<id>.<ext> (returns SIGNED proxy + transcode URLs)
                                          ├── /api/proxy?u=…&s=…            (signed; no Basic Auth)
                                          └── /api/transcode/<mode>/<id>/index.m3u8?s=…
                                                  └── spawns ffmpeg → /tmp/iptv-transcode/<mode>-<id>/

Panel data flow:
  Express ── HTTP ──► panel.example/player_api.php?action=…   (cached 1h in memory)

Stream data flow:
  Browser ──► /api/proxy ──► panel ──► segments back through Express
        OR
  Chromecast ──► panel directly (we hand it the panel URL)
```

## The Xtream Codes protocol (panel side)

All panels expose the same endpoints under `/player_api.php` with `username` and `password` query params. The actions we use:

- `(no action)` — returns `{user_info, server_info}`. Use for liveness/auth checks.
- `get_live_categories`, `get_live_streams[?category_id=N]`
- `get_vod_categories`, `get_vod_streams[?category_id=N]`
- `get_vod_info?vod_id=N` (returns ffprobe-ish metadata)
- `get_series_categories`, `get_series[?category_id=N]`
- `get_series_info?series_id=N` (seasons/episodes tree)
- `get_short_epg?stream_id=N`

Stream URLs are constructed (not returned by the API):

| Mode   | URL                                                       |
|--------|-----------------------------------------------------------|
| live   | `${PANEL}/live/${USER}/${PASS}/${id}.m3u8` (HLS) or `.ts` |
| movie  | `${PANEL}/movie/${USER}/${PASS}/${id}.${container_ext}`   |
| series | `${PANEL}/series/${USER}/${PASS}/${ep_id}.${container_ext}` |

`container_ext` comes from the metadata (`mp4`, `mkv`, `avi`).

### Things panels do that you'll be tempted to call bugs

- **Inconsistent codecs.** Many panels stream MPEG-2 SD video for "HD" channels. Browsers cannot decode MPEG-2 in MSE; that's why we have a transcoder.
- **Empty manifests.** Sometimes a `.m3u8` request returns `Content-Length: 0` even on HTTP 200. Channel may be off-air, slot may be in use, or rate-limit may have kicked in. Don't treat this as a code bug.
- **Cloudflare TOS placeholder.** When a reseller hosts video on Cloudflare's free tier and gets flagged, every video URL 302-redirects to `cloudflare-terms-of-service-abuse.com/stream.mp4` with a 12 KB clip. There is no client-side fix. The fallback panel feature exists for this case (some resellers run multiple hosts).
- **`max_connections=1` is loosely enforced.** You will see `active_cons` higher than `max_connections`. Don't panic, but expect some segment fetches to return weirdly when slots are tight.
- **Per-host slugs in segment URLs.** Live HLS chunks sit at `/hlsr/<long_token>/USER/PASS/CHID/<hash>/CHID_NNN.ts`. The token encodes auth. Don't try to parse it; just proxy through.
- **Some panels need specific User-Agents.** We send `Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36` to the panel. Don't change this casually — some panels return empty bodies for "browser-looking" UAs.

## Authentication model

There are two unrelated auth layers; do not conflate them.

1. **App auth (`APP_USER`/`APP_PASS`)** — HTTP Basic Auth in front of the UI and metadata APIs. Gates the whole product.
2. **Panel auth (`IPTV_USER`/`IPTV_PASS`)** — embedded in stream URLs. Gates the upstream content. The user never enters these.

The proxy and transcoder routes are deliberately **outside** Basic Auth and instead validated by an HMAC signature, because Chrome's `<video>` element does not consistently attach cached HTTP Basic Auth to media segment fetches. Without this, every play click triggered a fresh credential prompt loop. The signature is generated by `/api/stream` (which is itself behind Basic Auth), so URLs cannot be forged.

`PROXY_SECRET` **must be set in the VPS env** (and is — see deploy notes). It signs both `khouch_session` and `khouch_profile` cookies. If left unset, the server picks a random value per process and every container restart invalidates every cookie for every user.

**Multi-profile gotcha:** when both a session cookie AND an `Authorization: Basic` header arrive on the same request (browsers can keep cached Basic Auth alive across PROXY_SECRET rotations or other expiries), the auth middleware honors the cookie-derived profile id over the "first profile" Basic-Auth fallback. Don't reverse this — every profile-switch silently broke for that user.

## Cache-Control policy

`express.static(public/)` sets `Cache-Control: no-cache, must-revalidate` on every static asset. Browsers can keep the bytes but MUST revalidate via ETag on each request, so a deploy lands instantly without users sitting on a stale `app.js` / `profile-pick.html`.

`/api/home/{mode}` and `/api/bootstrap` send `Cache-Control: no-store`. Both vary per active profile and per server-side rule update (e.g. the title-language guard); browser caching them lets stale rails / wrong-profile state linger after a switch or deploy.

## XMLTV bulk EPG indexer

The panel exposes `/xmltv.php?username=…&password=…` which returns the entire EPG for every channel in one (large) XML document. `prewarmEpg()` fetches it on boot if the on-disk cache is stale, then nightly at 3 AM local. Programmes are parsed by single-pass regex (no SAX dependency) into an in-memory `epgIndex: Map<epg_channel_id, sorted [{start, stop, title, desc}]>` and persisted to `data/epg-xmltv.json` so server restarts don't re-download.

`/api/epg/short/{streamId}` checks `epgIndex` first using the panel's `epg_channel_id` field on the stream; when found, the response is a pure in-memory slice (1h-back / Nh-forward, capped 24h). Falls back to the per-channel `get_simple_data_table` call when the index has no coverage for that channel (long tail / no EPG provider).

`N` is the user's `userState.epgWindowHoursForward` (default 3h), settable from **Settings → TV Guide → Forward window** (web) — a click-to-cycle pill stepping through 2 / 3 / 5 / 8 / 12 / 24 h. Native `<select>` was unreliable inside the popup menu; the pill is a plain button so the outside-click handler can never close the menu mid-interaction. 1h-back lookback is fixed server-side.

## Real-4K verification

Panels routinely label movies "(4K)" in the title or category even when the actual file is 1080p (or once, observed: a 600×900 JPEG poster). The `4k` chip would surface all of them.

`prewarmQualityCache()` walks every in-memory movie tagged `4k`, calls `get_vod_info`, reads `info.video.{width, height}`, and demotes the tag on the live `byId` stream when actual resolution is sub-4K. Definition: `is4k = (height >= 2000) || (width >= 3200)` — covers 16:9 UHD (3840×2160), 2.4:1 cinema (3840×1600), and 4K-class ultra-wide (3940×816); excludes 1080p HEVC and poster-only entries. Verdicts persist to `data/quality-cache.json` (30-day TTL) so the verification runs once per item, not every boot. `applyQualityDemotion(mode, id, tags)` is consulted from both `projectStream` and `loadIndexFromDisk` so a rebuild can't re-promote the tag. Live and series are skipped — live has no API-level resolution metadata, and series would need per-episode probing.

## Panel-supplied tmdb_id shortcut

When `/api/{movie|series}/info/{id}` runs, the response's `info.tmdb_id` (when populated by the panel) is recorded into the TMDB cache opportunistically. The next `ensureTmdbForItem` call for that item skips the TMDB title-search round-trip and goes straight to the TMDB detail fetch — saves one HTTP per item and avoids the search-result ambiguity that bit ambiguous titles.

Same endpoint also fills `us_cert` from `info.mpaa_rating` when TMDB returned a match but with an empty `us_cert` field — only fills the gap, never overwrites a real TMDB cert. Unlocks the kid-cert filter on titles TMDB knows but hasn't rated (often older / foreign films).

## TMDB no-match retry

`source: "no-match"` cache entries get auto-retried two ways:

1. **TTL-driven**: `TMDB_NEGATIVE_TTL_MS = 7 days`. After a week, the regular `prewarmTmdbCache` pass on boot or after a buildIndex treats stale no-matches as candidates again.
2. **Nightly cron**: `scheduleTmdbNightlyRetry()` runs at **3:30 AM local** (30 min after the xmltv pull) — walks every `no-match` entry, calls `findTmdbMatch` again, promotes anything that resolves now. Mirrors the xmltv cron's scheduling pattern.

Both paths share the same `retryTmdbNoMatches({ onProgress })` worker. The admin endpoint `POST /api/admin/retry-tmdb-no-matches` streams NDJSON progress to the caller and runs the same function on demand.

`findTmdbMatch` cleanup is two-pass — first a strict cleanup (drop everything after `(YYYY)`), then a loose cleanup (collapse `Drive-Away.Dolls.2024` dot-separated filenames into spaces). Catches titles the strict pass leaves as garbage queries.

## Soft-NR for kid categories

`/api/home/movie` tile shape applies a small rescue rule for kid-cert filtering: when an item lands in a category whose name matches the kid-category regex (`kids`, `cartoon`, `animat`, `toddler`, `baby`, `family`, `disney`, `pixar`, `nick jr`, `cbeebies`, `nickelodeon`, `toon`) **and** TMDB returned no `us_cert`, the tile emits `us_cert: "G"`. Conservative — only fires in genuinely kid-themed rails, never overrides a real TMDB cert.

## Live channel codec probe + off-air detection

`/api/stream/live/<id>.m3u8` runs `probeChannelAudioCodec` on first hit: a manifest liveness check (3-attempt retry against the panel) followed by a 1-segment ffprobe to read the audio codec. Verdicts go in `data/audio-codec-cache.json` keyed by `live:<id>`, with separate TTLs — alive verdicts kept 7 days (codecs don't change), dead verdicts re-checked after 5 min (panels rotate CDN hosts so a 403 channel can be back fast).

When the verdict is `browser_safe: false` (audio in `{mp1, mp2, ac3, eac3, dts, dca, truehd, pcm_*}` — MSE can't decode them, hls.js silently mis-routes them as MP3 or drops them), `/api/stream` swaps the primary `url` field from the proxy URL to the transcode URL and adds `forceTranscode: true`. The web client (`play()` in `app.js`) promotes that into `state.playing.transcode` and toasts the reason. Fixes the silent-black-box failure mode on sports panels (Cric Eurosports = MP2).

`/api/probe-channels` is a separate batch endpoint for the TV Guide's visible-channel sweep — IntersectionObserver collects rows that scroll into view, posts the ids, server runs probes at concurrency=2 with a 250 ms gap. The inline `✕ off-air` marker renders for dead channels. **Gated behind `PROBE_CHANNELS_ENABLED` env flag (default OFF).** With the panel's `max_connections=1` cap loosely enforced and stale sessions not reaped promptly, even short-lived probes climb `active_cons` faster than the panel decrements — leaving the chip stuck at "5/1" with no real connections held. Enable only on panels that report > 1 actual slot. When disabled the server returns `{ disabled: true, verdicts: {} }` and the client one-shot-stops scheduling further probes; the off-air marker simply doesn't render, the play-time codec probe still works for the transcoder auto-route.

## allowed_output_formats + exp_date

`/api/bootstrap` returns the panel's `user_info` block via the `account` field. `streamUrl()` consults `user_info.allowed_output_formats` and silently falls back from `.ts` to `.m3u8` for live mode when the panel hasn't whitelisted TS. Web Settings shows `user_info.exp_date` as a "panel expires in N days" hint when set; the hint turns red within 14 days of expiry.

## External services

**TMDB** (optional). When `TMDB_API_KEY` is set in `.env`, the server enriches movie/series posters, backdrops, plots, ratings, runtimes, genres, and per-season episode stills via `/api/poster/...` endpoints. Artwork is TMDB-primary; text metadata only fills blanks the panel left empty. Lookups are cached on disk in `data/tmdb-cache.json` (positive matches forever, negative matches re-checked after 30 days). The image bytes themselves are served by `image.tmdb.org` (Cloudflare-fronted), so we don't proxy them. Without the key the feature is silently disabled and the UI falls back to whatever artwork the panel ships.

`prewarmTmdbCache(mode)` fires as a fire-and-forget background pass at the end of each `buildIndex()` for `movie` / `series`, and also on boot when no rebuild is scheduled. It iterates the index, calls `ensureTmdbForItem` for each ID, and stamps the cache. Concurrency is capped at 4 to leave headroom for live UI traffic — cached items return without an upstream call. Heartbeat logs every 1000 items so a multi-minute prewarm doesn't go silent.

## Filter tags + chip system

Both clients (web TV Guide, web Movies/Series home, Android TV) show chip-strip filters that narrow the visible list by language / country / genre / 4K / Music etc. The chip-toggle hot path used to run the full `GROUPS` regex table against every channel's category name client-side — fine on a laptop, ANR-killing on a Chromecast with 3 chips selected.

`CHANNEL_GROUPS` (in `server.js`) is now the single source of truth. The server pre-computes a per-stream `tags: string[]` array at index-build time via `categoryTagsFor()` (regexes against category name) merged with `streamTagsFor()` (4k / movies / music markers scanned from the channel name itself, plus the derived "entertainment" residual tag). The result rides on every stream in `/api/index/{mode}` and every tile in `/api/home/{mode}`. Both clients reduce chip toggles to `Set.has()` lookups against `s.tags` — no regex on the click path.

Per-mode tag maps are stored in `tagsByCategory[mode]: Map<categoryId, string[]>`, rebuilt by `rebuildCategoryTags(mode, cats)` whenever categories load (boot, periodic refresh, `/refresh`, `/bootstrap`). Old on-disk indexes get re-tagged in `loadIndexFromDisk` so a server upgrade flows tags through without forcing a re-index.

Synthetic tag rules:
- `4k` — `\b4k\b`, `\buhd\b`, `\b2160p?\b`, `\(2160\)`
- `movies` — `\bmovies?\b`, `\bcinema\b`
- `music` — language Group regex (MTV, VH1, 9XM, B4U Music, Sangeet, etc.)
- `entertainment` — derived: NOT in any of `{movies, sports, news, kids, music}`

Three extra passes layered on top of the category-name regex (in order):

1. **Regional-default language** (`REGION_DEFAULT_LANGUAGE`). A category tagged with a country but no language gets the region's default language: `india → hindi`, `pakistan → urdu`. Applied in `categoryTagsFor` only when no language tag is already present, so "INDIAN ENGLISH MOVIES" stays English. Closes the long-standing case where "news + hindi" returned empty because "INDIAN NEWS" had no `hindi` tag.

2. **Channel-name prefix `XX:`** (`CHANNEL_NAME_PREFIX_MAP`, `CHANNEL_PREFIX_RE`). Most panel feeds prefix channel names with a 1–5-letter language/country code, either at the start (`IN: REPUBLIC BHARAT`) or after a pipe (`News | Ar: Al Jazeera`). Recognized codes: `IN → hindi+india`, `TM/Tamil → tamil+india`, `TG/TE → telugu+india`, `MAL/ML/MY → malayalam+india`, `KAND/KN → kannada+india`, `MR → marathi+india`, `GUJ/GU → gujarati+india`, `BNG/BN/BD → bengali`, `PB/PA → punjabi+india`, `URDU/UR → urdu`, `PK → urdu+pakistan`, `AR/UAE → arabic`, `USA/US → english+us`, `UKFHD/UKHD/UKSD/UK → english+uk`, `CA → english+canada`, `AU → english+australia`, `EN → english`. Language from the prefix is **authoritative**: any other `LANGUAGE_GROUP_KEYS` tag inherited from the category is stripped before the prefix's language is added. Country tags are additive.

3. **Pre-pipe genre hint** (`CHANNEL_PREPIPE_RE`). The alt convention `<genre> | <lang>: <name>` ("Sport | Ar: Abu Dhabi", "News | Ar: Al Jazeera", "Kids | En: NickToons") puts the genre word before the pipe. The pre-pipe text is run against `CHANNEL_GROUPS` so news/sports/kids/music get surfaced even when the category bucket is generic.

The client-side filter modal (`detectGroups` in `public/app.js`) walks `state.modes[mode].streams[].tags` so the bucket list it offers during onboarding reflects everything the server-side tagger surfaced — including XX:-prefix-driven buckets that the client GROUPS regex would miss. Falls back to category-name regex when the index hasn't landed yet (first-run onboarding can open before `/api/index/{mode}` resolves).

## Server-driven chip catalog (`filterConfig`)

`/api/bootstrap` includes a `filterConfig` field that is **the source of truth** for both clients' chip catalogs and kids-cert thresholds:

```
filterConfig: {
  groups: [{key, label, kind}, ...],   // kind: language | country | genre
  syntheticTags: ["4k", "movies", "entertainment"],
  nonEntertainmentTags: ["sports", "news", "kids", "music", "movies"],
  kidsCertTiers: [{minAge, add: [...]}],  // incremental tiers
}
```

Both `public/app.js` and the Android TV repo's `GroupFilters.kt` / `KidsFilter.kt` consume this. Each retains a hardcoded fallback table for **graceful degradation against an older server** — but when the server is up-to-date, those hardcoded tables are inert and adding a new language / region / genre / cert tier is a server-only change (no APK update needed). Source of truth on the server: `CHIP_LABELS` + `CHIP_KINDS` + `KIDS_CERT_TIERS` in `server.js`.

## Home filtering rules

`/api/home/{mode}` decides which categories show as rails by intersecting the user's onboarded language picks with each category's group keys. Two extra layers sit on top of that, both driven by the user's saved filter (no per-rule hardcoding):

- **Filter fallback.** `userState.filter.groups[mode]` may be empty if the user finished onboarding with picks only on Live. The home endpoint falls back to the live picks for movie / series in that case — otherwise an "english/us/kids" Live profile would see Tamil + Hindi movie rails because the per-mode list was unset. See `modeKeys` in the home endpoint.
- **Title-language guard.** Panels often dump cross-language dubs into a generic "ENGLISH MOVIES" category — e.g. `Mufasa: The Lion King (2024) [Telugu]`. Category filtering passes the rail; per-item `titleLangPasses(name)` then drops items whose title names a language NOT in the user's onboarded set. Languages to check come from `LANGUAGE_GROUP_KEYS` (next to `CHANNEL_GROUPS`), one entry per language; the gate is fully driven by `onboardedKeys` so adding a language is one line. Applied to category rails AND Continue Watching / My List / Favorites / Recents so leftover wrong-language items in those lists also stop surfacing.

The kids-cert filter (`isKidSafe` in `public/app.js`) is client-side and runs on top of all of this. Cert thresholds: G + TV-Y/G always, PG + TV-Y7/PG at age 7+, PG-13 at age 10+, TV-14 at age 13+. R / NC-17 / TV-MA never.

## Server (server.js) tour

Read this file top-to-bottom for the current shape; this is just a map.

- **Env validation** — bails on boot if `IPTV_HOST`, `IPTV_USER`, `IPTV_PASS`, `APP_USER`, `APP_PASS` are missing.
- **`PANEL_PRIMARY` / `PANEL_FALLBACK` / `PANEL`** — `PANEL` is the active host. It starts as primary and switches to fallback if `probePanel` finds the primary unhealthy. `pickPanel` runs on boot and on every refresh tick.
- **`xtream(action, params)`** — single chokepoint for every panel call. Caches in memory for `TTL_MS` (1h). Dedupes concurrent identical requests via `inflight` map (this is what keeps 100 simultaneous category opens to one upstream call).
- **`indexes`** — three live in-memory inverted indexes (`live`, `movie`, `series`). Each is a `Map<id, projected stream>` plus progress counters. Built on boot in parallel by `buildAllIndexes`. Per-mode build runs categories sequentially because the panel rate-limits parallel calls to the same action.
- **HMAC helpers (`signProxyUrl`, `verifyProxySig`)** — cheap symmetric signing.
- **`/api/proxy`** — takes a signed upstream URL, fetches it with a Smart-TV UA, strips the Referer header, and pipes the response back. For HLS manifests it rewrites every segment URI through itself with a fresh signature. For binaries it pipes via `Readable.fromWeb`. Refuses internal IPs to avoid SSRF if the URL pattern ever leaks.
- **`/api/transcode/<mode>/<id>/index.m3u8`** — spawns ffmpeg and waits up to 15s for the first segment to land in `/tmp/iptv-transcode/<mode>-<id>/`. Output is H.264 main / AAC 192k, 4-second segments, 10-segment window with `delete_segments`. Idle transcoders are reaped after 90s in a `setInterval` sweep.
- **`/api/transcode/<mode>/<id>/seg_NNN.ts`** — serves files out of the transcoder's tmp dir. No-auth (the parent `/index.m3u8` was signed; the segment paths are unguessable enough). Touches `lastAccess` on every hit.
- **Basic auth middleware** — registered AFTER the proxy/transcode routes so it doesn't gate them.
- **`express.static(public/)`** — serves the SPA assets.
- **API routes** — `bootstrap`, `account`, `streams`, `info`, `index/*`, `home/{mode}`, `search/{mode}`, `epg/short/{id}`, `poster/{mode}/{id}`, `refresh`, `panel`.
- **`/api/home/{mode}`** — server-built hero + rails for the Netflix-style home view. Tile shape includes pre-resolved TMDB poster URLs (w154 tile / w342 detail / w780 backdrop) AND the pre-computed `tags` array so the Android / web chip strip can filter without re-fetching.
- **`/api/epg/short/{streamId}`** — slices `get_simple_data_table` (the full-week panel EPG) to a 1h-back / 8h-forward window. Earlier `get_short_epg` returned 1–2 entries on many channels, which left the TV-Guide grid almost empty.
- **SPA catch-all** — `/^\/(live|movie|series)(\/.*)?$/` returns `public/index.html` so deep-link reloads work.

## Visual identity — Marquee

Single palette + typography pairing used by both clients. Inky studio blue-black (`--bg #0d1124`, `--bg-2 #161b34`) with a single warm cyc-light orange accent (`--accent #f08245`) and a brass secondary (`--accent-2 #d4a544`). Bone-cream text (`--fg #ebe7df`) on a muted slate (`--fg-dim #8a92ac`). High contrast, low fatigue, one source of warmth — the orange draws the eye to live-playing rows, active chips, expiry warnings.

Typography: **Bebas Neue** (condensed all-caps, no lowercase glyphs) for display roles — brand wordmark, hero titles, rail titles, channel names, grid titles, settings section labels. **Karla** (humanist sans, mixed case) for everything else — body text, movie/series titles on tiles, EPG programme names, chips, buttons, status hints. Both loaded from Google Fonts; references are via the `--font-display` / `--font-body` CSS variables defined in `style.css :root`, so future swaps don't require chasing every component.

No theme picker. The previous Netflix/Hulu/Disney+ switcher is gone — Marquee is the single look. The Android TV's `KhouchColors` mirrors the same palette (typography on TV remains Compose defaults for now; can be upgraded with Google Fonts downloadable APIs later).

## Frontend (public/) tour

- **`index.html`** — single page, includes `style.css`, `app.js`, hls.js (jsdelivr CDN), Cast SDK (gstatic CDN). Loads Bebas Neue + Karla from Google Fonts via the `<link>` tags near the top of `<head>`. Has the elements `app.js` reaches by id: header, search, mode buttons, sidebar, grid, player, series modal, error banner, toast, refresh button, CC button.
- **`style.css`** — all styling. CSS variables at the top for the Marquee palette + `--font-display` / `--font-body`. `[hidden] { display: none !important }` is critical because some elements use flex/grid display by default.
- **`app.js`** — the whole client. Read top-to-bottom. The shape:
  - State: `state.mode`, `state.modes[mode] = { categories, streams, byCat, activeCatId, indexReady }`, plus per-mode `favorites`/`recents`, plus `lastEpisode` and `watched` for series.
  - Bootstrap: fetch `/api/bootstrap`, set categories per mode, call `setMode`. If a deep path is present, `applyPath()` overrides afterward.
  - Polling (`pollIndex`): every 2.5s asks `/api/index/status`. When a mode flips to ready, fetches `/api/index/<mode>` once to populate `streams` and pre-fill `byCat`. Continues until all three are ready.
  - On-demand category fetches (`loadCategoryStreams`): fired by clicking a category that hasn't been loaded yet. Shares the panel's cache via the dedup map server-side.
  - Routing: `applyPath()` parses `location.pathname` into mode, browse context (`cat`/`q`/`favs`/`all`/`recent`), and action (`play`/`open`). `updateUrl()` is the inverse and is called on every state-changing action; major actions push state, restorative ones replace.
  - Player: `play(mode, item, label, forceExt, useTranscode)`. HLS uses hls.js; everything else sets `<video src>` directly. On `fragParsingError` (codec unsupported) it auto-retries with `useTranscode=true`. CC button auto-shows when subtitle tracks are detected. **hls.js is configured with `lowLatencyMode: false`** — LL-HLS mode chases the live edge with too-small buffers and breaks down on regular IPTV-panel HLS (mild PCR jitter becomes audible glitches + visible stutters; FOX News was the symptom). Standard latency mode + a 4-segment sync window plays the same feeds the vendor app handles cleanly.
  - Cast: standard Cast Web Sender setup with `DEFAULT_MEDIA_RECEIVER_APP_ID`. Cast uses the **direct panel URL** — never the proxied/signed one — because the Chromecast pulls media from the panel itself and is not subject to browser CORS.
  - Chip strips: Live mode has `_guideQuickFilter` (Set, AND across) wired into `renderGuideTabBody`; Movies/Series have `_browseQuickFilter[mode]` wired into `renderRails` (built by `renderBrowseChipStrip`). Both consume `ch.tags` / `s.tags` from the server — `channelMatchesQuickFilter` is just `tags.includes(key)` now (the regex fallback is retained for clients hitting an older server). The Live chip strip also has a special **★ Favorites** chip that filters by `state.favorites.live.has(ch.id)`.
  - Search on Live: the search input filters EPG rows in place (`renderGuideTabBody` honours `state.query`) instead of swapping the view to a poster grid. Movies / Series search still switches to the grid because there's no time-grid equivalent.
  - **Header profile chip + popup.** `#profile-chip` in the header shows the active profile (avatar + nick) and opens `#profile-popup` (built by `openProfilePopup`) with the full profile list. Click a profile → `switchProfileFromPopup` POSTs `/api/profile/select`, wipes per-profile localStorage, and `location.href = "/"`. Same wipe pattern as `profile-pick.html`. Three layers protect against profile-state leaks: (a) the picker / chip flow wipes localStorage before reload, (b) `app.js` bootstrap detects `lastBootstrappedProfile != activeProfile.id` and clears state before applying server data, (c) server-side `/api/home` filters reflect the new profile's filter immediately.
  - **"Why is this here?" badge.** `channelCard(s, opts.reason)` renders a small dim line under the title naming the rail / context that surfaced the tile ("Continue Watching", "Recently Played", category name, "Search: foo"). Card tooltip carries the full provenance (rail + category + tags). Helps debug filter rules without DevTools.

## Routing and bookmarks

URLs look like `/live/cat/234-football/play/29-mutv-hd/m3u8`. Format:

```
/<mode>(/<context>)?(/<action>)?
mode    := live | movie | series
context := cat/<id-slug> | q/<urlencoded> | favs | all | recent
action  := play/<id-slug>(/<ext>)? | open/<id-slug>   ; open is the movie/series detail modal
```

Tokens are `${id}-${slug(name)}`. Parse with `parseInt`, which stops at the first non-digit, so channel names containing dashes parse cleanly. Falls back to bare numeric id when the name has no slug-able characters.

`pushState` for major nav (mode change, category click, play, openSeries); `replaceState` for restoration and search-keystroke updates.

Grid scroll position is persisted to `sessionStorage` keyed by the **context** portion of the URL (so `play` doesn't shift it) and restored after the grid renders on hash apply. This is what makes Cmd+R put you back exactly where you were.

## Deploying

GitHub Actions builds on every push to `main` (`.github/workflows/docker-publish.yml`). The container expects a `.env` mounted via docker-compose.

On the VPS, `docker-compose.yml` sits in `/docker/iptv-webui/` next to a `.env` with the secrets. Traefik discovers via Docker labels; no Traefik config edits needed for new hosts beyond updating the `Host()` rule. Let's Encrypt issues automatically over HTTP-01.

To change panel credentials or hosts: edit `/docker/iptv-webui/.env` on the VPS and `docker compose up -d --force-recreate`. Do not put real secrets in the repo's compose file or `.env.example`; keep those generic.

## Local dev

```
npm install
node --env-file=.env server.js
```

Or just inline:

```
IPTV_HOST=http://… IPTV_USER=… IPTV_PASS=… APP_USER=admin APP_PASS=test PORT=3737 node server.js
```

The first `/api/bootstrap` is slow (the indexers scrape ~600 categories total). Subsequent requests are served from the in-memory cache. The cache TTL is 1 hour and a background refresh runs every TTL minus a minute.

Cast does not work on `localhost` because the Cast Web SDK requires HTTPS (or a registered insecure origin). To verify cast end-to-end, deploy to the VPS and use the HTTPS hostname.

## Limitations to know about

- Single-tenant transcoder. Each active stream is one ffmpeg process; the 2-vCPU VPS can comfortably do 1–2 concurrent transcodes. There's no admission control today; if you expect more users, add it.
- Search is exact substring after `toLowerCase()` and is capped at 600 results to keep the DOM cheap.
- Subtitles are *detected* and toggleable, but the transcoder doesn't currently preserve them across re-encode (the wiring is present; the ffmpeg args don't pass them through yet).
- The catch-up/EPG endpoints are not surfaced in UI.

## Working on this code

A few preferences that have come up repeatedly while building this; please honor them.

- **Don't add backwards-compat shims.** Just rename or remove things.
- **No backwards-compat comments** like "// removed X for Y". Keep history in commits, not source.
- **Use existing patterns, don't refactor while passing through.** If you're fixing a CSS bug, don't restyle a third unrelated component "while you're there."
- **Verify before reporting done.** Probe with `curl`, read the response, confirm the assertion. Don't guess.
- **Don't put real secrets in the repo.** `.env.example` only has placeholders. The VPS keeps real values in `.env` (gitignored).
- **`docker-compose.yml` in the repo is a TEMPLATE.** The VPS has its own copy with private hostnames and full Traefik labels.
- **Prefer fewer dependencies.** Frontend has no build step on purpose — every CSS/JS change is a file edit, not a rebuild.

## Common tasks (recipes)

### Add a new field surfaced in the UI

1. Make sure the panel returns the field — check `get_<mode>_streams` or `get_<mode>_info`.
2. Project it in `projectStream(mode, s)` server-side.
3. Render it in `channelCard()` or wherever appropriate.

### Add a new action / verb in the URL

1. Update `updateUrl()` to emit the new verb.
2. Update `applyPath()` to consume it.
3. Update `SCROLL_KEY_RE` if the verb shouldn't shift the scroll key.

### Switch panels

Edit `IPTV_HOST` in the VPS `.env`. Optionally set `IPTV_HOST_FALLBACK` to enable failover. `docker compose up -d --force-recreate`.

### Change transcoder quality

Tweak the ffmpeg args in `startOrTouchTranscoder`. Knobs that matter:
- `-preset` (`ultrafast`/`veryfast`/`fast`/`medium` — each step ~2× CPU)
- `-crf` (lower = better; 18–23 is sane)
- `-vf scale=` (cap input resolution)
- `-c:a` and `-b:a` (audio codec/bitrate)

### Get a new hostname routed

Add a Traefik label entry for it: `Host(\`new.example.com\`) || Host(\`existing\`)`. DNS A-record at the registrar. `docker compose up -d --force-recreate`. Let's Encrypt issues automatically.

## Debugging cheatsheet

| Symptom                                       | Likely cause                                                                 |
|-----------------------------------------------|------------------------------------------------------------------------------|
| Auth prompt loop on video click               | Old browser cache holding pre-signed-URL `app.js`. Hard refresh.             |
| `fragParsingError` from hls.js                | Source codec is MPEG-2. Should auto-fall-back to transcoder.                 |
| `fragLoadError` from hls.js                   | Panel returned empty/error for a segment. Try another channel; transient.   |
| `manifestLoadError`                           | Channel offline. Try another channel.                                        |
| Movie shows 2-second "TOS" video              | Reseller's Cloudflare account is suspended. Switch panels via fallback.     |
| Cast picker shows only audio devices          | Network discovery (mDNS) issue. Run `dns-sd -B _googlecast._tcp .` on Mac.   |
| Browser sees `94.140.14.33` for the hostname  | Local DNS is filtering (AdGuard family). Use a different DNS or own domain. |
| Empty category in sidebar                     | Indexer hasn't finished that mode yet. Wait or click the refresh button.    |
| Subtitle CC button missing                    | This stream has no subtitle tracks. Most channels don't.                    |
| Panel returns 500 for `get_live_streams`      | Panel-side issue, varies by category. Logged as `cat X failed`.             |

## Public API contract — DO NOT BREAK without updating clients first

Multiple clients depend on the `/api/*` response shapes. Breaking any
of these is a production incident, not a refactor:

- **`iptv-webui` itself** — `public/app.js` (this repo)
- **`iptv-android-companion`** — phone app (`:app-phone`) and TV app (`:app`)
- **`home-assistant-config`** — `packages/iptv.yaml` REST sensor + `lovelace/iptv-card.yaml`

The exact field names each endpoint must keep are pinned by
`tests/api-contract.test.js`. **When you add a new client integration
that reads a new field, add it to the contract test in the same PR.**
When removing a field, update every consumer first, ship that, *then*
drop the contract entry — never the other way around.

Endpoints covered today:
- `GET /api/search/:mode` → `{ q, count, results: [{ id, name, icon, category_id, category_name }] }`
- `GET /api/search/all` → `{ q, movie, series, live }` each holding `{ id, name, icon, poster, year, us_cert, container }` items
- `GET /api/stream/:mode/:id.:ext` → `{ direct, proxy, transcode, url }`
- `GET /api/home/:mode` → `{ mode, rails, hero, chips, ready }`
- `GET /api/index/:mode` → `{ total, done, ready, streams }`
- `GET /api/bootstrap` → `{ categories, profile, userState, filterConfig, account, … }`
- `GET /api/profiles` → `{ profiles }`
- `POST /api/login` → `{ ok }`
- `GET /api/epg/short/:streamId` → `{ stream_id, programs }`

The CI workflow runs `npm test` BEFORE the docker build job (see
`.github/workflows/docker-publish.yml`), so a contract regression
fails fast and the image is never pushed.

## Client/server split philosophy

**Prefer server-side logic.** The Android TV client (`iptv-android-companion`) is a thin consumer of the same `/api/*` endpoints as the web client. Any filtering, deduplication, sorting, or enrichment done only in `public/app.js` is invisible to the TV app.

Rule of thumb:
- **Filtering** (kids cert gate, language guard, dedup by TMDB ID) → server, in `/api/home` and `/api/:mode/streams`.
- **Enrichment** (us_cert, tmdb_id, tags baked into index streams) → `projectStream()` + `loadIndexFromDisk()` so both clients get the data immediately from the index without extra round-trips.
- **Rendering** (layout, animation, hero rotation, chip toggles) → client only.
- When you find yourself adding a filter or transform in `app.js`, ask: should this be in `server.js` instead so the TV app gets the same behavior for free?

## File map

```
.
├── server.js                  Express server (the whole backend)
├── public/
│   ├── index.html             SPA shell, no build step
│   ├── style.css              All UI styles
│   └── app.js                 Client logic: state, routing, player, cast
├── Dockerfile                 node:20-alpine + ffmpeg
├── docker-compose.yml         Template; the VPS has its own with private hostnames
├── .github/workflows/docker-publish.yml   CI that publishes to ghcr.io
├── .env.example               Placeholders only
├── README.md                  User-facing intro
└── CLAUDE.md                  This file
```
