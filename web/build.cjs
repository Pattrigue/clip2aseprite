#!/usr/bin/env node
// Bundle web/ into a single offline HTML file.
//
// Usage: node web/build.cjs [output.html]   (default: clip2aseprite.html in the repo root)

"use strict";

const fs = require("fs");
const path = require("path");

const web = __dirname;
const read = (...parts) => fs.readFileSync(path.join(web, ...parts));

const template = read("template.html").toString("utf8");
const sqlJs = read("vendor", "sql-wasm.js").toString("utf8");
const core = read("core.js").toString("utf8");
const wasmBase64 = read("vendor", "sql-wasm.wasm").toString("base64");

// The scripts are inlined into <script> tags, which a literal "</script" would end early.
for (const [name, js] of [["sql-wasm.js", sqlJs], ["core.js", core]]) {
  if (js.toLowerCase().includes("</script")) {
    throw new Error(`${name} contains '</script' and cannot be inlined as-is`);
  }
}

// Function replacements, so "$" sequences in the code are inserted literally
const html = template
  .replace("<!--SQLJS-->", () => sqlJs)
  .replace("<!--CORE-->", () => core)
  .replace("__WASM_BASE64__", () => wasmBase64);

const output = process.argv[2] || path.join(web, "..", "clip2aseprite.html");
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, html);

console.log(`wrote ${output} (${Math.round(fs.statSync(output).size / 1024)} KB)`);
