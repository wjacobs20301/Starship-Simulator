"""The towers' catch arms ("chopsticks"), the carriage they hang from, the tower's lattice and the
ship quick-disconnect arm, as built.

The print kit's (tower_kit.py's source) are a toy's: arms half as long as the real ones, a deep
triangle of truss with a leg hanging off the tip, both on one hinge so a cranked pulley can lift
a model; a lattice of doubled columns and heavy crossed braces; a slim curved boom for the
quick-disconnect arm. What's built here is measured off photographs (all Wikimedia Commons):

  - "Starship 5 Booster Landing on Mechzilla.jpg" (Jurvetson, CC BY 2.0): a long-lens view from
    across the bay, square to the arms, with a booster hanging in them. No perspective to speak
    of, and the booster's 9 m to scale by: the source of every height and depth here.
  - "Tower-OLM.jpg" and "Tower and Booster.jpg" (Hautmann, CC BY-SA 4.0): the tower close up,
    the lattice's pattern, the arms and the quick-disconnect arm from below.
  - "SpaceX Starbase integration tower quick disconnect arm.jpg" (Hautmann, CC BY-SA 4.0): the
    quick-disconnect arm's head.
  - "SpaceX Starbase Launch Site Early 2026.jpg" (NOAA, public domain): both towers from above:
    the arms' plan, the roof.

What they show, and what's here:

  - The arms are two straight box trusses, each on its OWN hinge on the carriage (the hinges
    about eleven metres apart), parallel when shut, either side of the vehicle. Deep: 6.6 m at
    the root, 6 m at the tip, all the way out; the top flat, the tip raked back underneath.
    The landing rail runs along the inner top edge (pale: the rest is near black).
  - Each arm is propped from far below: a kicker strut from a lower hinge 20 m under the arm's
    top, on the carriage's foot, up to the bottom chords nine metres out.
  - The carriage is as tall as that (21 m), wrapped round the tower's corner toward the mount,
    riding that corner's column and its two neighbours.
  - The tower: one square column at each corner, a beam round it every 7 m, one diagonal per bay
    on each face, zig-zagging up; a lift shaft and a stair up the middle; a flat open roof.
  - The quick-disconnect arm is nearly as long as a catch arm: a truss 5.5 m deep from a hinge on
    the tower's side column, propped by its own kicker, a walkway and the propellant lines along
    its top, and at its end a head with the plate on a short boom.

Nothing is published: every size is scaled from those photos and approximate (within ~10%).
"""

import math

from mathutils import Matrix, Vector

from lib import MeshBuilder

# --- The catch arms ------------------------------------------------------------------------------
RAIL_TOP = 1.87  # top of the landing rail above the hinge point (sim ARMS.homeTop is built on it)
RAIL_W = 0.95  # the rail's width
# The hinges' offset either side of the centre line, and the rail's inner edge in from its hinge.
# With the arms shut the rails' inner edges stand 4.5 m off the centre line: on a 9 m hull. The
# colliders (scripts/export-pad-colliders.ts: cells of 0.75 m, each a column 0.4 m in radius)
# stop the arms a fraction of a degree short of that, and the rail then lies 4.6 to 5.6 m out:
# under the booster's catch pins and the ship's (both 5.0 to 5.2 m out). Nothing on an arm may
# reach further in than the rail does, or the arms stop on that instead and the pins miss.
HINGE_X = 5.6
RAIL_IN = 1.10
CHORD = 0.5  # the truss's chords (square tube)
WEB = 0.3  # its posts and diagonals
X_IN = -0.80  # the inner chords' centre line (the vehicle's side), from the hinge
X_OUT = 1.90  # the outer chords'
DEPTH_ROOT = 6.6  # the truss's depth at the root, top of rail to bottom chord
DEPTH_TIP = 6.0  # and at the tip
ROOT = 1.6  # where the truss starts, out from the hinge
PANEL = 3.9  # a panel's length (about)
TIP_RAKE = 1.8  # how far the bottom chord stops short of the tip
KICKER_DROP = 17.6  # the lower hinge below the hinge point
KICKER_OUT = 9.0  # where the kicker struts meet the bottom chords, out from the hinge


def _octagon(r, cx=0.0, cy=0.0):
    return [(cx + r * math.cos(2 * math.pi * (k + 0.5) / 8), cy + r * math.sin(2 * math.pi * (k + 0.5) / 8)) for k in range(8)]


def _tube(mb, p0, p1, r, sides=10):
    """A round tube between two points."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    if d.length < 1e-6:
        return
    m = Matrix.Translation(p0) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    mb.add_prism([(r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides)) for k in range(sides)], 0.0, d.length, matrix=m)


def _handrail(mb, p0, p1, height=1.1, pitch=2.0):
    """A handrail between two points: posts, a top rail and a mid rail."""
    p0, p1 = Vector(p0), Vector(p1)
    n = max(1, round((p1 - p0).length / pitch))
    up = Vector((0, 0, 1))
    for k in range(n + 1):
        p = p0 + (p1 - p0) * (k / n)
        mb.add_beam(p, p + up * height, 0.07)
    mb.add_beam(p0 + up * height, p1 + up * height, 0.07)
    mb.add_beam(p0 + up * height * 0.55, p1 + up * height * 0.55, 0.05)


def build_arm(length, hang_at):
    """One arm (the right-hand one, shut), `length` from its hinge to its tip, the vehicle hanging
    `hang_at` out from the hinge. Returns (steel, rail): the truss, and the landing rail's pale
    top, each a MeshBuilder.

    Local frame: the origin at this arm's hinge, +Y from the tower toward the vehicle, +X away
    from the vehicle (the left arm is the mirror), +Z up."""
    mb = MeshBuilder()
    rail = MeshBuilder()
    girder = 0.9  # the rail girder's depth (the inner top chord)
    zt = RAIL_TOP - 0.6  # the outer top chord's centre line
    n = max(5, round((length - ROOT) / PANEL))
    ys = [ROOT + (length - ROOT) * k / n for k in range(n + 1)]

    def zb(y):
        """The bottom chords' centre line at y (rising a little toward the tip)."""
        f = (y - ROOT) / (length - ROOT)
        return RAIL_TOP - (DEPTH_ROOT + (DEPTH_TIP - DEPTH_ROOT) * f) + CHORD / 2

    # The bottom chords stop short at the tip: the last frame is raked.
    yb = ys[:-1] + [length - TIP_RAKE]

    # The landing rail: a heavy girder along the inner top edge, its top the pale wearing surface
    # the pins come down on.
    x_rail = -RAIL_IN + RAIL_W / 2
    mb.add_box((x_rail, (ROOT + length) / 2, RAIL_TOP - 0.12 - (girder - 0.12) / 2), (RAIL_W, length - ROOT, girder - 0.12))
    rail.add_box((x_rail, (ROOT + 0.4 + length - 0.3) / 2, RAIL_TOP - 0.06), (RAIL_W, length - ROOT - 0.7, 0.12))
    # The other three chords.
    mb.add_beam((X_OUT, ys[0], zt), (X_OUT, ys[-1], zt), CHORD + 0.05)
    for x in (X_IN, X_OUT):
        mb.add_beam((x, yb[0], zb(yb[0])), (x, yb[-1], zb(yb[-1])), CHORD)
    # A frame at every node; a diagonal in every panel of all four faces (a W along each side).
    top_in = RAIL_TOP - girder  # under the rail girder
    for k in range(n + 1):
        yt_, yb_ = ys[k], yb[k]
        mb.add_beam((X_IN, yt_, top_in), (X_IN, yb_, zb(yb_)), WEB)
        mb.add_beam((X_OUT, yt_, zt), (X_OUT, yb_, zb(yb_)), WEB)
        mb.add_beam((X_IN, yt_, zt), (X_OUT, yt_, zt), WEB)
        mb.add_beam((X_IN, yb_, zb(yb_)), (X_OUT, yb_, zb(yb_)), WEB)
        if k == n:
            break
        y1t, y1b = ys[k + 1], yb[k + 1]
        if k % 2 == 0:
            mb.add_beam((X_IN, yt_, top_in), (X_IN, y1b, zb(y1b)), WEB)
            mb.add_beam((X_OUT, yt_, zt), (X_OUT, y1b, zb(y1b)), WEB)
        else:
            mb.add_beam((X_IN, yb_, zb(yb_)), (X_IN, y1t, top_in), WEB)
            mb.add_beam((X_OUT, yb_, zb(yb_)), (X_OUT, y1t, zt), WEB)
        xa, xb = (X_IN, X_OUT) if k % 2 == 0 else (X_OUT, X_IN)
        mb.add_beam((xa, yt_, zt), (xb, y1t, zt), WEB * 0.75)
        mb.add_beam((xb, yb_, zb(yb_)), (xa, y1b, zb(y1b)), WEB * 0.75)
    # The tip: a plate across the raked end frame, a bumper on the rail's end.
    mb.add_beam((X_IN, ys[-1], zt), (X_OUT, ys[-1], zt), CHORD)
    mb.add_box((x_rail, length - 0.15, RAIL_TOP - 0.55), (RAIL_W, 0.3, 1.1))

    # The walkway along the top, beside the rail (below it: a catch fin's underside passes a hand
    # above the rail, right across the arm), with a handrail on the outer edge clear of where a
    # vehicle hangs.
    deck = zt + CHORD / 2
    mb.add_box(((x_rail + RAIL_W / 2 + X_OUT) / 2 + 0.1, (ys[0] + ys[-1]) / 2, deck + 0.04), (X_OUT - x_rail - RAIL_W / 2 - 0.1, ys[-1] - ys[0], 0.08))
    for a, b in ((ys[0] + 0.3, hang_at - 6.5), (hang_at + 6.5, ys[-1] - 0.3)):
        if b - a > 2.0:
            # (Folded flat, as they are for a catch: a low kerb rail only.)
            mb.add_beam((X_OUT + 0.2, a, deck + 0.2), (X_OUT + 0.2, b, deck + 0.2), 0.1)
            for k in range(round((b - a) / 2.0) + 1):
                y = a + (b - a) * k / max(1, round((b - a) / 2.0))
                mb.add_beam((X_OUT + 0.2, y, deck), (X_OUT + 0.2, y, deck + 0.2), 0.08)

    # The root: the upper hinge's lugs, out from the pin to the first frame, top and bottom of it.
    z_low = zb(ys[0])
    mb.add_prism(_octagon(0.62), z_low - 0.5, RAIL_TOP - 0.25)
    for z in (zt, (zt + z_low) / 2, z_low):
        mb.add_beam((0.0, 0.2, z), (X_IN, ys[0], z), CHORD)
        mb.add_beam((0.0, 0.2, z), (X_OUT, ys[0], z), CHORD)
    mb.add_beam((X_IN, ys[0], zt), (X_OUT, ys[0], z_low), WEB)
    mb.add_beam((X_OUT, ys[0], zt), (X_IN, ys[0], z_low), WEB)
    # The lug the swing cylinder pushes on, outboard.
    mb.add_box((X_OUT + 0.7, ys[0] + 1.6, (zt + z_low) / 2), (0.9, 1.2, 1.6))
    mb.add_beam((X_OUT, ys[0], (zt + z_low) / 2), (X_OUT + 0.7, ys[0] + 1.6, (zt + z_low) / 2), 0.4)

    # The kicker: from the lower hinge, on the carriage's foot far below, two struts up to the
    # bottom chords (plain in every photo of the arms from the side), and a tie up to the root.
    kk = min(range(n + 1), key=lambda k: abs(yb[k] - KICKER_OUT))
    yk = yb[kk]
    foot = (0.0, 0.25, -KICKER_DROP)
    mb.add_prism(_octagon(0.55), -KICKER_DROP - 0.7, -KICKER_DROP + 0.7)
    for x in (X_IN, X_OUT):
        mb.add_beam(foot, (x, yk, zb(yk)), 0.62)
    mb.add_beam(foot, (0.0, 0.2, z_low), 0.45)
    # (Bracing between the two struts, and from them up to the chords' first nodes.)
    for f in (0.35, 0.7):
        pa = Vector(foot).lerp(Vector((X_IN, yk, zb(yk))), f)
        pb = Vector(foot).lerp(Vector((X_OUT, yk, zb(yk))), f)
        mb.add_beam(pa, pb, 0.26)
    mid = Vector(foot).lerp(Vector(((X_IN + X_OUT) / 2, yk, zb(yk))), 0.5)
    mb.add_beam(mid, ((X_IN + X_OUT) / 2, yb[1], zb(yb[1])), 0.3)

    # The stabilizer under the arm where the vehicle hangs: a V of struts down from the inner
    # bottom chord to a pad that steadies the hull.
    ys_ = min(max(hang_at, ys[0] + 4.0), yb[-1] - 4.0)
    zs = zb(ys_) - CHORD / 2
    apex = (X_IN + 0.1, ys_, zs - 4.2)
    mb.add_beam((X_IN + 0.1, ys_ - 2.6, zs), apex, 0.3)
    mb.add_beam((X_IN + 0.1, ys_ + 2.6, zs), apex, 0.3)
    mb.add_box((X_IN + 0.1, ys_, zs - 4.3), (0.55, 1.0, 0.5))
    return mb, rail


def build_carriage(col_r, corner_d):
    """The carriage: the frame the arms hinge on, wrapped round the tower's corner toward the
    vehicle. A front truss between the two hinges, as tall as the arms' kickers are long; a side
    truss from each hinge back along the tower's face to the next column; skates on that column,
    on the far one and on the corner's own; a deck on top.

    In the carriage's frame: the origin midway between the hinges, +Y toward the vehicle, +Z up.
    `corner_d`: the tower's centre behind the origin; `col_r`: its columns' centres out from
    that centre."""
    mb = MeshBuilder()
    z1 = RAIL_TOP - 0.5  # the top level (under the rails' top)
    z0 = -KICKER_DROP - 0.4
    levels = [z1, z1 - 6.3, z0 + 6.3, z0]
    yf = -1.0  # the front truss's plane, behind the hinges
    hx = HINGE_X
    # The hinge posts, and the pins' brackets top and bottom.
    for sx in (-1, 1):
        mb.add_beam((sx * hx, yf, z0 - 0.5), (sx * hx, yf, z1 + 0.3), 0.95)
        for z in (z1 - 0.5, -KICKER_DROP):
            mb.add_box((sx * hx, yf / 2, z), (1.5, abs(yf) + 0.9, 0.5))
    # The front truss between them.
    for z in levels:
        mb.add_beam((-hx, yf, z), (hx, yf, z), 0.6)
    for i in range(len(levels) - 1):
        a, b = levels[i], levels[i + 1]
        mb.add_beam((0.0, yf, a), (0.0, yf, b), 0.4)
        for sx in (-1, 1):
            lo, hi = (0.0, sx * hx) if i % 2 == 0 else (sx * hx, 0.0)
            mb.add_beam((lo, yf, a), (hi, yf, b), 0.36)
    # The side trusses: from each hinge post back to stand off the side column.
    side_col = Vector((col_r, -corner_d, 0.0))
    for sx in (-1, 1):
        a = Vector((sx * hx, yf, 0.0))
        b = Vector((sx * (side_col.x + 1.7), side_col.y + 0.5, 0.0))
        for z in levels:
            mb.add_beam(a + Vector((0, 0, z)), b + Vector((0, 0, z)), 0.5)
        nb = 2
        for k in range(1, nb + 1):
            p = a.lerp(b, k / nb)
            mb.add_beam(p + Vector((0, 0, z0)), p + Vector((0, 0, z1)), 0.42)
        for i in range(len(levels) - 1):
            for k in range(nb):
                p, q = a.lerp(b, k / nb), a.lerp(b, (k + 1) / nb)
                lo, hi = (levels[i], levels[i + 1]) if (i + k) % 2 == 0 else (levels[i + 1], levels[i])
                mb.add_beam(p + Vector((0, 0, lo)), q + Vector((0, 0, hi)), 0.3)
        # Skates on the side column's rail (on its face toward the vehicle), top and bottom, and
        # the arms out to them.
        q = math.sqrt(0.5)
        turn = Matrix.Rotation(sx * math.pi / 4, 3, "Z")
        for z in (z1 - 1.0, z0 + 1.0):
            skate = Vector((sx * (side_col.x + 1.45 * q), side_col.y + 1.45 * q, z))
            mb.add_box(skate, (1.6, 1.1, 1.8), turn)
            mb.add_beam(b + Vector((0, 0, z)), skate, 0.5)
    # Skates on the corner's own column (on both its faces toward the vehicle), off the front truss.
    front_col_y = -corner_d + col_r
    q = math.sqrt(0.5)
    for z in (z1 - 1.0, z0 + 1.0):
        for sx in (-1, 1):
            skate = Vector((sx * 1.45 * q, front_col_y + 1.45 * q, z))
            mb.add_box(skate, (1.6, 1.1, 1.8), Matrix.Rotation(sx * math.pi / 4, 3, "Z"))
            mb.add_beam((sx * 1.6, yf, z), skate, 0.5)
    # The deck on top, either side of the corner (grating; open over the tower itself).
    off = 1.3 * q  # the deck's inner edge stands this far off the tower's face
    for sx in (-1, 1):
        outline = [(sx * off, yf + 0.4), (sx * hx, yf + 0.4), (sx * (side_col.x + 1.7), side_col.y + 0.5),
                   (sx * (side_col.x + off), side_col.y + off), (sx * off, front_col_y + off)]
        mb.add_prism(outline if sx < 0 else list(reversed(outline)), z1 + 0.3, z1 + 0.4)
    _handrail(mb, (-hx, yf + 0.5, z1 + 0.4), (hx, yf + 0.5, z1 + 0.4))
    return mb


# --- The tower's lattice ------------------------------------------------------------------------
COLUMN = 1.8  # the four corner columns (square tube), m (approx: a seventh of the face)
GIRT = 0.6  # the horizontal beam round the tower at every bay
BRACE = 0.55  # the one diagonal in each bay of each face
BAY = 7.1  # a bay's height (about: 0.54 of the face, off the long-lens photo)


def build_lattice(half, z0, z1, joint_every=2):
    """The tower's lattice as built ("Tower-OLM.jpg" shows it close up): one square column at
    each corner, a beam round the tower at every bay, and ONE diagonal per bay on each face,
    zig-zagging up it, mirrored either side of each column; the sections' joints as collars on
    the columns every second bay; inside, a clad lift shaft and the stair beside it.

    In the tower's own frame: its centre at the origin, faces square to X and Y, `half` its
    half-width to the columns' outer faces, from z0 to z1. Returns (bracing, columns, lift,
    col_r): the columns with their joint collars and the carriage's rails are their own mesh (a
    paler steel than the bracing), and so is the lift shaft (dark cladding); col_r is the
    columns' centres' distance from the tower's axis."""
    mb = MeshBuilder()
    cols = MeshBuilder()
    lift = MeshBuilder()
    c = half - (COLUMN + 0.3) / 2  # (the collars, the widest thing on a column, come out to `half`)
    corners = [(c, c), (-c, c), (-c, -c), (c, -c)]
    n = max(4, round((z1 - z0) / BAY))
    zs = [z0 + (z1 - z0) * k / n for k in range(n + 1)]
    joints = [zs[k] for k in range(0, n + 1, joint_every)]
    for x, y in corners:
        cols.add_beam((x, y, z0), (x, y, z1), COLUMN, uv_size=2.0)
        for zj in joints:
            cols.add_box((x, y, min(z1 - 0.3, max(z0 + 0.3, zj))), (COLUMN + 0.3, COLUMN + 0.3, 0.6))
    for f in range(4):
        a, b = corners[f], corners[(f + 1) % 4]
        # (Diagonals leave the even corners going up, and arrive at the odd ones: mirrored either
        # side of every column, as built.)
        start, end = (a, b) if f % 2 == 0 else (b, a)
        for k, z in enumerate(zs):
            mb.add_beam((a[0], a[1], z), (b[0], b[1], z), GIRT)
            if k == n:
                break
            lo, hi = (start, end) if k % 2 == 0 else (end, start)
            mb.add_beam((lo[0], lo[1], z), (hi[0], hi[1], zs[k + 1]), BRACE)
            # (A gusset at each end of the diagonal, where it meets column and beam.)
            d = (Vector((hi[0], hi[1], zs[k + 1])) - Vector((lo[0], lo[1], z))).normalized()
            for p, sgn in ((Vector((lo[0], lo[1], z)), 1), (Vector((hi[0], hi[1], zs[k + 1])), -1)):
                mb.add_beam(p + d * sgn * 0.9, p + d * sgn * 2.3, BRACE + 0.5, BRACE * 0.5, up=(a[1] - b[1], b[0] - a[0], 0))
    # Plan bracing at every joint.
    for z in joints:
        mb.add_beam((c, c, z), (-c, -c, z), 0.3)
        mb.add_beam((-c, c, z), (c, -c, z), 0.3)
    # The core: the lift shaft (clad, dark) and beside it the stair: four posts, a landing at
    # every half bay, the flights between them.
    shaft = (-1.5, -1.5)
    lift.add_box((shaft[0], shaft[1], (z0 + z1 - 3.0) / 2), (2.6, 2.6, z1 - z0 - 3.0))
    sx, sy, sw = 1.5, 1.5, 1.4  # the stair's centre and half-width
    for x, y in ((sx - sw, sy - sw), (sx + sw, sy - sw), (sx + sw, sy + sw), (sx - sw, sy + sw)):
        mb.add_beam((x, y, z0), (x, y, z1 - 1.0), 0.22)
    m = 2 * n
    for k in range(m):
        z = z0 + (z1 - 1.0 - z0) * k / m
        zn = z0 + (z1 - 1.0 - z0) * (k + 1) / m
        mb.add_box((sx, sy, z + 0.05), (2 * sw, 2 * sw, 0.1))
        side = sw - 0.45 if k % 2 == 0 else -(sw - 0.45)
        mb.add_beam((sx + side, sy - sw + 0.3, z + 0.1), (sx + side, sy + sw - 0.3, zn), 0.8, 0.14)
        for (ax, ay), (bx, by) in (((-sw, -sw), (sw, -sw)), ((sw, -sw), (sw, sw)), ((sw, sw), (-sw, sw)), ((-sw, sw), (-sw, -sw))):
            mb.add_beam((sx + ax, sy + ay, z + 1.1), (sx + bx, sy + by, z + 1.1), 0.07)
    # (The landings reach the lift, and the girts, at every bay.)
    for z in zs[:-1]:
        mb.add_beam((shaft[0] + 1.3, shaft[1] + 1.3, z + 0.05), (sx - sw, sy - sw, z + 0.05), 1.2, 0.1)
    # The carriage's rails: up the column toward the vehicle (+X +Y here) and its two neighbours.
    for (x, y), faces in (((c, c), ((1, 0), (0, 1))), ((-c, c), ((0, 1),)), ((c, -c), ((1, 0),))):
        for fx, fy in faces:
            cols.add_beam((x + fx * (COLUMN / 2 + 0.05), y + fy * (COLUMN / 2 + 0.05), z0), (x + fx * (COLUMN / 2 + 0.05), y + fy * (COLUMN / 2 + 0.05), z1), 0.24)
    return mb, cols, lift, c * math.sqrt(2.0)


# --- The ship quick-disconnect arm ------------------------------------------------------------------
QD_TOP = -1.3  # the arm's deck below the plate's centre (the plate rides a boom on top of the head)
QD_DEPTH = 5.2  # the truss's depth
QD_HALF = 1.7  # its half-width
QD_HEAD = 5.0  # the head's length, back from the plate's face
QD_KICKER_DROP = 11.6  # the lower hinge below the plate's centre


def build_qd_arm(length):
    """The ship quick-disconnect arm as built: a truss nearly as long as a catch arm, 5.5 m deep,
    its bottom chord rising under the outer third to the head; propped from a lower hinge by a
    kicker; a walkway along the top with the two propellant lines (white, lagged) beside it; and
    the head: a frame with a railed platform, and on it the boom that carries the plate out to
    the ship. Returns (steel, lines): two MeshBuilders.

    Local frame: the hinge at the origin, +X out along the arm to the ship, +Z up, the plate's
    centre on the X axis. `length`: hinge to the plate's face."""
    mb = MeshBuilder()
    lines = MeshBuilder()
    w, zt = QD_HALF, QD_TOP
    x0, x1 = 1.5, length - QD_HEAD
    xm = x0 + (x1 - x0) * 0.6  # the bottom chord's knee
    zlow, zhead = zt - QD_DEPTH, zt - 2.4

    def zb(x):
        return zlow if x <= xm else zlow + (zhead - zlow) * (x - xm) / (x1 - xm)

    n = max(4, round((x1 - x0) / 4.2))
    xs = [x0 + (x1 - x0) * k / n for k in range(n + 1)]
    # (A node at the knee.)
    kn = min(range(n + 1), key=lambda k: abs(xs[k] - xm))
    xm = xs[kn]
    for y in (-w, w):
        mb.add_beam((x0, y, zt), (x1, y, zt), 0.45)
        mb.add_beam((x0, y, zlow), (xm, y, zlow), 0.45)
        mb.add_beam((xm, y, zlow), (x1, y, zhead), 0.45)
    for k, x in enumerate(xs):
        for y in (-w, w):
            mb.add_beam((x, y, zt), (x, y, zb(x)), 0.3)
        mb.add_beam((x, -w, zt), (x, w, zt), 0.28)
        mb.add_beam((x, -w, zb(x)), (x, w, zb(x)), 0.28)
        if k == n:
            break
        x2 = xs[k + 1]
        for y in (-w, w):
            if k % 2 == 0:
                mb.add_beam((x, y, zt), (x2, y, zb(x2)), 0.3)
            else:
                mb.add_beam((x, y, zb(x)), (x2, y, zt), 0.3)
        ya, yb_ = (-w, w) if k % 2 == 0 else (w, -w)
        mb.add_beam((x, ya, zb(x)), (x2, yb_, zb(x2)), 0.22)
    # The hinge: the pin's barrel on the column, lugs out to the truss top and bottom; the lower
    # hinge and the kicker from it up to the bottom chords.
    mb.add_prism(_octagon(0.6), zlow - 0.5, zt + 0.5)
    for z in (zt, zlow):
        for y in (-w, w):
            mb.add_beam((0.0, 0.0, z), (x0, y, z), 0.42)
    mb.add_beam((x0, -w, zt), (x0, w, zlow), 0.26)
    mb.add_beam((x0, w, zt), (x0, -w, zlow), 0.26)
    mb.add_prism(_octagon(0.5), -QD_KICKER_DROP - 0.6, -QD_KICKER_DROP + 0.6)
    foot = (0.0, 0.0, -QD_KICKER_DROP)
    xk = xs[min(2, n - 1)]
    for y in (-w, w):
        mb.add_beam(foot, (xk, y, zlow), 0.5)
    mb.add_beam(foot, (0.0, 0.0, zlow), 0.4)
    # The walkway along one side of the top, railed; the lines along the other.
    deck = zt + 0.23
    mb.add_box(((x0 + x1) / 2, -0.75, deck + 0.04), (x1 - x0, 1.7, 0.08))
    _handrail(mb, (x0, -w + 0.05, deck + 0.08), (x1, -w + 0.05, deck + 0.08))
    _handrail(mb, (x0, 0.1, deck + 0.08), (x1, 0.1, deck + 0.08))

    # The head: a frame the width of the arm and a little more, a platform on it, railed all
    # round; an upper frame on that for the boom.
    hw = w + 0.6
    hx0, hx1 = x1, length - 1.4
    for x in (hx0, hx1):
        for y in (-hw, hw):
            mb.add_beam((x, y, zhead - 0.6), (x, y, zt), 0.4)
    for z in (zhead - 0.6, zt):
        mb.add_beam((hx0, -hw, z), (hx1, -hw, z), 0.4)
        mb.add_beam((hx0, hw, z), (hx1, hw, z), 0.4)
        mb.add_beam((hx0, -hw, z), (hx0, hw, z), 0.4)
        mb.add_beam((hx1, -hw, z), (hx1, hw, z), 0.4)
    for y in (-hw, hw):
        mb.add_beam((hx0, y, zhead - 0.6), (hx1, y, zt), 0.26)
        mb.add_beam((hx0, y, zt), (hx1, y, zhead - 0.6), 0.26)
    mb.add_box(((hx0 + hx1) / 2, 0.0, deck + 0.04), (hx1 - hx0 + 0.6, 2 * hw + 0.6, 0.1))
    r = deck + 0.09
    _handrail(mb, (hx0 - 0.3, -hw - 0.3, r), (hx1 + 0.3, -hw - 0.3, r))
    _handrail(mb, (hx0 - 0.3, hw + 0.3, r), (hx1 + 0.3, hw + 0.3, r))
    _handrail(mb, (hx1 + 0.3, -hw - 0.3, r), (hx1 + 0.3, -1.3, r))
    _handrail(mb, (hx1 + 0.3, 1.3, r), (hx1 + 0.3, hw + 0.3, r))
    # (The boom's frame: two A-frames on the platform, the boom between them, out to the plate.)
    for x in (hx0 + 0.9, hx1 - 0.5):
        for y in (-1.0, 1.0):
            mb.add_beam((x, y, deck), (x, y * 0.45, 0.9), 0.22)
        mb.add_beam((x, -0.45, 0.9), (x, 0.45, 0.9), 0.22)
    mb.add_beam((hx0 + 0.6, 0.0, 0.25), (length - 0.4, 0.0, 0.1), 0.55, 0.7)
    # The plate, proud of the boom's end, with its guide pins' housings.
    mb.add_box((length - 0.2, 0.0, 0.0), (0.4, 2.1, 2.1))
    for y, z in ((-0.8, 0.8), (0.8, 0.8), (-0.8, -0.8), (0.8, -0.8)):
        mb.add_box((length - 0.55, y, z), (0.5, 0.3, 0.3))
    # The claws that steady the booster's top, folded under the head.
    for y in (-1.2, 1.2):
        mb.add_box((hx1 - 0.6, y, zhead - 1.0), (2.0, 0.7, 0.5))

    # The propellant lines: methane and oxygen, lagged white, along the arm's top beside the
    # walkway, up onto the boom at the head and out to the plate; at the root they turn down the
    # tower.
    for y, rad in ((0.75, 0.33), (1.3, 0.26)):
        zl = deck + rad + 0.1
        _tube(lines, (0.6, y, zl), (hx0 + 0.9, y, zl), rad)
        _tube(lines, (hx0 + 0.9, y, zl), (hx0 + 2.2, y * 0.5, 0.2), rad)
        _tube(lines, (hx0 + 2.2, y * 0.5, 0.2), (length - 0.45, y * 0.5, 0.2), rad)
        _tube(lines, (0.6, y, zl), (0.6, y, zlow - 1.5), rad)
    return mb, lines
