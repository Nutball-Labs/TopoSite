#!/usr/bin/env python3
"""gen_nav_icon.py — Build TopoSite's sidebar icon: one 24x24 SVG path in the style of
Z-Wave JS UI's Material Icons (filled, single colour, 2 px walls on whole pixels).

A room (walls with a doorway on the right) holding the mesh: controller star top-left,
links out to two mains nodes (hexagons) and one battery node (square).

Usage: scripts/gen_nav_icon.py [out.svg]   (default images/nav-icon.svg)
Prints the path data; Vuetify takes it as an icon string with an "svg:" prefix.
"""
import math
import os
import sys

WALL = 2
LO, HI = 2, 22                 # Material live area inside the 24 px box
DOOR_RIGHT = (13, 17)          # doorway gap on the right wall
STAR_AT, STAR_RO, STAR_RI = (8.6, 8.6), 3.9, 1.95
NODES = [((16.6, 7.2), "hex"), ((16.4, 16.4), "sq"), ((7.2, 16.6), "hex")]
HEX_R, SQ_H, LINK_W = 2.1, 1.65, 1.75


def poly(pts):
    # Same winding for every shape, so overlaps fill under the nonzero rule
    area = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    if area < 0:
        pts = pts[::-1]
    f = lambda v: f"{round(v, 2):g}"
    return "M" + " ".join(f"{f(x)} {f(y)}" for x, y in pts) + "Z"


def rect(x0, y0, x1, y1):
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def star(cx, cy, ro, ri):
    return [(cx + (ro if i % 2 == 0 else ri) * math.cos(math.radians(-90 + i * 36)),
             cy + (ro if i % 2 == 0 else ri) * math.sin(math.radians(-90 + i * 36)))
            for i in range(10)]


def hexagon(cx, cy, r):  # pointy-top, like the logo
    return [(cx + r * math.cos(math.radians(-90 + i * 60)),
             cy + r * math.sin(math.radians(-90 + i * 60))) for i in range(6)]


def link(p, q, w):
    (x0, y0), (x1, y1) = p, q
    n = math.hypot(x1 - x0, y1 - y0)
    nx, ny = -(y1 - y0) / n * w / 2, (x1 - x0) / n * w / 2
    return [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)]


def build():
    t = WALL
    shapes = [rect(LO, LO, HI, LO + t),              # top
              rect(LO, HI - t, HI, HI),              # bottom
              rect(LO, LO + t, LO + t, HI - t),      # left
              rect(HI - t, LO + t, HI, DOOR_RIGHT[0]),
              rect(HI - t, DOOR_RIGHT[1], HI, HI - t)]
    sx, sy = STAR_AT
    for (x, y), _ in NODES:
        k = STAR_RO / math.hypot(x - sx, y - sy)     # link starts at the star's outer radius
        shapes.append(link((sx + (x - sx) * k, sy + (y - sy) * k), (x, y), LINK_W))
    for (x, y), kind in NODES:
        shapes.append(hexagon(x, y, HEX_R) if kind == "hex"
                      else rect(x - SQ_H, y - SQ_H, x + SQ_H, y + SQ_H))
    shapes.append(star(sx, sy, STAR_RO, STAR_RI))
    return "".join(poly(s) for s in shapes)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "images", "nav-icon.svg")
    d = build()
    with open(out, "w") as fh:
        fh.write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
                 f'<path fill="currentColor" d="{d}"/></svg>\n')
    print(d)

# SN: 00002
