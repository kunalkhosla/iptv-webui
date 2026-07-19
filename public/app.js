"use strict";

const PSEUDO = { RECENTS: "__recents", FAVS: "__favs", MY_LIST: "__mylist", ALL: "__all" };
// "disk" is the local media library (superadmin-only). It rides every
// per-mode structure; the Disk nav tab is only revealed when bootstrap
// reports disk.enabled for this account.
const MODES = ["live", "movie", "series", "disk"];
const byMode = (fn) => Object.fromEntries(MODES.map((m) => [m, fn(m)]));

function emptyModeState() {
  return {
    categories: [],
    streams: [],
    byCat: new Map(),
    catPaging: new Map(), // catId -> { offset, total, hasMore, loading }
    activeCatId: PSEUDO.RECENTS,
    indexReady: false,
  };
}

const state = {
  mode: "live",
  query: "",
  diskEnabled: false,
  modes: byMode(emptyModeState),
  favorites: byMode(() => new Set()),
  // "My List" = Netflix-style watch-later. Distinct from favorites so
  // "I want to watch this later" and "I love this and rewatch it" stay
  // separate. Same per-mode Set shape as favorites.
  myList:    byMode(() => new Set()),
  // Explicit taste feedback (tile thumbs + the Refine screen). Two
  // per-mode Set groups; up/down are mutually exclusive per id. Mirrors
  // favorites; pushed to the server via pushUserState (userState.feedback).
  feedback:  { up: byMode(() => new Set()), down: byMode(() => new Set()) },
  recents:   byMode(() => []),
  // Server-side last-played map by mode → { id: timestamp_ms }. Hydrated
  // from /api/bootstrap so it's shared across browsers and survives a
  // localStorage wipe. Updated locally on play() for instant UI feedback.
  lastPlayed: byMode(() => ({})),
  sort: byMode(() => ({ f: "name", dir: "asc" })),
  playing: null,
  hls: null,
  castSession: null,
  // Server-built home rails cached per mode. Populated by the
  // fetchHomeRails() call on mode change. The web client used to
  // build rails purely client-side from the panel-category map,
  // which meant TMDB-derived smart rails (Action / Comedy / Of the
  // 90s etc.) never made it on screen. Now we read them straight
  // from /api/home — same source the phone + TV apps consume.
  home: byMode(() => null),
  homeFetching: byMode(() => false),
  // Single-language collection (the "Hindi" tab) — /api/collection rails
  // cached per sub-mode (movie/series). Same rail/tile shape as home so
  // it renders through renderRail. collectionMode tracks the active
  // movie/series sub-toggle within the view.
  collection: { movie: null, series: null },
  collectionFetching: { movie: false, series: false },
  collectionMode: "movie",
  collectionLang: "hindi",
  // Per-channel probe verdicts populated by /api/probe-channels.
  // Shape: { id: { audio_codec, browser_safe, dead, dead_reason, ts } }.
  // Drives the inline "off-air" marker in the TV Guide so users can
  // see which channels are dead before clicking. Refreshed as rows
  // scroll into view (IntersectionObserver in setupGuideObserver).
  channelProbes: {},
};

state.lastEpisode = {};
state.watched = new Set();
// progress[`${mode}:${id}`] = { p, d, t } — movies and series episodes only.
// Hydrated from /api/bootstrap so resume works on any device.
state.progress = {};
// Catalog filter — server-synced, hydrated in bootstrap.
// groups[mode] is a Set of selected groupKeys.
state.filter = {
  onboarded: false,
  groups: byMode(() => new Set()),
};
// Session-only override that bypasses the filter for the current view.
state.showAll = false;
// Active profile's kid age — derived from `kidsBirthYear` at bootstrap
// so the rating bucket advances on its own each year (a 7-year-old
// today is automatically treated as 9 in two years without anyone
// touching settings). When set, the rails / hero / grid filter movies
// and series with US certifications above the age threshold AND items
// where TMDB has no rating (safer default — kids see only what we
// can verify).
state.kidsAge = null;
// Server-supplied chip catalog + kids-cert tiers. Set from
// /api/bootstrap.filterConfig. When null (old server), the client
// falls back to the hardcoded GROUPS array and allowedCertsForAge
// table further down. When set, the server is authoritative — adding
// a new language/region/genre or shifting a kids cert threshold is a
// server-only change.
state.filterConfig = null;
// Derived lookup: key → { label, kind }. Rebuilt whenever
// filterConfig is set. Used by chip rendering + detectGroups for
// label lookups so new server-side keys flow through without an
// app update.
state.filterGroupIndex = new Map();
// TV-Guide forward window in hours. Hydrated from userState
// (server-side); settable from Settings → "TV Guide window". 1h-back
// lookback is fixed server-side.
state.epgWindowHoursForward = 3;
// Account snapshot (user_info / server_info) from /api/bootstrap.
// Used to surface exp_date as a "panel expires in N days" hint.
state.account = null;
// Video quality preference: "auto" (panel-direct, transcode only on
// codec error) or "low" / "med" / "high" (force transcode at that
// preset). Persisted in localStorage so it survives reloads.
state.quality = (() => {
  try {
    const v = localStorage.getItem("quality");
    // "source" used to be in the picker but its semantics ("force the
    // transcoder at source bitrate") confused users — Auto already
    // plays the panel's bytes directly when codecs are friendly.
    // Existing localStorage values are quietly normalized to "auto".
    if (v === "source") return "auto";
    return ["auto", "low", "med", "high"].includes(v) ? v : "auto";
  } catch { return "auto"; }
})();
// EPG cache — programs[i] = { title, description, start_ts, stop_ts }.
// Lazy-filled by the TV Guide as channel rows scroll into view; entries
// older than EPG_TTL_MS are refetched.
state.epg = {};
// Channels whose EPG fetch returned zero programs even though the panel
// claimed they had EPG. Used to migrate them into the "Without" tab on
// the next renderGuide call so the "With" tab stays honest.
state.epgEmpty = new Set();
// The on-screen channel remote (Ch ↑/↓, recents, number entry) is
// useful on Android TV and on big-screen mouse usage, but most users
// on a desktop / laptop want it out of the way. Default to off; the
// "Show channel remote" toggle in ⚙ Settings flips this and persists
// via userState so the choice syncs across devices.
state.remoteEnabled = (() => {
  try { return localStorage.getItem("remoteEnabled") === "1"; } catch { return false; }
})();
const EPG_TTL_MS = 30 * 60 * 1000;
(function loadPersisted() {
  for (const m of MODES) {
    try {
      const f = JSON.parse(localStorage.getItem(`favs:${m}`) || "[]");
      state.favorites[m] = new Set(f);
    } catch {}
    try {
      const f = JSON.parse(localStorage.getItem(`myList:${m}`) || "[]");
      state.myList[m] = new Set(f);
    } catch {}
    try {
      state.recents[m] = JSON.parse(localStorage.getItem(`recents:${m}`) || "[]");
    } catch {}
    try {
      const s = JSON.parse(localStorage.getItem(`sort:${m}`) || "null");
      if (s && typeof s.f === "string" && (s.dir === "asc" || s.dir === "desc")) state.sort[m] = s;
    } catch {}
  }
  try { state.lastEpisode = JSON.parse(localStorage.getItem("lastEpisode") || "{}"); } catch {}
  try { state.watched = new Set(JSON.parse(localStorage.getItem("watched") || "[]")); } catch {}
})();

const HIDDEN_FROM_RECENTS = /adult|xxx|porn|\bnsfw\b/i;
function isHiddenFromRecents(mode, item) {
  if (!item) return false;
  const cat = state.modes[mode].categories.find(c => String(c.category_id) === String(item.category_id));
  if (!cat) return false;
  return HIDDEN_FROM_RECENTS.test(cat.category_name);
}

function rememberEpisode(seriesId, ep, season, seriesName) {
  state.lastEpisode[seriesId] = {
    episode_id: ep.id,
    season,
    episode_num: ep.episode_num,
    title: ep.title || `Episode ${ep.episode_num}`,
    container: ep.container_extension || "mp4",
    series_name: seriesName,
    when: Date.now(),
  };
  localStorage.setItem("lastEpisode", JSON.stringify(state.lastEpisode));
  state.watched.add(String(ep.id));
  localStorage.setItem("watched", JSON.stringify([...state.watched]));
  pushUserState();
}

const el = {
  search: document.getElementById("search"),
  searchClear: document.getElementById("search-clear"),
  home: document.getElementById("home"),
  hero: document.getElementById("hero"),
  rails: document.getElementById("rails"),
  guide: document.getElementById("guide"),
  guideTabs: document.getElementById("guide-tabs"),
  guideScroll: document.getElementById("guide-scroll"),
  guideTimes: document.getElementById("guide-times"),
  guideRows: document.getElementById("guide-rows"),
  guideMeta: document.getElementById("guide-meta"),
  guideTopBtn: document.getElementById("guide-top-btn"),
  liveRemote: document.getElementById("live-remote"),
  liveRemoteToggle: document.getElementById("live-remote-toggle"),
  gridView: document.getElementById("grid-view"),
  grid: document.getElementById("grid"),
  gridTitle: document.getElementById("grid-title"),
  gridBack: document.getElementById("grid-back"),
  searchAllView: document.getElementById("search-all-view"),
  searchAllResults: document.getElementById("search-all-results"),
  searchAllTitle: document.getElementById("search-all-title"),
  searchAllBack: document.getElementById("search-all-back"),
  player: document.getElementById("player"),
  video: document.getElementById("video"),
  spinner: document.getElementById("player-spinner"),
  playerUpnext: document.getElementById("player-upnext"),
  playerUpnextTitle: document.getElementById("player-upnext-title"),
  playerUpnextPlay: document.getElementById("player-upnext-play"),
  playerTitle: document.getElementById("player-title"),
  castHere: document.getElementById("cast-here"),
  playerClose: document.getElementById("player-close"),
  playerAlt: document.getElementById("player-alt"),
  playerCC: document.getElementById("player-cc"),
  playerTracks: document.getElementById("player-tracks"),
  playerTracksMenu: document.getElementById("player-tracks-menu"),
  playerFavorite: document.getElementById("player-favorite"),
  playerMylist: document.getElementById("player-mylist"),
  playerRemote: document.getElementById("player-remote"),
  playerQuality: document.getElementById("player-quality"),
  playerAudio: document.getElementById("player-audio"),
  playerTheater: document.getElementById("player-theater"),
  playerMini: document.getElementById("player-mini"),
  playerFullscreen: document.getElementById("player-fullscreen"),
  toast: document.getElementById("toast"),
  refresh: document.getElementById("refresh"),
  panelSwitch: document.getElementById("panel-switch"),
  conns: document.getElementById("conns"),
  gridCount: document.getElementById("grid-count"),
  sortField: document.getElementById("sort-field"),
  sortDir: document.getElementById("sort-dir"),
  errorBanner: document.getElementById("error-banner"),
  // Only real modes (live/movie/series/disk) carry data-mode; the Hindi
  // collection tab shares the .mode look but isn't a mode, so the
  // [data-mode] selector keeps it out of the setMode loop.
  modeButtons: document.querySelectorAll("#modes .mode[data-mode]"),
  hindiTab: document.getElementById("hindi-tab"),
  collectionView: document.getElementById("collection-view"),
  collectionRails: document.getElementById("collection-rails"),
  collectionMovieBtn: document.getElementById("collection-movie"),
  collectionSeriesBtn: document.getElementById("collection-series"),
  seriesPanel: document.getElementById("series-panel"),
  seriesTitle: document.getElementById("series-title"),
  seriesMeta: document.getElementById("series-meta"),
  seriesPlot: document.getElementById("series-plot"),
  seriesPlayBtn: document.getElementById("series-play-btn"),
  seriesMyListBtn: document.getElementById("series-mylist-btn"),
  seriesThumbUpBtn: document.getElementById("series-thumb-up-btn"),
  seriesThumbDownBtn: document.getElementById("series-thumb-down-btn"),
  seriesPosterMenuBtn: document.getElementById("series-poster-menu"),
  seriesPosterMenuDropdown: document.getElementById("series-poster-menu-dropdown"),
  seriesDiskBtnWrap: document.getElementById("series-disk-btn-wrap"),
  seriesDiskBtn: document.getElementById("series-disk-btn"),
  seriesDiskDropdown: document.getElementById("series-disk-menu-dropdown"),
  seriesTagline:     document.getElementById("series-tagline"),
  seriesTrailerBtn:  document.getElementById("series-trailer-btn"),
  seriesCreators:    document.getElementById("series-creators"),
  seriesCatRow:      document.getElementById("series-cat-row"),
  seriesGenres:      document.getElementById("series-genres"),
  seriesCast:        document.getElementById("series-cast"),
  seriesCastStrip:   document.getElementById("series-cast-strip"),
  seriesKeywords:    document.getElementById("series-keywords"),
  seriesSimilar:     document.getElementById("series-similar"),
  trailerModal:      document.getElementById("trailer-modal"),
  trailerIframe:     document.getElementById("trailer-iframe"),
  trailerClose:      document.getElementById("trailer-close"),
  seriesPoster: document.getElementById("series-poster"),
  seriesClose: document.getElementById("series-close"),
  seriesSeasonSelect: document.getElementById("series-season-select"),
  seriesEpisodes: document.getElementById("series-episodes"),
  scrim: document.getElementById("scrim"),
  settingsBtn: document.getElementById("settings-btn"),
  settingsMenu: document.getElementById("settings-menu"),
  profileChip: document.getElementById("profile-chip"),
  profilePopup: document.getElementById("profile-popup"),
  panelConfigModal: document.getElementById("panel-config-modal"),
  panelConfigForm: document.getElementById("panel-config-form"),
  panelConfigClose: document.getElementById("panel-config-close"),
  panelConfigTest: document.getElementById("panel-config-test"),
  panelConfigSave: document.getElementById("panel-config-save"),
  panelConfigStatus: document.getElementById("panel-config-status"),
  settingsRefreshHint: document.getElementById("settings-refresh-hint"),
  settingsPanelSection: document.getElementById("settings-panel-section"),
  settingsPanelList: document.getElementById("settings-panel-list"),
  showAllBtn: document.getElementById("show-all-btn"),
  filterModal: document.getElementById("filter-modal"),
  filterHeading: document.querySelector("#filter-modal h2"),
  filterTabs: document.querySelectorAll("#filter-modal .filter-tab"),
  filterBody: document.getElementById("filter-body"),
  filterClose: document.getElementById("filter-close"),
  filterClear: document.getElementById("filter-clear"),
  filterAll: document.getElementById("filter-all"),
  filterDone: document.getElementById("filter-done"),
  refineModal: document.getElementById("refine-modal"),
  refineBody: document.getElementById("refine-body"),
  refineTabs: document.querySelectorAll("#refine-modal .filter-tab"),
  refineClose: document.getElementById("refine-close"),
  refineCancel: document.getElementById("refine-cancel"),
  refineSave: document.getElementById("refine-save"),
};

function ms() { return state.modes[state.mode]; }

function showBannerError(html) {
  el.errorBanner.innerHTML = html;
  el.errorBanner.hidden = false;
}
function clearBannerError() { el.errorBanner.hidden = true; el.errorBanner.innerHTML = ""; }

function renderConnsChip(ui) {
  if (!el.conns) return;
  const max = ui && ui.max_connections != null ? Number(ui.max_connections) : null;
  const active = ui && ui.active_cons != null ? Number(ui.active_cons) : null;
  if (max == null || active == null || Number.isNaN(max) || Number.isNaN(active)) {
    el.conns.hidden = true;
    return;
  }
  el.conns.hidden = false;
  el.conns.textContent = `${active}/${max}`;
  el.conns.classList.toggle("conns-full", max > 0 && active >= max);
}

function checkAccount(account) {
  const ui = account?.user_info;
  renderConnsChip(ui);
  if (!ui) {
    showBannerError("<b>Provider unreachable.</b> No account info returned. Check <code>IPTV_HOST</code> on the VPS or try the panel switch.");
    return false;
  }
  // The panel returns a sparse {auth:0} object (no status, no exp_date,
  // no other fields) when its connection limit is saturated — *not* only
  // for bad credentials. Distinguish those two cases by whether anything
  // beyond `auth` is present in user_info.
  if (Number(ui.auth) !== 1) {
    const onlyAuth = Object.keys(ui).every(k => k === "auth");
    if (onlyAuth) {
      showBannerError("<b>Panel busy.</b> Likely your subscription's connection limit (<code>max_connections</code>) is saturated by another stream. Cached library is shown; close other streams or wait for a slot.");
    } else {
      showBannerError("<b>Authentication rejected.</b> The username or password is wrong. Check <code>IPTV_USER</code> and <code>IPTV_PASS</code> on the VPS.");
    }
    return false;
  }
  if (ui.exp_date && Number(ui.exp_date) * 1000 < Date.now()) {
    const date = new Date(Number(ui.exp_date) * 1000).toLocaleDateString();
    showBannerError(`<b>Subscription expired</b> on ${date}. Renew with your provider.`);
    return false;
  }
  if (ui.status && ui.status !== "Active") {
    showBannerError(`<b>Account status: ${escapeHtml(ui.status)}</b>. Subscription may be suspended.`);
    return false;
  }
  clearBannerError();
  return true;
}

let _panelInfo = null;
async function refreshPanelButton() {
  try {
    const r = await fetch("/api/panel");
    const p = await r.json();
    _panelInfo = p;
    if ((p.candidates || []).length < 2) {
      el.panelSwitch.hidden = true;
      return;
    }
    el.panelSwitch.hidden = false;
    const host = new URL(p.active).host;
    el.panelSwitch.textContent = host;
    el.panelSwitch.classList.toggle("fallback", !p.using_primary);
    el.panelSwitch.title = `Active: ${p.active}\nClick to choose a different panel host`;
  } catch {}
}

let _panelMenuEl = null;
function closePanelMenu() {
  if (_panelMenuEl) { _panelMenuEl.remove(); _panelMenuEl = null; }
}
function openPanelMenu() {
  if (!_panelInfo) return;
  closePanelMenu();
  const menu = document.createElement("div");
  menu.id = "panel-menu";
  menu.innerHTML = `<div class="header">Panel host</div>`;
  for (const host of _panelInfo.candidates) {
    const btn = document.createElement("button");
    const isActive = host === _panelInfo.active;
    const isPrimary = host === _panelInfo.primary;
    btn.classList.toggle("active", isActive);
    const hostLabel = (() => { try { return new URL(host).host; } catch { return host; } })();
    btn.innerHTML = `<span>${escapeHtml(hostLabel)}</span><span class="tag">${isPrimary ? "primary" : "fallback"}${isActive ? " · active" : ""}</span>`;
    btn.onclick = (e) => {
      e.stopPropagation();
      closePanelMenu();
      if (!isActive) switchToPanelHost(host);
    };
    menu.appendChild(btn);
  }
  el.panelSwitch.parentElement.appendChild(menu);
  _panelMenuEl = menu;
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (_panelMenuEl && !_panelMenuEl.contains(e.target) && e.target !== el.panelSwitch) {
        closePanelMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}

async function switchToPanelHost(host) {
  el.panelSwitch.disabled = true;
  toast(`Switching to ${(()=>{try{return new URL(host).host}catch{return host}})()}…`, 0);
  try {
    const r = await fetch(`/api/panel/switch?host=${encodeURIComponent(host)}`, { method: "POST" });
    const d = await r.json();
    if (d.reason === "ok") {
      toast(`Switched. Reloading library…`, 2500);
      for (const m of MODES) {
        state.modes[m].byCat = new Map();
        state.modes[m].catPaging = new Map();
        state.modes[m].streams = [];
        state.modes[m].indexReady = false;
      }
      const r2 = await fetch("/api/bootstrap");
      const d2 = await r2.json();
      checkAccount(d2.account);
      state.modes.live.categories   = Array.isArray(d2.categories.live)   ? d2.categories.live   : [];
      state.modes.movie.categories  = Array.isArray(d2.categories.movie)  ? d2.categories.movie  : [];
      state.modes.series.categories = Array.isArray(d2.categories.series) ? d2.categories.series : [];
      state.modes.disk.categories   = Array.isArray(d2.categories.disk)   ? d2.categories.disk   : [];
      refreshView();
      pollIndex();
    } else {
      toast(`Switch failed: ${d.reason}`, 4000);
    }
    refreshPanelButton();
  } catch (e) {
    toast(`Switch failed: ${e.message}`, 4000);
  } finally {
    el.panelSwitch.disabled = false;
  }
}

// Reveal the Disk tab + owner Settings controls based on the bootstrap
// `disk` block. `enabled` is true only for an account that actually has a
// local library (superadmin-only), so regular tenants never see the tab.
function applyDiskConfig(disk) {
  state.diskConfig = disk || { enabled: false, isOwner: false };
  state.diskEnabled = !!(disk && disk.enabled);
  const tab = document.getElementById("mode-disk");
  if (tab) tab.hidden = !state.diskEnabled;
  const ownerDisk = document.getElementById("settings-disk-section");
  if (ownerDisk) ownerDisk.hidden = !(disk && disk.isOwner);
  const hint = document.getElementById("settings-disk-hint");
  if (hint && disk) hint.textContent = disk.path ? `${disk.count || 0} titles` : "not set";
}

async function bootstrap() {
  try {
    const r = await fetch("/api/bootstrap");
    if (r.status >= 500) throw new Error(`Provider server error (HTTP ${r.status}). The IPTV panel may be down or unreachable.`);
    if (!r.ok) throw new Error(`Bootstrap ${r.status}`);
    const d = await r.json();
    checkAccount(d.account);
    state.account = d.account || null;
    // Active profile (post-PR-15). Used to surface the profile name in
    // Settings → Profile and to update the brand subtitle.
    state.activeProfile = d.profile || null;
    state.activeUser = d.user || null;
    state.kidsAge = deriveKidsAge(state.activeProfile);
    applyFilterConfig(d.filterConfig);
    syncProfileChip();
    // Toggle owner-only sections (Invite a friend, etc.) in Settings.
    const ownerSection = document.getElementById("settings-owner-section");
    if (ownerSection) ownerSection.hidden = state.activeUser?.role !== "owner";
    state.modes.live.categories   = Array.isArray(d.categories.live)   ? d.categories.live   : [];
    state.modes.movie.categories  = Array.isArray(d.categories.movie)  ? d.categories.movie  : [];
    state.modes.series.categories = Array.isArray(d.categories.series) ? d.categories.series : [];
    state.modes.disk.categories   = Array.isArray(d.categories.disk)   ? d.categories.disk   : [];
    applyDiskConfig(d.disk);
    if (d.lastPlayed) {
      for (const m of MODES) {
        if (d.lastPlayed[m] && typeof d.lastPlayed[m] === "object") {
          state.lastPlayed[m] = d.lastPlayed[m];
        }
      }
    }
    // Server-side cross-device state. Server wins per-key when it has
    // data; when a key is empty server-side but local has items, keep
    // local and push it up to seed the server. Avoids wiping a device's
    // pre-sync localStorage favorites the first time it loads after the
    // sync feature shipped.
    //
    // Profile-switch guard: if the active profile changed since the
    // last bootstrap, the localStorage we hydrated from belongs to the
    // OLD profile. Disable the "keep-local-when-server-empty" branch
    // so we don't silently push the previous profile's favorites /
    // recents up to the new profile and corrupt it. profile-pick.html
    // also wipes localStorage on select; this is the second line of
    // defense for cookie / direct-nav cases.
    const lastBootstrappedProfile = localStorage.getItem("lastBootstrappedProfile");
    const currentProfileId = state.activeProfile?.id || null;
    const profileChanged = currentProfileId &&
      lastBootstrappedProfile &&
      lastBootstrappedProfile !== currentProfileId;
    if (profileChanged) {
      for (const m of MODES) {
        state.favorites[m] = new Set();
        state.myList[m] = new Set();
        state.recents[m] = [];
        localStorage.removeItem(`favs:${m}`);
        localStorage.removeItem(`myList:${m}`);
        localStorage.removeItem(`recents:${m}`);
      }
      state.lastEpisode = {};
      state.watched = new Set();
      localStorage.removeItem("lastEpisode");
      localStorage.removeItem("watched");
    }
    if (currentProfileId) {
      localStorage.setItem("lastBootstrappedProfile", currentProfileId);
    }
    let needsSeed = false;
    if (d.userState) {
      const u = d.userState;
      // IDs in the catalog (s.id) are numbers from the Xtream API. Coerce
      // any wire-format string IDs back to numbers so Set.has(s.id) works.
      const toNum = (x) => {
        const n = typeof x === "number" ? x : parseInt(x, 10);
        return Number.isFinite(n) ? n : x;
      };
      for (const m of MODES) {
        const fs = u.favorites && Array.isArray(u.favorites[m]) ? u.favorites[m] : null;
        if (fs && fs.length) {
          state.favorites[m] = new Set(fs.map(toNum));
          localStorage.setItem(`favs:${m}`, JSON.stringify([...state.favorites[m]]));
        } else if (state.favorites[m].size > 0) {
          needsSeed = true;
        }
        const ml = u.myList && Array.isArray(u.myList[m]) ? u.myList[m] : null;
        if (ml && ml.length) {
          state.myList[m] = new Set(ml.map(toNum));
          localStorage.setItem(`myList:${m}`, JSON.stringify([...state.myList[m]]));
        } else if (state.myList[m].size > 0) {
          needsSeed = true;
        }
        // Thumbs / Refine feedback — server is the sole source (no local
        // mirror), so just hydrate each render from bootstrap.
        const fu = u.feedback?.up && Array.isArray(u.feedback.up[m]) ? u.feedback.up[m] : null;
        state.feedback.up[m] = new Set((fu || []).map(toNum));
        const fd = u.feedback?.down && Array.isArray(u.feedback.down[m]) ? u.feedback.down[m] : null;
        state.feedback.down[m] = new Set((fd || []).map(toNum));
        const rs = u.recents && Array.isArray(u.recents[m]) ? u.recents[m] : null;
        if (rs && rs.length) {
          state.recents[m] = rs.map(toNum);
          localStorage.setItem(`recents:${m}`, JSON.stringify(state.recents[m]));
        } else if (state.recents[m].length > 0) {
          needsSeed = true;
        }
      }
      if (Array.isArray(u.watched) && u.watched.length) {
        // watched is keyed by episode ID for series; keep as strings (the existing
        // markWatched / has(String(ep.id)) convention uses strings throughout).
        state.watched = new Set(u.watched.map(String));
        localStorage.setItem("watched", JSON.stringify([...state.watched]));
      } else if (state.watched.size > 0) {
        needsSeed = true;
      }
      if (u.lastEpisode && typeof u.lastEpisode === "object" && Object.keys(u.lastEpisode).length) {
        state.lastEpisode = u.lastEpisode;
        localStorage.setItem("lastEpisode", JSON.stringify(state.lastEpisode));
      } else if (Object.keys(state.lastEpisode).length) {
        needsSeed = true;
      }
      if (u.progress && typeof u.progress === "object") {
        state.progress = u.progress;
      }
      if (u.filter && typeof u.filter === "object") {
        state.filter.onboarded = !!u.filter.onboarded;
        for (const m of MODES) {
          const arr = u.filter.groups && Array.isArray(u.filter.groups[m]) ? u.filter.groups[m] : [];
          state.filter.groups[m] = new Set(arr);
        }
      }
      if (typeof u.remoteEnabled === "boolean") {
        state.remoteEnabled = u.remoteEnabled;
        try { localStorage.setItem("remoteEnabled", u.remoteEnabled ? "1" : "0"); } catch {}
      }
      if (Number.isFinite(u.epgWindowHoursForward)) {
        state.epgWindowHoursForward = Math.min(Math.max(u.epgWindowHoursForward, 1), 24);
      }
    }
    if (needsSeed) pushUserState();
    setMode(state.mode, { skipPush: true, skipUrl: true });
    pollIndex();
    refreshPanelButton();
    refreshShowAllBtn();
    // First-run: open the filter modal once the categories are ready.
    // We poll until the active mode has categories, then show the picker.
    maybeOpenFirstRunFilter();
  } catch (e) {
    showBannerError(`<b>Cannot reach provider.</b> ${escapeHtml(e.message)}. Check <code>IPTV_HOST</code> on the VPS and that the panel is online.`);
  }
}

// Category browsing is paginated (CATEGORY_PAGE_SIZE per fetch) so opening
// a huge category doesn't block the server (one giant JSON.stringify) or
// the tab (thousands of DOM cards built in one synchronous pass). Further
// pages load as the user scrolls near the bottom of #grid — see
// setupGridPagingObserver(). For live, pollIndex()'s full-catalog
// background fetch still completes any category the user only partially
// scrolled (see the backfill fix in pollIndex below), so sort/search
// eventually see the full set exactly as before pagination existed.
// Movie/series/disk have no such backfill (pollIndex skips the full
// fetch for those modes) — a partially-scrolled category there stays
// partial until the user scrolls the rest of the way.
const CATEGORY_PAGE_SIZE = 200;

async function fetchCategoryPage(mode, catId, offset) {
  // PSEUDO.ALL has no real category_id — omitting it makes the server
  // return a paginated, filtered (including the onboarding category
  // allow-list — see server.js) slice across every category instead of
  // one. __all can't collide with a real category_id (always numeric).
  const catParam = catId === PSEUDO.ALL ? "" : `&category_id=${encodeURIComponent(catId)}`;
  // Sort server-side so paginated pages come back globally ordered (the
  // full VOD catalog is no longer resident to sort client-side). Only the
  // catalog-intrinsic fields are server-sortable; lastPlayed stays local.
  const cfg = state.sort[mode] || {};
  const serverSortable = ["name", "added", "rating", "year"].includes(cfg.f);
  const sortParam = serverSortable ? `&sort=${cfg.f}&dir=${cfg.dir || "asc"}` : "";
  const r = await fetch(`/api/${mode}/streams?offset=${offset}&limit=${CATEGORY_PAGE_SIZE}${catParam}${sortParam}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json(); // { items, total, hasMore }
}

// Single-item lookup (~200B, served from the server's in-memory index)
// and a small-concurrency batch wrapper for resolving a bounded id set
// (recents/favorites/my-list/deep-links) without needing the full
// per-mode catalog resident client-side.
async function fetchSingleItem(mode, id) {
  try {
    const r = await fetch(`/api/${mode}/item/${id}`);
    if (!r.ok) return null; // 404 removed-from-panel, 503 index still building
    return await r.json();
  } catch { return null; }
}

async function resolveIdsToItems(mode, ids) {
  const uniq = [...new Set(ids)];
  const CONCURRENCY = 8;
  const out = [];
  for (let i = 0; i < uniq.length; i += CONCURRENCY) {
    const batch = uniq.slice(i, i + CONCURRENCY);
    out.push(...(await Promise.all(batch.map(id => fetchSingleItem(mode, id)))).filter(Boolean));
  }
  return out;
}

async function loadCategoryStreams(mode, catId) {
  const m = state.modes[mode];
  const key = String(catId);
  // catPaging is only set after a successful page-0 fetch, so it (not
  // list length) is the "already loaded" marker — otherwise a genuinely
  // empty category re-fetches on every visit.
  if (m.byCat.has(key) && m.catPaging.has(key)) return m.byCat.get(key);
  const d = await fetchCategoryPage(mode, catId, 0);
  m.byCat.set(key, d.items);
  m.catPaging.set(key, { offset: d.items.length, total: d.total, hasMore: d.hasMore, loading: false });
  return d.items;
}

// Scroll-triggered continuation of loadCategoryStreams. Guarded by
// `loading` (no in-flight dedup infra like AbortController exists in this
// file, but the IntersectionObserver only fires once per intersection and
// this flag is enough to prevent a double-trigger). Re-reads catPaging
// after the await because pollIndex's background full-index fetch can
// complete this same category while this request is in flight — if so,
// this page is discarded rather than appended, to avoid duplicating items.
async function loadNextCategoryPage(mode, catId) {
  const m = state.modes[mode];
  const key = String(catId);
  const paging = m.catPaging.get(key);
  if (!paging || !paging.hasMore || paging.loading) return false;
  paging.loading = true;
  let d;
  try {
    d = await fetchCategoryPage(mode, catId, paging.offset);
  } catch (e) {
    paging.loading = false;
    throw e;
  }
  const currentPaging = m.catPaging.get(key);
  if (!currentPaging || currentPaging.hasMore === false) return false;
  const existing = m.byCat.get(key) || [];
  m.byCat.set(key, existing.concat(d.items));
  currentPaging.offset = paging.offset + d.items.length;
  currentPaging.total = d.total;
  currentPaging.hasMore = d.hasMore;
  currentPaging.loading = false;
  return d.items.length > 0;
}

async function pollIndex() {
  while (true) {
    try {
      const r = await fetch("/api/index/status");
      const s = await r.json();
      let pending = false;
      for (const mode of MODES) {
        const ix = s[mode];
        // Disk is local + owner-only; skip it here unless this account has
        // a library (otherwise an empty disk index would poll forever).
        if (mode === "disk" && !state.diskEnabled) continue;
        if (ix.ready && !ix.total) { continue; } // ready + empty = done (e.g. disk)
        if (!ix.total) { pending = true; continue; }
        if (!ix.ready) {
          pending = true;
          if (mode === state.mode) {
            toast(`Indexing ${mode}… ${ix.done}/${ix.total}`, 0);
          }
        } else if (!state.modes[mode].indexReady) {
          if (mode === "live") {
            // Live keeps the full-catalog fetch — the channel zapper needs
            // the complete ORDERED list (channel up/down), and the Guide's
            // with/without-EPG tab totals need the complete set. Neither
            // is satisfiable by an on-demand/paginated fetch.
            //
            // BUT defer it until the user is actually on Live: this used
            // to fire unconditionally in the background on every session,
            // regardless of active tab — downloading + JSON-parsing ~20MB
            // and building a byCat Map across thousands of channels while
            // the user was just browsing Movies. On memory-constrained
            // mobile browsers that background spike was enough to crash
            // the tab. Leave indexReady false and keep polling (cheap —
            // just the /api/index/status check above) until state.mode
            // becomes "live"; the next tick then does the real fetch.
            if (state.mode !== "live") { pending = true; continue; }
            const r2 = await fetch(`/api/index/${mode}`);
            const d = await r2.json();
            state.modes[mode].streams = d.streams;
            const groups = new Map();
            for (const x of d.streams) {
              const k = String(x.category_id);
              if (!groups.has(k)) groups.set(k, []);
              groups.get(k).push(x);
            }
            for (const [k, list] of groups) {
              const existing = state.modes[mode].byCat.get(k);
              const paging = state.modes[mode].catPaging.get(k);
              // A category the user opened but only partially scrolled has
              // some data (existing.length is truthy) but isn't complete —
              // the plain !existing.length check below would wrongly skip
              // it forever. Let this full backfill complete it, and mark
              // paging done so any in-flight loadNextCategoryPage() for the
              // same category discards its page instead of duplicating items.
              const partiallyLoaded = !!(paging && paging.hasMore);
              if (!existing || !existing.length || partiallyLoaded) {
                state.modes[mode].byCat.set(k, list);
                if (paging) {
                  state.modes[mode].catPaging.set(k, { offset: list.length, total: list.length, hasMore: false, loading: false });
                }
              }
            }
            state.modes[mode].indexReady = true;
            if (mode === state.mode) {
              refreshView();
              toast(`${cap(mode)} search ready — ${d.streams.length.toLocaleString()} items`, 2200);
            }
          } else {
            // Movie/series/disk: no consumer needs the full resident array
            // (hero/rails come from /api/home, categories load on demand,
            // recents/favorites/my-list/deep-links resolve per-id via
            // /api/{mode}/item/{id}, "All" paginates via /api/{mode}/streams
            // with no category_id) — so skip the multi-MB download entirely.
            // ix.total is already known from this same status poll.
            state.modes[mode].indexReady = true;
            if (mode === state.mode) toast(`${cap(mode)} ready — ${ix.total.toLocaleString()} items`, 2200);
          }
        }
      }
      if (!pending) return;
    } catch {}
    await new Promise(r => setTimeout(r, 2500));
  }
}

// --- Catalog filter (regions / languages) -----------------------------
// A curated list of buckets. Each category can match multiple buckets
// (e.g. "INDIA HINDI MOVIES" → India + Hindi), so picking either bucket
// will surface it. Categories that match nothing land in "Other".
//
// Patterns use \b word boundaries so e.g. /\bus\b/ doesn't match "music".
// Order in this array is the display order in the picker.
const GROUPS = [
  // --- Languages ---
  { key: "english", label: "English", patterns: [
    /\benglish\b/i, /\bblockbuster\b/i, /\boscar\b/i,
  ]},
  { key: "hindi", label: "Hindi", patterns: [
    /\bhindi\b/i, /bollywood/i,
    /\bstar plus\b/i, /\bstar bharat\b/i, /\bzee tv\b/i, /\bcolors hindi\b/i,
    /\bsony \(set\)\b/i, /\bsab\b/i, /\band tv\b/i, /\bmtv hindi\b/i, /\bepic tv\b/i,
    /\bsony liv\b/i, /\bdisney.*hotstar\b/i, /\bzee5\b/i, /\bjio cinema\b/i,
    /\bvoot\b/i, /\bmx player\b/i, /\bhungama play\b/i,
    /\btvf\b/i, /\bullu\b/i, /\beros now\b/i, /\bjio\b/i,
    /\baandetv\b/i, /\bbigg boss\b/i, /shemaroo/i, /\bhangama\b/i,
    /\baddatimes\b/i, /\bgreen tv\b/i, /\bsony aath\b/i, /amazon mini\b/i,
    /\bwaves ott\b/i, /\bsaregama\b/i, /lionsgate play/i, /\bsony \(set\)\b/i,
    /\bgemplex\b/i, /\bnews nation\b/i,
  ]},
  { key: "punjabi", label: "Punjabi", patterns: [
    /punjabi/i,
  ]},
  { key: "tamil", label: "Tamil", patterns: [
    /\btamil\b/i, /\bstar vijay\b/i, /\bsun tamil\b/i, /\bzee tamil\b/i,
  ]},
  { key: "telugu", label: "Telugu", patterns: [
    /\btelugu\b/i, /\bgemini\b/i, /\bstar maa\b/i, /\bzee telugu\b/i, /\betv\b/i, /\baha\b/i,
  ]},
  { key: "malayalam", label: "Malayalam", patterns: [
    /malayalam/i, /asianet/i, /\bsurya\b/i,
  ]},
  { key: "kannada", label: "Kannada", patterns: [
    /kannada/i, /star suvarna/i,
  ]},
  { key: "marathi", label: "Marathi", patterns: [
    /marathi/i, /star pravah/i,
  ]},
  { key: "gujarati", label: "Gujarati", patterns: [
    /gujarati/i,
  ]},
  { key: "bengali", label: "Bengali", patterns: [
    /\bbangla\b/i, /bengali/i, /jalsha/i,
  ]},
  { key: "urdu", label: "Urdu", patterns: [
    /\burdu\b/i,
  ]},
  { key: "arabic", label: "Arabic", patterns: [
    /arabic/i, /\bbein\b/i, /\bmbc\b/i,
  ]},
  // --- Countries / regions ---
  { key: "us", label: "USA", patterns: [
    /\busa?\b/i, /america/i,
    /\bnfl\b/i, /\bmlb\b/i, /\bnba\b/i, /\bmls\b/i, /\bnhl\b/i,
    /netflix/i, /\bhbo\b/i, /amazon prime/i, /\bdisney\b/i, /starz/i, /\bhulu\b/i, /\bpeacock\b/i,
  ]},
  { key: "india", label: "India", patterns: [
    // India-explicit signals only. Indian-language buckets (Hindi, Tamil,
    // etc.) are *separate* picks — selecting India alone should not drag
    // in every regional-language category. Pick India + Hindi + Tamil if
    // you want all of those.
    /\bindia\b/i, /\bindian\b/i, /\bipl\b/i, /\bhub premier\b/i,
    // Cricket is genre, but in this catalog's audience it's overwhelmingly
    // an India / Pakistan interest, so tag it on both so neither picker
    // gets cricket-less defaults.
    /cricket/i,
  ]},
  { key: "pakistan", label: "Pakistan", patterns: [
    /pakistan/i, /\bptv\b/i, /\bary\b/i, /\bgeo\b/i, /\bhum tv\b/i,
    /\bexpress tv\b/i, /aplus/i, /\baan\b/i, /aur life/i, /play entertainment/i,
    /\bmun tv\b/i, /\btv one\b/i, /apna/i, /kashmir/i, /dunya/i, /\bsamaa\b/i,
    // Urdu is the de-facto Pakistan signal too.
    /\burdu\b/i,
    /cricket/i, /\bpsl\b/i,
  ]},
  { key: "uk", label: "UK", patterns: [
    /\buk\b/i, /\bbritish\b/i, /\bbbc\b/i, /sky uk/i,
  ]},
  { key: "canada", label: "Canada", patterns: [
    /canada/i, /canadian/i, /\bctv\b/i,
  ]},
  { key: "australia", label: "Australia", patterns: [
    /australia/i, /australian/i, /fox australia/i, /\bdstv\b/i,
  ]},
  // --- Genres (catch-all for categories with no country/language tag) ---
  { key: "sports", label: "Sports", patterns: [
    /\bsports?\b/i, /cricket/i, /football/i, /soccer/i, /tennis/i, /\bgolf\b/i,
    /rugby/i, /racing/i, /\bf1\b/i, /motogp/i, /\bnfl\b/i, /\bmlb\b/i, /\bnba\b/i,
    /\bmls\b/i, /\bnhl\b/i, /\bepl\b/i, /\bipl\b/i, /\bpsl\b/i,
    /world cup/i, /\bfifa\b/i, /\bufc\b/i, /boxing/i, /wrestling/i, /\bwwe\b/i,
  ]},
  { key: "kids", label: "Kids", patterns: [
    /\bkids\b/i, /cartoon/i, /\bcbeebies\b/i, /nickelodeon/i, /\bnick jr\b/i,
    /\bbaby\b/i, /\btoddler\b/i,
  ]},
  { key: "news", label: "News", patterns: [
    /\bnews\b/i,
  ]},
];
const GROUP_INDEX = new Map(GROUPS.map(g => [g.key, g]));
const OTHER_GROUP = { key: "other", label: "Other" };

// Server's filterConfig takes precedence when present. Builds an
// ordered list of {key,label,kind} from the server response and an
// index for O(1) label lookups. With this set, the client never has
// to ship a regex / label change to track a new server-side group
// key — onboarding picks it up on the next bootstrap.
function applyFilterConfig(cfg) {
  if (!cfg || !Array.isArray(cfg.groups) || !cfg.groups.length) {
    state.filterConfig = null;
    state.filterGroupIndex = new Map();
    return;
  }
  state.filterConfig = cfg;
  state.filterGroupIndex = new Map(cfg.groups.map(g => [g.key, g]));
}
// Ordered group list used by the filter modal / chip strip. Prefers
// server's catalog; falls back to the hardcoded GROUPS for older
// servers (and during the brief pre-bootstrap window).
function orderedGroups() {
  return state.filterConfig?.groups || GROUPS;
}
// Label lookup for a chip key. Server is authoritative.
function labelForGroupKey(key) {
  return state.filterGroupIndex.get(key)?.label
      || GROUP_INDEX.get(key)?.label
      || key;
}

function groupKeysOf(catName) {
  if (!catName) return [OTHER_GROUP.key];
  const s = String(catName);
  const out = [];
  for (const g of GROUPS) {
    if (g.patterns.some(re => re.test(s))) out.push(g.key);
  }
  return out.length ? out : [OTHER_GROUP.key];
}

function detectGroups(mode) {
  const counts = new Map();
  const streams = state.modes[mode].streams;
  // Tag-driven detection: walk the server-attached `tags` array on each
  // stream so the filter modal lists every bucket the server-side
  // tagger surfaces (including XX:-prefix-driven languages that the
  // client GROUPS regex would miss). Falls back to category-name regex
  // when the index hasn't landed yet — first-run onboarding can open
  // before /api/index/{mode} resolves, and we still want a usable list.
  // Server's group catalog is authoritative when present — the set of
  // valid keys, their labels, and their ordering all come from it. The
  // hardcoded GROUPS array is only consulted when the server didn't
  // send filterConfig (talking to an old server).
  const catalog = orderedGroups();
  const validKey = new Set(catalog.map(g => g.key));
  if (Array.isArray(streams) && streams.length) {
    for (const s of streams) {
      const tags = Array.isArray(s.tags) ? s.tags : null;
      if (tags) {
        for (const t of tags) {
          if (validKey.has(t) || t === OTHER_GROUP.key) {
            counts.set(t, (counts.get(t) || 0) + 1);
          }
        }
      } else {
        const cat = state.modes[mode].categories.find(c => String(c.category_id) === String(s.category_id));
        for (const k of groupKeysOf(cat?.category_name || "")) {
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
  } else {
    for (const c of state.modes[mode].categories) {
      for (const k of groupKeysOf(c.category_name)) {
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  // Preserve catalog order; drop empties. Newer servers include
  // "other" in filterConfig.groups; older servers don't, so we tail-
  // append it only when the catalog lacks it AND the counts have it.
  const out = [];
  for (const g of catalog) {
    if (counts.has(g.key)) out.push({ key: g.key, label: g.label, count: counts.get(g.key) });
  }
  const hasOtherInCatalog = catalog.some(g => g.key === OTHER_GROUP.key);
  if (!hasOtherInCatalog && counts.has(OTHER_GROUP.key)) {
    out.push({ key: OTHER_GROUP.key, label: OTHER_GROUP.label, count: counts.get(OTHER_GROUP.key) });
  }
  return out;
}

function filterIsActive(mode) {
  if (state.showAll) return false;
  return state.filter.onboarded && state.filter.groups[mode].size > 0;
}

function categoryPasses(mode, category) {
  if (!filterIsActive(mode)) return true;
  const keys = groupKeysOf(category.category_name);
  const sel = state.filter.groups[mode];
  return keys.some(k => sel.has(k));
}

function filteredCategories(mode) {
  if (!filterIsActive(mode)) return state.modes[mode].categories;
  return state.modes[mode].categories.filter(c => categoryPasses(mode, c));
}

function setMode(mode, opts = {}) {
  state.mode = mode;
  if (!opts.keepQuery) { state.query = ""; el.search.value = ""; if (typeof syncSearchClearVisibility === "function") syncSearchClearVisibility(); }
  for (const b of el.modeButtons) b.classList.toggle("active", b.dataset.mode === mode);
  if (el.hindiTab) el.hindiTab.classList.remove("active"); // leaving the collection view
  el.search.placeholder = mode === "live" ? "Search channels…" : mode === "movie" ? "Search movies…" : "Search series…";
  if (!ms().activeCatId) ms().activeCatId = PSEUDO.RECENTS;
  if (!opts.skipSelect) {
    // Default landing for a mode is the home view (rails). The grid view
    // only opens when the user explicitly drills into a category, opens
    // Recent/Favs/All from a rail header, or types a search query.
    showHome();
  }
  if (!opts.skipUrl) updateUrl({ push: !opts.skipPush });
}

function showHome() {
  state.view = "home";
  ms().activeCatId = PSEUDO.RECENTS; // semantically "no category"
  el.home.hidden = false;
  el.gridView.hidden = true;
  el.searchAllView.hidden = true;
  if (el.collectionView) el.collectionView.hidden = true;
  if (state.playing && el.player.dataset.mode === "theater") setPlayerMode("mini");
  // Kick the server-built rail fetch as we land here. /api/home is
  // where the curated genre / decade / quality rails live (the panel
  // categories on their own are too noisy to give a Netflix-like
  // home). Fire-and-forget; renderRails re-runs once the fetch lands.
  fetchHomeRails(state.mode);
  renderHome();
}

async function fetchHomeRails(mode) {
  if (mode === "live") return; // live mode renders a TV guide, not rails
  if (state.homeFetching[mode]) return;
  if (state.home[mode]) return; // already cached this session
  state.homeFetching[mode] = true;
  // Retry with backoff: since the full VOD catalog is no longer resident,
  // the client-side fallback rails can't populate for movie/series/disk,
  // so a transient /api/home failure (deploy, cold index) would otherwise
  // leave a permanently blank home until the user re-navigates.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`/api/home/${mode}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.home[mode] = await r.json();
      break;
    } catch (e) {
      console.warn(`fetchHomeRails failed (attempt ${attempt}/3):`, e.message);
      state.home[mode] = null;
      if (attempt < 3) await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  }
  state.homeFetching[mode] = false;
  // If the user is still on the home view of this mode, re-render
  // so the new server-built rails replace whatever client-side
  // fallback was up. Also re-render the hero — it now reads
  // state.home[mode].hero directly and renders nothing until this
  // resolves (showHome() calls renderHero() synchronously beforehand,
  // before this fetch has landed).
  if (state.view === "home" && state.mode === mode) { renderHero(); renderRails(); }
}

function showGrid() {
  state.view = "grid";
  el.home.hidden = true;
  el.gridView.hidden = false;
  el.searchAllView.hidden = true;
  if (el.collectionView) el.collectionView.hidden = true;
  if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
  if (state.playing && el.player.dataset.mode === "theater") setPlayerMode("mini");
}

function showSearchAll() {
  state.view = "search-all";
  el.home.hidden = true;
  el.gridView.hidden = true;
  el.searchAllView.hidden = false;
  if (el.collectionView) el.collectionView.hidden = true;
  if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
  if (state.playing && el.player.dataset.mode === "theater") setPlayerMode("mini");
}

// ── Single-language collection view (the "Hindi" tab) ────────────────
// A dedicated browse surface backed by /api/collection/:lang/:mode. Not
// a real mode — it overlays the home/grid/search views. The movie/series
// sub-toggle swaps which collection payload renders. Reuses the home
// chip strip + renderRail so tiles play/open exactly like the home rails.
function enterCollection(subMode, opts = {}) {
  if (state.playing && el.player.dataset.mode === "theater") setPlayerMode("mini");
  state.view = "collection";
  if (subMode === "movie" || subMode === "series") state.collectionMode = subMode;
  if (!opts.keepQuery) { state.query = ""; el.search.value = ""; if (typeof syncSearchClearVisibility === "function") syncSearchClearVisibility(); }
  el.home.hidden = true;
  el.gridView.hidden = true;
  el.searchAllView.hidden = true;
  el.collectionView.hidden = false;
  // The Hindi tab isn't in modeButtons, so manage its active state here
  // and clear the real mode buttons (we've left the mode-based views).
  for (const b of el.modeButtons) b.classList.remove("active");
  if (el.hindiTab) el.hindiTab.classList.add("active");
  if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
  fetchCollection(state.collectionMode);
  renderCollection();
  if (!opts.skipUrl) updateUrl({ push: !opts.skipPush });
}

async function fetchCollection(subMode) {
  if (state.collectionFetching[subMode]) return;
  if (state.collection[subMode]) return; // cached this session
  state.collectionFetching[subMode] = true;
  try {
    const r = await fetch(`/api/collection/${state.collectionLang}/${subMode}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.collection[subMode] = await r.json();
  } catch (e) {
    console.warn("fetchCollection failed:", e.message);
    state.collection[subMode] = { rails: [] };
  } finally {
    state.collectionFetching[subMode] = false;
  }
  if (state.view === "collection" && state.collectionMode === subMode) renderCollection();
}

function renderCollection() {
  const subMode = state.collectionMode;
  if (el.collectionMovieBtn) el.collectionMovieBtn.classList.toggle("on", subMode === "movie");
  if (el.collectionSeriesBtn) el.collectionSeriesBtn.classList.toggle("on", subMode === "series");
  el.collectionRails.innerHTML = "";
  // Reuse the browse chip strip so the user can narrow the whole Hindi
  // view (e.g. + 4K) on top of the language. Same _browseQuickFilter
  // state as the movie/series home; the chip onclick calls
  // renderCollection() directly while this view is up.
  el.collectionRails.appendChild(renderBrowseChipStrip(subMode));
  const picks = _browseQuickFilter[subMode];
  const gate = (items) => {
    if (!picks || picks.size === 0) return items;
    return items.filter(s => Array.isArray(s.tags) && [...picks].every(k => s.tags.includes(k)));
  };
  const payload = state.collection[subMode];
  if (!payload) {
    el.collectionRails.insertAdjacentHTML("beforeend", `<div class="empty">Loading…</div>`);
    return;
  }
  let any = false;
  for (const r of (payload.rails || [])) {
    const items = gate(r.items || []);
    if (!items.length) continue;
    any = true;
    el.collectionRails.appendChild(renderRail({
      title: r.title,
      items,
      total: r.total ?? items.length,
      // Collection rails have no panel category to route to, so "See all"
      // opens an in-place poster grid of the rail's items (Back returns to
      // the rails). Mouse users can't horizontally scroll a long rail.
      onSeeAll: () => showCollectionGrid(r.title, items),
    }));
  }
  if (!any) el.collectionRails.insertAdjacentHTML("beforeend", `<div class="empty">Nothing here yet.</div>`);
}

// "See all" for a collection rail — replace the rails with a vertical
// poster grid of that rail's items, plus a Back button. Stays inside the
// collection view so the chip strip / sub-toggle context is preserved on
// Back. Reuses channelCard (cardMode is collection-aware) + .poster-grid.
function showCollectionGrid(title, items) {
  el.collectionRails.innerHTML = "";
  const head = document.createElement("div");
  head.className = "collection-seeall-head";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "collection-seeall-back";
  back.textContent = "‹ Back";
  back.onclick = () => renderCollection();
  const h = document.createElement("span");
  h.className = "collection-seeall-title";
  h.textContent = `${title} · ${items.length.toLocaleString()}`;
  head.append(back, h);
  const grid = document.createElement("div");
  grid.className = "poster-grid";
  for (const s of items) grid.appendChild(channelCard(s, { reason: title }));
  el.collectionRails.append(head, grid);
  el.collectionView.scrollTop = 0;
}

// Re-render whatever view is currently visible. Use this whenever
// underlying state changes (favorites/recents toggle, filter saved,
// indexer finished a mode) so we don't have to know which view is up.
function refreshView() {
  if (state.view === "collection") {
    renderCollection();
  } else if (state.view === "grid") {
    el.gridTitle.textContent = gridTitleFor(ms().activeCatId);
    el.grid.classList.toggle("poster", state.mode !== "live");
    renderGrid();
  } else {
    renderHome();
  }
}

async function selectCategory(id, opts = {}) {
  ms().activeCatId = id;
  state.query = "";
  el.search.value = "";
  if (typeof syncSearchClearVisibility === "function") syncSearchClearVisibility();
  showGrid();
  if (id === PSEUDO.RECENTS || id === PSEUDO.FAVS || id === PSEUDO.MY_LIST) {
    // Membership is user-mutable (a favorite/my-list toggle, a new play
    // pushing to recents) — unlike a real category, refetch every visit
    // rather than caching forever in byCat.
    el.grid.innerHTML = `<div class="empty">Loading…</div>`;
    const ids = id === PSEUDO.RECENTS ? state.recents[state.mode]
              : id === PSEUDO.FAVS   ? [...state.favorites[state.mode]]
              :                        [...state.myList[state.mode]];
    try {
      let items = await resolveIdsToItems(state.mode, ids);
      if (id === PSEUDO.RECENTS) items = items.filter(s => !isHiddenFromRecents(state.mode, s));
      ms().byCat.set(String(id), items);
    } catch (e) { toast(`Load failed: ${e.message}`, 4000); }
  } else {
    // Real categories AND PSEUDO.ALL (fetchCategoryPage omits category_id
    // for the latter) both go through the same paginated loader.
    const list = ms().byCat.get(String(id));
    if (!list || !list.length) {
      el.grid.innerHTML = `<div class="empty">Loading…</div>`;
      try { await loadCategoryStreams(state.mode, id); } catch (e) { toast(`Load failed: ${e.message}`, 4000); }
    }
  }
  el.gridTitle.textContent = gridTitleFor(id);
  el.grid.classList.toggle("poster", state.mode !== "live");
  renderGrid();
  el.grid.scrollTop = 0;
  if (!opts.skipUrl) updateUrl({ push: !opts.skipPush });
}

function gridTitleFor(id) {
  if (id === PSEUDO.RECENTS) return "Recent";
  if (id === PSEUDO.FAVS) return "Favorites";
  if (id === PSEUDO.MY_LIST) return "Watch Later";
  if (id === PSEUDO.ALL) {
    return state.mode === "live" ? "All channels" : state.mode === "movie" ? "All movies" : "All series";
  }
  // Server-emitted rail pseudo ids — look up the rail's title from the
  // cached /api/home response.
  if (id && String(id).startsWith("__rail-") && state.home[state.mode]) {
    const rail = (state.home[state.mode].rails || [])
      .find(r => r.category_id === id);
    if (rail) return rail.title;
  }
  const cat = ms().categories.find(c => String(c.category_id) === String(id));
  return cat ? cat.category_name : "";
}

// --- Home view: hero + horizontal rails ------------------------------
function renderHome() {
  // Live mode gets a TV-guide-style grid instead of rails; movies and
  // series get the hero + rails layout.
  if (state.mode === "live") {
    el.hero.hidden = true;
    el.rails.hidden = true;
    el.guide.hidden = false;
    renderGuide();
  } else {
    el.guide.hidden = true;
    el.rails.hidden = false;
    renderHero();
    renderRails();
  }
}

function continueWatchingItems(mode) {
  if (mode === "live") return [];
  const all = flatStreams();
  // #48 — merged Continue Watching = progress ∪ recents, ordered by
  // best-available recency (progress.t > state.lastPlayed[mode][id] > 0).
  // Replaces the old "Recently played" rail at the bottom; users
  // think "where was I last," not "did I save a position vs just
  // press play."
  const lpMode = (state.lastPlayed && state.lastPlayed[mode]) || {};
  if (mode === "movie") {
    const progressEntries = Object.entries(state.progress)
      .filter(([k]) => k.startsWith("movie:"))
      .map(([k, v]) => [parseInt(k.split(":", 2)[1], 10), v?.t || 0]);
    const recentsList = (state.recents?.movie || []).map((id) => [id, lpMode[String(id)] || 0]);
    const map = new Map();
    for (const [id, t] of [...progressEntries, ...recentsList]) {
      const prev = map.get(id) || 0;
      if (t > prev) map.set(id, t);
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([id]) => all.find((s) => s.id === id))
      .filter(Boolean);
  }
  // series: same union but at the series-id level. Progress is keyed
  // by episode id, so we read state.lastEpisode to map episode → series.
  const seriesIdToT = new Map();
  for (const [seriesId, ep] of Object.entries(state.lastEpisode || {})) {
    const prog = state.progress[`series:${ep?.episode_id}`];
    const t = (prog && prog.t) || ep?.when || 0;
    if (t) seriesIdToT.set(parseInt(seriesId, 10), t);
  }
  for (const id of state.recents?.series || []) {
    const t = lpMode[String(id)] || 0;
    if (t > (seriesIdToT.get(id) || 0)) seriesIdToT.set(id, t);
  }
  return [...seriesIdToT.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([id]) => all.find((s) => s.id === id))
    .filter(Boolean);
}

function recentItems(mode) {
  const all = flatStreams();
  return state.recents[mode]
    .map(id => all.find(s => s.id === id))
    .filter(Boolean)
    .filter(s => !isHiddenFromRecents(mode, s));
}

function favoriteItems(mode) {
  const set = state.favorites[mode];
  return flatStreams().filter(s => set.has(s.id));
}

function myListItems(mode) {
  const set = state.myList[mode];
  return flatStreams().filter(s => set.has(s.id));
}

function categoryItems(mode, catId, limit = 25) {
  const list = state.modes[mode].byCat.get(String(catId)) || [];
  if (mode === "live") return list.slice(0, limit);
  // Kid filtering is server-side now (makeKidsBlocker). The local
  // index already arrives pre-filtered for the active profile, so
  // we can just sort by "newest first" and slice.
  return [...list]
    .sort((a, b) => (Number(b.added) || 0) - (Number(a.added) || 0))
    .slice(0, limit);
}

// Hero rotation. Like Netflix: the "Featured" billboard cycles through
// a curated set of candidates every HERO_ROTATE_MS so the homepage
// feels alive instead of frozen. Continue-Watching items always come
// first so resume is one click away when the user lands.
const HERO_ROTATE_MS = 30_000;
let _heroTimer = null;
let _heroItems = [];
let _heroIdx = 0;

function renderHero() {
  // Tear down any previous rotation for the prior mode/state.
  if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = null; }
  el.hero.innerHTML = "";
  el.hero.hidden = true;
  if (state.mode === "live") return;

  // Hero pool comes straight from /api/home's server-computed `hero`
  // field (see the heroPool block in server.js) — deterministic per-day/
  // per-profile shuffle, excludes continue-watching + adult content,
  // kid-safe filtered, capped at 8. Previously rebuilt client-side from
  // byCat, which needed pollIndex()'s full-catalog backfill to have
  // breadth across every category; using the server's field removes that
  // dependency entirely. Renders nothing until fetchHomeRails() resolves
  // (see its completion callback, which re-calls renderHero()).
  const serverHero = state.home[state.mode]?.hero;
  _heroItems = Array.isArray(serverHero) ? serverHero : [];
  if (!_heroItems.length) return;
  _heroIdx = 0;

  // Render the hero shell once, then paintHero() swaps the inner
  // content on each rotation. Keeping the shell stable lets the user
  // start interacting (clicking the Play button) immediately even mid-
  // rotation.
  el.hero.hidden = false;
  el.hero.innerHTML = `
    <div class="hero-bg"></div>
    <div class="hero-fade"></div>
    <button type="button" class="hero-nav prev" aria-label="Previous featured">‹</button>
    <button type="button" class="hero-nav next" aria-label="Next featured">›</button>
    <div class="hero-body">
      <div class="hero-eyebrow"></div>
      <h1 class="hero-title"></h1>
      <div class="hero-meta"></div>
      <p class="hero-plot"></p>
      <div class="hero-actions">
        <button type="button" class="hero-play">Play</button>
        <button type="button" class="act-icon hero-thumb up" title="More like this" aria-label="More like this">👍</button>
        <button type="button" class="act-icon hero-thumb down" title="Not for me" aria-label="Not for me">👎</button>
      </div>
    </div>
    <div class="hero-dots"></div>`;
  paintHero(_heroItems[_heroIdx]);

  // Only rotate when there's actually more than one candidate. A
  // single-item rotation would just keep re-rendering the same hero
  // and burning TMDB lookups on a 30s tick for no visible change.
  if (_heroItems.length > 1) {
    _heroTimer = setInterval(advanceHero, HERO_ROTATE_MS);
  }
  renderHeroDots();
  attachHeroNavigation();
}

// Touch-swipe + arrow-button + keyboard navigation for the hero
// carousel. Each user-initiated jump also resets the auto-rotate
// timer so the just-picked slide gets a full HERO_ROTATE_MS window
// before advancing.
function attachHeroNavigation() {
  const prev = el.hero.querySelector(".hero-nav.prev");
  const next = el.hero.querySelector(".hero-nav.next");
  const jump = (delta) => {
    if (_heroItems.length <= 1) return;
    _heroIdx = (_heroIdx + delta + _heroItems.length) % _heroItems.length;
    paintHero(_heroItems[_heroIdx]);
    renderHeroDots();
    if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = setInterval(advanceHero, HERO_ROTATE_MS); }
  };
  prev?.addEventListener("click", () => jump(-1));
  next?.addEventListener("click", () => jump(1));
  // Touch swipe — horizontal threshold of 40px filters out
  // accidental vertical-scroll fingers that have a tiny lateral
  // component.
  let touchX = null;
  el.hero.addEventListener("touchstart", (e) => {
    touchX = e.touches[0]?.clientX ?? null;
  }, { passive: true });
  el.hero.addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
    touchX = null;
    if (Math.abs(dx) < 40) return;
    jump(dx < 0 ? 1 : -1);
  }, { passive: true });
  // Keyboard arrows when the hero region is in focus AND we're not
  // typing in a text input (search bar etc).
  el.hero.tabIndex = 0;
  el.hero.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea")) return;
    if (e.key === "ArrowLeft")  { e.preventDefault(); jump(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); jump(1); }
  });
}

function advanceHero() {
  if (!_heroItems.length) return;
  _heroIdx = (_heroIdx + 1) % _heroItems.length;
  paintHero(_heroItems[_heroIdx]);
  renderHeroDots();
}

function renderHeroDots() {
  const dots = el.hero.querySelector(".hero-dots");
  if (!dots) return;
  if (_heroItems.length <= 1) { dots.innerHTML = ""; return; }
  dots.innerHTML = _heroItems
    .map((_, i) => `<button type="button" class="hero-dot${i === _heroIdx ? " active" : ""}" data-i="${i}" aria-label="Featured ${i + 1}"></button>`)
    .join("");
  for (const d of dots.querySelectorAll(".hero-dot")) {
    d.onclick = () => {
      const i = Number(d.dataset.i);
      if (!Number.isFinite(i)) return;
      _heroIdx = i;
      paintHero(_heroItems[_heroIdx]);
      renderHeroDots();
      // Reset the rotation timer so the user gets a full HERO_ROTATE_MS
      // window on the slide they just picked.
      if (_heroTimer) { clearInterval(_heroTimer); _heroTimer = setInterval(advanceHero, HERO_ROTATE_MS); }
    };
  }
}

// Swap the hero's inner content for a given item. Panel artwork shows
// instantly; TMDB upgrade swaps in a real backdrop + better meta when
// the lookup resolves.
function paintHero(pick) {
  if (!pick || el.hero.hidden) return;
  const isResume = !!state.progress[`${state.mode}:${pick.id}`];
  const eyebrow = isResume
    ? "Continue watching"
    : (state.mode === "movie" ? "Featured movie" : "Featured series");
  const meta = [pick.year, pick.rating ? `★ ${Number(pick.rating).toFixed(1)}` : null]
    .filter(Boolean).join(" · ");

  el.hero.querySelector(".hero-eyebrow").textContent = eyebrow;
  el.hero.querySelector(".hero-title").textContent = pick.name;
  el.hero.querySelector(".hero-meta").textContent = meta;
  const plotEl = el.hero.querySelector(".hero-plot");
  plotEl.textContent = pick.plot || "";
  plotEl.hidden = !pick.plot;
  const playBtn = el.hero.querySelector(".hero-play");
  playBtn.textContent = isResume ? "Resume" : "Play";

  // Image swap (panel first, then TMDB upgrade if available).
  const bg = el.hero.querySelector(".hero-bg");
  if (bg) bg.style.backgroundImage = "";
  const setHeroBg = (url, forItemId) => {
    if (!url) return;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      // Guard against late-arriving images for items the user has
      // already rotated past — would otherwise flash the wrong art on
      // the new slide.
      if (_heroItems[_heroIdx] && _heroItems[_heroIdx].id !== forItemId) return;
      const bgNow = el.hero.querySelector(".hero-bg");
      if (bgNow) bgNow.style.backgroundImage = `url("${url}")`;
    };
    img.src = url;
  };
  if (pick.icon) setHeroBg(pick.icon, pick.id);
  posterFor(state.mode, pick.id).then((d) => {
    if (!d) return;
    if (_heroItems[_heroIdx] && _heroItems[_heroIdx].id !== pick.id) return; // rotated past
    if (d.backdrop) setHeroBg(d.backdrop, pick.id);
    else if (d.poster) setHeroBg(d.poster, pick.id);
    const newMetaBits = [
      d.year || pick.year,
      d.us_cert || null,
      (d.rating || pick.rating) ? `★ ${Number(d.rating || pick.rating).toFixed(1)}` : null,
      d.runtime ? `${d.runtime} min` : null,
    ].filter(Boolean).join(" · ");
    if (newMetaBits) el.hero.querySelector(".hero-meta").textContent = newMetaBits;
    if (d.plot && !pick.plot) {
      const p = el.hero.querySelector(".hero-plot");
      p.textContent = d.plot;
      p.hidden = false;
    }
  });

  playBtn.onclick = () => {
    if (state.mode === "series") openSeries(pick);
    else play(state.mode, pick);
  };

  // Thumbs — renderHero() only bails on live mode (movie/series/disk
  // all reach here), and state.mode is used directly rather than a
  // hardcoded mode, so no cardMode gate is needed here like
  // channelCard() has.
  const heroUp = el.hero.querySelector(".hero-thumb.up");
  const heroDown = el.hero.querySelector(".hero-thumb.down");
  const syncHeroThumbs = () => {
    heroUp.classList.toggle("on", state.feedback.up[state.mode].has(pick.id));
    heroDown.classList.toggle("on", state.feedback.down[state.mode].has(pick.id));
  };
  syncHeroThumbs();
  heroUp.onclick = (e) => { e.stopPropagation(); toggleFeedbackFromHero(state.mode, pick.id, "up"); syncHeroThumbs(); };
  heroDown.onclick = (e) => { e.stopPropagation(); toggleFeedbackFromHero(state.mode, pick.id, "down"); syncHeroThumbs(); };
}

function renderRails() {
  el.rails.innerHTML = "";
  const mode = state.mode;

  // Chip filter gate. Server attaches a `tags` array per stream; the
  // chip toggle is an O(1) Set lookup per item. AND across all picked
  // chips so "Hindi + 4K" narrows to Hindi-language 4K titles. Chip
  // filtering is the one purely-UI concern remaining client-side —
  // kid filtering and language guard are both server-side now.
  const picks = _browseQuickFilter[mode];
  // Thumbs-down = "not for me" → drop it from the home rails right away
  // (the discovery surface). Still findable via search / category browse
  // and gone from recommendations for good after the next taste rebuild.
  const disliked = state.feedback?.down?.[mode];
  const gate = (items) => {
    let out = items;
    if (disliked && disliked.size) out = out.filter(s => !disliked.has(s.id));
    if (!picks || picks.size === 0) return out;
    return out.filter(s => {
      const tags = s.tags;
      if (!Array.isArray(tags)) return false;
      for (const k of picks) if (!tags.includes(k)) return false;
      return true;
    });
  };
  // Render the chip strip first so D-pad / tab order lands on it
  // before the rails. Skipped on Live (the TV Guide has its own
  // chip strip).
  el.rails.appendChild(renderBrowseChipStrip(mode));

  // ── Server-built rails path ───────────────────────────────────────
  // When /api/home/{mode} has landed, render exactly what the server
  // sent: smart rails (Action / Comedy / Of the 90s / Hidden Gems)
  // followed by panel-category rails as a fallback. Bypasses the
  // legacy client-built fallback below entirely — that fallback is
  // only used for the brief window after a mode change when the home
  // payload hasn't returned yet.
  const serverHome = state.home[mode];
  if (serverHome && Array.isArray(serverHome.rails) && serverHome.rails.length) {
    for (const r of serverHome.rails) {
      const items = gate(r.items || []);
      if (!items.length) continue;
      el.rails.appendChild(renderRail({
        title: r.title,
        items,
        navId: r.category_id || null,
        total: r.total ?? items.length,
        blurb: r.blurb || null,
      }));
    }
    return;
  }

  const rails = [];

  // "Recently played" pill sits at the top of the rails column —
  // right after the featured hero / chip strip and before Continue
  // Watching. Used to be its own rail; was redundant with Continue
  // Watching for the common case (started + unfinished items appeared
  // in both). Placed up here so it's reachable without scrolling
  // past every category rail.
  // Each rail header carries a `total` so the rail title can render
  // "(N)" — the full item count in that category / list, BEFORE the
  // 25-tile cap. Counts come straight from the underlying data
  // structures (which are already kid- and lang-filtered by the
  // server) so chip filtering doesn't affect the displayed total.

  // Continue Watching — merged with Recently Played (#48). The
  // separate footer link to a "Recently played" pseudo-category is
  // gone; users get one rail of "stuff I was last on," with a Hide ✕
  // affordance on each tile.
  const cwRaw = continueWatchingItems(mode);
  const cw = gate(cwRaw);
  if (cw.length) rails.push({
    title: "Continue Watching",
    items: cw,
    navId: null,
    total: cwRaw.length,
    hideable: true,
  });

  // My List — sits above Favorites since "want to watch next" is
  // the highest-intent action on the homepage.
  const mlRaw = myListItems(mode);
  const ml = gate(mlRaw);
  if (ml.length) rails.push({ title: "Watch Later", items: ml.slice(0, 25), navId: PSEUDO.MY_LIST, total: mlRaw.length });

  // Favorites
  const favsRaw = favoriteItems(mode);
  const favs = gate(favsRaw);
  if (favs.length) rails.push({ title: "Favorites", items: favs.slice(0, 25), navId: PSEUDO.FAVS, total: favsRaw.length });

  // One rail per filtered category
  const cats = filteredCategories(mode);
  for (const c of cats) {
    const fullCat = state.modes[mode].byCat.get(String(c.category_id)) || [];
    const items = gate(categoryItems(mode, c.category_id, 25));
    if (items.length) rails.push({
      title: c.category_name,
      items,
      navId: c.category_id,
      total: fullCat.length,
    });
  }

  if (!rails.length) {
    const empty = document.createElement("div");
    empty.className = "rail-empty";
    if (!ms().indexReady) {
      empty.textContent = "Indexing the library… rails will appear once the panel is scanned.";
    } else if (picks && picks.size) {
      const labels = [...picks].map(k => chipLabel(k)).filter(Boolean).join(" + ");
      empty.textContent = `No ${mode === "movie" ? "movies" : "series"} match "${labels}".`;
    } else if (filterIsActive(mode)) {
      empty.innerHTML = `Nothing to show — your filter has no matching categories. Open <span aria-hidden="true">⚙</span> Settings to adjust, or click <b>Show all</b>.`;
    } else {
      empty.textContent = "Nothing to show yet. Open ⚙ Settings to pick the regions / languages you want on the homepage.";
    }
    el.rails.appendChild(empty);
    return;
  }

  for (const r of rails) el.rails.appendChild(renderRail(r));
}

// Chip strip above the rails on Movies / Series home. Mirrors the
// TV Guide's chip bar shape so the visual language is consistent —
// same CSS classes, same hover/focus treatment, same multi-select
// AND semantics. Chip set: All + 4K + the user's onboarded language
// groups (so a US-only profile doesn't see Hindi / Tamil chips).
function renderBrowseChipStrip(mode) {
  const bar = document.createElement("div");
  bar.className = "guide-quick browse-quick";
  const picks = _browseQuickFilter[mode];
  const isAll = !picks || picks.size === 0;
  const chips = [
    { key: "all", label: "All" },
    { key: "4k",  label: "4K" },
  ];
  if (state.filter.onboarded) {
    const seen = new Set(chips.map(c => c.key));
    for (const g of orderedGroups()) {
      if (state.filter.groups[mode] && state.filter.groups[mode].has(g.key) && !seen.has(g.key)) {
        chips.push({ key: g.key, label: g.label });
      }
    }
  }
  for (const c of chips) {
    const b = document.createElement("button");
    b.type = "button";
    const active = c.key === "all" ? isAll : picks.has(c.key);
    b.className = "guide-quick-chip" + (active ? " on" : "");
    b.textContent = c.label;
    b.onclick = () => {
      if (c.key === "all") {
        picks.clear();
      } else if (picks.has(c.key)) {
        picks.delete(c.key);
      } else {
        picks.add(c.key);
      }
      // Re-render just the rails for whichever surface the chip strip is
      // on — NOT renderHome()/refreshView(), which would also rebuild and
      // re-shuffle the hero on every chip click.
      if (state.view === "collection") renderCollection();
      else renderRails();
    };
    bar.appendChild(b);
  }
  return bar;
}

function renderRail({ title, items, navId, total, hideable, onSeeAll, blurb }) {
  const sec = document.createElement("section");
  sec.className = "rail";

  const header = document.createElement("div");
  header.className = "rail-header";
  const h = document.createElement("h3");
  h.className = "rail-title";
  h.textContent = title;
  if (blurb) h.title = blurb;
  header.appendChild(h);
  // Total count next to the title (server-supplied; falls back to
  // the visible item count). Surfaces "this rail has 47 things" so
  // the user knows to click See all when only 12 fit.
  const shown = items?.length || 0;
  const fullTotal = Number.isFinite(total) && total > 0 ? total : shown;
  if (fullTotal > 0) {
    const count = document.createElement("span");
    count.className = "rail-count";
    count.textContent = fullTotal === shown
      ? `${fullTotal.toLocaleString()}`
      : `${fullTotal.toLocaleString()}`;
    count.title = fullTotal === shown
      ? `${fullTotal} items`
      : `${fullTotal} items — showing first ${shown}`;
    header.appendChild(count);
  }
  if (onSeeAll || navId) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "rail-more";
    more.textContent = "See all ›";
    more.onclick = onSeeAll || (() => selectCategory(navId));
    header.appendChild(more);
  }

  const track = document.createElement("div");
  track.className = "rail-track" + (state.mode === "live" ? " live" : "");
  // Tag each card with which rail it came from so the user can debug
  // why a title is on their home — useful when a kids profile sees
  // something it shouldn't, or when filter chips are unexpectedly
  // including / excluding things.
  for (const s of items) track.appendChild(channelCard(s, { reason: title, hideable }));

  sec.append(header, track);
  return sec;
}

// --- TV Guide (Live) ----------------------------------------------------
// EPG_HOURS = the user's "Forward window" pill (refreshed each render).
// EPG_PX_PER_MIN = computed each render so the chosen hour count fits
// the available viewport width: short windows (2–5 h) fill the
// viewport flush; long windows (8–24 h) fall back to a readable
// minimum density (3.5 px/min) and overflow into the horizontal
// scroll. Both values are also mirrored to the CSS custom properties
// `--epg-hours` and `--epg-px-per-min` so the track/ruler width and
// gridline spacing stay in lockstep with the JS-driven positioning.
let EPG_HOURS = 3;
let EPG_PX_PER_MIN = 4;
const EPG_MIN_PX_PER_MIN = 3.5;
function computeEpgPxPerMin(hours) {
  const docStyle = getComputedStyle(document.documentElement);
  const channelW = parseInt(docStyle.getPropertyValue("--epg-channel-w"), 10) || 260;
  const viewportW = el.guideScroll?.clientWidth || window.innerWidth || 1280;
  const available = Math.max(200, viewportW - channelW);
  const minutes = Math.max(1, hours) * 60;
  return Math.max(EPG_MIN_PX_PER_MIN, available / minutes);
}
let _guideAnchorMs = null;
let _guideObserver = null;
let _guideNowTimer = null;
// Which tab is active in the guide. Defaults to the EPG-rich set.
let _guideTab = "with";
// Quick-filter chips — multi-select with AND semantics. Empty set means
// "All" (no filtering). Picking "Movies" + "Hindi" returns only channels
// whose category matches both. Persists across tab switches within the
// session.
let _guideQuickFilter = new Set();
// Chip filter for Movies / Series home rails. Per-mode so toggling
// between Movies and Series doesn't carry a stale "Hindi" pick across.
// Same AND-across-chips semantics as the TV Guide; empty = "All".
const _browseQuickFilter = { movie: new Set(), series: new Set(), disk: new Set() };
// Cached split for the current renderGuide() call so tab clicks don't
// re-walk the whole catalog.
let _guideChannels = { with: [], without: [], haveField: false };
// Guide rows are virtualized: building a DOM node + firing a logo image
// load for all 8000+ channels synchronously is what actually freezes the
// tab (the data itself is already fully in memory by the time the Guide
// has anything to show — see filteredLiveChannels()/pollIndex()). Render
// GUIDE_PAGE_SIZE rows at a time and extend on scroll via
// setupGuidePagingObserver(). _guideRenderList/_guideRenderedCount reset
// together only in renderGuideTabBody() (the sole full-rebuild entry
// point); appendGuideRowsPage() only ever advances them, never wipes the DOM.
const GUIDE_PAGE_SIZE = 200;
let _guideRenderList = [];
let _guideRenderedCount = 0;

// Genre and language chips offered above the guide rows. Keys match the
// curated GROUPS array so the same regex patterns drive the chip filter
// as drive the catalog filter — one source of truth.
const GUIDE_GENRE_CHIPS = [
  { key: "favs",   label: "★ Favorites" },
  { key: "4k",     label: "4K" },
  { key: "movies", label: "Movies" },
  { key: "sports", label: "Sports" },
  { key: "news",   label: "News" },
  { key: "music",  label: "Music" },
  { key: "kids",   label: "Kids" },
  { key: "entertainment", label: "Entertainment" }, // synthesized: NOT (sports/news/kids/music/movies)
];
const NON_ENTERTAINMENT_KEYS = new Set(["sports", "news", "kids", "music", "movies"]);
// Synthesized chip patterns (not part of GROUPS — they're guide-only).
// Only consulted on the legacy regex fallback path; the hot path reads
// the pre-computed `tags` array the server attaches to every stream.
const GUIDE_SYNTHETIC_PATTERNS = {
  movies: [/\bmovies?\b/i, /\bcinema\b/i],
  "4k":   [/\b4k\b/i, /\buhd\b/i, /\b2160p?\b/i, /\(2160\)/i],
};

function filteredLiveChannels() {
  const all = flatStreams();
  if (!filterIsActive("live")) return all;
  const allowedCatIds = new Set(filteredCategories("live").map(c => String(c.category_id)));
  return all.filter(s => allowedCatIds.has(String(s.category_id)));
}

function renderGuide() {
  const channels = filteredLiveChannels();
  // Refresh the grid hour-count from the user's pill so a freshly-
  // changed window takes effect on the next paint. Capped at 24h to
  // match the server's hard cap. The CSS track width is driven by
  // the `--epg-hours` custom property (see .guide-track in
  // style.css), so we mirror the JS value to it here — otherwise
  // the track stays at whatever value is in :root and you see
  // empty grid past the last hour label.
  EPG_HOURS = Math.min(Math.max(state.epgWindowHoursForward || 3, 1), 24);
  EPG_PX_PER_MIN = computeEpgPxPerMin(EPG_HOURS);
  document.documentElement.style.setProperty("--epg-hours", String(EPG_HOURS));
  document.documentElement.style.setProperty("--epg-px-per-min", `${EPG_PX_PER_MIN}px`);
  // Anchor 5 min before now, snapped to a 30-min boundary so the time
  // ruler labels fall on clean :00 / :30 marks.
  _guideAnchorMs = Math.floor((Date.now() - 5 * 60 * 1000) / (30 * 60 * 1000)) * (30 * 60 * 1000);

  el.guideTimes.innerHTML = "";
  for (let h = 0; h <= EPG_HOURS; h++) {
    const t = new Date(_guideAnchorMs + h * 3600 * 1000);
    const span = document.createElement("span");
    span.className = "guide-time";
    span.style.left = `${h * 60 * EPG_PX_PER_MIN}px`;
    span.textContent = t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    el.guideTimes.appendChild(span);
  }

  if (!channels.length) {
    el.guideTabs.innerHTML = "";
    el.guideRows.innerHTML = "";
    el.guideMeta.textContent = !ms().indexReady
      ? "Indexing the channel list…"
      : (filterIsActive("live") ? "No channels in your filter — open ⚙ Settings or click Show all." : "No channels.");
    return;
  }

  // Split into channels the panel claims have EPG vs ones that don't.
  // For very old cached indexes lacking the field entirely, treat all as
  // "with EPG" and skip the second tab — we'll discover the truth lazily
  // when each row scrolls in. Also moves channels we've already
  // discovered to be EPG-empty (panel said yes, but get_short_epg
  // returned 0) into the "Without" bucket.
  const haveField = channels.some(c => "epg_channel_id" in c);
  const claimedEpg = haveField ? channels.filter(c =>  c.epg_channel_id) : channels;
  const claimedNo  = haveField ? channels.filter(c => !c.epg_channel_id) : [];
  _guideChannels = {
    with:    claimedEpg.filter(c => !state.epgEmpty.has(String(c.id))),
    without: claimedNo.concat(claimedEpg.filter(c => state.epgEmpty.has(String(c.id)))),
    haveField,
  };

  el.guideMeta.textContent = `${channels.length.toLocaleString()} channels · next ${EPG_HOURS}h`;
  if (_guideTab === "without" && !_guideChannels.without.length) _guideTab = "with";

  // If something is playing, default to whichever tab the playing
  // channel lives in so the highlighted row is visible after refresh.
  if (state.playing && state.playing.mode === "live") {
    const id = String(state.playing.item.id);
    if (_guideChannels.without.some(c => String(c.id) === id)) _guideTab = "without";
    else if (_guideChannels.with.some(c => String(c.id) === id)) _guideTab = "with";
  }

  renderGuideTabs();
  renderGuideQuickFilters();
  renderGuideTabBody();
  scheduleNowLine();
  scrollGuideToPlaying();
}

function scrollGuideToPlaying() {
  if (!state.playing || state.playing.mode !== "live") return;
  const id = String(state.playing.item.id);
  // Rows are now paginated (see appendGuideRowsPage) — the playing
  // channel's row may not exist yet if it's beyond the first page.
  // Fast-forward the render cursor so it does before we try to scroll.
  ensureGuideRowRendered(id);
  // Wait one frame so the rows are laid out and have positions.
  requestAnimationFrame(() => {
    const row = el.guideRows.querySelector(`.guide-row[data-stream-id="${CSS.escape(id)}"]`);
    if (!row) return;
    // Manual scroll within the guide-scroll container (not page-scroll)
    // — the standard element.scrollIntoView() would also jiggle the
    // outer page on some browsers.
    const containerTop = el.guideScroll.getBoundingClientRect().top;
    const rowTop = row.getBoundingClientRect().top;
    const target = el.guideScroll.scrollTop + (rowTop - containerTop) - (el.guideScroll.clientHeight / 2) + (row.offsetHeight / 2);
    el.guideScroll.scrollTo({ top: Math.max(0, target), behavior: "instant" });
  });
}

// Fast-forwards the Guide's render cursor in ONE bulk append (not a loop
// of GUIDE_PAGE_SIZE-sized calls, which would redundantly re-run
// setupGuideObserver()/sentinel placement for a value about to be
// superseded) so a specific channel's row exists in the DOM. No-op if the
// channel isn't in the current filtered/tab'd view, or is already rendered.
function ensureGuideRowRendered(id) {
  if (_guideRenderedCount >= _guideRenderList.length) return;
  const idx = _guideRenderList.findIndex(ch => String(ch.id) === id);
  if (idx < 0 || idx < _guideRenderedCount) return;
  appendGuideRowsPage(idx + 1 - _guideRenderedCount);
}

function categoryNameForChannel(ch) {
  const cat = state.modes.live.categories.find(c => String(c.category_id) === String(ch.category_id));
  return cat ? cat.category_name : "";
}

function channelMatchesQuickFilter(ch, key) {
  if (key === "all") return true;
  // Favorites chip — special, not a tag. Lets the user pivot the
  // whole guide to "just the channels I care about" with one click,
  // and combines with other chips (e.g. Favorites + Sports) for
  // narrower views.
  if (key === "favs") return state.favorites.live.has(ch.id);
  // Hot path: every chip toggle previously re-ran the full GROUPS regex
  // table against every channel's category name in the main loop, which
  // on the TV client added up to a multi-second freeze with 3 chips
  // selected. The server now pre-computes a `tags` array per stream at
  // index time, so this becomes an O(1) membership check.
  const tags = ch.tags;
  if (Array.isArray(tags)) return tags.includes(key);
  // Legacy fallback for streams that came back without tags (e.g.
  // a brand-new mode that hasn't been re-indexed yet against the
  // new server).
  const name = categoryNameForChannel(ch);
  if (GUIDE_SYNTHETIC_PATTERNS[key]) {
    return GUIDE_SYNTHETIC_PATTERNS[key].some(re => re.test(name));
  }
  const keys = groupKeysOf(name);
  if (key === "entertainment") {
    if (GUIDE_SYNTHETIC_PATTERNS.movies.some(re => re.test(name))) return false;
    return !keys.some(k => NON_ENTERTAINMENT_KEYS.has(k));
  }
  return keys.includes(key);
}

function renderGuideQuickFilters() {
  // Existing chips bar (if any) — clear and rebuild.
  const existing = el.guide.querySelector(".guide-quick");
  if (existing) existing.remove();

  // Chip set: All + genres + the user's chosen language buckets so the
  // strip is curated to what they care about (no surprise chips).
  // Sports / News / Kids exist in *both* GUIDE_GENRE_CHIPS and GROUPS,
  // so dedupe by key — otherwise they'd appear twice when the user has
  // ticked them in the catalog filter.
  const chips = [{ key: "all", label: "All" }, ...GUIDE_GENRE_CHIPS];
  const seen = new Set(chips.map(c => c.key));
  if (state.filter.onboarded) {
    for (const g of orderedGroups()) {
      if (state.filter.groups.live.has(g.key) && !seen.has(g.key)) {
        chips.push({ key: g.key, label: g.label });
        seen.add(g.key);
      }
    }
  }

  const bar = document.createElement("div");
  bar.className = "guide-quick";
  const isAll = _guideQuickFilter.size === 0;
  for (const c of chips) {
    const b = document.createElement("button");
    b.type = "button";
    const active = c.key === "all" ? isAll : _guideQuickFilter.has(c.key);
    b.className = "guide-quick-chip" + (active ? " on" : "");
    b.textContent = c.label;
    b.onclick = () => {
      if (c.key === "all") {
        _guideQuickFilter.clear();
      } else if (_guideQuickFilter.has(c.key)) {
        _guideQuickFilter.delete(c.key);
      } else {
        _guideQuickFilter.add(c.key);
      }
      renderGuideQuickFilters();
      renderGuideTabBody();
    };
    bar.appendChild(b);
  }
  el.guideTabs.insertAdjacentElement("afterend", bar);
}

function renderGuideTabs() {
  el.guideTabs.innerHTML = "";
  // The "Without" tab only appears when the panel actually told us some
  // channels lack EPG; otherwise tabs would be a one-button noop.
  const tabs = [{ key: "with", label: "With program data", count: _guideChannels.with.length }];
  if (_guideChannels.haveField && _guideChannels.without.length) {
    tabs.push({ key: "without", label: "Without program data", count: _guideChannels.without.length });
  }
  for (const t of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.role = "tab";
    btn.className = "guide-tab" + (t.key === _guideTab ? " active" : "");
    btn.innerHTML = `<span>${escapeHtml(t.label)}</span><span class="tab-count">${t.count.toLocaleString()}</span>`;
    btn.onclick = () => {
      if (_guideTab === t.key) return;
      _guideTab = t.key;
      renderGuideTabs();
      renderGuideTabBody();
      el.guideScroll.scrollTo({ top: 0, behavior: "instant" });
    };
    el.guideTabs.appendChild(btn);
  }
}

function renderGuideTabBody() {
  const base = _guideTab === "without" ? _guideChannels.without : _guideChannels.with;
  // Multi-select chips — AND across them. Empty set means show all.
  let list = _guideQuickFilter.size === 0
    ? base
    : base.filter(ch => [..._guideQuickFilter].every(k => channelMatchesQuickFilter(ch, k)));

  // Filter EPG rows in place by the search query so the user keeps
  // the time-grid context while narrowing. Used to switch the whole
  // view to a poster grid, which lost the now-line + program blocks
  // they were scanning against.
  const q = (state.query || "").toLowerCase();
  if (q) list = list.filter(ch => (ch.name || "").toLowerCase().includes(q));

  el.guideRows.innerHTML = "";
  if (!list.length) {
    const labels = [..._guideQuickFilter].map(chipLabel).join(" + ") || "All";
    const empty = document.createElement("div");
    empty.style.cssText = "padding:32px 24px;color:var(--fg-dim);font-size:13px;";
    empty.textContent = q
      ? `No channels match "${state.query}" in this tab.`
      : `No channels in this tab match "${labels}".`;
    el.guideRows.appendChild(empty);
    _guideRenderList = [];
    _guideRenderedCount = 0;
    return;
  }
  _guideRenderList = list;
  _guideRenderedCount = 0;
  appendGuideRowsPage();
}

// Renders the next GUIDE_PAGE_SIZE rows of _guideRenderList and appends
// them (never wipes existing rows) — the incremental counterpart to
// renderGuideTabBody()'s full rebuild. `count` lets a caller (see
// ensureGuideRowRendered) jump ahead by more than one page in a single
// batch instead of looping.
function appendGuideRowsPage(count = GUIDE_PAGE_SIZE) {
  const start = _guideRenderedCount;
  if (start >= _guideRenderList.length) return;
  const end = Math.min(start + count, _guideRenderList.length);
  el.guideRows.querySelector(".guide-sentinel")?.remove();
  const frag = document.createDocumentFragment();
  const newTracks = [];
  for (let i = start; i < end; i++) {
    const row = buildGuideRow(_guideRenderList[i], { noEpg: _guideTab === "without" });
    newTracks.push(row.querySelector(".guide-track"));
    frag.appendChild(row);
  }
  el.guideRows.appendChild(frag);
  _guideRenderedCount = end;
  for (const track of newTracks) appendNowLineTo(track); // O(page), not O(rendered-so-far)
  setupGuideObserver();
  setupGuidePagingObserver();
}

// Scroll-triggered continuation of appendGuideRowsPage(). Disconnects and
// rebuilds per call, mirroring setupGridPagingObserver() — but unlike the
// grid, the data here is already fully in memory (no network round-trip),
// so the callback appends directly instead of fetching + re-rendering
// everything loaded so far.
let _guidePagingObserver = null;
function setupGuidePagingObserver() {
  if (_guidePagingObserver) { _guidePagingObserver.disconnect(); _guidePagingObserver = null; }
  if (_guideRenderedCount >= _guideRenderList.length) return;
  const sentinel = document.createElement("div");
  sentinel.className = "guide-sentinel";
  sentinel.textContent = "Loading more…";
  el.guideRows.appendChild(sentinel);
  _guidePagingObserver = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) appendGuideRowsPage();
  }, { root: el.guideScroll, rootMargin: "300px 0px" });
  _guidePagingObserver.observe(sentinel);
}

function chipLabel(key) {
  if (key === "all") return "All";
  const genre = GUIDE_GENRE_CHIPS.find(g => g.key === key);
  if (genre) return genre.label;
  return labelForGroupKey(key);
}

function buildGuideRow(ch, { noEpg = false } = {}) {
  const row = document.createElement("div");
  const isPlaying = state.playing && state.playing.mode === "live"
    && String(state.playing.item.id) === String(ch.id);
  row.className = "guide-row"
    + (noEpg ? " no-epg" : "")
    + (isPlaying ? " playing" : "");
  row.dataset.streamId = String(ch.id);
  if (noEpg) row.dataset.noEpg = "1";
  // Logo loads lazily via _guideObserver (see setupGuideObserver) once the
  // row scrolls into view, same as EPG/probe data — not at build time.
  // At 8000+ channels, firing new Image() for every row synchronously was
  // its own separate freeze on top of the row-building cost.
  if (ch.icon) row.dataset.icon = ch.icon;

  const left = document.createElement("div");
  left.className = "guide-channel";
  const offAir = renderOffAirMarker(ch.id);
  left.innerHTML = `
    <div class="ch-logo"></div>
    <span class="ch-name">${escapeHtml(ch.name)}</span>
    ${offAir}
  `;
  left.title = ch.name;
  left.onclick = () => play("live", ch);

  // Own click handler + stopPropagation — matches the card-grid star
  // (~line 3145). Without this the star was inert markup inside
  // left.innerHTML, so any click on it bubbled into left.onclick and
  // started playback instead of toggling the favorite — dangerous
  // given cap=1 concurrency (an accidental click could kill whatever
  // the family is actually watching).
  if (state.favorites.live.has(ch.id)) {
    const fav = document.createElement("span");
    fav.className = "ch-fav";
    fav.title = "Favorite";
    fav.textContent = "★";
    fav.onclick = (e) => {
      e.stopPropagation();
      toggleFav("live", ch.id);
      fav.remove();
    };
    left.appendChild(fav);
  }

  const track = document.createElement("div");
  track.className = "guide-track";
  const ph = document.createElement("div");
  ph.className = "guide-program placeholder";
  ph.style.left = "0px";
  ph.style.right = "0px";
  ph.textContent = noEpg ? "(no schedule — click name to play)" : "…";
  track.appendChild(ph);

  row.append(left, track);
  return row;
}

function setupGuideObserver() {
  if (_guideObserver) _guideObserver.disconnect();
  _guideObserver = new IntersectionObserver((entries) => {
    const probeIds = [];
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.streamId;
      if (id) {
        // Don't waste a panel call on channels the panel already told us
        // have no EPG; the placeholder stays put.
        if (!e.target.dataset.noEpg) loadEpgForChannel(id);
        // Queue a codec/liveness probe regardless of EPG state — the
        // off-air marker doesn't depend on schedule data.
        if (!state.channelProbes[id]) probeIds.push(parseInt(id, 10));
        // Lazy logo swap-in (see buildGuideRow). This observer is
        // recreated per page-append (appendGuideRowsPage), so an
        // already-loaded row can be re-observed — guard against
        // re-fetching its image every time.
        if (e.target.dataset.icon && !e.target.dataset.iconLoaded) {
          e.target.dataset.iconLoaded = "1";
          const logo = e.target.querySelector(".ch-logo");
          const img = new Image();
          img.referrerPolicy = "no-referrer";
          img.onload = () => { if (logo) logo.style.backgroundImage = `url("${e.target.dataset.icon}")`; };
          img.src = e.target.dataset.icon;
        }
      }
    }
    if (probeIds.length) scheduleChannelProbe(probeIds);
  }, { root: el.guideScroll, rootMargin: "300px 0px" });

  for (const row of el.guideRows.querySelectorAll(".guide-row")) {
    _guideObserver.observe(row);
  }
}

// Coalesce id requests from the IntersectionObserver so a fast scroll
// through 200 channels turns into a single POST rather than 200
// keystrokes hitting the server. 250 ms is roughly the time the panel
// needs to release a max_connections slot anyway.
let _probeBatchTimer = null;
let _probeBatch = new Set();
let _probePollTimer = null;
function scheduleChannelProbe(ids) {
  for (const id of ids) _probeBatch.add(id);
  if (_probeBatchTimer) return;
  _probeBatchTimer = setTimeout(flushChannelProbe, 250);
}
// Server may return { disabled: true } when PROBE_CHANNELS_ENABLED is
// off — in that case stop scheduling probes for the rest of this
// session so we don't keep hitting the endpoint pointlessly on every
// scroll. Off-air markers just don't render; the play-time probe is
// still there for the codec-driven transcoder fallback.
let _probesDisabledByServer = false;
async function flushChannelProbe() {
  _probeBatchTimer = null;
  const ids = [..._probeBatch];
  _probeBatch.clear();
  if (!ids.length || _probesDisabledByServer) return;
  try {
    const r = await fetch("/api/probe-channels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "live", ids }),
    });
    if (!r.ok) return;
    const data = await r.json();
    if (data.disabled) { _probesDisabledByServer = true; return; }
    if (data.verdicts) {
      for (const [id, v] of Object.entries(data.verdicts)) {
        state.channelProbes[id] = v;
        applyOffAirMarker(id);
      }
    }
    // Server still has probes pending for some of the requested ids.
    // Re-poll until they all land so the markers can populate without
    // forcing the user to scroll back into view.
    const unresolved = ids.filter(id => !state.channelProbes[id]);
    if (unresolved.length && !_probePollTimer) {
      _probePollTimer = setTimeout(() => {
        _probePollTimer = null;
        scheduleChannelProbe(unresolved);
      }, 3000);
    }
  } catch {}
}

// Pure renderer — emits the inline `✕ off-air` marker HTML for a
// channel id, or "" if no verdict / channel is alive. Kept separate
// so it can be reused both at row-build time and later when a
// late-arriving probe verdict needs to be injected without a full
// re-render.
function renderOffAirMarker(id) {
  const v = state.channelProbes[id];
  if (!v || !v.dead) return "";
  const reason = v.dead_reason ? ` (${escapeHtml(v.dead_reason)})` : "";
  return `<span class="ch-offair" title="Channel currently unreachable${reason}">✕ off-air</span>`;
}
function applyOffAirMarker(id) {
  const row = el.guideRows?.querySelector(`.guide-row[data-stream-id="${CSS.escape(String(id))}"]`);
  if (!row) return;
  const left = row.querySelector(".guide-channel");
  if (!left) return;
  const existing = left.querySelector(".ch-offair");
  const html = renderOffAirMarker(id);
  if (existing) existing.outerHTML = html;
  else if (html) left.querySelector(".ch-name")?.insertAdjacentHTML("afterend", html);
}

async function loadEpgForChannel(streamId) {
  const cached = state.epg[streamId];
  if (cached && (Date.now() - cached.fetchedAt) < EPG_TTL_MS) {
    paintEpgIntoRow(streamId, cached.programs);
    return;
  }
  try {
    const hours = Math.min(Math.max(state.epgWindowHoursForward || 3, 1), 24);
    const r = await fetch(`/api/epg/short/${encodeURIComponent(streamId)}?hours=${hours}`);
    if (!r.ok) return;
    const d = await r.json();
    state.epg[streamId] = { fetchedAt: Date.now(), programs: d.programs || [] };
    paintEpgIntoRow(streamId, d.programs || []);
  } catch {}
}

function paintEpgIntoRow(streamId, programs) {
  const row = el.guideRows.querySelector(`.guide-row[data-stream-id="${CSS.escape(String(streamId))}"]`);
  if (!row) return;
  const track = row.querySelector(".guide-track");
  track.innerHTML = "";
  if (!programs.length) {
    // Channel claimed EPG but the panel returned zero programs for the
    // visible window. Remember so it migrates to the "Without" tab on
    // the next renderGuide() — and use a placeholder that doesn't echo
    // the other tab's name verbatim.
    state.epgEmpty.add(String(streamId));
    const ph = document.createElement("div");
    ph.className = "guide-program placeholder";
    ph.style.left = "0px"; ph.style.right = "0px";
    ph.textContent = "Schedule unavailable";
    track.appendChild(ph);
    return;
  }
  // Found programs — make sure this channel isn't stuck in the empty
  // set from a previous (possibly transient) empty fetch.
  state.epgEmpty.delete(String(streamId));
  const startMs = _guideAnchorMs;
  const endMs = startMs + EPG_HOURS * 3600 * 1000;
  const nowMs = Date.now();
  // Sort by start time so we can clip each block to the next block's
  // start — some panels return programs with overlapping windows
  // (rounding errors, encoding glitches) and that was making titles
  // render on top of each other.
  const sorted = programs
    .filter(p => p.start_ts && p.stop_ts && p.stop_ts > startMs / 1000 && p.start_ts < endMs / 1000)
    .slice()
    .sort((a, b) => a.start_ts - b.start_ts);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const next = sorted[i + 1];
    const s = p.start_ts * 1000;
    let e = p.stop_ts * 1000;
    if (next) e = Math.min(e, next.start_ts * 1000);
    if (e <= s) continue; // fully overlapped — skip
    const left = Math.max(0, (s - startMs) / 60000) * EPG_PX_PER_MIN;
    const right = Math.min((endMs - startMs) / 60000, (e - startMs) / 60000) * EPG_PX_PER_MIN;
    const width = right - left;
    if (width < 4) continue; // smaller than a pixel-and-a-half — would be unreadable
    const block = document.createElement("div");
    block.className = "guide-program" + (s <= nowMs && e > nowMs ? " now" : "");
    block.style.left = `${left}px`;
    block.style.width = `${width}px`;
    const stTime = new Date(s).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const enTime = new Date(p.stop_ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    block.innerHTML = `
      <div class="gp-title">${escapeHtml(p.title || "Untitled")}</div>
      <div class="gp-time">${stTime}–${enTime}</div>
    `;
    block.title = `${stTime}–${enTime}\n${(p.title || "").trim()}${p.description ? "\n\n" + p.description.trim() : ""}`;
    block.onclick = () => {
      const ch = flatStreams().find(c => String(c.id) === String(streamId));
      if (ch) play("live", ch);
    };
    track.appendChild(block);
  }
  // The track was just emptied + repopulated; re-stamp the now-line
  // marker on this row only (others are untouched).
  appendNowLineTo(track);
}

function appendNowLineTo(track) {
  if (!_guideAnchorMs) return;
  const offset = (Date.now() - _guideAnchorMs) / 60000 * EPG_PX_PER_MIN;
  if (offset < 0 || offset > EPG_HOURS * 60 * EPG_PX_PER_MIN) return;
  const line = document.createElement("div");
  line.className = "guide-now-line";
  line.style.left = `${offset}px`;
  track.appendChild(line);
}

function scheduleNowLine() {
  if (_guideNowTimer) { clearInterval(_guideNowTimer); _guideNowTimer = null; }
  drawNowLine();
  _guideNowTimer = setInterval(drawNowLine, 60_000);
}
function drawNowLine() {
  if (el.guide.hidden) {
    if (_guideNowTimer) { clearInterval(_guideNowTimer); _guideNowTimer = null; }
    return;
  }
  el.guideRows.querySelectorAll(".guide-now-line").forEach(n => n.remove());
  if (!_guideAnchorMs) return;
  const offset = (Date.now() - _guideAnchorMs) / 60000 * EPG_PX_PER_MIN;
  if (offset < 0 || offset > EPG_HOURS * 60 * EPG_PX_PER_MIN) return;
  for (const track of el.guideRows.querySelectorAll(".guide-track")) {
    const line = document.createElement("div");
    line.className = "guide-now-line";
    line.style.left = `${offset}px`;
    track.appendChild(line);
  }
}

// --- Live remote (channel zapper) --------------------------------------
function liveChannelOrder() { return filteredLiveChannels(); }

function currentLiveChannelIndex() {
  if (!state.playing || state.playing.mode !== "live") return -1;
  const order = liveChannelOrder();
  return order.findIndex(c => String(c.id) === String(state.playing.item.id));
}

function stepLiveChannel(delta) {
  const order = liveChannelOrder();
  if (!order.length) return;
  let i = currentLiveChannelIndex();
  if (i < 0) i = 0;
  i = (i + delta + order.length) % order.length;
  play("live", order[i]);
}

function jumpLiveChannelByNumber(input) {
  const target = String(input).trim();
  if (!target) return;
  const order = liveChannelOrder();
  const ch = order.find(c => String(c.id) === target);
  if (ch) play("live", ch);
  else toast(`Channel ${target} not in your filter`, 2500);
}

function openLiveRemote() {
  if (!state.playing || state.playing.mode !== "live") return;
  el.liveRemoteToggle.hidden = true;
  el.liveRemote.hidden = false;
  renderLiveRemote();
}
function closeLiveRemote() {
  el.liveRemote.hidden = true;
  if (state.playing && state.playing.mode === "live") {
    el.liveRemoteToggle.hidden = false;
  }
}
function renderLiveRemote() {
  if (!state.playing) { closeLiveRemote(); return; }
  const ch = state.playing.item;
  const epg = state.epg[ch.id];
  const nowSec = Date.now() / 1000;
  const nowProg = epg && (epg.programs || []).find(p => p.start_ts <= nowSec && p.stop_ts > nowSec);
  const recents = state.recents.live
    .map(id => flatStreams().find(s => s.id === id))
    .filter(Boolean)
    .filter(s => String(s.id) !== String(ch.id))
    .slice(0, 5);
  el.liveRemote.innerHTML = `
    <div class="lr-head">
      <span class="lr-title">Remote</span>
      <button class="lr-btn lr-close" type="button" aria-label="Close">✕</button>
    </div>
    <div class="lr-current" title="${escapeHtml(ch.name)}">${escapeHtml(ch.name)}</div>
    ${nowProg ? `<div class="lr-now">Now: ${escapeHtml(nowProg.title)}</div>` : ""}
    <div class="lr-row">
      <button class="lr-btn lr-down" type="button">▼ Ch −</button>
      <button class="lr-btn lr-up"   type="button">Ch + ▲</button>
    </div>
    <div class="lr-num">
      <input type="text" inputmode="numeric" placeholder="Channel #" maxlength="6" />
      <button class="lr-btn lr-go" type="button">Go</button>
    </div>
    ${recents.length ? `
      <div class="lr-recents">
        ${recents.map(r => `<button type="button" data-id="${escapeHtml(String(r.id))}">${escapeHtml(r.name)}</button>`).join("")}
      </div>` : ""}
  `;
  el.liveRemote.querySelector(".lr-close").onclick = closeLiveRemote;
  el.liveRemote.querySelector(".lr-up").onclick   = () => stepLiveChannel(+1);
  el.liveRemote.querySelector(".lr-down").onclick = () => stepLiveChannel(-1);
  const input = el.liveRemote.querySelector(".lr-num input");
  const go = () => { const v = input.value; input.value = ""; jumpLiveChannelByNumber(v); };
  el.liveRemote.querySelector(".lr-go").onclick = go;
  input.onkeydown = (e) => { if (e.key === "Enter") { e.stopPropagation(); go(); } };
  for (const b of el.liveRemote.querySelectorAll(".lr-recents button")) {
    b.onclick = () => {
      const id = parseInt(b.dataset.id, 10);
      const ch2 = flatStreams().find(s => s.id === id);
      if (ch2) play("live", ch2);
    };
  }
  // Lazy-fetch EPG for the currently playing channel so the "Now" line
  // appears once data arrives.
  if (!epg) loadEpgForChannel(ch.id).then(() => {
    if (!el.liveRemote.hidden) renderLiveRemote();
  });
}
// Sync the player-bar ★ button to whether the currently-playing item
// (or its parent series, when an episode is playing) is a favorite.
// Episodes are stored individually in state.recents but favorites live
// at the series level — so playing S2E5 of Breaking Bad toggles the
// favorite on the *series*, not the episode.
function favoriteTargetForPlaying() {
  if (!state.playing) return null;
  if (state.playing.mode === "series") {
    // The episode item we play has the episode's id, not the series's.
    // Find the parent series id from state.openSeries (set when the
    // user came from the modal) or from state.lastEpisode reverse-map.
    const epId = String(state.playing.item.id);
    if (state.openSeries) return { mode: "series", id: state.openSeries.id, label: "series" };
    for (const [seriesId, ep] of Object.entries(state.lastEpisode)) {
      if (String(ep.episode_id) === epId) return { mode: "series", id: parseInt(seriesId, 10), label: "series" };
    }
    return null; // can't determine the parent — hide the button
  }
  return { mode: state.playing.mode, id: state.playing.item.id, label: state.playing.mode };
}
function refreshPlayerFavorite() {
  if (!el.playerFavorite) return;
  const target = favoriteTargetForPlaying();
  if (!target) {
    el.playerFavorite.hidden = true;
    if (el.playerMylist) el.playerMylist.hidden = true;
    return;
  }
  el.playerFavorite.hidden = false;
  const isOn = state.favorites[target.mode].has(target.id);
  el.playerFavorite.classList.toggle("on", isOn);
  el.playerFavorite.title = isOn
    ? `Remove from favorites (this ${target.label})`
    : `Add to favorites (this ${target.label})`;
  // Mirror onto the + (My List) button. Same target identification —
  // when watching an episode, the My List toggle scopes to the parent
  // series the same way favorites does.
  if (el.playerMylist) {
    el.playerMylist.hidden = false;
    const inList = state.myList[target.mode].has(target.id);
    el.playerMylist.classList.toggle("on", inList);
    el.playerMylist.textContent = inList ? "✓" : "+";
    el.playerMylist.title = inList
      ? `Remove from Watch Later (this ${target.label})`
      : `Add to Watch Later (this ${target.label})`;
  }
}

// --- Video quality picker -------------------------------------------
// "Auto" = play the panel's stream directly; auto-retry through the
// server-side transcoder only if the browser can't decode the codec.
// 480p / 720p / 1080p = force transcode at that preset. The old
// "Source" option (force transcode at source bitrate) was dropped —
// Auto already serves the source bytes when codecs are friendly, so
// "Source" was just "spend CPU re-encoding for no reason."
const QUALITY_OPTIONS = [
  // Short label on the button (fits next to icon buttons in the
  // bar). Full description goes into `desc` so the menu can still
  // explain "Auto = panel original".
  { key: "auto",   label: "Auto",  desc: "Auto (panel original)" },
  { key: "low",    label: "480p" },
  { key: "med",    label: "720p" },
  { key: "high",   label: "1080p" },
];
function qualityLabel(key) {
  const opt = QUALITY_OPTIONS.find(o => o.key === key);
  return opt ? opt.label : "Auto";
}
// Update the player-bar quality button label to match state.quality.
function refreshQualityButton() {
  if (!el.playerQuality) return;
  el.playerQuality.textContent = qualityLabel(state.quality);
  el.playerQuality.classList.toggle("on", state.quality !== "auto");
}
// Persist + apply a quality choice. Mid-playback: tear down the
// current stream and restart at the new preset (the kill happens via
// stopServerStreams() at the top of play()).
function setQuality(q) {
  if (!QUALITY_OPTIONS.find(o => o.key === q)) return;
  if (q === state.quality) return;
  state.quality = q;
  try { localStorage.setItem("quality", q); } catch {}
  refreshQualityButton();
  // If a movie/series/live stream is currently playing, restart it
  // with the new quality. Cast sessions use the panel-direct URL on
  // VOD and the transcoded one on live; either way, restart.
  if (state.playing) {
    const p = state.playing;
    play(p.mode, p.item, p.label, p.ext, false);
  }
}

let qualityMenuEl = null;
function closeQualityMenu() {
  if (qualityMenuEl) { qualityMenuEl.remove(); qualityMenuEl = null; }
}
function toggleQualityMenu() {
  if (qualityMenuEl) { closeQualityMenu(); return; }
  qualityMenuEl = document.createElement("div");
  qualityMenuEl.className = "cc-menu quality-menu";
  for (const opt of QUALITY_OPTIONS) {
    const b = document.createElement("button");
    b.textContent = opt.label;
    if (opt.key === state.quality) b.classList.add("active");
    b.onclick = () => { setQuality(opt.key); closeQualityMenu(); };
    qualityMenuEl.appendChild(b);
  }
  el.player.appendChild(qualityMenuEl);
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (qualityMenuEl && !qualityMenuEl.contains(e.target) && e.target !== el.playerQuality) {
        closeQualityMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}

// --- Audio-track picker (panel movie/series) ------------------------
// Parallel to the quality picker: probe the VOD's audio streams via
// /api/tracks, and when there's more than one let the user pick. A
// non-default pick forces the transcoder with &at=<index> (combined
// with &q if a quality preset is also set) — same re-play path as the
// quality switch, so the saved position is preserved.
async function fetchAudioTracks(mode, id, ext) {
  try {
    const r = await fetch(`/api/tracks/${mode}/${id}.${ext}`);
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data?.audioTracks) ? data.audioTracks : null;
  } catch { return null; }
}
// Build a menu/button label for one audio track: "English · 5.1".
function audioTrackLabel(t) {
  const name = t.label || t.lang || `Track ${t.index + 1}`;
  let ch = "";
  if (t.channels === 1) ch = "mono";
  else if (t.channels === 2) ch = "stereo";
  else if (t.channels === 6) ch = "5.1";
  else if (t.channels === 8) ch = "7.1";
  else if (t.channels) ch = `${t.channels}ch`;
  return ch ? `${name} · ${ch}` : name;
}
// Show the Audio button only when the current item has >1 audio track.
function refreshAudioButton() {
  if (!el.playerAudio) return;
  const p = state.playing;
  const tracks = (p && (p.mode === "movie" || p.mode === "series")) ? (p.audioTracks || []) : [];
  el.playerAudio.hidden = tracks.length <= 1;
  el.playerAudio.classList.toggle("on", !!(p && p.audioTrack));
}
// Apply an audio-track choice mid-playback: re-play through the
// transcoder with &at=<index> appended (force transcode, keep &q).
// Track 0 / default returns to normal playback.
function setAudioTrack(idx) {
  const p = state.playing;
  if (!p) return;
  if ((p.audioTrack || 0) === idx) return;
  play(p.mode, p.item, p.label, p.ext, false, null, idx);
}

let audioMenuEl = null;
function closeAudioMenu() {
  if (audioMenuEl) { audioMenuEl.remove(); audioMenuEl = null; }
}
function toggleAudioMenu() {
  if (audioMenuEl) { closeAudioMenu(); return; }
  const p = state.playing;
  const tracks = (p && p.audioTracks) || [];
  audioMenuEl = document.createElement("div");
  audioMenuEl.className = "cc-menu quality-menu";
  const current = p ? (p.audioTrack || 0) : 0;
  for (const t of tracks) {
    const b = document.createElement("button");
    b.textContent = audioTrackLabel(t);
    if (t.index === current) b.classList.add("active");
    b.onclick = () => { setAudioTrack(t.index); closeAudioMenu(); };
    audioMenuEl.appendChild(b);
  }
  el.player.appendChild(audioMenuEl);
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (audioMenuEl && !audioMenuEl.contains(e.target) && e.target !== el.playerAudio) {
        closeAudioMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}

function refreshLiveRemoteVisibility() {
  const isLive = state.playing && state.playing.mode === "live";
  // Remote is dual-gated: live stream AND the user has enabled the
  // remote in settings. Disabled by default — desktop browsers
  // rarely need it, but Android TV / big-screen users can flip it on.
  const enabled = state.remoteEnabled;
  el.playerRemote.hidden = !(isLive && enabled);
  if (!isLive || !enabled) {
    el.liveRemote.hidden = true;
    el.liveRemoteToggle.hidden = true;
    markPlayingInGuide();
    return;
  }
  if (el.liveRemote.hidden) el.liveRemoteToggle.hidden = false;
  else renderLiveRemote();
  markPlayingInGuide();
}

// Toggle the .playing class on whichever guide row matches state.playing.
// Cheap (just classlist toggles) so it's safe to call after every play().
function markPlayingInGuide() {
  if (!el.guideRows) return;
  for (const r of el.guideRows.querySelectorAll(".guide-row.playing")) {
    r.classList.remove("playing");
  }
  if (!state.playing || state.playing.mode !== "live") return;
  const id = String(state.playing.item.id);
  const row = el.guideRows.querySelector(`.guide-row[data-stream-id="${CSS.escape(id)}"]`);
  if (row) row.classList.add("playing");
}

function flatStreams() {
  const m = ms();
  if (m.streams.length) return m.streams;
  const out = [];
  for (const list of m.byCat.values()) out.push(...list);
  return out;
}

function currentList() {
  const m = ms();
  // Reachable only via a deep-link/URL-restore edge case (applyPath()'s
  // `q` token now routes to renderUnifiedSearch()/showSearchAll() instead
  // — the same path live-typing search already uses — so this never runs
  // in the normal flow). Left in place rather than deleted: flatStreams()
  // still resolves to *something* for live (fully populated) even though
  // it's empty for movie/series/disk post-pagination-migration.
  if (state.query) {
    const q = state.query.toLowerCase();
    return flatStreams().filter(s => s.name.toLowerCase().includes(q)).slice(0, 600);
  }
  // RECENTS/FAVS/MY_LIST/ALL are populated into byCat by selectCategory()
  // (via resolveIdsToItems() or loadCategoryStreams()) before renderGrid()
  // runs, so they now fall through to the generic byCat lookup below —
  // same as any real category.
  // Server-emitted rails that don't map to a real panel category get
  // a `__rail-<slug>` pseudo id. The grid for those just shows the
  // rail's items as-emitted by /api/home — which is already filtered
  // for this profile (kids cert, title language). Covers smart rails
  // ("New on Khouch · 2026", "Action", "Hidden Gems"), Recently Added,
  // and anything else the server flags this way.
  const catId = String(m.activeCatId || "");
  if (catId.startsWith("__rail-") && state.home[state.mode]) {
    const rail = (state.home[state.mode].rails || [])
      .find(r => r.category_id === catId);
    if (rail && Array.isArray(rail.items)) return rail.items;
  }
  return m.byCat.get(String(m.activeCatId)) || [];
}

function applySort(list) {
  // Search results stay in match order; Recents stays in chronological order
  // (most-recent-first is the user-facing definition of that view).
  // Preserve server order for `__rail-` views — the server already
  // sorted them with the rail's semantic (e.g. Recently Added by ts
  // desc, "New on Khouch" by vote_count, etc.). Re-sorting client-side
  // would discard that intent.
  const cid = String(ms().activeCatId || "");
  if (state.query || cid === PSEUDO.RECENTS || cid.startsWith("__rail-")) return list;
  const cfg = state.sort[state.mode];
  // Paginated VOD categories are already ordered server-side (see
  // fetchCategoryPage). Re-sorting the partial loaded pages here would
  // scramble the global order into "first N in name order". lastPlayed
  // isn't server-sortable, so it falls through and sorts the loaded pages
  // client-side (approximate — a rare, inherently-local sort).
  // Live keeps its full catalog resident (the pollIndex backfill replaces
  // byCat in channel/index order), so it must always client-sort. Only VOD
  // modes hold a partial server-sorted slice we must not re-sort.
  if (state.mode !== "live" && ms().catPaging?.has(cid) && ["name", "added", "rating", "year"].includes(cfg.f)) return list;
  const sign = cfg.dir === "asc" ? 1 : -1;
  const lp = state.lastPlayed[state.mode] || {};
  const key = (s) => {
    if (cfg.f === "name") return (s.name || "").toLowerCase();
    if (cfg.f === "added") return Number(s.added) || 0;
    if (cfg.f === "lastPlayed") return lp[s.id] || 0;
    if (cfg.f === "rating") return parseFloat(s.rating) || 0;
    if (cfg.f === "year") return parseInt(s.year) || 0;
    return 0;
  };
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b);
    if (ka < kb) return -1 * sign;
    if (ka > kb) return  1 * sign;
    return 0;
  });
}

function syncSortUI() {
  const cfg = state.sort[state.mode];
  if (el.sortField) el.sortField.value = cfg.f;
  if (el.sortDir) {
    el.sortDir.textContent = cfg.dir === "asc" ? "↑" : "↓";
    el.sortDir.title = cfg.dir === "asc" ? "Ascending — click to flip" : "Descending — click to flip";
  }
}

async function renderUnifiedSearch(q) {
  if (!q) return;
  el.searchAllTitle.textContent = `Results for "${q}"`;
  el.searchAllResults.innerHTML = `<div class="empty">Searching…</div>`;
  let data;
  try {
    const r = await fetch(`/api/search/all?q=${encodeURIComponent(q)}&limit=20`);
    data = await r.json();
  } catch {
    el.searchAllResults.innerHTML = `<div class="empty">Search failed — check connection.</div>`;
    return;
  }
  el.searchAllResults.innerHTML = "";
  const diskResults = Array.isArray(data.disk) ? data.disk : [];
  const total = diskResults.length + data.movie.length + data.series.length + data.live.length;
  if (!total) {
    el.searchAllResults.innerHTML = `<div class="empty">No results for "${q}"</div>`;
    return;
  }
  // When the query matched a TMDB genre name (or alias like
  // "sci-fi"), the server includes a `genre` field in the response.
  // Surface that as a banner at the top of the results so the user
  // knows their search was broadened beyond title matching — they
  // could be looking at "Thriller" titles that don't have the word
  // "thriller" in their name.
  if (data.genre) {
    const banner = document.createElement("div");
    banner.className = "search-all-genre-banner";
    banner.textContent = `Genre: ${data.genre}`;
    el.searchAllResults.appendChild(banner);
  }
  const addSection = (title, items, mode) => {
    if (!items.length) return;
    const sec = document.createElement("div");
    sec.className = "search-all-section";
    const hdr = document.createElement("div");
    hdr.className = "search-all-section-header";
    hdr.innerHTML = `<span class="search-all-section-title">${title}</span><span class="search-all-section-count">${items.length} result${items.length !== 1 ? "s" : ""}</span>`;
    const strip = document.createElement("div");
    strip.className = "search-all-strip";
    const prevMode = state.mode;
    for (const s of items) {
      // Temporarily set mode so channelCard renders the right tile
      // variant. The click handler captures `mode` via opts so the
      // click routing doesn't break when state.mode is restored.
      state.mode = mode;
      strip.appendChild(channelCard(s, { reason: `Search: "${q}"`, mode }));
    }
    state.mode = prevMode;
    sec.append(hdr, strip);
    el.searchAllResults.appendChild(sec);
  };
  // Disk (the owner's local library) ranks first.
  addSection("Disk", diskResults, "disk");
  addSection("Movies", data.movie, "movie");
  addSection("Series", data.series, "series");
  addSection("Live", data.live, "live");
}

function renderGrid() {
  // Kid-safe gate runs before sort so the count reflects what the
  // Kid filtering is server-side now — the index this list is built
  // from already excludes adult-cert items for kid profiles.
  const raw = currentList();
  const list = applySort(raw);
  if (el.gridCount) {
    // Paginated categories only hold a partial slice locally — show the
    // server-reported total, not just what's loaded so far.
    const total = ms().catPaging?.get(String(ms().activeCatId))?.total;
    const n = (Number.isFinite(total) && total > list.length) ? total : list.length;
    el.gridCount.textContent = n === 1 ? "1 item" : `${n.toLocaleString()} items`;
  }
  syncSortUI();
  el.grid.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.query
      ? `No matches for "${state.query}"`
      : ms().activeCatId === PSEUDO.RECENTS
        ? "Nothing recent yet."
        : ms().activeCatId === PSEUDO.FAVS
          ? "Star something to favorite it."
          : ms().activeCatId === PSEUDO.MY_LIST
            ? "Tap + on a card or in the detail view to add it to your list."
            : "Empty category.";
    el.grid.appendChild(empty);
    return;
  }
  // Reason for grid view = either the search query, the pseudo-rail
  // ("Recently Played" / "Favorites" / "My List"), or the category
  // name. Same affordance as the rails — hover or look at the badge
  // to see why a tile is on screen.
  const ctxId = ms().activeCatId;
  const reason = state.query
    ? `Search: "${state.query}"`
    : ctxId === PSEUDO.RECENTS ? "Recently Played"
    : ctxId === PSEUDO.FAVS ? "Favorites"
    : ctxId === PSEUDO.MY_LIST ? "Watch Later"
    : ctxId === PSEUDO.ALL ? `All ${state.mode === "movie" ? "movies" : state.mode === "series" ? "series" : "channels"}`
    : (ms().categories.find(c => String(c.category_id) === String(ctxId))?.category_name || null);
  const frag = document.createDocumentFragment();
  for (const s of list) frag.appendChild(channelCard(s, reason ? { reason } : {}));
  el.grid.appendChild(frag);
  setupGridPagingObserver();
}

// Infinite-scroll trigger for category browsing. Mirrors
// setupGuideObserver()'s disconnect-and-rebuild-per-render pattern (rather
// than the poster observer's self-unobserving singleton) since renderGrid()
// already does a full innerHTML rebuild every call, so any prior sentinel
// is already gone — recreating the observer each time needs no extra dedup
// beyond loadNextCategoryPage()'s own `loading` guard.
let _gridObserver = null;
function setupGridPagingObserver() {
  if (_gridObserver) { _gridObserver.disconnect(); _gridObserver = null; }
  const m = ms();
  const cid = String(m.activeCatId);
  // Mirror currentList()'s branch ordering — real categories AND
  // PSEUDO.ALL (fetchCategoryPage omits category_id for it) both paginate
  // via byCat/catPaging. Recents/Favorites/My List are small user-curated
  // sets resolved in one shot by selectCategory() (no catPaging entry, so
  // the lookup below naturally no-ops for them). Search and rail views
  // are unaffected.
  const isPlainCategory = !state.query
    && m.activeCatId !== PSEUDO.RECENTS
    && m.activeCatId !== PSEUDO.FAVS
    && m.activeCatId !== PSEUDO.MY_LIST
    && !cid.startsWith("__rail-");
  if (!isPlainCategory) return;
  const paging = m.catPaging.get(cid);
  if (!paging || !paging.hasMore) return;

  const sentinel = document.createElement("div");
  sentinel.className = "grid-sentinel";
  sentinel.textContent = "Loading more…";
  el.grid.appendChild(sentinel);

  const mode = state.mode; // capture — don't read state.mode after the await below
  _gridObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      loadNextCategoryPage(mode, cid).then(() => {
        if (!el.gridView?.hidden) renderGrid();
      });
    }
  }, { root: el.grid, rootMargin: "300px" });
  _gridObserver.observe(sentinel);
}

function channelCard(s, opts = {}) {
  const card = document.createElement("div");
  // Effective mode for this card. In the Hindi collection view state.mode
  // is the stale underlying mode the user was last on (often "live"), not
  // what these tiles are — so derive movie/series from the collection
  // sub-mode. Drives the card VARIANT (poster 2:3 vs live 16:10 aspect),
  // click-through, and the TMDB poster upgrade. opts.mode wins when the
  // caller pins it (e.g. the unified search-all view).
  const cardMode = opts.mode || (state.view === "collection" ? state.collectionMode : state.mode);
  const variant = cardMode === "live" ? "live" : "poster";
  card.className = `channel ${variant}`;
  // Tooltip carries the full provenance so a user can hover any card
  // and answer "why is this on my home?". Rail name + tag list +
  // category name when known.
  const cat = state.modes[state.mode]?.categories?.find(c => String(c.category_id) === String(s.category_id));
  const tagList = Array.isArray(s.tags) ? s.tags.join(", ") : "";
  const tipParts = [s.name];
  if (opts.reason) tipParts.push(`From: ${opts.reason}`);
  if (cat?.category_name && cat.category_name !== opts.reason) tipParts.push(`Category: ${cat.category_name}`);
  if (tagList) tipParts.push(`Tags: ${tagList}`);
  card.title = tipParts.join(" • ");
  card.onclick = (e) => {
    if (e.target.classList.contains("star")) return;
    if (e.target.classList.contains("thumb")) return;
    if (e.target.classList.contains("cw-hide")) return;
    if (cardMode === "series") openSeries(s);
    else if (cardMode === "movie") openMovie(s, "movie");
    else if (cardMode === "disk") openMovie(s, "disk");
    else play("live", s);
  };

  // Hide ✕ affordance for tiles on the Continue Watching rail (#48).
  // Removes both `recents[mode]` and `progress[mode:id]` server-side
  // so the title disappears from the merged rail entirely. Click is
  // swallowed via the e.target check above so the tile body doesn't
  // double-navigate into the title.
  if (opts.hideable) {
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "cw-hide";
    hide.title = "Hide from Continue Watching";
    hide.setAttribute("aria-label", `Hide ${s.name} from Continue Watching`);
    hide.textContent = "✕";
    hide.onclick = (e) => {
      e.stopPropagation();
      removeRecent(cardMode, s.id);
    };
    card.appendChild(hide);
  }

  const logo = document.createElement("div");
  logo.className = "logo";
  const initialsEl = document.createElement("span");
  initialsEl.className = "logo-initials";
  initialsEl.textContent = initials(s.name);
  logo.appendChild(initialsEl);
  // Icon + poster loading are both fully lazy via the shared
  // _posterObserver (see getPosterObserver()) — deferred until the card
  // scrolls near the viewport, not fired at build time. At catalog scale
  // (paginated grid pages, rails, search results — potentially thousands
  // of cards across a scroll session) firing new Image() for every card
  // synchronously at build time was its own freeze, independent of the
  // grid/Guide pagination fixes: same URL is already known up front, only
  // the actual network fetch needs to wait for visibility.
  if (s.icon) card.dataset.icon = s.icon;
  card.dataset.posterId = String(s.id);
  card.dataset.posterMode = cardMode;
  observePosterCard(card, logo);

  // Progress bar overlaid on the logo for items with saved playback
  // position. Series surfaces the last-watched episode's progress.
  let progPct = null;
  if (state.mode === "movie" || state.mode === "disk") {
    const p = state.progress[`${state.mode}:${s.id}`];
    if (p && p.d) progPct = Math.min(99, Math.max(2, Math.floor((p.p / p.d) * 100)));
  } else if (state.mode === "series") {
    const last = state.lastEpisode[s.id];
    if (last) {
      const p = state.progress[`series:${last.episode_id}`];
      if (p && p.d) progPct = Math.min(99, Math.max(2, Math.floor((p.p / p.d) * 100)));
    }
  }
  if (progPct != null) {
    const bar = document.createElement("div");
    bar.className = "progress-bar";
    bar.innerHTML = `<span style="width:${progPct}%"></span>`;
    logo.appendChild(bar);
  }

  // MKV tiles are guaranteed to go through the server-side ffmpeg
  // → HLS pipeline (Chrome won't decode mkv natively at any codec).
  // Surface that on the tile so the user knows to expect a slower
  // first-segment wait and isn't surprised by the transcode toast.
  if (state.mode !== "live" && (s.container || "").toLowerCase() === "mkv") {
    const badge = document.createElement("span");
    badge.className = "container-badge";
    badge.textContent = "MKV";
    logo.appendChild(badge);
  }

  // Audio-channel badge — 5.1 / 7.1 marker on titles whose source
  // audio is multi-channel. Server's qualityCache fills in
  // s.audio_channels via the offline probe + lazy /api/movie/info
  // path. Anchored top-left so it doesn't fight the MKV badge
  // (top-right) or rating/cert (bottom corners).
  if (state.mode !== "live" && s.audio_channels) {
    const ch = Number(s.audio_channels);
    const label = ch >= 8 ? "7.1" : ch >= 6 ? "5.1" : null;
    if (label) {
      const ab = document.createElement("span");
      ab.className = "audio-badge";
      ab.textContent = label;
      logo.appendChild(ab);
    }
  }

  if (state.mode !== "live" && s.rating) {
    const badge = document.createElement("div");
    badge.className = "rating-badge";
    badge.textContent = `★ ${parseFloat(s.rating).toFixed(1)}`;
    logo.appendChild(badge);
  }
  const cert = s.us_cert || _posterMem.get(`${state.mode}:${s.id}`)?.us_cert;
  if (state.mode !== "live" && cert) {
    const certBadge = document.createElement("div");
    certBadge.className = "cert-badge";
    certBadge.textContent = cert;
    logo.appendChild(certBadge);
  }

  const name = document.createElement("div");
  name.className = "name";
  name.textContent = s.name;

  card.append(logo, name);

  // Small dim line under the title. Prefer the server's per-tile
  // rationale (the "For You" / "Tonight" reason) — shown in any mode,
  // including Live's Tonight rail. Otherwise fall back to the "why is
  // this here?" provenance (rail / category / chip context), which is
  // noisy on Live so it stays movie/series-only.
  const reasonText = s.pickReason || (state.mode !== "live" ? opts.reason : null);
  if (reasonText) {
    const reason = document.createElement("div");
    reason.className = "card-reason";
    reason.textContent = reasonText;
    if (s.pickReason) reason.title = s.pickReason;
    card.appendChild(reason);
  }

  // EPG-matched live search result — the server attached the
  // programme whose title matched the query. Show it so the user
  // sees WHY a channel named nothing like their query is here
  // ("FOX" for "2026 fifa" → "Now · FIFA World Cup 2026").
  if (state.mode === "live" && s.programme) {
    const sub = document.createElement("div");
    sub.className = "sub";
    const startMs = s.programme.start_ts * 1000;
    const when = startMs <= Date.now()
      ? "Now"
      : new Date(startMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
    sub.textContent = `${when} · ${s.programme.title}`;
    sub.title = sub.textContent;
    card.appendChild(sub);
  }

  if (state.mode === "series") {
    const last = state.lastEpisode[s.id];
    if (last) {
      const sub = document.createElement("div");
      sub.className = "sub";
      const epProg = state.progress[`series:${last.episode_id}`];
      const pct = epProg && epProg.d ? Math.min(99, Math.floor((epProg.p / epProg.d) * 100)) : null;
      const head = `S${String(last.season).padStart(2, "0")}E${String(last.episode_num).padStart(2, "0")}`;
      sub.textContent = pct != null
        ? `Resume ${head} at ${pct}% · ${last.title}`
        : `Last: ${head} · ${last.title}`;
      sub.title = sub.textContent;
      card.appendChild(sub);
    }
  } else if (state.mode === "movie" || state.mode === "disk") {
    const prog = state.progress[`${state.mode}:${s.id}`];
    const ts = state.lastPlayed[state.mode]?.[s.id];
    if (prog) {
      const sub = document.createElement("div");
      sub.className = "sub";
      const pct = prog.d ? Math.min(99, Math.floor((prog.p / prog.d) * 100)) : null;
      sub.textContent = pct != null
        ? `Resume at ${formatPos(prog.p)} (${pct}%)`
        : `Resume at ${formatPos(prog.p)}`;
      sub.title = ts ? `Last played ${new Date(ts).toLocaleString()}` : sub.textContent;
      card.appendChild(sub);
    } else if (ts) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `Last played ${relativeTime(ts)}`;
      sub.title = new Date(ts).toLocaleString();
      card.appendChild(sub);
    }
  } else {
    const ts = state.lastPlayed.live?.[s.id];
    if (ts) {
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `Last played ${relativeTime(ts)}`;
      sub.title = new Date(ts).toLocaleString();
      card.appendChild(sub);
    }
  }

  const star = document.createElement("div");
  star.className = "star" + (state.favorites[state.mode].has(s.id) ? " on" : "");
  star.textContent = "★";
  star.title = "Favorite";
  star.onclick = (e) => {
    e.stopPropagation();
    toggleFav(state.mode, s.id);
    star.classList.toggle("on", state.favorites[state.mode].has(s.id));
  };

  // + button = add to My List. Sits next to the ★ — two distinct
  // affordances for two distinct actions ("I love this" vs "I'll
  // watch this later"). Glows accent when in the list.
  const plus = document.createElement("div");
  plus.className = "plus" + (state.myList[state.mode].has(s.id) ? " on" : "");
  plus.textContent = state.myList[state.mode].has(s.id) ? "✓" : "+";
  plus.title = "Add to My List";
  plus.onclick = (e) => {
    e.stopPropagation();
    toggleMyList(state.mode, s.id);
    const on = state.myList[state.mode].has(s.id);
    plus.classList.toggle("on", on);
    plus.textContent = on ? "✓" : "+";
    plus.title = on ? "Remove from My List" : "Add to My List";
  };

  card.appendChild(star);
  card.appendChild(plus);

  // Thumbs — explicit taste signal, VOD only (live is channels, not
  // titles). Uses cardMode so collection/search-all tiles record against
  // the right mode. 👍/👎 are mutually exclusive; toggling one re-syncs
  // both so the pair never shows lit together.
  if (cardMode !== "live") {
    const syncThumbs = () => {
      up.classList.toggle("on", state.feedback.up[cardMode].has(s.id));
      down.classList.toggle("on", state.feedback.down[cardMode].has(s.id));
    };
    const up = document.createElement("div");
    up.className = "thumb up" + (state.feedback.up[cardMode].has(s.id) ? " on" : "");
    up.textContent = "👍";
    up.title = "More like this";
    up.onclick = (e) => { e.stopPropagation(); toggleFeedback(cardMode, s.id, "up"); syncThumbs(); };
    const down = document.createElement("div");
    down.className = "thumb down" + (state.feedback.down[cardMode].has(s.id) ? " on" : "");
    down.textContent = "👎";
    down.title = "Not for me";
    down.onclick = (e) => { e.stopPropagation(); toggleFeedback(cardMode, s.id, "down"); syncThumbs(); };
    card.appendChild(up);
    card.appendChild(down);
  }
  return card;
}

function initials(name) {
  return (name || "").replace(/[^A-Za-z0-9 ]/g, "").trim().split(/\s+/).slice(0, 3).map(w => w[0]).join("").toUpperCase().slice(0, 4) || "TV";
}

function toggleFav(mode, id) {
  const set = state.favorites[mode];
  if (set.has(id)) set.delete(id); else set.add(id);
  localStorage.setItem(`favs:${mode}`, JSON.stringify([...set]));
  refreshView();
  pushUserState();
}

// My List = Netflix "+ Watch later". Same shape as toggleFav but on
// its own set. Toggles also re-render whatever view is open so the
// My List rail / pseudo-category / button states update instantly.
function toggleMyList(mode, id) {
  const set = state.myList[mode];
  if (set.has(id)) set.delete(id); else set.add(id);
  localStorage.setItem(`myList:${mode}`, JSON.stringify([...set]));
  refreshView();
  pushUserState();
}

// Taste feedback toggle. up/down are mutually exclusive per id — setting
// one clears the other. Clicking the lit direction again clears it.
// Fire-and-forget through the same debounced pushUserState as favorites.
function toggleFeedback(mode, id, dir) {
  const on = state.feedback[dir][mode];
  const off = state.feedback[dir === "up" ? "down" : "up"][mode];
  if (on.has(id)) on.delete(id);
  else { on.add(id); off.delete(id); }
  refreshView();
  pushUserState();
}

// Same mutation as toggleFeedback(), but for the Hero's own thumbs.
// Calls renderRails() instead of refreshView()/renderHome() — same
// reason the chip-strip click handler avoids refreshView() (see its
// comment above): rebuilding the hero here would reset _heroIdx to 0
// and discard whatever slide the user was looking at when they rated
// it. renderHero() is only ever called alongside renderRails() when
// state.view === "home" (never from renderCollection()), and the Hero
// itself is only visible in that view, so skipping the hero rebuild
// here is always correct.
function toggleFeedbackFromHero(mode, id, dir) {
  const on = state.feedback[dir][mode];
  const off = state.feedback[dir === "up" ? "down" : "up"][mode];
  if (on.has(id)) on.delete(id);
  else { on.add(id); off.delete(id); }
  renderRails();
  pushUserState();
}

function pushRecent(mode, id) {
  state.recents[mode] = [id, ...state.recents[mode].filter(x => x !== id)].slice(0, 24);
  localStorage.setItem(`recents:${mode}`, JSON.stringify(state.recents[mode]));
  refreshView();
  pushUserState();
}

// Hide an item from the merged Continue Watching rail (#48). Wipes
// both the recents entry (so it's not in "I pressed play") and the
// progress entry (so the resume bar is gone) in one round-trip.
// Optimistically updates local state and refreshes the view; the
// pushUserState() sync is a belt-and-braces fallback if the DELETE
// network call drops.
function removeRecent(mode, id) {
  state.recents[mode] = (state.recents[mode] || []).filter((x) => x !== id);
  delete state.progress[`${mode}:${id}`];
  localStorage.setItem(`recents:${mode}`, JSON.stringify(state.recents[mode]));
  fetch(`/api/user-state/recents/${mode}/${encodeURIComponent(id)}`, { method: "DELETE" })
    .catch(() => pushUserState());
  refreshView();
}

function recordPlayEvent(mode, id) {
  // Update locally so the UI reflects it immediately on the next render,
  // and POST to the server so the timestamp persists across browsers.
  const ts = Date.now();
  state.lastPlayed[mode][String(id)] = ts;
  fetch(`/api/play-event/${mode}/${encodeURIComponent(id)}`, { method: "POST" }).catch(() => {});
}

// Resume tracking: for movies and non-transcoded series episodes we
// periodically POST the current playback position to the server so the
// next session (any device) can pick up where this one left off. Live and
// transcoded streams are excluded — both use sliding-window manifests
// where seeking back has no meaning.
let _progressKey = null;
let _progressTimer = null;
function clearProgressTracking() {
  if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
  _progressKey = null;
}
function attachProgressTracking(key) {
  clearProgressTracking();
  _progressKey = key;
  _progressTimer = setInterval(() => {
    if (!_progressKey || el.video.paused || el.video.ended) return;
    sendProgress();
  }, 15_000);
}
function sendProgress() {
  if (!_progressKey) return;
  const cur = el.video.currentTime;
  if (!Number.isFinite(cur) || cur < 0) return;
  // For transcoded movies the video element's currentTime is relative
  // to the playlist (which itself starts at transcodeAnchorSecs of the
  // source). Real source position is anchor + cur — same math the
  // scrubber uses. Direct-play streams have anchor=0 so this collapses
  // to the old behavior.
  const anchor = (state.playing && state.playing.transcode && state.playing.transcodeAnchorSecs) || 0;
  const pos = anchor + cur;
  // Authoritative duration: for transcodes el.video.duration only
  // covers the encoded-so-far HLS playlist (e.g. "14 min" for a 158-min
  // movie), which would constantly trip the finished/95% rule and wipe
  // the entry. Wait for fullDurationSecs before saving on a transcode
  // — otherwise the first tick can race the /api/movie/info fetch and
  // spuriously mark the movie finished.
  const fullDur = (state.playing && state.playing.fullDurationSecs) || 0;
  const playlistDur = el.video.duration;
  const isTranscode = !!(state.playing && state.playing.transcode);
  if (isTranscode && !(fullDur > 0)) return;
  const dur = isTranscode ? fullDur : playlistDur;
  const [mode, id] = _progressKey.split(":");
  const validDur = Number.isFinite(dur) && dur > 0 ? dur : null;
  const finished = validDur != null && (pos >= validDur - 30 || pos >= validDur * 0.95);
  if (pos < 30 || finished) {
    delete state.progress[_progressKey];
  } else {
    state.progress[_progressKey] = { p: pos, d: validDur, t: Date.now() };
  }
  fetch(`/api/progress/${mode}/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ position: pos, duration: validDur }),
    keepalive: true,
  }).catch(() => {});
}
function formatPos(secs) {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

// Per-channel retry counter for manifest-load failures. Module-level
// so it survives the play()-on-retry that replaces state.playing with
// a fresh object. Reset on a successful manifest parse.
const _manifestRetries = new Map();

// Tells the server to kill ffmpeg transcoders. Without arguments, kills
// every transcoder (used on closePlayer / beforeunload — nothing should
// be playing). With { mode, id }, kills only that specific transcoder
// (used in play() to tear down the *previous* stream by id without
// risking a race where the new stream's ffmpeg has already spawned and
// gets killed by an in-flight kill-all POST).
//
// Either way the panel's max_connections=1 limit is respected: the
// previous upstream connection is released before the next one opens.
function stopServerStreams(specific) {
  return fetch("/api/transcode/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(specific || {}),
    keepalive: true,
  }).catch(() => {});
}

// --- TMDB poster lookup --------------------------------------------------
// In-memory cache of TMDB responses keyed by `${mode}:${id}` so a card
// scrolling in/out of view doesn't refetch. Inflight dedupe via a
// Promise map. Live mode is hard-no — TMDB doesn't index broadcast
// channels and the panel's stream_icon is the only authoritative source.
const _posterMem = new Map();      // key → { tmdb_id, poster, backdrop, plot, year, rating, runtime, genres, tmdb_title, us_cert }
const _posterInflight = new Map(); // key → Promise

// Compute the active kid age from the profile's stored birth year.
// Returns null when the profile isn't a kids profile. Kept as a
// pure function so the same call works at bootstrap and on profile
// switch.
function deriveKidsAge(profile) {
  if (!profile || !Number.isFinite(profile.kidsBirthYear)) return null;
  const age = new Date().getFullYear() - profile.kidsBirthYear;
  if (age < 0 || age > 17) return null;
  return age;
}
// US certification thresholds by age. An item is kid-safe if its
// US cert is in the allowed set for the kid's age. Live mode is
// always allowed (TMDB doesn't index broadcast channels, and the
// catalog filter is the right primary control there).
function allowedCertsForAge(age) {
  if (!Number.isFinite(age)) return null;
  // Prefer the server's tiers when present — tightening or relaxing
  // a threshold is then a server-only change. Fallback table below
  // matches the original (G/TV-Y/TV-G always, PG/TV-Y7/TV-PG at 7+,
  // PG-13 at 10+, TV-14 at 13+; R/NC-17/TV-MA never).
  const tiers = state.filterConfig?.kidsCertTiers;
  if (Array.isArray(tiers) && tiers.length) {
    const out = new Set();
    for (const t of tiers) {
      if (age >= (t.minAge || 0) && Array.isArray(t.add)) {
        for (const c of t.add) out.add(c);
      }
    }
    return out;
  }
  const movies = ["G"];
  const tv = ["TV-Y", "TV-G"];
  if (age >= 7) { movies.push("PG"); tv.push("TV-Y7", "TV-PG"); }
  if (age >= 10) { movies.push("PG-13"); }
  if (age >= 13) { tv.push("TV-14"); }
  return new Set([...movies, ...tv]);
}
// Kids cert filtering is now done entirely server-side (see
// `makeKidsBlocker` in server.js, applied to /api/home,
// /api/index/{mode}, /api/{mode}/streams, /api/search/all, and
// /api/search/{mode}). The client trusts the server's verdict.
// This stub is kept so call sites don't need conditional invocation.
function isKidSafe(_mode, _item) { return true; }

// In kid-profile mode the cert gate hides items whose rating we
// haven't fetched yet — but those items never become cards, so the
// IntersectionObserver path never warms their cache. This eager
// pre-warmer fires posterFor() for a candidate list in small chunks
// and re-renders home/grid once a chunk settles. Capped at the
// first 100 items per call so a 600-result search doesn't blast
// TMDB; the rest fill in as the user opens narrower views.
const KID_PREWARM_CAP = 100;
const KID_PREWARM_CHUNK = 8;
let _kidPrewarmReRender = null;
function prewarmKidCerts(mode, items) {
  if (!Number.isFinite(state.kidsAge) || mode === "live" || !items?.length) return;
  const todo = [];
  for (const it of items) {
    const key = `${mode}:${it.id}`;
    if (!_posterMem.has(key) && !_posterInflight.has(key)) todo.push(it.id);
    if (todo.length >= KID_PREWARM_CAP) break;
  }
  if (!todo.length) return;
  // Debounced re-render: after each chunk lands, trigger a single
  // refresh on the next animation frame instead of one per resolve.
  const scheduleReRender = () => {
    if (_kidPrewarmReRender) return;
    _kidPrewarmReRender = requestAnimationFrame(() => {
      _kidPrewarmReRender = null;
      if (!el.gridView?.hidden) renderGrid();
      else if (!el.home?.hidden) renderHome();
    });
  };
  let i = 0;
  const step = () => {
    if (i >= todo.length) return;
    const batch = todo.slice(i, i + KID_PREWARM_CHUNK);
    i += KID_PREWARM_CHUNK;
    Promise.all(batch.map(id => posterFor(mode, id).catch(() => null)))
      .then(() => { scheduleReRender(); step(); });
  };
  step();
}

function posterFor(mode, id) {
  if (mode === "live") return Promise.resolve(null);
  const key = `${mode}:${id}`;
  if (_posterMem.has(key)) return Promise.resolve(_posterMem.get(key));
  if (_posterInflight.has(key)) return _posterInflight.get(key);
  const p = (async () => {
    try {
      const r = await fetch(`/api/poster/${mode}/${encodeURIComponent(id)}`);
      if (!r.ok) { _posterMem.set(key, null); return null; }
      const d = await r.json();
      // Treat "no TMDB key configured" same as "no match" — null cache.
      const useful = d && (d.poster || d.backdrop || d.plot || d.year);
      _posterMem.set(key, useful ? d : null);
      return useful ? d : null;
    } catch {
      _posterMem.set(key, null);
      return null;
    }
  })().finally(() => _posterInflight.delete(key));
  _posterInflight.set(key, p);
  return p;
}

// One shared IntersectionObserver for all rendered cards. When a card
// scrolls within 300px of the viewport: (1) lazily load the panel-
// provided icon stashed on card.dataset.icon (cheap — the URL is already
// known, only the fetch itself was deferred), then (2) for non-live
// modes, fetch the TMDB-enriched poster and swap it in as an upgrade if
// one exists. Cards are observed once via `observePosterCard()` and
// unobserved here on first intersection — never re-observed, so no
// re-fetch guard is needed (unlike the Guide's per-page-recreated
// observer, which does need one).
let _posterObserver = null;
function getPosterObserver() {
  if (_posterObserver) return _posterObserver;
  _posterObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const card = e.target;
      _posterObserver.unobserve(card);
      const logo = card.querySelector(".logo");
      if (!logo) continue;
      if (card.dataset.icon) {
        const img = new Image();
        img.referrerPolicy = "no-referrer";
        img.onload = () => {
          if (img.naturalWidth > 4 && img.naturalHeight > 4) {
            logo.style.backgroundImage = `url("${card.dataset.icon}")`;
            logo.querySelector(".logo-initials")?.remove();
          }
        };
        img.src = card.dataset.icon;
      }
      const mode = card.dataset.posterMode;
      const id = card.dataset.posterId;
      if (!mode || !id) continue;
      // Guarded to non-live so live grid cards don't fire pointless TMDB
      // lookups (posterFor short-circuits null for live, but skip the
      // call entirely).
      if (mode !== "live") {
        posterFor(mode, id).then((d) => {
          if (!d || !d.poster) return;
          const img = new Image();
          img.referrerPolicy = "no-referrer";
          img.onload = () => {
            logo.style.backgroundImage = `url("${d.poster}")`;
            logo.querySelector(".logo-initials")?.remove();
          };
          img.src = d.poster;
        });
      }
    }
  }, { rootMargin: "300px" });
  return _posterObserver;
}
function observePosterCard(card, logo) {
  getPosterObserver().observe(card);
}

function clearPosterCache(mode, id) {
  const key = `${mode}:${id}`;
  _posterMem.delete(key);
  _posterInflight.delete(key);
  return fetch(`/api/poster/${mode}/${encodeURIComponent(id)}`, { method: "DELETE" })
    .then(r => r.ok)
    .catch(() => false);
}

// Episode-stills lookup. Resolves to a { panel_episode_id → still_url } map.
const _stillsMem = new Map();      // `series:<id>:season:<n>` → { stills }
const _stillsInflight = new Map();
function stillsForSeason(seriesId, seasonNum) {
  const key = `series:${seriesId}:season:${seasonNum}`;
  if (_stillsMem.has(key)) return Promise.resolve(_stillsMem.get(key));
  if (_stillsInflight.has(key)) return _stillsInflight.get(key);
  const p = (async () => {
    try {
      const r = await fetch(`/api/poster/series/${encodeURIComponent(seriesId)}/season/${seasonNum}`);
      if (!r.ok) { _stillsMem.set(key, {}); return {}; }
      const d = await r.json();
      const stills = (d && d.stills) || {};
      _stillsMem.set(key, stills);
      return stills;
    } catch {
      _stillsMem.set(key, {});
      return {};
    }
  })().finally(() => _stillsInflight.delete(key));
  _stillsInflight.set(key, p);
  return p;
}

// Debounced full-state PUT so favorites / recents / watched / last-
// episode bookmark sync to the server (and across other devices via
// the next bootstrap there). Optimistic updates remain instant locally;
// the server write just trails by a few hundred ms.
let _userStatePushTimer = null;
function pushUserState() {
  clearTimeout(_userStatePushTimer);
  _userStatePushTimer = setTimeout(() => {
    const body = {
      favorites: {
        live:   [...state.favorites.live],
        movie:  [...state.favorites.movie],
        series: [...state.favorites.series],
      },
      myList: {
        live:   [...state.myList.live],
        movie:  [...state.myList.movie],
        series: [...state.myList.series],
      },
      feedback: {
        up: {
          movie:  [...state.feedback.up.movie],
          series: [...state.feedback.up.series],
          disk:   [...state.feedback.up.disk],
        },
        down: {
          movie:  [...state.feedback.down.movie],
          series: [...state.feedback.down.series],
          disk:   [...state.feedback.down.disk],
        },
      },
      recents:    state.recents,
      watched:    [...state.watched],
      lastEpisode: state.lastEpisode,
      filter: {
        onboarded: state.filter.onboarded,
        groups: {
          live:   [...state.filter.groups.live],
          movie:  [...state.filter.groups.movie],
          series: [...state.filter.groups.series],
        },
      },
      remoteEnabled: state.remoteEnabled,
      epgWindowHoursForward: state.epgWindowHoursForward,
    };
    fetch("/api/user-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }, 400);
}

// Player has three viewing modes: theater (large, fills the content
// column), mini (small floating bottom-right overlay), and fullscreen
// (browser-native). The mode is reflected in a data-mode attribute so
// CSS does the layout work; JS only flips the attribute and toggles the
// body class that hides #content when theater is active.
function setPlayerMode(mode) {
  if (mode === "fullscreen") {
    // Fullscreen the WHOLE #player div, not just <video>. Otherwise the
    // browser's native fullscreen view drops our custom overlay (with
    // the scrubber that knows the real movie length via
    // state.playing.fullDurationSecs); native controls only show
    // video.duration, which on a transcoded HLS stream is the
    // encoded-so-far length (e.g. "4 min" of a 2h movie). Fullscreening
    // #player keeps our scrubber on screen and the duration honest.
    const target = el.player;
    // Fall back to fullscreening the <video> itself (losing the custom
    // overlay) when the whole-player request fails or isn't supported —
    // covers two real mobile cases: (1) some mobile Chrome builds reject
    // Element.requestFullscreen() on a non-video element in regular
    // mobile-site mode while allowing it under "Request desktop site"
    // (the promise just rejects; our old .catch(()=>{}) silently ate
    // that, so tapping Fullscreen did nothing), and (2) iOS Safari never
    // implements requestFullscreen()/webkitRequestFullscreen() on
    // arbitrary elements at all — only the <video> element supports
    // fullscreen there, via the older webkitEnterFullscreen() API.
    const videoFallback = () => {
      if (el.video.requestFullscreen) el.video.requestFullscreen().catch(() => {});
      else if (el.video.webkitRequestFullscreen) el.video.webkitRequestFullscreen();
      else if (el.video.webkitEnterFullscreen) el.video.webkitEnterFullscreen();
    };
    if (target.requestFullscreen) target.requestFullscreen().catch(videoFallback);
    else if (target.webkitRequestFullscreen) target.webkitRequestFullscreen();
    else videoFallback();
    return; // fullscreen doesn't change data-mode; user exits via Esc
  }
  if (!mode) {
    el.player.removeAttribute("data-mode");
    document.body.classList.remove("player-theater");
    return;
  }
  el.player.setAttribute("data-mode", mode);
  document.body.classList.toggle("player-theater", mode === "theater");
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

async function resolveStreamUrl(mode, id, ext, anchorSecs, diskSel) {
  // anchorSecs > 0 asks the server to spawn ffmpeg with -ss <secs>
  // so the returned transcode playlist begins at that source offset.
  // Used when the user scrubs / seeks past the already-encoded edge
  // of the current playlist — re-anchor instead of failing silently.
  // diskSel ({audio, sub}) forwards the disk track selection so the
  // server can switch the audio track or burn in an image subtitle.
  const params = [];
  if (anchorSecs && anchorSecs > 0) params.push(`t=${Math.floor(anchorSecs)}`);
  if (diskSel && Number.isFinite(diskSel.audio)) params.push(`audio=${diskSel.audio}`);
  if (diskSel && Number.isFinite(diskSel.sub)) params.push(`sub=${diskSel.sub}`);
  const qs = params.length ? `?${params.join("&")}` : "";
  const r = await fetch(`/api/stream/${mode}/${id}.${ext}${qs}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Source-side full movie duration (in seconds), pulled from
// /api/movie/info. The transcoded HLS playlist's reported duration
// only covers what ffmpeg has encoded so far, so without this the
// scrubber would say "this 2h38m movie is 14 minutes long" — which
// is what made the user think they couldn't seek forward.
async function fetchFullDurationSecs(mode, id) {
  if (mode !== "movie") return null;
  try {
    const r = await fetch(`/api/${mode}/info/${id}`);
    if (!r.ok) return null;
    const data = await r.json();
    const n = data?.info?.duration_secs;
    return typeof n === "number" && n > 0 ? n : null;
  } catch { return null; }
}

function pickExt(mode, item) {
  if (mode === "live") return "m3u8";
  return item.container || "mp4";
}

// Direct-play stall recovery. The panel drops or corrupts long-lived
// connections mid-stream; the <video> then buffers forever (spinner, no
// error event to hook). If playback is wedged for STALL_MS while we intend
// to play, fall back to the server transcode (which is error-resilient —
// it skips corrupt frames — and reconnects), anchored at the current
// position. One-shot: only fires while direct-playing, never once we're
// already on the transcode (hls.js owns recovery there).
let _stallWatch = null;
function clearStallWatch() { if (_stallWatch) { clearInterval(_stallWatch); _stallWatch = null; } }
function armStallWatch() {
  clearStallWatch();
  const STALL_MS = 10000;
  let lastT = -1, since = Date.now();
  _stallWatch = setInterval(() => {
    const v = el.video, p = state.playing;
    if (!p || p.transcode || v.paused || v.ended || v.seeking) { since = Date.now(); lastT = v.currentTime; return; }
    if (v.currentTime !== lastT) { lastT = v.currentTime; since = Date.now(); return; }
    if (v.readyState >= 3 /* HAVE_FUTURE_DATA */) { since = Date.now(); return; }
    if (Date.now() - since < STALL_MS) return;
    clearStallWatch();
    toast("Stream stalled — switching to transcode…", 3000);
    play(p.mode, p.item, p.label, p.ext, true);
  }, 2000);
}

async function play(mode, item, label, forceExt, useTranscode, diskSel, audioTrack) {
  saveScroll();
  clearStallWatch();
  clearProgressTracking();
  // Kill the *previous* transcoder by id (not all) so we can never have
  // two upstream panel connections live at once, while also avoiding a
  // race where a fire-and-forget kill-all POST arrives at the server
  // after the new stream's ffmpeg has already spawned.
  if (state.playing) {
    stopServerStreams({ mode: state.playing.mode, id: String(state.playing.item.id) });
  }
  // Manual quality override — anything but "auto" forces the
  // transcoder at that preset regardless of the codec-fallback flag.
  // "auto" keeps today's behavior: panel-direct first, transcode only
  // if hls.js raises fragParsingError (handled below).
  const userQuality = state.quality;
  const forceQuality = userQuality !== "auto";
  const ext = forceExt || pickExt(mode, item);
  // Resume into a transcoded movie at the saved source-offset by
  // priming the very first /api/stream call with ?t=<secs>. Direct-play
  // resumes work via a video.currentTime seek after loadedmetadata
  // (see the post-attach block below) — they leave the anchor at 0.
  // We only know up-front that we *will* transcode when MKV / user
  // forced a quality / caller passed useTranscode; audio-codec
  // fallback flips state.playing.transcode later but those are live
  // channels (no resume anyway).
  // A non-default audio track (panel movie/series) forces the transcoder,
  // which remaps 0:a:<at> — same shape as a forced quality preset.
  const forceAudio = Number.isFinite(audioTrack) && audioTrack > 0;
  const willTranscode = !!useTranscode || forceQuality || forceAudio || (mode !== "live" && ext === "mkv");
  const resumeKey = mode === "live" ? null : `${mode}:${item.id}`;
  const resumeSaved = resumeKey ? state.progress[resumeKey] : null;
  const resumeAnchorSecs = (willTranscode && resumeSaved && Number.isFinite(resumeSaved.p) && resumeSaved.p > 30)
    ? Math.floor(resumeSaved.p)
    : 0;
  state.playing = {
    mode, item, label: label || item.name,
    ext,
    transcode: !!useTranscode || forceQuality || forceAudio,
    quality: forceQuality ? userQuality : null,
    // Selected panel audio-track index (movie/series only). 0/absent =
    // panel default; >0 forces transcode with &at=<index>. Reset on each
    // play() unless the caller (audio picker re-play) threads it back in.
    audioTrack: forceAudio ? audioTrack : 0,
    // Probed panel audio tracks for the player's Audio picker. Filled
    // fire-and-forget below from /api/tracks (movie/series only).
    audioTracks: [],
    // Source-side anchor for transcoded movies. Starts non-zero when
    // we're resuming into a transcode; bumped by reanchorTo() when the
    // user scrubs past the encoded edge and we re-spawn ffmpeg with -ss.
    transcodeAnchorSecs: resumeAnchorSecs,
    // Full VOD length. Movies fill this below via /api/movie/info; series
    // seed it here from the panel's per-episode duration (threaded onto the
    // item by playEpisode) since fetchFullDurationSecs is movie-only; disk
    // fills it from the /api/stream response. The scrubber treats this as
    // authoritative for the denominator when transcoding (so 14min encoded
    // ≠ "the episode is 14 min"), and sendProgress needs it to save resume.
    fullDurationSecs: mode === "series" ? (item._durationSecs || 0) : 0,
    // Disk audio/subtitle selection ({audio, sub}) — forwarded to the
    // server so it can switch the audio track or burn in an image sub.
    diskSel: diskSel || null,
  };
  // Identity token for the staleness check after resolveStreamUrl below —
  // a rapid double/triple click (or click-then-immediately-click-a-
  // different-title) fires play() again before the first call's await
  // settles. Each call gets its own state.playing object, so if a newer
  // call has replaced it by the time this one's fetch resolves, this one
  // is stale and must bail rather than attach a player on top of the
  // newer request's — that's what produced overlapping play/pause/load
  // calls and an uncaught AbortError. The newest click always wins.
  const myPlaying = state.playing;
  // Fire-and-forget — by the time the first second of video is
  // playing, this has almost certainly resolved. updateScrubBar
  // gracefully falls back to el.video.duration if it hasn't.
  fetchFullDurationSecs(mode, item.id).then(secs => {
    // Only set a positive value — never clobber a duration already filled
    // from elsewhere (e.g. the disk /api/stream response) back to 0.
    if (secs > 0 && state.playing && state.playing.item === item) {
      state.playing.fullDurationSecs = secs;
    }
  });
  // Probe the panel VOD's audio tracks (movie/series only) so the
  // player bar can offer an Audio picker. Fire-and-forget — disk has its
  // own track list from /api/stream, live has no alternate audio.
  if (mode === "movie" || mode === "series") {
    fetchAudioTracks(mode, item.id, ext).then(tracks => {
      if (tracks && state.playing && state.playing.item === item) {
        state.playing.audioTracks = tracks;
        refreshAudioButton();
      }
    });
  }
  // Continue Watching / lastPlayed should only record a title once we
  // know the server actually has a stream for it — not the instant the
  // user clicks play. Firing these before resolveStreamUrl meant a
  // title that immediately 404/410/502'd (dead source, displaced slot)
  // still showed up as "Last played just now" in Continue Watching even
  // though not a single frame ever rendered. Cast bypasses the normal
  // player entirely (castMedia hands the URL straight to the receiver),
  // so it still records here, before the early return.
  const recordAsPlayed = () => {
    if (mode !== "series" && !isHiddenFromRecents(mode, item)) {
      pushRecent(mode, item.id);
    }
    recordPlayEvent(mode, item.id);
  };
  updateUrl({ push: !useTranscode });
  refreshLiveRemoteVisibility();
  refreshPlayerFavorite();
  // Compute the next episode (series only) for autoplay-on-end + the
  // Up-Next card; clears the card from any prior item.
  refreshNextEpisode();

  if (state.castSession) { recordAsPlayed(); castMedia(state.playing); return; }

  el.player.hidden = false;
  setPlayerMode(mode === "live" ? "mini" : "theater");
  refreshScrubState();
  showControls();
  el.playerTitle.textContent = state.playing.label;
  el.playerAlt.hidden = mode === "live";
  // Show the spinner immediately so the user has feedback while
  // resolveStreamUrl + transcoder warmup runs. The `playing` event
  // hides it once frames are flowing.
  if (el.spinner) el.spinner.hidden = false;

  let resolved;
  try {
    resolved = await resolveStreamUrl(mode, item.id, ext, resumeAnchorSecs, diskSel);
  } catch (e) {
    // Previously unhandled — resolveStreamUrl throws on any non-OK
    // /api/stream response (dead source, displaced cap=1 slot, bad id)
    // and this await had no try/catch, so the rejection was silent: no
    // toast, no console message a user would ever see, spinner stuck
    // forever. Surface it and put the UI back in a clean state.
    if (el.spinner) el.spinner.hidden = true;
    toast(
      e && /^HTTP 410/.test(e.message)
        ? "Another device started watching — try again in a moment."
        : "Couldn't start playback — this title may be unavailable.",
      4500,
    );
    closePlayer();
    return;
  }
  if (state.playing !== myPlaying) return; // superseded by a newer play() call meanwhile — let it own the player
  recordAsPlayed();
  // Disk: stash the probed track list + the signed VTT subtitle URLs so
  // the player's Audio/Subtitles menu can render them.
  if (mode === "disk") {
    state.playing.audioTracks = resolved.audioTracks || [];
    state.playing.subtitleTracks = resolved.subtitleTracks || [];
    state.playing.subtitleUrls = resolved.subtitleUrls || [];
    state.playing.selectedAudio = Number.isFinite(resolved.selectedAudio) ? resolved.selectedAudio : 0;
    // Probed full duration — lets the scrubber show real length AND lets
    // sendProgress save resume position for disk *transcodes* (avi/DTS),
    // which otherwise have no known duration (fetchFullDurationSecs only
    // covers panel movies via /info).
    if (resolved.durationSecs > 0) state.playing.fullDurationSecs = resolved.durationSecs;
  }
  // Server probes live-channel audio codec once per channel and sets
  // forceTranscode=true when MSE can't decode it (MP2 / AC3 / EAC3
  // sports feeds). Promote it into state.playing.transcode so the
  // rest of the play path treats it the same as user-requested
  // transcode (incl. scrubber denominator + manual quality picker).
  if (resolved.forceTranscode && !state.playing.transcode) {
    state.playing.transcode = true;
    toast(`Audio codec ${resolved.forceReason || ""} not browser-supported, transcoding…`.trim(), 3500);
  }
  let url, isHls;
  if (state.playing.transcode) {
    // resolved.transcode already has ?s=<sig>; append the quality
    // selection if the user picked one. Server defaults to "med" when
    // ?q= is missing — matches today's auto-fallback behavior.
    url = resolved.transcode
      + (state.playing.quality ? `&q=${state.playing.quality}` : "")
      + (state.playing.audioTrack ? `&at=${state.playing.audioTrack}` : "");
    isHls = true;
    toast(state.playing.quality
      ? `Transcoding at ${qualityLabel(state.playing.quality)}…`
      : "Transcoding to H.264… first chunk in ~5–10s", 5000);
  } else if (ext === "mkv") {
    // Chrome's HTML5 video silently rejects MKV containers in almost
    // every codec combination (especially 4K HEVC, which most "(4K)"
    // movies on the panel are). Going through the proxy directly
    // would just sit on a black screen until the user gave up.
    // Skip the native attempt and go straight to transcode.
    url = resolved.transcode;
    isHls = true;
    state.playing.transcode = true;
    toast("MKV not browser-playable, transcoding to H.264…", 4000);
  } else {
    url = resolved.proxy;
    isHls = ext === "m3u8";
  }

  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.removeAttribute("src");
  el.playerCC.hidden = true;
  closeCcMenu();
  // Disk: rebuild the Audio/Subtitles selector + attach VTT text tracks.
  setupDiskTracksUI();
  // Panel audio picker: reset (hidden until /api/tracks resolves with >1).
  closeAudioMenu();
  refreshAudioButton();

  if (isHls && window.Hls && Hls.isSupported()) {
    // lowLatencyMode is aggressive — meant for true LL-HLS feeds with
    // partial segments. IPTV panels publish standard HLS with 6–12 s
    // segments, and that mode causes hls.js to chase the live edge
    // with too-small buffers, which surfaces as robotic audio +
    // choppy video on streams with mild PCR jitter (FOX News for one).
    // Standard latency mode + a slightly larger sync window plays
    // cleanly on the same feeds the vendor app handles fine.
    const hls = new Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 4,
      maxBufferLength: 30,
    });
    hls.loadSource(url);
    hls.attachMedia(el.video);
    // Only attempt autoplay AFTER the manifest is parsed — otherwise
    // play() rejects with "no source" on every failed manifest load
    // and we toast "browser blocked autoplay" even when the real cause
    // was the manifest never arriving.
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      // Got a working manifest — clear any retry counter for this id.
      if (state.playing) _manifestRetries.delete(state.playing.item.id);
      el.video.play().catch(() =>
        toast("Tap play to resume — browser blocked autoplay", 3500)
      );
      // Silent-audio watchdog. hls.js's TS demuxer routes MP2 audio
      // through its MP3 parser and reports `audio/mpeg` to MSE — MSE
      // accepts the codec string and then renders nothing or garbage
      // (sports panels with MP2 audio: Cric Eurosports etc). Same
      // failure mode for AC3 / E-AC3 when the demuxer mis-IDs them.
      // After 6s of playback, if Chrome reports zero audio bytes
      // decoded, force the transcoder. webkitAudioDecodedByteCount is
      // Chrome-only; Firefox would silently skip this check and stay
      // on direct (the sports-feeds-with-MP2 problem only happens to
      // Chrome users in practice).
      if (state.playing && !state.playing.transcode && state.playing.mode === "live") {
        clearTimeout(state._noAudioTimer);
        state._noAudioTimer = setTimeout(() => {
          const cur = state.playing;
          if (!cur || cur.transcode) return;
          if (el.video.paused || el.video.readyState < 2) return;
          const dec = el.video.webkitAudioDecodedByteCount;
          if (typeof dec === "number" && dec === 0) {
            toast("Audio codec not browser-supported, transcoding…", 3000);
            play(cur.mode, cur.item, cur.label, cur.ext, true);
          }
        }, 6000);
      }
    });
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshCCButton);
    hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, refreshCCButton);
    // Audio codecs we know browsers can't decode in MSE — sports
    // panels frequently ship MP2 audio with H.264 video, which makes
    // the video stream parse cleanly (so fragParsingError never
    // fires) but produces a silent or stalled playback.
    // `BUFFER_CODECS` fires once hls.js has read the PMT and decided
    // what to ask MSE for. If MediaSource refuses the codec string,
    // fall over to the transcoder same way fragParsingError does.
    hls.on(Hls.Events.BUFFER_CODECS, (_e, data) => {
      if (!state.playing || state.playing.transcode) return;
      const audioCodec = data?.audio?.codec;
      if (!audioCodec) return;
      const ok = window.MediaSource &&
        MediaSource.isTypeSupported(`audio/mp4; codecs="${audioCodec}"`);
      if (!ok) {
        toast("Audio codec not browser-supported, transcoding…", 3000);
        play(state.playing.mode, state.playing.item, state.playing.label, state.playing.ext, true);
      }
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      // Server-side concurrency layer (PR 9) returns 410 Gone when
      // another device displaces this session's panel slot. Recognize
      // it before any retry path so we don't churn against a server
      // that's already told us to back off.
      if (data.response && data.response.code === 410) {
        toast("Another device started watching — your stream stopped.", 5000);
        closePlayer();
        return;
      }
      // fragParsingError = video unparseable. bufferAddCodecError /
      // bufferAppendError = MSE refused an audio/video codec. All
      // three mean "browser can't play this source as-is" — same fix.
      const codecLikeError = data.details === "fragParsingError" ||
        data.details === "bufferAddCodecError" ||
        data.details === "bufferIncompatibleCodecsError";
      if (codecLikeError && !state.playing.transcode) {
        toast("Codec not browser-supported, transcoding…", 3000);
        play(state.playing.mode, state.playing.item, state.playing.label, state.playing.ext, true);
      } else if (data.details === "manifestLoadError" || data.details === "manifestLoadTimeOut") {
        // First-attempt manifest load can fail on hard-refresh because
        // the panel's previous-session connection slot hasn't fully
        // released yet. Retry once per channel (counter is module-level
        // so the retry's fresh state.playing doesn't reset it). Past
        // one retry we give up rather than loop.
        const cur = state.playing;
        const id = cur && cur.item.id;
        const attempts = _manifestRetries.get(id) || 0;
        if (cur && cur.mode === "live" && attempts < 1) {
          _manifestRetries.set(id, attempts + 1);
          toast("Channel slot busy, retrying…", 1800);
          setTimeout(() => {
            if (state.playing && state.playing.item.id === id) {
              play(cur.mode, cur.item, cur.label, cur.ext, cur.transcode);
            }
          }, 1500);
        } else {
          _manifestRetries.delete(id);
          toast(cur && cur.mode === "live" ? "Channel offline or unreachable." : "This title is unavailable right now.", 4000);
        }
      } else {
        toast(`Stream error: ${data.details}`, 4000);
      }
    });
    state.hls = hls;
  } else {
    el.video.src = url;
    // Browsers reject some containers (avi, exotic codecs inside ts)
    // silently — play() rejects but the user only sees a black screen.
    // Hook the <video> error event so we can fall through to the
    // transcode path the way the HLS code path does on fragParsingError.
    const onSrcError = () => {
      // MediaError.code 4 = MEDIA_ERR_SRC_NOT_SUPPORTED — the browser
      // can decode no part of the source. That's the unambiguous "go
      // transcode" signal. Other codes (network, decode of one part)
      // we leave to the standard error path.
      const errCode = el.video.error?.code;
      if (errCode === 4 && state.playing && !state.playing.transcode) {
        toast("Codec not browser-supported, transcoding…", 3000);
        play(state.playing.mode, state.playing.item, state.playing.label,
             state.playing.ext, true);
      }
    };
    el.video.addEventListener("error", onSrcError, { once: true });
    el.video.play().catch(() => {});
    // Watch for a wedged stall (panel drop / corrupt frames the browser
    // can't decode) and fall back to the error-resilient transcode.
    if (mode !== "live") armStallWatch();
  }
  setTimeout(refreshCCButton, 600);
  setTimeout(refreshCCButton, 2500);
  el.video.addEventListener("loadedmetadata", refreshCCButton);
  if (el.video.textTracks?.addEventListener) {
    el.video.textTracks.addEventListener("addtrack", refreshCCButton);
    el.video.textTracks.addEventListener("change", refreshCCButton);
  }

  // Resume + tracking for movies and series episodes. Live is sliding-
  // window so position has no meaning. Movie transcodes ARE finite
  // (start.m3u8 covers the whole movie via re-anchor) so they get
  // both saved progress AND resume — the playlist itself starts at
  // transcodeAnchorSecs of the source, so we DON'T seek the video
  // element; we just attach the tracker. Direct-play resumes still
  // need the video.currentTime seek.
  if (mode !== "live") {
    const key = `${mode}:${item.id}`;
    const saved = state.progress[key];
    const hasResume = saved && Number.isFinite(saved.p) && saved.p > 30;
    if (state.playing.transcode) {
      // For transcodes the playlist already begins at the saved offset
      // (see resumeAnchorSecs in play()'s state.playing block).
      // currentTime ≈ 0 is correct; the scrubber's anchor+cur math
      // surfaces the real source position.
      if (hasResume) toast(`Resumed at ${formatPos(saved.p)}`, 2500);
      attachProgressTracking(key);
    } else if (hasResume) {
      // Race fix: the progress-save tick runs every 15 s and the
      // server's `< 30 s = delete` rule means a tick that fires
      // BEFORE the resume seek has actually landed will read
      // currentTime ≈ 0 and wipe the entry. So we wait for
      // `seeked` (the video element has actually arrived at the
      // resume position) before starting the timer. Without this,
      // a slow mp4 moov-atom load could quietly destroy the user's
      // resume position the very first tick after they reopened
      // the title.
      const seek = () => {
        const dur = el.video.duration;
        const pos = saved.p;
        const ok = !Number.isFinite(dur) || dur <= 0 || (pos < dur - 30 && pos < dur * 0.95);
        if (ok) {
          try { el.video.currentTime = pos; } catch {}
          toast(`Resumed at ${formatPos(pos)}`, 2500);
          el.video.addEventListener("seeked", () => attachProgressTracking(key), { once: true });
        } else {
          attachProgressTracking(key);
        }
      };
      el.video.addEventListener("loadedmetadata", seek, { once: true });
    } else {
      // No saved position — start tracking immediately so the FIRST
      // play of a title still records progress from the beginning.
      attachProgressTracking(key);
    }
  }
}

function listSubtitleTracks() {
  const out = [];
  if (state.hls && state.hls.subtitleTracks) {
    state.hls.subtitleTracks.forEach((t, i) => {
      out.push({
        kind: "hls",
        index: i,
        label: t.name || t.lang || `Track ${i + 1}`,
        active: state.hls.subtitleTrack === i,
      });
    });
  }
  for (let i = 0; i < el.video.textTracks.length; i++) {
    const t = el.video.textTracks[i];
    if (t.kind !== "subtitles" && t.kind !== "captions") continue;
    if (out.some(x => x.kind === "native" && x.index === i)) continue;
    out.push({
      kind: "native",
      index: i,
      label: t.label || t.language || `Track ${i + 1}`,
      active: t.mode === "showing",
    });
  }
  return out;
}

function setSubtitleTrack(track) {
  if (state.hls) state.hls.subtitleTrack = -1;
  for (let i = 0; i < el.video.textTracks.length; i++) {
    el.video.textTracks[i].mode = "disabled";
  }
  if (!track) return;
  if (track.kind === "hls" && state.hls) {
    state.hls.subtitleTrack = track.index;
  } else if (track.kind === "native") {
    el.video.textTracks[track.index].mode = "showing";
  }
}

function refreshCCButton() {
  // Disk mode routes subtitles through the dedicated Audio/Subtitles menu.
  if (state.playing?.mode === "disk") { el.playerCC.hidden = true; return; }
  const tracks = listSubtitleTracks();
  el.playerCC.hidden = tracks.length === 0;
  el.playerCC.classList.toggle("on", tracks.some(t => t.active));
  if (tracks.length === 0) closeCcMenu();
}

let ccMenuEl = null;
function closeCcMenu() {
  if (ccMenuEl) { ccMenuEl.remove(); ccMenuEl = null; }
}
function toggleCcMenu() {
  if (ccMenuEl) { closeCcMenu(); return; }
  const tracks = listSubtitleTracks();
  if (!tracks.length) return;
  ccMenuEl = document.createElement("div");
  ccMenuEl.className = "cc-menu";
  const offBtn = document.createElement("button");
  offBtn.textContent = "Off";
  if (!tracks.some(t => t.active)) offBtn.classList.add("active");
  offBtn.onclick = () => { setSubtitleTrack(null); closeCcMenu(); refreshCCButton(); };
  ccMenuEl.appendChild(offBtn);
  for (const t of tracks) {
    const b = document.createElement("button");
    b.textContent = t.label;
    if (t.active) b.classList.add("active");
    b.onclick = () => { setSubtitleTrack(t); closeCcMenu(); refreshCCButton(); };
    ccMenuEl.appendChild(b);
  }
  el.player.appendChild(ccMenuEl);
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (ccMenuEl && !ccMenuEl.contains(e.target) && e.target !== el.playerCC) {
        closeCcMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}

// ── Disk audio / subtitle selector ────────────────────────────────────
// The Disk player exposes a single "Audio" button that opens a menu of the
// file's audio tracks + subtitle tracks (probed server-side). Audio switch
// and image-subtitle burn-in re-request /api/stream (the server remuxes);
// text subtitles are side-loaded as <track> and toggled client-side.
let diskTracksMenuOpen = false;
function clearDiskTextTracks() {
  el.video.querySelectorAll("track[data-disk]").forEach(t => t.remove());
}
function closeDiskTracksMenu() {
  diskTracksMenuOpen = false;
  if (el.playerTracksMenu) el.playerTracksMenu.hidden = true;
}
function setupDiskTracksUI() {
  closeDiskTracksMenu();
  clearDiskTextTracks();
  const p = state.playing;
  if (!p || p.mode !== "disk") { if (el.playerTracks) el.playerTracks.hidden = true; return; }
  // Attach text-subtitle tracks (VTT) for client-side toggling.
  (p.subtitleUrls || []).forEach((s, i) => {
    const tr = document.createElement("track");
    tr.kind = "subtitles";
    tr.label = s.label || s.lang || `Subtitle ${i + 1}`;
    if (s.lang) tr.srclang = String(s.lang).slice(0, 3);
    tr.src = s.url;
    tr.dataset.disk = "1";
    tr.dataset.subIndex = String(s.index);
    el.video.appendChild(tr);
  });
  if (p.subShown == null) p.subShown = (p.diskSel && Number.isFinite(p.diskSel.sub)) ? p.diskSel.sub : null;
  const audioCount = (p.audioTracks || []).length;
  const subCount = (p.subtitleTracks || []).length;
  if (el.playerTracks) el.playerTracks.hidden = !(audioCount > 1 || subCount > 0);
}
function buildDiskTracksMenu() {
  const p = state.playing, menu = el.playerTracksMenu;
  if (!p || !menu) return;
  const rows = [];
  const audio = p.audioTracks || [];
  if (audio.length > 1) {
    rows.push(`<div class="tracks-head">Audio</div>`);
    for (const a of audio) {
      const on = a.index === p.selectedAudio;
      const ch = a.channels ? ` · ${a.channels > 2 ? a.channels + "ch" : "stereo"}` : "";
      rows.push(`<button class="tracks-item${on ? " on" : ""}" data-kind="audio" data-idx="${a.index}">${escapeHtml(a.label || "Audio " + (a.index + 1))}${ch}</button>`);
    }
  }
  const subs = p.subtitleTracks || [];
  if (subs.length) {
    rows.push(`<div class="tracks-head">Subtitles</div>`);
    rows.push(`<button class="tracks-item${p.subShown == null ? " on" : ""}" data-kind="sub" data-idx="off">Off</button>`);
    for (const s of subs) {
      const on = p.subShown === s.index;
      const tag = s.kind === "image" ? " · burn-in" : "";
      rows.push(`<button class="tracks-item${on ? " on" : ""}" data-kind="sub" data-idx="${s.index}">${escapeHtml(s.label || "Subtitle " + (s.index + 1))}${tag}</button>`);
    }
  }
  menu.innerHTML = rows.join("") || `<div class="tracks-head">No alternate tracks</div>`;
}
function toggleDiskTracksMenu() {
  if (diskTracksMenuOpen) { closeDiskTracksMenu(); return; }
  buildDiskTracksMenu();
  el.playerTracksMenu.hidden = false;
  diskTracksMenuOpen = true;
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (el.playerTracksMenu && !el.playerTracksMenu.contains(e.target) && e.target !== el.playerTracks) {
        closeDiskTracksMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}
function selectDiskAudio(idx) {
  const p = state.playing;
  if (!p || p.mode !== "disk") return;
  closeDiskTracksMenu();
  const sel = { audio: idx };
  if (p.diskSel && Number.isFinite(p.diskSel.sub)) sel.sub = p.diskSel.sub; // keep image-sub burn
  play(p.mode, p.item, p.label, p.ext, undefined, sel);
}
function selectDiskSub(idx) {
  const p = state.playing;
  if (!p || p.mode !== "disk") return;
  if (idx === "off") {
    for (const t of el.video.textTracks) t.mode = "disabled";
    const wasImage = p.diskSel && Number.isFinite(p.diskSel.sub);
    p.subShown = null;
    closeDiskTracksMenu();
    if (wasImage) {
      const sel = (p.diskSel && Number.isFinite(p.diskSel.audio)) ? { audio: p.diskSel.audio } : undefined;
      play(p.mode, p.item, p.label, p.ext, undefined, sel);
    } else { buildDiskTracksMenu(); }
    return;
  }
  const n = Number(idx);
  const track = (p.subtitleTracks || []).find(s => s.index === n);
  if (!track) return;
  if (track.kind === "text") {
    el.video.querySelectorAll("track[data-disk]").forEach(te => {
      if (te.track) te.track.mode = (Number(te.dataset.subIndex) === n) ? "showing" : "disabled";
    });
    p.subShown = n;
    closeDiskTracksMenu();
    buildDiskTracksMenu();
  } else {
    // Image subtitle → burn in via a transcode re-request.
    const sel = { sub: n };
    if (p.diskSel && Number.isFinite(p.diskSel.audio)) sel.audio = p.diskSel.audio;
    p.subShown = n;
    closeDiskTracksMenu();
    play(p.mode, p.item, p.label, p.ext, undefined, sel);
  }
}

function tryAlternateFormat() {
  const p = state.playing;
  if (!p || p.mode === "live") return;
  const next = p.ext === "m3u8" ? (p.item.container || "mp4") : "m3u8";
  toast(`Trying ${next.toUpperCase()}…`, 1500);
  play(p.mode, p.item, p.label, next);
}

function closePlayer() {
  sendProgress();
  clearProgressTracking();
  clearStallWatch();
  stopServerStreams();
  el.player.hidden = true;
  setPlayerMode(null);
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  clearTimeout(state._noAudioTimer);
  state._noAudioTimer = null;
  if (el.spinner) el.spinner.hidden = true;
  el.video.removeAttribute("src");
  el.video.load();
  state.playing = null;
  refreshLiveRemoteVisibility();
  refreshPlayerFavorite();
  updateUrl();
}

// --- Movie / disk detail (reuses the series modal's hero + close UI) -
async function openMovie(s, mode = "movie") {
  saveScroll();
  // Switch to the item's mode so updateUrl() builds the right path
  // rather than inheriting whatever tab the user was on before clicking
  // (e.g. from search-all). Lightweight version of setMode — no rail
  // reload, no home redirect, just the URL-affecting bits.
  if (state.mode !== mode) {
    state.mode = mode;
    for (const b of el.modeButtons) b.classList.toggle("active", b.dataset.mode === mode);
  }
  if (state.view === "collection" && el.hindiTab) el.hindiTab.classList.remove("active");
  // Stash the item on state.openMovie so the play button can find it.
  state.openMovie = s;
  state.openMovieMode = mode; // "movie" | "disk" — drives the panel /info skip + play mode
  state.openSeries = null;
  state.openSeriesData = null;
  el.seriesPanel.dataset.mode = "movie";
  el.seriesPanel.hidden = false;
  el.seriesPanel.scrollTop = 0;
  resetVersoTab();
  // Don't push to recents here — opening the detail modal isn't an
  // intent to watch. play() pushes the recent when the user actually
  // hits Play.

  el.seriesTitle.textContent = s.name;
  setSeriesHeroBackdrop(s.icon, s.icon);
  renderMovieMeta(s, null);
  el.seriesPlot.textContent = s.plot || "";
  setMoviePlayButton(s);
  refreshSeriesMyListBtn();
  refreshSeriesThumbBtns();
  refreshSeriesDiskBtn();
  updateUrl({ push: true });
  // Kick off TMDB enrichment in parallel with the panel info fetch —
  // either can finish first, the helper merges into state.openMovie.
  applyTmdbToDetail(mode, s);
  // Fire "More Like This" once per open. Lives outside applyTmdbToDetail
  // because that helper runs twice (once on entry, again after the
  // panel merge), and we don't want to fetch / re-render the rails
  // twice and end up with duplicate rows.
  renderSimilarRails(mode, s);

  // Disk items have no upstream panel /info — their metadata is the
  // index entry + TMDB (already applied above). Skip the panel fetch.
  if (mode !== "movie") return;

  try {
    const r = await fetch(`/api/movie/info/${s.id}`);
    const d = await r.json();
    state.openMovieData = d;
    const info = d && d.info ? d.info : {};
    const md = d && d.movie_data ? d.movie_data : {};
    const merged = {
      ...s,
      name: md.name || s.name,
      year: info.releasedate || info.releaseDate || info.year || s.year,
      rating: info.rating || s.rating,
      genre: info.genre,
      plot: info.plot || info.description || "",
      duration: info.duration_secs || info.duration,
      container: md.container_extension || s.container,
    };
    state.openMovie = merged;
    if (merged.plot) el.seriesPlot.textContent = merged.plot;
    renderMovieMeta(merged, info);
    const backdrop = (info.backdrop_path && info.backdrop_path[0]) || info.movie_image || s.icon;
    const poster = info.cover_big || info.movie_image || s.icon;
    setSeriesHeroBackdrop(backdrop, poster);
    setMoviePlayButton(merged);
    // Re-apply TMDB after the panel info merge so its fill-ins reflect
    // the merged baseline (and any TMDB artwork that arrived first
    // doesn't get overwritten by the panel poster above).
    applyTmdbToDetail("movie", merged);
  } catch {
    // Soft-fail — the hero still has the rail's metadata.
  }
}

function renderMovieMeta(s, info) {
  const bits = [];
  const year = (info && (info.releasedate || info.releaseDate || info.year)) || s.year;
  const rating = (info && info.rating) || s.rating;
  const dur = (info && (info.duration_secs || info.duration)) || s.duration;
  const genre = info && info.genre;
  if (year) bits.push(`<span class="meta-dim">${escapeHtml(String(year).slice(0, 4))}</span>`);
  if (s.us_cert) bits.push(`<span class="meta-cert">${escapeHtml(String(s.us_cert))}</span>`);
  if (dur) bits.push(`<span class="meta-dim">${escapeHtml(formatDuration(dur))}</span>`);
  if (rating) bits.push(`<span class="meta-rating">★ ${escapeHtml(String(Number(rating).toFixed(1)))}</span>`);
  if (genre) bits.push(`<span class="meta-dim">${escapeHtml(String(genre))}</span>`);
  el.seriesMeta.innerHTML = bits.join("");
}

function setMoviePlayButton(s) {
  const prog = state.progress[`${state.openMovieMode || "movie"}:${s.id}`];
  el.seriesPlayBtn.disabled = false;
  if (prog && Number.isFinite(prog.p) && prog.p > 30) {
    el.seriesPlayBtn.innerHTML = `▸ Resume <span class="play-sub">at ${escapeHtml(formatPos(prog.p))}</span>`;
  } else {
    el.seriesPlayBtn.innerHTML = `▸ Play`;
  }
}

// Resolves {mode, id} for whichever item the shared detail modal has
// open, or null. Single source of truth for every button in the modal
// that needs to know its target — mode uses state.openMovieMode
// ("movie" | "disk", set by openMovie()) rather than hardcoding
// "movie", so Disk-library items record My List / thumbs feedback
// under the right mode instead of colliding with the movie index.
function openItemTarget() {
  return state.openMovie
    ? { mode: state.openMovieMode || "movie", id: state.openMovie.id }
    : state.openSeries
      ? { mode: "series", id: state.openSeries.id }
      : null;
}

// Sync the detail-modal "+ My List" button to whichever item is open
// (movie or series). Called every time the modal opens AND every time
// the user toggles the button.
function refreshSeriesMyListBtn() {
  if (!el.seriesMyListBtn) return;
  const target = openItemTarget();
  if (!target) { el.seriesMyListBtn.hidden = true; return; }
  el.seriesMyListBtn.hidden = false;
  const inList = state.myList[target.mode].has(target.id);
  el.seriesMyListBtn.classList.toggle("on", inList);
  el.seriesMyListBtn.textContent = inList ? "✓ Watch Later" : "+ Watch Later";
  el.seriesMyListBtn.title = inList ? "Remove from Watch Later" : "Add to Watch Later";
}

// Sync the detail-modal thumbs to whichever item is open. Live has no
// detail modal, so no cardMode gate needed.
function refreshSeriesThumbBtns() {
  if (!el.seriesThumbUpBtn || !el.seriesThumbDownBtn) return;
  const target = openItemTarget();
  if (!target) { el.seriesThumbUpBtn.hidden = true; el.seriesThumbDownBtn.hidden = true; return; }
  el.seriesThumbUpBtn.hidden = false;
  el.seriesThumbDownBtn.hidden = false;
  el.seriesThumbUpBtn.classList.toggle("on", state.feedback.up[target.mode].has(target.id));
  el.seriesThumbDownBtn.classList.toggle("on", state.feedback.down[target.mode].has(target.id));
}

// Save-to-Disk button is owner-only (matches the Disk feature itself —
// see server.js's userDiskPath) and only makes sense for movie/series
// (never live). Hidden entirely for non-owner accounts rather than
// disabled, since a non-owner can never have a configured disk to save to.
function refreshSeriesDiskBtn() {
  if (!el.seriesDiskBtnWrap) return;
  const target = openItemTarget();
  const canShow = !!target && !!state.diskConfig?.isOwner && !!state.diskConfig?.enabled;
  el.seriesDiskBtnWrap.hidden = !canShow;
  if (canShow) renderDiskMenu();
}

function closeMovie() {
  el.seriesPanel.hidden = true;
  el.seriesPanel.removeAttribute("data-mode");
  state.openMovie = null;
  state.openMovieData = null;
  updateUrl();
}

// Season currently rendered inside the series modal — kept on
// state.openSeriesData so changing the dropdown can re-render without
// re-fetching the panel info.
async function openSeries(s) {
  saveScroll();
  // Mirror of openMovie: switch state.mode to "series" so updateUrl
  // builds a `/series/...` path even when the click came from a
  // search-all view or person-credits strip while the user was on
  // a different tab.
  if (state.mode !== "series") {
    state.mode = "series";
    for (const b of el.modeButtons) b.classList.toggle("active", b.dataset.mode === "series");
  }
  if (state.view === "collection" && el.hindiTab) el.hindiTab.classList.remove("active");
  state.openSeries = s;
  state.openSeriesData = null;
  // Don't push to recents on open — only when the user actually plays
  // an episode (handled in playEpisode → pushRecent).
  el.seriesPanel.dataset.mode = "series";
  el.seriesPanel.hidden = false;
  el.seriesPanel.scrollTop = 0;
  resetVersoTab();

  // Hero starts in a loading-ish state with whatever metadata we
  // already have on the projected stream object; episode list shows a
  // placeholder until the panel info arrives.
  el.seriesTitle.textContent = s.name;
  setSeriesHeroBackdrop(s.icon, s.icon);
  renderSeriesMeta(s, null);
  el.seriesPlot.textContent = s.plot || "";
  el.seriesSeasonSelect.innerHTML = "";
  el.seriesEpisodes.innerHTML = `<div class="empty">Loading episodes…</div>`;
  refreshSeriesMyListBtn();
  refreshSeriesThumbBtns();
  refreshSeriesDiskBtn();
  updateUrl({ push: true });
  // Kick off TMDB enrichment in parallel with the panel info fetch.
  applyTmdbToDetail("series", s);
  // Fire "More Like This" once per open — see openMovie() for why
  // this can't live inside applyTmdbToDetail.
  renderSimilarRails("series", s);

  try {
    const r = await fetch(`/api/series/info/${s.id}`);
    const d = await r.json();
    state.openSeriesData = d;
    refreshSeriesDiskBtn();
    const backdrop = (d.info && (d.info.backdrop_path?.[0] || d.info.movie_image)) || s.icon;
    const poster = (d.info && (d.info.cover || d.info.cover_big)) || s.icon;
    setSeriesHeroBackdrop(backdrop, poster);
    renderSeriesMeta(s, d);
    if (d.info && d.info.plot) el.seriesPlot.textContent = d.info.plot;
    // Re-apply TMDB so artwork/text upgrades win over the panel
    // baseline we just set above.
    applyTmdbToDetail("series", s);

    const episodesByS = d.episodes || {};
    const seasonNums = Object.keys(episodesByS).sort((a, b) => Number(a) - Number(b));
    if (!seasonNums.length) {
      el.seriesEpisodes.innerHTML = `<div class="empty">No episodes found.</div>`;
      el.seriesPlayBtn.disabled = true;
      return;
    }
    el.seriesPlayBtn.disabled = false;

    // Populate season dropdown; default to last-watched episode's
    // season if known, else first season.
    el.seriesSeasonSelect.innerHTML = "";
    for (const sn of seasonNums) {
      const opt = document.createElement("option");
      opt.value = sn;
      opt.textContent = `Season ${sn} · ${episodesByS[sn].length} ep`;
      el.seriesSeasonSelect.appendChild(opt);
    }
    const last = state.lastEpisode[s.id];
    const initial = last && seasonNums.includes(String(last.season))
      ? String(last.season)
      : seasonNums[0];
    el.seriesSeasonSelect.value = initial;
    renderSeriesEpisodes(s, d, initial);

    const pick = pickResumeOrFirstEpisode(s, d);
    if (pick) {
      const isResume = !!last;
      const label = `S${String(pick.sn).padStart(2, "0")}E${String(pick.ep.episode_num).padStart(2, "0")}`;
      el.seriesPlayBtn.innerHTML = isResume
        ? `▸ Resume <span class="play-sub">${escapeHtml(label)}</span>`
        : `▸ Play <span class="play-sub">${escapeHtml(label)}</span>`;
    }
  } catch (e) {
    el.seriesEpisodes.innerHTML = `<div class="empty">Failed to load: ${escapeHtml(e.message)}</div>`;
  }
}

// Apply TMDB enrichment to the open detail modal. Artwork is upgraded
// to TMDB unconditionally (better quality + actual backdrops). Text
// metadata only fills blanks the panel left empty so a hand-curated
// panel plot wins when both sources have content. Re-renders the meta
// bits and updates the override menu's "matched as ..." line.
async function applyTmdbToDetail(mode, item) {
  const d = await posterFor(mode, item.id);
  // Always update the override menu line (even on no-match it should
  // say "No TMDB match").
  if (typeof renderPosterMenu === "function") renderPosterMenu(mode, item, d);
  // Render the TMDB extras even on no-match — that just hides every
  // optional block — so the previous item's data doesn't leak into
  // the next item's detail page.
  renderTmdbExtras(mode, item, d);
  if (!d) return;
  // Override the panel's noisy title with TMDB's clean canonical one
  // ("Bajirao Mastani (2015)(4k)(Hindi)" → "Bajirao Mastani"). Falls
  // back to the panel name when there's no TMDB match.
  if (d.tmdb_title) el.seriesTitle.textContent = d.tmdb_title;
  // Artwork: TMDB poster + TMDB backdrop are nearly always nicer than
  // the panel's. Falls back to the panel image if TMDB has only one.
  const tmdbBackdrop = d.backdrop || d.poster || null;
  const tmdbPoster = d.poster || d.backdrop || null;
  if (tmdbPoster || tmdbBackdrop) {
    setSeriesHeroBackdrop(tmdbBackdrop || item.icon, tmdbPoster || item.icon);
  }
  // Text fill-ins, on the live `state.openMovie` / `state.openSeries`
  // first so renderXxxMeta() picks them up, then re-render.
  const target = mode === "movie" ? state.openMovie : state.openSeries;
  if (target) {
    if (d.tmdb_title) target.name = d.tmdb_title;
    if (!target.plot && d.plot) {
      target.plot = d.plot;
      el.seriesPlot.textContent = d.plot;
    }
    if (!target.year && d.year) target.year = d.year;
    if (!target.rating && d.rating) target.rating = d.rating;
    if (!target.runtime && d.runtime) target.runtime = d.runtime;
    if (d.us_cert) target.us_cert = d.us_cert;
    if ((!target.genre || !String(target.genre).trim()) && d.genres && d.genres.length) {
      target.genre = d.genres.join(", ");
    }
    if (mode === "movie") renderMovieMeta(target, null);
    else renderSeriesMeta(target, state.openSeriesData);
  }
}

// Populates the rich TMDB-driven detail block: tagline, trailer
// button, directors / creators, panel category breadcrumb, genres,
// cast strip with portraits, keyword chips. Each block hides
// itself when its underlying field is empty so titles without rich
// metadata still render a clean page.
function renderTmdbExtras(mode, item, d) {
  const tagEl = el.seriesTagline;
  const trailerBtn = el.seriesTrailerBtn;
  const creators = el.seriesCreators;
  const catRow = el.seriesCatRow;
  const genres = el.seriesGenres;
  const cast = el.seriesCast;
  const castStrip = el.seriesCastStrip;
  const keywords = el.seriesKeywords;

  // Tagline.
  if (d && d.tagline) {
    tagEl.textContent = d.tagline;
    tagEl.hidden = false;
  } else { tagEl.hidden = true; tagEl.textContent = ""; }

  // Trailer button. Clicking pops the iframe modal.
  if (d && d.trailer_key) {
    trailerBtn.hidden = false;
    trailerBtn.onclick = () => openTrailer(d.trailer_key);
  } else { trailerBtn.hidden = true; trailerBtn.onclick = null; }

  // Director(s) / Creator(s). Movies get "Directed by", TV gets
  // "Created by" — falls back to the field that's populated. Names
  // are clickable links that open the person-credits view, same as
  // the cast cards.
  if (d && Array.isArray(d.directors) && d.directors.length) {
    const label = mode === "series" ? "Created by" : "Directed by";
    const links = d.directors.map(n =>
      `<a class="person-link" data-name="${escapeHtml(n)}">${escapeHtml(n)}</a>`
    ).join(", ");
    creators.innerHTML = `<b>${label}</b>${links}`;
    creators.querySelectorAll(".person-link").forEach(a => {
      a.onclick = (e) => { e.preventDefault(); openPersonView(a.dataset.name); };
    });
    creators.hidden = false;
  } else { creators.hidden = true; creators.innerHTML = ""; }

  // Panel category breadcrumb — "From: BOLLYWOOD BLOCKBUSTERS".
  // Lets the user see which reseller bucket this came from and
  // jump back to it.
  const catName = (() => {
    const cats = state.modes[mode]?.categories || [];
    const c = cats.find(c => String(c.category_id) === String(item.category_id));
    return c?.category_name || null;
  })();
  if (catName) {
    catRow.innerHTML = `<b>From</b><a href="#" data-cat="${escapeHtml(String(item.category_id))}">${escapeHtml(catName)}</a>`;
    catRow.hidden = false;
    const link = catRow.querySelector("a");
    if (link) link.onclick = (e) => {
      e.preventDefault();
      closeDetail();
      selectCategory(item.category_id);
    };
  } else { catRow.hidden = true; catRow.innerHTML = ""; }

  // Genres — display as a comma-separated row. Already shown in the
  // meta line, but here gets the bold-uppercase label treatment.
  if (d && Array.isArray(d.genres) && d.genres.length) {
    genres.innerHTML =
      `<b>Genre</b>${d.genres.map(escapeHtml).join(" · ")}`;
    genres.hidden = false;
  } else { genres.hidden = true; genres.innerHTML = ""; }

  // Cast strip — up to 10 portraits with name + character. Each
  // card is a button that pops the person-credits view ("More from
  // Ranveer Singh"), powered by /api/person/credits which resolves
  // the actor to a tmdb person_id and intersects their filmography
  // with our catalog.
  if (d && Array.isArray(d.cast) && d.cast.length) {
    castStrip.innerHTML = "";
    for (const c of d.cast) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "cast-card";
      const photo = document.createElement("div");
      photo.className = "cast-photo";
      if (c.profile) photo.style.backgroundImage = `url("${c.profile}")`;
      else photo.style.background = "var(--bg-2)";
      const nm = document.createElement("div");
      nm.className = "cast-name";
      nm.textContent = c.name;
      card.appendChild(photo);
      card.appendChild(nm);
      if (c.character) {
        const ch = document.createElement("div");
        ch.className = "cast-char";
        ch.textContent = c.character;
        card.appendChild(ch);
      }
      card.onclick = () => openPersonView(c.name);
      castStrip.appendChild(card);
    }
    cast.hidden = false;
  } else { cast.hidden = true; castStrip.innerHTML = ""; }

  // Keyword chips. Each is tappable — opens an all-mode search for
  // that keyword. TMDB keywords are usually 2-3 word phrases like
  // "haunted house" or "post-apocalyptic future", great for the
  // "more like this but darker" exploration pattern.
  if (d && Array.isArray(d.keywords) && d.keywords.length) {
    keywords.innerHTML = "";
    for (const k of d.keywords) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "kw-chip";
      chip.textContent = k;
      chip.onclick = () => {
        closeDetail();
        el.search.value = k;
        syncSearchClearVisibility();
        state.query = k;
        renderUnifiedSearch(k);
        showSearchAll();
      };
      keywords.appendChild(chip);
    }
    keywords.hidden = false;
  } else { keywords.hidden = true; keywords.innerHTML = ""; }
}

// Fetch /api/similar/:mode/:id and render each rail under the detail
// extras. Server already applied profile gates + dedup + min-5-items
// thresholds + ordering, so the client literally iterates rails[].
// Stale-response guard: if the user opens detail A then B before A's
// fetch returns, we drop A's response since state.openMovie / open-
// Series no longer matches.
async function renderSimilarRails(mode, item) {
  const root = el.seriesSimilar;
  if (!root) return;
  root.innerHTML = "";
  root.hidden = true;
  if (mode !== "movie" && mode !== "series") return;
  try {
    const r = await fetch(`/api/similar/${mode}/${item.id}`);
    if (!r.ok) return;
    const data = await r.json();
    if (!data.ready || !Array.isArray(data.rails) || data.rails.length === 0) return;
    const active = mode === "series" ? state.openSeries : state.openMovie;
    if (!active || active.id !== item.id) return;
    for (const rail of data.rails) {
      const wrap = document.createElement("div");
      wrap.className = "similar-rail";
      const title = document.createElement("div");
      title.className = "similar-rail-title";
      title.textContent = rail.title;
      const row = document.createElement("div");
      row.className = "similar-rail-row";
      for (const it of rail.items) {
        row.appendChild(channelCard(it, { mode, reason: rail.title }));
      }
      wrap.appendChild(title);
      wrap.appendChild(row);
      root.appendChild(wrap);
    }
    root.hidden = false;
  } catch (_) {
    // These rails are nice-to-have, not essential. Failing silently
    // keeps the rest of the detail page intact.
  }
}

// "More from <actor/director>". Closes the current detail modal,
// hits /api/person/credits which resolves the name to a TMDB person
// and intersects their filmography with our local catalog, then
// renders the result in the existing search-all view shell (so the
// chrome — back button, scrollable sections, channel cards — is the
// same the user already knows).
async function openPersonView(name) {
  if (!name) return;
  closeDetail();
  el.searchAllTitle.textContent = `More from ${name}`;
  el.searchAllResults.innerHTML = `<div class="empty">Loading filmography…</div>`;
  showSearchAll();
  let data;
  try {
    const r = await fetch(`/api/person/credits?name=${encodeURIComponent(name)}`);
    data = await r.json();
  } catch {
    el.searchAllResults.innerHTML = `<div class="empty">Couldn't fetch filmography — check connection.</div>`;
    return;
  }
  const movie = data?.items?.movie || [];
  const series = data?.items?.series || [];
  el.searchAllResults.innerHTML = "";
  if (!movie.length && !series.length) {
    el.searchAllResults.innerHTML =
      `<div class="empty">No titles featuring <b>${escapeHtml(name)}</b> in your catalog.</div>`;
    return;
  }
  // Person summary banner at the top — photo, name, dept (Acting /
  // Directing / etc). Tells the user we resolved their click to a
  // specific TMDB person and which one.
  if (data.person) {
    const banner = document.createElement("div");
    banner.className = "person-summary";
    banner.innerHTML = `
      <div class="person-photo" ${data.person.profile ? `style="background-image:url('${data.person.profile}')"` : ""}></div>
      <div class="person-info">
        <div class="person-name">${escapeHtml(data.person.name)}</div>
        ${data.person.known_for_department ? `<div class="person-dept">${escapeHtml(data.person.known_for_department)}</div>` : ""}
        <div class="person-count">${movie.length + series.length} title${(movie.length + series.length) !== 1 ? "s" : ""} in your catalog</div>
      </div>
    `;
    el.searchAllResults.appendChild(banner);
  }
  const addSection = (title, items, mode) => {
    if (!items.length) return;
    const sec = document.createElement("div");
    sec.className = "search-all-section";
    const hdr = document.createElement("div");
    hdr.className = "search-all-section-header";
    hdr.innerHTML = `<span class="search-all-section-title">${title}</span><span class="search-all-section-count">${items.length}</span>`;
    const strip = document.createElement("div");
    strip.className = "search-all-strip";
    const prevMode = state.mode;
    for (const s of items) {
      state.mode = mode;
      strip.appendChild(channelCard(s, { reason: `Featuring: ${name}`, mode }));
    }
    state.mode = prevMode;
    sec.append(hdr, strip);
    el.searchAllResults.appendChild(sec);
  };
  addSection("Movies", movie, "movie");
  addSection("Series", series, "series");
}

function openTrailer(youtubeKey) {
  if (!youtubeKey) return;
  // Studio uploads (most Bollywood + Hollywood official trailers) set
  // `embeddable=false` on their YouTube videos, so the iframe path
  // shows a "video player configuration error 153" instead of the
  // trailer. Bouncing to youtube.com directly works for every
  // trailer regardless of embedding policy. window.open's second
  // arg + noopener prevents the new tab from racing back to our
  // origin.
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(youtubeKey)}`;
  window.open(url, "_blank", "noopener");
}

// Populate the ⋮ override menu with the matched TMDB title and a
// "Refresh poster" action that wipes the cache entry and re-searches.
// Called from applyTmdbToDetail() on every detail-modal load. The
// menu starts hidden — click ⋮ to toggle.
function renderPosterMenu(mode, item, tmdbResult) {
  const dd = el.seriesPosterMenuDropdown;
  if (!dd) return;
  const matched = tmdbResult && tmdbResult.tmdb_id
    ? `<b>${escapeHtml(tmdbResult.tmdb_title || "")}</b><span>via TMDB</span>`
    : `<b>No TMDB match</b><span>using panel artwork</span>`;
  dd.innerHTML = `
    <div class="pm-info">MATCHED${matched ? `<br>` : ""}${matched}</div>
    <button type="button" data-action="refresh">Refresh poster</button>
  `;
  // Wire the refresh button — clears server + client caches and
  // re-runs the TMDB enrichment so a wrong match self-heals.
  dd.querySelector('button[data-action="refresh"]').onclick = async () => {
    closePosterMenu();
    toast("Refreshing poster…", 1500);
    await clearPosterCache(mode, item.id);
    await applyTmdbToDetail(mode, item);
  };
}
function openPosterMenu() {
  if (el.seriesPosterMenuDropdown) el.seriesPosterMenuDropdown.hidden = false;
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (el.seriesPosterMenuDropdown && !el.seriesPosterMenuDropdown.contains(e.target) && e.target !== el.seriesPosterMenuBtn) {
        closePosterMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}
function closePosterMenu() {
  if (el.seriesPosterMenuDropdown) el.seriesPosterMenuDropdown.hidden = true;
}

// Save-to-Disk picker. Movie: a single confirm button (no picker needed —
// one file). Series: pick a season + episode from the already-fetched
// state.openSeriesData season/episode tree (no extra round-trip), with
// "this episode" / "this season" / "whole series" actions. Disk mode has
// no season/episode grouping (see the DISK MEDIA comment in server.js —
// it's a flat movie-style library), so a season/series download queues
// one job per episode; each becomes its own standalone Disk entry.
function renderDiskMenu() {
  const dd = el.seriesDiskDropdown;
  if (!dd) return;
  if (state.openMovie) {
    const m = state.openMovie;
    dd.innerHTML = `
      <div class="pm-info">SAVE TO DISK<br><b>Highest quality — no re-encode</b></div>
      <button type="button" data-action="go">⬇ Save this movie</button>
    `;
    dd.querySelector('[data-action="go"]').onclick = () => {
      closeDiskMenu();
      triggerDiskDownload({ mode: "movie", id: m.id, title: m.name, year: (m.year || "").slice(0, 4) || null });
    };
    return;
  }
  if (!state.openSeries || !state.openSeriesData) { dd.innerHTML = ""; return; }
  const s = state.openSeries;
  const episodesByS = state.openSeriesData.episodes || {};
  const seasonNums = Object.keys(episodesByS).sort((a, b) => Number(a) - Number(b));
  if (!seasonNums.length) {
    dd.innerHTML = `<div class="pm-info">SAVE TO DISK<br><b>No episodes found</b></div>`;
    return;
  }
  const defaultSeason = (el.seriesSeasonSelect?.value && episodesByS[el.seriesSeasonSelect.value])
    ? el.seriesSeasonSelect.value : seasonNums[0];
  const totalEpisodes = Object.values(episodesByS).reduce((n, eps) => n + eps.length, 0);

  dd.innerHTML = `
    <div class="pm-info">SAVE TO DISK<br><b>Highest quality — no re-encode</b></div>
    <div class="disk-menu-row">
      <select class="disk-menu-season"></select>
      <select class="disk-menu-episode"></select>
    </div>
    <button type="button" data-action="episode">⬇ This episode</button>
    <button type="button" data-action="season">⬇ This whole season</button>
    <button type="button" data-action="series">⬇ Whole series (${totalEpisodes} episodes)</button>
  `;
  const seasonSel = dd.querySelector(".disk-menu-season");
  const epSel = dd.querySelector(".disk-menu-episode");
  for (const sn of seasonNums) {
    const opt = document.createElement("option");
    opt.value = sn;
    opt.textContent = `Season ${sn}`;
    seasonSel.appendChild(opt);
  }
  seasonSel.value = defaultSeason;
  const fillEpisodes = () => {
    epSel.innerHTML = "";
    for (const ep of episodesByS[seasonSel.value] || []) {
      const opt = document.createElement("option");
      opt.value = ep.id;
      opt.textContent = `E${ep.episode_num} — ${ep.title || ep.info?.name || `Episode ${ep.episode_num}`}`;
      epSel.appendChild(opt);
    }
  };
  fillEpisodes();
  seasonSel.onchange = fillEpisodes;

  const episodePayload = (ep, sn) => ({
    id: ep.id,
    seriesTitle: s.name,
    season: Number(sn),
    episodeNum: ep.episode_num,
    episodeTitle: ep.title || ep.info?.name || null,
    year: (s.year || "").slice(0, 4) || null,
  });

  dd.querySelector('[data-action="episode"]').onclick = () => {
    const sn = seasonSel.value;
    const ep = (episodesByS[sn] || []).find((e) => String(e.id) === epSel.value);
    if (!ep) return;
    closeDiskMenu();
    triggerDiskDownload({ mode: "series", episodes: [episodePayload(ep, sn)] });
  };
  dd.querySelector('[data-action="season"]').onclick = () => {
    const sn = seasonSel.value;
    const eps = episodesByS[sn] || [];
    closeDiskMenu();
    triggerDiskDownload({ mode: "series", episodes: eps.map((ep) => episodePayload(ep, sn)) });
  };
  dd.querySelector('[data-action="series"]').onclick = () => {
    const all = [];
    for (const sn of seasonNums) for (const ep of episodesByS[sn] || []) all.push(episodePayload(ep, sn));
    closeDiskMenu();
    triggerDiskDownload({ mode: "series", episodes: all });
  };
}
function openDiskMenu() {
  if (!el.seriesDiskDropdown) return;
  renderDiskMenu();
  el.seriesDiskDropdown.hidden = false;
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (el.seriesDiskDropdown && !el.seriesDiskDropdown.contains(e.target) && e.target !== el.seriesDiskBtn) {
        closeDiskMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}
function closeDiskMenu() {
  if (el.seriesDiskDropdown) el.seriesDiskDropdown.hidden = true;
}
async function triggerDiskDownload(payload) {
  try {
    const r = await fetch("/api/disk-download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) { toast(`Download failed to queue: ${d.error || r.status}`, 4000); return; }
    const n = (d.jobIds || []).length;
    toast(n > 1 ? `Queued ${n} downloads — runs overnight, check Disk tomorrow` : "Queued — downloads overnight, will show up in Disk", 3500);
  } catch (e) {
    toast(`Download request failed: ${e.message}`, 4000);
  }
}

function setSeriesHeroBackdrop(backdropUrl, posterUrl) {
  const bg = el.seriesPanel.querySelector(".series-bg");
  // The poster shows sharp on the left card; the same image (or a
  // backdrop if the panel gave us one) is reused as a dimmed full-bleed
  // background for atmosphere.
  if (bg) bg.style.backgroundImage = "";
  el.seriesPoster.style.backgroundImage = "";
  const setBg = (u) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => { if (bg) bg.style.backgroundImage = `url("${u}")`; };
    img.src = u;
  };
  const setPoster = (u) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => { el.seriesPoster.style.backgroundImage = `url("${u}")`; };
    img.src = u;
  };
  if (posterUrl) setPoster(posterUrl);
  if (backdropUrl) setBg(backdropUrl);
  else if (posterUrl) setBg(posterUrl); // fall back to poster as backdrop
}

function renderSeriesMeta(s, info) {
  const bits = [];
  const seasonsCount = info && info.episodes ? Object.keys(info.episodes).length : null;
  const year = (info && info.info && (info.info.releaseDate || info.info.release_date)) || s.year;
  const rating = (info && info.info && (info.info.rating || info.info.rating_5based)) || s.rating;
  const genre = info && info.info && info.info.genre;
  if (year) bits.push(`<span class="meta-dim">${escapeHtml(String(year).slice(0, 4))}</span>`);
  if (s.us_cert) bits.push(`<span class="meta-cert">${escapeHtml(String(s.us_cert))}</span>`);
  if (seasonsCount) bits.push(`<span class="meta-dim">${seasonsCount} season${seasonsCount === 1 ? "" : "s"}</span>`);
  if (rating) bits.push(`<span class="meta-rating">★ ${escapeHtml(String(Number(rating).toFixed(1)))}</span>`);
  if (genre) bits.push(`<span class="meta-dim">${escapeHtml(String(genre))}</span>`);
  el.seriesMeta.innerHTML = bits.join("");
}

function formatDuration(d) {
  if (!d) return "";
  if (typeof d === "string" && d.includes(":")) {
    const parts = d.split(":").map(Number);
    if (parts.length === 3) {
      const [h, m] = parts;
      return h ? `${h}h ${m}m` : `${m} min`;
    }
    return d;
  }
  const secs = Number(d);
  if (Number.isFinite(secs)) {
    const m = Math.round(secs / 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
  }
  return String(d);
}

// True episode runtime in seconds from the panel's get_series_info blob.
// `duration_secs` is numeric seconds; some panels only give `duration` as
// "HH:MM:SS". 0 = unknown (callers guard on > 0).
function episodeDurationSecs(ep) {
  const n = Number(ep?.info?.duration_secs);
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const hms = ep?.info?.duration;
  if (typeof hms === "string" && hms.includes(":")) {
    const p = hms.split(":").map(Number);
    if (p.length === 3 && p.every(Number.isFinite)) return p[0] * 3600 + p[1] * 60 + p[2];
  }
  return 0;
}

function playEpisode(seriesItem, ep, sn, seriesData) {
  const title = ep.title || ep.info?.name || `Episode ${ep.episode_num}`;
  const ext = ep.container_extension || "mp4";
  rememberEpisode(seriesItem.id, ep, sn, seriesItem.name);
  pushRecent("series", seriesItem.id);
  // Stash the series context BEFORE closeSeries() wipes
  // state.openSeriesData, so next-episode autoplay / the Up-Next card can
  // resolve siblings without re-fetching. Falls back to the live
  // state.openSeriesData when the caller didn't pass it explicitly.
  const data = seriesData || state.openSeriesData;
  closeSeries();
  play("series",
       { id: ep.id, name: title, container: ext, _series: seriesItem, _data: data, _season: sn,
         _durationSecs: episodeDurationSecs(ep) },
       `${seriesItem.name} · S${sn}E${ep.episode_num}`);
}

// Compute the episode that follows (season, episode-num order) the one
// currently playing in a series. Rolls over to episode 1 of the next
// season; returns null when it's the last episode of the last season or
// the series data isn't available. Sourced from the cached series-info
// tree stashed on the playing item by playEpisode (no re-fetch).
function computeNextEpisode(playing) {
  if (!playing || playing.mode !== "series") return null;
  const item = playing.item;
  const seriesItem = item._series;
  const data = item._data;
  if (!seriesItem || !data || !data.episodes) return null;
  const episodesByS = data.episodes;
  const seasonNums = Object.keys(episodesByS).sort((a, b) => Number(a) - Number(b));
  if (!seasonNums.length) return null;
  const curSn = String(item._season);
  const curId = String(item.id);
  const list = episodesByS[curSn] || [];
  const idx = list.findIndex(e => String(e.id) === curId);
  if (idx === -1) return null;
  // Next in the same season.
  if (idx + 1 < list.length) {
    return { seriesItem, data, ep: list[idx + 1], sn: curSn };
  }
  // Roll over to episode 1 of the next non-empty season.
  const sPos = seasonNums.indexOf(curSn);
  for (let i = sPos + 1; i < seasonNums.length; i++) {
    const nextList = episodesByS[seasonNums[i]];
    if (nextList && nextList.length) {
      return { seriesItem, data, ep: nextList[0], sn: seasonNums[i] };
    }
  }
  return null; // last episode of the last season
}

// Recompute state.playing.nextEpisode for the current series episode and
// refresh the Up-Next card's title. Called after play() establishes the
// new state.playing. No-op (and hides the card) for movies / live.
function refreshNextEpisode() {
  hideUpNext();
  if (!state.playing || state.playing.mode !== "series") {
    if (state.playing) state.playing.nextEpisode = null;
    return;
  }
  const next = computeNextEpisode(state.playing);
  if (next) {
    const epTitle = next.ep.title || next.ep.info?.name || `Episode ${next.ep.episode_num}`;
    const label = `S${next.sn}E${next.ep.episode_num} · ${epTitle}`;
    state.playing.nextEpisode = { id: next.ep.id, ext: next.ep.container_extension || "mp4", label, _pick: next };
  } else {
    state.playing.nextEpisode = null;
  }
}

// Play whatever state.playing.nextEpisode points at. Used by both the
// Up-Next "Play now" button and autoplay-on-end.
function playNextEpisode() {
  const next = state.playing && state.playing.nextEpisode;
  if (!next || !next._pick) return;
  const { seriesItem, ep, sn, data } = next._pick;
  hideUpNext();
  playEpisode(seriesItem, ep, sn, data);
}

const UPNEXT_LEAD_SECS = 20; // show the card in the last N seconds
function showUpNext() {
  const next = state.playing && state.playing.nextEpisode;
  if (!next) return;
  el.playerUpnextTitle.textContent = next.label;
  el.playerUpnext.hidden = false;
}
function hideUpNext() {
  if (el.playerUpnext) el.playerUpnext.hidden = true;
}

function pickResumeOrFirstEpisode(seriesItem, info) {
  const episodesByS = info.episodes || {};
  const seasonNums = Object.keys(episodesByS).sort((a, b) => Number(a) - Number(b));
  if (!seasonNums.length) return null;
  // Resume the last-watched episode if it still exists; otherwise the
  // first episode of the first season.
  const last = state.lastEpisode[seriesItem.id];
  if (last) {
    const list = episodesByS[String(last.season)];
    const ep = list && list.find(e => String(e.id) === String(last.episode_id));
    if (ep) return { ep, sn: String(last.season) };
  }
  const firstSn = seasonNums[0];
  return { ep: episodesByS[firstSn][0], sn: firstSn };
}

function renderSeriesEpisodes(seriesItem, info, sn) {
  const list = (info.episodes && info.episodes[sn]) || [];
  el.seriesEpisodes.innerHTML = "";
  if (!list.length) {
    el.seriesEpisodes.innerHTML = `<div class="empty">No episodes in this season.</div>`;
    return;
  }
  const playingId = state.playing && state.playing.mode === "series"
    ? String(state.playing.item.id)
    : null;
  const frag = document.createDocumentFragment();
  for (const ep of list) {
    const title = ep.title || ep.info?.name || `Episode ${ep.episode_num}`;
    const thumbUrl = ep.info?.movie_image || ep.info?.cover_big || seriesItem.icon || "";
    const duration = formatDuration(ep.info?.duration_secs || ep.info?.duration);
    const plot = (ep.info?.plot || "").trim();
    const epProg = state.progress[`series:${ep.id}`];
    const epPct = epProg && epProg.d
      ? Math.min(99, Math.max(2, Math.floor((epProg.p / epProg.d) * 100)))
      : null;
    const resumeBit = epPct != null
      ? `Resume at ${epPct}%`
      : (epProg ? `Resume at ${formatPos(epProg.p)}` : "");

    const epEl = document.createElement("div");
    epEl.className = "episode"
      + (state.watched.has(String(ep.id)) ? " watched" : "")
      + (String(ep.id) === playingId ? " playing" : "");
    epEl.innerHTML = `
      <div class="ep-num">${escapeHtml(String(ep.episode_num))}</div>
      <div class="ep-thumb">
        ${epPct != null ? `<div class="ep-progress"><span style="width:${epPct}%"></span></div>` : ""}
      </div>
      <div class="ep-body">
        <div class="ep-head">
          <span class="ep-title">${escapeHtml(title)}</span>
          ${duration ? `<span class="ep-meta">${escapeHtml(duration)}</span>` : ""}
        </div>
        ${plot ? `<div class="ep-plot">${escapeHtml(plot)}</div>` : ""}
        ${resumeBit ? `<div class="ep-resume">${escapeHtml(resumeBit)}</div>` : ""}
      </div>
    `;
    if (thumbUrl) {
      const thumbEl = epEl.querySelector(".ep-thumb");
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => { thumbEl.style.backgroundImage = `url("${thumbUrl}")`; };
      img.src = thumbUrl;
    }
    epEl.dataset.epId = String(ep.id);
    epEl.onclick = () => playEpisode(seriesItem, ep, sn);
    frag.appendChild(epEl);
  }
  el.seriesEpisodes.appendChild(frag);

  // Upgrade thumbnails to TMDB stills when available. Single fetch
  // per (series, season); cached server-side and in-memory after first
  // call, so re-opening the same season is instant.
  stillsForSeason(seriesItem.id, sn).then((stills) => {
    if (!stills || !Object.keys(stills).length) return;
    for (const epId of Object.keys(stills)) {
      const node = el.seriesEpisodes.querySelector(`.episode[data-ep-id="${CSS.escape(epId)}"]`);
      if (!node) continue;
      const thumbEl = node.querySelector(".ep-thumb");
      if (!thumbEl) continue;
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.onload = () => { thumbEl.style.backgroundImage = `url("${stills[epId]}")`; };
      img.src = stills[epId];
    }
  });
}

function closeSeries() {
  el.seriesPanel.hidden = true;
  el.seriesPanel.removeAttribute("data-mode");
  el.seriesEpisodes.innerHTML = "";
  state.openSeries = null;
  state.openSeriesData = null;
  updateUrl();
}

// Generic detail-panel close — used by the X button and Escape so the
// caller doesn't have to care which mode the panel is showing.
function closeDetail() {
  closePosterMenu();
  if (state.openMovie) closeMovie();
  else if (state.openSeries) closeSeries();
  else { el.seriesPanel.hidden = true; el.seriesPanel.removeAttribute("data-mode"); }
}

async function castMedia(p) {
  const ext = p.ext || pickExt(p.mode, p.item);
  let stream;
  try {
    stream = await resolveStreamUrl(p.mode, p.item.id, ext);
  } catch (e) {
    // Same unhandled-rejection gap as the direct-play path (see play()) —
    // a dead source or a displaced cap=1 slot failed completely silently.
    toast(
      e && /^HTTP 410/.test(e.message)
        ? "Another device started watching — try again in a moment."
        : "Couldn't start casting — this title may be unavailable.",
      4500,
    );
    return;
  }
  // Live channels often serve MPEG-2 which the Default Media Receiver
  // cannot decode; route them through the transcoder by default. Movies
  // and series cast the direct panel URL — fast and CPU-free.
  const useTranscode = p.mode === "live";
  const url = useTranscode
    ? new URL(stream.transcode, location.href).href
    : stream.direct;
  const contentType = useTranscode || ext === "m3u8"
    ? "application/x-mpegurl"
    : `video/${ext === "mkv" ? "x-matroska" : "mp4"}`;
  const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = p.label;
  mediaInfo.streamType = p.mode === "live" ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
  const request = new chrome.cast.media.LoadRequest(mediaInfo);
  try {
    await state.castSession.loadMedia(request);
    toast(useTranscode ? `Casting (transcoded): ${p.label}` : `Casting: ${p.label}`, 2500);
  } catch (e) {
    toast(`Cast failed: ${e.code || e}`, 4000);
  }
}

function initCast() {
  window["__onGCastApiAvailable"] = (isAvailable) => {
    if (!isAvailable) return;
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (ev) => {
      if (ev.sessionState === cast.framework.SessionState.SESSION_STARTED ||
          ev.sessionState === cast.framework.SessionState.SESSION_RESUMED) {
        state.castSession = ctx.getCurrentSession();
        const device = state.castSession.getCastDevice().friendlyName;
        toast(`Cast connected: ${device}`, 2500);
        // Stop local playback so the laptop isn't playing the same stream
        // alongside the cast device.
        el.video.pause();
        if (state.hls) { state.hls.destroy(); state.hls = null; }
        el.video.removeAttribute("src");
        el.video.load();
        if (state.playing) {
          castMedia(state.playing);
          el.playerTitle.textContent = `Casting "${state.playing.label}" → ${device}`;
        }
      } else if (ev.sessionState === cast.framework.SessionState.SESSION_ENDED) {
        state.castSession = null;
        state.castWasPlaying = false;
        if (state.playing) el.playerTitle.textContent = state.playing.label;
      }
    });

    // Auto-recast on stream error. A hard transcoder restart (provider crash /
    // CDN-host rotation) takes several seconds to produce the next segment —
    // longer than the Chromecast receiver waits at the live edge, so it ends
    // the session with idleReason ERROR. The server stream self-heals; we just
    // re-issue the cast so the receiver reloads to the new live edge. Without
    // this a live cast freezes permanently on any hard upstream hiccup.
    const rp = new cast.framework.RemotePlayer();
    const rpc = new cast.framework.RemotePlayerController(rp);
    rpc.addEventListener(cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
      const ps = rp.playerState;
      if (ps === chrome.cast.media.PlayerState.PLAYING) { state.castWasPlaying = true; return; }
      if (ps !== chrome.cast.media.PlayerState.IDLE) return;
      if (!state.castSession || !state.playing || !state.castWasPlaying) return;
      if (state.playing.mode !== "live") return; // a VOD ending is normal
      const ms = state.castSession.getMediaSession && state.castSession.getMediaSession();
      const reason = ms && ms.idleReason;
      // CANCELLED = the user stopped it; never fight that.
      if (reason === chrome.cast.media.IdleReason.CANCELLED) { state.castWasPlaying = false; return; }
      const now = Date.now();
      if (now - (state.castRecastAt || 0) > 60_000) state.castRecastCount = 0;
      if ((state.castRecastCount || 0) >= 5) {
        toast("Cast keeps dropping — stopped auto-retry. Tap to recast.", 5000);
        state.castWasPlaying = false;
        return;
      }
      state.castRecastCount = (state.castRecastCount || 0) + 1;
      state.castRecastAt = now;
      state.castWasPlaying = false;
      toast(`Cast interrupted — reconnecting…`, 2500);
      castMedia(state.playing);
    });
  };
}

function toast(msg, ms = 2500) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  if (ms > 0) toast._t = setTimeout(() => el.toast.hidden = true, ms);
}

function slugify(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
function tokenize(id, name) {
  // Smart-rail synth ids ("__rail-action") already carry their slug —
  // appending the categoryName-fallback (which falls back to the id
  // itself when no panel category matches) would double-slug as
  // "__rail-action-rail-action". Emit the id verbatim.
  if (typeof id === "string" && id.startsWith("__rail-")) return id;
  const slug = slugify(name);
  return slug ? `${id}-${slug}` : String(id);
}
function untoken(token) {
  const n = parseInt(token, 10);
  return Number.isFinite(n) ? n : null;
}

function categoryName(modeKey, catId) {
  const m = state.modes[modeKey];
  const cat = m.categories.find(c => String(c.category_id) === String(catId));
  return cat ? cat.category_name : String(catId);
}

function updateUrl({ push = false } = {}) {
  // The Hindi collection overlays the mode views; its URL is
  // /hindi/<movie|series> (+ any play/open verb). `m` becomes the
  // sub-mode so the play/open conditions below resolve correctly.
  const inCollection = state.view === "collection";
  const m = inCollection ? state.collectionMode : state.mode;
  const parts = inCollection ? ["hindi", state.collectionMode] : [m];
  if (inCollection) {
    /* no cat/query context in the collection view */
  } else if (state.query) {
    parts.push("q", encodeURIComponent(state.query));
  } else if (state.view === "grid") {
    if (ms().activeCatId === PSEUDO.FAVS) parts.push("favs");
    else if (ms().activeCatId === PSEUDO.MY_LIST) parts.push("mylist");
    else if (ms().activeCatId === PSEUDO.ALL) parts.push("all");
    else if (ms().activeCatId === PSEUDO.RECENTS) parts.push("recent");
    else if (ms().activeCatId) parts.push("cat", tokenize(ms().activeCatId, categoryName(m, ms().activeCatId)));
  }
  if (state.playing) {
    parts.push("play", tokenize(state.playing.item.id, state.playing.label));
    if (state.playing.ext) parts.push(state.playing.ext);
  } else if (state.openSeries && m === "series") {
    parts.push("open", tokenize(state.openSeries.id, state.openSeries.name));
  } else if (state.openMovie && m === "movie") {
    parts.push("open", tokenize(state.openMovie.id, state.openMovie.name));
  }
  const url = "/" + parts.join("/");
  if (location.pathname !== url) {
    if (push) history.pushState(null, "", url);
    else history.replaceState(null, "", url);
  }
  document.title = state.playing
    ? `${state.playing.label} · Khouch Potato`
    : state.openSeries ? `${state.openSeries.name} · Khouch Potato`
    : state.openMovie ? `${state.openMovie.name} · Khouch Potato`
    : state.query ? `“${state.query}” · Khouch Potato`
    : "Khouch Potato";
}

const SCROLL_KEY_RE = /^\/[^/]+(\/(cat|q|favs|all|recent)(\/[^/]+)?)?/;
function scrollKey() {
  const m = location.pathname.match(SCROLL_KEY_RE);
  return m ? m[0] : location.pathname;
}
function saveScroll() {
  try { sessionStorage.setItem(`scroll:${scrollKey()}`, String(el.grid.scrollTop)); } catch {}
}
function restoreScroll() {
  try {
    const v = sessionStorage.getItem(`scroll:${scrollKey()}`);
    if (v) el.grid.scrollTop = Number(v);
  } catch {}
}
let scrollSaveTimer;
function scheduleSaveScroll() {
  clearTimeout(scrollSaveTimer);
  scrollSaveTimer = setTimeout(saveScroll, 150);
}

async function applyPath() {
  const path = location.pathname.replace(/^\/+|\/+$/g, "");
  if (!path) return;
  const parts = path.split("/").filter(Boolean);
  const mode = parts[0];
  // Hindi collection: /hindi/<movie|series>. Restore the view on
  // refresh / back-forward. Any trailing play/open verb is ignored
  // (the collection doesn't deep-link into a specific title).
  if (mode === "hindi") {
    // Back/forward out of an open movie/series modal that was launched
    // from the collection — clear it directly (mirrors the stale-modal
    // teardown the mode path does below, which our early return skips).
    if (state.openMovie || state.openSeries) {
      closePosterMenu();
      el.seriesPanel.hidden = true;
      el.seriesPanel.removeAttribute("data-mode");
      el.seriesEpisodes.innerHTML = "";
      state.openMovie = null;
      state.openMovieData = null;
      state.openSeries = null;
      state.openSeriesData = null;
    }
    const sub = parts[1] === "series" ? "series" : "movie";
    enterCollection(sub, { skipUrl: true });
    return;
  }
  if (!MODES.includes(mode)) return;

  // Browser-back from /<mode>/.../open/<id> pops to a URL that no longer
  // references the modal — clear panel + state directly (don't call
  // closeMovie/closeSeries here, since their updateUrl() would race
  // against the popstate-driven URL we're already responding to).
  const openIdx = parts.indexOf("open");
  const urlOpenId = openIdx >= 0 && parts[openIdx + 1] ? untoken(parts[openIdx + 1]) : null;
  const movieStale = state.openMovie && (mode !== "movie" || state.openMovie.id !== urlOpenId);
  const seriesStale = state.openSeries && (mode !== "series" || state.openSeries.id !== urlOpenId);
  if (movieStale || seriesStale) {
    closePosterMenu();
    el.seriesPanel.hidden = true;
    el.seriesPanel.removeAttribute("data-mode");
    el.seriesEpisodes.innerHTML = "";
    state.openMovie = null;
    state.openMovieData = null;
    state.openSeries = null;
    state.openSeriesData = null;
  }

  setMode(mode, { skipUrl: true, skipSelect: true });

  // Walk parts left-to-right: first set context (cat/q/favs/all/recent),
  // then handle the action verb (play/open) which may follow.
  let i = 1;
  let contextApplied = false;
  while (i < parts.length) {
    const tok = parts[i];
    if (tok === "cat" && parts[i + 1]) {
      // Smart rails are server-tagged with category_id "__rail-<slug>".
      // The url segment for those starts with "__rail-" — untoken's
      // parseInt path returns null for them, so handle that case
      // explicitly before falling through to the numeric panel cat lookup.
      // Without this branch, deep-linking / refreshing a smart-rail
      // See-all URL leaves the user on the home view (the historical
      // "blank page on mobile" symptom).
      const seg = String(parts[i + 1] || "");
      if (seg.startsWith("__rail-")) {
        const slug = seg.replace(/^__rail-/, "").split("-")[0]; // first slug segment only
        // We trust the server's emitted category_id over a guessed
        // reconstruction — look up the exact one in state.home.
        await fetchHomeRails(state.mode);
        const home = state.home[state.mode];
        const rail = (home?.rails || []).find(r =>
          typeof r.category_id === "string" &&
          r.category_id.startsWith("__rail-") &&
          // Match on the slug we extracted; tolerate the appended
          // "name" portion in the URL like __rail-action-some-name.
          (r.category_id === `__rail-${slug}` ||
           r.category_id === `__rail-${seg.replace(/^__rail-/, "")}`));
        if (rail) await selectCategory(rail.category_id, { skipUrl: true });
      } else {
        const id = untoken(parts[i + 1]);
        if (id != null) await selectCategory(id, { skipUrl: true });
      }
      contextApplied = true;
      i += 2;
    } else if (tok === "q" && parts[i + 1]) {
      // Same flow live-typing search already uses (showSearchAll() +
      // renderUnifiedSearch(), server-backed via /api/search/all) instead
      // of the old flatStreams()-based grid render — that branch is dead
      // for movie/series/disk now that pollIndex() no longer populates
      // the full catalog.
      state.query = decodeURIComponent(parts[i + 1]);
      el.search.value = state.query;
      if (typeof syncSearchClearVisibility === "function") syncSearchClearVisibility();
      showSearchAll();
      renderUnifiedSearch(state.query);
      contextApplied = true;
      i += 2;
    } else if (tok === "mylist") {
      await selectCategory(PSEUDO.MY_LIST, { skipUrl: true });
      contextApplied = true; i += 1;
    } else if (tok === "favs") {
      await selectCategory(PSEUDO.FAVS, { skipUrl: true });
      contextApplied = true; i += 1;
    } else if (tok === "all") {
      await selectCategory(PSEUDO.ALL, { skipUrl: true });
      contextApplied = true; i += 1;
    } else if (tok === "recent") {
      await selectCategory(PSEUDO.RECENTS, { skipUrl: true });
      contextApplied = true; i += 1;
    } else if (tok === "play" && parts[i + 1]) {
      const id = untoken(parts[i + 1]);
      const ext = parts[i + 2];
      if (id == null) { i += 2; continue; }
      if (!contextApplied) showHome();
      // Live's full catalog is still resident (fast synchronous lookup);
      // movie/series/disk resolve via the single-item endpoint since
      // pollIndex() no longer downloads their full catalog. This is a
      // local Express route reading an in-memory Map, not an upstream
      // panel round-trip, so blocking here is cheap.
      let item = mode === "live" ? ms().streams.find(s => s.id === id) : await fetchSingleItem(mode, id);
      if (!item) item = { id, name: parts[i + 1].replace(/^\d+-/, "").replace(/-/g, " ") || `Item ${id}`, container: ext };
      // We're auto-resuming a stream from a deep-link URL — usually a
      // hard-refresh of a tab that was already playing. The previous
      // session's beforeunload kill-POST may or may not have landed
      // server-side yet, so explicitly wait for a fresh kill-all to
      // complete before starting playback. Together with the proxy's
      // res.on("close") abort handler this guarantees the panel sees
      // exactly one connection at a time and can never trip
      // max_connections=1.
      await stopServerStreams();
      await new Promise(r => setTimeout(r, 200));
      play(mode, item, item.name, ext);
      i += ext ? 3 : 2;
    } else if (tok === "open" && parts[i + 1] && (mode === "series" || mode === "movie")) {
      const id = untoken(parts[i + 1]);
      if (id == null) { i += 2; continue; }
      if (!contextApplied) showHome();
      // mode is always "series" or "movie" here (see the else-if guard
      // above) — always resolve via the single-item endpoint; openMovie()/
      // openSeries() immediately re-fetch full detail via /api/{mode}/info
      // regardless, so this only needs to seed a title/icon stub.
      let item = await fetchSingleItem(mode, id);
      if (mode === "series") {
        if (!item) item = { id, name: parts[i + 1].replace(/^\d+-/, "").replace(/-/g, " ") || `Series ${id}` };
        openSeries(item);
      } else {
        if (!item) item = { id, name: parts[i + 1].replace(/^\d+-/, "").replace(/-/g, " ") || `Movie ${id}` };
        openMovie(item);
      }
      i += 2;
    } else {
      i += 1;
    }
  }
  // No context (e.g. /movie) → land on the home view (rails).
  if (!contextApplied) showHome();
  requestAnimationFrame(() => requestAnimationFrame(restoreScroll));
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

// --- Filter modal -----------------------------------------------------
let _filterDraft = null; // { live: Set, movie: Set, series: Set }
let _filterTab = "live";
let _filterUnified = false; // true during first-run unified onboarding
function openFilterModal({ firstRun = false } = {}) {
  _filterTab = state.mode;
  _filterUnified = firstRun && !state.filter.onboarded;
  // Build a draft Set per mode over ALL of MODES — the first-run unified
  // body loops MODES (incl. "disk") when a chip is toggled, so a missing
  // key threw inside the chip onclick and left onboarding un-completable
  // (chip never highlighted, Done never enabled).
  _filterDraft = {};
  for (const m of MODES) _filterDraft[m] = new Set(state.filter.groups[m] || []);
  el.filterClose.hidden = _filterUnified;
  el.filterModal.classList.toggle("filter-unified", _filterUnified);
  if (el.filterHeading) {
    el.filterHeading.textContent = _filterUnified
      ? "What do you like to watch?"
      : "Pick what you watch";
  }
  document.body.classList.add("filter-open");
  el.filterModal.hidden = false;
  if (_filterUnified) {
    renderUnifiedFilterBody();
  } else {
    syncFilterTabs();
    renderFilterBody();
  }
  updateFilterDoneEnabled();
}
function closeFilterModal() {
  document.body.classList.remove("filter-open");
  el.filterModal.hidden = true;
  _filterDraft = null;
}

// ── Refine For You ──────────────────────────────────────────────────
// Active batch calibration. The server returns a diverse, kid/lang-gated
// set (already excluding anything thumbed); the user marks each title and
// Save writes the verdicts into state.feedback then re-ranks immediately.
let _refineTab = "movie";
let _refineData = { movie: null, series: null };
let _refineDraft = {};       // "mode:id" -> verdict
const REFINE_VERDICTS = [
  { key: "seen_up",        label: "👍 Seen it" },
  { key: "seen_down",      label: "👎 Seen it" },
  { key: "not_interested", label: "Not for me" },
  { key: "not_seen",       label: "Haven't seen" },
];

function openRefineModal() {
  _refineTab = state.mode === "series" ? "series" : "movie";
  _refineData = { movie: null, series: null };
  _refineDraft = {};
  document.body.classList.add("filter-open");
  el.refineModal.hidden = false;
  syncRefineTabs();
  renderRefineBody();
  for (const m of ["movie", "series"]) {
    fetch(`/api/refine/candidates/${m}`, { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { _refineData[m] = (d && Array.isArray(d.items)) ? d.items : []; if (_refineTab === m) renderRefineBody(); })
      .catch(() => { _refineData[m] = []; if (_refineTab === m) renderRefineBody(); });
  }
}
function closeRefineModal() {
  document.body.classList.remove("filter-open");
  el.refineModal.hidden = true;
  _refineData = { movie: null, series: null };
  _refineDraft = {};
}
function syncRefineTabs() {
  for (const t of el.refineTabs) t.classList.toggle("active", t.dataset.refineTab === _refineTab);
}
function renderRefineBody() {
  const body = el.refineBody;
  body.innerHTML = "";
  const items = _refineData[_refineTab];
  if (items === null) { body.innerHTML = `<div class="refine-empty">Loading…</div>`; return; }
  if (!items.length) { body.innerHTML = `<div class="refine-empty">Not enough catalog data yet — watch or favorite a few titles first, then come back.</div>`; return; }
  const grid = document.createElement("div");
  grid.className = "refine-grid";
  for (const it of items) {
    const key = `${_refineTab}:${it.id}`;
    const cell = document.createElement("div");
    cell.className = "refine-cell";
    const poster = document.createElement("div");
    poster.className = "refine-poster";
    if (it.poster) {
      const img = document.createElement("img");
      img.src = it.poster; img.alt = ""; img.loading = "lazy";
      poster.appendChild(img);
    } else {
      poster.classList.add("refine-poster-blank");
      poster.textContent = initials(it.name);
    }
    const name = document.createElement("div");
    name.className = "refine-name";
    name.textContent = it.name + (it.year ? ` (${it.year})` : "");
    const row = document.createElement("div");
    row.className = "refine-verdicts";
    for (const v of REFINE_VERDICTS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "refine-verdict" + ((_refineDraft[key] || "not_seen") === v.key ? " on" : "");
      b.textContent = v.label;
      b.onclick = () => {
        _refineDraft[key] = v.key;
        for (const sib of row.children) sib.classList.toggle("on", sib === b);
      };
      row.appendChild(b);
    }
    cell.append(poster, name, row);
    grid.appendChild(cell);
  }
  body.appendChild(grid);
}
async function saveRefine() {
  // Verdicts → mutually-exclusive up/down sets. "Haven't seen" / unset =
  // no signal (but clear any stale membership defensively).
  for (const [key, verdict] of Object.entries(_refineDraft)) {
    const [mode, idStr] = key.split(":");
    if (!state.feedback.up[mode]) continue;
    const id = parseInt(idStr, 10);
    state.feedback.up[mode].delete(id);
    state.feedback.down[mode].delete(id);
    if (verdict === "seen_up") state.feedback.up[mode].add(id);
    else if (verdict === "seen_down" || verdict === "not_interested") state.feedback.down[mode].add(id);
  }
  el.refineSave.disabled = true;
  el.refineSave.textContent = "Saving…";
  // Flush now (don't wait on the debounced pushUserState) so the rebuild
  // reads the fresh feedback.
  try {
    await fetch("/api/user-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback: {
        up:   { movie: [...state.feedback.up.movie],   series: [...state.feedback.up.series],   disk: [...state.feedback.up.disk] },
        down: { movie: [...state.feedback.down.movie], series: [...state.feedback.down.series], disk: [...state.feedback.down.disk] },
      } }),
    });
  } catch {}
  refreshView();
  closeRefineModal();
  el.refineSave.disabled = false;
  el.refineSave.textContent = "Save & refresh";
  // Immediate re-rank of this profile; on success drop the cached home
  // rails so the "For You" row rebuilds from the new picks.
  try {
    const r = await fetch("/api/refine/rebuild", { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (d && d.ok) {
      state.home.movie = null; state.home.series = null;
      // Repopulate the cache then re-render whatever view is active
      // (refreshView, not renderHome — the user may not be on Home).
      if (state.mode !== "live") { await fetchHomeRails(state.mode); refreshView(); }
      toast("Recommendations updated");
    } else {
      toast("Saved — For You updates overnight");
    }
  } catch {
    toast("Saved — For You updates overnight");
  }
}
function syncFilterTabs() {
  for (const t of el.filterTabs) {
    t.classList.toggle("active", t.dataset.tab === _filterTab);
  }
}
function renderUnifiedFilterBody() {
  // Merge all groups across all three modes, deduplicated by key.
  const seen = new Set();
  const groups = [];
  for (const m of MODES) {
    for (const g of detectGroups(m)) {
      if (!seen.has(g.key)) { seen.add(g.key); groups.push(g); }
    }
  }
  el.filterBody.innerHTML = "";
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No categories yet — wait for the index to finish, then reopen.";
    el.filterBody.appendChild(empty);
    return;
  }
  for (const g of groups) {
    const chip = document.createElement("button");
    chip.type = "button";
    // Use live draft as the single representative — all three are kept in sync
    chip.className = "filter-chip" + (_filterDraft.live.has(g.key) ? " on" : "");
    chip.dataset.key = g.key;
    chip.innerHTML = `<span>${escapeHtml(g.label)}</span>`;
    chip.onclick = () => {
      const add = !_filterDraft.live.has(g.key);
      for (const m of MODES) {
        if (add) _filterDraft[m].add(g.key);
        else _filterDraft[m].delete(g.key);
      }
      chip.classList.toggle("on", add);
      updateFilterDoneEnabled();
    };
    el.filterBody.appendChild(chip);
  }
}

function renderFilterBody() {
  const groups = detectGroups(_filterTab);
  el.filterBody.innerHTML = "";
  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "filter-empty";
    empty.textContent = "No categories yet — wait for the index to finish, then reopen.";
    el.filterBody.appendChild(empty);
    return;
  }
  const selected = _filterDraft[_filterTab];
  for (const g of groups) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "filter-chip" + (selected.has(g.key) ? " on" : "");
    chip.dataset.key = g.key;
    chip.innerHTML = `<span>${escapeHtml(g.label)}</span><span class="chip-count">${g.count}</span>`;
    chip.onclick = () => {
      if (selected.has(g.key)) selected.delete(g.key);
      else selected.add(g.key);
      chip.classList.toggle("on", selected.has(g.key));
      updateFilterDoneEnabled();
    };
    el.filterBody.appendChild(chip);
  }
}
function updateFilterDoneEnabled() {
  // Require at least one pick across modes for first-run; afterwards
  // empty selections are allowed (they just mean "show nothing in default
  // views for that mode"; user can use "Show all" to bypass).
  if (state.filter.onboarded) {
    el.filterDone.disabled = false;
    return;
  }
  const total = (_filterDraft.live.size + _filterDraft.movie.size + _filterDraft.series.size);
  el.filterDone.disabled = total === 0;
}
function commitFilterDraft() {
  if (!_filterDraft) return;
  state.filter.groups.live   = new Set(_filterDraft.live);
  state.filter.groups.movie  = new Set(_filterDraft.movie);
  state.filter.groups.series = new Set(_filterDraft.series);
  state.filter.onboarded = true;
  pushUserState();
  refreshShowAllBtn();
  // If the user is currently inside a category that just got filtered
  // out, bounce back to home so they're not staring at an empty grid.
  if (state.view === "grid") {
    const activeId = ms().activeCatId;
    if (activeId !== PSEUDO.RECENTS && activeId !== PSEUDO.FAVS && activeId !== PSEUDO.MY_LIST && activeId !== PSEUDO.ALL) {
      const cat = ms().categories.find(c => String(c.category_id) === String(activeId));
      if (cat && !categoryPasses(state.mode, cat)) {
        showHome();
        return;
      }
    }
  }
  refreshView();
}

// Called once after bootstrap. Waits for at least the active mode's
// categories to be ready so detectGroups() actually has data to show.
function maybeOpenFirstRunFilter() {
  if (state.filter.onboarded) return;
  let tries = 0;
  const poll = () => {
    tries++;
    const haveAny = MODES.some(m => state.modes[m].categories.length > 0);
    if (haveAny) { openFilterModal({ firstRun: true }); return; }
    if (tries < 40) setTimeout(poll, 250); // give up after ~10s
  };
  poll();
}

function setShowAll(on) {
  state.showAll = !!on;
  if (el.showAllBtn) el.showAllBtn.classList.toggle("on", state.showAll);
  refreshView();
}

function refreshShowAllBtn() {
  if (!el.showAllBtn) return;
  const active = state.filter.onboarded
    && (state.filter.groups.live.size + state.filter.groups.movie.size + state.filter.groups.series.size) > 0;
  el.showAllBtn.hidden = !active;
  el.showAllBtn.classList.toggle("on", state.showAll);
}

function syncSearchClearVisibility() {
  const hasValue = !!el.search.value;
  // Mobile collapses the search-wrap to a 40px round icon when empty
  // and unfocused. Keep it expanded after blur if there's a typed
  // query — pairs with CSS's :focus-within selector.
  const wrap = el.search.closest(".search-wrap");
  if (wrap) wrap.classList.toggle("has-value", hasValue);
  if (el.searchClear) el.searchClear.hidden = !hasValue;
}
if (el.searchClear) {
  el.searchClear.addEventListener("click", () => {
    if (!el.search.value) return;
    el.search.value = "";
    state.query = "";
    syncSearchClearVisibility();
    // Restore the original view — same branch the input handler runs
    // when it sees an empty query.
    if (state.mode === "live" && state.view === "home") {
      renderGuideTabBody();
    } else {
      showHome();
    }
    updateUrl({ push: false });
    el.search.focus();
  });
}
// Mobile WebKit doesn't reliably re-style on :focus-within alone (the
// collapsed search pill stayed invisible while typing until an
// orientation change forced a re-layout) — mirror focus into a class
// the CSS can key off instead.
el.search.addEventListener("focus", () => {
  el.search.closest(".search-wrap")?.classList.add("focused");
});
el.search.addEventListener("blur", () => {
  el.search.closest(".search-wrap")?.classList.remove("focused");
});
// bfcache restores snapshot the DOM classes but not focus — without
// this, a page restored mid-search keeps .focused (pill stuck open)
// until the user focuses and blurs the field again.
window.addEventListener("pageshow", () => {
  el.search.closest(".search-wrap")
    ?.classList.toggle("focused", document.activeElement === el.search);
});
let searchTimer;
el.search.addEventListener("input", () => {
  syncSearchClearVisibility();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = el.search.value.trim();
    if (state.playing && el.player.dataset.mode === "theater") setPlayerMode("mini");
    if (state.query) {
      showSearchAll();
      renderUnifiedSearch(state.query);
    } else {
      showHome();
    }
    updateUrl({ push: false });
  }, 250);
});

el.searchAllBack.onclick = () => {
  state.query = "";
  el.search.value = "";
  syncSearchClearVisibility();
  showHome();
  updateUrl({ push: false });
};

for (const btn of el.modeButtons) {
  btn.onclick = () => {
    if (state.playing && el.player.dataset.mode === "theater") setPlayerMode("mini");
    setMode(btn.dataset.mode);
  };
}
if (el.hindiTab) el.hindiTab.onclick = () => enterCollection(state.collectionMode);
if (el.collectionMovieBtn) el.collectionMovieBtn.onclick = () => enterCollection("movie");
if (el.collectionSeriesBtn) el.collectionSeriesBtn.onclick = () => enterCollection("series");

el.playerClose.onclick = closePlayer;
el.playerAlt.onclick = tryAlternateFormat;
el.playerTheater.onclick = () => setPlayerMode("theater");
el.playerMini.onclick = () => setPlayerMode("mini");
el.playerFullscreen.onclick = () => setPlayerMode("fullscreen");
el.playerCC.onclick = (e) => { e.stopPropagation(); toggleCcMenu(); };
if (el.playerTracks) el.playerTracks.onclick = (e) => { e.stopPropagation(); toggleDiskTracksMenu(); };
if (el.playerTracksMenu) el.playerTracksMenu.onclick = (e) => {
  const btn = e.target.closest(".tracks-item");
  if (!btn) return;
  e.stopPropagation();
  if (btn.dataset.kind === "audio") selectDiskAudio(Number(btn.dataset.idx));
  else if (btn.dataset.kind === "sub") selectDiskSub(btn.dataset.idx);
};
el.playerQuality.onclick = (e) => { e.stopPropagation(); toggleQualityMenu(); };
if (el.playerAudio) el.playerAudio.onclick = (e) => { e.stopPropagation(); toggleAudioMenu(); };
refreshQualityButton();

// ── Overlay controls: auto-hide, click-to-pause, scrub bar ──────────

const elPlayPause   = document.getElementById("player-playpause");
const elScrubTrack    = document.getElementById("player-scrub-track");
const elScrubBuffered = document.getElementById("player-scrub-buffered");
const elScrubFill     = document.getElementById("player-scrub-fill");
const elScrubThumb    = document.getElementById("player-scrub-thumb");
const elPlayerTime    = document.getElementById("player-time");
const elLiveBadge   = document.getElementById("player-live-badge");

let _controlsTimer = null;
function showControls() {
  el.player.classList.remove("controls-hidden");
  clearTimeout(_controlsTimer);
  // Only auto-hide when a stream is actually playing (not paused)
  if (!el.video.paused) {
    _controlsTimer = setTimeout(() => el.player.classList.add("controls-hidden"), 3000);
  }
}
function keepControlsVisible() {
  clearTimeout(_controlsTimer);
  el.player.classList.remove("controls-hidden");
}

el.player.addEventListener("mousemove", showControls);
el.player.addEventListener("touchstart", showControls, { passive: true });

// Click video → toggle play/pause + show controls
el.video.addEventListener("click", (e) => {
  e.stopPropagation();
  if (el.video.paused) { el.video.play(); showControls(); }
  else { el.video.pause(); keepControlsVisible(); }
});

// Play/pause button
elPlayPause.addEventListener("click", (e) => {
  e.stopPropagation();
  if (el.video.paused) el.video.play(); else el.video.pause();
});

// Sync play/pause button icon + controls visibility
el.video.addEventListener("play",  () => { elPlayPause.textContent = "⏸"; showControls(); });
el.video.addEventListener("pause", () => { elPlayPause.textContent = "▶"; keepControlsVisible(); });

// Loading spinner driver. `playing` fires when frames actually start
// rendering (after the user-visible "preparing" gap). `waiting` fires
// when the player has to stall mid-stream for the next buffer. `error`
// hides so the error banner can take over without two overlays
// competing.
const hideSpinner = () => { if (el.spinner) el.spinner.hidden = true; };
const showSpinner = () => { if (el.spinner) el.spinner.hidden = false; };
el.video.addEventListener("playing", hideSpinner);
el.video.addEventListener("canplay", hideSpinner);
el.video.addEventListener("waiting", showSpinner);
el.video.addEventListener("error",   hideSpinner);

// Scrub bar — timeupdate + buffered.
//
// For transcoded movies the "true" duration comes from the panel's
// info (state.playing.fullDurationSecs), not el.video.duration —
// the latter only covers ffmpeg's encoded-so-far HLS playlist and
// would lie about the movie being short. The encoded-edge is still
// rendered as the lighter "buffered" fill so the user can see how
// far the scrubber will go without triggering a re-anchor.
function updateScrubBar() {
  const playlistDur = el.video.duration;
  if (!playlistDur || !isFinite(playlistDur)) return;
  const cur = el.video.currentTime;
  const anchor = (state.playing && state.playing.transcodeAnchorSecs) || 0;
  const fullDur = (state.playing && state.playing.fullDurationSecs) || 0;
  const useFullDur = state.playing && state.playing.transcode && fullDur > 0;
  const denom = useFullDur ? fullDur : playlistDur;
  const realPos = anchor + cur;
  const playPct = Math.min(100, (realPos / denom) * 100);
  elScrubFill.style.width = playPct + "%";
  elScrubThumb.style.left = playPct + "%";
  elPlayerTime.textContent = formatPos(realPos) + " / " + formatPos(denom);
  // Find the buffered range that covers currentTime and show its end
  const buf = el.video.buffered;
  let bufEnd = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf.start(i) <= cur && buf.end(i) > bufEnd) bufEnd = buf.end(i);
  }
  const realBufEnd = anchor + bufEnd;
  elScrubBuffered.style.width = Math.min(100, (realBufEnd / denom) * 100) + "%";
  // Up-Next card: surface in the last ~20s of a series episode that has a
  // next episode. denom is the authoritative full duration (handles the
  // transcode-playlist-vs-source-length case). Hidden otherwise.
  if (state.playing && state.playing.mode === "series" && state.playing.nextEpisode
      && denom > 0 && realPos >= denom - UPNEXT_LEAD_SECS && realPos < denom) {
    showUpNext();
  } else if (el.playerUpnext && !el.playerUpnext.hidden) {
    hideUpNext();
  }
}
el.video.addEventListener("timeupdate", updateScrubBar);
el.video.addEventListener("progress",   updateScrubBar);

// Scrub bar — seek on click/drag
function pctFromEvent(e) {
  const rect = elScrubTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}
function setScrubVisual(pct) {
  elScrubFill.style.width = (pct * 100) + "%";
  elScrubThumb.style.left = (pct * 100) + "%";
}
function seekToPct(pct) {
  const playlistDur = el.video.duration;
  if (!playlistDur || !isFinite(playlistDur)) return;
  const anchor = (state.playing && state.playing.transcodeAnchorSecs) || 0;
  const fullDur = (state.playing && state.playing.fullDurationSecs) || 0;
  const useFullDur = state.playing && state.playing.transcode && fullDur > 0;
  // Where the user wants to land, in real movie time (seconds).
  const targetReal = pct * (useFullDur ? fullDur : playlistDur);
  // Where that lands inside the current playlist (after subtracting
  // out the anchor offset). If it's within the encoded range, do a
  // normal in-playlist seek. Otherwise re-anchor — kill the current
  // ffmpeg and ask for a fresh playlist starting at targetReal.
  const targetInPlaylist = targetReal - anchor;
  if (!useFullDur || (targetInPlaylist >= 0 && targetInPlaylist < playlistDur)) {
    el.video.currentTime = Math.max(0, targetInPlaylist);
    return;
  }
  reanchorTo(Math.floor(targetReal));
}

// Re-anchor the transcode at `targetSecs` of the source. Server
// tears down the current ffmpeg and spawns a fresh one with
// -ss <secs>, returning a new manifest URL whose timeline starts at
// 0 representing targetSecs of real movie time. We reload the hls.js
// instance and stash the anchor on state.playing so updateScrubBar
// + seekToPct can keep speaking in real-movie-time.
async function reanchorTo(targetSecs) {
  if (!state.playing || !state.playing.transcode) return;
  // Re-anchor tears the video element down and rebuilds it. The
  // browser's `waiting` event — which normally drives the spinner —
  // never fires here because there's no in-progress decode to stall.
  // Show the spinner explicitly so the user has SOME signal during
  // the multi-second ffmpeg-respawn + manifest-parse gap. The
  // existing `playing` / `canplay` listeners will hide it once
  // frames actually render.
  showSpinner();
  toast("Skipping ahead — restarting transcode at the new position…", 4000);
  const p = state.playing;
  let resolved;
  try {
    resolved = await resolveStreamUrl(p.mode, p.item.id, p.ext, targetSecs);
  } catch (e) {
    hideSpinner();
    toast("Couldn't re-anchor: " + e.message, 4000);
    return;
  }
  let url = resolved.transcode
    + (p.quality ? `&q=${p.quality}` : "")
    + (p.audioTrack ? `&at=${p.audioTrack}` : "");
  p.transcodeAnchorSecs = targetSecs;
  if (state.hls) { state.hls.destroy(); state.hls = null; }
  el.video.removeAttribute("src");
  const hls = new Hls({
    lowLatencyMode: false,
    liveSyncDurationCount: 4,
    maxBufferLength: 30,
  });
  hls.loadSource(url);
  hls.attachMedia(el.video);
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    el.video.play().catch(() => {});
  });
  // Backstop: if the new transcoder doesn't deliver a playable frame
  // within ~20s, hide the spinner and surface what happened so the
  // user isn't left staring at a frozen spinner.
  setTimeout(() => {
    if (!el.spinner?.hidden) {
      hideSpinner();
      toast("Transcoder is taking longer than usual — check the panel?", 5000);
    }
  }, 20000);
  state.hls = hls;
}

// Click (no drag): seek immediately
elScrubTrack.addEventListener("click", (e) => seekToPct(pctFromEvent(e)));

// Drag: move thumb visually; seek only on release
elScrubTrack.addEventListener("pointerdown", (e) => {
  e.currentTarget.setPointerCapture(e.pointerId);
  let lastPct = pctFromEvent(e);
  setScrubVisual(lastPct);
  const onMove = (ev) => {
    lastPct = pctFromEvent(ev);
    setScrubVisual(lastPct);
  };
  const onUp = () => {
    seekToPct(lastPct);
    elScrubTrack.removeEventListener("pointermove", onMove);
  };
  elScrubTrack.addEventListener("pointermove", onMove);
  elScrubTrack.addEventListener("pointerup", onUp, { once: true });
});

// Live badge vs scrub bar visibility
function refreshScrubState() {
  if (!state.playing) return;
  const isLive = state.playing.mode === "live";
  elLiveBadge.hidden = !isLive;
  elScrubTrack.closest("#player-scrub-wrap").hidden = false;
  // Only live disables the scrub track — its sliding-window manifest
  // has no concept of seeking. Transcoded VOD (every MKV + any movie
  // the user picked a quality preset for) can be scrubbed too: seek
  // within the encoded HLS window when possible, else re-anchor
  // ffmpeg at the target time. The seek logic in seekToPct already
  // handles both paths; the leftover `isTranscode` here was a stale
  // guard from before re-anchor shipped that left MKVs unscrubbable.
  el.player.classList.toggle("scrub-disabled", isLive);
  if (isLive) {
    elScrubFill.style.width = "100%";
    elScrubThumb.style.left = "100%";
    elPlayerTime.textContent = "";
  }
}
// Called after each play() sets state.playing
const _origSetPlayerMode = setPlayerMode;
// Hook into el.video load so scrub resets on each new stream
el.video.addEventListener("loadedmetadata", () => {
  elScrubFill.style.width = "0%";
  elScrubThumb.style.left = "0%";
  elScrubBuffered.style.width = "0%";
  elPlayerTime.textContent = "";
  refreshScrubState();
  showControls();
});

el.refresh.onclick = async () => {
  el.refresh.classList.add("spinning");
  toast("Refreshing library from panel…", 3000);
  try {
    await fetch("/api/refresh", { method: "POST" });
    for (const m of MODES) {
      state.modes[m].byCat = new Map();
      state.modes[m].catPaging = new Map();
      state.modes[m].streams = [];
      state.modes[m].indexReady = false;
    }
    const r = await fetch("/api/bootstrap");
    const d = await r.json();
    state.modes.live.categories   = Array.isArray(d.categories.live)   ? d.categories.live   : [];
    state.modes.movie.categories  = Array.isArray(d.categories.movie)  ? d.categories.movie  : [];
    state.modes.series.categories = Array.isArray(d.categories.series) ? d.categories.series : [];
    refreshView();
    pollIndex();
  } catch (e) {
    toast(`Refresh failed: ${e.message}`, 4000);
  } finally {
    el.refresh.classList.remove("spinning");
  }
};

setInterval(() => { el.refresh.click(); }, 60 * 60 * 1000);

el.panelSwitch.onclick = (e) => {
  e.stopPropagation();
  if (_panelMenuEl) closePanelMenu();
  else openPanelMenu();
};

// A server-sortable field on a paginated VOD category must refetch page 0
// in the new order (the client only holds a partial slice); everything
// else (live resident, recents, favs/my-list) just re-renders locally.
function resortActiveCategory() {
  const m = ms();
  const cid = String(m.activeCatId || "");
  const cfg = state.sort[state.mode] || {};
  const serverSortable = ["name", "added", "rating", "year"].includes(cfg.f);
  if (serverSortable && m.catPaging?.has(cid)) {
    m.byCat.delete(cid);
    m.catPaging.delete(cid);
    el.grid.innerHTML = `<div class="empty">Loading…</div>`;
    loadCategoryStreams(state.mode, m.activeCatId)
      .then(() => renderGrid())
      .catch(e => {
        el.grid.innerHTML = `<div class="empty">Couldn't load — try again.</div>`;
        toast(`Load failed: ${e.message}`, 4000);
      });
  } else {
    renderGrid();
  }
}
el.sortField.onchange = () => {
  state.sort[state.mode].f = el.sortField.value;
  localStorage.setItem(`sort:${state.mode}`, JSON.stringify(state.sort[state.mode]));
  resortActiveCategory();
};
el.sortDir.onclick = () => {
  state.sort[state.mode].dir = state.sort[state.mode].dir === "asc" ? "desc" : "asc";
  localStorage.setItem(`sort:${state.mode}`, JSON.stringify(state.sort[state.mode]));
  resortActiveCategory();
};

el.seriesClose.onclick = closeDetail;

// Verso tab switching. One delegated handler — clicking a tab toggles
// `.is-active` on the tab bar and shows the matching pane. Default
// active pane (More Like This) is set in the markup; the renderers
// for cast / similar / episodes populate their panes regardless of
// which is currently visible, so switching tabs never refetches.
document.querySelector(".verso-tabs")?.addEventListener("click", (e) => {
  const tab = e.target.closest(".verso-tab");
  if (!tab) return;
  const pane = tab.dataset.pane;
  document.querySelectorAll(".verso-tab").forEach(t => {
    const on = t === tab;
    t.classList.toggle("is-active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".verso-pane").forEach(p => {
    p.toggleAttribute("hidden", p.dataset.pane !== pane);
  });
});
// On every detail-modal open, pick the right default tab for the
// mode. Series leads with Episodes (the thing users actually came
// for); movies have no Episodes tab so they lead with More Like This.
function resetVersoTab() {
  const isSeries = el.seriesPanel.dataset.mode === "series";
  const preferred = isSeries ? "episodes" : "similar";
  const t = document.querySelector(`.verso-tab[data-pane="${preferred}"]`);
  if (t) t.click();
}

el.seriesSeasonSelect.onchange = () => {
  if (state.openSeries && state.openSeriesData) {
    renderSeriesEpisodes(state.openSeries, state.openSeriesData, el.seriesSeasonSelect.value);
  }
};
el.seriesPosterMenuBtn.onclick = (e) => {
  e.stopPropagation();
  if (el.seriesPosterMenuDropdown.hidden) openPosterMenu();
  else closePosterMenu();
};
el.seriesDiskBtn.onclick = (e) => {
  e.stopPropagation();
  if (el.seriesDiskDropdown.hidden) openDiskMenu();
  else closeDiskMenu();
};

// Player-bar ★ — toggles favorite for the currently-playing item (or
// its parent series, when an episode is playing).
el.playerFavorite.onclick = (e) => {
  e.stopPropagation();
  const target = favoriteTargetForPlaying();
  if (!target) return;
  toggleFav(target.mode, target.id);
  refreshPlayerFavorite();
};
el.playerMylist.onclick = (e) => {
  e.stopPropagation();
  const target = favoriteTargetForPlaying();
  if (!target) return;
  toggleMyList(target.mode, target.id);
  refreshPlayerFavorite();
};
el.seriesMyListBtn.onclick = (e) => {
  e.stopPropagation();
  const target = openItemTarget();
  if (!target) return;
  toggleMyList(target.mode, target.id);
  refreshSeriesMyListBtn();
  refreshSeriesThumbBtns();
};
el.seriesThumbUpBtn.onclick = (e) => {
  e.stopPropagation();
  const target = openItemTarget();
  if (!target) return;
  toggleFeedback(target.mode, target.id, "up");
  refreshSeriesThumbBtns();
};
el.seriesThumbDownBtn.onclick = (e) => {
  e.stopPropagation();
  const target = openItemTarget();
  if (!target) return;
  toggleFeedback(target.mode, target.id, "down");
  refreshSeriesThumbBtns();
};
el.seriesPlayBtn.onclick = () => {
  if (state.openMovie) {
    const m = state.openMovie;
    const playMode = state.openMovieMode || "movie";
    closeMovie();
    play(playMode, { id: m.id, name: m.name, container: m.container || "mp4" }, m.name);
    return;
  }
  if (!state.openSeries || !state.openSeriesData) return;
  const pick = pickResumeOrFirstEpisode(state.openSeries, state.openSeriesData);
  if (pick) playEpisode(state.openSeries, pick.ep, pick.sn);
};
el.gridBack.onclick = () => { showHome(); updateUrl({ push: true }); };
el.liveRemoteToggle.onclick = openLiveRemote;
el.playerRemote.onclick = (e) => { e.stopPropagation(); openLiveRemote(); };

// "↑ Top" button shows once you've scrolled the guide past 200px and
// scrolls back to the top when clicked. Cheap scroll listener — just
// toggles a class.
// Re-fit the guide on viewport resize. computeEpgPxPerMin reads
// el.guideScroll.clientWidth at render time, so a window resize
// changes how many px/min are available per hour. Debounced so
// continuous drag-resize doesn't thrash.
let _guideResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(_guideResizeTimer);
  _guideResizeTimer = setTimeout(() => {
    if (state.mode === "live" && !el.guide.hidden) renderGuide();
  }, 150);
});
el.guideTopBtn.onclick = () => {
  el.guideScroll.scrollTo({ top: 0, behavior: "smooth" });
};
el.guideScroll.addEventListener("scroll", () => {
  el.guideTopBtn.classList.toggle("show", el.guideScroll.scrollTop > 200);
}, { passive: true });

// Settings dropdown — consolidated menu for filter, refresh, and panel
// switch. Each item still routes to the existing flows / handlers.
function openSettingsMenu() {
  populateSettingsPanel();
  refreshRemoteToggleLabel();
  syncEpgWindowSelect();
  syncPanelExpiryLabel();
  // Surface the active profile next to "Switch profile…"
  const ph = document.getElementById("settings-profile-hint");
  if (ph && state.activeProfile) {
    ph.textContent = state.activeProfile.nick || "";
  }
  el.settingsMenu.hidden = false;
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (!el.settingsMenu.contains(e.target) && e.target !== el.settingsBtn) {
        closeSettingsMenu();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}
function closeSettingsMenu() { el.settingsMenu.hidden = true; }

// Header profile chip + click-to-switch popup. Mirrors the
// /profile/pick page's flow but stays in the current SPA — one click
// to swap profiles from any screen, no Settings dive. Same
// localStorage wipe as profile-pick.html so the next bootstrap
// starts clean and can't leak the previous profile's favorites.
function syncProfileChip() {
  if (!el.profileChip) return;
  const p = state.activeProfile;
  if (!p) { el.profileChip.hidden = true; return; }
  el.profileChip.hidden = false;
  // Render the user's chosen theatre portrait next to the nick,
  // small enough to live in the header without competing with
  // the brand mark or the search bar.
  const portraitSvg = (typeof TheatrePortraits !== "undefined")
    ? TheatrePortraits.svg(TheatrePortraits.resolve(p))
    : "";
  el.profileChip.innerHTML =
    `<span class="profile-chip-avatar">${portraitSvg}</span>` +
    `<span class="profile-chip-nick">${escapeHtml(p.nick || "")}</span>`;
}
async function openProfilePopup() {
  if (!el.profilePopup || !el.profileChip) return;
  el.profilePopup.innerHTML = `<div class="settings-section-title">Switch profile</div>`;
  let profiles;
  try {
    const r = await fetch("/api/profiles", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`profiles ${r.status}`);
    profiles = (await r.json()).profiles || [];
  } catch (e) {
    const err = document.createElement("div");
    err.style.cssText = "padding:8px 10px;color:var(--accent);font-size:12px;";
    err.textContent = `Couldn't load profiles — ${e.message}`;
    el.profilePopup.appendChild(err);
    el.profilePopup.hidden = false;
    return;
  }
  const activeId = state.activeProfile?.id;
  for (const p of profiles) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "profile-popup-item" + (p.id === activeId ? " active" : "");
    const portraitSvg = (typeof TheatrePortraits !== "undefined")
      ? TheatrePortraits.svg(TheatrePortraits.resolve(p))
      : "";
    b.innerHTML =
      `<span class="profile-popup-avatar">${portraitSvg}</span>` +
      `<span class="nick">${escapeHtml(p.nick || "")}</span>` +
      (Number.isFinite(p.kidsBirthYear) ? `<span class="kid">Kid</span>` : "");
    b.onclick = () => switchProfileFromPopup(p.id);
    el.profilePopup.appendChild(b);
  }
  el.profilePopup.hidden = false;
  setTimeout(() => {
    document.addEventListener("click", function onDoc(e) {
      if (!el.profilePopup.contains(e.target) && e.target !== el.profileChip) {
        closeProfilePopup();
        document.removeEventListener("click", onDoc);
      }
    });
  }, 0);
}
function closeProfilePopup() { if (el.profilePopup) el.profilePopup.hidden = true; }
async function switchProfileFromPopup(id) {
  if (id === state.activeProfile?.id) { closeProfilePopup(); return; }
  try {
    const r = await fetch("/api/profile/select", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) throw new Error(`select ${r.status}`);
  } catch (e) {
    toast(`Profile switch failed — ${e.message}`, 4000);
    return;
  }
  // Same wipe as profile-pick.html so the next bootstrap starts
  // clean. Without this, app.js's loadPersisted() rehydrates the
  // previous profile's favorites / recents / lastEpisode and the
  // bootstrap's "server-empty → keep-local-and-seed" branch silently
  // pushes them up to the new profile.
  try {
    for (const m of MODES) {
      localStorage.removeItem(`favs:${m}`);
      localStorage.removeItem(`myList:${m}`);
      localStorage.removeItem(`recents:${m}`);
      localStorage.removeItem(`sort:${m}`);
    }
    localStorage.removeItem("lastEpisode");
    localStorage.removeItem("watched");
  } catch {}
  location.href = `/${state.mode || "live"}/`;
}
function populateSettingsPanel() {
  if (!_panelInfo || (_panelInfo.candidates || []).length < 2) {
    el.settingsPanelSection.hidden = true;
    return;
  }
  el.settingsPanelSection.hidden = false;
  el.settingsPanelList.innerHTML = "";
  for (const host of _panelInfo.candidates) {
    const isActive = host === _panelInfo.active;
    const isPrimary = host === _panelInfo.primary;
    const hostLabel = (() => { try { return new URL(host).host; } catch { return host; } })();
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-panel-row" + (isActive ? " active" : "");
    btn.innerHTML = `<span>${escapeHtml(hostLabel)}</span><span class="panel-tag">${isPrimary ? "primary" : "fallback"}${isActive ? " · active" : ""}</span>`;
    btn.onclick = () => {
      closeSettingsMenu();
      if (!isActive) switchToPanelHost(host);
    };
    el.settingsPanelList.appendChild(btn);
  }
}

el.settingsBtn.onclick = (e) => {
  e.stopPropagation();
  if (el.settingsMenu.hidden) openSettingsMenu();
  else closeSettingsMenu();
};
for (const item of el.settingsMenu.querySelectorAll(".settings-item")) {
  item.onclick = (ev) => {
    const action = item.dataset.action;
    // EPG-window cycler keeps the menu open so the user can step
    // through presets and see the live re-render after each press.
    if (action === "cycle-epg-window") {
      ev.stopPropagation();
      cycleEpgWindow();
      return;
    }
    closeSettingsMenu();
    if (action === "filter") openFilterModal();
    else if (action === "refine") openRefineModal();
    else if (action === "refresh") el.refresh.click();
    else if (action === "logout") logout();
    else if (action === "panel-config") openPanelConfigModal();
    else if (action === "toggle-remote") toggleRemoteEnabled();
    else if (action === "switch-profile") { location.href = `/profile/pick?from=${state.mode || "live"}`; }
    else if (action === "invite-friend") inviteFriend();
    else if (action === "disk-config") configureDiskFolder();
    else if (action === "disk-rescan") rescanDiskLibrary();
  };
}

// Owner-only: set/clear the local media folder, then rebuild the index.
async function configureDiskFolder() {
  const current = (state.diskConfig && state.diskConfig.path) || "";
  const path = prompt("Local media folder (absolute path inside the server/container).\nLeave blank to disable the Disk library.", current);
  if (path === null) return; // cancelled
  toast("Scanning library…", 0);
  try {
    const r = await fetch("/api/admin/disk-config", {
      method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ path: path.trim(), enabled: !!path.trim() }),
    });
    const d = await r.json();
    if (!r.ok || !d.ok) { toast(`Couldn't set folder: ${d.error || r.status}`, 5000); return; }
    toast(d.count ? `Indexed ${d.count} titles. Reloading…` : "Disk library cleared. Reloading…", 2500);
    setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(`Couldn't set folder: ${e.message}`, 5000); }
}
async function rescanDiskLibrary() {
  toast("Rescanning disk library…", 0);
  try {
    const r = await fetch("/api/admin/rescan-disk", { method: "POST", headers: { "Accept": "application/json" } });
    const d = await r.json();
    if (!r.ok || !d.ok) { toast(`Rescan failed: ${d.error || r.status}`, 5000); return; }
    toast(`Rescanned — ${d.count} titles. Reloading…`, 2500);
    setTimeout(() => location.reload(), 1200);
  } catch (e) { toast(`Rescan failed: ${e.message}`, 5000); }
}

// Owner-only: generate an invite link the user can share with a friend.
// The link routes to /signup?token=… where the friend brings their own
// panel credentials. Single-use, 7-day default expiry.
async function inviteFriend() {
  let r;
  try { r = await fetch("/api/invites", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" } }); }
  catch (e) { alert(`Couldn't create invite: ${e.message}`); return; }
  if (!r.ok) {
    if (r.status === 403) { alert("Only the owner can create invites."); return; }
    alert(`Couldn't create invite (HTTP ${r.status}).`); return;
  }
  const j = await r.json();
  const url = `${location.origin}${j.url}`;
  try { await navigator.clipboard.writeText(url); }
  catch {}
  const days = Math.round((j.expiresAt - Date.now()) / 86400000);
  prompt(`Invite link (copied to clipboard, valid ${days} days):`, url);
}

// Profile chip click → toggle popup. Hover affordance from CSS;
// keyboard activation works because it's a native <button>.
if (el.profileChip) {
  el.profileChip.onclick = (e) => {
    e.stopPropagation();
    if (el.profilePopup.hidden) openProfilePopup();
    else closeProfilePopup();
  };
}

// Flip the on-screen channel remote on/off. Persists locally (instant
// UI feel) and via userState (cross-device sync); refreshes any
// in-flight player so the change applies immediately.
function toggleRemoteEnabled() {
  state.remoteEnabled = !state.remoteEnabled;
  try { localStorage.setItem("remoteEnabled", state.remoteEnabled ? "1" : "0"); } catch {}
  refreshLiveRemoteVisibility();
  refreshRemoteToggleLabel();
  pushUserState();
}
function refreshRemoteToggleLabel() {
  const lbl = document.getElementById("settings-remote-toggle");
  if (lbl) {
    lbl.textContent = state.remoteEnabled ? "on" : "off";
    lbl.classList.toggle("on", state.remoteEnabled);
  }
}
// Cycle through preset window sizes. Click-to-cycle is more reliable
// inside a popup menu than a native <select> (browser-managed dropdown
// popups don't always play nicely with the outside-click listener
// that closes the settings menu). The pill text updates on every
// click; renderGuide() rebuilds rows so the IntersectionObserver
// re-fires EPG fetches against the new window.
const EPG_WINDOW_PRESETS = [2, 3, 5, 8, 12, 24];
function syncEpgWindowSelect() {
  const label = document.getElementById("settings-epg-window-label");
  if (!label) return;
  label.textContent = `${state.epgWindowHoursForward || 3}h`;
}
function cycleEpgWindow() {
  const cur = state.epgWindowHoursForward || 3;
  const idx = EPG_WINDOW_PRESETS.indexOf(cur);
  const next = EPG_WINDOW_PRESETS[(idx + 1) % EPG_WINDOW_PRESETS.length];
  state.epgWindowHoursForward = next;
  syncEpgWindowSelect();
  // Stale EPG cache — different window means different programme set.
  state.epg = {};
  pushUserState();
  if (state.mode === "live") renderGuide();
}
function syncPanelExpiryLabel() {
  const row = document.getElementById("settings-panel-expiry");
  const hint = document.getElementById("settings-panel-expiry-hint");
  if (!row || !hint) return;
  const exp = state.account?.user_info?.exp_date;
  const expSec = exp ? Number(exp) : NaN;
  if (!Number.isFinite(expSec) || expSec <= 0) {
    row.hidden = true;
    return;
  }
  const days = Math.round((expSec * 1000 - Date.now()) / (24 * 3600 * 1000));
  if (days < 0) {
    hint.textContent = `expired ${-days}d ago`;
    hint.style.color = "var(--accent)";
  } else if (days < 14) {
    hint.textContent = `in ${days}d`;
    hint.style.color = "var(--accent)";
  } else {
    hint.textContent = `in ${days}d`;
    hint.style.color = "";
  }
  row.hidden = false;
}

// --- Panel-config modal ----------------------------------------------
async function openPanelConfigModal() {
  // Pull the current config to pre-fill the form. Password is never
  // returned from the server — `has_pass` flips the placeholder to
  // make it obvious that leaving the field blank keeps the current.
  let cfg = null;
  try {
    const r = await fetch("/api/panel/config");
    if (r.ok) cfg = await r.json();
  } catch {}
  const form = el.panelConfigForm;
  form.elements.host.value = (cfg && cfg.host) || "";
  form.elements.host_fallback.value = (cfg && cfg.host_fallback) || "";
  form.elements.user.value = (cfg && cfg.user) || "";
  form.elements.pass.value = "";
  form.elements.pass.placeholder = cfg && cfg.has_pass ? "leave blank to keep current" : "";
  setPanelConfigStatus(null);
  el.panelConfigModal.hidden = false;
}
function closePanelConfigModal() {
  el.panelConfigModal.hidden = true;
}
function setPanelConfigStatus(msg, cls) {
  if (!msg) { el.panelConfigStatus.hidden = true; el.panelConfigStatus.textContent = ""; return; }
  el.panelConfigStatus.hidden = false;
  el.panelConfigStatus.textContent = msg;
  el.panelConfigStatus.className = "pc-status " + (cls || "");
}
function readPanelConfigForm() {
  const f = el.panelConfigForm.elements;
  return {
    host: f.host.value.trim(),
    host_fallback: f.host_fallback.value.trim(),
    user: f.user.value.trim(),
    pass: f.pass.value, // empty means "keep current" — server interprets
  };
}
async function testPanelConfig() {
  const body = readPanelConfigForm();
  if (!body.host || !body.user) {
    setPanelConfigStatus("Host and username are required.", "bad");
    return;
  }
  setPanelConfigStatus("Probing the panel…", "busy");
  try {
    const r = await fetch("/api/panel/config/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) setPanelConfigStatus("Authentication succeeded. Safe to save.", "ok");
    else setPanelConfigStatus(`Probe failed: ${d.reason || "unknown error"}`, "bad");
  } catch (e) {
    setPanelConfigStatus(`Probe failed: ${e.message}`, "bad");
  }
}
async function savePanelConfig() {
  const body = readPanelConfigForm();
  if (!body.host || !body.user) {
    setPanelConfigStatus("Host and username are required.", "bad");
    return;
  }
  setPanelConfigStatus("Saving and switching panels…", "busy");
  el.panelConfigSave.disabled = true;
  try {
    const r = await fetch("/api/panel/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) {
      setPanelConfigStatus("Saved. Library is rebuilding from the new panel…", "ok");
      toast("Panel updated. Library is reindexing.", 4000);
      // Reload the catalog so the user sees fresh data. The bootstrap
      // call pulls categories; pollIndex() picks up the rebuilt indexes
      // once they're ready (status endpoint will flip ready=true).
      try {
        const r2 = await fetch("/api/bootstrap");
        const d2 = await r2.json();
        for (const m of MODES) {
          state.modes[m].byCat = new Map();
          state.modes[m].catPaging = new Map();
          state.modes[m].streams = [];
          state.modes[m].indexReady = false;
          state.modes[m].categories = Array.isArray(d2.categories?.[m]) ? d2.categories[m] : [];
        }
        refreshView();
        pollIndex();
        refreshPanelButton();
      } catch {}
      closePanelConfigModal();
    } else {
      setPanelConfigStatus(`Save failed: ${d.reason || "unknown error"}`, "bad");
    }
  } catch (e) {
    setPanelConfigStatus(`Save failed: ${e.message}`, "bad");
  } finally {
    el.panelConfigSave.disabled = false;
  }
}
el.panelConfigClose.onclick = closePanelConfigModal;
el.panelConfigTest.onclick  = testPanelConfig;
el.panelConfigSave.onclick  = savePanelConfig;

async function logout() {
  // Best-effort POST so the server clears its session cookie even on
  // misconfigured browsers; then hard-navigate to /login. The server
  // would redirect us anyway on the next request, but doing it
  // explicitly avoids a noisy 302 chain.
  try {
    await fetch("/api/logout", { method: "POST", keepalive: true });
  } catch {}
  // Wipe local-only caches so the next sign-in starts fresh-looking
  // (theme survives — that's a stable preference).
  try {
    sessionStorage.clear();
  } catch {}
  location.href = "/login";
}
el.showAllBtn.onclick = () => setShowAll(!state.showAll);
for (const tab of el.filterTabs) {
  tab.onclick = () => { _filterTab = tab.dataset.tab; syncFilterTabs(); renderFilterBody(); };
}
el.filterClear.onclick = () => {
  if (!_filterDraft) return;
  if (_filterUnified) { for (const m of MODES) _filterDraft[m].clear(); renderUnifiedFilterBody(); }
  else { _filterDraft[_filterTab].clear(); renderFilterBody(); }
  updateFilterDoneEnabled();
};
el.filterAll.onclick = () => {
  if (!_filterDraft) return;
  if (_filterUnified) {
    const seen = new Set(); const keys = [];
    for (const m of MODES) for (const g of detectGroups(m)) if (!seen.has(g.key)) { seen.add(g.key); keys.push(g.key); }
    for (const m of MODES) for (const k of keys) _filterDraft[m].add(k);
    renderUnifiedFilterBody();
  } else {
    for (const g of detectGroups(_filterTab)) _filterDraft[_filterTab].add(g.key);
    renderFilterBody();
  }
  updateFilterDoneEnabled();
};
el.filterClose.onclick = () => closeFilterModal();
el.filterDone.onclick = () => {
  commitFilterDraft();
  closeFilterModal();
};
el.refineClose.onclick = () => closeRefineModal();
el.refineCancel.onclick = () => closeRefineModal();
el.refineSave.onclick = () => saveRefine();
for (const t of el.refineTabs) {
  t.onclick = () => { _refineTab = t.dataset.refineTab; syncRefineTabs(); renderRefineBody(); };
}
el.castHere.onclick = () => {
  if (!state.playing) return;
  if (state.castSession) castMedia(state.playing);
  else cast.framework.CastContext.getInstance().requestSession().catch((err) => {
    const code = (err && err.code) || err;
    if (code === "cancel") return; // user dismissed the device picker
    toast(`Cast failed: ${code}`, 4000);
  });
};

document.addEventListener("keydown", (e) => {
  // Live remote channel-zap shortcuts. Only fire when a live stream is
  // playing AND focus isn't in a text input (so search / number-entry
  // never get hijacked).
  const inField = document.activeElement && /^(input|textarea|select)$/i.test(document.activeElement.tagName);
  // Channel-zap keys only when the remote is enabled — otherwise ↑/↓
  // surprise the user (they probably wanted to scroll the page or
  // navigate the player UI).
  if (state.remoteEnabled && state.playing && state.playing.mode === "live" && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === "ArrowUp")   { e.preventDefault(); stepLiveChannel(+1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); stepLiveChannel(-1); return; }
  }
  // Spacebar toggles play/pause when the player is open and focus
  // isn't in an input. Standard Netflix / YouTube affordance — without
  // this the only ways to pause were the ▶/⏸ button or a click on the
  // video, and the latter is fragile when the scrub bar / scrim are
  // intercepting clicks.
  if (e.key === " " && state.playing && !el.player.hidden && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (el.video.paused) el.video.play();
    else el.video.pause();
    return;
  }
  if (e.key === "/" && document.activeElement !== el.search) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  } else if (e.key === "Escape") {
    if (!el.refineModal.hidden) closeRefineModal();
    else if (!el.filterModal.hidden && !el.filterClose.hidden) closeFilterModal();
    else if (!el.liveRemote.hidden) closeLiveRemote();
    else if (document.activeElement === el.search) {
      el.search.value = ""; state.query = ""; syncSearchClearVisibility(); showHome(); el.search.blur(); updateUrl();
    } else if (!el.seriesPanel.hidden) closeDetail();
    else if (!el.player.hidden) closePlayer();
  } else if (!e.metaKey && !e.ctrlKey && !e.altKey && document.activeElement !== el.search) {
    if (e.key === "1") setMode("live");
    else if (e.key === "2") setMode("movie");
    else if (e.key === "3") setMode("series");
  }
});

window.addEventListener("popstate", () => applyPath());
el.grid.addEventListener("scroll", scheduleSaveScroll, { passive: true });
window.addEventListener("beforeunload", () => { saveScroll(); sendProgress(); stopServerStreams(); });
el.video.addEventListener("pause", () => sendProgress());
el.video.addEventListener("ended", () => {
  sendProgress();
  // Series autoplay: when an episode finishes and there's a next one,
  // advance to it automatically (mirrors the Android TV behavior).
  // Movies / live fall through and just keep the saved progress.
  if (state.playing && state.playing.mode === "series" && state.playing.nextEpisode) {
    playNextEpisode();
  }
});
// Up-Next "Play now" → skip immediately to the next episode.
if (el.playerUpnextPlay) el.playerUpnextPlay.addEventListener("click", playNextEpisode);

if (location.hash.startsWith("#/")) {
  const target = location.hash.slice(1);
  history.replaceState(null, "", target + location.search);
}

initCast();
bootstrap().then(() => { if (location.pathname.length > 1) applyPath(); });
