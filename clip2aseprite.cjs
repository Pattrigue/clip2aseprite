#!/usr/bin/env node
// Command-line version of clip2aseprite. Uses the same converters as the web page.
//
// Usage:
//   node clip2aseprite.cjs input.clip [output.aseprite] [--fps N] [--layer-name NAME]
//   node clip2aseprite.cjs input.aseprite [output.clip] [--fps N]
//
// The direction is chosen from the input file's extension. Requires Node 18+.

"use strict";

const fs = require("fs");
const path = require("path");

const initSqlJs = require("./web/vendor/sql-wasm.js");
const clipToAseprite = require("./web/clip-to-aseprite.js");
const asepriteToClip = require("./web/aseprite-to-clip.js");

const TEMPLATE = path.join(__dirname, "web", "template.clip");

const USAGE = [
  "usage: node clip2aseprite.cjs input.clip [output.aseprite] [--fps N] [--layer-name NAME]",
  "       node clip2aseprite.cjs input.aseprite [output.clip] [--fps N]",
].join("\n");


function parseArgs(argv) {
  const args = { files: [], fps: undefined, layerName: "Sprite Sheet" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "--fps") {
      args.fps = parseFloat(argv[++i]);
      if (!(args.fps > 0)) throw new Error("--fps needs a positive number");
    } else if (arg === "--layer-name") {
      args.layerName = argv[++i];
    } else if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else {
      args.files.push(arg);
    }
  }

  if (args.files.length < 1 || args.files.length > 2) throw new Error(USAGE);
  return args;
}


async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.files[0];
  const toClip = /\.(aseprite|ase)$/i.test(input);
  const output = args.files[1] || input.replace(/\.(clip|aseprite|ase)$/i, "") + (toClip ? ".clip" : ".aseprite");

  const wasmBinary = fs.readFileSync(path.join(__dirname, "web", "vendor", "sql-wasm.wasm"));
  const SQL = await initSqlJs({ wasmBinary });
  const bytes = new Uint8Array(fs.readFileSync(input));

  if (toClip) {
    const template = new Uint8Array(fs.readFileSync(TEMPLATE));
    const result = await asepriteToClip.convert(SQL, bytes, template, { fps: args.fps });
    fs.writeFileSync(output, result.clip);

    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    console.log(`${output}: ${result.frames.length} layers, ${result.width}x${result.height}, ` +
      `${result.fps} fps, ${result.holds.reduce((a, b) => a + b, 0)} timeline frames`);
  } else {
    const result = await clipToAseprite.convert(SQL, bytes, { fps: args.fps, layerName: args.layerName });
    fs.writeFileSync(output, result.aseprite);

    for (const warning of result.warnings) console.error(`warning: ${warning}`);
    console.log(`${output}: ${result.frames.length} frames, ${result.width}x${result.height}, ` +
      `${result.durationMs} ms/frame (${+result.fps.toFixed(2)} fps)`);
    result.frameNames.forEach((name, i) => console.log(`  frame ${String(i).padStart(3)}: ${name}`));
  }
}


main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
