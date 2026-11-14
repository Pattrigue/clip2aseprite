// Shared helpers for reading and writing Clip Studio Paint (.clip) files.
//
// Used by clip-to-aseprite.js and aseprite-to-clip.js. Runs in browsers and Node 18+.
// Browser: exposes `ClipShared`. Node: module.exports.

(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.ClipShared = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Layer pixels are stored as square tiles of this size.
  const TILE_SIZE = 256;


  // ===========================================================================
  // Bytes
  // ===========================================================================

  function utf16be(text) {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      bytes[2 * i] = text.charCodeAt(i) >> 8;
      bytes[2 * i + 1] = text.charCodeAt(i) & 255;
    }
    return bytes;
  }

  function latin1(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return text;
  }

  function ascii(text) {
    return Uint8Array.from(text, (ch) => ch.charCodeAt(0));
  }

  // Position of `needle` in `haystack` at or after `from`, or -1.
  function findBytes(haystack, needle, from = 0) {
    let i = haystack.indexOf(needle[0], from);

    while (i !== -1 && i <= haystack.length - needle.length) {
      let matches = true;
      for (let j = 1; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return i;

      i = haystack.indexOf(needle[0], i + 1);
    }

    return -1;
  }

  function view(bytes, pos, size) {
    return new DataView(bytes.buffer, bytes.byteOffset + pos, size);
  }

  const readU32BE = (bytes, pos) => view(bytes, pos, 4).getUint32(0, false);
  const readU32LE = (bytes, pos) => view(bytes, pos, 4).getUint32(0, true);
  const readU64BE = (bytes, pos) => readU32BE(bytes, pos) * 2 ** 32 + readU32BE(bytes, pos + 4);

  function concatBytes(parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let pos = 0;
    for (const part of parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }

  // Builds a byte array piece by piece. Little-endian unless the method name says BE.
  class ByteWriter {
    constructor() {
      this.parts = [];
      this.length = 0;
    }

    bytes(data) {
      this.parts.push(data);
      this.length += data.length;
      return this;
    }

    number(size, setter, value, littleEndian) {
      const data = new Uint8Array(size);
      new DataView(data.buffer)[setter](0, value, littleEndian);
      return this.bytes(data);
    }

    u8(value) { return this.number(1, "setUint8", value, true); }
    u16(value) { return this.number(2, "setUint16", value, true); }
    i16(value) { return this.number(2, "setInt16", value, true); }
    u32(value) { return this.number(4, "setUint32", value, true); }
    u32be(value) { return this.number(4, "setUint32", value, false); }
    u64be(value) { return this.u32be(Math.floor(value / 2 ** 32)).u32be(value % 2 ** 32); }
    zeros(count) { return this.bytes(new Uint8Array(count)); }

    toBytes() { return concatBytes(this.parts); }
  }


  // ===========================================================================
  // Compression and checksums
  // ===========================================================================

  async function runThroughStream(bytes, stream) {
    const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
  }

  // "deflate" in the Streams API means zlib format, which is what both file formats use.
  function zlibDecompress(bytes) {
    return runThroughStream(bytes, new DecompressionStream("deflate"));
  }

  function zlibCompress(bytes) {
    return runThroughStream(bytes, new CompressionStream("deflate"));
  }

  function adler32(bytes) {
    let a = 1, b = 0;
    for (let i = 0; i < bytes.length; i += 5552) {
      const end = Math.min(i + 5552, bytes.length);
      for (let j = i; j < end; j++) {
        a += bytes[j];
        b += a;
      }
      a %= 65521;
      b %= 65521;
    }
    return ((b << 16) | a) >>> 0;
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Round half to even (banker's rounding) for 0..1 -> 0..255.
  function roundHalfEven(x) {
    const rounded = Math.round(x);
    const isHalf = Math.abs(x % 1) === 0.5;
    return isHalf && rounded % 2 !== 0 ? rounded - 1 : rounded;
  }

  function randomBytes(count) {
    return crypto.getRandomValues(new Uint8Array(count));
  }

  function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }


  // ===========================================================================
  // Images
  // ===========================================================================

  // Draw `above` over `below` in place (Float64 RGBA in 0..1, straight alpha).
  function blendNormal(below, above, opacity) {
    for (let i = 0; i < below.length; i += 4) {
      const aboveAlpha = above[i + 3] * opacity;
      const belowAlpha = below[i + 3];
      const outAlpha = aboveAlpha + belowAlpha * (1 - aboveAlpha);

      for (let c = 0; c < 3; c++) {
        below[i + c] = outAlpha > 0
          ? (above[i + c] * aboveAlpha + below[i + c] * belowAlpha * (1 - aboveAlpha)) / outAlpha
          : 0;
      }

      below[i + 3] = outAlpha;
    }
  }

  // Float 0..1 RGBA -> 8-bit RGBA; fully transparent pixels become (0, 0, 0, 0).
  function toUint8(image) {
    const out = new Uint8Array(image.length);
    const to255 = (v) => roundHalfEven(Math.min(1, Math.max(0, v)) * 255);

    for (let i = 0; i < image.length; i += 4) {
      const alpha = to255(image[i + 3]);
      if (!alpha) continue;

      out[i] = to255(image[i]);
      out[i + 1] = to255(image[i + 1]);
      out[i + 2] = to255(image[i + 2]);
      out[i + 3] = alpha;
    }

    return out;
  }

  // Minimal PNG encoder (8-bit RGBA, no filtering), used for CSP's file preview.
  async function encodePng(rgba, width, height) {
    const rows = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      rows.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
    }

    const chunk = (type, data) => {
      const typed = concatBytes([ascii(type), data]);
      return new ByteWriter().u32be(data.length).bytes(typed).u32be(crc32(typed)).toBytes();
    };

    const header = new ByteWriter().u32be(width).u32be(height)
      .u8(8)   // bit depth
      .u8(6)   // colour type: RGBA
      .u8(0).u8(0).u8(0)
      .toBytes();

    return concatBytes([
      Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      chunk("IHDR", header),
      chunk("IDAT", await zlibCompress(rows)),
      chunk("IEND", new Uint8Array(0)),
    ]);
  }


  // ===========================================================================
  // SQLite (sql.js)
  // ===========================================================================

  function sqlQuery(db, sql, params) {
    const statement = db.prepare(sql);
    if (params) statement.bind(params);

    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());

    statement.free();
    return rows;
  }

  function sqlInsert(db, table, row) {
    const columns = Object.keys(row);
    const sql = `insert into ${table} (${columns.join(", ")}) values (${columns.map(() => "?").join(", ")})`;
    db.run(sql, columns.map((column) => row[column]));
  }


  // ===========================================================================
  // The .clip container
  // ===========================================================================
  //
  // A .clip file is a "CSFCHUNK" header followed by chunks. Each chunk is an
  // 8-byte name, an 8-byte big-endian length and then the data:
  //
  //   CHNKHead   file header (holds the position of the CHNKSQLi chunk)
  //   CHNKExta   "external" data blob (pixels, timeline keys), named "extrnlid..."
  //   CHNKSQLi   a SQLite database describing the document
  //   CHNKFoot   end marker
  //
  // Database rows refer to external blobs by their name, and the ExternalChunk
  // table records where each blob's chunk starts in the file.

  function readClip(data) {
    if (latin1(data.subarray(0, 8)) !== "CSFCHUNK") {
      throw new Error("This is not a Clip Studio Paint (.clip) file.");
    }

    const externals = new Map();
    let database = null;
    let head = null;

    let pos = 24; // skip the file header
    while (pos + 16 <= data.length) {
      const chunkName = latin1(data.subarray(pos, pos + 8));
      const chunkLength = readU64BE(data, pos + 8);
      const body = data.subarray(pos + 16, pos + 16 + chunkLength);

      if (chunkName === "CHNKExta") {
        const nameLength = readU64BE(body, 0);
        const name = latin1(body.subarray(8, 8 + nameLength));
        externals.set(name, body.subarray(8 + nameLength));
      } else if (chunkName === "CHNKSQLi") {
        database = body;
      } else if (chunkName === "CHNKHead") {
        head = body;
      }

      pos += 16 + chunkLength;
    }

    if (!database) {
      throw new Error("The .clip file has no layer database (is it damaged?).");
    }

    return { database, externals, head };
  }

  // Assemble a .clip file. `externals` is a Map of blob name -> data, `makeDatabase`
  // receives the file offset of every blob's chunk and returns the SQLite bytes.
  function writeClip({ head, externals, makeDatabase }) {
    const chunk = (name, body) => new ByteWriter().bytes(ascii(name)).u64be(body.length).bytes(body).toBytes();

    // CHNKHead: u64 0x100, u64 position of CHNKSQLi, u64 0x10, 16-byte document id
    const headChunkLength = 16 + head.length;
    let pos = 24 + headChunkLength;

    const externalChunks = [];
    const offsets = new Map();
    for (const [name, data] of externals) {
      const body = new ByteWriter().u64be(name.length).bytes(ascii(name)).bytes(data).toBytes();
      offsets.set(name, pos);
      externalChunks.push(chunk("CHNKExta", body));
      pos += 16 + body.length;
    }

    const databaseOffset = pos;
    const database = makeDatabase(offsets);

    const newHead = new Uint8Array(head);
    view(newHead, 8, 8).setUint32(0, Math.floor(databaseOffset / 2 ** 32), false);
    view(newHead, 12, 4).setUint32(0, databaseOffset % 2 ** 32, false);
    newHead.set(randomBytes(16), 24); // fresh document id

    const body = concatBytes([
      chunk("CHNKHead", newHead),
      ...externalChunks,
      chunk("CHNKSQLi", database),
      chunk("CHNKFoot", new Uint8Array(0)),
    ]);

    const header = new ByteWriter().bytes(ascii("CSFCHUNK")).u64be(24 + body.length).u64be(24).toBytes();
    return concatBytes([header, body]);
  }

  function newExternalId() {
    return "extrnlid" + hex(randomBytes(16)).toUpperCase();
  }


  // ===========================================================================
  // Layer pixels ("offscreens")
  // ===========================================================================
  //
  // A layer's pixels are split into 256x256 tiles. The offscreen's Attribute
  // blob holds its size, the number of tiles across/down and the stored size
  // of each tile record ("BlockSize"). The pixel blob is:
  //
  //   u64 length of the rest
  //   one record per tile:
  //     u32 record size, u32 19, "BlockDataBeginChunk" (UTF-16BE),
  //     u32 tile index, u32 0x50000, u32 256, u32 256, u32 has_data,
  //     [if has_data: u32 BE compressed length + 4, u32 LE compressed length, zlib data]
  //     u32 17, "BlockDataEndChunk"
  //   u32 11, "BlockStatus", u32 12, u32 tile count, u32 4, u32 1 per tile
  //   u32 13, "BlockCheckSum", u32 12, u32 tile count, u32 4, u32 checksum per tile
  //
  // Decompressed, a tile is a 256x256 alpha plane followed by 256x256 BGRA
  // pixels (the A of BGRA is unused). A tile's checksum is the Adler-32 of its
  // LE length field + zlib data (0 for empty tiles).

  const TILE_BYTES = TILE_SIZE * TILE_SIZE * 5;

  function parseOffscreenAttribute(attribute) {
    const parameter = utf16be("Parameter");
    const paramPos = findBytes(attribute, parameter);
    if (paramPos < 0) throw new Error("Unrecognised layer pixel format.");

    const sizePos = paramPos + parameter.length;
    return {
      width: readU32BE(attribute, sizePos),
      height: readU32BE(attribute, sizePos + 4),
      tilesAcross: readU32BE(attribute, sizePos + 8),
      tilesDown: readU32BE(attribute, sizePos + 12),
      sizePos,
    };
  }

  // Copy an offscreen Attribute with a new size and new tile record sizes.
  function updateOffscreenAttribute(attribute, width, height, tilesAcross, tilesDown, recordSizes) {
    const { sizePos } = parseOffscreenAttribute(attribute);

    const blockSize = utf16be("BlockSize");
    const blockSizePos = findBytes(attribute, blockSize);
    if (blockSizePos < 0) throw new Error("Unrecognised layer pixel format.");

    const before = new Uint8Array(attribute.subarray(0, blockSizePos - 4));
    const sizes = new DataView(before.buffer, before.byteOffset + sizePos, 16);
    sizes.setUint32(0, width, false);
    sizes.setUint32(4, height, false);
    sizes.setUint32(8, tilesAcross, false);
    sizes.setUint32(12, tilesDown, false);

    const section = new ByteWriter()
      .u32be(blockSize.length / 2).bytes(blockSize)
      .u32be(12).u32be(recordSizes.length).u32be(4);
    recordSizes.forEach((size) => section.u32be(size));
    const sectionBytes = section.toBytes();

    // The 4th header word is the size of the BlockSize section.
    view(before, 12, 4).setUint32(0, sectionBytes.length, false);

    return concatBytes([before, sectionBytes]);
  }

  async function decodeOffscreen(attribute, data) {
    const { width, height, tilesAcross } = parseOffscreenAttribute(attribute);
    const pixels = new Uint8Array(width * height * 4);

    const marker = utf16be("BlockDataBeginChunk");
    for (let found = findBytes(data, marker); found !== -1; found = findBytes(data, marker, found + 1)) {
      const pos = found + marker.length;

      const tileIndex = readU32BE(data, pos);
      const hasData = readU32BE(data, pos + 16);
      if (!hasData) continue;

      const compressedLength = readU32LE(data, pos + 24);
      const raw = await zlibDecompress(data.subarray(pos + 28, pos + 28 + compressedLength));

      if (raw.length !== TILE_BYTES) {
        throw new Error("Only 32-bit colour layers are supported.");
      }

      const tileLeft = (tileIndex % tilesAcross) * TILE_SIZE;
      const tileTop = Math.floor(tileIndex / tilesAcross) * TILE_SIZE;

      for (let y = 0; y < TILE_SIZE && tileTop + y < height; y++) {
        for (let x = 0; x < TILE_SIZE && tileLeft + x < width; x++) {
          const tilePixel = y * TILE_SIZE + x;
          const src = TILE_SIZE * TILE_SIZE + tilePixel * 4;
          const dst = ((tileTop + y) * width + (tileLeft + x)) * 4;

          pixels[dst] = raw[src + 2];     // R
          pixels[dst + 1] = raw[src + 1]; // G
          pixels[dst + 2] = raw[src];     // B
          pixels[dst + 3] = raw[tilePixel];
        }
      }
    }

    return { width, height, pixels };
  }

  // Encode an RGBA image (or null for all-empty) as an offscreen pixel blob.
  // Returns { data, tilesAcross, tilesDown, recordSizes }.
  async function encodeOffscreen(rgba, width, height) {
    const tilesAcross = Math.ceil(width / TILE_SIZE);
    const tilesDown = Math.ceil(height / TILE_SIZE);
    const tileCount = tilesAcross * tilesDown;

    const beginName = utf16be("BlockDataBeginChunk");
    const endName = utf16be("BlockDataEndChunk");

    const records = [];
    const checksums = [];

    for (let index = 0; index < tileCount; index++) {
      const tileLeft = (index % tilesAcross) * TILE_SIZE;
      const tileTop = Math.floor(index / tilesAcross) * TILE_SIZE;

      // Fill the tile: alpha plane, then BGRA
      let raw = null;
      if (rgba) {
        const tile = new Uint8Array(TILE_BYTES);
        let hasPixels = false;

        for (let y = 0; y < TILE_SIZE && tileTop + y < height; y++) {
          for (let x = 0; x < TILE_SIZE && tileLeft + x < width; x++) {
            const src = ((tileTop + y) * width + (tileLeft + x)) * 4;
            const alpha = rgba[src + 3];
            if (!alpha) continue;

            const tilePixel = y * TILE_SIZE + x;
            const dst = TILE_SIZE * TILE_SIZE + tilePixel * 4;
            tile[tilePixel] = alpha;
            tile[dst] = rgba[src + 2];     // B
            tile[dst + 1] = rgba[src + 1]; // G
            tile[dst + 2] = rgba[src];     // R
            hasPixels = true;
          }
        }

        if (hasPixels) raw = tile;
      }

      const record = new ByteWriter()
        .u32be(beginName.length / 2).bytes(beginName)
        .u32be(index).u32be(TILE_BYTES).u32be(TILE_SIZE).u32be(TILE_SIZE)
        .u32be(raw ? 1 : 0);

      if (raw) {
        const compressed = await zlibCompress(raw);
        const lengthField = new ByteWriter().u32(compressed.length).toBytes();
        record.u32be(compressed.length + 4).bytes(lengthField).bytes(compressed);
        checksums.push(adler32(concatBytes([lengthField, compressed])));
      } else {
        checksums.push(0);
      }

      record.u32be(endName.length / 2).bytes(endName);
      records.push(new ByteWriter().u32be(record.length + 4).bytes(record.toBytes()).toBytes());
    }

    const listSection = (name, values) => {
      const nameBytes = utf16be(name);
      const section = new ByteWriter().u32be(nameBytes.length / 2).bytes(nameBytes)
        .u32be(12).u32be(values.length).u32be(4);
      values.forEach((value) => section.u32be(value));
      return section.toBytes();
    };

    const rest = concatBytes([
      ...records,
      listSection("BlockStatus", records.map(() => 1)),
      listSection("BlockCheckSum", checksums),
    ]);

    return {
      data: new ByteWriter().u64be(rest.length).bytes(rest).toBytes(),
      tilesAcross,
      tilesDown,
      recordSizes: records.map((record) => record.length),
    };
  }


  // ===========================================================================
  // Timeline key data ("binc")
  // ===========================================================================
  //
  // A track's key data is an external blob: u64 length of the rest, u32 LE
  // compressed length, zlib data. Decompressed, it starts with "cmt 0110binc",
  // a CRC32 of everything after byte 16, and a table of names (field and type
  // names) followed by records. A Double field is stored as:
  //
  //   u32 field name index, u32 type name index ("Double"), 3 bytes, f64 LE value
  //
  // Times are measured in timeline units; `Rate` is the number of units per
  // second, so units per frame = Rate / frame rate (5 at 12 fps).

  async function decodeBinc(blob) {
    const compressedLength = readU32LE(blob, 8);
    const data = await zlibDecompress(blob.subarray(12, 12 + compressedLength));

    // Seen versions: "cmt 0100binc" (TrackActionMixer) and "cmt 0110binc" (TrackActionMixer2)
    if (!/^cmt 01\d0binc$/.test(latin1(data.subarray(0, 12)))) {
      throw new Error("Unrecognised timeline format.");
    }

    // Name table: u32 count, then length-prefixed strings
    const nameCount = readU32LE(data, 16);
    const names = [];
    let pos = 20;
    for (let i = 0; i < nameCount; i++) {
      const length = data[pos];
      names.push(latin1(data.subarray(pos + 1, pos + 1 + length)));
      pos += 1 + length;
    }

    return { data, names, recordsStart: pos };
  }

  // Positions of the f64 values of every `field` stored as a Double.
  function findDoubles(binc, field) {
    const { data, names, recordsStart } = binc;
    const fieldIndex = names.indexOf(field);
    const typeIndex = names.indexOf("Double");
    if (fieldIndex < 0 || typeIndex < 0) return [];

    const header = new ByteWriter().u32be(fieldIndex).u32be(typeIndex).toBytes();
    const positions = [];
    for (let k = findBytes(data, header, recordsStart); k !== -1; k = findBytes(data, header, k + 1)) {
      positions.push(k + header.length + 3);
    }
    return positions;
  }

  function readDouble(data, pos) {
    return view(data, pos, 8).getFloat64(0, true);
  }

  function writeDouble(data, pos, value) {
    view(data, pos, 8).setFloat64(0, value, true);
  }

  async function encodeBinc(data) {
    const updated = new Uint8Array(data);
    view(updated, 12, 4).setUint32(0, crc32(updated.subarray(16)), true);

    const compressed = await zlibCompress(updated);
    const rest = new ByteWriter().u32(compressed.length).bytes(compressed).toBytes();
    return new ByteWriter().u64be(rest.length).bytes(rest).toBytes();
  }


  return {
    TILE_SIZE,
    utf16be, latin1, ascii, findBytes, readU32BE, readU32LE, readU64BE, concatBytes, ByteWriter,
    zlibDecompress, zlibCompress, adler32, crc32, roundHalfEven, randomBytes, hex,
    blendNormal, toUint8, encodePng,
    sqlQuery, sqlInsert,
    readClip, writeClip, newExternalId,
    parseOffscreenAttribute, updateOffscreenAttribute, decodeOffscreen, encodeOffscreen,
    decodeBinc, findDoubles, readDouble, writeDouble, encodeBinc,
  };
});
