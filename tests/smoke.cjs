// Smoke test for the bundled HTML: runs its inlined scripts in a sandbox and checks
// that sql.js and both converters load and work.
//
// Always: bad input is rejected, and a small generated animation survives
// Aseprite -> CLIP -> Aseprite unchanged.
// Locally: every .clip in testdata/ (git-ignored) converts to Aseprite and back.
//
// usage: node tests/smoke.cjs <path/to/clip2aseprite.html> [testdata dir]

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const [htmlPath, dataDir = path.join(__dirname, "..", "testdata")] = process.argv.slice(2);
if (!htmlPath) {
  console.error("usage: node tests/smoke.cjs <clip2aseprite.html> [testdata dir]");
  process.exit(2);
}


// ---- load the page's scripts ------------------------------------------------

const html = fs.readFileSync(htmlPath, "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const uiScript = scripts.pop();

const embedded = (name) => {
  const match = uiScript.match(new RegExp(`const ${name} = "([^"]+)"`));
  assert(match && match[1].length > 1000, `${name} not embedded`);
  return Uint8Array.from(Buffer.from(match[1], "base64"));
};
const wasmBinary = embedded("WASM_B64");
const clipTemplate = embedded("CLIP_TEMPLATE_B64");

const sandbox = vm.createContext({
  console, atob, Blob, Response, DecompressionStream, CompressionStream, crypto,
  TextEncoder, TextDecoder, WebAssembly, setTimeout, clearTimeout, URL, performance,
});
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
sandbox.self = sandbox;
scripts.forEach((script) => vm.runInContext(script, sandbox));

assert.strictEqual(typeof sandbox.initSqlJs, "function", "sql.js did not load");
assert.strictEqual(typeof sandbox.Clip2Ase?.convert, "function", "Clip2Ase did not load");
assert.strictEqual(typeof sandbox.Ase2Clip?.convert, "function", "Ase2Clip did not load");

const { Clip2Ase, Ase2Clip } = sandbox;
const ok = (message) => console.log(`ok   ${message}`);


// ---- helpers -----------------------------------------------------------------

const visiblePixels = (frame) => frame.filter((v, i) => i % 4 === 3 && v).length;
const sameFrames = (a, b) => a.length === b.length && a.every((f, i) => Buffer.compare(Buffer.from(f), Buffer.from(b[i])) === 0);

// A tiny 3-frame RGBA Aseprite file: a coloured square moving right, frame 2 held twice as long.
function makeAseprite() {
  const w = 20, h = 10, durations = [100, 200, 100];
  const u16 = (v) => Buffer.from([v & 255, v >> 8]);
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };

  const frames = durations.map((ms, f) => {
    const chunks = [];
    if (f === 0) {
      const name = Buffer.from("Layer");
      const layer = Buffer.concat([u16(3), u16(0), u16(0), u16(0), u16(0), u16(0), Buffer.from([255, 0, 0, 0]), u16(name.length), name]);
      chunks.push(Buffer.concat([u32(layer.length + 6), u16(0x2004), layer]));
    }
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let i = 0; i < 16; i++) pixels.set([255 * (f === 0), 255 * (f === 1), 255 * (f === 2), 255], i * 4);
    const cel = Buffer.concat([u16(0), u16(2 + f * 5), u16(3), Buffer.from([255]), u16(0), u16(0), Buffer.alloc(5), u16(4), u16(4), pixels]);
    chunks.push(Buffer.concat([u32(cel.length + 6), u16(0x2005), cel]));
    const body = Buffer.concat(chunks);
    return Buffer.concat([u32(16 + body.length), u16(0xF1FA), u16(chunks.length), u16(ms), u16(0), u32(chunks.length), body]);
  });

  const body = Buffer.concat(frames);
  const header = Buffer.alloc(128);
  header.writeUInt32LE(128 + body.length, 0);
  header.writeUInt16LE(0xA5E0, 4);
  header.writeUInt16LE(durations.length, 6);
  header.writeUInt16LE(w, 8);
  header.writeUInt16LE(h, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(1, 14);
  return new Uint8Array(Buffer.concat([header, body]));
}


// ---- tests -------------------------------------------------------------------

(async () => {
  const SQL = await sandbox.initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  assert.strictEqual(JSON.stringify(db.exec("select 1+1")[0].values), "[[2]]");
  db.close();
  ok("bundle loads, sql.js works");

  await assert.rejects(Clip2Ase.convert(SQL, new Uint8Array(64)), /not a Clip Studio Paint/);
  await assert.rejects(Ase2Clip.convert(SQL, new Uint8Array(128), clipTemplate), /not an Aseprite/);
  ok("bad input is rejected");

  // Aseprite -> CLIP -> Aseprite with a generated file
  const toClip = await Ase2Clip.convert(SQL, makeAseprite(), clipTemplate);
  assert.strictEqual(toClip.fps, 10);
  assert.deepStrictEqual(Array.from(toClip.holds), [1, 2, 1]);
  const back = await Clip2Ase.convert(SQL, toClip.clip);
  assert.strictEqual(back.frames.length, 4, "4 timeline frames (frame 2 held twice)");
  assert(sameFrames(back.frames, [toClip.frames[0], toClip.frames[1], toClip.frames[1], toClip.frames[2]]));
  assert(!back.warnings.length, `unexpected warnings: ${back.warnings}`);
  ok("generated .aseprite -> .clip -> .aseprite round trip (10 fps, held frame)");

  // Real files, if present
  const clips = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((f) => /\.clip$/i.test(f)) : [];
  if (!clips.length) console.log(`skip no .clip files in ${dataDir}`);

  for (const file of clips) {
    const r = await Clip2Ase.convert(SQL, new Uint8Array(fs.readFileSync(path.join(dataDir, file))));
    const a = r.aseprite;
    assert.strictEqual(a[4] | (a[5] << 8), 0xA5E0, "bad .aseprite magic");
    assert.strictEqual(a[6] | (a[7] << 8), r.frames.length, "frame count mismatch");
    assert(r.frames.some(visiblePixels), "all frames are empty");
    assert(!r.warnings.some((w) => /no animation timeline/i.test(w)), "timeline not found");
    assert(r.frames.length > 1, "expected an animation with more than one frame");

    const clip = await Ase2Clip.convert(SQL, a, clipTemplate);
    const again = await Clip2Ase.convert(SQL, clip.clip);
    assert(sameFrames(again.frames, r.frames), "round trip changed pixels");

    ok(`${file}: ${r.frames.length} frames ${r.width}x${r.height}, round trip identical` +
      (r.warnings.length ? ` (${r.warnings.length} warnings)` : ""));
  }
})().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
