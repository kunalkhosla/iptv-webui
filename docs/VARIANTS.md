# Title variants (language / quality copies)

The panel lists one film or show once per audio language and quality, for example
"Dhurandhar: The Revenge (2026) (Hindi)", "... (Tamil)", "... (Telugu)", and several "(4K)"
copies filed under per-language 4K categories. The server groups those copies into one
**title**. Grouped search returns one result per title, and each result lists its copies in
`variants`, so a client can offer a "Watch in" picker.

| Route | Grouped? | Client |
|---|---|---|
| `GET /api/search/:mode` | yes, always (movie/series) | Android TV (picker being built) |
| `GET /api/search/all` | only with `?group=1` | Phone sends `group=1` once its picker ships. Web stays ungrouped |
| `GET /api/variants/:mode/:id` | n/a | detail-screen picker |

Without `group=1`, `/api/search/all` is unchanged: an onboarded language's dub keeps its own
tile next to the bare title (decision 2026-08-09), and there are no variant fields.

Code: `lib/variants.js` (pure, tested in `tests/variants.test.js`), wired in `server.js`
(`variantIndexFor`, `/api/search/:mode`, `/api/search/all`, `/api/variants/:mode/:id`).
Home rails are not changed. They still use `assignVariants` / `makeVariantHider`.

## Grouping

- Movies and series both group by **TMDB id** (series copies in different languages are separate
  series ids. Each copy keeps its own seasons).
- TMDB matches are checked against the title. Inside one TMDB id:
  - if some copies' panel title equals the TMDB title, only those stay. Subtitle forms also stay
    when the year is the SAME as TMDB's: the panel title equals the TMDB title's part before `:`
    ("Stree 2 (2024)" for *Stree 2: Sarkate Ka Aatank*), or the panel's part before `:` equals
    the TMDB title. "Dhurandhar (2025)" vs *Dhurandhar: The Revenge* (2026) stays split, and so
    does "Blink" vs *Blink Twice*, which has no colon;
  - otherwise the most common panel title stays (ties break on the title text, so iteration order
    doesn't matter).
  - Everything else splits off and groups by its own title + year. Examples: "Ash (2025)" cached as
    *Avatar: Fire and Ash*, "Dhurandhar (2025)" cached as its 2026 sequel, "Blink (2024)" cached
    as *Blink Twice*.
  - Year check, using the release year written as `(YYYY)` in the panel name. A bare
    "Reply 1988" is part of the name, not a year.
    - A copy with TMDB's year stays. When no copy has TMDB's year, the copies' most common year is
      the reference instead.
    - One year off stays only when the title text is the TMDB title or a title already present
      with the reference year. More than one year off never joins.
    - A copy with **no** year never joins a group that has dated copies. The one exception is when
      exactly one dated copy stays, the bare copy's title equals the TMDB title, it names its
      language ("Dil Se.. (Hindi)") and its category is not a dubbed one. Example: "Dil Se" (no
      year, SOUTH INDIAN | HINDI DUBBED) was matched to *Dil Se..* (1998) by title alone, but it is
      a different film and now stays a separate tile.
    - Movies: an undated copy in a `*DUBBED*` category always stays alone.
    - Groups where no copy has a year (most series) are not affected.
- Copies without a usable TMDB match group by normalized title + year (`dedupTitleKey`). When the
  key has a year and exactly one TMDB group has that title + year, they join it.
- Builds never happen in a request:
  - The index is built in the background after each index load (`assignVariants`), only once
    `ix.ready`. A build takes about 1 s cold or 0.25 s warm (memoized) for 66k movies.
  - While `catalogGen` changes (TMDB backfill), the previous build keeps serving and a rebuild runs
    at most every 2 minutes.
  - With no build yet, search serves ungrouped results and `/api/variants` returns the copy alone.
  - Streams added since the last build group on their own until the next one.

## Language of a copy

| Source | Example | Result |
|---|---|---|
| Title says so | `(Hindi)`, `(Teugu)`, or 2+ languages in one bracket: `[Tel,Tam,Hin]`, `(Hindi, English)`, `(Multi Languages)` | `lang` = `hi` / `te` / `multi` (definite) |
| Category name names one language (or `MYANMAR`/`BURMA` -> Burmese `my`) | `TAMIL \| 2026 4K`, `HINDI DUBBED`, multi-audio category. Subtitle categories (`SUB`, `SUBS`, `SUBTITLED`) never count | `lang` definite |
| Otherwise | `INDIAN 2026 4K` | `lang: null`, `langName: null`, `langGuess` = TMDB `original_language`, else the stream's region-default tag (INDIAN -> hi). Clients must show this as "likely Hindi", never as Hindi. |

`multi` = a multi-audio bundle (`langName` "Multi-audio").

## Primary and order

Primary = the copy the tile shows and plays by default:
1. A language word in the query (`/api/search/all` facet, e.g. "hindi action") comes first.
2. Next, the original language (TMDB `original_language`). This applies when the profile has no
   language chips or includes that language; otherwise the profile's own languages come first.
3. Within the top language bucket, a copy this profile already started (saved progress or recents)
   comes first. Search then reopens the copy with the resume point, e.g. the 4K started from home,
   even when a definite-language copy exists, and even if the started copy is a CAM copy.
4. Within one language:
   - copies with a definite language before copies with a guessed one;
   - more episodes first (hook only: series episode counts are not in the index, so this is
     inactive today);
   - the home rails' canonical copy (`assignVariants`) before others, so home and search show the
     same id;
   - best quality: `4K` > `FHD` > `HD` > unknown > `SD`.
5. CAM / pre-retail copies (`lowQuality`: the `cam` tag or `isLowQuality`, the same test as
   `assignVariants`) are primary only when nothing else is left.

Quality: `4K` only from the stream's `4k` tag, which the resolution probe already demotes
(`applyQualityDemotion`). A probed resolution (`quality-cache.json`) overrides title/category text.

Home vs search ids: progress is keyed `mode:id` per copy, and Continue Watching shows the exact id
that was played. Favourites are resolved to the profile's chosen copy on home. With nothing started,
home and search can differ when home's canonical has only a guessed language. Dhurandhar is the
example: home shows 796884 (INDIAN 4K, which `assignVariants` treats as Hindi), while search shows
729968, the definite Hindi copy. Once the profile has started 796884, search also shows 796884
with its resume point.

`variants` order: the primary first, then the original language, then the profile's onboarded
languages (in their order), then Hindi, then English, then the other languages, then `multi`.
Within one language: non-CAM, definite, then best quality first.

## Filters (per request)

- Kid profiles: every copy must pass the kid cert gate (`makeKidsBlocker`, strict: no cert =
  blocked). A blocked copy is never listed or counted, so a kid never learns it exists.
- Title-language guard (`makeTitleLangFilter`): copies whose name has a non-onboarded language word
  are dropped. `/api/search/all` also drops explicit `(Language)` suffixes outside the profile's
  languages, as before.
- Profile language chips: copies whose language is **known** and not in the profile's onboarded
  languages are dropped, unless that would drop the whole title. Unknown and `multi` copies stay.

## Search tiles: `/api/search/:mode` (TV) and `/api/search/all?group=1`

Movie/series results: **one tile per title**. Every existing field is unchanged and describes the
primary copy (`id`, `name`, `poster`, `dubLang`, ...). These fields are added:

| Field | Type | Meaning |
|---|---|---|
| `lang` | string \| null | ISO code of the primary copy when known (`hi`, `ta`, `multi`, ...) |
| `langName` | string \| null | Full name, e.g. `"Hindi"`. Null when not known for sure |
| `langGuess` | string \| null | Likely ISO code when `lang` is null |
| `langGuessName` | string \| null | Its full name (`"Hindi"`), to show as "likely Hindi" |
| `quality` | `"4K"` \| `"FHD"` \| `"HD"` \| `"SD"` \| null | Primary copy's quality |
| `variantCount` | int | Number of entries in `variants` (1 = no picker) |
| `variants` | array | Every copy this profile may see, primary first (below) |

Live and disk results are unchanged (no variant fields).

Language keys: `/api/search/:mode` and `/api/variants` use the mode's chips, else movie, else
live (`profileModeKeys`). `/api/search/all` uses the movie chips, else live.

## `variants[]` entry

```json
{
  "id": 796884,
  "lang": null,
  "langName": null,
  "langGuess": "hi",
  "langGuessName": "Hindi",
  "quality": "4K",
  "lowQuality": false,
  "name": "Dhurandhar: The Revenge (2026)(4K)",
  "isPrimary": false
}
```

Exactly one entry has `isPrimary: true` (the first one). `id` is a normal stream id for the same
mode: play it, open its detail page, and so on. When `lang` is set, `langGuess` is null.

## `GET /api/variants/:mode/:id` (detail "Watch in" picker)

`mode` = `movie` | `series`. `id` = any copy's id.

```json
{
  "mode": "movie",
  "id": 729973,
  "tmdb_id": 1582770,
  "originalLanguage": "hi",
  "primaryId": 729968,
  "variantCount": 9,
  "variants": [ /* same entries as above */ ]
}
```

- Same grouping, filters, language keys and order as `/api/search/:mode`. The requested copy is
  always listed, even when the profile's language filters would hide it.
- Before the first background build, the response lists only the requested copy.
- `404 {"error":"not_found"}` when the id is not in the catalog.
- Kid profile + requested copy not kid-safe: `200` with `variants: []`, `variantCount: 0` and null
  `tmdb_id` / `originalLanguage` / `primaryId`. Show no picker.

## Example (live catalog, profile with Hindi + Tamil/Telugu/Malayalam/Kannada)

Search `dhur` -> the tile for 729968 "Dhurandhar: The Revenge (2026) (Hindi)", `langName: "Hindi"`,
`quality: "FHD"`, `variantCount: 9`:

| id | lang | langName / guess | quality |
|---|---|---|---|
| 729968 (primary) | hi | Hindi | FHD |
| 796884 | null | likely Hindi | 4K |
| 787206 | ta | Tamil | 4K |
| 729973 | ta | Tamil | - |
| 787663 | te | Telugu | 4K |
| 729974 | te | Telugu | - |
| 787791 | ml | Malayalam | 4K |
| 729970 | ml | Malayalam | - |
| 729969 | kn | Kannada | - |

A Hindi/English/Punjabi profile gets the same tile with `variantCount: 2` (729968, 796884). A kid
profile gets no tile, because the title is NR.
