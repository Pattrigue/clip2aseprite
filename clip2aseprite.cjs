#!/usr/bin/env node
// Command-line version of clip2aseprite. Uses the same converter as the web page (web/core.js).
//
// Usage:
//   node clip2aseprite.cjs input.clip [output.aseprite] [--fps N] [--layer-name NAME]
//
// Requires Node 18+.

"use strict";

const fs = require("fs");
const path = require("path");

const initSqlJs = require("./web/vendor/sql-wasm.js");
const { convert } = require("./web/core.js");

const USAGE = "usage: node clip2aseprite.cjs input.clip [output.aseprite] [--fps N] [--layer-name NAME]";


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
  const output = args.files[1] || input.replace(/\.clip$/i, "") + ".aseprite";

  const wasmBinary = fs.readFileSync(path.join(__dirname, "web", "vendor", "sql-wasm.wasm"));
  const SQL = await initSqlJs({ wasmBinary });

  const result = await convert(SQL, new Uint8Array(fs.readFileSync(input)), {
    fps: args.fps,
    layerName: args.layerName,
  });

  fs.writeFileSync(output, result.aseprite);

  for (const warning of result.warnings) console.error(`warning: ${warning}`);
  console.log(`${output}: ${result.frames.length} frames, ${result.width}x${result.height}, ` +
    `${result.durationMs} ms/frame (${+result.fps.toFixed(2)} fps)`);
  result.frameNames.forEach((name, i) => console.log(`  frame ${String(i).padStart(3)}: ${name}`));
}


main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
