const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync, execFile } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { AsyncLocalStorage } = require("async_hooks");
const autoplayPref = require("./lib/autoplay");
const { redactUrl, redactAllUrls, installConsoleRedaction } = require("./lib/redact");
// Provider URLs embed credentials; scrub every console line (Axiom ships stdout).
installConsoleRedaction();

// Request-scoped account context. The auth middleware wraps `next()` in
// `accountStore.run(req.account, …)` so any panel-touching helper down
// the async tree can read the active account without callers having to
// thread `actx` through every call. Helpers that want explicit context
// (background prewarms, boot-time builds) still accept an `actx` arg
// and pass it explicitly. Outside a request (boot, intervals), the
// store is empty and helpers fall back to `getOwnerAccount()`.
const accountStore = new AsyncLocalStorage();

const PROXY_SECRET = process.env.PROXY_SECRET || crypto.randomBytes(32).toString("hex");
function signProxyUrl(direct) {
  const sig = crypto.createHmac("sha256", PROXY_SECRET).update(direct).digest("hex").slice(0, 16);
  return `/api/proxy?u=${encodeURIComponent(direct)}&s=${sig}`;
}
function verifyProxySig(direct, sig) {
  if (!sig) return false;
  const expected = crypto.createHmac("sha256", PROXY_SECRET).update(direct).digest("hex").slice(0, 16);
  return sig === expected;
}

const {
  APP_USER,
  APP_PASS,
  TMDB_API_KEY,
  PORT = 3000,
} = process.env;

// Panel credentials: try disk first (data/panel-config.json), fall
// back to env. On first boot when the disk file is absent, env values
// get auto-seeded onto disk so the user can subsequently wipe their
// env file and edit creds entirely from the UI.
//
// `ownerAccount` is a single mutable object so pickPanel /
// switchToHost / panel-config PUT can flip the active host once and
// every reader sees the change. PR 1 derives it from env / panel-config
// at boot; PR 3 will replace this singleton with per-user lookup via
// req.account. Until then, helpers default to getOwnerAccount() and
// callsites stay unchanged.
const ownerAccount = {
  primary: null,            // primary host URL (canonical)
  fallbacks: [],            // array of fallback host URLs
  candidates: [],           // [primary, ...fallbacks]
  host: null,               // active host (mutates on pickPanel / switchToHost)
  user: null,
  pass: null,
  hostFallback: "",         // raw comma-separated fallback string for round-trip persist
};
function getOwnerAccount() { return ownerAccount; }
// Active account = ALS store (set in auth middleware) if present, else
// the owner singleton. PR 3+ paths read req.account via this helper so
// route handlers don't have to thread it through every helper call.
function currentAccount() { return accountStore.getStore() || ownerAccount; }
function accountKeyOf(actx) { return `${actx.user}@${actx.host}`; }
const panelConfigFile = path.join(process.env.DATA_DIR || path.join(__dirname, "data"), "panel-config.json");

// Symmetric encryption for the panel-config file at rest. AES-256-GCM
// with a key derived from PROXY_SECRET via scrypt. This protects
// against:
//   - data-dir leaks (backups, snapshots, accidentally-committed dirs)
//   - someone with read access to data/ but not the running process
// It does NOT protect against:
//   - a fully-compromised server (the key is derivable from env)
//   - PROXY_SECRET rotation — old ciphertext becomes unreadable. The
//     reader logs a clear error in that case and falls back to env.
//
// File shape (v1): { v:1, iv:<hex>, tag:<hex>, data:<base64 cipher> }
// Old plaintext files (no `v` field) are still read, then re-encrypted
// on the next write — automatic migration with zero user action.
const PANEL_CONFIG_KEY = (() => {
  // PROXY_SECRET is the only stable per-install secret we have. If a
  // user runs the default random-per-process secret, encryption keys
  // change every restart and ciphertext becomes unreadable — they'd
  // need to re-enter creds via the UI after every reboot. That's a
  // worse UX than the current plaintext-on-disk setup. Refuse to
  // encrypt in that case (boot warning) and persist plaintext instead.
  if (!process.env.PROXY_SECRET) return null;
  return crypto.scryptSync(process.env.PROXY_SECRET, "khouch-panel-config", 32);
})();

function encryptPanelConfig(obj) {
  if (!PANEL_CONFIG_KEY) return { plaintext: obj }; // fallback marker
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", PANEL_CONFIG_KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: data.toString("base64"),
  };
}
function decryptPanelConfig(env) {
  if (!env || env.v !== 1) return null;
  if (!PANEL_CONFIG_KEY) {
    console.warn("[panel] panel-config is encrypted but PROXY_SECRET is not set — cannot decrypt; falling back to env");
    return null;
  }
  try {
    const iv = Buffer.from(env.iv, "hex");
    const tag = Buffer.from(env.tag, "hex");
    const cipher = crypto.createDecipheriv("aes-256-gcm", PANEL_CONFIG_KEY, iv);
    cipher.setAuthTag(tag);
    const data = Buffer.concat([cipher.update(Buffer.from(env.data, "base64")), cipher.final()]);
    return JSON.parse(data.toString("utf8"));
  } catch (e) {
    console.warn(`[panel] panel-config decrypt failed (${e.message}); falling back to env. Did PROXY_SECRET change?`);
    return null;
  }
}

function readPanelConfigFromDisk() {
  try {
    const raw = fs.readFileSync(panelConfigFile, "utf8");
    const d = JSON.parse(raw);
    if (d && d.v === 1) return decryptPanelConfig(d);
    // Legacy plaintext file. Accept once; the next write will encrypt.
    return d && typeof d === "object" ? d : null;
  } catch { return null; }
}
function writePanelConfigToDisk(cfg) {
  try {
    fs.mkdirSync(path.dirname(panelConfigFile), { recursive: true });
    const wrapped = encryptPanelConfig(cfg);
    const onDisk = wrapped.plaintext ? wrapped.plaintext : wrapped;
    // Ownership-only read perms so even a casual disk peek requires
    // the same access the running server already has.
    fs.writeFileSync(panelConfigFile + ".tmp", JSON.stringify(onDisk), { mode: 0o600 });
    fs.renameSync(panelConfigFile + ".tmp", panelConfigFile);
  } catch (e) {
    console.warn(`save panel-config failed: ${e.message}`);
  }
}
// Recompute primary/fallbacks/candidates after host or hostFallback
// changes on an actx. Defaults to the owner account so legacy callers
// still work; PR 2 will take an explicit actx everywhere.
function recomputePanelDerived(actx = currentAccount()) {
  actx.primary = actx.host && typeof actx.host === "string"
    ? actx.host.replace(/\/$/, "")
    : (actx.primary || null);
  // When hostFallback string is set, derive fallbacks from it; otherwise
  // keep whatever was set explicitly (e.g. tests).
  if (typeof actx.hostFallback === "string") {
    actx.fallbacks = actx.hostFallback
      .split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
  }
  actx.candidates = [actx.primary, ...(actx.fallbacks || [])].filter(Boolean);
  // If the active host is unset or no longer a candidate, fall back to primary.
  if (!actx.host || !actx.candidates.includes(actx.host)) actx.host = actx.primary;
}
function loadInitialPanelConfig() {
  const disk = readPanelConfigFromDisk();
  const host         = (disk && disk.host)         || process.env.IPTV_HOST          || null;
  const hostFallback = (disk && disk.hostFallback) || process.env.IPTV_HOST_FALLBACK || "";
  const user         = (disk && disk.user)         || process.env.IPTV_USER          || null;
  const pass         = (disk && disk.pass)         || process.env.IPTV_PASS          || null;
  ownerAccount.host = host ? host.replace(/\/$/, "") : null;
  ownerAccount.hostFallback = hostFallback;
  ownerAccount.user = user;
  ownerAccount.pass = pass;
  // Migration: if no disk config existed but env had everything, seed
  // it so the user can drop the env file afterward.
  if (!disk && host && user && pass) {
    writePanelConfigToDisk({ host, hostFallback, user, pass });
    console.log("[panel] seeded data/panel-config.json from env vars (one-time migration)");
  }
  recomputePanelDerived(ownerAccount);
}
loadInitialPanelConfig();

for (const [k, v] of Object.entries({
  IPTV_HOST: ownerAccount.host,
  IPTV_USER: ownerAccount.user,
  IPTV_PASS: ownerAccount.pass,
  APP_USER, APP_PASS,
})) {
  if (!v) {
    console.error(`Missing required value (env or data/panel-config.json): ${k}`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Multi-user accounts. Replaces the single APP_USER/APP_PASS gate.
//
// Storage shape (data/accounts.json):
//   { users: [
//       { id, username, passwordHash, role: 'owner'|'member',
//         tokenEpoch, accountSealed, hostHash, lastLoginAt, createdAt }
//     ], nextId }
//
// - passwordHash: scrypt$<N>$<r>$<p>$<salt-hex>$<key-hex>
// - accountSealed: AES-256-GCM blob (same scheme as panel-config.json)
//   of { host, hostFallback, user, pass }. Decrypts to an actx.
// - hostHash: sha256(host).slice(0,16). Stored unencrypted so request
//   routing (per-host caches, EPG lookup) doesn't need the credentials.
// - tokenEpoch: per-user revocation counter; bumping it invalidates
//   every outstanding session for that user (used when owner kicks
//   a member).
//
// First-boot migration: when accounts.json is absent we seed owner u1
// from APP_USER/APP_PASS + the panel-config / env creds. After
// migration the disk file is the source of truth; APP_USER/APP_PASS
// env vars become irrelevant.
// ─────────────────────────────────────────────────────────────────────
const accountsFile = path.join(DATA_DIR_EARLY(), "accounts.json");
function DATA_DIR_EARLY() {
  // DATA_DIR is declared further down in the original file but we need
  // its value up here for accounts.json. Recompute it.
  return process.env.DATA_DIR || path.join(__dirname, "data");
}

// AES-256-GCM key for per-user account sealing. Distinct salt from the
// panel-config key so a leaked one doesn't decrypt the other.
const ACCOUNT_SEAL_KEY = (() => {
  if (!process.env.PROXY_SECRET) return null;
  return crypto.scryptSync(process.env.PROXY_SECRET, "khouch-account-seal", 32);
})();
function sealAccountCreds(obj) {
  if (!ACCOUNT_SEAL_KEY) {
    throw new Error("PROXY_SECRET must be set to seal account credentials");
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ACCOUNT_SEAL_KEY, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString("hex"), tag: tag.toString("hex"), data: data.toString("base64") };
}
function unsealAccountCreds(sealed) {
  if (!sealed || sealed.v !== 1) return null;
  if (!ACCOUNT_SEAL_KEY) return null;
  try {
    const iv = Buffer.from(sealed.iv, "hex");
    const tag = Buffer.from(sealed.tag, "hex");
    const cipher = crypto.createDecipheriv("aes-256-gcm", ACCOUNT_SEAL_KEY, iv);
    cipher.setAuthTag(tag);
    const data = Buffer.concat([cipher.update(Buffer.from(sealed.data, "base64")), cipher.final()]);
    return JSON.parse(data.toString("utf8"));
  } catch (e) {
    console.warn(`[accounts] unseal failed: ${e.message}`);
    return null;
  }
}

// scrypt password hash. Format: "scrypt$N$r$p$saltHex$keyHex"
function hashPassword(plain) {
  const N = 16384, r = 8, p = 1, keylen = 32;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(plain), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${key.toString("hex")}`;
}
function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, Ns, rs, ps, saltHex, keyHex] = parts;
  try {
    const N = parseInt(Ns, 10), r = parseInt(rs, 10), p = parseInt(ps, 10);
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(keyHex, "hex");
    const actual = crypto.scryptSync(String(plain), salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
}

// In-memory accounts registry.
const accounts = { users: [], byId: new Map(), byUsername: new Map(), nextId: 2 };
// LRU-ish (uncapped) decrypted-actx cache. Saves on scrypt for repeat
// sealing operations. Invalidated on PUT /api/panel/config.
const accountCtxCache = new Map(); // userId -> actx

function indexAccounts() {
  accounts.byId.clear();
  accounts.byUsername.clear();
  for (const u of accounts.users) {
    accounts.byId.set(u.id, u);
    accounts.byUsername.set(String(u.username).toLowerCase(), u);
  }
}
function loadAccountsFromDisk() {
  try {
    const raw = fs.readFileSync(accountsFile, "utf8");
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.users)) return false;
    accounts.users = d.users;
    accounts.nextId = Number.isFinite(d.nextId) ? d.nextId : (d.users.length + 1);
    indexAccounts();
    return true;
  } catch { return false; }
}
function saveAccountsToDisk() {
  try {
    fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
    const obj = { users: accounts.users, nextId: accounts.nextId };
    fs.writeFileSync(accountsFile + ".tmp", JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(accountsFile + ".tmp", accountsFile);
  } catch (e) {
    console.warn(`save accounts failed: ${e.message}`);
  }
}
function getUserById(id) { return accounts.byId.get(id) || null; }
function getUserByUsername(name) {
  return accounts.byUsername.get(String(name || "").toLowerCase()) || null;
}
function ownerUser() {
  // First user with role=owner, or u1 fallback.
  return accounts.users.find(u => u.role === "owner") || getUserById("u1");
}
function getAccountForUser(user) {
  if (!user) return ownerAccount;
  const cached = accountCtxCache.get(user.id);
  if (cached) return cached;
  // Owner: prefer the live ownerAccount singleton (which reflects
  // panel-config.json + env). Sealing exists on disk too but the
  // singleton is the source of truth post-migration.
  if (user.role === "owner") {
    accountCtxCache.set(user.id, ownerAccount);
    return ownerAccount;
  }
  const raw = unsealAccountCreds(user.accountSealed);
  if (!raw || !raw.host || !raw.user || !raw.pass) return ownerAccount;
  const actx = {
    primary: raw.host.replace(/\/$/, ""),
    fallbacks: [],
    candidates: [],
    host: raw.host.replace(/\/$/, ""),
    user: raw.user,
    pass: raw.pass,
    hostFallback: raw.hostFallback || "",
  };
  recomputePanelDerived(actx);
  accountCtxCache.set(user.id, actx);
  return actx;
}
function invalidateAccountCtx(userId) { accountCtxCache.delete(userId); }

// Invite tokens. Single-use, default 7-day expiry.
const invitesFile = path.join(DATA_DIR_EARLY(), "invites.json");
const invites = { invites: [], byToken: new Map() };
function indexInvites() {
  invites.byToken.clear();
  for (const inv of invites.invites) invites.byToken.set(inv.token, inv);
}
function loadInvitesFromDisk() {
  try {
    const raw = fs.readFileSync(invitesFile, "utf8");
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.invites)) return false;
    invites.invites = d.invites;
    indexInvites();
    return true;
  } catch { return false; }
}
function saveInvitesToDisk() {
  try {
    fs.mkdirSync(path.dirname(invitesFile), { recursive: true });
    fs.writeFileSync(invitesFile + ".tmp", JSON.stringify({ invites: invites.invites }), { mode: 0o600 });
    fs.renameSync(invitesFile + ".tmp", invitesFile);
  } catch (e) {
    console.warn(`save invites failed: ${e.message}`);
  }
}
function generateInviteToken() {
  return crypto.randomBytes(24).toString("base64url");
}
function getInvite(token) { return invites.byToken.get(token) || null; }
function isInviteValid(inv) {
  if (!inv) return false;
  if (inv.redeemedAt) return false;
  if (inv.expiresAt && Date.now() > inv.expiresAt) return false;
  return true;
}
function markInviteRedeemed(token, userId) {
  const inv = getInvite(token);
  if (!inv) return false;
  inv.redeemedAt = Date.now();
  inv.redeemedByUserId = userId;
  saveInvitesToDisk();
  return true;
}

// Migration: seed owner u1 from APP_USER/APP_PASS + ownerAccount creds
// on first boot. Idempotent.
function migrateToMultiTenant() {
  if (loadAccountsFromDisk() && accounts.users.length) {
    // Already migrated. Refuse to boot if PROXY_SECRET went missing.
    if (!process.env.PROXY_SECRET) {
      const hasNonOwner = accounts.users.some(u => u.role !== "owner");
      if (hasNonOwner) {
        console.error("[migrate] PROXY_SECRET unset but non-owner users exist; their sealed creds cannot be read. Set PROXY_SECRET and restart.");
        process.exit(1);
      }
    }
    loadInvitesFromDisk();
    return;
  }
  // Fresh install: create owner u1.
  if (!process.env.PROXY_SECRET) {
    console.warn("[migrate] PROXY_SECRET not set — sealed account creds will be unreadable across restarts. Single-tenant fallback may still work if you keep IPTV_USER/IPTV_PASS in env.");
  }
  const u1 = {
    id: "u1",
    username: APP_USER,
    passwordHash: hashPassword(APP_PASS),
    role: "owner",
    tokenEpoch: 0,
    // Owner's sealed creds: a safety copy. The live source of truth is
    // ownerAccount (panel-config.json + env). On PUT /api/panel/config
    // we re-seal here too so the round-trip stays consistent.
    accountSealed: ACCOUNT_SEAL_KEY ? sealAccountCreds({
      host: ownerAccount.host,
      hostFallback: ownerAccount.hostFallback,
      user: ownerAccount.user,
      pass: ownerAccount.pass,
    }) : null,
    hostHash: hostHashOfSafe(ownerAccount.host),
    lastLoginAt: 0,
    createdAt: Date.now(),
  };
  accounts.users = [u1];
  accounts.nextId = 2;
  indexAccounts();
  saveAccountsToDisk();
  // Patch existing profiles registry to assign ownerUserId = u1.
  try {
    const usersFilePath = path.join(DATA_DIR_EARLY(), "users.json");
    if (fs.existsSync(usersFilePath)) {
      const raw = fs.readFileSync(usersFilePath, "utf8");
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.profiles)) {
        let patched = false;
        for (const p of d.profiles) {
          if (!p.ownerUserId) { p.ownerUserId = "u1"; patched = true; }
        }
        if (patched) {
          fs.writeFileSync(usersFilePath + ".tmp", JSON.stringify(d), { mode: 0o600 });
          fs.renameSync(usersFilePath + ".tmp", usersFilePath);
        }
      }
    }
  } catch (e) {
    console.warn(`[migrate] patching profiles ownerUserId failed: ${e.message}`);
  }
  loadInvitesFromDisk();
  console.log(`[migrate] seeded accounts.json with owner u1 (${APP_USER})`);
}
// hostHashOf is defined later (lexical position). Use a fallback here.
function hostHashOfSafe(host) {
  return crypto.createHash("sha256").update(host || "").digest("hex").slice(0, 16);
}
migrateToMultiTenant();

// Probe a panel host for auth+health. Defaults to the request's
// account creds (or owner outside a request) so existing callers
// (boot, periodic refresh, manual host switch) stay one-arg; the
// /api/panel/config validation endpoint passes proposed user/pass
// to test a config change before committing it.
async function probePanel(host, user, pass) {
  if (user == null || pass == null) {
    const a = currentAccount();
    if (user == null) user = a.user;
    if (pass == null) pass = a.pass;
  }
  const url = `${host}/player_api.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    if (!data?.user_info) return { ok: false, reason: "no user_info" };
    if (Number(data.user_info.auth) !== 1) return { ok: false, reason: "auth=0" };
    return { ok: true, account: data };
  } catch (e) {
    return { ok: false, reason: redactAllUrls(e.message) };
  }
}

async function pickPanel(actx = currentAccount()) {
  for (const host of actx.candidates) {
    const r = await probePanel(host, actx.user, actx.pass);
    if (r.ok) {
      if (actx.host !== host) {
        console.log(`switched panel: ${actx.host} → ${host}`);
        cache.clear();
        afterInfoCacheClear();
        // Panel modes only — the local "disk" index isn't panel-derived and
        // must NOT be reset on a panel switch (buildAllIndexes won't rebuild it).
        for (const m of PANEL_MODES) getIndexesFor(actx)[m].ready = false;
      }
      actx.host = host;
      return { active: host, reason: "ok" };
    }
    console.warn(`panel probe failed for ${host}: ${r.reason}`);
  }
  console.error("all panels failed; staying on", actx.host);
  return { active: actx.host, reason: "all-failed" };
}

async function switchToHost(host, actx = currentAccount()) {
  if (!actx.candidates.includes(host)) return { active: actx.host, reason: "unknown-host" };
  if (host === actx.host) return { active: actx.host, reason: "already-active" };
  const r = await probePanel(host, actx.user, actx.pass);
  if (!r.ok) return { active: actx.host, reason: `unhealthy: ${r.reason}` };
  console.log(`manual switch: ${actx.host} → ${host}`);
  actx.host = host;
  cache.clear();
  afterInfoCacheClear();
  await clearDiskIndexes();
  // Panel modes only — never wipe the local "disk" index here (it isn't
  // panel-derived and buildAllIndexes won't rebuild it).
  for (const m of PANEL_MODES) {
    const ix = getIndexesFor(actx)[m];
    ix.ready = false;
    ix.byId = new Map();
    ix.done = 0;
    ix.total = 0;
  }
  buildAllIndexes();
  return { active: actx.host, reason: "ok" };
}

const MODES = {
  live: {
    cats: "get_live_categories",
    list: "get_live_streams",
    pathSeg: "live",
    defaultExt: "m3u8",
  },
  movie: {
    cats: "get_vod_categories",
    list: "get_vod_streams",
    info: "get_vod_info",
    pathSeg: "movie",
  },
  series: {
    cats: "get_series_categories",
    list: "get_series",
    info: "get_series_info",
    pathSeg: "series",
  },
  // Local on-disk media library. No Xtream panel actions — its catalog
  // comes from scanning a filesystem path (see buildDiskIndex). `local`
  // marks it so panel-only passes (xtream fetch, EPG, quality demotion,
  // codec-probe-on-play, periodic panel rebuild) skip it.
  disk: {
    pathSeg: "disk",
    local: true,
    label: "Disk",
  },
};

// All modes (incl. local). PANEL_MODES is the subset backed by an Xtream
// panel — use it for any loop that calls xtream()/panel actions. Mode
// route regexes use MODE_RE so adding a mode here flows through.
const MODE_KEYS = Object.keys(MODES);
const PANEL_MODES = MODE_KEYS.filter((m) => !MODES[m].local);
const LOCAL_MODES = MODE_KEYS.filter((m) => MODES[m].local);
const MODE_RE = MODE_KEYS.join("|"); // "live|movie|series|disk"
function isLocalMode(mode) { return !!MODES[mode]?.local; }

const cache = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
// Detail-screen info calls fail over to a stale copy after this long
// rather than holding the TV on a spinner for the 90 s default.
const INFO_PANEL_TIMEOUT_MS = 30_000;

// Window for the "Recently Added" home rail. 7 days matches the
// "anything new this week?" mental model. The panel batches drops
// (some days 0, some days 20+), so a narrower window like 24 h would
// show an empty rail most of the time.
const RECENTLY_ADDED_DAYS = 7;
// US certs for the "Family" rail — broadly watchable with a 9yo + 12yo,
// up to PG-13 (the 12yo's level), any genre (not just animation).
// Excludes TV-14 and R/NC-17/TV-MA. Unrated titles are excluded (a
// missing cert can't be vouched as family-safe). Cert-based regardless
// of the active profile, so a parent browsing their own profile still
// gets a "what can we all watch tonight" rail.
const FAMILY_CERTS = new Set(["G", "TV-Y", "TV-G", "PG", "TV-Y7", "TV-PG", "PG-13"]);
const inflight = new Map();

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const { entryKind } = require("./lib/new-trailers");
const { createLazyGate, pickLogo, logoUrl, logoBackfillCandidates, applyLogo } = require("./lib/title-logos");
const { pickTrailerKey, selectNewTrailers, backfillCandidates, applyReleaseInfo, buildTrailerKeyIndex, trailerKeyAllowed } = require("./lib/new-trailers");
// Last good get_vod_info / get_series_info per title, for stale-if-error
// on the detail endpoint (survives restarts, unlike `cache`).
const { createInfoStore, getInfoStaleIfError, isUsableInfo } = require("./lib/info-cache");
const audioTracksLib = require("./lib/audio-tracks");
const notifyMeLib = require("./lib/notify-me");
const newEpisodesLib = require("./lib/new-episodes");
const infoStore = createInfoStore({ dir: path.join(DATA_DIR, "info-cache") });
const indexFilePath =(mode) => path.join(DATA_DIR, `index-${mode}.json`);
const categoriesFilePath = (mode) => path.join(DATA_DIR, `categories-${mode}.json`);

// Serialize concurrent saves per-mode. Two callers (buildIndex and the
// /api/bootstrap pickCats path) can fire saveCategoriesToDisk for the
// same mode within the same millisecond on a cold boot, racing on the
// shared `.tmp` filename and leaving one rename to ENOENT-fail. Queue
// per-mode so writes happen back-to-back.
const _categorySaveInflight = new Map(); // `${accountKey}|${mode}` → Promise
async function saveCategoriesToDisk(mode, cats, actx = currentAccount()) {
  if (!Array.isArray(cats) || !cats.length) return;
  const p0 = dataPathFor(actx, "categories", mode);
  const key = `${accountKeyOf(actx)}|${mode}`;
  const prev = _categorySaveInflight.get(key) || Promise.resolve();
  const p = prev.then(async () => {
    try {
      await fs.promises.writeFile(p0 + ".tmp", JSON.stringify(cats));
      await fs.promises.rename(p0 + ".tmp", p0);
    } catch (e) {
      // ENOENT-on-rename means a concurrent writer beat us and the
      // file IS in place — harmless. Anything else is real (perms,
      // disk full, etc.) and worth logging.
      if (e.code !== "ENOENT") {
        console.warn(`[${mode}] save categories failed: ${e.message}`);
      }
    }
  });
  _categorySaveInflight.set(key, p);
  return p;
}

function loadCategoriesFromDiskSync(mode, actx = currentAccount()) {
  try {
    const raw = fs.readFileSync(dataPathFor(actx, "categories", mode), "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

const lastPlayedFile = path.join(DATA_DIR, "last-played.json");
// Last-played is a per-mode map of {id: timestamp}. Built from MODE_KEYS so
// every mode (incl. the local "disk" library) has a bucket — without this,
// recordLastPlayed("disk",…) silently dropped writes (`if (!lp[mode]) return`).
function emptyLastPlayed() {
  const o = {};
  for (const m of MODE_KEYS) o[m] = {};
  return o;
}
function normalizeLastPlayed(d) {
  const o = emptyLastPlayed();
  if (d && typeof d === "object") {
    for (const m of MODE_KEYS) if (d[m] && typeof d[m] === "object") o[m] = d[m];
  }
  return o;
}
const lastPlayed = (() => {
  try {
    const raw = fs.readFileSync(lastPlayedFile, "utf8");
    return normalizeLastPlayed(JSON.parse(raw));
  } catch { return emptyLastPlayed(); }
})();
const _lastPlayedSaveTimers = new Map(); // acctKey -> Timeout
function scheduleLastPlayedSave(actx = currentAccount()) {
  const key = accountKeyOf(actx);
  if (_lastPlayedSaveTimers.has(key)) return;
  // Debounce so a burst of play events writes the file once.
  const t = setTimeout(async () => {
    _lastPlayedSaveTimers.delete(key);
    try {
      const p0 = dataPathFor(actx, "lastPlayed");
      const lp = isOwnerAccount(actx) ? lastPlayed : (lastPlayedByAccount.get(key) || emptyLastPlayed());
      await fs.promises.writeFile(p0 + ".tmp", JSON.stringify(lp));
      await fs.promises.rename(p0 + ".tmp", p0);
    } catch (e) {
      console.warn(`save last-played failed: ${e.message}`);
    }
  }, 500);
  _lastPlayedSaveTimers.set(key, t);
}
function getLastPlayedFor(actx) {
  if (isOwnerAccount(actx)) return lastPlayed;
  const key = accountKeyOf(actx);
  let lp = lastPlayedByAccount.get(key);
  if (!lp) {
    // Lazy-load from disk on first access for this account. Falls back
    // to a fresh empty structure if the file doesn't exist yet.
    try {
      lp = normalizeLastPlayed(JSON.parse(fs.readFileSync(dataPathFor(actx, "lastPlayed"), "utf8")));
    } catch {
      lp = emptyLastPlayed();
    }
    lastPlayedByAccount.set(key, lp);
  }
  return lp;
}
function recordLastPlayed(mode, id, ts = Date.now(), actx = currentAccount()) {
  const lp = getLastPlayedFor(actx);
  if (!lp[mode]) return;
  lp[mode][String(id)] = ts;
  scheduleLastPlayedSave(actx);
}

// --- TMDB poster + metadata cache -------------------------------------
// On-disk cache keyed by `${mode}:${id}` for primary movie/series
// lookups, and `series-season:${id}:${n}` for episode-still maps.
// Positive entries persist forever (TMDB posters rarely change).
// Negative ("no-match") entries get re-checked after 7 days. The
// shorter TTL is supported by a separate nightly retry cron (see
// scheduleTmdbRetry below) — between the cron and the TTL-driven
// retry inside prewarmTmdbCache, no-match entries recover faster.
const TMDB_NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";
const tmdbCacheFile = path.join(DATA_DIR, "tmdb-cache.json");
const tmdbStore = (() => {
  try {
    const raw = fs.readFileSync(tmdbCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();

// --- Match-plausibility guard (lib/tmdb-match.js) ---------------------------
// tmdbStore is the raw persisted cache. tmdbCache (below) is a read-through
// VIEW of it: an entry whose TMDB title shares nothing with the stream name
// (and fails the language / festival heuristics) reads as a no-match with
// checked_at 0, so every tile / detail / cert / rail reader treats it as
// unmatched (kids: no cert => unrated) and ensureTmdbForItem re-resolves it
// lazily the next time a detail/poster request touches it. Nothing is
// deleted — the raw entry stays in tmdbStore until it is re-resolved.
// data/tmdb-overrides.json {"movie:825105": null | 1234} pins a stream to
// "no match" (null) or to a specific TMDB id (number) and bypasses the guard.
const { matchPlausible } = require("./lib/tmdb-match");
const { createGuardedTmdbCache, normalizeOverrides, markGuardRejected } = require("./lib/tmdb-guard-view");
const tmdbOverridesFile = path.join(DATA_DIR, "tmdb-overrides.json");
const tmdbOverrides = (() => {
  try { return normalizeOverrides(JSON.parse(fs.readFileSync(tmdbOverridesFile, "utf8"))); }
  catch { return {}; }
})();
function saveTmdbOverrides() {
  try {
    fs.writeFileSync(tmdbOverridesFile + ".tmp", JSON.stringify(tmdbOverrides, null, 2));
    fs.renameSync(tmdbOverridesFile + ".tmp", tmdbOverridesFile);
  } catch (e) { console.warn(`save tmdb-overrides failed: ${e.message}`); }
}
const hasTmdbOverride = (key) => Object.prototype.hasOwnProperty.call(tmdbOverrides, key);
// cacheKey -> {name, year, tags} captured while indexes are built (and looked up
// from the owner index afterwards), so the view can judge an entry by stream name.
// The SAME {name, year, tags} feeds ensureTmdbForItem's judging (tmdbHintsPlausible),
// so the view and the resolver can never disagree and loop re-fetching.
const tmdbNameHints = new Map();
function tmdbStreamInfo(key) {
  const h = tmdbNameHints.get(key);
  if (h) return h;
  try {
    const [m, id] = key.split(":");
    const it = _ownerIndexes[m]?.byId?.get(parseInt(id, 10));
    return it ? { name: it.name, year: it.year, tags: it.tags } : null;
  } catch { return null; }
}
// Judge a (projected) TMDB entry against a stream. Only movie/series.
function tmdbPlausibility(mode, info, e, viaPanelId) {
  if (mode !== "movie" && mode !== "series") return { ok: true, reason: "n/a" };
  let lang = null;
  try { lang = info.tags ? isoLangForItem({ tags: info.tags }) : (info.lang || null); } catch { /* ignore */ }
  return matchPlausible({
    streamName: info.name, streamLangTag: lang, streamYear: info.year,
    tmdb: { title: e.tmdb_title, original_title: e.original_title, original_language: e.original_language,
            year: e.year, genres: e.genres, runtime: e.runtime, alternative_titles: e.alternative_titles },
    viaPanelId: !!viaPanelId,
  });
}
const tmdbGuard = createGuardedTmdbCache({
  store: tmdbStore, overrides: tmdbOverrides, getInfo: tmdbStreamInfo,
  judge: (mode, info, e) => tmdbPlausibility(mode, info, e, false),
});
const tmdbCache = tmdbGuard.cache;
const tmdbEntryVerdict = tmdbGuard.verdict;
let tmdbCacheSaveTimer = null;
let tmdbCacheVersion = 0; // bumped on every change; consumers rebuild derived indexes lazily
function scheduleTmdbCacheSave() {
  tmdbCacheVersion++;
  if (tmdbCacheSaveTimer) return;
  tmdbCacheSaveTimer = setTimeout(async () => {
    tmdbCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(tmdbCacheFile + ".tmp", JSON.stringify(tmdbStore));
      await fs.promises.rename(tmdbCacheFile + ".tmp", tmdbCacheFile);
    } catch (e) {
      console.warn(`save tmdb-cache failed: ${e.message}`);
    }
  }, 500);
}

// ──────────────────────────────────────────────────────────────────
// Real-4K cache. Panels routinely label a movie "(4K)" in the title /
// category even when the actual file is 1080p or — observed — a 600x900
// JPEG poster. get_vod_info exposes real resolution via info.video.
// {width,height}. We verify items currently tagged "4k" once and
// demote the tag when actual resolution is sub-4K. Persisted to disk
// so we don't re-probe on every boot.
//
// Cache shape: { "movie:<id>": { w, h, codec, bitrate, is4k, checked_at } }
// Definition: is4k = (height >= 2000) || (width >= 3200). Covers 16:9
// UHD (3840x2160), 2.4:1 cinema (3840x1600), ultra-wide 4K-class
// (3940x816), etc. Excludes 1080p HEVC and poster-only entries.
const QUALITY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d re-check
const qualityCacheFile = path.join(DATA_DIR, "quality-cache.json");
const qualityCache = (() => {
  try {
    const raw = fs.readFileSync(qualityCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let qualityCacheSaveTimer = null;
let qualityCacheSaveDue = 0;
let qualityCacheSaving = false;
// delayMs: 500 for interactive writes; the background crawler passes 60 s
// (the file is ~9 MB, rewriting it every probe would be wasteful). An
// earlier deadline replaces a later one.
function scheduleQualityCacheSave(delayMs = 500) {
  const due = Date.now() + delayMs;
  if (qualityCacheSaveTimer) {
    if (due >= qualityCacheSaveDue) return;
    clearTimeout(qualityCacheSaveTimer);
  }
  qualityCacheSaveDue = due;
  qualityCacheSaveTimer = setTimeout(async () => {
    qualityCacheSaveTimer = null;
    if (qualityCacheSaving) { scheduleQualityCacheSave(1000); return; }
    qualityCacheSaving = true;
    try {
      await fs.promises.writeFile(qualityCacheFile + ".tmp", JSON.stringify(qualityCache));
      await fs.promises.rename(qualityCacheFile + ".tmp", qualityCacheFile);
    } catch (e) {
      console.warn(`save quality-cache failed: ${e.message}`);
    } finally { qualityCacheSaving = false; }
  }, delayMs);
}
// Audio codec cache for live channels. Sports panels routinely ship
// MP2 / AC3 / E-AC3 audio with H.264 video — the video parses cleanly
// in hls.js but MSE can't decode the audio, leaving the user with a
// silent black-box player. ffprobe the first segment once per channel,
// remember the verdict, and when the audio codec is browser-unsafe
// hand the client the transcode URL up front (no manifest-load-then-
// fail-then-retry round-trip).
const audioCodecCacheFile = path.join(DATA_DIR, "audio-codec-cache.json");
const audioCodecCache = (() => {
  try {
    const raw = fs.readFileSync(audioCodecCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let audioCodecCacheSaveTimer = null;
let audioCodecCacheSaving = false;
function scheduleAudioCodecCacheSave() {
  if (audioCodecCacheSaveTimer) return;
  audioCodecCacheSaveTimer = setTimeout(async () => {
    audioCodecCacheSaveTimer = null;
    if (audioCodecCacheSaving) { scheduleAudioCodecCacheSave(); return; }
    audioCodecCacheSaving = true;
    try {
      await fs.promises.writeFile(audioCodecCacheFile + ".tmp", JSON.stringify(audioCodecCache));
      await fs.promises.rename(audioCodecCacheFile + ".tmp", audioCodecCacheFile);
    } catch (e) {
      console.warn(`save audio-codec-cache failed: ${e.message}`);
    } finally { audioCodecCacheSaving = false; }
  }, 500);
}
// Panel VOD audio-track lists, keyed `${mode}:${id}`, from a network
// ffprobe of the panel stream. Multi-audio panel movies (a 4K mkv with
// Hindi + English + commentary tracks) need a picker; this caches the
// per-title enumeration so the probe runs once. Codecs/tracks don't
// change for a given id, so a long TTL is fine. Persisted like the
// audio-codec cache.
const panelTracksCacheFile = path.join(DATA_DIR, "panel-tracks-cache.json");
const panelTracksCache = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(panelTracksCacheFile, "utf8"));
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let panelTracksCacheSaveTimer = null;
function schedulePanelTracksCacheSave() {
  if (panelTracksCacheSaveTimer) return;
  panelTracksCacheSaveTimer = setTimeout(async () => {
    panelTracksCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(panelTracksCacheFile + ".tmp", JSON.stringify(panelTracksCache));
      await fs.promises.rename(panelTracksCacheFile + ".tmp", panelTracksCacheFile);
    } catch (e) {
      console.warn(`save panel-tracks-cache failed: ${e.message}`);
    }
  }, 500);
}

// ── Surround sound (docs/SURROUND.md) ──────────────────────────────
// Per-title audio summary from what is already known (never a stream):
// learned transcode tracks (panelTracksCache) win, then the panel's
// get_vod_info audio (qualityCache). Series: max over episodes of the
// series info (seriesAudio, persisted). Badge/format via lib/surround.
const surroundLib = require("./lib/surround");
function loadJsonObject(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, "utf8"));
    return d && typeof d === "object" && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}
function makeJsonSaver(file, obj, label, delayMs = 1000) {
  let timer = null;
  let saving = false;
  const save = () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (saving) { save(); return; }
      saving = true;
      try {
        await fs.promises.writeFile(file + ".tmp", JSON.stringify(obj));
        await fs.promises.rename(file + ".tmp", file);
      } catch (e) {
        console.warn(`save ${label} failed: ${e.message}`);
      } finally { saving = false; }
    }, delayMs);
  };
  return save;
}
// "movie:<id>" -> ms timestamp of a get_vod_info that carried no audio
// info (the panel never probed that file). Retried after AUDIO_MISS_TTL_MS.
const AUDIO_MISS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const audioCrawlMissesFile = path.join(DATA_DIR, "audio-crawl-misses.json");
const audioCrawlMisses = loadJsonObject(audioCrawlMissesFile);
// Expired misses are dropped at boot (the file only holds live verdicts).
for (const [k, t] of Object.entries(audioCrawlMisses)) {
  if (!Number.isFinite(t) || Date.now() - t >= AUDIO_MISS_TTL_MS) delete audioCrawlMisses[k];
}
const scheduleAudioCrawlMissesSave = makeJsonSaver(audioCrawlMissesFile, audioCrawlMisses, "audio-crawl-misses", 30_000);
const audioMissFresh = (id) => {
  const t = audioCrawlMisses[`movie:${id}`];
  return Number.isFinite(t) && Date.now() - t < AUDIO_MISS_TTL_MS;
};
// "<series id>" -> { channels, codec, profile, atmos, known, surround, t }
const seriesAudioFile = path.join(DATA_DIR, "series-audio.json");
const seriesAudio = loadJsonObject(seriesAudioFile);
const scheduleSeriesAudioSave = makeJsonSaver(seriesAudioFile, seriesAudio, "series-audio");

function learnedTrackSummary(mode, id) {
  const c = panelTracksCache[`${mode}:${id}`];
  return c && Array.isArray(c.audioTracks) ? surroundLib.summarizeTracks(c.audioTracks) : null;
}
function movieAudioSummary(id) {
  const learned = learnedTrackSummary("movie", id);
  if (learned) return learned;
  const q = qualityCache[`movie:${id}`];
  const ch = Number(q && q.audio_channels) || 0;
  if (!ch) return null;
  return { channels: ch, codec: q.audio_codec || null, profile: q.audio_profile || null, atmos: surroundLib.mentionsAtmos(q.audio_profile) };
}
// Writes the audio fields onto an index item (movie / series / disk) and
// keeps the "surround" chip tag in step (>= 6 channels). `summary` null =
// unknown: leaves the item untouched.
function applyAudioToItem(s, summary) {
  if (!s || !summary) return;
  const f = surroundLib.audioFields(summary);
  if (!f.audio_channels) return;
  s.audio_channels = f.audio_channels;
  s.audio_codec = f.audio_codec;
  if (f.audio_format) s.audio_format = f.audio_format; else delete s.audio_format;
  if (f.audio_badge) s.audio_badge = f.audio_badge; else delete s.audio_badge;
  const tags = Array.isArray(s.tags) ? s.tags : [];
  const has = tags.includes("surround");
  if (f.audio_badge && !has) s.tags = [...tags, "surround"];
  else if (!f.audio_badge && has) s.tags = tags.filter((t) => t !== "surround");
}
// Additive tile fields (spread into every VOD tile builder).
function audioTileFields(s) {
  if (!s || !s.audio_channels) return { audio_channels: null, audio_codec: null };
  return {
    audio_channels: s.audio_channels,
    audio_codec: s.audio_codec || null,
    audio_format: s.audio_format || undefined,
    audio_badge: s.audio_badge || undefined,
  };
}
// Detail-page fields: always present (null = unknown). Series fall back to
// the persisted summary when the index item has none yet.
function detailAudioFields(mode, item, actx = currentAccount()) {
  if (!isOwnerAccount(actx) && mode !== "disk") return surroundLib.audioFields(null);
  if (item && item.audio_channels) {
    return {
      audio_channels: item.audio_channels,
      audio_codec: item.audio_codec || null,
      audio_format: item.audio_format || null,
      audio_badge: item.audio_badge || null,
    };
  }
  if (mode === "series" && item) return surroundLib.audioFields(seriesAudioSummary(item.id));
  return { audio_channels: null, audio_codec: null, audio_format: null, audio_badge: null };
}
// Series: summarize a get_series_info answer, persist, patch the index item.
function noteSeriesAudio(seriesId, info, actx = currentAccount()) {
  if (!isOwnerAccount(actx) || !info || !info.episodes) return null;
  const sum = surroundLib.summarizeSeries(info.episodes, (epId) => learnedTrackSummary("series", epId));
  if (!sum) return null;
  const key = String(seriesId);
  const prev = seriesAudio[key];
  if (!prev || prev.channels !== sum.channels || prev.codec !== sum.codec || prev.atmos !== sum.atmos
      || prev.known !== sum.known || prev.surround !== sum.surround) {
    seriesAudio[key] = { ...sum, t: Date.now() };
    scheduleSeriesAudioSave();
  }
  applyAudioToItem(getIndexesFor(actx).series?.byId?.get(parseInt(key, 10)), sum);
  return sum;
}
// Per-episode fields in /api/episodes: only when known (omitted otherwise).
function episodeAudioFields(sum) {
  const f = surroundLib.audioFields(sum);
  if (!f.audio_channels) return {};
  return { audio_channels: f.audio_channels, audio_codec: f.audio_codec, audio_format: f.audio_format, audio_badge: f.audio_badge };
}
function seriesAudioSummary(seriesId) {
  const s = seriesAudio[String(seriesId)];
  return s && s.channels ? s : null;
}
// Records a get_vod_info answer: video verdict + audio into qualityCache.
// Video dims unknown (panel probed nothing but audio) -> is4k null (never
// demotes). Returns the entry, or null when the answer had neither.
// Owner panel only writes (qualityCache, misses, index patch are keyed by the
// owner's ids); a member answer is only summarised for the caller.
// `opts.saveDelayMs`: quality-cache save debounce (crawler: 60 s).
function recordPanelVodInfo(movieId, info, actx = currentAccount(), opts = {}) {
  const video = (info && info.video && typeof info.video === "object" && !Array.isArray(info.video)) ? info.video : {};
  const audio = surroundLib.fromPanelAudio(info && info.audio);
  const w = Number(video.width) || 0;
  const h = Number(video.height) || 0;
  if (!w && !h && !audio) return null;
  const entry = {
    w, h,
    codec: video.codec_name || null,
    bitrate: Number(info && info.bitrate) || null,
    is4k: (w || h) ? classifyAs4k(w, h) : null,
    // Audio: codec_name (aac, ac3, eac3, dts, truehd...), channels
    // (2, 6, 8...), layout and profile when the panel's ffprobe sent them.
    audio_codec: audio ? audio.codec : null,
    audio_channels: audio ? audio.channels : 0,
    audio_layout: (info && info.audio && info.audio.channel_layout) || null,
    audio_profile: audio ? audio.profile : null,
    checked_at: Date.now(),
  };
  if (!isOwnerAccount(actx)) {
    // Member panels: keep the pre-surround behaviour for the 4K verdict only
    // (video fields, shared keyspace, as before), never audio / misses /
    // index patches, and never over an owner entry that carries audio.
    const prev = qualityCache[`movie:${movieId}`];
    if ((w || h) && !(prev && "audio_channels" in prev)) {
      qualityCache[`movie:${movieId}`] = { w, h, codec: entry.codec, bitrate: entry.bitrate, is4k: entry.is4k, checked_at: entry.checked_at };
      scheduleQualityCacheSave(opts.saveDelayMs || 500);
    }
    return entry;
  }
  qualityCache[`movie:${movieId}`] = entry;
  scheduleQualityCacheSave(opts.saveDelayMs || 500);
  if (audio && audioCrawlMisses[`movie:${movieId}`]) {
    delete audioCrawlMisses[`movie:${movieId}`];
    scheduleAudioCrawlMissesSave();
  }
  // Patch the in-memory owner index so tiles carry it without a rebuild.
  const numId = parseInt(movieId, 10);
  applyAudioToItem(getIndexesFor(actx).movie?.byId?.get(numId), movieAudioSummary(numId));
  return entry;
}

// Codecs MSE cannot decode (or hls.js silently mis-routes through an
// incompatible decoder). Anything in this set forces a transcode.
const BROWSER_UNSAFE_AUDIO = new Set([
  "mp1", "mp2", "ac3", "eac3", "dts", "dca", "truehd", "pcm_s16le", "pcm_s24le",
]);
// Alive verdicts are stable (codecs don't change for a given channel)
// so we keep them for a week. Dead verdicts can flip back the moment
// the panel rotates CDN hosts or frees a slot, so we re-probe much
// more often — a permanent "off-air" marker on a channel that's
// since come back would be worse than a brief stale-marker window.
const PROBE_ALIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Dead TTL is short because IPTV panels rotate CDN hosts every few
// minutes — a channel that 403'd 5 min ago is often back. We retry
// inside the probe before marking dead, so a confirmed-dead verdict
// is already "3 consecutive fails", which justifies caching it for
// a few minutes rather than re-probing every refresh.
function isProbeFresh(entry) {
  if (!entry || typeof entry.ts !== "number") return false;
  const ttl = entry.dead ? deadTtlMs(entry.dead_reason) : PROBE_ALIVE_TTL_MS;
  return Date.now() - entry.ts < ttl;
}
const audioProbeInflight = new Map();
// Manifest liveness check — short GET with redirect follow. Catches
// the panel-side 403 / 404 / "empty body" failure modes BEFORE we
// pay 1s of ffprobe runtime on a dead channel.
async function _probeManifestOnce(direct, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(direct, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
      signal: controller.signal,
    });
    if (!r.ok) return { alive: false, reason: `http-${r.status}` };
    const text = await r.text();
    if (!text || text.length < 20 || !text.includes("#EXTM3U")) {
      return { alive: false, reason: "empty-manifest" };
    }
    // A header-only playlist (no segments, no variants) is what the provider
    // serves for a broken channel; players spin on it forever.
    if (!manifestHasContent(text)) return { alive: false, reason: "empty-playlist" };
    // A master playlist can look healthy while its variant is an empty
    // media playlist (players then throw/spin). Check the first variant.
    const variant = firstVariantUri(text);
    if (variant) {
      try {
        // Same controller: master + variant share one timeoutMs budget.
        const vr = await fetch(new URL(variant, r.url || direct).href, {
          method: "GET", redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
          signal: controller.signal,
        });
        if (!vr.ok) return { alive: false, reason: `variant-http-${vr.status}` };
        const vt = await vr.text();
        // Dead only if it is clearly an HLS playlist with no segment/variant
        // URIs; anything else (HTML, ...) stays inconclusive -> plays.
        if (vt.includes("#EXTM3U") && !manifestHasContent(vt)) {
          return { alive: false, reason: "empty-playlist" };
        }
      } catch (e) {
        if (e?.name === "AbortError" || e?.name === "TimeoutError") return { alive: false, reason: "timeout" };
      }
    }
    return { alive: true };
  } catch (e) {
    return { alive: false, reason: e?.name === "AbortError" ? "timeout" : "fetch-error" };
  } finally {
    clearTimeout(timer);
  }
}
// Panels flap. A single 403 / timeout from the upstream CDN host is
// not enough to call a channel dead — Cloudflare's anti-abuse layer
// hands those out under load, and the panel's max_connections=1 cap
// throws them when another session displaces the probe slot. Three
// consecutive misses with a small gap is the threshold: a genuinely
// off-air channel keeps failing, a flap recovers on attempt 2 or 3.
async function probeManifestLiveness(direct) {
  let lastReason = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 600));
    const v = await _probeManifestOnce(direct);
    if (v.alive) return v;
    // Two consecutive persistent failures (empty playlist / 404 / 410) are
    // confirmation enough; a third GET only delays the 503.
    if (attempt > 0 && isPersistentDeadReason(v.reason) && isPersistentDeadReason(lastReason)) return v;
    lastReason = v.reason;
  }
  return { alive: false, reason: lastReason };
}
// Liveness-only refresh of a cached verdict, coalesced per channel. One GET
// (3 s); only a PERSISTENT failure (empty-playlist / 404 / 410) is confirmed
// with a second GET before it counts as dead. Timeouts, fetch errors, 403, 429,
// 5xx and blank bodies are inconclusive: nothing is cached and the caller plays.
// Resolves { kind: "dead"|"recovered"|"alive"|"inconclusive", entry }.
// Covers master + first-variant GET together (alive channels measure 1-2 s).
const LIVE_CHECK_TIMEOUT_MS = 3000;
const liveCheckInflight = new Map();
function refreshLiveLiveness(key, direct, entry) {
  if (liveCheckInflight.has(key)) return liveCheckInflight.get(key);
  const p = (async () => {
    let v = await _probeManifestOnce(direct, LIVE_CHECK_TIMEOUT_MS);
    if (!v.alive && isPersistentDeadReason(v.reason)) {
      await new Promise((r) => setTimeout(r, 600));
      const v2 = await _probeManifestOnce(direct, LIVE_CHECK_TIMEOUT_MS);
      v = v2.alive ? v2 : (isPersistentDeadReason(v2.reason) ? v2 : { alive: null, reason: v2.reason });
    } else if (!v.alive) {
      v = { alive: null, reason: v.reason };
    }
    const out = applyLiveCheck(entry, v);
    if (out.kind !== "inconclusive") {
      // A full codec probe may have landed while this check was in flight:
      // on alive, keep that newer entry and only bump its liveness.
      const cur = audioCodecCache[key];
      if (out.kind === "alive" && cur && !cur.dead && (Number(cur.ts) || 0) > (Number(entry?.ts) || 0)) {
        audioCodecCache[key] = { ...cur, live_ts: out.entry.live_ts };
        out.entry = audioCodecCache[key];
      } else {
        audioCodecCache[key] = out.entry;
      }
      scheduleAudioCodecCacheSave();
    }
    return out;
  })().finally(() => liveCheckInflight.delete(key));
  liveCheckInflight.set(key, p);
  return p;
}
function probeChannelAudioCodec(mode, id, actx = currentAccount(), { skipLiveness = false } = {}) {
  const key = `${mode}:${id}`;
  if (audioProbeInflight.has(key)) return audioProbeInflight.get(key);
  const direct = streamUrl(mode, id, "m3u8", actx);
  const p = (async () => {
    // First: is the channel even responding? A dead panel host
    // means ffprobe would just block until our 6s timeout — wasteful
    // and starves the parallel-probe queue. Cheap manifest fetch
    // first; ffprobe only runs on confirmed-alive channels.
    const live = skipLiveness ? { alive: true } : await probeManifestLiveness(direct);
    if (!live.alive && !isPersistentDeadReason(live.reason)) {
      // Inconclusive (timeout / 403 / 5xx / blank): don't cache, don't call it dead.
      audioProbeInflight.delete(key);
      return null;
    }
    if (!live.alive) {
      const entry = {
        audio_codec: null,
        browser_safe: false,
        dead: true,
        dead_reason: live.reason,
        ts: Date.now(),
      };
      audioCodecCache[key] = entry;
      scheduleAudioCodecCacheSave();
      audioProbeInflight.delete(key);
      return entry;
    }
    return new Promise((resolve) => {
      const args = [
        "-v", "error",
        "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36",
        "-select_streams", "a:0",
        "-show_entries", "stream=codec_name",
        "-of", "default=noprint_wrappers=1:nokey=1",
        "-read_intervals", "%+1",
        direct,
      ];
      const proc = spawn("ffprobe", args);
      proc.on("error", () => { audioProbeInflight.delete(key); resolve(null); });
      let buf = "";
      proc.stdout.on("data", d => { buf += d.toString(); });
      proc.stderr.on("data", () => {});
      const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 6000);
      proc.on("close", () => {
        clearTimeout(killTimer);
        const codec = (buf.trim().split("\n")[0] || "").trim().toLowerCase();
        const entry = {
          audio_codec: codec || null,
          browser_safe: !!codec && !BROWSER_UNSAFE_AUDIO.has(codec),
          dead: false,
          ts: Date.now(),
        };
        // Don't cache failed probes — let the next request retry.
        if (codec) {
          audioCodecCache[key] = entry;
          scheduleAudioCodecCacheSave();
        }
        audioProbeInflight.delete(key);
        resolve(entry);
      });
    });
  })();
  audioProbeInflight.set(key, p);
  return p;
}

// Enumerate the audio tracks of a panel VOD (movie/series) via a network
// ffprobe, cached per id. Returns { audioTracks: [{ index, codec,
// channels, lang, label, default }] }. `index` is the ffmpeg 0:a:N
// ordinal the transcoder maps via ?at=. Mirrors analyzeDiskFile's track
// shape but over the panel URL instead of a local path. Empty/failed
// probes aren't cached so they retry; a successful one is persisted.
const panelTracksProbeInflight = new Map();
// True when a viewer is ACTIVELY streaming (touched within windowMs), unlike
// streamingNow which also counts a stale previous stream inside the idle grace.
function streamingRecently(actx, windowMs = 60000) {
  return streamingRecentlyIn(streams, actx ? accountKeyOf(actx) : null, windowMs);
}
function anyProbeInflight() {
  return panelTracksProbeInflight.size > 0 || audioProbeInflight.size > 0;
}
// Guarded entry: never opens a panel connection while a viewer is actively
// streaming (returns {audioTracks: [], busy: true}, uncached), and never runs
// two probes at once (waits, bounded, for the in-flight one first).
async function probePanelTracks(mode, id, ext, actx = currentAccount()) {
  const key = `${mode}:${id}`;
  const fresh = () => {
    const c = panelTracksCache[key];
    return c && typeof c.ts === "number" && Date.now() - c.ts < PROBE_ALIVE_TTL_MS ? c : null;
  };
  if (fresh()) return fresh();
  if (panelTracksProbeInflight.has(key)) return panelTracksProbeInflight.get(key);
  if (streamingRecently(actx)) return { audioTracks: [], busy: true };
  if (anyProbeInflight()) {
    const others = [...panelTracksProbeInflight.values(), ...audioProbeInflight.values()].map((p) => p.catch(() => {}));
    let timer;
    await Promise.race([Promise.all(others), new Promise((r) => { timer = setTimeout(r, 9500); })]);
    clearTimeout(timer);
    if (fresh()) return fresh();
    if (panelTracksProbeInflight.has(key)) return panelTracksProbeInflight.get(key);
    if (streamingRecently(actx) || anyProbeInflight()) return { audioTracks: [], busy: true };
  }
  return runPanelTracksProbe(mode, id, ext, actx);
}
function runPanelTracksProbe(mode, id, ext, actx) {
  const key = `${mode}:${id}`;
  const direct = streamUrl(mode, id, ext, actx);
  const p = new Promise((resolve) => {
    const args = [
      "-v", "error", "-print_format", "json",
      "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36",
      // stream_disposition (not "disposition" inside stream=): the latter
      // silently returns no disposition, so `default` was always false.
      "-show_entries", "stream=index,codec_type,codec_name,channels:stream_disposition=default,comment,visual_impaired:stream_tags=language,title",
      direct,
    ];
    const proc = spawn("ffprobe", args);
    let buf = "";
    proc.stdout.on("data", (d) => { buf += d.toString(); });
    proc.stderr.on("data", () => {});
    const killTimer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 9000);
    proc.on("close", () => {
      clearTimeout(killTimer);
      const audioTracks = [];
      try {
        const j = JSON.parse(buf);
        let ai = 0;
        for (const st of (j.streams || [])) {
          if (st.codec_type !== "audio") continue;
          const lang = st.tags?.language || null;
          const title = st.tags?.title || null;
          audioTracks.push({
            index: ai,
            codec: st.codec_name || null,
            channels: st.channels || null,
            lang,
            label: title || langLabel(lang) || `Audio ${ai + 1}`,
            default: !!st.disposition?.default,
            comment: !!st.disposition?.comment,
            visualImpaired: !!st.disposition?.visual_impaired,
          });
          ai++;
        }
      } catch {}
      const entry = { audioTracks, ts: Date.now() };
      // Only cache a non-empty probe — an empty result is usually a
      // transient panel hiccup, not a genuinely audio-less file.
      if (audioTracks.length) {
        panelTracksCache[key] = entry;
        schedulePanelTracksCacheSave();
      }
      panelTracksProbeInflight.delete(key);
      resolve(entry);
    });
    proc.on("error", () => {
      clearTimeout(killTimer);
      panelTracksProbeInflight.delete(key);
      resolve({ audioTracks: [] });
    });
  });
  panelTracksProbeInflight.set(key, p);
  return p;
}

// Learned track lists: the transcoder's ffmpeg prints the input's stream
// list on stderr as it opens the file, so a title that's being transcoded
// gets its Audio menu with ZERO extra provider connections (the ffprobe
// above is a second connection and is refused while anyone streams).
// Same entry shape as runPanelTracksProbe. Waiters are /api/tracks calls
// parked until the running transcoder's dump lands.
const panelTracksLearner = audioTracksLib.createTrackLearner({ cache: panelTracksCache, onSave: schedulePanelTracksCacheSave });
const learnPanelTracks = (mode, id, tracks) => panelTracksLearner.learn(mode, id, tracks);
const waitForLearnedTracks = (mode, id, ms) => panelTracksLearner.waitFor(mode, id, ms);
// A transcoder for this title is running or starting (its ffmpeg will
// report the track list soon).
// The track the newest running transcoder for this title maps (an auto
// pick may have restarted it), or null.
function currentTranscodeTrack(mode, id) {
  const prefix = `${mode}-${id}-`;
  let best = null;
  for (const [k, t] of transcoders) {
    if (k.startsWith(prefix) && !t.stopping && (!best || (t.startedAt || 0) > (best.startedAt || 0))) best = t;
  }
  return best ? (best.audioRestartTo ? best.audioRestartTo.index : best.audioTrack || 0) : null;
}
function transcoderActiveFor(mode, id) {
  const prefix = `${mode}-${id}-`;
  for (const k of transcoders.keys()) if (k.startsWith(prefix)) return true;
  for (const k of transcoderInflight.keys()) if (k.startsWith(prefix)) return true;
  return false;
}

// Per-title audio-pick context from the last /api/stream call (the
// transcode routes are pre-auth and have no profile): the title's
// original language and the requesting profile's audioLangPrefs.
const audioPickHints = new Map(); // `${mode}:${id}` -> { originalLang, prefs, at }
function setAudioPickHint(mode, id, hint) {
  const key = `${mode}:${id}`;
  audioPickHints.delete(key);
  audioPickHints.set(key, { ...hint, at: Date.now() });
  while (audioPickHints.size > 500) audioPickHints.delete(audioPickHints.keys().next().value);
}
function getAudioPickHint(mode, id) {
  const h = audioPickHints.get(`${mode}:${id}`);
  return h && Date.now() - h.at < 12 * 3600 * 1000 ? h : null;
}
// The language this copy's audio should default to (ISO 639-1 or a language
// word), or null. A stream NAME that names one language ("... (Hindi)")
// wins: that copy is the Hindi version even of an English film. Untagged
// copies use the title's original language (TMDB original_language), then
// the item's language-group tag.
function titleOriginalLang(mode, id, seriesId = null) {
  const itemId = mode === "movie" ? id : seriesId;
  const item = itemId ? indexes[mode]?.byId?.get(parseInt(itemId, 10)) : null;
  const tkey = mode === "movie" ? `movie:${id}` : (mode === "series" && seriesId ? `series:${seriesId}` : null);
  const t = tkey ? tmdbCache[tkey] : null;
  return audioTracksLib.copyAudioLang({
    nameLang: item ? audioTracksLib.nameLangTag(item.name, AUDIO_LANG_WORDS) : null,
    originalLang: t && t.source !== "no-match" ? t.original_language || null : null,
    tagLang: item ? isoLangForItem(item) : null,
  });
}
// Pick context for a title outside a profile request (transcode/download
// routes are pre-auth): the last /api/stream hint, else title-only.
function audioPickContext(mode, id) {
  const h = getAudioPickHint(mode, id);
  return { originalLang: h ? h.originalLang : titleOriginalLang(mode, id), prefs: h ? h.prefs : null };
}
// The default track from a fresh cached list, or null when unknown.
function cachedAudioPick(mode, id, ctx = audioPickContext(mode, id)) {
  const c = panelTracksCache[`${mode}:${id}`];
  if (!c || typeof c.ts !== "number" || Date.now() - c.ts >= PROBE_ALIVE_TTL_MS || !c.audioTracks?.length) return null;
  return audioTracksLib.chooseAudioTrack(c.audioTracks, ctx).index;
}
// Auto (no at/ap) transcode requests: base key (track 0) -> the key of the
// transcoder actually serving it, so the player's repeated manifest polls
// stay on the running ffmpeg even after the pick/cache changes.
const autoTrackAlias = new Map();
function setAutoTrackAlias(baseKey, key) {
  autoTrackAlias.delete(baseKey);
  autoTrackAlias.set(baseKey, key);
  while (autoTrackAlias.size > 300) autoTrackAlias.delete(autoTrackAlias.keys().next().value);
}

function classifyAs4k(width, height) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  return h >= 2000 || w >= 3200;
}

// Strip the "4k" tag when the quality cache has a verified "not 4k"
// verdict for this item. Pure — returns a possibly-new array, never
// mutates input. Only demotes (never promotes) so live and unverified
// items keep whatever the panel-name regex assigned.
function applyQualityDemotion(mode, id, tags) {
  if (mode !== "movie") return tags;
  if (!Array.isArray(tags) || !tags.includes("4k")) return tags;
  const v = qualityCache[`movie:${id}`];
  if (v && v.is4k === false && (v.w || v.h)) return tags.filter(t => t !== "4k");
  return tags;
}

// Verify a single movie's actual resolution from the panel. Returns
// the cached entry or null on transient panel failure (don't poison
// the cache on transient errors — try again next prewarm).
async function verifyQuality4k(movieId, actx = currentAccount()) {
  const key = `movie:${movieId}`;
  const cached = qualityCache[key];
  if (cached && (Date.now() - (cached.checked_at || 0)) < QUALITY_CACHE_TTL_MS) {
    return cached;
  }
  let info;
  try {
    info = await xtream(MODES.movie.info, { vod_id: movieId }, { actx });
  } catch {
    return null;
  }
  // Neither video dims nor audio = the panel never probed the file: not
  // cached (retried by the next 4K pass), noted for the surround crawler.
  const entry = recordPanelVodInfo(movieId, info && info.info, actx);
  // Only a real answer that carries nothing is a miss; an auth reject /
  // empty shell from a degraded panel is just a failure (retried).
  if (!entry) { if (isOwnerAccount(actx) && isUsableInfo(info, "movie")) noteAudioMiss(movieId); return null; }
  return entry;
}

function noteAudioMiss(movieId) {
  audioCrawlMisses[`movie:${movieId}`] = Date.now();
  scheduleAudioCrawlMissesSave();
}

// Surround crawler (lib/surround createAudioCrawler): fills panel movie audio
// info one get_vod_info at a time (a metadata call, never a stream), every
// SURROUND_CRAWL_INTERVAL_MS (default 4 s). Order: titles a client was just
// shown without audio data (home rails incl. For You, search), then 4K-tagged,
// then newest additions. Owner panel only (qualityCache is keyed by the owner's
// ids). Results persist in quality-cache.json / audio-crawl-misses.json, so a
// restart resumes. SURROUND_CRAWL=0 turns it off.
const SURROUND_CRAWL_INTERVAL_MS = Math.max(1000, parseInt(process.env.SURROUND_CRAWL_INTERVAL_MS, 10) || 4000);
const audioKnown = (id) => {
  const q = qualityCache[`movie:${id}`];
  return (!!q && ("audio_channels" in q)) || audioMissFresh(id);
};
// Always the owner panel + owner index, whatever async context started it.
const ownerMovieIndex = () => getIndexesFor(getOwnerAccount()).movie;
const surroundCrawler = surroundLib.createAudioCrawler({
  intervalMs: SURROUND_CRAWL_INTERVAL_MS,
  isKnown: (id) => audioKnown(id) || !ownerMovieIndex()?.byId?.has(id),
  candidates: () => (ownerMovieIndex()?.ready ? surroundLib.sweepOrder(ownerMovieIndex().byId.values()) : []),
  // Metadata calls don't use the stream slot, but stay out of the way while
  // anyone is watching (same rule as the other background panel passes).
  shouldYield: () => streamingNow(getOwnerAccount()),
  probe: async (id) => {
    const actx = getOwnerAccount();
    let info;
    try {
      // noCache: a crawl must not pin ~10k info answers in the 24 h memory cache.
      info = await xtream(MODES.movie.info, { vod_id: id }, { actx, timeout: 20_000, noCache: true });
    } catch (e) {
      // Only "this title is gone" is a miss; anything else (403 at the
      // connection cap, 429, HTML maintenance pages) is transient.
      if (/^Panel (404|410)\b/.test(String(e && e.message))) { noteAudioMiss(id); return "none"; }
      throw e;
    }
    if (!isUsableInfo(info, "movie")) throw new Error("unusable info answer");
    const entry = recordPanelVodInfo(id, info.info, actx, { saveDelayMs: 60_000 });
    if (!entry || !entry.audio_channels) { if (!entry) noteAudioMiss(id); return "none"; }
    return "found";
  },
  log: (m) => console.log(m),
});
function startSurroundCrawler() {
  if (process.env.SURROUND_CRAWL === "0") return;
  surroundCrawler.start();
}
// Called with the ids a client is being shown (rail/search tiles) whose
// audio is unknown: they jump the crawl queue.
function boostSurroundCrawl(items) {
  if (process.env.SURROUND_CRAWL === "0" || !isOwnerAccount(currentAccount())) return;
  const ids = [];
  for (const t of items) if (t && t.id != null && !t.audio_channels) ids.push(t.id);
  if (ids.length) surroundCrawler.boost(ids.slice(0, 400));
}

// Background pass that walks every in-memory movie tagged "4k" and
// verifies it against the panel's video metadata. Demotes the in-
// memory s.tags directly when not real 4K so subsequent
// /api/index/{mode} emissions reflect the truth without a rebuild.
// Fires on boot + after each movie buildIndex completes. Skips
// series (per-episode resolution would need a separate per-season
// probe) and live (no API-level resolution metadata).
const QUALITY_PREWARM_CONCURRENCY = 3;
async function prewarmQualityCache(actx = currentAccount()) {
  const ix = getIndexesFor(actx).movie;
  if (!ix?.ready) return;
  // Skips titles whose info recently carried nothing (panel never probed
  // the file): re-asking every index build only loads the panel.
  const candidates = [...ix.byId.values()].filter(s =>
    Array.isArray(s.tags) && s.tags.includes("4k") && !audioMissFresh(s.id)
  );
  if (!candidates.length) return;
  const startedAt = Date.now();
  console.log(`[quality] movie: verifying ${candidates.length} items tagged 4k`);
  let i = 0;
  let demoted = 0;
  let verified = 0;
  let failed = 0;
  await Promise.all(Array.from({ length: QUALITY_PREWARM_CONCURRENCY }, async () => {
    while (i < candidates.length) {
      const s = candidates[i++];
      await yieldToViewers("quality prewarm", actx);
      const v = await verifyQuality4k(s.id, actx).catch(() => null);
      if (!v) { failed++; continue; }
      verified++;
      if (v.is4k === false) {
        const idx = s.tags.indexOf("4k");
        if (idx >= 0) { s.tags.splice(idx, 1); demoted++; }
      }
    }
  }));
  console.log(`[quality] movie: verified ${verified}, demoted ${demoted}, failed ${failed} in ${((Date.now()-startedAt)/1000).toFixed(1)}s`);
}

// In-memory call cache + dedup, mirrors xtream(). 24h TTL — TMDB
// search results are stable enough.
const tmdbMemCache = new Map();
const tmdbInflight = new Map();
const TMDB_TTL_MS = 24 * 60 * 60 * 1000;
async function tmdb(action, params = {}) {
  if (!TMDB_API_KEY) return null;
  const qs = new URLSearchParams(params).toString();
  const key = action + (qs ? `?${qs}` : "");
  const hit = tmdbMemCache.get(key);
  if (hit && Date.now() - hit.t < TMDB_TTL_MS) return hit.v;
  if (tmdbInflight.has(key)) return tmdbInflight.get(key);
  const url = `https://api.themoviedb.org/3${action}${qs ? `?${qs}` : ""}`;
  const p = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, {
          headers: {
            "Authorization": `Bearer ${TMDB_API_KEY}`,
            "Accept": "application/json",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 429) {
          const wait = Math.max(parseInt(res.headers.get("Retry-After") || "10", 10), 5) * 1000;
          console.warn(`tmdb ${action} → 429, retrying in ${wait / 1000}s`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) {
          console.warn(`tmdb ${action} → HTTP ${res.status}`);
          return null;
        }
        const v = await res.json();
        tmdbMemCache.set(key, { t: Date.now(), v });
        return v;
      } catch (e) {
        console.warn(`tmdb ${action} failed: ${e.message}`);
        return null;
      }
    }
    console.warn(`tmdb ${action} → gave up after repeated 429s`);
    return null;
  })().finally(() => tmdbInflight.delete(key));
  tmdbInflight.set(key, p);
  return p;
}

// Project a TMDB movie/tv detail response into the shape we cache and
// return to clients. Centralized so the /movie and /tv variants stay
// consistent.
// Pull a US-region certification out of TMDB's release_dates (movies)
// or content_ratings (TV) blocks. Falls back to "" if absent. We only
// look at US ratings — TMDB has per-country certs but US ones are the
// most consistently populated and the rating ladder is well-known
// (G, PG, PG-13, R, NC-17 / TV-Y, TV-Y7, TV-G, TV-PG, TV-14, TV-MA).
function extractUsCert(mode, detail) {
  if (!detail) return "";
  // "disk" is a flat movie-style library (see CLAUDE.md) — treat anything
  // that isn't literally "series" as movie-shaped, so disk items route to
  // the same TMDB movie fields/endpoints as panel movies instead of falling
  // into the TV branch by default.
  if (mode !== "series") {
    const rd = detail.release_dates;
    const us = rd && Array.isArray(rd.results) ? rd.results.find(r => r.iso_3166_1 === "US") : null;
    if (!us || !Array.isArray(us.release_dates)) return "";
    for (const r of us.release_dates) {
      if (r.certification && r.certification.trim()) return r.certification.trim();
    }
    return "";
  }
  // TV
  const cr = detail.content_ratings;
  const us = cr && Array.isArray(cr.results) ? cr.results.find(r => r.iso_3166_1 === "US") : null;
  return us && typeof us.rating === "string" ? us.rating.trim() : "";
}

function projectTmdbDetail(mode, detail, baseTitle) {
  if (!detail || !detail.id) return null;
  // See extractUsCert's comment — disk is movie-shaped, not series-shaped.
  const isMovie = mode !== "series";
  const dateStr = isMovie ? detail.release_date : detail.first_air_date;

  // append_to_response payloads. Each is optional — older callers that
  // didn't request the append simply get an empty array / null.
  const credits = detail.credits || {};
  const cast = Array.isArray(credits.cast)
    ? credits.cast.slice(0, 10).map(c => ({
        name: c.name || "",
        character: c.character || "",
        profile_path: c.profile_path || null,
      })).filter(c => c.name)
    : [];
  // Director (movies) / Creator (TV). Some movies have multiple
  // directors (Coens, Wachowskis) so we return an array.
  const directors = (() => {
    const crew = Array.isArray(credits.crew) ? credits.crew : [];
    if (isMovie) {
      return crew.filter(c => c.job === "Director").map(c => c.name).filter(Boolean);
    }
    return Array.isArray(detail.created_by)
      ? detail.created_by.map(c => c.name).filter(Boolean)
      : [];
  })();

  // Trailer — first official YouTube "Trailer", else first Teaser,
  // else first YouTube video of any type. Stored as the YouTube key
  // so the client can embed via https://www.youtube.com/embed/<key>.
  const trailerKey = pickTrailerKey(detail.videos);

  // Top 1-2 reviews — author + a clipped excerpt. Full review URLs
  // and content are too big for the cache; we keep what's useful for
  // an at-a-glance pull quote.
  const reviews = (detail.reviews && Array.isArray(detail.reviews.results))
    ? detail.reviews.results.slice(0, 2).map(r => ({
        author: r.author || "Anonymous",
        rating: r.author_details?.rating || null,
        excerpt: (r.content || "").slice(0, 400),
      }))
    : [];

  // Semantic tags. TMDB API names the inner array differently per
  // mode: `keywords` for movies, `results` for tv.
  const kwSrc = detail.keywords || {};
  const keywords = (kwSrc.keywords || kwSrc.results || [])
    .slice(0, 15)
    .map(k => k.name)
    .filter(Boolean);

  // Recommendations and similar — just store the tmdb_ids; the client
  // resolves them back to panel items via the existing index lookup
  // (tmdb_id → panel id). Top 20 per type.
  const recIds = (detail.recommendations && Array.isArray(detail.recommendations.results))
    ? detail.recommendations.results.slice(0, 20).map(r => r.id).filter(Boolean)
    : [];
  const similarIds = (detail.similar && Array.isArray(detail.similar.results))
    ? detail.similar.results.slice(0, 20).map(r => r.id).filter(Boolean)
    : [];

  // Franchise / saga membership. Marvel, Bond, MI, John Wick etc.
  // Only present for movies that TMDB has tagged into a collection.
  const collection = detail.belongs_to_collection ? {
    id:            detail.belongs_to_collection.id,
    name:          detail.belongs_to_collection.name,
    poster_path:   detail.belongs_to_collection.poster_path || null,
    backdrop_path: detail.belongs_to_collection.backdrop_path || null,
  } : null;

  return {
    tmdb_id: detail.id,
    tmdb_title: isMovie ? (detail.title || detail.original_title || baseTitle)
                        : (detail.name  || detail.original_name || baseTitle),
    poster_path:   detail.poster_path   || null,
    backdrop_path: detail.backdrop_path || null,
    plot:          detail.overview || null,
    year:          dateStr ? String(dateStr).slice(0, 4) : null,
    // Full date (movie release_date / tv first_air_date) for the
    // "New trailers" rail; older entries get it via backfillReleaseDates.
    release_date:  /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "")) ? String(dateStr) : null,
    rating:        Number.isFinite(detail.vote_average) ? Number(detail.vote_average.toFixed(1)) : null,
    vote_count:    Number.isFinite(detail.vote_count) ? detail.vote_count : 0,
    popularity:    Number.isFinite(detail.popularity) ? Number(detail.popularity.toFixed(2)) : 0,
    runtime:       isMovie ? (Number.isFinite(detail.runtime) ? detail.runtime : null)
                           : (Array.isArray(detail.episode_run_time) && detail.episode_run_time[0]) || null,
    genres:        Array.isArray(detail.genres) ? detail.genres.map(g => g.name).filter(Boolean) : [],
    tagline:       detail.tagline || null,
    // Kept for the match-plausibility guard (lib/tmdb-match.js); not exposed by tmdbToResponse.
    original_title: (isMovie ? detail.original_title : detail.original_name) || null,
    alternative_titles: (() => {
      const alt = detail.alternative_titles || {};
      const arr = Array.isArray(alt.titles) ? alt.titles : Array.isArray(alt.results) ? alt.results : [];
      return [...new Set(arr.map((t) => t && t.title).filter((t) => typeof t === "string" && t && t.length <= 120))].slice(0, 30);
    })(),
    original_language: detail.original_language || null,
    imdb_id:       (detail.external_ids && detail.external_ids.imdb_id) || detail.imdb_id || null,
    // US-region content certification ("PG", "TV-MA", etc.). Used by
    // kids profiles to filter age-inappropriate content. Empty string
    // when TMDB has no rating for this title — kids profiles treat
    // unrated as "hide" by default.
    us_cert:       extractUsCert(mode, detail),
    collection,
    cast,
    directors,
    keywords,
    trailer_key:   trailerKey,
    logo:          pickLogo(detail.images),
    reviews,
    recommendations: recIds,
    similar:       similarIds,
  };
}

// Tile `poster` (lib/poster.js): TMDB poster, else a TMDB/https panel icon,
// else null (the client draws a title card). Never for live channels (their
// icon is a logo, not a poster). A VOD title with no TMDB entry at all is
// queued for a background TMDB lookup so its poster shows up next time.
const { posterUrl } = require("./lib/poster");
const episodeInfoLib = require("./lib/episode-info");
const posterFillTried = new Map(); // "<mode>:<id>" -> ms
let posterFillQueue = null;        // created lazily (createPrewarmQueue is defined later)
function tilePoster(mode, s, t) {
  if (!s || mode === "live") return null;
  const url = posterUrl(t, s.icon);
  // Owner catalog only: tmdbCache keys carry no account, so a member panel's
  // id must never be looked up under its own title.
  if (!t && TMDB_API_KEY && (mode === "movie" || mode === "series") && s.id != null && isOwnerAccount(currentAccount())) queuePosterFill(mode, s);
  return url;
}
function queuePosterFill(mode, s) {
  const key = `${mode}:${s.id}`;
  const now = Date.now();
  const last = posterFillTried.get(key);
  if (last && now - last < 6 * 3600_000) return;
  if (posterFillTried.size > 20_000) posterFillTried.clear();
  posterFillTried.set(key, now);
  if (!posterFillQueue) {
    posterFillQueue = createPrewarmQueue({
      fetcher: (e) => ensureTmdbForItem(e.mode, e.id, { name: e.name, year: e.year, lang: e.lang, tmdbId: e.tmdbId || undefined }),
      isCached: (e) => !!tmdbCache[`${e.mode}:${e.id}`],
      gapMs: 400,
      cap: 300,
      breakerThreshold: 10,
    });
  }
  posterFillQueue.enqueue([{ key, mode, id: s.id, name: s.name, year: s.year, lang: isoLangForItem(s), tmdbId: Number(s.tmdb_id) || null }]);
}

// Public response shape (same fields, but URLs absolutized + flagged
// with source/timestamp metadata callers may want).
function tmdbToResponse(entry) {
  if (!entry) return null;
  // Resolve cast profile paths to absolute URLs at response time so
  // the client doesn't have to know about TMDB_IMG_BASE. w185 is the
  // right size for the ~96px-wide chip the detail page will render.
  const cast = Array.isArray(entry.cast) ? entry.cast.map(c => ({
    name: c.name,
    character: c.character,
    profile: c.profile_path ? `${TMDB_IMG_BASE}/w185${c.profile_path}` : null,
  })) : [];
  return {
    tmdb_id:     entry.tmdb_id || null,
    tmdb_title:  entry.tmdb_title || null,
    poster:      entry.poster_path   ? `${TMDB_IMG_BASE}/w500${entry.poster_path}`   : null,
    backdrop:    entry.backdrop_path ? `${TMDB_IMG_BASE}/w1280${entry.backdrop_path}` : null,
    plot:        entry.plot   || null,
    year:        entry.year   || null,
    rating:      entry.rating || null,
    vote_count:  entry.vote_count || 0,
    popularity:  entry.popularity || 0,
    runtime:     entry.runtime || null,
    genres:      entry.genres || [],
    tagline:     entry.tagline || null,
    original_language: entry.original_language || null,
    imdb_id:     entry.imdb_id || null,
    us_cert:     effCert(entry),
    collection:  entry.collection || null,
    cast,
    directors:   entry.directors || [],
    keywords:    entry.keywords || [],
    trailer_key: entry.trailer_key || null,
    logo:        logoUrl(entry.logo),
    release_date: entry.release_date || null,
    reviews:     entry.reviews || [],
    recommendations: entry.recommendations || [],
    similar:     entry.similar || [],
  };
}

// Find the best TMDB match for a panel-named title. Two-pass: search,
// then full detail fetch to populate runtime/genres/etc.
// Strip panel cruft from a title so TMDB's search relevance scorer
// gets a clean query. Handles in priority order:
//   • trailing year ("(2024)", " 2024.", ".2024")
//   • bracketed quality / language / release tags
//   • dot-separated filename style ("Drive-Away.Dolls" → "Drive-Away Dolls")
//   • trailing single dots / leftover dashes
//   • collapsed whitespace
// Tried in two passes — strict (drop everything after the first
// year), then loose (just normalize separators) — so findTmdbMatch
// can retry if the first pass yields no hits.
// Parenthesised tags the panel appends: audio language ("(English)",
// "(Turkish)", "(Bangla)" + the panel's own misspellings) and release/quality
// words. Only the language ones were stripped before, and only a few, so
// 64% of the unmatched series ("3 Body Problem (English)") were queried
// against TMDB with the tag in the title.
const PANEL_PAREN_TAG_RE = new RegExp(
  "\\((?:(?:hindi|tamil|telugu|teugu|malayalam|malyalam|kannada|kannda|bengali|bangla|gujarati|gujrati|marathi|punjabi|urdu|english|turkish|korean|japanese|chinese|mandarin|cantonese|arabic|spanish|french|german|russian|italian|portuguese|thai|indonesian|malay|persian|farsi|nepali|sinhala|bhojpuri|odia|assamese|pashto|vietnamese|filipino|tagalog|dutch|polish|swedish|multi(?:\\s*audio)?|dual(?:\\s*audio)?|dubbed|sub|subbed|subs|dvd|bluray|hdr|hevc(?:10)?|x26[45]|org|original)(?:\\s+(?:dubbed|dub|subbed|subs?|audio))?(?:\\s+(?:hindi|tamil|telugu|english))?(?:\\s*[,/&+-]\\s*(?:hindi|tamil|telugu|english|malayalam|kannada))*)\\)",
  "gi",
);
function cleanPanelTitle(name, opts = {}) {
  let s = String(name || "");
  // Drop everything after first year-in-parens
  if (opts.strict !== false) {
    s = s.replace(/\((\d{4})\).*$/, "");
  }
  // Strip bracketed tags + commonly-appended quality words
  s = s.replace(/\[[^\]]*\]/g, " ")
       .replace(PANEL_PAREN_TAG_RE, " ")
       .replace(/\b(4K|FHD|UHD|HD|SD|CAM|HDRIP|DVDRIP|BLURAY|WEBRIP|WEBDL|WEB-DL|2160P|1080P|720P|480P|HDR|HEVC|x264|x265|DUAL|MULTI|DUBBED|SUB|SUBS)\b/gi, " ");
  // Dot-separated filename style → spaces (but preserve final ".0" decimals)
  s = s.replace(/\.(?=\D)/g, " ");
  // Trailing standalone year ("Title 1985") — strip when the year is
  // not part of the title proper. We pass year separately to TMDB so
  // the year-in-name is redundant noise.
  s = s.replace(/\s+(19|20)\d{2}\s*$/, "");
  // Tidy
  s = s.replace(/\(\s*\)/g, " ");
  s = s.replace(/\s+/g, " ").replace(/^[-\s.]+|[-\s.]+$/g, "").trim();
  return s;
}

// Fallback dedup key for a duplicate pair that hasn't (yet, or ever)
// resolved a shared tmdb_id — the panel lists the same film twice under
// different categories with different stream ids, and TMDB enrichment
// runs per stream id, so a race or a permanent no-match can leave one
// twin blank while the other has full metadata. Every seenTmdb/dedup
// call site below also checks this so an un-enriched duplicate can't
// silently bypass dedup just because it has no tmdb_id yet to collide
// on. cleanPanelTitle already strips language/quality bracket tags
// ("Movie Name (Hindi)" -> "Movie Name"), so most real duplicates
// collapse to the same key without any extra normalization here — EXCEPT
// a dot-separated filename twin ("The.Gift.2015.1080p"): cleanPanelTitle's
// dot-collapse only fires before a NON-digit (it has to preserve decimals
// like "9.5" in a title), so ".2015" stays glued to the title and never
// matches its parenthesized-style duplicate ("The Gift (2015)"). Verified
// via manual node -e sanity check before shipping — this is exactly the
// "Title.YYYY.quality" convention findTmdbMatch's own loose cleanup pass
// exists to handle (see the strict/loose retry there); pull the year out
// as a token match (dot OR space delimited, not just parens) and strip
// dots more aggressively here, since this key is dedup-only and never
// sent to TMDB (unlike cleanPanelTitle's output).
// dedupTitleKey runs ~6 regexes; it is called for every title on every home/search
// request, so memoize it per stream object (names are immutable per object).
const dedupKeyCache = new WeakMap();
function dedupKeyOf(s) {
  let k = dedupKeyCache.get(s);
  if (k === undefined) { k = dedupTitleKey(s.name); dedupKeyCache.set(s, k); }
  return k;
}
function dedupTitleKey(name) {
  const raw = String(name || "");
  const yearMatch = raw.match(/\((19|20)\d{2}\)/) || raw.match(/[.\s](19|20)\d{2}(?=[.\s]|$)/);
  const year = yearMatch ? yearMatch[0].replace(/[()\s.]/g, "") : "";
  const cleaned = cleanPanelTitle(raw)
    .replace(/\b(19|20)\d{2}\b/g, " ")
    // Apostrophes drop out entirely (no space) so "It's" and "Its"
    // converge, not diverge into "it s" vs "its".
    .replace(/['’]/g, "")
    // Remaining punctuation that differs between a dot-filename twin
    // (which never carries it) and a "clean" title twin (which might —
    // a colon subtitle separator, etc.) — e.g. "Avatar.The.Way.of.Water"
    // vs "Avatar: The Way of Water" only differ by the colon. Strip
    // everything but letters/digits/marks/spaces for this key. \p{M}
    // (not just \p{L}\p{N}) is required — Devanagari/Bengali/Gurmukhi
    // vowel signs are combining-mark codepoints, several of them \p{Mc}
    // (spacing mark) rather than \p{L}, so \p{L}\p{N} alone silently
    // shredded Hindi/Bengali titles into disconnected letter fragments
    // ("शोले" -> "श ले") — caught via manual testing against this
    // catalog's actual language mix before shipping, not a hypothetical.
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  // A blank/unparseable name would otherwise collapse every such item
  // onto the same "|" key, silently hiding all but the first — return
  // null so call sites skip the title check for these instead (falling
  // back to tmdb_id-only dedup, or none, which never merges wrongly).
  if (!cleaned) return null;
  return `${cleaned}|${year}`;
}

const tmdbTitleWords = (t) => String(t || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
// TMDB's search is fuzzy and latches onto longer titles that merely contain
// the query ("Mark" -> "Question Mark", "Lost" -> "Aquaman and the Lost
// Kingdom"). For short queries a longer candidate is accepted only if it IS
// the title, or the query followed by a subtitle ("Dune" -> "Dune: Part Two").
function tmdbTitleOk(query, r) {
  const q = tmdbTitleWords(query).replace(/^the /, "");
  if (!q) return true;
  const names = [r.title, r.name, r.original_title, r.original_name].filter(Boolean);
  // Reject only the clearly-wrong class: a SHORT query that appears inside
  // a longer candidate title but not at its start ("Mark" -> "Question
  // Mark", "Lost" -> "Aquaman and the Lost Kingdom", "Home" -> "Spider-Man:
  // No Way Home"). Prefix extensions ("Harry Potter" -> "Harry Potter and
  // the Sorcerer's Stone", "Rocky" -> "Rocky II") and unrelated/alternate
  // titles (translations) pass, as they did before.
  if (q.split(" ").length > 2) return true;
  for (const n of names) {
    const w = tmdbTitleWords(n).replace(/^the /, "");
    if (!w || w === q || w.startsWith(q + " ") || w.startsWith(q)) return true;
  }
  const containsInner = names.some((n) => {
    // "Dirilis: Ertugrul" — the query IS the whole subtitle: fine.
    const after = String(n).split(":").slice(1).join(":");
    if (after && tmdbTitleWords(after).replace(/^the /, "") === q) return false;
    const w = " " + tmdbTitleWords(n) + " ";
    return w.includes(" " + q + " ");
  });
  return !containsInner;
}
const tmdbExactTitle = (query, r) => {
  const q = tmdbTitleWords(query);
  return !!q && [r.title, r.name, r.original_title, r.original_name].filter(Boolean).some((n) => tmdbTitleWords(n) === q);
};
async function findTmdbMatch(mode, name, hintYear, langHint, forcedKind) {
  // Disk-mode Save-to-Disk episodes are named "Series Name SxxEyy - ..."
  // (see diskDownloadDestPath) — genuinely TV content saved into the flat
  // movie-style Disk library, NOT a movie. "disk" is movie-shaped in
  // general (see extractUsCert's comment) but this ONE filename shape is
  // the exception: searching the raw episode title against TMDB's movie
  // endpoint can never find a TV series. Detect it from the name itself
  // (not from `mode`, since a real disk MOVIE must still route as movie)
  // and route this call as series-shaped, querying just the series name.
  // Individual episode files no longer reach this function directly once
  // buildDiskIndex groups them (see stableDiskSeriesId) — this stays as
  // defense-in-depth for any episode-shaped file reached some other way.
  // `forcedKind` (used for the series-GROUP tile itself, whose name is
  // just the clean series name — nothing here to detect it from) wins
  // over both.
  const episodeMatch = !forcedKind && mode === "disk" ? String(name || "").match(/^(.+?)\s+S(\d{2})E(\d{2})\b/i) : null;
  const effMode = forcedKind || (episodeMatch ? "series" : mode);
  const queryName = episodeMatch ? episodeMatch[1].trim() : name;
  const action = effMode !== "series" ? "/search/movie" : "/search/tv";
  // Effective release year. The panel's movie list usually has NO year
  // field — the year lives only in the title ("Blind (2023)"). Parse it
  // from the name as a fallback. Without a year, a generic query like
  // "Blind" returns TMDB's most-popular hit ("The Blind Side", 2009)
  // instead of the 2023 film that's actually in the catalog — the wrong
  // poster/plot/cert on a correctly-named, correctly-playing title.
  // Only a PARENTHESIZED year is authoritative ("Blind (2023)"). A bare
  // in-title number is usually part of the title (Blade Runner 2049,
  // 1917, 2012) — using it would wrongly reject the correct match, and
  // TMDB's `year` param is an exact filter that would zero the search.
  const yearFromName = (() => {
    const m = String(name || "").match(/\((19|20)\d{2}\)/);
    return m ? m[0].replace(/[()]/g, "") : null;
  })();
  // Prefer the authoritative parenthesized title year over the panel's
  // (looser) year field, so the anchor and the exact/±1 tolerance agree.
  const effYearStr = yearFromName || (hintYear ? String(hintYear).slice(0, 4) : null);
  const effYear = effYearStr && /^\d{4}$/.test(effYearStr) ? parseInt(effYearStr, 10) : null;
  // Try the strict cleanup first; if it returns nothing, fall back to
  // a looser one. Many panel titles use ".Title.YYYY" style filenames
  // that the strict pass leaves as garbage; the loose pass collapses
  // dot-separators into spaces and tries again.
  const widePassDone = new Set();
  for (const strict of [true, false]) {
    const cleaned = cleanPanelTitle(queryName, { strict });
    if (!cleaned) continue;
    const params = { query: cleaned };
    if (effYear) params[effMode !== "series" ? "year" : "first_air_date_year"] = String(effYear);
    const searchRes = await tmdb(action, params);
    const results = searchRes && Array.isArray(searchRes.results) ? searchRes.results : [];
    if (!results.length) continue;
    // Narrow to year-valid candidates first (within ±1 of a known year),
    // rejecting the popular-but-wrong-year top hit. If none, fall through
    // to the loose pass and ultimately no-match — a retry beats a
    // confidently-wrong poster. Then, among the year-valid pool, prefer
    // the result whose original_language matches the item's language tag
    // (langHint) so a generic title ("Blind") picks the right regional
    // film instead of a more-popular foreign one.
    const yearOf = (r) => parseInt((r.release_date || r.first_air_date || "").slice(0, 4), 10);
    // The PARENTHESIZED year in a panel title ("Odyssey (2025)") is
    // authoritative, so require an EXACT-year match — the old ±1 tolerance let
    // a buzzy neighbour-year film (Christopher Nolan's "The Odyssey", 2026)
    // hijack the poster of a different 2025 film and play the wrong file. This
    // is release-independent: a "2025" title can never match a 2026 film, out
    // or not. The ±1 tolerance survives only for a looser panel year field on
    // titles that carry no parenthesized year. (We deliberately do NOT reject
    // future-dated matches — this catalog carries pre-retail CAM/screener rips
    // of not-yet-released films, which are legitimately in it.)
    const yearTol = yearFromName ? 0 : 1;
    let pool = effYear
      ? results.filter((r) => { const y = yearOf(r); return Number.isFinite(y) && Math.abs(y - effYear) <= yearTol; })
      : results;
    pool = pool.filter((r) => tmdbTitleOk(cleaned, r));
    // The panel often dates a film one year off (2,000+ cached matches differ
    // by exactly 1). With an authoritative title year the exact pass found
    // nothing — retry WITHOUT TMDB's exact-year filter and accept a neighbour
    // year only when the TITLE matches exactly, so a buzzy neighbour-year
    // film with a different title still can't hijack the entry.
    if (effYear && yearFromName && !pool.length && !widePassDone.has(cleaned)) {
      widePassDone.add(cleaned);
      const wide = await tmdb(action, { query: cleaned });
      const wr = wide && Array.isArray(wide.results) ? wide.results : [];
      // Neighbour year only on an exact title AND a compatible language (a
      // generic title absent from TMDB must not grab a same-named film).
      pool = wr.filter((r) => {
        const y = yearOf(r);
        if (!Number.isFinite(y) || Math.abs(y - effYear) !== 1 || !tmdbExactTitle(cleaned, r)) return false;
        return !(langHint && r.original_language && r.original_language !== langHint);
      });
    }
    if (!pool.length) continue;
    // Prefer an exact-title candidate, then the profile language, then rank.
    const exact = pool.filter((r) => tmdbExactTitle(cleaned, r));
    const pick = (langHint && exact.find((r) => r.original_language === langHint))
      || (langHint && pool.find((r) => r.original_language === langHint))
      || exact[0] || pool[0];
    // Fetch the full detail so runtime/genres etc. populate.
    // append_to_response folds certification + credits + videos +
    // reviews + keywords + recommendations + similar + external_ids
    // into one call (TMDB allows up to 20 appends).
    const detailAction = effMode !== "series" ? `/movie/${pick.id}` : `/tv/${pick.id}`;
    const detail = await tmdb(detailAction, { append_to_response: TMDB_DETAIL_APPENDS(effMode), include_image_language: "en,null" });
    const projected = projectTmdbDetail(effMode, detail || pick, cleaned);
    // Stamped so a later refetchTmdbDetail (cert backfill, cache-schema
    // upgrade) knows this entry is TV-shaped even though its cache key is
    // "disk:<id>" — without this it would default back to disk's normal
    // movie-shaped assumption and hit /movie/<id> with a TV show's id.
    if (projected && (episodeMatch || forcedKind)) projected.tmdb_kind = forcedKind || "series";
    return projected;
  }
  return null;
}

// All the append_to_response payloads we want bundled into the base
// detail call. Cert is mode-specific (movies use release_dates,
// TV uses content_ratings); everything else is the same shape on
// both endpoints, so we can share one comma-joined string.
const TMDB_DETAIL_APPENDS = (mode) => {
  const cert = mode !== "series" ? "release_dates" : "content_ratings";
  return [
    cert,
    "credits",
    "videos",
    "images",
    "reviews",
    "keywords",
    "recommendations",
    "similar",
    "external_ids",
    "alternative_titles",
  ].join(",");
};

// Re-fetch TMDB detail for an already-matched item by tmdb_id. Used
// to backfill new fields on old cache entries without re-running the
// search step. `kindOverride` ("movie"|"series"), when given, wins over
// `mode`'s default assumption — needed for a disk-mode Save-to-Disk
// episode entry (cache key "disk:<id>"), which findTmdbMatch stamps
// `tmdb_kind: "series"` on since its tmdb_id is a TV show's, not a
// movie's, even though disk mode is movie-shaped by default. Returns
// the projected entry, or null on failure.
async function refetchTmdbDetail(mode, tmdbId, kindOverride) {
  const effMode = kindOverride || mode;
  const detailAction = effMode !== "series" ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
  const detail = await tmdb(detailAction, { append_to_response: TMDB_DETAIL_APPENDS(effMode), include_image_language: "en,null" });
  if (!detail) return null;
  const projected = projectTmdbDetail(effMode, detail, detail.title || detail.name || "");
  if (projected && kindOverride) projected.tmdb_kind = kindOverride;
  return projected;
}

// Guard for a freshly fetched/searched match (see tmdbPlausibility). Judges with
// the SAME {name, year, tags} the cache view uses (owner index / boot hints) when
// known, falling back to the caller's hints (e.g. the info route may have no item).
// Skipped for disk / forced-kind lookups and when there is no stream name.
function tmdbHintsPlausible(mode, hints, projected, viaPanelId, key) {
  if (!projected || (hints && hints.forcedKind)) return { ok: true };
  const info = (key && tmdbStreamInfo(key)) || hints;
  if (!info || !info.name) return { ok: true };
  const v = tmdbPlausibility(mode, info, projected, viaPanelId);
  if (!v.ok) console.log(`[tmdb] rejected implausible match ${mode} "${info.name}" -> "${projected.tmdb_title}" (${v.reason})`);
  return v;
}
// Record a guard rejection without destroying data: an existing raw tmdb entry
// is kept (marked guard_rejected) so the view returns no-match but a false
// positive can be undone via /api/admin/tmdb-accept; otherwise store a no-match.
function tmdbStoreRejection(cacheKey, rejectedTmdbId, reason) {
  const raw = tmdbStore[cacheKey];
  if (raw && raw.source === "tmdb" && raw.tmdb_id) {
    tmdbStore[cacheKey] = markGuardRejected(raw, reason, rejectedTmdbId);
  } else {
    tmdbStore[cacheKey] = { tmdb_id: null, source: "no-match", checked_at: Date.now(), rejected_tmdb_id: rejectedTmdbId || null, guard_rejected: reason };
  }
  tmdbGuard.invalidate(cacheKey);
  scheduleTmdbCacheSave();
  return tmdbCache[cacheKey];
}

// Entry point used by the /api/poster routes. Reads cache (with negative
// TTL respect), searches if needed, persists, returns the public shape.
async function ensureTmdbForItem(mode, id, panelHints) {
  const cacheKey = `${mode}:${id}`;
  // Manual override (data/tmdb-overrides.json): null = pinned no-match, number = pinned id.
  if (hasTmdbOverride(cacheKey)) {
    const ov = tmdbOverrides[cacheKey];
    if (ov === null) {
      // Pinned no-match: served by the view; the raw entry is kept untouched so
      // clearing the override restores the original match.
      return tmdbCache[cacheKey];
    }
    const cur = tmdbStore[cacheKey];
    if (cur && cur.source === "tmdb" && cur.tmdb_id === ov) return cur;
    const forced = await refetchTmdbDetail(mode, ov);
    if (forced) {
      const entry = { ...forced, source: "tmdb", checked_at: Date.now(), override: true };
      tmdbStore[cacheKey] = entry;
      scheduleTmdbCacheSave();
      return entry;
    }
    return { tmdb_id: null, source: "no-match", checked_at: Date.now(), override_failed: true };
  }
  panelHints = panelHints || {};
  if (!panelHints.name) {
    // e.g. the info route had no index item: look the stream up from the owner index.
    const si = tmdbStreamInfo(cacheKey);
    if (si) panelHints = { ...panelHints, name: si.name, year: panelHints.year ?? si.year, lang: panelHints.lang ?? isoLangForItem({ tags: si.tags }) };
  }
  const existing = tmdbCache[cacheKey];
  // Cache entries written before the kids-profile feature lack the
  // `us_cert` field. We can backfill by re-hitting the detail endpoint
  // for the known tmdb_id (skipping the search step entirely). After
  // backfill we won't re-fetch again — entries with empty us_cert get
  // stored explicitly.
  const needsCertBackfill = existing
    && existing.source === "tmdb"
    && existing.tmdb_id
    && !("us_cert" in existing);
  if (needsCertBackfill) {
    const refreshed = await refetchTmdbDetail(mode, existing.tmdb_id, existing.tmdb_kind);
    if (refreshed) {
      const entry = { ...refreshed, source: "tmdb", checked_at: Date.now() };
      tmdbCache[cacheKey] = entry;
      scheduleTmdbCacheSave();
      return entry;
    }
    // Detail fetch failed — keep the old entry but stamp us_cert as ""
    // so we don't busy-loop the backfill. The next manual "Refresh
    // poster" will retry properly.
    existing.us_cert = "";
    scheduleTmdbCacheSave();
    return existing;
  }
  if (existing && existing.source === "tmdb") return existing;
  if (existing && existing.source === "no-match"
      && (Date.now() - (existing.checked_at || 0)) < TMDB_NEGATIVE_TTL_MS) {
    return existing;
  }
  // Shortcut: the panel sometimes ships a TMDB id alongside the title
  // (get_vod_info.info.tmdb_id, get_series_info.info.tmdb_id). When
  // present, skip the TMDB title-search step entirely and go straight
  // to the detail fetch — saves one HTTP round-trip per item AND
  // avoids the search-result ambiguity that bit ambiguous titles.
  const hintedId = panelHints && panelHints.tmdbId;
  let panelRejected = null;
  if (hintedId) {
    const refreshed = await refetchTmdbDetail(mode, hintedId);
    // The panel's id is wrong for some streams (e.g. a Punjabi film pointing at
    // "Dune: Part Three"): only trust it if the fetched title is plausible.
    if (refreshed) {
      const v = tmdbHintsPlausible(mode, panelHints, refreshed, true, cacheKey);
      if (v.ok) {
        const entry = { ...refreshed, source: "tmdb", checked_at: Date.now() };
        tmdbCache[cacheKey] = entry;
        scheduleTmdbCacheSave();
        return entry;
      }
      panelRejected = { id: refreshed.tmdb_id, reason: v.reason };
    }
    // Detail fetch with the panel-supplied id failed (or was implausible) —
    // fall through to the search-based path rather than caching a bad miss.
  }
  const match = await findTmdbMatch(mode, panelHints.name, panelHints.year, panelHints.lang, panelHints.forcedKind);
  if (match) {
    const v = tmdbHintsPlausible(mode, panelHints, match, false, cacheKey);
    if (v.ok) {
      const entry = { ...match, source: "tmdb", checked_at: Date.now() };
      tmdbCache[cacheKey] = entry;
      scheduleTmdbCacheSave();
      return entry;
    }
    return tmdbStoreRejection(cacheKey, match.tmdb_id, v.reason);
  }
  if (panelRejected) return tmdbStoreRejection(cacheKey, panelRejected.id, panelRejected.reason);
  const raw = tmdbStore[cacheKey];
  if (raw && raw.source === "tmdb" && raw.tmdb_id) {
    // Nothing plausible came back for an entry the guard hid: keep its data.
    return tmdbStoreRejection(cacheKey, null, tmdbEntryVerdict(cacheKey, raw).reason || "no plausible match on re-resolve");
  }
  const entry = { tmdb_id: null, source: "no-match", checked_at: Date.now() };
  tmdbCache[cacheKey] = entry;
  scheduleTmdbCacheSave();
  return entry;
}

// Background TMDB pre-warm. Fired after a movie / series index finishes
// so the home endpoint has posters + backdrops ready instead of waiting
// for clients to fan out per-tile lookups. Skips items already in
// tmdbCache; only spends an upstream call on the unknown ones. Run at
// a low concurrency so it doesn't interfere with live request latency
// — TMDB tolerates ~50 req/s but we want headroom for actual UI fetches.
const TMDB_PREWARM_CONCURRENCY = 2;
async function prewarmTmdbCache(mode, actx = currentAccount()) {
  if (!TMDB_API_KEY) return;
  if (mode === "live") return;
  const ix = getIndexesFor(actx)[mode];
  if (!ix?.ready) return;
  const items = [...ix.byId.values()];
  const startedAt = Date.now();
  const startCacheSize = Object.keys(tmdbCache).length;
  let i = 0;
  let resolved = 0;
  let lastLog = 0;
  console.log(`[${mode}] tmdb prewarm started: ${items.length} items, ${startCacheSize} cache entries on disk`);
  await new Promise((done) => {
    let active = 0;
    const next = () => {
      if (i >= items.length && active === 0) return done();
      while (active < TMDB_PREWARM_CONCURRENCY && i < items.length) {
        const it = items[i++];
        active++;
        ensureTmdbForItem(mode, it.id, { name: it.name, year: it.year, lang: isoLangForItem(it), forcedKind: it.isSeriesGroup ? "series" : undefined })
          .catch(() => {})
          .finally(() => {
            active--;
            resolved++;
            // Heartbeat every 1000 items so a multi-minute prewarm
            // doesn't go silent.
            if (resolved - lastLog >= 1000) {
              lastLog = resolved;
              const pct = Math.round((resolved / items.length) * 100);
              console.log(`[${mode}] tmdb prewarm: ${resolved}/${items.length} (${pct}%)`);
            }
            next();
          });
      }
    };
    next();
  });
  const added = Object.keys(tmdbCache).length - startCacheSize;
  const took = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[${mode}] tmdb prewarm done: ${resolved} items checked, ${added} new cache entries, ${took}s`);
  if (added) { try { assignVariants(mode, actx); } catch {} }
}

// ──────────────────────────────────────────────────────────────────
// XMLTV bulk EPG indexer. The panel's `xmltv.php` endpoint returns the
// entire EPG for every channel in a single (large) document. Pulling
// it once a night and parsing into an in-memory map means
// /api/epg/short/{streamId} becomes a pure in-memory slice — no panel
// round-trip per visible TV-Guide row. Falls back gracefully to the
// per-channel get_simple_data_table path when a channel isn't covered.
// ──────────────────────────────────────────────────────────────────
const zlib = require("zlib");
const { promisify } = require("util");
const { fixPanelPrograms, calibrateEpgOffsets, cleanEpgIndexOverlaps, shiftsToPersist, epgIdCountry } = require("./lib/epg-clean");
const epgIndex = new Map(); // epg_channel_id → sorted [{ start, stop, title, desc }]
let epgIndexBuiltAt = 0;
const epgIndexFile = path.join(DATA_DIR, "epg-xmltv.json");
// AI-normalized programme titles (owner EPG): { [rawTitle]: { clean,
// type, keywords[] } }. Built incrementally after each EPG refresh via
// normalizeNewEpgTitles() (no-op without ANTHROPIC_API_KEY). Persisted
// so restarts don't re-pay for titles already cleaned. Consumer:
// live keyword matching (searchEpgLive today reads raw titles; a future
// assistant `whats_on` tool reads this map's clean/keywords).
const epgNormalizedFile = path.join(DATA_DIR, "epg-normalized.json");
const epgNormalized = (() => {
  try { return JSON.parse(fs.readFileSync(epgNormalizedFile, "utf8")) || {}; }
  catch { return {}; }
})();
function saveEpgNormalized() {
  try {
    fs.writeFileSync(epgNormalizedFile + ".tmp", JSON.stringify(epgNormalized));
    fs.renameSync(epgNormalizedFile + ".tmp", epgNormalizedFile);
  } catch (e) {
    console.warn(`[epg] save epg-normalized failed: ${e.message}`);
  }
}
const EPG_XMLTV_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min — file can be 5–15 MB
const EPG_XMLTV_STALE_MS   = 6 * 60 * 60 * 1000; // 6h — re-fetch if older
const EPG_REFRESH_MS       = 6 * 60 * 60 * 1000; // polled refresh cadence
// Extra XMLTV sources. The provider's own xmltv.php is nearly empty and
// stale (110 programmes, mostly already aired, as of Nov 2026), so guide
// data comes mainly from free community XMLTV feeds, matched to provider
// channels by id/name (applyEpgMatching). Override with EPG_SOURCES=url,url
// (empty string disables externals).
const EPG_SOURCES_DEFAULT = [
  "https://epgshare01.online/epgshare01/epg_ripper_IN1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_IN2.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_PK1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_UK1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_US_SPORTS1.xml.gz",
  "https://epgshare01.online/epgshare01/epg_ripper_CA2.xml.gz",
  "https://epg.pw/xmltv/epg_IN.xml.gz",
];
const EPG_SOURCES = (process.env.EPG_SOURCES ?? EPG_SOURCES_DEFAULT.join(","))
  .split(",").map((x) => x.trim()).filter(Boolean);
const EPG_PAST_MS = 2 * 60 * 60 * 1000;      // keep programmes that ended <2h ago
const EPG_FUTURE_MS = 72 * 60 * 60 * 1000;   // ...and those starting <72h ahead
// External channel metadata (id -> {names, country}) for name matching;
// persisted alongside the programmes. Status is surfaced in /api/bootstrap.
let epgChannelMeta = new Map();
let epgStatus = { builtAt: 0, channels: 0, programmes: 0, matchedStreams: 0, sources: {} };

function xmltvToMs(str) {
  if (!str || str.length < 14) return 0;
  const y  = +str.slice(0, 4);
  const mo = +str.slice(4, 6) - 1;
  const d  = +str.slice(6, 8);
  const h  = +str.slice(8, 10);
  const mi = +str.slice(10, 12);
  const s  = +str.slice(12, 14);
  let ms = Date.UTC(y, mo, d, h, mi, s);
  const tz = /([+-])(\d{2})(\d{2})\s*$/.exec(str);
  if (tz) {
    const sign = tz[1] === "+" ? 1 : -1;
    ms -= sign * ((+tz[2]) * 60 + (+tz[3])) * 60 * 1000;
  }
  return ms;
}
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ""; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return ""; } });
}
const unCdata = (t) => String(t).replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");

// Tolerant XMLTV parse: attribute order / quote style / extra attributes /
// CDATA all vary by provider (the panel emits `channel="x" >`, which the
// old strict regex missed). Returns {chans: Map(id -> [displayNames]),
// progs: Map(id -> [{start, stop, title, desc}])} limited to the window.
function parseXmltv(text, now = Date.now()) {
  const chans = new Map();
  const CH_RE = /<channel\s+([^>]*?)>([\s\S]*?)<\/channel>/g;
  const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  const attrsOf = (str) => {
    const o = {};
    let a;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(str)) !== null) o[a[1]] = a[2] ?? a[3] ?? "";
    return o;
  };
  let m;
  while ((m = CH_RE.exec(text)) !== null) {
    const id = attrsOf(m[1]).id;
    if (!id) continue;
    const names = [];
    const DN_RE = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let d;
    while ((d = DN_RE.exec(m[2])) !== null) names.push(decodeXmlEntities(unCdata(d[1]).trim()));
    chans.set(id, names);
  }
  const progs = new Map();
  const PROG_RE = /<programme\s+([^>]*?)\s*>([\s\S]*?)<\/programme>/g;
  const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/;
  const DESC_RE = /<desc[^>]*>([\s\S]*?)<\/desc>/;
  const lo = now - EPG_PAST_MS, hi = now + EPG_FUTURE_MS;
  while ((m = PROG_RE.exec(text)) !== null) {
    const a = attrsOf(m[1]);
    const startMs = xmltvToMs(a.start), stopMs = xmltvToMs(a.stop);
    if (!startMs || !stopMs || !a.channel) continue;
    if (stopMs < lo || startMs > hi) continue;
    const tM = TITLE_RE.exec(m[2]);
    const dM = DESC_RE.exec(m[2]);
    const arr = progs.get(a.channel) || [];
    arr.push({
      start: startMs, stop: stopMs,
      title: tM ? decodeXmlEntities(unCdata(tM[1]).trim()) : "",
      desc: dM ? decodeXmlEntities(unCdata(dM[1]).trim()) : "",
    });
    progs.set(a.channel, arr);
  }
  return { chans, progs };
}
async function fetchXmltvText(url, timeoutMs) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const declared = parseInt(r.headers.get("content-length") || "0", 10);
  if (declared > 120 * 1024 * 1024) throw new Error("body too large");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 120 * 1024 * 1024) throw new Error("body too large");
  const isGz = buf[0] === 0x1f && buf[1] === 0x8b;
  return (isGz ? await promisify(zlib.gunzip)(buf, { maxOutputLength: 300 * 1024 * 1024 }) : buf).toString("utf8");
}

// ── Channel matching (provider stream <-> external XMLTV channel) ──
const EPG_COUNTRY_OF_PREFIX = { IN: "in", UK: "uk", GB: "uk", US: "us", CA: "ca", PK: "pk", AU: "au", BD: "bd", ZA: "za", AE: "ae" };
function epgNameKey(name) {
  let n = String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  n = n.replace(/^\|?\s*[A-Za-z]{2,3}\s*(?:\||:)+\s*/, "");        // "IN:" / "|FR|"
  n = n.replace(/\b(?:HD|FHD|UHD|SD|4K|HEVC|BACKUP|RAW|50FPS|1080P?|720P?)\b/gi, " ");
  return n.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function epgPrefixCountry(name) {
  const m = /^\|?\s*([A-Za-z]{2,3})\s*(?:\||:)+\s*/.exec(String(name || ""));
  return m ? (EPG_COUNTRY_OF_PREFIX[m[1].toUpperCase()] || m[1].toLowerCase()) : null;
}
const epgIdKey = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, "");

// Point live streams at an external channel that has programme data.
// Streams whose own epg_channel_id already has programmes are left alone.
// Idempotent; re-run after a live index build and after each EPG refresh.
function applyEpgMatching(actx = currentAccount()) {
  if (!isOwnerAccount(actx)) return 0;
  const ix = getIndexesFor(actx).live;
  if (!ix?.byId?.size || !epgIndex.size) return 0;
  const byName = new Map(), byId = new Map();
  for (const [id, names] of epgChannelMeta) {
    if (!epgIndex.has(id)) continue;
    const country = epgIdCountry(id);
    byId.set(epgIdKey(id), id);
    for (const nm of names) {
      const k = epgNameKey(nm);
      if (!k) continue;
      const arr = byName.get(k) || [];
      arr.push({ id, country });
      byName.set(k, arr);
    }
  }
  let matched = 0;
  for (const s of ix.byId.values()) {
    if (s.epg_channel_id && epgIndex.has(s.epg_channel_id) && !s._epgMatched) continue;
    let hit = s.epg_channel_id ? byId.get(epgIdKey(s.epg_channel_id)) : null;
    if (!hit) {
      const cands = byName.get(epgNameKey(s.name));
      if (cands?.length) {
        const pc = epgPrefixCountry(s.name);
        // No country prefix: only accept an unambiguous (single-candidate) name.
        const best = (pc && cands.find((c) => c.country === pc)) || (!pc && cands.length === 1 ? cands[0] : null);
        if (best) hit = best.id;
      }
    }
    if (!hit && s._epgMatched) {
      // The guide channel we pointed at is gone — restore the provider's id.
      s.epg_channel_id = s._epgOrig || "";
      delete s._epgMatched; delete s._epgOrig;
      continue;
    }
    if (hit) {
      if (!s._epgMatched && s.epg_channel_id && !s._epgOrig) s._epgOrig = s.epg_channel_id;
      s.epg_channel_id = hit; s._epgMatched = true; matched++;
    }
  }
  epgStatus.matchedStreams = matched;
  console.log(`[epg] matched ${matched} live streams to external guide channels`);
  return matched;
}
async function loadEpgIndexFromDisk(actx = currentAccount()) {
  try {
    const raw = await fs.promises.readFile(dataPathFor(actx, "epg"), "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data.byChannel !== "object") return;
    if (isOwnerAccount(actx)) {
      epgIndex.clear();
      for (const [k, v] of Object.entries(data.byChannel)) {
        if (Array.isArray(v)) epgIndex.set(k, v);
      }
      cleanEpgIndexOverlaps(epgIndex); // idempotent; covers files written before the cleanup existed
      epgIndexBuiltAt = data.builtAt || 0;
      if (data.channels && typeof data.channels === "object") epgChannelMeta = new Map(Object.entries(data.channels));
      if (data.status && typeof data.status === "object") epgStatus = data.status;
      const totalProgs = [...epgIndex.values()].reduce((a, b) => a + b.length, 0);
      console.log(`[epg] loaded ${epgIndex.size} channels / ${totalProgs} programmes from disk`);
    } else {
      const e = getEpgIndexFor(actx);
      e.byChannel.clear();
      for (const [k, v] of Object.entries(data.byChannel)) {
        if (Array.isArray(v)) e.byChannel.set(k, v);
      }
      cleanEpgIndexOverlaps(e.byChannel);
      e.builtAt = data.builtAt || 0;
      const totalProgs = [...e.byChannel.values()].reduce((a, b) => a + b.length, 0);
      console.log(`[epg] loaded ${e.byChannel.size} channels / ${totalProgs} programmes from disk (host=${hostHashOf(actx.host)})`);
    }
  } catch {}
}
async function saveEpgIndexToDisk(actx = currentAccount()) {
  try {
    const p0 = dataPathFor(actx, "epg");
    let obj;
    if (isOwnerAccount(actx)) {
      obj = { builtAt: epgIndexBuiltAt, byChannel: Object.fromEntries(epgIndex), channels: Object.fromEntries(epgChannelMeta), status: epgStatus };
    } else {
      const e = getEpgIndexFor(actx);
      obj = { builtAt: e.builtAt, byChannel: Object.fromEntries(e.byChannel) };
    }
    await fs.promises.writeFile(p0 + ".tmp", JSON.stringify(obj));
    await fs.promises.rename(p0 + ".tmp", p0);
  } catch (e) {
    console.warn(`[epg] save failed: ${e.message}`);
  }
}
let epgRefreshRunning = false;
async function prewarmEpg(actx = currentAccount()) {
  if (!actx.host) return false;
  if (epgRefreshRunning) { console.log("[epg] refresh already running — skipping"); return false; }
  epgRefreshRunning = true;
  try { return await prewarmEpgInner(actx); } finally { epgRefreshRunning = false; }
}
async function prewarmEpgInner(actx) {
  const t0 = Date.now();
  const owner = isOwnerAccount(actx);
  const next = new Map();       // channel id -> sorted programmes
  const meta = new Map();       // channel id -> display names (external + provider)
  const sources = {};
  const sourceOf = new Map();   // channel id -> source label that supplied its programmes
  const mergeIn = (label, parsed) => {
    let n = 0;
    for (const [id, names] of parsed.chans) if (!meta.has(id)) meta.set(id, names);
    for (const [id, arr] of parsed.progs) {
      if (!next.has(id)) { next.set(id, arr); sourceOf.set(id, label); n += arr.length; }
    }
    sources[label] = { channels: parsed.progs.size, programmes: n };
  };
  // 1) the panel's own xmltv.php
  try {
    await yieldToViewers("xmltv", actx);
    const url = `${actx.host}/xmltv.php?username=${encodeURIComponent(actx.user)}&password=${encodeURIComponent(actx.pass)}`;
    console.log(`[epg] fetching provider xmltv.php …`);
    // One long provider request: hold Save-to-Disk jobs off for all of it.
    diskDownloadPanelBusy++;
    let text;
    try { text = await fetchXmltvText(url, EPG_XMLTV_TIMEOUT_MS); } finally { diskDownloadPanelBusy--; }
    const parsed = parseXmltv(text);
    if (!parsed.progs.size) console.warn(`[epg] provider xmltv parsed 0 programmes from ${(text.length / 1024).toFixed(0)} KB; head: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    mergeIn("provider", parsed);
  } catch (e) {
    console.warn(`[epg] provider xmltv failed: ${e.message}`);
    sources.provider = { error: redactAllUrls(e.message) };
  }
  // 2) community XMLTV feeds (owner guide only; no provider connection)
  if (owner) {
    for (const url of EPG_SOURCES) {
      if (!/^https:\/\//i.test(url)) { console.warn(`[epg] ignoring non-https source ${redactUrl(url)}`); continue; }
      const label = url.split("/").pop().replace(/\.xml(\.gz)?$/, "");
      try {
        const text = await fetchXmltvText(url, 90_000);
        const parsed = parseXmltv(text);
        if (!parsed.progs.size) console.warn(`[epg] ${label}: 0 programmes parsed from ${(text.length / 1024).toFixed(0)} KB`);
        mergeIn(label, parsed);
        await new Promise((r) => setImmediate(r)); // let the loop breathe between big parses
      } catch (e) {
        console.warn(`[epg] ${label} failed: ${e.message}`);
        sources[label] = { error: redactAllUrls(e.message) };
      }
    }
  }
  for (const arr of next.values()) arr.sort((a, b) => a.start - b.start);
  // Fix mis-labelled source time zones (measured against the epgshare
  // feeds, which carry explicit offsets), then drop merged-schedule
  // overlaps. See lib/epg-clean.js.
  let calibration = null;
  if (owner) {
    try {
      // Only the panel's own feed is shifted; epgshare feeds are the reference.
      const r = calibrateEpgOffsets({
        byChannel: next, names: meta, sourceOf, nameKey: epgNameKey,
        isReference: (l) => /^epg_ripper_/.test(l), isCandidate: (l) => l === "provider",
        previous: shiftsToPersist(epgStatus.calibration?.groups),
      });
      calibration = { shiftedChannels: r.applied.size, groups: r.groups, zeroIds: r.zeroIds };
      for (const gk of r.absent) console.warn(`[epg] ${gk}: no channels this build; remembering its ${r.groups[gk].remembered.shiftMin} min shift (miss ${r.groups[gk].remembered.misses})`);
      for (const [gk, g] of Object.entries(r.groups)) if (g.shiftMin) console.log(`[epg] ${gk}: shifting ${g.channels} channel(s) by ${g.shiftMin} min (${g.reused ? "reused from last build" : `${JSON.stringify(g.votes)} of ${g.calibrated} calibrated`})`);
    } catch (e) {
      // Keep the last known shifts so the next build can still reuse them.
      calibration = { error: e.message, groups: epgStatus.calibration?.groups || {} };
      console.warn(`[epg] offset calibration failed: ${e.message}`);
    }
  }
  const overlaps = cleanEpgIndexOverlaps(next);
  if (overlaps.channels) console.log(`[epg] dropped ${overlaps.programmesDropped} overlapping programme(s) on ${overlaps.channels} channel(s) (e.g. ${overlaps.examples.slice(0, 5).join(", ")})`);
  let total = 0;
  for (const arr of next.values()) total += arr.length;
  // Never replace a populated guide with an empty one (a failed/odd
  // download used to wipe the index and nothing noticed).
  const oldCount = owner ? epgIndex.size : getEpgIndexFor(actx).byChannel.size;
  let oldTotal = 0;
  for (const arr of (owner ? epgIndex : getEpgIndexFor(actx).byChannel).values()) oldTotal += arr.length;
  const failedSources = Object.values(sources).filter((v) => v.error).length;
  if (total > 0 && failedSources > 0 && oldTotal > 0 && total < oldTotal * 0.5) {
    console.warn(`[epg] ${failedSources} source(s) failed and the result (${total}) is under half the current guide (${oldTotal}) — keeping the current guide`);
    if (owner) { epgStatus = { ...epgStatus, sources, lastAttempt: Date.now(), lastError: `${failedSources} source(s) failed`, calibration: epgStatus.calibration ?? null }; saveEpgIndexToDisk(actx); }
    return false;
  }
  if (total === 0) {
    console.warn(`[epg] refresh produced 0 programmes — keeping the existing guide (${oldCount} channels)`);
    if (owner) { epgStatus = { ...epgStatus, sources, lastAttempt: Date.now(), lastError: "0 programmes", calibration: epgStatus.calibration ?? null }; saveEpgIndexToDisk(actx); }
    return false;
  }
  if (owner) {
    epgIndex.clear();
    for (const [k, v] of next) epgIndex.set(k, v);
    epgIndexBuiltAt = Date.now();
    epgChannelMeta = meta;
  } else {
    const e = getEpgIndexFor(actx);
    e.byChannel.clear();
    for (const [k, v] of next) e.byChannel.set(k, v);
    e.builtAt = Date.now();
  }
  console.log(`[epg] indexed ${next.size} channels / ${total} programmes in ${((Date.now() - t0) / 1000).toFixed(1)}s total (${Object.entries(sources).map(([k, v]) => `${k}:${v.programmes ?? "err"}`).join(", ")})`);
  if (owner) {
    epgStatus = { builtAt: epgIndexBuiltAt, channels: next.size, programmes: total, matchedStreams: 0, sources, lastAttempt: Date.now(),
      calibration, overlaps: { channels: overlaps.channels, programmesDropped: overlaps.programmesDropped, emptied: overlaps.emptied } };
    applyEpgMatching(actx);
  }
  saveEpgIndexToDisk(actx);
  // Clean any newly-seen programme titles for keyword matching. Owner
  // EPG only (that's what `epgIndex` holds); fire-and-forget so the
  // refresh return isn't gated on the AI batch. No-op without a key.
  if (owner && ai.aiEnabled()) {
    normalizeNewEpgTitles({ reason: "epg-refresh" }).catch(e => console.warn(`[epg] normalize failed: ${e.message}`));
  }
  return true;
}
function msUntilNextLocalHour(targetHour) {
  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  return target - now;
}
function scheduleEpgNightlyRefresh() {
  // Polled every 6h (guide data is short-horizon, so once a night left most
  // of the day stale). Each run yields to viewers before touching the panel.
  console.log(`[epg] refresh every ${EPG_REFRESH_MS / 3600000}h (${EPG_SOURCES.length} external feeds)`);
  setInterval(() => {
    prewarmEpg().catch(e => console.warn(`[epg] refresh: ${e.message}`));
  }, EPG_REFRESH_MS);
}

// User state PER PROFILE. Netflix-style profiles share one household
// login (APP_USER/APP_PASS) but each profile has its OWN favorites,
// recents, watched, progress, lastEpisode, myList, filter, theme,
// quality, etc. Storage shape on disk:
//
//   data/user-state.json = { "<profileId>": <state>, "<profileId>": <state> }
//
// The legacy shape (top-level state keys directly on the root object)
// is detected on boot and auto-migrated into a default "p1" profile.
const userStateFile = path.join(DATA_DIR, "user-state.json");
const profilesFile  = path.join(DATA_DIR, "users.json");

// Per-mode bucket helpers so adding a mode (e.g. "disk") flows through
// every favorites/myList/recents/filter structure without hand-listing.
function emptyModeBuckets() {
  const o = {};
  for (const m of MODE_KEYS) o[m] = [];
  return o;
}
function pickModeBuckets(src, fallback, cap) {
  const o = {};
  for (const m of MODE_KEYS) {
    o[m] = Array.isArray(src?.[m]) ? (cap ? src[m].slice(0, cap) : src[m]) : (fallback?.[m] || []);
  }
  return o;
}
// Same idea as emptyModeBuckets/pickModeBuckets but for id -> value maps
// (seenSnooze: id -> expiresAtMs) rather than arrays.
function emptyModeObjects() {
  const o = {};
  for (const m of MODE_KEYS) o[m] = {};
  return o;
}
function pickModeObjects(src, fallback, cap) {
  const o = {};
  for (const m of MODE_KEYS) {
    if (src?.[m] && typeof src[m] === "object" && !Array.isArray(src[m])) {
      const entries = Object.entries(src[m])
        .filter(([id, v]) => /^\d+$/.test(id) && Number.isFinite(v))
        .slice(0, cap || 5000);
      o[m] = Object.fromEntries(entries);
    } else {
      o[m] = fallback?.[m] || {};
    }
  }
  return o;
}
function emptyUserState() {
  return {
    favorites: emptyModeBuckets(),
    myList:    emptyModeBuckets(),
    // Explicit taste signal from tile thumbs + the Refine screen. `down`
    // ids are excluded from picks AND sent to Claude as negative signal;
    // `up` counts as a positive like a favorite. Mutually exclusive per
    // id (client enforces); live bucket is unused (thumbs are VOD-only).
    feedback:  { up: emptyModeBuckets(), down: emptyModeBuckets() },
    // "Seen it, not now" — a SOFTER, TEMPORARY exclusion than
    // feedback.down: the viewer liked the title, just doesn't want it
    // re-recommended for a while. Duration (SEEN_SNOOZE_DAYS, 90) is a
    // client-side constant (public/app.js) — the server just trusts
    // whatever expiresAtMs the client computed and pushed, same trust
    // model as every other userState field. Unlike thumbs-down it's
    // mode:id -> expiresAtMs (not an array), is never sent to Claude as
    // a "disliked" signal, and only affects the For You candidate pool
    // — never hides the title from browse/search.
    seenSnooze: emptyModeObjects(),
    recents:   emptyModeBuckets(),
    watched:   [],
    lastEpisode: {},
    progress: {},
    filter: {
      onboarded: false,
      groups: emptyModeBuckets(),
    },
    remoteEnabled: false,
    // Forward hours of EPG to slice from the panel into /api/epg/short.
    // Settable from the Settings UI (cycle pill: 2 / 3 / 5 / 8 / 12 / 24).
    // Default 3h — covers "what's on now and next" without padding the
    // payload on weak TV clients. Capped at 24h server-side. The
    // 1h backward lookback is fixed (programmes already in progress
    // need their block when a row first renders).
    epgWindowHoursForward: 3,
    // Audio languages to prefer (ISO 639-2, e.g. ["hin","eng"]) when a
    // panel VOD title's ORIGINAL language has no matching track. null =
    // unset → DEFAULT_AUDIO_LANG_PREFS (hin, eng). See chooseAudioTrack.
    audioLangPrefs: null,
    // Server-owned (never taken from PUT /api/user-state):
    // seriesId -> { s, e, at }: last episode listed when this profile last
    // opened / played the series (lib/new-episodes.js).
    seriesSeen: {},
    // "Notify me when it lands on Khouch" list (lib/notify-me.js).
    notifyMe: [],
  };
}
function normalizeSeriesSeen(v) {
  const out = {};
  if (!v || typeof v !== "object") return out;
  for (const [sid, m] of Object.entries(v)) {
    if (!/^\d{1,12}$/.test(sid) || !m || !Number.isFinite(m.s) || !Number.isFinite(m.e)) continue;
    out[sid] = { s: m.s, e: m.e, at: Number(m.at) || 0 };
  }
  return out;
}
// Normalize the on-disk shape into the canonical structure (so old
// files with missing keys upgrade safely).
function normalizeUserState(d) {
  const e = emptyUserState();
  if (!d || typeof d !== "object") return e;
  return {
    favorites: pickModeBuckets(d?.favorites, e.favorites),
    myList:    pickModeBuckets(d?.myList, e.myList),
    feedback:  (d?.feedback && typeof d.feedback === "object") ? {
      up:   pickModeBuckets(d.feedback.up,   emptyModeBuckets()),
      down: pickModeBuckets(d.feedback.down, emptyModeBuckets()),
    } : e.feedback,
    seenSnooze: pickModeObjects(d?.seenSnooze, e.seenSnooze),
    recents:   pickModeBuckets(d?.recents, e.recents),
    watched:     Array.isArray(d?.watched)         ? d.watched         : e.watched,
    lastEpisode: d?.lastEpisode && typeof d.lastEpisode === "object" ? d.lastEpisode : e.lastEpisode,
    progress:    d?.progress    && typeof d.progress    === "object" ? d.progress    : e.progress,
    filter:      d?.filter      && typeof d.filter      === "object" ? {
      onboarded: !!d.filter.onboarded,
      groups: pickModeBuckets(d.filter.groups, emptyModeBuckets()),
    } : e.filter,
    remoteEnabled: typeof d?.remoteEnabled === "boolean" ? d.remoteEnabled : e.remoteEnabled,
    epgWindowHoursForward: Math.min(Math.max(parseInt(d?.epgWindowHoursForward, 10) || e.epgWindowHoursForward, 1), 24),
    audioLangPrefs: audioTracksLib.normalizeAudioLangPrefs(d?.audioLangPrefs) || e.audioLangPrefs,
    seriesSeen: normalizeSeriesSeen(d?.seriesSeen),
    notifyMe: notifyMeLib.normalizeList(d?.notifyMe),
  };
}

// Profile portraits are hand-illustrated theatre characters
// served as SVG by public/theatre-portraits.js. The server
// stores only the chosen portrait id; the SVG itself lives
// entirely in the client. Keep this list in sync with the
// PORTRAITS map in public/theatre-portraits.js.
const PORTRAIT_IDS = new Set([
  "chanteuse", "magician", "cat", "strongman", "mime",
  "ringmaster", "lady", "child", "acrobat",
]);
function normalizeAvatar(v) {
  return (typeof v === "string" && PORTRAIT_IDS.has(v)) ? v : null;
}

// In-memory state. Map<profileId, normalized userState>. Loaded at
// boot from disk; mutations call scheduleUserStateSave() to flush.
const profileStates = new Map();

// Profiles registry: { profiles: [...], nextId }. The first profile
// auto-created during migration is "p1" / "You". Future profile IDs
// are assigned sequentially as "p2", "p3", etc.
const profiles = { profiles: [], nextId: 2 };

function loadProfilesFromDisk() {
  try {
    const raw = fs.readFileSync(profilesFile, "utf8");
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.profiles)) {
      profiles.profiles = d.profiles;
      profiles.nextId = Number.isFinite(d.nextId) ? d.nextId : (profiles.profiles.length + 1);
      return true;
    }
  } catch {}
  return false;
}
function saveProfilesToDisk() {
  try {
    fs.writeFileSync(profilesFile + ".tmp", JSON.stringify(profiles));
    fs.renameSync(profilesFile + ".tmp", profilesFile);
  } catch (e) {
    console.warn(`save users.json failed: ${e.message}`);
  }
}

(function loadUserStatesAndMigrate() {
  let raw;
  try { raw = fs.readFileSync(userStateFile, "utf8"); } catch { raw = null; }
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  // Heuristic: legacy shape has `favorites` at the top level. New
  // shape has profile-ID keys ("p1", "p2", …) at the top.
  const isLegacy = parsed && (parsed.favorites || parsed.recents || parsed.myList);
  const hadProfiles = loadProfilesFromDisk();
  if (isLegacy && !hadProfiles) {
    // Single-user data, no profile registry yet → wrap into a default
    // "p1" profile named "You" so the existing user's data carries over.
    const state = normalizeUserState(parsed);
    profileStates.set("p1", state);
    profiles.profiles = [{
      id: "p1",
      nick: "You",
      kidsBirthYear: null,
      createdAt: Date.now(),
    }];
    profiles.nextId = 2;
    saveProfilesToDisk();
    console.log("[profiles] migrated legacy user-state.json into profile p1 (\"You\")");
  } else if (parsed && typeof parsed === "object" && !isLegacy) {
    // Already in the new shape — load each profile's state.
    for (const id of Object.keys(parsed)) {
      profileStates.set(id, normalizeUserState(parsed[id]));
    }
  }
  // If we still have no profiles, seed one for fresh installs.
  if (!profiles.profiles.length) {
    profiles.profiles = [{
      id: "p1",
      nick: "You",
      kidsBirthYear: null,
      createdAt: Date.now(),
    }];
    profiles.nextId = 2;
    saveProfilesToDisk();
  }
  // Make sure every profile has a state entry.
  for (const p of profiles.profiles) {
    if (!profileStates.has(p.id)) profileStates.set(p.id, emptyUserState());
  }
})();

// Helpers for the rest of the server to read/write a profile's state
// without thinking about disk layout.
function getProfileState(profileId) {
  let s = profileStates.get(profileId);
  if (!s) { s = emptyUserState(); profileStates.set(profileId, s); }
  return s;
}
function findProfile(id) {
  return profiles.profiles.find(p => p.id === id) || null;
}
function profileIdsOnDisk() { return Object.fromEntries(profileStates); }

let userStateSaveTimer = null;
function scheduleUserStateSave() {
  if (userStateSaveTimer) return;
  userStateSaveTimer = setTimeout(async () => {
    userStateSaveTimer = null;
    try {
      await fs.promises.writeFile(userStateFile + ".tmp", JSON.stringify(profileIdsOnDisk()));
      await fs.promises.rename(userStateFile + ".tmp", userStateFile);
    } catch (e) {
      console.warn(`save user-state failed: ${e.message}`);
    }
  }, 500);
}

// Synchronous flush — used by the SIGTERM/SIGINT handler so a CI
// auto-deploy that recreates the container can't drop the last 500 ms
// of pending mutations (notably a /api/progress write that landed
// just before docker stop). writeFileSync is fine here because we're
// already shutting down.
function flushUserStateSync() {
  if (userStateSaveTimer) {
    clearTimeout(userStateSaveTimer);
    userStateSaveTimer = null;
  }
  try {
    fs.writeFileSync(userStateFile + ".tmp", JSON.stringify(profileIdsOnDisk()));
    fs.renameSync(userStateFile + ".tmp", userStateFile);
  } catch (e) {
    console.warn(`flush user-state on shutdown failed: ${e.message}`);
  }
}

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, flushing user-state…`);
  flushUserStateSync();
  flushLiveHealthSync();
  flushRemindersSync();
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Backstop: Express 4 doesn't route async-handler rejections to the
// error middleware, and Node's default for an unhandled rejection is
// to kill the process — which takes every TV in the house down with
// it. Async handlers still catch their own errors; this only stops a
// missed one from becoming an outage.
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandled rejection: ${reason?.stack || reason}`);
});

async function saveIndexToDisk(mode, actx = currentAccount()) {
  const ix = getIndexesFor(actx)[mode];
  if (!ix.byId.size) return;
  const data = {
    savedAt: Date.now(),
    panel: actx.host,
    total: ix.total,
    done: ix.done,
    streams: [...ix.byId.values()],
  };
  const p = dataPathFor(actx, "index", mode);
  try {
    await fs.promises.writeFile(p + ".tmp", JSON.stringify(data));
    await fs.promises.rename(p + ".tmp", p);
  } catch (e) {
    console.warn(`[${mode}] save failed: ${e.message}`);
  }
}

// ── Effective age rating ─────────────────────────────────────────────
// TMDB's US rating is missing for ~56% of matched titles, which hid them all
// from kid profiles (strict allow-list). `cert_alt` is a US-scale equivalent
// derived from other countries' ratings (most restrictive wins) or, failing
// that, a conservative "PG" for Family-genre titles. Everything that used
// `us_cert` now goes through effCert().
const effCert = (t) => (t ? (t.us_cert || t.cert_alt || "") : "");
const { altCertFromTmdb, familyHeuristicCert } = require("./lib/alt-cert");
const { createPrewarmQueue, buildDetailEntries } = require("./lib/prewarm-queue");
const { xtreamKey: xtreamKeyFor } = require("./lib/xtream-key");
const { isLowQuality, lowQualityLast } = require("./lib/low-quality");
const { decideLiveAudio, withDeadline, decideLiveHealth, applyLiveCheck, isPersistentDeadReason, deadTtlMs, manifestHasContent, firstVariantUri, LIVE_UNAVAILABLE, clientRoutesLiveAudio, liveVerdictTrusted } = require("./lib/live-audio-verdict");
const LIVE_AUDIO_PROBE_WAIT_MS = (() => { const n = parseInt(process.env.LIVE_AUDIO_PROBE_WAIT_MS ?? "", 10); return Number.isFinite(n) && n >= 0 ? n : 3500; })();
const { segmentQuery } = require("./lib/segment-query");
const { liveHlsListSize, panelReconnectArgs, liveTolerantArgs } = require("./lib/live-hls");
const { createDownloadQueue, waitingFor: dlWaitingFor } = require("./lib/download-queue");
const { streamingRecently: streamingRecentlyIn } = require("./lib/recent-stream");
const certBackfill = { running: false, done: 0, total: 0 };
async function tmdbRaw(pathAndQuery) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`https://api.themoviedb.org/3${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) { await new Promise((r) => setTimeout(r, Math.max(parseInt(res.headers.get("Retry-After") || "5", 10), 3) * 1000)); continue; }
      if (res.status === 404) return { results: [] };
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }
  return null;
}
function refreshIndexCerts() {
  catalogGen++;
  for (const m of ["movie", "series"]) {
    const ix = indexes[m];
    if (!ix?.byId) continue;
    for (const s of ix.byId.values()) {
      const c = effCert(tmdbCache[`${m}:${s.id}`]);
      if (c) s.us_cert = c;
    }
  }
}
async function backfillAltCerts({ reason = "cron" } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY" };
  if (certBackfill.running) return { ok: false, error: "already running" };
  certBackfill.running = true;
  try {
    const todo = [];
    const RECHECK_MS = 30 * 24 * 3600 * 1000; // TMDB adds ratings weeks after release
    for (const [key, e] of Object.entries(tmdbCache)) {
      if (!e || e.source === "no-match" || !e.tmdb_id || e.us_cert) continue;
      const stale = ("cert_alt" in e) && (!e.cert_alt || e.cert_src === "genre") && Date.now() - (e.cert_checked_at || 0) > RECHECK_MS;
      if (("cert_alt" in e) && !stale) continue;
      const [mode] = key.split(":");
      if (mode === "movie" || mode === "series") todo.push({ key, mode, e });
    }
    certBackfill.done = 0; certBackfill.total = todo.length;
    console.log(`[cert] backfilling alternate ratings for ${todo.length} titles (${reason})`);
    let i = 0, found = 0, genreRated = 0, nulls = 0, abort = false;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (i < todo.length && !abort) {
        const { key, mode, e } = todo[i++];
        const res = await tmdbRaw(mode === "series" ? `/tv/${e.tmdb_id}/content_ratings` : `/movie/${e.tmdb_id}/release_dates`);
        certBackfill.done++;
        if (res === null) {
          // transient failure: retry next run; stop if TMDB looks down
          if (++nulls >= 40) { abort = true; console.warn("[cert] TMDB failing repeatedly — stopping this run"); }
          continue;
        }
        nulls = 0;
        const r = altCertFromTmdb(mode, res.results);
        let alt = r.cert, src = "intl";
        if (alt) found++;
        else if (!r.anyData) {
          // No rating anywhere: conservative Family-genre fallback.
          alt = familyHeuristicCert(mode, e.genres, e.tmdb_title || "");
          if (alt) { genreRated++; src = "genre"; }
        } // else: ratings exist but are unmappable → grant nothing
        e.cert_alt = alt;           // "" = checked, nothing granted
        e.cert_checked_at = Date.now();
        if (alt) e.cert_src = src; else delete e.cert_src;
        if (certBackfill.done % 10000 === 0) {
          scheduleTmdbCacheSave(); refreshIndexCerts();
          console.log(`[cert] ${certBackfill.done}/${certBackfill.total} (intl ${found}, family-genre ${genreRated})`);
        }
      }
    }));
    scheduleTmdbCacheSave(); refreshIndexCerts();
    console.log(`[cert] done: ${certBackfill.done} checked, ${found} rated from other countries, ${genreRated} by Family genre`);
    return { ok: true, checked: certBackfill.done, found, genreRated };
  } finally {
    certBackfill.running = false;
  }
}
function scheduleAltCerts() {
  if (!TMDB_API_KEY) return;
  setTimeout(() => backfillAltCerts({ reason: "boot" }).catch((e) => console.warn(`[cert] ${e.message}`)), 8 * 60 * 1000);
  setInterval(() => backfillAltCerts().catch((e) => console.warn(`[cert] ${e.message}`)), 6 * 3600 * 1000);
}

// ── Streaming buzz: what's popular on the big platforms ─────────────
// The household has no Netflix/Prime/etc, so it never sees what's famous
// there. TMDB (JustWatch data) tells us, per platform and region, the most
// popular recent titles; we intersect that with the Khouch catalog (by TMDB
// id) and surface it as "Popular on Netflix" rails with "#N on Netflix"
// captions, plus an MCP tool that also lists what's hot but NOT in Khouch.
// Only English, Hindi and Punjabi content (the household's languages).
// English comes from the US catalogs; Hindi and Punjabi from the India
// catalogs (they differ from the US ones). Filtered by the TITLE's original
// language, so a Korean show on Netflix never appears.
// Bumped whenever catalog metadata changes IN PLACE (variants, ratings, TMDB
// matches) so the /api/home caches below don't serve stale groupings.
let catalogGen = 0;
function putHomeCache(map, key, val) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.at > 8 * 60 * 1000) map.delete(k);
  while (map.size >= 12) map.delete(map.keys().next().value); // oldest first
  map.set(key, { ...val, gen: catalogGen, at: now });
}
const catBucketCache = new Map(); // gate signature -> { byId, at, map } (category grouping, see /api/home)
const smartPoolCache = new Map(); // gate signature -> { byId, at, pool } (see /api/home)
const BUZZ_LANG_NAME = { en: "English", hi: "Hindi", pa: "Punjabi" };
const BUZZ_PLATFORMS_US = [
  ["netflix", "Netflix", 8], ["prime", "Prime Video", 9], ["max", "HBO Max", 1899], ["disney", "Disney+", 337],
  ["apple", "Apple TV+", 350], ["hulu", "Hulu", 15], ["paramount", "Paramount+", 531], ["peacock", "Peacock", 386],
];
const BUZZ_PLATFORMS_IN_HI = [
  ["netflix", "Netflix", 8], ["prime", "Prime Video", 119], ["hotstar", "JioHotstar", 2336],
  ["zee5", "ZEE5", 232], ["sonyliv", "SonyLIV", 237], ["mxplayer", "MX Player", 515],
];
const BUZZ_PLATFORMS_IN_PA = [["prime", "Prime Video", 119], ["zee5", "ZEE5", 232], ["netflix", "Netflix", 8]];
const BUZZ_SOURCES = [
  ...BUZZ_PLATFORMS_US.map(([k, label, id]) => ({ key: `${k}-en`, platform: k, label, id, region: "US", lang: "en", title: `Popular on ${label}` })),
  ...BUZZ_PLATFORMS_IN_HI.map(([k, label, id]) => ({ key: `${k}-hi`, platform: k, label, id, region: "IN", lang: "hi", title: `Hindi on ${label}` })),
  ...BUZZ_PLATFORMS_IN_PA.map(([k, label, id]) => ({ key: `${k}-pa`, platform: k, label, id, region: "IN", lang: "pa", title: `Punjabi on ${label}` })),
  // Language-wide popularity across all India platforms.
  { key: "trending-hi", platform: "trending", label: "Hindi trending", id: null, region: "IN", lang: "hi", title: "Trending Hindi" },
  { key: "trending-pa", platform: "trending", label: "Punjabi trending", id: null, region: "IN", lang: "pa", title: "Trending Punjabi" },
];
const BUZZ_LANGS = new Set(Object.keys(BUZZ_LANG_NAME));
const streamingBuzzFile = path.join(DATA_DIR, "streaming-buzz.json");
let streamingBuzz = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(streamingBuzzFile, "utf8")) || {};
    return d.v === 2 ? d : {}; // older shape (unfiltered, per-platform keys): rebuild instead
  } catch { return {}; }
})();
let streamingBuzzRunning = false;
async function buildStreamingBuzz({ reason = "cron" } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY" };
  if (streamingBuzzRunning) return { ok: false, error: "already running" };
  streamingBuzzRunning = true;
  try {
    const now = new Date();
    const since = (years) => new Date(now.getFullYear() - years, now.getMonth(), now.getDate()).toISOString().slice(0, 10);
    const rows = (res, kind) => (res?.results || []).filter((r) => BUZZ_LANGS.has(r.original_language)).map((r) => ({
      id: r.id,
      title: kind === "movie" ? r.title : r.name,
      year: String((kind === "movie" ? r.release_date : r.first_air_date) || "").slice(0, 4) || null,
      lang: r.original_language,
    }));
    // tmdb() caches 24h; drop the discover/trending pages so a 12h refresh is real.
    for (const k of [...tmdbMemCache.keys()]) if (k.startsWith("/discover/") || k.startsWith("/trending/")) tmdbMemCache.delete(k);
    const out = { v: 2, updatedAt: Date.now(), providers: {}, trending: {} };
    const prevOk = streamingBuzz.v === 2; // older data had a different (unfiltered) shape
    // Keep the previous list when a fresh one comes back empty/much shorter
    // (a TMDB hiccup mid-run must not wipe the rails).
    const keepIfBetter = (fresh, prev, what) => {
      if (prevOk && prev?.length && fresh.length < prev.length * 0.5) {
        console.warn(`[buzz] ${what}: got ${fresh.length} vs ${prev.length} before — keeping the previous list`);
        return prev;
      }
      return fresh;
    };
    for (const p of BUZZ_SOURCES) {
      out.providers[p.key] = { label: p.label, platform: p.platform, lang: p.lang, region: p.region, title: p.title, movie: [], tv: [] };
      for (const kind of ["movie", "tv"]) {
        const list = [];
        for (let page = 1; page <= (p.id ? 5 : 3); page++) {
          const params = {
            watch_region: p.region, with_watch_monetization_types: "flatrate",
            with_original_language: p.lang, sort_by: "popularity.desc", page: String(page),
          };
          if (p.id) params.with_watch_providers = String(p.id);
          // Recent buzz, not the whole back catalogue.
          params[kind === "movie" ? "primary_release_date.gte" : "first_air_date.gte"] = since(kind === "movie" ? 3 : 5);
          const res = await tmdb(`/discover/${kind}`, params);
          if (!res) break;
          list.push(...rows(res, kind));
          if (page >= (res.total_pages || 1)) break;
        }
        out.providers[p.key][kind] = keepIfBetter(
          list.map((r, i) => ({ ...r, rank: i + 1 })), streamingBuzz.providers?.[p.key]?.[kind], `${p.key}/${kind}`);
      }
    }
    for (const kind of ["movie", "tv"]) {
      const list = [];
      for (let page = 1; page <= 3; page++) {
        const res = await tmdb(`/trending/${kind}/week`, { page: String(page) });
        if (!res) break;
        list.push(...rows(res, kind));
      }
      out.trending[kind] = keepIfBetter(
        list.map((r, i) => ({ ...r, rank: i + 1 })), streamingBuzz.trending?.[kind], `trending/${kind}`);
    }
    const total = Object.values(out.providers).reduce((n, p) => n + p.movie.length + p.tv.length, 0);
    if (!total) { console.warn("[buzz] TMDB returned nothing — keeping the previous data"); return { ok: false, error: "empty" }; }
    streamingBuzz = out;
    try {
      fs.writeFileSync(streamingBuzzFile + ".tmp", JSON.stringify(out));
      fs.renameSync(streamingBuzzFile + ".tmp", streamingBuzzFile);
    } catch (e) { console.warn(`[buzz] save failed: ${e.message}`); }
    console.log(`[buzz] (${reason}) ${total} provider titles across ${BUZZ_SOURCES.length} sources`);
    return { ok: true, total };
  } finally {
    streamingBuzzRunning = false;
  }
}
// ── Streaming arrivals: new titles on the platforms ──────────────────
// TMDB has no "added on" date for platform availability, so arrivals are
// detected by DIFFERENCE: per platform/language/kind we keep the set of recent
// releases (last 120 days, flatrate, region catalog) seen at the previous
// check; anything newly present is an arrival (with first-seen time). The
// first run only seeds the snapshot (no flood). Log kept 60 days.
const streamingArrivalsFile = path.join(DATA_DIR, "streaming-arrivals.json");
let streamingArrivals = (() => {
  try { return JSON.parse(fs.readFileSync(streamingArrivalsFile, "utf8")) || {}; } catch { return {}; }
})();
let arrivalsRunning = false;
async function checkStreamingArrivals({ reason = "cron" } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY" };
  if (arrivalsRunning) return { ok: false, error: "already running" };
  arrivalsRunning = true;
  try {
    const now = new Date();
    const dayStr = (d) => d.toISOString().slice(0, 10);
    const since = dayStr(new Date(now.getTime() - 120 * 86400000));
    const today = dayStr(now);
    const recentCut = dayStr(new Date(now.getTime() - 60 * 86400000)); // an "arrival" must be a recent release
    const seeded = !!streamingArrivals.seeded;
    const snap = streamingArrivals.snap || {};
    const everSeen = streamingArrivals.everSeen || {};   // "kind:tmdb_id:platform" -> ts (never re-announce)
    const log = Array.isArray(streamingArrivals.log) ? streamingArrivals.log : [];
    const nextSnap = {};
    const nextSeen = { ...everSeen };
    const added = [];
    let failures = 0, anomalies = 0;
    for (const src of BUZZ_SOURCES) {
      if (src.platform === "trending") continue;
      for (const kind of ["movie", "tv"]) {
        const key = `${src.key}|${kind}`;
        const rows = [];
        let ok = true;
        for (let page = 1; page <= 3; page++) {
          // tmdb() caches 24h; arrivals need fresh pages, so bypass the cache
          const params = new URLSearchParams({
            watch_region: src.region, with_watch_providers: String(src.id), with_watch_monetization_types: "flatrate",
            with_original_language: src.lang, sort_by: kind === "movie" ? "primary_release_date.desc" : "first_air_date.desc", page: String(page),
            [kind === "movie" ? "primary_release_date.gte" : "first_air_date.gte"]: since,
            [kind === "movie" ? "primary_release_date.lte" : "first_air_date.lte"]: today,
          }).toString();
          const res = await tmdbRaw(`/discover/${kind}?${params}`);
          if (!res || (res.results || []).length === 0 && page === 1 && (snap[key] || []).length > 0) { ok = false; break; } // error / suspicious empty
          for (const r of res.results || []) {
            if (!BUZZ_LANGS.has(r.original_language)) continue;
            const date = String((kind === "movie" ? r.release_date : r.first_air_date) || "");
            rows.push({
              id: r.id, title: kind === "movie" ? r.title : r.name, date,
              year: date.slice(0, 4) || null, overview: String(r.overview || "").slice(0, 200),
            });
          }
          if (page >= (res.total_pages || 1)) break;
        }
        if (!ok) { failures++; if (Array.isArray(snap[key])) nextSnap[key] = snap[key]; continue; } // keep old; never invent []
        const prev = new Set(snap[key] || []);
        nextSnap[key] = rows.map((r) => r.id);
        const fresh = [];
        for (const r of rows) {
          const sk = `${kind}:${r.id}:${src.platform}`;
          if (!nextSeen[sk]) { nextSeen[sk] = Date.now(); if (seeded && Array.isArray(snap[key]) && !prev.has(r.id)) fresh.push(r); }
        }
        if (!seeded || !Array.isArray(snap[key])) continue; // first sight of this list only seeds it
        // Flood breaker: a big jump in one list is a data anomaly, not 15 premieres.
        if (fresh.length > 15) { anomalies++; continue; }
        for (const r of fresh) {
          if (r.date && r.date < recentCut) continue; // slid in from deep in the window: not a new release
          added.push({
            tmdb_id: r.id, title: r.title, year: r.year, date: r.date, overview: r.overview,
            kind: kind === "movie" ? "movie" : "series",
            platform: src.platform, platform_label: src.label, lang: src.lang, first_seen: Date.now(),
          });
        }
      }
    }
    const cutoff = Date.now() - 60 * 86400000;
    const seenCut = Date.now() - 150 * 86400000;
    for (const [k, t] of Object.entries(nextSeen)) if (t < seenCut) delete nextSeen[k];
    streamingArrivals = {
      seeded: true, updatedAt: Date.now(), snap: nextSnap, everSeen: nextSeen,
      cursors: streamingArrivals.cursors || {},
      log: [...added, ...log].filter((a) => a.first_seen > cutoff).slice(0, 2000),
    };
    try {
      fs.writeFileSync(streamingArrivalsFile + ".tmp", JSON.stringify(streamingArrivals));
      fs.renameSync(streamingArrivalsFile + ".tmp", streamingArrivalsFile);
    } catch (e) { console.warn(`[arrivals] save failed: ${e.message}`); }
    console.log(`[arrivals] (${reason}) ${seeded ? added.length + " new" : "seeded"}${failures ? `, ${failures} lists failed` : ""}${anomalies ? `, ${anomalies} anomalous lists reseeded` : ""}`);
    return { ok: true, seeded: !seeded, new: added.length, failures, anomalies };
  } finally {
    arrivalsRunning = false;
  }
}
function scheduleStreamingArrivals() {
  if (!TMDB_API_KEY) return;
  setTimeout(() => checkStreamingArrivals({ reason: "boot" }).catch((e) => console.warn(`[arrivals] ${e.message}`)), 6 * 60 * 1000);
  setInterval(() => checkStreamingArrivals().catch((e) => console.warn(`[arrivals] ${e.message}`)), 6 * 3600 * 1000);
}

function scheduleStreamingBuzz() {
  if (!TMDB_API_KEY) return;
  const age = Date.now() - (streamingBuzz.updatedAt || 0);
  setTimeout(() => buildStreamingBuzz({ reason: "boot" }).catch((e) => console.warn(`[buzz] ${e.message}`)),
    age > 20 * 3600 * 1000 ? 3 * 60 * 1000 : 30 * 60 * 1000);
  setInterval(() => buildStreamingBuzz().catch((e) => console.warn(`[buzz] ${e.message}`)), 12 * 3600 * 1000);
}

// ── Canonical variants (one tile per film/show, in its native language) ──
// The panel lists the same title once per audio language / quality ("TRON:
// Ares" in English FHD, 4 dubs, a multi-audio bundle). Group streams by TMDB
// id; rank the members so the NATIVE-language stream (audio language equals
// TMDB's original_language) wins, then 4K > FHD > HD, non-CAM, surround, not
// a multi-language bundle. The winner carries `variants`; the rest are
// flagged `isAlt` with `canonicalId` and hidden from rails/search/taste
// (variantChoice below can swap the winner per profile language).
const { LANG_WORDS: AUDIO_LANG_WORDS, buildVariantIndex, resolveGroup, tileVariantFields, variantsPayload, createVariantIndexCache } = require("./lib/variants");
function streamAudioLang(s, catName) {
  const name = String(s.name || "");
  if (/\[[^\]]*,[^\]]*\]/.test(name)) return "multi";                  // "[Tel,Tam,Hin,Eng]"
  const tag = /\(\s*([A-Za-z]+)\s*\)\s*\.?\s*$/.exec(name);
  if (tag && AUDIO_LANG_WORDS[tag[1].toLowerCase()]) return AUDIO_LANG_WORDS[tag[1].toLowerCase()];
  const cn = String(catName || "");
  if (/dubbed/i.test(cn)) {
    if (/hindi/i.test(cn)) return "hi";
    if (/multi/i.test(cn)) return "multi";
    return null;
  }
  if (/multi/i.test(cn) && /language|audio/i.test(cn)) return "multi";
  const langs = (Array.isArray(s.tags) ? s.tags : []).filter((t) => LANG_TAG_TO_ISO[t]);
  return langs.length === 1 ? LANG_TAG_TO_ISO[langs[0]] : null;
}
function assignVariants(mode, actx = currentAccount()) {
  if (mode !== "movie" && mode !== "series") return;
  const ix = getIndexesFor(actx)[mode];
  if (!ix?.byId?.size) return;
  const catNames = new Map();
  for (const c of (loadCategoriesFromDiskSync(mode, actx) || [])) catNames.set(String(c.category_id), c.category_name);
  const groups = new Map();
  const byTmdb = new Map(); // tmdb_id -> every catalog stream for it (streaming-buzz lookup)
  for (const s of ix.byId.values()) {
    delete s.isAlt; delete s.canonicalId; delete s.variants; delete s.audioLang;
    const t = tmdbCache[`${mode}:${s.id}`];
    if (!t || t.source === "no-match" || !t.tmdb_id) continue;
    s.audioLang = streamAudioLang(s, catNames.get(String(s.category_id)));
    // A panel title year more than one year off TMDB's means a wrong match:
    // never fold it into another film's group (or surface it as the hit).
    const ny = /\(((?:19|20)\d{2})\)/.exec(s.name || "");
    const ty = parseInt(t.year, 10);
    if (ny && Number.isFinite(ty) && Math.abs(parseInt(ny[1], 10) - ty) > 1) continue;
    { const bt = byTmdb.get(t.tmdb_id); if (bt) bt.push(s); else byTmdb.set(t.tmdb_id, [s]); }
    // Series dubs can carry partial seasons and no episode counts are known
    // here, so series fold only same-language twins (platform/quality
    // duplicates); movies fold across languages.
    const gkey = mode === "series" ? `${t.tmdb_id}|${s.audioLang || "?"}` : t.tmdb_id;
    const arr = groups.get(gkey);
    if (arr) arr.push(s); else groups.set(gkey, [s]);
  }
  let grouped = 0, hidden = 0;
  for (const [tmdbId, members] of groups) {
    if (members.length < 2) continue;
    const orig = members.map((m) => tmdbCache[`${mode}:${m.id}`]?.original_language).find(Boolean) || null;
    const quality = (s) => {
      const tags = s.tags || [];
      if (tags.includes("4k")) return 0;
      if (/\b(FHD|1080P?)\b/i.test(s.name)) return 1;
      if (/\b(HD|720P?)\b/i.test(s.name)) return 2;
      return 3;
    };
    const isCam = (s) => (s.tags || []).includes("cam") || isLowQuality(s, catNames.get(String(s.category_id)));
    const langRank = (s) => {
      if (!orig || !s.audioLang) return 1;
      return s.audioLang === orig ? 0 : s.audioLang === "multi" ? 3 : 2;
    };
    const score = (s) => [isCam(s) ? 1 : 0, langRank(s), s.audioLang === "multi" ? 1 : 0, quality(s), (s.tags || []).includes("surround") ? 0 : 1, s.id];
    members.sort((a, b) => {
      const x = score(a), y = score(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    });
    const canon = members[0];
    canon.variants = members.map((m) => ({ id: m.id, lang: m.audioLang || null, q: quality(m), cam: isCam(m) }));
    for (const m of members.slice(1)) { m.isAlt = true; m.canonicalId = canon.id; hidden++; }
    grouped++;
  }
  ix.byTmdb = byTmdb;
  catalogGen++;
  // Titles on a Notify-me list may have just arrived (after module init).
  setImmediate(() => scheduleNotifyMeCheck(`index:${mode}`));
  console.log(`[${mode}] variants: ${grouped} multi-version titles, ${hidden} alternates folded`);
  // Warm the search/detail title groups off the request path.
  scheduleVariantBuild(mode, ix, actx);
}
// Per-request: should stream `s` be hidden because another variant of the same
// title is the one this profile should see? `passes(stream)` = the profile's
// language + category gates. A profile whose onboarded languages exclude the
// native one gets the best variant in a language it chose (kids watching the
// Hindi dub); otherwise the native-first canonical wins. If the canonical is
// gated out, the best surviving alternate shows instead.
function makeVariantHider(ix, passes, profileIso) {
  const chosen = new Map(); // canonicalId -> chosen stream id
  const decide = (canon) => {
    if (chosen.has(canon.id)) return chosen.get(canon.id);
    // Camera-recorded copies only represent a title when nothing else passes.
    const vs = (canon.variants || []).filter((v) => ix.byId.get(v.id));
    const list = [...vs.filter((v) => !v.cam), ...vs.filter((v) => v.cam)].map((v) => ix.byId.get(v.id)).filter(passes);
    let pick = list[0];
    if (profileIso && profileIso.size && pick && pick.audioLang && !profileIso.has(pick.audioLang)) {
      pick = list.find((m) => m.audioLang && profileIso.has(m.audioLang)) || pick;
    }
    chosen.set(canon.id, pick ? pick.id : null);
    return chosen.get(canon.id);
  };
  const hider = (s) => {
    const canon = s.isAlt ? ix.byId.get(s.canonicalId) : (s.variants ? s : null);
    if (!canon) return false;
    const id = decide(canon);
    return id !== null && id !== s.id;
  };
  // The stream to show in place of `s` (AI picks / saved ids may point at an
  // alternate variant): the chosen variant of its title, else `s` itself.
  hider.resolve = (s) => {
    if (!s) return s;
    const canon = s.isAlt ? ix.byId.get(s.canonicalId) : (s.variants ? s : null);
    if (!canon) return s;
    const id = decide(canon);
    return id !== null ? (ix.byId.get(id) || s) : s;
  };
  return hider;
}

// ── Search/detail title groups (lib/variants.js, docs/VARIANTS.md) ──
// Every movie/series stream mapped to its title group (TMDB id, else
// title+year). Built off the request path: after each index load
// (assignVariants) and, while catalogGen churns (TMDB backfill), at most every
// 2 minutes in the background while the previous build keeps serving. A
// request never builds: with no build yet (or an index still filling) callers
// get null and serve ungrouped results. Streams added since the last build
// group on their own until the next one.
const variantMemo = new WeakMap(); // stream -> regex-derived fields (lib memo)
function probedQualityOf(mode, s) {
  if (mode !== "movie") return null;
  const v = qualityCache[`movie:${s.id}`];
  if (!v || !(v.w || v.h)) return null;
  if (v.is4k) return "4K";
  if (v.h >= 1000 || v.w >= 1900) return "FHD";
  if (v.h >= 700 || v.w >= 1260) return "HD";
  return "SD";
}
// buildVariantIndex opts for a mode (also describes a lone copy when no
// build exists yet).
function variantOptsFor(mode, actx = currentAccount()) {
  const catNames = new Map();
  for (const cat of (loadCategoriesFromDiskSync(mode, actx) || [])) catNames.set(String(cat.category_id), cat.category_name);
  const catOf = (s) => catNames.get(String(s.category_id)) || null;
  return {
    mode,
    memo: variantMemo,
    tmdbOf: (s) => tmdbCache[`${mode}:${s.id}`] || null,
    catNameOf: catOf,
    titleKeyOf: (s) => dedupKeyOf(s),
    normTitle: (x) => { const k = dedupTitleKey(x); return k ? k.slice(0, k.lastIndexOf("|")) : null; },
    // Same CAM test as assignVariants (synthetic "cam" tag + title/category text).
    isLowQuality: (s) => (s.tags || []).includes("cam") || isLowQuality(s, catOf(s)),
    tagLangOf: (s) => isoLangForItem(s),
    probedQuality: (s) => probedQualityOf(mode, s),
    // The copy home rails show (assignVariants canonical): same id on home and search.
    isCanonical: (s) => !s.isAlt && Array.isArray(s.variants),
    // Series episode counts are not in the index (only per-title info calls), so
    // no episodeCountOf: see docs/VARIANTS.md.
  };
}
const variantIndexCache = createVariantIndexCache({
  getGen: () => catalogGen,
  build: (mode, ix, actx) => {
    const t0 = Date.now();
    const opts = variantOptsFor(mode, actx);
    const vix = buildVariantIndex(ix.byId.values(), opts);
    const ms = Date.now() - t0;
    if (ms > 250) console.log(`[${mode}] variant index: ${vix.groups.size} groups in ${ms}ms`);
    return { vix, opts };
  },
  log: (m) => console.warn(m),
});
const scheduleVariantBuild = (mode, ix, actx) => variantIndexCache.scheduleBuild(mode, ix, actx);
const variantIndexFor = (mode, ix, actx = currentAccount()) => variantIndexCache.get(mode, ix, actx);
function variantGroupOf(entry, s) {
  return entry.vix.groupOf.get(s.id) || buildVariantIndex([s], entry.opts).groupOf.get(s.id);
}
// Profile language context for resolveGroup: onboarded language keys -> ISO
// (null when not onboarded); sort order = onboarded languages, then Hindi,
// English. `facetIso` (a language word in the query) outranks everything.
function variantLangCtx(langKeys, facetIso = null) {
  const iso = (langKeys || []).map((k) => LANG_TAG_TO_ISO[k]).filter(Boolean);
  const preferLangs = [...new Set([...iso, "hi", "en"])];
  return { profileLangs: iso.length ? new Set(iso) : null, preferLangs, firstLang: facetIso || null };
}
// Ids this profile already started in `mode` (saved progress + recents):
// resolveGroup prefers them so search reopens the copy with the resume point.
function startedIdsFor(userState, mode) {
  const out = new Set();
  for (const k of Object.keys(userState.progress || {})) {
    if (k.startsWith(mode + ":")) out.add(k.slice(mode.length + 1).split(":")[0]);
  }
  for (const id of (userState.recents?.[mode] || [])) out.add(String(id));
  return out;
}
// Onboarded keys for a per-mode search / variants request: the mode's own
// chips, else movie, else live (/api/search/:mode and /api/variants agree).
function profileModeKeys(userState, mode) {
  const g = userState.filter?.groups || {};
  if (Array.isArray(g[mode]) && g[mode].length) return g[mode];
  if (Array.isArray(g.movie) && g.movie.length) return g.movie;
  return g.live || [];
}

async function loadIndexFromDisk(mode, actx = currentAccount()) {
  try {
    const raw = await fs.promises.readFile(dataPathFor(actx, "index", mode), "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data.streams)) return null;
    // Re-tag against the current CHANNEL_GROUPS regex table. Old
    // on-disk indexes from before the tagging system was added won't
    // have `tags` baked in; a pattern table update should also
    // re-flow tags without forcing a full re-index. Cheap (one Map
    // lookup per stream).
    const cats = loadCategoriesFromDiskSync(mode, actx);
    if (cats && cats.length) rebuildCategoryTags(mode, cats, actx);
    const tagMap = getTagsByCategoryFor(actx)[mode];
    const byId = new Map();
    for (const s of data.streams) {
      const cat = tagMap?.get(String(s.category_id)) || ["other"];
      s.tags = applyQualityDemotion(mode, s.id, streamTagsFor(s.name, cat));
      if (mode !== "live") {
        tmdbNameHints.set(`${mode}:${s.id}`, { name: s.name, year: s.year, tags: s.tags });
        const tmdbEntry = tmdbCache[`${mode}:${s.id}`];
        s.us_cert = effCert(tmdbEntry) || null;
        s.tmdb_id = tmdbEntry?.tmdb_id || null;
      }
      // Re-attach audio metadata (qualityCache / learned tracks / series
      // summaries) on every load so the badges show without a rebuild.
      // Owner panel only: those caches are keyed by the owner's ids.
      if ((mode === "movie" || mode === "series") && isOwnerAccount(actx)) {
        applyAudioToItem(s, mode === "movie" ? movieAudioSummary(s.id) : seriesAudioSummary(s.id));
        if (!s.audio_badge && s.tags.includes("surround")) s.tags = s.tags.filter((t) => t !== "surround");
      }
      byId.set(s.id, s);
    }
    const target = getIndexesFor(actx)[mode];
    target.byId = byId;
    target.total = data.total || data.streams.length;
    target.done = data.done || data.streams.length;
    target.ready = true;
    try { assignVariants(mode, actx); } catch (e) { console.warn(`[${mode}] variants failed: ${e.message}`); }
    return data;
  } catch {
    return null;
  }
}

async function clearDiskIndexes(actx = currentAccount()) {
  // Panel indexes only — the local "disk" media index is not tied to the
  // panel and must survive a panel switch/clear.
  for (const mode of PANEL_MODES) {
    try { await fs.promises.unlink(dataPathFor(actx, "index", mode)); } catch {}
  }
}

function xtreamKey(actx, action, params) {
  return xtreamKeyFor(accountKeyOf(actx), action, params);
}
function xtreamIsFresh(actx, action, params) {
  const key = xtreamKey(actx, action, params);
  const hit = cache.get(key);
  return !!((hit && Date.now() - hit.t < TTL_MS) || inflight.has(key));
}

// Background warm-up of get_vod_info / get_series_info for titles the home
// screen just surfaced, so the first detail-screen open is a cache hit
// instead of a (up to ~19 s) live panel round-trip. Only warms the xtream
// cache; the /info handler still runs its side effects on first open.
const detailPrewarm = createPrewarmQueue({
  fetcher: (e) => xtream(MODES[e.mode].info, { [e.idKey]: e.id }, { actx: e.actx }),
  isCached: (e) => xtreamIsFresh(e.actx, MODES[e.mode].info, { [e.idKey]: e.id }),
  shouldYield: () => streamingNow(null),
});
function prewarmDetails(mode, ids, actx, max = 8) {
  return detailPrewarm.enqueue(buildDetailEntries(mode, ids, actx, accountKeyOf(actx), max));
}

async function xtream(action, params = {}, opts = {}) {
  const { timeout = 90_000, actx = currentAccount() } = opts;
  // Scope the cache + inflight map by accountKey so two accounts (owner
  // and a friend on a different reseller host, or just different panel
  // logins) don't poison each other. Same action+params under different
  // creds will yield different upstream responses.
  const key = xtreamKey(actx, action, params);
  const hit = cache.get(key);
  // opts.fresh: always ask the panel (still joins a call already in flight).
  if (!opts.fresh && hit && Date.now() - hit.t < TTL_MS) return hit.v;
  if (inflight.has(key)) return inflight.get(key);

  const qs = new URLSearchParams({
    username: actx.user,
    password: actx.pass,
    ...(action ? { action } : {}),
    ...params,
  }).toString();

  const url = `${actx.host}/player_api.php?${qs}`;
  const p = (async () => {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
      },
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`Panel ${res.status} for ${action || "auth"}`);
    const v = await res.json();
    // Do not cache auth-rejection bodies — they're transient (panel is
    // rate-limiting or briefly unhappy) and a 24-hour TTL would lock the
    // app into a broken state long after the panel recovers. Lets every
    // subsequent call retry against the live panel until it answers.
    const isAuthReject = !Array.isArray(v) && v && v.user_info && Number(v.user_info.auth) === 0;
    if (!isAuthReject && !opts.noCache) cache.set(key, { t: Date.now(), v });
    return v;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}

// Most-recently observed panel account info. Populated by /api/bootstrap
// (which calls xtream("") to refresh it). Used to honor
// user_info.allowed_output_formats — some panels only allow m3u8 and
// reject .ts requests, so a client asking for "/live/.../X.ts" would
// get a broken URL. When the panel hasn't whitelisted "ts", we silently
// fall back to m3u8 for live mode. movie/series streams use the
// container ext from the panel metadata so this guard doesn't apply.
// lastAccountInfo is now per-account; owner reads from `lastAccountInfo`
// for backwards compat (older code still mutates it), and writers also
// stash to `lastAccountInfoByAccount` so friends each have their own
// authoritative `user_info` snapshot.
let lastAccountInfo = null;
function setLastAccountInfo(actx, account) {
  if (isOwnerAccount(actx)) lastAccountInfo = account;
  lastAccountInfoByAccount.set(accountKeyOf(actx), account);
}
function getLastAccountInfo(actx) {
  if (isOwnerAccount(actx)) return lastAccountInfo;
  return lastAccountInfoByAccount.get(accountKeyOf(actx)) || null;
}
function panelAllowsExt(ext, actx = currentAccount()) {
  const info = getLastAccountInfo(actx);
  const allowed = info?.user_info?.allowed_output_formats;
  if (!Array.isArray(allowed) || !allowed.length) return true; // unknown → allow
  return allowed.map(s => String(s).toLowerCase()).includes(String(ext).toLowerCase());
}
function streamUrl(mode, id, ext, actx = currentAccount()) {
  const m = MODES[mode];
  if (!m) throw new Error(`Bad mode ${mode}`);
  // Local "disk" media: there is no panel URL — return the absolute
  // filesystem path so the transcoder can `ffmpeg -i <path>`. Direct
  // play does NOT go through here (it uses the signed /api/diskfile
  // route); only the transcoder consumes this.
  if (m.local) {
    const meta = getIndexesFor(actx).disk?.meta?.get(Number(id));
    return meta ? meta.absPath : null;
  }
  let e = ext || m.defaultExt || "mp4";
  if (mode === "live" && e === "ts" && !panelAllowsExt("ts", actx)) e = "m3u8";
  // Live URLs are intentionally cache-keyless — they're sliding-window
  // manifests and identical query-keying is the norm.
  if (mode === "live") {
    return `${actx.host}/${m.pathSeg}/${actx.user}/${actx.pass}/${id}.${e}`;
  }
  // VOD: per-call cache-bust query. The panel sits behind Cloudflare,
  // which has been seen caching a 200 OK error-HTML response for
  // 4 hours after a transient panel hiccup. Every subsequent request
  // for the same path then served HTML instead of mp4 bytes, ffmpeg
  // failed with "Invalid data found", and playback died. A fresh
  // `?_=<ts>` per play attempt sidesteps the cached error entirely.
  return `${actx.host}/${m.pathSeg}/${actx.user}/${actx.pass}/${id}.${e}?_=${Date.now()}`;
}

function projectStream(mode, s, actx = currentAccount()) {
  const catId = String(s.category_id);
  // Pre-computed tags for this stream's category. Both web and TV
  // chip filters consume `tags` as a flat string array so toggling
  // chips is an O(1) Set lookup instead of running every GROUPS regex
  // against the category name on each click. Falls back to ["other"]
  // when categories haven't been indexed yet (boot ordering).
  const catTags = getTagsByCategoryFor(actx)[mode]?.get(catId) || ["other"];
  // Per-stream synthetic markers. "4k", "movies", and "music" often
  // appear in the channel name even when the category is generic —
  // e.g. category "INDIA SPORTS HD" containing both "Star Sports 1"
  // and "Star Sports 1 (4K)". Without this pass, the 4K chip would
  // miss those streams. Always layered on top of category tags.
  // Real-4K demotion sits on the very end — see applyQualityDemotion.
  const projectedId = mode === "series" ? s.series_id : (s.stream_id || s.id);
  let tags = applyQualityDemotion(mode, projectedId, streamTagsFor(s.name, catTags));
  const tmdbEntry = mode !== "live" ? tmdbCache[`${mode}:${projectedId}`] : null;
  const us_cert = effCert(tmdbEntry) || null;
  const tmdb_id = tmdbEntry?.tmdb_id || null;
  // Audio metadata (surround badge + "surround" chip tag at >= 6 channels):
  // owner panel only (the caches are keyed by the owner's ids).
  const audioSummary = !isOwnerAccount(actx) ? null
    : mode === "movie" ? movieAudioSummary(projectedId)
    : mode === "series" ? seriesAudioSummary(projectedId) : null;
  const af = surroundLib.audioFields(audioSummary);
  if (af.audio_badge && !tags.includes("surround")) tags = [...tags, "surround"];
  else if (!af.audio_badge && tags.includes("surround")) tags = tags.filter((t) => t !== "surround");
  const audioOut = af.audio_channels ? {
    audio_channels: af.audio_channels,
    audio_codec: af.audio_codec,
    audio_format: af.audio_format || undefined,
    audio_badge: af.audio_badge || undefined,
  } : null;
  if (mode === "series") {
    return {
      id: s.series_id,
      name: s.name,
      icon: s.cover,
      category_id: catId,
      year: s.year || s.releaseDate || null,
      rating: s.rating || s.rating_5based || null,
      plot: s.plot || null,
      us_cert,
      tmdb_id,
      tags,
      ...(audioOut || {}),
    };
  }
  return {
    id: s.stream_id,
    name: s.name,
    icon: s.stream_icon || s.cover,
    category_id: catId,
    container: s.container_extension || null,
    year: s.year || s.releaseDate || null,
    rating: s.rating || s.rating_5based || null,
    added: s.added || null,
    audio_channels: audioOut ? audioOut.audio_channels : null,
    audio_codec: audioOut ? audioOut.audio_codec : null,
    audio_format: audioOut ? audioOut.audio_format : undefined,
    audio_badge: audioOut ? audioOut.audio_badge : undefined,
    // For live streams: panel returns epg_channel_id when EPG data exists
    // for this channel (empty string / null otherwise). The TV Guide uses
    // it to split channels into "with program data" / "without".
    epg_channel_id: mode === "live"
      ? (s.epg_channel_id ? String(s.epg_channel_id) : "")
      : undefined,
    // Catch-up flags, kept for when the provider enables archive (0 today).
    tv_archive: mode === "live" ? (Number(s.tv_archive) || 0) : undefined,
    tv_archive_duration: mode === "live" ? (Number(s.tv_archive_duration) || 0) : undefined,
    us_cert,
    tmdb_id,
    tags,
  };
}

// Per-account in-memory structures. The owner u1 uses `_ownerIndexes`
// directly so existing on-disk paths (data/index-*.json, etc.) stay
// where they are. Non-owner accounts get their own entry in
// indexesByAccountKey and per-host shared structures (categories + EPG
// are panel-host-universal; two friends on the same reseller host share
// those without re-downloading).
//
// `indexes` (declared below) is a Proxy over getIndexesFor(currentAccount())
// so every route handler reading indexes.live / indexes.movie / indexes.series
// transparently picks up the active account from the ALS store. Helpers
// that already have an explicit `actx` should use `getIndexesFor(actx)[mode]`
// directly to avoid any ambiguity with ALS state.
function emptyIndex() {
  return { total: 0, done: 0, ready: false, running: false, byId: new Map() };
}
// Disk index also carries a server-only `meta` Map<id,{absPath,root,
// video,audioTracks,subTracks,container}> that is NEVER serialized to
// disk (saveIndexToDisk writes byId only) nor sent to clients — it's the
// id→filesystem resolver for /api/diskfile|disksubs|diskart.
function emptyDiskIndex() {
  // ready:true by default — an unconfigured/empty local library is "done"
  // (there's no async panel build to wait on), so clients never report it
  // as perpetually "indexing". buildDiskIndex keeps it true after a scan.
  return { total: 0, done: 0, ready: true, running: false, byId: new Map(), meta: new Map() };
}
function freshModeIndexes() {
  const o = {};
  for (const m of MODE_KEYS) o[m] = MODES[m].local ? emptyDiskIndex() : emptyIndex();
  return o;
}
const _ownerIndexes = freshModeIndexes();
const indexesByAccountKey = new Map();         // acctKey -> {live,movie,series}
const lastAccountInfoByAccount = new Map();    // acctKey -> account user_info snapshot
const lastPlayedByAccount = new Map();         // acctKey -> {live:{},movie:{},series:{}}
const epgIndexByHost = new Map();              // hostKey -> {byChannel:Map, builtAt}
const tagsByCategoryByHost = new Map();        // hostKey -> {live:Map, movie:Map, series:Map}
function isOwnerAccount(actx) { return actx === ownerAccount; }
function hostHashOf(host) {
  return crypto.createHash("sha256").update(host || "").digest("hex").slice(0, 16);
}
function getIndexesFor(actx) {
  if (isOwnerAccount(actx)) return _ownerIndexes;
  const key = accountKeyOf(actx);
  let ix = indexesByAccountKey.get(key);
  if (!ix) {
    ix = freshModeIndexes();
    indexesByAccountKey.set(key, ix);
  }
  return ix;
}
const indexes = new Proxy(_ownerIndexes, {
  get(_, mode) { return getIndexesFor(currentAccount())[mode]; },
  ownKeys() { return [...MODE_KEYS]; },
  getOwnPropertyDescriptor() {
    return { configurable: true, enumerable: true, writable: true, value: undefined };
  },
});
function getEpgIndexFor(actx) {
  if (isOwnerAccount(actx)) {
    return { byChannel: epgIndex, builtAt: () => epgIndexBuiltAt };
  }
  const hostKey = hostHashOf(actx.host);
  let e = epgIndexByHost.get(hostKey);
  if (!e) {
    e = { byChannel: new Map(), builtAt: 0 };
    epgIndexByHost.set(hostKey, e);
  }
  return e;
}
function dataPathFor(actx, kind, mode) {
  // Owner u1: legacy paths (no file moves needed for the in-place migration).
  if (isOwnerAccount(actx)) {
    if (kind === "index")      return path.join(DATA_DIR, `index-${mode}.json`);
    if (kind === "categories") return path.join(DATA_DIR, `categories-${mode}.json`);
    if (kind === "epg")        return path.join(DATA_DIR, "epg-xmltv.json");
    if (kind === "lastPlayed") return path.join(DATA_DIR, "last-played.json");
    throw new Error(`unknown dataPathFor kind ${kind}`);
  }
  // Non-owner accounts: namespaced by host hash so two accounts on the
  // same reseller host share EPG/categories.
  const hostKey = hostHashOf(actx.host);
  const dir = path.join(DATA_DIR, "accounts", hostKey);
  fs.mkdirSync(dir, { recursive: true });
  if (kind === "index")      return path.join(dir, `index-${mode}.json`);
  if (kind === "categories") return path.join(dir, `categories-${mode}.json`);
  if (kind === "epg")        return path.join(dir, "epg-xmltv.json");
  if (kind === "lastPlayed") return path.join(dir, "last-played.json");
  throw new Error(`unknown dataPathFor kind ${kind}`);
}

// The top-level get_*_categories call is the one fatal in a build. A
// per-category 500 backfills from the last snapshot (see the loop below),
// but if the CATEGORY LIST itself errors there's nothing to iterate and the
// mode is left at total:0 / ready:false — the "stuck on indexing" boot
// failure (a transient panel 500 right as the container restarts). Panels
// 500 transiently under the max_connections=1 cap and during brief reseller
// blips, so retry with backoff; if the panel still won't answer, fall back
// to the categories we last saved to disk so the per-category snapshot
// backfill can rebuild the prior catalog instead of serving an empty app.
// Returns null only when neither the panel nor disk yields any categories.
async function fetchCategoriesResilient(mode, m, actx) {
  const delaysMs = [2_000, 5_000, 15_000];
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    try {
      const cats = await xtream(m.cats, {}, { actx });
      if (Array.isArray(cats)) return cats;
      console.warn(`[${mode}] categories: panel returned non-array (${typeof cats})`);
    } catch (e) {
      console.warn(`[${mode}] categories fetch attempt ${attempt + 1}/${delaysMs.length + 1} failed: ${e.message}`);
    }
    if (attempt < delaysMs.length) await new Promise(r => setTimeout(r, delaysMs[attempt]));
  }
  const disk = loadCategoriesFromDiskSync(mode, actx);
  if (disk && disk.length) {
    console.warn(`[${mode}] panel categories unavailable; falling back to ${disk.length} cached categories from disk`);
    return disk;
  }
  return null;
}

// The provider allows ONE connection per account and panel API calls count
// against it: a catalog rebuild (hundreds of get_*_streams calls) during a
// stream gets the stream 403'd / the calls 500'd. So rebuilds yield: before
// each panel call, wait while any viewer is active (stream seen within the
// idle grace and not displaced). `streams` is declared further down; only
// read inside functions that run after startup.
// viewersOnly: ignore Save-to-Disk transfers (a phone download still counts:
// a person is waiting for it).
function streamingNow(actx, { viewersOnly = false } = {}) {
  const now = Date.now();
  const key = actx ? accountKeyOf(actx) : null;
  for (const [owner, v] of streams) {
    if (v.displaced || now - v.lastSeen >= LIVE_IDLE_GRACE_MS) continue;
    if (viewersOnly && diskDlSchedule.isDiskDownloadOwner(owner)) continue;
    if (key && v.accountKey !== key) continue; // the 1-connection cap is per panel account
    if (v.mode === "disk") continue; // local files never touch the panel
    return true;
  }
  return false;
}
async function yieldToViewers(label, actx) {
  const t0 = Date.now();
  let paused = false;
  while (streamingNow(actx, { viewersOnly: true })) {
    if (!paused) console.log(`[index] ${label}: viewer active — pausing panel calls until the stream ends`);
    paused = true;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (paused) console.log(`[index] ${label}: resumed after ${Math.round((Date.now() - t0) / 1000)}s`);
  // Catalog / EPG refreshes outrank a Save-to-Disk transfer: claim the
  // provider connection (the job waits while the claim is fresh).
  if ((!actx || isOwnerAccount(actx)) && claimPanelFromDiskDownloads(label)) await new Promise((r) => setTimeout(r, 1500));
}

async function buildIndex(mode, actx = currentAccount(), { noYield = false } = {}) {
  const ix = getIndexesFor(actx)[mode];
  if (ix.running) return;
  ix.running = true;
  const m = MODES[mode];
  const t = Date.now();
  try {
    if (!noYield) await yieldToViewers(`${mode} build`, actx);
    const cats = await fetchCategoriesResilient(mode, m, actx);
    if (!cats) {
      console.warn(`[${mode}] index build aborted: no categories from panel or disk (will retry on next refresh tick)`);
      return;
    }
    saveCategoriesToDisk(mode, cats, actx);
    rebuildCategoryTags(mode, cats, actx);
    ix.total = cats.length;
    ix.done = 0;
    // A warm index (ready) keeps serving the previous catalog while the
    // rebuild fills a private map, swapped in at the end — a rebuild that
    // pauses for a viewer must not expose a half-filled catalog. A cold
    // build (not ready) fills in place so partial results show progress.
    const warm = ix.ready;
    const nextById = warm ? new Map() : (ix.byId = new Map());
    console.log(`[${mode}] indexing ${cats.length} categories…`);
    // Snapshot how many items each category contributed so a panel
    // hiccup that returned an empty list for a usually-populated
    // category surfaces in the logs instead of silently shrinking the
    // catalog by thousands of titles. This is how 9 categories
    // (OSCAR WINNING / ENGLISH FHD 2020-26 / 4K / AWARDS SHOW)
    // disappeared one day — panel returned [], we saved an index
    // that was 15% smaller than the prior one, the staleness check
    // still considered it fresh, and movies like Good Will Hunting
    // were invisible until a manual rebuild.
    // Last good snapshot, grouped by category, so a per-category panel
    // hiccup (500 under the max_connections=1 cap, or a spurious empty
    // list) backfills from the prior build instead of dropping those
    // titles from search. The 4K / Oscar / recent-year English
    // categories 500 during a full rebuild; without this, an entire
    // category (e.g. every Interstellar VOD in ENGLISH (4K)) vanishes
    // until the panel happens to answer on some later rebuild.
    const priorByCat = new Map();
    try {
      const prior = JSON.parse(fs.readFileSync(dataPathFor(actx, "index", mode), "utf8"));
      if (Array.isArray(prior.streams)) {
        for (const s of prior.streams) {
          const k = String(s.category_id);
          if (!priorByCat.has(k)) priorByCat.set(k, []);
          priorByCat.get(k).push(s);
        }
      }
    } catch { /* no prior — first build */ }
    const beforeCats = [];
    for (const c of cats) {
      const beforeSize = nextById.size;
      let failed = false;
      if (!noYield) await yieldToViewers(`${mode} build`, actx);
      try {
        const list = await xtream(m.list, { category_id: c.category_id }, { timeout: 60_000, actx });
        for (const s of list) {
          const p = projectStream(mode, s, actx);
          if (!nextById.has(p.id)) nextById.set(p.id, p);
        }
      } catch (e) {
        failed = true;
        console.warn(`  [${mode}] cat ${c.category_id} (${c.category_name}) failed: ${e.message}`);
      }
      let added = nextById.size - beforeSize;
      // Backfill from the last good snapshot when the panel errored, or
      // returned nothing for a category that previously had titles. A
      // transient 500 / [] must not delete content; fresh data wins on
      // any build where the panel actually answers, so this self-heals.
      if (added === 0) {
        const prev = priorByCat.get(String(c.category_id));
        if (prev && prev.length) {
          for (const s of prev) if (!nextById.has(s.id)) nextById.set(s.id, s);
          added = nextById.size - beforeSize;
          if (added) {
            console.warn(`  [${mode}] cat ${c.category_id} (${c.category_name}) ${failed ? "failed" : "empty"}; backfilled ${added} from last snapshot`);
          }
        }
      }
      beforeCats.push({ id: c.category_id, name: c.category_name, added });
      ix.done++;
    }
    // Warn loudly when a non-trivial cat returned zero items — that's
    // almost always a panel-side blip, not a real empty category.
    const zeros = beforeCats.filter((c) => c.added === 0);
    if (zeros.length) {
      console.warn(`[${mode}] ${zeros.length} categories returned 0 items: ${
        zeros.slice(0, 12).map((c) => `${c.id}/${c.name}`).join(", ")
      }${zeros.length > 12 ? ", …" : ""}`);
    }
    // Catalog-shrink guard: if the new index is significantly smaller
    // than the one we had on disk, keep the old one. A 5% loss is
    // worth investigating; 15% (what we saw with the GWH incident)
    // would silently bury thousands of titles.
    const newSize = nextById.size;
    let priorSize = 0;
    try {
      const prior = JSON.parse(fs.readFileSync(dataPathFor(actx, "index", mode), "utf8"));
      priorSize = Array.isArray(prior.streams) ? prior.streams.length : 0;
    } catch { /* no prior — first build */ }
    if (priorSize > 0 && newSize < priorSize * 0.95) {
      console.warn(
        `[${mode}] catalog shrink guard: new index has ${newSize} items vs prior ${priorSize} ` +
        `(${(((newSize - priorSize) / priorSize) * 100).toFixed(1)}%). Refusing to save; ` +
        `the in-memory index will serve but disk keeps the prior snapshot.`,
      );
      if (warm) ix.byId = nextById;
      ix.ready = true;
      if (mode === "live") { try { applyEpgMatching(actx); } catch {} }
      return;
    }
    if (warm) ix.byId = nextById;
    ix.ready = true;
    try { assignVariants(mode, actx); } catch (e) { console.warn(`[${mode}] variants failed: ${e.message}`); }
    if (mode === "live") { try { applyEpgMatching(actx); } catch (e) { console.warn(`[epg] match after live build: ${e.message}`); } }
    console.log(`[${mode}] index ready: ${ix.byId.size} items in ${Date.now() - t}ms`);
    saveIndexToDisk(mode, actx);
    // Fire-and-forget TMDB pre-warm so the home endpoint's tiles get
    // posters/backdrops/cert ready before the user opens the app.
    // No-op for live (no TMDB enrichment) and skipped without an API
    // key. Errors inside are already caught per-item.
    if (mode !== "live") {
      prewarmTmdbCache(mode, actx).catch(e => {
        console.warn(`[${mode}] tmdb prewarm errored: ${e.message}`);
      });
    }
    if (mode === "movie") {
      prewarmQualityCache(actx).catch(e => {
        console.warn(`[movie] quality prewarm errored: ${e.message}`);
      });
      // Audio metadata for the 5.1 / 7.1 badges and the Surround rail:
      // the gentle one-at-a-time crawler (owner panel only).
      if (isOwnerAccount(actx)) startSurroundCrawler();
    }
  } finally {
    ix.running = false;
  }
}

async function buildAllIndexes(actx = currentAccount(), opts) {
  await Promise.all(PANEL_MODES.map((m) => buildIndex(m, actx, opts)));
}

// ===========================================================================
// DISK MEDIA — a local on-disk library served as the "disk" mode, PER TENANT.
// Each account configures its own filesystem path (u.diskPath on the user
// record; owner may also seed from DISK_MEDIA_DIR). buildDiskIndex scans that
// path, ffprobes each file once (cached), and fills getIndexesFor(actx).disk
// with client-safe entries (.byId) + a server-only id→{absPath,tracks} map
// (.meta) used by the signed /api/diskfile|disksubs|diskart routes. Playback
// reuses the existing VAAPI transcoder; ~89% of a typical library direct-plays
// via the Range route. TMDB enrichment rides the existing prewarmTmdbCache.
// ===========================================================================

const DISK_VIDEO_EXTS = new Set([".m4v", ".mp4", ".mkv", ".avi", ".mov", ".webm", ".m2ts", ".ts", ".wmv", ".flv", ".mpg", ".mpeg"]);
// Browser/MSE-decodable video codecs → eligible for direct play. Everything
// else (mpeg4-ASP from avi, mpeg2, hevc-in-most-browsers, vc1…) transcodes.
const BROWSER_SAFE_VIDEO = new Set(["h264", "avc1", "vp8", "vp9", "av1"]);
// Image-based subtitle codecs can't become a text <track>; must be burned in.
const IMAGE_SUB_CODECS = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvdsub", "pgssub", "vobsub", "xsub"]);
// Containers Chrome's <video> can direct-play. mkv/avi/ts/wmv/flv are NOT
// here — they're remuxed to HLS by the transcoder even with safe codecs.
const BROWSER_SAFE_CONTAINERS = new Set(["mp4", "m4v", "mov", "webm", "ogg", "ogv"]);

const diskProbeCacheFile = path.join(DATA_DIR, "disk-probe-cache.json");
let diskProbeCache = {};
try { diskProbeCache = JSON.parse(fs.readFileSync(diskProbeCacheFile, "utf8")) || {}; } catch { diskProbeCache = {}; }
let _diskProbeSaveT = null;
function scheduleDiskProbeCacheSave() {
  if (_diskProbeSaveT) return;
  _diskProbeSaveT = setTimeout(() => {
    _diskProbeSaveT = null;
    try {
      fs.writeFileSync(diskProbeCacheFile + ".tmp", JSON.stringify(diskProbeCache));
      fs.renameSync(diskProbeCacheFile + ".tmp", diskProbeCacheFile);
    } catch (e) { console.warn(`[disk] probe-cache save failed: ${e.message}`); }
  }, 800);
}

// The disk library is SUPERADMIN-ONLY. Only the owner can configure/serve a
// local library — regular tenants (friends on their own panels) cannot add a
// disk. Enforced here at the data layer (non-owner always resolves null) AND
// at the config endpoints (owner-role gate), so neither a crafted request nor
// a stray record field can give a tenant a disk. Owner path: the user record's
// diskPath, falling back to the DISK_MEDIA_DIR env seed.
function userDiskPath(user) {
  if (!user || user.role !== "owner") return null;
  const explicit = user.diskPath && String(user.diskPath).trim();
  if (explicit) return explicit;
  if (process.env.DISK_MEDIA_DIR) return String(process.env.DISK_MEDIA_DIR).trim();
  return null;
}
function userDiskEnabled(user) {
  return !!userDiskPath(user) && user.diskEnabled !== false; // default ON once a path is set
}

// "Adventures In Babysitting (2016)" → {title, year}. Handles trailing
// "(YYYY)" or a bare " YYYY" / ".YYYY." and collapses dot/underscore
// scene separators so findTmdbMatch gets a clean query.
function parseTitleYear(basename) {
  let s = String(basename).replace(/\.[a-z0-9]+$/i, ""); // drop extension
  s = s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  let year = null;
  let m = s.match(/\((19\d{2}|20\d{2})\)\s*$/) || s.match(/\b(19\d{2}|20\d{2})\b(?!.*\b(19\d{2}|20\d{2})\b)/);
  if (m) { year = m[1]; }
  // Title = everything before the (first) year marker / parenthetical year.
  let title = s.replace(/\((19\d{2}|20\d{2})\)\s*$/, "").trim();
  if (year && title === s) {
    // bare year not in parens — cut at it
    title = s.slice(0, s.indexOf(year)).trim();
  }
  // strip common scene cruft after the title
  title = title.replace(/\b(1080p|720p|2160p|480p|bluray|brrip|bdrip|web-?dl|webrip|hdrip|dvdrip|x264|x265|h264|hevc|aac|ac3|dts|remux|proper|extended|unrated)\b.*$/i, "").trim();
  title = title.replace(/[-\s]+$/, "").trim();
  return { title: title || s, year };
}

// Save-to-Disk names series episodes "Series Name SxxEyy - EpisodeTitle
// (Year)" (see diskDownloadDestPath). Detect that shape so buildDiskIndex
// can group episodes under one series tile instead of a flat per-file
// dump — with a big downloaded show (Entourage: 18 episodes) a flat list
// becomes unmanageable, one tile per episode. Returns null for anything
// else (real movies, manually-placed files) — those stay flat, one tile
// per file, exactly as today.
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseDiskEpisode(basename) {
  let s = String(basename).replace(/\.[a-z0-9]+$/i, "");
  s = s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  const m = s.match(/^(.+?)\s+S(\d{2})E(\d{2})\b\s*-?\s*(.*)$/i);
  if (!m) return null;
  const seriesName = m[1].trim();
  if (!seriesName) return null;
  let episodeTitle = m[4].trim();
  // The Android season/episode picker's disk-download POST sometimes
  // sends an episodeTitle that re-includes "Series SxxEyy - " itself
  // (a client-side quirk, not this server's doing) — e.g. filenames
  // like "Entourage S03E13 - Entourage - S03E13 - Less Than 30 (2004)".
  // Strip that redundant repeat so the episode row shows a clean title
  // ("Less Than 30") instead of the whole thing again.
  const redundantPrefix = new RegExp(`^${escapeRegExp(seriesName)}\\s*-?\\s*S\\d{2}E\\d{2}\\s*-?\\s*`, "i");
  episodeTitle = episodeTitle.replace(redundantPrefix, "").trim();
  // Strip the trailing "(Year)" that parseTitleYear would otherwise
  // extract — the episode picker shows its own season/episode number,
  // the year belongs to the series as a whole, not repeated per-row.
  episodeTitle = episodeTitle.replace(/\((19\d{2}|20\d{2})\)\s*$/, "").trim();
  const yearMatch = s.match(/\((19\d{2}|20\d{2})\)\s*$/);
  return {
    seriesName,
    season: parseInt(m[2], 10),
    episodeNum: parseInt(m[3], 10),
    episodeTitle: episodeTitle || null,
    year: yearMatch ? yearMatch[1] : null,
  };
}

// One ffprobe per file, cached by absPath+mtime. Returns
// {video:{codec,width,height}, audioTracks:[…], subTracks:[…]} or null.
function analyzeDiskFile(absPath, mtimeMs) {
  const cached = diskProbeCache[absPath];
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;
  let json = null;
  try {
    const r = spawnSync("ffprobe", [
      "-v", "error", "-print_format", "json",
      "-show_entries", "format=duration:stream=index,codec_type,codec_name,width,height,channels,disposition:stream_tags=language,title",
      absPath,
    ], { encoding: "utf8", maxBuffer: 12 * 1024 * 1024, timeout: 25000 });
    if (r.status === 0 && r.stdout) json = JSON.parse(r.stdout);
  } catch { json = null; }
  if (!json || !Array.isArray(json.streams)) return null;
  const durationSecs = Math.round(Number(json.format?.duration) || 0) || null;
  const out = { video: null, audioTracks: [], subTracks: [], durationSecs };
  let ai = 0, si = 0;
  for (const st of json.streams) {
    const lang = st.tags?.language || null;
    const title = st.tags?.title || null;
    const isDefault = !!st.disposition?.default;
    if (st.codec_type === "video" && st.codec_name !== "mjpeg" && st.codec_name !== "png") {
      if (!out.video) out.video = { codec: st.codec_name || null, width: st.width || 0, height: st.height || 0 };
    } else if (st.codec_type === "audio") {
      out.audioTracks.push({ i: ai++, abs: st.index, codec: st.codec_name || null, channels: st.channels || null, lang, title, default: isDefault });
    } else if (st.codec_type === "subtitle") {
      out.subTracks.push({ i: si++, abs: st.index, codec: st.codec_name || null, lang, title, kind: IMAGE_SUB_CODECS.has(st.codec_name) ? "image" : "text" });
    }
  }
  diskProbeCache[absPath] = { mtimeMs, data: out, ts: Date.now() };
  scheduleDiskProbeCacheSave();
  return out;
}

function stableDiskId(relpath) {
  const hex = crypto.createHash("sha1").update(relpath).digest("hex").slice(0, 13);
  return parseInt(hex, 16); // ≤ 2^52, safe integer, unique within the disk mode
}

// Synthetic id for a series-group tile — keyed by series NAME (not a
// filepath, unlike stableDiskId), so the same show groups to the same
// tile across rescans regardless of which episode files exist at any
// given time. Distinct hash prefix ("series:" salt) so a series group
// can never collide with a real file's id in the same disk:<id>
// tmdbCache / byId namespace.
function stableDiskSeriesId(seriesName) {
  const hex = crypto.createHash("sha1").update(`series:${seriesName.toLowerCase()}`).digest("hex").slice(0, 13);
  return parseInt(hex, 16);
}

const LANG_LABELS = {
  eng: "English", spa: "Spanish", fra: "French", fre: "French", deu: "German", ger: "German",
  ita: "Italian", por: "Portuguese", rus: "Russian", jpn: "Japanese", kor: "Korean",
  zho: "Chinese", chi: "Chinese", hin: "Hindi", tam: "Tamil", tel: "Telugu", ara: "Arabic",
  und: "Unknown",
};
function langLabel(code) {
  if (!code) return null;
  return LANG_LABELS[String(code).toLowerCase()] || String(code).toUpperCase();
}

// Recursively walk a library root collecting video files (depth/file capped,
// skipping hidden + Windows system dirs). Returns [{absPath, relpath, mtimeMs, folder}].
function walkLibrary(root) {
  const out = [];
  const SKIP_DIR = /^(\$|\.|@eaDir|System Volume Information$|#recycle$)/i;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 8 || out.length > 50000) break;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name.startsWith(".") || SKIP_DIR.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push({ dir: abs, depth: depth + 1 }); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!DISK_VIDEO_EXTS.has(ext)) continue;
      let stat; try { stat = fs.statSync(abs); } catch { continue; }
      const rel = path.relative(root, abs);
      const folder = path.dirname(rel) === "." ? "Movies" : path.dirname(rel).split(path.sep)[0];
      out.push({ absPath: abs, relpath: rel, mtimeMs: Math.round(stat.mtimeMs), folder });
    }
  }
  return out;
}

// Quick count (no probe) for the config-screen preview.
function countDiskVideos(root) {
  try { return walkLibrary(root).length; } catch { return 0; }
}

function slugifyCat(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "disk";
}

// Build (or rebuild) the disk index for one tenant. rootPath comes from the
// caller (the user record). Fills ix.disk.byId (client-safe) + ix.disk.meta
// (server-only absPath/tracks). Cheap on a warm probe cache (stats only).
async function buildDiskIndex(actx, rootPath) {
  const ix = getIndexesFor(actx).disk;
  ix.running = true;
  try {
    if (!rootPath) { ix.byId = new Map(); ix.meta = new Map(); ix.total = 0; ix.done = 0; ix.ready = true; return { count: 0 }; }
    let rootStat = null;
    try { rootStat = fs.statSync(rootPath); } catch {}
    if (!rootStat || !rootStat.isDirectory()) {
      console.warn(`[disk] path not a readable directory: ${rootPath}`);
      ix.byId = new Map(); ix.meta = new Map(); ix.ready = true; return { count: 0, error: "not-a-directory" };
    }
    const files = walkLibrary(rootPath);
    ix.total = files.length; ix.done = 0;
    const byId = new Map();
    const meta = new Map();
    const cats = new Map(); // catId -> catName
    // Save-to-Disk episodes group under one series tile instead of a
    // flat per-file dump (a big downloaded show would otherwise be
    // dozens of individual tiles — unmanageable). seriesId -> group.
    const seriesGroups = new Map();
    for (const f of files) {
      const a = analyzeDiskFile(f.absPath, f.mtimeMs);
      ix.done++;
      if (!a || !a.video) continue; // not a real video / probe failed
      const basename = path.basename(f.relpath);
      const id = stableDiskId(f.relpath);
      // catId stays derived from the raw folder name so it's stable even
      // if the display label below changes — only the label is prettied
      // up for Save-to-Disk's own "Downloads" folder (diskDownloadDestPath).
      const catId = slugifyCat(f.folder);
      const catName = f.folder === "Downloads" ? "Khouch IPTV Downloads" : f.folder;
      if (!cats.has(catId)) cats.set(catId, catName);
      // sidecar artwork next to the file
      const baseNoExt = f.absPath.replace(/\.[a-z0-9]+$/i, "");
      const posterPath = [`${baseNoExt}-poster.jpg`, `${baseNoExt}.jpg`, `${baseNoExt}-poster.png`].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
      const backdropPath = [`${baseNoExt}-backdrop.jpg`, `${baseNoExt}-fanart.jpg`].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
      const container = path.extname(f.relpath).slice(1).toLowerCase();
      const maxCh = a.audioTracks.reduce((mx, t) => Math.max(mx, t.channels || 0), 0);
      const trackSum = surroundLib.summarizeTracks(a.audioTracks);
      // client-safe audio/sub track summaries for the player selector
      const audioTracks = a.audioTracks.map(t => ({ index: t.i, codec: t.codec, channels: t.channels, lang: t.lang, label: t.title || langLabel(t.lang) || `Audio ${t.i + 1}`, default: t.default }));
      const subtitleTracks = a.subTracks.map(t => ({ index: t.i, codec: t.codec, lang: t.lang, kind: t.kind, label: t.title || langLabel(t.lang) || `Subtitle ${t.i + 1}` }));
      // meta always gets a per-file entry, grouped or not — playback
      // (/api/stream/disk/:id) resolves the REAL underlying file by its
      // own id regardless of whether the tile shown for it was a series
      // group or a standalone movie.
      meta.set(id, { absPath: f.absPath, root: rootPath, container, video: a.video, audioTracks: a.audioTracks, subTracks: a.subTracks, posterPath, backdropPath, durationSecs: a.durationSecs || null });

      const episodeInfo = parseDiskEpisode(basename);
      if (episodeInfo) {
        const seriesId = stableDiskSeriesId(episodeInfo.seriesName);
        let group = seriesGroups.get(seriesId);
        if (!group) {
          group = { seriesId, seriesName: episodeInfo.seriesName, catId, catName, year: episodeInfo.year, episodes: [] };
          seriesGroups.set(seriesId, group);
        }
        group.episodes.push({
          id, season: episodeInfo.season, episodeNum: episodeInfo.episodeNum,
          title: episodeInfo.episodeTitle,
          container, durationSecs: a.durationSecs || null,
          audio_channels: maxCh || null,
          audio_codec: trackSum?.codec || null,
          audio_atmos: !!trackSum?.atmos,
        });
        continue; // absorbed into the series group, not its own tile
      }

      const { title, year } = parseTitleYear(basename);
      let tags = streamTagsFor(title, ["disk"]);
      if (!tags.includes("disk")) tags = [...tags, "disk"];
      if (classifyAs4k(a.video.width, a.video.height) && !tags.includes("4k")) tags = [...tags, "4k"];
      const diskAudio = surroundLib.audioFields(trackSum);
      if (diskAudio.audio_badge && !tags.includes("surround")) tags = [...tags, "surround"];
      const tmdbEntry = tmdbCache[`disk:${id}`];
      byId.set(id, {
        id, name: title, year: year || null,
        icon: posterPath ? `/api/diskart/${id}/poster?acct=${diskAcctId(actx)}` : null,
        category_id: catId, category_name: catName,
        container,
        rating: null,
        us_cert: effCert(tmdbEntry) || null,
        tmdb_id: tmdbEntry?.tmdb_id || null,
        audio_channels: maxCh || null,
        audio_codec: diskAudio.audio_codec || a.audioTracks[0]?.codec || null,
        audio_format: diskAudio.audio_format || undefined,
        audio_badge: diskAudio.audio_badge || undefined,
        durationSecs: a.durationSecs || null,
        audioTracks, subtitleTracks,
        tags,
      });
    }
    // One synthetic tile per series group, keyed by series name so it
    // stays the same tile across rescans. No sidecar poster of its own
    // (icon: null) — same as any disk movie with no local poster file,
    // it picks up a real poster from tmdb_id via the normal downstream
    // TMDB-compositing path once ensureTmdbForItem/prewarmTmdbCache
    // matches it (isSeriesGroup tells prewarmTmdbCache to force a
    // series-shaped TMDB search rather than disk's movie-shaped default
    // — see prewarmTmdbCache). The episode list itself is server-only
    // (meta), read by GET /api/disk/series/:id for the episode picker.
    for (const group of seriesGroups.values()) {
      const seriesId = group.seriesId;
      group.episodes.sort((x, y) => x.season - y.season || x.episodeNum - y.episodeNum);
      const tmdbEntry = tmdbCache[`disk:${seriesId}`];
      const groupAudio = surroundLib.audioFields(surroundLib.summarizeTracks(group.episodes.map((e) => ({ channels: e.audio_channels, codec: e.audio_codec, title: e.audio_atmos ? "Atmos" : null }))));
      byId.set(seriesId, {
        id: seriesId, name: group.seriesName, year: group.year || null,
        icon: null,
        category_id: group.catId, category_name: group.catName,
        container: null,
        rating: null,
        us_cert: effCert(tmdbEntry) || null,
        tmdb_id: tmdbEntry?.tmdb_id || null,
        audio_channels: groupAudio.audio_channels,
        audio_codec: groupAudio.audio_codec,
        audio_format: groupAudio.audio_format || undefined,
        audio_badge: groupAudio.audio_badge || undefined,
        durationSecs: null,
        audioTracks: [], subtitleTracks: [],
        tags: groupAudio.audio_badge ? ["disk", "series-group", "surround"] : ["disk", "series-group"],
        isSeriesGroup: true,
        episodeCount: group.episodes.length,
      });
      meta.set(seriesId, { isSeriesGroup: true, seriesName: group.seriesName, episodes: group.episodes });
    }
    ix.byId = byId;
    ix.meta = meta;
    ix.ready = true;
    // Persist a synthetic categories file so /api/home/disk + search can
    // render folder rails through the normal category pipeline.
    const catArr = [...cats.entries()].map(([category_id, category_name]) => ({ category_id, category_name }));
    try { saveCategoriesToDisk("disk", catArr, actx); rebuildCategoryTags("disk", catArr, actx); } catch {}
    // Persist byId (client-safe) for debugging / quick boot visibility.
    try { await saveIndexToDisk("disk", actx); } catch {}
    console.log(`[disk] indexed ${byId.size} titles from ${rootPath} (${files.length} files scanned)`);
    return { count: byId.size };
  } finally {
    ix.running = false;
  }
}

// ===========================================================================
// DISK DOWNLOAD — "save to disk" for a movie or series episode, at the
// highest available quality: a stream COPY (no re-encode, no downscale —
// unlike /api/download's client-facing 720p CRF22 re-encode meant for a
// phone's limited storage). Runs as a background job queue, ONE AT A
// TIME, only while nobody is watching: the household has ONE provider
// connection, so a job takes the SAME admitStream() slot a viewer uses (via
// a synthetic "disk-download:" owner key), only when the slot is free, and
// gives it up the moment a viewer asks to play (see diskDownloadGate /
// preemptDiskDownloadsForViewer). Disk is owner-only (see userDiskPath), so
// this whole subsystem only ever targets the owner's disk root.
// ===========================================================================

const DISK_DOWNLOAD_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB headroom
const DISK_DOWNLOAD_DISPLACED_RETRY_MS = 30_000;
const DISK_DOWNLOAD_MAX_ERROR_RETRIES = 8;

// Persisted the same way as diskProbeCache above — a plain in-memory Map
// used to be the whole store, so a container restart (a deploy, a crash)
// silently dropped every queued/paused job with zero trace. Loaded
// once at boot; "downloading"/"paused" entries are demoted back to
// "queued" since whatever admitStream/ffmpeg state they held is gone
// with the old process — the job itself resumes cleanly via the existing
// tmpPath + Range logic in runDiskDownloadJob.
const diskDownloadJobsFile = path.join(DATA_DIR, "disk-download-jobs.json");
const diskDownloadJobs = new Map(); // jobId -> job
try {
  const saved = JSON.parse(fs.readFileSync(diskDownloadJobsFile, "utf8"));
  for (const job of saved) {
    if (job.status === "downloading" || job.status === "paused") {
      job.status = "queued";
      job.pausedReason = null;
    }
    diskDownloadJobs.set(job.jobId, job);
  }
} catch {}
// Unlike diskProbeCache's save (called per-item during a bulk scan, hence
// debounced), this fires only a handful of times across a whole job's
// lifecycle — cheap enough to write synchronously. That matters here
// specifically: a debounced write pending when the container gets SIGTERM'd
// (the Dockerfile has no signal-forwarding init, so Node exits immediately
// with no chance to flush a timer) would lose exactly the transition this
// fix exists to survive — e.g. a `"done"` a few hundred ms before a deploy
// lands would boot back as `"queued"` and silently re-download. History
// (done/failed) is capped to the newest 200 by createdAt, matching the
// `GET /jobs` display cap, so a long-lived job history doesn't turn every
// save into an ever-growing write — but anything still actionable
// (queued/downloading/paused) is ALWAYS kept regardless of the cap: a
// "download whole series" click can queue hundreds of same-timestamp
// episode jobs in one request, and letting recency evict from that set
// would silently drop the front of a FIFO queue right when a restart
// mid-batch is the exact case this feature exists to survive.
function saveDiskDownloadJobs() {
  try {
    const all = [...diskDownloadJobs.values()];
    const active = all.filter((j) => j.status === "queued" || j.status === "downloading" || j.status === "paused");
    const terminal = all.filter((j) => j.status === "done" || j.status === "failed")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200);
    fs.writeFileSync(diskDownloadJobsFile + ".tmp", JSON.stringify([...active, ...terminal]));
    fs.renameSync(diskDownloadJobsFile + ".tmp", diskDownloadJobsFile);
  } catch (e) { console.warn(`[disk-download] jobs save failed: ${e.message}`); }
}
let diskDownloadQueueRunning = false;

function diskDownloadFreeBytes(rootPath) {
  try {
    const s = fs.statfsSync(rootPath);
    return s.bavail * s.bsize;
  } catch (e) {
    console.warn(`[disk-download] statfs failed for ${rootPath}: ${e.message}`);
    return null;
  }
}

function diskDownloadSafeName(s) {
  return String(s).replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, " ").trim();
}

// Downloads land in a dedicated "Downloads" subfolder of the disk root —
// buildDiskIndex categorizes by top-level folder, so these show up as
// their own "Downloads" rail rather than mixing into whatever other
// folders the owner has organized. Filenames follow the same
// `Title (YYYY)` shape parseTitleYear() expects, so a rescan indexes them
// exactly like any manually-placed file. Series episodes have no
// season/episode grouping in Disk mode (it's a flat movie-style library —
// see the DISK MEDIA comment above), so each downloaded episode becomes
// its own standalone Disk entry named "Series Name SxxEyy - Title (Year)".
function diskDownloadDestPath(rootPath, job) {
  const dir = path.join(rootPath, "Downloads");
  fs.mkdirSync(dir, { recursive: true });
  // year goes through the same sanitizer as title/seriesTitle/episodeTitle
  // — all four are client-supplied (POST /api/disk-download body) and
  // land raw in a real filesystem path. Missing this on `year` alone was
  // a live path-traversal hole: a body like
  // {year: "2020)/../../../../etc/cron.d/evil"} survived into the
  // template literal untouched and path.join() happily normalized the
  // embedded "../" segments outside `dir`.
  const year = diskDownloadSafeName(job.year || "");
  let filename;
  if (job.mode === "movie") {
    filename = diskDownloadSafeName(job.title) + (year ? ` (${year})` : "");
  } else {
    const season = String(job.season || 0).padStart(2, "0");
    const ep = String(job.episodeNum || 0).padStart(2, "0");
    filename = `${diskDownloadSafeName(job.seriesTitle)} S${season}E${ep}`
      + (job.episodeTitle ? ` - ${diskDownloadSafeName(job.episodeTitle)}` : "")
      + (year ? ` (${year})` : "");
  }
  const dest = path.join(dir, `${filename}.${job.ext}`);
  // Defense-in-depth containment check, matching the pattern the disk
  // media routes already use (see CLAUDE.md: "containment-check the
  // absolute path under the account's configured root") — belt-and-
  // braces in case any future field lands in `filename` unsanitized the
  // way `year` just was.
  const resolved = path.resolve(dest);
  if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`refusing to write outside Downloads dir: ${resolved}`);
  }
  return resolved;
}

// job: { mode, id, title, year, seriesTitle?, season?, episodeNum?,
//        episodeTitle? } — enough to resolve the source URL and name the
// destination file. Returns the new job's id.
function enqueueDiskDownload(job) {
  const jobId = crypto.randomUUID();
  // jobId (this queue entry's own tracking id) is a DIFFERENT thing from
  // job.id (the panel's movie/episode content id, already present on the
  // spread-in `job` spec) — spreading `job` last previously clobbered a
  // same-named `id` field with the content id, silently breaking any
  // future correlation between "the id POST /api/disk-download returned"
  // and "the id this job shows up under in GET .../jobs". Named distinctly
  // so the spread can never collide.
  diskDownloadJobs.set(jobId, {
    jobId,
    status: "queued",
    createdAt: Date.now(),
    bytesWritten: 0,
    retries: 0,
    error: null,
    ...job,
  });
  saveDiskDownloadJobs();
  processDiskDownloadQueue().catch((e) => console.warn(`[disk-download] queue error: ${e.message}`));
  return jobId;
}

// When a job may move bytes: lib/disk-download-schedule.js (pure). By default
// there is NO window: a job starts as soon as nobody is watching, yields the
// moment a viewer asks for a stream (preemptDiskDownloadsForViewer from
// /api/stream, plus admitStream's oldest-evicted rule as the backstop), and
// resumes via HTTP Range once no viewer has been seen for
// DISK_DOWNLOAD_RESUME_GRACE_MS. The overnight window is opt-in: only when
// BOTH DISK_DOWNLOAD_WINDOW_START_HOUR and _END_HOUR are set. Hours are in the
// household's timezone (the container runs in UTC).
const diskDlSchedule = require("./lib/disk-download-schedule");
const DISK_DOWNLOAD_WINDOW = diskDlSchedule.parseWindowEnv(
  process.env.DISK_DOWNLOAD_WINDOW_START_HOUR, process.env.DISK_DOWNLOAD_WINDOW_END_HOUR);
if (DISK_DOWNLOAD_WINDOW.invalid) {
  console.warn("[disk-download] DISK_DOWNLOAD_WINDOW_START_HOUR/END_HOUR need both set to different hours 0-23; ignoring them (no window)");
}
const DISK_DOWNLOAD_WINDOW_TZ = process.env.DISK_DOWNLOAD_WINDOW_TZ || "America/New_York";
const DISK_DOWNLOAD_WINDOW_POLL_MS = 5 * 60_000;
const DISK_DOWNLOAD_POLL_MS = 10_000;
const DISK_DOWNLOAD_RESUME_GRACE_MS = diskDlSchedule.graceMsFrom(process.env.DISK_DOWNLOAD_RESUME_GRACE_MS);
// Newest viewer activity seen (admission, media request, a pause heartbeat's
// lastSeen bump, a play request). Starts at boot time so a deploy restart
// gives the players that were watching a grace to reconnect first.
let diskDownloadLastViewerAt = Date.now();
function noteViewerActivity(owner) {
  if (!diskDlSchedule.isBackgroundOwner(owner)) diskDownloadLastViewerAt = Date.now();
}

function currentHourInDiskDownloadWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISK_DOWNLOAD_WINDOW_TZ, hour: "numeric", hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour").value) % 24;
}
// Always open when no window is configured.
function isDiskDownloadWindowOpen() {
  if (!DISK_DOWNLOAD_WINDOW.enabled) return true;
  return diskDlSchedule.hourInWindow(currentHourInDiskDownloadWindow(),
    DISK_DOWNLOAD_WINDOW.startHour, DISK_DOWNLOAD_WINDOW.endHour);
}
// { run, waitingFor } for a job right now. `selfOwner`: the job's own streams key.
function diskDownloadGate(selfOwner = null) {
  diskDownloadLastViewerAt = diskDlSchedule.latestViewerSeen(streams, diskDownloadLastViewerAt);
  const d = diskDlSchedule.decideDiskDownload({
    now: Date.now(),
    windowEnabled: DISK_DOWNLOAD_WINDOW.enabled,
    windowOpen: isDiskDownloadWindowOpen(),
    holder: diskDlSchedule.slotHolder(streams, selfOwner, accountKeyOf(ownerAccount)),
    lastViewerAt: diskDownloadLastViewerAt,
    graceMs: DISK_DOWNLOAD_RESUME_GRACE_MS,
  });
  // A catalog / EPG refresh claimed the connection recently.
  if (d.run && (diskDownloadPanelBusy > 0 || Date.now() - diskDownloadPanelClaimAt < DISK_DOWNLOAD_PANEL_CLAIM_MS)) return { run: false, waitingFor: "queue" };
  return d;
}
// A viewer asked to play (GET /api/stream): stop any Save-to-Disk transfer NOW,
// synchronously, so its upstream connection is already closing before the
// player's first manifest/segment request reaches the provider. The entry is
// tagged displaced (as admitStream would) so it never counts against the
// viewer's admission; the job's own abort path deletes it and goes back to
// waiting for the grace.
// Background panel work (catalog rebuild, EPG) wants the connection: hold
// jobs back for DISK_DOWNLOAD_PANEL_CLAIM_MS after the latest claim (each
// rebuild step re-claims) and stop a running transfer. True while a transfer's
// entry is still present (it is deleted once its connection has aborted), so
// every concurrent caller waits for the close, not just the first.
const DISK_DOWNLOAD_PANEL_CLAIM_MS = 90_000; // >= the longest single panel call (60 s list timeout)
let diskDownloadPanelClaimAt = 0;
let diskDownloadPanelBusy = 0; // a long provider request (xmltv) in flight
function claimPanelFromDiskDownloads(label) {
  diskDownloadPanelClaimAt = Date.now();
  let n = 0, present = 0;
  for (const [k, v] of streams) {
    if (!diskDlSchedule.isDiskDownloadOwner(k)) continue;
    present++;
    if (v.displaced) continue;
    v.displaced = true;
    for (const kill of v.killers) { try { kill("queue"); } catch {} }
    n++;
  }
  if (n) console.log(`[disk-download] yielding to panel work (${label})`);
  return present > 0;
}
// Trailers come from YouTube, not the panel: only real viewers matter.
function streamingNowViewers60s() {
  const now = Date.now();
  for (const [owner, v] of streams) {
    if (v.displaced || v.preview || now - v.lastSeen >= 60_000 || v.mode === "disk") continue;
    if (!diskDlSchedule.isBackgroundOwner(owner)) return true;
  }
  return false;
}
function preemptDiskDownloadsForViewer(reason) {
  if (reason !== "queue") diskDownloadLastViewerAt = Date.now(); // "queue" = a phone download, not a viewer
  let n = 0;
  for (const [k, v] of streams) {
    if (!diskDlSchedule.isDiskDownloadOwner(k) || v.displaced) continue;
    v.displaced = true;
    for (const kill of v.killers) { try { kill(reason); } catch {} }
    n++;
  }
  if (n) console.log(`[disk-download] yielding to a viewer (${reason})`);
  return n;
}

async function processDiskDownloadQueue() {
  if (diskDownloadQueueRunning) return;
  diskDownloadQueueRunning = true;
  try {
    while (true) {
      const job = [...diskDownloadJobs.values()].find((j) => j.status === "queued");
      if (!job) break;
      const gate = diskDownloadGate();
      if (!gate.run) {
        await new Promise((r) => setTimeout(r, gate.waitingFor === "window" ? DISK_DOWNLOAD_WINDOW_POLL_MS : DISK_DOWNLOAD_POLL_MS));
        continue;
      }
      await runDiskDownloadJob(job);
    }
  } finally {
    diskDownloadQueueRunning = false;
  }
}

async function runDiskDownloadJob(job) {
  const user = ownerUser();
  const rootPath = userDiskPath(user);
  if (!rootPath || !userDiskEnabled(user)) {
    job.status = "failed";
    job.error = "disk not configured";
    saveDiskDownloadJobs();
    return;
  }

  const free = diskDownloadFreeBytes(rootPath);
  if (free != null && free < DISK_DOWNLOAD_MIN_FREE_BYTES) {
    job.status = "failed";
    job.error = `disk almost full (${(free / 1024 / 1024 / 1024).toFixed(1)} GB free, need ${DISK_DOWNLOAD_MIN_FREE_BYTES / 1024 / 1024 / 1024} GB headroom)`;
    console.warn(`[disk-download] ${job.jobId} (content id ${job.id}) refused: ${job.error}`);
    saveDiskDownloadJobs();
    return;
  }

  const owner = `disk-download:${job.jobId}`;
  let sourceUrl = null;
  let destPath = null;
  let tmpPath = null;
  const setStatus = (status) => {
    if (job.status === status) return;
    job.status = status;
    saveDiskDownloadJobs();
  };

  while (true) {
    // Never call admitStream() while anyone else holds the slot: its "newest
    // wins" rule would evict an ALREADY-WATCHING viewer for this job. The gate
    // also waits out the resume grace after the last viewer activity, and the
    // check is synchronous with the admitStream() below (no await between), so
    // a real request cannot interleave. Once admitted, the only way this job
    // loses the slot is a viewer arriving later (preempt / oldest-evicted).
    const gate = diskDownloadGate(owner);
    if (!gate.run) {
      job.pausedReason = gate.waitingFor;
      setStatus("paused");
      await new Promise((r) => setTimeout(r, gate.waitingFor === "window" ? DISK_DOWNLOAD_WINDOW_POLL_MS : DISK_DOWNLOAD_POLL_MS));
      continue;
    }
    // Recomputed every pass (a panel failover switches ownerAccount.host).
    const accountKey = accountKeyOf(ownerAccount);
    const ac = new AbortController();
    const killer = (reason) => {
      job.pausedReason = reason;
      ac.abort();
    };
    const admission = admitStream(owner, job.mode, job.id, killer, accountKey);
    if (!admission.ok) {
      // Our own prior registration is still tagged displaced.
      streams.delete(owner);
      setStatus("paused");
      await new Promise((r) => setTimeout(r, DISK_DOWNLOAD_POLL_MS));
      continue;
    }
    job.pausedReason = null;
    setStatus("downloading");

    try {
      if (!sourceUrl) {
        // A real (tiny) provider request, so it runs under the admission too.
        const r = await resolveDownloadSourceUrl(job.mode, job.id, ownerAccount, ac.signal);
        if (ac.signal.aborted) throw new Error("aborted");
        if (!r.sourceUrl) throw new Error(`source unavailable: ${redactAllUrls(r.error)}`);
        sourceUrl = r.sourceUrl;
        if (!destPath) {
          job.ext = r.ext;
          destPath = diskDownloadDestPath(rootPath, job);
          tmpPath = `${destPath}.part`;
        }
      }

      let startByte = 0;
      try { startByte = fs.statSync(tmpPath).size; } catch {}

      const resp = await fetch(sourceUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV)",
          ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {}),
        },
        redirect: "follow",
        signal: ac.signal,
      });
      let complete = false;
      let expectedTotal = null;
      if (resp.status === 416 && startByte > 0) {
        // Nothing past what we have: complete if the source size is exactly
        // the .part size (e.g. a restart between the last byte and the rename).
        const total = Number(/\/(\d+)\s*$/.exec(resp.headers.get("content-range") || "")?.[1]);
        try { await resp.body?.cancel(); } catch {}
        if (total !== startByte) {
          fs.rmSync(tmpPath, { force: true });
          throw new Error("resume rejected (416); restarting from zero");
        }
        complete = true;
      } else {
        if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
        if (/^text\//i.test(resp.headers.get("content-type") || "")) {
          try { await resp.body?.cancel(); } catch {}
          throw new Error("provider returned an error page instead of video");
        }
        const resumed = resp.status === 206;
        if (resumed) {
          const crStart = Number(/bytes\s+(\d+)-/.exec(resp.headers.get("content-range") || "")?.[1]);
          if (crStart !== startByte) {
            try { await resp.body?.cancel(); } catch {}
            fs.rmSync(tmpPath, { force: true });
            throw new Error(`resume offset mismatch (asked ${startByte}, got ${crStart}); restarting from zero`);
          }
        } else if (startByte > 0) {
          console.log(`[disk-download] ${job.jobId} source ignored Range; restarting from zero`);
        }
        // Expected total, to catch a CDN that closes cleanly mid-transfer: a
        // 206's Content-Range total, or a 200's Content-Length. Missing ->
        // proceed on trust.
        expectedTotal = resumed
          ? Number(resp.headers.get("content-range")?.split("/")?.[1]) || null
          : Number(resp.headers.get("content-length")) || null;
        if (expectedTotal != null) {
          job.totalBytes = expectedTotal;
          const freeNow = diskDownloadFreeBytes(rootPath);
          const need = expectedTotal - (resumed ? startByte : 0) + DISK_DOWNLOAD_MIN_FREE_BYTES;
          if (freeNow != null && freeNow < need) {
            try { await resp.body?.cancel(); } catch {}
            throw Object.assign(new Error(`disk almost full (${(freeNow / 1024 / 1024 / 1024).toFixed(1)} GB free, this title needs ${(need / 1024 / 1024 / 1024).toFixed(1)} GB incl. headroom)`), { fatal: true });
          }
        }
        // Resync to the .part file's real size (bytesWritten is only persisted
        // on status transitions).
        job.bytesWritten = resumed ? startByte : 0;
        const out = fs.createWriteStream(tmpPath, { flags: resumed ? "a" : "w" });
        const source = Readable.fromWeb(resp.body);
        // touchStream keeps the entry's lastSeen fresh so the idle reaper
        // never mistakes a healthy transfer for an abandoned viewer.
        source.on("data", (chunk) => { job.bytesWritten += chunk.length; touchStream(owner); });
        await pipeline(source, out);
        if (expectedTotal != null) {
          const actual = fs.statSync(tmpPath).size;
          if (actual < expectedTotal) {
            throw new Error(`truncated transfer: got ${actual} of ${expectedTotal} bytes`);
          }
        }
      }

      // Completed without abort, size verified — success.
      fs.renameSync(tmpPath, destPath);
      try { job.bytesWritten = fs.statSync(destPath).size; } catch {}
      job.status = "done";
      job.finishedAt = Date.now();
      job.pausedReason = null;
      saveDiskDownloadJobs();
      dropStreamKiller(owner, killer);
      streams.delete(owner);
      console.log(`[disk-download] ${job.jobId} done → ${destPath} (${(job.bytesWritten / 1024 / 1024).toFixed(0)} MB${complete ? ", already complete" : ""})`);
      try {
        await buildDiskIndex(ownerAccount, rootPath);
        prewarmTmdbCache("disk", ownerAccount).catch(() => {});
      } catch (e) {
        console.warn(`[disk-download] post-download rescan failed: ${e.message}`);
      }
      return;
    } catch (e) {
      dropStreamKiller(owner, killer);
      streams.delete(owner);
      if (ac.signal.aborted) {
        // A viewer took the slot (or the reaper freed a stalled transfer).
        // Expected, not an error: back to the gate, then resume via Range.
        console.log(`[disk-download] ${job.jobId} paused (${job.pausedReason || "displaced"}) at ${(job.bytesWritten / 1024 / 1024).toFixed(0)} MB — will resume`);
        sourceUrl = null; // re-resolve on resume (a panel failover may have moved hosts)
        setStatus("paused");
        continue;
      }
      job.error = redactAllUrls(e.message);
      if (e.fatal) {
        job.status = "failed";
        console.warn(`[disk-download] ${job.jobId} failed: ${job.error}`);
        saveDiskDownloadJobs();
        return;
      }
      job.retries += 1;
      if (job.retries > DISK_DOWNLOAD_MAX_ERROR_RETRIES) {
        job.status = "failed";
        console.warn(`[disk-download] ${job.jobId} gave up after ${job.retries} attempts: ${job.error}`);
        if (tmpPath) { try { fs.rmSync(tmpPath, { force: true }); } catch {} }
        saveDiskDownloadJobs();
        return;
      }
      console.warn(`[disk-download] ${job.jobId} retry ${job.retries}/${DISK_DOWNLOAD_MAX_ERROR_RETRIES}: ${job.error}`);
      await new Promise((r) => setTimeout(r, Math.min(5000 * job.retries, 60_000)));
    }
  }
}

// ---- account-bound signing for the unauthenticated disk media routes ----
// We embed the owning userId in the URL and HMAC over `${kind}:${userId}:${id}`
// so a signed URL minted for tenant A can't be replayed to read tenant B's
// files. The route resolves that user's account and looks up THAT account's
// disk.meta — never a path from the query — then containment-checks absPath.
function diskAcctId(actx) {
  if (isOwnerAccount(actx)) { const o = ownerUser(); return o ? o.id : "u1"; }
  const u = accounts.users.find(x => getAccountForUser(x) === actx);
  return u ? u.id : "u1";
}
function signDisk(kind, acctId, id) {
  return crypto.createHmac("sha256", PROXY_SECRET).update(`${kind}:${acctId}:${id}`).digest("hex").slice(0, 16);
}
function verifyDisk(kind, acctId, id, sig) {
  if (!sig) return false;
  return sig === signDisk(kind, acctId, id);
}
// Resolve the account + meta for a signed disk request. Returns
// {meta, entry, actx} or null. Containment-checks absPath under the
// account's configured root as defense-in-depth.
function resolveDiskRequest(kind, req, requireSig = true) {
  const id = Number(req.query.id != null ? req.query.id : req.params.id);
  const acctId = String(req.query.acct || "");
  if (!Number.isFinite(id) || !acctId) return null;
  if (requireSig && !verifyDisk(kind, acctId, id, req.query.s)) return null;
  const user = getUserById(acctId);
  if (!user) return null;
  const actx = getAccountForUser(user);
  const meta = getIndexesFor(actx).disk?.meta?.get(id);
  // A series-group entry has no absPath (it's not a real file) — not
  // reachable today (nothing signs a disk URL for a group id), but
  // path.resolve(undefined) below would throw if that ever changes.
  if (!meta || meta.isSeriesGroup) return null;
  // containment: absPath must live under the configured root
  const root = path.resolve(meta.root || userDiskPath(user) || "");
  const abs = path.resolve(meta.absPath);
  if (!root || (abs !== root && !abs.startsWith(root + path.sep))) return null;
  return { id, acctId, user, actx, meta };
}

const app = express();

// Honor X-Forwarded-Proto so `req.secure` reflects the upstream
// (Traefik terminates TLS and forwards HTTP to us). This drives the
// conditional `Secure` attribute on session/profile cookies — Secure
// breaks non-browser clients on HTTP (OkHttp follows the RFC and
// drops them on the next request), so we only set it when the
// client actually reached us over HTTPS.
app.set("trust proxy", true);

// no-store so Cloudflare doesn't cache the SHA — the deploy workflow
// polls this endpoint after each push to confirm the new container is
// live, and stale cached responses caused the SHA-match wait to time
// out (manifested as "deploy failed" on a perfectly healthy recreate).
app.get("/healthz", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, sha: process.env.GIT_SHA || "dev" });
});

// --- signed media routes (no app auth required, validated by HMAC) ---
// These are placed BEFORE the session-auth middleware so the browser's
// <video> element can fetch them without sending a session cookie or
// re-prompting for credentials.

const DISK_MIME = {
  m4v: "video/x-m4v", mp4: "video/mp4", mkv: "video/x-matroska", webm: "video/webm",
  mov: "video/quicktime", avi: "video/x-msvideo", ts: "video/mp2t", m2ts: "video/mp2t",
  wmv: "video/x-ms-wmv", flv: "video/x-flv", mpg: "video/mpeg", mpeg: "video/mpeg",
};

// Direct-play a local file with HTTP Range support → native instant seeking
// in the browser/Chromecast. Account-bound signature; absPath comes from the
// account's disk.meta, never the query (no path traversal).
// Direct-play Disk viewers (not in `streams`); the media sidecar yields to
// them: open responses (one open-ended Range can stream a whole movie) plus
// a 2 min tail after the last one.
let diskfileLastSeen = 0;
let diskfileActive = 0;
app.get("/api/diskfile", (req, res) => {
  const r = resolveDiskRequest("file", req, true);
  if (!r) return res.status(403).end();
  diskfileLastSeen = Date.now();
  diskfileActive++;
  let counted = true;
  res.on("close", () => { if (counted) { counted = false; diskfileActive--; diskfileLastSeen = Date.now(); } });
  let stat; try { stat = fs.statSync(r.meta.absPath); } catch { return res.status(404).end(); }
  const total = stat.size;
  const ext = path.extname(r.meta.absPath).slice(1).toLowerCase();
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", DISK_MIME[ext] || "application/octet-stream");
  const range = req.headers.range;
  if (range) {
    const mm = /bytes=(\d*)-(\d*)/.exec(range);
    let start = mm && mm[1] ? parseInt(mm[1], 10) : 0;
    let end = mm && mm[2] ? parseInt(mm[2], 10) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.status(416).setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
    res.setHeader("Content-Length", end - start + 1);
    const s = fs.createReadStream(r.meta.absPath, { start, end });
    s.on("error", () => res.destroy());
    s.pipe(res);
  } else {
    res.status(200);
    res.setHeader("Content-Length", total);
    const s = fs.createReadStream(r.meta.absPath);
    s.on("error", () => res.destroy());
    s.pipe(res);
  }
});

// Extract an embedded TEXT subtitle track to WebVTT on demand (cached in tmp).
// Image subs (PGS/VOBSUB) are not served here — they get burned in at
// transcode time (see /api/stream).
app.get("/api/disksubs/:id/:track.vtt", (req, res) => {
  const r = resolveDiskRequest("subs", req, true);
  if (!r) return res.status(403).end();
  const trackIdx = parseInt(req.params.track, 10);
  const sub = (r.meta.subTracks || []).find(t => t.i === trackIdx);
  if (!sub) return res.status(404).end();
  if (sub.kind !== "text") return res.status(415).end();
  const dir = path.join(os.tmpdir(), "khouch-disksubs");
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const out = path.join(dir, `${r.id}-${trackIdx}.vtt`);
  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  try {
    if (!(fs.existsSync(out) && fs.statSync(out).size > 0)) {
      const rr = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", r.meta.absPath, "-map", `0:s:${trackIdx}`, "-f", "webvtt", out], { timeout: 30000 });
      if (rr.status !== 0) return res.status(500).end();
    }
  } catch { return res.status(500).end(); }
  return res.sendFile(out);
});

// Serve on-disk sidecar artwork (poster/backdrop). Not signed (posters aren't
// sensitive) but still account-scoped + containment-checked.
app.get("/api/diskart/:id/:kind", (req, res) => {
  const r = resolveDiskRequest("art", req, false);
  if (!r) return res.status(404).end();
  const p = req.params.kind === "backdrop" ? r.meta.backdropPath : r.meta.posterPath;
  if (!p) return res.status(404).end();
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.sendFile(p);
});

function alternateHosts(target, actx = currentAccount()) {
  if (actx.candidates.length < 2) return [];
  let url; try { url = new URL(target); } catch { return []; }
  return actx.candidates
    .filter(panel => new URL(panel).host !== url.host)
    .map(panel => {
      const p = new URL(panel);
      const alt = new URL(target);
      alt.protocol = p.protocol; alt.host = p.host; alt.port = p.port;
      return alt.href;
    });
}

async function fetchUpstream(target, range, externalSignal) {
  // Compose the external (client-disconnect) signal with our own
  // timeout so closing the browser tab tears down the upstream fetch
  // instantly — otherwise Node fetch happily keeps reading data into
  // the void after the client goes away, holding the panel's
  // max_connections=1 slot through the natural drain.
  const signal = externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000);
  return fetch(target, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36",
      "Accept": "*/*",
      ...(range ? { "Range": range } : {}),
    },
    signal,
  });
}

app.get("/api/proxy", async (req, res, _next) => {
  const target = req.query.u;
  if (!target) return res.status(400).end();
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).end(); }
  if (!/^https?:$/.test(parsed.protocol)) return res.status(400).end();
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return res.status(403).end();
  }
  if (!verifyProxySig(target, req.query.s)) return res.status(403).end();

  const isManifestPath = target.includes(".m3u8");

  // Tie the upstream fetch lifetime to the client connection. As soon as
  // the browser disconnects (tab close, hard refresh, channel switch),
  // we abort the panel-side fetch so its connection slot is released
  // immediately rather than draining the rest of the segment.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on("close", onClose);

  // Admission control. If the URL identifies a stream (manifest or
  // direct VOD URL or live segment with chid), claim a slot on behalf
  // of this request's owner. Sub-segments without an obvious mode/id
  // just bump lastSeen on the existing entry — refused if the owner
  // was displaced.
  const owner = ownerKeyOf(req);
  const parsed2 = parseStreamFromPanelUrl(target);
  const killer = () => { try { ac.abort(); } catch {} };
  if (parsed2) {
    const ad = admitStream(owner, parsed2.mode, parsed2.id, killer, currentAccountKey());
    if (!ad.ok) return sendDisplaced(res);
  } else {
    if (!touchStream(owner)) return sendDisplaced(res);
  }
  res.on("close", () => dropStreamKiller(owner, killer));

  try {
    let upstream = await fetchUpstream(target, req.headers.range, ac.signal);
    let effectiveTarget = target;
    let fellBack = false;

    if (isManifestPath) {
      const looksEmpty = (h) => h.headers.get("content-length") === "0" || !h.ok;
      if (looksEmpty(upstream)) {
        for (const alt of alternateHosts(target)) {
          const upstream2 = await fetchUpstream(alt, req.headers.range, ac.signal);
          if (!looksEmpty(upstream2)) {
            upstream = upstream2;
            effectiveTarget = alt;
            fellBack = true;
            break;
          }
        }
      }
    }

    res.status(upstream.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    for (const h of ["content-length", "content-range", "accept-ranges", "cache-control"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }

    if (target.includes(".m3u8") || ct.includes("mpegurl")) {
      const baseForRelatives = upstream.url || target;
      const text = await upstream.text();
      const rewritten = text.split(/\r?\n/).map(line => {
        if (!line || line.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (_m, u) => {
            const abs = new URL(u, baseForRelatives).href;
            return `URI="${signProxyUrl(abs)}"`;
          });
        }
        const t = line.trim();
        if (!t) return line;
        const abs = new URL(t, baseForRelatives).href;
        return signProxyUrl(abs);
      }).join("\n");
      res.removeHeader("content-length");
      res.send(rewritten);
    } else if (upstream.body) {
      // Keep the cap=1 slot alive while bytes are actively flowing. A
      // progressive <video> (direct-play VOD) makes ONE long /api/proxy
      // request and reads it for minutes without re-hitting the endpoint,
      // so nothing bumps the streams-map lastSeen — and the idle reaper
      // (LIVE_IDLE_GRACE_MS) then aborts this pipe mid-file, stalling
      // playback every ~3 min (each resume buys another window). Touch on
      // data (throttled) so an actively-downloading stream is never
      // mistaken for a departed viewer; when the client truly stops
      // reading, data stops, idle grows, and it reaps correctly.
      const src = Readable.fromWeb(upstream.body);
      let lastTouch = Date.now();
      src.on("data", () => {
        const now = Date.now();
        if (now - lastTouch > 15000) { lastTouch = now; touchStream(owner); }
      });
      src.on("error", () => res.end()).pipe(res);
    } else {
      res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.status(502);
    res.end();
  }
});

app.get("/api/transcode/:mode(live|movie|series|disk)/:id/index.m3u8", async (req, res, next) => {
  // The source-seek offset (?t=<secs>) IS part of the HMAC so a
  // client can't ask for an arbitrary anchor without a fresh signed
  // URL from /api/stream. t=0 (the common case) signs the same as
  // before, so old client URLs keep working.
  const offsetSecs = normalizeOffsetSecs(req.query.t);
  const sigInput = offsetSecs > 0
    ? `transcode:${req.params.mode}:${req.params.id}:${offsetSecs}`
    : `transcode:${req.params.mode}:${req.params.id}`;
  const expected = crypto.createHmac("sha256", PROXY_SECRET).update(sigInput).digest("hex").slice(0, 16);
  if (req.query.s !== expected) return res.status(403).end();
  // Quality + audio mode are NOT baked into the HMAC — both are UX
  // settings, not authorization concerns. Default audio to "stereo"
  // so legacy callers (web, older TV builds) keep working.
  const quality = normalizeQuality(req.query.q);
  const audio = normalizeAudio(req.query.a);
  // Disk audio/subtitle selection (?da=, ?ds=) — null for panel modes.
  const diskSel = diskSelFromQuery(req.params.mode, req.query);
  // Panel audio track (outside the HMAC, a UX setting like ?q/?a):
  //   ?at=N  the viewer's explicit choice (0 included; repeated -> last wins)
  //   ?ap=N  the server's default pick baked in by /api/stream
  //   neither: a running auto transcoder for these params, else a pick
  //   from the cached track list, else track 0 + learn-and-restart
  //   (autoPick, see spawnTranscoder). The transcoder is keyed by the
  //   EFFECTIVE track, so key == what ffmpeg maps.
  const vod = req.params.mode === "movie" || req.params.mode === "series";
  const { explicit: atExplicit, serverPick: atServer } = audioTracksLib.resolveAudioTrackParam(req.query);
  const baseKey = transcoderKey(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, 0);
  const autoMode = vod && atExplicit == null && atServer == null;
  const aliased = autoMode ? transcoders.get(autoTrackAlias.get(baseKey)) : null;
  let { audioTrack, autoPick } = audioTracksLib.effectiveAudioTrack({
    vod, explicit: atExplicit, serverPick: atServer,
    aliasedTrack: aliased && !aliased.stopping ? (aliased.keyTrack || 0) : null,
    cachedPick: autoMode && !aliased ? cachedAudioPick(req.params.mode, req.params.id) : null,
  });
  // An explicit/server index past the cached track count would map no audio.
  if (!aliased && audioTrack > 0) {
    const c = panelTracksCache[`${req.params.mode}:${req.params.id}`];
    audioTrack = audioTracksLib.clampTrack(audioTrack, c?.audioTracks?.length || null);
  }
  // Admission control. The killer here SIGTERMs the ffmpeg so the
  // upstream panel slot is freed when this owner gets displaced.
  const owner = ownerKeyOf(req);
  let tRef = null; // the entry this request runs on (its key can change on an audio restart)
  const killer = (reason = "admit-displace") => {
    stopTranscoder(tRef || transcoders.get(transcoderKey(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, audioTrack)), reason);
  };
  const ad = admitStream(owner, req.params.mode, req.params.id, killer, currentAccountKey());
  if (!ad.ok) return sendDisplaced(res);
  try {
    const t = await startOrTouchTranscoder(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, audioTrack, autoPick);
    tRef = t;
    if (autoMode && t.key) setAutoTrackAlias(baseKey, t.key);
    noteOwner(t, owner);
    // 30 s startup window. Heavy MKVs (4K HEVC with TrueHD audio) can
    // need 15-20 s for ffmpeg to read the source headers + emit the
    // first segment on a 2-vCPU VPS. The earlier 15 s budget timed out
    // legitimately-playable titles (Spectre, etc.) before any data
    // arrived.
    for (let i = 0; i < 120; i++) {
      // Re-read t.dir each pass: an audio auto-pick restart moves the entry
      // to its new track's key/dir.
      const playlistPath = path.join(t.dir, "index.m3u8");
      if (fs.existsSync(playlistPath) && fs.readFileSync(playlistPath, "utf8").includes("#EXTINF")) {
        let content = fs.readFileSync(playlistPath, "utf8");
        // Segment URLs carry the same quality tag AND offset so the
        // segment route can route to the right ffmpeg dir even when
        // the user has flipped quality or re-anchored mid-stream.
        // The KEY's track (not the mapped one: a failover maps 0 under "-atN").
        const qq = segmentQuery({ quality, offsetSecs, audio, diskSel, audioTrack: t.keyTrack || 0 });
        // Pass 1: before a respawn-boundary segment, inject #EXT-X-DISCONTINUITY
        // *ahead of* its #EXTINF (HLS requires it precede the segment's EXTINF,
        // not sit between EXTINF and the URI) so the player resets its decoder
        // timeline across the ffmpeg restart instead of ending the session.
        if (t.discontinuities && t.discontinuities.size) {
          content = content.replace(/(#EXTINF:[^\n]*\n)(seg_(\d+)\.ts)/g, (_m, extinf, seg, n) =>
            (t.discontinuities.has(parseInt(n, 10)) ? "#EXT-X-DISCONTINUITY\n" : "") + extinf + seg);
        }
        // Pass 2: rewrite every segment URI to the signed proxy path.
        content = content.replace(/^seg_(\d+)\.ts$/gm,
          `/api/transcode/${req.params.mode}/${req.params.id}/seg_$1.ts?${qq}`);
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-cache");
        return res.send(content);
      }
      await new Promise(r => setTimeout(r, 250));
    }
    res.status(504).json({ error: "transcoder startup timeout" });
  } catch (e) {
    if (e && e.code === "SOURCE_UNAVAILABLE") {
      return res.status(502).json({ error: "source unavailable" });
    }
    next(e);
  }
});

app.get("/api/transcode/:mode(live|movie|series|disk)/:id/seg_:n.ts", (req, res) => {
  const owner = ownerKeyOf(req);
  // Bump lastSeen on the existing stream record. If the owner was
  // displaced between segments, this is where they learn about it.
  if (!touchStream(owner)) return sendDisplaced(res);
  const quality = normalizeQuality(req.query.q);
  const offsetSecs = normalizeOffsetSecs(req.query.t);
  const audio = normalizeAudio(req.query.a);
  const audioTrack = audioTracksLib.resolveAudioTrackParam(req.query).explicit || 0;
  const diskSel = diskSelFromQuery(req.params.mode, req.query);
  const t = transcoders.get(transcoderKey(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, audioTrack));
  if (!t) return res.status(404).end();
  t.lastAccess = t.mediaAccess = Date.now();
  noteOwner(t, owner);
  const segPath = path.join(t.dir, `seg_${req.params.n}.ts`);
  if (!fs.existsSync(segPath)) return res.status(404).end();
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Access-Control-Allow-Origin", "*");
  fs.createReadStream(segPath).on("error", () => res.end()).pipe(res);
});

// Tile preview media (see GET /api/preview/:mode/:id further down). Signed
// like /api/transcode (the Android players fetch media without cookies). A
// stopped / replaced / displaced preview answers 410 so the player gives up.
function activePreviewFor(req, res) {
  const sid = req.params.sid;
  if (!previewSigOk(sid, req.query.s)) { res.status(403).end(); return null; }
  const p = activePreview;
  if (!p || p.sid !== sid) { res.status(410).set("Cache-Control", "no-store").json({ error: "preview_stopped" }); return null; }
  p.lastAccess = Date.now();
  const e = streams.get(`${streamPreview.PREVIEW_OWNER_PREFIX}${sid}`);
  if (e) e.lastSeen = e.mediaSeen = p.lastAccess;
  return p;
}
app.get("/api/preview/:sid(p[0-9a-f]{16})/index.m3u8", async (req, res) => {
  const p = activePreviewFor(req, res);
  if (!p) return;
  const file = path.join(p.dir, "index.m3u8");
  for (let i = 0; i < 50; i++) {
    if (activePreview !== p) return res.status(410).set("Cache-Control", "no-store").json({ error: "preview_stopped" });
    let text = null;
    try { text = fs.readFileSync(file, "utf8"); } catch {}
    if (text && text.includes("#EXTINF")) {
      p.lastAccess = Date.now();
      const s = previewSig(p.sid);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-cache");
      return res.send(text.replace(/^seg_(\d+)\.ts$/gm, `/api/preview/${p.sid}/seg_$1.ts?s=${s}`));
    }
    if (p.ended) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  res.status(504).set("Cache-Control", "no-store").json({ error: "preview_timeout" });
});
app.get("/api/preview/:sid(p[0-9a-f]{16})/seg_:n(\\d{1,6}).ts", (req, res) => {
  const p = activePreviewFor(req, res);
  if (!p) return;
  const segPath = path.join(p.dir, `seg_${req.params.n}.ts`);
  if (!fs.existsSync(segPath)) return res.status(404).end();
  res.setHeader("Content-Type", "video/mp2t");
  fs.createReadStream(segPath).on("error", () => res.end()).pipe(res);
});

// Single-file 720p MP4 piped live from ffmpeg. Used by the Android
// phone's DownloadManager to save a watchable, ~1 GB-per-2-hour
// copy of a movie or episode for offline playback.
//
// Why this exists instead of letting the phone pull through
// /api/proxy: panel CDN URLs are throwaway (see whois on the
// resolved IP — Rackdog VPS + a Spanish hoster, domain registered
// 2 weeks ago through a privacy proxy) and they routinely drop
// long-lived connections mid-file. The proxy can't transparently
// resume because the upstream HMAC signature is HEAD-vs-GET
// asymmetric and DownloadManager's Range-on-resume fails. Routing
// through ffmpeg here means the panel→server hop is ffmpeg's
// problem (which can re-open + seek) and the server→phone hop is a
// stable HTTP/200 stream from the same origin DownloadManager
// already trusts.
//
// Quality is fixed at 720p — phones can't physically resolve the
// extra pixels of a 1080p source on a 6" screen, and the panel's
// native bitrate makes raw downloads 4-5 GB per movie. CRF 22 +
// veryfast preset gives Netflix-Standard-ish file sizes (≈ 1 GB
// for a 2-hour movie at 24fps).
//
// HMAC-signed (like /api/proxy and /api/transcode) so the URL can
// be handed to a non-auth'd client like DownloadManager. Lives
// BEFORE the auth middleware below for that reason — see the
// session-auth middleware at the next section.
// The panel stores each title as either .mp4, .mkv, or (rarely) .avi and
// requesting the wrong extension returns 200 OK + text/html + 0 bytes —
// same pattern as a missing file. For movies the index lookup is
// authoritative (movies.byId is keyed by movie id). For series the index
// is keyed by series id, NOT episode id, so any per-episode container
// lookup misses and falls back to mp4 — which fails for the (very
// common) panels that store episodes as mkv. Rather than fetching
// get_series_info for every request, probe the candidate containers in
// order and use the first that returns real bytes. Shared by
// /api/download (client-side download) and the disk-download job queue
// (server-side save to the Disk library) — both hit this exact panel
// flakiness.
// actx defaults to currentAccount() (ALS-backed) like streamUrl() does,
// so /api/download's request-context call site is unchanged. The
// disk-download job queue runs with no active request/ALS context — it
// passes ownerAccount explicitly rather than relying on the fallback
// (currentAccount() happens to resolve to ownerAccount outside a
// request today, but that's implicit; explicit matches the rest of the
// job's actx-threading — see buildDiskIndex/prewarmTmdbCache calls).
async function resolveDownloadSourceUrl(mode, id, actx = currentAccount(), signal = null) {
  const indexExt = (mode === "movie"
    ? getIndexesFor(actx).movie.byId.get(parseInt(id, 10))?.container
    : null);
  const candidates = indexExt
    ? [indexExt, ...["mp4", "mkv", "avi"].filter(x => x !== indexExt)]
    : ["mp4", "mkv", "avi"];

  // Pre-flight check: panel returns 200 OK with Content-Type text/html
  // and an empty body for the wrong container as well as for files no
  // longer on the reseller's CDN. Without this probe a downstream
  // consumer (ffmpeg, or a raw fetch) would "succeed" with 0 real bytes.
  let lastProbeErr = "no candidates";
  for (const ext of candidates) {
    const url = streamUrl(mode, id, ext, actx);
    if (!url) continue;
    try {
      const probe = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV)",
          "Range": "bytes=0-1024",
        },
        redirect: "follow",
        signal: signal ? AbortSignal.any([AbortSignal.timeout(4000), signal]) : AbortSignal.timeout(4000),
      });
      const ct = probe.headers.get("content-type") || "";
      const buf = Buffer.from(await probe.arrayBuffer());
      if (!ct.startsWith("text/") && buf.length > 0) {
        return { sourceUrl: url, ext };
      }
      lastProbeErr = `${ext}: ct=${ct} bytes=${buf.length}`;
    } catch (e) {
      lastProbeErr = `${ext}: ${redactAllUrls(e.message)}`;
    }
  }
  return { sourceUrl: null, ext: null, error: lastProbeErr };
}

// ── Phone downloads v2 ───────────────────────────────────────────────
// The old /api/download piped a LIVE re-encode to DownloadManager: no size,
// no resume, silent truncation. v2 prepares a finished 720p MP4 first:
//   1. fetch the ORIGINAL file from the panel into the cache dir (Range resume,
//      takes the single provider connection and yields to anyone watching),
//   2. encode it locally (GPU, faststart MP4, ~1-2 GB per film) — no provider
//      connection needed for this step,
//   3. serve the finished file with Content-Length + Range, so the phone's
//      DownloadManager gets a real percentage and can resume.
// One job at a time. Clients: POST /api/download/prepare/:mode/:id, poll
// GET /api/download/status/:mode/:id, then download the signed `url`.
const DL_DIR = path.join(DATA_DIR, "download-cache");
const DL_MAX_BYTES = 40 * 1024 ** 3;
const DL_TTL_MS = 48 * 3600 * 1000;
const DL_MIN_FREE_BYTES = 8 * 1024 ** 3;
const DL_MAX_FETCH_RETRIES = 6;
const dlq = createDownloadQueue({ maxActive: 12, maxPerProfile: 5, maxPending: 50 });
const dlJobs = dlq.jobs;    // "mode_id" -> job
const dlQueue = dlq.queue;
let dlRunning = false;
let dlCurrent = null; // the job runDownloadJob is working on (for the queued-behind-a-waiting-job view)
const DL_ID_RE = /^\d{1,12}$/;
const dlKey = (mode, id) => {
  if (!/^(movie|series)$/.test(mode) || !DL_ID_RE.test(String(id))) throw new Error("bad download id");
  return `${mode}_${id}`;
};
const dlFile = (k) => path.join(DL_DIR, `${k}.mp4`);
const dlSrcPath = (k) => path.join(DL_DIR, `${k}.src.part`);
const dlOutPath = (k) => path.join(DL_DIR, `${k}.out.part.mp4`);
const DL_MAX_JOB_AGE_MS = 24 * 3600 * 1000;       // measured from when the job STARTS running
const DL_MAX_QUEUE_AGE_MS = 3 * 24 * 3600 * 1000; // measured from when it was queued
const DL_BATCH_MAX = 10;
// Batch items beyond the active caps wait here (insertion-ordered = FIFO) and
// are promoted from dlPump's finally / cancel. key -> {mode,id,actx,profileId}.
const dlPending = dlq.pending;
const DL_MIN_AGE_BEFORE_PRUNE_MS = 3600 * 1000;
app.param("id", (req, res, next, id) => (DL_ID_RE.test(String(id).replace(/\.mp4$/, "")) || !req.path.startsWith("/api/download/")) ? next() : res.status(400).json({ error: "bad id" }));
try {
  fs.mkdirSync(DL_DIR, { recursive: true });
  // Unfinished work from a previous run is not resumable across restarts: drop it.
  for (const f of fs.readdirSync(DL_DIR)) if (f.endsWith(".part") || f.endsWith(".part.mp4")) fs.rmSync(path.join(DL_DIR, f), { force: true });
} catch (e) { console.warn(`[download] cache dir: ${e.message}`); }

function dlSignedUrl(mode, id) {
  const sig = crypto.createHmac("sha256", PROXY_SECRET).update(`download:${mode}:${id}`).digest("hex").slice(0, 16);
  return `/api/download/${mode}/${id}.mp4?s=${sig}&v=2`;
}
function dlView(mode, id) {
  const k = dlKey(mode, id);
  let st = null;
  try { st = fs.statSync(dlFile(k)); } catch {}
  if (st && st.size > 0) return { state: "ready", pct: 100, size: st.size, url: dlSignedUrl(mode, id) };
  const j = dlJobs.get(k);
  // Parked batch items look like ordinary queued jobs to clients.
  if (!j && dlPending.has(k)) return { state: "queued", pct: 0, stage: "queued", bytes: 0, error: null, queue_position: dlq.position(k) };
  if (!j) return { state: "none" };
  if (j.state === "ready") { dlJobs.delete(k); return { state: "none" }; } // file vanished
  // Machine-readable reason a job is not progressing: it (or the job it is queued behind) yields to a live viewer.
  const waitingFor = dlWaitingFor(j, dlCurrent);
  return {
    state: j.state, pct: Math.max(0, Math.min(99, Math.round(j.pct || 0))), stage: j.stage || null,
    bytes: j.bytes || 0, error: j.error || null, queue_position: dlq.position(k),
    ...(waitingFor ? { waiting_for: waitingFor } : {}),
  };
}
// Start (or report) a job. `deferWhenCapped`: instead of failing when the caps
// are hit, park the request in the pending list (promoted as jobs finish).
function ensureDownloadJob(mode, id, actx, profileId, deferWhenCapped = false) {
  const k = dlKey(mode, id);
  const view = dlView(mode, id);
  if (view.state === "ready") { try { fs.utimesSync(dlFile(k), new Date(), new Date()); } catch {} return view; }
  const r = dlq.admit(k, mode, id, actx, profileId, { defer: deferWhenCapped });
  if (r.result === "capped") return { state: "failed", pct: 0, error: "too many downloads in progress — wait for one to finish" };
  if (r.result === "full") return { state: "failed", pct: 0, error: "download queue is full" };
  if (r.result === "started") dlPump();
  return dlView(mode, id);
}
// Promote parked batch items into real jobs while the caps allow.
function dlPromotePending() {
  const skip = (k) => { try { return fs.statSync(dlFile(k)).size > 0; } catch { return false; } };
  if (dlq.promote(skip).length) dlPump();
}
function dlPump() {
  if (dlRunning) return;
  const job = dlQueue.shift();
  if (!job) return;
  dlRunning = true; dlCurrent = job;
  runDownloadJob(job)
    .catch((e) => { job.state = "failed"; job.error = redactAllUrls(e.message); console.warn(`[download] ${job.key} crashed: ${redactUrl(e.message)}`); })
    .finally(() => {
      const owner = `phone-download:${job.key}`;
      streams.delete(owner);
      if (job.state !== "ready") { try { fs.rmSync(dlOutPath(job.key), { force: true }); } catch {} }
      if (job.state === "failed" || job.cancelled) { try { fs.rmSync(dlSrcPath(job.key), { force: true }); } catch {} }
      if (job.cancelled) dlq.dropJob(job);
      dlRunning = false; dlCurrent = null; pruneDownloadCache(); dlPromotePending(); dlPump(); });
}
function pruneDownloadCache() {
  try {
    const files = fs.readdirSync(DL_DIR).filter((f) => f.endsWith(".mp4") && !f.endsWith(".part.mp4"))
      .map((f) => { const st = fs.statSync(path.join(DL_DIR, f)); return { f, size: st.size, t: st.mtimeMs }; })
      .sort((a, b) => a.t - b.t);
    let total = files.reduce((n, x) => n + x.size, 0);
    const now = Date.now();
    for (const x of files) {
      if (now - x.t > DL_TTL_MS || (total > DL_MAX_BYTES && now - x.t > DL_MIN_AGE_BEFORE_PRUNE_MS)) {
        fs.rmSync(path.join(DL_DIR, x.f), { force: true });
        dlJobs.delete(x.f.replace(/\.mp4$/, ""));
        total -= x.size;
      }
    }
  } catch (e) { console.warn(`[download] prune: ${e.message}`); }
}
setInterval(pruneDownloadCache, 30 * 60 * 1000).unref?.();

// Provider URLs carry credentials; never let them reach logs or job.error.
const redactUrls = redactAllUrls;

async function runDownloadJob(job) {
  const { mode, id, actx, key } = job;
  job.startedAt = Date.now();
  const freeBytes = diskDownloadFreeBytes(DL_DIR);
  if (freeBytes == null || freeBytes < DL_MIN_FREE_BYTES) {
    job.state = "failed"; job.error = "server disk almost full"; return;
  }
  const srcPath = dlSrcPath(key);
  const owner = `phone-download:${key}`;
  const accountKey = accountKeyOf(actx);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // ── 1. fetch the original (Range resume; yields to viewers) ──
  let fetched = false;
  let sourceUrl = null;
  let fetchNo = 0;
  const mb = (n) => (n / 1048576).toFixed(1);
  const waitForViewer = async () => {
    if (job.stage !== "waiting-for-viewer") console.log(`[download] ${mode} ${id} waiting for viewer`);
    job.state = "waiting"; job.stage = "waiting-for-viewer";
    await sleep(DISK_DOWNLOAD_DISPLACED_RETRY_MS);
  };
  const fetchT0 = Date.now();
  for (let attempt = 0; attempt <= DL_MAX_FETCH_RETRIES && !fetched;) {
    if (job.cancelled) return;
    if (Date.now() - job.createdAt > DL_MAX_QUEUE_AGE_MS) { job.state = "failed"; job.stage = "failed"; job.error = "timed out: download pending for over 3 days"; return; }
    if (Date.now() - job.startedAt > DL_MAX_JOB_AGE_MS) { job.state = "failed"; job.stage = "failed"; job.error = "timed out waiting for the provider connection"; return; }
    // Never touch the provider while someone else holds the slot (newest-wins would evict the viewer).
    // A Save-to-Disk transfer is not "someone": a phone download (a person
    // waiting for it) takes the slot from it.
    // A tile preview gives way: wait for its ffmpeg (and connection) to be gone.
    const previewGone = stopPreviews("phone download");
    if (previewGone) { await previewGone; continue; }
    const slotHeld = [...streams.entries()].some(([k, v]) => k !== owner && v.accountKey === accountKey && !v.displaced && !v.preview && !diskDlSchedule.isDiskDownloadOwner(k));
    if (slotHeld) { await waitForViewer(); continue; }
    if (accountKey === accountKeyOf(ownerAccount)) preemptDiskDownloadsForViewer("queue");
    const ac = new AbortController();
    const killer = () => ac.abort();
    const admission = admitStream(owner, mode, id, killer, accountKey);
    if (!admission.ok) { await waitForViewer(); continue; }
    job.abort = () => ac.abort();
    if (job.stage === "waiting-for-viewer") console.log(`[download] ${mode} ${id} resumed after viewer`);
    job.stage = "fetching";
    job.state = "running";
    let startByte = 0;
    try { startByte = fs.statSync(srcPath).size; } catch {}
    const before = startByte;
    let out = null;
    try {
      if (!sourceUrl) {
        const probe = await resolveDownloadSourceUrl(mode, id, actx);
        if (!probe.sourceUrl) throw Object.assign(new Error(`this title isn't available from the provider right now (${probe.error})`), { fatal: true });
        sourceUrl = probe.sourceUrl;
      }
      const resp = await fetch(sourceUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV)", ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {}) },
        redirect: "follow", signal: ac.signal,
      });
      if (resp.status === 416 && startByte > 0) {
        const m = /\*\/(\d+)/.exec(resp.headers.get("content-range") || "");
        try { await resp.body?.cancel(); } catch {}
        if (m && Number(m[1]) === startByte) { fetched = true; continue; }
        fs.rmSync(srcPath, { force: true });
        throw new Error("resume rejected; restarting");
      }
      if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
      if (/^text\//i.test(resp.headers.get("content-type") || "")) throw new Error("provider returned an error page instead of video");
      const resumed = resp.status === 206;
      const total = resumed ? Number(resp.headers.get("content-range")?.split("/")?.[1]) || null : Number(resp.headers.get("content-length")) || null;
      fetchNo++;
      const restartZero = !resumed && startByte > 0; // Range sent, provider answered 200: file is truncated
      console.log(`[download] ${key} fetch attempt ${fetchNo} start=${startByte} status=${resp.status} total=${total ?? "unknown"}${restartZero ? " (RESTART FROM ZERO)" : ""}`);
      if (total) {
        const free = diskDownloadFreeBytes(DL_DIR);
        const need = (total - (resumed ? startByte : 0)) * 1.3 + DL_MIN_FREE_BYTES;
        if (free == null || free < need) throw Object.assign(new Error("not enough server disk for this title"), { fatal: true });
      }
      job.bytes = resumed ? startByte : 0;
      out = fs.createWriteStream(srcPath, { flags: resumed ? "a" : "w" });
      const source = Readable.fromWeb(resp.body);
      source.on("data", (chunk) => { job.bytes += chunk.length; if (total) job.pct = (job.bytes / total) * 50; touchStream(owner); });
      await pipeline(source, out);
      const actual = fs.statSync(srcPath).size;
      if (actual === 0 || (total != null && actual < total)) throw new Error(`truncated transfer: got ${actual} of ${total} bytes`);
      fetched = true;
      console.log(`[download] ${key} fetch done ${mb(actual)} MB in ${Math.round((Date.now() - fetchT0) / 1000)}s over ${fetchNo} attempt(s)`);
    } catch (e) {
      console.log(`[download] ${key} fetch dropped: ${redactUrls(e.message)} (job.bytes=${mb(job.bytes || 0)} MB, attempt ${fetchNo})`);
      if (out) { try { if (!out.closed) await new Promise((r) => { out.once("close", r); out.destroy(); }); } catch {} }
      streams.delete(owner);
      if (job.cancelled) return;
      if (e.fatal) { job.state = "failed"; job.error = redactUrls(e.message); return; }
      if (ac.signal.aborted) { await waitForViewer(); continue; } // a viewer arrived: resume later
      let grew = false;
      try { grew = fs.statSync(srcPath).size > before; } catch {}
      if (grew) attempt = 0; else attempt++;
      job.error = redactUrls(e.message);
      if (attempt > DL_MAX_FETCH_RETRIES) { job.state = "failed"; job.error = `download from provider failed: ${redactUrls(e.message)}`; try { fs.rmSync(srcPath, { force: true }); } catch {} return; }
      await sleep(Math.min(5000 * Math.max(attempt, 1), 30000));
    }
  }
  job.abort = null;
  if (job.cancelled) return;
  streams.delete(owner); // encode reads the local file: free the provider connection
  // ── 2. encode to a small faststart MP4 ──
  job.state = "running"; job.stage = "encoding"; job.error = null; job.pct = 50;
  const encT0 = Date.now();
  let srcSize = 0; try { srcSize = fs.statSync(srcPath).size; } catch {}
  console.log(`[download] ${key} encode start (source ${mb(srcSize)} MB)`);
  const durationSecs = await new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", srcPath], { timeout: 20000 }, (err, out) => resolve(err ? null : parseFloat(out)));
  });
  const outPath = dlOutPath(key);
  const encode = (useHw) => new Promise((resolve) => {
    try { fs.rmSync(outPath, { force: true }); } catch {}
    const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y"];
    if (useHw) args.push("-hwaccel", "vaapi", "-hwaccel_device", VAAPI_DEVICE, "-hwaccel_output_format", "vaapi");
    // Same default audio track a play would get (cached track list only).
    args.push("-i", srcPath, "-map", "0:v:0", "-map", `0:a:${cachedAudioPick(mode, id) ?? 0}?`);
    if (useHw) args.push("-vf", "scale_vaapi=w='min(1280,iw)':h=-2:format=nv12", "-c:v", "h264_vaapi", "-qp", "26", "-profile:v", "high");
    else args.push("-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-profile:v", "high", "-pix_fmt", "yuv420p");
    args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", "-f", "mp4", outPath);
    const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    try { os.setPriority(ff.pid, 10); } catch {}
    let err = "";
    ff.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
    ff.stdout.on("data", (c) => {
      const m = /out_time_us=(\d+)/.exec(String(c));
      if (m && durationSecs) job.pct = 50 + Math.min(1, Number(m[1]) / 1e6 / durationSecs) * 49;
    });
    let lastAdvance = Date.now();
    const wd = setInterval(() => {
      const hard = durationSecs ? durationSecs * 3000 + 600000 : 6 * 3600 * 1000;
      if (job.cancelled || Date.now() - lastAdvance > 10 * 60 * 1000 || Date.now() - startedAt > hard) { err += " [killed: stalled/cancelled]"; try { ff.kill("SIGKILL"); } catch {} }
    }, 15000);
    const startedAt = Date.now();
    let lastUs = -1;
    ff.stdout.on("data", (c) => { const m = /out_time_us=(\d+)/.exec(String(c)); if (m && Number(m[1]) > lastUs) { lastUs = Number(m[1]); lastAdvance = Date.now(); } });
    ff.on("error", (e) => { clearInterval(wd); resolve({ code: -1, err: redactAllUrls(e.message) }); });
    ff.on("close", (code) => { clearInterval(wd); resolve({ code, err }); });
  });
  const useHw0 = HW_ENCODE && !hwDecodeFailed.has(`${mode}:${id}`);
  const outOk = async () => {
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return false;
    if (!durationSecs) return true;
    const d = await new Promise((resolve) => execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", outPath], { timeout: 20000 }, (err, o) => resolve(err ? null : parseFloat(o))));
    return d != null && d >= durationSecs * 0.97;
  };
  let res = await encode(useHw0);
  let okOut = res.code === 0 && await outOk();
  if (!okOut && useHw0 && !job.cancelled) { res = await encode(false); okOut = res.code === 0 && await outOk(); }
  if (okOut || res.code === 0) { try { fs.rmSync(srcPath, { force: true }); } catch {} }
  if (job.cancelled) return;
  if (!okOut) { job.state = "failed"; job.error = `could not prepare the file (${redactAllUrls((res.err || "ffmpeg failed or output was incomplete").slice(-200))})`; try { fs.rmSync(outPath, { force: true }); } catch {} return; }
  fs.renameSync(outPath, dlFile(key));
  job.state = "ready"; job.pct = 100;
  console.log(`[download] ${key} ready (${(fs.statSync(dlFile(key)).size / 1024 / 1024).toFixed(0)} MB, encode ${Math.round((Date.now() - encT0) / 1000)}s)`);
}

app.get("/api/download/:mode(movie|series)/:id.mp4", async (req, res) => {
  const { mode, id } = req.params;
  const expected = crypto.createHmac("sha256", PROXY_SECRET)
    .update(`download:${mode}:${id}`).digest("hex").slice(0, 16);
  if (req.query.s !== expected) return res.status(403).end("bad signature");

  // v2: serve the prepared file (Content-Length + Range). 409 until it is ready.
  if (req.query.v === "2") {
    const file = dlFile(dlKey(mode, id));
    if (!fs.existsSync(file)) return res.status(409).json(dlView(mode, id));
    res.set("Cache-Control", "no-store");
    return res.sendFile(file, {
      acceptRanges: true, dotfiles: "allow",
      headers: { "Content-Type": "video/mp4", "Content-Disposition": `attachment; filename="khouch_${mode}_${id}_720p.mp4"` },
    });
  }

  const { sourceUrl, error: lastProbeErr } = await resolveDownloadSourceUrl(mode, id);
  if (!sourceUrl) {
    return res.status(502).type("text/plain")
      .end(`panel says this file isn't available on the active CDN — try again later or pick a different title (${lastProbeErr})`);
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition",
    `attachment; filename="khouch_${mode}_${id}_720p.mp4"`);

  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-fflags", "+genpts",
    "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV)",
    // Same panel-flakiness problem /api/transcode already solves (see its
    // comment near "-rw_timeout"): the panel CDN drops long-lived
    // connections mid-transfer. Without these, a drop hits ffmpeg's input
    // as a premature EOF — indistinguishable from a real end of file — so
    // ffmpeg finishes cleanly (exit 0) with a TRUNCATED encode, and
    // ff.stdout.pipe(res) closes the HTTP response normally right along
    // with it. DownloadManager sees a well-formed, complete transfer and
    // marks it SUCCESSFUL with a genuine non-zero byte count — not the
    // 0-byte case DownloadsRepo's own guard already catches, a silently
    // truncated file that LOOKS fine everywhere. This was very likely the
    // actual cause of "downloads have never worked reliably" (any title
    // long enough to hit one CDN drop, which per this file's own docs is
    // routine). Do NOT add -reconnect_at_eof — see /api/transcode's
    // comment for why that reconnect-loops forever on a genuine EOF.
    "-rw_timeout", "15000000",
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-i", sourceUrl,
    "-map", "0:v:0", "-map", `0:a:${cachedAudioPick(mode, id) ?? 0}?`,
    "-c:v", "libx264", "-preset", "veryfast",
    "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
    "-crf", "22",
    "-vf", "scale=-2:720",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
  ];
  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  ff.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 8192) stderrBuf = stderrBuf.slice(-4096);
  });
  ff.stdout.pipe(res);
  res.on("close", () => {
    if (!ff.killed) {
      try { ff.kill("SIGKILL"); } catch {}
    }
  });
  ff.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[download] ${mode}/${id} ffmpeg exit ${code}\n${redactUrl(stderrBuf.slice(-1024))}`);
    }
  });
});

// --- Session auth ---------------------------------------------------------
// HTTP Basic Auth as the only gate worked but exposed the browser's
// system password dialog on every fresh tab — ugly for a polished
// streaming app. Replace with a signed-cookie session in front of
// Basic Auth: browsers get a styled HTML login page, while non-browser
// API clients (curl scripts, future Android TV app) can still use
// Basic Auth headers as a fallback.
//
// Session token v2: `${userId}.${tokenEpoch}.${issuedAt}.${hmac32}`.
// userId resolves the user record (one HMAC-signed roundtrip, no DB
// read for verification). tokenEpoch lets the owner kick a member —
// bumping the epoch invalidates every outstanding cookie for that
// user. Legacy 2-part tokens are rejected; Android's 401 interceptor
// transparently re-authenticates against the stored credentials.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Rolling refresh: any authenticated request on a cookie older than this
// re-issues a fresh 30-day cookie, so an actively-used device never hits
// the hard 30-day cliff. Without this, every device that logged in within
// the same window (e.g. a token-format migration) expires together 30 days
// later and dumps the whole household to the login screen at once. (#13)
const SESSION_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // re-issue when >7 days old
const SESSION_COOKIE = "khouch_session";

function signSession(userId, epoch, issuedAt) {
  return crypto.createHmac("sha256", PROXY_SECRET)
    .update(`${userId}:${epoch}:${issuedAt}`)
    .digest("hex").slice(0, 32);
}
function makeSessionToken(user) {
  const epoch = user.tokenEpoch || 0;
  const issuedAt = Date.now();
  return `${user.id}.${epoch}.${issuedAt}.${signSession(user.id, epoch, issuedAt)}`;
}
function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [userId, epochStr, issuedAtStr, sig] = parts;
  const epoch = Number(epochStr);
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(epoch) || !Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > SESSION_TTL_MS) return null;
  const user = getUserById(userId);
  if (!user) return null;
  if ((user.tokenEpoch || 0) !== epoch) return null;
  if (sig !== signSession(userId, epoch, issuedAt)) return null;
  return user;
}
function parseSessionCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(/;\s*/)) {
    if (part.startsWith(SESSION_COOKIE + "=")) {
      return decodeURIComponent(part.slice(SESSION_COOKIE.length + 1));
    }
  }
  return null;
}
// Build the cookie suffix. Secure is opt-in based on the request
// because non-browser clients on HTTP drop Secure cookies entirely
// (Android TV app via OkHttp, dev curls, etc.). Production traffic
// always comes in over HTTPS via Traefik, so this keeps the Secure
// flag on for browsers in real deployments.
function cookieAttrs(req, maxAge) {
  const secure = req && req.secure ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
function setSessionCookie(req, res, user) {
  if (!user) throw new Error("setSessionCookie requires a user");
  const token = makeSessionToken(user);
  res.setHeader("Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(req, SESSION_TTL_MS / 1000)}`);
}
function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; ${cookieAttrs(req, 0)}`);
}

// Profile selection cookie. Set after the user picks a profile from
// /profile/pick. HMAC-signed so it can't be forged; the payload is
// the profile id ("p1", "p2", …). Browsers without a valid profile
// cookie get bounced to the picker.
const PROFILE_COOKIE = "khouch_profile";
function signProfile(id) {
  return crypto.createHmac("sha256", PROXY_SECRET)
    .update(`profile:${id}`)
    .digest("hex").slice(0, 24);
}
function makeProfileToken(id) { return `${id}.${signProfile(id)}`; }
function parseProfileToken(token) {
  if (!token || typeof token !== "string") return null;
  const idx = token.indexOf(".");
  if (idx <= 0) return null;
  const id = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (sig !== signProfile(id)) return null;
  return id;
}
function parseProfileCookie(req) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(/;\s*/)) {
    if (part.startsWith(PROFILE_COOKIE + "=")) {
      return decodeURIComponent(part.slice(PROFILE_COOKIE.length + 1));
    }
  }
  return null;
}
function setProfileCookie(req, res, id) {
  res.append("Set-Cookie",
    `${PROFILE_COOKIE}=${encodeURIComponent(makeProfileToken(id))}; ${cookieAttrs(req, SESSION_TTL_MS / 1000)}`);
}
function clearProfileCookie(req, res) {
  res.append("Set-Cookie", `${PROFILE_COOKIE}=; ${cookieAttrs(req, 0)}`);
}

// Pull the active profile id from the request (cookie). Returns the
// profile id if valid AND that profile still exists in the registry.
function getRequestProfileId(req) {
  const tok = parseProfileCookie(req);
  if (!tok) return null;
  const id = parseProfileToken(tok);
  if (!id) return null;
  if (!findProfile(id)) return null;
  return id;
}

// Verify a Basic Auth header against the accounts.json registry.
// Returns the user record on success, null otherwise. Used by API
// clients (curl, the Android cookie-bootstrap path) — browsers
// normally land via the cookie path.
function verifyBasicAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return null;
  let decoded;
  try { decoded = Buffer.from(h.slice(6), "base64").toString("utf8"); }
  catch { return null; }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  const user = getUserByUsername(decoded.slice(0, idx));
  if (!user) return null;
  if (!verifyPassword(decoded.slice(idx + 1), user.passwordHash)) return null;
  return user;
}

// Public routes that bypass auth: the login page itself, the form
// POST endpoint, the favicon (so the login page can render its tab
// icon without an extra round-trip), and /healthz (so external
// uptime checks don't need creds).
const PUBLIC_PATHS = new Set([
  "/login", "/login/", "/api/login",
  "/signup", "/signup/", "/api/signup", "/api/signup/check",
  "/favicon.svg",
  "/healthz",
  // The theatre-portraits JS file is just SVG drawing code (no
  // secrets) and is loaded by the login + profile-pick pages — both
  // of which can render before a session cookie exists. Same rationale
  // as the /portraits/ path bypass below.
  "/theatre-portraits.js",
]);
// Paths reachable after household sign-in but before picking a
// profile. Anything else requires the profile cookie too.
const PROFILE_GATED_BYPASS = new Set([
  "/profile", "/profile/", "/profile/pick", "/profile/pick/",
  "/api/profiles", "/api/profile/select", "/api/logout",
]);

const { parseTokens, matchBearer, parseRef, createMcpServer } = require("./lib/mcp");
// Bearer tokens for POST /mcp (see lib/mcp.js). Unset = endpoint always 401s.
const mcpTokens = parseTokens(process.env.MCP_TOKENS);

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  // /mcp: bearer-token only (MCP_TOKENS) — never cookies or Basic Auth,
  // so a browser session can't be ridden into it and the household
  // password never sits in an assistant's config. See lib/mcp.js.
  // Normalised: Express routing is case-insensitive and non-strict, so
  // "/MCP" or "/mcp/" also reach the /mcp handler and must not fall
  // through to cookie auth.
  if (req.path.toLowerCase().replace(/\/+$/, "") === "/mcp") {
    const hit = matchBearer(mcpTokens, req.headers.authorization);
    const mcpUser = hit ? getUserByUsername(hit.username) : null;
    if (!mcpUser) return res.status(401).json({ error: "bearer token required" });
    const own = profiles.profiles.filter(p => p.ownerUserId === mcpUser.id);
    const prof = hit.profileId ? own.find(p => p.id === hit.profileId) : own[0];
    if (!prof) return res.status(403).json({ error: "token's profile not found for this user" });
    req.user = mcpUser;
    req.account = getAccountForUser(mcpUser);
    req.profileId = prof.id;
    req.mcpAuthed = true;
    return accountStore.run(req.account, () => next());
  }
  // Theatre-portrait SVGs are unauthenticated static assets so
  // they render on the login page (future) and the Android phone
  // app's pre-login profile picker — Coil's SVG decoder fetches
  // them without a session cookie. There's nothing sensitive in
  // an SVG, and they're cacheable forever (the file content is
  // the only thing that changes when we add a new portrait).
  if (req.path.startsWith("/portraits/")) return next();
  // Resolve the user from session cookie (v2) or Basic Auth fallback.
  const sessionToken = parseSessionCookie(req);
  const sessionUser = sessionToken ? verifySessionToken(sessionToken) : null;
  const basicUser = !sessionUser ? verifyBasicAuth(req) : null;
  const user = sessionUser || basicUser;
  // Rolling session: re-issue a cookie-authed session that's older than
  // the refresh window so active devices never reach the 30-day TTL. We
  // re-append (not setHeader) so the profile-cookie refresh below and any
  // route-level Set-Cookie all survive. (#13)
  let refreshSession = false;
  if (sessionUser && sessionToken) {
    const issuedAt = Number(sessionToken.split(".")[2]);
    refreshSession = Number.isFinite(issuedAt) && (Date.now() - issuedAt > SESSION_REFRESH_MS);
    if (refreshSession) {
      res.append("Set-Cookie",
        `${SESSION_COOKIE}=${encodeURIComponent(makeSessionToken(sessionUser))}; ${cookieAttrs(req, SESSION_TTL_MS / 1000)}`);
    }
  }
  if (!user) {
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    if (wantsHtml) {
      const next2 = encodeURIComponent(req.originalUrl || "/");
      return res.redirect(302, `/login?next=${next2}`);
    }
    return res.status(401).json({ error: "auth required" });
  }
  req.user = user;
  req.account = getAccountForUser(user);
  // Profile selection. Verify ownership: cookies tied to another user's
  // profile fall through to the picker so a stolen cookie can't carry
  // across users.
  const cookieProfileId = getRequestProfileId(req);
  const cookieProfile = cookieProfileId ? findProfile(cookieProfileId) : null;
  const cookieProfileOwned = cookieProfile && cookieProfile.ownerUserId === user.id;
  const ownProfiles = profiles.profiles.filter(p => p.ownerUserId === user.id);
  const runNext = () => accountStore.run(req.account, () => next());
  if (basicUser) {
    req.profileId = cookieProfileOwned ? cookieProfileId : (ownProfiles[0]?.id || null);
    return runNext();
  }
  if (cookieProfileOwned) {
    req.profileId = cookieProfileId;
    // Keep the profile cookie in lockstep with the rolling session so it
    // can't expire on its own (it carries no timestamp to age-check; its
    // only expiry is the client Max-Age). Otherwise a 30-day-old profile
    // cookie drops off mid-session → "profile required". (#13)
    if (refreshSession) setProfileCookie(req, res, cookieProfileId);
    return runNext();
  }
  if (PROFILE_GATED_BYPASS.has(req.path)) return runNext();
  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) return res.redirect(302, "/profile/pick");
  return res.status(401).json({ error: "profile required" });
});

// Login form handler. Verifies the submitted username/password against
// the accounts.json registry (scrypt-hashed). Sets the v2 session
// cookie and redirects (or returns JSON for fetch-style submits).
app.post("/api/login", express.json(), express.urlencoded({ extended: false }), (req, res) => {
  const u = (req.body && (req.body.user || req.body.username)) || "";
  const p = (req.body && (req.body.pass || req.body.password)) || "";
  const user = getUserByUsername(u);
  if (user && verifyPassword(p, user.passwordHash)) {
    user.lastLoginAt = Date.now();
    saveAccountsToDisk();
    setSessionCookie(req, res, user);
    const next = (req.body && req.body.next) || (req.query && req.query.next) || "/";
    // Allow only same-origin paths in `next` so an attacker can't
    // craft a login link that redirects to evil.com after success.
    const safeNext = (typeof next === "string" && next.startsWith("/") && !next.startsWith("//")) ? next : "/";
    if ((req.headers.accept || "").includes("application/json")) {
      return res.json({ ok: true, next: safeNext });
    }
    return res.redirect(302, safeNext);
  }
  if ((req.headers.accept || "").includes("application/json")) {
    return res.status(401).json({ ok: false, error: "Wrong username or password" });
  }
  return res.redirect(302, `/login?error=1${req.body && req.body.next ? `&next=${encodeURIComponent(req.body.next)}` : ""}`);
});

// Logout — clears the cookie and bounces back to the login page.
app.post("/api/logout", (req, res) => {
  clearSessionCookie(req, res);
  clearProfileCookie(req, res);
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ ok: true });
  }
  res.redirect(302, "/login");
});

// The styled login page itself. Lives at public/login.html so it can
// be edited without touching server code.
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Profile picker page — served after household sign-in if the user
// hasn't picked a profile yet (or wants to switch).
app.get("/profile/pick", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile-pick.html"));
});

// List profiles owned by the active user. Multi-tenant: each user
// (owner or member) only sees their own profile list — a friend's
// /profile/pick can't reveal Kunal's profiles. `avatar` is the chosen
// portrait id (e.g. "magician"). The client maps it to an SVG via
// public/theatre-portraits.js and falls back to a hash-pick when the
// field is null — see TheatrePortraits.resolve().
app.get("/api/profiles", (req, res) => {
  const userId = req.user?.id;
  res.json({
    profiles: profiles.profiles
      .filter(p => p.ownerUserId === userId)
      .map(p => ({
        id: p.id,
        nick: p.nick,
        avatar: normalizeAvatar(p.avatar),
        kidsBirthYear: p.kidsBirthYear || null,
        autoplay: autoplayPref.effective(p),
      })),
  });
});

// Create a new profile. Returns the new id so the picker can flip to
// it immediately. No role enforcement yet — anyone with household
// access can add a profile (matches Netflix's model where any
// household member can add a profile on the picker).
// Birth year is stored instead of age so the child's profile ages
// up automatically (an 8-year-old today is a 10-year-old in two
// years without anyone touching settings). Accept anything from
// 1980 to next year; the client decides the resulting age bucket.
function normalizeBirthYear(v) {
  const thisYear = new Date().getFullYear();
  if (!Number.isFinite(v)) return null;
  const n = Math.floor(v);
  if (n < 1980 || n > thisYear + 1) return null;
  return n;
}

app.post("/api/profiles", express.json(), (req, res) => {
  const b = req.body || {};
  const nick = String(b.nick || "").trim().slice(0, 32);
  if (!nick) return res.status(400).json({ error: "nick required" });
  const avatar = normalizeAvatar(b.avatar);
  const kidsBirthYear = normalizeBirthYear(b.kidsBirthYear);
  const rec = { nick, avatar, kidsBirthYear, ownerUserId: req.user.id, createdAt: Date.now() };
  if (b.autoplay !== undefined && b.autoplay !== null && !autoplayPref.apply(rec, b.autoplay)) {
    return res.status(400).json({ error: "bad autoplay" });
  }
  const id = `p${profiles.nextId++}`;
  profiles.profiles.push({ id, ...rec });
  profileStates.set(id, emptyUserState());
  saveProfilesToDisk();
  scheduleUserStateSave();
  res.json({ ok: true, id });
});

// Update an existing profile's nickname / avatar / kidsBirthYear / autoplay
// ({ next, stopAfter }, merged; null = back to the profile-kind default).
app.patch("/api/profiles/:id", express.json(), (req, res) => {
  const p = findProfile(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown profile" });
  if (p.ownerUserId !== req.user.id) return res.status(404).json({ error: "unknown profile" });
  const b = req.body || {};
  // Validated up front (nothing changes on a 400), applied after the kid
  // flag so unspecified fields default from the profile's new kind.
  if (b.autoplay !== undefined && !autoplayPref.apply({ ...p }, b.autoplay)) {
    return res.status(400).json({ error: "bad autoplay" });
  }
  if (typeof b.nick === "string") {
    const nick = b.nick.trim().slice(0, 32);
    if (nick) p.nick = nick;
  }
  if (typeof b.avatar === "string") {
    const a = normalizeAvatar(b.avatar);
    if (a) p.avatar = a;
  }
  if (b.kidsBirthYear === null) p.kidsBirthYear = null;
  else if (Number.isFinite(b.kidsBirthYear)) {
    const y = normalizeBirthYear(b.kidsBirthYear);
    if (y !== null) p.kidsBirthYear = y;
  }
  if (b.autoplay !== undefined) autoplayPref.apply(p, b.autoplay);
  saveProfilesToDisk();
  res.json({ ok: true, autoplay: autoplayPref.effective(p) });
});

// Delete a profile + wipe its state. Refuses if it's the last
// remaining profile — there's always at least one.
app.delete("/api/profiles/:id", (req, res) => {
  const idx = profiles.profiles.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "unknown profile" });
  const p = profiles.profiles[idx];
  if (p.ownerUserId !== req.user.id) return res.status(404).json({ error: "unknown profile" });
  // Refuse to delete the requester's last profile.
  const mine = profiles.profiles.filter(x => x.ownerUserId === req.user.id);
  if (mine.length === 1) {
    return res.status(400).json({ error: "cannot delete last profile" });
  }
  profiles.profiles.splice(idx, 1);
  profileStates.delete(req.params.id);
  saveProfilesToDisk();
  scheduleUserStateSave();
  // If the requester was on this profile, clear their cookie so the
  // next request bounces them back to the picker.
  if (getRequestProfileId(req) === req.params.id) clearProfileCookie(req, res);
  res.json({ ok: true });
});

// Pick a profile. Sets the cookie and redirects (or JSON-replies).
app.post("/api/profile/select", express.json(), (req, res) => {
  const id = String(req.body?.id || req.query?.id || "");
  const p = findProfile(id);
  if (!p || p.ownerUserId !== req.user.id) return res.status(404).json({ error: "unknown profile" });
  setProfileCookie(req, res, id);
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ ok: true });
  }
  res.redirect(302, "/");
});

// ─────────────────────────────────────────────────────────────────────
// Invites (owner-only) + self-signup. The owner generates a one-shot
// invite token, shares the resulting /signup?token=… URL with the
// friend, and the friend completes signup with their own panel creds.
// Tokens expire after INVITE_TTL_MS by default.
// ─────────────────────────────────────────────────────────────────────
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
function requireOwner(req, res) {
  if (req.user?.role !== "owner") {
    res.status(403).json({ error: "owner only" });
    return false;
  }
  return true;
}

app.get("/api/invites", (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json({
    invites: invites.invites.map(inv => ({
      token: inv.token,
      url: `/signup?token=${inv.token}`,
      createdAt: inv.createdAt,
      expiresAt: inv.expiresAt,
      redeemedAt: inv.redeemedAt || null,
      redeemedBy: inv.redeemedByUserId ? (getUserById(inv.redeemedByUserId)?.username || null) : null,
    })),
  });
});
app.post("/api/invites", express.json(), (req, res) => {
  if (!requireOwner(req, res)) return;
  const ttl = Number(req.body?.expiresMs) || INVITE_TTL_MS;
  const inv = {
    token: generateInviteToken(),
    createdBy: req.user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    redeemedAt: null,
    redeemedByUserId: null,
  };
  invites.invites.push(inv);
  indexInvites();
  saveInvitesToDisk();
  res.json({ ok: true, token: inv.token, url: `/signup?token=${inv.token}`, expiresAt: inv.expiresAt });
});
app.delete("/api/invites/:token", (req, res) => {
  if (!requireOwner(req, res)) return;
  const tok = req.params.token;
  const idx = invites.invites.findIndex(i => i.token === tok);
  if (idx < 0) return res.status(404).json({ error: "unknown token" });
  invites.invites.splice(idx, 1);
  indexInvites();
  saveInvitesToDisk();
  res.json({ ok: true });
});

// Public: validate an invite token before showing the signup form.
app.get("/api/signup/check", (req, res) => {
  const token = String(req.query?.token || "");
  const inv = getInvite(token);
  if (!inv) return res.json({ valid: false, reason: "unknown token" });
  if (inv.redeemedAt) return res.json({ valid: false, reason: "already redeemed" });
  if (inv.expiresAt && Date.now() > inv.expiresAt) return res.json({ valid: false, reason: "expired" });
  return res.json({ valid: true });
});

// Public: serve the signup page.
app.get("/signup", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "signup.html"));
});

// Public: complete signup. Validates token, probes friend's panel,
// creates user + first profile, marks invite redeemed, sets session.
const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;
app.post("/api/signup", express.json(), express.urlencoded({ extended: false }), async (req, res) => {
  const b = req.body || {};
  const token = String(b.token || "");
  const inv = getInvite(token);
  if (!isInviteValid(inv)) {
    return res.status(400).json({ ok: false, reason: "invalid or expired invite" });
  }
  const usernameRaw = String(b.username || "").trim().toLowerCase();
  if (!USERNAME_RE.test(usernameRaw)) {
    return res.status(400).json({ ok: false, reason: "username must be 3-32 chars, lowercase letters/digits/_-" });
  }
  if (getUserByUsername(usernameRaw)) {
    return res.status(400).json({ ok: false, reason: "username already taken" });
  }
  const password = String(b.password || "");
  if (password.length < 8) {
    return res.status(400).json({ ok: false, reason: "password must be at least 8 chars" });
  }
  const panel = b.panel || {};
  const host = String(panel.host || "").trim().replace(/\/$/, "");
  const panelUser = String(panel.user || "").trim();
  const panelPass = String(panel.pass || "").trim();
  const hostFallback = String(panel.hostFallback || panel.host_fallback || "").trim();
  if (!host || !panelUser || !panelPass) {
    return res.status(400).json({ ok: false, reason: "panel host, user, and pass required" });
  }
  // Probe the friend's panel before committing anything.
  const probe = await probePanel(host, panelUser, panelPass);
  if (!probe.ok) {
    return res.status(400).json({ ok: false, reason: `panel probe failed: ${probe.reason}` });
  }
  if (!ACCOUNT_SEAL_KEY) {
    return res.status(500).json({ ok: false, reason: "server is missing PROXY_SECRET; cannot seal account creds" });
  }
  // Create the user.
  const newId = `u${accounts.nextId++}`;
  const sealed = sealAccountCreds({ host, hostFallback, user: panelUser, pass: panelPass });
  const user = {
    id: newId,
    username: usernameRaw,
    passwordHash: hashPassword(password),
    role: "member",
    tokenEpoch: 0,
    accountSealed: sealed,
    hostHash: hostHashOfSafe(host),
    lastLoginAt: Date.now(),
    createdAt: Date.now(),
  };
  accounts.users.push(user);
  indexAccounts();
  saveAccountsToDisk();
  // Create their first profile.
  const profileNick = String(b.nick || usernameRaw).trim().slice(0, 32) || usernameRaw;
  const newProfileId = `p${profiles.nextId++}`;
  profiles.profiles.push({
    id: newProfileId,
    nick: profileNick,
    avatar: null,
    kidsBirthYear: null,
    ownerUserId: user.id,
    createdAt: Date.now(),
  });
  profileStates.set(newProfileId, emptyUserState());
  saveProfilesToDisk();
  scheduleUserStateSave();
  // Redeem the invite.
  markInviteRedeemed(token, user.id);
  // Set session + profile cookies so the friend lands logged-in.
  setSessionCookie(req, res, user);
  setProfileCookie(req, res, newProfileId);
  // Kick off a background index build against their panel. The
  // /api/bootstrap call that follows will block on categories
  // (≈5-15 s) and the home rails populate as the index lands.
  const actx = getAccountForUser(user);
  buildAllIndexes(actx).catch(e => console.warn(`[signup] background build failed: ${e.message}`));
  if ((req.headers.accept || "").includes("application/json")) {
    return res.json({ ok: true, next: "/" });
  }
  return res.redirect(302, "/");
});

// Owner-only: list users for admin UI.
app.get("/api/users", (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json({
    users: accounts.users.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      lastLoginAt: u.lastLoginAt || 0,
      createdAt: u.createdAt || 0,
      profiles: profiles.profiles.filter(p => p.ownerUserId === u.id).map(p => p.id),
    })),
  });
});
// Owner-only: revoke a user. Bumps tokenEpoch (invalidates outstanding
// sessions) and removes the user record + their profiles + per-account
// data dir. Refuses to delete the owner.
app.delete("/api/users/:id", (req, res) => {
  if (!requireOwner(req, res)) return;
  const id = req.params.id;
  const user = getUserById(id);
  if (!user) return res.status(404).json({ error: "unknown user" });
  if (user.role === "owner") return res.status(400).json({ error: "cannot delete owner" });
  // Bump epoch so any outstanding cookies fail signature check
  // immediately. (Also belt-and-suspenders: we delete the user below.)
  user.tokenEpoch = (user.tokenEpoch || 0) + 1;
  // Remove their profiles + states.
  const removedProfileIds = profiles.profiles.filter(p => p.ownerUserId === id).map(p => p.id);
  profiles.profiles = profiles.profiles.filter(p => p.ownerUserId !== id);
  for (const pid of removedProfileIds) profileStates.delete(pid);
  saveProfilesToDisk();
  scheduleUserStateSave();
  // Remove the user.
  accounts.users = accounts.users.filter(u => u.id !== id);
  indexAccounts();
  saveAccountsToDisk();
  invalidateAccountCtx(id);
  // Clean up their per-host data dir (best-effort).
  if (user.hostHash) {
    const dir = path.join(DATA_DIR_EARLY(), "accounts", user.hostHash);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  res.json({ ok: true });
});

// Force browsers to revalidate static assets on every request via
// ETag rather than serving stale bytes from disk cache. Without this,
// app.js / style.css / profile-pick.html can stick around for hours
// after a deploy and a user can hit a half-deployed app — exactly the
// kind of bug that lets the OLD profile-pick.html (no localStorage
// wipe) leak the previous profile's data into the new one even after
// the fix has shipped. ETags do their job; no-cache just guarantees
// the browser asks every time.
// Optional per-deployment branding override, driven by env so a private
// instance can re-brand (tagline / header tooltip) without touching
// tracked source — set BRAND_TAGLINE / BRAND_TOOLTIP in .env (mounted
// like the other secrets). Unset (public builds) → empty 200, generic
// brand from the static HTML. Env values are JSON-encoded into JS string
// literals so they can't break out of the script.
app.get("/branding.local.js", (_req, res) => {
  res.type("application/javascript").setHeader("Cache-Control", "no-cache, must-revalidate");
  const tag = process.env.BRAND_TAGLINE;
  const tip = process.env.BRAND_TOOLTIP;
  if (!tag && !tip) return res.send("");
  res.send(
    "(function(){" +
    (tag ? `document.querySelectorAll(".brand-tag").forEach(function(e){e.textContent=${JSON.stringify(tag)};});` : "") +
    (tip ? `var b=document.querySelector(".brand");if(b)b.title=${JSON.stringify(tip)};` : "") +
    "})();"
  );
});

// Cache-busted SPA shell. index.html itself is always served fresh
// (no-cache, must-revalidate below) — but Cloudflare has been observed
// silently overriding that SAME header on the *referenced* assets
// (app.js, style.css) with its own default browser-cache TTL
// (max-age=14400 seen in practice, vs. the no-cache this app sends),
// so a deploy can silently NOT reach a browser tab for up to 4 hours
// even though the HTML shell polling for a new version always would.
// Query-string versioning sidesteps the problem entirely regardless of
// what any CDN/browser does with Cache-Control — a new deploy is a
// genuinely new URL every client has to fetch fresh, no revalidation
// negotiation involved.
const SPA_ASSET_VERSION = process.env.GIT_SHA || "dev";
const SPA_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8")
  .replace(/(href|src)="\/(style\.css|app\.js|nf-helpers\.js|rescue-logic\.js|pause-keepalive\.js|theatre-portraits\.js)"/g,
    (_m, attr, file) => `${attr}="/${file}?v=${SPA_ASSET_VERSION}"`);
function sendSpaShell(res) {
  res.type("html").setHeader("Cache-Control", "no-cache, must-revalidate").send(SPA_HTML);
}
// /index.html explicitly too — otherwise it falls through to
// express.static below and serves the raw, unversioned file straight
// off disk (same staleness bug this whole shell exists to avoid, just
// reachable via a second URL — a bookmark, browser history, or a typed
// full filename).
app.get(["/", "/index.html"], (_req, res) => sendSpaShell(res));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
  },
}));

app.get("/api/account", async (_req, res, next) => {
  try { res.json(await xtream("")); } catch (e) { next(e); }
});

app.get("/api/bootstrap", async (req, res, next) => {
  // No browser cache for the same reasons as /api/home — bootstrap
  // carries the active profile + userState and a stale response leaks
  // the previous profile's data after a switch.
  res.set("Cache-Control", "no-store");
  try {
    const [account, liveCats, movieCats, seriesCats] = await Promise.all([
      xtream("").catch(() => null),
      xtream(MODES.live.cats).catch(() => null),
      xtream(MODES.movie.cats).catch(() => null),
      xtream(MODES.series.cats).catch(() => null),
    ]);
    // Update the cached account snapshot — used by streamUrl() to honor
    // user_info.allowed_output_formats and by clients to surface
    // exp_date as a "panel expires in N days" hint.
    if (account && account.user_info) setLastAccountInfo(currentAccount(), account);
    const pickCats = (mode, fresh) => {
      if (Array.isArray(fresh)) {
        saveCategoriesToDisk(mode, fresh);
        rebuildCategoryTags(mode, fresh);
        return fresh;
      }
      const fromDisk = loadCategoriesFromDiskSync(mode);
      if (fromDisk && fromDisk.length) rebuildCategoryTags(mode, fromDisk);
      return fromDisk;
    };
    // Bootstrap returns ONLY the active profile's state. Profile list
    // is fetched separately via /api/profiles when the picker / settings
    // page needs it. Restrict the fallback to profiles owned by the
    // current user so a friend never lands on Kunal's profile.
    const userOwnedProfiles = profiles.profiles.filter(p => p.ownerUserId === req.user?.id);
    const activeProfile = findProfile(req.profileId) || userOwnedProfiles[0] || profiles.profiles[0];
    res.json({
      account,
      categories: {
        live:   pickCats("live",   liveCats),
        movie:  pickCats("movie",  movieCats),
        series: pickCats("series", seriesCats),
        // Disk categories are synthetic (folder names), written by
        // buildDiskIndex. Only the owner ever has a non-empty disk index.
        disk:   (() => { const d = loadCategoriesFromDiskSync("disk"); if (d && d.length) rebuildCategoryTags("disk", d); return d || []; })(),
      },
      index: {
        live:   { total: indexes.live.total,   done: indexes.live.done,   ready: indexes.live.ready },
        movie:  { total: indexes.movie.total,  done: indexes.movie.done,  ready: indexes.movie.ready },
        series: { total: indexes.series.total, done: indexes.series.done, ready: indexes.series.ready },
        disk:   { total: indexes.disk.total,   done: indexes.disk.done,   ready: indexes.disk.ready },
      },
      // Disk (local library) section. `enabled` drives whether the client
      // shows the Disk tab at all — true only for an account that actually
      // has a library (superadmin-only). path/count are owner-only.
      disk: (() => {
        const enabled = !!(indexes.disk?.ready && indexes.disk.byId.size > 0);
        const isOwner = req.user?.role === "owner";
        return {
          enabled,
          isOwner,
          count: indexes.disk?.byId?.size || 0,
          path: isOwner ? (userDiskPath(req.user) || "") : null,
        };
      })(),
      lastPlayed: getLastPlayedFor(currentAccount()),
      epg: isOwnerAccount(currentAccount())
        ? { builtAt: epgStatus.builtAt || epgIndexBuiltAt, channels: epgIndex.size, programmes: epgStatus.programmes || 0, matchedStreams: epgStatus.matchedStreams || 0 }
        : undefined,
      profile: activeProfile && {
        id: activeProfile.id,
        nick: activeProfile.nick,
        avatar: normalizeAvatar(activeProfile.avatar),
        kidsBirthYear: activeProfile.kidsBirthYear || null,
        autoplay: autoplayPref.effective(activeProfile),
      },
      user: req.user && {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
      },
      userState: (() => {
        const pid = activeProfile ? activeProfile.id : "p1";
        // This client now sees the current lists — unless it asked for a
        // categories-only refresh (?lite=1) and ignores userState.
        if (!req.query.lite) clearPendingListAdds(pid);
        // Server-owned internals stay home; the Notify-me list goes out in its public shape.
        const { seriesSeen, notifyMe, ...st } = getProfileState(pid);
        return { ...st, notifyMe: (notifyMe || []).map(notifyMeLib.publicView) };
      })(),
      // Authoritative chip-filter and kids-cert configuration. Both
      // web and Android TV clients consume this — they hold a fallback
      // table for graceful degradation against an older server, but
      // when this field is present it wins. Adding a new language /
      // country / genre is a server-only change after this.
      filterConfig: {
        groups: [
          ...CHANNEL_GROUPS.map(g => ({
            key: g.key,
            label: CHIP_LABELS[g.key] || g.key,
            kind: CHIP_KINDS[g.key] || "other",
          })),
          // Residual bucket for streams whose category matches no
          // CHANNEL_GROUPS regex. categoryTagsFor returns ["other"]
          // for these, and we want users to be able to pick it as a
          // filter chip just like any other group. Tail-position
          // matches the historical client-side ordering.
          { key: "other", label: "Other", kind: "residual" },
        ],
        syntheticTags: ["4k", "movies", "entertainment", "cam"],
        nonEntertainmentTags: [...NON_ENTERTAINMENT_KEYS],
        kidsCertTiers: KIDS_CERT_TIERS,
      },
    });
  } catch (e) { next(e); }
});

// Pre-built home rails per profile. Mirrors what the web client's
// renderRails() composes — Continue Watching, My List, Favorites,
// Recently Played, then one rail per onboarded-filtered category —
// but does the work server-side so weak TV clients don't have to
// download the full 19.7 MB catalog and iterate it in Compose.
//
// Each item carries a pre-sized TMDB poster URL (w185 for tiles,
// w342/w780 on hero) so the client doesn't fan out one /api/poster
// fetch per visible tile. Cap is 12 items per rail to keep the JSON
// payload small (~50 KB end-to-end vs 19.7 MB).
//
// Server-side category-group matching uses the same regex table the
// web client has in public/app.js — kept in lockstep so a category
// that ends up under "USA" on the web shows up under "USA" on the TV.
// Source of truth: this list. The web's GROUPS array mirrors it.
const CHANNEL_GROUPS = [
  // Languages
  { key: "english", patterns: [/\benglish\b/i, /\bblockbuster\b/i, /\boscar\b/i] },
  { key: "hindi", patterns: [
    /\bhindi\b/i, /bollywood/i,
    /\bstar plus\b/i, /\bstar bharat\b/i, /\bzee tv\b/i, /\bcolors hindi\b/i,
    /\bsony \(set\)\b/i, /\bsab\b/i, /\band tv\b/i, /\bmtv hindi\b/i, /\bepic tv\b/i,
    /\bsony liv\b/i, /\bdisney.*hotstar\b/i, /\bzee5\b/i, /\bjio cinema\b/i,
    /\bvoot\b/i, /\bmx player\b/i, /\bhungama play\b/i,
    /\btvf\b/i, /\bullu\b/i, /\beros now\b/i, /\bjio\b/i,
    /\baandetv\b/i, /\bbigg boss\b/i, /shemaroo/i, /\bhangama\b/i,
    /\baddatimes\b/i, /\bgreen tv\b/i, /\bsony aath\b/i, /amazon mini\b/i,
    /\bwaves ott\b/i, /\bsaregama\b/i, /lionsgate play/i,
    /\bgemplex\b/i, /\bnews nation\b/i,
  ]},
  { key: "punjabi", patterns: [/punjabi/i] },
  { key: "tamil",   patterns: [/\btamil\b/i, /\bstar vijay\b/i, /\bsun tamil\b/i, /\bzee tamil\b/i] },
  { key: "telugu",  patterns: [/\btelugu\b/i, /\bgemini\b/i, /\bstar maa\b/i, /\bzee telugu\b/i, /\betv\b/i, /\baha\b/i] },
  { key: "malayalam", patterns: [/malayalam/i, /asianet/i, /\bsurya\b/i] },
  { key: "kannada", patterns: [/kannada/i, /star suvarna/i] },
  { key: "marathi", patterns: [/marathi/i, /star pravah/i] },
  { key: "gujarati", patterns: [/gujarati/i] },
  { key: "bengali", patterns: [/\bbangla\b/i, /bengali/i, /jalsha/i] },
  { key: "urdu",    patterns: [/\burdu\b/i] },
  { key: "arabic",  patterns: [/arabic/i, /\bbein\b/i, /\bmbc\b/i] },
  { key: "turkish", patterns: [/turkish/i, /\bturkiye\b/i, /\btrt\b/i] },
  // Countries
  { key: "us",      patterns: [/\busa?\b/i, /america/i, /\bnfl\b/i, /\bmlb\b/i, /\bnba\b/i, /\bmls\b/i, /\bnhl\b/i, /netflix/i, /\bhbo\b/i, /amazon prime/i, /\bdisney\b/i, /starz/i, /\bhulu\b/i, /\bpeacock\b/i] },
  { key: "india",   patterns: [/\bindia\b/i, /\bindian\b/i, /\bipl\b/i, /\bhub premier\b/i, /cricket/i] },
  { key: "pakistan", patterns: [/pakistan/i, /\bptv\b/i, /\bary\b/i, /\bgeo\b/i, /\bhum tv\b/i, /\bexpress tv\b/i, /aplus/i, /\baan\b/i, /aur life/i, /play entertainment/i, /\bmun tv\b/i, /\btv one\b/i, /apna/i, /kashmir/i, /dunya/i, /\bsamaa\b/i, /\burdu\b/i, /cricket/i, /\bpsl\b/i] },
  { key: "uk",      patterns: [/\buk\b/i, /\bbritish\b/i, /\bbbc\b/i, /sky uk/i] },
  { key: "canada",  patterns: [/canada/i, /canadian/i, /\bctv\b/i] },
  { key: "australia", patterns: [/australia/i, /australian/i, /fox australia/i, /\bdstv\b/i] },
  // Genres
  { key: "sports", patterns: [/\bsports?\b/i, /cricket/i, /football/i, /soccer/i, /tennis/i, /\bgolf\b/i, /rugby/i, /racing/i, /\bf1\b/i, /motogp/i, /\bnfl\b/i, /\bmlb\b/i, /\bnba\b/i, /\bmls\b/i, /\bnhl\b/i, /\bepl\b/i, /\bipl\b/i, /\bpsl\b/i, /world cup/i, /\bfifa\b/i, /\bufc\b/i, /boxing/i, /wrestling/i, /\bwwe\b/i] },
  { key: "kids",   patterns: [/\bkids\b/i, /cartoon/i, /\bcbeebies\b/i, /nickelodeon/i, /\bnick jr\b/i, /\bbaby\b/i, /\btoddler\b/i] },
  { key: "news",   patterns: [/\bnews\b/i] },
  { key: "music",  patterns: [/\bmusic\b/i, /\bmtv\b/i, /\bvh1\b/i, /\bvevo\b/i, /\bmusik\b/i, /\b9xm\b/i, /\bb4u music\b/i, /\bsangeet\b/i] },
];

// Synthetic chip patterns (not in CHANNEL_GROUPS — they're guide-only
// flags layered on top of group membership). Movies + 4K become extra
// tags; "entertainment" is derived as "not movies AND no non-ent group".
const MOVIES_PATTERNS = [/\bmovies?\b/i, /\bcinema\b/i];
const FOURK_PATTERNS = [/\b4k\b/i, /\buhd\b/i, /\b2160p?\b/i, /\(2160\)/i];
// Cam / screener prints. Panels label these explicitly in the category
// or title ("INDIAN (2026) (CAM)"), so a regex on the name is reliable.
// Surfaced as a synthetic `cam` tag so clients can hide low-quality
// pre-retail rips (the Hindi collection excludes them by default).
const CAM_PATTERNS = [/\bcam\b/i, /\bhdcam\b/i, /\bcamrip\b/i, /\btelesync\b/i, /\bdvdscr\b/i, /\bpre-?dvd\b/i];
const NON_ENTERTAINMENT_KEYS = new Set(["sports", "news", "kids", "music", "movies"]);
// CHANNEL_GROUPS keys whose names also appear as language indicators
// inside title strings (e.g. "Mufasa (2024) [Telugu]"). Used by the
// home endpoint to drop dub items that the user's profile didn't opt
// into. Country / genre keys are excluded — "USA" / "kids" rarely
// appears in the title to indicate exclusion.
const LANGUAGE_GROUP_KEYS = [
  "english", "hindi", "tamil", "telugu", "malayalam", "kannada",
  "marathi", "gujarati", "bengali", "urdu", "punjabi", "arabic", "turkish",
];
const LANGUAGE_GROUP_KEYS_SET = new Set(LANGUAGE_GROUP_KEYS);
// Panel convention for a multi-dub title's separate catalog entries:
// "Kohrra", "Kohrra (Hindi)", "Kohrra (Tamil)", … — the bracketed word is
// the ONLY place a specific dub variant's language is recorded anywhere
// (category tags are identical across all of a title's variants).
const TITLE_LANG_SUFFIX_RE = new RegExp(`\\((${LANGUAGE_GROUP_KEYS.join("|")})\\)`, "i");
// A dub variant's own explicit language, parsed from its title suffix
// ("Kohrra (Hindi)" -> "hindi"); null for the bare/default entry.
function suffixOf(name) {
  const m = TITLE_LANG_SUFFIX_RE.exec(String(name || ""));
  return m ? m[1].toLowerCase() : null;
}

// Map a language group tag → TMDB ISO-639-1 original_language code. Used
// to disambiguate generic-titled foreign films: a query like "Blind"
// returns many same-year hits across languages, and TMDB ranks by
// popularity, so a Hindi "Blind (2023)" loses to an English "Double
// Blind". Preferring the result whose original_language matches the
// panel item's language tag picks the right regional film.
const LANG_TAG_TO_ISO = {
  english: "en", hindi: "hi", tamil: "ta", telugu: "te", malayalam: "ml",
  kannada: "kn", marathi: "mr", gujarati: "gu", bengali: "bn", urdu: "ur",
  punjabi: "pa", arabic: "ar", turkish: "tr",
};
// First language-tag → ISO for an index item (null when none / unknown).
function isoLangForItem(item) {
  const tags = item && Array.isArray(item.tags) ? item.tags : [];
  for (const t of tags) {
    if (LANG_TAG_TO_ISO[t]) return LANG_TAG_TO_ISO[t];
  }
  return null;
}

// Alternate title words that panels use for the same language.
// Key = LANGUAGE_GROUP_KEYS entry, value = extra words to block.
const LANGUAGE_TITLE_ALIASES = {
  bengali: ["bangla"],
};

// Returns a function that returns false when a title contains a language
// word the user hasn't opted into. Used by /api/home, /api/streams, and
// /api/index so the title-language guard is consistently applied to all clients.
function makeTitleLangFilter(onboardedKeys) {
  if (!onboardedKeys || onboardedKeys.size === 0) return () => true;
  // Pre-build one regex per unselected language (key + aliases).
  const patterns = [];
  for (const lang of LANGUAGE_GROUP_KEYS) {
    if (onboardedKeys.has(lang)) continue;
    const words = [lang, ...(LANGUAGE_TITLE_ALIASES[lang] || [])];
    patterns.push(new RegExp(`\\b(${words.join("|")})\\b`, "i"));
  }
  if (!patterns.length) return () => true;
  return (name) => {
    if (!name) return true;
    for (const re of patterns) if (re.test(name)) return false;
    return true;
  };
}

// Region → default language fallback. Panels routinely file content
// under a country bucket ("INDIAN NEWS", "PAKISTAN NEWS", "UAE") with
// no language hint in the category name. The vast majority of channels
// in those buckets are the region's primary language by default, so we
// add it automatically — but ONLY when no language tag is already
// present. "INDIAN ENGLISH MOVIES" stays English; "INDIAN ENTERTAINMENT"
// gets Hindi. The XX:-prefix layer at the per-channel level overrides
// this for individual channels that aren't actually in the default
// language.
const REGION_DEFAULT_LANGUAGE = {
  india:     "hindi",
  pakistan:  "urdu",
};

// Per-channel name-prefix → tags. Many panel feeds prefix the channel
// name with a 1–5-letter language/country code, either at the start
// ("IN: REPUBLIC BHARAT", "TM: KAIRALI NEWS HD") or after a pipe in
// the alternate "<genre> | <lang>: <name>" form ("News | Ar: Al
// Jazeera", "Kids | En: NickToons HD"). The capture is the strongest
// per-channel language signal the panel gives us — much more reliable
// than category regex when the panel files everything under a generic
// bucket like INDIAN NEWS. Order: more-specific codes first so KAND
// is checked before KA, USA before US, etc.
const CHANNEL_NAME_PREFIX_MAP = [
  // South Asian languages
  { codes: ["IN"],                  tags: ["hindi",     "india"] },
  { codes: ["TAMIL", "TM"],         tags: ["tamil",     "india"] },
  { codes: ["TG", "TE"],            tags: ["telugu",    "india"] },
  { codes: ["MAL", "ML"],           tags: ["malayalam", "india"] },
  { codes: ["MY"],                  tags: ["malayalam", "india"] },
  { codes: ["KAND", "KN"],          tags: ["kannada",   "india"] },
  { codes: ["MR"],                  tags: ["marathi",   "india"] },
  { codes: ["GUJ", "GU"],           tags: ["gujarati",  "india"] },
  { codes: ["BNG", "BN", "BD"],     tags: ["bengali"] },
  { codes: ["PB", "PA"],            tags: ["punjabi",   "india"] },
  { codes: ["URDU", "UR"],          tags: ["urdu"] },
  // Pakistan
  { codes: ["PK"],                  tags: ["urdu",      "pakistan"] },
  // Arabic
  { codes: ["UAE"],                 tags: ["arabic"] },
  { codes: ["AR"],                  tags: ["arabic"] },
  // Anglophone
  { codes: ["USA", "US"],           tags: ["english",   "us"] },
  { codes: ["UKFHD", "UKHD", "UKSD", "UK"], tags: ["english", "uk"] },
  { codes: ["CA"],                  tags: ["english",   "canada"] },
  { codes: ["AU"],                  tags: ["english",   "australia"] },
  { codes: ["EN"],                  tags: ["english"] },
];
const CHANNEL_PREFIX_CODE_INDEX = (() => {
  const m = new Map();
  for (const entry of CHANNEL_NAME_PREFIX_MAP) {
    for (const code of entry.codes) m.set(code.toUpperCase(), entry.tags);
  }
  return m;
})();
// Match either start-of-name ("IN: …") OR after a pipe ("News | Ar:
// …"). The 1–5-letter cap rejects long words like "INDIAN" or "BANGLA"
// (those are caught by category regex anyway). Whitespace allowance
// on both sides of the colon accepts "UK : SKY SPORTS"-style spacing.
const CHANNEL_PREFIX_RE = /(?:^|\|\s*)([A-Za-z]{1,5})\s*:\s/;

// Display labels for every CHANNEL_GROUPS key, plus a `kind`
// classification that lets the chip strip group buckets visually
// (languages | countries | genres) in onboarding. This is the single
// source of truth for chip labels — both clients (web + Android TV)
// read these via the filterConfig field on /api/bootstrap. Adding a
// new CHANNEL_GROUPS entry only requires adding a matching label + kind
// here; no client release needed.
const CHIP_LABELS = {
  english: "English", hindi: "Hindi", punjabi: "Punjabi", tamil: "Tamil",
  telugu: "Telugu", malayalam: "Malayalam", kannada: "Kannada", marathi: "Marathi",
  gujarati: "Gujarati", bengali: "Bengali", urdu: "Urdu", arabic: "Arabic", turkish: "Turkish",
  us: "USA", india: "India", pakistan: "Pakistan", uk: "UK",
  canada: "Canada", australia: "Australia",
  sports: "Sports", kids: "Kids", news: "News", music: "Music",
};
const CHIP_KINDS = {
  english: "language", hindi: "language", punjabi: "language", tamil: "language",
  telugu: "language", malayalam: "language", kannada: "language", marathi: "language",
  gujarati: "language", bengali: "language", urdu: "language", arabic: "language", turkish: "language",
  us: "country", india: "country", pakistan: "country", uk: "country",
  canada: "country", australia: "country",
  sports: "genre", kids: "genre", news: "genre", music: "genre",
};

// Kids cert filtering lives in lib/kids-filter.js so it can be
// unit-tested in isolation. KIDS_CERT_TIERS is the source of truth
// for which us_cert values are allowed at each age. Exposed in
// filterConfig so the client doesn't have to ship a copy of the
// table. `makeKidsBlocker(profile)` is the predicate factory used
// by every endpoint that ships streams to the client so kid
// filtering is uniform across rails, search, index, and per-mode
// streams.
const { KIDS_CERT_TIERS, makeKidsBlocker } = require("./lib/kids-filter");
const { selectContinueAndHistory, hasPosition, clearAutoPointer, autoPointerLive } = require("./lib/continue-rails");

// "<genre> | <lang>: <name>" is a common alternate convention where
// the word BEFORE the pipe is the genre hint ("News | Ar: Al Jazeera",
// "Sport | Ar: Abu Dhabi Sports", "Kids | En: NickToons"). The pre-pipe
// text is run against CHANNEL_GROUPS so news/sports/kids/music get
// surfaced even when the category bucket is generic ("SPORTS | ARABIC"
// doesn't say news, but every Al-Jazeera-style channel in it does).
const CHANNEL_PREPIPE_RE = /^([A-Za-z]{2,12})\s*\|\s*[A-Za-z]{1,5}\s*:\s/;

// Compute the full tag set for a category name in one regex pass. Tags
// returned: language/country/genre group keys + synthetic flags
// ("movies", "4k", "entertainment"). Always returns at least one tag
// — "other" when nothing matches. Both clients consume this set as a
// flat string array on each stream so chip toggles become O(1)
// membership checks instead of running regexes in the UI thread.
function categoryTagsFor(catName) {
  if (!catName) return ["other"];
  const s = String(catName);
  const groups = [];
  for (const g of CHANNEL_GROUPS) {
    if (g.patterns.some(re => re.test(s))) groups.push(g.key);
  }
  // Regional-default language. "INDIAN NEWS" / "PAKISTAN NEWS" / "UAE"
  // have a country tag but no language; selecting hindi+news / urdu+news
  // would return zero. Default the country's primary language ONLY when
  // no language is already in the set (so "INDIAN ENGLISH MOVIES" stays
  // English). The per-channel XX:-prefix layer further refines this for
  // individual channels that aren't in the regional default.
  const hasLang = groups.some(k => LANGUAGE_GROUP_KEYS_SET.has(k));
  if (!hasLang) {
    for (const k of groups) {
      const def = REGION_DEFAULT_LANGUAGE[k];
      if (def && !groups.includes(def)) groups.push(def);
    }
  }
  const isMovies = MOVIES_PATTERNS.some(re => re.test(s));
  const is4k = FOURK_PATTERNS.some(re => re.test(s));
  const isCam = CAM_PATTERNS.some(re => re.test(s));
  const out = [...groups];
  // Residual "other" tag — surfaces categories that match no explicit
  // language/country/genre group. Lets users opt into the long-tail via
  // the Region/language filter modal's "Other" chip. Separate concern
  // from the entertainment derivation below — a category can be both
  // "other" (no group key matched) AND "entertainment" (no non-ent
  // marker fired). Example: "BRASIL", "FRENCH", "RUSSIAN MUSIC TV".
  if (!groups.length) out.push("other");
  if (isMovies) out.push("movies");
  if (is4k) out.push("4k");
  if (isCam) out.push("cam");
  // "entertainment" = neither a movies channel nor part of any other
  // "utility" genre (sports/news/kids/music). Means general programming
  // — what shows on the chip filter when the user wants the residual.
  const hasNonEnt = isMovies || groups.some(k => NON_ENTERTAINMENT_KEYS.has(k));
  if (!hasNonEnt) out.push("entertainment");
  return out.length ? out : ["other"];
}

// Merge category-derived tags with stream-name-derived synthetic
// flags. Some markers (4K resolution, music channels, movies) sit in
// the channel name even when the category is a generic bucket — so
// we scan both. The "entertainment" derived tag is re-evaluated
// against the combined set so e.g. "Sun Music" leaves the entertainment
// bucket once "music" is added.
function streamTagsFor(streamName, catTags) {
  const name = String(streamName || "");
  const set = new Set(catTags);
  // Music channels often live in language buckets ("Tamil – Movies &
  // Music"), so their category alone doesn't carry the music tag.
  // Group regexes have their own music patterns; reuse them here.
  const musicGroup = CHANNEL_GROUPS.find(g => g.key === "music");
  const has4k = FOURK_PATTERNS.some(re => re.test(name));
  const hasMovies = MOVIES_PATTERNS.some(re => re.test(name));
  const hasMusic = musicGroup ? musicGroup.patterns.some(re => re.test(name)) : false;
  const hasCam = CAM_PATTERNS.some(re => re.test(name));
  if (has4k) set.add("4k");
  if (hasMovies) set.add("movies");
  if (hasMusic) set.add("music");
  if (hasCam) set.add("cam");
  // XX:-prefix layer. Per-channel language code is the strongest signal
  // the panel gives us. When present, the language tag is authoritative
  // — strip any other language tag inherited from the category (so a
  // "TE: …" Telugu channel filed under "INDIA HINDI MOVIES" drops the
  // hindi tag and gains telugu). Country tags are additive.
  const prefixMatch = name.match(CHANNEL_PREFIX_RE);
  if (prefixMatch) {
    const tags = CHANNEL_PREFIX_CODE_INDEX.get(prefixMatch[1].toUpperCase());
    if (tags) {
      const langFromPrefix = tags.filter(t => LANGUAGE_GROUP_KEYS_SET.has(t));
      if (langFromPrefix.length) {
        for (const lang of LANGUAGE_GROUP_KEYS) {
          if (!langFromPrefix.includes(lang)) set.delete(lang);
        }
      }
      for (const t of tags) set.add(t);
    }
  }
  // Pre-pipe genre hint. "News | Ar: Al Jazeera HD" tells us the
  // channel is news even though category "SPORTS | ARABIC" only says
  // sports. Run the word before the pipe against CHANNEL_GROUPS so the
  // matching genre key (news/sports/kids/music) lands as a tag.
  const prePipeMatch = name.match(CHANNEL_PREPIPE_RE);
  if (prePipeMatch) {
    const word = prePipeMatch[1];
    for (const g of CHANNEL_GROUPS) {
      if (g.patterns.some(re => re.test(word))) set.add(g.key);
    }
  }
  // Recompute "entertainment" against the merged set: any
  // non-entertainment marker (sports/news/kids/music/movies)
  // disqualifies the channel from the residual bucket.
  let isEnt = !(set.has("movies") || set.has("sports") || set.has("news") || set.has("kids") || set.has("music"));
  if (isEnt) set.add("entertainment"); else set.delete("entertainment");
  return [...set];
}

// Per-host lookup table: category_id (as string) → tag array. Rebuilt
// every time a category list lands (boot, periodic refresh, /refresh).
// Populated synchronously so projectStream() can hit it on the hot
// path without async fan-out per stream. Owner u1 keeps the legacy
// `tagsByCategory` object so older code reading it directly still works;
// non-owner accounts get their own per-host table.
const tagsByCategory = { live: new Map(), movie: new Map(), series: new Map() };
function getTagsByCategoryFor(actx) {
  if (isOwnerAccount(actx)) return tagsByCategory;
  const hostKey = hostHashOf(actx.host);
  let t = tagsByCategoryByHost.get(hostKey);
  if (!t) {
    t = { live: new Map(), movie: new Map(), series: new Map() };
    tagsByCategoryByHost.set(hostKey, t);
  }
  return t;
}

function rebuildCategoryTags(mode, cats, actx = currentAccount()) {
  if (!Array.isArray(cats)) return;
  const m = new Map();
  for (const c of cats) {
    if (c?.category_id == null) continue;
    m.set(String(c.category_id), categoryTagsFor(c.category_name));
  }
  getTagsByCategoryFor(actx)[mode] = m;
}

// Backwards-compat shim — the home endpoint still calls homeGroupKeysOf
// against onboarded language/country keys. Returns just the GROUP
// keys (no synthetic flags) so the existing onboarded-filter logic
// keeps the same semantics.
function homeGroupKeysOf(catName) {
  if (!catName) return ["other"];
  const out = [];
  for (const g of CHANNEL_GROUPS) if (g.patterns.some(re => re.test(catName))) out.push(g.key);
  return out.length ? out : ["other"];
}

// ── Native trailers (GET /api/trailer/:key.mp4) ─────────────────────
// TMDB trailer keys are YouTube videos. Instead of sending the apps to
// YouTube, the server downloads the trailer once with yt-dlp (720p H.264 +
// AAC mp4) into DATA_DIR/trailers/ and serves it with Range support. This
// talks to YouTube only — never the IPTV panel, never the 1-stream
// admission. See lib/trailer-cache.js and docs/TRAILERS.md.
const { createTrailerCache, trailerRouteHandler, makeYtDlpDownloader, newestVersion, isValidTrailerKey } = require("./lib/trailer-cache");
const TRAILER_DIR = path.join(DATA_DIR, "trailers");
const YTDLP_IMAGE_BIN = process.env.YTDLP_BIN || "/usr/local/bin/yt-dlp";
// Self-updated copy lives on the data volume so `yt-dlp -U` survives a
// container recreate; the newer of the two (by --version) is used.
const YTDLP_LOCAL_BIN = path.join(DATA_DIR, "bin", "yt-dlp");
const ytdlp = { bin: null, version: null, lastUpdate: 0, updating: null, failStreak: 0 };
function ytdlpVersionOf(bin) {
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 15_000 }, (err, out) => {
      const v = !err && String(out || "").trim();
      resolve(v && /^\d{4}\.\d{2}\.\d{2}/.test(v) ? v : null);
    });
  });
}
async function pickYtDlp() {
  const cands = [];
  for (const bin of [YTDLP_LOCAL_BIN, YTDLP_IMAGE_BIN]) {
    if (fs.existsSync(bin)) cands.push({ bin, version: await ytdlpVersionOf(bin) });
  }
  const best = newestVersion(cands);
  const prev = ytdlp.version;
  ytdlp.bin = best ? best.bin : null;
  ytdlp.version = best ? best.version : null;
  // A new yt-dlp may fix what failed: forget remembered failures.
  if (best && prev && best.version !== prev) {
    const n = trailerCache.clearNegative();
    if (n) console.log(`[trailer] yt-dlp ${prev} -> ${best.version}: cleared ${n} remembered failures`);
  }
  console.log(best ? `[trailer] yt-dlp ${best.version} (${best.bin})` : "[trailer] yt-dlp not available — trailers disabled");
  return best;
}
// `yt-dlp -U` on the data-volume copy (seeded from the image binary).
// Weekly, and after a streak of download failures (at most every 12 h).
// Last -U time persists as the mtime of a stamp file on the data volume, so
// frequent redeploys don't keep postponing the weekly update.
const YTDLP_STAMP = path.join(DATA_DIR, "bin", ".yt-dlp-updated");
function ytdlpLastUpdate() {
  try { return fs.statSync(YTDLP_STAMP).mtimeMs; } catch { return 0; }
}
function maybeWeeklyYtDlpUpdate() {
  if (Date.now() - ytdlpLastUpdate() > 7 * 86400_000) selfUpdateYtDlp("weekly");
}
function selfUpdateYtDlp(reason) {
  if (ytdlp.updating) return ytdlp.updating;
  ytdlp.lastUpdate = Date.now();
  ytdlp.updating = (async () => {
    try {
      if (!fs.existsSync(YTDLP_LOCAL_BIN)) {
        if (!fs.existsSync(YTDLP_IMAGE_BIN)) return;
        fs.mkdirSync(path.dirname(YTDLP_LOCAL_BIN), { recursive: true });
        fs.copyFileSync(YTDLP_IMAGE_BIN, YTDLP_LOCAL_BIN + ".tmp");
        fs.chmodSync(YTDLP_LOCAL_BIN + ".tmp", 0o755);
        fs.renameSync(YTDLP_LOCAL_BIN + ".tmp", YTDLP_LOCAL_BIN);
      }
      await new Promise((resolve) => {
        execFile(YTDLP_LOCAL_BIN, ["-U"], { timeout: 180_000 }, (err, out, errOut) => {
          const msg = String(out || errOut || (err && err.message) || "").trim().split("\n").slice(-1)[0];
          console.log(`[trailer] yt-dlp -U (${reason}): ${msg.slice(0, 160)}`);
          // Stamp only a successful run, so a failed weekly update retries in 6 h.
          if (!err) {
            try { fs.mkdirSync(path.dirname(YTDLP_STAMP), { recursive: true }); fs.writeFileSync(YTDLP_STAMP, new Date().toISOString()); } catch { /* ignore */ }
          }
          resolve();
        });
      });
      await pickYtDlp();
    } catch (e) {
      console.warn(`[trailer] yt-dlp self-update failed: ${e.message}`);
    } finally {
      ytdlp.updating = null;
    }
  })();
  return ytdlp.updating;
}
const ytDlpDownload = makeYtDlpDownloader({
  bin: () => ytdlp.bin,
  onError: () => {
    if (++ytdlp.failStreak >= 3 && Date.now() - ytdlp.lastUpdate > 12 * 3600_000) {
      ytdlp.failStreak = 0;
      selfUpdateYtDlp("failures");
    }
  },
});
const trailerCache = createTrailerCache({
  dir: TRAILER_DIR,
  download: async (key, tmpDir, opts) => {
    if (!ytdlp.bin) throw new Error("yt-dlp not available");
    const out = await ytDlpDownload(key, tmpDir, opts);
    ytdlp.failStreak = 0;
    return out;
  },
  concurrency: 2,
  timeoutMs: 45_000,
  negTtlMs: 6 * 3600_000,
  ttlMs: 30 * 86400_000,
  maxBytes: (() => { const g = parseFloat(process.env.TRAILER_CACHE_MAX_GB || ""); return (Number.isFinite(g) && g > 0 ? g : 8) * 1024 ** 3; })(),
  log: (m) => console.log(m),
});
// Background prefetch of the "New trailers" rail: one at a time, gap
// between downloads, waits while anyone is watching or a viewer-triggered
// trailer download runs; 5 failures in a row pause it 10 min.
const trailerPrefetch = createPrewarmQueue({
  fetcher: async (e) => {
    if (!ytdlp.bin) throw new Error("yt-dlp not available");
    const f = await trailerCache.ensure(e.trailerKey, { priority: "low" });
    if (!f) throw new Error("unavailable");
  },
  isCached: (e) => trailerCache.has(e.trailerKey) || trailerCache.isNegative(e.trailerKey),
  shouldYield: () => trailerCache.busy() || streamingNowViewers60s(),
  gapMs: 5_000,
  yieldMs: 30_000,
  cap: 40,
});
function scheduleTrailers() {
  pickYtDlp().catch(() => {}).then(() => {
    if (!ytdlp.bin && fs.existsSync(YTDLP_IMAGE_BIN)) selfUpdateYtDlp("boot");
  });
  ytdlp.lastUpdate = ytdlpLastUpdate();
  setTimeout(maybeWeeklyYtDlpUpdate, 3 * 60_000).unref?.();
  const t1 = setInterval(maybeWeeklyYtDlpUpdate, 6 * 3600_000); t1.unref?.();
  const evict = () => { try { const r = trailerCache.evict(); if (r.removed) console.log(`[trailer] evicted ${r.removed} (${(r.totalBytes / 1073741824).toFixed(2)} GB left)`); } catch (e) { console.warn(`[trailer] evict: ${e.message}`); } };
  setTimeout(evict, 60_000).unref?.();
  const t2 = setInterval(evict, 6 * 3600_000); t2.unref?.();
  setTimeout(() => backfillReleaseDates({ reason: "boot" }).catch((e) => console.warn(`[trailer] backfill: ${e.message}`)), 5 * 60_000).unref?.();
  // Title logos are filled on demand only (lazyFillLogo, when a title is opened); the bulk
  // backfill is manual: POST /api/admin/backfill-logos.
  const t3 = setInterval(() => backfillReleaseDates().catch((e) => console.warn(`[trailer] backfill: ${e.message}`)), 6 * 3600_000); t3.unref?.();
}

// Lazy backfill of release_date (+ a missing trailer_key) for TMDB cache
// entries written before release_date was stored. Library titles only,
// only ones recent enough to matter (year >= last year), one TMDB call per
// tmdb_id at a time with a gap, capped per run.
const releaseBackfill = { running: false, done: 0, total: 0 };
async function backfillReleaseDates({ reason = "cron", gapMs = 250 } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY" };
  if (releaseBackfill.running) return { ok: false, error: "already running" };
  releaseBackfill.running = true;
  try {
    const entries = [];
    for (const m of ["movie", "series"]) {
      const ix = indexes[m];
      if (!ix?.byId) continue;
      for (const s of ix.byId.values()) {
        const key = `${m}:${s.id}`;
        entries.push([key, tmdbCache[key]]);
      }
    }
    const todo = backfillCandidates({ entries });
    releaseBackfill.done = 0; releaseBackfill.total = todo.length;
    if (!todo.length) return { ok: true, checked: 0 };
    console.log(`[trailer] release-date backfill: ${todo.length} titles (${reason})`);
    let updated = 0, nulls = 0;
    for (const c of todo) {
      const res = await tmdbRaw(`/${c.kind === "series" ? "tv" : "movie"}/${c.tmdbId}?append_to_response=videos`);
      releaseBackfill.done++;
      if (res === null) {
        if (++nulls >= 20) { console.warn("[trailer] TMDB failing repeatedly — stopping backfill"); break; }
      } else {
        nulls = 0;
        for (const key of c.keys) {
          const e = tmdbCache[key];
          if (e && e.source === "tmdb" && e.tmdb_id === c.tmdbId) { applyReleaseInfo(e, c.kind, res); updated++; tmdbCacheVersion++; }
        }
      }
      await new Promise((r) => setTimeout(r, gapMs));
    }
    if (updated) { scheduleTmdbCacheSave(); catalogGen++; }
    console.log(`[trailer] release-date backfill done: ${releaseBackfill.done} fetched, ${updated} entries updated`);
    return { ok: true, checked: releaseBackfill.done, updated };
  } finally {
    releaseBackfill.running = false;
  }
}

// Lazy backfill of title-logo art (`logo`) for TMDB cache entries written
// before it existed. Library titles only, one TMDB call per tmdb_id with a
// gap, capped per run (the rest on later runs) so TMDB is never hammered.
const logoBackfill = { running: false, done: 0, total: 0 };
async function backfillLogos({ reason = "cron", gapMs = 300, max = 300 } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY" };
  if (logoBackfill.running) return { ok: false, error: "already running" };
  logoBackfill.running = true;
  try {
    const entries = [];
    for (const m of ["movie", "series"]) {
      const ix = indexes[m];
      if (!ix?.byId) continue;
      for (const s of ix.byId.values()) { const key = `${m}:${s.id}`; entries.push([key, tmdbCache[key]]); }
    }
    const todo = logoBackfillCandidates({ entries, max });
    logoBackfill.done = 0; logoBackfill.total = todo.length;
    if (!todo.length) return { ok: true, checked: 0 };
    console.log(`[logo] backfill: ${todo.length} titles (${reason})`);
    let updated = 0, nulls = 0;
    for (const c of todo) {
      const res = await tmdbRaw(`/${c.kind === "series" ? "tv" : "movie"}/${c.tmdbId}/images?include_image_language=en,null`);
      logoBackfill.done++;
      if (res === null) {
        if (++nulls >= 20) { console.warn("[logo] TMDB failing repeatedly — stopping backfill"); break; }
      } else {
        nulls = 0;
        for (const key of c.keys) {
          const e = tmdbCache[key];
          if (e && e.source === "tmdb" && e.tmdb_id === c.tmdbId) { applyLogo(e, { images: res }); updated++; }
        }
      }
      await new Promise((r) => setTimeout(r, gapMs));
    }
    if (updated) { scheduleTmdbCacheSave(); catalogGen++; }
    console.log(`[logo] backfill done: ${logoBackfill.done} fetched, ${updated} entries updated`);
    return { ok: true, checked: logoBackfill.done, updated };
  } finally {
    logoBackfill.running = false;
  }
}

// Only keys that are the TMDB trailer of a cached title are served (no
// arbitrary YouTube downloads); kid profiles additionally need one such
// title rated within their allowed certs. Index rebuilt lazily when the TMDB
// cache changed (at most every 30 s) and at least every 5 min.
const trailerKeyIdx = { idx: new Map(), builtAt: 0, version: -1 };
function trailerKeyIndex(force = false) {
  const age = Date.now() - trailerKeyIdx.builtAt;
  if (force || age > 5 * 60_000 || (trailerKeyIdx.version !== tmdbCacheVersion && age > 30_000)) {
    const version = tmdbCacheVersion;
    trailerKeyIdx.idx = buildTrailerKeyIndex(tmdbStore, (k) => tmdbCache[k], effCert);
    trailerKeyIdx.builtAt = Date.now();
    trailerKeyIdx.version = version;
  }
  return trailerKeyIdx.idx;
}
function kidCertsForProfile(profile) {
  const by = profile?.kidsBirthYear;
  if (!by) return null;
  const age = new Date().getFullYear() - by;
  if (!Number.isFinite(age)) return null;
  const s = new Set();
  for (const tier of KIDS_CERT_TIERS) if (age >= tier.minAge) tier.add.forEach((c) => s.add(c));
  return s;
}
function trailerAllowKey(key, req) {
  let idx = trailerKeyIndex();
  // A key the index has not seen yet (just added by a TMDB fetch/backfill):
  // rebuild once (at most every 2 s) before refusing, so a tile's
  // trailer_key never 404s because of index lag.
  if (!idx.has(key) && Date.now() - trailerKeyIdx.builtAt > 2_000) idx = trailerKeyIndex(true);
  return trailerKeyAllowed(idx, key, kidCertsForProfile(findProfile(req.profileId)));
}
app.get("/api/trailer/:key.mp4", trailerRouteHandler({
  cache: trailerCache,
  available: () => !!ytdlp.bin,
  allowKey: trailerAllowKey,
}));

// Muted preview of a CACHED trailer: the first ~30 s (from 3 s in), video
// only, stream-copied (no re-encode), moov at the front. Never waits for a
// download: an uncached trailer answers 404 not_cached at once and is queued
// for the background prefetch, so a hover/focus preview can retry later.
const TRAILER_PREVIEW_DIR = path.join(TRAILER_DIR, "preview");
const trailerPreviewInflight = new Map();
function trailerFieldsFor(key) {
  if (!key || !isValidTrailerKey(key)) return { trailer: null };
  return { trailer: { key, url: `/api/trailer/${key}.mp4`, preview: `/api/trailer/${key}/preview.mp4`, cached: trailerCache.has(key) } };
}
// withAudio (?audio=1, TV tile previews with sound): the same clip with the
// trailer's first audio track re-encoded to stereo AAC, stored as <key>.a.mp4.
function trailerPreviewFile(key, withAudio) {
  return path.join(TRAILER_PREVIEW_DIR, `${key}${withAudio ? ".a" : ""}.mp4`);
}
function buildTrailerPreview(key, src, withAudio = false) {
  const flightKey = `${key}${withAudio ? ".a" : ""}`;
  let p = trailerPreviewInflight.get(flightKey);
  if (p) return p;
  p = (async () => {
    fs.mkdirSync(TRAILER_PREVIEW_DIR, { recursive: true });
    const dest = trailerPreviewFile(key, withAudio);
    const tmp = path.join(TRAILER_PREVIEW_DIR, `.${flightKey}.${process.pid}.tmp.mp4`);
    const { runFfmpeg } = require("./lib/media-sidecar");
    const r = await runFfmpeg(spawn, "ffmpeg", [
      "-nostdin", "-hide_banner", "-v", "error", "-y", "-ss", "3", "-i", src, "-t", "30",
      ...(withAudio
        ? ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-c:v", "copy", "-c:a", "aac", "-ac", "2", "-b:a", "128k"]
        : ["-map", "0:v:0", "-an", "-sn", "-dn", "-c:v", "copy"]),
      "-movflags", "+faststart", "-f", "mp4", tmp,
    ], { timeoutMs: 30_000, maxBytes: 1024 });
    let ok = false;
    try { ok = r.ok && fs.statSync(tmp).size > 10_000; } catch { ok = false; }
    if (!ok) { fs.rmSync(tmp, { force: true }); console.log(`[trailer] preview ${key} failed: ${String(r.error || "").slice(0, 200)}`); return null; }
    fs.renameSync(tmp, dest);
    return dest;
  })().finally(() => trailerPreviewInflight.delete(flightKey));
  trailerPreviewInflight.set(flightKey, p);
  return p;
}
app.get("/api/trailer/:key/preview.mp4", async (req, res, next) => {
  try {
    const key = req.params.key;
    if (!isValidTrailerKey(key)) return res.status(400).json({ error: "bad_key" });
    let allowed = false;
    try { allowed = !!trailerAllowKey(key, req); } catch { allowed = false; }
    const none = (code) => res.status(404).set({ "Cache-Control": "no-store", ...(code === "not_cached" ? { "Retry-After": "30" } : {}) }).json({ error: code });
    if (!allowed) return none("trailer_unavailable");
    const src = path.join(TRAILER_DIR, `${key}.mp4`);
    if (!trailerCache.has(key)) {
      if (trailerCache.isNegative(key) || !ytdlp.bin) return none("trailer_unavailable");
      if (!req.get("x-khouch-internal")) trailerPrefetch.enqueue([{ key, trailerKey: key }]);
      return none("not_cached");
    }
    const withAudio = req.query.audio === "1";
    const dest = trailerPreviewFile(key, withAudio);
    let file = null;
    try { if (fs.statSync(dest).isFile()) file = dest; } catch { file = null; }
    if (!file) file = await buildTrailerPreview(key, src, withAudio);
    if (!file) return none("trailer_unavailable");
    let size;
    try { size = fs.statSync(file).size; } catch { return none("trailer_unavailable"); }
    res.sendFile(file, {
      acceptRanges: true, lastModified: false, etag: false, dotfiles: "allow",
      headers: { "Content-Type": "video/mp4", "Cache-Control": "private, max-age=86400", "ETag": `"${key}-p${withAudio ? "a" : ""}-${size}"` },
    }, (err) => { if (err && !res.headersSent) none("trailer_unavailable"); });
  } catch (e) { next(e); }
});
// Previews whose full trailer was evicted go too.
setInterval(() => {
  let names = [];
  try { names = fs.readdirSync(TRAILER_PREVIEW_DIR); } catch { return; }
  for (const n of names) {
    const m = /^([A-Za-z0-9_-]{6,20})(?:\.a)?\.mp4$/.exec(n);
    const f = path.join(TRAILER_PREVIEW_DIR, n);
    let old = false;
    try { old = Date.now() - fs.statSync(f).mtimeMs > 10 * 60_000; } catch {}
    if ((n.endsWith(".tmp.mp4") && old) || (m && !n.startsWith(".") && !trailerCache.has(m[1]))) fs.rmSync(f, { force: true });
  }
}, 6 * 3600_000).unref?.();

app.get("/api/admin/trailers", (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json({ ytdlp: { bin: ytdlp.bin, version: ytdlp.version }, cache: trailerCache.stats(), prefetch: { ...trailerPrefetch.stats, queued: trailerPrefetch.size }, backfill: releaseBackfill, logoBackfill });
});
app.post("/api/admin/backfill-logos", (req, res) => {
  if (!requireOwner(req, res)) return;
  if (logoBackfill.running) return res.json({ ok: false, error: "already running", progress: logoBackfill });
  backfillLogos({ reason: "admin" }).catch((e) => console.warn(`[logo] backfill: ${e.message}`));
  res.json({ ok: true, started: true });
});
app.post("/api/admin/backfill-release-dates", (req, res) => {
  if (!requireOwner(req, res)) return;
  if (releaseBackfill.running) return res.json({ ok: false, error: "already running", progress: releaseBackfill });
  backfillReleaseDates({ reason: "admin" }).catch((e) => console.warn(`[trailer] backfill: ${e.message}`));
  res.json({ ok: true, started: true });
});

app.get("/api/home/:mode(live|movie|series|disk)", (req, res) => {
  // No browser cache — the response varies per profile + per filter
  // change + per server-side rule update (e.g. title-language guard).
  // Without this, browsers serve stale rails after a profile switch
  // or a deploy, and users see content the new code would have
  // filtered out.
  res.set("Cache-Control", "no-store");
  const mode = req.params.mode;
  // New shuffle per visit (first fetch after ~8 min idle), stable while browsing.
  const visitSeed = homeVisitSeed(req.profileId, mode, req.get("x-khouch-internal") !== "mcp");
  console.log(`[home] ${mode} profile=${req.profileId || "-"} ${visitSeed} ua=${String(req.get("user-agent") || "-").slice(0, 40)}${req.get("x-khouch-internal") ? " internal" : ""}`);
  const userState = getProfileState(req.profileId);
  const activeProfile = findProfile(req.profileId);
  const kidsAge = (() => {
    const by = activeProfile?.kidsBirthYear;
    if (!by) return null;
    const age = new Date().getFullYear() - by;
    return Number.isFinite(age) ? age : null;
  })();
  const allowedKidCerts = kidsAge === null ? null : (() => {
    const s = new Set();
    for (const tier of KIDS_CERT_TIERS) {
      if (kidsAge >= tier.minAge) tier.add.forEach(c => s.add(c));
    }
    return s;
  })();
  // Allow-list: hero needs an explicit kid-safe cert (used only for
  // the most prominent placement). Block-list (`isKidBlocked`) is
  // used for everything else — see `makeKidsBlocker`.
  const isKidSafe = (tile) => {
    if (allowedKidCerts === null) return true;
    if (!tile.us_cert) return false;
    return allowedKidCerts.has(tile.us_cert);
  };
  const isKidBlocked = makeKidsBlocker(activeProfile);
  const ix = indexes[mode];
  // Followed series with episodes added since this profile last opened / played them.
  const newEps = mode === "series" ? newEpisodeMapFor(req.profileId) : null;

  // Cheap poster URL lookups out of the existing TMDB cache so the
  // client gets a CDN URL inline and never has to fan out a request
  // per tile. Sizes follow TMDB's API: w185 ≈ 2:3 tile at 140 dp,
  // w342 for slightly larger detail-poster, w780 for backdrops.
  const tmdbFor = (id) => tmdbCache[`${mode}:${id}`];
  // Soft-NR: when TMDB has no US cert but the rail's category name
  // strongly implies kid content, treat the item as "G" so kid
  // profiles see the rail at all. Conservative — we only fire on
  // explicit kid markers (kids/cartoon/animation/toddler/family etc.),
  // not on general "entertainment" buckets, and never overrides a
  // real cert (TMDB's R-rated answer always wins).
  const KID_CAT_RE = /\bkids?\b|\bcartoon\b|\banimat|\btoddler\b|\bbaby\b|\bfamily\b|disney|pixar|nick\s*jr|cbeebies|nickelodeon|toon/i;
  const tileFor = (s, catName) => {
    if (!s) return null;
    const t = tmdbFor(s.id);
    let cert = effCert(t) || null;
    if (!cert && (mode === "movie" || mode === "disk") && catName && KID_CAT_RE.test(catName)) {
      cert = "G";
    }
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      year: s.year || null,
      // w154 ≈ 154 px wide vs the 140-dp tile, so 1:1 with minimal
      // upscale. Earlier w185 forced the TV's Coil to decode bitmaps
      // ~40% larger than the tile needs, which the GC measurements
      // pinned as the main jank source on Chromecast silicon.
      poster: tilePoster(mode, s, t),
      us_cert: cert,
      // Pre-computed group/genre/4K tags. Lets the chip strip on
      // Movies / Series filter rails client-side without re-running
      // the GROUPS regex table per tile.
      tags: s.tags || ["other"],
      // The container ext (mp4 / mkv / avi). Clients use this to
      // surface an "MKV" badge on tiles that will go through the
      // server transcoder — sets expectations for the slower start.
      container: s.container || null,
      // Channel count on the source audio track (2, 6, 8…) when known.
      // Lets the TV render a "5.1" / "7.1" badge for tiles that will
      // exercise an AVR setup. Populated lazily as users open detail
      // screens — null until then.
      ...audioTileFields(s),
      // Disk-only: a synthetic tile grouping Save-to-Disk episodes under
      // one series (see buildDiskIndex) — the client opens the episode
      // picker instead of playing this id directly.
      isSeriesGroup: s.isSeriesGroup || undefined,
      episodeCount: s.episodeCount || undefined,
      // YouTube key of the title's TMDB trailer (play /api/trailer/<key>.mp4,
      // or the muted /api/trailer/<key>/preview.mp4). Omitted when none.
      trailer_key: (mode !== "live" && t?.trailer_key) || undefined,
      // Series: number of episodes added since this profile last opened / played it.
      new_episodes: newEps?.get(String(s.id))?.count || undefined,
    };
  };
  const heroFor = (s) => {
    if (!s) return null;
    const t = tmdbFor(s.id);
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      year: s.year || null,
      plot: t?.plot || s.plot || null,
      poster: tilePoster(mode, s, t),
      // w1280 (vs w780) — at the taller hero size, w780 was visibly
      // upscaled on wide monitors. w1280 is the next TMDB step up
      // and is the right size for a 1440p-ish hero with the 1.05
      // zoom transform applied.
      backdrop: t?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${t.backdrop_path}` : null,
      rating: t?.rating || null,
      runtime: t?.runtime || null,
      us_cert: effCert(t) || null,
      logo: logoUrl(t?.logo),
      isSeriesGroup: s.isSeriesGroup || undefined,
      trailer_key: (mode !== "live" && t?.trailer_key) || undefined,
      preview: (mode !== "live" && t?.trailer_key) ? `/api/trailer/${t.trailer_key}/preview.mp4` : undefined,
    };
  };

  // Onboarded category filter. Same shape the web's
  // filteredLiveChannels() uses — only categories whose group keys
  // intersect the user's picks are eligible. Falls through to "all
  // visible" if the user never onboarded or picked nothing.
  // Onboarding always sets live picks first; movie/series may be left
  // blank if the user finished onboarding without filling those tabs.
  // Treating empty as "no filter" dumped every category into the home
  // rails — e.g. a kids profile that picked English/US/Kids on Live
  // would still see Tamil / Hindi movie rails. Fall back to the live
  // picks for movie/series when the per-mode list is empty.
  const modeKeys = (() => {
    const own = userState.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    const liveKeys = userState.filter?.groups?.live;
    if (Array.isArray(liveKeys) && liveKeys.length) return liveKeys;
    return [];
  })();
  const onboardedKeys = new Set(modeKeys);
  // Disk is the owner's own local library — never apply the language /
  // onboarding category filter to it (show every folder + every title;
  // smart TMDB rails still build). Kid-cert blocking still applies below.
  const onboarded = mode !== "disk" && !!userState.filter?.onboarded && onboardedKeys.size > 0;
  const cats = loadCategoriesFromDiskSync(mode); // array of {category_id, category_name}
  const allowedCatIds = new Set();
  if (!onboarded) {
    for (const c of cats) allowedCatIds.add(String(c.category_id));
  } else {
    for (const c of cats) {
      if (homeGroupKeysOf(c.category_name).some(k => onboardedKeys.has(k))) {
        allowedCatIds.add(String(c.category_id));
      }
    }
  }

  const titleLangPasses = onboarded ? makeTitleLangFilter(onboardedKeys) : () => true;
  // One tile per title: hide non-chosen language/quality variants (see assignVariants).
  const variantCatName = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
  const variantHidden = makeVariantHider(
    ix,
    // Kid gate included (with the category soft-NR rescue tileFor applies), so
    // the variant chosen is one the profile can actually see.
    (x) => titleLangPasses(x.name) && allowedCatIds.has(String(x.category_id))
      && (allowedKidCerts === null || !isKidBlocked(tileFor(x, variantCatName.get(String(x.category_id))))),
    onboarded ? new Set([...onboardedKeys].map((k) => LANG_TAG_TO_ISO[k]).filter(Boolean)) : null,
  );

  // Camera-recorded copies (CAM/HDTS/...) stay browsable in category rails
  // (sorted last) and searchable, but never headline the hero or a curated rail.
  const isLQ = (s) => !!s && mode !== "live" && isLowQuality(s, variantCatName.get(String(s.category_id)));

  // Group eligible items by category in one pass over the index.
  // Cached per gate signature (language/kid/account) like the smart pool: the
  // grouping is request-independent and costs a regex test per catalog item.
  const gateSig = [
    mode, onboarded ? [...onboardedKeys].sort().join(",") : "-",
    allowedKidCerts ? [...allowedKidCerts].sort().join(",") : "-",
    accountKeyOf(currentAccount()),
  ].join("|");
  let byCat;
  const cachedCats = catBucketCache.get(gateSig);
  if (ix.ready && cachedCats && cachedCats.byId === ix.byId && cachedCats.gen === catalogGen && Date.now() - cachedCats.at < 8 * 60 * 1000) {
    byCat = new Map(cachedCats.map); // shallow copy: callers replace entries with their sliced items
  } else {
    byCat = new Map();
    for (const s of ix.byId.values()) {
      const cid = String(s.category_id || "");
      if (!allowedCatIds.has(cid)) continue;
      if (!titleLangPasses(s.name)) continue;
      if (variantHidden(s)) continue;
      let bucket = byCat.get(cid);
      if (!bucket) { bucket = []; byCat.set(cid, bucket); }
      bucket.push(s);
    }
    if (ix.ready) putHomeCache(catBucketCache, gateSig, { byId: ix.byId, map: new Map(byCat) }); // never cache a half-built catalog
  }
  // For kid profiles: sort each bucket so cert-passing items come first,
  // then slice to 12. Without this the cap picks the first 12 by index
  // insertion order and kid-safe items (e.g. WrestleMania PG) that sit
  // beyond position 12 never make it into the rail.
  const sliceBucket = (bucket, catName) => {
    if (allowedKidCerts !== null) {
      const isKidCategory = !!catName && KID_CAT_RE.test(catName);
      bucket = bucket.filter(s => {
        if (s.us_cert) return allowedKidCerts.has(s.us_cert);
        return isKidCategory;
      });
    }
    // Walk the bucket dedup'ing by tmdb_id (falling back to title+year
    // when tmdb_id hasn't landed for one twin yet — see dedupTitleKey);
    // track the eligible total (post-filter, post-dedup) so the client
    // can show "12 of 87" counts on each rail. Cap the visible window
    // at 12.
    const seenTmdb = new Set();
    const seenTitle = new Set();
    const out = [];
    let totalEligible = 0;
    if (mode !== "live") bucket = lowQualityLast(bucket, (x) => variantCatName.get(String(x.category_id)));
    for (const s of bucket) {
      const titleKey = dedupKeyOf(s);
      if (titleKey && seenTitle.has(titleKey)) continue;
      if (s.tmdb_id) {
        if (seenTmdb.has(s.tmdb_id)) continue;
        seenTmdb.add(s.tmdb_id);
      }
      if (titleKey) seenTitle.add(titleKey);
      totalEligible++;
      if (out.length < 12) out.push(s);
    }
    return { items: out, total: totalEligible };
  };
  const catName = new Map(cats.map(c => [String(c.category_id), c.category_name]));
  // Stash the sliced items + the full eligible total per category so
  // rails can render "(N)" next to the title.
  const bucketTotals = new Map();
  const rotBucketNow = visitSeed;
  for (const [cid, rawBucket] of byCat) {
    // Rotate WHICH titles surface in each provider category (VOD only —
    // channel order in live categories is meaningful). Soft shuffle
    // over the first 200 so the visible 12 change through the day.
    // Dedup twins BEFORE shuffling so the surviving variant (stream id —
    // progress/favorites are keyed by it) doesn't flip between rotations.
    let bucket = rawBucket;
    // Kid profiles skip the pre-dedup: sliceBucket applies the cert filter
    // before its dedup, and deduping first could keep an uncertified twin.
    if (mode !== "live" && allowedKidCerts === null) {
      const sT = new Set(), sK = new Set();
      bucket = rawBucket.filter((s) => {
        const tk = dedupKeyOf(s);
        if ((tk && sK.has(tk)) || (s.tmdb_id && sT.has(s.tmdb_id))) return false;
        if (tk) sK.add(tk);
        if (s.tmdb_id) sT.add(s.tmdb_id);
        return true;
      });
      bucket = [...jitterOrder(bucket.slice(0, 200), seededRng(`cat:${rotBucketNow}:${req.profileId}:${mode}:${cid}`), 60), ...bucket.slice(200)];
    }
    const r = sliceBucket(bucket, catName.get(String(cid)));
    byCat.set(cid, r.items);
    bucketTotals.set(cid, r.total);
  }

  const rails = [];

  // Continue Watching — newest-first by `t`. progress is per-profile,
  // keyed as "mode:id". Live mode has no concept of position so
  // it's skipped there. Title-language guard applies here too so a
  // wrong-language item left over in progress / favorites / recents
  // (e.g. from a previous profile-state leak) doesn't keep showing.
  // User-curated rails: gate by `isKidSafe` (strict allow-list) so a
  // leftover R/TV-MA in My List or progress can't surface on a kid
  // profile. Also gated by the title-language guard.
  //
  // For the on-rail "total" count, we report the full eligible set
  // size (post-filtering) — i.e. how many CW/MyList/Favs items in
  // this mode survive the kid-cert + title-language gates — so the
  // header can say "My List (87)" even though the rail only shows 12.
  const eligibleFromIds = (ids) => (ids || [])
    .map(id => ix.byId.get(id))
    .filter(s => s && titleLangPasses(s.name))
    .map(s => tileFor(s))
    .filter(t => t && isKidSafe(t));

  // Continue Watching (unfinished only) + Recently Watched (history) rails,
  // split by lib/continue-rails.js from the union of `userState.progress`
  // (items with a saved playback position) and `userState.recents`
  // (items the user just pressed play on, no position). Recency comes
  // from progress.t when available, else lastPlayed[mode][id] (per-
  // household timestamp recorded on /api/play-event), else 0. Items
  // surface a `progress: {p, d}` field when they have a position so the
  // client can render the resume progress bar without a second lookup.
  // Replaces the old separate "Continue Watching" + "Recently Played"
  // rails — users think "where was I last," not "did I save a position."
  if (mode !== "live") {
    // Series Continue Watching entries must key everything (progress,
    // recents, lastPlayed) by the PARENT series id — that's what
    // ix.byId is keyed by for series mode. In practice individual
    // clients haven't been consistent about which id (series vs.
    // specific episode) they send to pushRecent/play-event/progress,
    // which silently broke recency sorting (and could drop a series
    // from the rail entirely). Rather than trust every client to get
    // this right, normalize any episode id we recognize back to its
    // parent series id here — using the episode_id → series id reverse
    // map baked from lastEpisode, which every client already writes
    // correctly on episode playback.
    const toSeriesId = (id) => id;
    let normalizeId = toSeriesId;
    if (mode === "series") {
      const episodeToSeries = new Map();
      for (const [seriesId, le] of Object.entries(userState.lastEpisode || {})) {
        if (le?.episode_id != null) episodeToSeries.set(String(le.episode_id), parseInt(seriesId, 10));
      }
      // Only remap when the raw id ISN'T already a valid series id in
      // the index — an id that already resolves in ix.byId is trusted
      // as-is, so a coincidental collision between a series id and an
      // unrelated series' episode_id (panel ids aren't guaranteed
      // disjoint) can never hijack an already-correct entry.
      normalizeId = (id) => ix.byId.has(id) ? id : (episodeToSeries.get(String(id)) ?? id);
    }
    const progressEntries = Object.entries(userState.progress || {})
      .filter(([k]) => k.startsWith(mode + ":"));
    // Two raw keys can normalize onto the same series id (e.g. stale
    // progress under an old episode id alongside fresh progress under
    // the series id); keep whichever has the more recent timestamp,
    // not just whichever comes last in object insertion order.
    const progressById = new Map();
    for (const [k, v] of progressEntries) {
      const id = normalizeId(parseInt(k.split(":", 2)[1], 10));
      const cur = progressById.get(id);
      if (!cur || (v?.t || 0) > (cur?.t || 0)) progressById.set(id, v);
    }
    const recentIds = (Array.isArray(userState.recents?.[mode])
      ? userState.recents[mode] : []).map(normalizeId);
    const lpRaw = getLastPlayedFor(currentAccount())[mode] || {};
    // Same normalization for lastPlayed — a raw entry may be stamped
    // under an episode id from a play-event call; fold it onto its
    // series id, keeping the most recent timestamp per series.
    const lpForMode = {};
    for (const [rawId, ts] of Object.entries(lpRaw)) {
      const key = String(normalizeId(parseInt(rawId, 10)));
      if (!lpForMode[key] || ts > lpForMode[key]) lpForMode[key] = ts;
    }
    const watchedIds = [];
    for (const w of userState.watched || []) {
      const w2 = String(w);
      if (w2.startsWith(mode + ":")) {
        const n = parseInt(w2.slice(mode.length + 1), 10);
        if (Number.isFinite(n)) watchedIds.push(normalizeId(n));
      }
    }
    const { continueIds, historyIds } = selectContinueAndHistory({
      mode, progressById, recentIds, lpForMode, watchedIds,
      lastEpisode: userState.lastEpisode || {},
    });
    const tilesFor = (ids, withProgress) => ids
      .map((id) => ix.byId.get(id))
      .filter((s) => s && titleLangPasses(s.name))
      .map((s) => {
        const tile = tileFor(s);
        if (!tile) return null;
        const p = progressById.get(s.id);
        if (withProgress && p && Number.isFinite(p.p) && p.p > 5) {
          tile.progress = { p: p.p, d: p.d || null };
        }
        return tile;
      })
      .filter((t) => t && isKidSafe(t));
    const cwTiles = tilesFor(continueIds, true);
    const histTiles = tilesFor(historyIds, false);
    if (cwTiles.length) {
      // No category_id: "See all" for __recents lists recents (incl.
      // finished titles), which is the history rail's job. 12 is enough
      // for unfinished items; no client change needed.
      rails.push({
        title: "Continue Watching",
        total: cwTiles.length,
        items: cwTiles.slice(0, 12),
      });
    }
    // New episodes (lib/new-episodes.js): followed series with episodes the
    // panel added since this profile last opened / played them, newest first.
    if (newEps?.size) {
      const neTiles = newEpisodesLib.railOrder(newEps)
        .map((sid) => {
          const s = ix.byId.get(parseInt(sid, 10));
          const tile = s && tileFor(s);
          if (!tile || !isKidSafe(tile)) return null;
          const ne = newEps.get(sid);
          tile.pickReason = ne.count > 1 ? `${ne.count} new episodes` : `New: S${ne.latest.s} E${ne.latest.e}`;
          return tile;
        })
        .filter(Boolean);
      if (neTiles.length) {
        rails.push({ title: "New episodes", category_id: "__rail-new-episodes", total: neTiles.length, items: neTiles });
      }
    }
    // Now on Khouch: titles from this profile's Notify-me list that arrived in
    // the catalog (lib/notify-me.js), newest arrival first.
    if (mode === "movie" || mode === "series") {
      const seenNow = new Set();
      const nowTiles = notifyMeLib.nowOnKhouch(userState.notifyMe, mode)
        .map((e) => {
          const raw = ix.byId.get(e.landed.id);
          const s = raw ? (variantHidden.resolve(raw) || raw) : null;
          if (!s || seenNow.has(s.id)) return null;
          seenNow.add(s.id);
          const tile = tileFor(s, null);
          if (!tile || isKidBlocked(tile)) return null;
          tile.pickReason = "You asked to be notified";
          return tile;
        })
        .filter(Boolean);
      if (nowTiles.length) rails.push({ title: "Now on Khouch", category_id: "__rail-now-on-khouch", total: nowTiles.length, items: nowTiles });
    }
    if (histTiles.length) {
      // __recents = web PSEUDO.RECENTS / Android CategoryScreen: client-side
      // "See all" over userState.recents. Hint only; server doesn't render it.
      rails.push({
        title: "Recently Watched",
        category_id: "__recents",
        total: histTiles.length,
        items: histTiles.slice(0, 12),
      });
    }
  }

  // Tonight — AI-curated live highlights for tonight (rebuildTonight,
  // nightly). Live mode only. `tonightDigest` is an OWNER-GLOBAL built
  // from the owner panel's stream id space, so it must only render for
  // the owner account — a member's `ix` is their own panel and the ids
  // wouldn't map (a collision would surface an unrelated channel under
  // a curated hook). Skipped entirely for kid profiles: normal live
  // browsing confines kids to kid-named categories (`allowedCatIds`),
  // and this curated primetime set isn't so confined. channel_ids are
  // live stream ids; each pick's `why` rides on the tile as pickReason.
  // `titleLangPasses` keeps language parity with the sibling live rails.
  // Hidden when the digest is missing or stale (> 30h = last night's).
  if (mode === "live" && isOwnerAccount(currentAccount()) && allowedKidCerts === null
      && tonightDigest && Array.isArray(tonightDigest.live)
      && Date.now() - (tonightDigest.updatedAt || 0) < 30 * 60 * 60 * 1000) {
    const seenTn = new Set();
    const tnTiles = tonightDigest.live
      .map((pick) => {
        const s = ix.byId.get(pick.channel_id) ?? ix.byId.get(parseInt(pick.channel_id, 10));
        if (!s || !titleLangPasses(s.name)) return null;
        const key = String(s.id);
        if (seenTn.has(key)) return null;
        seenTn.add(key);
        const tile = tileFor(s, null);
        if (tile && pick.why) tile.pickReason = pick.why;
        return tile;
      })
      .filter(Boolean);
    if (tnTiles.length) {
      rails.push({
        title: "Tonight",
        blurb: tonightDigest.summary || null,
        total: tnTiles.length,
        items: tnTiles.slice(0, 20),
      });
    }
  }

  // On now / Starting soon (live) — from the guide (EPG) for channels matched
  // to guide data: what's airing now on your favourite/recent channels, live
  // sport and long programmes (movies), plus sport/movies starting in the next
  // 3 hours. One tile per guide channel (HD/FHD copies collapse). Owner +
  // adult profiles only, like Tonight.
  if (mode === "live" && isOwnerAccount(currentAccount()) && allowedKidCerts === null && epgIndex.size) {
    const nowMs = Date.now();
    const SPORT_RE = /\b(live|v|vs|cricket|football|soccer|match|ipl|nba|nfl|mlb|nhl|f1|grand prix|ufc|wwe|tennis|golf|premier league|world cup|test|odi|t20)\b/i;
    const NOT_RE = /\b(news|bulletin|headlines|weather|shopping|teleshop|promo|filler|religious|prayer)\b/i;
    const fav = new Set([...(userState.favorites?.live || []), ...(userState.recents?.live || [])].map(String));
    const clock = (ms) => new Date(ms).toLocaleTimeString("en-US", { timeZone: DISK_DOWNLOAD_WINDOW_TZ, hour: "numeric", minute: "2-digit" });
    const seenEpg = new Set();
    const onNow = [], soon = [];
    // Guide channel ids of favourite/recent streams (any HD/SD copy counts).
    const favEpg = new Set();
    for (const s of ix.byId.values()) if (s.epg_channel_id && fav.has(String(s.id))) favEpg.add(s.epg_channel_id);
    // First programme whose stop is after `t` (arrays are sorted by start).
    const firstEnding = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].stop > t) hi = m; else lo = m + 1; } return lo; };
    for (const s of ix.byId.values()) {
      const eid = s.epg_channel_id;
      if (!eid || seenEpg.has(eid)) continue;
      if (!allowedCatIds.has(String(s.category_id)) || !titleLangPasses(s.name)) continue;
      const progs = epgIndex.get(eid);
      if (!progs || !progs.length) continue;
      seenEpg.add(eid);
      const idx = firstEnding(progs, nowMs);
      if (idx >= progs.length) continue;
      const cur = progs[idx].start <= nowMs ? progs[idx] : null;
      const nxt = cur ? progs[idx + 1] : progs[idx];
      if (cur && cur.title && !NOT_RE.test(cur.title)) {
        const dur = (cur.stop - cur.start) / 60000;
        const score = (favEpg.has(eid) ? 5 : 0) + (SPORT_RE.test(cur.title) ? 3 : 0) + (dur >= 90 ? 2 : 0);
        onNow.push({ s, cur, score });
      }
      if (nxt && nxt.title && nxt.start > nowMs && nxt.start - nowMs <= 3 * 3600e3 && !NOT_RE.test(nxt.title)
          && (SPORT_RE.test(nxt.title) || (nxt.stop - nxt.start) / 60000 >= 90)) {
        soon.push({ s, nxt });
      }
    }
    const mk = (s, text) => { const tl = tileFor(s, null); if (tl) tl.pickReason = text.slice(0, 80); return tl; };
    const nowTiles = onNow.sort((a, b) => b.score - a.score || a.cur.stop - b.cur.stop).slice(0, 20)
      .map((x) => mk(x.s, `${x.cur.title} · until ${clock(x.cur.stop)}`)).filter(Boolean);
    const soonTiles = soon.sort((a, b) => a.nxt.start - b.nxt.start).slice(0, 16)
      .map((x) => mk(x.s, `${x.nxt.title} · ${clock(x.nxt.start)}`)).filter(Boolean);
    if (nowTiles.length >= 4) rails.push({ title: "On now", total: nowTiles.length, items: nowTiles });
    if (soonTiles.length >= 4) rails.push({ title: "Starting soon", total: soonTiles.length, items: soonTiles });
  }

  // For You — AI taste picks from the nightly rebuildTasteProfiles()
  // job (absent until the job has run, i.e. whenever ANTHROPIC_API_KEY
  // isn't configured). Picks were kid-gated at build time, but the
  // gates re-run at render time anyway: the profile's cert tier and
  // language filter can change between rebuilds, and the item must
  // still exist in the index.
  {
    const pickIds = tasteProfiles[req.profileId]?.picks?.[mode];
    // Per-pick "Because you watched…" rationales, keyed by String(id)
    // (lib/ai.js writes them that way). Attached to the tile so the
    // client shows the reason in place of the generic rail-name caption.
    const pickReasons = tasteProfiles[req.profileId]?.reasons?.[mode];
    const pickWhen = tasteProfiles[req.profileId]?.when?.[mode];
    if (Array.isArray(pickIds) && pickIds.length) {
      // Daypart-matching picks lead, then a seeded soft shuffle (stable
      // ~4h) so every open of the app isn't the same 20 in the same order.
      const dp = currentDaypart();
      const fits = (id) => { const w = pickWhen?.[String(id)]; return !w || w === dp ? 0 : 1; };
      const rngFy = seededRng(`fy:${visitSeed}:${req.profileId}:${mode}`);
      // Jitter inside each fit-group so daypart matches always lead.
      const ordered = [
        ...jitterOrder(pickIds.filter((id) => fits(id) === 0), rngFy, 40),
        ...jitterOrder(pickIds.filter((id) => fits(id) === 1), rngFy, 40),
      ];
      const seenFy = new Set();
      const fyTiles = ordered
        .map((id) => variantHidden.resolve(ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10))))
        .filter((s) => s && titleLangPasses(s.name) && !isLQ(s))
        .filter((s) => {
          const key = s.tmdb_id || `id:${s.id}`;
          if (seenFy.has(key)) return false;
          seenFy.add(key);
          return true;
        })
        .map((s) => {
          const tile = tileFor(s, null);
          // Picks may point at another variant of this title: look the
          // rationale up across the whole group.
          const canonS = s.isAlt ? ix.byId.get(s.canonicalId) : s;
          const reason = pickReasons?.[String(s.id)]
            || (canonS?.variants || []).map((v) => pickReasons?.[String(v.id)]).find(Boolean);
          if (tile && reason) tile.pickReason = reason;
          return tile;
        })
        .filter((t) => t && !isKidBlocked(t));
      if (fyTiles.length >= 4) {
        // "Tonight's pick" — the 3 best-fitting picks as their own
        // short rail, so "just give me something" is one glance away
        // on every client (phone, TV, web) with no client change.
        if (fyTiles.length >= 8 && mode !== "live") {
          const top = fyTiles.splice(0, 3);
          rails.push({
            title: "Tonight's pick",
            total: top.length,
            items: top,
            snoozable: true,
          });
        }
        rails.push({
          title: "For You",
          total: fyTiles.length,
          items: fyTiles.slice(0, 20),
          // Client-side flag: only this rail's tiles get the "seen it,
          // not now" affordance — it's a recommendation-snooze concept,
          // meaningless on a plain browse/category rail.
          snoozable: true,
        });
      }
    }
  }

  // Popular in your house — titles at least 2 profiles of THIS household (same
  // login) have watched in the last 3 weeks. Who watched what comes from each
  // profile's recents/progress/lastEpisode/watched; when comes from the
  // household's per-title last-played timestamps (a finished movie drops out of
  // `progress`, so progress alone misses it). Variants of a title count as one.
  if ((mode === "movie" || mode === "series") && ix.byId && req.user) {
    const since = Date.now() - 21 * 86400000;
    const lp = getLastPlayedFor(currentAccount())[mode] || {};
    const tally = new Map(); // canonical stream id -> { viewers:Set, last }
    const canonId = (id) => { const s0 = ix.byId.get(id); return s0 ? (s0.isAlt ? s0.canonicalId : id) : null; };
    const bump = (id, pid, t) => {
      const cid = canonId(id);
      if (cid == null || !(t > since)) return;
      const e = tally.get(cid) || { viewers: new Set(), last: 0 };
      e.viewers.add(pid); e.last = Math.max(e.last, t); tally.set(cid, e);
    };
    for (const pr of profiles.profiles) {
      if (pr.ownerUserId !== req.user.id) continue;
      const st = getProfileState(pr.id);
      const seenIds = new Set();
      (st.recents?.[mode] || []).forEach((id) => seenIds.add(parseInt(id, 10)));
      for (const k of Object.keys(st.progress || {})) if (k.startsWith(mode + ":")) seenIds.add(parseInt(k.slice(mode.length + 1), 10));
      for (const w of st.watched || []) { const w2 = String(w); if (w2.startsWith(mode + ":")) seenIds.add(parseInt(w2.slice(mode.length + 1), 10)); }
      for (const [sid, le] of Object.entries(st.lastEpisode || {})) {
        if (mode === "series") bump(parseInt(sid, 10), pr.id, le?.when || 0);
      }
      for (const id of seenIds) if (Number.isFinite(id)) bump(id, pr.id, lp[id] || lp[String(id)] || 0);
    }
    const tiles = [...tally.entries()]
      .filter(([, e]) => e.viewers.size >= 2)
      .sort((a, b) => b[1].viewers.size - a[1].viewers.size || b[1].last - a[1].last)
      .map(([id]) => variantHidden.resolve(ix.byId.get(id)))
      .filter((s) => s && titleLangPasses(s.name) && !isLQ(s))
      .map((s) => tileFor(s, null))
      .filter((t) => t && !isKidBlocked(t));
    const seenH = new Set();
    const uniq = tiles.filter((t) => (seenH.has(t.id) ? false : (seenH.add(t.id), true)));
    if (uniq.length >= 4) rails.push({ title: "Popular in your house", total: uniq.length, items: uniq.slice(0, 20) });
  }

  // Streaming buzz — "Popular on Netflix / Prime / Max / …" from TMDB's
  // per-platform popularity (buildStreamingBuzz), limited to titles Khouch
  // actually has. Each tile is captioned "#N on <platform>" (N = rank among
  // everything popular there, not just what Khouch carries). Movies/series
  // only; kid/language gates and the native-language variant choice apply.
  if ((mode === "movie" || mode === "series") && streamingBuzz.providers && ix.byTmdb) {
    const kind = mode === "movie" ? "movie" : "tv";
    const buzzRails = [];
    const tileForBuzz = (entry, label, lang) => {
      const members = ix.byTmdb.get(entry.id);
      if (!members?.length) return null;
      // First member that survives this profile's gates (language, category,
      // kid) — the title may exist in several languages/categories.
      let tile = null;
      // Prefer the stream whose audio matches the rail's language.
      const ordered = lang && lang !== "all"
        ? [...members].sort((a, b) => (b.audioLang === lang) - (a.audioLang === lang))
        : members;
      for (const m of ordered) {
        const s = variantHidden.resolve(m);
        if (!s || !titleLangPasses(s.name) || !allowedCatIds.has(String(s.category_id)) || isLQ(s)) continue;
        const tl = tileFor(s, null);
        if (tl && !isKidBlocked(tl)) { tile = tl; break; }
      }
      if (!tile) return null;
      tile.pickReason = /trending/.test(label) ? `#${entry.rank} ${label}` : `#${entry.rank} on ${label}`;
      return tile;
    };
    const makeRail = (title, list, label, srcLang) => {
      const seen = new Set();
      const tiles = [];
      for (const entry of list) {
        const t = tileForBuzz(entry, label, srcLang);
        if (!t || seen.has(t.id)) continue;
        seen.add(t.id);
        tiles.push(t);
        if (tiles.length >= 20) break;
      }
      return tiles.length >= 6 ? { title, total: tiles.length, items: tiles, _lang: srcLang } : null;
    };
    // Trending this week (all platforms; English/Hindi/Punjabi titles only).
    const trendingRail = makeRail("Trending this week", streamingBuzz.trending?.[kind] || [], "trending this week", "all");
    const langTrending = [];
    const platformRails = [];
    for (const src of BUZZ_SOURCES) {
      const data = streamingBuzz.providers[src.key]?.[kind] || [];
      if (src.platform === "trending") {
        const r = makeRail(src.title, data, `${BUZZ_LANG_NAME[src.lang]} trending`, src.lang);
        if (r) langTrending.push(r);
      } else {
        const r = makeRail(src.title, data, src.label, src.lang);
        if (r) platformRails.push(r);
      }
    }
    // Keep the home manageable: the trending rails always, plus 2 English,
    // 2 Hindi and 1 Punjabi platform rail, a different set each visit.
    const rngBuzz = seededRng(`buzz:${visitSeed}:${req.profileId}:${mode}`);
    const shuffled = jitterOrder(platformRails, rngBuzz, 12);
    const pick = (lang, n) => shuffled.filter((r) => r._lang === lang).slice(0, n);
    const chosen = new Set([...pick("en", 2), ...pick("hi", 2), ...pick("pa", 1)]);
    for (const r of shuffled) { if (chosen.size >= 5) break; chosen.add(r); } // fill if a language is short
    const platforms = shuffled.filter((r) => chosen.has(r));
    const out = [trendingRail, ...langTrending, ...platforms].filter(Boolean);
    for (const r of out) delete r._lang;
    rails.push(...out);
  }

  // Recently Added — items whose panel-side `added` timestamp falls
  // within the last RECENTLY_ADDED_DAYS. Surfaces what's new this week
  // so the household has a "anything new tonight?" answer without
  // crawling the catalog. Live is skipped (channels don't churn like
  // VOD does). Applies the same kid + title-language guards as the
  // user-curated rails. Hidden when empty (the panel batches drops,
  // so on quiet days the rail just doesn't show).
  if (mode !== "live") {
    const cutoffSec = Math.floor((Date.now() - RECENTLY_ADDED_DAYS * 86400000) / 1000);
    const recentTiles = [...indexes[mode].byId.values()]
      .map((s) => {
        const added = parseInt(s.added, 10);
        return Number.isFinite(added) && added >= cutoffSec ? { s, added } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.added - a.added)
      .filter(({ s }) => titleLangPasses(s.name) && !variantHidden(s) && !isLQ(s))
      .map(({ s }) => tileFor(s))
      .filter((t) => t && isKidSafe(t));
    if (recentTiles.length) {
      // Emit up to 100 so the See-all grid actually shows all the
      // recently-added titles. Rail track is horizontally scrollable
      // and the home payload stays bounded by RECENTLY_ADDED_DAYS.
      // total must be the PRE-slice count — clients gate "See all" on
      // total > items.size, so using slice.length here (the post-slice
      // count) made total == items.length always true, and the "See
      // all" link never appeared no matter how many recently-added
      // items actually existed beyond the visible rail row.
      const slice = recentTiles.slice(0, 100);
      rails.push({
        title: "Recently Added",
        total: recentTiles.length,
        items: slice,
      });
    }
  }

  // New trailers — recent releases (movies <=120 d, series first aired
  // <=90 d, by TMDB release_date) that the library carries and that have a
  // TMDB trailer. One tile per tmdb_id (4K/FHD copies), same language /
  // variant / low-quality / kid gates as Recently Added, newest first,
  // hidden when empty. Tiles carry `trailer_key` (+ `release_date`) so the
  // apps play GET /api/trailer/<key>.mp4 natively. The top of the rail is
  // prefetched in the background (one at a time, only while idle).
  if (mode === "movie" || mode === "series") {
    const picked = selectNewTrailers({
      items: indexes[mode].byId.values(),
      tmdbFor,
      mode,
      passes: (s) => titleLangPasses(s.name) && !variantHidden(s) && !isLQ(s),
    });
    const trailerTiles = [];
    for (const { s, t } of picked) {
      const tile = tileFor(s);
      if (!tile || !isKidSafe(tile)) continue;
      tile.trailer_key = t.trailer_key;
      tile.release_date = t.release_date;
      trailerTiles.push(tile);
    }
    if (trailerTiles.length) {
      rails.push({
        title: "New trailers",
        category_id: "__rail-new-trailers",
        total: trailerTiles.length,
        items: trailerTiles.slice(0, 40),
      });
      if (!req.get("x-khouch-internal")) {
        trailerPrefetch.enqueue(trailerTiles.slice(0, 12).map((x) => ({ key: x.trailer_key, trailerKey: x.trailer_key })));
      }
    }
  }

  // Family — broadly watchable with the 9yo + 12yo (cert up to PG-13),
  // any genre, not just animation. Cert-based (FAMILY_CERTS) so it shows
  // on an adult profile too; unrated excluded. Most-voted first so the
  // recognizable family films lead. `__rail-family` gives it a See-all
  // grid client-side.
  if (mode !== "live") {
    // The panel carries the same film in many categories (4K, FHD,
    // BLOCKBUSTER, CAM…) as separate streams, so dedupe by tmdb_id —
    // otherwise the rail shows "Interstellar" four times. Sort first so
    // the kept copy is the best one: a non-CAM print, then most-voted.
    const seenFamily = new Set();
    const familyTiles = [...indexes[mode].byId.values()]
      .filter((s) => titleLangPasses(s.name) && !variantHidden(s) && !isLQ(s))
      .map((s) => ({ s, t: tmdbFor(s.id) }))
      .filter((x) => x.t && effCert(x.t) && FAMILY_CERTS.has(effCert(x.t)))
      .sort((a, b) => {
        const ca = (a.s.tags || []).includes("cam") ? 1 : 0;
        const cb = (b.s.tags || []).includes("cam") ? 1 : 0;
        if (ca !== cb) return ca - cb;
        return (b.t.vote_count || 0) - (a.t.vote_count || 0);
      })
      .filter((x) => {
        const key = x.t.tmdb_id || x.s.name;
        if (seenFamily.has(key)) return false;
        seenFamily.add(key);
        return true;
      })
      .map((x) => tileFor(x.s))
      .filter((t) => t && isKidSafe(t));
    if (familyTiles.length) {
      const famOrdered = [
        ...jitterOrder(familyTiles.slice(0, 160), seededRng(`fam:${visitSeed}:${req.profileId}:${mode}`), 80),
        ...familyTiles.slice(160),
      ];
      rails.push({
        title: "Family Friendly",
        category_id: "__rail-family",
        total: familyTiles.length,
        items: famOrdered.slice(0, 100),
      });
    }
  }

  // Surround sound — titles with CONFIRMED >= 6 audio channels (panel
  // get_vod_info / learned transcode tracks / Disk ffprobe; never guessed).
  // Movies and the owner's Disk library (each in its own home; series have
  // too little data for a rail, see docs/SURROUND.md). Same language /
  // variant / low-quality / CAM gates as Family, kid profiles get the
  // allow-list (unrated hidden). One tile per tmdb_id, Atmos / 7.1 first
  // then most-voted, lightly shuffled per visit. `__rail-surround` = See all.
  if (mode === "movie" || mode === "disk") {
    const seenSurround = new Set();
    const rank = (s) => (s.audio_badge === "Atmos" ? 2 : s.audio_badge === "7.1" ? 1 : 0);
    const surroundTiles = [...indexes[mode].byId.values()]
      .filter((s) => surroundLib.isSurround(s.audio_channels) && !(s.tags || []).includes("cam")
        && titleLangPasses(s.name) && !variantHidden(s) && !isLQ(s))
      .map((s) => ({ s, t: tmdbFor(s.id) }))
      .sort((a, b) => (rank(b.s) - rank(a.s)) || ((b.t?.vote_count || 0) - (a.t?.vote_count || 0)))
      .filter((x) => {
        const key = x.t?.tmdb_id || x.s.tmdb_id || `n:${String(x.s.name).toLowerCase()}`;
        if (seenSurround.has(key)) return false;
        seenSurround.add(key);
        return true;
      })
      .map((x) => tileFor(x.s))
      .filter((t) => t && isKidSafe(t));
    if (surroundTiles.length >= 4) {
      const ordered = [
        ...jitterOrder(surroundTiles.slice(0, 160), seededRng(`sur:${visitSeed}:${req.profileId}:${mode}`), 60),
        ...surroundTiles.slice(160),
      ];
      rails.push({
        title: "Surround sound",
        category_id: "__rail-surround",
        total: surroundTiles.length,
        items: ordered.slice(0, 100),
      });
    }
  }

  // `category_id` here is a PSEUDO id the web client recognizes — it
  // surfaces a "See all ›" button on the rail header and routes the
  // click into the matching grid view.
  const userRail = (title, pseudoCatId, ids) => {
    const eligible = eligibleFromIds(ids);
    if (!eligible.length) return null;
    return {
      title,
      category_id: pseudoCatId,
      total: eligible.length,
      items: eligible.slice(0, 12),
    };
  };
  const myListRail = userRail("Watch Later",   "__mylist", userState.myList?.[mode]);
  const favsRail   = userRail("Favorites", "__favs",   userState.favorites?.[mode]);
  if (myListRail) rails.push(myListRail);
  if (favsRail)   rails.push(favsRail);

  // Editorial rails — AI-proposed themed rails (weekly, household-level,
  // rebuildEditorialRails). Each pick is re-gated per viewing profile
  // exactly like For You; a rail with < 4 survivors is hidden. Only
  // movie/series carry editorial rails (the builder runs per those id
  // spaces), so live/disk skip this naturally. Like Tonight, these are
  // OWNER-GLOBAL (owner panel id space) — render only for the owner
  // account so member panels don't get owner ids mis-mapped onto them.
  // `seenEdTmdb` spans all editorial rails so one title can't repeat
  // across two of them.
  if (isOwnerAccount(currentAccount())) {
    const seenEdTmdb = new Set();
    for (const er of (editorialRails.rails || [])) {
      if (er.mode !== mode) continue;
      const edTiles = (er.picks || [])
        .map((id) => variantHidden.resolve(ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10))))
        .filter((s) => s && titleLangPasses(s.name) && !isLQ(s))
        .filter((s) => {
          const key = s.tmdb_id || `id:${s.id}`;
          if (seenEdTmdb.has(key)) return false;
          seenEdTmdb.add(key);
          return true;
        })
        .map((s) => tileFor(s, null))
        .filter((t) => t && !isKidBlocked(t));
      if (edTiles.length >= 4) {
        rails.push({
          title: er.title,
          blurb: er.blurb || null,
          total: edTiles.length,
          items: jitterOrder(edTiles, seededRng(`ed:${visitSeed}:${req.profileId}:${er.title}`), 30).slice(0, 20),
        });
      }
    }
  }

  // ── Smart (TMDB-derived) rails ─────────────────────────────────────
  // Replaces the panel's gunky category soup ("INDIAN MOVIES HINDI
  // OLD 80'S") with a curated, Netflix-style mix sourced from the
  // tmdbCache we already populate for posters / metadata: by genre,
  // by decade, by quality bucket. Items that survive the kid + title-
  // language gates AND have a TMDB hit go into the candidate pool.
  // Rails with fewer than `minRail` items are skipped so the home
  // doesn't render half-empty rows on small / niche slices.
  //
  // Each item gets surfaced in exactly ONE smart rail (highest-
  // priority one wins, see surfacedIds) so the home doesn't feel
  // repetitive. The panel-category rails below the smart block still
  // include everything regardless — that's where items without TMDB
  // data ultimately land, and where users who *want* to browse by
  // panel taxonomy can still do so.
  if (mode !== "live") {
    const smartStart = rails.length;
    // This profile's own plays with timestamps, newest first. The play
    // timestamps live in the household-level lastPlayed store (profile
    // state has none); intersect with the profile's recents/progress so
    // another member's titles never name a rail on this profile (kids).
    const myPlays = (() => {
      if (mode === "series") {
        // Series timestamps are keyed by EPISODE id and progress keys are episode ids,
        // so use the profile's recents (show ids, newest first) as the history.
        return (userState.recents?.series || []).map((id) => [String(id), 0]);
      }
      const mine = new Set((userState.recents?.[mode] || []).map(String));
      for (const k of Object.keys(userState.progress || {})) {
        if (k.startsWith(mode + ":")) mine.add(k.split(":", 2)[1]);
      }
      return Object.entries(getLastPlayedFor(currentAccount())[mode] || {})
        .filter(([id]) => mine.has(String(id)))
        .sort((x, y) => y[1] - x[1]);
    })();
    const tmdbBy = (s) => tmdbFor(s.id);
    // Build the pool, deduplicating by tmdb_id so a movie that the
    // panel ships in 5 quality / language / dub variants doesn't take
    // 5 tiles in every smart rail. First eligible variant wins —
    // panel ordering is stable enough that the "primary" listing
    // tends to land first. Items without tmdb_id are skipped entirely
    // (the smart rails are TMDB-driven).
    // The pool depends only on the catalog, the TMDB cache and this profile's
    // language/kid gates — not on the request — so cache it per gate signature
    // (rebuilding it dominated /api/home: ~44k tileFor calls per request).
    const cachedPool = smartPoolCache.get(gateSig);
    let pool, poolV, poolR;
    if (ix.ready && cachedPool && cachedPool.byId === ix.byId && cachedPool.gen === catalogGen && Date.now() - cachedPool.at < 8 * 60 * 1000) {
      pool = cachedPool.pool; poolV = cachedPool.byVotes; poolR = cachedPool.byRating;
    } else {
      pool = [];
      const seenTmdb = new Set();
      for (const s of ix.byId.values()) {
        if (!titleLangPasses(s.name)) continue;
        if (variantHidden(s) || isLQ(s)) continue;
        const t = tmdbBy(s);
        if (!t || t.source === "no-match") continue;
        if (t.tmdb_id) {
          if (seenTmdb.has(t.tmdb_id)) continue;
          seenTmdb.add(t.tmdb_id);
        }
        // Reuse tileFor for the kid-cert + soft-NR logic. catName is
        // null because these tiles came from the smart pool, not a
        // specific panel category.
        const tile = tileFor(s, null);
        if (!tile) continue;
        if (isKidBlocked(tile)) continue;
        pool.push({ s, t, tile });
      }
      for (const p of pool) p.tvm = Array.isArray(p.t.genres) && p.t.genres.includes("TV Movie");
      // Pre-sorted views, so rails filter an already-ordered list instead of sorting 10-20k items each.
      const byVotes = [...pool].sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0));
      const byRating = [...pool].sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0));
      if (ix.ready) putHomeCache(smartPoolCache, gateSig, { byId: ix.byId, pool, byVotes, byRating });
      poolV = byVotes; poolR = byRating;
    }
    // TV Movie is a TMDB genre that lumps in straight-to-streaming
    // / made-for-cable productions, which would crowd out theatrical
    // titles on every genre rail if left in. Drop them from the
    // discovery layer entirely; they still surface via panel rails.
    const notTvMovie = (p) => !p.tvm;

    const surfacedIds = new Set();
    // RAIL_CAP caps the items emitted in the rail payload to keep the
    // home response small. Smart rails do NOT expose a "See all" link
    // (they have no category_id; clientside renderRail hides the
    // affordance), so reporting the eligible-pool size lets the user
    // know how deep a genre actually goes — "Action · 2302" tells them
    // there's a lot to search through, even though the rail only
    // surfaces the top 100.
    const RAIL_CAP = 100;
    const MIN_RAIL = 15;
    const railSeed = `rails:${visitSeed}:${req.profileId}:${mode}`;
    const addRail = (title, items, { jitter = true } = {}) => {
      const eligible = items.filter(p => !surfacedIds.has(p.s.id));
      if (eligible.length < MIN_RAIL) return;
      // Soft-shuffle quality-sorted rails so the leading titles rotate;
      // ordered rails (franchise by year, TMDB-ranked recs) opt out.
      const ordered = jitter
        ? [...jitterOrder(eligible.slice(0, RAIL_CAP + 60), seededRng(`${railSeed}:${title}`), 60), ...eligible.slice(RAIL_CAP + 60)]
        : eligible;
      const filtered = ordered.slice(0, RAIL_CAP);
      for (const p of filtered) surfacedIds.add(p.s.id);
      rails.push({
        title,
        total: eligible.length,
        items: filtered.map(p => p.tile),
      });
    };

    // Most popular this year — current year by vote_count
    // (popularity isn't in the cache; vote_count is the closest
    // proxy and TMDB scrapes both from the same engagement signal).
    const thisYear = String(new Date().getFullYear());
    addRail(
      `New on Khouch · ${thisYear}`,
      poolV
        .filter(p => p.t.year === thisYear)
        .filter(notTvMovie),
    );

    // Critically acclaimed — high rating, real audience size
    addRail(
      "Critically Acclaimed",
      poolR
        .filter(p => (p.t.rating || 0) >= 7.5 && (p.t.vote_count || 0) >= 500)
        .filter(notTvMovie),
    );

    // Per-genre rails. Order is rough "broad → niche" so the most
    // crowd-pleasing genres land highest on the home. Each title only
    // gets used once across smart rails, so a film tagged Action +
    // Thriller goes into Action (which comes first) and not both.
    for (const g of ["Action", "Comedy", "Drama", "Thriller", "Horror",
                     "Romance", "Science Fiction", "Animation", "Family",
                     "Documentary"]) {
      addRail(g, poolV
        .filter(p => Array.isArray(p.t.genres) && p.t.genres.includes(g))
        .filter(notTvMovie));
    }

    // Decade flashbacks — only the most distinctive decades show.
    // Skip 2020s because "New on Khouch" already pulls from there.
    for (const [start, title] of [
      [2010, "Of the 2010s"],
      [1990, "Of the 90s"],
      [1980, "Of the 80s"],
    ]) {
      addRail(title, pool
        .filter(p => {
          const y = parseInt(p.t.year, 10);
          return y >= start && y < start + 10;
        })
        .filter(notTvMovie)
        .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0)));
    }

    // "Because you watched <title>" — pulls TMDB's recommendations
    // list for the user's most recent play in this mode and surfaces
    // only the items that exist in our catalog. The personalized rail
    // sits high in the smart block because intent-matched
    // recommendations are higher-signal than any genre slice.
    // Up to 3 most recent distinct plays, newest first — one "Because
    // you watched" rail each, so the block refreshes after every watch.
    const lastPlayIds = myPlays.slice(0, 3)
      .map(([k]) => parseInt(k, 10))
      .filter(Number.isFinite);
    for (const lastPlayId of lastPlayIds) {
      const lpEntry = tmdbFor(lastPlayId);
      const recIds = lpEntry && Array.isArray(lpEntry.recommendations) ? lpEntry.recommendations : [];
      if (recIds.length) {
        const recSet = new Set(recIds);
        const recItems = pool
          .filter(p => recSet.has(p.t.tmdb_id))
          .filter(notTvMovie)
          // Preserve TMDB's recommended order (which is itself rough
          // popularity-weighted).
          .sort((a, b) => recIds.indexOf(a.t.tmdb_id) - recIds.indexOf(b.t.tmdb_id));
        const refName = ix.byId.get(lastPlayId)?.name || lpEntry?.tmdb_title || "what you watched";
        const refClean = lpEntry?.tmdb_title || refName.replace(/\s*\(.*$/, "").trim();
        addRail(`Because you watched ${refClean}`, recItems, { jitter: false });
      }
    }

    // Franchise rails. TMDB's belongs_to_collection groups items
    // into sagas (MCU, Bond, MI, John Wick, Harry Potter, etc.). We
    // surface a rail per collection that has at least 3 items in
    // the catalog. The collections are ranked by total catalog size
    // so a household with most MCU films sees MCU near the top, but
    // a household with just two Bond films won't get a half-empty
    // "Bond" rail.
    const collMap = new Map(); // id -> { name, items: [] }
    for (const p of pool) {
      const col = p.t.collection;
      if (!col || !col.name) continue;
      if (!collMap.has(col.id)) collMap.set(col.id, { name: col.name, items: [] });
      collMap.get(col.id).items.push(p);
    }
    const ranked = [...collMap.values()]
      .filter(c => c.items.length >= 3)
      .sort((a, b) => b.items.length - a.items.length)
      .slice(0, 6);  // cap so they don't dominate the home
    for (const c of ranked) {
      // Sort within the franchise by year ascending — feels right
      // for sagas (Bond 1, Bond 2, ...). Year is a string in the
      // cache so compare via parseInt with a safe fallback.
      c.items.sort((a, b) => (parseInt(a.t.year, 10) || 0) - (parseInt(b.t.year, 10) || 0));
      addRail(c.name, c.items, { jitter: false });
    }

    // Taste-driven people rails (movies and series — creators count as
    // "directors" for TV): the director/creator and the actor the profile's
    // recent plays share most. No AI, rebuilt every request.
    {
      const recentIds = myPlays.slice(0, 25).map(([k]) => parseInt(k, 10)).filter(Number.isFinite);
      const watchedSet = new Set(recentIds);
      const watchedTmdb = new Set(recentIds.map(id => tmdbFor(id)?.tmdb_id).filter(Boolean));
      const dirCount = new Map(), actCount = new Map();
      for (const id of recentIds) {
        const t = tmdbFor(id);
        if (!t) continue;
        for (const d of (t.directors || []).slice(0, 2)) dirCount.set(d, (dirCount.get(d) || 0) + 1);
        for (const a of (t.cast || []).slice(0, 3)) if (a?.name) actCount.set(a.name, (actCount.get(a.name) || 0) + 1);
      }
      const top = (m, min) => [...m.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1])[0]?.[0];
      const dirName = top(dirCount, 1);
      const actName = top(actCount, 2);
      const peopleRail = (title, test) => {
        const items = poolR
          .filter(p => !watchedSet.has(p.s.id) && !watchedTmdb.has(p.t.tmdb_id) && (p.t.vote_count || 0) >= 100 && test(p.t))
          .filter(notTvMovie);
        if (items.length < 4) return;
        rails.push({ title, total: items.length, items: items.slice(0, 40).map(p => p.tile) });
      };
      if (dirName) peopleRail(`More from ${dirName}`, t => (t.directors || []).includes(dirName));
      if (actName && actName !== dirName) {
        peopleRail(`Starring ${actName}`, t => (t.cast || []).slice(0, 6).some(a => a?.name === actName));
      }
    }
    if (mode === "movie") {
      // Runtime-shaped rails (movies only) — the daypart weights below decide
      // which one leads (weeknights: quick; weekends: epics).
      addRail("Quick watch · under 100 min", poolV
        .filter(p => p.t.runtime >= 70 && p.t.runtime <= 100 && (p.t.rating || 0) >= 6.3 && (p.t.vote_count || 0) >= 300)
        .filter(notTvMovie));
      addRail("Weekend epics · 2.5h+", poolV
        .filter(p => p.t.runtime >= 150 && (p.t.rating || 0) >= 7 && (p.t.vote_count || 0) >= 500)
        .filter(notTvMovie));
    }

    // Long-tail discovery — high-quality stuff most people haven't
    // heard of (low vote_count). Built last; the smart-block shuffle
    // below may move it.
    addRail("Hidden Gems", poolR
      .filter(p => (p.t.rating || 0) >= 7 && (p.t.vote_count || 0) >= 50 && (p.t.vote_count || 0) < 500)
      .filter(notTvMovie));

    // Mood / occasion rails — deterministic rules over cached TMDB data (genres,
    // keywords, rating, votes, runtime, cert). Overlap with genre rails on
    // purpose, so they bypass surfacedIds. Three per visit, biased by daypart.
    {
      const has = (p, ...g) => g.some((x) => (p.t.genres || []).includes(x));
      const kw = (p, ...k) => (p.t.keywords || []).some((w) => k.some((x) => String(w).toLowerCase().includes(x)));
      const good = (p, r, v) => (p.t.rating || 0) >= r && (p.t.vote_count || 0) >= v;
      const MOODS = mode === "movie" ? [
        { title: "Family movie night", dp: "weekend", test: (p) => has(p, "Family", "Animation") && ["G", "PG"].includes(effCert(p.t)) && good(p, 6.5, 800) },
        { title: "Date night", dp: "late", test: (p) => has(p, "Romance") && !has(p, "Horror") && good(p, 6.5, 800) },
        { title: "On the edge of your seat", dp: "late", test: (p) => has(p, "Thriller", "Mystery") && !has(p, "Family") && good(p, 6.8, 1500) },
        { title: "Feel-good and funny", dp: "weeknight", test: (p) => has(p, "Comedy") && !has(p, "Horror", "Crime") && good(p, 6.8, 1000) },
        { title: "Mind-bending", dp: "late", test: (p) => (kw(p, "plot twist", "time travel", "dystopia", "alternate reality", "parallel world", "mind-bending", "mind bending") || (has(p, "Science Fiction") && has(p, "Mystery"))) && good(p, 7, 1500) },
        { title: "Based on a true story", dp: "weeknight", test: (p) => kw(p, "true story", "biography", "based on real") && good(p, 6.8, 800) },
        { title: "Big, epic and award-worthy", dp: "weekend", test: (p) => p.t.runtime >= 140 && good(p, 7.5, 3000) },
        { title: "Bollywood blockbusters", dp: "weekend", test: (p) => p.t.original_language === "hi" && good(p, 6.5, 300) },
        { title: "Punjabi hits", dp: "weekend", test: (p) => p.t.original_language === "pa" && good(p, 5.5, 20) },
      ] : [
        { title: "Binge-worthy", dp: "weekend", test: (p) => good(p, 8.0, 1500) },
        { title: "Crime and mystery", dp: "late", test: (p) => has(p, "Crime", "Mystery") && good(p, 7.3, 800) },
        { title: "Comedy series", dp: "weeknight", test: (p) => has(p, "Comedy") && !has(p, "Animation") && good(p, 7.3, 600) },
        { title: "For the whole family", dp: "weekend", test: (p) => has(p, "Family", "Kids") && ["TV-G", "TV-PG", "TV-Y", "TV-Y7"].includes(effCert(p.t)) && good(p, 7, 300) },
        { title: "Indian shows people love", dp: "weeknight", test: (p) => ["hi", "pa"].includes(p.t.original_language) && good(p, 6.8, 40) },
      ];
      const dpNow = currentDaypart();
      const moodRng = seededRng(`mood:${visitSeed}:${req.profileId}:${mode}`);
      const isKidProfile = allowedKidCerts !== null;
      const hasAtLeast = (test, n) => { let c = 0; for (const p of pool) { if (notTvMovie(p) && test(p) && ++c >= n) return true; } return false; };
      const eligible = MOODS
        .filter((m) => !(isKidProfile && ["Date night", "On the edge of your seat"].includes(m.title)))
        .filter((m) => !rails.some((r) => r.title === m.title))
        .filter((m) => hasAtLeast(m.test, 10));
      const ranked = eligible
        .map((m, i) => ({ m, k: i + moodRng() * 6 - (m.dp === dpNow ? 3 : 0) }))
        .sort((x, y) => x.k - y.k).slice(0, 3);
      for (const { m } of ranked) {
        const items = poolV.filter(notTvMovie).filter((p) => m.test(p)).slice(0, 80);
        const jittered = jitterOrder(items, seededRng(`mood-items:${visitSeed}:${req.profileId}:${m.title}`), 30);
        rails.push({ title: m.title, total: Math.min(items.length, 40), items: jittered.slice(0, 40).map((p) => p.tile) });
      }
    }

    // Reorder the smart block: personal rails (new releases, because-you-
    // watched, people rails) stay up front; the rest are shuffled with a
    // seeded soft jitter, biased by time of day (late = thrillers/horror,
    // weekend = family/epics, weeknight = comedy/drama/quick watches).
    const smart = rails.splice(smartStart);
    const dpW = {
      late: { Horror: 3, Thriller: 3, Comedy: 2, "Science Fiction": 1 },
      weekend: { Family: 3, Animation: 3, Action: 2, Documentary: 1, "Weekend epics": 4 },
      weeknight: { Comedy: 2, Drama: 2, Documentary: 1, "Quick watch": 4 },
    }[currentDaypart()] || {};
    const pinned = (t) => /^(New on Khouch|Because you watched|More from|Starring) /.test(t + " ");
    const wOf = (t) => Object.entries(dpW).find(([k]) => t === k || t.startsWith(k + " "))?.[1] || 0;
    const orderRng = seededRng(`smart:${visitSeed}:${req.profileId}:${mode}`);
    const front = smart.filter(r => pinned(r.title));
    const rest = smart.filter(r => !pinned(r.title))
      .map((r, i) => ({ r, k: i + orderRng() * 12 - wOf(r.title) * 5 }))
      .sort((a, b) => a.k - b.k).map(o => o.r);
    rails.push(...front, ...rest);
  }

  // Per-category rails. Order: categories the profile actually plays
  // from first (by play count), then the rest in a seeded soft shuffle
  // (VOD) or panel order (live), with CAM / screener categories last.
  const catAffinity = new Map();
  {
    const bump = (id) => {
      const it = ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10));
      if (it?.category_id != null) {
        const k = String(it.category_id);
        catAffinity.set(k, (catAffinity.get(k) || 0) + 1);
      }
    };
    (userState.recents?.[mode] || []).forEach(bump);
    (userState.favorites?.[mode] || []).forEach(bump);
    for (const k of Object.keys(userState.progress || {})) {
      if (k.startsWith(mode + ":")) bump(k.split(":", 2)[1]);
    }
  }
  const catRails = [];
  for (const c of cats) {
    const items = byCat.get(String(c.category_id));
    if (!items?.length) continue;
    catRails.push({
      title: c.category_name,
      // category_id lets the Android / phone clients open a "See all"
      // view for that rail. The web client doesn't use this — it has
      // the full index in memory and navigates via its own routing.
      category_id: String(c.category_id),
      total: bucketTotals.get(String(c.category_id)) || items.length,
      items: items.map(s => tileFor(s, c.category_name)),
    });
  }
  {
    const catRng = seededRng(`catorder:${visitSeed}:${req.profileId}:${mode}`);
    const isCam = (t) => /\bCAM\b/i.test(t || "");
    const scored = catRails.map((r, i) => ({
      r,
      aff: catAffinity.get(r.category_id) || 0,
      cam: isCam(r.title),
      k: mode === "live" ? i : i + catRng() * 25,
    }));
    scored.sort((a, b) => (a.cam - b.cam) || (b.aff - a.aff) || (a.k - b.k));
    for (const o of scored) rails.push(o.r);
  }

  // Adult-content filter for the hero. Independent of the kids-cert
  // logic (which is per-profile and only fires on kid profiles). The
  // hero is the most prominent, auto-rotating placement on the home
  // screen — we don't want an Indian "Bigg Boss XXX 18+" channel or
  // a TMDB-rated NC-17 title popping up there for any household
  // member, regardless of profile. Three signals:
  //  1. us_cert = NC-17 or TV-MA  (R is allowed — many mainstream
  //     films are R but suitable for hero placement)
  //  2. title contains an explicit adult keyword
  //  3. category name contains an explicit adult keyword
  const HERO_ADULT_CERTS = new Set(["NC-17", "TV-MA"]);
  const HERO_ADULT_RE = /\b(?:adult|xxx|porn|porno|erotic|18\+|nsfw|hentai|playboy|hustler|brazzers|naked|nude|sex|onlyfans|fetish|kink|swingers?)\b/i;
  const catNameById = new Map(cats.map(c => [String(c.category_id), c.category_name || ""]));
  const isAdultForHero = (s) => {
    const cert = effCert(tmdbFor(s.id)) || s.us_cert;
    if (cert && HERO_ADULT_CERTS.has(cert)) return true;
    if (s.name && HERO_ADULT_RE.test(s.name)) return true;
    const cn = catNameById.get(String(s.category_id)) || "";
    if (cn && HERO_ADULT_RE.test(cn)) return true;
    return false;
  };

  // Hero pool — *discovery* only. Continue-Watching items are
  // deliberately excluded: the resume CTA on the user's currently-
  // playing title was eating every hero slot, so for weeks the hero
  // was the same handful of in-progress movies. The Continue
  // Watching rail still surfaces them; the hero is for "what's
  // new I haven't tried yet".
  //
  // Skim up to 5 items per filtered category — EVERY eligible category,
  // not just the first ones walked — then shuffle the whole thing with
  // a per-day, per-profile, per-mode seed. Same all day so caching/
  // intra-day re-renders are stable; different next day, and different
  // across members of the same household.
  //
  // A prior version capped the total pool at 40 and broke out of the
  // category walk as soon as it filled — since `byCat` iterates in a
  // fixed category order, that meant only the first ~8 categories ever
  // contributed a single candidate, and the same few dozen titles from
  // those categories rotated forever while every other category (often
  // the bulk of the catalog) never got a chance. Skimming everything
  // first and shuffling after fixes that; the per-category cap of 5
  // still keeps any one huge category from dominating the pool.
  const seen = new Set();
  // Exclude in-progress titles from candidates so they never sneak
  // back in via the category skim.
  if (mode !== "live") {
    for (const k of Object.keys(userState.progress || {})) {
      if (!k.startsWith(mode + ":")) continue;
      seen.add(parseInt(k.split(":", 2)[1], 10));
    }
  }
  // Dedup by tmdb_id too, not just stream id — the same film is often
  // cross-listed under several categories with different stream ids
  // ("Action", "New Releases", "2024 Movies"), and now that every
  // category gets a chance to contribute, a cross-listed film would
  // otherwise land in the pool once per category and unfairly dominate
  // the shuffle. Mirrors the seenTmdb pattern rails already use above.
  const seenTmdb = new Set();
  const seenTitle = new Set();
  const heroPool = [];
  for (const items of byCat.values()) {
    for (const s of items.slice(0, 5)) {
      if (seen.has(s.id) || !s.icon) continue;
      const titleKey = dedupKeyOf(s);
      if (titleKey && seenTitle.has(titleKey)) continue;
      if (s.tmdb_id && seenTmdb.has(s.tmdb_id)) continue;
      if (isAdultForHero(s)) { seen.add(s.id); continue; }
      if (isLQ(s)) continue;
      heroPool.push(s); seen.add(s.id);
      if (titleKey) seenTitle.add(titleKey);
      if (s.tmdb_id) seenTmdb.add(s.tmdb_id);
    }
  }
  // Seed = today's date + active profile id + mode. Mulberry32 is
  // a small fast PRNG, deterministic from the seed.
  const daySeed = (() => {
    const now = new Date();
    return `${visitSeed}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}:${req.profileId || "p1"}:${mode}`;
  })();
  let seedState = 0;
  for (const c of daySeed) seedState = (seedState * 31 + c.charCodeAt(0)) | 0;
  const rng = () => {
    seedState |= 0;
    seedState = (seedState + 0x6D2B79F5) | 0;
    let t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = heroPool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [heroPool[i], heroPool[j]] = [heroPool[j], heroPool[i]];
  }
  const hero = heroPool
    .map(heroFor)
    .filter(h => h && !HERO_ADULT_CERTS.has(h.us_cert) && !HERO_ADULT_RE.test(h.name || ""))
    .filter(isKidSafe)
    .slice(0, 8);
  // Warm the hero's trailers so its muted previews are ready (background,
  // one at a time, yields while anyone is streaming).
  if (mode !== "live" && !req.get("x-khouch-internal")) {
    try { trailerPrefetch.enqueue(hero.filter((h) => h.trailer_key).slice(0, 4).map((h) => ({ key: h.trailer_key, trailerKey: h.trailer_key }))); } catch {}
  }

  // Active chip list for this profile + mode. Walk every tile in the
  // built rails, collect their tags, then intersect with the master
  // chip catalog (filterConfig groups + synthetic 4k/movies) so the
  // client only renders chips that can actually narrow the result
  // set. Without this, Vir's Series tab would surface chips like
  // "Tamil" even though his rails have no Tamil items.
  const tagsPresent = new Set();
  for (const r of rails) {
    for (const it of r.items) {
      if (Array.isArray(it.tags)) for (const t of it.tags) tagsPresent.add(t);
    }
  }
  // Language chips are gated by the user's onboarded language set.
  // Without this, a single mis-tagged item could surface "Tamil" on
  // a profile that never picked Tamil — `titleLangPasses` blocks
  // names that *contain* the word, but item tags can carry the
  // language via category-name regex or XX:-prefix even when the
  // visible name doesn't, leaving Tamil in `tagsPresent`.
  const onboardedSet = new Set(modeKeys);
  const chips = [];
  for (const [key, label] of [["4k", "4K"], ["surround", "Surround"], ["movies", "Movies"]]) {
    if (tagsPresent.has(key)) chips.push({ key, label, kind: "synthetic" });
  }
  for (const g of CHANNEL_GROUPS) {
    if (!tagsPresent.has(g.key)) continue;
    const kind = CHIP_KINDS[g.key] || "other";
    if (kind === "language" && !onboardedSet.has(g.key)) continue;
    chips.push({
      key:   g.key,
      label: CHIP_LABELS[g.key] || g.key,
      kind,
    });
  }

  // Universal "See all ›" support: every rail without an explicit
  // category_id (panel category id or a known PSEUDO.* string) gets a
  // synthesized one based on its title. The web client knows how to
  // handle the `__rail-<slug>` prefix — it renders a grid view sourced
  // from the rail's items as-emitted. Without this, smart rails ("New
  // on Khouch · 2026", "Action", "Hidden Gems", "Recently Added") have
  // no navigable "See all" target.
  //
  // The prefix is hyphen-separated (not colon-separated) so it
  // round-trips cleanly through a URL path. iOS Safari interprets a
  // colon inside a path segment as the start of an authority and bails
  // out of pushState restoration, which surfaced as a blank-grid bug
  // on real mobile devices.
  for (const r of rails) {
    if (r.category_id) continue;
    const slug = String(r.title || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) r.category_id = `__rail-${slug}`;
  }

  // Warm the detail-info cache for what the user is most likely to open:
  // hero first, then the leading rails' first items. Fire-and-forget.
  try {
    if (mode === "movie" || mode === "series") {
      const lead = [];
      for (const h of hero) if (!h.isSeriesGroup) lead.push(h.id);
      for (const r of rails.slice(0, 6)) {
        for (const it of (r.items || []).slice(0, 4)) if (!it.isSeriesGroup) lead.push(it.id);
      }
      prewarmDetails(mode, lead, req.account || currentAccount(), 8);
    }
  } catch {}

  // Movie tiles shown without audio info jump the surround crawl queue.
  if (mode === "movie" && !req.get("x-khouch-internal")) {
    try { boostSurroundCrawl(rails.flatMap((r) => (r.items || []).slice(0, 24))); } catch {}
  }

  // Collections row (additive top-level field: older clients ignore it).
  // Tiles here are COLLECTIONS, not titles: open /api/collections/:id.
  let collections;
  if (mode === "movie") {
    try { collections = collectionsRailFor(req, 30); } catch (e) { console.warn(`[home] collections: ${e.message}`); }
  }

  res.json({
    mode,
    ready: ix.ready,
    rails,
    hero,
    chips,
    collections,
  });
});

// Single-language "collection" — a dedicated browse surface for one
// language (e.g. Hindi), organized into year + genre rails. Unlike
// /api/home it ignores the profile's onboarding language filter (the
// whole point is to dive into ONE language regardless of what the
// profile onboarded), but it still honors the active profile's kid-cert
// gate and excludes CAM / screener rips by default. `lang` is a
// LANGUAGE_GROUP_KEYS key. Response shape mirrors /api/home's rails so
// clients reuse the same rail renderer.
app.get("/api/collection/:lang/:mode(movie|series)", (req, res) => {
  res.set("Cache-Control", "no-store");
  const lang = String(req.params.lang || "").toLowerCase();
  const mode = req.params.mode;
  const ix = indexes[mode];
  if (!ix) return res.status(404).json({ error: "unknown mode" });
  if (!LANGUAGE_GROUP_KEYS_SET.has(lang)) {
    return res.status(404).json({ error: "unknown language", lang });
  }

  const activeProfile = findProfile(req.profileId);
  const kidsAge = (() => {
    const by = activeProfile?.kidsBirthYear;
    if (!by) return null;
    const age = new Date().getFullYear() - by;
    return Number.isFinite(age) ? age : null;
  })();
  const allowedKidCerts = kidsAge === null ? null : (() => {
    const s = new Set();
    for (const tier of KIDS_CERT_TIERS) if (kidsAge >= tier.minAge) tier.add.forEach(c => s.add(c));
    return s;
  })();
  const isKidSafe = (tile) =>
    allowedKidCerts === null ? true : (!!tile.us_cert && allowedKidCerts.has(tile.us_cert));
  const isKidBlocked = makeKidsBlocker(activeProfile);
  const tmdbFor = (id) => tmdbCache[`${mode}:${id}`];
  const tileFor = (s) => {
    if (!s) return null;
    const t = tmdbFor(s.id);
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      year: s.year || null,
      poster: tilePoster(mode, s, t),
      us_cert: effCert(t) || null,
      tags: s.tags || ["other"],
      container: s.container || null,
      ...audioTileFields(s),
    };
  };

  // Candidate pool: in-language, not CAM, passes the profile's kid gate.
  // Title-language guard: generic "INDIAN" categories get the regional-
  // default `hindi` tag even when they hold Kannada / Tamil / Marathi /
  // Bangla titles, so a tag match alone leaks other-language titles into
  // the Hindi view. Drop items whose title explicitly names a language
  // other than the collection's — same guard /api/home applies to rails.
  const titleLangPasses = makeTitleLangFilter(new Set([lang]));
  const pool = [];
  for (const s of ix.byId.values()) {
    const tags = Array.isArray(s.tags) ? s.tags : [];
    if (!tags.includes(lang)) continue;
    if (tags.includes("cam")) continue;
    if (!titleLangPasses(s.name)) continue;
    const tile = tileFor(s);
    if (!tile || isKidBlocked(tile) || !isKidSafe(tile)) continue;
    pool.push({ s, t: tmdbFor(s.id), tile });
  }

  const addedOf = (p) => parseInt(p.s.added, 10) || 0;
  const byAddedDesc = (a, b) => addedOf(b) - addedOf(a);
  // Prefer the TMDB-cache year (authoritative for movies, whose base
  // index entry often has no year — only series carry s.year); fall back
  // to the panel year for items TMDB hasn't matched.
  const yearOf = (p) => parseInt(p.t?.year || p.s.year, 10);
  const rails = [];
  const pushRail = (title, list, min) => {
    if (list.length < min) return;
    rails.push({ title, total: list.length, items: list.slice(0, 100).map(p => p.tile) });
  };

  // 1. New this week — newest panel additions in this language.
  const cutoff = Math.floor((Date.now() - RECENTLY_ADDED_DAYS * 86400000) / 1000);
  pushRail("New This Week", pool.filter(p => addedOf(p) >= cutoff).sort(byAddedDesc), 1);

  // 2. 4K (verified — the 4k tag is resolution-checked).
  pushRail("4K", pool.filter(p => (p.s.tags || []).includes("4k")).sort(byAddedDesc), 1);

  // 2b. Family Friendly — up to PG-13, any genre (matches the home rail).
  //     Most-voted first; unrated excluded (pool tiles carry us_cert).
  //     Dedupe by tmdb_id (pool isn't deduped — same film recurs across
  //     categories; pool already drops CAM prints).
  const seenFamily = new Set();
  pushRail("Family Friendly",
    pool.filter(p => p.tile.us_cert && FAMILY_CERTS.has(p.tile.us_cert))
      .sort((a, b) => (b.t?.vote_count || 0) - (a.t?.vote_count || 0))
      .filter(p => {
        const key = p.t?.tmdb_id || p.s.name;
        if (seenFamily.has(key)) return false;
        seenFamily.add(key);
        return true;
      }), 1);

  // 3. Year rails — the 5 most-recent years each get a rail; the rest
  //    fall into "Older" below. Years partition naturally (a title has
  //    one year) so these don't dedupe against each other or genres.
  const byYear = new Map();
  for (const p of pool) {
    const y = yearOf(p);
    if (!Number.isFinite(y) || y < 1920 || y > 2100) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(p);
  }
  const currentYear = new Date().getFullYear();
  for (const y of [...byYear.keys()].sort((a, b) => b - a)) {
    if (y < currentYear - 4) continue;
    pushRail(String(y), byYear.get(y).sort(byAddedDesc), 4);
  }

  // 4. Genre rails — from TMDB genres. Deduped within the genre block so
  //    a film lands in just one genre rail (not Action AND Thriller), but
  //    NOT against the year/older rails — same title can show under both
  //    "2025" and "Action". Broad → niche order.
  const genreSeen = new Set();
  for (const g of ["Action", "Comedy", "Drama", "Thriller", "Romance",
                   "Crime", "Adventure", "Family", "Horror",
                   "Science Fiction", "Mystery", "Animation", "Documentary"]) {
    const list = pool
      .filter(p => !genreSeen.has(p.s.id))
      .filter(p => p.t && Array.isArray(p.t.genres) && p.t.genres.includes(g))
      .sort((a, b) => (b.t?.vote_count || 0) - (a.t?.vote_count || 0));
    if (list.length < 6) continue;
    for (const p of list.slice(0, 100)) genreSeen.add(p.s.id);
    rails.push({ title: g, total: list.length, items: list.slice(0, 100).map(p => p.tile) });
  }

  // 5. Older — back catalog older than the per-year rails, newest first.
  pushRail("Older",
    pool.filter(p => {
      const y = yearOf(p);
      return !Number.isFinite(y) || y < currentYear - 4;
    }).sort(byAddedDesc), 1);

  res.json({ lang, mode, ready: ix.ready, rails });
});

// Records a play event. The frontend hits this when starting playback so the
// "last played" timestamp is shared across browsers / devices.
app.post("/api/play-event/:mode(live|movie|series|disk)/:id", express.json(), (req, res) => {
  recordLastPlayed(req.params.mode, req.params.id);
  const lp = getLastPlayedFor(currentAccount());
  res.json({ ok: true, ts: lp[req.params.mode][String(req.params.id)] });
});

// Saves playback position for a movie or series episode so playback can
// resume on the same or a different device. Live is excluded — its
// position has no meaning in a sliding-window stream. Position near the
// start (< 30s) or near the end (within 30s or past 95%) deletes the
// entry: nothing useful to resume to.
// Phone downloads v2 (see the block above the signed file route).
app.post("/api/download/prepare/:mode(movie|series)/:id", (req, res) => {
  const id = String(req.params.id);
  if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: "bad id" });
  res.json(ensureDownloadJob(req.params.mode, id, currentAccount(), req.profileId));
});
app.get("/api/download/status/:mode(movie|series)/:id", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(dlView(req.params.mode, String(req.params.id)));
});
// "Download for the trip": enqueue up to DL_BATCH_MAX titles at once. Items over
// the per-profile/global caps wait in a pending list and are promoted as jobs
// finish, instead of failing with "too many".
app.post("/api/download/prepare-batch", express.json(), (req, res) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > DL_BATCH_MAX) {
    return res.status(400).json({ error: `items must be an array of 1-${DL_BATCH_MAX}` });
  }
  const parsed = [];
  for (const it of items) {
    const mode = it && it.mode, id = it && it.id != null ? String(it.id) : "";
    if ((mode !== "movie" && mode !== "series") || !DL_ID_RE.test(id)) return res.status(400).json({ error: "bad item" });
    parsed.push({ mode, id });
  }
  const actx = currentAccount();
  const out = parsed.map(({ mode, id }) => ({ mode, id, ...ensureDownloadJob(mode, id, actx, req.profileId, true) }));
  res.json({ items: out });
});
app.get("/api/download/queue", (req, res) => {
  res.set("Cache-Control", "no-store");
  const items = [];
  for (const j of dlJobs.values()) {
    if (j.profileId === req.profileId) items.push({ mode: j.mode, id: j.id, ...dlView(j.mode, j.id) });
  }
  for (const p of dlPending.values()) {
    if (p.profileId === req.profileId) items.push({ mode: p.mode, id: p.id, ...dlView(p.mode, p.id) });
  }
  res.json({ items });
});
// The phone calls this after it has saved the file, to free server disk.
app.delete("/api/download/cache/:mode(movie|series)/:id", (req, res) => {
  const k = dlKey(req.params.mode, String(req.params.id));
  if (dlPending.delete(k)) return res.json({ ok: true, cancelled: true });
  const j = dlJobs.get(k);
  if (j && (j.state === "running" || j.state === "waiting" || j.state === "queued")) {
    // cancel: the runner notices the flag, stops, and cleans its partial files
    j.cancelled = true; dlJobs.delete(k);
    dlq.removeFromQueue(j);
    try { j.abort?.(); } catch {}
    dlPromotePending();
    return res.json({ ok: true, cancelled: true });
  }
  try { fs.rmSync(dlFile(k), { force: true }); } catch {}
  dlJobs.delete(k);
  res.json({ ok: true });
});

app.post("/api/progress/:mode(movie|series|disk)/:id", express.json(), (req, res) => {
  const userState = getProfileState(req.profileId);
  const { mode, id } = req.params;
  const position = Number(req.body?.position);
  const duration = Number(req.body?.duration);
  if (!Number.isFinite(position) || position < 0) {
    return res.status(400).json({ error: "bad position" });
  }
  // A player is running on this device: no tile preview elsewhere meanwhile.
  previewViewerActivity(ownerKeyOf(req), "progress");
  const key = `${mode}:${id}`;
  const validDur = Number.isFinite(duration) && duration > 0 ? duration : null;
  const finished = validDur != null && (position >= validDur - 30 || position >= validDur * 0.95);
  if (position < 30 || finished) {
    delete userState.progress[key];
  } else {
    userState.progress[key] = { p: position, d: validDur, t: Date.now() };
  }
  // Finished a series episode: move this profile's "continue" pointer to the NEXT
  // episode, so Continue Watching offers what to watch next instead of replaying
  // the one just finished. Uses the cached series info only (never calls the
  // panel mid-playback: the account allows one connection).
  if (mode === "series") {
    // Playing an episode clears the series' "new episode" badge.
    // Progress ticks every few seconds: at most every 10 min per profile + series.
    const sid = Object.entries(userState.lastEpisode || {}).find(([, le]) => String(le?.episode_id) === String(id))?.[0];
    if (sid && newEpisodeTickDue(req.profileId, sid)) noteSeriesPlayed(userState, sid);
  }
  if (mode === "series" && finished) {
    try { advanceToNextEpisode(userState, id); } catch (e) { console.warn(`[progress] next-episode: ${e.message}`); }
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

function advanceToNextEpisode(userState, finishedEpisodeId) {
  const epId = String(finishedEpisodeId);
  const entry = Object.entries(userState.lastEpisode || {}).find(([, le]) => String(le?.episode_id) === epId);
  if (!entry) return;
  const [seriesId, le] = entry;
  const actx = currentAccount();
  const infoKey = (sid) => xtreamKey(actx, MODES.series.info, { series_id: sid });
  const hit = cache.get(infoKey(String(seriesId))) || cache.get(infoKey(parseInt(seriesId, 10)));
  const info = hit && Date.now() - hit.t < TTL_MS ? hit.v : null;
  const seasons = info?.episodes && typeof info.episodes === "object" ? info.episodes : null;
  if (!seasons) { clearAutoPointer(le); return; }
  const all = Object.entries(seasons)
    .flatMap(([sn, eps]) => (Array.isArray(eps) ? eps : []).map((e) => ({ ...e, season: Number(e.season ?? sn) })))
    .sort((a, b) => a.season - b.season || (Number(a.episode_num) || 0) - (Number(b.episode_num) || 0));
  const at = all.findIndex((e) => String(e.id) === epId);
  const next = at >= 0 ? all[at + 1] : null;
  if (!next || !/^\d{1,12}$/.test(String(next.id))) { clearAutoPointer(le); return; } // last episode: series is done
  userState.lastEpisode[seriesId] = {
    ...le,
    episode_id: String(next.id), season: next.season, episode_num: Number(next.episode_num) || null,
    title: next.title || null, container: String(next.container_extension || le.container || "mp4").toLowerCase(),
    when: Date.now(), auto: true,
  };
  const sid = parseInt(seriesId, 10);
  if (Number.isFinite(sid)) {
    userState.recents ||= {};
    const list = Array.isArray(userState.recents?.series) ? userState.recents.series : (userState.recents.series = []);
    userState.recents.series = [sid, ...list.filter((x) => x !== sid)].slice(0, 100);
  }
}

// Remove a single item from the merged Continue Watching rail (#48).
// Wipes both `recents[mode]` (the "I pressed play" entry) AND
// `progress[mode:id]` (the saved playback position) so the title
// disappears from the merged rail entirely in one round-trip.
// Idempotent — a 404-style miss just no-ops at 200 OK.
app.delete("/api/user-state/recents/:mode(movie|series|live|disk)/:id", (req, res) => {
  const userState = getProfileState(req.profileId);
  const mode = req.params.mode;
  const idNum = parseInt(req.params.id, 10);
  if (!Number.isFinite(idNum)) {
    return res.status(400).json({ error: "bad id" });
  }
  const list = Array.isArray(userState.recents?.[mode]) ? userState.recents[mode] : [];
  userState.recents[mode] = list.filter((x) => x !== idNum);
  delete userState.progress[`${mode}:${idNum}`];
  // Series: progress is keyed by EPISODE id and an "up next" pointer also
  // keeps a show in Continue Watching. Drop the pointed episode's position and
  // the up-next flag (the pointer stays, so Resume / history still know it).
  if (mode === "series") {
    const le = userState.lastEpisode?.[String(idNum)];
    if (le && typeof le === "object") {
      if (le.episode_id != null) delete userState.progress[`series:${le.episode_id}`];
      // `cwRemovedAt`: a client's stale snapshot (auto: true) must not win the
      // PUT /api/user-state merge and bring the show back, and the show is no
      // longer followed for new episodes.
      clearAutoPointer(le);
      le.cwRemovedAt = Date.now();
    }
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

// Clear the whole Continue Watching list for a mode (#48). Wipes
// recents[mode] AND every progress entry in that mode. Settings →
// Privacy → "Clear Continue Watching" calls this per mode.
app.delete("/api/user-state/recents/:mode(movie|series|live|disk)", (req, res) => {
  const userState = getProfileState(req.profileId);
  const mode = req.params.mode;
  userState.recents[mode] = [];
  for (const key of Object.keys(userState.progress || {})) {
    if (key.startsWith(mode + ":")) delete userState.progress[key];
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

// Whole-state PUT for cross-device sync. Scoped to the active profile
// — same household password, isolated state per profile.
app.put("/api/user-state", express.json({ limit: "256kb" }), (req, res) => {
  const userState = getProfileState(req.profileId);
  const b = req.body || {};
  if (b.favorites && typeof b.favorites === "object") {
    for (const m of MODE_KEYS) {
      if (Array.isArray(b.favorites[m])) {
        userState.favorites[m] = b.favorites[m].slice(0, 5000);
      }
    }
  }
  if (b.myList && typeof b.myList === "object") {
    for (const m of MODE_KEYS) {
      if (Array.isArray(b.myList[m])) {
        userState.myList[m] = b.myList[m].slice(0, 5000);
      }
    }
  }
  mergePendingListAdds(req.profileId, userState);
  if (b.feedback && typeof b.feedback === "object") {
    for (const dir of ["up", "down"]) {
      const src = b.feedback[dir];
      if (src && typeof src === "object") {
        for (const m of MODE_KEYS) {
          if (Array.isArray(src[m])) {
            userState.feedback[dir][m] = src[m].slice(0, 5000);
          }
        }
      }
    }
  }
  if (b.seenSnooze && typeof b.seenSnooze === "object") {
    userState.seenSnooze = pickModeObjects(b.seenSnooze, userState.seenSnooze);
  }
  if (b.recents && typeof b.recents === "object") {
    for (const m of MODE_KEYS) {
      if (Array.isArray(b.recents[m])) {
        userState.recents[m] = b.recents[m].slice(0, 100);
      }
    }
  }
  if (Array.isArray(b.watched)) {
    userState.watched = b.watched.slice(0, 50000);
  }
  if (b.lastEpisode && typeof b.lastEpisode === "object") {
    // Per show, keep the newer pointer: a stale client snapshot must not revert the
    // server's "next episode" advance (entries without `when` count as oldest).
    const merged = { ...b.lastEpisode };
    for (const [sid, cur] of Object.entries(userState.lastEpisode || {})) {
      const inc = merged[sid];
      // (A show the client omitted stays omitted: that is how a client clears history.)
      if (inc && (cur?.when || 0) > (inc?.when || 0)) merged[sid] = cur;
      // Removed from Continue Watching: only a newer pointer (a new play) brings it back.
      // (TV pointers carry no `when`: a different episode is a new play.)
      else if (inc && cur?.cwRemovedAt && String(inc.episode_id) === String(cur.episode_id)
        && !(Number(inc.when) > cur.cwRemovedAt)) merged[sid] = cur;
      // Server-owned play time survives a client snapshot.
      else if (inc && typeof inc === "object" && cur?.playedAt) merged[sid] = { ...inc, playedAt: Math.max(cur.playedAt, Math.min(Number(inc.playedAt) || 0, Date.now())) };
    }
    userState.lastEpisode = merged;
  }
  if (b.filter && typeof b.filter === "object") {
    const next = {
      onboarded: !!b.filter.onboarded,
      groups: emptyModeBuckets(),
    };
    if (b.filter.groups && typeof b.filter.groups === "object") {
      for (const m of MODE_KEYS) {
        if (Array.isArray(b.filter.groups[m])) {
          next.groups[m] = b.filter.groups[m]
            .filter(x => typeof x === "string")
            .slice(0, 200);
        }
      }
    }
    userState.filter = next;
  }
  if (typeof b.remoteEnabled === "boolean") {
    userState.remoteEnabled = b.remoteEnabled;
  }
  if (Number.isFinite(b.epgWindowHoursForward)) {
    userState.epgWindowHoursForward = Math.min(Math.max(Math.round(b.epgWindowHoursForward), 1), 24);
  }
  // [] or null clears back to the default (hin, eng).
  if (b.audioLangPrefs === null || Array.isArray(b.audioLangPrefs)) {
    const n = audioTracksLib.normalizeAudioLangPrefs(b.audioLangPrefs);
    userState.audioLangPrefs = n && n.length ? n : null;
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

// Voice-friendly name matching. Panel channel names carry punctuation
// and language prefixes ("USA: CNN HD", "|CA| CNN | HD") that a single
// contiguous substring test can't see through — searching "USA CNN"
// returned nothing because "usa cnn" isn't a substring of "usa: cnn hd".
// The Cooper / khouch-homeassistant voice flow feeds ASR text ("usa cnn",
// "cnn news", "cnn") that never matches the panel's punctuation/prefix
// formatting, so contiguous matching is brittle for voice. Instead we
// normalize both sides (lowercase, non-alphanumerics → spaces, collapse
// whitespace) and require every query token to appear (order-independent
// AND).
const normalizeForSearch = (s) =>
  String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Rank a normalized name against a normalized query + its tokens.
// 3 = contiguous full-query substring (exact stays on top),
// 2 = all tokens present (order-independent), 0 = no match.
// An empty query matches everything at a neutral rank.
// Per-title normalized search text (title words, cast+director words), cached
// by stream object and invalidated when its TMDB entry object is replaced.
// Each text is space-padded (" w1 w2 ") so word-start checks are `includes(" p")`.
const searchTextsCache = new WeakMap();
function searchTextsFor(s, t) {
  const c = searchTextsCache.get(s);
  if (c && c.t === t) return c;
  const tj = normalizeForSearch(cleanPanelTitle(s.name || "") || s.name || "");
  const other = [];
  if (Array.isArray(t?.cast)) for (const m of t.cast) other.push(normalizeForSearch(m.name || ""));
  if (Array.isArray(t?.directors)) for (const d of t.directors) other.push(normalizeForSearch(d || ""));
  const out = { t, tj, title: ` ${tj} `, other: ` ${other.join(" ")} ` };
  searchTextsCache.set(s, out);
  return out;
}
// Sort search candidates by quality then popularity while keeping a title's
// language/quality siblings (same dedupTitleKey) together and ordered by
// langRank. Siblings share one (best) score/vote, which keeps the comparator
// a strict weak ordering (the old mixed comparator was intransitive).
function rankWithDubClusters(items, scoreOf, voteOf, langRank) {
  const g = new Map();
  for (const it of items) {
    if (!it.dtKey) continue;
    const sc = scoreOf(it), v = voteOf(it), cur = g.get(it.dtKey);
    if (!cur) g.set(it.dtKey, { sc, v });
    else { if (sc > cur.sc) cur.sc = sc; if (v > cur.v) cur.v = v; }
  }
  const gs = (it) => (it.dtKey ? g.get(it.dtKey).sc : scoreOf(it));
  const gv = (it) => (it.dtKey ? g.get(it.dtKey).v : voteOf(it));
  items.sort((a, b) => {
    const sa = gs(a), sb = gs(b);
    if (sa !== sb) return sb - sa;
    const va = gv(a), vb = gv(b);
    if (va !== vb) return vb - va;
    const ka = a.dtKey || "", kb = b.dtKey || "";
    if (ka !== kb) return ka < kb ? -1 : 1;
    return langRank(a.s) - langRank(b.s);
  });
}
const nameMatchRank = (normName, normQuery, queryTokens) => {
  if (!normQuery) return 1;
  if (normName.includes(normQuery)) return 3;
  if (queryTokens.length && queryTokens.every((t) => normName.includes(t))) return 2;
  return 0;
};

// EPG-aware live search. Channel names rarely carry event words —
// "2026 fifa" finds nothing by name even while five channels are
// airing World Cup matches. Scan the xmltv index's programme titles
// (currently airing or starting within the window) and surface the
// channels airing the matches, each tagged with the programme that
// matched so clients can label WHY the channel is in the results.
// Pure in-memory pass over the nightly xmltv index — no panel calls.
const EPG_SEARCH_WINDOW_MS = 48 * 60 * 60 * 1000;
function searchEpgLive(normQ, qTokens, limit) {
  if (!qTokens.length || limit <= 0) return [];
  const epgByChannel = isOwnerAccount(currentAccount())
    ? epgIndex
    : getEpgIndexFor(currentAccount()).byChannel;
  if (!epgByChannel || epgByChannel.size === 0) return [];
  // epg_channel_id → live streams (panels map several quality
  // variants of one channel onto the same EPG id).
  const byEpgId = new Map();
  for (const s of indexes.live.byId.values()) {
    if (!s.epg_channel_id) continue;
    const arr = byEpgId.get(s.epg_channel_id);
    if (arr) arr.push(s); else byEpgId.set(s.epg_channel_id, [s]);
  }
  const now = Date.now();
  const horizon = now + EPG_SEARCH_WINDOW_MS;
  const hits = [];
  for (const [chId, progs] of epgByChannel) {
    const streams = byEpgId.get(chId);
    if (!streams) continue;
    for (const p of progs) {
      if (p.stop <= now) continue;     // already ended
      if (p.start >= horizon) break;   // sorted by start
      const rank = nameMatchRank(normalizeForSearch(p.title), normQ, qTokens);
      if (!rank) continue;
      // First (soonest) matching programme per channel is enough —
      // a tournament airs many matches; one tile per channel.
      hits.push({ streams, prog: p, rank });
      break;
    }
  }
  // Airing-now / starting-soonest first; match quality breaks ties.
  hits.sort((a, b) => (a.prog.start - b.prog.start) || (b.rank - a.rank));
  const out = [];
  for (const h of hits) {
    for (const s of h.streams) {
      if (out.length >= limit) return out;
      out.push({
        s,
        programme: {
          title:    h.prog.title || "",
          start_ts: Math.floor(h.prog.start / 1000),
          stop_ts:  Math.floor(h.prog.stop  / 1000),
        },
      });
    }
  }
  return out;
}

// ── NL search translation cache ─────────────────────────────────────
// /api/search/all falls back to a Claude translation when a query
// looks conversational and substring/facet matching came up dry (see
// the endpoint below). Queries repeat heavily across a household, so
// translations are cached: in-memory Map (insertion-ordered → cheap
// LRU trim) persisted to disk so a container recreate doesn't re-buy
// them. In-flight dedupe stops a keystroke burst from firing the same
// translation twice, and the concurrency cap stops a burst of
// DIFFERENT queries from stacking API calls — beyond the cap the
// endpoint just returns the substring results (NL is best-effort).
const nlQueryCacheFile = path.join(DATA_DIR, "nl-query-cache.json");
const NL_CACHE_MAX = 2000;
const nlQueryCache = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(nlQueryCacheFile, "utf8"));
    return new Map(Object.entries(d || {}));
  } catch { return new Map(); }
})();
let nlCacheSaveTimer = null;
let nlCacheSaving = false;
function scheduleNlCacheSave() {
  if (nlCacheSaveTimer) return;
  nlCacheSaveTimer = setTimeout(async () => {
    nlCacheSaveTimer = null;
    // Serialize: two concurrent writers on the same .tmp path can
    // interleave and rename a corrupted file into place.
    if (nlCacheSaving) return void scheduleNlCacheSave();
    nlCacheSaving = true;
    try {
      await fs.promises.writeFile(nlQueryCacheFile + ".tmp", JSON.stringify(Object.fromEntries(nlQueryCache)));
      await fs.promises.rename(nlQueryCacheFile + ".tmp", nlQueryCacheFile);
    } catch (e) {
      console.warn(`[ai] save nl-query-cache failed: ${e.message}`);
    } finally {
      nlCacheSaving = false;
    }
  }, 2000);
}
const nlInFlight = new Map(); // q -> Promise<facets|null>
async function translateNlQueryCached(q) {
  if (nlQueryCache.has(q)) {
    const hit = nlQueryCache.get(q);
    // Refresh LRU position so hot queries survive the trim.
    nlQueryCache.delete(q);
    nlQueryCache.set(q, hit);
    return hit.facets;
  }
  if (nlInFlight.has(q)) return nlInFlight.get(q);
  if (nlInFlight.size >= 4) return null; // shed load, keep search snappy
  // translateSearchQuery is documented never to reject, but the
  // in-flight slot MUST be released even if that ever changes — four
  // stuck entries would disable NL search until restart (the cap
  // above). Hence catch + finally, not cleanup inside then().
  const p = ai.translateSearchQuery(q)
    .catch(() => null)
    .then((facets) => {
      // Only successful translations are cached. A null is ambiguous —
      // it could be a transport failure that would succeed on retry —
      // so nulls stay uncached and simply retry on a later search.
      if (facets) {
        nlQueryCache.set(q, { facets, t: Date.now() });
        while (nlQueryCache.size > NL_CACHE_MAX) {
          nlQueryCache.delete(nlQueryCache.keys().next().value);
        }
        scheduleNlCacheSave();
      }
      return facets;
    })
    .finally(() => nlInFlight.delete(q));
  nlInFlight.set(q, p);
  return p;
}

// Search across the in-memory index for a mode. Token-AND name match
// (normalized, punctuation-insensitive); bounded result count. Designed
// for HA / external clients that want to drive a search-as-you-type UI
// without pulling the whole index. Works for live, movie, and series.
app.get("/api/search/all", async (req, res, next) => {
  try {
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 60);
  const groupTitles = req.query.group === "1"; // docs/VARIANTS.md
  if (!q) return res.json({ q, disk: [], movie: [], series: [], live: [] });

  const userState = getProfileState(req.profileId);
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  const modeKeys = (() => {
    const own = userState.filter?.groups?.movie;
    if (Array.isArray(own) && own.length) return own;
    return userState.filter?.groups?.live || [];
  })();
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  const kidBlocker = makeKidsBlocker(activeProfile);

  // Resolve the query to a canonical TMDB genre when applicable, so
  // typing "thriller" surfaces every thriller-tagged title in the
  // catalog — not just those whose name happens to contain the word.
  // Matched on the full query (after trim/lower); also handles common
  // synonyms users type ("sci-fi" for Science Fiction, etc).
  // Maps common synonyms / informal terms onto TMDB's canonical
  // genre names. TMDB doesn't have "Suspense" (filed under Thriller),
  // doesn't split out Anime from Animation, etc. — without these,
  // perfectly reasonable searches like "suspense" or "anime" return
  // only title-substring matches.
  const GENRE_ALIASES = {
    // Thriller
    "thrillers": "Thriller",
    "suspense": "Thriller",
    "psychological": "Thriller",
    // Sci-Fi
    "sci-fi": "Science Fiction",
    "scifi": "Science Fiction",
    "sci fi": "Science Fiction",
    "science-fiction": "Science Fiction",
    // Animation
    "anime": "Animation",
    "cartoon": "Animation",
    "cartoons": "Animation",
    "animated": "Animation",
    // Comedy
    "comedies": "Comedy",
    "funny": "Comedy",
    "rom-com": "Romance",
    "romcom": "Romance",
    "rom com": "Romance",
    // Horror
    "scary": "Horror",
    "horror movies": "Horror",
    // Family / Kids
    "kids": "Family",
    "kid": "Family",
    "children": "Family",
    "family-friendly": "Family",
    // Documentary
    "doc": "Documentary",
    "docs": "Documentary",
    "documentaries": "Documentary",
    "true story": "Documentary",
    // Crime / Mystery
    "true crime": "Crime",
    "detective": "Mystery",
    "whodunit": "Mystery",
    // Action / Adventure
    "actions": "Action",
    "fights": "Action",
    "adventures": "Adventure",
    // Romance
    "romances": "Romance",
    "love": "Romance",
    "love story": "Romance",
    // Music
    "musical": "Music",
    "musicals": "Music",
    "concert": "Music",
    // Misc
    "war movies": "War",
    "westerns": "Western",
    "historical": "History",
    "fantasy movies": "Fantasy",
  };
  const KNOWN_GENRES = [
    "Action", "Adventure", "Animation", "Comedy", "Crime", "Documentary",
    "Drama", "Family", "Fantasy", "History", "Horror", "Music", "Mystery",
    "Romance", "Science Fiction", "Thriller", "War", "Western",
  ];
  const matchedGenre = (() => {
    if (GENRE_ALIASES[q]) return GENRE_ALIASES[q];
    const direct = KNOWN_GENRES.find(g => g.toLowerCase() === q);
    return direct || null;
  })();

  // Multi-token faceted parse. "thriller hindi 2024 ajay devgan"
  // splits into facets (Thriller / Hindi / 2024) AND a residual name
  // phrase ("ajay devgan") that matches against title OR cast. AND
  // combined across facets so the result is everything that is a
  // 2024 Hindi thriller featuring Ajay Devgan.
  const LANG_ALIASES = {
    hindi: "hi", english: "en", tamil: "ta", telugu: "te",
    kannada: "kn", malayalam: "ml", marathi: "mr", gujarati: "gu",
    punjabi: "pa", bengali: "bn", urdu: "ur", arabic: "ar",
    spanish: "es", french: "fr", german: "de", italian: "it",
    portuguese: "pt", japanese: "ja", korean: "ko", chinese: "zh",
    russian: "ru", turkish: "tr",
  };
  const parseQuery = (qq) => {
    const tokens = qq.split(/\s+/).filter(Boolean);
    let year = null, decadeStart = null, genre = null, lang = null;
    const nameTokens = [];
    for (const tok of tokens) {
      if (!year && /^(19|20)\d{2}$/.test(tok)) { year = tok; continue; }
      // decade tokens: "90s", "80s", "2010s". Normalize to a
      // 4-digit decade start.
      const dm = /^(?:(19|20)?(\d0))s$/.exec(tok);
      if (!decadeStart && dm) {
        const dd = parseInt(dm[2], 10);
        const century = dm[1] ? parseInt(dm[1] + "00", 10)
                              : (dd >= 30 ? 1900 : 2000);
        decadeStart = century + dd;
        continue;
      }
      const g = GENRE_ALIASES[tok] || KNOWN_GENRES.find(x => x.toLowerCase() === tok);
      if (!genre && g) { genre = g; continue; }
      if (!lang && LANG_ALIASES[tok]) { lang = LANG_ALIASES[tok]; continue; }
      nameTokens.push(tok);
    }
    return { year, decadeStart, genre, lang, name: nameTokens.join(" ") };
  };
  const parsed = parseQuery(q);
  const hasFacets = !!(parsed.year || parsed.decadeStart || parsed.genre || parsed.lang);
  // Multi-token query with no parsed facets is almost certainly a
  // person name ("ranveer singh", "christopher nolan"). Run those
  // through the faceted matcher too so the cast lookup engages —
  // panel titles never include cast names, so the plain substring
  // pass would return zero.
  const couldBeName = !hasFacets && /\s/.test(q);

  // Facets arrive as parameters (not closure state) so the NL
  // fallback below can re-run the exact same matcher with a
  // Claude-translated facet set. nameQ is what the substring passes
  // (1 and 3) match on: the raw query for the deterministic run —
  // live mode has no facet filter, so stripping facet tokens there
  // breaks "comedy central" — and the translated name for the NL
  // rerun, so a translation like name:"batman" can change the outcome.
  const searchMode = (mode, parsed, hasFacets, couldBeName, nameQ) => {
    const ix = indexes[mode];
    if (!ix.ready || ix.byId.size === 0) return [];
    // Live channels have no us_cert; running the strict allow-list
    // on them would zero out the live-search bucket for kid profiles.
    const isKidBlocked = mode === "live" ? () => false : kidBlocker;
    const seenTmdb = new Set();
    const seenIds = new Set();
    const seenTitle = new Set();
    const results = [];
    // Same-title dub variants ("Kohrra", "Kohrra (Hindi)", "Kohrra
    // (Tamil)", …) collapse to one dedupTitleKey below — intentional, one
    // tile per show, not five near-identical ones. But whichever candidate
    // reaches eligible() FIRST wins that slot and every other dub is
    // silently dropped from results entirely, unreachable by any search.
    // A bare/no-suffix title almost always ranks as the best text match
    // for its own name, so a profile onboarded for Hindi searching
    // "Kohrra" got the (usually English-default) bare entry every time,
    // with the Hindi dub invisibly discarded — not filtered, not a lower
    // rank, just gone. langRank breaks a same-titleKey tie toward the
    // profile's onboarded language(s) instead of raw text-match rank, so
    // eligible() gets offered the right dub first and keeps THAT one.
    const langPref = onboarded ? modeKeys.filter(k => LANGUAGE_GROUP_KEYS_SET.has(k)) : [];
    // s.tags is USELESS for telling dub variants apart — every variant of
    // a title shares the same panel category, hence identical tags,
    // regardless of which language it actually contains. The dub
    // language only ever shows up in the title text itself, panel
    // convention "Title (Language)" — suffixOf (module-level, near
    // TITLE_LANG_SUFFIX_RE) parses it. Matched against the RAW name (not
    // dedupTitleKey's cleaned version, which deliberately strips this
    // exact suffix).
    const langRank = (s) => {
      if (!langPref.length) return 0;
      const suffix = suffixOf(s.name);
      if (suffix) {
        // An explicit, WRONG-language suffix is a confirmed miss — rank
        // it below even a bare/no-suffix title (ambiguous default audio,
        // could still turn out to be the preferred language).
        const i = langPref.indexOf(suffix);
        return i >= 0 ? i : langPref.length + 1;
      }
      const tags = Array.isArray(s.tags) ? s.tags : [];
      const i = langPref.findIndex(l => tags.includes(l));
      return i === -1 ? langPref.length : i; // lower = more preferred; no match sorts in the ambiguous middle
    };
    const projectTile = (s) => {
      const t = mode !== "live" ? tmdbCache[`${mode}:${s.id}`] : null;
      return {
        id: s.id,
        name: s.name,
        icon: s.icon || null,
        poster: tilePoster(mode, s, t),
        year: s.year || null,
        rating: s.rating || null,
        us_cert: s.us_cert || null,
        tmdb_id: s.tmdb_id || null,
        category_id: s.category_id,
        tags: s.tags || [],
        container: s.container || null,
        ...(mode !== "live" ? audioTileFields(s) : {}),
        isSeriesGroup: s.isSeriesGroup || undefined,
        // Explicit dub-language marker ("hindi", "punjabi", …) parsed from
        // the title's own "(Language)" suffix — null for the bare/default
        // entry. Search can now return several same-poster variants of one
        // title side by side (their own onboarded languages, see eligible()
        // above); without this the client has no way to tell two otherwise-
        // identical tiles apart short of the full un-truncated title text.
        dubLang: suffixOf(s.name) || null,
      };
    };
    // One result per title: fold language/quality variants into the native-
    // language canonical (see assignVariants); a profile whose onboarded
    // languages exclude it gets the best variant it chose instead.
    const variantHidden = makeVariantHider(
      ix,
      (x) => titleLangPasses(x.name) && !isKidBlocked(x) && !(onboarded && suffixOf(x.name) && !langPref.includes(suffixOf(x.name))),
      onboarded ? new Set(modeKeys.map((k) => LANG_TAG_TO_ISO[k]).filter(Boolean)) : null,
    );
    // `?group=1` (opt-in; the phone sends it once its picker ships): one
    // result per TITLE group (lib/variants.js). A member that passes the
    // profile gates claims its group's slot; the tile shows the group's
    // primary copy plus the `variants` picker list. Default (web, current
    // phone): the separate onboarded-language dub tiles below, unchanged.
    const vEntry = groupTitles ? variantIndexFor(mode, ix) : null;
    const vctx = vEntry ? {
      passes: (x) => titleLangPasses(x.name) && !isKidBlocked(x) && !(onboarded && suffixOf(x.name) && !langPref.includes(suffixOf(x.name))),
      ...variantLangCtx(langPref, parsed.lang),
      startedIds: startedIdsFor(userState, mode),
    } : null;
    const seenGroups = new Set();
    // The result tile for `s`, or null when it is gated out / its title is
    // already in the results.
    const admit = (s) => {
      if (!vEntry) return eligible(s) ? projectTile(s) : null;
      if (seenIds.has(s.id) || !vctx.passes(s)) return null;
      const g = variantGroupOf(vEntry, s);
      if (seenGroups.has(g.key)) return null;
      seenGroups.add(g.key);
      const resolved = resolveGroup(g, vctx); // non-null: `s` itself passes
      seenIds.add(s.id);
      for (const v of resolved.variants) seenIds.add(v.id);
      return { ...projectTile(resolved.primary.s), ...tileVariantFields(resolved) };
    };
    const eligible = (s) => {
      if (variantHidden(s)) return false;
      if (!titleLangPasses(s.name)) return false;
      if (isKidBlocked(s)) return false;
      const suffix = suffixOf(s.name);
      // Hard-drop a dub variant explicitly labeled in a language the
      // profile didn't onboard (Kunal, 2026-08-09: wants Hindi AND
      // English/bare shown for a title, since both are onboarded, but
      // never Tamil/Telugu/etc since those aren't). Distinct from the
      // dedup below — this is exclusion, not a same-title tiebreak.
      if (onboarded && suffix && !langPref.includes(suffix)) return false;
      // Title+year fallback — catches a duplicate before it has a
      // tmdb_id to dedup on, or when two duplicates' tmdb_id lookups
      // haven't converged yet. See dedupTitleKey. Keyed on (title,
      // accepted-language-variant) rather than title alone, so a title's
      // OWN onboarded-language dub gets its own tile instead of every
      // variant collapsing into a single winner — e.g. "Kohrra" (bare)
      // and "Kohrra (Hindi)" both survive as separate results; "Kohrra
      // (Tamil)"/"(Telugu)" were already rejected above and never reach
      // this point.
      const titleKey = dedupKeyOf(s);
      const dedupKey = titleKey ? `${titleKey}::${suffix || "_"}` : null;
      if (dedupKey && seenTitle.has(dedupKey)) return false;
      if (s.tmdb_id) {
        const tmdbKey = `${s.tmdb_id}::${suffix || "_"}`;
        if (seenTmdb.has(tmdbKey)) return false;
        seenTmdb.add(tmdbKey);
      }
      if (dedupKey) seenTitle.add(dedupKey);
      if (seenIds.has(s.id)) return false;
      seenIds.add(s.id);
      return true;
    };
    // Faceted match — when the user typed multiple tokens that
    // resolve to facets (year + language + genre, etc.), AND-combine
    // them. The residual `parsed.name` runs against BOTH the panel
    // title AND the cached TMDB cast list, so "ajay devgan" matches
    // his films without him being in the title.
    if ((hasFacets || couldBeName) && mode !== "live") {
      const nameLow = parsed.name || "";
      const matches = [];
      let castOnly = 0;
      for (const s of ix.byId.values()) {
        const t = tmdbCache[`${mode}:${s.id}`];
        if (!t || t.source === "no-match") continue;
        // Year facet — strict 4-digit match.
        if (parsed.year && t.year !== parsed.year) continue;
        // Decade — TMDB year falls in [start, start+10).
        if (parsed.decadeStart) {
          const y = parseInt(t.year, 10);
          if (!(y >= parsed.decadeStart && y < parsed.decadeStart + 10)) continue;
        }
        if (parsed.genre) {
          if (!Array.isArray(t.genres) || !t.genres.includes(parsed.genre)) continue;
        }
        if (parsed.lang && t.original_language !== parsed.lang) {
          // Fallback: when original_language isn't yet populated by
          // the v2 backfill, also accept the panel-derived tag.
          if (!(Array.isArray(s.tags) && s.tags.includes(parsed.lang === "hi" ? "hindi" : parsed.lang))) continue;
        }
        // Name residual — AND-match every query token against WORDS of the
        // panel title + TMDB cast + directors. A token is a word PREFIX (4
        // chars max, so "Devgan"/"Devgn" still meet), and 1-2 letter tokens
        // ("se", "ek") must be whole words — as loose substrings they matched
        // every cast list in the catalog ("dil se" returned Inception).
        let titleScore = 0;
        if (nameLow) {
          // Normalized like the haystack ("dil se.." -> dil se; "mr. & mrs." -> mr mrs).
          const userTokens = normalizeForSearch(nameLow).split(" ").filter(Boolean);
          if (!userTokens.length) {
            // Nothing Latin to normalize (e.g. Devanagari): plain substring match
            // on the raw title/cast, as before.
            const raw = nameLow.split(/\s+/).filter(Boolean);
            const hay = ((s.name || "") + " | " + (t.cast || []).map((c) => c.name || "").join(" ")).toLowerCase();
            if (!raw.every((tok) => hay.includes(tok))) continue;
            titleScore = (s.name || "").toLowerCase().includes(nameLow) ? 3 : 1;
          } else {
          const st = searchTextsFor(s, t);
          // Word-start prefix (4 chars max) for tokens >2 chars; whole word for 1-2 letters.
          const tokHit = (tok, text) => (tok.length <= 2
            ? text.includes(" " + tok + " ")
            : text.includes(" " + (tok.length >= 5 ? tok.slice(0, 4) : tok)));
          if (!userTokens.every((tok) => tokHit(tok, st.title) || tokHit(tok, st.other))) continue;
          // How well does the TITLE itself match? (cast-only hits rank last)
          const qj = userTokens.join(" ");
          if (st.tj === qj) titleScore = 5;
          else if (st.tj.startsWith(qj + " ")) titleScore = 4;
          else if (userTokens.every((tok) => st.title.includes(" " + tok + " "))) titleScore = 3;
          else if (userTokens.every((tok) => tokHit(tok, st.title))) titleScore = 2;
          else if (userTokens.some((tok) => tokHit(tok, st.title))) titleScore = 1;
          }
        }
        // Title hits are always kept; cast/director-only hits are capped so a
        // generic name query can't balloon the list. (The old early break
        // stopped at the first limit*10 hits in index order, BEFORE ranking,
        // so the real title could be cut off.) Facet-only queries (no name
        // residual) keep every match so the popularity sort sees them all.
        if (nameLow && titleScore === 0) {
          if (castOnly >= limit * 10) continue;
          castOnly++;
        }
        matches.push({ s, t, dtKey: dedupKeyOf(s), titleScore });
        if (matches.length >= 60000) break;
      }
      // Rank: how well the title matches first (exact > prefix > whole words
      // > word prefixes > partial > cast-only), then audience size.
      // Same-titleKey candidates (dub variants of one show) tiebreak on
      // langRank instead — see the comment on langRank above — so eligible()
      // below sees the profile's onboarded-language dub first.
      rankWithDubClusters(matches, (m) => m.titleScore, (m) => m.t.vote_count || 0, langRank);
      for (const m of matches) {
        if (results.length >= limit) break;
        const tile = admit(m.s);
        if (tile) results.push(tile);
      }
      return results;
    }

    // Pass 1 — token-AND name match. Triggers when no facets were parsed
    // out of the query, so "bajirao" or "marvel" still works; multi-token
    // live queries ("usa cnn") now match too. Collect every match with a
    // rank, sort so contiguous full-query hits come before all-tokens
    // hits (exact stays on top), then dedup in rank order via eligible().
    const normQ = normalizeForSearch(nameQ);
    const qTokens = normQ.split(" ").filter(Boolean);
    const ranked = [];
    for (const s of ix.byId.values()) {
      const rank = nameMatchRank(normalizeForSearch(s.name), normQ, qTokens);
      if (!rank) continue;
      // Title quality bonus: an exact title ("Sholay") beats a title that merely
      // contains the word ("The Sholay Girl"); a prefix beats a mid-title hit.
      const tj = normalizeForSearch(cleanPanelTitle(s.name || "") || s.name || "");
      const bonus = tj === normQ ? 10 : tj.startsWith(normQ + " ") ? 5 : (" " + tj + " ").includes(" " + normQ + " ") ? 2 : 0;
      ranked.push({ s, rank: rank + bonus, dtKey: dedupKeyOf(s) });
    }
    // Same-titleKey candidates (dub variants of one show) tiebreak on
    // langRank instead of raw rank — see the comment on langRank above —
    // so the profile's onboarded-language dub is what eligible() sees
    // first and keeps. Different titles keep the existing rank order.
    // Same title quality: the more-watched (TMDB vote count) title first.
    rankWithDubClusters(ranked, (r) => r.rank, (r) => tmdbCache[`${mode}:${r.s.id}`]?.vote_count || 0, langRank);
    for (const { s } of ranked) {
      if (results.length >= limit) break;
      const tile = admit(s);
      if (tile) results.push(tile);
    }
    // Pass 2 — genre matches, only when the query mapped to a
    // canonical TMDB genre and we still have room under the limit.
    // Sorted by audience size (vote_count) so the most-known titles
    // show first; users with niche taste can scroll. Live items have
    // no TMDB data, so this pass is a no-op for that mode.
    if (matchedGenre && mode !== "live" && results.length < limit) {
      const tagged = [];
      for (const s of ix.byId.values()) {
        if (seenIds.has(s.id)) continue;
        const t = tmdbCache[`${mode}:${s.id}`];
        if (!t || t.source === "no-match") continue;
        if (!Array.isArray(t.genres) || !t.genres.includes(matchedGenre)) continue;
        if (!titleLangPasses(s.name)) continue;
        if (isKidBlocked(s)) continue;
        // Dedup (titleKey/tmdb_id) deliberately NOT applied here — same
        // reasoning as the faceted-match pass above: it has to run AFTER
        // the sort below so a dub-cluster's language tiebreak sees every
        // sibling, not just whichever the raw scan reached first.
        tagged.push({ s, vc: t.vote_count || 0, dtKey: dedupKeyOf(s) });
      }
      tagged.sort((a, b) => {
        if (a.dtKey && a.dtKey === b.dtKey) return langRank(a.s) - langRank(b.s);
        return b.vc - a.vc;
      });
      for (const { s, dtKey } of tagged) {
        if (results.length >= limit) break;
        if (vEntry) { const tile = admit(s); if (tile) results.push(tile); continue; }
        // Same exclusion + (title, language-variant) dedup as eligible()
        // above — kept inline here since this pass has never called
        // eligible() (pre-existing duplication, not introduced by this).
        const suffix = suffixOf(s.name);
        if (onboarded && suffix && !langPref.includes(suffix)) continue;
        const dedupKey = dtKey ? `${dtKey}::${suffix || "_"}` : null;
        if (dedupKey && seenTitle.has(dedupKey)) continue;
        if (s.tmdb_id) {
          const tmdbKey = `${s.tmdb_id}::${suffix || "_"}`;
          if (seenTmdb.has(tmdbKey)) continue;
          seenTmdb.add(tmdbKey);
        }
        if (dedupKey) seenTitle.add(dedupKey);
        seenIds.add(s.id);
        results.push(projectTile(s));
      }
    }
    // Pass 3 (live only) — EPG programme-title match. Surfaces the
    // channels airing a searched event ("2026 fifa" → FOX while a
    // World Cup match is on) that name matching can't find. eligible()
    // dedups against the name-match results via seenIds and applies
    // the same language gate.
    if (mode === "live" && results.length < limit) {
      for (const { s, programme } of searchEpgLive(normQ, qTokens, limit * 2)) {
        if (results.length >= limit) break;
        if (!eligible(s)) continue;
        results.push({ ...projectTile(s), programme });
      }
    }
    return results;
  };

  // Disk (local library) first — the user's own media ranks above panel
  // results. Omitted entirely for non-owner tenants (empty disk index).
  const runAll = (p, hf, cbn, nameQ) => ({
    disk: searchMode("disk", p, hf, cbn, nameQ),
    movie: searchMode("movie", p, hf, cbn, nameQ),
    series: searchMode("series", p, hf, cbn, nameQ),
    live: searchMode("live", p, hf, cbn, nameQ),
  });
  const countHits = (r) => r.disk.length + r.movie.length + r.series.length + r.live.length;

  let results = runAll(parsed, hasFacets, couldBeName, q);
  let effectiveParsed = parsed;
  let effectiveHasFacets = hasFacets;

  // NL fallback — when the deterministic passes came up (nearly) dry
  // on a query that reads like a sentence ("something funny for the
  // kids") or carries an abbreviation the matcher can't know ("srk
  // 90s"), ask Claude to translate it into the same facet shape and
  // re-run the matcher. Gated hard so the common case never pays for
  // it: needs an API key, 2–12 tokens (≤200 chars — nobody types a
  // paragraph into a TV search box, and the bound keeps arbitrary
  // client input from amplifying into API spend / cache bloat), and
  // <3 total hits. Translations are cached (translateNlQueryCached)
  // and best-effort — any failure just returns the substring results
  // already computed.
  const nlTokens = q.split(/\s+/).length;
  if (ai.aiEnabled() && countHits(results) < 3 && nlTokens >= 2 && nlTokens <= 12 && q.length <= 200) {
    try {
      const facets = await translateNlQueryCached(q);
      if (facets) {
        const nlParsed = {
          year: facets.year || null,
          decadeStart: facets.decadeStart || null,
          genre: facets.genre || null,
          lang: facets.lang || null,
          name: facets.name || "",
        };
        const nlHasFacets = !!(nlParsed.year || nlParsed.decadeStart || nlParsed.genre || nlParsed.lang);
        // Unlike the deterministic couldBeName, no whitespace required:
        // a single-token translated name ("batman") should still go
        // through the faceted title/cast matcher.
        const nlCouldBeName = !nlHasFacets && !!nlParsed.name;
        // Only re-run when the translation actually adds information
        // beyond what the deterministic parse already tried.
        if (nlHasFacets || (nlParsed.name && nlParsed.name !== q)) {
          const rerun = runAll(nlParsed, nlHasFacets, nlCouldBeName, nlParsed.name || q);
          if (facets.kidsSafe) {
            // "…for the kids" narrows VOD to family certs even on an
            // adult profile. Live carries no certs, so it's left as-is
            // (kid profiles are already gated upstream).
            const kidPass = (t) => effCert(t) && FAMILY_CERTS.has(effCert(t));
            rerun.movie = rerun.movie.filter(kidPass);
            rerun.series = rerun.series.filter(kidPass);
          }
          if (countHits(rerun) > countHits(results)) {
            results = rerun;
            effectiveParsed = nlParsed;
            effectiveHasFacets = nlHasFacets;
          }
        }
      }
    } catch (e) {
      console.warn(`[ai] nl search fallback failed: ${e.message}`);
    }
  }

  res.json({
    q,
    ...results,
    // Clients render a "Genre: Thriller" header above the results
    // when this is set — gives the user a visual cue that the
    // results were broadened beyond plain title matching.
    genre: matchedGenre || effectiveParsed.genre || null,
    // Echo back the parsed facets so the UI can render a chip strip
    // showing "Thriller · Hindi · 2024 · ajay devgan" and the user
    // immediately sees how their multi-token query was understood —
    // whether it was parsed deterministically or via the NL fallback.
    parsed: effectiveHasFacets ? {
      year: effectiveParsed.year,
      decadeStart: effectiveParsed.decadeStart,
      genre: effectiveParsed.genre,
      lang: effectiveParsed.lang,
      name: effectiveParsed.name || null,
    } : null,
  });
  } catch (e) { next(e); } // async handler — rejections don't reach Express 4's error middleware on their own
});

app.get("/api/search/:mode(live|movie|series|disk)", (req, res) => {
  const mode = req.params.mode;
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const ix = indexes[mode];
  if (!ix.ready || ix.byId.size === 0) return res.json({ q, results: [] });

  const cats = loadCategoriesFromDiskSync(mode);
  const catName = new Map(cats.map((c) => [String(c.category_id), c.category_name]));
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  const isKidBlocked = mode === "live" ? () => false : makeKidsBlocker(activeProfile);
  // Title-language guard — same parity /api/search/all and the home rails
  // enforce, which this per-mode endpoint was missing: a Hindi/English
  // profile searching should not see Telugu/Tamil/etc. results. Onboarded
  // language keys are per-mode with the usual fallback (mode → movie →
  // live); disk (owner-only local library) is never language-gated.
  const userState = getProfileState(req.profileId);
  const modeKeys = profileModeKeys(userState, mode);
  const onboarded = mode !== "disk" && !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;

  // Token-AND name match (normalized, punctuation-insensitive) so voice
  // queries like "usa cnn" match "USA: CNN HD". Ranked: contiguous
  // full-query first, then all-tokens. An empty query browses the index
  // in iteration order, capped at the limit.
  const normQ = normalizeForSearch(q);
  const qTokens = normQ.split(" ").filter(Boolean);
  const ranked = [];
  for (const s of ix.byId.values()) {
    if (isKidBlocked(s)) continue;
    if (!titleLangPasses(s.name)) continue;
    const rank = nameMatchRank(normalizeForSearch(s.name), normQ, qTokens);
    if (!rank) continue;
    ranked.push({ s, rank });
    if (!q && ranked.length >= limit) break;
  }
  if (q) ranked.sort((a, b) => b.rank - a.rank);
  // Dedup genuine duplicate catalog listings (two separate ids both named
  // bare "Kohrra", for instance — confirmed live on this panel) that
  // slip through unrelated to onboarding: titleLangPasses above already
  // keeps a non-onboarded-language dub out, but doesn't catch a literal
  // duplicate entry in the SAME language. Keyed on (title, dub-language-
  // suffix), same as /api/search/all's eligible(), so distinct onboarded-
  // language variants of one title (bare + Hindi + Punjabi) still each
  // survive as their own result — only exact repeats collapse.
  // Movies/series: one result per TITLE (every language/quality copy folded
  // into its group, see lib/variants.js + docs/VARIANTS.md). The tile is the
  // group's primary copy (original language, best quality, non-CAM) and
  // carries the `variants` picker list. The best-ranked member places it.
  const seenDedup = new Set();
  const vEntry = variantIndexFor(mode, ix);
  const vctx = vEntry ? {
    passes: (x) => !isKidBlocked(x) && titleLangPasses(x.name),
    ...variantLangCtx(onboarded ? modeKeys.filter((k) => LANGUAGE_GROUP_KEYS_SET.has(k)) : []),
    startedIds: startedIdsFor(userState, mode),
  } : null;
  const deduped = [];
  for (const r of ranked) {
    if (deduped.length >= limit) break;
    if (vEntry) {
      const g = variantGroupOf(vEntry, r.s);
      if (seenDedup.has(g.key)) continue;
      seenDedup.add(g.key);
      const resolved = resolveGroup(g, vctx); // non-null: r.s itself passes
      deduped.push({ s: resolved.primary.s, resolved });
      continue;
    }
    const key = `${dedupTitleKey(r.s.name)}::${suffixOf(r.s.name) || "_"}`;
    if (seenDedup.has(key)) continue;
    seenDedup.add(key);
    deduped.push(r);
  }
  // Panel icon is unreliable for movie/series VOD entries (Xtream panels
  // populate stream_icon reliably for live channel logos, but frequently
  // leave it null/blank for VOD) — same reason /api/home and the detail
  // screens lean on TMDB enrichment instead. This endpoint used to skip
  // that fallback entirely, unlike /api/search/all's projectTile (which
  // already does this exact lookup), leaving movie/series search results
  // with blank thumbnails whenever the panel icon was empty. tmdbCache
  // is already warmed in-memory (prewarmTmdbCache), so this is a
  // synchronous lookup, no extra round-trip.
  const results = deduped.map(({ s, resolved }) => {
    const t = mode !== "live" ? tmdbCache[`${mode}:${s.id}`] : null;
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      poster: tilePoster(mode, s, t),
      category_id: s.category_id,
      category_name: catName.get(String(s.category_id)) || null,
      isSeriesGroup: s.isSeriesGroup || undefined,
      // Same dub-language marker /api/search/all's projectTile sets — this
      // endpoint has no dedup layer (titleLangPasses above already drops
      // non-onboarded-language dubs), but a viewer's own onboarded-
      // language variants (e.g. bare + Hindi + Punjabi) still surface
      // side by side with identical posters, so the client badge needs
      // this to tell them apart.
      dubLang: mode !== "live" ? (suffixOf(s.name) || null) : null,
      ...(mode !== "live" ? audioTileFields(s) : {}),
      ...(resolved ? tileVariantFields(resolved) : {}),
    };
  });
  if (mode === "movie" && q) { try { boostSurroundCrawl(results); } catch {} }
  // EPG programme-title pass for live — same rationale as the
  // search/all pass 3: event searches match what's AIRING, not what
  // channels are named.
  if (mode === "live" && q && results.length < limit) {
    const seen = new Set(results.map(r => r.id));
    for (const { s, programme } of searchEpgLive(normQ, qTokens, limit * 2)) {
      if (results.length >= limit) break;
      if (seen.has(s.id)) continue;
      if (!titleLangPasses(s.name)) continue;
      seen.add(s.id);
      results.push({
        id: s.id,
        name: s.name,
        icon: s.icon || null,
        category_id: s.category_id,
        category_name: catName.get(String(s.category_id)) || null,
        programme,
      });
    }
  }
  res.json({ q, count: results.length, results });
});

// Every playable copy of a title ("Watch in" picker on the detail screens):
// the same `variants` list search tiles carry, for ANY member id. Kid
// profiles only ever see kid-safe copies; a kid asking for a blocked id gets
// an empty list (nothing about the title is revealed). Contract: docs/VARIANTS.md.
app.get("/api/variants/:mode(movie|series)/:id", (req, res) => {
  const mode = req.params.mode;
  const ix = indexes[mode];
  const raw = String(req.params.id);
  const s = ix.byId.get(parseInt(raw, 10)) ?? ix.byId.get(raw);
  if (!s) return res.status(404).json({ error: "not_found" });
  const activeProfile = profiles.profiles.find((p) => p.id === req.profileId) || null;
  const userState = getProfileState(req.profileId);
  const modeKeys = profileModeKeys(userState, mode); // same keys as /api/search/:mode
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const vEntry = variantIndexFor(mode, ix);
  res.json(variantsPayload({
    mode, s,
    index: vEntry ? vEntry.vix : null,
    opts: vEntry ? vEntry.opts : variantOptsFor(mode),
    isKidBlocked: makeKidsBlocker(activeProfile),
    titleLangPasses: onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true,
    ctx: { ...variantLangCtx(onboarded ? modeKeys.filter((k) => LANGUAGE_GROUP_KEYS_SET.has(k)) : []), startedIds: startedIdsFor(userState, mode) },
  }));
});

// ── Live buffering rescue (docs/LIVE_RESCUE.md) ─────────────────────────────
// Clients report each live session's stalls / reconnects / time-to-first-
// frame; the server keeps a per-copy health score by hour of day and, when a
// client says its channel is struggling, lists the other copies of the same
// channel (same region prefix) ranked by that score. Metadata only: nothing
// here ever opens a panel connection.
const liveRescue = require("./lib/live-rescue");
const liveHealthFile = path.join(DATA_DIR, "live-health.json");
// Read a small JSON store. Missing = null. Unreadable = null too, but the bad
// file is kept as <file>.corrupt-<ts> first so the next save can't erase it.
function loadJsonStore(file, label, valid) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code !== "ENOENT") console.error(`[${label}] read ${path.basename(file)} failed: ${e.message}`);
    return null;
  }
  try {
    const d = JSON.parse(raw);
    if (valid(d)) return d;
    throw new Error("unexpected shape");
  } catch (e) {
    const bad = `${file}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(file, bad); } catch {}
    console.error(`[${label}] ${path.basename(file)} unreadable (${e.message}); kept ${path.basename(bad)}, starting empty`);
    return null;
  }
}
const liveHealth = loadJsonStore(liveHealthFile, "rescue", (d) => !!d && typeof d === "object" && !Array.isArray(d)) || {};
function pruneLiveHealth() {
  const n = liveRescue.pruneHealth(liveHealth, Date.now());
  if (n) { console.log(`[rescue] pruned ${n} faded health records`); scheduleLiveHealthSave(); }
}
let liveHealthSaveTimer = null;
function scheduleLiveHealthSave() {
  if (liveHealthSaveTimer) return;
  liveHealthSaveTimer = setTimeout(async () => {
    liveHealthSaveTimer = null;
    try {
      await fs.promises.writeFile(liveHealthFile + ".tmp", JSON.stringify(liveHealth));
      await fs.promises.rename(liveHealthFile + ".tmp", liveHealthFile);
    } catch (e) { console.warn(`save live-health failed: ${e.message}`); }
  }, 5000);
}
function flushLiveHealthSync() {
  if (!liveHealthSaveTimer) return;
  clearTimeout(liveHealthSaveTimer);
  liveHealthSaveTimer = null;
  try {
    fs.writeFileSync(liveHealthFile + ".tmp", JSON.stringify(liveHealth));
    fs.renameSync(liveHealthFile + ".tmp", liveHealthFile);
  } catch (e) { console.warn(`flush live-health failed: ${e.message}`); }
}
pruneLiveHealth();
setInterval(pruneLiveHealth, 6 * 3600e3).unref?.();
// Owner copies keyed by bare id; other accounts get an account prefix.
function liveHealthKey(actx, id) {
  if (isOwnerAccount(actx)) return String(id);
  return `${crypto.createHash("sha1").update(accountKeyOf(actx)).digest("hex").slice(0, 8)}:${id}`;
}
const liveGroupCache = new WeakMap(); // byId Map -> { size, groups, keyOfId }
function liveGroupsFor(ix) {
  const c = liveGroupCache.get(ix.byId);
  if (c && c.size === ix.byId.size) return c;
  const g = { size: ix.byId.size, ...liveRescue.buildGroups(ix.byId.values()) };
  liveGroupCache.set(ix.byId, g);
  return g;
}
// The liveness cache is keyed by bare stream id (owner panel), so only the
// owner account can use it; other accounts' ids may name different channels.
function liveDeadState(id) {
  const entry = audioCodecCache[`live:${id}`];
  if (!entry || !entry.dead) return null;
  return decideLiveHealth({ entry, now: Date.now() }).action === "unavailable" ? "unavailable" : "stale-dead";
}
const liveHealthRate = new Map(); // ownerKey -> { n, t }
app.post("/api/live/health/:id", express.json({ limit: "4kb" }), (req, res) => {
  const id = String(req.params.id);
  if (!/^\d{1,12}$/.test(id)) return res.status(400).json({ error: "bad id" });
  const actx = currentAccount();
  if (!getIndexesFor(actx).live.byId.has(parseInt(id, 10))) return res.status(404).json({ error: "not in catalog" });
  const ok = ownerKeyOf(req);
  const now = Date.now();
  const rl = liveHealthRate.get(ok);
  if (rl && now - rl.t < 60e3 && rl.n >= 30) return res.status(429).json({ error: "slow down" });
  if (!rl || now - rl.t >= 60e3) liveHealthRate.set(ok, { n: 1, t: now }); else rl.n += 1;
  if (liveHealthRate.size > 500) for (const [k, v] of liveHealthRate) if (now - v.t >= 60e3) liveHealthRate.delete(k);
  // The end of this device's live session (tile previews may run again).
  streamPreview.noteSignal(previewSignals, ok, "live-end", now);
  const report = liveRescue.sanitizeReport(req.body);
  if (!report) return res.json({ ok: true, recorded: false });
  liveRescue.recordReport(liveHealth, liveHealthKey(actx, id), report, now);
  scheduleLiveHealthSave();
  console.log(`[rescue] health live:${id} watched=${Math.round(report.watchedSec)}s stalls=${report.stalls} stallSec=${Math.round(report.stallSec)} reconn=${report.reconnects} ttff=${report.ttffMs == null ? "-" : Math.round(report.ttffMs)}${report.failed ? " failed" : ""}${req.body?.reason ? ` reason=${String(req.body.reason).slice(0, 24).replace(/[^a-z0-9_-]/gi, "")}` : ""}`);
  res.json({ ok: true, recorded: true });
});
app.get("/api/live/alternates/:id", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!/^\d{1,12}$/.test(String(req.params.id))) return res.status(400).json({ error: "bad id" });
  const idInt = parseInt(req.params.id, 10);
  const actx = currentAccount();
  const ix = getIndexesFor(actx).live;
  const cur = ix.byId.get(idInt);
  if (!cur) return res.status(404).json({ error: "not in catalog" });
  const { groups, keyOfId } = liveGroupsFor(ix);
  const key = keyOfId.get(String(idInt));
  const ids = key ? groups.get(key) || [] : [];
  const now = Date.now();
  const candidates = ids.map((i) => ix.byId.get(i)).filter(Boolean).map((s) => ({ id: s.id, name: s.name }));
  const alternates = liveRescue.rankAlternates({
    currentId: idInt,
    currentName: cur.name,
    candidates,
    health: (i) => liveRescue.scoreFor(liveHealth, liveHealthKey(actx, i), now),
    deadState: isOwnerAccount(actx) ? liveDeadState : null,
  });
  const self = liveRescue.scoreFor(liveHealth, liveHealthKey(actx, idInt), now);
  if (req.query.reason) console.log(`[rescue] alternates live:${idInt} reason=${String(req.query.reason).slice(0, 24).replace(/[^a-z0-9_-]/gi, "")} copies=${ids.length} offered=${alternates.length}${alternates[0] ? ` best=${alternates[0].id}(${alternates[0].score})` : ""}`);
  res.json({
    id: idInt,
    name: cur.name,
    score: self.score,
    floor: liveRescue.SCORE_FLOOR,
    alternates: alternates.map(({ rank, ...a }) => a),
  });
});

// ── Programme reminders (docs/REMINDERS.md) ─────────────────────────────────
// Per-profile, server-side. ~2 min before start the server pushes an HA
// notification (if configured for the profile) and open clients show a banner
// from GET /api/reminders `due`. Firing never opens a stream.
const remindersLib = require("./lib/reminders");
const remindersFile = path.join(DATA_DIR, "reminders.json");
const reminderStore = loadJsonStore(remindersFile, "reminders", (d) => !!d && Array.isArray(d.reminders))
  || { reminders: [], seenEpgBuild: 0 };
let remindersSaveTimer = null;
function scheduleRemindersSave() {
  if (remindersSaveTimer) return;
  remindersSaveTimer = setTimeout(async () => {
    remindersSaveTimer = null;
    try {
      await fs.promises.writeFile(remindersFile + ".tmp", JSON.stringify(reminderStore));
      await fs.promises.rename(remindersFile + ".tmp", remindersFile);
    } catch (e) { console.warn(`save reminders failed: ${e.message}`); }
  }, 500);
}
function flushRemindersSync() {
  if (!remindersSaveTimer) return;
  clearTimeout(remindersSaveTimer);
  remindersSaveTimer = null;
  try {
    fs.writeFileSync(remindersFile + ".tmp", JSON.stringify(reminderStore));
    fs.renameSync(remindersFile + ".tmp", remindersFile);
  } catch (e) { console.warn(`flush reminders failed: ${e.message}`); }
}
// HA push, owner household only (see remindersLib.haServiceFor):
// HA_NOTIFY_PROFILES="Kunal=mobile_app_x,Shuchi=mobile_app_y" maps one of the
// owner user's profiles (nick or id, case-insensitive) to a notify service,
// else HA_NOTIFY_SERVICE. Other users' and deleted profiles get the in-app
// banner only. No HA_URL / HA_TOKEN: in-app banners only.
function haNotifyServiceFor(r, profile) {
  return remindersLib.haServiceFor({
    reminder: r,
    profile,
    ownerUserId: ownerUser()?.id || null,
    profilesMap: process.env.HA_NOTIFY_PROFILES,
    fallback: process.env.HA_NOTIFY_SERVICE,
  });
}
async function sendHaNotify(service, title, message, tag, group = "khouch-reminders") {
  const base = String(process.env.HA_URL || "").replace(/\/+$/, "");
  const token = process.env.HA_TOKEN;
  if (!base || !token || !service || !/^[a-z0-9_]+$/.test(service)) return false;
  const r = await fetch(`${base}/api/services/notify/${service}`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, message, data: { tag, group } }),
  });
  if (!r.ok) console.warn(`[reminders] HA notify ${service} -> HTTP ${r.status}`);
  return r.ok;
}
// Guide programmes for a channel from the bulk XMLTV index (ms), or null when
// the channel has no guide data there (reminders on it are kept as set).
function reminderProgrammes(streamId) {
  const s = getIndexesFor(ownerAccount).live.byId.get(parseInt(streamId, 10));
  const chId = s?.epg_channel_id;
  if (!chId || !epgIndex.has(chId)) return null;
  return epgIndex.get(chId);
}
function liveChannelLabel(name) {
  return liveRescue.splitPrefix(name).rest.trim() || String(name || "");
}
// After each guide rebuild: follow moved programmes, drop vanished ones, and
// re-home reminders whose channel id left the catalog onto a copy of the same
// channel (same region + name).
function revalidateReminders() {
  if (reminderStore.seenEpgBuild === epgIndexBuiltAt) return;
  const ix = getIndexesFor(ownerAccount).live;
  if (!ix.ready || !epgIndexBuiltAt) return;
  let changed = false;
  let byKey = null;
  const now = Date.now();
  for (const r of reminderStore.reminders) {
    if (r.status !== "pending" || !r.owner) continue;
    if (!ix.byId.has(parseInt(r.streamId, 10))) {
      if (!byKey) byKey = liveGroupsFor(ix).byKey;
      const twinId = r.groupKey ? (byKey.get(r.groupKey) || [])[0] : null;
      if (twinId != null) {
        console.log(`[reminders] ${r.id} Channel moved live:${r.streamId} -> live:${twinId}`);
        r.streamId = String(twinId);
        r.note = "Channel moved";
      } else {
        console.log(`[reminders] ${r.id} dropped: channel live:${r.streamId} left the catalog`);
        r.status = "dropped";
        r.note = "Channel no longer available";
        changed = true;
        continue;
      }
      changed = true;
    }
    const m = remindersLib.rematch(r, reminderProgrammes(r.streamId));
    if (m.action === "move") {
      console.log(`[reminders] ${r.id} moved ${new Date(r.start).toISOString()} -> ${new Date(m.start).toISOString()}`);
      r.start = m.start; r.stop = m.stop; r.note = "Time changed";
      // Moved earlier to a time already past the late-fire window: it can't
      // fire any more, and "server was offline" would be wrong.
      if (now > r.start + remindersLib.LATE_FIRE_MS) { r.status = "missed"; r.note = "Moved earlier in the guide; already started"; }
      changed = true;
    } else if (m.action === "drop") {
      console.log(`[reminders] ${r.id} dropped: ${m.note}`);
      r.status = "dropped"; r.note = m.note;
      changed = true;
    }
  }
  reminderStore.seenEpgBuild = epgIndexBuiltAt;
  scheduleRemindersSave();
  if (changed) console.log("[reminders] revalidated after guide rebuild");
}
let remindersTicking = false;
async function remindersTick() {
  if (remindersTicking) return;
  remindersTicking = true;
  try {
    try { revalidateReminders(); } catch (e) { console.warn(`[reminders] revalidate failed: ${e.message}`); }
    const now = Date.now();
    const { fire, miss } = remindersLib.dueTransitions(reminderStore.reminders, now);
    for (const r of miss) { r.status = "missed"; r.note = "Server was offline at start time"; }
    for (const r of fire) {
      r.status = "fired";
      r.firedAt = now;
      const profile = findProfile(r.profileId);
      const svc = haNotifyServiceFor(r, profile);
      const { title, message } = remindersLib.notifyText(r, profile?.nick, now);
      let pushed = false;
      try { pushed = await sendHaNotify(svc, title, message, `khouch-reminder-${r.id}`); }
      catch (e) { console.warn(`[reminders] HA notify failed: ${e.message}`); }
      console.log(`[reminders] fired ${r.id} profile=${r.profileId} live:${r.streamId} push=${pushed ? svc : "none"}`);
    }
    const before = reminderStore.reminders.length;
    reminderStore.reminders = remindersLib.prune(reminderStore.reminders, now);
    if (fire.length || miss.length || before !== reminderStore.reminders.length) scheduleRemindersSave();
  } finally { remindersTicking = false; }
}
setInterval(() => { remindersTick().catch((e) => console.warn(`[reminders] tick failed: ${e.message}`)); }, 20_000).unref?.();

function remindersPayload(profileId) {
  const now = Date.now();
  const mine = reminderStore.reminders.filter((r) => r.profileId === profileId).sort((a, b) => a.start - b.start);
  return {
    reminders: mine.map((r) => remindersLib.publicView(r, now)),
    due: remindersLib.dueForProfile(reminderStore.reminders, profileId, now).map((r) => remindersLib.publicView(r, now)),
  };
}
app.get("/api/reminders", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!req.profileId) return res.json({ reminders: [], due: [] });
  res.json(remindersPayload(req.profileId));
});
app.post("/api/reminders", express.json({ limit: "4kb" }), (req, res) => {
  if (!req.profileId) return res.status(400).json({ error: "no profile" });
  const now = Date.now();
  const v = remindersLib.validateCreate(req.body, now);
  if (v.error) return res.status(400).json({ error: v.error });
  const actx = currentAccount();
  const s = getIndexesFor(actx).live.byId.get(parseInt(v.streamId, 10));
  if (!s) return res.status(404).json({ error: "not in catalog" });
  // Snap to the guide's own times when the bulk guide has this airing.
  if (isOwnerAccount(actx)) {
    const m = remindersLib.rematch({ title: v.title, start: v.start, stop: v.stop }, reminderProgrammes(v.streamId));
    if (m.action === "move") { v.start = m.start; v.stop = m.stop; }
  }
  const dup = remindersLib.findDuplicate(reminderStore.reminders, req.profileId, v.streamId, v.start, v.title);
  if (!dup) {
    const roomy = remindersLib.makeRoom(reminderStore.reminders, req.profileId);
    if (!roomy) return res.status(429).json({ error: "too many reminders" });
    reminderStore.reminders = roomy;
    reminderStore.reminders.push({
      id: crypto.randomBytes(6).toString("hex"),
      profileId: req.profileId,
      owner: isOwnerAccount(actx),
      streamId: v.streamId,
      groupKey: liveRescue.groupKeyOf(s),
      channel: liveChannelLabel(s.name),
      title: v.title,
      start: v.start,
      stop: v.stop,
      status: "pending",
      createdAt: now,
    });
    scheduleRemindersSave();
  }
  res.json(remindersPayload(req.profileId));
});
app.delete("/api/reminders/:id", (req, res) => {
  const i = reminderStore.reminders.findIndex((r) => r.id === req.params.id && r.profileId === req.profileId);
  if (i < 0) return res.status(404).json({ error: "not found" });
  reminderStore.reminders.splice(i, 1);
  scheduleRemindersSave();
  res.json(remindersPayload(req.profileId));
});
// Banner dismissed (OK or close) on one client: stop showing it everywhere.
app.post("/api/reminders/:id/ack", (req, res) => {
  const r = reminderStore.reminders.find((x) => x.id === req.params.id && x.profileId === req.profileId);
  if (!r) return res.status(404).json({ error: "not found" });
  if (!r.ackedAt) { r.ackedAt = Date.now(); scheduleRemindersSave(); }
  res.json(remindersPayload(req.profileId));
});

// The xtream cache (series infos included) was dropped: re-read followed
// series soon, so new-episode badges don't vanish until the next 6 h crawl.
// Polls every 2 min (up to 2 h) until the owner's series index is ready again,
// then crawls. One poller at a time.
let newEpRecrawlTimer = null;
function afterInfoCacheClear() {
  if (newEpRecrawlTimer) return;
  let tries = 0;
  const tick = () => {
    newEpRecrawlTimer = null;
    if (!getIndexesFor(ownerAccount).series?.ready && ++tries < 60) {
      newEpRecrawlTimer = setTimeout(tick, 2 * 60e3);
      newEpRecrawlTimer.unref?.();
      return;
    }
    crawlNewEpisodes("cache-clear");
  };
  newEpRecrawlTimer = setTimeout(tick, 2 * 60e3);
  newEpRecrawlTimer.unref?.();
}
// ── New episodes (lib/new-episodes.js) ──────────────────────────────────────
// Series a profile follows (a lastEpisode pointer played in the last 120 days)
// are re-read from the panel every NEW_EP_REFRESH_MS: get_series_info only,
// never a stream, one call at a time with a gap, paused while anyone watches
// (createPrewarmQueue yields on streamingNow), errors back off. Owner panel
// only. Home reads the cached infos: a "New episodes" rail + `new_episodes`
// on series tiles. Opening (GET /api/series/info) or playing the series moves
// the profile's seen mark to the last listed episode, which clears it.
const NEW_EP_REFRESH_MS = 6 * 3600e3;
function cachedSeriesInfoHit(actx, sid) {
  return cache.get(xtreamKey(actx, MODES.series.info, { series_id: String(sid) }))
    || cache.get(xtreamKey(actx, MODES.series.info, { series_id: parseInt(sid, 10) }))
    || null;
}
function cachedSeriesInfo(actx, sid) {
  const hit = cachedSeriesInfoHit(actx, sid);
  return hit && isUsableInfo(hit.v, "series") ? hit.v : null;
}
function profileAccount(p) { return getAccountForUser(getUserById(p?.ownerUserId)); }
function ownerAccountProfiles() {
  const users = new Set(accounts.users.map((u) => u.id));
  return profiles.profiles.filter((p) => (!p.ownerUserId || users.has(p.ownerUserId)) && isOwnerAccount(profileAccount(p)));
}
// The profile has now seen every episode listed in `info`.
function markSeriesSeen(userState, sid, info) {
  const m = newEpisodesLib.markFor(info);
  if (!m) return;
  userState.seriesSeen ||= {};
  const cur = userState.seriesSeen[String(sid)];
  // Only forward: an older (stale) copy must not bring seen episodes back as new.
  if (cur && (m.s < cur.s || (m.s === cur.s && m.e <= cur.e))) return;
  userState.seriesSeen = newEpisodesLib.pruneSeen({ ...userState.seriesSeen, [String(sid)]: m }, userState);
  scheduleUserStateSave();
}
// The profile played an episode of [sid]: it is followed (server-owned
// `playedAt` on its pointer: TV pointers carry no `when`, and a finished last
// episode leaves no progress) and has seen what the cached info lists.
function noteSeriesPlayed(userState, sid) {
  const le = userState.lastEpisode?.[String(sid)];
  if (le && typeof le === "object") { le.playedAt = Date.now(); scheduleUserStateSave(); }
  const info = cachedSeriesInfo(currentAccount(), sid);
  if (info) markSeriesSeen(userState, sid, info);
}
const newEpisodeTickAt = new Map(); // "profile|series" -> ms
function newEpisodeTickDue(profileId, sid) {
  const k = `${profileId}|${sid}`;
  const now = Date.now();
  if (now - (newEpisodeTickAt.get(k) || 0) < 10 * 60e3) return false;
  if (newEpisodeTickAt.size > 2000) newEpisodeTickAt.clear();
  newEpisodeTickAt.set(k, now);
  return true;
}
// First fresh read of a followed series with no mark yet: start counting
// from what the panel lists now (no flood of "new" on the first crawl).
function baselineSeriesSeen(sid, info) {
  for (const p of ownerAccountProfiles()) {
    const st = getProfileState(p.id);
    if (st.seriesSeen?.[String(sid)]) continue;
    if (!newEpisodesLib.trackedSeries(st).includes(String(sid))) continue;
    markSeriesSeen(st, sid, info);
  }
}
const newEpisodeCrawl = createPrewarmQueue({
  fetcher: async (e) => {
    const key = xtreamKey(ownerAccount, MODES.series.info, { series_id: e.sid });
    const v = await xtream(MODES.series.info, { series_id: e.sid }, { actx: ownerAccount, fresh: true, noCache: true, timeout: 30_000 });
    // An empty shell (series pulled / panel hiccup) keeps the good copy and is
    // not an error for the queue's breaker.
    if (!isUsableInfo(v, "series")) return;
    cache.set(key, { t: Date.now(), v });
    infoStore.put(key, v, "series").catch(() => {});
    baselineSeriesSeen(e.sid, v);
  },
  isCached: (e) => {
    const hit = cachedSeriesInfoHit(ownerAccount, e.sid);
    if (!hit || Date.now() - hit.t >= NEW_EP_REFRESH_MS || !isUsableInfo(hit.v, "series")) return false;
    baselineSeriesSeen(e.sid, hit.v);
    return true;
  },
  shouldYield: () => streamingNow(null),
  gapMs: 5000,
  cap: 300,
});
function crawlNewEpisodes(reason = "cron") {
  const sids = new Set();
  const catalog = getIndexesFor(ownerAccount).series?.byId;
  for (const p of ownerAccountProfiles()) {
    for (const sid of newEpisodesLib.trackedSeries(getProfileState(p.id))) {
      if (catalog?.has(parseInt(sid, 10))) sids.add(sid);
    }
  }
  const n = newEpisodeCrawl.enqueue([...sids].map((sid) => ({ key: `newep:${sid}`, sid })));
  console.log(`[new-episodes] (${reason}) ${sids.size} followed series, ${n} queued`);
}
setTimeout(() => crawlNewEpisodes("boot"), 12 * 60e3).unref?.();
setInterval(() => crawlNewEpisodes(), NEW_EP_REFRESH_MS).unref?.();
// { seriesId -> { count, first, latest, recency } } for this profile (cached infos only).
function newEpisodeMapFor(profileId) {
  const p = findProfile(profileId);
  if (!p) return new Map();
  const actx = profileAccount(p);
  if (!isOwnerAccount(actx)) return new Map();
  return newEpisodesLib.newEpisodeMap(getProfileState(profileId), (sid) => cachedSeriesInfo(actx, sid));
}

// ── "Notify me when it lands on Khouch" (lib/notify-me.js) ──────────────────
// Per profile, TMDB ids of titles not in the catalog. Matched against each
// account's catalog tmdb map (ix.byTmdb) after every variant pass (index
// build / TMDB backfill) and every 30 min. A match: HA push (owner household
// rule, same as reminders) + the "Now on Khouch" home rail.
function catalogLookupFor(actx) {
  const ixs = getIndexesFor(actx);
  return (kind, tmdbId) => {
    const mode = notifyMeLib.modeOfKind(kind);
    // A panel title matched to the other TMDB kind (tmdb_kind) shares the id space only by accident.
    const want = kind === "tv" ? "series" : "movie";
    const members = (ixs[mode]?.byTmdb?.get(tmdbId) || [])
      .filter((m) => (tmdbCache[`${mode}:${m.id}`]?.tmdb_kind || mode) === want);
    if (!members.length) return null;
    const s = members.find((m) => !m.isAlt) || members[0];
    return { mode, id: s.id };
  };
}
let notifyMeChecking = false;
let notifyMeRerun = false;
async function checkNotifyMe(reason = "cron") {
  if (notifyMeChecking) { notifyMeRerun = true; return; }
  notifyMeChecking = true;
  try {
    const now = Date.now();
    for (const p of profiles.profiles) {
      if (p.kidsBirthYear) continue;
      const st = getProfileState(p.id);
      if (!Array.isArray(st.notifyMe) || !st.notifyMe.length) continue;
      const actx = profileAccount(p);
      const before = st.notifyMe.length;
      st.notifyMe = notifyMeLib.prune(st.notifyMe, now);
      const landed = notifyMeLib.match(st.notifyMe, catalogLookupFor(actx), now);
      if (landed.length || before !== st.notifyMe.length) scheduleUserStateSave();
      for (const e of landed) {
        const svc = haNotifyServiceFor({ owner: isOwnerAccount(actx), profileId: p.id }, p);
        const { title, message } = notifyMeLib.notifyText(e, p.nick);
        let pushed = false;
        if (svc) {
          try { pushed = await sendHaNotify(svc, title, message, `khouch-notify-${e.kind}-${e.tmdb_id}`, "khouch-notify"); }
          catch (err) { console.warn(`[notify-me] HA notify failed: ${err.message}`); }
        }
        console.log(`[notify-me] (${reason}) landed ${e.kind}:${e.tmdb_id} -> ${e.landed.mode}:${e.landed.id} profile=${p.id} push=${pushed ? svc : "none"}`);
      }
    }
  } finally {
    notifyMeChecking = false;
    if (notifyMeRerun) { notifyMeRerun = false; scheduleNotifyMeCheck("rerun"); }
  }
}
let notifyMeCheckTimer = null;
function scheduleNotifyMeCheck(reason) {
  if (notifyMeCheckTimer) return;
  notifyMeCheckTimer = setTimeout(() => {
    notifyMeCheckTimer = null;
    checkNotifyMe(reason).catch((e) => console.warn(`[notify-me] ${e.message}`));
  }, 5000);
  notifyMeCheckTimer.unref?.();
}
setInterval(() => scheduleNotifyMeCheck("cron"), 30 * 60e3).unref?.();
const isKidProfile = (profileId) => !!findProfile(profileId)?.kidsBirthYear;
function notifyMePayload(profileId) {
  const st = getProfileState(profileId);
  return { items: (st.notifyMe || []).map(notifyMeLib.publicView) };
}
app.get("/api/notify-me", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!req.profileId || isKidProfile(req.profileId)) return res.json({ items: [] });
  res.json(notifyMePayload(req.profileId));
});
app.post("/api/notify-me", express.json({ limit: "4kb" }), (req, res) => {
  if (!req.profileId) return res.status(400).json({ error: "no profile" });
  if (isKidProfile(req.profileId)) return res.status(403).json({ error: "not for kid profiles" });
  const v = notifyMeLib.validateAdd(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const hit = catalogLookupFor(currentAccount())(v.kind, v.tmdb_id);
  if (hit) return res.status(409).json({ error: "in_catalog", mode: hit.mode, id: hit.id });
  const st = getProfileState(req.profileId);
  const next = notifyMeLib.add(st.notifyMe, v);
  if (!next) return res.status(429).json({ error: "too many titles" });
  st.notifyMe = next;
  scheduleUserStateSave();
  res.json(notifyMePayload(req.profileId));
});
app.delete("/api/notify-me/:kind(movie|tv)/:tmdbId(\\d{1,10})", (req, res) => {
  if (!req.profileId) return res.status(400).json({ error: "no profile" });
  const st = getProfileState(req.profileId);
  st.notifyMe = notifyMeLib.remove(st.notifyMe, req.params.kind, Number(req.params.tmdbId));
  scheduleUserStateSave();
  res.json(notifyMePayload(req.profileId));
});

// A title by TMDB id, for clients showing something the catalog may not have
// (search "Not on Khouch yet", person credits). `in_catalog` = open that
// instead; `notify` = on this profile's Notify-me list. Adult profiles only.
const tmdbCardOf = (kind, r) => {
  const date = String((kind === "movie" ? r.release_date : r.first_air_date) || "");
  return {
    tmdb_id: r.id,
    kind,
    title: (kind === "movie" ? r.title : r.name) || r.original_title || r.original_name || "",
    year: date.slice(0, 4) || null,
    date: date || null,
    poster: r.poster_path ? `${TMDB_IMG_BASE}/w342${r.poster_path}` : null,
    backdrop: r.backdrop_path ? `${TMDB_IMG_BASE}/w1280${r.backdrop_path}` : null,
    overview: String(r.overview || "").slice(0, 600) || null,
    rating: Number.isFinite(r.vote_average) && r.vote_count >= 20 ? Math.round(r.vote_average * 10) / 10 : null,
  };
};
app.get("/api/tmdb-title/:kind(movie|tv)/:tmdbId(\\d{1,10})", async (req, res, next) => {
  try {
    if (isKidProfile(req.profileId)) return res.status(403).json({ error: "not for kid profiles" });
    if (!TMDB_API_KEY) return res.status(404).json({ error: "tmdb_unavailable" });
    const { kind } = req.params;
    const tmdbId = Number(req.params.tmdbId);
    const d = await tmdb(`/${kind}/${tmdbId}`);
    if (!d || !d.id) return res.status(404).json({ error: "not_found" });
    const card = tmdbCardOf(kind, d);
    const st = getProfileState(req.profileId);
    res.set("Cache-Control", "no-store");
    res.json({
      ...card,
      genres: Array.isArray(d.genres) ? d.genres.map((g) => g.name).filter(Boolean).slice(0, 4) : [],
      runtime: kind === "movie" ? d.runtime || null : (Array.isArray(d.episode_run_time) && d.episode_run_time[0]) || null,
      seasons: kind === "tv" ? d.number_of_seasons || null : null,
      in_catalog: catalogLookupFor(currentAccount())(kind, tmdbId),
      notify: (st.notifyMe || []).some((e) => e.kind === kind && e.tmdb_id === tmdbId && !e.landed),
    });
  } catch (e) { next(e); }
});
// TMDB search for titles the catalog does not have (movies + shows, top 10).
app.get("/api/search/elsewhere", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q.length < 2 || !TMDB_API_KEY || isKidProfile(req.profileId)) return res.json({ q, results: [] });
    const r = await tmdb("/search/multi", { query: q, include_adult: "false" });
    const lookup = catalogLookupFor(currentAccount());
    const st = getProfileState(req.profileId);
    const results = [];
    for (const x of r?.results || []) {
      if (x.media_type !== "movie" && x.media_type !== "tv") continue;
      if (x.adult || !x.poster_path || lookup(x.media_type, x.id)) continue;
      const card = tmdbCardOf(x.media_type, x);
      card.notify = (st.notifyMe || []).some((e) => e.kind === card.kind && e.tmdb_id === card.tmdb_id && !e.landed);
      results.push(card);
      if (results.length >= 10) break;
    }
    res.set("Cache-Control", "no-store");
    res.json({ q, results });
  } catch (e) { next(e); }
});

// EPG: programs for a live channel in a time window. Used by the
// TV-Guide view (lazy-loaded per visible channel) and the "Now playing"
// badge on live rail cards.
//
// Source: the panel's `get_simple_data_table` action returns the full
// week-ahead EPG (often 50–80 entries). The legacy `get_short_epg`
// action returned just 1–2 entries on many channels — that's why the
// guide grid looked starved. We slice server-side to the requested
// window so payloads stay small (~3–6 entries per channel, ~600 bytes).
//
// Titles and descriptions come back base64-encoded from the panel; we
// decode them here so clients get clean JSON. xtream() caches for 24h
// and dedupes concurrent identical requests, so heavy bursts from the
// guide grid hit the panel at most once per channel per day.
app.get("/api/epg/short/:streamId", async (req, res, next) => {
  try {
    const streamId = req.params.streamId;
    // Window: 1h-back / Nh-forward. Default N = 5h (matches the
    // userState default); client can override via ?hours=N or its
    // saved epgWindowHoursForward preference. Capped at 24h.
    const hours  = Math.min(Math.max(parseInt(req.query.hours, 10) || 3, 1), 24);
    const nowSec = Math.floor(Date.now() / 1000);
    const fromSec = nowSec - 3600;
    const toSec   = nowSec + hours * 3600;

    // 1) Try the xmltv bulk index first. One-time nightly fetch
    // populated this; subsequent reads are pure in-memory slices.
    const stream = indexes.live.byId.get(parseInt(streamId, 10))
                || indexes.live.byId.get(streamId);
    const chId = stream?.epg_channel_id;
    const epgByChannel = isOwnerAccount(currentAccount())
      ? epgIndex
      : getEpgIndexFor(currentAccount()).byChannel;
    if (chId && epgByChannel.has(chId)) {
      const all = epgByChannel.get(chId);
      const fromMs = fromSec * 1000;
      const toMs   = toSec   * 1000;
      const out = [];
      for (const p of all) {
        if (p.stop <= fromMs) continue;
        if (p.start >= toMs)  break; // array is sorted by start
        out.push({
          title:       p.title || "",
          description: p.desc  || "",
          start_ts:    Math.floor(p.start / 1000),
          stop_ts:     Math.floor(p.stop  / 1000),
        });
      }
      return res.json({ stream_id: streamId, programs: out, source: "xmltv" });
    }

    // 2) Fallback — per-channel panel fetch. Still cached by xtream()
    // for 24h + deduped, so heavy bursts from the guide grid hit the
    // panel at most once per channel per day.
    const v = await xtream("get_simple_data_table", { stream_id: streamId });
    const list = Array.isArray(v?.epg_listings) ? v.epg_listings
               : Array.isArray(v) ? v
               : [];
    const decode = (s) => {
      if (!s) return "";
      try { return Buffer.from(String(s), "base64").toString("utf8"); }
      catch { return String(s); }
    };
    const rows = list
      .map(p => ({
        title: decode(p.title),
        desc:  decode(p.description),
        start: (Number(p.start_timestamp) || (p.start ? Math.floor(new Date(p.start).getTime() / 1000) : 0)) * 1000,
        stop:  (Number(p.stop_timestamp)  || (p.end   ? Math.floor(new Date(p.end).getTime()   / 1000) : 0)) * 1000,
      }))
      .filter(p => p.start && p.stop);
    // Same shift + overlap cleanup the bulk index gets (lib/epg-clean.js).
    // Calibration is measured on the owner's panel only; other accounts get overlap cleanup but no shift.
    const owner = isOwnerAccount(currentAccount());
    const out = fixPanelPrograms(rows, chId, owner ? epgStatus.calibration?.groups : null, "provider", epgStatus.calibration?.zeroIds)
      .filter(p => p.stop > fromSec * 1000 && p.start < toSec * 1000)
      .sort((a, b) => a.start - b.start)
      .map(p => ({ title: p.title, description: p.desc, start_ts: Math.floor(p.start / 1000), stop_ts: Math.floor(p.stop / 1000) }));
    res.json({ stream_id: streamId, programs: out, source: "panel" });
  } catch (e) { next(e); }
});

app.get("/api/:mode(live|movie|series|disk)/streams", async (req, res, next) => {
  try {
    const mode = req.params.mode;
    const ix = indexes[mode];
    const catId = req.query.category_id ? String(req.query.category_id) : null;
    // TMDB poster wins whenever a match exists — mirroring /api/home's
    // tileFor (poster is TMDB-first, icon is only the fallback) and the
    // client's own toStream() convention (`icon = poster ?: icon`).
    // This is NOT just "fill in a blank icon": disk's raw `icon` is
    // frequently a same-origin-relative sidecar path
    // (`/api/diskart/<id>/poster`) that a browser resolves fine against
    // its own origin but Android's Coil can't load at all (no base URL
    // to resolve against) — so a disk item can have a perfectly
    // "present" icon that's still unusable client-side. Every other
    // read path (/api/home, /api/search/:mode) already prefers TMDB for
    // exactly this reason; this endpoint was the one place that didn't,
    // which is why "See All" on a disk category showed 400+ blank tiles
    // even though every item technically had a non-null `icon`.
    const withPosterFallback = (s) => {
      if (mode === "live") return s;
      const t = tmdbCache[`${mode}:${s.id}`];
      if (!t?.poster_path) return s;
      return { ...s, icon: `${TMDB_IMG_BASE}/w342${t.poster_path}` };
    };
    // Optional offset/limit — opt-in only. Without `limit` the response
    // stays a bare array (unchanged), which the Android app's
    // streamsByCategory() depends on (it deserializes straight to
    // List<Stream> and would hard-fail on an object response). Large
    // categories otherwise force one big JSON.stringify that blocks the
    // event loop for every connected client, not just the requester.
    const hasPaging = req.query.limit !== undefined;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    // Sort BEFORE slicing so paginated pages are globally ordered (the
    // client can no longer sort a fully-resident catalog for VOD). Keys
    // mirror the web client's applySort exactly. Client-only sorts
    // (lastPlayed) are absent here and stay client-side. No sort key →
    // index order (unchanged).
    const SORT_KEYS = {
      name:   (s) => (s.name || "").toLowerCase(),
      added:  (s) => Number(s.added) || 0,
      rating: (s) => parseFloat(s.rating) || 0,
      year:   (s) => parseInt(s.year, 10) || 0,
    };
    const sortKey = Object.hasOwn(SORT_KEYS, req.query.sort) ? SORT_KEYS[req.query.sort] : null;
    const sortSign = req.query.dir === "desc" ? -1 : 1;
    const sortForPage = (arr) => {
      if (!sortKey) return arr;
      return [...arr].sort((a, b) => {
        const ka = sortKey(a), kb = sortKey(b);
        return ka < kb ? -sortSign : ka > kb ? sortSign : 0;
      });
    };

    // Prefer the in-memory index (already built and persisted). Per-category
    // panel queries can return non-array bodies under load — typically right
    // after a container restart while the panel rate-limits fresh traffic.
    if (ix.ready && ix.byId.size > 0) {
      const all = [...ix.byId.values()];
      const userState = getProfileState(req.profileId);
      const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
      const modeKeys = (() => {
        const own = userState.filter?.groups?.[mode];
        if (Array.isArray(own) && own.length) return own;
        return userState.filter?.groups?.live || [];
      })();
      const onboarded = mode !== "disk" && !!userState.filter?.onboarded && modeKeys.length > 0;
      const titleLangPasses = onboarded
        ? makeTitleLangFilter(new Set(modeKeys))
        : () => true;
      const isKidBlocked = mode === "live" ? () => false : makeKidsBlocker(activeProfile);
      // Unscoped calls (no category_id — used for the "All" pseudo-category)
      // must also apply the onboarding CATEGORY allow-list, not just the
      // title-keyword block-list above. Mirrors /api/home's allowedCatIds
      // (homeGroupKeysOf + loadCategoriesFromDiskSync) — without this, "All"
      // would silently include categories the user excluded during
      // onboarding. Category-scoped calls (the normal grid path) are
      // unaffected since the caller already picked a specific category.
      const allowedCatIds = (!catId && onboarded) ? (() => {
        const set = new Set();
        for (const c of loadCategoriesFromDiskSync(mode)) {
          if (homeGroupKeysOf(c.category_name).some(k => modeKeys.includes(k))) set.add(String(c.category_id));
        }
        return set;
      })() : null;
      const catFiltered = catId
        ? all.filter(s => s.category_id === catId)
        : (allowedCatIds ? all.filter(s => allowedCatIds.has(String(s.category_id))) : all);
      const seenTmdb = new Set();
      const seenTitle = new Set();
      const deduped = catFiltered.filter(s => {
        if (!titleLangPasses(s.name)) return false;
        if (isKidBlocked(s)) return false;
        // Title+year fallback catches the twin BEFORE it ever gets a
        // tmdb_id to collide on (see dedupTitleKey) — checked first so
        // an un-enriched duplicate of an already-kept enriched item is
        // rejected too, not just the reverse.
        const titleKey = dedupKeyOf(s);
        if (titleKey && seenTitle.has(titleKey)) return false;
        if (s.tmdb_id) {
          if (seenTmdb.has(s.tmdb_id)) return false;
          seenTmdb.add(s.tmdb_id);
        }
        if (titleKey) seenTitle.add(titleKey);
        return true;
      });
      if (hasPaging) {
        const sorted = sortForPage(deduped);
        const total = sorted.length;
        const items = sorted.slice(offset, offset + limit).map(withPosterFallback);
        return res.json({ items, total, hasMore: offset + items.length < total });
      }
      return res.json(deduped.map(withPosterFallback));
    }

    const m = MODES[mode];
    const v = await xtream(m.list, catId ? { category_id: catId } : {});
    if (!Array.isArray(v)) {
      console.warn(`[streams] panel returned non-array for ${mode} cat=${catId}: ${typeof v}`);
      return res.json(hasPaging ? { items: [], total: 0, hasMore: false } : []);
    }
    const mapped = v.map(s => projectStream(mode, s));
    if (hasPaging) {
      const sorted = sortForPage(mapped);
      const total = sorted.length;
      const items = sorted.slice(offset, offset + limit).map(withPosterFallback);
      return res.json({ items, total, hasMore: offset + items.length < total });
    }
    res.json(mapped.map(withPosterFallback));
  } catch (e) { next(e); }
});

// Single-item lookup. Replaces the TV app's pattern of downloading the
// full /api/index/{mode} (15 MB for movies) just to populate a detail
// screen's title / icon / tags before the /api/poster TMDB enrichment
// arrives. Served straight from the in-memory index — when it's still
// building, returns 503 and the client retries via /api/poster only.
app.get("/api/:mode(live|movie|series|disk)/item/:id", (req, res) => {
  const { mode, id } = req.params;
  const ix = indexes[mode];
  if (!ix?.ready || ix.byId.size === 0) return res.status(503).json({ error: "index not ready" });
  const numId = parseInt(id, 10);
  const item = ix.byId.get(numId) || ix.byId.get(id);
  if (!item) return res.status(404).json({ error: "not found" });
  // Same TTL window as the other detail endpoints so the TV's OkHttp
  // cache picks it up across restarts.
  res.set("Cache-Control", "private, max-age=600");
  res.json(item);
});

app.get("/api/:mode(movie|series)/info/:id", async (req, res, next) => {
  try {
    const mode = req.params.mode;
    const m = MODES[mode];
    const key = mode === "series" ? "series_id" : "vod_id";
    // Stale-if-error: a panel 500/timeout serves the last good copy
    // (in-memory even past TTL, else disk) instead of failing the detail
    // screen; with no copy at all it's a fast structured 503.
    const actx = currentAccount();
    const params = { [key]: req.params.id };
    const cacheKey = xtreamKey(actx, m.info, params);
    // Snapshot BEFORE the live call: xtream() caches whatever the panel
    // returns, so a degraded shell could otherwise replace the good copy.
    const entryBefore = cache.get(cacheKey);
    let r;
    try {
      r = await getInfoStaleIfError({
        key: cacheKey,
        mode,
        // The cap is enforced here, not only via xtream's own timeout:
        // xtream dedupes in-flight calls, so this may join a 90 s prewarm.
        fetchLive: () => xtream(m.info, params, { actx, timeout: INFO_PANEL_TIMEOUT_MS }),
        timeoutMs: INFO_PANEL_TIMEOUT_MS,
        memStale: entryBefore?.v,
        // Don't pin an empty/degraded answer in the 24 h cache: put the
        // previous good entry back (keeping its age, so it's refetched
        // next time), else drop the shell.
        onUnusableLive: () => {
          if (entryBefore && isUsableInfo(entryBefore.v, mode)) cache.set(cacheKey, entryBefore);
          else cache.delete(cacheKey);
        },
        store: infoStore,
        onStale: (s, err) => console.warn(`[info] ${mode} ${req.params.id}: panel failed (${redactAllUrls(err && err.message)}); serving stale ${s.source} copy`),
      });
    } catch (e) {
      if (e && e.code === "info_unavailable") {
        console.warn(`[info] ${mode} ${req.params.id}: unavailable (${redactAllUrls(e.cause && e.cause.message)})`);
        res.set({ "Cache-Control": "no-store", "Retry-After": "30" });
        return res.status(503).json({ error: "info_unavailable" });
      }
      throw e;
    }
    const v = r.v;
    // Opening a series clears its "new episode" badge for this profile.
    if (mode === "series" && req.profileId && !r.stale && !req.get("x-khouch-internal")) markSeriesSeen(getProfileState(req.profileId), req.params.id, v);
    if (r.stale) {
      // Short client cache so a recovered panel is picked up soon.
      res.set({ "Cache-Control": "private, max-age=60", "X-Khouch-Stale": "1" });
      return res.json(v);
    }
    // Opportunistic TMDB shortcut: panel ships info.tmdb_id alongside
    // VOD / series detail. Caching it here means the next ensureTmdb
    // for this item (poster / kids cert lookup) skips the title-search
    // round-trip and goes straight to the TMDB detail fetch. Best-
    // effort — failures are swallowed.
    const panelTmdbId = v && v.info && v.info.tmdb_id ? Number(v.info.tmdb_id) : null;
    if (panelTmdbId && TMDB_API_KEY) {
      const cacheKey = `${mode}:${req.params.id}`;
      const existing = tmdbCache[cacheKey];
      const haveGoodEntry = existing && existing.source === "tmdb" && existing.tmdb_id;
      if (!haveGoodEntry) {
        const item = indexes[mode]?.byId?.get(parseInt(req.params.id, 10))
                  || indexes[mode]?.byId?.get(req.params.id);
        ensureTmdbForItem(mode, req.params.id, {
          name: item?.name,
          year: item?.year,
          lang: isoLangForItem(item),
          tmdbId: panelTmdbId,
        }).catch(() => {});
      }
    }
    // Opportunistic audio + resolution cache: we already paid the
    // vod_info round-trip, so record the audio/video metadata (qualityCache,
    // in-memory index patch) for the 5.1 / 7.1 badges. Series: per-series
    // audio summary over the episodes (owner panel only).
    if (mode === "movie" && v?.info && isOwnerAccount(actx)) recordPanelVodInfo(req.params.id, v.info);
    if (mode === "series" && v?.episodes) noteSeriesAudio(req.params.id, v, actx);
    // Panel mpaa_rating fallback. TMDB sometimes returns a tmdb_id with
    // an empty us_cert (no rating data on TMDB's side). The panel
    // itself often carries the original MPAA / TV rating in
    // info.mpaa_rating — when we have nothing better, write it into
    // the cache so the kids-cert filter has something to work with.
    const panelCert = v && v.info && typeof v.info.mpaa_rating === "string"
      ? v.info.mpaa_rating.trim().toUpperCase().replace(/\s+/g, "-")
      : "";
    if (panelCert && mode === "movie") {
      const cacheKey = `${mode}:${req.params.id}`;
      const existing = tmdbCache[cacheKey];
      // Only fill the gap — never overwrite a TMDB-derived cert.
      if (existing && existing.source === "tmdb" && !existing.us_cert) {
        existing.us_cert = panelCert;
        scheduleTmdbCacheSave();
      }
    }
    // 10 min cache — panel info (seasons/episodes, mpaa, duration) is
    // stable. Lets the TV app's OkHttp cache short-circuit repeat opens.
    res.set("Cache-Control", "private, max-age=600");
    res.json(v);
  } catch (e) { next(e); }
});

// ---- Subtitles (OpenSubtitles, lazy + disk-cached; see lib/subtitles.js) ----
const subtitleSvc = require("./lib/subtitles").createSubtitleService({ dataDir: DATA_DIR });
function subtitleCtx(req, mode, id) {
  // Series ids are series ids; the episode comes from ?season=&episode=.
  if (mode !== "series") return { mode, id };
  const season = String(req.query.season ?? ""), episode = String(req.query.episode ?? "");
  if (!/^\d{1,4}$/.test(season) || !/^\d{1,5}$/.test(episode)) return null;
  return { mode, id, season, episode };
}
const subtitleQs = (c) => (c.mode === "series" ? `?season=${c.season}&episode=${c.episode}` : "");
const subtitleEntries = (c) => subtitleSvc.listLangs(c).map((lang) => ({ lang, label: subtitleSvc.LANGS[lang], url: `/api/subtitles/${c.mode}/${c.id}/${lang}.vtt${subtitleQs(c)}`, cached: subtitleSvc.isCached({ ...c, lang }) }));
async function subtitleTmdb(mode, id) {
  const numId = parseInt(id, 10);
  const item = indexes[mode]?.byId.get(numId) || indexes[mode]?.byId.get(id);
  if (!item) return null;
  const entry = await ensureTmdbForItem(mode, id, { name: item.name, year: item.year, lang: isoLangForItem(item), forcedKind: item.isSeriesGroup ? "series" : undefined });
  if (!entry || entry.source !== "tmdb" || !entry.tmdb_id) return null;
  // tmdb_id of a movie vs a TV show differ; never feed one into the other's search.
  // (tmdb_kind "series" marks a movie-mode item that resolved to a TV show.)
  if (mode === "movie" && entry.tmdb_kind === "series") return null;
  return entry;
}
app.get("/api/subtitles/:mode(movie|series)/:id(\\d{1,12})", async (req, res, next) => {
  try {
    const c = subtitleCtx(req, req.params.mode, req.params.id);
    const entry = c && TMDB_API_KEY && subtitleSvc.enabled() ? await subtitleTmdb(c.mode, c.id) : null;
    const list = entry ? subtitleEntries(c) : [];
    res.set("Cache-Control", list.length ? "private, max-age=300" : "no-store");
    res.json(list);
  } catch (e) { next(e); }
});
app.get("/api/subtitles/:mode(movie|series)/:id(\\d{1,12})/:lang(en|hi).vtt", async (req, res, next) => {
  try {
    const none = () => { res.set("Cache-Control", "no-store"); return res.status(404).json({ error: "no subtitles" }); };
    const c = subtitleCtx(req, req.params.mode, req.params.id);
    if (!c) return none();
    const entry = await subtitleTmdb(c.mode, c.id);
    if (!entry) return none();
    const file = await subtitleSvc.getVtt({ ...c, lang: req.params.lang, tmdbId: entry.tmdb_id, year: entry.year });
    if (!file) return none();
    res.set("Cache-Control", "private, max-age=86400");
    res.type("text/vtt; charset=utf-8");
    res.sendFile(path.resolve(file));
  } catch (e) {
    if (e && e.busy) { res.set({ "Retry-After": String(e.retryAfter || 10), "Cache-Control": "no-store" }); return res.status(503).json({ error: "busy" }); }
    next(e);
  }
});

// TMDB poster + metadata for a movie or series. Returns null TMDB
// fields when no key is configured or when nothing matches — the
// client falls back to the panel artwork in either case. We pull the
// panel name+year from the in-memory index so the lookup happens
// server-side without the client needing to know the title.
// Fill a missing `logo` on demand (one images call per tmdb_id, never more
// than one in flight per id and at most one lazy call per 300 ms globally),
// so a title someone is looking at doesn't wait for the cron backfill.
const logoGate = createLazyGate();
let logoSaveTimer = null;
async function lazyFillLogo(key, entry) {
  if (!entry || entry.source !== "tmdb" || !entry.tmdb_id || "logo" in entry) return;
  // disk: entries are movie-shaped unless stamped tmdb_kind "series" (entryKind).
  const kind = entryKind(key, entry) || (key.startsWith("disk:") ? "movie" : null);
  if (!kind) return;
  const fid = `${kind}:${entry.tmdb_id}`;
  if (!logoGate.tryStart(fid)) return;
  const res = await tmdbRaw(`/${kind === "series" ? "tv" : "movie"}/${entry.tmdb_id}/images?include_image_language=en,null`);
  if (res === null) { logoGate.fail(fid); return; }
  logoGate.done(fid);
  applyLogo(entry, { images: res });
  const raw = tmdbCache[key];
  if (raw && raw !== entry && raw.source === "tmdb" && raw.tmdb_id === entry.tmdb_id) applyLogo(raw, { images: res });
  // Coalesced persist: the store is huge, so never save per fill.
  if (!logoSaveTimer) {
    logoSaveTimer = setTimeout(() => { logoSaveTimer = null; scheduleTmdbCacheSave(); }, 45_000);
    logoSaveTimer.unref?.();
  }
}
app.get("/api/poster/:mode(movie|series|disk)/:id", async (req, res, next) => {
  try {
    if (!TMDB_API_KEY) return res.json(tmdbToResponse(null));
    const { mode, id } = req.params;
    const numId = parseInt(id, 10);
    const item = (indexes[mode].byId.get(numId) || indexes[mode].byId.get(id));
    if (!item) return res.status(404).json({ error: "unknown id" });
    const entry = await ensureTmdbForItem(mode, id, { name: item.name, year: item.year, lang: isoLangForItem(item), forcedKind: item.isSeriesGroup ? "series" : undefined });
    // 10 min cache — TMDB metadata changes slowly and the TV app's
    // OkHttp disk cache picks this up to avoid network round-trips
    // when the user re-opens the same title.
    res.set("Cache-Control", "private, max-age=600");
    // On demand: wait briefly (<=1 s) so a title being opened shows its logo the first time;
    // a slower TMDB call finishes in the background and shows on the next fetch.
    await Promise.race([lazyFillLogo(`${mode}:${id}`, entry).catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
    const out = tmdbToResponse(entry);
    if (out) {
      // Additive detail fields: collection art/size + trailer preview URLs.
      if (mode === "movie" && out.collection && Number.isFinite(Number(out.collection.id))) {
        // Library-wide title count, not profile-gated: this response is
        // HTTP-cached per URL across profile switches. The collection page
        // applies the profile's gate.
        const col = movieCollectionIndex().get(Number(out.collection.id));
        const n = col ? new Set(col.members.map((m) => m.t.tmdb_id)).size : 0;
        out.collection = {
          ...out.collection,
          poster: out.collection.poster_path ? `${TMDB_IMG_BASE}/w342${out.collection.poster_path}` : null,
          backdrop: out.collection.backdrop_path ? `${TMDB_IMG_BASE}/w1280${out.collection.backdrop_path}` : null,
          count: n,
          url: n >= 2 ? `/api/collections/${out.collection.id}` : null,
        };
      }
      Object.assign(out, trailerFieldsFor(out.trailer_key));
      // Surround badge for the detail meta line (null fields = unknown).
      Object.assign(out, detailAudioFields(mode, item));
    }
    res.json(out);
  } catch (e) { next(e); }
});

// TMDB episode stills for a series's season. We look up the series's
// tmdb_id (calling ensureTmdbForItem if needed), fetch the season
// detail, and project a { panel_episode_id → still URL } map by
// matching `episode_number`. Cached under series-season:<id>:<n>.
app.get("/api/poster/series/:id/season/:n", async (req, res, next) => {
  try {
    if (!TMDB_API_KEY) return res.json({ stills: {} });
    const seriesId = req.params.id;
    const seasonNum = parseInt(req.params.n, 10);
    if (!Number.isFinite(seasonNum)) return res.status(400).json({ error: "bad season" });
    const cacheKey = `series-season:${seriesId}:${seasonNum}`;
    const cached = tmdbCache[cacheKey];
    if (cached && cached.fetched_at && (Date.now() - cached.fetched_at) < TMDB_TTL_MS) {
      return res.json({ stills: cached.stills || {} });
    }
    // Resolve the series's tmdb_id first.
    const seriesItem = indexes.series.byId.get(parseInt(seriesId, 10))
                    || indexes.series.byId.get(seriesId);
    if (!seriesItem) return res.status(404).json({ error: "unknown series" });
    const seriesEntry = await ensureTmdbForItem("series", seriesId, { name: seriesItem.name, year: seriesItem.year, lang: isoLangForItem(seriesItem) });
    if (!seriesEntry || !seriesEntry.tmdb_id) return res.json({ stills: {} });
    // Pull panel episode list to build the panel_ep_id → episode_number map.
    const panelInfo = await xtream(MODES.series.info, { series_id: seriesId });
    const panelEpisodes = panelInfo && panelInfo.episodes && panelInfo.episodes[String(seasonNum)];
    if (!Array.isArray(panelEpisodes) || !panelEpisodes.length) return res.json({ stills: {} });
    const tmdbSeason = await tmdb(`/tv/${seriesEntry.tmdb_id}/season/${seasonNum}`);
    const tmdbEps = tmdbSeason && Array.isArray(tmdbSeason.episodes) ? tmdbSeason.episodes : [];
    const byNum = new Map();
    for (const e of tmdbEps) byNum.set(e.episode_number, e.still_path);
    const stills = {};
    for (const ep of panelEpisodes) {
      const still = byNum.get(Number(ep.episode_num));
      if (still) stills[String(ep.id)] = `${TMDB_IMG_BASE}/w400${still}`;
    }
    tmdbCache[cacheKey] = { fetched_at: Date.now(), stills };
    scheduleTmdbCacheSave();
    res.json({ stills });
  } catch (e) { next(e); }
});

// Episodes of a series with TMDB stills and THIS profile's progress, for the
// series page (additive; /api/series/info/:id is unchanged). Panel series:
// :id is the series id; disk: the disk series-group id. no-store (progress).
//   { id, mode, tmdb_id, seasons: [{ season, episodes: [{ id, episode_num,
//     title, plot, air_date, duration_secs, container, still,
//     progress: { position, duration, pct, updated_at } | null, watched }] }],
//     last_episode: { episode_id, season, episode_num } | null }
// All seasons fetched in parallel (tmdb() is memory-cached 24 h and
// single-flight), under ONE overall deadline; late seasons get no stills.
// Each season -> { eps: Map<episode_number, tmdbEpisode>, alt: Map (original-
// language copy, lib/episode-info FALLBACK_LANGS only), season: seasonExtras }.
async function tmdbSeasonsEpisodes(tmdbId, seasonNums, timeoutMs = 6000, originalLanguage = null) {
  const out = new Map();
  if (!TMDB_API_KEY || !tmdbId) return out;
  const nums = [...new Set(seasonNums.filter(Number.isFinite))].slice(0, 60);
  let timer;
  const done = Promise.all(nums.map(async (n) => { out.set(n, await tmdbSeasonEpisodes(tmdbId, n, originalLanguage)); }));
  await Promise.race([done, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
  clearTimeout(timer);
  return new Map(out); // snapshot: late seasons don't land after the deadline
}
const EMPTY_TMDB_SEASON = Object.freeze({ eps: new Map(), alt: new Map(), season: {} });
function tmdbEpisodeMap(d) {
  const out = new Map();
  for (const e of (d && Array.isArray(d.episodes) ? d.episodes : [])) {
    if (e && Number.isFinite(e.episode_number)) out.set(e.episode_number, e);
  }
  return out;
}
async function tmdbSeasonEpisodes(tmdbId, seasonNum, originalLanguage = null) {
  if (!TMDB_API_KEY || !tmdbId || !Number.isFinite(seasonNum)) return EMPTY_TMDB_SEASON;
  // tmdb() caches each URL in memory for 24 h and single-flights it, so this
  // is one TMDB call per season per day (two with the language fallback).
  const d = await tmdb(`/tv/${tmdbId}/season/${seasonNum}`).catch(() => null);
  const alt = episodeInfoLib.needsLangFallback(d, originalLanguage)
    ? await tmdb(`/tv/${tmdbId}/season/${seasonNum}`, { language: originalLanguage }).catch(() => null)
    : null;
  return { eps: tmdbEpisodeMap(d), alt: tmdbEpisodeMap(alt), season: episodeInfoLib.seasonExtras(d, alt) };
}
// Overview for one episode: TMDB (default language), TMDB original language,
// then the panel plot; repeated/short texts lose (lib/episode-info.js).
function episodePlot(te, ta, panelPlot, repeats) {
  const p = episodeInfoLib.pickOverview([
    { text: te?.overview, source: "tmdb" },
    { text: ta?.overview, source: "tmdb_alt" },
    { text: panelPlot, source: "panel" },
  ], repeats);
  return p ? p.text : null;
}
function episodeDisplayTitle(panelTitle, tmdbName) {
  const d = episodeInfoLib.displayTitle(panelTitle, tmdbName);
  return d ? { display_title: d } : {};
}
function seasonRepeats(tm, panelPlots) {
  return {
    tmdb: episodeInfoLib.repeatedTexts([...tm.eps.values()].map((e) => e.overview)),
    tmdb_alt: episodeInfoLib.repeatedTexts([...tm.alt.values()].map((e) => e.overview)),
    panel: episodeInfoLib.repeatedTexts(panelPlots),
  };
}
// watchedSet: Set of String(userState.watched) — holds bare episode ids (web
// client) and/or "mode:id" keys.
function episodeProgressFor(userState, mode, epId, watchedSet) {
  const p = userState.progress?.[`${mode}:${epId}`];
  const watched = !!watchedSet && (watchedSet.has(String(epId)) || watchedSet.has(`${mode}:${epId}`));
  if (!p || !Number.isFinite(p.p)) return { progress: null, watched };
  const dur = Number.isFinite(p.d) && p.d > 0 ? p.d : null;
  return {
    progress: { position: Math.round(p.p), duration: dur ? Math.round(dur) : null, pct: dur ? Math.min(100, Math.round((p.p / dur) * 100)) : null, updated_at: p.t || null },
    watched,
  };
}
app.get("/api/episodes/:mode(series|disk)/:id(\\d{1,17})", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const { mode, id } = req.params;
    const userState = getProfileState(req.profileId);
    const watchedSet = new Set((Array.isArray(userState.watched) ? userState.watched : []).map(String));
    const seasonsOut = [];
    let tmdbId = null;
    let origLang = null;
    let lastEpisode = null;
    if (mode === "disk") {
      if (!requireOwner(req, res)) return;
      const ix = getIndexesFor(req.account || currentAccount()).disk;
      const numId = parseInt(id, 10);
      const info = ix?.meta?.get(numId);
      if (!info || !info.isSeriesGroup) return res.status(404).json({ error: "not a series group" });
      const t = tmdbCache[`disk:${numId}`];
      if (t && t.source === "tmdb" && t.tmdb_id && t.tmdb_kind === "series") { tmdbId = t.tmdb_id; origLang = t.original_language || null; }
      const bySeason = new Map();
      for (const ep of info.episodes) {
        if (!bySeason.has(ep.season)) bySeason.set(ep.season, []);
        bySeason.get(ep.season).push(ep);
      }
      const tmAll = await tmdbSeasonsEpisodes(tmdbId, [...bySeason.keys()], 6000, origLang);
      for (const [season, eps] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
        const tm = tmAll.get(season) || EMPTY_TMDB_SEASON;
        const repeats = seasonRepeats(tm, []);
        seasonsOut.push({
          season,
          ...tm.season,
          episodes: eps.map((ep) => {
            const te = tm.eps.get(ep.episodeNum);
            return {
              id: ep.id, episode_num: ep.episodeNum,
              title: ep.title || te?.name || `Episode ${ep.episodeNum}`,
              ...episodeDisplayTitle(ep.title, te?.name),
              plot: episodePlot(te, tm.alt.get(ep.episodeNum), null, repeats), air_date: te?.air_date || null,
              duration_secs: ep.durationSecs || null, container: ep.container || null,
              still: te?.still_path ? `${TMDB_IMG_BASE}/w400${te.still_path}` : null,
              ...episodeInfoLib.episodeExtras(te),
              ...episodeAudioFields(ep.audio_channels ? { channels: ep.audio_channels, codec: ep.audio_codec || null, atmos: !!ep.audio_atmos } : null),
              ...episodeProgressFor(userState, "disk", ep.id, watchedSet),
            };
          }),
        });
      }
    } else {
      const item = indexes.series?.byId?.get(parseInt(id, 10));
      if (!item) return res.status(404).json({ error: "unknown series" });
      const actx = currentAccount();
      const params = { series_id: id };
      const infoKey = xtreamKey(actx, MODES.series.info, params);
      let info = cache.get(infoKey)?.v || null;
      if (!info?.episodes) {
        try { info = await xtream(MODES.series.info, params, { actx, timeout: INFO_PANEL_TIMEOUT_MS }); } catch { info = null; }
      }
      // Panel down: the last good copy on disk (same store /info falls back to).
      if (!info?.episodes) info = (await infoStore.get(infoKey).catch(() => null))?.v || null;
      if (!info?.episodes || typeof info.episodes !== "object") {
        res.set("Retry-After", "30");
        return res.status(503).json({ error: "info_unavailable" });
      }
      noteSeriesAudio(id, info, actx);
      const t = TMDB_API_KEY ? await Promise.race([
        ensureTmdbForItem("series", id, { name: item.name, year: item.year, lang: isoLangForItem(item) }).catch(() => null),
        new Promise((r) => setTimeout(() => r(null), 4000)),
      ]) : null;
      if (t && t.source === "tmdb" && t.tmdb_id) { tmdbId = t.tmdb_id; origLang = t.original_language || null; }
      const seasons = Object.entries(info.episodes)
        .filter(([, list]) => Array.isArray(list))
        .map(([sn, list]) => [Number(sn), list])
        .sort((a, b) => a[0] - b[0]);
      const tmAll = await tmdbSeasonsEpisodes(tmdbId, seasons.map(([n]) => n), 6000, origLang);
      for (const [season, list] of seasons) {
        const tm = tmAll.get(season) || EMPTY_TMDB_SEASON;
        const repeats = seasonRepeats(tm, list.map((ep) => ep?.info?.plot));
        const stills = {};
        const episodes = list.map((ep) => {
          const num = Number(ep.episode_num);
          const te = tm.eps.get(num);
          const tStill = te?.still_path ? `${TMDB_IMG_BASE}/w400${te.still_path}` : null;
          if (tStill) stills[String(ep.id)] = tStill;
          // The panel's own episode image, if https and not a portrait
          // poster (some panels put the series poster there).
          const pi = typeof ep.info?.movie_image === "string" ? ep.info.movie_image.trim() : "";
          const panelStill = /^https:\/\/[^\s"'<>]+$/i.test(pi) && !/_and_h900|\/w(?:92|154|185|342|500|780)\//i.test(pi) ? pi : null;
          return {
            id: ep.id, episode_num: Number.isFinite(num) ? num : null,
            title: ep.title || te?.name || null,
            ...episodeDisplayTitle(ep.title, te?.name),
            plot: episodePlot(te, tm.alt.get(num), typeof ep.info?.plot === "string" ? ep.info.plot : null, repeats),
            air_date: te?.air_date || ep.info?.releasedate || ep.info?.air_date || null,
            duration_secs: Number(ep.info?.duration_secs) || null,
            container: ep.container_extension || null,
            still: tStill || panelStill,
            ...episodeInfoLib.episodeExtras(te),
            ...episodeAudioFields((isOwnerAccount(actx) ? learnedTrackSummary("series", ep.id) : null) || surroundLib.fromPanelAudio(ep.info?.audio)),
            ...episodeProgressFor(userState, "series", ep.id, watchedSet),
          };
        });
        // Keep the legacy /api/poster/series/:id/season/:n cache warm too.
        if (Object.keys(stills).length && Number.isFinite(season)) {
          const k = `series-season:${id}:${season}`;
          if (!tmdbCache[k] || Date.now() - (tmdbCache[k].fetched_at || 0) > TMDB_TTL_MS) { tmdbCache[k] = { fetched_at: Date.now(), stills }; scheduleTmdbCacheSave(); }
        }
        seasonsOut.push({ season, ...tm.season, episodes });
      }
      const le = userState.lastEpisode?.[id] || userState.lastEpisode?.[String(parseInt(id, 10))];
      if (le?.episode_id) lastEpisode = { episode_id: String(le.episode_id), season: le.season ?? null, episode_num: le.episode_num ?? null };
    }
    res.json({ id: Number(id), mode, tmdb_id: tmdbId, seasons: seasonsOut, last_episode: lastEpisode });
  } catch (e) { next(e); }
});

// Wipe a TMDB cache entry so the next poster request re-searches.
// Used by the "Fix poster" override in the detail modal. Also clears
// any series-season:<id>:* entries when called for a series.
app.delete("/api/poster/:mode(movie|series|disk)/:id", (req, res) => {
  const { mode, id } = req.params;
  let cleared = 0;
  const primaryKey = `${mode}:${id}`;
  if (tmdbCache[primaryKey]) { delete tmdbCache[primaryKey]; cleared++; }
  if (mode === "series") {
    const prefix = `series-season:${id}:`;
    for (const k of Object.keys(tmdbCache)) {
      if (k.startsWith(prefix)) { delete tmdbCache[k]; cleared++; }
    }
  }
  if (cleared) scheduleTmdbCacheSave();
  res.json({ ok: true, cleared });
});

// Walks tmdbCache for entries where source === "no-match", looks up
// the panel item by mode+id, and re-runs findTmdbMatch on each. TMDB
// occasionally fixes a title mapping or adds metadata after the
// original prewarm ran, so a periodic retry promotes anything that's
// matchable now without users having to click "Refresh poster" per
// title. `onProgress({phase, ...})` is called for each hit + start +
// done — used by the admin endpoint to stream NDJSON, and by the
// nightly cron just for logging.
async function retryTmdbNoMatches({ onProgress } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY configured" };
  const tally = { scanned: 0, retried: 0, promoted: 0, stillMissing: 0, errors: 0 };
  const candidates = [];
  for (const [key, entry] of Object.entries(tmdbCache)) {
    if (!entry || entry.source !== "no-match" || entry.override || entry.override_pending) continue;
    const [mode, id] = key.split(":");
    if (!["movie", "series", "disk"].includes(mode) || !id) continue;
    candidates.push({ key, mode, id });
  }
  tally.scanned = candidates.length;
  onProgress?.({ phase: "start", candidates: candidates.length });

  // Low concurrency to leave headroom for live UI / boot prewarm.
  const CONC = 3;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      tally.retried++;
      try {
        const ix = indexes[c.mode];
        const item = ix?.byId?.get(parseInt(c.id, 10)) || ix?.byId?.get(c.id);
        const name = item?.name;
        const year = item?.year;
        if (!name) { tally.errors++; continue; }
        const match = await findTmdbMatch(c.mode, name, year, isoLangForItem(item), item?.isSeriesGroup ? "series" : undefined);
        const verdict = match && match.tmdb_id
          ? tmdbHintsPlausible(c.mode, { name, year, lang: isoLangForItem(item), forcedKind: item?.isSeriesGroup ? "series" : undefined }, match, false, c.key)
          : null;
        if (verdict && verdict.ok) {
          tmdbCache[c.key] = { ...match, source: "tmdb", checked_at: Date.now() };
          tally.promoted++;
          onProgress?.({ phase: "hit", id: c.id, mode: c.mode, name, tmdb_id: match.tmdb_id, us_cert: match.us_cert || "" });
        } else {
          // Refresh checked_at so the next cron pass doesn't re-retry
          // immediately — keep the no-match status. A guard-hidden raw match
          // keeps its data (marked rejected) instead of being overwritten.
          const raw = tmdbStore[c.key];
          if (raw && raw.source === "tmdb" && raw.tmdb_id) {
            tmdbStoreRejection(c.key, verdict ? match.tmdb_id : null, verdict ? verdict.reason : (tmdbEntryVerdict(c.key, raw).reason || "no plausible match on retry"));
          } else {
            tmdbCache[c.key] = { tmdb_id: null, source: "no-match", checked_at: Date.now(), ...(verdict ? { rejected_tmdb_id: match.tmdb_id, guard_rejected: verdict.reason } : {}) };
          }
          tally.stillMissing++;
        }
      } catch (e) {
        tally.errors++;
      }
    }
  }));
  scheduleTmdbCacheSave();
  for (const m of ["movie", "series"]) { try { assignVariants(m); } catch {} }
  onProgress?.({ phase: "done", ...tally });
  return { ok: true, ...tally };
}

// Re-validate matched entries whose YEAR disagrees with the panel title.
// findTmdbMatch historically took the most-popular search hit when the
// panel movie list carried no year field, so a Hindi "Blind (2023)"
// matched the American "The Blind Side (2009)" — correct title + video,
// wrong poster/plot. Now that findTmdbMatch year-gates, re-run those: for
// each cached tmdb match whose stored year is >1 off the year parsed from
// the panel name, re-match and replace; if nothing resolves in the right
// year, drop to no-match so the title/video stay correct without a
// misleading poster. On-demand (admin endpoint) — it can issue a lot of
// TMDB calls, so it isn't on the nightly cron.
async function revalidateTmdbYears({ onProgress } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY configured" };
  const tally = { scanned: 0, mismatched: 0, rematched: 0, cleared: 0, unchanged: 0, errors: 0 };
  // Parenthesized year only — see findTmdbMatch (a bare in-title number
  // like "Blade Runner 2049" must not be treated as the release year, or
  // this would clear a correct poster).
  const yearOfName = (n) => {
    const m = String(n || "").match(/\((19|20)\d{2}\)/);
    return m ? parseInt(m[0].replace(/[()]/g, ""), 10) : null;
  };
  const candidates = [];
  for (const [key, entry] of Object.entries(tmdbCache)) {
    if (!entry || entry.source !== "tmdb" || !entry.tmdb_id) continue;
    const [mode, id] = key.split(":");
    if (!["movie", "series", "disk"].includes(mode) || !id) continue;
    const item = indexes[mode]?.byId?.get(parseInt(id, 10)) || indexes[mode]?.byId?.get(id);
    if (!item) continue; // not in index → can't compare, leave alone
    const lang = isoLangForItem(item);
    const nameYear = yearOfName(item.name);
    const tmdbYear = parseInt(String(entry.year || "").slice(0, 4), 10);
    // "year": the stored release year is >1 off the parenthesized title
    //   year — a wrong-era match (Blind 2023 → The Blind Side 2009).
    // "lang": the title's language tag and the matched film's
    //   original_language disagree — a wrong-language match (Blind 2023
    //   hi → Double Blind 2024 en). Regional-default tagging marks
    //   Telugu/Tamil films as hi too, so lang candidates only SWITCH if
    //   the re-match actually finds a same-language film (see below) —
    //   otherwise the existing (correct) match is kept.
    const yearBad = nameYear && Number.isFinite(tmdbYear) && Math.abs(nameYear - tmdbYear) > 1;
    const langBad = lang && entry.original_language && entry.original_language !== lang;
    if (!yearBad && !langBad) continue;
    candidates.push({ key, mode, id, name: item.name, nameYear, tmdbYear, lang, reason: yearBad ? "year" : "lang", forcedKind: item.isSeriesGroup ? "series" : undefined });
  }
  tally.scanned = Object.keys(tmdbCache).length;
  tally.mismatched = candidates.length;
  onProgress?.({ phase: "start", mismatched: candidates.length });
  const CONC = 3;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      if (hasTmdbOverride(c.key)) continue;
      try {
        let match = await findTmdbMatch(c.mode, c.name, c.nameYear, c.lang, c.forcedKind);
        if (match && !tmdbHintsPlausible(c.mode, { name: c.name, year: c.nameYear, lang: c.lang, forcedKind: c.forcedKind }, match, false, c.key).ok) match = null;
        const cur = tmdbCache[c.key];
        // For a lang candidate, only accept a re-match that actually
        // resolved to the wanted language — otherwise the regional-default
        // hi tag would wrongly drag a Telugu/Tamil film onto a Hindi one.
        // For a year candidate, any year-valid re-match is an improvement.
        const accept = match && match.tmdb_id
          && (c.reason !== "lang" || match.original_language === c.lang);
        if (accept) {
          const changed = match.tmdb_id !== cur?.tmdb_id;
          tmdbCache[c.key] = { ...match, source: "tmdb", checked_at: Date.now() };
          if (changed) {
            tally.rematched++;
            onProgress?.({ phase: "fix", id: c.id, mode: c.mode, name: c.name, reason: c.reason, tmdb_id: match.tmdb_id, lang: match.original_language });
          } else {
            tally.unchanged++;
          }
        } else if (c.reason === "year") {
          // Wrong-era and nothing better in the right year → drop the
          // misleading poster to no-match (title/video stay correct).
          tmdbCache[c.key] = { tmdb_id: null, source: "no-match", checked_at: Date.now() };
          tally.cleared++;
        } else {
          tally.unchanged++; // lang candidate with no same-language hit → keep existing
        }
      } catch (e) {
        tally.errors++;
      }
    }
  }));
  scheduleTmdbCacheSave();
  onProgress?.({ phase: "done", ...tally });
  return { ok: true, ...tally };
}

// Nightly retry cron. Fires at 3:30 AM local — 30 minutes after the
// xmltv pull, so the two heavy tasks don't fight for panel headroom.
// Mirrors scheduleEpgNightlyRefresh's "msUntilNextLocalHour + then
// setInterval 24h" pattern.
function scheduleTmdbNightlyRetry() {
  if (!TMDB_API_KEY) return;
  const fireHour = 3;
  const fireMin = 30;
  const now = new Date();
  const target = new Date(now);
  target.setHours(fireHour, fireMin, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const ms = target - now;
  console.log(`[tmdb] next no-match retry in ${Math.round(ms / 60000)} min`);
  setTimeout(() => {
    const summary = { promoted: 0, stillMissing: 0 };
    retryTmdbNoMatches({
      onProgress: (e) => {
        if (e.phase === "done") {
          summary.promoted = e.promoted;
          summary.stillMissing = e.stillMissing;
          console.log(`[tmdb] nightly retry: ${e.promoted} promoted, ${e.stillMissing} still missing (scanned ${e.scanned})`);
        }
      },
    }).catch(e => console.warn(`[tmdb] nightly retry failed: ${e.message}`));
    setInterval(() => {
      retryTmdbNoMatches({
        onProgress: (e) => {
          if (e.phase === "done") {
            console.log(`[tmdb] nightly retry: ${e.promoted} promoted, ${e.stillMissing} still missing (scanned ${e.scanned})`);
          }
        },
      }).catch(e => console.warn(`[tmdb] nightly retry failed: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }, ms);
}

// ── AI taste profiles ("For You" rail) ──────────────────────────────
// Nightly, per profile: distill the watch history into a one-line
// taste summary + a ranked pick list via lib/ai.js (Claude Haiku).
// /api/home renders a "For You" rail (after Continue Watching) from
// the persisted picks — entirely server-side, no client changes. Without
// ANTHROPIC_API_KEY the job never runs and the rail never appears
// (same silent degradation as TMDB enrichment).
const ai = require("./lib/ai");
// Rotation helpers — home rails vary through the day instead of serving
// one frozen order. The bucket is stable within ~4h (so quick re-opens
// don't reshuffle) and changes with the profile.
function seededRng(seedStr) {
  let st = 0;
  for (const c of String(seedStr)) st = (st * 31 + c.charCodeAt(0)) | 0;
  return () => {
    st = (st + 0x6D2B79F5) | 0;
    let t = st;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Wall-clock parts in the household timezone (the container runs UTC).
let zonedFmt = null;
function zonedParts(now = new Date()) {
  zonedFmt ||= new Intl.DateTimeFormat("en-US", {
    timeZone: DISK_DOWNLOAD_WINDOW_TZ, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
  });
  const o = {};
  for (const x of zonedFmt.formatToParts(now)) o[x.type] = x.value;
  return {
    y: +o.year, m: +o.month, d: +o.day, hour: +o.hour % 24, minute: +o.minute,
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday),
  };
}
function rotationBucket(now = new Date()) {
  const z = zonedParts(now);
  return `${z.y}-${z.m}-${z.d}:${Math.floor(z.hour / 4)}`;
}
// Soft shuffle: keeps a quality bias (rank) but lets items move up to
// ~`spread` places, so the same titles don't lead forever.
function jitterOrder(arr, rng, spread = 40) {
  return arr
    .map((x, i) => ({ x, k: i + rng() * spread }))
    .sort((a, b) => a.k - b.k)
    .map((o) => o.x);
}
// A "visit" = first home fetch for a profile+mode after ~8 min idle. The
// rail seed includes the visit counter, so reopening the app reshuffles
// while tab-switching / back-navigation within a session stays stable.
const homeVisits = new Map();
function homeVisitSeed(profileId, mode, touch = true) {
  const key = `${profileId}:${mode}`;
  const now = Date.now();
  let v = homeVisits.get(key);
  if (!v) { v = { n: Math.floor(Math.random() * 1e6), last: 0 }; homeVisits.set(key, v); }
  // Non-UI callers (MCP/TARS loopback) read the current seed without
  // starting a visit or extending one.
  if (touch) {
    if (now - v.last > 8 * 60 * 1000) v.n++;
    v.last = now;
  }
  return `${rotationBucket()}:v${v.n}`;
}
function currentDaypart(now = new Date()) {
  const { hour: h, dow: d } = zonedParts(now);
  if (h >= 22 || h < 5) return "late";
  if (d === 6 || d === 0 || (d === 5 && h >= 17)) return "weekend";
  return "weeknight";
}

const tasteProfilesFile = path.join(DATA_DIR, "taste-profiles.json");
// { [profileId]: { updatedAt, summary, picks: { movie:[ids], series:[ids] },
//   reasons: { movie:{[id]:reason}, series:{[id]:reason} } } }
const tasteProfiles = (() => {
  try { return JSON.parse(fs.readFileSync(tasteProfilesFile, "utf8")) || {}; }
  catch { return {}; }
})();
function saveTasteProfiles() {
  try {
    fs.writeFileSync(tasteProfilesFile + ".tmp", JSON.stringify(tasteProfiles));
    fs.renameSync(tasteProfilesFile + ".tmp", tasteProfilesFile);
  } catch (e) {
    console.warn(`[ai] save taste-profiles failed: ${e.message}`);
  }
}

// Watch signal for one profile+mode — "Title (year) — genres [lang]"
// lines, most recent first. Sources in priority order: progress
// (timestamped), recents (already newest-first), favorites + myList
// (untimestamped, appended last, tagged so the model can weigh
// deliberate curation above passive watching). Returns the lines plus
// the id set, so candidates can exclude what the viewer already saw.
function tasteSignalFor(state, mode, cap = 40) {
  const ix = indexes[mode];
  // Ids arrive as strings or numbers depending on the panel and the
  // client that wrote them — same reason every other lookup in this
  // file does the dual get. Dedupe/exclude on String(id) so the two
  // spellings of one item can't double-count.
  const lookup = (id) => ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10));
  const ids = [];
  const seen = new Set();
  const pushId = (id) => {
    const key = String(id);
    if (seen.has(key)) return;
    seen.add(key);
    ids.push(id);
  };
  Object.entries(state.progress || {})
    .filter(([k]) => k.startsWith(mode + ":"))
    .sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0))
    .forEach(([k]) => pushId(k.split(":", 2)[1]));
  (state.recents?.[mode] || []).forEach(pushId);
  const curatedFrom = new Set(
    [...(state.favorites?.[mode] || []), ...(state.myList?.[mode] || [])].map(String),
  );
  curatedFrom.forEach(pushId);
  // Thumbs-up ids are explicit positive curation — treated like a
  // favorite in the signal (tagged " (liked)") and counted toward the
  // cold-start gate, so a fresh profile that only calibrated still builds.
  const likedFrom = new Set((state.feedback?.up?.[mode] || []).map(String));
  likedFrom.forEach(pushId);
  // `watched` is a flat client-managed list; entries are mode-qualified
  // ("movie:123"). Fold matching ids into the exclusion set (not the
  // signal — no recency and it can be huge).
  const excludeIds = new Set(seen);
  for (const w of state.watched || []) {
    const s = String(w);
    if (s.startsWith(mode + ":")) {
      const raw = s.slice(mode.length + 1);
      excludeIds.add(raw);
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) excludeIds.add(String(n)); // "007" also excludes 7
    }
  }
  // Thumbs-down: never resurface a disliked title as a pick (fold into
  // the exclusion set, dual spelling like `watched`) AND surface it to
  // Claude as explicit negative signal via the `disliked` lines below.
  const disliked = [];
  for (const rawId of (state.feedback?.down?.[mode] || [])) {
    excludeIds.add(String(rawId));
    const n = parseInt(rawId, 10);
    if (Number.isFinite(n)) excludeIds.add(String(n));
    if (disliked.length >= 20) continue;
    const s = lookup(rawId);
    if (!s) continue;
    const t = tmdbCache[`${mode}:${s.id}`];
    const genres = Array.isArray(t?.genres) && t.genres.length ? ` — ${t.genres.join("/")}` : "";
    const lang = t?.original_language ? ` [${t.original_language}]` : "";
    disliked.push(`${s.name} (${t?.year || s.year || "?"})${genres}${lang}`);
  }
  // "Seen it, not now" — a softer, TEMPORARY exclusion (see
  // emptyUserState's seenSnooze comment). Only mechanically drops the
  // id from the candidate pool for as long as it hasn't expired; unlike
  // thumbs-down it's never surfaced to Claude as a "disliked" signal —
  // the viewer liked it, they just don't want it re-picked right now.
  const now = Date.now();
  for (const [rawId, expiresAt] of Object.entries(state.seenSnooze?.[mode] || {})) {
    if (expiresAt <= now) continue;
    excludeIds.add(String(rawId));
    const n = parseInt(rawId, 10);
    if (Number.isFinite(n)) excludeIds.add(String(n));
  }
  const signal = [];
  for (const id of ids) {
    if (signal.length >= cap) break;
    const s = lookup(id);
    if (!s) continue;
    excludeIds.add(String(s.id)); // canonical spelling, for the candidate pass
    const t = tmdbCache[`${mode}:${s.id}`];
    const genres = Array.isArray(t?.genres) && t.genres.length ? ` — ${t.genres.join("/")}` : "";
    const lang = t?.original_language ? ` [${t.original_language}]` : "";
    const curated = curatedFrom.has(String(id)) ? " (favorite)"
      : likedFrom.has(String(id)) ? " (liked)" : "";
    signal.push(`${s.name} (${t?.year || s.year || "?"})${genres}${lang}${curated}`);
  }
  return { signal, excludeIds, disliked };
}

// Candidate pool the model may pick from: TMDB-matched catalog items
// that clear the SAME per-profile gates /api/home applies (title-
// language + kid cert), minus anything the viewer already touched.
// Ranked by audience size and capped — the pool is the prompt, so it
// has to stay small. The model can only recommend from this pool
// (lib/ai.js drops any id outside it), which is what makes the kid
// gating airtight: a kid profile's pool never contained the R-rated
// item in the first place.
function tasteCandidatesFor(state, profile, mode, excludeIds, cap = 150) {
  const ix = indexes[mode];
  const modeKeys = (() => {
    const own = state.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    const liveKeys = state.filter?.groups?.live;
    return Array.isArray(liveKeys) && liveKeys.length ? liveKeys : [];
  })();
  const onboarded = !!state.filter?.onboarded && modeKeys.length > 0;
  const langPass = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  const kidBlocked = makeKidsBlocker(profile);
  const pool = [];
  const seenTmdb = new Set();
  for (const s of ix.byId.values()) {
    if (s.isAlt) continue; // one entry per title
    if (excludeIds.has(String(s.id))) continue;
    if (!langPass(s.name)) continue;
    const t = tmdbCache[`${mode}:${s.id}`];
    if (!t || t.source === "no-match" || !t.tmdb_id) continue;
    if (seenTmdb.has(t.tmdb_id)) continue;
    if (kidBlocked({ us_cert: effCert(t) || s.us_cert })) continue;
    seenTmdb.add(t.tmdb_id);
    pool.push({ s, t });
  }
  pool.sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0));
  // Top ~40% by audience size, rest sampled at random from the next
  // 1500 — a pure top-N pool made every rebuild see the same titles.
  const head = pool.slice(0, Math.floor(cap * 0.4));
  const rest = pool.slice(head.length, head.length + 1500);
  const rng = seededRng(`${rotationBucket()}:${profile?.id || ""}:${mode}:${Date.now() % 997}`);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const sampled = [...head, ...rest.slice(0, cap - head.length)];
  return sampled.map(({ s, t }) => ({
    id: s.id,
    line: `${s.name} (${t.year || s.year || "?"}) — ${(t.genres || []).join("/")}` +
      (t.original_language ? ` [${t.original_language}]` : "") +
      (t.rating ? ` ★${t.rating}` : ""),
  }));
}

// Deterministic diverse calibration batch for the "Refine For You"
// screen. Same gating as tasteCandidatesFor (kid-cert + title-language,
// TMDB-matched, deduped by tmdb_id) so a kid profile's batch can never
// contain a blocked title — but instead of a flat popularity sort it
// spreads the picks across genre × language × decade buckets
// (round-robin, best-per-bucket first) so a handful of answers span the
// viewer's taste space. Excludes anything already thumbed. AI-free.
function refineBatchFor(state, profile, mode, cap = 30) {
  const ix = indexes[mode];
  if (!ix || !ix.byId) return [];
  const modeKeys = (() => {
    const own = state.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    const liveKeys = state.filter?.groups?.live;
    return Array.isArray(liveKeys) && liveKeys.length ? liveKeys : [];
  })();
  const onboarded = !!state.filter?.onboarded && modeKeys.length > 0;
  const langPass = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  const kidBlocked = makeKidsBlocker(profile);
  const rated = new Set(
    [...(state.feedback?.up?.[mode] || []), ...(state.feedback?.down?.[mode] || [])].map(String),
  );
  const buckets = new Map();
  const seenTmdb = new Set();
  for (const s of ix.byId.values()) {
    if (s.isAlt) continue;
    if (rated.has(String(s.id))) continue;
    if (!langPass(s.name)) continue;
    const t = tmdbCache[`${mode}:${s.id}`];
    if (!t || t.source === "no-match" || !t.tmdb_id) continue;
    if (seenTmdb.has(t.tmdb_id)) continue;
    if (kidBlocked({ us_cert: effCert(t) || s.us_cert })) continue;
    seenTmdb.add(t.tmdb_id);
    const genre = (Array.isArray(t.genres) && t.genres[0]) || "other";
    const lang = t.original_language || "?";
    const decade = t.year ? Math.floor(t.year / 10) * 10 : "?";
    const key = `${genre}|${lang}|${decade}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ s, vote: t.vote_count || 0 });
  }
  if (!buckets.size) return [];
  const ordered = [...buckets.entries()].map(([key, list]) => {
    list.sort((a, b) => b.vote - a.vote);
    return { key, list };
  });
  // Order buckets by their top item's popularity, tie-break on the key
  // so identical calls return an identical batch (no RNG).
  ordered.sort((a, b) => (b.list[0].vote - a.list[0].vote) || (a.key < b.key ? -1 : 1));
  const out = [];
  for (let pass = 0; out.length < cap; pass++) {
    let advanced = false;
    for (const { list } of ordered) {
      if (list[pass]) {
        out.push(list[pass].s);
        advanced = true;
        if (out.length >= cap) break;
      }
    }
    if (!advanced) break;
  }
  return out;
}

// One profile: movie + series picks (two Claude calls — the two id
// spaces overlap, so they can't share one prompt). Returns the entry
// to persist, or null when the profile has too little history.
async function buildTasteForProfile(p) {
  const state = getProfileState(p.id);
  const entry = { updatedAt: Date.now(), summary: "", picks: {}, reasons: {} };
  const summaries = [];
  for (const mode of ["movie", "series"]) {
    // Member indexes are created lazily and sit EMPTY after a restart
    // until the member's first request or the 24h refresh tick — but
    // the catalog from the last periodic build is on disk. Load it
    // rather than silently skipping the profile until tomorrow.
    let ix = indexes[mode];
    if (!ix.ready || ix.byId.size === 0) {
      await loadIndexFromDisk(mode).catch(() => null);
      ix = indexes[mode];
      if (!ix.ready || ix.byId.size === 0) {
        console.log(`[ai] taste: ${mode} index not ready for profile ${p.id} — skipping mode`);
        continue;
      }
    }
    const { signal, excludeIds, disliked } = tasteSignalFor(state, mode);
    if (signal.length + disliked.length < 3) continue; // not enough taste signal (likes/dislikes count)
    // Don't re-pick what the last few rebuilds already surfaced (5d),
    // unless that would starve the pool.
    const prevHist = tasteProfiles[p.id]?.history?.[mode] || {};
    const histCut = Date.now() - 5 * 86400000;
    const recentShown = new Set(Object.entries(prevHist).filter(([, t]) => t > histCut).map(([id]) => id));
    let candidates = tasteCandidatesFor(state, p, mode, new Set([...excludeIds, ...recentShown]));
    if (candidates.length < 60) candidates = tasteCandidatesFor(state, p, mode, excludeIds);
    if (!candidates.length) continue;
    const res = await ai.buildTasteProfile({
      profileName: p.nick || p.id,
      signal,
      disliked,
      candidates,
    });
    if (res) {
      entry.picks[mode] = res.picks;
      const hist = {};
      for (const [id, t] of Object.entries(prevHist)) if (t > histCut) hist[id] = t;
      for (const id of res.picks) hist[String(id)] = Date.now();
      (entry.history ||= {})[mode] = hist;
      if (res.when && Object.keys(res.when).length) (entry.when ||= {})[mode] = res.when;
      if (res.reasons && Object.keys(res.reasons).length) entry.reasons[mode] = res.reasons;
      summaries.push(res.summary);
    }
  }
  // Any mode that produced nothing this run (failed call, skipped for
  // thin signal / empty pool / index not ready) keeps its previous picks,
  // reasons, when-tags and no-repeat history instead of vanishing.
  const prev = tasteProfiles[p.id];
  if (prev) {
    for (const mode of ["movie", "series"]) {
      if (entry.picks[mode] || !prev.picks?.[mode]) continue;
      entry.picks[mode] = prev.picks[mode];
      if (prev.reasons?.[mode]) entry.reasons[mode] = prev.reasons[mode];
      if (prev.when?.[mode]) (entry.when ||= {})[mode] = prev.when[mode];
      if (prev.history?.[mode]) (entry.history ||= {})[mode] = prev.history[mode];
    }
  }
  if (!Object.keys(entry.picks).length) return null;
  entry.summary = summaries.join(" ").slice(0, 600);
  return entry;
}

let tasteRebuildRunning = false;
async function rebuildTasteProfiles({ reason = "cron" } = {}) {
  if (!ai.aiEnabled()) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  if (tasteRebuildRunning) return { ok: false, error: "already running" };
  tasteRebuildRunning = true;
  const tally = { profiles: 0, built: 0, skipped: 0 };
  try {
    for (const p of profiles.profiles) {
      tally.profiles++;
      // Resolve the profile's account so `indexes` sees the right
      // catalog (invited members bring their own panel). Legacy
      // profiles without ownerUserId fall through to the owner.
      const actx = getAccountForUser(getUserById(p.ownerUserId));
      const built = await accountStore.run(actx, () => buildTasteForProfile(p));
      if (built) { tasteProfiles[p.id] = built; tally.built++; }
      else tally.skipped++;
    }
    saveTasteProfiles();
  } finally {
    tasteRebuildRunning = false;
  }
  console.log(`[ai] taste rebuild (${reason}): ${tally.built} built, ${tally.skipped} skipped of ${tally.profiles} profiles`);
  return { ok: true, ...tally };
}

// Fires at 4:15 AM local — after the 3 AM xmltv pull and the 3:30 AM
// TMDB retry, so the night's enrichment lands before taste picks are
// computed against it. Same "msUntilNextLocalHour + setInterval 24h"
// pattern as the other nightly jobs. Also warms once shortly after
// boot when no profile has picks yet (fresh deploys shouldn't wait a
// day for the rail to appear).
function scheduleTasteProfileNightly() {
  if (!ai.aiEnabled()) return;
  // Warm the structured-output schema cache (~24h server-side): the
  // first request with a given schema pays a compile cost that can
  // blow the search path's 10s no-retry timeout, which is exactly how
  // the household's first NL query of the day would die. One warm-up
  // at boot + one after each nightly rebuild keeps real queries on
  // the warm path. Logged with duration so prod telemetry shows both
  // that the leg works and when actual recompiles happen.
  const warmSchema = (label) => ai.warmSchemaCache()
    .then((ms) => console.log(`[ai] schema warm-up ${ms !== null ? `ok in ${ms}ms` : "FAILED"} (${label})`))
    .catch(() => null);
  setTimeout(() => warmSchema("boot"), 30 * 1000);
  const now = new Date();
  const target = new Date(now);
  target.setHours(4, 15, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const ms = target - now;
  console.log(`[ai] next taste rebuild in ${Math.round(ms / 60000)} min (model ${ai.AI_MODEL})`);
  const nightly = () => {
    rebuildTasteProfiles().catch(e => console.warn(`[ai] taste rebuild failed: ${e.message}`));
    warmSchema("nightly"); // re-warm daily, see above
  };
  setTimeout(() => {
    nightly();
    setInterval(nightly, 24 * 60 * 60 * 1000);
  }, ms);
  // Second rebuild at ~4:15 PM household time so the evening differs
  // from the morning. Polled (the container runs UTC; DST-proof).
  let pmRanOn = "";
  setInterval(() => {
    const z = zonedParts();
    const day = `${z.y}-${z.m}-${z.d}`;
    if (z.hour === 16 && z.minute >= 15 && pmRanOn !== day) {
      rebuildTasteProfiles({ reason: "pm" })
        .then((r) => {
          if (r && r.ok) pmRanOn = day; // retry next tick if skipped (e.g. already running)
          else if (r) console.warn(`[ai] pm taste rebuild skipped: ${r.error}`);
        })
        .catch(e => console.warn(`[ai] taste rebuild failed: ${e.message}`));
    }
  }, 5 * 60 * 1000);
  if (!Object.keys(tasteProfiles).length) {
    // 10 min gives the boot index build + TMDB prewarm time to settle.
    // If the index still isn't ready (fresh install, slow panel), keep
    // retrying every 10 min for an hour instead of running once
    // against an empty catalog and then waiting for the 4:15 cron.
    let warmTries = 0;
    const warm = () => {
      if (++warmTries > 6) return;
      if (!indexes.movie.ready) {
        return void setTimeout(warm, 10 * 60 * 1000);
      }
      rebuildTasteProfiles({ reason: "boot-warm" })
        .then((r) => {
          // {ok:false} = another rebuild held the lock (or no key) —
          // retry rather than silently waiting for the 4:15 cron.
          if (!r.ok && r.error === "already running") setTimeout(warm, 10 * 60 * 1000);
        })
        .catch(e => console.warn(`[ai] boot taste rebuild failed: ${e.message}`));
    };
    setTimeout(warm, 10 * 60 * 1000);
  }
}

// ── AI editorial rails (auto themed rails) ──────────────────────────
// Weekly, household-level: Claude proposes a few themed browse rails
// ("Heist Night", "90s Bollywood") from the owner catalog. Stored once
// (owner account); /api/home injects the current mode's rails after the
// personal rails, re-gating every pick per viewing profile — so a kid
// profile can never see an editorial pick its cert/language would drop.
const editorialRailsFile = path.join(DATA_DIR, "editorial-rails.json");
// { updatedAt, rails: [{ title, blurb, mode, picks:[ids] }] }
let editorialRails = (() => {
  try { return JSON.parse(fs.readFileSync(editorialRailsFile, "utf8")) || { rails: [] }; }
  catch { return { rails: [] }; }
})();
function saveEditorialRails() {
  try {
    fs.writeFileSync(editorialRailsFile + ".tmp", JSON.stringify(editorialRails));
    fs.renameSync(editorialRailsFile + ".tmp", editorialRailsFile);
  } catch (e) {
    console.warn(`[ai] save editorial-rails failed: ${e.message}`);
  }
}

// A representative adult profile of the owner account, used only to
// gate the household candidate pool (its onboarded languages, no kid
// block). Falls back to the first owner profile when every profile is
// a kid. Render-time re-gating still runs per viewing profile.
function ownerHouseholdProfile() {
  const oid = ownerUser()?.id;
  const owned = profiles.profiles.filter(p => p.ownerUserId === oid);
  return owned.find(p => !p.kidsBirthYear) || owned[0] || profiles.profiles[0] || null;
}

let editorialRebuildRunning = false;
async function rebuildEditorialRails({ reason = "cron" } = {}) {
  if (!ai.aiEnabled()) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  if (editorialRebuildRunning) return { ok: false, error: "already running" };
  editorialRebuildRunning = true;
  const built = [];
  try {
    const actx = getAccountForUser(ownerUser());
    await accountStore.run(actx, async () => {
      const profile = ownerHouseholdProfile();
      if (!profile) return;
      const state = getProfileState(profile.id);
      // Movie and series live in separate id spaces (same reason taste
      // can't share one prompt) — one editorial pass per mode, each
      // rail tagged with its mode so /api/home shows it only there.
      for (const mode of ["movie", "series"]) {
        let ix = indexes[mode];
        if (!ix.ready || ix.byId.size === 0) {
          await loadIndexFromDisk(mode).catch(() => null);
          ix = indexes[mode];
          if (!ix.ready || ix.byId.size === 0) continue;
        }
        // Broad household pool: no exclusions, larger cap than taste.
        const candidates = tasteCandidatesFor(state, profile, mode, new Set(), 250);
        if (candidates.length < 8) continue;
        const res = await ai.buildEditorialRails({ candidates });
        if (res) for (const r of res.rails) built.push({ ...r, mode });
      }
    });
  } finally {
    editorialRebuildRunning = false;
  }
  if (built.length) {
    editorialRails = { updatedAt: Date.now(), rails: built };
    saveEditorialRails();
  }
  console.log(`[ai] editorial rebuild (${reason}): ${built.length} rails`);
  return { ok: true, rails: built.length };
}

// Weekly, Sunday 4:30 AM local — after the nightly taste job. Same
// scheduling idiom as the others (compute ms to the target, then a
// fixed interval). Boot-warms once when no rails exist yet so a fresh
// deploy doesn't wait until Sunday for the rails to appear.
function scheduleEditorialRailsWeekly() {
  if (!ai.aiEnabled()) return;
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  const now = new Date();
  const target = new Date(now);
  target.setHours(4, 30, 0, 0);
  target.setDate(target.getDate() + ((7 - target.getDay()) % 7)); // next Sunday (0 = today)
  if (target <= now) target.setDate(target.getDate() + 7);
  const ms = target - now;
  console.log(`[ai] next editorial rebuild in ${Math.round(ms / 3600000)} h`);
  const run = () => rebuildEditorialRails().catch(e => console.warn(`[ai] editorial rebuild failed: ${e.message}`));
  setTimeout(() => {
    run();
    setInterval(run, WEEK);
  }, ms);
  // Second weekly run mid-week (Wednesday) so the themed rails turn over
  // twice a week instead of once.
  const wed = new Date(now);
  wed.setHours(4, 30, 0, 0);
  wed.setDate(wed.getDate() + ((3 - wed.getDay() + 7) % 7));
  if (wed <= now) wed.setDate(wed.getDate() + 7);
  setTimeout(() => {
    run();
    setInterval(run, WEEK);
  }, wed - now);
  if (!editorialRails.rails?.length) {
    let tries = 0;
    const warm = () => {
      if (++tries > 6) return;
      if (!indexes.movie.ready) return void setTimeout(warm, 10 * 60 * 1000);
      rebuildEditorialRails({ reason: "boot-warm" })
        .then((r) => { if (!r.ok && r.error === "already running") setTimeout(warm, 10 * 60 * 1000); })
        .catch(e => console.warn(`[ai] boot editorial rebuild failed: ${e.message}`));
    };
    setTimeout(warm, 12 * 60 * 1000);
  }
}

// ── AI "Tonight" digest ─────────────────────────────────────────────
// Nightly, household-level: from tonight's live EPG (+ what the
// household is mid-way through) Claude curates the handful of live
// programmes most worth watching. Persisted once (owner account);
// /api/home/live injects a "Tonight" rail near the top from the picks.
const tonightFile = path.join(DATA_DIR, "tonight.json");
// { updatedAt, summary, live: [{ channel_id, programme, why }] } —
// channel_id is a LIVE STREAM id (not the xmltv channel id), so the
// home endpoint maps it straight onto a tile.
let tonightDigest = (() => {
  try { return JSON.parse(fs.readFileSync(tonightFile, "utf8")) || null; }
  catch { return null; }
})();
function saveTonight() {
  try {
    fs.writeFileSync(tonightFile + ".tmp", JSON.stringify(tonightDigest));
    fs.renameSync(tonightFile + ".tmp", tonightFile);
  } catch (e) {
    console.warn(`[ai] save tonight failed: ${e.message}`);
  }
}

// Collect tonight's live candidates: one representative primetime
// programme per live channel that has EPG coverage, within the
// window [max(now, 18:00 today) .. 02:00 tomorrow]. Keyed by live
// stream id so the digest ids map onto tiles. Capped so the prompt
// stays bounded (logged when the cap bites).
const TONIGHT_CANDIDATE_CAP = 300;
function tonightLiveCandidates() {
  const ix = indexes.live;
  if (!ix?.ready || ix.byId.size === 0) return [];
  const now = Date.now();
  const windowStart = Math.max(now, new Date(new Date().setHours(18, 0, 0, 0)).getTime());
  const primeTarget = new Date(new Date().setHours(20, 30, 0, 0)).getTime();
  const windowEnd = new Date(new Date(now + 86400000).setHours(2, 0, 0, 0)).getTime();
  const out = [];
  let skippedForCap = 0;
  for (const s of ix.byId.values()) {
    const chId = s.epg_channel_id;
    if (!chId) continue;
    const progs = epgIndex.get(chId);
    if (!Array.isArray(progs) || !progs.length) continue;
    // Programmes intersecting the tonight window; pick the one nearest
    // primetime (a proxy for "the headline programme").
    let best = null, bestDist = Infinity;
    for (const p of progs) {
      if (p.stop <= windowStart || p.start >= windowEnd) continue;
      if (!p.title) continue;
      const dist = Math.abs(p.start - primeTarget);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    if (!best) continue;
    if (out.length >= TONIGHT_CANDIDATE_CAP) { skippedForCap++; continue; }
    out.push({
      channel_id: s.id,
      channel_name: s.name,
      programme: best.title,
      start: best.start,
      desc: best.desc || "",
    });
  }
  if (skippedForCap) console.log(`[ai] tonight: ${out.length} candidates (capped; ${skippedForCap} channels dropped)`);
  return out;
}

// Household "mid-way through" context — the owner household profile's
// in-progress movie/series, newest first, as short strings.
function tonightResumeItems() {
  const profile = ownerHouseholdProfile();
  if (!profile) return [];
  const state = getProfileState(profile.id);
  const items = [];
  for (const mode of ["movie", "series"]) {
    const ix = indexes[mode];
    if (!ix?.ready) continue;
    const prog = state.progress?.[mode];
    if (!prog) continue;
    const entries = Object.entries(prog)
      .sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0))
      .slice(0, 8);
    for (const [id] of entries) {
      const s = ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10));
      if (s?.name) items.push(`${s.name} (${mode})`);
    }
  }
  return items.slice(0, 10);
}

let tonightRebuildRunning = false;
async function rebuildTonight({ reason = "cron" } = {}) {
  if (!ai.aiEnabled()) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  if (tonightRebuildRunning) return { ok: false, error: "already running" };
  tonightRebuildRunning = true;
  try {
    const actx = getAccountForUser(ownerUser());
    const res = await accountStore.run(actx, async () => {
      const liveCandidates = tonightLiveCandidates();
      if (!liveCandidates.length) return null;
      return ai.buildTonightDigest({ liveCandidates, resumeItems: tonightResumeItems() });
    });
    if (res) {
      tonightDigest = { updatedAt: Date.now(), summary: res.summary, live: res.live };
      saveTonight();
    }
    console.log(`[ai] tonight rebuild (${reason}): ${res ? res.live.length + " picks" : "no digest"}`);
    return { ok: true, picks: res ? res.live.length : 0 };
  } finally {
    tonightRebuildRunning = false;
  }
}

// Nightly at 4:45 AM local — after the 3 AM EPG refresh (so tonight's
// programmes are fresh) and the 4:15 taste job. Boot-warms once when
// no digest exists. Note: the digest is computed against the EPG at
// rebuild time, so it reflects the day it was built; the rail is
// hidden by /api/home once it goes stale (see the render guard).
function scheduleTonightNightly() {
  if (!ai.aiEnabled()) return;
  const now = new Date();
  const target = new Date(now);
  target.setHours(4, 45, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const ms = target - now;
  console.log(`[ai] next tonight rebuild in ${Math.round(ms / 60000)} min`);
  const run = () => rebuildTonight().catch(e => console.warn(`[ai] tonight rebuild failed: ${e.message}`));
  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, ms);
  if (!tonightDigest) {
    let tries = 0;
    const warm = () => {
      if (++tries > 6) return;
      if (!indexes.live.ready || epgIndex.size === 0) return void setTimeout(warm, 10 * 60 * 1000);
      rebuildTonight({ reason: "boot-warm" })
        .then((r) => { if (!r.ok && r.error === "already running") setTimeout(warm, 10 * 60 * 1000); })
        .catch(e => console.warn(`[ai] boot tonight rebuild failed: ${e.message}`));
    };
    setTimeout(warm, 13 * 60 * 1000);
  }
}

// ── EPG title normalization ─────────────────────────────────────────
// After each owner EPG refresh, clean any programme titles we haven't
// seen before via lib/ai.js and merge them into `epgNormalized`.
// Incremental — only NEW distinct titles cost tokens, so steady-state
// nightly runs are cheap (a panel's title set changes slowly). Bounded
// per run so a fresh panel with tens of thousands of distinct titles
// doesn't fire one huge batch on the first pass; the remainder gets
// picked up on subsequent nights.
// Bounded per run so a fresh panel's huge title set spreads over several
// nights rather than one giant batch; and bounded overall so the
// persisted map / boot-time parse can't grow without limit on panels
// whose titles embed dates or fixtures (a large slice is "new" every
// night — this feature has no consumer yet, so the ceilings keep its
// token cost + footprint modest until one ships). Insertion order is
// preserved, so oldest keys evict first (FIFO) when over the cap.
const EPG_NORMALIZE_MAX_PER_RUN = 500;
const EPG_NORMALIZED_MAX = 12000;
let epgNormalizeRunning = false;
async function normalizeNewEpgTitles({ reason = "cron" } = {}) {
  if (!ai.aiEnabled()) return { ok: false, error: "ANTHROPIC_API_KEY not configured" };
  if (epgNormalizeRunning) return { ok: false, error: "already running" };
  epgNormalizeRunning = true;
  try {
    // Distinct titles across the owner EPG that we haven't cleaned yet.
    // Object.hasOwn (not `in`) so a title like "__proto__" can't read as
    // already-present via the prototype chain.
    const fresh = new Set();
    for (const progs of epgIndex.values()) {
      for (const p of progs) {
        const t = p.title;
        if (t && !Object.hasOwn(epgNormalized, t) && !fresh.has(t)) fresh.add(t);
        if (fresh.size >= EPG_NORMALIZE_MAX_PER_RUN) break;
      }
      if (fresh.size >= EPG_NORMALIZE_MAX_PER_RUN) break;
    }
    if (!fresh.size) {
      console.log(`[epg] normalize (${reason}): nothing new`);
      return { ok: true, added: 0 };
    }
    const map = await ai.normalizeEpgTitles({ titles: [...fresh] });
    let added = 0;
    if (map) {
      for (const [raw, v] of Object.entries(map)) {
        // Guard the merge against prototype-polluting keys and re-check
        // own-ness (a concurrent path could have added it).
        if (raw === "__proto__" || raw === "constructor" || raw === "prototype") continue;
        if (!Object.hasOwn(epgNormalized, raw)) {
          epgNormalized[raw] = v;
          added++;
        }
      }
      // FIFO-evict oldest keys so the map (and its on-disk JSON / boot
      // parse) stays bounded on high-cardinality panels.
      const keys = Object.keys(epgNormalized);
      if (keys.length > EPG_NORMALIZED_MAX) {
        for (const k of keys.slice(0, keys.length - EPG_NORMALIZED_MAX)) delete epgNormalized[k];
      }
      if (added) saveEpgNormalized();
    }
    console.log(`[epg] normalize (${reason}): +${added} of ${fresh.size} new titles (${Object.keys(epgNormalized).length} total)`);
    return { ok: true, added };
  } finally {
    epgNormalizeRunning = false;
  }
}

// ── AI assistant (/api/assistant) ───────────────────────────────────
// One conversational endpoint for every voice/chat surface: HA (the
// khouch.assist service — Cooper and plain Assist both route here),
// the TV app's assistant box, the phone app. Claude (Opus) runs a
// short tool-use loop over in-process catalog tools and answers with
// a reply plus an optional play action that the CALLER executes (HA
// casts via media_player, the TV/phone apps play in their own
// player). The server never starts a stream on the assistant's
// behalf, and no tool touches the upstream panel's media paths — the
// only panel call is the 24h-cached get_series_info metadata fetch.
//
// Ref discipline: an action ref must be a ref some tool returned
// DURING THIS REQUEST (issuedRefs) — the model cannot invent or replay
// ids, and series-level refs are refused (only episode refs play).

const ASSISTANT_MAX_TURNS = 6;
let assistantInFlight = 0;

// Per-TMDB-entry cast/director haystack, built once per entry instead
// of per assistant search call (the model may search several times per
// request across a 10k+ catalog). WeakMap: entries are replaced whole
// on TMDB refresh, so stale haystacks fall away with their entry.
const assistantHayCache = new WeakMap();
function assistantHaystack(name, t) {
  let hay = assistantHayCache.get(t);
  if (!hay) {
    hay = [
      (name || "").toLowerCase(),
      ...(Array.isArray(t.cast) ? t.cast.map((c) => (c.name || "").toLowerCase()) : []),
      ...(Array.isArray(t.directors) ? t.directors.map((d) => (d || "").toLowerCase()) : []),
    ].join(" | ");
    assistantHayCache.set(t, hay);
  }
  return hay;
}

const ASSISTANT_TOOL_SCHEMAS = [
  {
    name: "search",
    description: "Search the catalog. Matches title/channel words AND cast/director names (so 'shah rukh khan' finds his films). ALL query words must match, so keep queries minimal — one title OR one person, never both. If empty, retry once with different words (expand an abbreviation, or drop to the 2-3 most distinctive title words). Returns up to 4 candidates per kind with a playable ref (except series — resolve with series_episode before play).",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Minimal title words OR a person's name — no filler, no parentheticals." },
        kind: { type: "string", enum: ["live", "movie", "series"], description: "Restrict to one kind. Omit to search all." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "whats_on",
    description: "Find live channels airing programmes that match a keyword now or in the next 48h (sports events, teams, tournaments, show names). Use this for 'the match', 'the game', event names — programme titles match even when no channel is named after the event.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "continue_watching",
    description: "The viewer's in-progress items, most recent first (movies and series with the exact next episode to resume).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "for_you",
    description: "The viewer's taste summary and current AI picks — use when they ask for a suggestion ('put on something I'd like').",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "now_streaming",
    description: "Whether the household's single upstream slot is currently in use, and by what. Check before playing.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "series_episode",
    description: "Resolve a series to a playable episode ref: the viewer's last-watched episode when there is one, else season 1 episode 1.",
    input_schema: {
      type: "object",
      properties: { series_id: { type: ["integer", "string"] } },
      required: ["series_id"],
      additionalProperties: false,
    },
  },
  {
    name: "play",
    description: "Queue one item for playback on the viewer's device. ref MUST be a playable ref returned by a tool in this conversation (episode refs for series). Call at most once.",
    input_schema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        title: { type: "string", description: "Human title to confirm back to the viewer." },
      },
      required: ["ref", "title"],
      additionalProperties: false,
    },
  },
];

function makeAssistantTools(req) {
  const profile = findProfile(req.profileId);
  const state = getProfileState(req.profileId);
  const kidBlockedVod = makeKidsBlocker(profile);
  // Title-language gate, mirroring /api/home: hide items whose title
  // names a language the profile didn't onboard (the same wrong-language
  // -dub filter every browse/search surface applies). Per mode, with the
  // live-picks fallback the home endpoint uses; a no-op until onboarded.
  const langPassFor = (mode) => {
    const groups = state.filter?.groups || {};
    const keys = (Array.isArray(groups[mode]) && groups[mode].length)
      ? groups[mode]
      : (Array.isArray(groups.live) && groups.live.length ? groups.live : []);
    return (state.filter?.onboarded && keys.length)
      ? makeTitleLangFilter(new Set(keys))
      : () => true;
  };
  // Refs end up interpolated into /api/stream/<mode>/<id>.<ext> URLs by
  // callers we don't control (HA, the TV app), and both the container
  // ext and lastEpisode ids originate outside this server (panel
  // metadata / client-written user-state). Sanitize at ref-mint time so
  // an attacker-shaped string can never ride an action ref.
  const safeExt = (ext) => (/^[a-z0-9]{1,5}$/i.test(String(ext || "")) ? String(ext) : "mp4");
  const safeId = (id) => {
    const n = parseInt(id, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const extFor = (mode, s) => (mode === "live" ? "m3u8" : safeExt(s.container));
  // Every ref a tool hands the model this request. play() only accepts
  // members; series-level refs are tracked separately and refused.
  const issuedRefs = new Set();
  const seriesLevelRefs = new Set();
  const refFor = (mode, s) => {
    const id = safeId(s.id);
    if (id === null) return null;
    const ref = `${mode}:${id}:${extFor(mode, s)}`;
    issuedRefs.add(ref);
    if (mode === "series") seriesLevelRefs.add(ref);
    return ref;
  };
  const episodeRef = (epId, container) => {
    const id = safeId(epId);
    if (id === null) return null;
    const ref = `series:${id}:${safeExt(container)}`;
    issuedRefs.add(ref);
    // Episode legitimacy wins a numeric collision with a series-level
    // ref issued earlier in the request (fail-open is safe here: the
    // string resolves as an episode either way).
    seriesLevelRefs.delete(ref);
    return ref;
  };
  let action = null;

  const executors = {
    search({ query, kind }) {
      const modes = kind ? [kind] : ["movie", "series", "live"];
      const normQ = normalizeForSearch(String(query || "").toLowerCase());
      const qTokens = normQ.split(" ").filter(Boolean);
      if (!qTokens.length) return { results: [] };
      const results = [];
      for (const mode of modes) {
        const ix = indexes[mode];
        if (!ix?.ready) continue;
        const blocked = mode === "live" ? () => false : kidBlockedVod;
        const langPass = langPassFor(mode);
        // Same 4-char-prefix trick as the faceted matcher, so spelling
        // variants ("devgan"/"devgn") still hit cast names.
        const prefixes = qTokens.map((tok) => (tok.length >= 5 ? tok.slice(0, 4) : tok));
        const ranked = [];
        const vHidden = makeVariantHider(ix, (x) => !blocked(x) && langPass(x.name), null);
        for (const s of ix.byId.values()) {
          if (blocked(s) || !langPass(s.name)) continue;
          if (vHidden(s)) continue; // one candidate per title (native-language canonical)
          let rank = nameMatchRank(normalizeForSearch(s.name), normQ, qTokens);
          let vc = 0;
          if (mode !== "live") {
            const t = tmdbCache[`${mode}:${s.id}`];
            vc = t?.vote_count || 0;
            // Title miss → cast/director pass (how "shah rukh khan"
            // finds his films — panel titles never carry cast).
            if (!rank && t && t.source !== "no-match") {
              const hay = assistantHaystack(s.name, t);
              if (prefixes.every((p) => hay.includes(p))) rank = 1;
            }
          }
          if (rank) ranked.push({ s, rank, vc });
        }
        ranked.sort((a, b) => (b.rank - a.rank) || (b.vc - a.vc));
        for (const { s } of ranked.slice(0, 4)) {
          const ref = refFor(mode, s);
          if (!ref) continue;
          const t = mode !== "live" ? tmdbCache[`${mode}:${s.id}`] : null;
          const item = { ref, title: s.name, kind: mode };
          if (t?.year || s.year) item.year = t?.year || s.year;
          if (t?.rating) item.rating = t.rating;
          if (mode === "series") {
            item.series_id = s.id;
            item.note = "series — call series_episode before play";
          }
          results.push(item);
        }
      }
      return { results };
    },

    whats_on({ query }) {
      const normQ = normalizeForSearch(String(query || "").toLowerCase());
      const qTokens = normQ.split(" ").filter(Boolean);
      if (!qTokens.length) return { results: [] };
      const langPass = langPassFor("live");
      const results = searchEpgLive(normQ, qTokens, 8)
        .filter(({ s }) => langPass(s.name))
        .map(({ s, programme }) => ({
          ref: refFor("live", s),
          channel: s.name,
          programme: programme.title,
          starts_in_min: Math.max(0, Math.round((programme.start_ts * 1000 - Date.now()) / 60000)),
        }))
        .filter((r) => r.ref);
      return { results };
    },

    continue_watching() {
      const results = [];
      for (const mode of ["movie", "series"]) {
        const ix = indexes[mode];
        if (!ix?.ready) continue;
        const entries = Object.entries(state.progress || {})
          .filter(([k]) => k.startsWith(mode + ":"))
          .sort((a, b) => (b[1]?.t || 0) - (a[1]?.t || 0))
          .slice(0, 6);
        for (const [k] of entries) {
          const rawId = k.split(":", 2)[1];
          const s = ix.byId.get(rawId) ?? ix.byId.get(parseInt(rawId, 10));
          if (!s || kidBlockedVod(s)) continue;
          if (mode === "series") {
            const le = (state.lastEpisode || {})[String(s.id)];
            const item = { series_id: s.id, title: s.name, kind: "series" };
            const epRef = le?.episode_id ? episodeRef(le.episode_id, le.container) : null;
            if (epRef) {
              item.ref = epRef;
              item.episode = `S${le.season}E${le.episode_num}`;
            } else {
              item.note = "call series_episode to resolve";
            }
            results.push(item);
          } else {
            const ref = refFor(mode, s);
            if (ref) results.push({ ref, title: s.name, kind: mode });
          }
        }
      }
      return { results: results.slice(0, 10) };
    },

    for_you() {
      const taste = tasteProfiles[req.profileId];
      if (!taste) return { summary: null, picks: [] };
      const picks = [];
      for (const mode of ["movie", "series"]) {
        const ix = indexes[mode];
        const langPass = langPassFor(mode);
        for (const id of (taste.picks?.[mode] || []).slice(0, 6)) {
          const s = ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10));
          if (!s || kidBlockedVod(s) || !langPass(s.name)) continue;
          const ref = refFor(mode, s);
          if (!ref) continue;
          const item = { ref, title: s.name, kind: mode };
          if (mode === "series") {
            item.series_id = s.id;
            item.note = "series — call series_episode before play";
          }
          picks.push(item);
        }
      }
      return { summary: taste.summary || null, picks };
    },

    now_streaming() {
      // Match how streams were ADMITTED: admitStream tags every entry
      // with currentAccountKey() (the owner panel today — see PR3 note),
      // so compare against that, not accountKeyOf(currentAccount()) which
      // would never match for a member account and always report idle.
      const accountKey = currentAccountKey();
      for (const [owner, v] of streams) {
        if (v.accountKey !== accountKey || v.displaced) continue;
        if (diskDlSchedule.isBackgroundOwner(owner)) continue; // a download, not someone watching
        if (v.preview) continue; // a tile preview, not someone watching
        // "Still watching?" window matches the idle reaper: one grace for
        // all modes (a buffering cast OR a VOD player playing out a deep
        // forward buffer stops fetching but is still wanted).
        const graceMs = LIVE_IDLE_GRACE_MS;
        if (Date.now() - v.lastSeen > graceMs) continue; // stale entry, not really watching
        const ix = indexes[v.mode];
        const s = ix?.byId?.get(v.id) ?? ix?.byId?.get(parseInt(v.id, 10));
        // Kid profile asking: don't leak an age-gated title into the
        // spoken reply — "busy" is all the kid needs to know.
        const hideTitle = v.mode !== "live" && s && kidBlockedVod(s);
        return {
          busy: true,
          kind: v.mode,
          title: hideTitle ? "another programme" : (s?.name || `${v.mode} #${v.id}`),
          watching_for_min: Math.round((Date.now() - v.since) / 60000),
        };
      }
      return { busy: false };
    },

    async series_episode({ series_id }) {
      const ix = indexes.series;
      const s = ix.byId.get(series_id) ?? ix.byId.get(parseInt(series_id, 10));
      if (!s) return { error: "unknown series" };
      if (kidBlockedVod(s)) return { error: "not available on this profile" };
      const le = (state.lastEpisode || {})[String(s.id)];
      const resumeRef = le?.episode_id ? episodeRef(le.episode_id, le.container) : null;
      if (resumeRef) {
        return {
          ref: resumeRef,
          title: `${s.name} S${le.season}E${le.episode_num}`,
          resuming: true,
        };
      }
      // Short timeout override: xtream() defaults to 90s, but a human
      // is waiting on a TV/speaker and this holds an in-flight slot —
      // a slow panel should degrade to "couldn't get episodes", fast.
      const info = await xtream(MODES.series.info, { series_id: s.id }, { timeout: 10_000 }).catch(() => null);
      const seasons = info?.episodes && typeof info.episodes === "object"
        ? Object.keys(info.episodes).map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
        : [];
      for (const season of seasons) {
        const eps = info.episodes[String(season)];
        if (!Array.isArray(eps) || !eps.length) continue;
        const ep = [...eps].sort((a, b) => (a.episode_num || 0) - (b.episode_num || 0))[0];
        const epRef = episodeRef(ep.id, ep.container_extension);
        if (!epRef) continue;
        return {
          ref: epRef,
          title: `${s.name} S${season}E${ep.episode_num || 1}`,
          resuming: false,
        };
      }
      return { error: "no episodes listed for this series" };
    },

    play({ ref, title }) {
      if (!issuedRefs.has(ref)) {
        return { ok: false, error: "unknown ref — only refs returned by tools in this conversation are playable" };
      }
      if (seriesLevelRefs.has(ref)) {
        return { ok: false, error: "series-level ref — call series_episode and play the episode ref" };
      }
      action = { type: "play", ref, title: String(title || "").slice(0, 120) };
      return { ok: true, queued: action };
    },
  };

  return {
    async execute(name, input) {
      const fn = executors[name];
      if (!fn) return { error: `unknown tool ${name}` };
      return await fn.call(null, input || {});
    },
    getAction: () => action,
    profile,
  };
}

async function runAssistant(req, utterance) {
  const tools = makeAssistantTools(req);
  const nick = tools.profile?.nick || "the viewer";
  const isKid = !!tools.profile?.kidsBirthYear;
  const system = [
    "You are Khouch's watching assistant for one household's IPTV app. The viewer says what they want; you find it with tools and queue it.",
    "Rules:",
    "- Ground everything in tool results. Never invent titles, channels, or refs — a ref must come verbatim from a tool result in this conversation.",
    "- To start playback call play (at most once). Series need series_episode first — series-level refs don't play.",
    "- For live events ('the match', 'the game', a team or tournament name) use whats_on — programme titles match even when no channel is named after the event.",
    "- The household's upstream allows ONE concurrent stream. Check now_streaming before play; if someone is actively watching, still queue but tell the viewer whose stream stops.",
    "- Ambiguous request with several plausible matches? Don't guess — reply with the top 2-3 options and no play call.",
    "- Nothing found? Say so plainly. Never suggest content outside the tool results.",
    "- Reply in 1-2 short plain sentences (spoken aloud on TVs and speakers — no markdown, no lists unless offering options).",
    `Viewer: ${nick}${isKid ? " (kid profile — the catalog is already age-gated; never work around that)" : ""}.`,
  ].join("\n");
  const messages = [{ role: "user", content: utterance }];

  for (let turn = 0; turn < ASSISTANT_MAX_TURNS; turn++) {
    const response = await ai.assistantTurn({ system, messages, tools: ASSISTANT_TOOL_SCHEMAS });
    if (response.stop_reason === "refusal") {
      return { reply: "Sorry, I can't help with that one.", action: null };
    }
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      const action = tools.getAction();
      return {
        reply: text || (action ? `Queued ${action.title}.` : "Sorry, I came up empty on that."),
        action,
      };
    }
    messages.push({ role: "assistant", content: response.content });
    const results = [];
    for (const tu of toolUses) {
      let out;
      try {
        out = await tools.execute(tu.name, tu.input);
      } catch (e) {
        out = { error: redactAllUrls(e.message) };
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results });
  }
  const action = tools.getAction();
  return {
    reply: action ? `Queued ${action.title}.` : "Sorry, that took too many steps — try saying it differently.",
    action,
  };
}

// ---------------------------------------------------------------------
// MCP endpoint (POST /mcp) — lets an assistant (e.g. a household agent)
// search, read the guide, see Continue Watching and resolve a cast-ready
// URL. Auth: bearer token from MCP_TOKENS (handled in the auth
// middleware). Khouch itself casts nothing server-side — playback on a
// TV/speaker is the caller's job (e.g. Home Assistant
// media_player.play_media with resolve_playback's url).
//
// Read tools reuse the real HTTP handlers via a loopback request carrying
// a freshly minted session + profile cookie for the token's user, so
// kids/language filters and response shapes stay exactly what every
// other client sees. NOTHING here starts upstream playback: resolving a
// URL only builds it; the stream opens when a player fetches it.
// ---------------------------------------------------------------------
async function mcpApi(req, pathAndQuery) {
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(makeSessionToken(req.user))}; `
    + `${PROFILE_COOKIE}=${encodeURIComponent(makeProfileToken(req.profileId))}`;
  const r = await fetch(`http://127.0.0.1:${PORT}${pathAndQuery}`, {
    headers: { cookie, accept: "application/json", "x-khouch-internal": "mcp" },
  });
  if (!r.ok) throw new Error(`${pathAndQuery.split("?")[0]} returned HTTP ${r.status}`);
  return r.json();
}

function mcpHit(mode, item) {
  const id = item.id ?? item.stream_id ?? item.series_id;
  const ext = mode === "live" ? "m3u8"
    : String(item.container_extension || item.container || "mp4").toLowerCase();
  const out = { ref: `${mode}:${id}:${ext}`, title: item.name || item.title || "", kind: mode };
  if (item.year) out.year = item.year;
  const cat = item.category_name || item.category;
  if (cat) out.category = cat;
  return out;
}

const mcpNow = () => Math.floor(Date.now() / 1000);
function mcpProgram(p) {
  return { title: p.title, start: new Date(p.start_ts * 1000).toISOString(), end: new Date(p.stop_ts * 1000).toISOString() };
}

// Items added to Watch Later / Favorites through MCP (TARS). Clients PUT
// whole lists, so a tab that loaded before the add would otherwise erase it
// on its next change. Until some client loads /api/bootstrap (i.e. has SEEN
// the list) or 24h pass, a PUT that lacks a pending add gets it re-merged.
// In-memory; a restart just drops the protection.
const pendingListAdds = new Map(); // profileId -> Map("key|mode|id" -> ts)
function notePendingListAdd(profileId, key, mode, id) {
  let m = pendingListAdds.get(profileId);
  if (!m) { m = new Map(); pendingListAdds.set(profileId, m); }
  m.set(`${key}|${mode}|${id}`, Date.now());
}
function clearPendingListAdds(profileId) { pendingListAdds.delete(profileId); }
function mergePendingListAdds(profileId, userState) {
  const m = pendingListAdds.get(profileId);
  if (!m) return;
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const restore = [];
  for (const [k, t] of m) {
    if (t < cutoff) { m.delete(k); continue; }
    const [key, mode, idStr] = k.split("|");
    const id = parseInt(idStr, 10);
    const list = (userState[key][mode] ||= []);
    if (!list.some((x) => String(x) === String(id))) restore.push({ list, id });
  }
  // Insertion order is oldest-first; unshift in that order so the newest
  // add ends up at the front, as update_list leaves it.
  for (const r of restore) r.list.unshift(r.id);
  if (!m.size) pendingListAdds.delete(profileId);
}

const MCP_TOOLS = [
  {
    name: "search",
    description: "Search the Khouch catalog (live TV channels, movies, series, local disk media). "
      + "Returns every match with an opaque `ref` to pass to resolve_playback. A query like 'CNN' "
      + "often matches several channels — pick or confirm the right one.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", enum: ["live", "movie", "series", "disk"] },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
      required: ["query"],
    },
    async handler(args, req) {
      const q = String(args.query || "").trim();
      if (!q) throw new Error("query is required");
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
      const data = await mcpApi(req, `/api/search/all?q=${encodeURIComponent(q)}&limit=${limit}`);
      const modes = args.kind ? [args.kind] : ["live", "movie", "series", "disk"];
      const results = [];
      for (const m of modes) for (const it of (data[m] || []).slice(0, limit)) results.push(mcpHit(m, it));
      return { query: q, count: results.length, results };
    },
  },
  {
    name: "whats_on",
    description: "What's on live TV: for channels whose name matches `query`, the programme on now "
      + "and next; plus programmes (on now or starting within `hours`, default 3) whose TITLE "
      + "matches `query` on any channel — use that for 'put on the Yankees game'. Each has a "
      + "channel `ref` for resolve_playback.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        hours: { type: "integer", minimum: 1, maximum: 12 },
      },
      required: ["query"],
    },
    async handler(args, req) {
      const q = String(args.query || "").trim();
      if (!q) throw new Error("query is required");
      const hours = Math.min(Math.max(parseInt(args.hours, 10) || 3, 1), 12);
      const now = mcpNow();
      const data = await mcpApi(req, `/api/search/all?q=${encodeURIComponent(q)}&limit=6`);
      const channels = [];
      for (const it of (data.live || []).slice(0, 6)) {
        const hit = mcpHit("live", it);
        try {
          const epg = await mcpApi(req, `/api/epg/short/${encodeURIComponent(it.id ?? it.stream_id)}?hours=${hours}`);
          const progs = (epg.programs || []).filter(p => p.stop_ts > now);
          const cur = progs.find(p => p.start_ts <= now);
          hit.now = cur ? mcpProgram(cur) : null;
          hit.next = progs.filter(p => p.start_ts > now).slice(0, 2).map(mcpProgram);
        } catch { hit.now = null; hit.next = []; }
        channels.push(hit);
      }
      // Programme-title scan over the in-memory XMLTV index. Skipped for
      // kid profiles: live channels carry no certificate to filter by.
      const programmes = [];
      const prof = findProfile(req.profileId);
      if (!prof?.kidsBirthYear) {
        const needle = q.toLowerCase();
        const acct = currentAccount();
        const byChannel = isOwnerAccount(acct) ? epgIndex : getEpgIndexFor(acct).byChannel;
        const untilMs = (now + hours * 3600) * 1000;
        const nowMs = now * 1000;
        for (const s of getIndexesFor(acct).live.byId?.values?.() || []) {
          if (programmes.length >= 15) break;
          const list = s.epg_channel_id ? byChannel.get(s.epg_channel_id) : null;
          if (!list) continue;
          for (const p of list) {
            if (p.start >= untilMs) break;
            if (p.stop <= nowMs) continue;
            if (!(p.title || "").toLowerCase().includes(needle)) continue;
            programmes.push({
              ...mcpProgram({ title: p.title, start_ts: p.start / 1000, stop_ts: p.stop / 1000 }),
              on_now: p.start <= nowMs,
              channel: s.name,
              ref: mcpHit("live", s).ref,
            });
            break;
          }
        }
        programmes.sort((a, b) => a.start.localeCompare(b.start));
      }
      return { query: q, channels, programmes };
    },
  },
  {
    name: "continue_watching",
    description: "This profile's Continue Watching: movies and series episodes with a saved "
      + "position (seconds), most recent first. Each `ref` resumes that exact item; pass "
      + "`position` to the player to seek.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
    },
    async handler(args, req) {
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 20);
      const st = getProfileState(req.profileId);
      const ix = getIndexesFor(currentAccount());
      const items = [];
      const seenEpisodes = new Set();
      for (const [seriesId, le] of Object.entries(st.lastEpisode || {})) {
        if (le?.episode_id == null || !/^\d+$/.test(String(le.episode_id))) continue;
        const pr = st.progress?.[`series:${le.episode_id}`];
        // Unfinished only: a saved position, or an "up next" pointer.
        if (!hasPosition(pr) && !autoPointerLive(le)) continue;
        seenEpisodes.add(String(le.episode_id));
        items.push({
          ref: `episode:${le.episode_id}:${String(le.container || "mp4").toLowerCase()}`,
          kind: "episode",
          title: le.series_name || ix.series.byId?.get(parseInt(seriesId, 10))?.name || "",
          season: le.season ?? null, episode: le.episode_num ?? null, episode_title: le.title || null,
          position: pr?.p ?? 0, duration: pr?.d ?? null,
          t: pr?.t || le.when || 0,
        });
      }
      for (const [key, pr] of Object.entries(st.progress || {})) {
        const [mode, id] = key.split(":", 2);
        if (mode === "series" || !/^\d+$/.test(id || "")) continue;
        if (mode !== "movie" && mode !== "disk") continue;
        const item = ix[mode]?.byId?.get(parseInt(id, 10));
        if (!item || !hasPosition(pr)) continue;
        items.push({ ...mcpHit(mode, item), position: pr.p, duration: pr.d ?? null, t: pr.t || 0 });
      }
      items.sort((a, b) => b.t - a.t);
      return { items: items.slice(0, limit).map(({ t, ...rest }) => rest) };
    },
  },
  {
    name: "for_you",
    description: "Personalised suggestions for this profile, the same ones the Khouch home screen shows "
      + "right now: `tonights_pick` (3 best fits for this time of day) and `for_you` (more), each with a "
      + "`ref` and a short `why`. Rotates through the day. For live TV also returns `tonight` "
      + "(highlights). Use for 'what should we watch', 'put on something good'. `kind` movie or series "
      + "(default movie).",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["movie", "series", "live"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    async handler(args, req) {
      const kind = ["movie", "series", "live"].includes(args.kind) ? args.kind : "movie";
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 20);
      const home = await mcpApi(req, `/api/home/${kind}`);
      const pick = (titles) => {
        const r = (home.rails || []).find(x => titles.includes(x.title));
        return (r?.items || []).slice(0, limit).map(t => {
          const o = mcpHit(kind, t);
          if (t.pickReason) o.why = t.pickReason;
          return o;
        });
      };
      const out = { kind };
      if (kind === "live") out.tonight = pick(["Tonight"]);
      else {
        out.tonights_pick = pick(["Tonight's pick"]);
        out.for_you = pick(["For You"]);
      }
      return out;
    },
  },
  {
    name: "streaming_buzz",
    description: "What's popular right now on the big streaming platforms and whether each title is "
      + "available in Khouch. Covers English (US catalogs: Netflix, Prime Video, HBO Max, Disney+, Apple "
      + "TV+, Hulu, Paramount+, Peacock), Hindi (India catalogs: Netflix, Prime Video, JioHotstar, ZEE5, "
      + "SonyLIV, MX Player) and Punjabi (Prime Video, ZEE5) titles only. The household has no "
      + "subscriptions, so use this for 'what's everyone watching on Netflix', 'what's the big Hindi "
      + "show right now'. `platform` = a platform name (omit for this week's trending + Hindi/Punjabi "
      + "trending), `language` = english|hindi|punjabi (omit for all), `kind` movie|series (default "
      + "movie). Each item has `rank` (popularity rank on that platform) and, when in Khouch, a `ref`; "
      + "`not_in_khouch` lists top hits it does not have.",
    inputSchema: {
      type: "object",
      properties: {
        platform: { type: "string" },
        language: { type: "string", enum: ["english", "hindi", "punjabi"] },
        kind: { type: "string", enum: ["movie", "series"] },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
    },
    async handler(args, req) {
      const kind = args.kind === "series" ? "tv" : "movie";
      const mode = kind === "tv" ? "series" : "movie";
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), 20);
      if (!streamingBuzz.providers) throw new Error("streaming buzz not built yet — try again in a few minutes");
      const ix = getIndexesFor(currentAccount())[mode];
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const ALIASES = {
        amazon: "prime", amazonprime: "prime", primevideo: "prime", disneyplus: "disney", disney: "disney",
        hbo: "max", hbomax: "max", appletv: "apple", appletvplus: "apple", paramountplus: "paramount",
        jio: "hotstar", jiohotstar: "hotstar", disneyhotstar: "hotstar", sony: "sonyliv", zee: "zee5",
        mx: "mxplayer",
      };
      const LANG_ALIASES = { english: "en", en: "en", hindi: "hi", hi: "hi", punjabi: "pa", pa: "pa" };
      const wantLang = LANG_ALIASES[norm(args.language)] || null;
      if (args.language && !wantLang) return { error: `unknown language "${args.language}"`, valid_languages: ["english", "hindi", "punjabi"] };
      const want = norm(args.platform);
      const sources = [];
      if (!want || /^trend/.test(want)) {
        if (!wantLang || wantLang === "en") sources.push({ name: "Trending this week", list: streamingBuzz.trending?.[kind] || [] });
        for (const src of BUZZ_SOURCES) {
          if (src.platform !== "trending" || (wantLang && src.lang !== wantLang)) continue;
          sources.push({ name: src.title, list: streamingBuzz.providers[src.key]?.[kind] || [] });
        }
      }
      if (want && !/^trend/.test(want)) {
        const wantKey = ALIASES[want] || want;
        for (const src of BUZZ_SOURCES) {
          if (src.platform === "trending" || (wantLang && src.lang !== wantLang)) continue;
          if (src.platform === wantKey || norm(src.label) === want) {
            sources.push({ name: `${src.title}`, list: streamingBuzz.providers[src.key]?.[kind] || [] });
          }
        }
        if (sources.length === 0) {
          return { error: `no data for platform "${args.platform}"${wantLang ? ` in ${args.language}` : ""}`,
            valid_platforms: [...new Set(BUZZ_SOURCES.filter((p) => p.platform !== "trending").map((p) => `${p.label} (${BUZZ_LANG_NAME[p.lang]})`))] };
        }
      }
      // A kid profile gets the same gates as the home screen (rated-only titles,
      // no raw TMDB titles of unknown rating).
      const prof = findProfile(req.profileId);
      const isKid = !!prof?.kidsBirthYear;
      const kidBlocked = makeKidsBlocker(prof);
      const platforms = sources.map((src) => {
        const items = [], missing = [];
        for (const e of src.list) {
          if (items.length >= limit && (isKid || missing.length >= 5)) break;
          const members = (ix?.byTmdb?.get(e.id) || []).filter((m) => !(isKid && kidBlocked({ us_cert: m.us_cert })));
          // Prefer the native-language canonical, then any non-alternate.
          const s = members.find((m) => m.variants) || members.find((m) => !m.isAlt) || members[0] || null;
          if (s && items.length < limit) {
            items.push({ rank: e.rank, title: e.title, year: e.year, ref: mcpHit(mode, s).ref });
          } else if (!s && !isKid && missing.length < 5 && e.rank <= 30 && !ix?.byTmdb?.get(e.id)) {
            missing.push({ rank: e.rank, title: e.title, year: e.year });
          }
        }
        return { platform: src.name, in_khouch: items, not_in_khouch: missing };
      });
      return { kind: mode, updated: new Date(streamingBuzz.updatedAt || 0).toISOString(), platforms };
    },
  },
  {
    name: "streaming_arrivals",
    description: "NEW arrivals on the streaming platforms (Netflix, Prime Video, HBO Max, Disney+, Apple TV+, "
      + "Hulu, Paramount+, Peacock; JioHotstar/ZEE5/SonyLIV/MX Player for Hindi and Punjabi) — movies and "
      + "series that newly became available since the last check, English/Hindi/Punjabi only. Checked every "
      + "6 hours. Covers NEW RELEASES that became available (released in the last ~60 days); an older "
      + "title added to a catalog is not detected. `unseen: true` returns only arrivals not already "
      + "returned to this caller (for a recurring alert); otherwise `since_hours` (default 24). Also "
      + "`platform`, `language` english|hindi|punjabi, `kind` movie|series. Each item has the platform, "
      + "title, year, a short overview, `in_khouch` (and a `ref` when Khouch has it).",
    inputSchema: {
      type: "object",
      properties: {
        since_hours: { type: "integer", minimum: 1, maximum: 1440 },
        unseen: { type: "boolean" },
        platform: { type: "string" },
        language: { type: "string", enum: ["english", "hindi", "punjabi"] },
        kind: { type: "string", enum: ["movie", "series"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    async handler(args, req) {
      if (!streamingArrivals.seeded) return { arrivals: [], note: "arrival tracking is still seeding (first check pending); try again after the next 6-hourly check" };
      const hours = Math.min(Math.max(parseInt(args.since_hours, 10) || 24, 1), 1440);
      const limit = Math.min(Math.max(parseInt(args.limit, 10) || 25, 1), 50);
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const ALIASES = { amazon: "prime", amazonprime: "prime", primevideo: "prime", disneyplus: "disney", hbo: "max", hbomax: "max", appletv: "apple", jio: "hotstar", jiohotstar: "hotstar" };
      const LANGS = { english: "en", hindi: "hi", punjabi: "pa" };
      const wantP = ALIASES[norm(args.platform)] || norm(args.platform);
      const wantL = LANGS[norm(args.language)] || null;
      const wantK = args.kind === "movie" ? "movie" : args.kind === "series" ? "series" : null;
      const callerKey = `${req.user?.id || "u"}:${req.profileId || "p"}`;
      const cursors = (streamingArrivals.cursors ||= {});
      // `unseen`: everything newer than this caller's cursor (first call: the last 24h).
      const cutoff = args.unseen ? (cursors[callerKey] ?? Date.now() - 24 * 3600 * 1000) : Date.now() - hours * 3600 * 1000;
      const prof = findProfile(req.profileId);
      const isKid = !!prof?.kidsBirthYear;
      const kidBlocked = makeKidsBlocker(prof);
      const seen = new Set();
      const out = [];
      for (const a of streamingArrivals.log || []) {
        if (a.first_seen < cutoff) continue;
        if (wantP && a.platform !== wantP && norm(a.platform_label) !== wantP) continue;
        if (wantL && a.lang !== wantL) continue;
        if (wantK && a.kind !== wantK) continue;
        const dedupe = `${a.kind}:${a.tmdb_id}:${a.platform}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const mode = a.kind;
        const members = getIndexesFor(currentAccount())[mode]?.byTmdb?.get(a.tmdb_id) || [];
        const ok = members.filter((m) => !(isKid && kidBlocked({ us_cert: m.us_cert })));
        const s = ok.find((m) => m.variants) || ok.find((m) => !m.isAlt) || ok[0] || null;
        if (isKid && !s) continue; // kids only see titles Khouch can gate
        out.push({
          platform: a.platform_label, kind: a.kind, title: a.title, year: a.year,
          language: a.lang === "en" ? "English" : a.lang === "hi" ? "Hindi" : "Punjabi",
          overview: a.overview, first_seen: new Date(a.first_seen).toISOString(),
          in_khouch: !!s, ...(s ? { ref: mcpHit(mode, s).ref } : {}),
        });
        if (out.length >= limit) break;
      }
      if (args.unseen) {
        // Covered everything up to the last check (a truncated list drops the overflow;
        // repeating the same top items forever would be worse for an alert).
        cursors[callerKey] = streamingArrivals.updatedAt || Date.now();
        try {
          fs.writeFileSync(streamingArrivalsFile + ".tmp", JSON.stringify(streamingArrivals));
          fs.renameSync(streamingArrivalsFile + ".tmp", streamingArrivalsFile);
        } catch (e) { console.warn(`[arrivals] cursor save failed: ${e.message}`); }
      }
      return { updated: new Date(streamingArrivals.updatedAt || 0).toISOString(), count: out.length, arrivals: out };
    },
  },
  {
    name: "update_list",
    description: "Add or remove items on this profile's Watch Later (`watch_later`) or Favorites "
      + "(`favorites`) list. `refs` are refs from search / for_you / whats_on (movie, series, live, "
      + "disk; not episodes). Lists show as the 'Watch Later' / 'Favorites' rails on the Khouch home "
      + "on every device. Default action is add. Returns per-ref status (added / already_there / "
      + "removed / not_in_list / not_found / invalid).",
    inputSchema: {
      type: "object",
      properties: {
        refs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30 },
        list: { type: "string", enum: ["watch_later", "favorites"] },
        action: { type: "string", enum: ["add", "remove"] },
      },
      required: ["refs", "list"],
    },
    async handler(args, req) {
      const refs = Array.isArray(args.refs) ? args.refs.slice(0, 30) : [];
      if (!refs.length) throw new Error("refs is required");
      const key = args.list === "favorites" ? "favorites" : args.list === "watch_later" ? "myList" : null;
      if (!key) throw new Error("list must be watch_later or favorites");
      if (args.action != null && args.action !== "add" && args.action !== "remove") {
        throw new Error("action must be add or remove");
      }
      const remove = args.action === "remove";
      const st = getProfileState(req.profileId);
      const ix = getIndexesFor(currentAccount());
      const results = [];
      for (const raw of refs) {
        const ref = parseRef(raw);
        if (!ref || !["live", "movie", "series", "disk"].includes(ref.mode)) {
          results.push({ ref: raw, status: "invalid" });
          continue;
        }
        const id = parseInt(ref.id, 10);
        const item = ix[ref.mode]?.byId?.get(id);
        if (!item) { results.push({ ref: raw, status: "not_found" }); continue; }
        const list = (st[key][ref.mode] ||= []);
        const at = list.findIndex((x) => String(x) === String(id));
        if (remove) {
          pendingListAdds.get(req.profileId)?.delete(`${key}|${ref.mode}|${id}`);
          if (at >= 0) list.splice(at, 1);
          results.push({ ref: raw, title: item.name, status: at >= 0 ? "removed" : "not_in_list" });
        } else if (at >= 0) {
          results.push({ ref: raw, title: item.name, status: "already_there" });
        } else {
          list.unshift(id); // newest first — the home rail shows only the first 12
          notePendingListAdd(req.profileId, key, ref.mode, id);
          results.push({ ref: raw, title: item.name, status: "added" });
        }
      }
      for (const m of ["live", "movie", "series", "disk"]) {
        if (st[key][m] && st[key][m].length > 5000) st[key][m].length = 5000;
      }
      scheduleUserStateSave();
      return { list: args.list, action: remove ? "remove" : "add", results };
    },
  },
  {
    name: "resolve_playback",
    description: "Turn a `ref` (from search/whats_on/continue_watching) into a cast-ready URL for "
      + "a media player. For a series ref, optionally give season+episode; otherwise it picks the "
      + "episode last watched on this profile (with its saved position), else S1E1. Does not "
      + "start playback — hand the url to the player.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string" },
        season: { type: "integer", minimum: 0 },
        episode: { type: "integer", minimum: 0 },
      },
      required: ["ref"],
    },
    async handler(args, req) {
      const ref = parseRef(args.ref);
      if (!ref) throw new Error("invalid ref — use one returned by search/whats_on/continue_watching");
      let { mode, id, ext } = ref;
      let label = null;
      let position = 0;
      const st = getProfileState(req.profileId);
      if (mode === "series") {
        const info = await mcpApi(req, `/api/series/info/${id}`);
        const seasons = info?.episodes && typeof info.episodes === "object" ? info.episodes : {};
        const all = Object.entries(seasons).flatMap(([s, eps]) =>
          (Array.isArray(eps) ? eps : []).map(e => ({ ...e, season: Number(e.season ?? s) })));
        let ep = null;
        if (args.season != null || args.episode != null) {
          ep = all.find(e => (args.season == null || e.season === Number(args.season))
            && (args.episode == null || Number(e.episode_num) === Number(args.episode)));
          if (!ep) throw new Error("no such season/episode for that series");
        } else {
          const le = st.lastEpisode?.[id];
          ep = (le && all.find(e => String(e.id) === String(le.episode_id)))
            || all.sort((a, b) => a.season - b.season || Number(a.episode_num) - Number(b.episode_num))[0];
        }
        if (!ep) throw new Error("series has no episodes");
        id = String(ep.id);
        // Upstream panel data goes into a loopback path — digits only.
        if (!/^\d{1,12}$/.test(id)) throw new Error("bad episode id");
        ext = String(ep.container_extension || "mp4").toLowerCase();
        label = `S${ep.season}E${ep.episode_num}${ep.title ? ` — ${ep.title}` : ""}`;
        mode = "episode";
      }
      if (mode === "episode") {
        position = st.progress?.[`series:${id}`]?.p || 0;
        mode = "series"; // /api/stream serves episodes under the series mode
      } else if (mode === "movie" || mode === "disk") {
        position = st.progress?.[`${mode}:${id}`]?.p || 0;
      }
      if (!/^[a-z0-9]{1,6}$/.test(ext)) throw new Error("bad container");
      const data = await mcpApi(req, `/api/stream/${mode}/${id}.${ext}`);
      let url = data?.url || data?.direct || data?.transcode;
      if (!url) throw new Error("no playable url");
      if (url.startsWith("/")) {
        const base = (process.env.MCP_PUBLIC_URL || "").replace(/\/+$/, "");
        if (!base) throw new Error("MCP_PUBLIC_URL must be set for same-origin (transcode/disk) urls");
        url = base + url;
      }
      const isHls = /\.m3u8(\?|$)/.test(url);
      return {
        url,
        content_type: isHls ? "application/x-mpegURL" : "video/mp4",
        live: mode === "live",
        position: mode === "live" ? 0 : Math.floor(position),
        episode: label,
      };
    },
  },
];

const mcpServer = createMcpServer({ name: "khouch", version: require("./package.json").version, tools: MCP_TOOLS });

app.post("/mcp", express.json({ limit: "64kb" }), async (req, res) => {
  if (!req.mcpAuthed) return res.status(401).json({ error: "bearer token required" });
  const out = await mcpServer(req.body, req);
  if (out === null) return res.status(202).end();
  res.json(out);
});
// Stateless server: no SSE stream, no sessions to delete.
app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());
app.delete("/mcp", (_req, res) => res.status(405).set("Allow", "POST").end());

app.post("/api/assistant", express.json(), async (req, res) => {
  try {
    if (!ai.aiEnabled()) {
      return res.status(503).json({ ok: false, error: "AI not configured (ANTHROPIC_API_KEY)" });
    }
    const utterance = String(req.body?.utterance || "").trim().slice(0, 400);
    if (!utterance) return res.status(400).json({ ok: false, error: "utterance required" });
    // A couple of concurrent conversations is a household; more is a
    // bug or a runaway client. Shed rather than queue — the surfaces
    // all have humans waiting.
    if (assistantInFlight >= 3) return res.status(429).json({ ok: false, error: "assistant busy" });
    assistantInFlight++;
    try {
      const out = await runAssistant(req, utterance);
      res.json({ ok: true, ...out });
    } finally {
      assistantInFlight--;
    }
  } catch (e) {
    console.warn(`[ai] assistant failed: ${e.message}`);
    res.status(502).json({ ok: false, error: "assistant unavailable", reply: "Sorry — I hit a snag. Try again.", action: null });
  }
});

// One-time backfill for the expanded TMDB cache fields. Earlier
// entries only stored {genres, rating, poster, ...}; the projected
// shape now also includes cast / directors / trailer_key / keywords
// / vote_count / popularity / tagline / original_language / imdb_id
// / collection / reviews / recommendations. Re-fetching with the
// new append_to_response payloads via refetchTmdbDetail() upgrades
// each entry in place.
//
// "Done" sentinel: an entry has `vote_count` once backfilled, since
// vote_count wasn't in the old projection at all. Entries lacking it
// are still on the legacy shape and queued for refresh.
async function backfillTmdbCacheV2({ onProgress } = {}) {
  if (!TMDB_API_KEY) return { ok: false, error: "no TMDB_API_KEY configured" };
  const tally = { scanned: 0, retried: 0, upgraded: 0, errors: 0 };
  const candidates = [];
  for (const [key, entry] of Object.entries(tmdbCache)) {
    if (!entry || entry.source !== "tmdb" || !entry.tmdb_id) continue;
    if ("vote_count" in entry) continue; // already upgraded
    const [mode, id] = key.split(":");
    if (!["movie", "series", "disk"].includes(mode) || !id) continue;
    candidates.push({ key, mode, id, tmdb_id: entry.tmdb_id, kind: entry.tmdb_kind });
  }
  tally.scanned = candidates.length;
  onProgress?.({ phase: "start", candidates: candidates.length });

  // 5-way concurrency. TMDB allows ~50 req/s on a single key; at 5
  // concurrent requests the throughput is still well within limits,
  // but we don't saturate so live UI / boot prewarm can interleave.
  const CONC = 5;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < candidates.length) {
      const c = candidates[i++];
      tally.retried++;
      try {
        const fresh = await refetchTmdbDetail(c.mode, c.tmdb_id, c.kind);
        if (fresh && fresh.tmdb_id) {
          tmdbCache[c.key] = { ...fresh, source: "tmdb", checked_at: Date.now() };
          tally.upgraded++;
          if (tally.retried % 500 === 0) {
            // Progress heartbeat for long runs + flush to disk
            // periodically so a crash mid-backfill doesn't lose
            // hours of work.
            scheduleTmdbCacheSave();
            onProgress?.({ phase: "heartbeat", ...tally });
          }
        } else {
          tally.errors++;
        }
      } catch (e) {
        tally.errors++;
      }
    }
  }));
  scheduleTmdbCacheSave();
  onProgress?.({ phase: "done", ...tally });
  return { ok: true, ...tally };
}

// "More from <actor>" — resolves an actor name to a TMDB person_id,
// pulls their full filmography (movies + TV), and intersects with
// our local index by tmdb_id so we only return titles the user can
// actually play. Cached per-name in memory for a week so popular
// actors don't burn TMDB calls on every click.
const personCache = new Map();
const PERSON_CACHE_MS = 7 * 24 * 60 * 60 * 1000;

app.get("/api/person/credits", async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const cacheKey = name.toLowerCase();

  // `elsewhere`: notable credits the catalog lacks (Notify me), adults only,
  // flagged with this profile's Notify-me state.
  const send = (payload) => {
    const kid = isKidProfile(req.profileId);
    const nm = getProfileState(req.profileId).notifyMe || [];
    const inCat = catalogLookupFor(currentAccount());
    const flag = (list) => (kid ? [] : (list || []).filter((c) => !inCat(c.kind, c.tmdb_id)).slice(0, 12).map((c) => ({ ...c, notify: nm.some((e) => e.kind === c.kind && e.tmdb_id === c.tmdb_id && !e.landed) })));
    res.json({ ...payload, elsewhere: { movie: flag(payload.elsewhere?.movie), series: flag(payload.elsewhere?.series) } });
  };
  const cached = personCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PERSON_CACHE_MS) {
    return send(cached.payload);
  }
  if (!TMDB_API_KEY) {
    return res.json({ name, person: null, items: { movie: [], series: [] }, elsewhere: { movie: [], series: [] } });
  }

  try {
    // Search for the person — TMDB returns matches ordered by their
    // own popularity score, so [0] is the right pick for "Ranveer
    // Singh" but also for ambiguous names like "Will Smith" (the
    // actor wins over the boxer).
    const search = await tmdb("/search/person", { query: name });
    const person = (search?.results || [])[0];
    if (!person) {
      const payload = { name, person: null, items: { movie: [], series: [] } };
      personCache.set(cacheKey, { ts: Date.now(), payload });
      return send(payload);
    }

    // combined_credits = movie + tv in one call; we still split them
    // into the buckets the client renders separately.
    const credits = await tmdb(`/person/${person.id}/combined_credits`);
    const cast = Array.isArray(credits?.cast) ? credits.cast : [];
    const movieIds = new Set();
    const seriesIds = new Set();
    // role label by tmdb_id, so we can show "as Bajirao" / "as
    // Mastani" next to each title.
    const roleBy = new Map();
    for (const c of cast) {
      if (c.media_type === "movie") movieIds.add(c.id);
      else if (c.media_type === "tv") seriesIds.add(c.id);
      if (c.character) roleBy.set(`${c.media_type}:${c.id}`, c.character);
    }

    const findItems = (mode, idSet) => {
      const ix = indexes[mode];
      if (!ix?.ready) return [];
      const out = [];
      // Dedupe by tmdb_id within the result — the panel ships
      // multiple variants of every popular title (Hindi dub, Tamil
      // dub, CAM rip, HD, etc.) all sharing one TMDB id. Without
      // this, "Ryan Gosling" returned 14 Project Hail Marys.
      const seenTmdb = new Set();
      // Scan the index once. ix.byId is a Map, so this is O(n) on
      // the catalog (~70k worst case) — fine for an on-click action,
      // and the personCache makes it a one-shot per unique actor.
      for (const s of ix.byId.values()) {
        if (!s.tmdb_id || !idSet.has(s.tmdb_id)) continue;
        if (seenTmdb.has(s.tmdb_id)) continue;
        seenTmdb.add(s.tmdb_id);
        const t = tmdbCache[`${mode}:${s.id}`];
        out.push({
          id: s.id,
          name: s.name,
          icon: s.icon || null,
          poster: tilePoster(mode, s, t),
          year: s.year || (t?.year || null),
          us_cert: s.us_cert || null,
          rating: s.rating || (t?.rating || null),
          tags: s.tags || [],
          container: s.container || null,
          tmdb_id: s.tmdb_id,
          character: roleBy.get(`${mode === "movie" ? "movie" : "tv"}:${s.tmdb_id}`) || null,
        });
      }
      // Newest first — feels more useful than TMDB's default order.
      out.sort((a, b) => String(b.year || "").localeCompare(String(a.year || "")));
      return out;
    };

    const payload = {
      name: person.name,
      person: {
        id: person.id,
        name: person.name,
        profile: person.profile_path ? `${TMDB_IMG_BASE}/w185${person.profile_path}` : null,
        known_for_department: person.known_for_department || null,
      },
      items: {
        movie: findItems("movie", movieIds),
        series: findItems("series", seriesIds),
      },
    };
    // Credits the catalog may not carry: the 30 most popular per kind with a
    // poster (talk / news shows and self appearances skipped). Shared cache:
    // the catalog filter (and the cut to 12) runs per request in send().
    const elsewhereOf = (kind) => {
      const seen = new Set();
      return cast
        .filter((c) => c.media_type === kind && c.poster_path && !c.adult
          && !/\b(self|himself|herself|host|narrator)\b/i.test(c.character || "")
          && !(kind === "tv" && Array.isArray(c.genre_ids) && c.genre_ids.some((g) => g === 10767 || g === 10763)))
        .sort((a, b) => (b.popularity || 0) - (a.popularity || 0))
        .filter((c) => !seen.has(c.id) && seen.add(c.id))
        .slice(0, 30)
        .map((c) => ({ ...tmdbCardOf(kind, c), character: c.character || null }));
    };
    payload.elsewhere = { movie: elsewhereOf("movie"), series: elsewhereOf("tv") };
    personCache.set(cacheKey, { ts: Date.now(), payload });
    send(payload);
  } catch (e) {
    res.status(500).json({ error: redactAllUrls(e.message) });
  }
});

// "More like this" rails for a detail screen. All three clients (web,
// phone, TV) consume this same response and just iterate rails[] — no
// client-side filtering, ordering, or threshold logic. Server applies:
//   - title-language gate (no Tamil titles for a hindi-only profile)
//   - kid-cert gate (no PG-13 for a kid profile)
//   - tmdb_id dedup (panel ships dubs / rips of the same title)
//   - min 5 items per rail (hidden otherwise — see issue #45)
//   - cap 20 items per rail
// Live mode has no usable TMDB recommendations, so reject early.
app.get("/api/similar/:mode/:id", (req, res) => {
  const { mode, id } = req.params;
  if (mode !== "movie" && mode !== "series") {
    return res.status(400).json({ error: "mode must be movie or series" });
  }
  const ix = indexes[mode];
  if (!ix?.ready) return res.json({ ready: false, rails: [] });
  const seedId = parseInt(id, 10);
  const seed = ix.byId.get(seedId);
  if (!seed) return res.status(404).json({ error: "not found" });
  const seedTmdb = tmdbCache[`${mode}:${seedId}`];
  if (!seedTmdb || seedTmdb.source === "no-match") {
    return res.json({ ready: true, rails: [] });
  }

  const userState = getProfileState(req.profileId);
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  // Mirror the home-endpoint fallback: if the user only onboarded on
  // Live, use those groups for movie/series gating too.
  const modeKeys = (() => {
    const own = userState.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    return userState.filter?.groups?.live || [];
  })();
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  const isKidBlocked = makeKidsBlocker(activeProfile);

  const tile = (s) => {
    const t = tmdbCache[`${mode}:${s.id}`];
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      poster: tilePoster(mode, s, t),
      year: s.year || (t?.year || null),
      rating: s.rating || (t?.rating || null),
      us_cert: s.us_cert || null,
      tmdb_id: s.tmdb_id || null,
      category_id: s.category_id,
      tags: s.tags || [],
      container: s.container || null,
      ...audioTileFields(s),
    };
  };

  const passes = (s, seenTmdb) => {
    if (!s.tmdb_id || seenTmdb.has(s.tmdb_id)) return false;
    if (!titleLangPasses(s.name)) return false;
    if (isKidBlocked(s)) return false;
    return true;
  };

  // TMDB-id list → panel items, preserving TMDB's order, deduping,
  // capped at 20. Shared between recommendations[] and similar[].
  const resolveTmdbIds = (tmdbIds) => {
    if (!tmdbIds || !tmdbIds.length) return [];
    const want = new Set(tmdbIds);
    const found = new Map();
    const seen = new Set([seed.tmdb_id]);
    for (const s of ix.byId.values()) {
      if (!want.has(s.tmdb_id)) continue;
      if (!passes(s, seen)) continue;
      if (!found.has(s.tmdb_id)) found.set(s.tmdb_id, s);
      seen.add(s.tmdb_id);
    }
    return tmdbIds
      .map(tid => found.get(tid))
      .filter(Boolean)
      .slice(0, 20)
      .map(tile);
  };

  // Collection: every other catalog item sharing belongs_to_collection.id.
  const collectionItems = (() => {
    const colId = seedTmdb.collection?.id;
    if (!colId) return [];
    const seen = new Set([seed.tmdb_id]);
    const out = [];
    for (const s of ix.byId.values()) {
      const t = tmdbCache[`${mode}:${s.id}`];
      if (!t || t.collection?.id !== colId) continue;
      if (!passes(s, seen)) continue;
      seen.add(s.tmdb_id);
      out.push(s);
    }
    out.sort((a, b) => (parseInt(a.year, 10) || 0) - (parseInt(b.year, 10) || 0));
    return out.slice(0, 20).map(tile);
  })();

  // Director: catalog items sharing at least one director with the
  // seed. toLowerCase compare for robustness, year-desc ordering.
  const directorRail = (() => {
    const seedDirs = Array.isArray(seedTmdb.directors) ? seedTmdb.directors : [];
    if (!seedDirs.length) return { name: null, items: [] };
    const dirSet = new Set(seedDirs.map(d => (d || "").toLowerCase()));
    const seen = new Set([seed.tmdb_id]);
    const out = [];
    for (const s of ix.byId.values()) {
      const t = tmdbCache[`${mode}:${s.id}`];
      if (!t || !Array.isArray(t.directors) || !t.directors.length) continue;
      if (!t.directors.some(d => dirSet.has((d || "").toLowerCase()))) continue;
      if (!passes(s, seen)) continue;
      seen.add(s.tmdb_id);
      out.push(s);
    }
    out.sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));
    return { name: seedDirs[0], items: out.slice(0, 20).map(tile) };
  })();

  const recItems = resolveTmdbIds(seedTmdb.recommendations);
  const similarItems = resolveTmdbIds(seedTmdb.similar);

  // Display order: collection → recommendations → director → similar.
  // Hide rails below MIN_RAIL items so the user isn't shown an
  // almost-empty strip.
  const MIN_RAIL = 5;
  const rails = [];
  if (collectionItems.length >= MIN_RAIL) {
    rails.push({
      kind: "collection",
      title: `More from ${seedTmdb.collection.name}`,
      items: collectionItems,
    });
  }
  if (recItems.length >= MIN_RAIL) {
    rails.push({ kind: "recommendations", title: "More Like This", items: recItems });
  }
  if (directorRail.items.length >= MIN_RAIL) {
    rails.push({
      kind: "director",
      title: `More by ${directorRail.name}`,
      items: directorRail.items,
    });
  }
  if (similarItems.length >= MIN_RAIL) {
    rails.push({ kind: "similar", title: "You might also like", items: similarItems });
  }

  // 10 min cache. Similar rails are TMDB-derived and stable across this
  // window. private keeps it per-user so kid-cert / language gates aren't
  // shared across profiles. TV app's OkHttp cache picks this up.
  res.set("Cache-Control", "private, max-age=600");
  res.json({ ready: true, rails });
});

// ── Collections (TMDB belongs_to_collection) ───────────────────────────
// Movie library titles grouped by TMDB collection (lib/collections.js). The
// grouping is cached per catalog + TMDB cache version; the per-viewer gate
// (title language, kid certs, camera copies, one variant per title) runs per
// request. Only collections with >= 2 visible titles are listed.
const collectionsLib = require("./lib/collections");
const collectionIdxCache = { byId: null, version: -1, at: 0, idx: new Map() };
function movieCollectionIndex() {
  const ix = indexes.movie;
  if (!ix?.ready) return new Map();
  const c = collectionIdxCache;
  const fresh = c.byId === ix.byId && (c.version === tmdbCacheVersion || Date.now() - c.at < 60_000);
  if (!fresh || !isOwnerAccount(currentAccount())) {
    const idx = collectionsLib.buildCollectionIndex(ix.byId.values(), (s) => tmdbCache[`movie:${s.id}`]);
    if (!isOwnerAccount(currentAccount())) return idx; // member panels: not cached (owner-shaped cache)
    Object.assign(c, { byId: ix.byId, version: tmdbCacheVersion, at: Date.now(), idx });
  }
  return c.idx;
}
function collectionGateFor(req) {
  const userState = getProfileState(req.profileId);
  const profile = findProfile(req.profileId);
  const modeKeys = (() => {
    const own = userState.filter?.groups?.movie;
    if (Array.isArray(own) && own.length) return own;
    return userState.filter?.groups?.live || [];
  })();
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  const isKidBlocked = makeKidsBlocker(profile);
  const catName = new Map(loadCategoriesFromDiskSync("movie").map((c) => [String(c.category_id), c.category_name]));
  const played = new Set((userState.recents?.movie || []).map(String));
  for (const k of Object.keys(userState.progress || {})) if (k.startsWith("movie:")) played.add(k.slice(6));
  return {
    pass: (s, t) => titleLangPasses(s.name)
      && !isKidBlocked({ us_cert: effCert(t) || s.us_cert || null })
      && !isLowQuality(s, catName.get(String(s.category_id))),
    // Canonical (non-alternate) copy of a title first.
    prefer: (s) => (s.isAlt ? 1 : 0),
    affinity: (vis) => (vis.some((m) => played.has(String(m.s.id))) ? 1 : 0),
  };
}
function collectionTile(e) {
  const { col, vis } = e;
  const lead = vis[0];
  return {
    id: col.id,
    name: col.name,
    poster: col.poster_path ? `${TMDB_IMG_BASE}/w342${col.poster_path}` : (lead ? tilePoster("movie", lead.s, lead.t) : null),
    backdrop: col.backdrop_path ? `${TMDB_IMG_BASE}/w1280${col.backdrop_path}` : null,
    count: vis.length,
    first_year: e.firstYear,
    last_year: e.lastYear,
  };
}
function collectionsRailFor(req, max = 40) {
  const gate = collectionGateFor(req);
  const list = collectionsLib.collectionList(movieCollectionIndex(), gate.pass, { prefer: gate.prefer, affinity: gate.affinity });
  return { title: "Collections", total: list.length, items: list.slice(0, max).map(collectionTile) };
}
app.get("/api/collections", (req, res) => {
  res.set("Cache-Control", "no-store"); // per-profile gate, profile is a cookie
  const mode = String(req.query.mode || "movie");
  if (mode !== "movie") return res.json({ title: "Collections", total: 0, items: [] }); // TMDB collections are movie-only
  const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
  res.json(collectionsRailFor(req, lim));
});
app.get("/api/collections/:id(\\d{1,10})", async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const col = movieCollectionIndex().get(id);
    const gate = collectionGateFor(req);
    const vis = col ? collectionsLib.visibleMembers(col, gate.pass, gate.prefer) : [];
    if (!col || !vis.length) return res.status(404).json({ error: "not_found" });
    // Overview from TMDB's collection endpoint (memory-cached 24 h); never
    // waits more than 2.5 s for it.
    let overview = null;
    if (TMDB_API_KEY) {
      const d = await Promise.race([tmdb(`/collection/${id}`).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2500))]);
      overview = (d && typeof d.overview === "string" && d.overview.trim()) || null;
    }
    const years = vis.map((m) => parseInt(m.t.year || m.s.year, 10)).filter(Number.isFinite);
    res.set("Cache-Control", "no-store"); // per-profile gate
    res.json({
      ...collectionTile({ col, vis, firstYear: years.length ? Math.min(...years) : null, lastYear: years.length ? Math.max(...years) : null }),
      overview,
      items: vis.map(({ s, t }) => ({
        id: s.id,
        name: s.name,
        icon: s.icon || null,
        poster: tilePoster("movie", s, t),
        year: s.year || t.year || null,
        release_date: t.release_date || null,
        rating: t.rating || null,
        us_cert: effCert(t) || s.us_cert || null,
        tmdb_id: t.tmdb_id || null,
        category_id: s.category_id,
        tags: s.tags || [],
        container: s.container || null,
        ...audioTileFields(s),
        trailer_key: t.trailer_key || null,
      })),
    });
  } catch (e) { next(e); }
});

// --- Disk library config (SUPERADMIN ONLY) ---
// View / set the local media folder. The disk feature is owner-only, so all
// three endpoints hard-gate on requireOwner. The path persists on the owner's
// user record (accounts.json); DISK_MEDIA_DIR env is the fallback seed.
app.get("/api/admin/disk-config", (req, res) => {
  if (!requireOwner(req, res)) return;
  const ix = getIndexesFor(req.account).disk;
  res.json({
    enabled: userDiskEnabled(req.user),
    path: userDiskPath(req.user) || "",
    envSeed: process.env.DISK_MEDIA_DIR || "",
    count: ix?.byId?.size || 0,
    ready: !!ix?.ready,
    scanning: !!ix?.running,
  });
});

app.post("/api/admin/disk-config", express.json(), async (req, res) => {
  if (!requireOwner(req, res)) return;
  const body = req.body || {};
  const path_ = typeof body.path === "string" ? body.path.trim() : null;
  if (path_ != null) req.user.diskPath = path_ || null;
  if (typeof body.enabled === "boolean") req.user.diskEnabled = body.enabled;
  saveAccountsToDisk();
  invalidateAccountCtx(req.user.id);
  const resolved = userDiskPath(req.user);
  // Validate the path is a readable directory and give a preview count.
  if (resolved) {
    let ok = false;
    try { ok = fs.statSync(resolved).isDirectory(); } catch {}
    if (!ok) return res.status(400).json({ ok: false, error: "not-a-directory", path: resolved });
  }
  let count = 0;
  if (resolved && userDiskEnabled(req.user)) {
    const r = await buildDiskIndex(req.account, resolved);
    count = r.count;
    prewarmTmdbCache("disk", req.account).catch(() => {});
  } else {
    // disabled / cleared → empty the index
    const ix = getIndexesFor(req.account).disk;
    ix.byId = new Map(); ix.meta = new Map(); ix.ready = true; ix.total = 0; ix.done = 0;
  }
  res.json({ ok: true, path: resolved || "", enabled: userDiskEnabled(req.user), count });
});

// Episode list for a disk series-group tile (see buildDiskIndex /
// stableDiskSeriesId) — the client's disk detail screen calls this
// instead of playing the tile directly when it sees `isSeriesGroup`.
// Deliberately its OWN shape (not a copy of the Xtream get_series_info
// tree /api/series/info returns) — disk has no real season metadata,
// just what parseDiskEpisode inferred from filenames, so a purpose-built
// {seasons:[{season,episodes:[...]}]} shape is simpler and less fragile
// than mimicking the panel's shape for data that isn't panel-shaped.
app.get("/api/disk/series/:id", (req, res) => {
  if (!requireOwner(req, res)) return;
  const ix = getIndexesFor(req.account).disk;
  const numId = parseInt(req.params.id, 10);
  const tile = ix?.byId?.get(numId) || ix?.byId?.get(req.params.id);
  const info = ix?.meta?.get(numId) || ix?.meta?.get(req.params.id);
  if (!tile || !info || !info.isSeriesGroup) {
    return res.status(404).json({ ok: false, error: "not a series group" });
  }
  const tmdbEntry = tmdbCache[`disk:${tile.id}`];
  const seasons = new Map();
  for (const ep of info.episodes) {
    if (!seasons.has(ep.season)) seasons.set(ep.season, []);
    seasons.get(ep.season).push({
      id: ep.id,
      episodeNum: ep.episodeNum,
      title: ep.title || `Episode ${ep.episodeNum}`,
      container: ep.container,
      durationSecs: ep.durationSecs,
      audioChannels: ep.audio_channels,
    });
  }
  res.json({
    id: tile.id,
    name: tile.name,
    year: tile.year,
    poster: tmdbEntry?.poster_path ? `${TMDB_IMG_BASE}/w342${tmdbEntry.poster_path}` : null,
    backdrop: tmdbEntry?.backdrop_path ? `${TMDB_IMG_BASE}/w780${tmdbEntry.backdrop_path}` : null,
    plot: tmdbEntry?.plot || null,
    us_cert: tile.us_cert,
    seasons: [...seasons.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([season, episodes]) => ({ season, episodes })),
  });
});

// Client-safe projection of jobs (pct / waiting_for / selection: lib/disk-download-status.js).
const diskJobStatus = require("./lib/disk-download-status");
function projectDiskDownloadJobs(list) {
  const viewerWaiting = diskDownloadGate().waitingFor === "viewer";
  return diskJobStatus.projectDiskJobs(list, diskDownloadJobs.values(), { windowOpen: isDiskDownloadWindowOpen(), viewerWaiting });
}
// enabled false (the default): no window, `open` always true, hours null.
function diskDownloadWindowInfo() {
  return {
    enabled: DISK_DOWNLOAD_WINDOW.enabled,
    open: isDiskDownloadWindowOpen(),
    startHour: DISK_DOWNLOAD_WINDOW.startHour,
    endHour: DISK_DOWNLOAD_WINDOW.endHour,
    tz: DISK_DOWNLOAD_WINDOW_TZ,
  };
}

// Owner-only: queue one or more highest-quality (stream-copy, no
// re-encode) saves to the Disk library. Body is either
// `{ mode: "movie", id, title, year }` or
// `{ mode: "series", episodes: [{ id, seriesTitle, season, episodeNum,
// episodeTitle, year }, …] }` — the client already has this metadata
// from the detail page / season picker, so it's passed through rather
// than re-fetched server-side. Each episode becomes its own queued job
// (see runDiskDownloadJob — Disk mode has no season/episode grouping).
app.post("/api/disk-download", express.json(), (req, res) => {
  if (!requireOwner(req, res)) return;
  const user = req.user;
  if (!userDiskPath(user) || !userDiskEnabled(user)) {
    return res.status(400).json({ ok: false, error: "disk not configured" });
  }
  const body = req.body || {};
  const ids = [];
  if (body.mode === "movie") {
    const id = parseInt(body.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "invalid movie id" });
    ids.push(enqueueDiskDownload({ mode: "movie", id, title: String(body.title || `Movie ${id}`), year: body.year || null }));
  } else if (body.mode === "series" && Array.isArray(body.episodes)) {
    for (const ep of body.episodes) {
      const id = parseInt(ep.id, 10);
      if (!Number.isFinite(id)) continue;
      ids.push(enqueueDiskDownload({
        mode: "series", id,
        seriesTitle: String(ep.seriesTitle || "Series"),
        season: parseInt(ep.season, 10) || 0,
        episodeNum: parseInt(ep.episodeNum, 10) || 0,
        episodeTitle: ep.episodeTitle || null,
        year: ep.year || null,
      }));
    }
    if (!ids.length) return res.status(400).json({ ok: false, error: "no valid episodes" });
  } else {
    return res.status(400).json({ ok: false, error: "mode must be movie or series" });
  }
  res.json({ ok: true, jobIds: ids, jobs: projectDiskDownloadJobs(ids.map((id) => diskDownloadJobs.get(id))), window: diskDownloadWindowInfo() });
});

// Owner-only: poll job status for the "downloading…" badge on tiles/
// detail pages. Newest first: every active job + the newest 100 finished;
// `?mode=series&ids=1,2` lists every job for just those titles, uncapped.
app.get("/api/disk-download/jobs", (req, res) => {
  if (!requireOwner(req, res)) return;
  const mode = req.query.mode === "movie" || req.query.mode === "series" ? req.query.mode : null;
  const ids = mode ? diskJobStatus.parseIdsParam(req.query.ids) : null;
  const jobs = projectDiskDownloadJobs(diskJobStatus.selectDiskJobs(diskDownloadJobs.values(), { mode, ids }));
  res.json({ jobs, window: diskDownloadWindowInfo() });
});

app.post("/api/admin/rescan-disk", async (req, res) => {
  if (!requireOwner(req, res)) return;
  const resolved = userDiskPath(req.user);
  if (!resolved || !userDiskEnabled(req.user)) return res.status(400).json({ ok: false, error: "disk not configured" });
  const r = await buildDiskIndex(req.account, resolved);
  prewarmTmdbCache("disk", req.account).catch(() => {});
  res.json({ ok: true, count: r.count, error: r.error || null });
});

// Force a full panel re-index for a specific account, on demand. The
// periodic loop now refreshes every account, but this lets the owner
// kick a member's library fresh immediately — e.g. right after they sign
// up, or to pull in new catalog before they next open the app — instead
// of waiting up to TTL_MS for the next tick. Rebuilds in-memory + on-disk
// for that account, so it also busts the lazy-loaded stale copy a member
// who's already logged in is being served. Owner-only.
app.post("/api/admin/reindex-account", express.json(), async (req, res) => {
  if (!requireOwner(req, res)) return;
  const userId = String(req.query.userId || req.body?.userId || "").trim();
  const target = userId ? getUserById(userId) : null;
  if (!target) return res.status(404).json({ ok: false, error: "unknown userId" });
  const actx = getAccountForUser(target);
  try {
    await pickPanel(actx);
    await buildAllIndexes(actx, { noYield: true });
    res.json({ ok: true, userId, host: actx.host });
  } catch (e) {
    res.status(500).json({ ok: false, error: redactAllUrls(e.message) });
  }
});

// Only one TMDB bulk admin job (v2 backfill / no-match retry / year revalidation)
// at a time, so concurrent runs can't double-hit TMDB.
let tmdbAdminJob = null;
function tmdbAdminJobStart(res, name) {
  if (tmdbAdminJob) { res.status(409).json({ ok: false, error: `already running: ${tmdbAdminJob}` }); return false; }
  tmdbAdminJob = name;
  return true;
}
function tmdbAdminJobEnd() { tmdbAdminJob = null; }

app.post("/api/admin/backfill-tmdb-v2", (req, res) => {
  if (!requireOwner(req, res)) return;
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  if (!tmdbAdminJobStart(res, "backfill-tmdb-v2")) return;
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  backfillTmdbCacheV2({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => { tmdbAdminJobEnd(); res.end(); }).catch(e => {
    tmdbAdminJobEnd();
    res.write(JSON.stringify({ phase: "fatal", error: redactAllUrls(e.message) }) + "\n");
    res.end();
  });
});

// Streams progress over a single NDJSON response. Same heavy lifting
// as the nightly cron, just with live feedback to the caller.
// --- TMDB match guard: manual overrides + mismatch report (OWNER ONLY) ---
// Override file: data/tmdb-overrides.json {"movie:825105": null | 1234}.
// null pins "no match" (UI falls back to panel metadata); a number pins that
// TMDB id. Either bypasses the plausibility guard. The raw cached match is never
// destroyed by setting an override (the view just masks it), so clearing one
// restores the original; only an entry that WAS written by a number override is
// dropped on clear so the normal resolver runs again.
function tmdbOverrideKey(src) {
  const mode = String(src?.mode || "");
  const id = String(src?.id || "");
  if (!["movie", "series"].includes(mode) || !/^\d+$/.test(id)) return null;
  return { key: `${mode}:${id}`, mode, id };
}
function refreshIndexItemFromTmdb(k) {
  const item = _ownerIndexes[k.mode]?.byId?.get(parseInt(k.id, 10));
  if (item) {
    const e = tmdbCache[k.key];
    item.tmdb_id = e?.tmdb_id || null;
    item.us_cert = effCert(e) || null;
  }
  catalogGen++;
}
function afterTmdbOverrideChange(k, { clearing = false } = {}) {
  const raw = tmdbStore[k.key];
  if (clearing && raw && raw.override) delete tmdbStore[k.key];
  tmdbGuard.invalidate(k.key);
  refreshIndexItemFromTmdb(k);
  scheduleTmdbCacheSave();
}
app.post("/api/admin/tmdb-override", express.json(), (req, res) => {
  if (!requireOwner(req, res)) return;
  const k = tmdbOverrideKey(req.body);
  if (!k) return res.status(400).json({ error: "need mode (movie|series) and numeric id" });
  const t = req.body.tmdbId;
  if (t !== null && !(Number.isInteger(t) && t > 0)) {
    return res.status(400).json({ error: "tmdbId must be a positive integer or null" });
  }
  tmdbOverrides[k.key] = t;
  saveTmdbOverrides();
  afterTmdbOverrideChange(k);
  if (t !== null && TMDB_API_KEY) {
    ensureTmdbForItem(k.mode, k.id, {}).then(() => refreshIndexItemFromTmdb(k)).catch(() => {});
  }
  res.json({ ok: true, key: k.key, tmdbId: t });
});
app.delete("/api/admin/tmdb-override", express.json(), (req, res) => {
  if (!requireOwner(req, res)) return;
  const k = tmdbOverrideKey({ ...req.query, ...(req.body || {}) });
  if (!k) return res.status(400).json({ error: "need mode (movie|series) and numeric id" });
  const had = hasTmdbOverride(k.key);
  delete tmdbOverrides[k.key];
  saveTmdbOverrides();
  afterTmdbOverrideChange(k, { clearing: true });
  res.json({ ok: true, key: k.key, cleared: had });
});
// Undo a guard false positive: pin the existing (or rejected) tmdb id as an
// override, which bypasses the guard and clears the rejection marker.
app.post("/api/admin/tmdb-accept", express.json(), (req, res) => {
  if (!requireOwner(req, res)) return;
  const k = tmdbOverrideKey(req.body);
  if (!k) return res.status(400).json({ error: "need mode (movie|series) and numeric id" });
  const raw = tmdbStore[k.key];
  const id = raw && ((raw.source === "tmdb" && raw.tmdb_id) || raw.rejected_tmdb_id);
  if (!id) return res.status(404).json({ error: "no cached or rejected tmdb match for this stream" });
  tmdbOverrides[k.key] = id;
  saveTmdbOverrides();
  if (raw.source === "tmdb" && raw.tmdb_id === id) {
    const { guard_rejected, rejected_at, rejected_tmdb_id, ...clean } = raw;
    tmdbStore[k.key] = clean;
  } else {
    delete tmdbStore[k.key]; // no-match placeholder: let the override resolver fetch the id
  }
  afterTmdbOverrideChange(k);
  if (TMDB_API_KEY && !(tmdbStore[k.key] && tmdbStore[k.key].tmdb_id)) {
    ensureTmdbForItem(k.mode, k.id, {}).then(() => refreshIndexItemFromTmdb(k)).catch(() => {});
  }
  res.json({ ok: true, key: k.key, tmdbId: id });
});
app.get("/api/admin/tmdb-mismatches", (req, res) => {
  if (!requireOwner(req, res)) return;
  const only = req.query.mode;
  const rows = [];
  let checked = 0;
  for (const [key, e] of Object.entries(tmdbStore)) {
    if (!e) continue;
    const [mode, id] = key.split(":");
    if (mode !== "movie" && mode !== "series") continue;
    if (only && only !== mode) continue;
    if (hasTmdbOverride(key)) continue;
    let reason = null, kind = null;
    if (e.source === "tmdb" && e.tmdb_id) {
      checked++;
      const v = tmdbEntryVerdict(key, e);
      if (!v.ok) { reason = v.reason; kind = e.guard_rejected ? "guard_rejected" : "implausible"; }
    } else if (e.rejected_tmdb_id) {
      reason = e.guard_rejected || "rejected on re-resolve"; kind = "rejected_candidate";
    }
    if (!reason) continue;
    const info = tmdbStreamInfo(key);
    rows.push({ mode, id, name: info?.name || null, tmdb_id: e.tmdb_id || null, rejected_tmdb_id: e.rejected_tmdb_id || null,
      tmdb_title: e.tmdb_title || null, original_language: e.original_language || null, kind, reason });
  }
  res.json({ checked, flagged: rows.length, overrides: tmdbOverrides, mismatches: rows });
});
// Low-priority, no-network pass shortly after boot: just log how many cached
// matches the guard currently hides (they re-resolve lazily on next detail open).
setTimeout(() => {
  try {
    let n = 0;
    for (const [key, e] of Object.entries(tmdbStore)) if (!tmdbEntryVerdict(key, e).ok) n++;
    if (n) console.log(`[tmdb] plausibility guard hides ${n} implausible cached matches (re-resolved lazily)`);
  } catch (e) { console.warn(`[tmdb] guard scan failed: ${e.message}`); }
}, 60 * 1000).unref?.();

app.post("/api/admin/retry-tmdb-no-matches", (req, res) => {
  if (!requireOwner(req, res)) return;
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  if (!tmdbAdminJobStart(res, "retry-tmdb-no-matches")) return;
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  retryTmdbNoMatches({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => { tmdbAdminJobEnd(); res.end(); }).catch(e => {
    tmdbAdminJobEnd();
    res.write(JSON.stringify({ phase: "fatal", error: redactAllUrls(e.message) }) + "\n");
    res.end();
  });
});

// Rebuild the AI taste profiles ("For You" rail) on demand — for
// testing and for warming a fresh deploy without waiting for the
// 4:15 AM cron. Runs the exact same job.
app.post("/api/admin/check-streaming-arrivals", (req, res) => {
  if (!requireOwner(req, res)) return;
  checkStreamingArrivals({ reason: "admin" }).catch((e) => console.warn(`[arrivals] ${e.message}`));
  res.json({ ok: true, started: true });
});
app.post("/api/admin/check-new-episodes", (req, res) => {
  if (!requireOwner(req, res)) return;
  crawlNewEpisodes("admin");
  res.json({ ok: true, started: true });
});
app.post("/api/admin/check-notify-me", (req, res) => {
  if (!requireOwner(req, res)) return;
  checkNotifyMe("admin").catch((e) => console.warn(`[notify-me] ${e.message}`));
  res.json({ ok: true, started: true });
});
app.post("/api/admin/backfill-alt-certs", (req, res) => {
  if (!requireOwner(req, res)) return;
  if (certBackfill.running) return res.json({ ok: false, error: "already running", progress: certBackfill });
  backfillAltCerts({ reason: "admin" }).catch((e) => console.warn(`[cert] ${e.message}`));
  res.json({ ok: true, started: true, progress: certBackfill });
});
app.post("/api/admin/rebuild-streaming-buzz", (req, res) => {
  if (!requireOwner(req, res)) return;
  // ~1 min of serial TMDB calls: run in the background (a Cloudflare request would time out).
  buildStreamingBuzz({ reason: "admin" }).catch((e) => console.warn(`[buzz] ${e.message}`));
  res.json({ ok: true, started: true });
});
app.post("/api/admin/rebuild-taste-profiles", async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const r = await rebuildTasteProfiles({ reason: "admin" });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: redactAllUrls(e.message) });
  }
});

// Viewer-scoped: the diverse calibration batch for the "Refine For You"
// screen. Pure catalog sampling (no AI) so it populates without an API
// key; kid-cert + title-language gated to the caller's profile.
app.get("/api/refine/candidates/:mode(movie|series)", (req, res) => {
  // Per-profile + viewer-scoped like /api/home — never let a shared
  // cache serve one profile's batch to another after a switch.
  res.set("Cache-Control", "no-store");
  const mode = req.params.mode;
  const state = getProfileState(req.profileId);
  const profile = findProfile(req.profileId);
  const tmdbFor = (id) => tmdbCache[`${mode}:${id}`];
  const items = refineBatchFor(state, profile, mode).map((s) => {
    const t = tmdbFor(s.id);
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      year: s.year || null,
      poster: tilePoster(mode, s, t),
      us_cert: effCert(t) || null,
      tags: s.tags || ["other"],
      container: s.container || null,
    };
  });
  res.json({ mode, items });
});

// Viewer-scoped: re-rank ONLY the caller's profile now (the Refine
// "Save & refresh" path), so a fresh dislike batch takes effect in
// seconds instead of waiting for the 4:15 AM nightly. Per-profile lock
// so a double-tap can't run two Claude passes at once.
const refineInFlight = new Set();
app.post("/api/refine/rebuild", async (req, res) => {
  if (!ai.aiEnabled()) return res.json({ ok: false, error: "ANTHROPIC_API_KEY not configured" });
  const pid = req.profileId;
  const p = findProfile(pid);
  if (!p) return res.status(404).json({ ok: false, error: "no such profile" });
  // The nightly rebuild already covers this profile — don't double-run a
  // Claude pass (both the per-profile lock and the global nightly lock).
  if (refineInFlight.has(pid) || tasteRebuildRunning) return res.status(409).json({ ok: false, error: "already running" });
  refineInFlight.add(pid);
  try {
    const actx = getAccountForUser(getUserById(p.ownerUserId));
    const built = await accountStore.run(actx, () => buildTasteForProfile(p));
    if (built) { tasteProfiles[pid] = built; saveTasteProfiles(); }
    res.json({ ok: true, built: !!built });
  } catch (e) {
    res.status(500).json({ ok: false, error: redactAllUrls(e.message) });
  } finally {
    refineInFlight.delete(pid);
  }
});

// Rebuild the AI editorial rails on demand (same as the weekly cron).
app.post("/api/admin/rebuild-editorial-rails", async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const r = await rebuildEditorialRails({ reason: "admin" });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: redactAllUrls(e.message) });
  }
});

// Rebuild the "Tonight" digest on demand (same as the nightly cron).
app.post("/api/admin/rebuild-tonight", async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const r = await rebuildTonight({ reason: "admin" });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: redactAllUrls(e.message) });
  }
});

// Re-match cached TMDB entries whose year disagrees with the panel
// title's year (the "Blind (2023)" → "The Blind Side (2009)" class of
// wrong poster). Streams NDJSON progress.
app.post("/api/admin/revalidate-tmdb-years", (req, res) => {
  if (!requireOwner(req, res)) return;
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  if (!tmdbAdminJobStart(res, "revalidate-tmdb-years")) return;
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  revalidateTmdbYears({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => { tmdbAdminJobEnd(); res.end(); }).catch(e => {
    tmdbAdminJobEnd();
    res.write(JSON.stringify({ phase: "fatal", error: redactAllUrls(e.message) }) + "\n");
    res.end();
  });
});

const TRANSCODE_DIR = path.join(os.tmpdir(), "iptv-transcode");
fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
const transcoders = new Map();

// Titles whose hardware run died with no output and needed the software
// fallback (10-bit H.264, AV1, ...). Remembered so later sessions/seeks start
// straight in software instead of failing on the GPU first.
const hwDecodeFailed = new Set();
// When a VOD run using VAAPI dies with no output, retry it once in software.
const { vodSoftwareFallbackEligible, transcodeSourceUnavailable } = require("./lib/transcode-fallback");
const { noteOwner, handleStopRequest } = require("./lib/transcode-stop");
const { vodReachedEnd, noPacketsLabel } = require("./lib/vod-end");
const pauseKeepalive = require("./lib/pause-keepalive");
const PAUSE_KEEPALIVE_MAX_MS = pauseKeepalive.maxMsFrom(process.env.PAUSE_KEEPALIVE_MAX_MS);

// Circuit breaker: transcoderKey -> timestamp of the last give-up where the
// source never connected (invalid/broken upstream). A fresh request for that
// key within TRANSCODE_FAIL_COOLDOWN_MS is refused instead of respawning
// ffmpeg at a dead input on every player manifest retry.
const transcoderFailures = new Map();
const TRANSCODE_FAIL_COOLDOWN_MS = 60_000;

// In-flight transcoder spawns, keyed by transcoderKey. Single-flight
// guard so concurrent requests for the same key await one spawn instead
// of racing a second ffmpeg into the same segment dir (that race caused
// two ffmpeg writing one folder → CPU spike + playback spinner).
const transcoderInflight = new Map();

// Hardware H.264 encode (Intel Quick Sync via VAAPI). Probed once at
// boot: if /dev/dri/renderD128 is present and a tiny h264_vaapi encode
// succeeds, transcodes offload to the iGPU (~10x less CPU than libx264).
// Falls back to software libx264 when unavailable (no Intel GPU, or
// /dev/dri not passed into the container), so the image stays portable.
const VAAPI_DEVICE = "/dev/dri/renderD128";
let HW_ENCODE = false;
(function probeHwEncode() {
  try {
    if (!fs.existsSync(VAAPI_DEVICE)) return;
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-vaapi_device", VAAPI_DEVICE,
      "-f", "lavfi", "-i", "testsrc=size=320x240:rate=5",
      "-frames:v", "5", "-vf", "format=nv12,hwupload",
      "-c:v", "h264_vaapi", "-f", "null", "-",
    ], { timeout: 15000 });
    HW_ENCODE = r.status === 0;
  } catch { HW_ENCODE = false; }
  console.log(`[transcode] hardware H264 encode (VAAPI): ${HW_ENCODE ? "ENABLED" : "disabled (software libx264)"}`);
})();
// A stream that's on-screen and wanted can still go request-silent for a
// minute-plus, in TWO ways that are indistinguishable server-side from
// "the viewer left":
//   - Live: a Cast receiver rebuffering through a WiFi blip stops
//     fetching segments mid-stall.
//   - VOD: the transcoder writes a grow-only playlist (hls_list_size 0)
//     with no -re pacing, so ffmpeg races far ahead of realtime; the
//     player fills a deep forward buffer in one burst, then plays it out
//     for 60-90s making ZERO requests before it fetches again.
// Reaping either mid-buffer kills a stream the user is actively watching
// — for VOD that froze every movie ~68s in (the forward buffer drains
// into an already-killed ffmpeg). So ALL modes share one generous idle
// grace; only a genuinely departed viewer, or an already-displaced
// entry, reaps sooner. Cost: a cap=1 slot held up to the grace after a
// real departure — the same tradeoff live already accepted. Env-tunable
// (the env name is historical — it now governs VOD too).
const LIVE_IDLE_GRACE_MS = (() => {
  const n = parseInt(process.env.LIVE_IDLE_GRACE_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 180_000;
})();
// Single "is this stream still wanted?" idle window, used by EVERY
// teardown/keepalive path so they agree on one boundary: both idle
// reapers, the self-heal respawn gate, and the stall watchdog. If they
// disagreed, an ffmpeg that exits mid-rebuffer would be torn down in the
// gap with nothing left to resume into.
const idleWindowMs = () => LIVE_IDLE_GRACE_MS;

// --- Live transcoder self-heal --------------------------------------------
// Live upstreams stall (the playlist stops advancing) and rotate CDN hosts; a
// single ffmpeg can wedge alive-but-silent or exit outright. Without recovery
// the cast freezes forever (the idle reaper then SIGKILLs the wedged ffmpeg —
// exit 123 — and nothing respawns). These bound the stall watchdog + respawn.
const STALL_MS = 25_000;          // no new live segment for this long = wedged
const STALL_GRACE_MS = 30_000;    // skip the stall-check this long after a (re)spawn
const MAX_RESTARTS = 5;           // ...within RESTART_WINDOW_MS, else give up (off-air)
const RESTART_WINDOW_MS = 60_000;
// A respawn that connect-fails on a channel we KNOW was live (everConnected) is almost
// always the cap=1 panel still holding our just-killed connection's slot. Wait this long
// before retrying so the panel notices the drop and frees the slot — what a manual
// stop+re-cast does implicitly. (issue #56)
const SLOT_RELEASE_MS = 6_000;
// Slot-held retries are real connections to a cap=1 panel — cap them tighter than the
// general restart budget, and reset on any run that emits a segment (so a channel that
// recovers then stalls again gets a fresh budget). (issue #56 review)
const MAX_SLOT_RETRIES = 3;

// Deliberate, terminal kill (no respawn). The flag lets the exit handler tell
// an operator stop (quality switch, idle reaper, displaced viewer) apart from
// a crash/stall that should self-heal.
function stopTranscoder(t, reason = "?") {
  if (!t) return;
  t.stopping = true;
  console.log(`[transcode ${t.mode}-${t.id}-${t.quality}] stopping (${reason})`);
  try { t.proc.kill("SIGTERM"); } catch {}
}

// Sum of #EXTINF durations already written to a VOD transcoder's on-disk
// playlist — the actual elapsed seconds produced so far. NOT segment-count *
// nominal -hls_time: the muxer cuts at the next keyframe at-or-after that
// target, and GOP size here is pinned to a fixed 48 frames, so real segment
// duration is 48/sourceFps rounded up to the next GOP boundary ≥ hls_time —
// exactly 4s only at 24fps; ~4.8s at 30fps, ~5.76s at 25fps. A respawn seek
// offset built from segment count alone would drift further off with every
// respawn on any non-24fps source. Reading the real EXTINF values sidesteps
// the framerate math entirely.
function playlistElapsedSecs(dir) {
  try {
    const text = fs.readFileSync(path.join(dir, "index.m3u8"), "utf8");
    let total = 0;
    for (const m of text.matchAll(/#EXTINF:([\d.]+),/g)) total += parseFloat(m[1]);
    return total;
  } catch { return 0; }
}

// Newest seg mtime + next free segment number for a live transcoder dir.
function liveSegStats(dir) {
  let maxN = -1, newest = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^seg_(\d+)\.ts$/.exec(f);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
      const mt = fs.statSync(path.join(dir, f)).mtimeMs;
      if (mt > newest) newest = mt;
    }
  } catch {}
  return { nextNumber: maxN + 1, newest };
}

// --- Server-side panel concurrency enforcement ----------------------------
// The Xtream panel locks the account when active connections exceed
// `max_connections`. The previous safety story was per-browser-session
// (each device tore down its own previous stream before starting a new
// one). That fails when multiple family members on different devices
// independently start streams: each thinks it's behaving correctly but
// together they trip the cap.
//
// This middleware makes the Node server the single arbiter. It tracks
// every panel-touching request, attributes it to an "owner" (cookie
// session for browsers, IP+UA for non-browser clients), and enforces a
// configurable cap. When a new stream would exceed the cap, the OLDEST
// active stream gets killed (not the new one) — the user pressing play
// in front of them always wins.
//
// A displaced session is tagged so its next in-flight request returns
// HTTP 410 Gone with a `Khouch-Displaced: 1` header — the client can
// then toast "Another device started watching."
const MAX_CONCURRENT_STREAMS = (() => {
  const n = parseInt(process.env.MAX_CONCURRENT_STREAMS, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
})();
const STREAM_IDLE_MS = 60_000; // a stream with no requests for 60s is dead

// streams: Map<ownerKey, { mode, id, accountKey, since, lastSeen, killers, displaced }>
// One slot per owner — switching streams within the same owner just
// replaces the entry rather than counting twice.
//
// `accountKey` identifies which IPTV upstream this stream is hitting,
// so the concurrency cap is partitioned per panel-credential.
// Different IPTV accounts have independent `max_connections` budgets;
// owner A's stream against account X must not be displaced by owner
// B's stream against account Y. Today the server has a single global
// IPTV account from .env so accountKey is global; when PR 14 + PR 15
// land with per-user panel credentials, accountKey will be derived
// per-request and this Map's partitioning still works unchanged.
const streams = new Map();

function currentAccountKey() {
  // Identity of the upstream panel account currently in use. Both the
  // host and the panel user matter — same user across two hosts is two
  // separate accounts, two users on one host are also separate. PR 3
  // will replace this owner-only lookup with accountKeyOf(req.account)
  // at the route level.
  return accountKeyOf(ownerAccount);
}

function ownerKeyOf(req) {
  // Prefer the session cookie so a single browser session is one owner
  // even across hard refreshes. Fall back to IP+UA hash for non-browser
  // clients (curl scripts, the Android TV app pre-cookie).
  const cookie = parseSessionCookie(req);
  if (cookie) return `s:${cookie.slice(0, 24)}`;
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xff || req.socket.remoteAddress || "unknown";
  const ua = (req.headers["user-agent"] || "").slice(0, 64);
  return `ip:${ip}:${crypto.createHash("sha1").update(ua).digest("hex").slice(0, 8)}`;
}

// Pull mode + id out of a panel-direct URL so a /api/proxy request can
// be attributed to a specific stream. Pattern matches:
//   /<mode>/USER/PASS/<id>.<ext>          (direct VOD or live manifest)
//   /hlsr/<token>/USER/PASS/<chid>/...    (live segment URLs)
function parseStreamFromPanelUrl(panelUrl) {
  let parsed;
  try { parsed = new URL(panelUrl); } catch { return null; }
  let m = parsed.pathname.match(/^\/(live|movie|series|disk)\/[^/]+\/[^/]+\/(\d+)\.[a-z0-9]+$/i);
  if (m) return { mode: m[1].toLowerCase(), id: m[2] };
  m = parsed.pathname.match(/^\/hlsr\/[^/]+\/[^/]+\/[^/]+\/(\d+)\//);
  if (m) return { mode: "live", id: m[1] };
  return null;
}

// Admit a request as starting/sustaining a stream for (mode, id) on
// behalf of `owner`, scoped to the panel `accountKey`. Registers a
// killer the admission layer can invoke if it later needs to displace
// this owner. Cap check counts ONLY entries that share the same
// accountKey — different IPTV accounts have independent budgets and
// don't displace each other. Returns:
//   { ok: true } — proceed
//   { ok: false, reason: "displaced" } — owner was already displaced
function admitStream(owner, mode, id, killer, accountKey) {
  const existing = streams.get(owner);
  noteViewerActivity(owner); // Save-to-Disk waits a grace after any viewer activity
  // Anything real (a viewer, a phone download) beats a tile preview, which
  // never counts against the cap. Save-to-Disk jobs never admit while a
  // preview holds the slot (slotHolder), so they are not checked here.
  if (!diskDlSchedule.isDiskDownloadOwner(owner)) stopPreviews(`admit ${mode}`);
  if (existing && existing.displaced) {
    // The previous request from this owner was displaced; the client
    // hasn't yet learned. Reject so it surfaces.
    return { ok: false, reason: "displaced" };
  }
  if (existing && existing.mode === mode && String(existing.id) === String(id) && existing.accountKey === accountKey) {
    // Same owner, same stream, same account — just bump. Keep ONLY the latest
    // killer: a live manifest is reloaded every few seconds and each reload
    // makes a fresh closure, so `.add` accumulated dozens of identical killers.
    // A later reap/displace then fired the whole pile — dozens of SIGTERMs at
    // one ffmpeg → exit 123 ("> 3 system signals") → the cast died on a brief
    // viewer blip. One killer is enough; the latest targets the current quality.
    existing.lastSeen = existing.mediaSeen = Date.now();
    if (killer) { existing.killers.clear(); existing.killers.add(killer); }
    return { ok: true };
  }
  if (existing) {
    // Same owner switched streams (or accounts) — release the old
    // killers so any panel slot it held is freed before the new fetch.
    console.log(`[concurrency] same-owner switch ${owner}: ${existing.mode}:${existing.id}/${existing.accountKey} -> ${mode}:${id}/${accountKey}`);
    for (const k of existing.killers) { try { k("owner-switch"); } catch {} }
    streams.delete(owner);
  }
  // Per-account cap: only entries sharing this accountKey count
  // against the new request's budget. Owner A on account X never
  // displaces owner B on account Y.
  const sameAccount = [];
  for (const [k, v] of streams) {
    if (v.accountKey === accountKey && !v.displaced && !v.preview) sameAccount.push([k, v]);
  }
  if (sameAccount.length >= MAX_CONCURRENT_STREAMS) {
    let oldest = sameAccount[0];
    for (const [k, v] of sameAccount) {
      if (v.since < oldest[1].since) oldest = [k, v];
    }
    const [oldKey, oldEntry] = oldest;
    oldEntry.displaced = true; // tag survives until the entry is reaped
    for (const k of oldEntry.killers) { try { k("admit-displace"); } catch {} }
    console.log(`[concurrency] displaced ${oldKey} (acct=${accountKey}) for ${owner} (${mode}:${id}) — cap=${MAX_CONCURRENT_STREAMS}`);
  }
  streams.set(owner, {
    mode, id: String(id),
    accountKey,
    since: Date.now(),
    lastSeen: Date.now(),
    // Last REAL media request (manifest/segment/bytes). lastSeen can also be
    // bumped by a pause heartbeat; mediaSeen bounds how long that may last.
    mediaSeen: Date.now(),
    killers: new Set(killer ? [killer] : []),
    displaced: false,
  });
  return { ok: true };
}

// Bump lastSeen for a request that's part of an existing stream but
// doesn't carry mode/id (a segment fetch from /api/proxy with a hashed
// segment path). Returns false if the owner has been displaced — the
// caller should 410 the request.
function touchStream(owner) {
  const entry = streams.get(owner);
  if (!entry) return true; // no record = first request for this owner
  if (entry.displaced) return false;
  entry.lastSeen = entry.mediaSeen = Date.now();
  noteViewerActivity(owner);
  return true;
}

// Client IP exactly as ownerKeyOf derives it (for pause-heartbeat matching
// against the Android players' cookie-less "ip:" owner keys).
function callerIpOf(req) {
  const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xff || req.socket.remoteAddress || "unknown";
}

// Pause keep-alive (lib/pause-keepalive.js). While a movie/episode/disk title
// is PAUSED the player makes no media requests, so the idle reaper would free
// the slot (and delete the transcode) after LIVE_IDLE_GRACE_MS. Clients POST
// { mode, id } about once a minute while paused (up to 60 min); this only
// refreshes the caller's EXISTING session for that title. No upstream I/O.
app.post("/api/stream/heartbeat", express.json(), (req, res) => {
  // A paused player on some device (a valid heartbeat): no tile preview may
  // hold the connection.
  if (pauseKeepalive.parseHeartbeat(req.body).ok) previewViewerActivity(ownerKeyOf(req), "heartbeat");
  const r = pauseKeepalive.handleHeartbeat(req.body, {
    streams, transcoders, callerOwner: ownerKeyOf(req), callerIp: callerIpOf(req),
    now: Date.now(), maxMs: PAUSE_KEEPALIVE_MAX_MS,
  });
  if (r.status === 410) return sendDisplaced(res);
  res.setHeader("Cache-Control", "no-store");
  res.status(r.status).json(r.body);
});

// --- Tile previews from the title stream (lib/stream-preview.js, docs/TILE_PREVIEWS.md)
// Lowest priority user of the household's one provider connection: admitted
// only while nobody is watching, stopped by anything real, one at a time.
// TILE_STREAM_PREVIEW=0 turns it off (the endpoint answers 503 disabled).
const streamPreview = require("./lib/stream-preview");
const TILE_STREAM_PREVIEW = process.env.TILE_STREAM_PREVIEW !== "0";
const PREVIEW_DURATION_SECS = 90;
const PREVIEW_IDLE_MS = 20_000;       // running, no manifest/segment request: the TV left
const PREVIEW_MAX_MS = 4 * 60_000;    // hard cap on one preview's life
const PREVIEW_LINGER_MS = 60_000;     // after ffmpeg finished: segments stay this long past the last request
const PREVIEW_DIR = path.join(TRANSCODE_DIR, "previews");
const previewSignals = new Map();     // owner -> latest play/progress/heartbeat (noteSignal)
const previewStartRate = new Map();   // requester -> { n, t }
// SIGKILLed preview ffmpegs that have not exited yet (may still hold the provider connection).
const previewProcsExiting = new Map(); // proc -> { pid, at, warned }
let activePreview = null;             // { sid, requester, mode, id, streamId, accountKey, dir, proc, ... }
// Bumped by every real play request: a preview request that was waiting
// (series info, the previous preview's exit) when one arrived gives up.
let previewPlayEpoch = 0;
const PREVIEW_MIN_GAP_MS = 5_000;     // provider connection churn: at most one new preview per 5 s
let previewLastStartAt = 0;
let previewReqSeq = 0;                // newest admitted-for-processing preview request (latest focus wins)
try { fs.rmSync(PREVIEW_DIR, { recursive: true, force: true }); } catch {} // crash leftovers

function previewSig(sid) {
  return crypto.createHmac("sha256", PROXY_SECRET).update(`preview:${sid}`).digest("hex").slice(0, 16);
}
function previewSigOk(sid, s) {
  const want = Buffer.from(previewSig(sid));
  const got = Buffer.from(typeof s === "string" ? s : "");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Stop the current preview (if any): ffmpeg SIGKILLed at once (nothing to
// keep, and its provider connection closes with the process), slot entry
// removed, segments deleted. Returns null when nothing was stopped, else a
// promise that resolves once that ffmpeg has exited (at most ~2 s).
function stopPreviews(reason, exceptRequester = null) {
  const p = activePreview;
  if (!p) return null;
  if (exceptRequester && p.requester === exceptRequester) return null;
  activePreview = null;
  streams.delete(`${streamPreview.PREVIEW_OWNER_PREFIX}${p.sid}`);
  const proc = p.proc;
  const running = !!proc && proc.exitCode === null && proc.signalCode === null;
  const exited = running
    ? new Promise((resolve) => {
      const t = setTimeout(() => {
        console.warn(`[preview] ${p.sid} ffmpeg pid ${proc.pid} did not exit within 2 s of SIGKILL (${reason})`);
        resolve(false);
      }, 2000);
      proc.once("exit", () => { clearTimeout(t); previewProcsExiting.delete(proc); resolve(true); });
      proc.once("error", () => previewProcsExiting.delete(proc));
    })
    : Promise.resolve();
  if (running) { if (proc.pid != null) previewProcsExiting.set(proc, { pid: proc.pid, at: Date.now(), warned: false }); try { proc.kill("SIGKILL"); } catch {} }
  p.stopped = true;
  setTimeout(() => fs.rm(p.dir, { recursive: true, force: true }, () => {}), 2000).unref?.();
  console.log(`[preview] ${p.sid} stop (${reason}) ${p.mode}:${p.streamId} after ${Math.round((Date.now() - p.startedAt) / 1000)}s`);
  return exited;
}
// A real player somewhere (progress / heartbeat / play request): remember it
// for admission, and stop a preview another device is running. Returns
// stopPreviews' exit promise (null = nothing stopped).
function previewViewerActivity(owner, kind) {
  streamPreview.noteSignal(previewSignals, owner, kind === "play-live" || kind === "play-vod" ? kind : "activity", Date.now());
  if (kind === "play-live" || kind === "play-vod") previewPlayEpoch++;
  if (kind === "play-live" || kind === "play-vod") return stopPreviews(`play ${kind === "play-live" ? "live" : "vod"}`);
  return stopPreviews(kind, owner);
}
function spawnPreviewFfmpeg(p, hw) {
  fs.rmSync(p.dir, { recursive: true, force: true });
  fs.mkdirSync(p.dir, { recursive: true });
  const args = streamPreview.previewFfmpegArgs({
    sourceUrl: p.sourceUrl, startSecs: p.startSecs, durationSecs: PREVIEW_DURATION_SECS,
    audioTrack: p.audioTrack, hw, vaapiDevice: VAAPI_DEVICE, reconnectArgs: panelReconnectArgs(),
    userAgent: "Mozilla/5.0 (Linux; Android 12; Smart TV)", dir: p.dir,
  });
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  p.proc = proc;
  p.hw = hw;
  try { os.setPriority(proc.pid, 10); } catch {}
  let err = "";
  proc.stderr.on("data", (d) => { if (err.length < 2000) err += d.toString(); });
  proc.on("error", () => {});
  proc.on("exit", (code) => {
    if (activePreview !== p || p.proc !== proc) return;
    // The provider connection is closed now: the preview no longer holds the slot.
    streams.delete(`${streamPreview.PREVIEW_OWNER_PREFIX}${p.sid}`);
    const segs = (() => { try { return fs.readdirSync(p.dir).filter((f) => f.endsWith(".ts")).length; } catch { return 0; } })();
    if (code !== 0 && segs === 0 && hw && !p.retried) {
      // VAAPI refused this source (10-bit H.264, AV1...): once more in software.
      p.retried = true;
      hwDecodeFailed.add(`${p.mode}:${p.streamId}`);
      console.log(`[preview] ${p.sid} hw run failed, retrying in software: ${err.trim().split("\n").pop()?.slice(0, 160) || code}`);
      // Same gate as a fresh start: a viewer / the server may have taken the
      // provider since (the slot entry was just dropped).
      if (previewBlockedReason(p.requester) != null || !registerPreviewSlot(p)) { stopPreviews("busy on retry"); return; }
      try { spawnPreviewFfmpeg(p, false); } catch (e) {
        console.log(`[preview] ${p.sid} software retry failed: ${e.message}`);
        stopPreviews("retry failed");
      }
      return;
    }
    p.ended = true;
    p.lastAccess = Date.now();
    if (code !== 0) console.log(`[preview] ${p.sid} ffmpeg exit ${code} after ${segs} segment(s): ${err.trim().split("\n").pop()?.slice(0, 160) || ""}`);
  });
}
// Why a preview may not start now (null = it may): someone is watching
// (decideAdmission), or the server itself is using the provider (a liveness /
// codec probe, the xmltv download, a catalog rebuild's claim).
function previewBlockedReason(requester) {
  const adm = streamPreview.decideAdmission({
    streams, signals: previewSignals, requester, accountKey: currentAccountKey(), now: Date.now(),
    idleGraceMs: LIVE_IDLE_GRACE_MS, isBackgroundOwner: diskDlSchedule.isBackgroundOwner, isDiskDownloadOwner: diskDlSchedule.isDiskDownloadOwner,
  });
  if (!adm.ok) return adm.reason || "viewer";
  if (anyProbeInflight() || diskDownloadPanelBusy > 0 || Date.now() - diskDownloadPanelClaimAt < DISK_DOWNLOAD_PANEL_CLAIM_MS) return "provider";
  return null;
}
// The preview's entry in the admission map: counts as holding the slot (Save
// to Disk waits for it), displaced by any real admission (its killer).
function registerPreviewSlot(p) {
  const now = Date.now();
  const adm = streamPreview.decideAdmission({
    streams, signals: previewSignals, requester: p.requester, accountKey: p.accountKey, now,
    idleGraceMs: LIVE_IDLE_GRACE_MS, isBackgroundOwner: diskDlSchedule.isBackgroundOwner, isDiskDownloadOwner: diskDlSchedule.isDiskDownloadOwner,
  });
  if (!adm.ok) return false;
  streams.set(`${streamPreview.PREVIEW_OWNER_PREFIX}${p.sid}`, {
    mode: p.mode, id: String(p.streamId), accountKey: p.accountKey,
    since: now, lastSeen: now, mediaSeen: now, preview: true,
    killers: new Set([() => stopPreviews("displaced")]), displaced: false,
  });
  return true;
}
setInterval(() => {
  const p = activePreview;
  if (!p) return;
  const now = Date.now();
  if (now - p.startedAt > PREVIEW_MAX_MS) stopPreviews("max age");
  else if (!p.ended && now - p.lastAccess > PREVIEW_IDLE_MS) stopPreviews("idle");
  else if (p.ended && now - p.lastAccess > PREVIEW_LINGER_MS) stopPreviews("done");
}, 5000).unref?.();

// GET /api/preview/:mode/:id -> { sid, url, mode, id, series_id, start, duration }
// 409 busy (someone is watching), 403 not_allowed (kid gate), 503 disabled.
app.get("/api/preview/:mode(movie|series)/:id(\\d{1,12})", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    if (!TILE_STREAM_PREVIEW) return res.status(503).json({ error: "disabled" });
    const actx = currentAccount();
    if (!isOwnerAccount(actx)) return res.status(403).json({ error: "not_allowed" });
    const { mode, id } = req.params;
    const requester = ownerKeyOf(req);
    const now = Date.now();
    const epoch0 = previewPlayEpoch;
    const rl = previewStartRate.get(requester);
    if (rl && now - rl.t < 60_000 && rl.n >= 20) return res.status(429).json({ error: "slow down" });
    if (!rl || now - rl.t >= 60_000) previewStartRate.set(requester, { n: 1, t: now }); else rl.n += 1;
    if (previewStartRate.size > 200) for (const [k, v] of previewStartRate) if (now - v.t >= 60_000) previewStartRate.delete(k);
    const item = indexes[mode]?.byId?.get(parseInt(id, 10));
    if (!item) return res.status(404).json({ error: "not in catalog" });
    // Kid profiles: the title's rating must be within their allowed certs
    // (unrated = no preview), like trailers.
    const certs = kidCertsForProfile(findProfile(req.profileId));
    if (certs && !certs.has(effCert(tmdbCache[`${mode}:${id}`]))) return res.status(403).json({ error: "not_allowed" });
    // Cheap pre-check before any panel call: someone is watching -> 409 now.
    const pre = previewBlockedReason(requester);
    if (pre) return res.status(409).json({ error: "busy", reason: pre });
    // The TV moves focus fast: a request it has abandoned (connection closed)
    // or that a newer preview request superseded must not open a connection.
    // A newer request supersedes this one even if it later fails (404, kid
    // gate, info_unavailable): acceptable, the latest focus wins.
    const seq = ++previewReqSeq;
    let clientGone = false;
    res.on("close", () => { clientGone = true; });
    const abandoned = () => clientGone || res.writableEnded || !!req.socket?.destroyed;
    // Stale = abandoned, superseded, or a real play started meanwhile. Checked
    // after every await and BEFORE anything with side effects (stopping the
    // current preview, preempting Save to Disk): a stale request must not
    // kill a newer request's preview on its way to a 409.
    // -> true when the request is done (response sent or client gone).
    const bailIfStale = () => {
      if (abandoned()) return true;
      if (previewPlayEpoch !== epoch0) { res.status(409).json({ error: "busy", reason: "play" }); return true; }
      if (seq !== previewReqSeq) { res.status(409).json({ error: "busy", reason: "superseded" }); return true; }
      return false;
    };
    const userState = getProfileState(req.profileId);
    let streamId = String(id), ext = String(item.container || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp4", durationSecs = null, seriesId = null, le = null;
    if (mode === "movie") {
      durationSecs = panelDurationSecsCached("movie", id) || (Number(tmdbCache[`movie:${id}`]?.runtime) * 60 || null);
    } else {
      seriesId = String(id);
      const params = { series_id: seriesId };
      const infoKey = xtreamKey(actx, MODES.series.info, params);
      let info = cache.get(infoKey)?.v || null;
      if (!info?.episodes) {
        try { info = await xtream(MODES.series.info, params, { actx, timeout: INFO_PANEL_TIMEOUT_MS }); } catch { info = null; }
      }
      if (!info?.episodes) info = (await infoStore.get(infoKey).catch(() => null))?.v || null;
      le = userState.lastEpisode?.[seriesId] || userState.lastEpisode?.[String(parseInt(seriesId, 10))] || null;
      const ep = streamPreview.pickSeriesEpisode(info, le);
      if (bailIfStale()) return;
      if (!ep) return res.status(503).json({ error: "info_unavailable" });
      streamId = ep.id; ext = ep.ext; durationSecs = ep.durationSecs;
    }
    if (bailIfStale()) return;
    const prog = userState.progress?.[`${mode}:${streamId}`];
    // Resume point when the profile has one (movie position, or the series'
    // in-progress / next episode); read only, a preview never writes progress.
    // Next episode = the continue pointer at an episode with no progress yet (a
    // nearly finished one keeps its ~10 % start).
    const nextEpisode = mode === "series" && !(Number(prog?.p) >= 60) && le != null && String(le.episode_id ?? "") === String(streamId);
    const startSecs = streamPreview.previewStartSecs({ progressSecs: prog?.p, durationSecs: durationSecs || prog?.d, nextEpisode });
    // Connection churn: at most one new preview per PREVIEW_MIN_GAP_MS (the
    // request waits out the rest of the gap).
    // Recomputed after each sleep (a preview may have started meanwhile); a
    // request superseded while it waited gives up, so the latest focus wins.
    for (let gap; (gap = previewLastStartAt + PREVIEW_MIN_GAP_MS - Date.now()) > 0;) {
      await new Promise((r) => setTimeout(r, gap));
      if (bailIfStale()) return;
    }
    if (bailIfStale()) return;
    // One at a time: this replaces any current preview (ours or another
    // device's); its provider connection must be closed before ours opens.
    for (let i = 0; i < 3 && activePreview; i++) {
      const prev = stopPreviews("replaced");
      // Its ffmpeg may still hold the provider connection: never open a second one.
      if (prev && (await prev) === false) return abandoned() ? undefined : res.status(409).json({ error: "busy", reason: "preview" });
      if (bailIfStale()) return; // a newer request may have claimed meanwhile: don't stop ITS preview
    }
    // Yield the connection like a viewer does: a running Save-to-Disk transfer
    // stops, and its connection must be gone before ours opens.
    if (preemptDiskDownloadsForViewer("preview")) {
      for (let i = 0; i < 30 && [...streams.keys()].some((k) => diskDlSchedule.isDiskDownloadOwner(k)); i++) await new Promise((r) => setTimeout(r, 100));
    }
    // Final checks, then claim: no await from here to spawn, so a concurrent
    // request or a real play can't slip in between.
    if (bailIfStale()) return;
    if (previewProcsExiting.size) {
      for (const e of previewProcsExiting.values()) {
        if (!e.warned && Date.now() - e.at > 60_000) { e.warned = true; console.warn(`[preview] killed ffmpeg pid ${e.pid} still not exited after 60 s: previews stay blocked until it does`); }
      }
      return res.status(409).json({ error: "busy", reason: "preview" });
    }
    if (activePreview) return res.status(409).json({ error: "busy", reason: "preview" });
    if ([...streams.keys()].some((k) => diskDlSchedule.isDiskDownloadOwner(k))) return res.status(409).json({ error: "busy", reason: "download" });
    const late = previewBlockedReason(requester);
    if (late) return res.status(409).json({ error: "busy", reason: late });
    const sid = streamPreview.newSid((n) => crypto.randomBytes(n).toString("hex"));
    // `now` is the request's entry time (up to ~40 s of awaits ago): the reaper
    // must time this preview from its claim.
    const claimAt = Date.now();
    const p = {
      sid, requester, mode, id: String(id), streamId, accountKey: currentAccountKey(),
      dir: path.join(PREVIEW_DIR, sid), startSecs, startedAt: claimAt, lastAccess: claimAt,
      sourceUrl: streamUrl(mode, streamId, ext, actx),
      audioTrack: cachedAudioPick(mode, streamId) ?? 0,
    };
    if (!registerPreviewSlot(p)) {
      const adm = streamPreview.decideAdmission({ streams, signals: previewSignals, requester, accountKey: p.accountKey, now: Date.now(), idleGraceMs: LIVE_IDLE_GRACE_MS, isBackgroundOwner: diskDlSchedule.isBackgroundOwner, isDiskDownloadOwner: diskDlSchedule.isDiskDownloadOwner });
      return res.status(409).json({ error: "busy", reason: adm.reason || "viewer" });
    }
    activePreview = p;
    previewLastStartAt = Date.now();
    try { spawnPreviewFfmpeg(p, HW_ENCODE && !hwDecodeFailed.has(`${mode}:${streamId}`)); } catch (e) {
      stopPreviews("spawn failed");
      throw e;
    }
    console.log(`[preview] ${sid} start ${mode}:${streamId}${seriesId ? ` (series ${seriesId})` : ""} at ${startSecs}s`);
    res.json({
      sid, url: `/api/preview/${sid}/index.m3u8?s=${previewSig(sid)}`,
      mode, id: Number(streamId), series_id: seriesId ? Number(seriesId) : null,
      start: startSecs, duration: PREVIEW_DURATION_SECS,
    });
  } catch (e) { next(e); }
});
// POST /api/preview/stop { sid } — the TV's focus left the tile.
app.post("/api/preview/stop", express.json({ limit: "1kb" }), (req, res) => {
  res.set("Cache-Control", "no-store");
  const sid = req.body?.sid;
  if (!streamPreview.isValidSid(sid)) return res.status(400).json({ error: "bad sid" });
  const stopped = activePreview?.sid === sid ? !!stopPreviews("client stop") : false;
  res.json({ ok: true, stopped });
});

// Exact panel duration for a VOD title from what is ALREADY cached (never a
// panel call): get_vod_info for movies, the cached series info for episodes.
function panelDurationSecsCached(mode, id) {
  if (mode === "movie") {
    for (const vid of [String(id), Number(id)]) {
      const hit = cache.get(xtreamKey(ownerAccount, MODES.movie.info, { vod_id: vid }));
      const d = Number(hit?.v?.info?.duration_secs);
      if (Number.isFinite(d) && d > 0) return d;
    }
    return null;
  }
  if (mode === "series") return sidecarGroupFor("series", id)?.dur || null;
  return null;
}

function dropStreamKiller(owner, killer) {
  const entry = streams.get(owner);
  if (entry) entry.killers.delete(killer);
}

// Idle reaper for the streams map. Drops entries with no recent
// requests (handles ungraceful client disconnects) and clears the
// stale "displaced" tag after the original session has had a chance
// to learn about it.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of streams) {
    // Active viewers of ANY mode get the long grace so a buffer-ahead
    // gap (live rebuffer OR a VOD player playing out a deep forward
    // buffer) survives; a displaced entry is already dead, so reap it on
    // the short window (its killers already fired; this just clears the
    // tag so the owner can start a fresh stream).
    const limit = v.displaced ? STREAM_IDLE_MS : LIVE_IDLE_GRACE_MS;
    if (now - v.lastSeen > limit) {
      if (!v.displaced) {
        const idleS = Math.round((now - v.lastSeen) / 1000);
        console.log(`[concurrency] idle-reap ${k} (${v.mode}:${v.id}, idle ${idleS}s) — freeing the slot`);
      }
      for (const kill of v.killers) { try { kill("idle-reap"); } catch {} }
      streams.delete(k);
    }
  }
}, 15_000);

// Send a uniform 410 Gone response when a request is rejected because
// the owner has been displaced. Headers + body let the client toast.
function sendDisplaced(res) {
  res.status(410)
     .setHeader("Khouch-Displaced", "1")
     .setHeader("Cache-Control", "no-store");
  res.json({ error: "displaced", message: "Another device started watching." });
}

// Quality presets driving the ffmpeg args. "med" is the historical
// default and what auto-fallback (codec-error retry) uses. Each preset
// is bound by what a 2-vCPU VPS can comfortably encode in real time —
// "high" (1080p) is feasible for one stream but drops frames if a
// second one piggybacks.
const QUALITY_PRESETS = {
  source: { copy: true,                                                              label: "Source" },
  low:    { vf: "scale='min(854,iw)':-2:flags=lanczos",  crf: "26", preset: "veryfast", aBitrate: "128k", label: "480p" },
  med:    { vf: "scale='min(1280,iw)':-2:flags=lanczos", crf: "22", preset: "fast",     aBitrate: "192k", label: "720p" },
  high:   { vf: "scale='min(1920,iw)':-2:flags=lanczos", crf: "20", preset: "fast",     aBitrate: "192k", label: "1080p" },
};
function normalizeQuality(q) {
  return QUALITY_PRESETS[q] ? q : "med";
}

// `offsetSecs` is the source-side seek anchor: when the client asks
// to skip forward past the encoded edge, we restart ffmpeg with
// `-ss <offsetSecs>` so the new playlist starts there. Including it
// in the key lets two concurrent viewers of the same title at
// different offsets get their own ffmpeg + segment dir without
// stepping on each other.
function transcoderKey(mode, id, quality, offsetSecs = 0, audio = "stereo", diskSel = null, audioTrack = 0) {
  const off = Number(offsetSecs) || 0;
  const suffix = off > 0 ? `-t${off}` : "";
  const a = audio === "surround" ? "-surround" : "";
  // Disk audio/subtitle selection changes the ffmpeg output, so it must
  // key a distinct transcoder dir (a different selected track or a
  // burned-in subtitle is a different stream).
  let dsel = "";
  if (diskSel) {
    if (Number.isFinite(diskSel.a) && diskSel.a > 0) dsel += `-da${diskSel.a}`;
    if (Number.isFinite(diskSel.s) && diskSel.s >= 0) dsel += `-ds${diskSel.s}`;
  }
  // Panel audio-track selection (?at=) maps a different upstream audio
  // stream — a distinct output, so it keys its own transcoder.
  const at = Number.isFinite(audioTrack) && audioTrack > 0 ? `-at${audioTrack}` : "";
  return `${mode}-${id}-${normalizeQuality(quality)}${a}${suffix}${dsel}${at}`;
}
// Parse disk audio/subtitle selection from a request's query (?da=, ?ds=).
// Returns null for panel modes or when nothing is selected.
function diskSelFromQuery(mode, q) {
  if (!MODES[mode]?.local) return null;
  const a = parseInt(q.da, 10);
  const s = parseInt(q.ds, 10);
  const sel = {};
  if (Number.isFinite(a) && a > 0) sel.a = a;
  if (Number.isFinite(s) && s >= 0) sel.s = s;
  return (sel.a != null || sel.s != null) ? sel : null;
}

// Normalize the `?t=` query param: float seconds, non-negative, max
// 24h (anything past that is almost certainly a client bug, and the
// suffix gets unwieldy in cache keys). 0 means "from the start".
function normalizeOffsetSecs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), 86400);
}

// Kill all transcoders for a given (mode, id) regardless of quality
// AND wait for each ffmpeg process to actually exit. Used before
// spawning a new transcoder so the panel's max_connections=1 slot is
// released BEFORE the new ffmpeg's upstream fetch — without this
// serialization the new ffmpeg races against the dying one and gets
// an Input/output error from the panel (manifest never completes,
// player wheel spins forever).
async function killAllTranscodersForId(mode, id) {
  const prefix = `${mode}-${id}-`;
  const waits = [];
  for (const [k, t] of transcoders) {
    if (!k.startsWith(prefix)) continue;
    waits.push(new Promise((resolve) => t.proc.once("exit", resolve)));
    stopTranscoder(t, "drain");
  }
  if (!waits.length) return;
  // 3s safety cap: if ffmpeg refuses to exit we don't hang the new
  // request forever. The panel will then briefly see two connections
  // but that's still better than the alternative of waiting indefinitely.
  await Promise.race([
    Promise.all(waits),
    new Promise(resolve => setTimeout(resolve, 3000)),
  ]);
}

function normalizeAudio(a) {
  return a === "surround" ? "surround" : "stereo";
}

// Panel audio-track index (?at=) — the Nth audio stream to map. 0 (or
// absent/invalid) = the default first track, i.e. today's behavior.
function normalizeAudioTrack(a) {
  const n = parseInt(a, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function startOrTouchTranscoder(mode, id, quality, offsetSecs = 0, audio = "stereo", diskSel = null, audioTrack = 0, autoPick = false) {
  quality = normalizeQuality(quality);
  offsetSecs = normalizeOffsetSecs(offsetSecs);
  audio = normalizeAudio(audio);
  audioTrack = normalizeAudioTrack(audioTrack);
  const preset = QUALITY_PRESETS[quality];
  const key = transcoderKey(mode, id, quality, offsetSecs, audio, diskSel, audioTrack);
  // Reuse the existing same-key ffmpeg if it's still alive — same
  // owner re-hitting the manifest for the same quality during normal
  // segment fetching shouldn't restart anything.
  const existing = transcoders.get(key);
  // Reuse only an ffmpeg mapping the requested track (key == mapping).
  const sameTrack = (existing?.audioTrack || 0) === audioTrack || existing?.trackReset;
  if (existing && sameTrack && (existing.respawning || !existing.proc.killed)) {
    // respawning: an ffmpeg is being replaced under this same key — treat the
    // entry as live so a manifest poll mid-respawn doesn't race a second spawn
    // into the dir.
    existing.lastAccess = existing.mediaAccess = Date.now();
    return existing;
  }
  // Single-flight: if a spawn for this key is already underway, await
  // that one instead of racing a second ffmpeg into the same segment
  // dir (the previous duplicate-transcoder bug: two ffmpeg, one folder,
  // load spike, perpetual spinner).
  const pending = transcoderInflight.get(key);
  if (pending) return pending;
  // Circuit breaker: if this source recently gave up having never connected
  // (invalid/broken upstream), don't respawn ffmpeg at it on every manifest
  // retry — refuse fast until the cooldown passes.
  if (transcodeSourceUnavailable(transcoderFailures.get(key), Date.now(), TRANSCODE_FAIL_COOLDOWN_MS)) {
    const err = new Error("transcode source unavailable");
    err.code = "SOURCE_UNAVAILABLE";
    throw err;
  }
  const startPromise = spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, null, audioTrack, false, { autoPick: autoPick && audioTrack === 0 });
  transcoderInflight.set(key, startPromise);
  startPromise.finally(() => transcoderInflight.delete(key));
  return startPromise;
}

// The actual spawn. Only ever runs once per key at a time, gated by the
// transcoderInflight single-flight map in startOrTouchTranscoder.
// Source failover: when a movie's stream never opens (dead link / 4xx / empty
// file), play another copy of the same title (see assignVariants) under the
// same transcode key, so the viewer's manifest requests just start working.
const sourceOverride = new Map(); // transcode key -> alternate stream id
// A fresh play's audio auto-pick may restart ffmpeg only this soon after
// spawn (and only before any segment exists) — later, it's left to the
// learned cache for the next play and the Audio menu.
const AUDIO_AUTOPICK_RESTART_MAX_MS = 8000;
const failoverTried = new Map();  // transcode key -> { tried:Set<id>, at }
function nextAltVariant(mode, id, tried) {
  if (mode !== "movie") return null;
  const ix = indexes.movie;
  const me = ix?.byId?.get(parseInt(id, 10));
  if (!me) return null;
  const canon = me.isAlt ? ix.byId.get(me.canonicalId) : me;
  const cands = (canon?.variants || []).map((v) => ix.byId.get(v.id)).filter(Boolean)
    .filter((c) => String(c.id) !== String(id) && !tried.has(String(c.id)));
  if (!cands.length) return null;
  const isCam = (c) => (c.tags || []).includes("cam");
  // Same audio language first (the viewer picked it), then any; never a CAM
  // rip unless the failed one was a CAM too.
  const ok = cands.filter((c) => !isCam(c) || isCam(me));
  // Never a different language than the one the viewer chose (when known).
  if (me.audioLang) return ok.find((c) => c.audioLang === me.audioLang || c.audioLang === "multi") || null;
  return ok[0] || null;
}
async function spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel = null, respawn = null, audioTrack = 0, swFallback = false, opts = {}) {
  audioTrack = normalizeAudioTrack(audioTrack);
  // Hardware encode for this run: the global VAAPI capability, unless this is
  // a software fallback retry (a prior VAAPI run was rejected by this source).
  const hw = HW_ENCODE && !swFallback && !hwDecodeFailed.has(`${mode}:${id}`);
  const dir = path.join(TRANSCODE_DIR, key);
  if (respawn && respawn.fresh) {
    // Audio auto-pick restart under its new key: fresh dir, nothing to drain
    // (the caller's ffmpeg already exited).
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } else if (!respawn) {
    // Quality switch (or stale entry) → drain any other transcoders for
    // this id and await their exit so the panel slot is free.
    await killAllTranscodersForId(mode, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  // On respawn we KEEP the dir + its segments so the live playlist is appended
  // to (continued media sequence) and the player rebuffers over the gap rather
  // than seeing a fresh stream. sourceUrl below is rebuilt fresh either way —
  // that's what recovers a CDN-host/token rotation.
  const startNumber = respawn ? respawn.startNumber : 0;
  // A VOD respawn must seek the NEW process to where the dying one actually
  // left off — the session's original offsetSecs plus the REAL elapsed time
  // already produced (playlistElapsedSecs, summed from the playlist's own
  // EXTINF values — segment-count * nominal hls_time drifts on anything but
  // a 24fps source, see that function's comment). Without this, a respawn
  // restarts the input at the session's original anchor and duplicates
  // everything already played into the (appended) playlist — a visible
  // rewind instead of a brief rebuffer. Live has no such offset (unseekable,
  // always "now"), so this only matters for movie/series.
  const effectiveOffsetSecs = (respawn && mode !== "live")
    ? offsetSecs + playlistElapsedSecs(dir)
    : offsetSecs;
  // Source container ext. Live is always HLS; VOD has to match the
  // actual file on the panel — mp4 hardcode was breaking ALL .mkv
  // titles (Bajirao Mastani 4K, etc.) with "Invalid data found when
  // processing input" because the panel returns 0 bytes for the
  // wrong-extension request. For movies the index is authoritative;
  // for series the index keys by series_id (not episode_id), so the
  // lookup misses and we fall back to mp4 — matches the equivalent
  // probe-fallback in /api/download for the same reason.
  // A failed-over movie reads from an alternate variant's stream id.
  const srcId = (mode === "movie" && sourceOverride.get(`${mode}:${id}`)) || id;
  let ext;
  if (mode === "live") {
    ext = "m3u8";
  } else if (mode === "movie") {
    ext = indexes.movie.byId.get(parseInt(srcId, 10))?.container || "mp4";
  } else if (MODES[mode].local) {
    ext = getIndexesFor(currentAccount()).disk?.byId?.get(parseInt(id, 10))?.container || "mp4";
  } else {
    ext = "mp4"; // series — see comment above
  }
  const sourceUrl = streamUrl(mode, srcId, ext); // panel URL, or absolute path for disk
  // Audio codec selection:
  //  - "stereo" (default): AAC 192/preset stereo. Max compatibility.
  //  - "surround": E-AC3 384k passthrough for AVR-connected Android TVs.
  const audioArgs = audio === "surround"
    ? ["-c:a", "eac3", "-b:a", "384k"]
    : ["-c:a", "aac", "-b:a", preset.copy ? "192k" : preset.aBitrate, "-ac", "2"];
  const args = [
    // level+info (not "error"): the input's stream dump is info-level and is
    // how panel audio tracks are learned (learnPanelTracks). Each line carries
    // its level; only error-level lines reach stderrBuf, so exit-tail
    // diagnostics are exactly what "-loglevel error" used to print.
    // -nostats drops the per-0.5s progress line info would otherwise add.
    "-hide_banner", "-nostats", "-loglevel", "level+info",
    // Tolerate corrupt/truncated source. Panels ship damaged files (a few
    // bad H264 NAL units mid-title, or a corrupt live segment). Without
    // this ffmpeg aborts on the bad frames (exit 255) and the WHOLE title
    // dies at that timestamp — the player then spins forever with no way
    // past it. discardcorrupt drops the bad packets and ignore_err keeps
    // decoding, so playback glitches through the damage instead of freezing.
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
  ];

  if (MODES[mode].local) {
    // --- Local disk file. We only reach the transcoder when direct play
    // is impossible: unsafe video (avi/mpeg4), unsafe or non-default audio
    // (DTS, alt language track), or an image-subtitle burn-in. Copy the
    // video stream whenever it's already browser-safe (audio-only remux)
    // so seeking stays responsive; re-encode only when we must.
    const meta = getIndexesFor(currentAccount()).disk?.meta?.get(parseInt(id, 10)) || {};
    const videoSafe = BROWSER_SAFE_VIDEO.has(meta.video?.codec);
    const defAudio = Array.isArray(meta.audioTracks) ? meta.audioTracks.findIndex(t => t.default) : -1;
    const aIdx = (diskSel && Number.isFinite(diskSel.a)) ? diskSel.a : (defAudio >= 0 ? defAudio : 0);
    let burnIdx = null;
    if (diskSel && Number.isFinite(diskSel.s) && meta.subTracks?.[diskSel.s]?.kind === "image") burnIdx = diskSel.s;
    const copyVideo = videoSafe && burnIdx == null;
    if (hw && !copyVideo && burnIdx == null) args.push("-vaapi_device", VAAPI_DEVICE);
    if (offsetSecs > 0) args.push("-ss", String(offsetSecs));
    args.push("-i", sourceUrl);
    if (copyVideo) {
      args.push("-map", "0:v:0", "-map", `0:a:${aIdx}?`, "-c:v", "copy", ...audioArgs);
    } else if (burnIdx != null) {
      // Image subs (PGS/VOBSUB) can't be a text <track> — overlay them onto
      // the decoded frame. Overlay needs raw frames, so this path is always
      // software libx264 (the VAAPI hwupload chain can't take the overlay).
      args.push(
        "-filter_complex", `[0:v:0][0:s:${burnIdx}]overlay[v]`,
        "-map", "[v]", "-map", `0:a:${aIdx}?`,
        "-c:v", "libx264", "-preset", preset.preset,
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-crf", preset.crf, "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        ...audioArgs, "-af", "aresample=async=1000:first_pts=0",
      );
    } else if (hw) {
      args.push(
        "-map", "0:v:0", "-map", `0:a:${aIdx}?`,
        "-vf", `${preset.vf},format=nv12,hwupload`,
        "-c:v", "h264_vaapi", "-qp", String(preset.crf),
        "-profile:v", "high", "-level", "41", "-g", "48", "-keyint_min", "48",
        ...audioArgs, "-af", "aresample=async=1000:first_pts=0",
      );
    } else {
      args.push(
        "-map", "0:v:0", "-map", `0:a:${aIdx}?`,
        "-c:v", "libx264", "-preset", preset.preset,
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-crf", preset.crf, "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        "-vf", preset.vf, ...audioArgs, "-af", "aresample=async=1000:first_pts=0",
      );
    }
  } else {
    // --- Panel (Xtream) source. Unchanged behavior. ---
    // -ss before -i is an input-side seek; skipped for live and at offset 0.
    args.push("-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV)");
    // Panel upstream is flaky for BOTH live and VOD: it stalls reads,
    // rotates CDN hosts, and drops long-lived connections mid-transfer.
    // ffmpeg opens ONE long HTTP GET, so without these a single drop ends
    // it — for live the cast falls to IDLE/ERROR; for a VOD transcode the
    // GET hits a premature EOF (logs as "exit 0" partway through) and the
    // movie just stops, where a direct-play app (HTTP range requests)
    // would have shrugged the blip off. -rw_timeout aborts a stalled read
    // (15s, in microseconds) so a silent stall errors fast instead of
    // hanging; -reconnect/-reconnect_streamed re-open the connection
    // mid-stream and ride over the drop (for VOD ffmpeg range-resumes at
    // the byte offset; for live it keeps segment numbering continuous).
    // Do NOT add -reconnect_at_eof: a real EOF is the genuine end (live
    // HLS segments EOF every few seconds; a VOD's true end EOFs once), so
    // it would reconnect-loop forever (the reverted c5540f0).
    args.push(...panelReconnectArgs());
    // Live only: a corrupt-frame ratio must not abort the whole channel (exit 255
    // on "reference frames exceeds max" / mmco errors from flaky provider feeds).
    if (mode === "live") args.push(...liveTolerantArgs());
    // VOD on the iGPU: decode AND scale on the GPU (0.7 vs 42 CPU-seconds for
    // a 20s 4K HEVC clip — measured). Decoding in software and only encoding
    // on the GPU pinned ~7.5 cores per movie and starved everything else on
    // the box, so playback stalled after a few minutes. Live keeps the old
    // chain (its sources are small and there is no software fallback to
    // retry into); a VOD run that fails here falls back to libx264
    // (vodSoftwareFallbackEligible), where pacing below caps the CPU.
    const hwFull = hw && !preset.copy && mode !== "live";
    if (hwFull) {
      args.push("-hwaccel", "vaapi", "-hwaccel_device", VAAPI_DEVICE, "-hwaccel_output_format", "vaapi");
    } else if (hw && !preset.copy) {
      args.push("-vaapi_device", VAAPI_DEVICE);
    }
    if (!hw && !preset.copy && mode !== "live") {
      // Software VOD encode: don't race through the whole file at full CPU.
      // 4x keeps the panel connection from being held for half the movie.
      args.push("-readrate", "4", "-readrate_initial_burst", "30");
    }
    if (effectiveOffsetSecs > 0 && mode !== "live") {
      args.push("-ss", String(effectiveOffsetSecs));
    }
    args.push("-i", sourceUrl, "-map", "0:v:0", "-map", `0:a:${audioTrack}?`);
    if (preset.copy) {
      args.push("-c:v", "copy", ...audioArgs);
    } else if (hwFull) {
      const maxW = /min\((\d+),\s*iw\)/.exec(preset.vf || "")?.[1] || "1280";
      args.push(
        "-vf", `scale_vaapi=w='min(${maxW},iw)':h=-2:format=nv12`,
        "-c:v", "h264_vaapi", "-qp", String(preset.crf),
        "-profile:v", "high", "-level", "41",
        "-g", "48", "-keyint_min", "48",
        ...audioArgs,
        "-af", "aresample=async=1000:first_pts=0",
      );
    } else if (hw) {
      args.push(
        "-vf", `${preset.vf},format=nv12,hwupload`,
        "-c:v", "h264_vaapi", "-qp", String(preset.crf),
        "-profile:v", "high", "-level", "41",
        "-g", "48", "-keyint_min", "48",
        ...audioArgs,
        "-af", "aresample=async=1000:first_pts=0",
      );
    } else {
      args.push(
        "-c:v", "libx264", "-preset", preset.preset,
        "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p",
        "-crf", preset.crf,
        "-g", "48", "-keyint_min", "48", "-sc_threshold", "0",
        "-vf", preset.vf,
        ...audioArgs,
        "-af", "aresample=async=1000:first_pts=0",
      );
    }
  }
  args.push(
    "-max_muxing_queue_size", "1024",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_segment_filename", path.join(dir, "seg_%05d.ts"),
  );
  if (mode === "live") {
    // Live: sliding window (liveHlsListSize() x 4 s, default 80 s so a client live offset of 20-30 s plus a rebuffer stays inside it). Old segments age out
    // because there's no concept of rewinding past the live edge,
    // and disk space matters more than seek-back range. On respawn,
    // append_list + a continued start_number extend the SAME playlist so
    // the player's media sequence keeps advancing (brief rebuffer, no reset).
    args.push(
      "-hls_list_size", String(liveHlsListSize()),
      "-start_number", String(startNumber),
      // append_list continues the same media sequence on respawn. The inline
      // #EXT-X-DISCONTINUITY marker the player needs at the boundary is injected
      // by the manifest route (ffmpeg won't emit one across a process restart;
      // -hls_flags discont_start does NOT write an inline tag with append_list).
      "-hls_flags",
      "delete_segments+independent_segments+omit_endlist" + (respawn ? "+append_list" : ""),
    );
  } else {
    // VOD (movie / series): keep all segments and grow the playlist
    // without deletion. The 40-second live-style window was making
    // ExoPlayer throw BehindLiveWindowException on any pause/rewind
    // past 40s — the segments behind the player had been deleted.
    // The idle reaper still cleans the whole dir when the user navigates
    // away (after the shared idle grace), so this doesn't leak disk
    // across sessions.
    // -start_number + append_list on respawn mirror live's self-heal: the
    // new process continues the SAME growing playlist instead of
    // overwriting it from segment 0, so a mid-movie panel connection drop
    // is a brief rebuffer, not a dead stream.
    args.push(
      "-hls_list_size", "0",
      "-start_number", String(startNumber),
      "-hls_flags", "independent_segments" + (respawn && !respawn.fresh ? "+append_list" : ""),
    );
  }
  args.push(path.join(dir, "index.m3u8"));
  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  // Lower priority so a transcode yields to the API / stream proxy inside this
  // container (it does not limit other containers — the GPU path is the real fix).
  try { require("os").setPriority(ffmpeg.pid, 10); } catch {}
  let stderrBuf = "";
  // Panel VOD: learn the audio track list from this ffmpeg's own input dump.
  const learnTracks = mode === "movie" || mode === "series";
  const trackParser = learnTracks ? audioTracksLib.createInputStreamParser({ labelFor: langLabel }) : null;
  ffmpeg.stderr.on("data", audioTracksLib.lineSplitter((line) => {
    const { level, msg } = audioTracksLib.splitLevel(line);
    if (audioTracksLib.isErrorLevel(level)) stderrBuf = (stderrBuf + msg + "\n").slice(-4000);
    if (trackParser && !trackParser.done) {
      const tracks = trackParser.feed(msg);
      if (tracks) onInputTracks(tracks);
    }
  }));
  // Reuse the entry across respawns so lastAccess, restart history, and the
  // transcoders-map slot survive an ffmpeg replacement.
  const entry = respawn ? respawn.entry : {
    // mediaAccess: last manifest/segment request (a pause heartbeat bumps
    // lastAccess only, and only on the transcoder with the newest mediaAccess).
    proc: ffmpeg, key, lastAccess: Date.now(), mediaAccess: Date.now(), dir, sourceUrl, mode, id, quality,
    audio, preset, offsetSecs, diskSel, restarts: [], stopping: false, respawning: false,
    discontinuities: new Set(),
    // Media sidecar (trick-play / markers) reads this transcode's segments;
    // owner account only (its ids are the ones the sidecar's cache uses).
    analyze: isOwnerAccount(currentAccount()),
    // Owner keys that fetched this transcoder's manifest/segments (bounded,
    // see noteOwner). /api/transcode/stop with no args stops only these.
    owners: new Set(),
  };
  entry.proc = ffmpeg;
  entry.key = key;
  entry.keyTrack = audioTracksLib.keyTrackOf(key); // track the KEY encodes (segment URLs, alias)
  entry.dir = dir;
  entry.sourceUrl = sourceUrl;
  entry.startedAt = Date.now();
  entry.segAtSpawn = startNumber; // baseline: this run "produced" only if it exceeds this
  entry.respawning = false;
  entry.usedHardware = hw;        // whether THIS run used the VAAPI encoder
  entry.audioTrack = audioTrack;  // the 0:a:N this run maps
  // A failed-over alternate maps track 0 under the original key (its layout
  // is unknown); startOrTouchTranscoder must still reuse it.
  if (opts.trackReset) entry.trackReset = true;
  if (swFallback) entry.swTried = true; // don't loop back to hardware after a fallback
  if (respawn && startNumber > 0) {
    // Mark the boundary so the manifest route emits #EXT-X-DISCONTINUITY before
    // this segment — the player resets its decoder timeline across the restart.
    entry.discontinuities.add(startNumber);
    for (const d of entry.discontinuities) if (d < startNumber - liveHlsListSize() - 2) entry.discontinuities.delete(d);
  }
  // Input stream dump parsed: cache the track list (keyed by the stream id
  // actually read — a failed-over alternate has its own layout), then, on a
  // fresh play where the server may choose (no ?at=), restart this ffmpeg
  // ONCE on the right track if the one it maps isn't the pick — only while
  // nothing has been written yet (dump lands ~1-3s in; segments are 4s).
  function onInputTracks(tracks) {
    learnPanelTracks(mode, srcId, tracks);
    if (!opts.autoPick || respawn || entry.audioAutoDone || entry.stopping || srcId !== id) return;
    entry.audioAutoDone = true;
    const hint = getAudioPickHint(mode, id);
    const pick = audioTracksLib.chooseAudioTrack(tracks, {
      originalLang: hint ? hint.originalLang : titleOriginalLang(mode, id),
      prefs: hint ? hint.prefs : null,
    });
    if (pick.index === audioTrack || !tracks.some((t) => t.index === pick.index)) return;
    const age = Date.now() - entry.startedAt;
    const written = liveSegStats(dir).nextNumber > 0 || fs.existsSync(path.join(dir, "index.m3u8"));
    if (age > AUDIO_AUTOPICK_RESTART_MAX_MS || written) {
      console.log(`[transcode ${key}] audio pick ${pick.index} (${pick.reason}) not applied — already producing (${age}ms); next play / Audio menu`);
      return;
    }
    // Re-key to the new track (key == mapping), so an explicit ?at=0 later
    // can never reuse this ffmpeg; the auto alias follows it.
    const newKey = transcoderKey(mode, id, quality, offsetSecs, audio, diskSel, pick.index);
    if (!audioTracksLib.rekeyTranscoder(transcoders, entry, key, newKey)) return;
    console.log(`[transcode ${key}] audio auto-pick: track ${pick.index} (${pick.reason}) instead of ${audioTrack} — restarting as ${newKey} before first segment (${age}ms)`);
    entry.audioTrack = pick.index;
    setAutoTrackAlias(key, newKey);
    entry.audioRestartTo = { index: pick.index, key: newKey };
    // Live-entry marker for startOrTouchTranscoder until the new ffmpeg is up
    // (a manifest request in between must not spawn a second one).
    entry.respawning = true;
    // The input opened and was read: a reconnect that hits the cap=1 slot
    // still held by this connection is "slot-held", not "source dead".
    entry.everConnected = true;
    try { ffmpeg.kill("SIGKILL"); } catch {}
  }
  ffmpeg.on("exit", (code) => {
    // Deliberate audio-track restart (onInputTracks): same key/entry/dir,
    // fresh playlist, now mapping the chosen track.
    if (trackParser && !trackParser.done) {
      const late = trackParser.flush(); // died before printing a mapping
      if (late) learnPanelTracks(mode, srcId, late);
    }
    if (entry.audioRestartTo != null && entry.proc === ffmpeg) {
      const { index: to, key: nk } = entry.audioRestartTo;
      entry.audioRestartTo = null;
      fs.rmSync(dir, { recursive: true, force: true }); // the old track's dir
      if (entry.stopping || transcoders.get(nk) !== entry) {
        if (transcoders.get(nk) === entry) transcoders.delete(nk);
        return;
      }
      spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, nk, diskSel, { startNumber: 0, entry, fresh: true }, to, !!entry.swTried)
        .catch((e) => {
          console.log(`[transcode ${nk}] audio restart failed: ${redactUrl(e?.message || e)}`);
          if (transcoders.get(nk) === entry) transcoders.delete(nk);
          fs.rmSync(path.join(TRANSCODE_DIR, nk), { recursive: true, force: true });
        });
      return;
    }
    const tail = redactUrl(stderrBuf.split("\n").filter(Boolean).slice(-3).join(" | "));
    const now = Date.now();
    const prevExitCode = entry.lastExitCode;
    entry.lastExitCode = code;
    entry.restarts = (entry.restarts || []).filter((ts) => now - ts < RESTART_WINDOW_MS);
    // Self-heal: an unexpected exit (provider EOF / I/O error, CDN-host
    // rotation, or a watchdog SIGTERM of a wedged ffmpeg) respawns against a
    // freshly-built panel URL while a viewer is still connected. Panel-backed
    // modes only (live, movie, series) — disk reads a local file, so an
    // unexpected exit there is a real error respawning would just loop on,
    // not a dropped upstream connection. VOD didn't get this before: the
    // panel closes long-lived movie/series downloads after ~10-20 min (looks
    // to ffmpeg like a clean EOF, exit 0) and every session died outright —
    // no continuation, the viewer had to manually re-open and resume. Terminal
    // cleanup on a deliberate stop, an abandoned stream, or a flapping source
    // that's blown the restart cap.
    const recentViewer = now - entry.lastAccess < idleWindowMs();
    // Did THIS ffmpeg run emit a segment? If so, the channel is live — remember it
    // for the lifetime of this entry (survives respawns).
    const connectFail = liveSegStats(dir).nextNumber <= (entry.segAtSpawn || 0);
    if (!connectFail) { entry.everConnected = true; entry.slotRetries = 0; transcoderFailures.delete(key); }
    // VOD races the source with no -re pacing (grow-only playlist, no
    // realtime throttle) — a viewer only partway through can already be
    // sitting on a FULLY encoded playlist well before they've watched that
    // far. Without this, a genuine "reached the real end of the title" exit
    // is indistinguishable from a dropped connection: the respawn logic
    // below would keep computing a `-ss` offset further past the actual
    // end of the file, immediately re-hit EOF, exit near-instantly, and
    // repeat until the restart cap gives up — on a title that was actually
    // already fully encoded and playable. Movies only (TMDB `runtime` is
    // series-level/typical for series, not the specific episode's real
    // length, so this is a no-op there — series keeps the plain respawn
    // behavior above). TMDB runtime is whole-minute-rounded and can floor
    // (a 145m47s film can report as "145") — +65s clears that rounding
    // risk with room to spare; a false "complete" here would truncate the
    // movie's real ending, worse than the runaway respawn this replaces.
    const finishInert = () => {
      // No respawn needed (nothing left to encode) but also no
      // transcoders.delete/fs.rmSync here — a still-connected viewer is
      // reading already-written segments off this dir. Self-schedule the
      // same idle check the reaper would otherwise apply, purely for this
      // now-inert entry.
      const reapWhenIdle = () => {
        if (transcoders.get(key) !== entry) return;
        if (Date.now() - entry.lastAccess > idleWindowMs()) {
          transcoders.delete(key);
          fs.rmSync(dir, { recursive: true, force: true });
          return;
        }
        setTimeout(reapWhenIdle, 30_000);
      };
      setTimeout(reapWhenIdle, 30_000);
    };
    // offsetSecs + elapsed (lib/vod-end.js): a resumed transcode's playlist
    // starts at its -ss anchor, so elapsed alone never reached the runtime.
    // Panel duration_secs (exact) first; TMDB runtime (movies) as fallback.
    if ((mode === "movie" || mode === "series") && !connectFail) {
      const knownRuntimeMin = mode === "movie" ? tmdbCache[`${mode}:${id}`]?.runtime : null;
      const end = vodReachedEnd({
        offsetSecs, elapsedSecs: playlistElapsedSecs(dir),
        durationSecs: panelDurationSecsCached(mode, id), runtimeMin: knownRuntimeMin,
        // Stream copy seeks to the keyframe before each respawn's -ss, so the
        // appended playlist overstates the position (vod-end.js).
        copySeeks: preset?.copy ? (entry.respawnCount || 0) + (offsetSecs > 0 ? 1 : 0) : 0,
      });
      if (end.done) {
        const via = end.by === "duration" ? "panel duration" : `known runtime (${knownRuntimeMin}min)`;
        console.log(`[transcode ${key}] exit ${code} — reached ${via} at ${Math.round(end.position)}s, transcode complete`);
        try {
          const m3u8 = path.join(dir, "index.m3u8");
          const text = fs.readFileSync(m3u8, "utf8");
          if (!text.includes("#EXT-X-ENDLIST")) fs.appendFileSync(m3u8, "#EXT-X-ENDLIST\n");
        } catch {}
        finishInert();
        return;
      }
    }
    // A VOD respawn that seeks to where the previous run stopped and gets
    // "no packets" is the real end of the title (series have no per-episode
    // runtime to check above). Treating it as a failure used to trigger the
    // software fallback below, whose fresh-dir wipe deleted the whole
    // already-encoded episode out from under the viewer mid-playback.
    if (!isLocalMode(mode) && mode !== "live" && connectFail && entry.everConnected
        && !entry.stopping && /received no packets|nothing was written/i.test(stderrBuf)) {
      // Two strikes at the same resume point: one "no packets" could be a
      // slot-held/short-body reconnect after a real mid-file drop (the normal
      // retry below handles that); the same result twice is the true end.
      const resumeAt = liveSegStats(dir).nextNumber;
      if (entry.noPacketsAt === resumeAt) {
        console.log(`[transcode ${key}] exit ${code} — respawn past last segment produced nothing twice, treating as end of title`);
        try {
          const m3u8 = path.join(dir, "index.m3u8");
          const text = fs.readFileSync(m3u8, "utf8");
          if (!text.includes("#EXT-X-ENDLIST")) fs.appendFileSync(m3u8, "#EXT-X-ENDLIST\n");
        } catch {}
        finishInert();
        return;
      }
      entry.noPacketsAt = resumeAt;
    }
    // VOD hardware-encode fallback. The boot HW_ENCODE probe only proves a
    // bare nv12→h264 upload works, not that every source encodes: some files
    // carry video params the VAAPI encoder rejects at runtime (`h264_vaapi`
    // exits -22 with no packets), so the movie is unplayable at every seek
    // offset. libx264 encodes those fine. If a VOD run that USED hardware
    // died with no output, retry it ONCE in software (fresh dir at seg 0) —
    // the in-flight manifest request keeps polling the same dir path and
    // recovers. If software also fails, terminal cleanup runs on that exit.
    if (vodSoftwareFallbackEligible({
      mode, exitCode: code, usedHardware: entry.usedHardware,
      alreadyTriedSoftware: entry.swTried, producedSegment: !connectFail || !!entry.everConnected,
      viewerPresent: recentViewer, stopping: entry.stopping,
    })) {
      console.log(`[transcode ${key}] exit ${code} — VAAPI produced no output; retrying in software (libx264)${tail ? ": " + tail : ""}`);
      hwDecodeFailed.add(`${mode}:${id}`);
      transcoders.delete(key);
      fs.rmSync(dir, { recursive: true, force: true });
      spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, null, audioTrack, true, { trackReset: !!entry.trackReset })
        .catch((e) => {
          console.log(`[transcode ${key}] software fallback failed: ${e?.message || e}`);
          transcoders.delete(key);
          fs.rmSync(dir, { recursive: true, force: true });
        });
      return;
    }
    // Respawn decision:
    //  - produced a segment → the stream worked then died (provider EOF / stall /
    //    rotation): normal self-heal respawn.
    //  - connect-failed BUT the channel was working earlier (everConnected): the
    //    likely cause is the cap=1 panel still holding our just-killed connection's
    //    slot, so the fresh ffmpeg couldn't get in. DON'T give up — wait for the
    //    slot to release and retry. This is exactly what a manual stop+re-cast does
    //    (the !respawn path drains the slot first). (issue #56)
    //  - connect-failed and NEVER connected → genuinely off-air / panel-locked:
    //    fail fast so we don't machine-gun the cap=1 panel into locking the account.
    const slotHeldRetry = connectFail && entry.everConnected
      && (entry.slotRetries || 0) < MAX_SLOT_RETRIES;
    const canRespawn = !entry.stopping && !isLocalMode(mode) && recentViewer
      && entry.restarts.length < MAX_RESTARTS
      && (!connectFail || slotHeldRetry);
    if (!canRespawn) {
      const note = (entry.stopping || isLocalMode(mode)) ? ""
        : !recentViewer ? " (viewer gone)"
        : (connectFail && !entry.everConnected) ? " (input unavailable — not respawning)"
        : connectFail ? " (slot never freed / source went off-air — giving up)"
        : " (restart cap — source unstable, giving up)";
      console.log(`[transcode ${key}] exit ${code}${note}${tail ? ": " + tail : ""}`);
      // Trip the circuit breaker when we give up on a source that never
      // connected (invalid/broken upstream), but not on a deliberate stop.
      // The next manifest retry for this key is then refused fast instead of
      // machine-gunning ffmpeg at a dead input.
      if (connectFail && !entry.everConnected && !entry.stopping) {
        // Before tripping the breaker: another copy of this movie may be alive.
        // Only on an HTTP-error/empty-file signature (not a slot lock or bad seek).
        const deadLink = /(Server returned (4|5)\d\d|HTTP error (4|5)\d\d|Invalid data found|End of file|404 Not Found|403 Forbidden)/i.test(tail || "");
        if (recentViewer && mode === "movie" && deadLink) {
          const fk = `${mode}:${id}`;
          const ft = failoverTried.get(fk) || { tried: new Set(), at: Date.now() };
          ft.tried.add(String(sourceOverride.get(fk) || id)); ft.at = Date.now();
          failoverTried.set(fk, ft);
          const alt = nextAltVariant(mode, id, ft.tried);
          if (alt && ft.tried.size <= 4) {
            console.log(`[transcode ${key}] source ${sourceOverride.get(fk) || id} unavailable — failing over to variant ${alt.id} (${alt.name})`);
            sourceOverride.set(fk, alt.id);
            transcoders.delete(key);
            fs.rmSync(dir, { recursive: true, force: true });
            // Single-flight: a manifest retry during the drain must not start a second ffmpeg.
            // audioTrack resets to 0 — the alternate's track layout is unknown.
            const p = spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, null, 0, !!entry.swTried, { trackReset: true })
              .catch((e) => {
                console.log(`[transcode ${key}] failover spawn failed: ${e?.message || e}`);
                transcoders.delete(key);
                fs.rmSync(dir, { recursive: true, force: true });
              })
              .finally(() => { if (transcoderInflight.get(key) === p) transcoderInflight.delete(key); });
            transcoderInflight.set(key, p);
            return;
          }
        }
        transcoderFailures.set(key, Date.now());
        sourceOverride.delete(`${mode}:${id}`); failoverTried.delete(`${mode}:${id}`);
      }
      transcoders.delete(key);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    entry.restarts.push(now);
    entry.respawnCount = (entry.respawnCount || 0) + 1; // lifetime (restarts is windowed)
    if (slotHeldRetry) entry.slotRetries = (entry.slotRetries || 0) + 1;
    entry.respawning = true;
    const nextStart = liveSegStats(dir).nextNumber;
    // Normal respawn backs off 1s,2s,…5s. A slot-held retry waits longer (≥6s,
    // escalating to 12s) so the cap=1 panel notices our prior connection dropped
    // and frees the slot before we reconnect — otherwise the retry connect-fails
    // straight into our own dying session and we'd give up for nothing.
    const backoff = slotHeldRetry
      ? Math.min(SLOT_RELEASE_MS + 2000 * entry.restarts.length, 12_000)
      : Math.min(1000 * entry.restarts.length, 5000);
    const why = !slotHeldRetry ? ""
      : noPacketsLabel({ previousExitCode: prevExitCode, stderr: stderrBuf }) === "past end of file"
        ? " (past end of file — the previous run ended cleanly)"
        : " (slot-held — waiting for the cap slot to free)";
    console.log(`[transcode ${key}] exit ${code} — respawn #${entry.restarts.length} in ${backoff}ms (start_number=${nextStart})${why}${tail ? ": " + tail : ""}`);
    setTimeout(() => {
      if (transcoders.get(key) !== entry) return; // replaced/removed during backoff
      // Honor a stop OR a viewer who left during the (up to 12s) backoff — don't open a
      // fresh cap=1 panel connection for nobody. (issue #56 review)
      if (entry.stopping || Date.now() - entry.lastAccess > idleWindowMs()) {
        transcoders.delete(key); fs.rmSync(dir, { recursive: true, force: true }); return;
      }
      // Thread entry.swTried through as the new run's swFallback: once a
      // source has proven VAAPI can't encode it (a real, permanent property
      // of that file, not a transient blip), every respawn must keep using
      // software — omitting this made each respawn default back to
      // HW_ENCODE from scratch, so a VAAPI-hostile VOD file flip-flopped
      // hardware-fail → one-shot-software-success → next respawn tries
      // hardware again → fails → (already used its one-shot fallback, so
      // vodSoftwareFallbackEligible now says no) → burns through the
      // restart/slot-retry budget on repeated hardware failures and gives
      // up entirely, instead of just continuing on software indefinitely.
      spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, { startNumber: nextStart, entry }, audioTrack, entry.swTried)
        .catch((e) => {
          console.log(`[transcode ${key}] respawn failed: ${redactUrl(e?.message || e)}`);
          transcoders.delete(key);
          fs.rmSync(dir, { recursive: true, force: true });
        });
    }, backoff);
  });
  if (!respawn) transcoders.set(key, entry);
  console.log(`[transcode ${key}] ${respawn ? "respawned" : "started"} → ${redactUrl(sourceUrl)}`);
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, t] of transcoders) {
    if (now - t.lastAccess > idleWindowMs()) {
      stopTranscoder(t, "idle");
    }
  }
  // Drop failover bookkeeping for keys that are gone (10 min).
  for (const [fk, ft] of failoverTried) {
    const live = [...transcoders.keys()].some((k) => k.startsWith(fk.replace(":", "-") + "-"));
    if (!live && now - ft.at > 10 * 60 * 1000) { failoverTried.delete(fk); sourceOverride.delete(fk); }
  }
}, 30_000);

// Stall watchdog: a live ffmpeg can stay alive but stop emitting segments when
// the upstream playlist quits advancing — the failure -rw_timeout can't catch
// (the socket isn't hung, the feed just went silent). If no new segment has
// landed for STALL_MS while a viewer is still polling, SIGTERM it; the exit
// handler respawns against a fresh panel URL. The post-(re)spawn grace lets a
// new ffmpeg emit its first segment before we judge it stalled.
setInterval(() => {
  const now = Date.now();
  for (const [key, t] of transcoders) {
    if (t.mode !== "live" || t.stopping || t.respawning) continue;
    if (now - (t.startedAt || 0) < STALL_GRACE_MS) continue;
    // Keep healing a wedged live transcode through the full idle grace —
    // a SIGTERM+respawn during a rebuffer rebuilds the rolling segment
    // window so the receiver has fresh segments to catch when WiFi
    // recovers. Past the grace, the idle reaper owns teardown.
    if (now - t.lastAccess > idleWindowMs()) continue;
    const { newest } = liveSegStats(t.dir);
    const age = now - (newest || t.startedAt);
    if (age > STALL_MS) {
      console.log(`[transcode ${key}] stalled (${Math.round(age / 1000)}s without a segment) — restarting`);
      t.respawning = true;
      try { t.proc.kill("SIGTERM"); } catch {}
    }
  }
}, 10_000);

// ===========================================================================
// MEDIA SIDECAR — trick-play thumbnails + intro/credits markers
// (lib/media-sidecar.js). It never opens an upstream stream: it reads the
// HLS segments a viewer's own transcode already wrote (owner account only,
// so ids are the owner panel's), and Disk-library files while nobody is
// watching. See docs/NETFLIX_FEATURES.md.
// ===========================================================================
const { createTrickplayStore } = require("./lib/trickplay");
const { createMarkerStore } = require("./lib/marker-store");
const { createMediaSidecar } = require("./lib/media-sidecar");
const TRICKPLAY_INTERVAL_SEC = 10;
const trickplayStore = createTrickplayStore({
  dir: path.join(DATA_DIR, "trickplay"),
  maxBytes: (() => { const m = parseFloat(process.env.TRICKPLAY_CACHE_MAX_MB || ""); return (Number.isFinite(m) && m > 0 ? m : 2048) * 1024 ** 2; })(),
  maxCompleteBytes: (() => { const m = parseFloat(process.env.TRICKPLAY_DISK_MAX_MB || ""); return (Number.isFinite(m) && m > 0 ? m : 8192) * 1024 ** 2; })(),
});
const markerStore = createMarkerStore({ dir: path.join(DATA_DIR, "markers"), log: (m) => console.log(m) });

// Series group (and season) of an episode the owner is watching, from data
// already in memory: the cached get_series_info (fetched when the series page
// was opened) or a profile's "last episode" pointer. Disk episodes come from
// the disk index's series groups.
function sidecarGroupFor(mode, id) {
  const sid = String(id);
  if (mode === "disk") {
    const meta = getIndexesFor(ownerAccount).disk?.meta;
    if (!meta) return null;
    for (const [gid, g] of meta) {
      if (!g || !g.isSeriesGroup || !Array.isArray(g.episodes)) continue;
      const ep = g.episodes.find((e) => String(e.id) === sid);
      if (ep) return { group: `disk:${gid}`, season: ep.season ?? null, dur: ep.durationSecs || null };
    }
    return null;
  }
  if (mode !== "series") return null;
  const prefix = `${accountKeyOf(ownerAccount)}\0${MODES.series.info}`;
  for (const [k, hit] of cache) {
    if (!k.startsWith(prefix)) continue;
    const eps = hit?.v?.episodes;
    if (!eps || typeof eps !== "object") continue;
    for (const [sn, list] of Object.entries(eps)) {
      if (!Array.isArray(list)) continue;
      const ep = list.find((e) => String(e?.id) === sid);
      if (!ep) continue;
      let seriesId = null;
      try { seriesId = JSON.parse(k.slice(prefix.length)).series_id; } catch {}
      if (seriesId == null) continue;
      const dur = Number(ep.info?.duration_secs) || null;
      return { group: `series:${seriesId}`, season: Number(ep.season ?? sn) || null, dur };
    }
  }
  for (const st of profileStates.values()) {
    for (const [seriesId, le] of Object.entries(st?.lastEpisode || {})) {
      if (String(le?.episode_id) === sid && /^\d{1,12}$/.test(String(seriesId))) {
        return { group: `series:${seriesId}`, season: Number(le.season) || null, dur: null };
      }
    }
  }
  return null;
}

// Anyone watching anything (panel or disk) within the last minute.
function sidecarViewerActive() {
  const now = Date.now();
  for (const [k, v] of streams) if (!v.displaced && now - v.lastSeen < 60_000 && !diskDlSchedule.isBackgroundOwner(k)) return true;
  for (const t of transcoders.values()) if (now - t.lastAccess < 60_000) return true;
  return diskfileActive > 0 || now - diskfileLastSeen < 120_000;
}

const mediaSidecar = createMediaSidecar({
  trickplay: trickplayStore,
  markers: markerStore,
  interval: TRICKPLAY_INTERVAL_SEC,
  listTranscodes: () => {
    const out = [];
    for (const t of transcoders.values()) {
      if (!t.analyze || t.mode === "live" || t.stopping) continue;
      out.push({ entry: t, mode: t.mode, id: t.id, dir: t.dir, offsetSecs: t.offsetSecs || 0 });
    }
    return out;
  },
  groupFor: sidecarGroupFor,
  viewerActive: sidecarViewerActive,
  log: (m) => console.log(m),
});
if (process.env.MEDIA_SIDECAR !== "0") {
  setInterval(() => { try { mediaSidecar.scan(); } catch (e) { console.warn(`[sidecar] scan: ${e.message}`); } }, 5_000).unref?.();
  setInterval(() => { trickplayStore.evict().then((r) => { if (r.removed) console.log(`[trickplay] evicted ${r.removed} titles`); }).catch(() => {}); }, 6 * 3600_000).unref?.();
  // Disk library: queue what is still missing (thumbnails for every file,
  // fingerprints for series episodes). Jobs run one at a time, only while
  // nobody watches anything.
  const queueDiskSidecarJobs = () => {
    try {
      const ix = getIndexesFor(ownerAccount).disk;
      if (!ix?.ready || !ix.meta) return;
      let n = 0;
      // Fingerprints first (seconds each), then thumbnails (minutes each).
      for (const [gid, g] of ix.meta) {
        if (!g?.isSeriesGroup || !Array.isArray(g.episodes)) continue;
        for (const ep of g.episodes) {
          const m = ix.meta.get(ep.id);
          const rec = markerStore.get(`disk:${ep.id}`);
          if (!m?.absPath || (rec && (rec.pruned || (rec.head && (rec.tail || !ep.durationSecs))))) continue;
          if (mediaSidecar.enqueueOffline({ kind: "offline-fp", key: `fp:disk:${ep.id}`, mode: "disk", id: String(ep.id), file: m.absPath, dur: ep.durationSecs || m.durationSecs || null, group: `disk:${gid}`, season: ep.season ?? null })) n++;
        }
      }
      for (const [id, m] of ix.meta) {
        if (!m || m.isSeriesGroup || !m.absPath) continue;
        const tl = trickplayStore.list("disk", id);
        if (!tl.complete && !tl.evicted) {
          if (mediaSidecar.enqueueOffline({ kind: "offline-thumbs", key: `th:disk:${id}`, mode: "disk", id: String(id), file: m.absPath })) n++;
        }
      }
      if (n) console.log(`[sidecar] queued ${n} offline Disk-library jobs`);
    } catch (e) { console.warn(`[sidecar] disk queue: ${e.message}`); }
  };
  setTimeout(queueDiskSidecarJobs, (() => { const n = parseInt(process.env.MEDIA_SIDECAR_DISK_DELAY_MS || "", 10); return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000; })()).unref?.();
  setInterval(queueDiskSidecarJobs, 60 * 60_000).unref?.();
}

// Trick-play thumbnails for a title (movie stream id, series EPISODE id, or
// disk file id). Coverage is partial: only what a transcode produced, or a
// full offline pass for Disk files (complete: true). Empty `frames` = none.
app.get("/api/trickplay/:mode(movie|series|disk)/:id(\\d{1,17})", (req, res) => {
  const { mode, id } = req.params;
  res.set("Cache-Control", "private, max-age=15");
  const owner = isOwnerAccount(currentAccount());
  const l = owner ? trickplayStore.list(mode, id) : { times: [], complete: false, size: null };
  res.json({
    mode, id,
    interval: TRICKPLAY_INTERVAL_SEC,
    width: l.size?.width || null,
    height: l.size?.height || null,
    complete: !!l.complete,
    count: l.times.length,
    frames: l.times,
    url: `/api/trickplay/${mode}/${id}/{t}.jpg`,
  });
});
app.get("/api/trickplay/:mode(movie|series|disk)/:id(\\d{1,17})/:t(\\d{1,6}).jpg", (req, res) => {
  const { mode, id, t } = req.params;
  const f = isOwnerAccount(currentAccount()) ? trickplayStore.filePath(mode, id, t) : null;
  if (!f) return res.status(404).set("Cache-Control", "no-store").json({ error: "no_frame" });
  res.sendFile(f, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=604800, immutable" }, dotfiles: "allow" });
});

// Skip-intro / skip-credits markers (seconds into the title). Nulls when not
// detected or not sure. Recap detection is not implemented (always null).
app.get("/api/markers/:mode(movie|series|disk)/:id(\\d{1,17})", (req, res) => {
  const { mode, id } = req.params;
  res.set("Cache-Control", "private, max-age=60");
  const rec = isOwnerAccount(currentAccount()) ? markerStore.get(`${mode}:${id}`) : null;
  const m = rec?.markers || null;
  res.json({
    mode, id,
    introStart: m?.introStart ?? null,
    introEnd: m?.introEnd ?? null,
    recapStart: null,
    recapEnd: null,
    creditsStart: m?.creditsStart ?? null,
    source: m && (m.introStart != null || m.creditsStart != null) ? "fingerprint" : null,
    support: m?.support || { intro: 0, credits: 0 },
    analysed: { head: !!rec?.head, tail: !!rec?.tail },
  });
});

// Surround: crawler progress + coverage (owner).
app.get("/api/admin/surround", (req, res) => {
  if (!requireOwner(req, res)) return;
  let movies = 0, known = 0, surround = 0, misses = 0;
  for (const it of (indexes.movie?.byId?.values() || [])) {
    movies++;
    if (audioKnown(it.id)) known++;
    if (audioMissFresh(it.id)) misses++;
    if (surroundLib.isSurround(it.audio_channels)) surround++;
  }
  let disk = 0;
  for (const it of (indexes.disk?.byId?.values() || [])) if (surroundLib.isSurround(it.audio_channels)) disk++;
  const seriesKnown = Object.keys(seriesAudio).length;
  const seriesSurround = Object.values(seriesAudio).filter((v) => surroundLib.isSurround(v && v.channels)).length;
  res.json({
    crawler: { ...surroundCrawler.stats(), intervalMs: SURROUND_CRAWL_INTERVAL_MS, enabled: process.env.SURROUND_CRAWL !== "0" },
    movies: { total: movies, known, surround, noInfo: misses },
    disk: { surround: disk },
    series: { known: seriesKnown, surround: seriesSurround },
  });
});

// One-time seed of series audio summaries from the on-disk info store
// (get_series_info answers saved for stale-if-error). Local files only.
async function seedSeriesAudioFromInfoStore() {
  const actx = currentAccount();
  const ix = indexes.series;
  if (!ix?.ready || !isOwnerAccount(actx)) return 0;
  let names;
  try { names = new Set(await fs.promises.readdir(path.join(DATA_DIR, "info-cache"))); } catch { return 0; }
  let n = 0;
  for (const id of ix.byId.keys()) {
    const key = xtreamKey(actx, MODES.series.info, { series_id: String(id) });
    if (!names.has(path.basename(infoStore.fileFor(key)))) continue;
    const rec = await infoStore.get(key).catch(() => null);
    if (rec && rec.v && noteSeriesAudio(id, rec.v, actx)) n++;
  }
  if (n) console.log(`[surround] seeded ${n} series audio summaries from the info store`);
  return n;
}

app.get("/api/admin/sidecar", (req, res) => {
  if (!requireOwner(req, res)) return;
  res.json({ sidecar: mediaSidecar.stats(), markers: markerStore.stats() });
});

// Stops transcoders on the client's request (logic in lib/transcode-stop.js):
//  - { mode, id }: every quality/offset variant of that title. Called by the
//    client right before switching streams so the previous ffmpeg (which would
//    otherwise hold the upstream slot until the idle grace elapses) doesn't
//    collide with the new stream against the panel's max_connections=1.
//  - no args: only the caller's own — its admission stream plus transcoders it
//    fetched from (closePlayer / beforeunload / deep-link resume). Never all.
app.post("/api/transcode/stop", express.json(), (req, res) => {
  const owner = ownerKeyOf(req);
  const r = handleStopRequest(req.body, { transcoders, streams, owner, stop: stopTranscoder });
  if (r.error) console.log(`[transcode-stop] rejected ${owner}: ${r.error}`);
  res.status(r.status).json(r.body);
});

app.get("/api/stream/:mode(live|movie|series|disk)/:id.:ext", async (req, res) => {
  // Reject ids that aren't in this mode's index — most often this is
  // a stale URL or a mode-mixed-up link (e.g. clicking a series tile
  // in a unified search and ending up at /movie/.../<series_id>.mp4).
  // Without this guard streamUrl() happily builds a panel URL for an
  // id that lives in a different bucket; the panel then 4xx's the
  // download with no useful client error. For movies the index is
  // authoritative; for series the index keys by series_id (not
  // episode_id), so a per-episode lookup would always 404 here —
  // hence series is exempt and we let the panel decide.
  const idInt = parseInt(req.params.id, 10);
  if (req.params.mode === "movie" && Number.isFinite(idInt)) {
    if (!indexes.movie?.byId?.has(idInt)) {
      return res.status(404).json({
        error: "not in catalog",
        hint: "This id isn't in the current index — likely a stale link or a mode mismatch (e.g. a series id opened as a movie).",
      });
    }
  }
  // A play request: a running Save-to-Disk transfer gives up the household's
  // one provider connection right now, before this player reaches the
  // provider (Disk titles are local files and never need it).
  if (req.params.mode !== "disk") preemptDiskDownloadsForViewer(`play ${req.params.mode}`);
  // ...and a tile preview (any device) stops before the player starts: wait
  // for its ffmpeg (and so its provider connection) to be gone first.
  // (A local Disk file uses no provider connection: it stops a preview but
  // leaves no "someone is watching" signal.)
  const previewGone = req.params.mode === "disk" ? stopPreviews("play disk")
    : previewViewerActivity(ownerKeyOf(req), req.params.mode === "live" ? "play-live" : "play-vod");
  if (previewGone) await previewGone;

  // --- Disk (local) media. Decide direct-play vs transcode from the probed
  // codec metadata (no network probe). Return signed same-origin URLs; the
  // absolute path never reaches the client. Honors ?audio=<idx> / ?sub=<idx>.
  if (req.params.mode === "disk") {
    const actx = currentAccount();
    // Sourced from meta, NOT indexes.disk.byId — a series-group's
    // episode files were deliberately excluded from byId (buildDiskIndex
    // groups them under one synthetic tile there); byId only has real,
    // independently-playable files PLUS series-group placeholders. meta
    // has an entry for every real file regardless of whether it's
    // grouped for display, which is exactly what playback needs.
    const meta = Number.isFinite(idInt) ? getIndexesFor(actx).disk.meta.get(idInt) : null;
    if (!meta) {
      return res.status(404).json({ error: "not in catalog" });
    }
    // A series-group tile isn't a real file — no absPath, nothing to
    // stream. The client should be hitting GET /api/disk/series/:id and
    // playing one of ITS episode ids (each a real file), never this one
    // directly; a stray direct hit (stale link, bad client code) gets a
    // clean 400 instead of the transcoder choking on an undefined path.
    if (meta.isSeriesGroup) {
      return res.status(400).json({ error: "series group has no playable file", hint: "fetch /api/disk/series/:id and play an episode id instead" });
    }
    const acctId = diskAcctId(actx);
    const offset = normalizeOffsetSecs(req.query.t);
    const audio = normalizeAudio(req.query.a);
    // Client-safe shape — same mapping buildDiskIndex uses to build a
    // tile's byId entry, recomputed here since episode files no longer
    // have their own byId entry (only meta, which keeps the raw probed
    // tracks: {i, codec, channels, lang, title, default}).
    const audioTracks = (meta.audioTracks || []).map(t => ({ index: t.i, codec: t.codec, channels: t.channels, lang: t.lang, label: t.title || langLabel(t.lang) || `Audio ${t.i + 1}`, default: t.default }));
    const subtitleTracks = (meta.subTracks || []).map(t => ({ index: t.i, codec: t.codec, lang: t.lang, kind: t.kind, label: t.title || langLabel(t.lang) || `Subtitle ${t.i + 1}` }));
    const defAudioIdx = audioTracks.findIndex(t => t.default);
    const baseAudioIdx = defAudioIdx >= 0 ? defAudioIdx : 0;
    const reqAudio = parseInt(req.query.audio, 10);
    const reqSub = parseInt(req.query.sub, 10);
    const selAudioIdx = Number.isFinite(reqAudio) ? reqAudio : baseAudioIdx;
    const selAudio = audioTracks[selAudioIdx];
    const selSub = Number.isFinite(reqSub) ? subtitleTracks[reqSub] : null;
    const container = (meta.container || "").toLowerCase();
    // Chrome's <video> can only direct-play a handful of containers,
    // regardless of codec. mkv/avi/ts must be remuxed through the
    // transcoder (HLS) even when their codecs are themselves fine.
    const containerSafe = BROWSER_SAFE_CONTAINERS.has(container);
    const videoSafe = BROWSER_SAFE_VIDEO.has(meta.video?.codec);
    const audioSafe = !!selAudio && !BROWSER_UNSAFE_AUDIO.has(selAudio.codec);
    const burnImageSub = !!selSub && selSub.kind === "image";
    let need = false, reason = null;
    if (!containerSafe) { need = true; reason = `disk-container:${container || "?"}`; }
    else if (!videoSafe) { need = true; reason = `disk-video:${meta.video?.codec || "?"}`; }
    else if (!audioSafe) { need = true; reason = `disk-audio:${selAudio?.codec || "?"}`; }
    else if (selAudioIdx !== baseAudioIdx) { need = true; reason = "disk-audio-switch"; }
    else if (burnImageSub) { need = true; reason = "disk-sub-burn"; }
    const fileUrl = `/api/diskfile?id=${idInt}&acct=${encodeURIComponent(acctId)}&s=${signDisk("file", acctId, idInt)}`;
    const tSigInput = offset > 0 ? `transcode:disk:${idInt}:${offset}` : `transcode:disk:${idInt}`;
    const tSig = crypto.createHmac("sha256", PROXY_SECRET).update(tSigInput).digest("hex").slice(0, 16);
    let tQuery = `s=${tSig}` + (offset > 0 ? `&t=${offset}` : "") + (audio === "surround" ? `&a=surround` : "");
    if (selAudioIdx > 0) tQuery += `&da=${selAudioIdx}`;
    if (burnImageSub) tQuery += `&ds=${reqSub}`;
    const tUrl = `/api/transcode/disk/${idInt}/index.m3u8?${tQuery}`;
    const subSig = signDisk("subs", acctId, idInt);
    const subtitleUrls = subtitleTracks
      .filter(t => t.kind === "text")
      .map(t => ({ index: t.index, lang: t.lang, label: t.label,
        url: `/api/disksubs/${idInt}/${t.index}.vtt?acct=${encodeURIComponent(acctId)}&s=${subSig}` }));
    return res.json({
      direct: fileUrl,
      proxy: fileUrl,
      transcode: tUrl,
      download: fileUrl,
      url: need ? tUrl : fileUrl,
      transcodeAnchorSecs: offset,
      forceTranscode: need,
      forceReason: reason,
      durationSecs: meta.durationSecs || null,
      audioTracks,
      subtitleTracks,
      subtitleUrls,
      selectedAudio: selAudioIdx,
    });
  }

  const direct = streamUrl(req.params.mode, req.params.id, req.params.ext);
  // ?t=<secs> requests a transcode URL anchored at that source
  // offset — used when the client wants to fast-forward past the
  // already-encoded portion of the HLS playlist. t is part of the
  // HMAC so a stale URL with a different offset gets a 403. Omitting
  // t (the common case) signs identically to before so legacy
  // clients keep working.
  const offsetSecs = normalizeOffsetSecs(req.query.t);
  // ?a=surround forwards through to the transcoder so AVR-connected
  // Android TVs can request E-AC3 multi-channel instead of the
  // default AAC stereo. Like ?q= (quality), not part of the HMAC.
  const audio = normalizeAudio(req.query.a);
  // Audio track for panel VOD. A client-chosen ?at= (0 included) is passed
  // through as the explicit `at`. Otherwise, when the title's track list is
  // cached, the server's default pick rides as `ap` — a SEPARATE param, so
  // a client that appends its own &at= always wins. The default: the copy's
  // language / the title's ORIGINAL language (a Hindi film plays Hindi, not
  // an English dub), then the profile's audioLangPrefs (unset: onboarded
  // languages, then hin, eng), then the file default — chooseAudioTrack.
  // Cache-only: NEVER probes here (play-start critical path). An unknown
  // title's first play learns its list from the transcoder's own ffmpeg and
  // restarts that transcode once before its first segment if needed
  // (spawnTranscoder); the hint carries original language + prefs to the
  // pre-auth transcode route.
  const vodMode = req.params.mode === "movie" || req.params.mode === "series";
  const explicitAt = vodMode ? audioTracksLib.resolveAudioTrackParam(req.query).explicit : null;
  let serverPick = null;
  if (vodMode) {
    const userState = getProfileState(req.profileId);
    const seriesId = req.params.mode === "series" && /^\d{1,12}$/.test(String(req.query.series ?? "")) ? String(req.query.series) : null;
    // Playing an episode clears the series' "new episode" badge (cached info only).
    if (seriesId && req.profileId) noteSeriesPlayed(userState, seriesId);
    const onboarded = (() => {
      const own = userState.filter?.groups?.[req.params.mode];
      const keys = Array.isArray(own) && own.length ? own : userState.filter?.groups?.live;
      return (Array.isArray(keys) ? keys : []).filter((k) => LANGUAGE_GROUP_KEYS_SET.has(k));
    })();
    const ctx = {
      originalLang: titleOriginalLang(req.params.mode, req.params.id, seriesId),
      prefs: audioTracksLib.effectiveAudioLangPrefs(userState.audioLangPrefs, onboarded),
    };
    setAudioPickHint(req.params.mode, req.params.id, ctx);
    serverPick = cachedAudioPick(req.params.mode, req.params.id, ctx);
  }
  // What the transcode URL will map (explicit > server pick > unknown 0).
  const audioTrack = explicitAt ?? serverPick ?? 0;
  const transcodeSigInput = offsetSecs > 0
    ? `transcode:${req.params.mode}:${req.params.id}:${offsetSecs}`
    : `transcode:${req.params.mode}:${req.params.id}`;
  const transcodeSig = crypto.createHmac("sha256", PROXY_SECRET)
    .update(transcodeSigInput).digest("hex").slice(0, 16);
  const transcodeQuery =
    `s=${transcodeSig}` +
    (offsetSecs > 0 ? `&t=${offsetSecs}` : "") +
    (audio === "surround" ? `&a=surround` : "") +
    (explicitAt != null ? `&at=${explicitAt}` : serverPick != null ? `&ap=${serverPick}` : "");
  const transcodeUrl = `/api/transcode/${req.params.mode}/${req.params.id}/index.m3u8?${transcodeQuery}`;
  // /api/download produces a single-file 720p mp4 piped from ffmpeg.
  // Consumed by the Android phone's DownloadManager. HMAC-signed
  // with a dedicated prefix so it can't be forged from the proxy
  // signature or vice-versa.
  const downloadSig = crypto.createHmac("sha256", PROXY_SECRET)
    .update(`download:${req.params.mode}:${req.params.id}`).digest("hex").slice(0, 16);
  // Live channels with non-browser-decodable audio (MP2 / AC3 / EAC3
  // — common on sports feeds) get auto-routed through the transcoder
  // so the client never sees the silent-black-box failure mode. The
  // verdict is cached per channel; first hit blocks on ffprobe for
  // up to ~3s, subsequent hits are free. Movies / series skip this
  // path — they're already transcoded for MKV / unsupported codec
  // via the existing /api/stream → fragParsingError fallback.
  let forceTranscode = false;
  let forceReason = null;
  let liveChecked;
  if (req.params.mode === "live" && req.params.ext === "m3u8") {
    const key = `${req.params.mode}:${req.params.id}`;
    const zapT0 = Date.now();
    let zapGate = "", zapProbe = "none";
    // One line per live zap: where the time went (no URLs/creds).
    const zapLog = (status) => console.log(`[zap] live:${idInt} ${status} ${Date.now() - zapT0}ms gate=${zapGate} probe=${zapProbe}${viewerActive ? " viewer" : ""}${clientAudio ? " client-audio" : ""}`);
    let verdict = audioCodecCache[key];
    // Fail fast on dead/empty channels (see decideLiveHealth). A persistent-dead
    // verdict inside its TTL answers 503 with no network call; `?retry=1` (the
    // clients' Retry) bypasses it once. Any network check/probe is skipped while
    // ANY viewer is streaming (cap=1 account) -- then we just play, as before.
    // Other owners only: the requester's own current stream is still registered
    // while it zaps, and must not suppress its own codec probe.
    const viewerActive = streamingRecentlyIn(streams, null, LIVE_IDLE_GRACE_MS, Date.now(), ownerKeyOf(req));
    // Android apps (and ?probe=0) never read forceTranscode/url: no codec probe for them.
    const clientAudio = clientRoutesLiveAudio({ userAgent: req.get("user-agent"), probe: req.query.probe });
    const health = decideLiveHealth({ entry: verdict, now: Date.now(), viewerActive, retry: req.query.retry === "1" });
    zapGate = health.action;
    if (health.action === "unavailable") {
      zapLog(503);
      return res.status(503).json(LIVE_UNAVAILABLE);
    }
    let skipProbe = viewerActive || clientAudio;
    let livenessVerified = false;
    let checkKind = null;
    if (health.action === "check" && !audioProbeInflight.has(key)) {
      const known = !!verdict && (verdict.dead || !!verdict.audio_codec); // liveness-only entries don't count
      const tc = Date.now();
      const out = await refreshLiveLiveness(key, direct, verdict);
      checkKind = out.kind;
      zapGate = `check:${out.kind}(${Date.now() - tc}ms)`;
      if (out.kind === "dead") { zapLog(503); return res.status(503).json(LIVE_UNAVAILABLE); }
      verdict = out.entry;
      if (out.kind === "recovered" || out.kind === "alive") livenessVerified = true;
      // Known channel + flapping panel: don't hammer it, play. An unknown
      // channel still gets its codec probe (with its own liveness retries).
      if (out.kind === "inconclusive" && known) skipProbe = true;
    }
    liveChecked = liveVerdictTrusted({ viewerActive, healthAction: health.action, checkKind });
    // An unrechecked dead verdict never blocks playback or routes audio.
    if (verdict && verdict.dead) verdict = undefined;
    // Stale-while-revalidate: a known codec verdict (even past its TTL) routes
    // immediately; only an unknown channel waits, and only up to
    // LIVE_AUDIO_PROBE_WAIT_MS (default 3500; the probe keeps running and
    // caches for next zap). Keep it generous: an unknown MP2/AC3 channel played
    // direct gives silent audio on ExoPlayer (no error to recover from).
    const plan = decideLiveAudio({
      entry: verdict,
      fresh: isProbeFresh(verdict),
      sameKeyInflight: audioProbeInflight.has(key),
      anyInflight: anyProbeInflight(),
    });
    if (plan.wait && skipProbe) zapProbe = clientAudio ? "skip-client" : "skip";
    if (plan.wait && !skipProbe) {
      const tp = Date.now();
      try {
        const probed = await withDeadline(probeChannelAudioCodec(req.params.mode, req.params.id, undefined, { skipLiveness: livenessVerified || liveChecked }), LIVE_AUDIO_PROBE_WAIT_MS);
        if (probed) verdict = probed;
        zapProbe = `${probed ? (probed.dead ? "dead" : probed.audio_codec || "none") : "timeout"}(${Date.now() - tp}ms)`;
      } catch {}
      if (verdict && verdict.dead) { zapLog(503); return res.status(503).json(LIVE_UNAVAILABLE); }
    }
    if (verdict && verdict.audio_codec && !verdict.browser_safe) {
      forceTranscode = true;
      forceReason = `audio:${verdict.audio_codec}`;
    }
    zapLog(200);
  }
  const primaryUrl = forceTranscode ? transcodeUrl : direct;
  res.json({
    direct,
    proxy: signProxyUrl(direct),
    transcode: transcodeUrl,
    download: `/api/download/${req.params.mode}/${req.params.id}.mp4?s=${downloadSig}`,
    download2: `/api/download/${req.params.mode}/${req.params.id}.mp4?s=${downloadSig}&v=2`,
    url: primaryUrl,
    transcodeAnchorSecs: offsetSecs,
    forceTranscode,
    forceReason,
    // Live only: true = the server's liveness verdict is current (fresh cache
    // or a check that just passed), so the client can skip its own pre-play
    // manifest GET. false/absent = check it yourself.
    ...(liveChecked !== undefined ? { liveChecked } : {}),
    // The audio track the transcode URL maps (0 = default). Clients that
    // track the selected track should start from this, not 0.
    audioTrack,
    subtitles: streamSubtitles(req),
  });
});

// Cache-only (never calls TMDB or OpenSubtitles): lazy en/hi URLs when the
// title already has a TMDB match. Series need ?series=<id>&season=&episode=.
function streamSubtitles(req) {
  try {
    const mode = req.params.mode;
    if (mode !== "movie" && mode !== "series") return [];
    const id = mode === "series" ? String(req.query.series ?? "") : req.params.id;
    if (!/^\d{1,12}$/.test(id)) return [];
    const e = tmdbCache[`${mode}:${id}`];
    if (!e || e.source !== "tmdb" || !e.tmdb_id || !subtitleSvc.enabled()) return [];
    if (mode === "movie" && e.tmdb_kind === "series") return [];
    const c = subtitleCtx(req, mode, id);
    return c ? subtitleEntries(c) : [];
  } catch { return []; }
}

// Audio-track list for a panel VOD (movie/series). The client calls this
// after playback starts; if >1 audio track it shows a picker, and
// selecting a non-default track forces the transcoder with ?at=<index>.
// Network ffprobe (cached) — kept OUT of /api/stream so it never adds
// latency to the play path. ext is explicit (the client has it from the
// stream URL) so the panel URL is built correctly.
app.get("/api/tracks/:mode(movie|series)/:id.:ext", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const { mode, id } = req.params;
    const cacheKey = `${mode}:${id}`;
    const cachedFresh = () => {
      const c = panelTracksCache[cacheKey];
      return c && typeof c.ts === "number" && Date.now() - c.ts < PROBE_ALIVE_TTL_MS ? c : null;
    };
    // This title is being transcoded (usually for the very viewer asking):
    // its ffmpeg reports the track list within seconds of opening the file,
    // so wait for that instead of answering busy/empty (clients ask once:
    // empty = no Audio menu). No polling for a transcoder that may never
    // come (direct play): that case keeps the old probe/busy path.
    if (!cachedFresh() && transcoderActiveFor(mode, id)) {
      const learned = await waitForLearnedTracks(mode, id, 10000);
      if (!learned) return res.json({ audioTracks: [], busy: true });
      const cur = currentTranscodeTrack(mode, id);
      return res.json({ audioTracks: learned.audioTracks.map(audioTracksLib.publicTrack), ...(cur != null ? { currentTrack: cur } : {}) });
    }
    const probed = await Promise.race([
      probePanelTracks(mode, id, req.params.ext),
      new Promise((r) => setTimeout(() => r(null), 10000)),
    ]);
    const out = { audioTracks: ((probed && probed.audioTracks) || []).map(audioTracksLib.publicTrack) };
    // The track a running transcode of this title maps (clients that
    // haven't chosen one start their Audio selection here).
    const cur = currentTranscodeTrack(mode, id);
    if (cur != null && out.audioTracks.length) out.currentTrack = cur;
    if (!probed || probed.busy) out.busy = true; // viewer active or probe still running; retry later
    res.json(out);
  } catch {
    res.json({ audioTracks: [] });
  }
});

// (moved earlier in the file so it sits ahead of the auth middleware
// — see `app.get("/api/download/...")` near the transcode routes.)

app.get("/api/index/:mode(live|movie|series|disk)", (req, res) => {
  const mode = req.params.mode;
  const ix = indexes[mode];
  const userState = getProfileState(req.profileId);
  const activeProfile = profiles.profiles.find(p => p.id === req.profileId) || null;
  const modeKeys = (() => {
    const own = userState.filter?.groups?.[mode];
    if (Array.isArray(own) && own.length) return own;
    return userState.filter?.groups?.live || [];
  })();
  const onboarded = !!userState.filter?.onboarded && modeKeys.length > 0;
  const titleLangPasses = onboarded ? makeTitleLangFilter(new Set(modeKeys)) : () => true;
  // Skip kid-cert filter for live — broadcast channels don't ship a
  // us_cert, so a strict allow-list would hide every channel. Live
  // safety relies on the onboarded language/country/genre filter and
  // the kid-category regex baked into channel tags.
  const isKidBlocked = mode === "live" ? () => false : makeKidsBlocker(activeProfile);
  const seenTmdb = new Set();
  const streams = [];
  for (const s of ix.byId.values()) {
    if (!titleLangPasses(s.name)) continue;
    if (isKidBlocked(s)) continue;
    if (s.tmdb_id) {
      if (seenTmdb.has(s.tmdb_id)) continue;
      seenTmdb.add(s.tmdb_id);
    }
    streams.push(s);
  }
  res.json({ total: ix.total, done: ix.done, ready: ix.ready, streams });
});

app.get("/api/index/status", (_req, res) => {
  const out = {};
  for (const m of MODE_KEYS) {
    out[m] = { total: indexes[m].total, done: indexes[m].done, ready: indexes[m].ready };
  }
  res.json(out);
});

// Batched on-demand channel probe. The TV-Guide UI calls this with
// whatever channel ids just scrolled into view; we return the
// current cache state immediately and fire-and-forget probes for
// anything missing or stale at controlled concurrency. The client
// polls every few seconds while uncached entries remain — late
// verdicts populate the inline "off-air" marker as they land.
//
// The panel max_connections=1 cap means we have to pace ourselves:
// concurrency=2 + a soft yield, and only when nothing is actively
// streaming (the caller passes `playing: true` to pause the queue).
const probeQueue = [];
let probeWorkers = 0;
const PROBE_CONCURRENCY = 2;
function enqueueProbe(mode, id) {
  const key = `${mode}:${id}`;
  if (audioProbeInflight.has(key)) return;
  if (isProbeFresh(audioCodecCache[key])) return;
  if (probeQueue.some(([m, i]) => m === mode && i === id)) return;
  probeQueue.push([mode, id]);
  pumpProbeQueue();
}
function pumpProbeQueue() {
  while (probeWorkers < PROBE_CONCURRENCY && probeQueue.length) {
    const [mode, id] = probeQueue.shift();
    probeWorkers++;
    probeChannelAudioCodec(mode, id).finally(() => {
      probeWorkers--;
      // Tiny yield so the panel doesn't see us as a hammer — same
      // host that enforces max_connections=1 also rate-limits
      // bursts of "probe a channel, drop the slot, probe another".
      setTimeout(pumpProbeQueue, 250);
    });
  }
}
// PROBE_CHANNELS_ENABLED guards the visible-channel probe sweep. With
// the panel's max_connections=1 cap and slow-reaping ghost sessions,
// even short-lived probes climb the panel's active_cons counter
// faster than it can decrement. Default OFF so the TV Guide doesn't
// hammer the panel. The /api/stream play-time probe (single hit, only
// when the user actually clicks a channel) stays on regardless —
// that's what auto-routes MP2 / AC3 channels through the transcoder.
const PROBE_CHANNELS_ENABLED = process.env.PROBE_CHANNELS_ENABLED === "1"
  || process.env.PROBE_CHANNELS_ENABLED === "true";
app.post("/api/probe-channels", express.json({ limit: "32kb" }), (req, res) => {
  if (!PROBE_CHANNELS_ENABLED) {
    return res.json({ verdicts: {}, pending: 0, disabled: true });
  }
  const mode = String(req.body?.mode || "live");
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200) : [];
  if (mode !== "live") return res.status(400).json({ error: "live-only for now" });
  const verdicts = {};
  for (const raw of ids) {
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id)) continue;
    const key = `live:${id}`;
    const entry = audioCodecCache[key];
    if (entry && isProbeFresh(entry)) {
      verdicts[id] = entry;
    } else {
      enqueueProbe("live", id);
    }
  }
  res.json({ verdicts, pending: probeQueue.length });
});

app.post("/api/refresh", async (_req, res) => {
  console.log(`[refresh] /api/refresh from ${_req.ip} ua=${String(_req.get("user-agent") || "-").slice(0, 40)}`);
  const actx = getOwnerAccount();
  const picked = await pickPanel(actx);
  cache.clear();
  afterInfoCacheClear();
  await clearDiskIndexes(actx);
  // Panel modes only — "Refresh from panel" must NOT wipe the local disk
  // library (it isn't panel-derived; buildAllIndexes won't rebuild it).
  // This was the bug that made the Disk tab vanish after a refresh.
  //
  // Skip any mode whose build is already running (`ix.running`, set by
  // buildIndex). A second concurrent refresh used to reset ix.total/done/
  // byId unconditionally, out from under the first build's still-running
  // loop — which keeps incrementing ix.done and writing into whatever
  // `ix.byId` currently is, but never re-sets ix.total after the stomp.
  // End state: ix.total stuck at 0 forever with ix.ready eventually true
  // — the TV Guide's permanent empty "Indexing the channel list…" state.
  const skipped = [];
  for (const m of PANEL_MODES) {
    const ix = getIndexesFor(actx)[m];
    if (ix.running) { skipped.push(m); continue; }
    ix.ready = false;
    ix.byId = new Map();
    ix.done = 0;
    ix.total = 0;
  }
  buildAllIndexes(actx, { noYield: true }); // manual refresh already wiped the catalog — don't wait
  res.json({ ok: true, active_host: picked.active, ...(skipped.length ? { alreadyRefreshing: skipped } : {}) });
});

// Inventory of currently-tracked panel-touching streams. Useful for
// debugging concurrency issues and (in a follow-up) a UI showing who
// else in the household is currently streaming.
app.get("/api/streams", (_req, res) => {
  const list = [];
  for (const [owner, v] of streams) {
    list.push({
      owner_hash: crypto.createHash("sha1").update(owner).digest("hex").slice(0, 10),
      // A Save-to-Disk transfer: holds the provider slot but is not a viewer
      // (it yields to any play request and resumes after a restart).
      background: diskDlSchedule.isDiskDownloadOwner(owner),
      // A tile preview (lowest priority, stops for any viewer); not a viewer.
      preview: !!v.preview,
      account_hash: crypto.createHash("sha1").update(v.accountKey || "").digest("hex").slice(0, 10),
      mode: v.mode, id: v.id,
      since_ms: Date.now() - v.since,
      last_seen_ms: Date.now() - v.lastSeen,
      displaced: v.displaced,
    });
  }
  res.json({
    cap_per_account: MAX_CONCURRENT_STREAMS,
    active: list.filter((x) => !x.background && !x.preview).length, // viewers (and phone-download fetches)
    background: list.filter((x) => x.background).length,
    preview: list.filter((x) => x.preview).length,
    streams: list,
  });
});

app.get("/api/panel", (_req, res) => {
  const actx = getOwnerAccount();
  res.json({
    active: actx.host,
    primary: actx.primary,
    fallbacks: actx.fallbacks,
    candidates: actx.candidates,
    using_primary: actx.host === actx.primary,
  });
});

app.post("/api/panel/switch", async (req, res) => {
  const host = req.query.host;
  if (!host) return res.status(400).json({ error: "host param required" });
  const r = await switchToHost(host);
  res.json({ active: r.active, reason: r.reason });
});

// Return the current panel config (no password). Used by the settings
// UI to pre-fill the form with the active values.
app.get("/api/panel/config", (_req, res) => {
  const actx = getOwnerAccount();
  res.json({
    host: actx.primary,
    host_fallback: actx.hostFallback,
    user: actx.user,
    // Indicate a password is configured without exposing it. The form
    // shows a placeholder so the user knows they can leave it blank to
    // keep the current password.
    has_pass: !!actx.pass,
  });
});

// "Test" a proposed config without committing it. Probes the primary
// host with the proposed user/pass. Returns { ok, reason }.
app.post("/api/panel/config/test", express.json(), async (req, res) => {
  const actx = getOwnerAccount();
  const b = req.body || {};
  const host = String(b.host || "").trim().replace(/\/$/, "");
  const user = String(b.user || "").trim();
  // Treat empty pass as "use current password" — same logic as the
  // save endpoint — so test from the settings form works without
  // re-typing the password every time.
  const pass = b.pass === "" || b.pass == null ? actx.pass : String(b.pass);
  if (!host || !user || !pass) {
    return res.status(400).json({ ok: false, reason: "host, user, and pass required" });
  }
  const r = await probePanel(host, user, pass);
  res.json({ ok: r.ok, reason: r.reason || null });
});

// Save a new panel config to disk + mutate the live state. Validates
// the primary host first; if it fails, returns 400 and the old config
// stays active. On success: writes disk, flips creds, clears caches,
// kicks off a fresh index build in the background.
app.put("/api/panel/config", express.json(), async (req, res) => {
  const b = req.body || {};
  const host         = String(b.host || "").trim().replace(/\/$/, "");
  const hostFallback = String(b.host_fallback || b.hostFallback || "").trim();
  const user         = String(b.user || "").trim();
  // Empty password = keep current (lets the user edit host/user
  // without re-entering the password).
  const actx = getOwnerAccount();
  const pass = (b.pass === "" || b.pass == null) ? actx.pass : String(b.pass);
  if (!host || !user || !pass) {
    return res.status(400).json({ ok: false, reason: "host, user, and pass required" });
  }
  const probe = await probePanel(host, user, pass);
  if (!probe.ok) {
    return res.status(400).json({ ok: false, reason: `panel probe failed: ${probe.reason}` });
  }
  // Commit.
  actx.host         = host;
  actx.hostFallback = hostFallback;
  actx.user         = user;
  actx.pass         = pass;
  writePanelConfigToDisk({ host, hostFallback, user, pass });
  recomputePanelDerived(actx);
  actx.host = actx.primary; // start from primary on a fresh config
  // Wipe in-memory + on-disk caches so we don't serve stale stuff
  // belonging to the previous panel.
  cache.clear();
  afterInfoCacheClear();
  try { await clearDiskIndexes(actx); } catch {}
  // Panel modes only — a panel-credential change must not wipe the local
  // disk library (it isn't panel-derived; buildAllIndexes skips it).
  for (const m of PANEL_MODES) {
    const ix = getIndexesFor(actx)[m];
    ix.ready = false;
    ix.byId = new Map();
    ix.done = 0;
    ix.total = 0;
  }
  buildAllIndexes(actx).catch(() => {});
  console.log(`[panel] config updated → ${actx.host}`);
  res.json({ ok: true, active: actx.host });
});

app.get(/^\/(live|movie|series|disk|hindi)(\/.*)?$/, (_req, res) => {
  sendSpaShell(res);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: redactAllUrls(err && err.message) });
});

app.listen(PORT, async () => {
  const actx = getOwnerAccount();
  console.log(`khouch potato listening on :${PORT}`);
  console.log(`  primary:    ${actx.primary}`);
  console.log(`  fallbacks:  ${actx.fallbacks.join(", ") || "(none)"}`);
  console.log(`  data dir:   ${DATA_DIR}`);
  console.log(`  tmdb:       ${TMDB_API_KEY ? "enabled" : "disabled (set TMDB_API_KEY to enable)"}`);
  console.log(`  concurrency cap: ${MAX_CONCURRENT_STREAMS} concurrent stream(s) per IPTV account`);
  console.log(`  panel-config:    ${PANEL_CONFIG_KEY ? "encrypted (AES-256-GCM)" : "plaintext (set PROXY_SECRET in env to encrypt at rest)"}`);

  if ([...diskDownloadJobs.values()].some((j) => j.status === "queued")) {
    console.log(`[disk-download] resuming ${[...diskDownloadJobs.values()].filter((j) => j.status === "queued").length} job(s) restored from disk`);
    processDiskDownloadQueue().catch((e) => console.warn(`[disk-download] queue error: ${e.message}`));
  }

  for (const mode of PANEL_MODES) {
    const data = await loadIndexFromDisk(mode, actx);
    if (data) {
      const ageH = ((Date.now() - data.savedAt) / 3_600_000).toFixed(1);
      console.log(`[${mode}] loaded ${data.streams.length} items from disk (${ageH}h old)`);
    }
  }
  // Surround: series summaries from saved info, then the movie audio crawler
  // (also started after each movie index build).
  if (indexes.movie?.ready) setTimeout(startSurroundCrawler, 60_000).unref?.();

  await pickPanel(actx);
  console.log(`  active:     ${actx.host}`);
  // Series audio summaries from saved info (keys include the active host).
  seedSeriesAudioFromInfoStore().catch((e) => console.warn(`[surround] seed failed: ${e.message}`));

  const STALE_MS = TTL_MS;
  const needsRebuild = (mode) => {
    const f = indexFilePath(mode);
    try {
      const stat = fs.statSync(f);
      return Date.now() - stat.mtimeMs > STALE_MS;
    } catch {
      return true;
    }
  };
  const stale = new Set(PANEL_MODES.filter(needsRebuild));
  // The live index gained an `epg_channel_id` field; if the cached copy
  // pre-dates that addition, force a rebuild so the TV Guide can split
  // channels into "with EPG" / "without EPG" without an extra fetch.
  if (indexes.live.byId.size > 0) {
    const sample = indexes.live.byId.values().next().value;
    if (sample && !("epg_channel_id" in sample)) {
      console.log("[live] cached index pre-dates epg_channel_id field; rebuilding");
      indexes.live.ready = false;
      indexes.live.byId = new Map();
      indexes.live.done = 0;
      indexes.live.total = 0;
      stale.add("live");
    }
  }
  if (stale.size) {
    const list = [...stale];
    console.log(`rebuilding stale indexes in background: ${list.join(", ")}`);
    Promise.all(list.map(mode => buildIndex(mode, actx))).catch(() => {});
  } else {
    console.log("all indexes fresh; no rebuild needed at boot");
    // No rebuild planned → make sure TMDB cache is warm for any
    // movie/series items added since the last prewarm pass. Skipped
    // items already in cache return cheaply; new ones get fetched at
    // low concurrency in the background.
    if (indexes.movie.ready) {
      prewarmQualityCache(actx).catch(e => console.warn(`[movie] quality boot prewarm: ${e.message}`));
    }
    if (TMDB_API_KEY) {
      for (const m of ["movie", "series"]) {
        if (indexes[m].ready) {
          prewarmTmdbCache(m).catch(e => console.warn(`[${m}] boot prewarm: ${e.message}`));
        }
      }
    }
  }

  // Disk (local) library — owner-only. Scan the configured folder at boot.
  // Cheap on a warm probe cache (stats only); cold first run ffprobes each
  // file once. Not on the periodic panel-rebuild timer — it's local and
  // only re-scanned on demand via /api/admin/rescan-disk.
  {
    const owner = ownerUser();
    const diskPath = userDiskPath(owner);
    if (diskPath && userDiskEnabled(owner)) {
      console.log(`[disk] boot scan: ${diskPath}`);
      buildDiskIndex(actx, diskPath)
        .then(r => {
          console.log(`[disk] boot scan complete: ${r.count} titles${r.error ? " (" + r.error + ")" : ""}`);
          if (TMDB_API_KEY && r.count) prewarmTmdbCache("disk", actx).catch(e => console.warn(`[disk] tmdb prewarm: ${e.message}`));
        })
        .catch(e => console.warn(`[disk] boot scan failed: ${e.message}`));
    } else {
      // mark ready (empty) so the index endpoints don't report "building"
      getIndexesFor(actx).disk.ready = true;
    }
  }

  setInterval(async () => {
    // Refresh the owner panel AND every registered non-owner account, so
    // members' libraries stay current instead of frozen at signup time.
    // Each account has its own panel host; build sequentially and isolate
    // failures so one dead panel can't stall the rest. De-dupe by host hash
    // since two members on the same reseller share one namespaced index.
    const ctxs = [actx];
    for (const u of accounts.users) {
      if (u.role === "owner") continue;
      const a = getAccountForUser(u);
      if (a && !isOwnerAccount(a)) ctxs.push(a);
    }
    const seen = new Set();
    for (const a of ctxs) {
      const key = isOwnerAccount(a) ? "__owner__" : hostHashOf(a.host);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await pickPanel(a);
        await buildAllIndexes(a);
      } catch (e) {
        console.warn(`[refresh] periodic build failed (${key}): ${e.message}`);
      }
    }
  }, TTL_MS);

  // EPG bulk index: load any cached xmltv from disk; refresh now if
  // it's older than 24h; then schedule a nightly 3 AM refresh. The
  // boot-time refresh is fire-and-forget — every other code path
  // gracefully falls back to per-channel get_simple_data_table while
  // the xmltv download / parse is in flight.
  loadEpgIndexFromDisk().then(() => {
    try { applyEpgMatching(actx); } catch (e) { console.warn(`[epg] boot match: ${e.message}`); }
    // Also rebuild a guide saved before time-zone calibration existed
    // (calibration === undefined), so the fix doesn't wait up to 6h. Any
    // attempt, even a failed one, persists a calibration value (null when it
    // never got that far), so a failing build can't re-trigger on every boot.
    if (Date.now() - epgIndexBuiltAt > EPG_XMLTV_STALE_MS || epgStatus.calibration === undefined) {
      prewarmEpg(actx).catch(e => console.warn(`[epg] boot prewarm: ${e.message}`));
    }
    scheduleEpgNightlyRefresh();
  });

  // TMDB no-match retry — runs at 3:30 AM local, 30 min after the
  // xmltv pull so the two heavy panel-adjacent jobs don't fight for
  // headroom. Promotes any cached "no-match" entry that TMDB now
  // resolves (titles get added / fixed there over time).
  scheduleTmdbNightlyRetry();

  // AI taste profiles ("For You") — 4:15 AM, after the TMDB retry so
  // picks are computed against the freshest enrichment. No-op without
  // ANTHROPIC_API_KEY.
  scheduleTasteProfileNightly();

  // AI editorial rails — weekly (Sun 4:30 AM); "Tonight" digest —
  // nightly (4:45 AM, after the taste job + EPG refresh). Both no-op
  // without ANTHROPIC_API_KEY and boot-warm on a fresh deploy.
  scheduleEditorialRailsWeekly();
  scheduleTonightNightly();
  scheduleStreamingBuzz();
  scheduleStreamingArrivals();
  scheduleAltCerts();
  scheduleTrailers();
});
