#!/usr/bin/env python3
"""Convert a Clip Studio Paint animation (.clip) into a flattened .aseprite file.

Each CSP animation cel (a folder or layer on the animation timeline) is composited
into one frame of a single-layer RGBA Aseprite sprite. Frame order and timing come
from the CSP timeline; frame duration comes from the timeline frame rate unless
--fps is given.

Usage:
    python3 clip2aseprite.py input.clip [output.aseprite] [--fps N] [--layer-name NAME]

Requires: numpy
"""
import argparse
import re
import sqlite3
import struct
import sys
import zlib
from pathlib import Path

import numpy as np

TIME_UNITS_PER_FRAME = 5  # CSP timeline stores time in 1/5-frame units (12 frames -> 60)
BLOCK = 256               # CSP offscreen tile size

LAYER_FOLDER, LAYER_RASTER, LAYER_ROOT = 0, 1, 256
TRACK_KIND_CEL = 1000     # timeline track that shows/hides an animation cel


def warn(msg):
    print(f"warning: {msg}", file=sys.stderr)


# --------------------------------------------------------------------------- .clip container

def read_clip(path):
    """Return (sqlite connection, {external_id: bytes})."""
    d = Path(path).read_bytes()
    if d[:8] != b"CSFCHUNK":
        raise ValueError(f"{path}: not a CLIP STUDIO file")
    p, externals, sql = 24, {}, None
    while p + 16 <= len(d):
        name = d[p:p + 8]
        ln = struct.unpack(">Q", d[p + 8:p + 16])[0]
        body = d[p + 16:p + 16 + ln]
        if name == b"CHNKExta":
            il = struct.unpack(">Q", body[:8])[0]
            externals[body[8:8 + il].decode("ascii")] = body[8 + il:]
        elif name == b"CHNKSQLi":
            sql = body
        p += 16 + ln
    if sql is None:
        raise ValueError(f"{path}: no SQLite chunk found")
    db = sqlite3.connect(":memory:")
    db.deserialize(sql)
    db.row_factory = sqlite3.Row
    return db, externals


# --------------------------------------------------------------------------- pixels

def decode_offscreen(attribute, data):
    """Decode a raster offscreen into an RGBA uint8 array (straight alpha)."""
    i = attribute.find("Parameter".encode("utf-16-be"))
    if i < 0:
        raise ValueError("offscreen attribute without Parameter block")
    i += len("Parameter".encode("utf-16-be"))
    width, height, bw, bh = struct.unpack(">IIII", attribute[i:i + 16])
    img = np.zeros((bh * BLOCK, bw * BLOCK, 4), np.uint8)
    marker = "BlockDataBeginChunk".encode("utf-16-be")
    for m in re.finditer(re.escape(marker), data):
        p = m.end()
        idx, _usize, _w, _h, exists = struct.unpack(">5I", data[p:p + 20])
        if not exists:
            continue
        clen = struct.unpack("<I", data[p + 24:p + 28])[0]
        raw = zlib.decompress(data[p + 28:p + 28 + clen])
        if len(raw) != BLOCK * BLOCK * 5:
            raise ValueError(f"unexpected block size {len(raw)} (only 32-bit color layers are supported)")
        alpha = np.frombuffer(raw[:BLOCK * BLOCK], np.uint8).reshape(BLOCK, BLOCK)
        bgra = np.frombuffer(raw[BLOCK * BLOCK:], np.uint8).reshape(BLOCK, BLOCK, 4)
        by, bx = divmod(idx, bw)
        img[by * BLOCK:(by + 1) * BLOCK, bx * BLOCK:(bx + 1) * BLOCK] = np.dstack(
            [bgra[..., 2], bgra[..., 1], bgra[..., 0], alpha])
    return img[:height, :width]


def blend_normal(dst, src, opacity):
    """Straight-alpha 'over' in float [0,1]."""
    sa = src[..., 3:4] * opacity
    da = dst[..., 3:4]
    oa = sa + da * (1 - sa)
    with np.errstate(invalid="ignore", divide="ignore"):
        rgb = np.where(oa > 0, (src[..., :3] * sa + dst[..., :3] * da * (1 - sa)) / oa, 0)
    return np.concatenate([rgb, oa], -1)


class Document:
    def __init__(self, path):
        self.db, self.ext = read_clip(path)
        cv = self.db.execute("select * from Canvas").fetchone()
        self.w, self.h = int(cv["CanvasWidth"]), int(cv["CanvasHeight"])
        self.root = cv["CanvasRootFolder"]
        self.layers = {r["MainId"]: r for r in self.db.execute("select * from Layer")}

    def children(self, mid):
        """Children of a folder, bottom-most first (CSP links first child = bottom)."""
        out, c = [], self.layers[mid]["LayerFirstChildIndex"]
        while c:
            out.append(c)
            c = self.layers[c]["LayerNextIndex"]
        return out

    def layer_pixels(self, mid):
        l = self.layers[mid]
        r = self.db.execute(
            "select o.Attribute, cast(o.BlockData as text) from Mipmap m "
            "join MipmapInfo i on i.MainId = m.BaseMipmapInfo "
            "join Offscreen o on o.MainId = i.Offscreen where m.MainId = ?",
            (l["LayerRenderMipmap"],)).fetchone()
        canvas = np.zeros((self.h, self.w, 4))
        if r is None:
            return canvas
        off = decode_offscreen(r[0], self.ext[r[1]]).astype(np.float64) / 255.0
        ox = l["LayerOffsetX"] + l["LayerRenderOffscrOffsetX"]
        oy = l["LayerOffsetY"] + l["LayerRenderOffscrOffsetY"]
        oh, ow = off.shape[:2]
        x0, y0 = max(0, ox), max(0, oy)
        x1, y1 = min(self.w, ox + ow), min(self.h, oy + oh)
        if x1 > x0 and y1 > y0:
            canvas[y0:y1, x0:x1] = off[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
        return canvas

    def render(self, mid):
        """Composite a layer or folder to a float RGBA canvas."""
        l = self.layers[mid]
        if not l["LayerFolder"]:
            return self.layer_pixels(mid)
        acc = np.zeros((self.h, self.w, 4))
        for c in self.children(mid):
            cl = self.layers[c]
            name = cl["LayerName"]
            if not (cl["LayerVisibility"] or 0) & 1:
                continue
            if cl["LayerType"] not in (LAYER_FOLDER, LAYER_RASTER):
                warn(f"layer '{name}' has unsupported type {cl['LayerType']}; skipped")
                continue
            if cl["LayerComposite"]:
                warn(f"layer '{name}' uses blend mode {cl['LayerComposite']}; rendered as Normal")
            if cl["LayerClip"]:
                warn(f"layer '{name}' is a clipping layer; clipping ignored")
            if cl["LayerLayerMaskMipmap"]:
                warn(f"layer '{name}' has a layer mask; mask ignored")
            acc = blend_normal(acc, self.render(c), (cl["LayerOpacity"] or 0) / 256.0)
        return acc

    # ----------------------------------------------------------------------- timeline

    def _layer_by_uuid(self):
        def norm(s):
            return "".join(ch for ch in (s or "").lower() if ch in "0123456789abcdef")
        return {norm(r["LayerUuid"]): k for k, r in self.layers.items()}, norm

    def timeline(self):
        """Return (fps, [layer_id or None per frame]) or None if the file has no animation."""
        tl = self.db.execute("select * from TimeLine order by MainId").fetchone()
        if tl is None:
            return None
        fps = tl["FrameRate"]
        nframes = round(tl["EndFrame"] - tl["StartFrame"])
        start_frame = round(tl["StartFrame"])
        by_uuid, norm = self._layer_by_uuid()
        frames = [None] * nframes
        for t in self.db.execute(
                "select MainId, hex(LayerUuidWithTrack) u, TrackKind, "
                "cast(TrackActionMixer2 as text) m from Track where BankId = ?", (tl["BankId"],)):
            if t["TrackKind"] != TRACK_KIND_CEL or t["m"] not in self.ext:
                continue
            lid = by_uuid.get(norm(t["u"]))
            if lid is None:
                warn(f"track {t['MainId']} refers to an unknown layer")
                continue
            start, end = parse_timeclip(self.ext[t["m"]])
            for f in range(round(start / TIME_UNITS_PER_FRAME), round(end / TIME_UNITS_PER_FRAME)):
                i = f - start_frame
                if not 0 <= i < nframes:
                    continue
                if frames[i] is not None:
                    warn(f"frame {i} claimed by both '{self.layers[frames[i]]['LayerName']}' "
                         f"and '{self.layers[lid]['LayerName']}'")
                frames[i] = lid
        return fps, frames


def parse_timeclip(blob):
    """Extract the first TimeClip Start/End from a track's ActionMixer2 'binc' stream."""
    z = zlib.decompress(blob[12:])
    if z[:12] != b"cmt 0110binc":
        raise ValueError("unknown track data format")
    count = struct.unpack("<I", z[16:20])[0]
    p, names = 20, []
    for _ in range(count):
        n = z[p]
        names.append(z[p + 1:p + 1 + n].decode("latin-1"))
        p += 1 + n

    def value(field):
        # record: [u32 0x10][u32 0x1c][u32 0x20][u32 name index][u32 type=Double] payload
        hdr = struct.pack(">IIIII", 0x10, 0x1C, 0x20, names.index(field), names.index("Double"))
        k = z.find(hdr, p)
        if k < 0:
            raise ValueError(f"TimeClip field '{field}' not found")
        q = k + len(hdr) + 3
        return struct.unpack("<d", z[q:q + 8])[0]

    return value("Start"), value("End")


# --------------------------------------------------------------------------- .aseprite writer

def _chunk(ctype, body):
    return struct.pack("<IH", len(body) + 6, ctype) + body


def write_aseprite(path, frames, w, h, duration_ms, layer_name):
    colors = np.unique(np.vstack([f.reshape(-1, 4) for f in frames]), axis=0)
    colors = [tuple(int(v) for v in c) for c in colors if c[3] > 0]
    if len(colors) > 256:
        colors = colors[:256]  # palette is informational in RGBA mode
    if not colors:
        colors = [(0, 0, 0, 255)]
    palette = struct.pack("<III8x", len(colors), 0, len(colors) - 1) + b"".join(
        struct.pack("<H4B", 0, *c) for c in colors)
    color_profile = struct.pack("<HHI8x", 1, 0, 0)  # sRGB
    nm = layer_name.encode("utf-8")
    layer = struct.pack("<HHHHHHB3xH", 3, 0, 0, 0, 0, 0, 255, len(nm)) + nm

    out = b""
    for i, img in enumerate(frames):
        chunks = []
        if i == 0:
            chunks += [_chunk(0x2007, color_profile), _chunk(0x2019, palette), _chunk(0x2004, layer)]
        ys, xs = np.nonzero(img[..., 3])
        if len(ys):
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            px = np.ascontiguousarray(img[y0:y1, x0:x1]).tobytes()
            chunks.append(_chunk(0x2005, struct.pack("<HhhBHh5xHH", 0, x0, y0, 255, 2, 0,
                                                     x1 - x0, y1 - y0) + zlib.compress(px, 9)))
        body = b"".join(chunks)
        n = len(chunks)
        out += struct.pack("<IHHH2xI", 16 + len(body), 0xF1FA, min(n, 0xFFFF), duration_ms, n) + body

    header = struct.pack("<IHHHHHIHII", 128 + len(out), 0xA5E0, len(frames), w, h, 32, 1,
                         duration_ms, 0, 0)
    header += bytes([0, 0, 0, 0]) + struct.pack("<HBBhhHH", len(colors), 1, 1, 0, 0, 16, 16)
    Path(path).write_bytes(header.ljust(128, b"\0") + out)


# --------------------------------------------------------------------------- main

def to_uint8(img):
    r = np.round(np.clip(img, 0, 1) * 255).astype(np.uint8)
    r[r[..., 3] == 0] = 0
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    ap.add_argument("--fps", type=float, help="override timeline frame rate")
    ap.add_argument("--layer-name", default="Sprite Sheet")
    args = ap.parse_args()
    out = args.output or str(Path(args.input).with_suffix(".aseprite"))

    doc = Document(args.input)
    tl = doc.timeline()
    if tl is None or not any(tl[1]):
        warn("no animation timeline found; exporting the whole canvas as one frame")
        fps, cels = args.fps or 12.0, [doc.root]
    else:
        fps, cels = tl
        fps = args.fps or fps
    for i, c in enumerate(cels):
        if c is None:
            warn(f"frame {i} has no cel; exported empty")

    frames = [to_uint8(doc.render(c)) if c else np.zeros((doc.h, doc.w, 4), np.uint8) for c in cels]
    duration = max(1, round(1000 / fps))
    write_aseprite(out, frames, doc.w, doc.h, duration, args.layer_name)
    print(f"{out}: {len(frames)} frames, {doc.w}x{doc.h}, {duration} ms/frame ({fps:g} fps)")
    for i, c in enumerate(cels):
        print(f"  frame {i:3d}: {doc.layers[c]['LayerName'] if c else '(empty)'}")


if __name__ == "__main__":
    main()
