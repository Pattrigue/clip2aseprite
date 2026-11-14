# clip2aseprite

Converts a Clip Studio Paint animation (`.clip`) into a flattened `.aseprite` file:
one Aseprite frame per timeline frame, with everything visible in that frame merged into a single layer.

## Use it

**In the browser:** open **https://pattrigue.github.io/clip2aseprite/** and drop `.clip` files onto the page.
Everything runs locally in your browser, and your files are never uploaded.

To use it offline, open https://pattrigue.github.io/clip2aseprite/clip2aseprite.html and save the page
(Ctrl+S). The single saved file works without an internet connection.

**From the command line** (needs Node 18+):

```
node clip2aseprite.cjs animation.clip                  # writes animation.aseprite
node clip2aseprite.cjs animation.clip out.aseprite --fps 10
```

## What gets converted

- Frames come from the CSP animation timeline. Cels can be folders (e.g. a folder of body parts per frame)
  or plain layers, and a cel can be held for several frames.
- Frame duration comes from the timeline frame rate (override with `--fps` or the page's Options).
- Layers are composited with Normal blending. Layer opacity and hidden layers are respected, and nested folders are supported.

Not supported yet (a warning is shown): blend modes other than Normal, clipping layers, layer masks,
vector and tone layers, and cels that appear more than once on the timeline. Paper layers are skipped.

## Development

```
web/core.js        the converter (shared by the web page and the command line)
web/template.html  page UI
web/vendor/        sql.js (reads the SQLite database inside .clip files)
web/build.cjs      inlines everything into one HTML file
clip2aseprite.cjs  command-line wrapper
tests/smoke.cjs    tests the built HTML
```

```
node web/build.cjs                      # -> clip2aseprite.html
node tests/smoke.cjs clip2aseprite.html # also converts any .clip files in testdata/ (git-ignored)
```

Pushing to `main` builds, tests and publishes the page to GitHub Pages (`.github/workflows/pages.yml`).

## How .clip files are read

A `.clip` file is a sequence of chunks. One chunk is a SQLite database holding the layer tree, the canvas
and the timeline. Other chunks hold the raw data that the database refers to:

- **Pixels:** 256×256 tiles, each compressed with zlib and containing an alpha plane followed by BGRA data.
- **Timeline:** each layer or folder controlled by the timeline has a track with a `TimeClip` (Start and End,
  measured in 5 units per frame). It is shown only during that range; layers without a track are always shown.

Each output frame is a render of the whole document at that point in time.
In the layer tree, a folder's first child is the bottom of its stack.
