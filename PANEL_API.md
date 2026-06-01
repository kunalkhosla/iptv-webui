# Xtream Codes panel API — what this panel actually serves

Inventory of the upstream IPTV panel's HTTP surface, probed live and
classified by usefulness to this project. Paths use `${PANEL}` for the
base URL and `${USER}` / `${PASS}` for the embedded credentials.

There is no official Xtream Codes spec; this is what *this* panel
(an XUI.one-family fork) exposes today. Other panels in the same
family will have ~95% overlap.

All requests must send `User-Agent: Mozilla/5.0 (Linux; Android 12;
Smart TV) AppleWebKit/537.36`. The panel returns HTTP 500 / empty
body for "browser-looking" UAs.

## Live (used)

| Method+Path | Returns | Notes |
| --- | --- | --- |
| `GET ${PANEL}/player_api.php?username=${USER}&password=${PASS}` | `{user_info, server_info}` | No `action` → auth/health probe. `user_info` has `exp_date` (Unix), `active_cons`, `max_connections`, `allowed_output_formats: ["m3u8","ts"]`. |
| `GET …&action=get_live_categories` | `[{category_id, category_name, parent_id}]` | |
| `GET …&action=get_live_streams[&category_id=N]` | `[{stream_id, name, stream_icon, epg_channel_id, added, category_id, tv_archive, tv_archive_duration, ...}]` | `tv_archive=0` for every channel on this account → no catch-up. |
| `GET …&action=get_short_epg&stream_id=N[&limit=M]` | `{epg_listings: [{title, description, start, end, ...}]}` | `title` + `description` are **base64**. Most channels return 0–2 entries. |
| `GET …&action=get_simple_data_table&stream_id=N` | `{epg_listings: [...]}` | Full-week EPG for one channel. Larger payload (~70KB). Same base64 fields. Has `has_archive: 0/1` per programme (always 0 here). |

## VOD / movies (used)

| Method+Path | Returns | Notes |
| --- | --- | --- |
| `GET …&action=get_vod_categories` | `[{category_id, category_name, parent_id}]` | |
| `GET …&action=get_vod_streams[&category_id=N]` | `[{stream_id, name, stream_icon, rating, rating_5based, added, category_id, container_extension, ...}]` | |
| `GET …&action=get_vod_info&vod_id=N` | `{info: {tmdb_id, name, description, plot, cover_big, backdrop_path[], releasedate, mpaa_rating, duration, video, audio, ...}, movie_data: {...}}` | **`info.tmdb_id` is populated by the panel** — skip the TMDB title-search step when present. Full ffprobe video/audio blocks available. |

## Series (used)

| Method+Path | Returns | Notes |
| --- | --- | --- |
| `GET …&action=get_series_categories` | `[{category_id, category_name, parent_id}]` | |
| `GET …&action=get_series[&category_id=N]` | `[{series_id, name, cover, plot, cast, director, genre, releaseDate, last_modified, rating, backdrop_path[], youtube_trailer, ...}]` | |
| `GET …&action=get_series_info&series_id=N` | `{seasons[], info{...}, episodes: { "<season#>": [{id, episode_num, title, container_extension, info: {tmdb_id, duration_secs, video, audio, ...}, subtitles[], ...}] }}` | Per-episode `info.tmdb_id` populated. **`subtitles[]` is exposed** — not yet plumbed through the transcoder. |

## Stream URLs (constructed, not via API)

```
${PANEL}/live/${USER}/${PASS}/<stream_id>.m3u8     # HLS
${PANEL}/live/${USER}/${PASS}/<stream_id>.ts       # MPEG-TS
${PANEL}/movie/${USER}/${PASS}/<vod_id>.<ext>      # ext from container_extension
${PANEL}/series/${USER}/${PASS}/<episode_id>.<ext> # ext from container_extension
${PANEL}/timeshift/${USER}/${PASS}/<duration_min>/YYYY-MM-DD:HH-MM/<stream_id>.ts
```

`timeshift/...` redirects to the Cloudflare TOS placeholder on this panel
— this account does not have catch-up provisioned (matches the
`tv_archive: 0` flag on every live stream).

## Bulk export (not currently consumed — opportunities)

| Method+Path | Returns | Notes |
| --- | --- | --- |
| `GET ${PANEL}/xmltv.php?username=${USER}&password=${PASS}` | XMLTV 1.0 document, `application/octet-stream`, streamed | **Entire panel EPG in one fetch.** Replaces ~1,800 per-channel `get_simple_data_table` calls. Server identifies as `generator-info-name="Sersi.GA"`. No gzip; HEAD returns CL=0 because Cloudflare doesn't run the generator for HEAD — always use GET. |
| `GET ${PANEL}/get.php?username=${USER}&password=${PASS}&type=m3u_plus&output=ts` | M3U playlist (UTF-8, CRLF) | All live + movies + series in one file. `#EXTINF -1 tvg-id tvg-name tvg-logo group-title,name` then a direct stream URL. Useful as a bulk-import seed; lacks category structure. |
| `GET ${PANEL}/get.php?username=${USER}&password=${PASS}&type=m3u_plus&output=hls` | Same as above with `.m3u8` URLs for live | |
| `GET ${PANEL}/get.php?username=${USER}&password=${PASS}&type=m3u` | Legacy M3U | No extended tags — just `#EXTINF:-1,name`. |

## Confirmed absent on this panel

Unknown `action=` values silently return the base `{user_info,
server_info}` payload — these were all classified that way:

- `action=get_account_info`, `action=get_credentials`, `action=get_status`,
  `action=get_user`, `action=get_user_info`, `action=get_settings`,
  `action=get_panel_info`, `action=get_server_info` — no admin/account endpoints
- `action=get_recordings`, `action=create_user` — no PVR / user-mgmt
- `GET ${PANEL}/panel_api.php` → HTTP 404
- `GET ${PANEL}/enigma.php` → HTTP 404
- `GET ${PANEL}/get.php?type=enigma2` → HTTP 404 on GET (HEAD lies and returns 200)
- `GET ${PANEL}/streaming/timeshift.php` → HTTP 403

## Operational notes

- The panel returns HTTP 500 + empty body under burst load even for valid
  actions. Re-test with a small delay before classifying as "broken."
- Set `User-Agent` to the Smart-TV string above. "Browser-looking" UAs
  get empty bodies on the auth endpoint.
- If `IPTV_HOST_FALLBACK` is configured, it tends to be more reliable
  than the primary host; cross-check both before reporting an action
  as missing.
- All payloads are JSON unless noted; ETag is not surfaced — use the
  in-process 1h cache (`xtream()` in `server.js`) to amortize.

## What this enables (status)

1. **`xmltv.php` EPG indexer** — ✅ **Done.** `prewarmEpg()` fetches
   once on boot (if cache stale) and nightly at 3 AM local;
   `/api/epg/short` slices `epgIndex` first, falls back to per-channel
   `get_simple_data_table`. See "XMLTV bulk EPG indexer" in CLAUDE.md.
2. **TMDB shortcut via `info.tmdb_id`** — ✅ **Done.**
   `ensureTmdbForItem` skips title search when a panel-supplied
   `tmdbId` is provided; the `/api/{mode}/info/{id}` endpoint seeds
   the cache opportunistically.
3. **Expiry surfacing** — ✅ **Done.** `state.account.user_info.exp_date`
   rendered in web Settings as "panel expires in N days" (red
   within 14 days of expiry).
4. **`allowed_output_formats` honoring** — ✅ **Done.** `streamUrl()`
   falls back live `.ts` → `.m3u8` when the panel hasn't whitelisted
   TS.
5. **Subtitle pass-through** — Probed but **`subtitles[]` is unpopulated
   on this account** across 30 categories sampled. Skipping for now;
   re-evaluate if a different panel ever surfaces subtitle URLs.

Dead ends (don't build for these): catch-up TV (`tv_archive: 0`
everywhere), PVR, account self-service, Enigma2 export.
