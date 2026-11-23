"use strict";
// Provider URLs carry account credentials (Xtream: /live/<user>/<pass>/<id>.m3u8,
// movie|series|timeshift likewise, or username=&password= query params). Anything
// that can reach logs (Axiom via Vector), job.error, or admin responses goes
// through redactUrl() first.

const SEG = "[^/\\s?#'\")]+";
const PATH_RE = new RegExp(`/(live|movie|series|timeshift)/${SEG}/${SEG}/`, "gi");
const USER_Q_RE = /([?&;]|\b)username=[^&\s'")#]*/gi;
const PASS_Q_RE = /([?&;]|\b)password=[^&\s'")#]*/gi;
const USERINFO_RE = /(https?:\/\/)[^\s/@'")]+:[^\s/@'")]*@/gi;

function redactUrl(s) {
  if (s == null) return "";
  let t = typeof s === "string" ? s : String(s);
  if (!t) return t;
  t = t.replace(USERINFO_RE, "$1<u>:<p>@");
  t = t.replace(PATH_RE, (_m, kind) => `/${kind}/<u>/<p>/`);
  t = t.replace(USER_Q_RE, (_m, pre) => `${pre}username=<u>`);
  t = t.replace(PASS_Q_RE, (_m, pre) => `${pre}password=<p>`);
  return t;
}

// Redact one console argument: strings directly, Errors by message/stack.
function redactArg(a) {
  if (typeof a === "string") return redactUrl(a);
  if (a instanceof Error) {
    try {
      const msg = redactUrl(a.message);
      if (msg !== a.message) a.message = msg;
      if (typeof a.stack === "string") a.stack = redactUrl(a.stack);
    } catch {}
    return a;
  }
  return a;
}

// Safety net: every console.log/warn/error/info line passes through redactUrl,
// so a sink missed by an explicit call still can't leak credentials.
function installConsoleRedaction(c = console) {
  if (c.__redactInstalled) return;
  for (const m of ["log", "info", "warn", "error"]) {
    const orig = c[m].bind(c);
    c[m] = (...args) => orig(...args.map(redactArg));
  }
  c.__redactInstalled = true;
}

// Stricter: also collapse every remaining http(s) URL (CDN hosts, tokens).
function redactAllUrls(s) {
  return redactUrl(s).replace(/https?:\/\/[^\s'")]+/g, "<url>");
}

module.exports = { redactAllUrls, redactUrl, redactArg, installConsoleRedaction };
