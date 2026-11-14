// clip2aseprite core: Clip Studio Paint (.clip) animation -> flattened .aseprite
// Port of clip2aseprite.py. Runs in browsers and Node 18+ (needs DecompressionStream,
// CompressionStream and an initialised sql.js `SQL` object).
(function (root) {
  "use strict";

  const TIME_UNITS_PER_FRAME = 5; // CSP timeline time units per frame
  const BLOCK = 256;              // CSP offscreen tile size
  const LAYER_FOLDER = 0, LAYER_RASTER = 1;
  const TRACK_KIND_CEL = 1000;

  // ------------------------------------------------------------------ helpers
  const utf16be = (s) => {
    const b = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) >> 8; b[2 * i + 1] = s.charCodeAt(i) & 255; }
    return b;
  };
  const latin1 = (b) => String.fromCharCode.apply(null, b);
  function indexOf(hay, needle, from = 0) {
    const n = needle.length, first = needle[0];
    outer: for (let i = hay.indexOf(first, from); i !== -1 && i <= hay.length - n; i = hay.indexOf(first, i + 1)) {
      for (let j = 1; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }
  const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u32le = (b, o) => ((b[o + 3] << 24) >>> 0) + (b[o + 2] << 16) + (b[o + 1] << 8) + b[o];
  const u64be = (b, o) => u32be(b, o) * 2 ** 32 + u32be(b, o + 4);

  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }
  const inflate = (b) => pipe(b, new DecompressionStream("deflate"));
  const deflate = (b) => pipe(b, new CompressionStream("deflate"));

  // numpy-compatible round half to even
  function roundHalfEven(x) {
    const r = Math.round(x);
    return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
  }

  // ------------------------------------------------------------------ .clip container
  function readContainer(d) {
    if (latin1(d.subarray(0, 8)) !== "CSFCHUNK") throw new Error("This is not a Clip Studio Paint (.clip) file.");
    let p = 24, sql = null;
    const ext = new Map();
    while (p + 16 <= d.length) {
      const name = latin1(d.subarray(p, p + 8));
      const len = u64be(d, p + 8);
      const body = d.subarray(p + 16, p + 16 + len);
      if (name === "CHNKExta") {
        const il = u64be(body, 0);
        ext.set(latin1(body.subarray(8, 8 + il)), body.subarray(8 + il));
      } else if (name === "CHNKSQLi") sql = body;
      p += 16 + len;
    }
    if (!sql) throw new Error("The .clip file has no layer database (is it damaged?).");
    return { sql, ext };
  }

  function query(db, sql, params) {
    const st = db.prepare(sql);
    if (params) st.bind(params);
    const rows = [];
    while (st.step()) rows.push(st.getAsObject());
    st.free();
    return rows;
  }

  // ------------------------------------------------------------------ pixels
  async function decodeOffscreen(attr, data) {
    const key = utf16be("Parameter");
    let i = indexOf(attr, key);
    if (i < 0) throw new Error("Unrecognised layer pixel format.");
    i += key.length;
    const width = u32be(attr, i), height = u32be(attr, i + 4), bw = u32be(attr, i + 8);
    const out = new Uint8Array(width * height * 4);
    const marker = utf16be("BlockDataBeginChunk");
    for (let m = indexOf(data, marker); m !== -1; m = indexOf(data, marker, m + 1)) {
      const p = m + marker.length;
      const idx = u32be(data, p), exists = u32be(data, p + 16);
      if (!exists) continue;
      const clen = u32le(data, p + 24);
      const raw = await inflate(data.subarray(p + 28, p + 28 + clen));
      if (raw.length !== BLOCK * BLOCK * 5) throw new Error("Only 32-bit colour layers are supported.");
      const bx = (idx % bw) * BLOCK, by = Math.floor(idx / bw) * BLOCK;
      for (let y = 0; y < BLOCK; y++) {
        const oy = by + y;
        if (oy >= height) break;
        for (let x = 0; x < BLOCK; x++) {
          const ox = bx + x;
          if (ox >= width) break;
          const s = y * BLOCK + x, c = BLOCK * BLOCK + s * 4, o = (oy * width + ox) * 4;
          out[o] = raw[c + 2]; out[o + 1] = raw[c + 1]; out[o + 2] = raw[c]; out[o + 3] = raw[s];
        }
      }
    }
    return { width, height, px: out };
  }

  // straight-alpha "over", Float64, same operation order as the Python/numpy version
  function blendNormal(dst, src, opacity) {
    for (let i = 0; i < dst.length; i += 4) {
      const sa = src[i + 3] * opacity, da = dst[i + 3];
      const oa = sa + da * (1 - sa);
      for (let k = 0; k < 3; k++) {
        dst[i + k] = oa > 0 ? (src[i + k] * sa + dst[i + k] * da * (1 - sa)) / oa : 0;
      }
      dst[i + 3] = oa;
    }
  }

  class Document {
    constructor(SQL, bytes) {
      const { sql, ext } = readContainer(bytes);
      this.ext = ext;
      this.db = new SQL.Database(sql);
      this.warnings = [];
      const cv = query(this.db, "select * from Canvas")[0];
      this.w = Math.round(cv.CanvasWidth); this.h = Math.round(cv.CanvasHeight);
      this.root = cv.CanvasRootFolder;
      this.layers = new Map(query(this.db, "select * from Layer").map((r) => [r.MainId, r]));
    }
    warn(msg) { if (!this.warnings.includes(msg)) this.warnings.push(msg); }
    close() { this.db.close(); }

    children(mid) { // bottom-most first
      const out = [];
      for (let c = this.layers.get(mid).LayerFirstChildIndex; c; c = this.layers.get(c).LayerNextIndex) out.push(c);
      return out;
    }

    async layerPixels(mid) {
      const l = this.layers.get(mid);
      const canvas = new Float64Array(this.w * this.h * 4);
      const r = query(this.db,
        "select o.Attribute a, cast(o.BlockData as text) b from Mipmap m " +
        "join MipmapInfo i on i.MainId = m.BaseMipmapInfo " +
        "join Offscreen o on o.MainId = i.Offscreen where m.MainId = ?", [l.LayerRenderMipmap])[0];
      if (!r || !this.ext.has(r.b)) return canvas;
      const off = await decodeOffscreen(r.a, this.ext.get(r.b));
      const ox = l.LayerOffsetX + l.LayerRenderOffscrOffsetX, oy = l.LayerOffsetY + l.LayerRenderOffscrOffsetY;
      const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
      const x1 = Math.min(this.w, ox + off.width), y1 = Math.min(this.h, oy + off.height);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const s = ((y - oy) * off.width + (x - ox)) * 4, d = (y * this.w + x) * 4;
        for (let k = 0; k < 4; k++) canvas[d + k] = off.px[s + k] / 255;
      }
      return canvas;
    }

    async render(mid) {
      const l = this.layers.get(mid);
      if (!l.LayerFolder) return this.layerPixels(mid);
      const acc = new Float64Array(this.w * this.h * 4);
      for (const c of this.children(mid)) {
        const cl = this.layers.get(c), name = cl.LayerName;
        if (!((cl.LayerVisibility || 0) & 1)) continue;
        if (cl.LayerType !== LAYER_FOLDER && cl.LayerType !== LAYER_RASTER) {
          this.warn(`Layer "${name}" is a special layer type (vector, tone, paper…) and was skipped.`); continue;
        }
        if (cl.LayerComposite) this.warn(`Layer "${name}" uses a blend mode; it was drawn as Normal.`);
        if (cl.LayerClip) this.warn(`Layer "${name}" is a clipping layer; clipping was ignored.`);
        if (cl.LayerLayerMaskMipmap) this.warn(`Layer "${name}" has a layer mask; the mask was ignored.`);
        blendNormal(acc, await this.render(c), (cl.LayerOpacity || 0) / 256);
      }
      return acc;
    }

    async timeline() {
      const tl = query(this.db, "select * from TimeLine order by MainId")[0];
      if (!tl) return null;
      const norm = (s) => String(s || "").toLowerCase().replace(/[^0-9a-f]/g, "");
      const byUuid = new Map([...this.layers].map(([k, r]) => [norm(r.LayerUuid), k]));
      const n = Math.round(tl.EndFrame - tl.StartFrame), start0 = Math.round(tl.StartFrame);
      const frames = new Array(n).fill(null);
      const tracks = query(this.db,
        "select MainId, hex(LayerUuidWithTrack) u, TrackKind k, cast(TrackActionMixer2 as text) m " +
        "from Track where BankId = ?", [tl.BankId]);
      for (const t of tracks) {
        if (t.k !== TRACK_KIND_CEL || !this.ext.has(t.m)) continue;
        const lid = byUuid.get(norm(t.u));
        if (lid === undefined) { this.warn(`A timeline track refers to a missing layer.`); continue; }
        const [s, e] = await parseTimeClip(this.ext.get(t.m));
        for (let f = Math.round(s / TIME_UNITS_PER_FRAME); f < Math.round(e / TIME_UNITS_PER_FRAME); f++) {
          const i = f - start0;
          if (i < 0 || i >= n) continue;
          if (frames[i] !== null) this.warn(`Frame ${i + 1} is used by two cels; the later one was kept.`);
          frames[i] = lid;
        }
      }
      return { fps: tl.FrameRate, frames };
    }
  }

  async function parseTimeClip(blob) {
    const zlen = u32le(blob, 8);
    const z = await inflate(blob.subarray(12, 12 + zlen));
    if (latin1(z.subarray(0, 12)) !== "cmt 0110binc") throw new Error("Unrecognised timeline format.");
    const count = u32le(z, 16);
    const names = [];
    let p = 20;
    for (let i = 0; i < count; i++) { const n = z[p]; names.push(latin1(z.subarray(p + 1, p + 1 + n))); p += 1 + n; }
    const value = (field) => {
      const hdr = new Uint8Array(20), dv = new DataView(hdr.buffer);
      [0x10, 0x1c, 0x20, names.indexOf(field), names.indexOf("Double")].forEach((v, i) => dv.setUint32(i * 4, v));
      const k = indexOf(z, hdr, p);
      if (k < 0) throw new Error(`Timeline field ${field} not found.`);
      return new DataView(z.buffer, z.byteOffset + k + 23, 8).getFloat64(0, true);
    };
    return [value("Start"), value("End")];
  }

  // ------------------------------------------------------------------ .aseprite writer
  class Buf {
    constructor() { this.parts = []; this.len = 0; }
    bytes(b) { this.parts.push(b); this.len += b.length; return this; }
    fmt(spec, ...vals) { // little-endian: B=u8 H=u16 h=i16 I=u32 x=pad byte
      const size = { B: 1, H: 2, h: 2, I: 4, x: 1 };
      const b = new Uint8Array([...spec].reduce((a, c) => a + size[c], 0)), dv = new DataView(b.buffer);
      let o = 0, v = 0;
      for (const c of spec) {
        if (c === "B") dv.setUint8(o, vals[v++]); else if (c === "H") dv.setUint16(o, vals[v++], true);
        else if (c === "h") dv.setInt16(o, vals[v++], true); else if (c === "I") dv.setUint32(o, vals[v++], true);
        o += size[c];
      }
      return this.bytes(b);
    }
    concat() { const out = new Uint8Array(this.len); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
  }
  const chunk = (type, body) => new Buf().fmt("IH", body.length + 6, type).bytes(body).concat();

  async function writeAseprite(frames, w, h, durationMs, layerName) {
    const seen = new Map();
    for (const f of frames) for (let i = 0; i < f.length; i += 4) {
      if (!f[i + 3]) continue;
      const key = ((f[i] << 24) >>> 0) + (f[i + 1] << 16) + (f[i + 2] << 8) + f[i + 3];
      seen.set(key, true);
    }
    let colors = [...seen.keys()].sort((a, b) => a - b).slice(0, 256);
    if (!colors.length) colors = [255];
    const pal = new Buf().fmt("IIIxxxxxxxx", colors.length, 0, colors.length - 1);
    for (const c of colors) pal.fmt("HBBBB", 0, c >>> 24, (c >> 16) & 255, (c >> 8) & 255, c & 255);
    const profile = new Buf().fmt("HHIxxxxxxxx", 1, 0, 0).concat();
    const nm = new TextEncoder().encode(layerName);
    const layer = new Buf().fmt("HHHHHHBxxxH", 3, 0, 0, 0, 0, 0, 255, nm.length).bytes(nm).concat();

    const body = new Buf();
    for (let fi = 0; fi < frames.length; fi++) {
      const img = frames[fi], chunks = [];
      if (fi === 0) chunks.push(chunk(0x2007, profile), chunk(0x2019, pal.concat()), chunk(0x2004, layer));
      let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (img[(y * w + x) * 4 + 3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      if (x1 >= 0) {
        const cw = x1 - x0 + 1, ch = y1 - y0 + 1, px = new Uint8Array(cw * ch * 4);
        for (let y = 0; y < ch; y++) px.set(img.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
        const cel = new Buf().fmt("HhhBHhxxxxxHH", 0, x0, y0, 255, 2, 0, cw, ch).bytes(await deflate(px)).concat();
        chunks.push(chunk(0x2005, cel));
      }
      const len = chunks.reduce((a, c) => a + c.length, 0);
      body.fmt("IHHHxxI", 16 + len, 0xF1FA, Math.min(chunks.length, 0xFFFF), durationMs, chunks.length);
      chunks.forEach((c) => body.bytes(c));
    }
    const header = new Buf().fmt("IHHHHHIHIIBxxxHBBhhHH", 128 + body.len, 0xA5E0, frames.length, w, h, 32, 1,
      durationMs, 0, 0, 0, colors.length, 1, 1, 0, 0, 16, 16).concat();
    const head = new Uint8Array(128); head.set(header);
    return new Buf().bytes(head).bytes(body.concat()).concat();
  }

  // ------------------------------------------------------------------ public API
  async function convert(SQL, bytes, opts = {}) {
    const doc = new Document(SQL, bytes);
    try {
      const tl = await doc.timeline();
      let fps, cels;
      if (!tl || !tl.frames.some((f) => f !== null)) {
        doc.warn("No animation timeline found, so the whole canvas was exported as one frame.");
        fps = 12; cels = [doc.root];
      } else ({ fps, frames: cels } = tl);
      if (opts.fps) fps = opts.fps;
      cels.forEach((c, i) => { if (c === null) doc.warn(`Frame ${i + 1} is empty on the timeline.`); });
      const frames = [];
      for (const c of cels) {
        const px = new Uint8Array(doc.w * doc.h * 4);
        if (c !== null) {
          const f = await doc.render(c);
          for (let i = 0; i < f.length; i += 4) {
            const a = roundHalfEven(Math.min(1, Math.max(0, f[i + 3])) * 255);
            if (!a) continue;
            for (let k = 0; k < 3; k++) px[i + k] = roundHalfEven(Math.min(1, Math.max(0, f[i + k])) * 255);
            px[i + 3] = a;
          }
        }
        frames.push(px);
      }
      const durationMs = Math.max(1, Math.round(1000 / fps));
      const aseprite = await writeAseprite(frames, doc.w, doc.h, durationMs, opts.layerName || "Sprite Sheet");
      return {
        aseprite, frames, width: doc.w, height: doc.h, fps, durationMs, warnings: doc.warnings,
        frameNames: cels.map((c) => (c === null ? "(empty)" : doc.layers.get(c).LayerName)),
      };
    } finally { doc.close(); }
  }

  const api = { convert };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Clip2Ase = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
