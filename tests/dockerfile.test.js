// Guards against the "I refactored server.js to require a new file
// but forgot to COPY it in the Dockerfile" outage. Walks every
// `require("./...")` in server.js and asserts the corresponding
// path is COPY-ed (directly or as an ancestor) in the Dockerfile.
//
// Catches the 2026-05-15 incident where lib/kids-filter.js was
// added and the container crashed at startup with MODULE_NOT_FOUND.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

test("Dockerfile copies every relative require'd path from server.js", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

  // Extract `require("./...")` / `require("../...")` paths.
  const re = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  const requires = new Set();
  let m;
  while ((m = re.exec(server)) !== null) requires.add(m[1]);

  // Extract COPY <src> <dst> lines (ignore the package.json line +
  // any single-file COPY, but also accept directory copies that
  // cover the require path as an ancestor).
  const copies = [];
  for (const line of dockerfile.split("\n")) {
    const c = line.match(/^\s*COPY\s+(?!--from)([^\s]+(?:\s+[^\s]+)*?)\s+\S+/);
    if (c) {
      // First arg(s) before the destination are sources. Split on space.
      const parts = line.trim().replace(/^COPY\s+/, "").split(/\s+/);
      // Last item is destination; everything before is sources.
      const sources = parts.slice(0, -1);
      for (const s of sources) copies.push(s);
    }
  }

  for (const req of requires) {
    // Normalize "./X" → "X", "./X/Y" → "X/Y", strip ".js" extension
    let rel = req.replace(/^\.\//, "");
    const candidates = [rel, rel + ".js", rel + "/index.js"];
    // Does some COPY source match (exact or as a directory ancestor)?
    const covered = copies.some((src) => {
      // Exact match
      if (candidates.includes(src)) return true;
      // Directory ancestor: COPY lib ./lib covers lib/kids-filter.js
      if (candidates.some((c) => c === src || c.startsWith(src + "/"))) return true;
      return false;
    });
    assert.ok(
      covered,
      `server.js requires "${req}" but the Dockerfile never COPYs it (or an ancestor directory). ` +
      `Add a COPY line so the container can resolve the module at startup.`,
    );
  }
});

test("every relative require in server.js resolves to a file on disk", () => {
  const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const re = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(server)) !== null) {
    const rel = m[1];
    const candidates = [rel, rel + ".js", rel + "/index.js"];
    const found = candidates.some((c) => fs.existsSync(path.join(ROOT, c)));
    assert.ok(found, `server.js requires "${rel}" but no matching file exists on disk`);
  }
});
