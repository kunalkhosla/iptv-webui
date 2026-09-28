// lib/mcp.js — token parsing/matching, ref validation and the JSON-RPC
// surface of the /mcp endpoint. Tool bodies live in server.js and are
// exercised against a live index only; this locks the protocol + auth.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseTokens, matchBearer, parseRef, createMcpServer } = require("../lib/mcp");

const TOK = "a".repeat(32);
const TOK2 = "b".repeat(40);

test("parseTokens: user/profile and user-only entries", () => {
  const t = parseTokens(`alice/p2=${TOK}, bob=${TOK2}`);
  assert.equal(t.length, 2);
  assert.deepEqual([t[0].username, t[0].profileId], ["alice", "p2"]);
  assert.deepEqual([t[1].username, t[1].profileId], ["bob", null]);
  assert.ok(!JSON.stringify(t).includes(TOK), "raw token must not be kept");
});

test("parseTokens: empty is no tokens; short or malformed tokens throw", () => {
  assert.deepEqual(parseTokens(""), []);
  assert.deepEqual(parseTokens(undefined), []);
  assert.throws(() => parseTokens("alice=short"));
  assert.throws(() => parseTokens(TOK));
  assert.throws(() => parseTokens(`/p1=${TOK}`));
});

test("matchBearer: only an exact bearer token matches", () => {
  const t = parseTokens(`alice/p2=${TOK},bob=${TOK2}`);
  assert.deepEqual(matchBearer(t, `Bearer ${TOK2}`), { username: "bob", profileId: null });
  assert.deepEqual(matchBearer(t, `Bearer ${TOK}`), { username: "alice", profileId: "p2" });
  assert.equal(matchBearer(t, `Bearer ${TOK}x`), null);
  assert.equal(matchBearer(t, `Basic ${TOK}`), null);
  assert.equal(matchBearer(t, undefined), null);
  assert.equal(matchBearer([], `Bearer ${TOK}`), null);
});

test("parseRef: accepts catalog refs, rejects anything else", () => {
  assert.deepEqual(parseRef("live:1201:m3u8"), { mode: "live", id: "1201", ext: "m3u8" });
  assert.deepEqual(parseRef("episode:55:mkv"), { mode: "episode", id: "55", ext: "mkv" });
  for (const bad of ["", "live:12", "live:abc:m3u8", "radio:1:mp3", "movie:1:../x", "movie:1:mp4?x=1", null]) {
    assert.equal(parseRef(bad), null, String(bad));
  }
});

const server = createMcpServer({
  name: "khouch", version: "0.0.0",
  tools: [
    { name: "echo", description: "d", inputSchema: { type: "object" }, handler: async (a, ctx) => ({ got: a.x, who: ctx.who }) },
    { name: "boom", description: "d", inputSchema: { type: "object" }, handler: async () => { throw new Error("nope"); } },
  ],
});

test("initialize negotiates a supported protocol version", async () => {
  const r = await server({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, {});
  assert.equal(r.result.protocolVersion, "2025-03-26");
  assert.equal(r.result.serverInfo.name, "khouch");
  const r2 = await server({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } }, {});
  assert.equal(r2.result.protocolVersion, "2025-06-18");
});

test("tools/list and tools/call", async () => {
  const l = await server({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {});
  assert.deepEqual(l.result.tools.map(t => t.name), ["echo", "boom"]);
  const c = await server({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: { x: 5 } } }, { who: "me" });
  assert.deepEqual(c.result.structuredContent, { got: 5, who: "me" });
  assert.equal(c.result.isError, false);
  assert.deepEqual(JSON.parse(c.result.content[0].text), { got: 5, who: "me" });
});

test("a tool error is an isError result; unknowns are JSON-RPC errors", async () => {
  const e = await server({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "boom" } }, {});
  assert.equal(e.result.isError, true);
  assert.equal(e.result.content[0].text, "nope");
  const u = await server({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nah" } }, {});
  assert.equal(u.error.code, -32602);
  const m = await server({ jsonrpc: "2.0", id: 5, method: "resources/list" }, {});
  assert.equal(m.error.code, -32601);
  assert.equal((await server([1], {})).error.code, -32600);
  assert.equal((await server({ id: 1, method: "ping" }, {})).error.code, -32600);
});

test("notifications get no response body", async () => {
  assert.equal(await server({ jsonrpc: "2.0", method: "notifications/initialized" }, {}), null);
});

// server.js wiring: /mcp authenticates by bearer token only, before the
// cookie/Basic path, and the tools never touch the stream-open paths.
const SERVER = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
test("server.js: /mcp is bearer-only and wired before cookie auth", () => {
  const mw = SERVER.indexOf('if (req.path === "/mcp")');
  const cookie = SERVER.indexOf("const sessionToken = parseSessionCookie(req);");
  assert.ok(mw > 0 && cookie > mw, "/mcp branch must precede cookie/Basic auth");
  assert.match(SERVER.slice(mw, cookie), /matchBearer\(mcpTokens, req\.headers\.authorization\)/);
  assert.match(SERVER, /app\.post\("\/mcp"/);
});
test("server.js: MCP tools never fetch stream/transcode/proxy bytes", () => {
  const start = SERVER.indexOf("const MCP_TOOLS = [");
  const end = SERVER.indexOf("const mcpServer = createMcpServer(");
  const body = SERVER.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(body, /\/api\/(transcode|proxy|diskfile|download)\//);
  assert.doesNotMatch(body, /fetch\(\s*url/);
});
