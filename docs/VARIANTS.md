# Title variants (language / quality copies)

The panel lists one film or show once per audio language and quality, for example
"Dhurandhar: The Revenge (2026) (Hindi)", "... (Tamil)", "... (Telugu)", and several "(4K)"
copies filed under per-language 4K categories. The server groups those copies into one
**title** and returns one search result per title. Each result lists its copies in
`variants`, so a client can offer a "Watch in" picker.

Code: `lib/variants.js` (pure, tested in `tests/variants.test.js`), wired in `server.js`
(`variantIndexFor`, `/api/search/:mode`, `/api/search/all`, `/api/variants/:mode/:id`).
Home rails are not changed. They still use `assignVariants` / `makeVariantHider`.

## Grouping

- Movies and series both group by **TMDB id** (series copies in different languages are separate
  series ids. Each copy keeps its own seasons).
- TMDB matches are checked against the title. Inside one TMDB id, a copy stays only when its panel
  title equals the TMDB title or the group's most common panel title. A wrong match such as
  "Ash (2025)" cached as *Avatar: Fire and Ash* splits off. A panel year more than one year off
  TMDB's also splits off.
- Copies without a usable TMDB match group by normalized title + year (`dedupTitleKey`). When
  exactly one TMDB group has that title + year, they join it.
- The index is precomputed per catalog index and `catalogGen` (about 0.5 s for 66k movies, and it
  runs off the request path after a reindex). A stale build keeps serving for up to 60 s while
  `catalogGen` changes, then rebuilds in the background.

## Language of a copy

| Source | Example | Result |
|---|---|---|
| Title says so | `(Hindi)`, `(Teugu)`, `[Tel,Tam,Hin]` | `lang` = `hi` / `te` / `multi` (definite) |
| Category name names one language | `TAMIL \| 2026 4K`, `HINDI DUBBED`, multi-audio category | `lang` definite |
| Otherwise | `INDIAN 2026 4K` | `lang: null`, `langName: null`, `langGuess` = the stream's language tag (region default, e.g. INDIAN -> hi), else TMDB `original_language`. Clients must show this as "likely Hindi", never as Hindi. |

`multi` = a multi-audio bundle (`langName` "Multi-audio").

## Primary and order

Primary = the copy the tile shows and plays by default:
1. Original language (TMDB `original_language`). This applies when the profile has no language
   chips or includes that language; otherwise the profile's own languages come first.
2. Copies with a definite language before copies with a guessed one.
3. Best quality: `4K` > `FHD` > `HD` > unknown > `SD`.
4. CAM / pre-retail copies (`lowQuality`) are primary only when nothing else is left.

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

## Search tiles: `/api/search/:mode` (TV) and `/api/search/all` (web, phone)

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

Behaviour change: `/api/search/all` used to return an onboarded language's dub as its own tile
next to the bare title ("Kohrra" + "Kohrra (Hindi)"). It now returns one tile, and the dub is in
`variants`.

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

- Same grouping, filters and order as search. The requested copy is always listed, even when the
  profile's language filters would hide it.
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
