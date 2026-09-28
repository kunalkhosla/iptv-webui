// Minimal MCP (Model Context Protocol) server over Streamable HTTP —
// stateless, JSON responses only (no SSE, no sessions). Enough for an
// assistant to search the catalog, read the guide and resolve a
// cast-ready URL; the transport is a single `POST /mcp` JSON-RPC call.
//
// Auth is a per-user API token (MCP_TOKENS env), NOT the household
// password: each token is bound to one username + one profile, so the
// kids filter, language filter and Continue Watching of that profile all
// apply. Tokens are compared as SHA-256 digests with timingSafeEqual.
//
// This module is protocol-only (no server.js state) so it is unit
// tested in isolation; server.js supplies the tool implementations.

"use strict";

const crypto = require("node:crypto");

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// MCP_TOKENS="username/profileId=token,username2/profileId2=token2"
// Profile is optional ("username=token" → the user's first profile).
// Tokens shorter than 24 chars are rejected at boot — they're bearer
// credentials reachable from the internet.
function parseTokens(raw) {
  const out = [];
  for (const part of String(raw || "").split(",").map(s => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new Error("MCP_TOKENS entry must be user[/profile]=token");
    const who = part.slice(0, eq).trim();
    const token = part.slice(eq + 1).trim();
    if (token.length < 24) throw new Error("MCP_TOKENS token too short (min 24 chars)");
    const [username, profileId] = who.split("/", 2).map(s => (s || "").trim());
    if (!username) throw new Error("MCP_TOKENS entry missing username");
    out.push({ username, profileId: profileId || null, digest: sha(token) });
  }
  return out;
}

function sha(s) { return crypto.createHash("sha256").update(String(s)).digest(); }

// → {username, profileId} or null.
function matchBearer(tokens, authorization) {
  const h = String(authorization || "");
  if (!h.startsWith("Bearer ")) return null;
  const d = sha(h.slice(7).trim());
  let hit = null;
  for (const t of tokens) {
    // Compare against every entry (no early exit) so timing doesn't leak
    // which slot matched.
    if (crypto.timingSafeEqual(d, t.digest) && !hit) hit = t;
  }
  return hit ? { username: hit.username, profileId: hit.profileId } : null;
}

// Refs are opaque "<mode>:<id>:<ext>" strings (same shape as the Home
// Assistant integration's), so a model can only hand back something a
// search/continue_watching result gave it.
const REF_RE = /^(live|movie|series|episode|disk):(\d{1,12}):([a-z0-9]{1,6})$/;
function parseRef(ref) {
  const m = REF_RE.exec(String(ref || ""));
  if (!m) return null;
  return { mode: m[1], id: m[2], ext: m[3] };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// tools: [{name, description, inputSchema, handler(args, ctx) → object}]
// Returns an async (body, ctx) → response-object | null (null = notification,
// reply 202 with no body).
function createMcpServer({ name, version, tools }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  return async function handle(body, ctx) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return rpcError(null, -32600, "expected a single JSON-RPC request");
    }
    const { id, method, params } = body;
    if (body.jsonrpc !== "2.0" || typeof method !== "string") {
      return rpcError(id, -32600, "invalid request");
    }
    const isNotification = id === undefined;
    if (method.startsWith("notifications/")) return null;
    if (isNotification) return null;
    if (method === "initialize") {
      const asked = params?.protocolVersion;
      return {
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        },
      };
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") {
      return {
        jsonrpc: "2.0", id,
        result: { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
      };
    }
    if (method === "tools/call") {
      const tool = byName.get(params?.name);
      if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`);
      const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        const out = await tool.handler(args, ctx);
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError: false },
        };
      } catch (e) {
        // Tool failures are results (the model reads them), not protocol errors.
        return {
          jsonrpc: "2.0", id,
          result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true },
        };
      }
    }
    return rpcError(id, -32601, `method not found: ${method}`);
  };
}

module.exports = { parseTokens, matchBearer, parseRef, createMcpServer, PROTOCOL_VERSIONS };
