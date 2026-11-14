#!/usr/bin/env node
// Bundle web/ into a single offline HTML file.
//
// Usage: node web/build.cjs [output.html]   (default: clip2aseprite.html in the repo root)

"use strict";

const fs = require("fs");
const path = require("path");

const web = __dirname;
const read = (...parts) => fs.readFileSync(path.join(web, ...parts));
const text = (...parts) => read(...parts).toString("utf8");

const scripts = {
  "<!--SQLJS-->": text("vendor", "sql-wasm.js"),
  "<!--SHARED-->": text("shared.js"),
  "<!--CLIP_TO_ASEPRITE-->": text("clip-to-aseprite.js"),
  "<!--ASEPRITE_TO_CLIP-->": text("aseprite-to-clip.js"),
};

const data = {
  "__WASM_BASE64__": read("vendor", "sql-wasm.wasm").toString("base64"),
  "__CLIP_TEMPLATE_BASE64__": read("template.clip").toString("base64"),
};

let html = text("template.html");

for (const [placeholder, js] of Object.entries(scripts)) {
  // The scripts are inlined into <script> tags, which a literal "</script" would end early.
  if (js.toLowerCase().includes("</script")) {
    throw new Error(`${placeholder} contains '</script' and cannot be inlined as-is`);
  }
  if (!html.includes(placeholder)) throw new Error(`template.html has no ${placeholder}`);

  // Function replacements, so "$" sequences in the code are inserted literally
  html = html.replace(placeholder, () => js);
}

for (const [placeholder, value] of Object.entries(data)) {
  if (!html.includes(placeholder)) throw new Error(`template.html has no ${placeholder}`);
  html = html.replace(placeholder, () => value);
}

const output = process.argv[2] || path.join(web, "..", "clip2aseprite.html");
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, html);

console.log(`wrote ${output} (${Math.round(fs.statSync(output).size / 1024)} KB)`);
