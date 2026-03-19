"""
Generate PNG icons for the CrosslistPlus Chrome extension.

Produces icon16.png, icon32.png, icon48.png, icon128.png — each with a
circular blue (#2563eb) background and two white curved sync arrows.

No third-party dependencies; uses only stdlib (struct, zlib, math).
"""

import math
import struct
import zlib

# ---------------------------------------------------------------------------
# Minimal PNG encoder (RGBA, 8-bit, no external libs required)
# ---------------------------------------------------------------------------

def _chunk(tag: bytes, data: bytes) -> bytes:
    crc = struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return struct.pack(">I", len(data)) + tag + data + crc


def encode_png(width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    """Encode an RGBA pixel list as a valid PNG byte string."""
    # IHDR: width, height, bit-depth=8, colour-type=6 (RGBA)
    ihdr = _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))

    raw_rows = bytearray()
    for y in range(height):
        raw_rows += b"\x00"  # filter type: None
        for x in range(width):
            raw_rows += bytes(pixels[y * width + x])

    idat = _chunk(b"IDAT", zlib.compress(bytes(raw_rows), level=9))
    iend = _chunk(b"IEND", b"")

    signature = b"\x89PNG\r\n\x1a\n"
    return signature + ihdr + idat + iend


# ---------------------------------------------------------------------------
# Icon renderer
# ---------------------------------------------------------------------------

# Brand colour
_BG = (37, 99, 235)       # #2563eb  (blue-600)
_WHITE = (255, 255, 255)
_TRANSPARENT = (0, 0, 0, 0)


def _lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def _aa_alpha(dist: float, radius: float) -> float:
    """Return [0, 1] coverage for a pixel at `dist` from the circle edge."""
    if dist <= radius - 0.5:
        return 1.0
    if dist >= radius + 0.5:
        return 0.0
    return radius + 0.5 - dist


def _blend(fg: tuple[int, int, int], bg_alpha: float, fg_alpha: float
           ) -> tuple[int, int, int, int]:
    """Alpha-composite fg over a solid background, return RGBA."""
    a = fg_alpha
    r = int(fg[0] * a + 0.5)
    g = int(fg[1] * a + 0.5)
    b = int(fg[2] * a + 0.5)
    return (r, g, b, int(a * 255 + 0.5))


def draw_icon(size: int) -> list[tuple[int, int, int, int]]:
    """
    Render a `size x size` icon.

    Design
    ------
    - Circular blue disc
    - Two white arcs (upper-right arc + lower-left arc) separated by small
      gaps; each arc terminates in an arrowhead pointing in the rotation
      direction, giving the classic "sync / refresh" symbol.
    """
    pixels: list[tuple[int, int, int, int]] = []

    cx = (size - 1) / 2.0
    cy = (size - 1) / 2.0
    disc_r = size / 2.0 - 0.5       # outer edge of the blue disc

    # Arrow ring geometry (scaled to icon size)
    ring_r   = disc_r * 0.52         # centreline radius of the ring
    ring_w   = disc_r * 0.18         # half-width of stroke
    gap_deg  = 28.0                  # angular gap between the two arcs (°)
    head_len = ring_r * 0.55         # length of each arrowhead arm
    head_w   = ring_r * 0.22         # half-width of arrowhead base

    gap = math.radians(gap_deg)

    # Arc 1 spans  gap/2  →  π - gap/2   (right side, points downward)
    # Arc 2 spans  π+gap/2 → 2π - gap/2  (left side, points upward)
    arc1_start = gap / 2
    arc1_end   = math.pi - gap / 2
    arc2_start = math.pi + gap / 2
    arc2_end   = 2 * math.pi - gap / 2

    # Arrowhead tips (at the arc *end* point, in the arc travel direction)
    def arc_tip(end_angle: float) -> tuple[float, float]:
        return (cx + ring_r * math.cos(end_angle),
                cy + ring_r * math.sin(end_angle))

    # Tangent (perpendicular) direction at arc end
    def tangent_at(end_angle: float, cw: bool) -> tuple[float, float]:
        """Unit tangent in the direction of travel."""
        # For CCW arc, tangent = (-sin, cos); CW = (sin, -cos)
        s, c = math.sin(end_angle), math.cos(end_angle)
        if cw:
            return (s, -c)
        return (-s, c)

    # Both arcs travel counter-clockwise (angle increases)
    tip1  = arc_tip(arc1_end)
    tan1  = tangent_at(arc1_end, cw=False)   # direction of travel at tip
    tip2  = arc_tip(arc2_end)
    tan2  = tangent_at(arc2_end, cw=False)

    def point_in_arc(angle: float) -> bool:
        # Normalise to [0, 2π)
        a = angle % (2 * math.pi)
        in1 = arc1_start <= a <= arc1_end
        in2 = arc2_start <= a <= arc2_end
        return in1 or in2

    def dist_to_segment(px: float, py: float,
                        ax: float, ay: float,
                        bx: float, by: float) -> float:
        """Perpendicular distance from point (px,py) to segment (a→b)."""
        dx, dy = bx - ax, by - ay
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy + 1e-12)
        t = max(0.0, min(1.0, t))
        rx, ry = px - (ax + t * dx), py - (ay + t * dy)
        return math.hypot(rx, ry)

    def coverage_ring(px: float, py: float) -> float:
        """Coverage of the circular arc stroke at pixel (px, py)."""
        dx, dy = px - cx, py - cy
        d = math.hypot(dx, dy)
        if d < 1e-9:
            return 0.0
        angle = math.atan2(dy, dx) % (2 * math.pi)
        if not point_in_arc(angle):
            return 0.0
        dist_from_ring = abs(d - ring_r)
        return max(0.0, 1.0 - max(0.0, dist_from_ring - ring_w) / 0.8)

    def coverage_arrowhead(px: float, py: float,
                           tip: tuple[float, float],
                           tangent: tuple[float, float]) -> float:
        """
        Coverage of a filled triangular arrowhead.

        The triangle has its apex at `tip`, with the base perpendicular to
        `tangent` and located `head_len` behind the tip.
        """
        tx, ty = tangent          # unit vector pointing in travel direction
        nx, ny = -ty, tx          # perpendicular (left normal)

        apex  = tip
        # Base centre
        base_cx = tip[0] - tx * head_len
        base_cy = tip[1] - ty * head_len

        # Three vertices
        v0 = apex
        v1 = (base_cx + nx * head_w, base_cy + ny * head_w)
        v2 = (base_cx - nx * head_w, base_cy - ny * head_w)

        # Barycentric / cross-product test with soft edge
        def edge_dist(ax: float, ay: float,
                      bx: float, by: float,
                      qx: float, qy: float) -> float:
            """Signed distance from q to edge a→b (positive = inside)."""
            ex, ey = bx - ax, by - ay
            return (qx - ax) * ey - (qy - ay) * ex

        d0 = edge_dist(v0[0], v0[1], v1[0], v1[1], px, py)
        d1 = edge_dist(v1[0], v1[1], v2[0], v2[1], px, py)
        d2 = edge_dist(v2[0], v2[1], v0[0], v0[1], px, py)

        inside = (d0 >= 0 and d1 >= 0 and d2 >= 0) or \
                 (d0 <= 0 and d1 <= 0 and d2 <= 0)

        if inside:
            # Distance to nearest edge for soft anti-aliasing
            min_d = min(abs(d0), abs(d1), abs(d2)) / (head_w + 0.5)
            return min(1.0, min_d * 2 + 0.5)
        else:
            min_d = min(abs(d0), abs(d1), abs(d2))
            return max(0.0, 1.0 - min_d / 0.8)

    for y in range(size):
        for x in range(size):
            px, py = float(x), float(y)
            dx, dy = px - cx, py - cy
            dist = math.hypot(dx, dy)

            # --- Disc coverage (alpha of the blue background) ---
            disc_cov = _aa_alpha(dist, disc_r)
            if disc_cov <= 0.0:
                pixels.append(_TRANSPARENT)
                continue

            # --- White symbol coverage ---
            ring_cov  = coverage_ring(px, py)
            arrow_cov = max(
                coverage_arrowhead(px, py, tip1, tan1),
                coverage_arrowhead(px, py, tip2, tan2),
            )
            white_cov = min(1.0, ring_cov + arrow_cov)

            # --- Composite: white over blue, then mask by disc ---
            bg_r  = _lerp(_BG[0], _WHITE[0], white_cov)
            bg_g  = _lerp(_BG[1], _WHITE[1], white_cov)
            bg_b  = _lerp(_BG[2], _WHITE[2], white_cov)

            final_a = int(disc_cov * 255 + 0.5)
            pixels.append((int(bg_r + 0.5), int(bg_g + 0.5), int(bg_b + 0.5), final_a))

    return pixels


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import os

    script_dir = os.path.dirname(os.path.abspath(__file__))
    sizes = [16, 32, 48, 128]

    for size in sizes:
        pixels = draw_icon(size)
        png_bytes = encode_png(size, size, pixels)
        out_path = os.path.join(script_dir, f"icon{size}.png")
        with open(out_path, "wb") as fh:
            fh.write(png_bytes)
        print(f"Created {out_path}  ({len(png_bytes):,} bytes)")

    print("Done.")
