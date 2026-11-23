"use strict";
// Provider URLs carry account credentials (Xtream: /live/<user>/<pass>/<id>.m3u8,
// movie|series|timeshift likewise, or username=&password= query params). Anything
// that can reach logs (Axiom via Vector), job.error, or admin responses goes
// through redactUrl() first.

const util = require("util");

const SEG = "[^/\\s?#'\")]+";
// Provider paths only: after http(s)://host[:port], or a bare path at
// start-of-string / after whitespace, quote, "(" or "=". A path that is merely a
// suffix of ours (/api/series/12/season/3/..., /media/series/Show/Season1/..) has
// "/api" or "/media" before it and never matches.
const PATH_RE = new RegExp(
  `(https?:\\/\\/[^/\\s'")]+|^|[\\s'"(=])\\/(live|movie|series|timeshift)\\/${SEG}\\/${SEG}\\/`, "gi");
const USER_Q_RE = /([?&;]|\b)username=[^&\s'")#]*/gi;
const PASS_Q_RE = /([?&;]|\b)password=[^&\s'")#]*/gi;
const JSON_USER_RE = /("username"\s*:\s*")[^"]*(")/gi;
const JSON_PASS_RE = /("password"\s*:\s*")[^"]*(")/gi;
const USERINFO_RE = /(https?:\/\/)[^\s/@'")]+:[^\s/@'")]*@/gi;

function redactUrl(s) {
  if (s == null) return "";
  let t = typeof s === "string" ? s : String(s);
  if (!t) return t;
  t = t.replace(USERINFO_RE, "$1<u>:<p>@");
  t = t.replace(PATH_RE, (_m, pre, kind) => `${pre}/${kind}/<u>/<p>/`);
  t = t.replace(USER_Q_RE, (_m, pre) => `${pre}username=<u>`);
  t = t.replace(PASS_Q_RE, (_m, pre) => `${pre}password=<p>`);
  t = t.replace(JSON_USER_RE, "$1<u>$2").replace(JSON_PASS_RE, "$1<p>$2");
  return t;
}

// Errors: message, stack and cause. A frozen/non-writable Error is replaced by a
// redacted copy rather than mutated.
function redactError(a, seen = new Set()) {
  if (seen.has(a)) return a;
  seen.add(a);
  const msg = redactUrl(a.message);
  const stack = typeof a.stack === "string" ? redactUrl(a.stack) : a.stack;
  let out = a;
  if (msg !== a.message || stack !== a.stack) {
    try {
      a.message = msg;
      if (typeof stack === "string") a.stack = stack;
    } catch {}
    if (a.message !== msg) {
      out = new Error(msg);
      out.name = a.name;
      if (typeof stack === "string") out.stack = stack;
    }
  }
  if (a.cause instanceof Error) {
    const c = redactError(a.cause, seen);
    if (c !== a.cause) {
      try { a.cause = c; } catch {}
      if (out !== a) out.cause = c;
    }
  }
  return out;
}

// One console argument. Plain objects/arrays are only touched when a credential
// pattern is present; then they are logged as a redacted util.inspect string.
function redactArg(a) {
  if (typeof a === "string") return redactUrl(a);
  if (a instanceof Error) {
    try { return redactError(a); } catch { return a; }
  }
  if (a && typeof a === "object") {
    try {
      let json;
      try { json = JSON.stringify(a); } catch { json = util.inspect(a, { depth: 4 }); }
      if (typeof json === "string" && redactUrl(json) !== json) {
        return redactUrl(util.inspect(a, { depth: 4, breakLength: 120 }));
      }
    } catch {}
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
