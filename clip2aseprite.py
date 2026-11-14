#!/usr/bin/env python3
"""Convert a Clip Studio Paint animation (.clip) into a flattened .aseprite file.

Each animation cel on the CSP timeline (usually a folder of layers) becomes one
frame of a single-layer RGBA Aseprite sprite. Frame order and duration come from
the CSP timeline.

Usage:
    python3 clip2aseprite.py input.clip [output.aseprite] [--fps N] [--layer-name NAME]

Requires Python 3.11+ and numpy.
"""

import argparse
import re
import sqlite3
import struct
import sys
import zlib
from pathlib import Path

import numpy as np


# CSP layer types (Layer.LayerType)
LAYER_FOLDER = 0
LAYER_RASTER = 1

# CSP timeline track that shows one animation cel (Track.TrackKind)
TRACK_KIND_CEL = 1000

# The CSP timeline measures time in 1/5 frame units (a 12-frame animation ends at 60).
TIME_UNITS_PER_FRAME = 5

# Layer pixels are stored as square tiles of this size.
TILE_SIZE = 256

# Aseprite chunk types
ASE_COLOR_PROFILE = 0x2007
ASE_PALETTE = 0x2019
ASE_LAYER = 0x2004
ASE_CEL = 0x2005


def warn(message):
    print(f"warning: {message}", file=sys.stderr)


# =============================================================================
# Reading the .clip container
# =============================================================================
#
# A .clip file is a "CSFCHUNK" header followed by chunks. Each chunk is an
# 8-byte name, an 8-byte big-endian length and then the data:
#
#   CHNKHead   file header
#   CHNKExta   "external" data blob (pixels, timeline keys), named "extrnlid..."
#   CHNKSQLi   a SQLite database describing the document
#   CHNKFoot   end marker
#
# Database rows refer to external blobs by their name.

def read_clip(path):
    """Return (sqlite connection, {external blob name: bytes})."""
    data = Path(path).read_bytes()

    if data[:8] != b"CSFCHUNK":
        raise ValueError(f"{path}: not a Clip Studio Paint file")

    externals = {}
    database = None

    pos = 24  # skip the file header
    while pos + 16 <= len(data):
        chunk_name = data[pos:pos + 8]
        chunk_length = struct.unpack(">Q", data[pos + 8:pos + 16])[0]
        body = data[pos + 16:pos + 16 + chunk_length]

        if chunk_name == b"CHNKExta":
            name_length = struct.unpack(">Q", body[:8])[0]
            name = body[8:8 + name_length].decode("ascii")
            externals[name] = body[8 + name_length:]

        elif chunk_name == b"CHNKSQLi":
            database = body

        pos += 16 + chunk_length

    if database is None:
        raise ValueError(f"{path}: no layer database found")

    connection = sqlite3.connect(":memory:")
    connection.deserialize(database)
    connection.row_factory = sqlite3.Row

    return connection, externals


# =============================================================================
# Layer pixels
# =============================================================================
#
# A layer's pixels ("offscreen") are split into 256x256 tiles. The offscreen's
# Attribute blob holds its size and the number of tiles across/down. The pixel
# blob contains one "BlockDataBeginChunk" record per tile:
#
#   u32 tile index, u32 uncompressed size, u32 width, u32 height, u32 has_data,
#   u32 ?, u32 compressed length (little-endian!), zlib data
#
# Decompressed, a tile is a 256x256 alpha plane followed by 256x256 BGRA pixels
# (the A of BGRA is unused).

def decode_offscreen(attribute, data):
    """Decode a layer's pixel blob into an RGBA uint8 array (straight alpha)."""
    parameter = "Parameter".encode("utf-16-be")
    pos = attribute.find(parameter)
    if pos < 0:
        raise ValueError("unrecognised layer pixel format")

    pos += len(parameter)
    width, height, tiles_across, tiles_down = struct.unpack(">IIII", attribute[pos:pos + 16])

    image = np.zeros((tiles_down * TILE_SIZE, tiles_across * TILE_SIZE, 4), np.uint8)

    marker = "BlockDataBeginChunk".encode("utf-16-be")
    for match in re.finditer(re.escape(marker), data):
        pos = match.end()

        tile_index, _size, _width, _height, has_data = struct.unpack(">5I", data[pos:pos + 20])
        if not has_data:
            continue

        compressed_length = struct.unpack("<I", data[pos + 24:pos + 28])[0]
        raw = zlib.decompress(data[pos + 28:pos + 28 + compressed_length])

        if len(raw) != TILE_SIZE * TILE_SIZE * 5:
            raise ValueError("only 32-bit colour layers are supported")

        alpha = np.frombuffer(raw[:TILE_SIZE * TILE_SIZE], np.uint8).reshape(TILE_SIZE, TILE_SIZE)
        bgra = np.frombuffer(raw[TILE_SIZE * TILE_SIZE:], np.uint8).reshape(TILE_SIZE, TILE_SIZE, 4)
        rgba = np.dstack([bgra[..., 2], bgra[..., 1], bgra[..., 0], alpha])

        row, col = divmod(tile_index, tiles_across)
        y, x = row * TILE_SIZE, col * TILE_SIZE
        image[y:y + TILE_SIZE, x:x + TILE_SIZE] = rgba

    return image[:height, :width]


def blend_normal(below, above, opacity):
    """Draw `above` over `below` (float RGBA in 0..1, straight alpha)."""
    above_alpha = above[..., 3:4] * opacity
    below_alpha = below[..., 3:4]
    out_alpha = above_alpha + below_alpha * (1 - above_alpha)

    with np.errstate(invalid="ignore", divide="ignore"):
        out_rgb = np.where(
            out_alpha > 0,
            (above[..., :3] * above_alpha + below[..., :3] * below_alpha * (1 - above_alpha)) / out_alpha,
            0,
        )

    return np.concatenate([out_rgb, out_alpha], -1)


# =============================================================================
# The document: layer tree, compositing and timeline
# =============================================================================

class Document:
    def __init__(self, path):
        self.db, self.externals = read_clip(path)

        canvas = self.db.execute("select * from Canvas").fetchone()
        self.width = int(canvas["CanvasWidth"])
        self.height = int(canvas["CanvasHeight"])
        self.root = canvas["CanvasRootFolder"]

        self.layers = {row["MainId"]: row for row in self.db.execute("select * from Layer")}

    # ---- layer tree -----------------------------------------------------------

    def children(self, layer_id):
        """Children of a folder, bottom-most first.

        Each layer links to its first child and its next sibling; the first
        child is the bottom of the stack.
        """
        result = []

        child = self.layers[layer_id]["LayerFirstChildIndex"]
        while child:
            result.append(child)
            child = self.layers[child]["LayerNextIndex"]

        return result

    # ---- pixels ---------------------------------------------------------------

    def layer_pixels(self, layer_id):
        """A raster layer's pixels placed on a canvas-sized float RGBA array."""
        layer = self.layers[layer_id]
        canvas = np.zeros((self.height, self.width, 4))

        # Layer -> Mipmap -> MipmapInfo (full-size level) -> Offscreen
        row = self.db.execute(
            "select o.Attribute, cast(o.BlockData as text) "
            "from Mipmap m "
            "join MipmapInfo i on i.MainId = m.BaseMipmapInfo "
            "join Offscreen o on o.MainId = i.Offscreen "
            "where m.MainId = ?",
            (layer["LayerRenderMipmap"],),
        ).fetchone()

        if row is None:
            return canvas

        attribute, blob_name = row
        pixels = decode_offscreen(attribute, self.externals[blob_name]).astype(np.float64) / 255.0

        # Where the pixel data's top-left corner sits on the canvas
        left = layer["LayerOffsetX"] + layer["LayerRenderOffscrOffsetX"]
        top = layer["LayerOffsetY"] + layer["LayerRenderOffscrOffsetY"]

        # Clip to the canvas
        pixels_height, pixels_width = pixels.shape[:2]
        x0, y0 = max(0, left), max(0, top)
        x1, y1 = min(self.width, left + pixels_width), min(self.height, top + pixels_height)

        if x1 > x0 and y1 > y0:
            canvas[y0:y1, x0:x1] = pixels[y0 - top:y1 - top, x0 - left:x1 - left]

        return canvas

    def render(self, layer_id):
        """Composite a layer or folder into a float RGBA canvas."""
        layer = self.layers[layer_id]

        if not layer["LayerFolder"]:
            return self.layer_pixels(layer_id)

        result = np.zeros((self.height, self.width, 4))

        for child_id in self.children(layer_id):
            child = self.layers[child_id]
            name = child["LayerName"]

            if not (child["LayerVisibility"] or 0) & 1:
                continue

            if child["LayerType"] not in (LAYER_FOLDER, LAYER_RASTER):
                warn(f"layer '{name}' has unsupported type {child['LayerType']}; skipped")
                continue

            if child["LayerComposite"]:
                warn(f"layer '{name}' uses blend mode {child['LayerComposite']}; rendered as Normal")
            if child["LayerClip"]:
                warn(f"layer '{name}' is a clipping layer; clipping ignored")
            if child["LayerLayerMaskMipmap"]:
                warn(f"layer '{name}' has a layer mask; mask ignored")

            opacity = (child["LayerOpacity"] or 0) / 256.0
            result = blend_normal(result, self.render(child_id), opacity)

        return result

    # ---- timeline -------------------------------------------------------------

    def timeline(self):
        """Return (fps, [layer id or None for each frame]), or None if there is no animation."""
        timeline = self.db.execute("select * from TimeLine order by MainId").fetchone()
        if timeline is None:
            return None

        first_frame = round(timeline["StartFrame"])
        frame_count = round(timeline["EndFrame"] - timeline["StartFrame"])
        frames = [None] * frame_count

        layers_by_uuid = {normalize_uuid(row["LayerUuid"]): layer_id for layer_id, row in self.layers.items()}

        tracks = self.db.execute(
            "select MainId, hex(LayerUuidWithTrack) as uuid, TrackKind, "
            "cast(TrackActionMixer2 as text) as keys "
            "from Track where BankId = ?",
            (timeline["BankId"],),
        )

        for track in tracks:
            if track["TrackKind"] != TRACK_KIND_CEL or track["keys"] not in self.externals:
                continue

            layer_id = layers_by_uuid.get(normalize_uuid(track["uuid"]))
            if layer_id is None:
                warn(f"track {track['MainId']} refers to an unknown layer")
                continue

            start, end = parse_time_clip(self.externals[track["keys"]])
            start_frame = round(start / TIME_UNITS_PER_FRAME)
            end_frame = round(end / TIME_UNITS_PER_FRAME)

            for frame in range(start_frame, end_frame):
                index = frame - first_frame
                if not 0 <= index < frame_count:
                    continue

                if frames[index] is not None:
                    warn(f"frame {index} claimed by both '{self.layers[frames[index]]['LayerName']}' "
                         f"and '{self.layers[layer_id]['LayerName']}'")

                frames[index] = layer_id

        return timeline["FrameRate"], frames


def normalize_uuid(value):
    """UUIDs are stored with inconsistent dashes; compare just the hex digits."""
    return "".join(ch for ch in (value or "").lower() if ch in "0123456789abcdef")


def parse_time_clip(blob):
    """Read the first TimeClip's Start and End from a track's key data.

    The blob is zlib-compressed CSP "binc" data: a table of names (field and
    type names) followed by records. A Double record looks like:

        u32 0x10, u32 0x1c, u32 0x20, u32 field name index, u32 type name index,
        3 bytes, f64 little-endian value
    """
    compressed_length = struct.unpack("<I", blob[8:12])[0]
    data = zlib.decompress(blob[12:12 + compressed_length])

    if data[:12] != b"cmt 0110binc":
        raise ValueError("unknown timeline data format")

    # Name table: u32 count, then length-prefixed strings
    name_count = struct.unpack("<I", data[16:20])[0]
    names = []
    pos = 20
    for _ in range(name_count):
        length = data[pos]
        names.append(data[pos + 1:pos + 1 + length].decode("latin-1"))
        pos += 1 + length

    def read_double(field):
        header = struct.pack(">IIIII", 0x10, 0x1C, 0x20, names.index(field), names.index("Double"))
        found = data.find(header, pos)
        if found < 0:
            raise ValueError(f"TimeClip field '{field}' not found")

        value_pos = found + len(header) + 3
        return struct.unpack("<d", data[value_pos:value_pos + 8])[0]

    return read_double("Start"), read_double("End")


# =============================================================================
# Writing the .aseprite file
# =============================================================================
#
# Format reference: https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md
#
# 128-byte header, then one frame block per frame. Frame 1 carries the colour
# profile, palette and layer chunks; every frame carries one compressed cel
# cropped to its visible pixels.

def make_chunk(chunk_type, body):
    return struct.pack("<IH", len(body) + 6, chunk_type) + body


def unique_colors(frames):
    """Up to 256 visible colours, for the palette (informational in RGBA mode)."""
    colors = np.unique(np.vstack([frame.reshape(-1, 4) for frame in frames]), axis=0)
    colors = [tuple(int(v) for v in color) for color in colors if color[3] > 0]
    return colors[:256] or [(0, 0, 0, 255)]


def write_aseprite(path, frames, width, height, duration_ms, layer_name):
    colors = unique_colors(frames)

    # Chunks that only appear in the first frame
    color_profile = struct.pack("<HHI8x", 1, 0, 0)  # sRGB

    palette = struct.pack("<III8x", len(colors), 0, len(colors) - 1)
    palette += b"".join(struct.pack("<H4B", 0, *color) for color in colors)

    name = layer_name.encode("utf-8")
    layer = struct.pack("<HHHHHHB3xH", 3, 0, 0, 0, 0, 0, 255, len(name)) + name  # visible + editable

    # Frames
    frame_blocks = b""
    for index, image in enumerate(frames):
        chunks = []

        if index == 0:
            chunks.append(make_chunk(ASE_COLOR_PROFILE, color_profile))
            chunks.append(make_chunk(ASE_PALETTE, palette))
            chunks.append(make_chunk(ASE_LAYER, layer))

        ys, xs = np.nonzero(image[..., 3])
        if len(ys):
            y0, y1 = ys.min(), ys.max() + 1
            x0, x1 = xs.min(), xs.max() + 1
            pixels = np.ascontiguousarray(image[y0:y1, x0:x1]).tobytes()

            # layer 0, position, opaque, compressed image, z-index 0, size, pixels
            cel = struct.pack("<HhhBHh5xHH", 0, x0, y0, 255, 2, 0, x1 - x0, y1 - y0)
            chunks.append(make_chunk(ASE_CEL, cel + zlib.compress(pixels, 9)))

        body = b"".join(chunks)
        frame_header = struct.pack("<IHHH2xI", 16 + len(body), 0xF1FA, min(len(chunks), 0xFFFF),
                                   duration_ms, len(chunks))
        frame_blocks += frame_header + body

    # File header: size, magic, frames, size, 32 bpp, flags, speed, ...
    header = struct.pack("<IHHHHHIHII", 128 + len(frame_blocks), 0xA5E0, len(frames),
                         width, height, 32, 1, duration_ms, 0, 0)
    header += bytes(4)  # transparent index + reserved
    header += struct.pack("<HBBhhHH", len(colors), 1, 1, 0, 0, 16, 16)  # colours, pixel ratio, grid

    Path(path).write_bytes(header.ljust(128, b"\0") + frame_blocks)


# =============================================================================
# Command line
# =============================================================================

def to_uint8(image):
    result = np.round(np.clip(image, 0, 1) * 255).astype(np.uint8)
    result[result[..., 3] == 0] = 0  # fully transparent pixels become (0, 0, 0, 0)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("input")
    parser.add_argument("output", nargs="?")
    parser.add_argument("--fps", type=float, help="override the timeline frame rate")
    parser.add_argument("--layer-name", default="Sprite Sheet")
    args = parser.parse_args()

    output = args.output or str(Path(args.input).with_suffix(".aseprite"))
    doc = Document(args.input)

    # Decide which layer/folder becomes each frame
    timeline = doc.timeline()
    if timeline is None or not any(timeline[1]):
        warn("no animation timeline found; exporting the whole canvas as one frame")
        fps, cels = 12.0, [doc.root]
    else:
        fps, cels = timeline

    if args.fps:
        fps = args.fps

    for index, cel in enumerate(cels):
        if cel is None:
            warn(f"frame {index} has no cel; exported empty")

    # Render and write
    frames = []
    for cel in cels:
        if cel is None:
            frames.append(np.zeros((doc.height, doc.width, 4), np.uint8))
        else:
            frames.append(to_uint8(doc.render(cel)))

    duration_ms = max(1, round(1000 / fps))
    write_aseprite(output, frames, doc.width, doc.height, duration_ms, args.layer_name)

    # Report
    print(f"{output}: {len(frames)} frames, {doc.width}x{doc.height}, {duration_ms} ms/frame ({fps:g} fps)")
    for index, cel in enumerate(cels):
        name = doc.layers[cel]["LayerName"] if cel else "(empty)"
        print(f"  frame {index:3d}: {name}")


if __name__ == "__main__":
    main()
