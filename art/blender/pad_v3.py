"""Starbase V3 launch mount and flame trench (Pad 2 as built, and Pad 1 as rebuilt to match).

Measured off photographs of Pad 2's mount, finished (none free to reuse: looked at, not copied;
nothing of them is in the model but the shapes and sizes read off them):

  - RGV Aerial Photography's oblique view down on it after a static fire (2026): the whole
    form, the deck and its clamps, the hoods, the tunnel mouth and the diverter in it, the
    aprons either end. The ring the booster stands in, 12.5 m across, to scale by.
  - Starship Gazer's view from the ground straight through the tunnel (2026): the deck's depth,
    the two sides' different slopes, the hoods' height, the pipe along the deck's lip, and
    daylight under the deck down to the diverter's ridge.
  - A view of a booster on it from the other side (Mar 2026).
  - RGV Aerial Photography's views from straight above (2026): where the two hoods stand round
    the opening and which way each points.

with the trench's footprint from OpenStreetMap (85 x 23.5 m). What they show, and what's here:

  Launch mount   NOT two piers and a bridge: one squat pyramid with the trench tunnelling
                 through it. On top a steel deck 23.5 m square and 8 m deep, flat, pale, with
                 the round opening the booster stands in (20 hold-down clamps inside its rim).
                 Either side of the tunnel a wall 3 m thick whose ends run down to the ground
                 14 m out along the trench, at 50 deg: the pyramid's ribs. The side away from
                 the tower is a slope of steel plate (62 deg) down to the ground; the tower's
                 side is all but sheer. Along the deck's lip over each tunnel mouth, a pipe a
                 metre through.
  Hoods          two boxed ducts (the booster's propellant and power connections), each straight
                 out from the opening's rim like a spoke, 4.4 m wide: one 5 deg off square to
                 the plated side, out over the deck's edge and down onto the slope; the other
                 70 deg round toward the far tunnel mouth, out over the deck's lip there and
                 down in front of it to the soffit. A bare steel cabin at the rim, 4.6 m tall,
                 then a pale roof falling outward to an eave, and a pale wall hanging below it.
                 (The angles off two views from straight above, which give -3 and 65 deg and
                 11 and 80: tall things lean in such views. From the ground along the trench
                 the first is nine metres across and the second seven or eight, as boxes of
                 that width turned so would be.)
  Flame trench   a pit 6 m deep under the mount, its floor ramping back up to grade both ways;
                 the far end's slab rises on above grade. A tall wing wall beside the mouth on
                 the tower's side, tapering away; low kerbs elsewhere.
  Flame diverter two-sided, of water-cooled steel tubes laid DOWN the slope: from a ridge under
                 the middle of the booster, 4 m above grade (daylight shows over it, through
                 the tunnel), down a hollow curve either way to the pit's floor 20 m out.
  Tower plinth   a wide concrete base with sloped sides.

Deck height matches the sim's PAD.mountHeight. Sizes are scaled from the photos: approx (10%).

Local frame for a pad: origin at the mount center on the ground, X along the trench axis,
Y across it, Z up. Everything is rotated into the pad's east/north frame at the end.
"""

import math

from mathutils import Matrix, Vector

from lib import MeshBuilder

DECK_HALF = 11.75  # the deck, half its side (the trench's outer width, OSM)
DECK_DEPTH = 8.0  # its depth: the tunnel's soffit below its top
RIB = 3.15  # the tunnel's side walls' thickness (the channel between them 17.2 m)
MOUTH_RUN = 14.3  # their sloped ends' feet, out along the trench from the deck's edge
FLANK_RUN = 9.0  # the plated slope's foot, out from the deck's edge (away from the tower)
BACK_RUN = 1.5  # the tower side's (all but sheer)
OPENING_R = 6.25  # the opening in the deck (the booster's 4.5 m and the clamps round it)
RIDGE = 3.6  # the diverter's ridge above grade
FOOT = 20.6  # its feet, out along the trench
RAMP_END = 38.0  # where the pit's floor is back up at grade
FAR_RISE = 1.2  # the far slab's end above grade
PLINTH_BASE = 26.0  # tower plinth, square at the ground, m
PLINTH_TOP = 17.5  # ... at its top (the tower's width), m
PLINTH_H = 7.0
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


def _convex(mb, faces, uv_size=3.0):
    """A convex solid from its faces (each a list of points, any winding): every face is turned
    to look away from the solid's middle."""
    pts = [Vector(p) for f in faces for p in f]
    mid = sum(pts, Vector((0, 0, 0))) / len(pts)
    for f in faces:
        f = [Vector(p) for p in f]
        n = (f[1] - f[0]).cross(f[2] - f[0])
        if n.dot(f[0] - mid) < 0:
            f.reverse()
            n = -n
        n.normalize()
        u = (f[1] - f[0]).normalized()
        v = n.cross(u)
        mb.add_face(f, [((q - f[0]).dot(u) / uv_size, (q - f[0]).dot(v) / uv_size) for q in f])


def _slab(mb, profile, y0, y1):
    """A convex outline in the XZ plane (points (x, z)) made a slab from y0 to y1."""
    a = [(x, y0, z) for x, z in profile]
    b = [(x, y1, z) for x, z in profile]
    n = len(profile)
    _convex(mb, [a, b] + [[a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]] for i in range(n)])


def _joints(mb, a, b, c, d, pitch_u=2.6, pitch_v=1.8, w=0.07):
    """The joints between the plates on a flat four-sided face (corners a, b along its foot, d, c
    above them): thin dark strips standing a finger proud of it, courses along it and staggered
    uprights between them."""
    a, b, c, d = (Vector(p) for p in (a, b, c, d))
    n = (b - a).cross(d - a).normalized()
    rows = max(2, round((d - a).length / pitch_v))

    def strip(p, q):
        along = (q - p).normalized()
        side = n.cross(along) * (w / 2)
        lift = n * 0.02
        pts = [p - side + lift, q - side + lift, q + side + lift, p + side + lift]
        mb.add_face(pts, [(0, 0), (1, 0), (1, 1), (0, 1)])
        mb.add_face(list(reversed(pts)), [(0, 0), (1, 0), (1, 1), (0, 1)])

    for i in range(1, rows):
        strip(a.lerp(d, i / rows), b.lerp(c, i / rows))
    for i in range(rows):
        p0, q0 = a.lerp(d, i / rows), b.lerp(c, i / rows)
        p1, q1 = a.lerp(d, (i + 1) / rows), b.lerp(c, (i + 1) / rows)
        cols = max(1, round((q0 - p0).length / pitch_u))
        for j in range(1, cols + (i % 2)):
            f = (j - 0.5 * (i % 2)) / cols
            strip(p0.lerp(q0, f), p1.lerp(q1, f))


def build_v3_pad(root, mats, geo, spec):
    """spec: {prefix, mount: [east, north], tower: [east, north] (relative to the mount), trench}."""
    pre = spec["prefix"]
    tr = spec["trench"]
    pad = geo["pad"]
    L, D = tr["length"], tr["depth"]
    deck_top = pad["mountHeight"] - 1.0  # the booster sits on the clamps, ~1 m above the plate
    soffit = deck_top - DECK_DEPTH
    to_world = Matrix.Translation((spec["mount"][0], spec["mount"][1], 0.0)) @ Matrix.Rotation(math.radians(tr["axisDeg"]), 4, "Z")
    # The tower's side of the trench (the mount's all but sheer side), and the other, where the
    # plated slope and the hoods are. The tunnel mouth at -X is the one nearer the tower.
    tower_local = to_world.to_3x3().inverted() @ Vector((spec["tower"][0], spec["tower"][1], 0.0))
    st = 1 if tower_local.y > 0 else -1
    if tower_local.x > 0:
        to_world = to_world @ Matrix.Rotation(math.pi, 4, "Z")
        st = -st
    sh = -st
    h, half = DECK_HALF, L / 2
    yc = h - RIB  # the channel's half-width
    xr = h + MOUTH_RUN  # the ribs' feet

    def floor(x):
        """The channel's floor along the trench: the diverter's hollow slopes, the pit, the ramps."""
        ax = abs(x)
        if ax <= FOOT:
            return -D + (RIDGE + D) * (1 - ax / FOOT) ** 1.8
        if x > 0:
            return -D + (D + FAR_RISE) * min(1.0, (ax - FOOT) / (half - FOOT))
        return -D + (D - 0.3) * min(1.0, (ax - FOOT) / (RAMP_END - FOOT))

    objs = []

    # --- Flame trench: the pit's floor and ramps ------------------------------------
    lining = MeshBuilder()  # steel plate at the diverter's feet
    apron = MeshBuilder()  # concrete beyond
    for mb, x0, x1 in ((lining, FOOT, FOOT + 7.0), (apron, FOOT + 7.0, half)):
        for sx in (-1, 1):
            xs = [sx * (x0 + (x1 - x0) * k / 6) for k in range(7)]
            rows = [[(x, -yc * sx, floor(x)) for x in xs], [(x, yc * sx, floor(x)) for x in xs]]
            mb.add_grid(rows, [[(x / 4, -yc / 4) for x in xs], [(x / 4, yc / 4) for x in xs]], smooth=False)
    # (The far slab's end, standing above grade.)
    apron.add_box((half - 0.15, 0, FAR_RISE / 2), (0.3, 2 * yc, FAR_RISE))
    objs.append(lining.build(pre + "Trench_Lining", mats.trench_steel, parent=root))

    # --- Flame diverter: tubes laid down the slope, either way from the ridge --------
    bucket = MeshBuilder()
    pitch = 0.45
    ny = round(2 * yc / pitch)
    ys = []
    for k in range(ny):
        y = -yc + 2 * yc * k / ny
        ys += [(y, 0.0), (y + yc / ny, 0.16)]
    ys.append((yc, 0.0))
    for sx in (-1, 1):
        xs = [sx * FOOT * (k / 14) ** 1.3 for k in range(15)]
        rows = [[(x, -y * sx, floor(x) + up) for y, up in ys] for x in xs]
        bucket.add_grid(rows, [[(x / 2, y / 2) for y, _ in ys] for x in xs], smooth=False)
    objs.append(bucket.build(pre + "FlameDiverter", mats.diverter, parent=root))
    cap = MeshBuilder()
    _pipe(cap, (0, -yc, RIDGE + 0.1), (0, yc, RIDGE + 0.1), 0.45, 12)
    objs.append(cap.build(pre + "Diverter_RidgeCap", mats.trench_steel, parent=root))

    # --- The mount's concrete: the tunnel's side walls and their ribs, the pit's walls,
    # the wing walls and kerbs, the tower's side ---------------------------------------
    walls = MeshBuilder()
    for sy in (-1, 1):
        y0, y1 = sorted((sy * yc, sy * h))
        # The pit's wall, from its floor up to a kerb at grade.
        _slab(walls, [(-half, -D - 0.4), (half, -D - 0.4), (half, 0.3), (-half, 0.3)], y0, y1)
        # The tunnel's side wall: up to the deck, its ends sloping down to the ground.
        _slab(walls, [(-xr, 0.3), (xr, 0.3), (h, deck_top - 0.06), (-h, deck_top - 0.06)], y0, y1)
        if sy == st:
            # The tall wing wall beside the mouth on the tower's side, tapering away; a lower
            # one along the far slab.
            _slab(walls, [(-half + 1.5, 0.3), (-xr + 4.0, 0.3), (-xr + 7.0, 8.4), (-half + 1.5, 1.2)], y0, y1)
            _slab(walls, [(xr - 4.0, 0.3), (half, 0.3), (half, FAR_RISE + 0.5), (xr - 4.0, 4.6)], y0, y1)
        else:
            _slab(walls, [(xr - 2.0, 0.3), (half, 0.3), (half, FAR_RISE + 0.5), (xr - 2.0, FAR_RISE + 0.5)], y0, y1)
    # The tower's side: all but sheer.
    yb = st * (h + BACK_RUN)
    t1, t2 = (-h, st * h, deck_top - 0.06), (h, st * h, deck_top - 0.06)
    b1, b2, b3, b4 = (-xr, st * h, 0.0), (xr, st * h, 0.0), (xr, yb, 0.0), (-xr, yb, 0.0)
    _convex(walls, [[t1, t2, b3, b4], [t1, b4, b1], [t2, b2, b3], [b1, b2, b3, b4]])
    walls_obj = walls.build(pre + "LaunchMount_Concrete", mats.mount_concrete, parent=root)
    objs.append(walls_obj)
    objs.append(apron.build(pre + "Trench_Caps", mats.concrete, parent=root))

    # --- The plated slope away from the tower, its plates' joints, its doors and vents ---
    yf = sh * (h + FLANK_RUN)
    t1, t2 = Vector((-h, sh * h, deck_top - 0.06)), Vector((h, sh * h, deck_top - 0.06))
    b1, b2, b3, b4 = Vector((-xr, sh * h, 0.0)), Vector((xr, sh * h, 0.0)), Vector((xr, yf, 0.0)), Vector((-xr, yf, 0.0))
    clad = MeshBuilder()
    _convex(clad, [[t1, t2, b3, b4], [t1, b4, b1], [t2, b2, b3], [b1, b2, b3, b4]])
    joints = MeshBuilder()
    _joints(joints, b4, b3, t2, t1)
    for sx, (ba, bb, tt) in ((-1, (b1, b4, t1)), (1, (b3, b2, t2))):
        _joints(joints, ba, bb, tt, tt, pitch_u=2.4)

    def on_slope(x, up):
        """A point on the slope: x along the trench, `up` its height."""
        return Vector((x, sh * (h + FLANK_RUN * (1 - up / (deck_top - 0.06))), up))

    white = MeshBuilder()
    for x, up in ((-15.0, 3.2), (-7.5, 9.5), (8.0, 9.0), (15.5, 3.4), (2.0, 4.6)):
        p = on_slope(x, up)
        clad.add_box(p + Vector((0, sh * 0.7, 0.2)), (2.2, 2.0, 1.7))
        white.add_box(p + Vector((0, sh * 0.9, 1.15)), (2.5, 2.6, 0.12), Matrix.Rotation(sh * -0.5, 4, "X"))
    dark = MeshBuilder()
    for x in (-19.5, 11.0):
        clad.add_box((x, yf - sh * 1.5, 1.9), (3.8, 3.0, 3.8))
        dark.add_box((x, yf + sh * 0.03, 1.7), (3.0, 0.1, 3.2))
    objs.append(joints.build(pre + "LaunchMount_Joints", mats.tower, parent=root))

    # --- The deck: a steel box with the round opening, the pipe along its lip over each
    # tunnel mouth ----------------------------------------------------------------------
    table = MeshBuilder()
    _ring_deck(table, h, OPENING_R, soffit, deck_top)
    objs.append(table.build(pre + "LaunchTable", mats.tower_light, parent=root))
    pipes = MeshBuilder()
    for sx in (-1, 1):
        x = sx * (h + 0.6)
        y_end = sh * (3.0 if sx > 0 else yc + 1.0)  # (the far mouth's runs into the hood there)
        _pipe(pipes, (x, st * (yc + 1.0), deck_top - 0.7), (x, y_end, deck_top - 0.7), 0.5, 14)
        _pipe(pipes, (x, st * (yc + 1.0), deck_top - 0.7), (x, st * (yc + 1.0), soffit - 2.5), 0.5, 14)
        pipes.add_box((x, y_end, deck_top - 0.7), (0.95, 0.12, 0.95))
        for y in (st * 6.0, st * 1.5, sh * 1.7):
            pipes.add_box((sx * (h + 0.25), y, deck_top - 0.7), (0.5, 0.5, 1.5))
    objs.append(pipes.build(pre + "LaunchMount_Manifold", mats.diverter, parent=root))

    # --- The hoods: two boxed ducts, each straight out from the opening's rim like a spoke.
    # One near the middle of the plated side, out over the deck's edge and down onto the slope;
    # the other round toward the far tunnel mouth, out over the deck's lip there and down in
    # front of it to the soffit. At the rim a bare steel cabin as tall as a house, with a door;
    # from its roof a pale roof falling outward to an eave at deck level, and under the eave a
    # pale wall hanging down the mount's side. --------------------------------------------
    for ang, edge, z_end in ((5.0, h / math.cos(math.radians(5.0)), deck_top - 9.5), (70.0, h / math.sin(math.radians(70.0)), soffit - 0.2)):
        # (Its own frame: u out from the mount's middle, v across the duct.)
        a = math.radians(ang)
        out, across = Vector((math.sin(a), sh * math.cos(a), 0.0)), Vector((math.cos(a), -sh * math.sin(a), 0.0))
        top = deck_top + 4.6
        r0, r1, r2 = OPENING_R + 0.35, OPENING_R + 4.1, edge + 3.6
        w = 2.2

        def duct(mb, prof, half_w):
            lo = [out * r + across * -half_w + Vector((0, 0, z)) for r, z in prof]
            hi = [out * r + across * half_w + Vector((0, 0, z)) for r, z in prof]
            n = len(prof)
            _convex(mb, [lo, hi] + [[lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i]] for i in range(n)])

        duct(clad, [(r0, deck_top - 0.2), (r0, top), (r1, top), (r1, deck_top - 0.2)], w)
        # (The pale part is wider than the cabin: six metres to its 4.4.)
        duct(white, [(r1, deck_top - 0.2), (r1, top), (r2, deck_top + 0.3), (r2, deck_top - 0.2)], w + 0.8)
        duct(white, [(edge - 0.6, z_end), (edge - 0.6, deck_top + 0.28), (r2, deck_top + 0.28), (r2, z_end)], w + 0.78)
        # (The cabin's door, on its side toward the other hood.)
        side = -1 if ang < 30 else 1
        door = out * (r0 + 1.9) + across * (side * (w + 0.03)) + Vector((0, 0, deck_top + 1.1))
        dark.add_box(door, (1.0, 0.08, 2.1), Matrix.Rotation(math.atan2(out.y, out.x), 4, "Z"))
    objs.append(dark.build(pre + "LaunchMount_Openings", mats.dark, parent=root))
    objs.append(clad.build(pre + "LaunchMount_Cladding", mats.tower_light, parent=root))
    objs.append(white.build(pre + "LaunchMount_Covers", mats.tank_white, parent=root))

    # Tower plinth: a wide concrete base with sloped sides, square to the tower (which stands
    # with a corner toward the mount, see tower_kit.py).
    plinth = MeshBuilder()
    b, tp = PLINTH_BASE / 2, PLINTH_TOP / 2
    _frustum(plinth, (-b, b, -b, b), (-tp, tp, -tp, tp), 0.0, PLINTH_H)
    pl = plinth.build(pre + "Tower_Plinth", mats.mount_concrete, parent=root)
    corner_on = math.atan2(-spec["tower"][1], -spec["tower"][0]) + math.pi / 4
    pl.matrix_world = (Matrix.Translation((spec["mount"][0] + spec["tower"][0], spec["mount"][1] + spec["tower"][1], 0.0))
                       @ Matrix.Rotation(corner_on, 4, "Z"))

    # 20 hold-down clamps inside the opening's rim: a housing each, set into the deck, and an
    # arm reaching in under the booster's skirt.
    housings = MeshBuilder()
    clamps = MeshBuilder()
    booster_r = geo["booster"]["radius"]
    for k in range(N_CLAMPS):
        rot = Matrix.Rotation(2 * math.pi * (k + 0.5) / N_CLAMPS, 4, "Z")
        housings.add_box(tuple(rot @ Vector((OPENING_R - 0.75, 0, deck_top - 0.55))), (1.5, 1.35, 1.9), rot)
        clamps.add_beam(tuple(rot @ Vector((OPENING_R - 1.0, 0, deck_top + 0.2))), tuple(rot @ Vector((booster_r + 0.3, 0, pad["mountHeight"] + 0.5))), 0.7, 0.8)
    objs.append(housings.build(pre + "LaunchMount_ClampHousings", mats.tower_light, parent=root))
    objs.append(clamps.build(pre + "LaunchMount_Clamps", mats.chopstick, parent=root))

    for o in objs:
        o.matrix_world = to_world
    return objs
