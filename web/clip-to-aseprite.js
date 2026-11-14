// Convert a Clip Studio Paint animation (.clip) into a flattened .aseprite file.
//
// Each output frame is a render of the whole CSP document at that point on the
// timeline, merged into a single Aseprite layer.
//
// Public API:  Clip2Ase.convert(SQL, clipBytes, { fps, layerName }) -> result
// Needs shared.js and an initialised sql.js `SQL` object.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./shared.js"));
  else root.Clip2Ase = factory(root.ClipShared);
})(typeof globalThis !== "undefined" ? globalThis : this, function (shared) {
  "use strict";

  const {
    ByteWriter, zlibCompress, sqlQuery, readClip, decodeOffscreen,
    decodeBinc, findDoubles, readDouble, blendNormal, toUint8,
  } = shared;

  // CSP layer types (Layer.LayerType)
  const LAYER_FOLDER = 0;
  const LAYER_RASTER = 1;

  // CSP timeline tracks that show/hide a folder or a layer (Track.TrackKind)
  const TRACK_KIND_FOLDER = 1000;
  const TRACK_KIND_LAYER = 2001;

  // Aseprite chunk types
  const ASE_COLOR_PROFILE = 0x2007;
  const ASE_PALETTE = 0x2019;
  const ASE_LAYER = 0x2004;
  const ASE_CEL = 0x2005;


  // ===========================================================================
  // The document: layer tree, compositing and timeline
  // ===========================================================================

  class Document {
    constructor(SQL, bytes) {
      const { database, externals } = readClip(bytes);
      this.externals = externals;
      this.db = new SQL.Database(database);
      this.warnings = [];

      const canvas = sqlQuery(this.db, "select * from Canvas")[0];
      this.width = Math.round(canvas.CanvasWidth);
      this.height = Math.round(canvas.CanvasHeight);
      this.root = canvas.CanvasRootFolder;

      const layers = sqlQuery(this.db, "select * from Layer");
      this.layers = new Map(layers.map((row) => [row.MainId, row]));

      // Decoded layer pixels, reused when a layer appears in several frames
      this.pixelCache = new Map();

      // Frame range [start, end) per layer that is shown/hidden by the timeline.
      // Layers without an entry are always visible. Filled in by loadTimeline().
      this.visibleFrames = new Map();
    }

    warn(message) {
      if (!this.warnings.includes(message)) this.warnings.push(message);
    }

    close() {
      this.db.close();
    }

    // ---- layer tree ---------------------------------------------------------

    // Children of a folder, bottom-most first. Each layer links to its first
    // child and its next sibling; the first child is the bottom of the stack.
    children(layerId) {
      const result = [];

      let child = this.layers.get(layerId).LayerFirstChildIndex;
      while (child) {
        result.push(child);
        child = this.layers.get(child).LayerNextIndex;
      }

      return result;
    }

    // ---- pixels -------------------------------------------------------------

    // A raster layer's pixels placed on a canvas-sized Float64 RGBA array.
    async layerPixels(layerId) {
      const layer = this.layers.get(layerId);
      const canvas = new Float64Array(this.width * this.height * 4);

      // Layer -> Mipmap -> MipmapInfo (full-size level) -> Offscreen
      const row = sqlQuery(this.db,
        "select o.Attribute as attribute, cast(o.BlockData as text) as blobName " +
        "from Mipmap m " +
        "join MipmapInfo i on i.MainId = m.BaseMipmapInfo " +
        "join Offscreen o on o.MainId = i.Offscreen " +
        "where m.MainId = ?",
        [layer.LayerRenderMipmap])[0];

      if (!row || !this.externals.has(row.blobName)) return canvas;

      if (!this.pixelCache.has(layerId)) {
        this.pixelCache.set(layerId, await decodeOffscreen(row.attribute, this.externals.get(row.blobName)));
      }
      const image = this.pixelCache.get(layerId);

      // Where the pixel data's top-left corner sits on the canvas
      const left = layer.LayerOffsetX + layer.LayerRenderOffscrOffsetX;
      const top = layer.LayerOffsetY + layer.LayerRenderOffscrOffsetY;

      // Clip to the canvas
      const x0 = Math.max(0, left);
      const y0 = Math.max(0, top);
      const x1 = Math.min(this.width, left + image.width);
      const y1 = Math.min(this.height, top + image.height);

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const src = ((y - top) * image.width + (x - left)) * 4;
          const dst = (y * this.width + x) * 4;
          for (let c = 0; c < 4; c++) canvas[dst + c] = image.pixels[src + c] / 255;
        }
      }

      return canvas;
    }

    // Is this layer shown at this frame? (Layers without a timeline track always are.)
    isVisibleAt(layerId, frame) {
      const range = this.visibleFrames.get(layerId);
      return !range || (frame >= range.start && frame < range.end);
    }

    // Composite a layer or folder, as it looks at `frame`, into a Float64 RGBA canvas.
    async render(layerId, frame) {
      const layer = this.layers.get(layerId);
      if (!layer.LayerFolder) return this.layerPixels(layerId);

      const result = new Float64Array(this.width * this.height * 4);

      for (const childId of this.children(layerId)) {
        const child = this.layers.get(childId);
        const name = child.LayerName;

        if (!((child.LayerVisibility || 0) & 1)) continue;
        if (!this.isVisibleAt(childId, frame)) continue;

        if (child.LayerType !== LAYER_FOLDER && child.LayerType !== LAYER_RASTER) {
          this.warn(`Layer "${name}" is a special layer type (vector, tone, paper…) and was skipped.`);
          continue;
        }

        if (child.LayerComposite) this.warn(`Layer "${name}" uses a blend mode; it was drawn as Normal.`);
        if (child.LayerClip) this.warn(`Layer "${name}" is a clipping layer; clipping was ignored.`);
        if (child.LayerLayerMaskMipmap) this.warn(`Layer "${name}" has a layer mask; the mask was ignored.`);

        const opacity = (child.LayerOpacity || 0) / 256;
        blendNormal(result, await this.render(childId, frame), opacity);
      }

      return result;
    }

    // ---- timeline -----------------------------------------------------------

    // Read the animation timeline and record when each tracked layer/folder is
    // visible (this.visibleFrames). Returns { fps, firstFrame, frameCount },
    // or null if the file has no animation.
    //
    // Cels can be folders (e.g. one folder of body parts per frame) or plain
    // layers; both get a track with a TimeClip saying when they are shown.
    // Layers inside a cel folder also have tracks, normally spanning the
    // whole timeline.
    async loadTimeline() {
      const timeline = sqlQuery(this.db, "select * from TimeLine order by MainId")[0];
      if (!timeline) return null;

      const layersByUuid = new Map();
      for (const [layerId, row] of this.layers) layersByUuid.set(normalizeUuid(row.LayerUuid), layerId);

      const tracks = sqlQuery(this.db,
        "select MainId, hex(LayerUuidWithTrack) as uuid, TrackKind, " +
        "cast(TrackActionMixer2 as text) as keys " +
        "from Track where BankId = ?",
        [timeline.BankId]);

      for (const track of tracks) {
        if (track.TrackKind !== TRACK_KIND_FOLDER && track.TrackKind !== TRACK_KIND_LAYER) continue;
        if (!this.externals.has(track.keys)) continue;

        const layerId = layersByUuid.get(normalizeUuid(track.uuid));
        if (layerId === undefined) {
          this.warn("A timeline track refers to a missing layer.");
          continue;
        }

        const clip = await readTimeClip(this.externals.get(track.keys));
        const unitsPerFrame = clip.rate / timeline.FrameRate;

        this.visibleFrames.set(layerId, {
          start: Math.round(clip.start / unitsPerFrame),
          end: Math.round(clip.end / unitsPerFrame),
        });
      }

      if (!this.visibleFrames.size) return null;

      this.firstFrame = Math.round(timeline.StartFrame);
      this.endFrame = Math.round(timeline.EndFrame);

      return {
        fps: timeline.FrameRate,
        firstFrame: this.firstFrame,
        frameCount: this.endFrame - this.firstFrame,
      };
    }

    // Names of the timeline-controlled layers shown at `frame` that are
    // themselves visible, outermost first (used to report what each frame shows).
    celNamesAt(frame) {
      const names = [];

      const visit = (layerId) => {
        for (const childId of this.children(layerId)) {
          const child = this.layers.get(childId);
          if (!((child.LayerVisibility || 0) & 1) || !this.isVisibleAt(childId, frame)) continue;

          const range = this.visibleFrames.get(childId);
          const isCel = range && !(range.start <= this.firstFrame && range.end >= this.endFrame);

          if (isCel) names.push(child.LayerName);
          else if (child.LayerFolder) visit(childId);
        }
      };

      visit(this.root);
      return names;
    }
  }

  // UUIDs are stored with inconsistent dashes; compare just the hex digits.
  function normalizeUuid(value) {
    return String(value || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  }

  // The first TimeClip's Start and End, and the timeline Rate (units per second).
  async function readTimeClip(blob) {
    const binc = await decodeBinc(blob);

    const first = (field) => {
      const positions = findDoubles(binc, field);
      if (!positions.length) throw new Error(`Timeline field ${field} not found.`);
      return readDouble(binc.data, positions[0]);
    };

    const ratePositions = findDoubles(binc, "Rate");
    const rate = ratePositions.length ? readDouble(binc.data, ratePositions[0]) : 60;

    return { start: first("Start"), end: first("End"), rate };
  }


  // ===========================================================================
  // Writing the .aseprite file
  // ===========================================================================
  //
  // Format reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
  //
  // 128-byte header, then one frame block per frame. Frame 1 carries the colour
  // profile, palette and layer chunks; every frame carries one compressed cel
  // cropped to its visible pixels. All numbers are little-endian.

  function makeChunk(type, body) {
    return new ByteWriter().u32(body.length + 6).u16(type).bytes(body).toBytes();
  }

  // Up to 256 visible colours, for the palette (informational in RGBA mode).
  // Sorted by R, G, B, A.
  function uniqueColors(frames) {
    const seen = new Set();

    for (const frame of frames) {
      for (let i = 0; i < frame.length; i += 4) {
        if (!frame[i + 3]) continue;
        seen.add(((frame[i] << 24) >>> 0) + (frame[i + 1] << 16) + (frame[i + 2] << 8) + frame[i + 3]);
      }
    }

    const colors = [...seen].sort((a, b) => a - b).slice(0, 256);
    if (!colors.length) colors.push(255); // opaque black

    return colors.map((c) => [c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255]);
  }

  // Bounding box of the non-transparent pixels, or null if the frame is empty.
  function visibleBounds(image, width, height) {
    let left = width, top = height, right = -1, bottom = -1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!image[(y * width + x) * 4 + 3]) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }

    if (right < 0) return null;
    return { left, top, width: right - left + 1, height: bottom - top + 1 };
  }

  function cropImage(image, imageWidth, box) {
    const out = new Uint8Array(box.width * box.height * 4);

    for (let y = 0; y < box.height; y++) {
      const rowStart = ((box.top + y) * imageWidth + box.left) * 4;
      out.set(image.subarray(rowStart, rowStart + box.width * 4), y * box.width * 4);
    }

    return out;
  }

  async function writeAseprite(frames, width, height, durationMs, layerName) {
    const colors = uniqueColors(frames);

    // Chunks that only appear in the first frame
    const colorProfile = new ByteWriter()
      .u16(1)      // sRGB
      .u16(0)      // flags
      .u32(0)      // gamma (unused)
      .zeros(8)
      .toBytes();

    const palette = new ByteWriter()
      .u32(colors.length)
      .u32(0)                 // first index
      .u32(colors.length - 1) // last index
      .zeros(8);
    for (const [r, g, b, a] of colors) palette.u16(0).u8(r).u8(g).u8(b).u8(a);

    const nameBytes = new TextEncoder().encode(layerName);
    const layer = new ByteWriter()
      .u16(3)      // flags: visible + editable
      .u16(0)      // normal layer
      .u16(0)      // child level
      .u16(0).u16(0)
      .u16(0)      // blend mode: normal
      .u8(255)     // opacity
      .zeros(3)
      .u16(nameBytes.length).bytes(nameBytes)
      .toBytes();

    // Frames
    const body = new ByteWriter();

    for (let index = 0; index < frames.length; index++) {
      const image = frames[index];
      const chunks = [];

      if (index === 0) {
        chunks.push(makeChunk(ASE_COLOR_PROFILE, colorProfile));
        chunks.push(makeChunk(ASE_PALETTE, palette.toBytes()));
        chunks.push(makeChunk(ASE_LAYER, layer));
      }

      const box = visibleBounds(image, width, height);
      if (box) {
        const pixels = await zlibCompress(cropImage(image, width, box));
        const cel = new ByteWriter()
          .u16(0)                 // layer index
          .i16(box.left).i16(box.top)
          .u8(255)                // opacity
          .u16(2)                 // compressed image
          .i16(0)                 // z-index
          .zeros(5)
          .u16(box.width).u16(box.height)
          .bytes(pixels)
          .toBytes();
        chunks.push(makeChunk(ASE_CEL, cel));
      }

      const chunksLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      body
        .u32(16 + chunksLength)
        .u16(0xF1FA)                           // frame magic
        .u16(Math.min(chunks.length, 0xFFFF))  // old chunk count
        .u16(durationMs)
        .zeros(2)
        .u32(chunks.length);
      chunks.forEach((chunk) => body.bytes(chunk));
    }

    // File header (padded to 128 bytes)
    const header = new ByteWriter()
      .u32(128 + body.length)  // file size
      .u16(0xA5E0)             // magic
      .u16(frames.length)
      .u16(width).u16(height)
      .u16(32)                 // bits per pixel: RGBA
      .u32(1)                  // flags: layer opacity is valid
      .u16(durationMs)         // deprecated speed
      .u32(0).u32(0)
      .u8(0)                   // transparent palette index
      .zeros(3)
      .u16(colors.length)
      .u8(1).u8(1)             // pixel ratio 1:1
      .i16(0).i16(0)           // grid position
      .u16(16).u16(16);        // grid size
    header.zeros(128 - header.length);

    return new ByteWriter().bytes(header.toBytes()).bytes(body.toBytes()).toBytes();
  }


  // ===========================================================================
  // Public API
  // ===========================================================================

  async function convert(SQL, bytes, options = {}) {
    const doc = new Document(SQL, bytes);

    try {
      // Work out which frames to render
      const timeline = await doc.loadTimeline();
      let fps = 12;
      let frameNumbers = [0];
      let frameNames = ["(whole canvas)"];

      if (timeline) {
        fps = timeline.fps;
        frameNumbers = Array.from({ length: timeline.frameCount }, (_, i) => timeline.firstFrame + i);
        frameNames = frameNumbers.map((frame) => doc.celNamesAt(frame).join(" + ") || "(empty)");

        frameNames.forEach((name, index) => {
          if (name === "(empty)") doc.warn(`Frame ${index + 1} has no cel on the timeline.`);
        });
      } else {
        doc.warn("No animation timeline found, so the whole canvas was exported as one frame.");
      }

      if (options.fps) fps = options.fps;

      // Render each frame of the whole document, then write the file
      const frames = [];
      for (const frame of frameNumbers) {
        frames.push(toUint8(await doc.render(doc.root, frame)));
      }

      const durationMs = Math.max(1, Math.round(1000 / fps));
      const aseprite = await writeAseprite(frames, doc.width, doc.height, durationMs,
        options.layerName || "Sprite Sheet");

      return {
        aseprite,
        frames,
        width: doc.width,
        height: doc.height,
        fps,
        durationMs,
        warnings: doc.warnings,
        frameNames,
      };
    } finally {
      doc.close();
    }
  }

  return { convert };
});
