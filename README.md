# clip2aseprite

Converts a Clip Studio Paint animation (`.clip`) into a flattened `.aseprite` file:
one Aseprite frame per animation cel, with all of the cel's layers merged into a single layer.

## Use it

**In the browser:** open **https://pattrigue.github.io/clip2aseprite/** and drop `.clip` files onto the page.
Everything runs locally in your browser, and your files are never uploaded.

To use it offline, open https://pattrigue.github.io/clip2aseprite/clip2aseprite.html and save the page
(Ctrl+S). The single saved file works without an internet connection.

**From the command line** (needs Python 3.11+ and numpy):

```
python3 clip2aseprite.py animation.clip                  # writes animation.aseprite
python3 clip2aseprite.py animation.clip out.aseprite --fps 10
```

## What gets converted

- Frames and their order come from the CSP animation timeline, including cels held for several frames.
- Frame duration comes from the timeline frame rate (override with `--fps` or the page's Options).
- Layers are composited with Normal blending. Layer opacity and hidden layers are respected, and nested folders are supported.

Not supported yet (a warning is shown): blend modes other than Normal, clipping layers, layer masks,
and vector, tone or paper layers.

## Development

```
web/core.js        converter (browser + Node)
web/template.html  page UI
web/vendor/        sql.js (reads the SQLite database inside .clip files)
web/build.py       inlines everything into one HTML file
tests/smoke.cjs    tests the built HTML
clip2aseprite.py   command-line version (same logic in Python)
```

```
python3 web/build.py                    # -> clip2aseprite.html
node tests/smoke.cjs clip2aseprite.html # also converts any .clip files in testdata/ (git-ignored)
```

Pushing to `main` builds, tests and publishes the page to GitHub Pages (`.github/workflows/pages.yml`).

## How .clip files are read

A `.clip` file is a sequence of chunks. One chunk is a SQLite database holding the layer tree, the canvas
and the timeline. Other chunks hold the raw data that the database refers to:

- **Pixels:** 256×256 tiles, each compressed with zlib and containing an alpha plane followed by BGRA data.
- **Timeline:** each animation folder's track holds a `TimeClip` with Start and End, measured in 5 units per frame.

In the layer tree, a folder's first child is the bottom of its stack.
