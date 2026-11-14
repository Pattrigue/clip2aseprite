// Convert an Aseprite file (.aseprite / .ase) into a Clip Studio Paint animation (.clip).
//
// Every Aseprite frame is flattened into one CSP raster layer, and each layer is
// shown on the CSP timeline for as long as the Aseprite frame lasts.
//
// The .clip is built from a template saved by CSP itself (a 2-frame animation where
// each frame is one plain layer): the template's first frame layer, with its timeline
// track, is copied once per output frame and filled with new pixels. Everything CSP
// stores that we don't understand is therefore something CSP wrote.
//
// Public API:  Ase2Clip.convert(SQL, asepriteBytes, templateBytes, { fps }) -> result
// Needs shared.js and an initialised sql.js `SQL` object.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./shared.js"));
  else root.Ase2Clip = factory(root.ClipShared);
})(typeof globalThis !== "undefined" ? globalThis : this, function (shared) {
  "use strict";

  const {
    ByteWriter, concatBytes, readU32BE, zlibDecompress, randomBytes, hex, encodePng,
    sqlQuery, sqlInsert, readClip, writeClip, newExternalId,
    parseOffscreenAttribute, updateOffscreenAttribute, encodeOffscreen,
    decodeBinc, findDoubles, readDouble, writeDouble, encodeBinc,
  } = shared;

  // Aseprite chunk types
  const ASE_OLD_PALETTE = 0x0004;
  const ASE_LAYER = 0x2004;
  const ASE_CEL = 0x2005;
  const ASE_PALETTE = 0x2019;

  // Aseprite layer flags
  const LAYER_VISIBLE = 1;
  const LAYER_REFERENCE = 64;

  // Aseprite layer types
  const LAYER_NORMAL = 0;
  const LAYER_GROUP = 1;

  const MAX_FPS = 60;


  // ===========================================================================
  // Reading the .aseprite file
  // ===========================================================================
  //
  // Format reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
  //
  // 128-byte header, then one block per frame. Each frame holds chunks: layers
  // (in the first frame), palettes and cels (a layer's image in that frame).
  // All numbers are little-endian.

  class Reader {
    constructor(bytes, pos = 0) {
      this.bytes = bytes;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.pos = pos;
    }

    u8() { return this.bytes[this.pos++]; }
    u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
    i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
    u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    skip(count) { this.pos += count; }
    take(count) { const out = this.bytes.subarray(this.pos, this.pos + count); this.pos += count; return out; }

    string() {
      const length = this.u16();
      return new TextDecoder().decode(this.take(length));
    }
  }

  async function readAseprite(bytes) {
    const warnings = [];
    const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };

    const header = new Reader(bytes);
    header.skip(4); // file size
    if (header.u16() !== 0xA5E0) throw new Error("This is not an Aseprite (.aseprite / .ase) file.");

    const frameCount = header.u16();
    const width = header.u16();
    const height = header.u16();
    const depth = header.u16();
    const flags = header.u32();
    header.skip(2 + 4 + 4); // speed, reserved
    const transparentIndex = header.u8();

    if (![8, 16, 32].includes(depth)) throw new Error(`Unsupported colour depth (${depth} bits).`);
    const layerOpacityValid = (flags & 1) !== 0;

    const layers = [];
    const palette = [];
    const frames = [];

    let pos = 128;
    for (let f = 0; f < frameCount; f++) {
      const frame = new Reader(bytes, pos);
      const frameSize = frame.u32();
      if (frame.u16() !== 0xF1FA) throw new Error("Damaged Aseprite file (bad frame header).");
      const oldChunkCount = frame.u16();
      const durationMs = frame.u16();
      frame.skip(2);
      const newChunkCount = frame.u32();
      const chunkCount = newChunkCount || oldChunkCount;

      const cels = [];

      for (let c = 0; c < chunkCount; c++) {
        const chunkStart = frame.pos;
        const chunkSize = frame.u32();
        const type = frame.u16();
        const chunk = new Reader(bytes, frame.pos);

        if (type === ASE_LAYER) {
          const layerFlags = chunk.u16();
          const layerType = chunk.u16();
          const childLevel = chunk.u16();
          chunk.skip(4); // default width/height
          const blendMode = chunk.u16();
          const opacity = chunk.u8();
          chunk.skip(3);
          const name = chunk.string();
          layers.push({ flags: layerFlags, type: layerType, childLevel, blendMode, opacity, name });

        } else if (type === ASE_PALETTE) {
          chunk.skip(4); // new palette size
          const first = chunk.u32();
          const last = chunk.u32();
          chunk.skip(8);
          for (let i = first; i <= last; i++) {
            const entryFlags = chunk.u16();
            palette[i] = [chunk.u8(), chunk.u8(), chunk.u8(), chunk.u8()];
            if (entryFlags & 1) chunk.string();
          }

        } else if (type === ASE_OLD_PALETTE && !palette.length) {
          const packets = chunk.u16();
          let index = 0;
          for (let p = 0; p < packets; p++) {
            index += chunk.u8();
            const count = chunk.u8() || 256;
            for (let i = 0; i < count; i++) palette[index++] = [chunk.u8(), chunk.u8(), chunk.u8(), 255];
          }

        } else if (type === ASE_CEL) {
          const layerIndex = chunk.u16();
          const x = chunk.i16();
          const y = chunk.i16();
          const opacity = chunk.u8();
          const celType = chunk.u16();
          const zIndex = chunk.i16();
          chunk.skip(5);

          if (zIndex) warn("Some cels use a z-index; they were drawn in normal layer order.");

          if (celType === 0 || celType === 2) {
            const celWidth = chunk.u16();
            const celHeight = chunk.u16();
            const data = chunk.take(chunkStart + chunkSize - chunk.pos);
            const pixels = celType === 2 ? await zlibDecompress(data) : data;
            cels.push({ layerIndex, x, y, opacity, width: celWidth, height: celHeight, pixels });
          } else if (celType === 1) {
            cels.push({ layerIndex, linkedFrame: chunk.u16(), opacity, x, y });
          } else {
            warn("Tilemap cels are not supported and were skipped.");
          }
        }

        frame.pos = chunkStart + chunkSize;
      }

      frames.push({ durationMs, cels });
      pos += frameSize;
    }

    // Linked cels reuse the image of the same layer in another frame
    for (const frame of frames) {
      frame.cels = frame.cels.map((cel) => {
        if (cel.linkedFrame === undefined) return cel;
        const source = frames[cel.linkedFrame]?.cels.find((c) => c.layerIndex === cel.layerIndex && c.pixels);
        return source ? { ...source, opacity: cel.opacity } : null;
      }).filter(Boolean);
    }

    const sprite = { width, height, depth, transparentIndex, layerOpacityValid, layers, palette, frames };
    return { sprite, warnings };
  }

  // Which layers are drawn, and with what combined opacity (0..1)?
  // Layers are nested with `childLevel`; a hidden group hides everything in it.
  function layerVisibility(sprite, warn) {
    const result = [];
    const parents = []; // stack of { visible, opacity } per child level

    sprite.layers.forEach((layer, index) => {
      parents.length = layer.childLevel;
      const parent = parents[layer.childLevel - 1] || { visible: true, opacity: 1 };

      const opacity = (sprite.layerOpacityValid ? layer.opacity / 255 : 1) * parent.opacity;
      const visible = parent.visible && (layer.flags & LAYER_VISIBLE) !== 0 && !(layer.flags & LAYER_REFERENCE);

      parents[layer.childLevel] = { visible, opacity };

      if (layer.type === LAYER_GROUP) return;
      if (layer.type !== LAYER_NORMAL) {
        if (visible) warn(`Layer "${layer.name}" is a tilemap layer and was skipped.`);
        return;
      }
      if (visible && layer.blendMode !== 0) {
        warn(`Layer "${layer.name}" uses a blend mode; it was drawn as Normal.`);
      }

      result[index] = { visible, opacity };
    });

    return result;
  }

  // Flatten one Aseprite frame into 8-bit RGBA.
  function flattenFrame(sprite, frame, visibility) {
    const { width, height, depth, palette, transparentIndex } = sprite;
    const out = new Float64Array(width * height * 4);

    const cels = [...frame.cels].sort((a, b) => a.layerIndex - b.layerIndex);

    for (const cel of cels) {
      const layer = visibility[cel.layerIndex];
      if (!layer || !layer.visible) continue;

      const opacity = layer.opacity * (cel.opacity / 255);
      const isBackground = (sprite.layers[cel.layerIndex].flags & 8) !== 0;

      for (let cy = 0; cy < cel.height; cy++) {
        const y = cel.y + cy;
        if (y < 0 || y >= height) continue;

        for (let cx = 0; cx < cel.width; cx++) {
          const x = cel.x + cx;
          if (x < 0 || x >= width) continue;

          // Source pixel as RGBA 0..255
          let r, g, b, a;
          const i = cy * cel.width + cx;
          if (depth === 32) {
            [r, g, b, a] = [cel.pixels[i * 4], cel.pixels[i * 4 + 1], cel.pixels[i * 4 + 2], cel.pixels[i * 4 + 3]];
          } else if (depth === 16) {
            r = g = b = cel.pixels[i * 2];
            a = cel.pixels[i * 2 + 1];
          } else {
            const index = cel.pixels[i];
            if (index === transparentIndex && !isBackground) continue;
            [r, g, b, a] = palette[index] || [0, 0, 0, 0];
          }

          const above = (a / 255) * opacity;
          if (above <= 0) continue;

          const o = (y * width + x) * 4;
          const below = out[o + 3];
          const total = above + below * (1 - above);
          out[o] = (r / 255 * above + out[o] * below * (1 - above)) / total;
          out[o + 1] = (g / 255 * above + out[o + 1] * below * (1 - above)) / total;
          out[o + 2] = (b / 255 * above + out[o + 2] * below * (1 - above)) / total;
          out[o + 3] = total;
        }
      }
    }

    return shared.toUint8(out);
  }


  // ===========================================================================
  // Timing
  // ===========================================================================
  //
  // CSP has one frame rate per animation, Aseprite has a duration per frame.
  // Pick the frame rate that fits all durations exactly (e.g. 100 ms -> 10 fps;
  // 100 ms and 150 ms -> 20 fps, held for 2 and 3 frames), or, if there is none,
  // the closest one and round.

  function chooseTiming(durations, fpsOverride, warn) {
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const base = durations.reduce(gcd);

    let fps = fpsOverride;
    if (!fps) {
      fps = 1000 / base;
      if (!Number.isInteger(fps) || fps > MAX_FPS) {
        fps = Math.min(MAX_FPS, Math.max(1, Math.round(1000 / Math.min(...durations))));
      }
    }

    const holds = durations.map((ms) => Math.max(1, Math.round((ms * fps) / 1000)));
    if (holds.some((hold, i) => Math.abs(hold * 1000 / fps - durations[i]) > 0.5)) {
      warn(`Frame durations don't fit exactly at ${fps} fps; they were rounded to whole frames.`);
    }

    return { fps, holds };
  }


  // ===========================================================================
  // Building the .clip from the template
  // ===========================================================================

  function uuidText(bytes) {
    // CSP stores layer UUIDs as text with dashes after 10, 14, 18 and 22 hex digits
    const h = hex(bytes);
    return `${h.slice(0, 10)}-${h.slice(10, 14)}-${h.slice(14, 18)}-${h.slice(18, 22)}-${h.slice(22)}`;
  }

  function asciiBytes(text) {
    return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  }

  function blobName(value) {
    return typeof value === "string" ? value : String.fromCharCode(...value);
  }

  function maxId(db, table) {
    return sqlQuery(db, `select coalesce(max(MainId), 0) as id from ${table}`)[0].id;
  }

  // Rows describing one frame layer of the template, to be copied per frame.
  function templateFrameRows(db, layerId) {
    const one = (sql, params) => {
      const row = sqlQuery(db, sql, params)[0];
      if (!row) throw new Error("The built-in template is incomplete.");
      return row;
    };

    const layer = one("select * from Layer where MainId = ?", [layerId]);
    const mipmap = one("select * from Mipmap where MainId = ?", [layer.LayerRenderMipmap]);
    const mipmapInfo = one("select * from MipmapInfo where MainId = ?", [mipmap.BaseMipmapInfo]);
    const offscreen = one("select * from Offscreen where MainId = ?", [mipmapInfo.Offscreen]);
    const thumbnail = one("select * from LayerThumbnail where MainId = ?", [layer.LayerRenderThumbnail]);
    const thumbnailOffscreen = one("select * from Offscreen where MainId = ?", [thumbnail.ThumbnailOffscreen]);
    const track = one("select * from Track where hex(LayerUuidWithTrack) = ?",
      [layer.LayerUuid.replace(/-/g, "").toUpperCase()]);

    for (const row of [layer, mipmap, mipmapInfo, offscreen, thumbnail, thumbnailOffscreen, track]) delete row._PW_ID;
    return { layer, mipmap, mipmapInfo, offscreen, thumbnail, thumbnailOffscreen, track };
  }

  // Copy a timeline key blob with new Start/End times (all occurrences).
  async function retimeTrackBlob(binc, start, end) {
    const data = new Uint8Array(binc.data);
    findDoubles(binc, "Start").forEach((pos) => writeDouble(data, pos, start));
    findDoubles(binc, "End").forEach((pos) => writeDouble(data, pos, end));
    return encodeBinc(data);
  }

  async function buildClip(SQL, templateBytes, images, width, height, timing) {
    const template = readClip(templateBytes);
    const db = new SQL.Database(template.database);

    try {
      const canvas = sqlQuery(db, "select * from Canvas")[0];
      const rootId = canvas.CanvasRootFolder;
      const root = sqlQuery(db, "select * from Layer where MainId = ?", [rootId])[0];
      const timeline = sqlQuery(db, "select * from TimeLine order by MainId")[0];

      // ---- the template's frame layer, which every new frame copies ----------

      const tpl = templateFrameRows(db, root.LayerFirstChildIndex);
      const mixer = await decodeBinc(template.externals.get(blobName(tpl.track.TrackActionMixer)));
      const mixer2 = await decodeBinc(template.externals.get(blobName(tpl.track.TrackActionMixer2)));

      // Timeline units per second ("Rate"); units per frame = Rate / fps
      const ratePositions = findDoubles(mixer2, "Rate");
      const rate = ratePositions.length ? readDouble(mixer2.data, ratePositions[0]) : 60;
      const unitsPerFrame = rate / timing.fps;

      // LayerComp lists every layer; keep the template's per-layer flags
      const layerComp = sqlQuery(db, "select * from LayerComp order by MainId")[0];
      const compEntryFlags = layerComp ? layerComp.CompLayerInfo.subarray(8 + 24, 8 + 32) : null;

      // ---- remove the template's layers (everything except the root folder) --

      for (const table of ["Layer", "Mipmap", "MipmapInfo", "Offscreen", "LayerThumbnail"]) {
        const column = table === "Layer" ? "MainId" : "LayerId";
        db.run(`delete from ${table} where ${column} != ?`, [rootId]);
      }
      db.run("delete from Track");

      // ---- canvas size --------------------------------------------------------

      db.run("update Canvas set CanvasWidth = ?, CanvasHeight = ?", [width, height]);
      db.run("update Project set DefaultPageWidth = ?, DefaultPageHeight = ?", [width, height]);
      db.run("update LayerThumbnail set ThumbnailCanvasWidth = ?, ThumbnailCanvasHeight = ?", [width, height]);

      // The root folder's composite has no stored pixels (CSP renders it), but its
      // attribute still describes the canvas size.
      const rootMipmap = sqlQuery(db, "select * from Mipmap where MainId = ?", [root.LayerRenderMipmap])[0];
      const rootInfo = sqlQuery(db, "select * from MipmapInfo where MainId = ?", [rootMipmap.BaseMipmapInfo])[0];
      const rootOffscreen = sqlQuery(db, "select * from Offscreen where MainId = ?", [rootInfo.Offscreen])[0];
      const emptyCanvas = await encodeOffscreen(null, width, height);
      db.run("update Offscreen set Attribute = ? where MainId = ?", [
        updateOffscreenAttribute(rootOffscreen.Attribute, width, height,
          emptyCanvas.tilesAcross, emptyCanvas.tilesDown, emptyCanvas.recordSizes),
        rootOffscreen.MainId,
      ]);

      // ---- one layer + track per frame ---------------------------------------

      const ids = {};
      for (const table of ["Layer", "Mipmap", "MipmapInfo", "Offscreen", "LayerThumbnail", "Track"]) {
        ids[table] = maxId(db, table);
      }
      const nextId = (table) => ++ids[table];

      const thumbnailSize = parseOffscreenAttribute(tpl.thumbnailOffscreen.Attribute);
      const emptyThumbnail = await encodeOffscreen(null, thumbnailSize.width, thumbnailSize.height);

      const newExternals = new Map();
      const newLayers = [];
      let frameStart = 0;

      for (let i = 0; i < images.length; i++) {
        const layerId = nextId("Layer");
        const mipmapId = nextId("Mipmap");
        const mipmapInfoId = nextId("MipmapInfo");
        const offscreenId = nextId("Offscreen");
        const thumbnailOffscreenId = nextId("Offscreen");
        const thumbnailId = nextId("LayerThumbnail");
        const trackId = nextId("Track");
        const uuid = randomBytes(16);

        // Pixels
        const pixels = await encodeOffscreen(images[i], width, height);
        const pixelsBlob = newExternalId();
        newExternals.set(pixelsBlob, pixels.data);

        const thumbnailBlob = newExternalId();
        newExternals.set(thumbnailBlob, emptyThumbnail.data);

        sqlInsert(db, "Offscreen", {
          ...tpl.offscreen,
          MainId: offscreenId,
          LayerId: layerId,
          Attribute: updateOffscreenAttribute(tpl.offscreen.Attribute, width, height,
            pixels.tilesAcross, pixels.tilesDown, pixels.recordSizes),
          BlockData: asciiBytes(pixelsBlob),
        });
        sqlInsert(db, "Offscreen", {
          ...tpl.thumbnailOffscreen,
          MainId: thumbnailOffscreenId,
          LayerId: layerId,
          Attribute: updateOffscreenAttribute(tpl.thumbnailOffscreen.Attribute, thumbnailSize.width,
            thumbnailSize.height, emptyThumbnail.tilesAcross, emptyThumbnail.tilesDown, emptyThumbnail.recordSizes),
          BlockData: asciiBytes(thumbnailBlob),
        });
        sqlInsert(db, "MipmapInfo", { ...tpl.mipmapInfo, MainId: mipmapInfoId, LayerId: layerId, Offscreen: offscreenId });
        sqlInsert(db, "Mipmap", { ...tpl.mipmap, MainId: mipmapId, LayerId: layerId, BaseMipmapInfo: mipmapInfoId });
        sqlInsert(db, "LayerThumbnail", {
          ...tpl.thumbnail,
          MainId: thumbnailId,
          LayerId: layerId,
          ThumbnailOffscreen: thumbnailOffscreenId,
          ThumbnailCanvasWidth: width,
          ThumbnailCanvasHeight: height,
        });

        // Layer (the sibling link is filled in below)
        sqlInsert(db, "Layer", {
          ...tpl.layer,
          MainId: layerId,
          LayerName: `Frame ${i + 1}`,
          LayerNextIndex: 0,
          LayerRenderMipmap: mipmapId,
          LayerRenderThumbnail: thumbnailId,
          LayerUuid: uuidText(uuid),
          LayerSelect: i === 0 ? tpl.layer.LayerSelect : 0,
        });

        // Timeline: show this layer from frameStart for `hold` frames
        const start = frameStart * unitsPerFrame;
        const end = (frameStart + timing.holds[i]) * unitsPerFrame;
        frameStart += timing.holds[i];

        const mixerBlob = newExternalId();
        const mixer2Blob = newExternalId();
        newExternals.set(mixerBlob, await retimeTrackBlob(mixer, start, end));
        newExternals.set(mixer2Blob, await retimeTrackBlob(mixer2, start, end));

        sqlInsert(db, "Track", {
          ...tpl.track,
          MainId: trackId,
          TrackNextIndex: 0,
          LayerUuidWithTrack: uuid,
          TrackUuid: randomBytes(16),
          TrackActionMixer: asciiBytes(mixerBlob),
          TrackActionMixer2: asciiBytes(mixer2Blob),
        });

        newLayers.push({ layerId, trackId, uuid });
      }

      // ---- links between rows -------------------------------------------------

      // First child is the bottom of the stack, so frame 1 ends up at the bottom.
      newLayers.forEach(({ layerId, trackId }, i) => {
        const next = newLayers[i + 1];
        db.run("update Layer set LayerNextIndex = ? where MainId = ?", [next ? next.layerId : 0, layerId]);
        db.run("update Track set TrackNextIndex = ? where MainId = ?", [next ? next.trackId : 0, trackId]);
      });

      db.run("update Layer set LayerFirstChildIndex = ? where MainId = ?", [newLayers[0].layerId, rootId]);
      db.run("update Canvas set CanvasCurrentLayer = ?", [newLayers[0].layerId]);
      db.run(
        "update TimeLine set FirstTrack = ?, FrameRate = ?, StartFrame = 0, EndFrame = ?, " +
        "CurrentFrame = 0, SmallestStartFrame = 0, BiggestEndFrame = ? where MainId = ?",
        [newLayers[0].trackId, timing.fps, frameStart, frameStart, timeline.MainId]);

      if (layerComp) {
        const info = new ByteWriter().u32be(8).u32be(newLayers.length);
        for (const { uuid } of newLayers) info.u32be(0x20).u32be(0x10).bytes(uuid).bytes(compEntryFlags);
        db.run("update LayerComp set CompLayerInfo = ? where MainId = ?", [info.toBytes(), layerComp.MainId]);
      }

      // Highest id per table
      for (const [table, id] of Object.entries(ids)) {
        db.run("update ElemScheme set MaxIndex = ? where TableName = ? and MaxIndex < ?", [id, table, id]);
      }

      // File preview (shown by file browsers and CSP's open dialog)
      db.run("update CanvasPreview set ImageWidth = ?, ImageHeight = ?, ImageData = ?",
        [width, height, await encodePng(images[0], width, height)]);

      // ---- external blobs: keep the template's that are still referenced -----

      const referenced = new Set();
      for (const { TableName, ColumnName } of sqlQuery(db, "select * from ExternalTableAndColumnName")) {
        const exists = sqlQuery(db, "select 1 from sqlite_master where type = 'table' and name = ?", [TableName]);
        if (!exists.length) continue;
        for (const row of sqlQuery(db, `select cast(${ColumnName} as text) as id from ${TableName}`)) {
          if (row.id) referenced.add(row.id);
        }
      }

      const externals = new Map();
      for (const [name, data] of template.externals) if (referenced.has(name)) externals.set(name, data);
      for (const [name, data] of newExternals) externals.set(name, data);

      return writeClip({
        head: template.head,
        externals,
        makeDatabase: (offsets) => {
          db.run("delete from ExternalChunk");
          for (const [name, offset] of offsets) {
            db.run("insert into ExternalChunk (ExternalID, Offset) values (?, ?)", [name, offset]);
          }
          return db.export();
        },
      });
    } finally {
      db.close();
    }
  }


  // ===========================================================================
  // Public API
  // ===========================================================================

  async function convert(SQL, asepriteBytes, templateBytes, options = {}) {
    const { sprite, warnings } = await readAseprite(asepriteBytes);
    const warn = (message) => { if (!warnings.includes(message)) warnings.push(message); };

    if (!sprite.frames.length) throw new Error("The Aseprite file has no frames.");

    const visibility = layerVisibility(sprite, warn);
    const images = sprite.frames.map((frame) => flattenFrame(sprite, frame, visibility));

    images.forEach((image, i) => {
      if (!image.some((value, j) => j % 4 === 3 && value)) warn(`Frame ${i + 1} is empty.`);
    });

    const timing = chooseTiming(sprite.frames.map((frame) => frame.durationMs || 100), options.fps, warn);
    const clip = await buildClip(SQL, templateBytes, images, sprite.width, sprite.height, timing);

    return {
      clip,
      frames: images,
      width: sprite.width,
      height: sprite.height,
      fps: timing.fps,
      holds: timing.holds,
      durationsMs: sprite.frames.map((frame) => frame.durationMs),
      warnings,
    };
  }

  return { convert };
});
