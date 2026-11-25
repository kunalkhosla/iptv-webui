# Title-logo art: server contract

Netflix-style title treatment: the film's own transparent-PNG logo, shown
instead of the plain-text title on hero/detail screens.

- Source: TMDB `images.logos`, fetched with the normal detail call
  (`append_to_response=...,images` + `include_image_language=en,null`), so no
  extra request per title.
- Selection (`lib/title-logos.js` `pickLogo`): PNG only, width >= 150; English
  first, then language-null; then highest `vote_average`, then width.
- Stored on the TMDB cache entry as `logo` (just the file_path string, e.g.
  `"/abc123.png"`; `null` = checked, none available; key absent = not yet looked up).
- Backfill: `backfillLogos` fetches `/{movie|tv}/{id}/images` for library titles
  whose entry has no `logo` key, 300 ms apart, max 300 titles per run, 8 min after
  boot then every 3 h. Owner can trigger `POST /api/admin/backfill-logos`.

## API (additive; clients ignore unknown fields)

- `GET /api/poster/:mode/:id` -> `logo`: `"https://image.tmdb.org/t/p/w500<file_path>"` or `null`.
- `GET /api/home/:mode` -> each `hero[]` item gets `logo` (same URL or `null`).
  Rail tiles do not carry it.

Logos are often white or black lettering with transparency; clients should show
them on a scrim/dark area and fall back to the text title when `logo` is null.
