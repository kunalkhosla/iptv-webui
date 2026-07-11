// Claude API helpers — the only place in the codebase that talks to
// the Anthropic API. Jobs, all nightly/weekly batch except the search
// translator:
//
//   1. buildTasteProfile() — per profile: turn watch history into a
//      one-line taste summary + a ranked pick list WITH per-pick
//      rationales ("For You" rail in /api/home).
//   2. buildEditorialRails() — weekly, household: propose a handful of
//      themed rails ("Heist Night", "90s Bollywood") grounded in the
//      catalog the model is shown.
//   3. buildTonightDigest() — nightly, household: curate tonight's most
//      watchable live programmes (from the EPG) + a one-line summary.
//   4. normalizeEpgTitles() — batch: clean messy xmltv programme titles
//      into {clean, type, keywords} for reliable live keyword matching.
//   5. translateSearchQuery() — on demand: turn a conversational search
//      query ("something funny for the kids") into the same facet shape
//      /api/search/all's faceted matcher already executes ({genre, lang,
//      year, decadeStart, name}). Hot-ish path, so it carries a short
//      timeout and the caller caches translations.
//
// Every one degrades to null on ANY failure (no key, timeout, bad JSON,
// API error) — the callers treat null as "feature absent", same
// pattern as the TMDB enrichment. Never throw across this boundary.

const Anthropic = require("@anthropic-ai/sdk");

// Haiku keeps the nightly batch + per-query translation at pennies/
// month. Overridable so a smarter model can be A/B'd from .env
// without a deploy.
const AI_MODEL = process.env.AI_MODEL || "claude-haiku-4-5";

function aiEnabled() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client = null;
function client() {
  if (!_client) _client = new Anthropic({ maxRetries: 1 });
  return _client;
}

// Pull the first text block and parse it as JSON. With
// output_config.format the API guarantees the first text block is
// valid JSON matching the schema — the try/catch is for refusals /
// truncation, where we degrade to null rather than surface an error.
function parseJsonResponse(response) {
  try {
    const text = response.content.find((b) => b.type === "text")?.text;
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ── NL search translation ────────────────────────────────────────────
// Must stay in lockstep with the facet vocabulary in server.js's
// /api/search/all (KNOWN_GENRES / LANG_ALIASES). The output is fed
// straight into the same matcher the hand-typed facets use.
const SEARCH_GENRES = [
  "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
  "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
  "Romance", "Science Fiction", "Thriller", "War", "Western",
];
const SEARCH_LANGS = [
  "hi", "en", "ta", "te", "kn", "ml", "mr", "gu", "pa", "bn", "ur", "ar",
  "es", "fr", "de", "it", "pt", "ja", "ko", "zh", "ru", "tr",
];

const TRANSLATE_SCHEMA = {
  type: "object",
  properties: {
    genre: { anyOf: [{ type: "string", enum: SEARCH_GENRES }, { type: "null" }] },
    lang: { anyOf: [{ type: "string", enum: SEARCH_LANGS }, { type: "null" }] },
    year: { anyOf: [{ type: "string" }, { type: "null" }] },
    decadeStart: { anyOf: [{ type: "integer" }, { type: "null" }] },
    name: { anyOf: [{ type: "string" }, { type: "null" }] },
    kidsSafe: { type: "boolean" },
  },
  required: ["genre", "lang", "year", "decadeStart", "name", "kidsSafe"],
  additionalProperties: false,
};

const TRANSLATE_SYSTEM = `You translate natural-language TV/movie search queries into structured filters for an IPTV catalog search.

Rules:
- genre: the single best-matching genre from the allowed list, or null. Map informal terms ("funny" → Comedy, "scary" → Horror, "space stuff" → Science Fiction).
- lang: ISO 639-1 code when the query names or strongly implies a language/industry ("bollywood" → hi, "korean drama" → ko), else null.
- year: a specific 4-digit year mentioned, else null.
- decadeStart: 4-digit decade start when a decade is meant ("90s movies" → 1990), else null.
- name: the residual title / actor / director words ONLY — strip filler ("something", "movies", "to watch", "for the kids"). EXPAND well-known abbreviations, initialisms, and nicknames of actors, directors, and franchises to their canonical searchable names ("srk" → "shah rukh khan", "big b" → "amitabh bachchan", "dicaprio" → "leonardo dicaprio", "mcu" → "marvel"). Null when nothing remains.
- kidsSafe: true when the query asks for children/family-appropriate content.
Do not invent facets the query doesn't imply.`;

// Translate a conversational query into search facets. Returns the
// facet object or null. Hard 10s ceiling — no retries — so a dead or
// slow API can't stack attempts and hang the search endpoint (the
// caller falls back to the substring results it already computed).
// The schema warm-up path overrides the request options; nothing else
// should.
async function translateSearchQuery(q, reqOpts = { timeout: 10_000, maxRetries: 0 }) {
  if (!aiEnabled()) return null;
  try {
    const response = await client().messages.create(
      {
        model: AI_MODEL,
        max_tokens: 300,
        system: TRANSLATE_SYSTEM,
        output_config: { format: { type: "json_schema", schema: TRANSLATE_SCHEMA } },
        messages: [{ role: "user", content: `Query: ${q}` }],
      },
      reqOpts,
    );
    if (response.stop_reason === "refusal") return null;
    const out = parseJsonResponse(response);
    if (!out) return null;
    // Belt-and-suspenders: the schema enums should guarantee these,
    // but the matcher downstream trusts the values, so re-check.
    if (out.genre && !SEARCH_GENRES.includes(out.genre)) out.genre = null;
    if (out.lang && !SEARCH_LANGS.includes(out.lang)) out.lang = null;
    if (out.year && !/^(19|20)\d{2}$/.test(out.year)) out.year = null;
    // Must be a 4-digit decade start (1990, not 90) — the matcher does
    // [start, start+10) range math on it.
    if (out.decadeStart && !/^(19|20)\d0$/.test(String(out.decadeStart))) out.decadeStart = null;
    if (out.name) out.name = String(out.name).toLowerCase().trim() || null;
    return out;
  } catch {
    return null;
  }
}

// Throwaway translation with a generous timeout to (re)compile the
// structured-output schema server-side (the API caches compiled
// schemas ~24h; the first request after expiry pays a compile cost
// the search path's 10s no-retry ceiling can't survive — this call
// can). Returns elapsed ms on success, null on failure, so the caller
// can log whether the warm leg actually works in prod.
async function warmSchemaCache() {
  const started = Date.now();
  const r = await translateSearchQuery("warm up the schema cache", { timeout: 60_000, maxRetries: 1 });
  return r ? Date.now() - started : null;
}

// ── Assistant (/api/assistant) ───────────────────────────────────────
// The conversational endpoint runs on a stronger model than the batch
// jobs — it reasons over tool results live while someone waits on a
// TV or speaker.
const AI_ASSISTANT_MODEL = process.env.AI_ASSISTANT_MODEL || "claude-opus-4-8";

// One raw Messages turn for the assistant's tool-use loop. The loop
// and the tool executors live in server.js, next to the state they
// read. Unlike everything else in this module this THROWS on failure:
// the loop must distinguish "model wants tools" from "API is down",
// and it owns the try/catch that degrades to an apology reply.
async function assistantTurn({ system, messages, tools }) {
  return client().messages.create(
    {
      model: AI_ASSISTANT_MODEL,
      max_tokens: 1000,
      system,
      tools,
      messages,
    },
    { timeout: 30_000, maxRetries: 1 },
  );
}

// ── Taste profile ────────────────────────────────────────────────────

// picks carry an id + a one-line rationale. id accepts strings too —
// some panels ship string stream_ids, and the id must round-trip
// through the model unchanged.
const TASTE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { anyOf: [{ type: "integer" }, { type: "string" }] },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "picks"],
  additionalProperties: false,
};

const TASTE_SYSTEM = `You are the recommendation engine for a household IPTV app. Given a viewer's watch history and a numbered candidate pool from the catalog, produce:
- summary: one sentence describing the viewer's taste (genres, languages, eras, tone). Written for the household owner, not the viewer.
- picks: the candidates the viewer is most likely to enjoy next, best first, up to 40. Each pick is {id, reason}. id: only ids from the candidate pool; skip anything they already watched; favor variety across their taste clusters over 40 near-duplicates. reason: a short viewer-facing phrase (≤ 70 chars) for why THIS pick fits, tied to their history — e.g. "Because you loved Shah Rukh Khan dramas", "More 90s action like you watch". No trailing period.

If a "Disliked" list is given, treat it as strong negative signal: never pick anything close to those titles in genre, tone, franchise, or language, even if it is popular.`;

// Build a taste profile for one viewer. `signal` is what they watched
// / favorited (title + metadata strings); `candidates` is the
// pre-filtered pool [{id, line}] the picks must come from (already
// kid-cert gated by the caller — this function never sees anything
// the profile shouldn't). Returns {summary, picks:[id], reasons:{[id]:
// reason}} or null. `picks` keeps the id-array shape callers expect;
// `reasons` is a side map so a caller wanting only ids ignores it.
async function buildTasteProfile({ profileName, signal, disliked, candidates } = {}) {
  if (!aiEnabled()) return null;
  const sig = Array.isArray(signal) ? signal : [];
  const dis = Array.isArray(disliked) ? disliked : [];
  if (!sig.length && !dis.length) return null;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  try {
    // Keyed by String(id) so a model echo of "123" maps back onto a
    // numeric candidate id 123 (and vice versa) — the persisted pick
    // keeps the candidate's original id type for index lookups.
    const candidateById = new Map(candidates.map((c) => [String(c.id), c.id]));
    const user = [
      `Viewer: ${profileName}`,
      "",
      "Watch history and favorites (most recent first):",
      ...sig.map((s) => `- ${s}`),
      ...(dis.length ? [
        "",
        "Disliked — do NOT recommend anything similar:",
        ...dis.map((s) => `- ${s}`),
      ] : []),
      "",
      "Candidate pool:",
      ...candidates.map((c) => `${c.id}: ${c.line}`),
    ].join("\n");
    const response = await client().messages.create(
      {
        model: AI_MODEL,
        max_tokens: 2000,
        system: TASTE_SYSTEM,
        output_config: { format: { type: "json_schema", schema: TASTE_SCHEMA } },
        messages: [{ role: "user", content: user }],
      },
      { timeout: 120_000 },
    );
    if (response.stop_reason === "refusal") return null;
    const out = parseJsonResponse(response);
    if (!out || !Array.isArray(out.picks)) return null;
    // The model can only pick from the pool it was shown — drop
    // anything else (hallucinated or duplicated ids) before it can
    // reach a rail. Carry each pick's rationale across in a side map
    // keyed by the pool's original id.
    const seen = new Set();
    const picks = [];
    const reasons = {};
    for (const p of out.picks) {
      const id = candidateById.get(String(p?.id));
      if (id === undefined) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(id);
      const reason = String(p?.reason || "").trim().slice(0, 80);
      if (reason) reasons[key] = reason;
      if (picks.length >= 40) break;
    }
    if (!picks.length) return null;
    return {
      summary: String(out.summary || "").slice(0, 300),
      picks,
      reasons,
    };
  } catch {
    return null;
  }
}

// ── Editorial rails ──────────────────────────────────────────────────
// Weekly, household-level: propose a few themed rails from the catalog
// sample. The model picks ids ONLY from the pool it is shown; the caller
// re-gates every id per viewing profile at render time, so this pool is
// household-broad (owner cert), never kid-scoped.
const EDITORIAL_SCHEMA = {
  type: "object",
  properties: {
    rails: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          blurb: { type: "string" },
          picks: { type: "array", items: { anyOf: [{ type: "integer" }, { type: "string" }] } },
        },
        required: ["title", "blurb", "picks"],
        additionalProperties: false,
      },
    },
  },
  required: ["rails"],
  additionalProperties: false,
};

const EDITORIAL_SYSTEM = `You are the editorial curator for a household IPTV app. Given a candidate pool from the catalog, propose 3 to 5 themed browse rails a household would enjoy tonight.

Each rail is {title, blurb, picks}:
- title: a short punchy rail name (≤ 30 chars) — e.g. "Heist Night", "90s Bollywood", "Feel-Good Sunday", "Edge-of-Seat Thrillers". Not a genre label already obvious from the app; a mood or theme.
- blurb: one short sentence (≤ 90 chars) describing the rail.
- picks: 8 to 20 ids from the candidate pool that fit the theme, best first. Only ids from the pool. A title may appear in at most one rail. Themes must be genuinely distinct from each other.
Ground every rail in what's actually in the pool — do not invent a theme you cannot fill with real candidates.`;

// Propose editorial rails from a candidate pool [{id, line}]. Returns
// {rails:[{title, blurb, picks:[id]}]} or null. Ids validated against
// the pool; rails with < 4 valid picks dropped; ≤ 5 rails.
async function buildEditorialRails({ candidates } = {}) {
  if (!aiEnabled()) return null;
  if (!Array.isArray(candidates) || !candidates.length) return null;
  try {
    const candidateById = new Map(candidates.map((c) => [String(c.id), c.id]));
    const user = [
      "Candidate pool:",
      ...candidates.map((c) => `${c.id}: ${c.line}`),
    ].join("\n");
    const response = await client().messages.create(
      {
        model: AI_MODEL,
        max_tokens: 2000,
        system: EDITORIAL_SYSTEM,
        output_config: { format: { type: "json_schema", schema: EDITORIAL_SCHEMA } },
        messages: [{ role: "user", content: user }],
      },
      { timeout: 120_000 },
    );
    if (response.stop_reason === "refusal") return null;
    const out = parseJsonResponse(response);
    if (!out || !Array.isArray(out.rails)) return null;
    // A title may only land on one rail across the whole set — the
    // prompt asks for it, but dedupe defensively so two rails can't
    // share the same tiles.
    const usedGlobally = new Set();
    const rails = [];
    for (const r of out.rails) {
      const seen = new Set();
      const picks = [];
      for (const rawId of Array.isArray(r?.picks) ? r.picks : []) {
        const id = candidateById.get(String(rawId));
        if (id === undefined) continue;
        const key = String(id);
        if (seen.has(key) || usedGlobally.has(key)) continue;
        seen.add(key);
        picks.push(id);
        if (picks.length >= 20) break;
      }
      if (picks.length < 4) continue;
      picks.forEach((id) => usedGlobally.add(String(id)));
      rails.push({
        title: String(r?.title || "").trim().slice(0, 40),
        blurb: String(r?.blurb || "").trim().slice(0, 120),
        picks,
      });
      if (rails.length >= 5) break;
    }
    if (!rails.length) return null;
    return { rails };
  } catch {
    return null;
  }
}

// ── Tonight digest ───────────────────────────────────────────────────
// Nightly, household-level: from tonight's live programmes (+ the
// household's in-progress items) curate the handful most worth watching.
const TONIGHT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    live: {
      type: "array",
      items: {
        type: "object",
        properties: {
          channel_id: { anyOf: [{ type: "integer" }, { type: "string" }] },
          programme: { type: "string" },
          why: { type: "string" },
        },
        required: ["channel_id", "programme", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "live"],
  additionalProperties: false,
};

const TONIGHT_SYSTEM = `You program the "Tonight" rail for a household IPTV app. Given tonight's live programmes (each with a channel id) and what the household is mid-way through, pick the most watchable live items for tonight.

Produce:
- summary: one warm sentence for the household about tonight (≤ 120 chars).
- live: up to 8 items, best first, each {channel_id, programme, why}. channel_id: ONLY a channel_id present in the input. programme: the programme title as given. why: a ≤ 60-char hook ("Live semifinal", "Premieres tonight"). Favor live sport, premieres, films, and finales over routine daytime/news filler. Skip anything not genuinely worth surfacing — fewer great items beats a padded list.`;

// Curate tonight's live picks. `liveCandidates` is [{channel_id,
// channel_name, programme, start, desc}]; `resumeItems` is a list of
// "Title — next up" strings for context. Returns {summary, live:
// [{channel_id, programme, why}]} or null. channel_ids validated
// against the input.
async function buildTonightDigest({ liveCandidates, resumeItems } = {}) {
  if (!aiEnabled()) return null;
  if (!Array.isArray(liveCandidates) || !liveCandidates.length) return null;
  try {
    const idSet = new Set(liveCandidates.map((c) => String(c.channel_id)));
    const lines = liveCandidates.map((c) => {
      const t = c.start ? `${new Date(c.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ` : "";
      const ch = c.channel_name ? ` on ${c.channel_name}` : "";
      return `${c.channel_id}: ${t}${c.programme}${ch}`;
    });
    const user = [
      "Tonight's live programmes:",
      ...lines,
      ...(Array.isArray(resumeItems) && resumeItems.length
        ? ["", "The household is mid-way through:", ...resumeItems.map((s) => `- ${s}`)]
        : []),
    ].join("\n");
    const response = await client().messages.create(
      {
        model: AI_MODEL,
        max_tokens: 1200,
        system: TONIGHT_SYSTEM,
        output_config: { format: { type: "json_schema", schema: TONIGHT_SCHEMA } },
        messages: [{ role: "user", content: user }],
      },
      { timeout: 120_000 },
    );
    if (response.stop_reason === "refusal") return null;
    const out = parseJsonResponse(response);
    if (!out || !Array.isArray(out.live)) return null;
    const seen = new Set();
    const live = [];
    for (const item of out.live) {
      const key = String(item?.channel_id);
      if (!idSet.has(key) || seen.has(key)) continue;
      seen.add(key);
      live.push({
        channel_id: item.channel_id,
        programme: String(item?.programme || "").slice(0, 120),
        why: String(item?.why || "").trim().slice(0, 70),
      });
      if (live.length >= 8) break;
    }
    if (!live.length) return null;
    return { summary: String(out.summary || "").slice(0, 160), live };
  } catch {
    return null;
  }
}

// ── EPG title normalization ──────────────────────────────────────────
// Batch-clean messy xmltv programme titles so live keyword matching
// (searchEpgLive / a future assistant tool) is reliable. Chunked to
// bound tokens; the caller merges chunk results and persists them.
const EPG_TYPES = ["sports", "movie", "series", "news", "other"];
const EPG_NORM_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          raw: { type: "string" },
          clean: { type: "string" },
          type: { type: "string", enum: EPG_TYPES },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["raw", "clean", "type", "keywords"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

const EPG_NORM_SYSTEM = `You clean up raw electronic-programme-guide (EPG) titles from an IPTV panel so they can be matched by keyword. For each raw title produce {raw, clean, type, keywords}:
- raw: echo the input title verbatim (used as the map key).
- clean: a tidy, human-readable title — strip channel-code prefixes, filler, and encoding cruft; expand obvious abbreviations. If it's a live match, format as "Team A vs Team B" when both are named.
- type: one of sports, movie, series, news, other.
- keywords: lowercase search terms someone might type to find this — team names, tournament/league, canonical show/film name, sport. Omit generic filler words. [] if nothing useful.
Return one entry per input title, no more, no fewer.`;

// ~70 titles/chunk: each entry echoes `raw` + `clean` + up to 12
// keywords (~70 tokens worst case), so 70 × ~70 ≈ 5k stays clear of
// max_tokens even on verbose sports titles. A chunk that still
// truncates fails JSON-parse and contributes nothing — but since the
// caller drops those exact titles the same way every run, a chronically
// oversized chunk would re-truncate forever, so keep this conservative.
const EPG_NORM_CHUNK = 70;

// Normalize a list of distinct raw titles. Returns a map
// {[raw]: {clean, type, keywords}} covering whatever succeeded — a
// failed chunk contributes nothing (fail-to-null per chunk) rather
// than sinking the whole pass. Only titles echoed back verbatim and
// present in the input are kept.
async function normalizeEpgTitles({ titles } = {}) {
  if (!aiEnabled()) return null;
  if (!Array.isArray(titles) || !titles.length) return null;
  const out = {};
  for (let i = 0; i < titles.length; i += EPG_NORM_CHUNK) {
    const chunk = titles.slice(i, i + EPG_NORM_CHUNK);
    const chunkSet = new Set(chunk);
    try {
      const response = await client().messages.create(
        {
          model: AI_MODEL,
          max_tokens: 8000,
          system: EPG_NORM_SYSTEM,
          output_config: { format: { type: "json_schema", schema: EPG_NORM_SCHEMA } },
          messages: [{ role: "user", content: "Titles:\n" + chunk.map((t) => `- ${t}`).join("\n") }],
        },
        { timeout: 120_000 },
      );
      if (response.stop_reason === "refusal") continue;
      const parsed = parseJsonResponse(response);
      if (!parsed || !Array.isArray(parsed.entries)) continue;
      for (const e of parsed.entries) {
        const raw = String(e?.raw || "");
        if (!chunkSet.has(raw) || out[raw]) continue;
        const type = EPG_TYPES.includes(e?.type) ? e.type : "other";
        const keywords = Array.isArray(e?.keywords)
          ? e.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 12)
          : [];
        out[raw] = { clean: String(e?.clean || raw).slice(0, 160), type, keywords };
      }
    } catch {
      // Skip this chunk; keep whatever earlier chunks produced.
    }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  aiEnabled,
  translateSearchQuery,
  warmSchemaCache,
  buildTasteProfile,
  buildEditorialRails,
  buildTonightDigest,
  normalizeEpgTitles,
  assistantTurn,
  AI_MODEL,
  AI_ASSISTANT_MODEL,
};
