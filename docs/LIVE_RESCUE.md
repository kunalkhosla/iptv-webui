# Live buffering rescue

When a live channel keeps buffering, the client switches to another copy of the
same channel (the panel often carries several: `IN: ZEE TV HD`, `IN: ZEE TV (FHD)`,
`IN: ZEETV (4K).`). The account allows one stream, so the switch is always
stop-then-tune. Nothing here probes the panel: copies are ranked from what real
viewing reported.

## Server

`lib/live-rescue.js` (pure logic + tests in `tests/live-rescue.test.js`).

- **Copies**: same region prefix (`IN`, `UK`, ...; aliases `UKHD/UKFHD/UKSD/GB=UK`,
  `USA=US`, `TM=TAMIL`, `KAND/KN=KANNADA`, `MAL/ML=MALAYALAM`, `TG/TE=TELUGU`,
  `MR=MARATHI`, `GUJ/GU=GUJARATI`, `PB/PA=PUNJABI`) and the same name once quality
  words (HD, FHD, 4K, SD, HEVC, 1080p, ...) and punctuation are dropped. Names
  without a prefix only match inside their own panel category. `+1` feeds stay
  separate.
- **Health**: `data/live-health.json`, per copy, 24 hour-of-day buckets of
  decayed sums (half-life 14 days): sessions, watched seconds, stalls, stall
  seconds, reconnects, time to first frame, failed starts. The score (0-100)
  uses the current hour and its neighbours (falling back to the whole day) and
  is blended toward a neutral 65 by confidence (20 min watched or 4 sessions =
  full confidence).
- **Ranking**: excludes the current copy, copies with a dead verdict inside its
  TTL (the `/api/stream` liveness cache), and anything under the floor (55).
  Lighter copies get +6, heavier -12, a stale dead verdict -15.

### `POST /api/live/health/:id`

```json
{ "ttffMs": 2300, "stalls": 2, "stallMs": 9000, "reconnects": 1, "watchedMs": 600000, "failed": false, "reason": "stalls" }
```

One per session (a copy played until stop, zap, rescue, exit or background).
`ttffMs` is play request to first frame (null if none); `stalls` counts
rebuffers after the first frame (a user pause is not a stall); `failed` means
no frame was ever shown. Values are clamped; empty reports are ignored; 30
reports a minute per client.

### `GET /api/live/alternates/:id[?reason=...]`

```json
{ "id": 220, "name": "IN: ZEE TV FHD", "score": 65, "floor": 55,
  "alternates": [ { "id": 161, "name": "IN: ZEE TV HD", "quality": "HD", "score": 72.5, "confidence": 0.4, "measured": true } ] }
```

Best first. An empty list means there is nothing safe to switch to.

Logs: `[rescue] health ...`, `[rescue] alternates ...` (with `reason`).

## Clients (phone, web, TV: same numbers)

- Struggling = 2 stalls starting within 90 s, or one stall lasting 7 s, or 2
  reconnects within 180 s, or no first frame 15 s after the play request. Stall
  rules start after the first frame.
- At most 2 automatic switches per 10 minutes. Then: report the current
  session, stop it, play `alternates[0]`, toast "Switched to <copy> (OK to
  undo, 10 s)". OK within 10 s goes back to the original copy and turns
  automatic switching off for that channel for 10 minutes.

## Catch-up flags

Live index streams carry `tv_archive` and `tv_archive_duration` (0 on this
provider today), so the cache shows it if the provider ever enables archive.
