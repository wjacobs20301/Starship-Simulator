"""Starlink V3, as Starship carries it (Flights 14 and 15).

SpaceX hasn't published a drawing of V3, its size or its mass. This follows what is known and
the V2 Mini's layout, scaled to the V3 figures:
- a flat-pack bus (they stack in the payload bay and leave through a slot ~7.5 m x 0.9 m):
  ~7 m long, 3.5 m wide (the most quoted estimates), ~0.3 m thick;
- two solar wings, each 6.36 m x 20.2 m deployed (SpaceX's 2022 FCC filing for the full-size
  satellite), accordion-folded into stacks on the bus's back for launch: ten 2.02 m panels each;
- the Earth-facing side tiled with phased-array antennas (user beams), with two gimballed
  backhaul antennas ("Doppio") under radomes;
- six laser inter-satellite links (Starlink: "six 400-gigabit space lasers"), on the edges;
- an argon Hall thruster at one end; star trackers ("Star Trekker") on the back;
- the back, between the stowed wings, a radiator of mirror tiles; the edges black.

The model holds the bus (node "Bus") and one solar panel ("SolarPanel") and a wing yoke
("Yoke"): the runtime (render/starlink.ts) builds both wings from those and unfolds them.

Axes (Blender): X along the bus (7 m), Y across it (3.5 m), Z out of its back (zenith, away from
the Earth once it's flying). Origin: the middle of the bus.
"""

import math

import numpy as np
from mathutils import Matrix, Vector

from lib import MeshBuilder, empty, fractal_noise, material, normal_from_height, save_image, srgb

BUS_L, BUS_W, BUS_T = 7.0, 3.5, 0.30
PANEL_L, PANEL_W, PANEL_T = 6.36, 2.02, 0.025
PANELS = 10
# The stowed wings: one stack on the bus's back, the other above it.
STACK_T = PANELS * PANEL_T + 0.02


# ---------------------------------------------------------------------------
# Textures (sizes in metres in the comments: UVs are metres / tile size)
# ---------------------------------------------------------------------------


def _grid(h, w, nx, ny):
    """Cell coordinates 0..1 within an nx x ny grid over the image."""
    y = (np.arange(h)[:, None] + 0.5) / h * ny
    x = (np.arange(w)[None, :] + 0.5) / w * nx
    return x - np.floor(x), y - np.floor(y), np.floor(x), np.floor(y)


def make_solar_textures(res=1024):
    """Front of a solar panel, a 1 m tile: 8 x 12 cells (0.125 x 0.083 m) under cover glass, deep
    blue-black, thin silver busbars across each, light gaps between; each cell a little
    different (cells vary in their tint and in how the glass catches the light)."""
    h = w = res
    fx, fy, ix, iy = _grid(h, w, 8, 12)
    gap = (np.minimum(np.minimum(fx, 1 - fx) * 0.125, np.minimum(fy, 1 - fy) * 0.0833) < 0.0016).astype(float)
    # Two busbars across each cell, and fine fingers.
    bus = ((np.abs(fy - 0.33) < 0.012) | (np.abs(fy - 0.67) < 0.012)).astype(float)
    fingers = (np.abs((fx * 40) % 1 - 0.5) < 0.04).astype(float) * 0.25
    rng = np.random.default_rng(5)
    tint = rng.normal(0, 1, (12, 8))[iy.astype(int) % 12, ix.astype(int) % 8]
    n = fractal_noise(h, w, beta=1.6, seed=31)
    base = np.stack([0.012 + 0.002 * tint, 0.016 + 0.003 * tint, 0.042 + 0.006 * tint], axis=-1) * (0.9 + 0.2 * n[..., None])
    silver = np.array([0.42, 0.43, 0.45])
    col = base * (1 - bus[..., None]) + silver * bus[..., None] * 0.8
    col = col * (1 - fingers[..., None]) + silver * fingers[..., None] * 0.35 + col * fingers[..., None] * 0.65
    col = col * (1 - gap[..., None]) + np.array([0.3, 0.31, 0.33]) * gap[..., None]
    rough = 0.16 + 0.06 * n + 0.4 * gap + 0.15 * bus
    height = -0.0008 * gap + 0.0002 * bus
    return (
        save_image("sl_solar_color", srgb(np.clip(col, 0, 1))),
        save_image("sl_solar_normal", normal_from_height(height, 1.0, w / 1.0), non_color=True),
        save_image("sl_solar_rough", np.clip(rough, 0, 1), non_color=True),
    )


def make_panel_back_textures(res=512):
    """Back of a solar panel, a 1 m tile: a white composite face sheet, the honeycomb panel's
    ribs showing faintly every 0.25 m, inserts and a little grime."""
    h = w = res
    fx, fy, _, _ = _grid(h, w, 4, 4)
    rib = (np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) < 0.012).astype(float)
    insert_ = ((np.hypot(fx - 0.5, fy - 0.5) < 0.03)).astype(float)
    n = fractal_noise(h, w, beta=2.0, seed=41)
    v = 0.72 + 0.05 * n - 0.06 * rib - 0.25 * insert_
    col = np.stack([v, v * 0.99, v * 0.96], axis=-1)
    return (
        save_image("sl_back_color", srgb(np.clip(col, 0, 1))),
        save_image("sl_back_normal", normal_from_height(0.0004 * rib, 1.0, w), non_color=True),
        save_image("sl_back_rough", 0.6 + 0.1 * n, non_color=True),
    )


def make_array_textures(res=1024):
    """Phased-array antenna face, a 0.5 m tile: 16 x 16 radiating elements (~3 cm) on a black
    radome, the element patches a little glossier, a seam every tile."""
    h = w = res
    fx, fy, _, _ = _grid(h, w, 16, 16)
    elem = ((np.abs(fx - 0.5) < 0.32) & (np.abs(fy - 0.5) < 0.32)).astype(float)
    # Each element a cross-shaped feed under the radome.
    feed = ((np.abs(fx - 0.5) < 0.05) & (np.abs(fy - 0.5) < 0.22) | (np.abs(fy - 0.5) < 0.05) & (np.abs(fx - 0.5) < 0.22)).astype(float)
    tx, ty, _, _ = _grid(h, w, 1, 1)
    seam = (np.minimum(np.minimum(tx, 1 - tx), np.minimum(ty, 1 - ty)) < 0.004).astype(float)
    n = fractal_noise(h, w, beta=2.0, seed=51)
    v = 0.028 + 0.012 * elem + 0.02 * feed + 0.01 * n - 0.015 * seam
    col = np.stack([v, v, v * 1.05], axis=-1)
    rough = 0.55 - 0.15 * elem + 0.1 * n
    return (
        save_image("sl_array_color", srgb(np.clip(col, 0, 1))),
        save_image("sl_array_normal", normal_from_height(0.0004 * elem - 0.0006 * seam, 1.0, w / 0.5), non_color=True),
        save_image("sl_array_rough", np.clip(rough, 0, 1), non_color=True),
    )


def make_osr_textures(res=512):
    """Radiator of optical solar reflectors, a 0.4 m tile: 10 x 10 mirror tiles 4 cm across,
    each tilted a hair differently (they don't all catch the light alike), dark bond lines."""
    h = w = res
    fx, fy, ix, iy = _grid(h, w, 10, 10)
    line = (np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) < 0.035).astype(float)
    rng = np.random.default_rng(9)
    tilt = rng.normal(0, 1, (10, 10, 2))
    tx = tilt[iy.astype(int), ix.astype(int), 0]
    ty = tilt[iy.astype(int), ix.astype(int), 1]
    height = 0.00015 * (tx * fx + ty * fy) - 0.0003 * line
    v = 0.92 - 0.6 * line
    col = np.stack([v, v, v * 1.01], axis=-1)
    return (
        save_image("sl_osr_color", srgb(np.clip(col, 0, 1))),
        save_image("sl_osr_normal", normal_from_height(height, 1.0, w / 0.4), non_color=True),
        save_image("sl_osr_rough", 0.05 + 0.5 * line, non_color=True),
    )


def make_hull_textures(res=512):
    """The bus's black edges and fittings, a 1 m tile: black anodised panels with rows of
    fasteners and a faint satin sheen."""
    h = w = res
    fx, fy, _, _ = _grid(h, w, 2, 2)
    seam = (np.minimum(np.minimum(fx, 1 - fx), np.minimum(fy, 1 - fy)) < 0.006).astype(float)
    sx, sy, _, _ = _grid(h, w, 20, 2)
    screws = ((np.hypot((sx - 0.5) * 0.05, (np.minimum(sy, 1 - sy)) * 0.5 - 0.02) < 0.004)).astype(float)
    n = fractal_noise(h, w, beta=1.8, seed=61)
    v = 0.035 + 0.01 * n - 0.015 * seam + 0.12 * screws
    col = np.stack([v, v, v], axis=-1)
    return (
        save_image("sl_hull_color", srgb(np.clip(col, 0, 1))),
        save_image("sl_hull_normal", normal_from_height(-0.0005 * seam + 0.0004 * screws, 1.0, w), non_color=True),
        save_image("sl_hull_rough", 0.45 + 0.1 * n, non_color=True),
    )


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------


def chamfer_box(mb, center, size, bevel, uv_size=1.0):
    """A box with its edges chamfered (8 corner planes and 12 edge strips), UVs in metres / uv_size."""
    cx, cy, cz = center
    hx, hy, hz = (s / 2 for s in size)
    b = bevel
    # The box as a convex hull of its chamfered corners: build each face inset by the bevel and
    # the strips / corners between them.
    def p(x, y, z):
        return (cx + x, cy + y, cz + z)

    faces = []
    for axis in range(3):
        for sgn in (-1, 1):
            # Face perpendicular to `axis`, inset by b on the other two.
            a1, a2 = [i for i in range(3) if i != axis]
            half = [hx, hy, hz]
            pts = []
            for s1, s2 in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                v = [0, 0, 0]
                v[axis] = sgn * half[axis]
                v[a1] = s1 * (half[a1] - b)
                v[a2] = s2 * (half[a2] - b)
                pts.append(p(*v))
            if sgn < 0:
                pts.reverse()
            faces.append((pts, (half[a1] * 2, half[a2] * 2)))
    for pts, (w_, h_) in faces:
        mb.add_face(pts, [(0, 0), (w_ / uv_size, 0), (w_ / uv_size, h_ / uv_size), (0, h_ / uv_size)])
    # Edge strips.
    half = [hx, hy, hz]
    for axis in range(3):
        a1, a2 = [i for i in range(3) if i != axis]
        for s1 in (-1, 1):
            for s2 in (-1, 1):
                q = []
                for along in (-1, 1):
                    for which in (0, 1):
                        v = [0, 0, 0]
                        v[axis] = along * (half[axis] - b)
                        if which == 0:
                            v[a1] = s1 * half[a1]
                            v[a2] = s2 * (half[a2] - b)
                        else:
                            v[a1] = s1 * (half[a1] - b)
                            v[a2] = s2 * half[a2]
                        q.append(p(*v))
                quad = [q[0], q[2], q[3], q[1]]
                # Wind outward.
                n = (Vector(quad[1]) - Vector(quad[0])).cross(Vector(quad[2]) - Vector(quad[0]))
                out = Vector(quad[0]) - Vector(center)
                if n.dot(out) < 0:
                    quad.reverse()
                L = 2 * (half[axis] - b)
                mb.add_face(quad, [(0, 0), (L / uv_size, 0), (L / uv_size, b * 1.4 / uv_size), (0, b * 1.4 / uv_size)])
    # Corner triangles.
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                tri = [p(sx * hx, sy * (hy - b), sz * (hz - b)), p(sx * (hx - b), sy * hy, sz * (hz - b)), p(sx * (hx - b), sy * (hy - b), sz * hz)]
                n = (Vector(tri[1]) - Vector(tri[0])).cross(Vector(tri[2]) - Vector(tri[0]))
                if n.dot(Vector((sx, sy, sz))) < 0:
                    tri.reverse()
                mb.add_face(tri, [(0, 0), (b / uv_size, 0), (0, b / uv_size)])


def cylinder(mb, center, radius, length, axis="z", segments=24, cap0=True, cap1=True, uv_size=1.0, r1=None):
    """A (possibly tapered: r1) cylinder along an axis through `center`."""
    c = Vector(center)
    r1 = radius if r1 is None else r1
    if axis == "z":
        m = Matrix.Identity(3)
    elif axis == "x":
        m = Matrix(((0, 0, 1), (0, 1, 0), (-1, 0, 0))).transposed()
    else:
        m = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0))).transposed()
    ring0, ring1 = [], []
    for i in range(segments + 1):
        a = 2 * math.pi * i / segments
        ring0.append(c + m @ Vector((radius * math.cos(a), radius * math.sin(a), -length / 2)))
        ring1.append(c + m @ Vector((r1 * math.cos(a), r1 * math.sin(a), length / 2)))
    circ = 2 * math.pi * radius
    mb.add_grid([ring0, ring1], [[(circ * i / segments / uv_size, 0) for i in range(segments + 1)], [(circ * i / segments / uv_size, length / uv_size) for i in range(segments + 1)]], smooth=True)
    if cap1:
        mb.add_face(ring1[:-1], [(0.5 + 0.5 * math.cos(2 * math.pi * i / segments), 0.5 + 0.5 * math.sin(2 * math.pi * i / segments)) for i in range(segments)])
    if cap0:
        mb.add_face(list(reversed(ring0[:-1])), [(0.5, 0.5)] * segments)


def dome(mb, center, radius, height, segments=24, rings=6, axis_sign=1):
    """A shallow dome (a radome) over a disc of `radius`, bulging `height` along +-Z."""
    c = Vector(center)
    rows, uvs = [], []
    for j in range(rings + 1):
        t = j / rings
        r = radius * math.cos(t * math.pi / 2)
        z = height * math.sin(t * math.pi / 2) * axis_sign
        row = [c + Vector((r * math.cos(2 * math.pi * i / segments), r * math.sin(2 * math.pi * i / segments), z)) for i in range(segments + 1)]
        if axis_sign < 0:
            row.reverse()
        rows.append(row)
        uvs.append([(i / segments, t) for i in range(segments + 1)])
    mb.add_grid(rows, uvs, smooth=True)


def build_starlink_v3():
    hull_m = material("SL_Hull", (1, 1, 1), metallic=0.6, roughness=0.5, textures=make_hull_textures())
    array_m = material("SL_PhasedArray", (1, 1, 1), metallic=0.1, roughness=0.55, textures=make_array_textures())
    osr_m = material("SL_Radiator", (1, 1, 1), metallic=1.0, roughness=0.08, textures=make_osr_textures())
    solar_m = material("SL_SolarCells", (1, 1, 1), metallic=0.0, roughness=0.25, textures=make_solar_textures())
    back_m = material("SL_PanelBack", (1, 1, 1), metallic=0.0, roughness=0.65, textures=make_panel_back_textures())
    radome_m = material("SL_Radome", (0.86, 0.85, 0.82), metallic=0.0, roughness=0.6)
    silver_m = material("SL_Silver", (0.78, 0.79, 0.8), metallic=1.0, roughness=0.25)
    gold_m = material("SL_Kapton", (0.55, 0.38, 0.12), metallic=1.0, roughness=0.35)
    lens_m = material("SL_Lens", (0.02, 0.03, 0.05), metallic=0.5, roughness=0.05)
    dark_m = material("SL_Dark", (0.02, 0.02, 0.02), metallic=0.3, roughness=0.7)
    thruster_m = material("SL_Thruster", (0.25, 0.22, 0.2), metallic=0.9, roughness=0.4)

    root = empty("StarlinkV3")
    bus = empty("Bus", parent=root)

    # --- The bus: a flat slab, chamfered, black edges ---
    mb = MeshBuilder()
    chamfer_box(mb, (0, 0, 0), (BUS_L, BUS_W, BUS_T), 0.04)
    mb.build("BusBody", hull_m, parent=bus)

    zt, zb = BUS_T / 2, -BUS_T / 2

    # --- Earth-facing side: phased arrays, 3 x 2 big tiles, a little proud ---
    mb = MeshBuilder()
    tile_l, tile_w = 2.05, 1.5
    for i in range(3):
        for j in range(2):
            cx = (i - 1) * (tile_l + 0.12)
            cy = (j - 0.5) * (tile_w + 0.12)
            chamfer_box(mb, (cx, cy, zb - 0.012), (tile_l, tile_w, 0.024), 0.008, uv_size=0.5)
    mb.build("PhasedArrays", array_m, parent=bus)

    # Two gimballed backhaul antennas under white radomes, at the ends of the array field.
    mb = MeshBuilder()
    for sx in (-1, 1):
        cylinder(mb, (sx * 3.3, 0, zb - 0.03), 0.24, 0.06, segments=28, cap1=False, uv_size=0.5)
        dome(mb, (sx * 3.3, 0, zb - 0.06), 0.24, 0.17, segments=28, rings=7, axis_sign=-1)
    mb.build("BackhaulRadomes", radome_m, parent=bus)

    # --- The back (zenith): mirror radiator, framed in silver tape ---
    mb = MeshBuilder()
    chamfer_box(mb, (0, 0, zt + 0.004), (BUS_L - 0.3, BUS_W - 0.3, 0.008), 0.003, uv_size=0.4)
    mb.build("Radiator", osr_m, parent=bus)
    mb = MeshBuilder()
    for sy in (-1, 1):
        mb.add_box((0, sy * (BUS_W / 2 - 0.15), zt + 0.006), (BUS_L - 0.3, 0.05, 0.012))
    for sx in (-1, 1):
        mb.add_box((sx * (BUS_L / 2 - 0.15), 0, zt + 0.006), (0.05, BUS_W - 0.3, 0.012))
    mb.build("RadiatorFrame", silver_m, parent=bus)

    # Star trackers: two baffled cameras on the back, canted, near the thruster end.
    mb = MeshBuilder()
    lens = MeshBuilder()
    for sy in (-1, 1):
        c = Vector((-BUS_L / 2 + 0.55, sy * 1.15, zt + 0.12))
        cylinder(mb, c, 0.075, 0.18, segments=20, cap1=False, r1=0.095)
        cylinder(lens, c + Vector((0, 0, 0.06)), 0.07, 0.01, segments=20, cap0=False)
        mb.add_box((c.x, c.y, zt + 0.02), (0.22, 0.22, 0.04))
    mb.build("StarTrackers", hull_m, parent=bus)
    lens.build("StarTrackerLenses", lens_m, parent=bus)

    # --- Six laser links on the long edges: turrets with a dark window, on gold-wrapped mounts ---
    mb = MeshBuilder()
    gold = MeshBuilder()
    win = MeshBuilder()
    for sy in (-1, 1):
        for k, x in enumerate((-2.6, 0.0, 2.6)):
            base = Vector((x, sy * (BUS_W / 2 + 0.12), 0.0))
            gold.add_box((base.x, base.y - sy * 0.04, 0.0), (0.42, 0.2, 0.26))
            cylinder(mb, base + Vector((0, sy * 0.1, 0)), 0.15, 0.2, axis="y", segments=24)
            cylinder(win, base + Vector((0, sy * 0.205, 0)), 0.09, 0.012, axis="y", segments=24)
    mb.build("LaserTerminals", silver_m, parent=bus)
    gold.build("LaserMounts", gold_m, parent=bus)
    win.build("LaserWindows", lens_m, parent=bus)

    # --- Argon Hall thruster at the -X end, on a gimbal: the ring channel and the cathode ---
    mb = MeshBuilder()
    dk = MeshBuilder()
    t = Vector((-BUS_L / 2 - 0.18, 0, 0))
    mb.add_box((t.x + 0.08, 0, 0), (0.16, 0.5, 0.26))
    cylinder(mb, t + Vector((-0.06, 0, 0)), 0.17, 0.14, axis="x", segments=32)
    cylinder(dk, t + Vector((-0.135, 0, 0)), 0.13, 0.01, axis="x", segments=32, cap0=False)
    cylinder(mb, t + Vector((-0.14, 0, 0)), 0.05, 0.02, axis="x", segments=16)
    cylinder(mb, t + Vector((-0.08, 0.22, 0)), 0.025, 0.12, axis="x", segments=12)
    mb.build("HallThruster", thruster_m, parent=bus)
    dk.build("HallThrusterChannel", dark_m, parent=bus)

    # Dispenser fittings at the corners (where the stack is held in the bay), and the wing hinges.
    mb = MeshBuilder()
    for sx in (-1, 1):
        for sy in (-1, 1):
            mb.add_box((sx * (BUS_L / 2 - 0.25), sy * (BUS_W / 2 + 0.03), zt - 0.05), (0.3, 0.08, 0.1))
    for sy in (-1, 1):
        for x in (-2.2, 2.2):
            mb.add_box((x, sy * (BUS_W / 2 + 0.05), zt + 0.03), (0.25, 0.12, 0.08))
    mb.build("Fittings", silver_m, parent=bus)

    # --- One solar panel, the wings' building block: its cells on +Z, its back on -Z.
    # Spans X -PANEL_L/2..PANEL_L/2, Y 0..PANEL_W (its hinge edge on Y = 0), Z 0..PANEL_T.
    panel = empty("SolarPanel", parent=root)
    mb = MeshBuilder()
    mb.add_face([(-PANEL_L / 2, 0, PANEL_T), (PANEL_L / 2, 0, PANEL_T), (PANEL_L / 2, PANEL_W, PANEL_T), (-PANEL_L / 2, PANEL_W, PANEL_T)],
                [(0, 0), (PANEL_L, 0), (PANEL_L, PANEL_W), (0, PANEL_W)])
    mb.build("SolarCells", solar_m, parent=panel)
    mb = MeshBuilder()
    mb.add_face([(-PANEL_L / 2, PANEL_W, 0), (PANEL_L / 2, PANEL_W, 0), (PANEL_L / 2, 0, 0), (-PANEL_L / 2, 0, 0)],
                [(0, PANEL_W), (PANEL_L, PANEL_W), (PANEL_L, 0), (0, 0)])
    # The panel's edges (a thin frame).
    for a, b_ in (((-PANEL_L / 2, 0), (PANEL_L / 2, 0)), ((PANEL_L / 2, 0), (PANEL_L / 2, PANEL_W)),
                  ((PANEL_L / 2, PANEL_W), (-PANEL_L / 2, PANEL_W)), ((-PANEL_L / 2, PANEL_W), (-PANEL_L / 2, 0))):
        L = math.hypot(b_[0] - a[0], b_[1] - a[1])
        mb.add_face([(a[0], a[1], 0), (b_[0], b_[1], 0), (b_[0], b_[1], PANEL_T), (a[0], a[1], PANEL_T)], [(0, 0), (L, 0), (L, PANEL_T), (0, PANEL_T)])
    mb.build("PanelBack", back_m, parent=panel)
    # Hinge brackets on the panel's hinge edge.
    mb = MeshBuilder()
    for x in (-2.4, 0.0, 2.4):
        mb.add_box((x, 0.0, PANEL_T / 2), (0.12, 0.05, PANEL_T + 0.01))
    mb.build("PanelHinges", silver_m, parent=panel)

    # --- The yoke: the boom from the bus's edge to a wing's root (1.1 m), along +Y from the hinge.
    yoke = empty("Yoke", parent=root)
    mb = MeshBuilder()
    for x in (-2.2, 2.2):
        mb.add_beam((x, 0, 0), (x * 0.25, 1.1, 0), 0.07)
    mb.add_beam((-2.6, 1.1, 0), (2.6, 1.1, 0), 0.06)
    mb.build("YokeTruss", silver_m, parent=yoke)
    mb = MeshBuilder()
    cylinder(mb, (0, 1.1, 0), 0.09, 0.3, axis="x", segments=16)
    mb.build("WingDrive", hull_m, parent=yoke)

    # Templates sit apart from the bus in the file (the runtime places them).
    panel.location = (0, 6, 0)
    yoke.location = (0, -6, 0)
    return root


def preview_pose(root):
    """Lay out a deployed satellite for the preview render only (not exported)."""
    import bpy

    panel = bpy.data.objects["SolarPanel"]
    yoke = bpy.data.objects["Yoke"]
    copies = []
    for side in (1, -1):
        rot = Matrix.Rotation(0 if side > 0 else math.pi, 4, "Z")
        y0 = BUS_W / 2 + 0.05
        for k in range(PANELS):
            dup = panel.copy()
            bpy.context.scene.collection.objects.link(dup)
            dup.matrix_world = rot @ Matrix.Translation((0, y0 + 1.1 + k * PANEL_W, 0.0))
            for ch in panel.children:
                c = ch.copy()
                bpy.context.scene.collection.objects.link(c)
                c.parent = dup
            copies.append(dup)
        y = yoke.copy()
        bpy.context.scene.collection.objects.link(y)
        y.matrix_world = rot @ Matrix.Translation((0, y0, 0))
        for ch in yoke.children:
            c = ch.copy()
            bpy.context.scene.collection.objects.link(c)
            c.parent = y
        copies.append(y)
    panel.hide_render = True
    for ch in panel.children:
        ch.hide_render = True
    yoke.hide_render = True
    for ch in yoke.children:
        ch.hide_render = True
    return copies
