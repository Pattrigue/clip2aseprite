// Smoke test for the bundled HTML: runs its inlined scripts in a sandbox, checks that
// sql.js + the converter load, that bad input is rejected cleanly, and converts any
// .clip files found in testdata/ (git-ignored, so only locally).
//
// usage: node tests/smoke.cjs <path/to/clip2aseprite.html> [testdata dir]
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), assert = require("assert");

const [htmlPath, dataDir = path.join(__dirname, "..", "testdata")] = process.argv.slice(2);
if (!htmlPath) { console.error("usage: node tests/smoke.cjs <clip2aseprite.html> [testdata dir]"); process.exit(2); }

const src = fs.readFileSync(htmlPath, "utf8");
const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.strictEqual(scripts.length, 3, "expected 3 inline scripts (sql.js, core, ui)");
const b64 = scripts[2].match(/const WASM_B64 = "([^"]+)"/);
assert(b64 && b64[1].length > 100000, "wasm binary not embedded");

const ctx = vm.createContext({
  console, atob, Blob, Response, DecompressionStream, CompressionStream,
  TextEncoder, TextDecoder, WebAssembly, setTimeout, clearTimeout, URL, performance,
});
ctx.globalThis = ctx; ctx.window = ctx; ctx.self = ctx;
vm.runInContext(scripts[0], ctx);
vm.runInContext(scripts[1], ctx);
assert.strictEqual(typeof ctx.initSqlJs, "function", "sql.js did not load");
assert.strictEqual(typeof ctx.Clip2Ase?.convert, "function", "converter did not load");

(async () => {
  const SQL = await ctx.initSqlJs({ wasmBinary: Uint8Array.from(Buffer.from(b64[1], "base64")) });
  const db = new SQL.Database();
  assert.strictEqual(JSON.stringify(db.exec("select 1+1")[0].values), "[[2]]");
  db.close();
  console.log("ok   bundle loads, sql.js works");

  await assert.rejects(ctx.Clip2Ase.convert(SQL, new Uint8Array(64)), /not a Clip Studio Paint/);
  console.log("ok   non-.clip input is rejected");

  const clips = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => /\.clip$/i.test(f)) : [];
  if (!clips.length) console.log("skip no .clip files in " + dataDir);
  for (const f of clips) {
    const r = await ctx.Clip2Ase.convert(SQL, new Uint8Array(fs.readFileSync(path.join(dataDir, f))));
    const a = r.aseprite;
    assert.strictEqual(a[4] | (a[5] << 8), 0xA5E0, "bad .aseprite magic");
    assert.strictEqual(a[6] | (a[7] << 8), r.frames.length, "frame count mismatch");
    assert(r.frames.some((fr) => fr.some((v, i) => i % 4 === 3 && v)), "all frames are empty");
    console.log(`ok   ${f}: ${r.frames.length} frames ${r.width}x${r.height}` +
      (r.warnings.length ? ` (${r.warnings.length} warnings)` : ""));
  }
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
