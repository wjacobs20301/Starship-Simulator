"""Starbase V3 launch mount and flame trench (Pad 2 as built, and Pad 1 as rebuilt to match).

Built from published descriptions and photos (NASASpaceflight incl. side-on shots of Pad 2's
mount, overhead imagery, Wikipedia "SpaceX Starbase"),
with the trench footprint from OpenStreetMap. Dimensions not published are estimated from
photos and marked approx:

  Flame trench   85 x 23.5 m (OSM), ~6 m deep (approx): a steel-lined concrete "bathtub",
                 open-ended, the floor ramping back up to grade at both ends.
  Flame diverter a double-sided flame bucket under the mount: a ridge of water-cooled steel
                 pipes (with a ridge cap) splitting the exhaust down both arms of the trench.
  Launch mount   a massive concrete bridge over the trench: two sloped piers (truncated
                 pyramids) joined by a thick span over a tunnel the exhaust flows out
                 through, a row of vents along the span, and the steel launch table on top
                 (20 hold-down clamps, water-cooled deck, booster QD, equipment house). Deck
                 height matches the sim's PAD.mountHeight.
  Tower plinth   a wide concrete base with sloped sides.

Local frame for a pad: origin at the mount center on the ground, X along the trench axis,
Y across it, Z up. Everything is rotated into the pad's east/north frame at the end.
"""

import math

from mathutils import Matrix, Vector

from lib import MeshBuilder

# Approx / tune (not published): proportions from photos of Pad 2's mount.
CONCRETE_BELOW_DECK = 4.5  # top of the concrete bridge below the deck, m (the steel table brings it to PAD.mountHeight)
SPAN_DEPTH = 5.0  # the bridge span's depth over the tunnel, m
SPAN_X = 11.0  # half-depth of the span / piers' tops along the trench, m
PIER_BASE_X = 17.0  # half-depth of the piers at the ground, m
PIER_BASE_W = 14.0  # pier width across the trench at the ground, m
PIER_TOP_W = 7.0  # ... and at the top, m
HOLE = 6.5  # half-size of the flame hole through the span, m
TABLE_HALF = 10.0  # steel launch table, half-size, m
DECK_THICK = 1.2
OPENING_R = 6.2  # central opening in the deck, m (booster radius 4.5 + clamps)
PLINTH_BASE = 26.0  # tower plinth, square at the ground, m
PLINTH_TOP = 17.5  # ... at its top (the tower's width), m
PLINTH_H = 7.0
RAMP = 16.0  # length of the trench's end ramps, m
DIVERTER_HALF = 17.0  # half-length of the flame bucket along the trench, m
DIVERTER_TOP = -0.6  # ridge cap height (just below grade), m
PIPE_D = 0.55  # diverter pipe diameter, m
WALL = 2.25  # trench wall thickness at grade, m (19 m channel + walls = OSM 23.5 m)
N_CLAMPS = 20


def _pipe(mb, p0, p1, radius, segments=10):
    """Closed-ish cylinder between two points (no end caps: they sit against the walls)."""
    p0, p1 = Vector(p0), Vector(p1)
    axis = (p1 - p0).normalized()
    ref = Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((1, 0, 0))
    u = axis.cross(ref).normalized()
    v = axis.cross(u)
    length = (p1 - p0).length
    rows, uvs = [], []
    for p, t in ((p0, 0.0), (p1, length)):
        row, uvr = [], []
        for j in range(segments + 1):
            a = 2 * math.pi * j / segments
            row.append(p + (u * math.cos(a) + v * math.sin(a)) * radius)
            uvr.append((j / segments * 2 * math.pi * radius, t))
        rows.append(row)
        uvs.append(uvr)
    mb.add_grid(rows, uvs, smooth=True)


def _ring_deck(mb, half, radius, z0, z1, segments=64):
    """Square slab (side 2*half) with a round hole, top at z1, bottom at z0."""
    outer, inner = [], []
    for j in range(segments):
        a = 2 * math.pi * j / segments
        c, s = math.cos(a), math.sin(a)
        k = half / max(abs(c), abs(s))  # ray to the square's boundary
        outer.append((c * k, s * k))
        inner.append((c * radius, s * radius))
    outer.append(outer[0])
    inner.append(inner[0])
    for z, flip in ((z1, False), (z0, True)):
        rows = [[(x, y, z) for x, y in outer], [(x, y, z) for x, y in inner]]
        if flip:
            rows.reverse()
        uv = [[(x / 4, y / 4) for x, y, _ in r] for r in rows]
        mb.add_grid(rows, uv, smooth=False)
    # Inner wall of the opening and the outer sides.
    rows = [[(x, y, z1) for x, y in inner], [(x, y, z0) for x, y in inner]]
    mb.add_grid(rows, [[(j / 4, z) for j, (_, _, z) in enumerate(r)] for r in rows], smooth=True)
    mb.add_box((half, 0, (z0 + z1) / 2), (0.01, 2 * half, z1 - z0))
    mb.add_box((-half, 0, (z0 + z1) / 2), (0.01, 2 * half, z1 - z0))
    mb.add_box((0, half, (z0 + z1) / 2), (2 * half, 0.01, z1 - z0))
    mb.add_box((0, -half, (z0 + z1) / 2), (2 * half, 0.01, z1 - z0))


def _frustum(mb, bottom, top, z0, z1, flip_y=False):
    """Truncated pyramid between two axis-aligned rectangles (x0, x1, y0, y1) at z0 and z1.
    flip_y mirrors it across y = 0."""
    def corners(r, z):
        x0, x1, y0, y1 = r
        pts = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)]
        if flip_y:
            pts = [(x, -y, z) for x, y, z in reversed(pts)]
        return [Vector(p) for p in pts]
    lo, hi = corners(bottom, z0), corners(top, z1)
    mb.add_face(list(reversed(lo)), [(0, 0), (1, 0), (1, 1), (0, 1)])
    mb.add_face(hi, [(p.x / 3, p.y / 3) for p in hi])
    for i in range(4):
        j = (i + 1) % 4
        w = (lo[j] - lo[i]).length / 3
        hgt = (hi[i] - lo[i]).length / 3
        mb.add_face([lo[i], lo[j], hi[j], hi[i]], [(0, 0), (w, 0), (w, hgt), (0, hgt)])


def build_v3_pad(root, mats, geo, spec):
    """spec: {prefix, mount: [east, north], tower: [east, north] (relative to the mount), trench}."""
    pre = spec["prefix"]
    tr = spec["trench"]
    pad = geo["pad"]
    L, W, D = tr["length"], tr["width"], tr["depth"]
    deck_top = pad["mountHeight"] - 1.0  # the booster sits on the clamps, ~1 m above the plate
    concrete_top = pad["mountHeight"] - CONCRETE_BELOW_DECK
    tunnel_top = concrete_top - SPAN_DEPTH  # soffit of the tunnel over the trench
    to_world = Matrix.Translation((spec["mount"][0], spec["mount"][1], 0.0)) @ Matrix.Rotation(math.radians(tr["axisDeg"]), 4, "Z")
    # Direction to the tower in the local (trench) frame, for the booster QD.
    tower_local = to_world.to_3x3().inverted() @ Vector((spec["tower"][0], spec["tower"][1], 0.0))
    tower_dir = Vector((tower_local.x, tower_local.y)).normalized()

    objs = []

    # --- Flame trench ---------------------------------------------------------
    lining = MeshBuilder()  # stainless steel lining: floor, ramps and walls
    xs = [-L / 2, -L / 2 + RAMP, L / 2 - RAMP, L / 2]
    zs = [0.0, -D, -D, 0.0]
    # Floor + ramps (one strip across the trench).
    rows = [[(x, -W / 2, z) for x, z in zip(xs, zs)], [(x, W / 2, z) for x, z in zip(xs, zs)]]
    lining.add_grid(rows, [[(x / 4, -W / 8) for x in xs], [(x / 4, W / 8) for x in xs]], smooth=False)
    # Side walls from the floor profile up to grade.
    for y, flip in ((-W / 2, True), (W / 2, False)):
        bottom = [(x, y, z) for x, z in zip(xs, zs)]
        top = [(x, y, 0.0) for x in xs]
        r = [top, bottom] if flip else [bottom, top]
        lining.add_grid(r, [[(x / 4, z / 4) for x, _, z in row] for row in r], smooth=False)
    objs.append(lining.build(pre + "Trench_Lining", mats.trench_steel, parent=root))

    # Concrete wall caps at grade along both sides (the visible edge of the trench).
    caps = MeshBuilder()
    for y in (-W / 2 - WALL / 2, W / 2 + WALL / 2):
        caps.add_box((0, y, -0.2), (L, WALL, 1.0), uv_size=2.0)
    objs.append(caps.build(pre + "Trench_Caps", mats.concrete, parent=root))

    # Double-sided flame bucket: pipes laid across the trench along a concave profile on each
    # side of a central ridge.
    bucket = MeshBuilder()
    def profile(x):
        t = min(1.0, abs(x) / DIVERTER_HALF)
        return -D + (DIVERTER_TOP + D) * (1 - t) ** 2
    s = 0.0
    x = 0.0
    # Walk along the curve at pipe-diameter spacing (arc length), both sides.
    samples = [0.0]
    while x < DIVERTER_HALF:
        dx = 0.05
        while True:
            z0, z1 = profile(x), profile(x + dx)
            if math.hypot(dx, z1 - z0) >= PIPE_D * 1.02 or x + dx >= DIVERTER_HALF:
                break
            dx += 0.05
        x += dx
        samples.append(min(x, DIVERTER_HALF))
    for xp in samples:
        for sign in ((1,) if xp == 0 else (1, -1)):
            zc = profile(xp) + PIPE_D / 2
            _pipe(bucket, (sign * xp, -W / 2, zc), (sign * xp, W / 2, zc), PIPE_D / 2)
    objs.append(bucket.build(pre + "FlameDiverter", mats.diverter, parent=root))
    cap = MeshBuilder()
    cap.add_box((0, 0, DIVERTER_TOP + 0.5), (1.4, W, 0.8))  # ridge cap
    objs.append(cap.build(pre + "Diverter_RidgeCap", mats.trench_steel, parent=root))

    # --- Launch mount: a concrete bridge over the trench ------------------------------
    # Two sloped concrete piers (truncated pyramids) on either side of the trench, joined by a
    # thick span over a tall tunnel the exhaust flows out through; the steel launch table sits
    # on top. Proportions from side-on and overhead photos of Pad 2 (approx / tune).
    y_in = W / 2  # piers' inner faces line the trench channel
    walls = MeshBuilder()
    for sy in (-1, 1):
        # Pier: bottom (x +-PIER_BASE_X, y from y_in to y_in + PIER_BASE_W), top narrower.
        _frustum(walls,
                 (-PIER_BASE_X, PIER_BASE_X, y_in, y_in + PIER_BASE_W),
                 (-SPAN_X, SPAN_X, y_in, y_in + PIER_TOP_W),
                 0.0, concrete_top, flip_y=sy < 0)
    # Span over the tunnel, with the flame hole through its middle.
    hx, hy = HOLE, HOLE
    for x0, x1, y0, y1 in ((-SPAN_X, -hx, -y_in, y_in), (hx, SPAN_X, -y_in, y_in),
                           (-hx, hx, -y_in, -hy), (-hx, hx, hy, y_in)):
        walls.add_box(((x0 + x1) / 2, (y0 + y1) / 2, (tunnel_top + concrete_top) / 2),
                      (x1 - x0, y1 - y0, concrete_top - tunnel_top), uv_size=3.0)
    objs.append(walls.build(pre + "LaunchMount_Concrete", mats.mount_concrete, parent=root))

    # Dark details: the row of vents along the top of the span (both tunnel faces) and
    # doorways in the piers' inner faces.
    dark = MeshBuilder()
    for sx in (-1, 1):
        for k in range(9):
            y = -y_in + (k + 0.5) * (2 * y_in / 9)
            dark.add_box((sx * (SPAN_X + 0.05), y, concrete_top - 2.2), (0.2, 1.1, 1.3))
        for sy in (-1, 1):
            dark.add_box((sx * 6.0, sy * (y_in + 0.05), 1.6), (1.8, 0.2, 3.2))
    objs.append(dark.build(pre + "LaunchMount_Openings", mats.dark, parent=root))

    # Steel launch table on the concrete: plated sides with ribs, the water-cooled deck plate.
    h = TABLE_HALF
    table = MeshBuilder()
    t = 1.2
    z0, z1 = concrete_top, deck_top - DECK_THICK
    for sx in (-1, 1):
        table.add_box((sx * (h - t / 2), 0, (z0 + z1) / 2), (t, 2 * h, z1 - z0), uv_size=2.0)
        table.add_box((0, sx * (h - t / 2), (z0 + z1) / 2), (2 * h - 2 * t, t, z1 - z0), uv_size=2.0)
    for k in range(-4, 5):
        off = k * (2 * h / 9)
        for sx in (-1, 1):
            table.add_box((sx * (h + 0.2), off, (z0 + z1) / 2), (0.4, 0.4, z1 - z0))
            table.add_box((off, sx * (h + 0.2), (z0 + z1) / 2), (0.4, 0.4, z1 - z0))
    # Equipment house on the side away from the tower (seen on Pad 2's table).
    away = -Vector((tower_dir.x, tower_dir.y, 0))
    table.add_box(tuple(away * (h - 3.5) + Vector((0, 0, deck_top + 2.5))), (7.0, 7.0, 5.0), Matrix.Rotation(math.atan2(away.y, away.x), 4, "Z"))
    objs.append(table.build(pre + "LaunchTable", mats.tower_light, parent=root))
    deck = MeshBuilder()
    _ring_deck(deck, h, OPENING_R, deck_top - DECK_THICK, deck_top)
    objs.append(deck.build(pre + "LaunchMount_Deck", mats.steel_dark, parent=root))

    # Tower plinth: a wide concrete base with sloped sides, square to the tower (which stands
    # with a corner toward the mount, see tower_kit.py).
    plinth = MeshBuilder()
    b, tp = PLINTH_BASE / 2, PLINTH_TOP / 2
    _frustum(plinth, (-b, b, -b, b), (-tp, tp, -tp, tp), 0.0, PLINTH_H)
    pl = plinth.build(pre + "Tower_Plinth", mats.mount_concrete, parent=root)
    corner_on = math.atan2(-spec["tower"][1], -spec["tower"][0]) + math.pi / 4
    pl.matrix_world = (Matrix.Translation((spec["mount"][0] + spec["tower"][0], spec["mount"][1] + spec["tower"][1], 0.0))
                       @ Matrix.Rotation(corner_on, 4, "Z"))

    # 20 hold-down clamps around the opening, each an arm reaching over the booster's skirt.
    clamps = MeshBuilder()
    booster_r = geo["booster"]["radius"]
    for k in range(N_CLAMPS):
        a = 2 * math.pi * (k + 0.5) / N_CLAMPS
        rot = Matrix.Rotation(a, 4, "Z")
        base = rot @ Vector((OPENING_R + 1.3, 0, deck_top + 1.2))
        clamps.add_box(tuple(base), (2.2, 1.1, 2.4), rot)
        tip = rot @ Vector((booster_r + 0.35, 0, pad["mountHeight"] + 0.9))
        clamps.add_beam(tuple(base + Vector((0, 0, 0.8))), tuple(tip), 0.7, 0.9)
    objs.append(clamps.build(pre + "LaunchMount_Clamps", mats.chopstick, parent=root))

    # Booster quick disconnect: a hood on the deck edge facing the tower.
    bqd = MeshBuilder()
    d = Vector((tower_dir.x, tower_dir.y, 0))
    rot = Matrix.Rotation(math.atan2(d.y, d.x), 4, "Z")
    bqd.add_box(tuple(rot @ Vector((booster_r + 2.2, 0, deck_top + 2.5))), (2.6, 4.2, 5.0), rot)
    bqd.add_box(tuple(rot @ Vector((booster_r + 4.6, 0, deck_top + 1.5))), (2.4, 5.4, 3.0), rot)
    objs.append(bqd.build(pre + "BoosterQD", mats.tower, parent=root))

    for o in objs:
        o.matrix_world = to_world
    return objs
