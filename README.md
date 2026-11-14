# clip2aseprite

Converts between Clip Studio Paint animations (`.clip`) and Aseprite files (`.aseprite` / `.ase`):

- **CLIP → Aseprite:** one Aseprite frame per timeline frame, with everything visible in that frame merged
  into a single layer.
- **Aseprite → CLIP:** each Aseprite frame is flattened into one CSP layer, shown on the CSP timeline for as long
  as the frame lasts ("one cel = one layer").

## Use it

**In the browser:** open **https://pattrigue.github.io/clip2aseprite/** and drop `.clip` or `.aseprite` files onto
the page. Each file is converted the other way. Everything runs locally in your browser, and your files are never
uploaded.

To use it offline, open https://pattrigue.github.io/clip2aseprite/clip2aseprite.html and save the page
(Ctrl+S). The single saved file works without an internet connection.

**From the command line** (needs Node 18+):

```
node clip2aseprite.cjs animation.clip                  # writes animation.aseprite
node clip2aseprite.cjs animation.aseprite              # writes animation.clip
node clip2aseprite.cjs animation.clip out.aseprite --fps 10
```

## What gets converted

CLIP → Aseprite:

- Frames come from the CSP animation timeline. Cels can be folders (e.g. a folder of body parts per frame)
  or plain layers, and a cel can be held for several frames.
- Frame duration comes from the timeline frame rate (override with `--fps` or the page's Options).
- Layers are composited with Normal blending. Layer opacity and hidden layers are respected, and nested folders
  are supported.
- Not supported yet (a warning is shown): blend modes other than Normal, clipping layers, layer masks,
  vector and tone layers, and cels that appear more than once on the timeline. Paper layers are skipped.

Aseprite → CLIP:

- Visible layers are flattened per frame (RGBA, grayscale and indexed sprites; groups, layer/cel opacity and
  linked cels are supported). Blend modes are drawn as Normal, tilemaps are skipped (a warning is shown).
- CSP has one frame rate per animation, so the frame rate is chosen to fit the Aseprite frame durations
  (100 ms frames → 10 fps; 100 ms and 150 ms → 20 fps, held for 2 and 3 frames).
- Layer thumbnails start out blank.

## Development

```
web/shared.js             .clip container, pixel tiles, timeline data, byte helpers
web/clip-to-aseprite.js   CLIP → Aseprite
web/aseprite-to-clip.js   Aseprite → CLIP
web/template.clip         small CSP animation used as the starting point for .clip output
web/template.html         page UI
web/vendor/               sql.js (reads and writes the SQLite database inside .clip files)
web/build.cjs             inlines everything into one HTML file
clip2aseprite.cjs         command-line wrapper
tests/smoke.cjs           tests the built HTML
```

```
node web/build.cjs                      # -> clip2aseprite.html
node tests/smoke.cjs clip2aseprite.html # also round-trips any .clip files in testdata/ (git-ignored)
```

Pushing to `main` builds, tests and publishes the page to GitHub Pages (`.github/workflows/pages.yml`).

## How .clip files work

A `.clip` file is a sequence of chunks. One chunk is a SQLite database holding the layer tree, the canvas
and the timeline. Other chunks hold the raw data that the database refers to; the database's `ExternalChunk`
table records where each of them starts in the file.

- **Pixels:** 256×256 tiles, each compressed with zlib and containing an alpha plane followed by BGRA data.
  Each tile has a checksum: the Adler-32 of its 4-byte length field and compressed data.
- **Timeline:** each layer or folder controlled by the timeline has a track whose key data (CSP's "binc" format,
  with a CRC32) holds a `TimeClip` with Start and End times and a `Rate` in time units per second.
  It is shown only during that range; layers without a track are always shown.

Each Aseprite frame from a `.clip` is a render of the whole document at that point in time.
In the layer tree, a folder's first child is the bottom of its stack.

`.clip` output is built by copying the structures of `web/template.clip` (saved by CSP) once per frame and filling
in new pixels and times, so everything CSP stores that the converter doesn't understand was written by CSP itself.
