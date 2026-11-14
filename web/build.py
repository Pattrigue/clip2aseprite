#!/usr/bin/env python3
"""Bundle web/ into a single offline HTML file.

usage: python3 web/build.py [output.html]   (default: clip2aseprite.html in the repo root)
"""
import base64
import sys
from pathlib import Path

web = Path(__file__).resolve().parent
html = (web / "template.html").read_text(encoding="utf-8")
sqljs = (web / "vendor" / "sql-wasm.js").read_text(encoding="utf-8")
core = (web / "core.js").read_text(encoding="utf-8")
wasm = base64.b64encode((web / "vendor" / "sql-wasm.wasm").read_bytes()).decode("ascii")

for name, js in (("sql-wasm.js", sqljs), ("core.js", core)):
    if "</script" in js.lower():
        raise SystemExit(f"{name} contains '</script' and cannot be inlined as-is")

html = (html.replace("<!--SQLJS-->", sqljs)
            .replace("<!--CORE-->", core)
            .replace("__WASM_BASE64__", wasm))
out = Path(sys.argv[1]) if len(sys.argv) > 1 else web.parent / "clip2aseprite.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
