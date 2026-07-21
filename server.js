const express = require("express");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const { AsyncLocalStorage } = require("async_hooks");

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
    return { ok: false, reason: e.message };
  }
}

async function pickPanel(actx = currentAccount()) {
  for (const host of actx.candidates) {
    const r = await probePanel(host, actx.user, actx.pass);
    if (r.ok) {
      if (actx.host !== host) {
        console.log(`switched panel: ${actx.host} → ${host}`);
        cache.clear();
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
const indexFilePath = (mode) => path.join(DATA_DIR, `index-${mode}.json`);
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
const tmdbCache = (() => {
  try {
    const raw = fs.readFileSync(tmdbCacheFile, "utf8");
    const d = JSON.parse(raw);
    return d && typeof d === "object" ? d : {};
  } catch { return {}; }
})();
let tmdbCacheSaveTimer = null;
function scheduleTmdbCacheSave() {
  if (tmdbCacheSaveTimer) return;
  tmdbCacheSaveTimer = setTimeout(async () => {
    tmdbCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(tmdbCacheFile + ".tmp", JSON.stringify(tmdbCache));
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
function scheduleQualityCacheSave() {
  if (qualityCacheSaveTimer) return;
  qualityCacheSaveTimer = setTimeout(async () => {
    qualityCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(qualityCacheFile + ".tmp", JSON.stringify(qualityCache));
      await fs.promises.rename(qualityCacheFile + ".tmp", qualityCacheFile);
    } catch (e) {
      console.warn(`save quality-cache failed: ${e.message}`);
    }
  }, 500);
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
function scheduleAudioCodecCacheSave() {
  if (audioCodecCacheSaveTimer) return;
  audioCodecCacheSaveTimer = setTimeout(async () => {
    audioCodecCacheSaveTimer = null;
    try {
      await fs.promises.writeFile(audioCodecCacheFile + ".tmp", JSON.stringify(audioCodecCache));
      await fs.promises.rename(audioCodecCacheFile + ".tmp", audioCodecCacheFile);
    } catch (e) {
      console.warn(`save audio-codec-cache failed: ${e.message}`);
    }
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
const PROBE_DEAD_TTL_MS  = 5 * 60 * 1000;
function isProbeFresh(entry) {
  if (!entry || typeof entry.ts !== "number") return false;
  const ttl = entry.dead ? PROBE_DEAD_TTL_MS : PROBE_ALIVE_TTL_MS;
  return Date.now() - entry.ts < ttl;
}
const audioProbeInflight = new Map();
// Manifest liveness check — short GET with redirect follow. Catches
// the panel-side 403 / 404 / "empty body" failure modes BEFORE we
// pay 1s of ffprobe runtime on a dead channel.
async function _probeManifestOnce(direct) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3500);
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
    lastReason = v.reason;
  }
  return { alive: false, reason: lastReason };
}
function probeChannelAudioCodec(mode, id, actx = currentAccount()) {
  const key = `${mode}:${id}`;
  if (audioProbeInflight.has(key)) return audioProbeInflight.get(key);
  const direct = streamUrl(mode, id, "m3u8", actx);
  const p = (async () => {
    // First: is the channel even responding? A dead panel host
    // means ffprobe would just block until our 6s timeout — wasteful
    // and starves the parallel-probe queue. Cheap manifest fetch
    // first; ffprobe only runs on confirmed-alive channels.
    const live = await probeManifestLiveness(direct);
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
function probePanelTracks(mode, id, ext, actx = currentAccount()) {
  const key = `${mode}:${id}`;
  const cached = panelTracksCache[key];
  if (cached && typeof cached.ts === "number" && Date.now() - cached.ts < PROBE_ALIVE_TTL_MS) {
    return Promise.resolve(cached);
  }
  if (panelTracksProbeInflight.has(key)) return panelTracksProbeInflight.get(key);
  const direct = streamUrl(mode, id, ext, actx);
  const p = new Promise((resolve) => {
    const args = [
      "-v", "error", "-print_format", "json",
      "-user_agent", "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36",
      "-show_entries", "stream=index,codec_type,codec_name,channels,disposition:stream_tags=language,title",
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
  if (v && v.is4k === false) return tags.filter(t => t !== "4k");
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
  const video = (info && info.info && info.info.video) || {};
  const audio = (info && info.info && info.info.audio) || {};
  const w = Number(video.width) || 0;
  const h = Number(video.height) || 0;
  // Reject zero-dimension entries — they're "panel didn't ffprobe"
  // states that'd otherwise demote a possibly-real-4K title because
  // we can't see the resolution. Re-check on the next prewarm.
  if (!w && !h) return null;
  const audio_channels = Number(audio.channels) || 0;
  const entry = {
    w, h,
    codec: video.codec_name || null,
    bitrate: Number(info?.info?.bitrate) || null,
    is4k: classifyAs4k(w, h),
    // Audio metadata: codec name (aac, ac3, eac3, dts, truehd…),
    // channel count (2, 6, 8…), and channel_layout when ffprobe
    // emitted one ("5.1", "7.1", "stereo"). Lets the client tag tiles
    // with a "5.1" / "7.1" badge so users can pick titles that'll
    // actually exercise their home-theater setup.
    audio_codec: audio.codec_name || null,
    audio_channels,
    audio_layout: audio.channel_layout || null,
    checked_at: Date.now(),
  };
  qualityCache[key] = entry;
  scheduleQualityCacheSave();
  return entry;
}

// Background pass that probes EVERY movie's vod_info to cache video
// + audio metadata. Same panel hit that 4K verification already pays,
// just broader. Output: tiles on home rails carry "5.1" / "7.1"
// audio badges as soon as the cache fills, instead of waiting for
// the user to drill into each detail screen.
//
// Conservative concurrency (2) + cap per run (PREWARM_AUDIO_BATCH).
// Cache entries persist on disk so each batch picks up where the
// previous left off — full catalog coverage spans multiple boots.
const AUDIO_PREWARM_CONCURRENCY = 2;
const AUDIO_PREWARM_BATCH = 1500;
async function prewarmAudioInfoCache(actx = currentAccount()) {
  const ix = getIndexesFor(actx).movie;
  if (!ix?.ready) return;
  // Only probe movies whose qualityCache entry is missing audio data —
  // either no entry at all, or an old entry from before the audio
  // fields existed.
  const candidates = [...ix.byId.values()].filter(s => {
    const c = qualityCache[`movie:${s.id}`];
    return !c || (!("audio_channels" in c));
  }).slice(0, AUDIO_PREWARM_BATCH);
  if (!candidates.length) return;
  const startedAt = Date.now();
  console.log(`[audio] probing ${candidates.length} movies for audio metadata`);
  let i = 0, probed = 0, surround = 0, failed = 0;
  await Promise.all(Array.from({ length: AUDIO_PREWARM_CONCURRENCY }, async () => {
    while (i < candidates.length) {
      const s = candidates[i++];
      const v = await verifyQuality4k(s.id, actx).catch(() => null);
      if (!v) { failed++; continue; }
      probed++;
      // Patch the in-memory index entry so /api/home / /api/index pick
      // up the audio fields immediately without a full rebuild.
      if (v.audio_channels) {
        s.audio_channels = v.audio_channels;
        s.audio_codec = v.audio_codec;
        if (v.audio_channels >= 3) {
          if (!Array.isArray(s.tags)) s.tags = [];
          if (!s.tags.includes("surround")) s.tags.push("surround");
          if (v.audio_channels >= 6) surround++;
        }
      }
    }
  }));
  console.log(`[audio] probed ${probed} (surround=${surround}, failed=${failed}) in ${((Date.now()-startedAt)/1000).toFixed(1)}s`);
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
  const candidates = [...ix.byId.values()].filter(s =>
    Array.isArray(s.tags) && s.tags.includes("4k")
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
  const videos = (detail.videos && Array.isArray(detail.videos.results))
    ? detail.videos.results : [];
  const trailerKey = (() => {
    const ytOnly = videos.filter(v => v.site === "YouTube" && v.key);
    const off = ytOnly.find(v => v.official && v.type === "Trailer")
            || ytOnly.find(v => v.type === "Trailer")
            || ytOnly.find(v => v.type === "Teaser")
            || ytOnly[0];
    return off ? off.key : null;
  })();

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
    rating:        Number.isFinite(detail.vote_average) ? Number(detail.vote_average.toFixed(1)) : null,
    vote_count:    Number.isFinite(detail.vote_count) ? detail.vote_count : 0,
    popularity:    Number.isFinite(detail.popularity) ? Number(detail.popularity.toFixed(2)) : 0,
    runtime:       isMovie ? (Number.isFinite(detail.runtime) ? detail.runtime : null)
                           : (Array.isArray(detail.episode_run_time) && detail.episode_run_time[0]) || null,
    genres:        Array.isArray(detail.genres) ? detail.genres.map(g => g.name).filter(Boolean) : [],
    tagline:       detail.tagline || null,
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
    reviews,
    recommendations: recIds,
    similar:       similarIds,
  };
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
    us_cert:     entry.us_cert || "",
    collection:  entry.collection || null,
    cast,
    directors:   entry.directors || [],
    keywords:    entry.keywords || [],
    trailer_key: entry.trailer_key || null,
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
function cleanPanelTitle(name, opts = {}) {
  let s = String(name || "");
  // Drop everything after first year-in-parens
  if (opts.strict !== false) {
    s = s.replace(/\((\d{4})\).*$/, "");
  }
  // Strip bracketed tags + commonly-appended quality words
  s = s.replace(/\[[^\]]*\]/g, " ")
       .replace(/\((Hindi|Tamil|Telugu|Malayalam|Kannada|Bengali|Gujarati|Marathi|Punjabi|Urdu|Dubbed|Sub|Subs|Subbed|Multi|Dual|DVD|BluRay|HDR|HEVC|x264|x265|HEVC10)\)/gi, " ")
       .replace(/\b(4K|FHD|UHD|HD|SD|CAM|HDRIP|DVDRIP|BLURAY|WEBRIP|WEBDL|WEB-DL|2160P|1080P|720P|480P|HDR|HEVC|x264|x265|DUAL|MULTI|DUBBED|SUB|SUBS)\b/gi, " ");
  // Dot-separated filename style → spaces (but preserve final ".0" decimals)
  s = s.replace(/\.(?=\D)/g, " ");
  // Trailing standalone year ("Title 1985") — strip when the year is
  // not part of the title proper. We pass year separately to TMDB so
  // the year-in-name is redundant noise.
  s = s.replace(/\s+(19|20)\d{2}\s*$/, "");
  // Tidy
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
    const pool = effYear
      ? results.filter((r) => { const y = yearOf(r); return Number.isFinite(y) && Math.abs(y - effYear) <= yearTol; })
      : results;
    if (effYear && !pool.length) continue;
    const pick = (langHint && pool.find((r) => r.original_language === langHint)) || pool[0];
    // Fetch the full detail so runtime/genres etc. populate.
    // append_to_response folds certification + credits + videos +
    // reviews + keywords + recommendations + similar + external_ids
    // into one call (TMDB allows up to 20 appends).
    const detailAction = effMode !== "series" ? `/movie/${pick.id}` : `/tv/${pick.id}`;
    const detail = await tmdb(detailAction, { append_to_response: TMDB_DETAIL_APPENDS(effMode) });
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
    "reviews",
    "keywords",
    "recommendations",
    "similar",
    "external_ids",
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
  const detail = await tmdb(detailAction, { append_to_response: TMDB_DETAIL_APPENDS(effMode) });
  if (!detail) return null;
  const projected = projectTmdbDetail(effMode, detail, detail.title || detail.name || "");
  if (projected && kindOverride) projected.tmdb_kind = kindOverride;
  return projected;
}

// Entry point used by the /api/poster routes. Reads cache (with negative
// TTL respect), searches if needed, persists, returns the public shape.
async function ensureTmdbForItem(mode, id, panelHints) {
  const cacheKey = `${mode}:${id}`;
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
  if (hintedId) {
    const refreshed = await refetchTmdbDetail(mode, hintedId);
    if (refreshed) {
      const entry = { ...refreshed, source: "tmdb", checked_at: Date.now() };
      tmdbCache[cacheKey] = entry;
      scheduleTmdbCacheSave();
      return entry;
    }
    // Detail fetch with the panel-supplied id failed — fall through
    // to the search-based path rather than caching a bad miss.
  }
  const match = await findTmdbMatch(mode, panelHints.name, panelHints.year, panelHints.lang, panelHints.forcedKind);
  const entry = match
    ? { ...match, source: "tmdb", checked_at: Date.now() }
    : { tmdb_id: null, source: "no-match", checked_at: Date.now() };
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
}

// ──────────────────────────────────────────────────────────────────
// XMLTV bulk EPG indexer. The panel's `xmltv.php` endpoint returns the
// entire EPG for every channel in a single (large) document. Pulling
// it once a night and parsing into an in-memory map means
// /api/epg/short/{streamId} becomes a pure in-memory slice — no panel
// round-trip per visible TV-Guide row. Falls back gracefully to the
// per-channel get_simple_data_table path when a channel isn't covered.
// ──────────────────────────────────────────────────────────────────
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
const EPG_XMLTV_STALE_MS   = 24 * 60 * 60 * 1000; // 24h — re-fetch if older
const EPG_NIGHTLY_HOUR     = 3; // 3 AM local for the daily refresh

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
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
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
      epgIndexBuiltAt = data.builtAt || 0;
      const totalProgs = [...epgIndex.values()].reduce((a, b) => a + b.length, 0);
      console.log(`[epg] loaded ${epgIndex.size} channels / ${totalProgs} programmes from disk`);
    } else {
      const e = getEpgIndexFor(actx);
      e.byChannel.clear();
      for (const [k, v] of Object.entries(data.byChannel)) {
        if (Array.isArray(v)) e.byChannel.set(k, v);
      }
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
      obj = { builtAt: epgIndexBuiltAt, byChannel: Object.fromEntries(epgIndex) };
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
async function prewarmEpg(actx = currentAccount()) {
  if (!actx.host) return false;
  const url = `${actx.host}/xmltv.php?username=${encodeURIComponent(actx.user)}&password=${encodeURIComponent(actx.pass)}`;
  console.log(`[epg] fetching xmltv.php …`);
  const t0 = Date.now();
  let response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(EPG_XMLTV_TIMEOUT_MS),
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV) AppleWebKit/537.36" },
    });
  } catch (e) {
    console.warn(`[epg] xmltv fetch failed: ${e.message}`);
    return false;
  }
  if (!response.ok) {
    console.warn(`[epg] xmltv returned HTTP ${response.status}`);
    return false;
  }
  let text;
  try { text = await response.text(); }
  catch (e) {
    console.warn(`[epg] xmltv body read failed: ${e.message}`);
    return false;
  }
  console.log(`[epg] downloaded ${(text.length / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s — parsing …`);

  // Single-pass regex scan. XMLTV is well-formed enough that this is
  // dramatically faster (and dependency-free) vs. a SAX parser.
  const PROG_RE = /<programme start="([^"]+)" stop="([^"]+)" channel="([^"]+)">([\s\S]*?)<\/programme>/g;
  const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/;
  const DESC_RE  = /<desc[^>]*>([\s\S]*?)<\/desc>/;
  const next = new Map();
  let total = 0;
  let m;
  while ((m = PROG_RE.exec(text)) !== null) {
    const startMs = xmltvToMs(m[1]);
    const stopMs  = xmltvToMs(m[2]);
    if (!startMs || !stopMs) continue;
    const channelId = m[3];
    if (!channelId) continue;
    const body = m[4];
    const tM = TITLE_RE.exec(body);
    const dM = DESC_RE.exec(body);
    const arr = next.get(channelId) || [];
    arr.push({
      start: startMs,
      stop:  stopMs,
      title: tM ? decodeXmlEntities(tM[1].trim()) : "",
      desc:  dM ? decodeXmlEntities(dM[1].trim()) : "",
    });
    next.set(channelId, arr);
    total++;
  }
  for (const arr of next.values()) arr.sort((a, b) => a.start - b.start);
  if (isOwnerAccount(actx)) {
    epgIndex.clear();
    for (const [k, v] of next) epgIndex.set(k, v);
    epgIndexBuiltAt = Date.now();
  } else {
    const e = getEpgIndexFor(actx);
    e.byChannel.clear();
    for (const [k, v] of next) e.byChannel.set(k, v);
    e.builtAt = Date.now();
  }
  console.log(`[epg] indexed ${next.size} channels / ${total} programmes in ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
  saveEpgIndexToDisk(actx);
  // Clean any newly-seen programme titles for keyword matching. Owner
  // EPG only (that's what `epgIndex` holds); fire-and-forget so the
  // refresh return isn't gated on the AI batch. No-op without a key.
  if (isOwnerAccount(actx) && ai.aiEnabled()) {
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
  const ms = msUntilNextLocalHour(EPG_NIGHTLY_HOUR);
  console.log(`[epg] next xmltv refresh in ${Math.round(ms / 60000)} min`);
  setTimeout(() => {
    prewarmEpg().catch(e => console.warn(`[epg] nightly: ${e.message}`));
    setInterval(() => {
      prewarmEpg().catch(e => console.warn(`[epg] nightly: ${e.message}`));
    }, 24 * 60 * 60 * 1000);
  }, ms);
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
  };
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
        const tmdbEntry = tmdbCache[`${mode}:${s.id}`];
        s.us_cert = tmdbEntry?.us_cert || null;
        s.tmdb_id = tmdbEntry?.tmdb_id || null;
      }
      // Re-attach audio metadata from qualityCache on every boot so
      // entries written by an offline prober (scripts/probe-audio.mjs)
      // — or by a previous server's prewarm — show up on tiles
      // immediately, without waiting for the user to open a detail
      // screen on each title.
      if (mode === "movie") {
        const qEntry = qualityCache[`movie:${s.id}`];
        if (qEntry?.audio_channels) {
          s.audio_channels = qEntry.audio_channels;
          s.audio_codec = qEntry.audio_codec || null;
          if (qEntry.audio_channels >= 3 && !s.tags.includes("surround")) {
            s.tags.push("surround");
          }
        }
      }
      byId.set(s.id, s);
    }
    const target = getIndexesFor(actx)[mode];
    target.byId = byId;
    target.total = data.total || data.streams.length;
    target.done = data.done || data.streams.length;
    target.ready = true;
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

async function xtream(action, params = {}, opts = {}) {
  const { timeout = 90_000, actx = currentAccount() } = opts;
  // Scope the cache + inflight map by accountKey so two accounts (owner
  // and a friend on a different reseller host, or just different panel
  // logins) don't poison each other. Same action+params under different
  // creds will yield different upstream responses.
  const key = `${accountKeyOf(actx)} ${action}${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return hit.v;
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
    if (!isAuthReject) cache.set(key, { t: Date.now(), v });
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
  const us_cert = tmdbEntry?.us_cert || null;
  const tmdb_id = tmdbEntry?.tmdb_id || null;
  // Audio metadata: surfaced when the quality cache has been populated
  // for this id (currently movie only — series episodes don't go through
  // verifyQuality4k). Lets the client tag tiles with a "5.1" / "7.1"
  // badge. Channel count > 2 also adds a synthetic "surround" tag so
  // future chip filtering can pick out multi-channel titles.
  const audioEntry = mode === "movie" ? qualityCache[`movie:${projectedId}`] : null;
  const audio_channels = audioEntry?.audio_channels || null;
  const audio_codec = audioEntry?.audio_codec || null;
  if (audio_channels && audio_channels >= 3 && !tags.includes("surround")) {
    tags = [...tags, "surround"];
  }
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
    audio_channels,
    audio_codec,
    // For live streams: panel returns epg_channel_id when EPG data exists
    // for this channel (empty string / null otherwise). The TV Guide uses
    // it to split channels into "with program data" / "without".
    epg_channel_id: mode === "live"
      ? (s.epg_channel_id ? String(s.epg_channel_id) : "")
      : undefined,
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

async function buildIndex(mode, actx = currentAccount()) {
  const ix = getIndexesFor(actx)[mode];
  if (ix.running) return;
  ix.running = true;
  const m = MODES[mode];
  const t = Date.now();
  try {
    const cats = await fetchCategoriesResilient(mode, m, actx);
    if (!cats) {
      console.warn(`[${mode}] index build aborted: no categories from panel or disk (will retry on next refresh tick)`);
      return;
    }
    saveCategoriesToDisk(mode, cats, actx);
    rebuildCategoryTags(mode, cats, actx);
    ix.total = cats.length;
    ix.done = 0;
    ix.byId = new Map();
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
      const beforeSize = ix.byId.size;
      let failed = false;
      try {
        const list = await xtream(m.list, { category_id: c.category_id }, { timeout: 60_000, actx });
        for (const s of list) {
          const p = projectStream(mode, s, actx);
          if (!ix.byId.has(p.id)) ix.byId.set(p.id, p);
        }
      } catch (e) {
        failed = true;
        console.warn(`  [${mode}] cat ${c.category_id} (${c.category_name}) failed: ${e.message}`);
      }
      let added = ix.byId.size - beforeSize;
      // Backfill from the last good snapshot when the panel errored, or
      // returned nothing for a category that previously had titles. A
      // transient 500 / [] must not delete content; fresh data wins on
      // any build where the panel actually answers, so this self-heals.
      if (added === 0) {
        const prev = priorByCat.get(String(c.category_id));
        if (prev && prev.length) {
          for (const s of prev) if (!ix.byId.has(s.id)) ix.byId.set(s.id, s);
          added = ix.byId.size - beforeSize;
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
    const newSize = ix.byId.size;
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
      ix.ready = true;
      return;
    }
    ix.ready = true;
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
      // Broader audio-metadata prewarm — walks all movies missing
      // audio data, capped at AUDIO_PREWARM_BATCH per run. Lets the
      // 5.1 / 7.1 badge populate on home rails without forcing the
      // user to click into every detail.
      prewarmAudioInfoCache(actx).catch(e => {
        console.warn(`[movie] audio prewarm errored: ${e.message}`);
      });
    }
  } finally {
    ix.running = false;
  }
}

async function buildAllIndexes(actx = currentAccount()) {
  await Promise.all(PANEL_MODES.map((m) => buildIndex(m, actx)));
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
        });
        continue; // absorbed into the series group, not its own tile
      }

      const { title, year } = parseTitleYear(basename);
      let tags = streamTagsFor(title, ["disk"]);
      if (!tags.includes("disk")) tags = [...tags, "disk"];
      if (classifyAs4k(a.video.width, a.video.height) && !tags.includes("4k")) tags = [...tags, "4k"];
      if (maxCh >= 3 && !tags.includes("surround")) tags = [...tags, "surround"];
      const tmdbEntry = tmdbCache[`disk:${id}`];
      byId.set(id, {
        id, name: title, year: year || null,
        icon: posterPath ? `/api/diskart/${id}/poster?acct=${diskAcctId(actx)}` : null,
        category_id: catId, category_name: catName,
        container,
        rating: null,
        us_cert: tmdbEntry?.us_cert || null,
        tmdb_id: tmdbEntry?.tmdb_id || null,
        audio_channels: maxCh || null,
        audio_codec: a.audioTracks[0]?.codec || null,
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
      byId.set(seriesId, {
        id: seriesId, name: group.seriesName, year: group.year || null,
        icon: null,
        category_id: group.catId, category_name: group.catName,
        container: null,
        rating: null,
        us_cert: tmdbEntry?.us_cert || null,
        tmdb_id: tmdbEntry?.tmdb_id || null,
        audio_channels: null,
        audio_codec: null,
        durationSecs: null,
        audioTracks: [], subtitleTracks: [],
        tags: ["disk", "series-group"],
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
// TIME, gated to an overnight window (isDiskDownloadWindowOpen) so it
// never competes with live viewing at all in practice. As a backstop for
// the rare case someone's up during the window, it also participates in
// the SAME admitStream() concurrency slot a real viewer uses, via a
// synthetic owner key — but ONLY after confirming the slot isn't already
// held by someone else (admitStream()'s own "newest wins" rule would
// otherwise let the download evict an ALREADY-WATCHING viewer, not the
// reverse — see the slotHeld check in runDiskDownloadJob for why). Disk
// is owner-only (see userDiskPath), so this whole subsystem only ever
// targets the owner's disk root.
// ===========================================================================

const DISK_DOWNLOAD_MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB headroom
const DISK_DOWNLOAD_DISPLACED_RETRY_MS = 30_000;
const DISK_DOWNLOAD_MAX_ERROR_RETRIES = 8;

// Persisted the same way as diskProbeCache above — a plain in-memory Map
// used to be the whole store, so a container restart (a deploy, a crash)
// silently dropped every queued/paused job with zero trace, and the
// overnight window that follows just never had anything to run. Loaded
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

// Downloads only run overnight (default 1–6 AM) rather than competing
// with live viewing at all — Kunal's call, simpler and safer than
// relying solely on the admitStream() displacement dance below to sort
// it out in real time (that mechanism stays in place as a backstop for
// the rare case someone's up during the window, not the primary guard).
// Hours are computed in the household's actual timezone (America/
// New_York), not server-local — the container runs in UTC (confirmed
// on hestia), so a naive Date().getHours() would silently pick the
// wrong 5-hour block.
// Number(badString) is NaN, and every comparison against NaN is false —
// a typo'd env value (e.g. "1am" instead of "1") would otherwise make
// isDiskDownloadWindowOpen() return false forever with zero error
// surfaced anywhere; jobs would just sit "queued" indefinitely. Falls
// back to the same default a missing/empty value would use.
function diskDownloadWindowHour(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : fallback;
}
const DISK_DOWNLOAD_WINDOW_START_HOUR = diskDownloadWindowHour(process.env.DISK_DOWNLOAD_WINDOW_START_HOUR, 1);
const DISK_DOWNLOAD_WINDOW_END_HOUR = diskDownloadWindowHour(process.env.DISK_DOWNLOAD_WINDOW_END_HOUR, 6);
const DISK_DOWNLOAD_WINDOW_TZ = process.env.DISK_DOWNLOAD_WINDOW_TZ || "America/New_York";
const DISK_DOWNLOAD_WINDOW_POLL_MS = 5 * 60_000;

function currentHourInDiskDownloadWindow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DISK_DOWNLOAD_WINDOW_TZ, hour: "numeric", hour12: false,
  }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour").value) % 24;
}
function isDiskDownloadWindowOpen() {
  const h = currentHourInDiskDownloadWindow();
  return DISK_DOWNLOAD_WINDOW_START_HOUR <= DISK_DOWNLOAD_WINDOW_END_HOUR
    ? h >= DISK_DOWNLOAD_WINDOW_START_HOUR && h < DISK_DOWNLOAD_WINDOW_END_HOUR
    : h >= DISK_DOWNLOAD_WINDOW_START_HOUR || h < DISK_DOWNLOAD_WINDOW_END_HOUR; // window wraps midnight
}

async function processDiskDownloadQueue() {
  if (diskDownloadQueueRunning) return;
  diskDownloadQueueRunning = true;
  try {
    while (true) {
      const job = [...diskDownloadJobs.values()].find((j) => j.status === "queued");
      if (!job) break;
      if (!isDiskDownloadWindowOpen()) {
        await new Promise((r) => setTimeout(r, DISK_DOWNLOAD_WINDOW_POLL_MS));
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

  job.status = "downloading";
  const { sourceUrl, ext, error: probeErr } = await resolveDownloadSourceUrl(job.mode, job.id, ownerAccount);
  if (!sourceUrl) {
    job.status = "failed";
    job.error = `source unavailable: ${probeErr}`;
    saveDiskDownloadJobs();
    return;
  }
  job.ext = ext;
  const destPath = diskDownloadDestPath(rootPath, job);
  const tmpPath = `${destPath}.part`;

  const owner = `disk-download:${job.jobId}`;

  while (true) {
    // Recomputed fresh every iteration (not hoisted above the loop) so a
    // panel failover mid-download (pickPanel switching ownerAccount.host)
    // self-heals within one retry cycle — real viewer traffic recomputes
    // this per-request too (see /api/proxy, /api/transcode), so a stale
    // cached accountKey here would silently split the download and a
    // real viewer into two independent cap=1 budgets after a failover.
    const accountKey = accountKeyOf(ownerAccount);
    // admitStream()'s eviction rule is "newest wins, oldest gets evicted"
    // — correct for two real viewers (whoever just pressed play should
    // win over a stale session), but WRONG for this job: if a real
    // viewer is already occupying the slot when the download tries to
    // (re)admit, admitStream would treat the download as "newest" and
    // evict the VIEWER instead of the reverse — the exact harm this
    // whole mechanism exists to prevent. So: never call admitStream()
    // while the slot is already held by someone else. Only registering
    // when the slot is free means the ONLY way this job ever loses it
    // afterward is a real viewer arriving LATER (registering newer),
    // which correctly evicts the download via the same "oldest evicted"
    // rule — that direction is the intended one. Synchronous check
    // immediately followed by admitStream(), no await between them, so
    // there's no event-loop window for a real request to interleave.
    const slotHeld = [...streams.entries()]
      .some(([k, v]) => k !== owner && v.accountKey === accountKey && !v.displaced);
    if (slotHeld) {
      job.status = "paused";
      job.pausedReason = "slot-held";
      saveDiskDownloadJobs();
      await new Promise((r) => setTimeout(r, DISK_DOWNLOAD_DISPLACED_RETRY_MS));
      continue;
    }
    let ac = new AbortController();
    const killer = (reason) => {
      job.pausedReason = reason;
      ac.abort();
    };
    const admission = admitStream(owner, job.mode, job.id, killer, accountKey);
    if (!admission.ok) {
      // Our own prior registration is still tagged displaced (the
      // streams-map reaper hasn't cleared it yet) — same "waiting for
      // the slot" state as slotHeld above, not actively downloading.
      job.status = "paused";
      saveDiskDownloadJobs();
      await new Promise((r) => setTimeout(r, DISK_DOWNLOAD_DISPLACED_RETRY_MS));
      continue;
    }
    job.status = "downloading";

    let startByte = 0;
    try { startByte = fs.statSync(tmpPath).size; } catch {}

    try {
      const resp = await fetch(sourceUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 12; Smart TV)",
          ...(startByte > 0 ? { Range: `bytes=${startByte}-` } : {}),
        },
        redirect: "follow",
        signal: ac.signal,
      });
      if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
      const resumed = resp.status === 206;
      const out = fs.createWriteStream(tmpPath, { flags: resumed ? "a" : "w" });
      // Resync to the .part file's real size, not the in-memory value —
      // bytesWritten is only persisted on status transitions (not per
      // chunk), so a job resuming after a restart would otherwise keep
      // incrementing from a stale/zero baseline forever. Within a single
      // process's lifetime this was already correct (a same-process pause/
      // resume never touched bytesWritten), so this is a no-op there.
      job.bytesWritten = resumed ? startByte : 0;
      // Expected total size, for verifying the transfer actually completed
      // rather than silently truncating — the same CDN-drop failure mode
      // /api/download had (closes the connection cleanly mid-transfer;
      // pipeline() sees a normal stream end, not an error). A 206's
      // Content-Range carries the total after the "/"; a fresh 200's
      // Content-Length IS the total. Missing/malformed header (some CDN
      // responses omit it) → can't verify, proceed on trust same as
      // /api/download does today.
      const expectedTotal = resumed
        ? Number(resp.headers.get("content-range")?.split("/")?.[1]) || null
        : Number(resp.headers.get("content-length")) || null;
      const source = Readable.fromWeb(resp.body);
      // touchStream keeps streams' lastSeen fresh for the whole transfer —
      // without it, admitStream() is only called once per pause/resume
      // cycle (job start / after a displacement), so lastSeen goes stale
      // the moment bytes start flowing and the idle reaper (which reaps
      // ANY entry — not just displaced ones — after LIVE_IDLE_GRACE_MS
      // with no touch) would kill a perfectly healthy, actively-writing
      // download as if it were an abandoned viewer.
      source.on("data", (chunk) => { job.bytesWritten += chunk.length; touchStream(owner); });
      await pipeline(source, out);

      if (expectedTotal != null) {
        const actual = fs.statSync(tmpPath).size;
        if (actual < expectedTotal) {
          throw new Error(`truncated transfer: got ${actual} of ${expectedTotal} bytes`);
        }
      }

      // Completed without abort, size verified — success.
      fs.renameSync(tmpPath, destPath);
      job.status = "done";
      job.finishedAt = Date.now();
      saveDiskDownloadJobs();
      dropStreamKiller(owner, killer);
      streams.delete(owner);
      console.log(`[disk-download] ${job.jobId} done → ${destPath} (${(job.bytesWritten / 1024 / 1024).toFixed(0)} MB)`);
      try {
        await buildDiskIndex(ownerAccount, rootPath);
        prewarmTmdbCache("disk", ownerAccount).catch(() => {});
      } catch (e) {
        console.warn(`[disk-download] post-download rescan failed: ${e.message}`);
      }
      return;
    } catch (e) {
      if (ac.signal.aborted) {
        // Displaced by a real viewer — this is expected, not an error.
        // Loop back: re-admit once the slot frees (streams' idle reaper
        // or the viewer's own session ending clears it), resuming via
        // Range from whatever this attempt already wrote.
        console.log(`[disk-download] ${job.jobId} paused (${job.pausedReason || "displaced"}) at ${(job.bytesWritten / 1024 / 1024).toFixed(0)} MB — will resume`);
        job.status = "paused";
        saveDiskDownloadJobs();
        // Matches the other exit paths (success, error-retry) — a
        // displaced entry is functionally inert (excluded from every
        // admitStream/slotHeld check by its own `displaced` flag) but
        // leaving it around until the idle reaper gets to it is a
        // needless stale entry for anyone reading `streams` to debug.
        streams.delete(owner);
        await new Promise((r) => setTimeout(r, DISK_DOWNLOAD_DISPLACED_RETRY_MS));
        continue;
      }
      job.retries += 1;
      job.error = e.message;
      streams.delete(owner);
      if (job.retries > DISK_DOWNLOAD_MAX_ERROR_RETRIES) {
        job.status = "failed";
        console.warn(`[disk-download] ${job.jobId} gave up after ${job.retries} attempts: ${e.message}`);
        try { fs.rmSync(tmpPath, { force: true }); } catch {}
        saveDiskDownloadJobs();
        return;
      }
      console.warn(`[disk-download] ${job.jobId} retry ${job.retries}/${DISK_DOWNLOAD_MAX_ERROR_RETRIES}: ${e.message}`);
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
app.get("/api/diskfile", (req, res) => {
  const r = resolveDiskRequest("file", req, true);
  if (!r) return res.status(403).end();
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
  // Panel audio-track selection (?at=) — like ?q/?a it's a UX setting,
  // not an authorization concern, so it's outside the HMAC. 0/absent =
  // the default first audio track (today's behavior).
  const audioTrack = normalizeAudioTrack(req.query.at);
  // Disk audio/subtitle selection (?da=, ?ds=) — null for panel modes.
  const diskSel = diskSelFromQuery(req.params.mode, req.query);
  // Admission control. The killer here SIGTERMs the ffmpeg so the
  // upstream panel slot is freed when this owner gets displaced.
  const owner = ownerKeyOf(req);
  const killer = (reason = "admit-displace") => {
    stopTranscoder(transcoders.get(transcoderKey(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, audioTrack)), reason);
  };
  const ad = admitStream(owner, req.params.mode, req.params.id, killer, currentAccountKey());
  if (!ad.ok) return sendDisplaced(res);
  try {
    const t = await startOrTouchTranscoder(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, audioTrack);
    const playlistPath = path.join(t.dir, "index.m3u8");
    // 30 s startup window. Heavy MKVs (4K HEVC with TrueHD audio) can
    // need 15-20 s for ffmpeg to read the source headers + emit the
    // first segment on a 2-vCPU VPS. The earlier 15 s budget timed out
    // legitimately-playable titles (Spectre, etc.) before any data
    // arrived.
    for (let i = 0; i < 120; i++) {
      if (fs.existsSync(playlistPath) && fs.readFileSync(playlistPath, "utf8").includes("#EXTINF")) {
        let content = fs.readFileSync(playlistPath, "utf8");
        // Segment URLs carry the same quality tag AND offset so the
        // segment route can route to the right ffmpeg dir even when
        // the user has flipped quality or re-anchored mid-stream.
        const qq = `q=${quality}` +
          (offsetSecs > 0 ? `&t=${offsetSecs}` : "") +
          (audio === "surround" ? `&a=surround` : "") +
          (diskSel?.a != null ? `&da=${diskSel.a}` : "") +
          (diskSel?.s != null ? `&ds=${diskSel.s}` : "");
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
  const audioTrack = normalizeAudioTrack(req.query.at);
  const diskSel = diskSelFromQuery(req.params.mode, req.query);
  const t = transcoders.get(transcoderKey(req.params.mode, req.params.id, quality, offsetSecs, audio, diskSel, audioTrack));
  if (!t) return res.status(404).end();
  t.lastAccess = Date.now();
  const segPath = path.join(t.dir, `seg_${req.params.n}.ts`);
  if (!fs.existsSync(segPath)) return res.status(404).end();
  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Access-Control-Allow-Origin", "*");
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
async function resolveDownloadSourceUrl(mode, id, actx = currentAccount()) {
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
        signal: AbortSignal.timeout(4000),
      });
      const ct = probe.headers.get("content-type") || "";
      const buf = Buffer.from(await probe.arrayBuffer());
      if (!ct.startsWith("text/") && buf.length > 0) {
        return { sourceUrl: url, ext };
      }
      lastProbeErr = `${ext}: ct=${ct} bytes=${buf.length}`;
    } catch (e) {
      lastProbeErr = `${ext}: ${e.message}`;
    }
  }
  return { sourceUrl: null, ext: null, error: lastProbeErr };
}

app.get("/api/download/:mode(movie|series)/:id.mp4", async (req, res) => {
  const { mode, id } = req.params;
  const expected = crypto.createHmac("sha256", PROXY_SECRET)
    .update(`download:${mode}:${id}`).digest("hex").slice(0, 16);
  if (req.query.s !== expected) return res.status(403).end("bad signature");

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
    "-map", "0:v:0", "-map", "0:a:0?",
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
      console.warn(`[download] ${mode}/${id} ffmpeg exit ${code}\n${stderrBuf.slice(-1024)}`);
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

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
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
  const id = `p${profiles.nextId++}`;
  profiles.profiles.push({ id, nick, avatar, kidsBirthYear, ownerUserId: req.user.id, createdAt: Date.now() });
  profileStates.set(id, emptyUserState());
  saveProfilesToDisk();
  scheduleUserStateSave();
  res.json({ ok: true, id });
});

// Update an existing profile's nickname / avatar / kidsBirthYear.
app.patch("/api/profiles/:id", express.json(), (req, res) => {
  const p = findProfile(req.params.id);
  if (!p) return res.status(404).json({ error: "unknown profile" });
  if (p.ownerUserId !== req.user.id) return res.status(404).json({ error: "unknown profile" });
  const b = req.body || {};
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
  saveProfilesToDisk();
  res.json({ ok: true });
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
  .replace(/(href|src)="\/(style\.css|app\.js|theatre-portraits\.js)"/g,
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
      profile: activeProfile && {
        id: activeProfile.id,
        nick: activeProfile.nick,
        avatar: normalizeAvatar(activeProfile.avatar),
        kidsBirthYear: activeProfile.kidsBirthYear || null,
      },
      user: req.user && {
        id: req.user.id,
        username: req.user.username,
        role: req.user.role,
      },
      userState: getProfileState(activeProfile ? activeProfile.id : "p1"),
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

app.get("/api/home/:mode(live|movie|series|disk)", (req, res) => {
  // No browser cache — the response varies per profile + per filter
  // change + per server-side rule update (e.g. title-language guard).
  // Without this, browsers serve stale rails after a profile switch
  // or a deploy, and users see content the new code would have
  // filtered out.
  res.set("Cache-Control", "no-store");
  const mode = req.params.mode;
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
    let cert = t?.us_cert || null;
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
      poster: t?.poster_path ? `https://image.tmdb.org/t/p/w154${t.poster_path}` : null,
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
      audio_channels: s.audio_channels ?? null,
      audio_codec: s.audio_codec ?? null,
      // Disk-only: a synthetic tile grouping Save-to-Disk episodes under
      // one series (see buildDiskIndex) — the client opens the episode
      // picker instead of playing this id directly.
      isSeriesGroup: s.isSeriesGroup || undefined,
      episodeCount: s.episodeCount || undefined,
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
      poster: t?.poster_path ? `https://image.tmdb.org/t/p/w342${t.poster_path}` : null,
      // w1280 (vs w780) — at the taller hero size, w780 was visibly
      // upscaled on wide monitors. w1280 is the next TMDB step up
      // and is the right size for a 1440p-ish hero with the 1.05
      // zoom transform applied.
      backdrop: t?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${t.backdrop_path}` : null,
      rating: t?.rating || null,
      runtime: t?.runtime || null,
      us_cert: t?.us_cert || null,
      isSeriesGroup: s.isSeriesGroup || undefined,
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

  // Group eligible items by category in one pass over the index.
  const byCat = new Map();
  for (const s of ix.byId.values()) {
    const cid = String(s.category_id || "");
    if (!allowedCatIds.has(cid)) continue;
    if (!titleLangPasses(s.name)) continue;
    let bucket = byCat.get(cid);
    if (!bucket) { bucket = []; byCat.set(cid, bucket); }
    bucket.push(s);
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
    for (const s of bucket) {
      const titleKey = dedupTitleKey(s.name);
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
  for (const [cid, bucket] of byCat) {
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

  // Continue Watching — merged rail (#48). Union of `userState.progress`
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
    const unionIds = new Set([...progressById.keys(), ...recentIds]);
    const idsByRecency = [...unionIds]
      .map((id) => {
        const p = progressById.get(id);
        if (p?.t) return [id, p.t];
        const lp = lpForMode[String(id)];
        return [id, lp || 0];
      })
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);
    const cwTiles = idsByRecency
      .map((id) => ix.byId.get(id))
      .filter((s) => s && titleLangPasses(s.name))
      .map((s) => {
        const tile = tileFor(s);
        if (!tile) return null;
        const p = progressById.get(s.id);
        if (p && Number.isFinite(p.p) && p.p > 5) {
          tile.progress = { p: p.p, d: p.d || null };
        }
        return tile;
      })
      .filter((t) => t && isKidSafe(t));
    if (cwTiles.length) {
      rails.push({
        title: "Continue Watching",
        // Web client's PSEUDO.RECENTS pseudo-category id. Surfaces a
        // "See all ›" button on the rail header and selectCategory()
        // already knows how to render this view. Server doesn't render
        // this value anywhere — it's a hint for the client.
        category_id: "__recents",
        total: cwTiles.length,
        items: cwTiles.slice(0, 12),
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
    if (Array.isArray(pickIds) && pickIds.length) {
      const seenFy = new Set();
      const fyTiles = pickIds
        .map((id) => ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10)))
        .filter((s) => s && titleLangPasses(s.name))
        .filter((s) => {
          const key = s.tmdb_id || `id:${s.id}`;
          if (seenFy.has(key)) return false;
          seenFy.add(key);
          return true;
        })
        .map((s) => {
          const tile = tileFor(s, null);
          const reason = pickReasons?.[String(s.id)];
          if (tile && reason) tile.pickReason = reason;
          return tile;
        })
        .filter((t) => t && !isKidBlocked(t));
      if (fyTiles.length >= 4) {
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
      .filter(({ s }) => titleLangPasses(s.name))
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
      .filter((s) => titleLangPasses(s.name))
      .map((s) => ({ s, t: tmdbFor(s.id) }))
      .filter((x) => x.t && x.t.us_cert && FAMILY_CERTS.has(x.t.us_cert))
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
      rails.push({
        title: "Family Friendly",
        category_id: "__rail-family",
        total: familyTiles.length,
        items: familyTiles.slice(0, 100),
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
        .map((id) => ix.byId.get(id) ?? ix.byId.get(parseInt(id, 10)))
        .filter((s) => s && titleLangPasses(s.name))
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
          items: edTiles.slice(0, 20),
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
    const tmdbBy = (s) => tmdbFor(s.id);
    // Build the pool, deduplicating by tmdb_id so a movie that the
    // panel ships in 5 quality / language / dub variants doesn't take
    // 5 tiles in every smart rail. First eligible variant wins —
    // panel ordering is stable enough that the "primary" listing
    // tends to land first. Items without tmdb_id are skipped entirely
    // (the smart rails are TMDB-driven).
    const pool = [];
    const seenTmdb = new Set();
    for (const s of ix.byId.values()) {
      if (!titleLangPasses(s.name)) continue;
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
    // TV Movie is a TMDB genre that lumps in straight-to-streaming
    // / made-for-cable productions, which would crowd out theatrical
    // titles on every genre rail if left in. Drop them from the
    // discovery layer entirely; they still surface via panel rails.
    const notTvMovie = (p) =>
      !(Array.isArray(p.t.genres) && p.t.genres.includes("TV Movie"));

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
    const addRail = (title, items) => {
      const eligible = items.filter(p => !surfacedIds.has(p.s.id));
      if (eligible.length < MIN_RAIL) return;
      const filtered = eligible.slice(0, RAIL_CAP);
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
      pool
        .filter(p => p.t.year === thisYear)
        .filter(notTvMovie)
        .sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0)),
    );

    // Critically acclaimed — high rating, real audience size
    addRail(
      "Critically Acclaimed",
      pool
        .filter(p => (p.t.rating || 0) >= 7.5 && (p.t.vote_count || 0) >= 500)
        .filter(notTvMovie)
        .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0)),
    );

    // Per-genre rails. Order is rough "broad → niche" so the most
    // crowd-pleasing genres land highest on the home. Each title only
    // gets used once across smart rails, so a film tagged Action +
    // Thriller goes into Action (which comes first) and not both.
    for (const g of ["Action", "Comedy", "Drama", "Thriller", "Horror",
                     "Romance", "Science Fiction", "Animation", "Family",
                     "Documentary"]) {
      addRail(g, pool
        .filter(p => Array.isArray(p.t.genres) && p.t.genres.includes(g))
        .filter(notTvMovie)
        .sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0)));
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
    const lastPlayId = (() => {
      const lp = userState.lastPlayed?.[mode];
      if (!lp || typeof lp !== "object") return null;
      let bestId = null, bestT = 0;
      for (const [k, t] of Object.entries(lp)) {
        if (t > bestT) { bestT = t; bestId = parseInt(k, 10); }
      }
      return bestId;
    })();
    if (lastPlayId) {
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
        addRail(`Because you watched ${refClean}`, recItems);
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
      addRail(c.name, c.items);
    }

    // Long-tail discovery — high-quality stuff most people haven't
    // heard of (low vote_count). Pinned to the bottom of the smart
    // block so the user has already seen the safer big-name rails.
    addRail("Hidden Gems", pool
      .filter(p => (p.t.rating || 0) >= 7 && (p.t.vote_count || 0) >= 50 && (p.t.vote_count || 0) < 500)
      .filter(notTvMovie)
      .sort((a, b) => (b.t.rating || 0) - (a.t.rating || 0)));
  }

  // Per-category rails, ordered by the original category list so the
  // sequence is stable across reloads.
  for (const c of cats) {
    const items = byCat.get(String(c.category_id));
    if (!items?.length) continue;
    rails.push({
      title: c.category_name,
      // category_id lets the Android / phone clients open a "See all"
      // view for that rail. The web client doesn't use this — it has
      // the full index in memory and navigates via its own routing.
      category_id: String(c.category_id),
      total: bucketTotals.get(String(c.category_id)) || items.length,
      items: items.map(s => tileFor(s, c.category_name)),
    });
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
    const cert = tmdbFor(s.id)?.us_cert || s.us_cert;
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
      const titleKey = dedupTitleKey(s.name);
      if (titleKey && seenTitle.has(titleKey)) continue;
      if (s.tmdb_id && seenTmdb.has(s.tmdb_id)) continue;
      if (isAdultForHero(s)) { seen.add(s.id); continue; }
      heroPool.push(s); seen.add(s.id);
      if (titleKey) seenTitle.add(titleKey);
      if (s.tmdb_id) seenTmdb.add(s.tmdb_id);
    }
  }
  // Seed = today's date + active profile id + mode. Mulberry32 is
  // a small fast PRNG, deterministic from the seed.
  const daySeed = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}:${req.profileId || "p1"}:${mode}`;
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
  for (const [key, label] of [["4k", "4K"], ["movies", "Movies"]]) {
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

  res.json({
    mode,
    ready: ix.ready,
    rails,
    hero,
    chips,
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
      poster: t?.poster_path ? `https://image.tmdb.org/t/p/w154${t.poster_path}` : null,
      us_cert: t?.us_cert || null,
      tags: s.tags || ["other"],
      container: s.container || null,
      audio_channels: s.audio_channels ?? null,
      audio_codec: s.audio_codec ?? null,
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
app.post("/api/progress/:mode(movie|series|disk)/:id", express.json(), (req, res) => {
  const userState = getProfileState(req.profileId);
  const { mode, id } = req.params;
  const position = Number(req.body?.position);
  const duration = Number(req.body?.duration);
  if (!Number.isFinite(position) || position < 0) {
    return res.status(400).json({ error: "bad position" });
  }
  const key = `${mode}:${id}`;
  const validDur = Number.isFinite(duration) && duration > 0 ? duration : null;
  const finished = validDur != null && (position >= validDur - 30 || position >= validDur * 0.95);
  if (position < 30 || finished) {
    delete userState.progress[key];
  } else {
    userState.progress[key] = { p: position, d: validDur, t: Date.now() };
  }
  scheduleUserStateSave();
  res.json({ ok: true });
});

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
    userState.lastEpisode = b.lastEpisode;
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
    const projectTile = (s) => {
      const t = mode !== "live" ? tmdbCache[`${mode}:${s.id}`] : null;
      return {
        id: s.id,
        name: s.name,
        icon: s.icon || null,
        poster: t?.poster_path ? `${TMDB_IMG_BASE}/w154${t.poster_path}` : null,
        year: s.year || null,
        rating: s.rating || null,
        us_cert: s.us_cert || null,
        tmdb_id: s.tmdb_id || null,
        category_id: s.category_id,
        tags: s.tags || [],
        container: s.container || null,
        isSeriesGroup: s.isSeriesGroup || undefined,
      };
    };
    const eligible = (s) => {
      if (!titleLangPasses(s.name)) return false;
      if (isKidBlocked(s)) return false;
      // Title+year fallback — catches a duplicate before it has a
      // tmdb_id to dedup on, or when two duplicates' tmdb_id lookups
      // haven't converged yet. See dedupTitleKey.
      const titleKey = dedupTitleKey(s.name);
      if (titleKey && seenTitle.has(titleKey)) return false;
      if (s.tmdb_id) {
        if (seenTmdb.has(s.tmdb_id)) return false;
        seenTmdb.add(s.tmdb_id);
      }
      if (titleKey) seenTitle.add(titleKey);
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
        // Name residual — fuzzy AND-match against the panel title
        // + TMDB cast names + TMDB director names. Each user token
        // becomes a 4-char prefix (full token if shorter) so spelling
        // variants like "Ajay Devgan" → "Ajay Devgn" still match.
        // Every token must hit somewhere in the haystack; this avoids
        // "ajay devgan" matching every film that has either a random
        // "Ajay X" or "Y Devgan" in any role.
        if (nameLow) {
          const userTokens = nameLow.split(/\s+/).filter(Boolean);
          const prefixes = userTokens.map(tok => tok.length >= 5 ? tok.slice(0, 4) : tok);
          const haystackParts = [(s.name || "").toLowerCase()];
          if (Array.isArray(t.cast)) {
            for (const c of t.cast) haystackParts.push((c.name || "").toLowerCase());
          }
          if (Array.isArray(t.directors)) {
            for (const d of t.directors) haystackParts.push((d || "").toLowerCase());
          }
          const haystack = haystackParts.join(" | ");
          if (!prefixes.every(p => haystack.includes(p))) continue;
        }
        if (!eligible(s)) continue;
        matches.push({ s, t });
        if (matches.length >= limit * 3) break; // collect a bit extra to sort
      }
      // Sort by audience size (vote_count) — bigger / more-watched
      // titles first so the user sees recognizable matches up top.
      matches.sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0));
      for (const m of matches) {
        if (results.length >= limit) break;
        results.push(projectTile(m.s));
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
      if (rank) ranked.push({ s, rank });
    }
    ranked.sort((a, b) => b.rank - a.rank);
    for (const { s } of ranked) {
      if (results.length >= limit) break;
      if (!eligible(s)) continue;
      results.push(projectTile(s));
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
        const titleKey = dedupTitleKey(s.name);
        if (titleKey && seenTitle.has(titleKey)) continue;
        if (s.tmdb_id) {
          if (seenTmdb.has(s.tmdb_id)) continue;
          seenTmdb.add(s.tmdb_id);
        }
        if (titleKey) seenTitle.add(titleKey);
        tagged.push({ s, vc: t.vote_count || 0 });
      }
      tagged.sort((a, b) => b.vc - a.vc);
      for (const { s } of tagged) {
        if (results.length >= limit) break;
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
            const kidPass = (t) => t.us_cert && FAMILY_CERTS.has(t.us_cert);
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
  const modeKeys = (() => {
    const g = userState.filter?.groups || {};
    if (Array.isArray(g[mode]) && g[mode].length) return g[mode];
    if (Array.isArray(g.movie) && g.movie.length) return g.movie;
    return g.live || [];
  })();
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
  // Panel icon is unreliable for movie/series VOD entries (Xtream panels
  // populate stream_icon reliably for live channel logos, but frequently
  // leave it null/blank for VOD) — same reason /api/home and the detail
  // screens lean on TMDB enrichment instead. This endpoint used to skip
  // that fallback entirely, unlike /api/search/all's projectTile (which
  // already does this exact lookup), leaving movie/series search results
  // with blank thumbnails whenever the panel icon was empty. tmdbCache
  // is already warmed in-memory (prewarmTmdbCache), so this is a
  // synchronous lookup, no extra round-trip.
  const results = ranked.slice(0, limit).map(({ s }) => {
    const t = mode !== "live" ? tmdbCache[`${mode}:${s.id}`] : null;
    return {
      id: s.id,
      name: s.name,
      icon: s.icon || null,
      poster: t?.poster_path ? `${TMDB_IMG_BASE}/w154${t.poster_path}` : null,
      category_id: s.category_id,
      category_name: catName.get(String(s.category_id)) || null,
      isSeriesGroup: s.isSeriesGroup || undefined,
    };
  });
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
    const out = list
      .map(p => ({
        title:       decode(p.title),
        description: decode(p.description),
        start_ts:    Number(p.start_timestamp) || (p.start ? Math.floor(new Date(p.start).getTime() / 1000) : null),
        stop_ts:     Number(p.stop_timestamp)  || (p.end   ? Math.floor(new Date(p.end).getTime()   / 1000) : null),
      }))
      .filter(p => p.start_ts && p.stop_ts && p.stop_ts > fromSec && p.start_ts < toSec)
      .sort((a, b) => a.start_ts - b.start_ts);
    res.json({ stream_id: streamId, programs: out, source: "panel" });
  } catch (e) { next(e); }
});

app.get("/api/:mode(live|movie|series|disk)/streams", async (req, res, next) => {
  try {
    const mode = req.params.mode;
    const ix = indexes[mode];
    const catId = req.query.category_id ? String(req.query.category_id) : null;
    // Panel `icon` is unreliable for movie/series VOD (frequently blank),
    // and disk only has one when a local sidecar poster file exists next
    // to the video — most saved titles have neither — so plenty of disk
    // items hit this the same way VOD does. Same rationale as
    // /api/search/:mode's poster fallback. Unlike that endpoint this one
    // can't add a separate `poster` field without a client-model change
    // (the Android Stream model only has `icon`), so this overrides
    // `icon` in the RESPONSE only when it's already empty — never
    // mutates the shared index entry. Without this, "See All" on a disk
    // category showed 400+ blank tiles (no sidecar poster + TMDB posters
    // only composited by /api/home + /api/poster + /api/search today,
    // not here).
    const withPosterFallback = (s) => {
      if (s.icon || mode === "live") return s;
      const t = tmdbCache[`${mode}:${s.id}`];
      if (!t?.poster_path) return s;
      return { ...s, icon: `${TMDB_IMG_BASE}/w154${t.poster_path}` };
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
        const titleKey = dedupTitleKey(s.name);
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
    const v = await xtream(m.info, { [key]: req.params.id });
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
    // vod_info round-trip, so write the audio/video metadata straight
    // into qualityCache. Lazy population — each movie a user opens a
    // detail screen for gets cached on first view; tiles render their
    // "5.1" badge on the next bootstrap / index re-emission.
    if (mode === "movie" && v?.info) {
      const cacheKey = `movie:${req.params.id}`;
      const video = v.info.video || {};
      const audio = v.info.audio || {};
      const w = Number(video.width) || 0;
      const h = Number(video.height) || 0;
      if (w || h || audio.channels) {
        const numId = parseInt(req.params.id, 10);
        const entry = {
          w, h,
          codec: video.codec_name || null,
          bitrate: Number(v.info.bitrate) || null,
          is4k: classifyAs4k(w, h),
          audio_codec: audio.codec_name || null,
          audio_channels: Number(audio.channels) || 0,
          audio_layout: audio.channel_layout || null,
          checked_at: Date.now(),
        };
        qualityCache[cacheKey] = entry;
        scheduleQualityCacheSave();
        // Patch the in-memory index entry too so the NEXT projectStream
        // emission (e.g. /api/index re-poll) carries the audio fields
        // without waiting for a full rebuild.
        const indexItem = indexes.movie?.byId?.get(numId);
        if (indexItem) {
          indexItem.audio_codec = entry.audio_codec;
          indexItem.audio_channels = entry.audio_channels;
          if (entry.audio_channels >= 3 && !indexItem.tags?.includes("surround")) {
            indexItem.tags = [...(indexItem.tags || []), "surround"];
          }
        }
      }
    }
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

// TMDB poster + metadata for a movie or series. Returns null TMDB
// fields when no key is configured or when nothing matches — the
// client falls back to the panel artwork in either case. We pull the
// panel name+year from the in-memory index so the lookup happens
// server-side without the client needing to know the title.
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
    res.json(tmdbToResponse(entry));
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
    if (!entry || entry.source !== "no-match") continue;
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
        if (match && match.tmdb_id) {
          tmdbCache[c.key] = { ...match, source: "tmdb", checked_at: Date.now() };
          tally.promoted++;
          onProgress?.({ phase: "hit", id: c.id, mode: c.mode, name, tmdb_id: match.tmdb_id, us_cert: match.us_cert || "" });
        } else {
          // Refresh checked_at so the next cron pass doesn't re-retry
          // immediately — keep the no-match status.
          tmdbCache[c.key] = { tmdb_id: null, source: "no-match", checked_at: Date.now() };
          tally.stillMissing++;
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
      try {
        const match = await findTmdbMatch(c.mode, c.name, c.nameYear, c.lang, c.forcedKind);
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
    if (excludeIds.has(String(s.id))) continue;
    if (!langPass(s.name)) continue;
    const t = tmdbCache[`${mode}:${s.id}`];
    if (!t || t.source === "no-match" || !t.tmdb_id) continue;
    if (seenTmdb.has(t.tmdb_id)) continue;
    if (kidBlocked({ us_cert: t.us_cert || s.us_cert })) continue;
    seenTmdb.add(t.tmdb_id);
    pool.push({ s, t });
  }
  pool.sort((a, b) => (b.t.vote_count || 0) - (a.t.vote_count || 0));
  return pool.slice(0, cap).map(({ s, t }) => ({
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
    if (rated.has(String(s.id))) continue;
    if (!langPass(s.name)) continue;
    const t = tmdbCache[`${mode}:${s.id}`];
    if (!t || t.source === "no-match" || !t.tmdb_id) continue;
    if (seenTmdb.has(t.tmdb_id)) continue;
    if (kidBlocked({ us_cert: t.us_cert || s.us_cert })) continue;
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
    const candidates = tasteCandidatesFor(state, p, mode, excludeIds);
    if (!candidates.length) continue;
    const res = await ai.buildTasteProfile({
      profileName: p.nick || p.id,
      signal,
      disliked,
      candidates,
    });
    if (res) {
      entry.picks[mode] = res.picks;
      if (res.reasons && Object.keys(res.reasons).length) entry.reasons[mode] = res.reasons;
      summaries.push(res.summary);
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
        for (const s of ix.byId.values()) {
          if (blocked(s) || !langPass(s.name)) continue;
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
      for (const [, v] of streams) {
        if (v.accountKey !== accountKey || v.displaced) continue;
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
        out = { error: e.message };
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

  const cached = personCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < PERSON_CACHE_MS) {
    return res.json(cached.payload);
  }
  if (!TMDB_API_KEY) {
    return res.json({ name, person: null, items: { movie: [], series: [] } });
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
      return res.json(payload);
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
          poster: t?.poster_path ? `${TMDB_IMG_BASE}/w154${t.poster_path}` : null,
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
    personCache.set(cacheKey, { ts: Date.now(), payload });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
      poster: t?.poster_path ? `${TMDB_IMG_BASE}/w154${t.poster_path}` : null,
      year: s.year || (t?.year || null),
      rating: s.rating || (t?.rating || null),
      us_cert: s.us_cert || null,
      tmdb_id: s.tmdb_id || null,
      category_id: s.category_id,
      tags: s.tags || [],
      container: s.container || null,
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

// Client-safe projection of a job — omits internal fields (pausedReason
// is informative enough without exposing the raw killer/abort plumbing).
function projectDiskDownloadJob(j) {
  return {
    id: j.jobId, mode: j.mode, sourceId: j.id, status: j.status,
    title: j.mode === "movie" ? j.title : j.episodeTitle,
    seriesTitle: j.seriesTitle || null, season: j.season || null, episodeNum: j.episodeNum || null,
    bytesWritten: j.bytesWritten, error: j.error, createdAt: j.createdAt, finishedAt: j.finishedAt || null,
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
  res.json({ ok: true, jobIds: ids });
});

// Owner-only: poll job status for the "downloading…" badge on tiles/
// detail pages. Newest first, capped at 100 so a long download history
// doesn't grow the response unbounded.
app.get("/api/disk-download/jobs", (req, res) => {
  if (!requireOwner(req, res)) return;
  const jobs = [...diskDownloadJobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map(projectDiskDownloadJob);
  res.json({ jobs });
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
    await buildAllIndexes(actx);
    res.json({ ok: true, userId, host: actx.host });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/admin/backfill-tmdb-v2", (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  backfillTmdbCacheV2({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => res.end()).catch(e => {
    res.write(JSON.stringify({ phase: "fatal", error: e.message }) + "\n");
    res.end();
  });
});

// Streams progress over a single NDJSON response. Same heavy lifting
// as the nightly cron, just with live feedback to the caller.
app.post("/api/admin/retry-tmdb-no-matches", (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  retryTmdbNoMatches({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => res.end()).catch(e => {
    res.write(JSON.stringify({ phase: "fatal", error: e.message }) + "\n");
    res.end();
  });
});

// Rebuild the AI taste profiles ("For You" rail) on demand — for
// testing and for warming a fresh deploy without waiting for the
// 4:15 AM cron. Runs the exact same job.
app.post("/api/admin/rebuild-taste-profiles", async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const r = await rebuildTasteProfiles({ reason: "admin" });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
      poster: t?.poster_path ? `https://image.tmdb.org/t/p/w154${t.poster_path}` : null,
      us_cert: t?.us_cert || null,
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
    res.status(500).json({ ok: false, error: e.message });
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
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Rebuild the "Tonight" digest on demand (same as the nightly cron).
app.post("/api/admin/rebuild-tonight", async (req, res) => {
  if (!requireOwner(req, res)) return;
  try {
    const r = await rebuildTonight({ reason: "admin" });
    res.status(r.ok ? 200 : 409).json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Re-match cached TMDB entries whose year disagrees with the panel
// title's year (the "Blind (2023)" → "The Blind Side (2009)" class of
// wrong poster). Streams NDJSON progress.
app.post("/api/admin/revalidate-tmdb-years", (req, res) => {
  if (!TMDB_API_KEY) {
    return res.status(400).json({ ok: false, error: "no TMDB_API_KEY configured" });
  }
  res.set("Content-Type", "application/x-ndjson");
  res.set("Cache-Control", "no-store");
  revalidateTmdbYears({
    onProgress: (e) => res.write(JSON.stringify(e) + "\n"),
  }).then(() => res.end()).catch(e => {
    res.write(JSON.stringify({ phase: "fatal", error: e.message }) + "\n");
    res.end();
  });
});

const TRANSCODE_DIR = path.join(os.tmpdir(), "iptv-transcode");
fs.mkdirSync(TRANSCODE_DIR, { recursive: true });
const transcoders = new Map();

// When a VOD run using VAAPI dies with no output, retry it once in software.
const { vodSoftwareFallbackEligible, transcodeSourceUnavailable } = require("./lib/transcode-fallback");

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
    existing.lastSeen = Date.now();
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
    if (v.accountKey === accountKey && !v.displaced) sameAccount.push([k, v]);
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
  entry.lastSeen = Date.now();
  return true;
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

async function startOrTouchTranscoder(mode, id, quality, offsetSecs = 0, audio = "stereo", diskSel = null, audioTrack = 0) {
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
  if (existing && (existing.respawning || !existing.proc.killed)) {
    // respawning: an ffmpeg is being replaced under this same key — treat the
    // entry as live so a manifest poll mid-respawn doesn't race a second spawn
    // into the dir.
    existing.lastAccess = Date.now();
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
  const startPromise = spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, null, audioTrack);
  transcoderInflight.set(key, startPromise);
  startPromise.finally(() => transcoderInflight.delete(key));
  return startPromise;
}

// The actual spawn. Only ever runs once per key at a time, gated by the
// transcoderInflight single-flight map in startOrTouchTranscoder.
async function spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel = null, respawn = null, audioTrack = 0, swFallback = false) {
  audioTrack = normalizeAudioTrack(audioTrack);
  // Hardware encode for this run: the global VAAPI capability, unless this is
  // a software fallback retry (a prior VAAPI run was rejected by this source).
  const hw = HW_ENCODE && !swFallback;
  const dir = path.join(TRANSCODE_DIR, key);
  if (!respawn) {
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
  // Source container ext. Live is always HLS; VOD has to match the
  // actual file on the panel — mp4 hardcode was breaking ALL .mkv
  // titles (Bajirao Mastani 4K, etc.) with "Invalid data found when
  // processing input" because the panel returns 0 bytes for the
  // wrong-extension request. For movies the index is authoritative;
  // for series the index keys by series_id (not episode_id), so the
  // lookup misses and we fall back to mp4 — matches the equivalent
  // probe-fallback in /api/download for the same reason.
  let ext;
  if (mode === "live") {
    ext = "m3u8";
  } else if (mode === "movie") {
    ext = indexes.movie.byId.get(parseInt(id, 10))?.container || "mp4";
  } else if (MODES[mode].local) {
    ext = getIndexesFor(currentAccount()).disk?.byId?.get(parseInt(id, 10))?.container || "mp4";
  } else {
    ext = "mp4"; // series — see comment above
  }
  const sourceUrl = streamUrl(mode, id, ext); // panel URL, or absolute path for disk
  // Audio codec selection:
  //  - "stereo" (default): AAC 192/preset stereo. Max compatibility.
  //  - "surround": E-AC3 384k passthrough for AVR-connected Android TVs.
  const audioArgs = audio === "surround"
    ? ["-c:a", "eac3", "-b:a", "384k"]
    : ["-c:a", "aac", "-b:a", preset.copy ? "192k" : preset.aBitrate, "-ac", "2"];
  const args = [
    "-hide_banner", "-loglevel", "error",
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
    args.push(
      "-rw_timeout", "15000000",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
    );
    if (hw && !preset.copy) {
      args.push("-vaapi_device", VAAPI_DEVICE);
    }
    if (offsetSecs > 0 && mode !== "live") {
      args.push("-ss", String(offsetSecs));
    }
    args.push("-i", sourceUrl, "-map", "0:v:0", "-map", `0:a:${audioTrack}?`);
    if (preset.copy) {
      args.push("-c:v", "copy", ...audioArgs);
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
    // Live: tight 40-second sliding window. Old segments age out
    // because there's no concept of rewinding past the live edge,
    // and disk space matters more than seek-back range. On respawn,
    // append_list + a continued start_number extend the SAME playlist so
    // the player's media sequence keeps advancing (brief rebuffer, no reset).
    args.push(
      "-hls_list_size", "10",
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
    args.push(
      "-hls_list_size", "0",
      "-hls_flags", "independent_segments",
    );
  }
  args.push(path.join(dir, "index.m3u8"));
  const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderrBuf = "";
  ffmpeg.stderr.on("data", (b) => { stderrBuf = (stderrBuf + b.toString()).slice(-4000); });
  // Reuse the entry across respawns so lastAccess, restart history, and the
  // transcoders-map slot survive an ffmpeg replacement.
  const entry = respawn ? respawn.entry : {
    proc: ffmpeg, lastAccess: Date.now(), dir, sourceUrl, mode, id, quality,
    audio, preset, offsetSecs, diskSel, restarts: [], stopping: false, respawning: false,
    discontinuities: new Set(),
  };
  entry.proc = ffmpeg;
  entry.sourceUrl = sourceUrl;
  entry.startedAt = Date.now();
  entry.segAtSpawn = startNumber; // baseline: this run "produced" only if it exceeds this
  entry.respawning = false;
  entry.usedHardware = hw;        // whether THIS run used the VAAPI encoder
  if (swFallback) entry.swTried = true; // don't loop back to hardware after a fallback
  if (respawn && startNumber > 0) {
    // Mark the boundary so the manifest route emits #EXT-X-DISCONTINUITY before
    // this segment — the player resets its decoder timeline across the restart.
    entry.discontinuities.add(startNumber);
    for (const d of entry.discontinuities) if (d < startNumber - 30) entry.discontinuities.delete(d);
  }
  ffmpeg.on("exit", (code) => {
    const tail = stderrBuf.split("\n").filter(Boolean).slice(-3).join(" | ");
    const now = Date.now();
    entry.restarts = (entry.restarts || []).filter((ts) => now - ts < RESTART_WINDOW_MS);
    // Live transcoders self-heal: an unexpected exit (provider EOF / I/O error,
    // CDN-host rotation, or a watchdog SIGTERM of a wedged ffmpeg) respawns
    // against a freshly-built panel URL while a viewer is still connected.
    // Terminal cleanup on a deliberate stop, VOD, an abandoned stream, or a
    // flapping channel that's blown the restart cap.
    const recentViewer = now - entry.lastAccess < idleWindowMs();
    // Did THIS ffmpeg run emit a segment? If so, the channel is live — remember it
    // for the lifetime of this entry (survives respawns).
    const connectFail = liveSegStats(dir).nextNumber <= (entry.segAtSpawn || 0);
    if (!connectFail) { entry.everConnected = true; entry.slotRetries = 0; transcoderFailures.delete(key); }
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
      alreadyTriedSoftware: entry.swTried, producedSegment: !connectFail,
      viewerPresent: recentViewer, stopping: entry.stopping,
    })) {
      console.log(`[transcode ${key}] exit ${code} — VAAPI produced no output; retrying in software (libx264)${tail ? ": " + tail : ""}`);
      transcoders.delete(key);
      fs.rmSync(dir, { recursive: true, force: true });
      spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, null, audioTrack, true)
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
    const canRespawn = !entry.stopping && mode === "live" && recentViewer
      && entry.restarts.length < MAX_RESTARTS
      && (!connectFail || slotHeldRetry);
    if (!canRespawn) {
      const note = (entry.stopping || mode !== "live") ? ""
        : !recentViewer ? " (viewer gone)"
        : (connectFail && !entry.everConnected) ? " (input unavailable — not respawning)"
        : connectFail ? " (slot never freed / channel went off-air — giving up)"
        : " (restart cap — channel unstable, giving up)";
      console.log(`[transcode ${key}] exit ${code}${note}${tail ? ": " + tail : ""}`);
      // Trip the circuit breaker when we give up on a source that never
      // connected (invalid/broken upstream), but not on a deliberate stop.
      // The next manifest retry for this key is then refused fast instead of
      // machine-gunning ffmpeg at a dead input.
      if (connectFail && !entry.everConnected && !entry.stopping) {
        transcoderFailures.set(key, Date.now());
      }
      transcoders.delete(key);
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }
    entry.restarts.push(now);
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
    const why = slotHeldRetry ? " (slot-held — waiting for the cap slot to free)" : "";
    console.log(`[transcode ${key}] exit ${code} — respawn #${entry.restarts.length} in ${backoff}ms (start_number=${nextStart})${why}${tail ? ": " + tail : ""}`);
    setTimeout(() => {
      if (transcoders.get(key) !== entry) return; // replaced/removed during backoff
      // Honor a stop OR a viewer who left during the (up to 12s) backoff — don't open a
      // fresh cap=1 panel connection for nobody. (issue #56 review)
      if (entry.stopping || Date.now() - entry.lastAccess > idleWindowMs()) {
        transcoders.delete(key); fs.rmSync(dir, { recursive: true, force: true }); return;
      }
      spawnTranscoder(mode, id, quality, offsetSecs, audio, preset, key, diskSel, { startNumber: nextStart, entry }, audioTrack)
        .catch((e) => {
          console.log(`[transcode ${key}] respawn failed: ${e?.message || e}`);
          transcoders.delete(key);
          fs.rmSync(dir, { recursive: true, force: true });
        });
    }, backoff);
  });
  if (!respawn) transcoders.set(key, entry);
  console.log(`[transcode ${key}] ${respawn ? "respawned" : "started"} → ${sourceUrl}`);
  return entry;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, t] of transcoders) {
    if (now - t.lastAccess > idleWindowMs()) {
      stopTranscoder(t, "idle");
    }
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

// Kills the transcoder for a specific (mode, id), or all transcoders
// when neither is given. Called by the client immediately before
// switching streams so that the previous ffmpeg process — which would
// otherwise hold an upstream panel connection until the idle grace
// elapses — does not collide with the new stream against the panel's
// max_connections=1 limit.
app.post("/api/transcode/stop", express.json(), (req, res) => {
  const { mode, id } = req.body || {};
  let killed = 0;
  if (mode && id) {
    // Prefix-match so a quality switch (which spawns a new transcoder
    // under a different key) and the kill-prev call from the client
    // both clean up *any* transcoder for this id, not just one
    // quality variant.
    const prefix = `${mode}-${id}-`;
    for (const [k, t] of transcoders) {
      if (k.startsWith(prefix)) { stopTranscoder(t, "client-stop"); killed++; }
    }
  } else {
    for (const t of transcoders.values()) { stopTranscoder(t, "client-stop-all"); killed++; }
  }
  res.json({ ok: true, killed });
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
  const transcodeSigInput = offsetSecs > 0
    ? `transcode:${req.params.mode}:${req.params.id}:${offsetSecs}`
    : `transcode:${req.params.mode}:${req.params.id}`;
  const transcodeSig = crypto.createHmac("sha256", PROXY_SECRET)
    .update(transcodeSigInput).digest("hex").slice(0, 16);
  const transcodeQuery =
    `s=${transcodeSig}` +
    (offsetSecs > 0 ? `&t=${offsetSecs}` : "") +
    (audio === "surround" ? `&a=surround` : "");
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
  if (req.params.mode === "live" && req.params.ext === "m3u8") {
    const key = `${req.params.mode}:${req.params.id}`;
    let verdict = audioCodecCache[key];
    if (!isProbeFresh(verdict)) {
      try {
        const probed = await Promise.race([
          probeChannelAudioCodec(req.params.mode, req.params.id),
          new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
        ]);
        if (probed) verdict = probed;
      } catch {}
    }
    if (verdict && verdict.audio_codec && !verdict.browser_safe) {
      forceTranscode = true;
      forceReason = `audio:${verdict.audio_codec}`;
    }
  }
  const primaryUrl = forceTranscode ? transcodeUrl : direct;
  res.json({
    direct,
    proxy: signProxyUrl(direct),
    transcode: transcodeUrl,
    download: `/api/download/${req.params.mode}/${req.params.id}.mp4?s=${downloadSig}`,
    url: primaryUrl,
    transcodeAnchorSecs: offsetSecs,
    forceTranscode,
    forceReason,
  });
});

// Audio-track list for a panel VOD (movie/series). The client calls this
// after playback starts; if >1 audio track it shows a picker, and
// selecting a non-default track forces the transcoder with ?at=<index>.
// Network ffprobe (cached) — kept OUT of /api/stream so it never adds
// latency to the play path. ext is explicit (the client has it from the
// stream URL) so the panel URL is built correctly.
app.get("/api/tracks/:mode(movie|series)/:id.:ext", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const probed = await Promise.race([
      probePanelTracks(req.params.mode, req.params.id, req.params.ext),
      new Promise((r) => setTimeout(() => r(null), 10000)),
    ]);
    res.json({ audioTracks: (probed && probed.audioTracks) || [] });
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
  const actx = getOwnerAccount();
  const picked = await pickPanel(actx);
  cache.clear();
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
  buildAllIndexes(actx);
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
      account_hash: crypto.createHash("sha1").update(v.accountKey || "").digest("hex").slice(0, 10),
      mode: v.mode, id: v.id,
      since_ms: Date.now() - v.since,
      last_seen_ms: Date.now() - v.lastSeen,
      displaced: v.displaced,
    });
  }
  res.json({
    cap_per_account: MAX_CONCURRENT_STREAMS,
    active: list.length,
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
  res.status(500).json({ error: err.message });
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

  await pickPanel(actx);
  console.log(`  active:     ${actx.host}`);

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
    if (Date.now() - epgIndexBuiltAt > EPG_XMLTV_STALE_MS) {
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
});
