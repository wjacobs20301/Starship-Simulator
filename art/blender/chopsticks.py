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

and, for where the arms meet the carriage, two photos that aren't free to reuse (looked at, not
copied: nothing of them is in the model but the sizes read off them):

  - StarshipGazer's side-on view of the second tower's arms and carriage standing on the ground
    before they went up (Starship SpaceX Wiki, "Chopsticks"): people on them to scale by.
  - Max Evans / NASASpaceflight's long-lens view up at the second tower's arm with a ship in it.

What they show, and what's here:

  - The arms are two straight box trusses, each on its OWN hinge on the carriage (the hinges
    about eleven metres apart), parallel when shut, either side of the vehicle. Deep: 6.6 m at
    the root, 6 m at the tip, all the way out; the top flat, the tip raked back underneath.
    The landing rail runs along the inner top edge (pale: the rest is near black).
  - Each arm is propped from far below: a kicker strut from a lower hinge 20 m under the arm's
    top, on the carriage's foot, up to the bottom chords nine metres out.
  - Where an arm meets the carriage it is no truss: a round hinge post, a metre through, stands
    from the lower hinge to the upper, and from its foot heavy round tubes fan up and out: the
    kickers to the bottom chords, a steeper pair to the top chords four metres out. The pins'
    barrels sit in forks on the carriage's top and bottom beams.
  - The second tower's arms (the shorter design) are not the first's cut short. They are deeper
    (9 m), of round tube a metre through, and their bottom chords START at the kickers, ten
    metres out: inboard of that there is only the fan. Top chords are box girders; the webs
    are one vertical and one diagonal a panel, all leaning the same way.
  - Each arm is swung by a hydraulic cylinder as thick as its tubes, lying level just under the
    arm's top: from a bracket on the carriage's side beside the tower, forward to a lug outboard
    of the hinge. Its tower end is boxed in pale covers.
  - The carriage is as tall as that (21 m), wrapped round the tower's corner toward the mount,
    riding that corner's column and its two neighbours: a heavy box beam round the top and
    another round the foot, lighter trussing between, railed walkways along it.
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


def _pipe(mb, p0, p1, r, sides=12):
    """A round tube between two points, smooth, capped."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    if d.length < 1e-6:
        return
    m = Matrix.Translation(p0) @ d.to_track_quat("Z", "Y").to_matrix().to_4x4()
    mb.add_lathe([(r, 0.0), (r, d.length)], sides, matrix=m, u_size=2.0, v_size=2.0)
    ring = [(r * math.cos(2 * math.pi * k / sides), r * math.sin(2 * math.pi * k / sides)) for k in range(sides)]
    mb.add_face([m @ Vector((x, y, 0.0)) for x, y in reversed(ring)], [(x / 2, y / 2) for x, y in reversed(ring)])
    mb.add_face([m @ Vector((x, y, d.length)) for x, y in ring], [(x / 2, y / 2) for x, y in ring])


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


# Where an arm meets the carriage (both designs).
POST_R = 0.48  # the hinge post, from the lower hinge to the upper
BARREL_R = 0.8  # the pins' barrels on it, in the carriage's forks
BARREL_Z = (RAIL_TOP - 1.35, RAIL_TOP - 0.15)  # the upper one's height range (the lower: +-0.7 about the lower hinge)
STEEP_OUT = 4.4  # where the steep struts from the lower hinge meet the top chords, out from the hinge
# The swing cylinders: level, a little under the arm's top; from a bracket on the carriage's side
# (carriage's frame, the right-hand arm's: the left is the mirror) to a lug on the arm outboard of
# its hinge (arm's frame). The lug is 3 m from the pin and the bracket 9.4 m: from an arm folded
# square out to one swung 70 deg inward the two are 6.4 to 12.4 m apart, which a barrel and a rod
# of these lengths cover without the rod leaving the barrel or coming out of its back.
ACT_Z = RAIL_TOP - 2.1
ACT_LUG = (2.4, 1.8)
ACT_ANCHOR = (HINGE_X + 4.6, -8.2)
ACT_BARREL = 6.2
ACT_ROD = 6.3
ACT_R = 0.42
# The second tower's arms (the shorter design).
SHORT_DEPTH = 9.0  # top of rail to the bottom chords' underside
SHORT_KNEE = 10.4  # where the bottom chords start, at the kickers' heads, out from the hinge
SHORT_TIP = 3.2  # how far they stop short of the tip
SHORT_X_IN = -0.55  # the planes of the two sides, from the hinge
SHORT_X_OUT = 2.35


def _root(mb, top, x_out):
    """What every arm has at its hinge: the post from the lower pin to the upper, the pins'
    barrels, and the lug the swing cylinder holds, braced back to the post and up to the outer
    top chord (whose centre line is at `top`, in the plane x_out)."""
    mb.add_lathe([(POST_R, -KICKER_DROP - 0.9), (POST_R, RAIL_TOP - 0.2)], 14, u_size=2.0, v_size=2.0)
    mb.add_prism(_octagon(POST_R), RAIL_TOP - 0.3, RAIL_TOP - 0.2)
    for z0, z1 in (BARREL_Z, (-KICKER_DROP - 0.7, -KICKER_DROP + 0.7)):
        mb.add_prism(_octagon(BARREL_R), z0, z1)
    lx, ly = ACT_LUG
    mb.add_box((lx, ly, ACT_Z), (0.8, 0.9, 1.1))
    _pipe(mb, (0.0, 0.0, ACT_Z), (lx, ly, ACT_Z), 0.3)
    mb.add_beam((lx, ly, ACT_Z + 0.5), (x_out, ROOT + 0.6, top - 0.2), 0.45)


def _stabilizer(mb, x, y, z):
    """The stabilizer under an arm where the vehicle hangs: a V of struts down from the inner
    bottom chord (its underside at z) to a pad that steadies the hull."""
    apex = (x, y, z - 4.2)
    mb.add_beam((x, y - 2.6, z), apex, 0.3)
    mb.add_beam((x, y + 2.6, z), apex, 0.3)
    mb.add_box((x, y, z - 4.3), (0.55, 1.0, 0.5))


def _walkway(mb, x0, x1, y0, y1, deck, hang_at):
    """The walkway along an arm's top beside the rail (below it: a catch fin's underside passes a
    hand above the rail, right across the arm), with its handrail folded flat, as it is for a
    catch: a low kerb rail only, clear of where a vehicle hangs."""
    mb.add_box(((x0 + x1) / 2, (y0 + y1) / 2, deck + 0.04), (x1 - x0, y1 - y0, 0.08))
    for a, b in ((y0 + 0.3, hang_at - 6.5), (hang_at + 6.5, y1 - 0.3)):
        if b - a > 2.0:
            mb.add_beam((x1 + 0.1, a, deck + 0.2), (x1 + 0.1, b, deck + 0.2), 0.1)
            for k in range(round((b - a) / 2.0) + 1):
                y = a + (b - a) * k / max(1, round((b - a) / 2.0))
                mb.add_beam((x1 + 0.1, y, deck), (x1 + 0.1, y, deck + 0.2), 0.08)


def build_arm(length, hang_at, short=False):
    """One arm (the right-hand one, shut), `length` from its hinge to its tip, the vehicle hanging
    `hang_at` out from the hinge; `short`: the second tower's design. Returns (steel, rail): the
    truss, and the landing rail's pale top, each a MeshBuilder.

    Local frame: the origin at this arm's hinge, +Y from the tower toward the vehicle, +X away
    from the vehicle (the left arm is the mirror), +Z up."""
    return _arm_short(length, hang_at) if short else _arm_long(length, hang_at)


def _arm_long(length, hang_at):
    """The first tower's arm: a box truss of square tube all the way in to the hinge."""
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
    _walkway(mb, x_rail + RAIL_W / 2 + 0.1, X_OUT + 0.1, ys[0], ys[-1], zt + CHORD / 2, hang_at)

    # The root: the hinge post, and round tube out from it to the truss's first frame, top and
    # bottom of it. (Nothing here reaches further in toward the vehicle than the rail: the
    # constants' note on the colliders says why.)
    z_low = zb(ys[0])
    _root(mb, zt, X_OUT)
    for x in (x_rail, X_OUT):
        _pipe(mb, (0.0, 0.1, zt - 0.1), (x, ys[0] + 0.2, zt - 0.1), 0.34)
    for x in (X_IN, X_OUT):
        _pipe(mb, (0.0, 0.1, z_low), (x, ys[0] + 0.1, z_low), 0.3)
    mb.add_beam((X_IN, ys[0], zt), (X_OUT, ys[0], z_low), WEB)
    mb.add_beam((X_OUT, ys[0], zt), (X_IN, ys[0], z_low), WEB)
    # The fan from the lower hinge, on the carriage's foot far below: the kickers up to the
    # bottom chords (plain in every photo of the arms from the side), a steeper pair to the top
    # chords nearer in, and bracing between the two of each pair.
    kk = min(range(n + 1), key=lambda k: abs(yb[k] - KICKER_OUT))
    ks = min(range(1, n + 1), key=lambda k: abs(ys[k] - STEEP_OUT))
    yk = yb[kk]
    foot = Vector((0.0, 0.1, -KICKER_DROP))
    heads = [(Vector((X_IN + 0.12, yk, zb(yk))), Vector((X_OUT, yk, zb(yk))), 0.36),
             (Vector((X_IN + 0.1, ys[ks], top_in - 0.1)), Vector((X_OUT, ys[ks], zt - 0.2)), 0.3)]
    for pa, pb, r in heads:
        _pipe(mb, foot, pa, r)
        _pipe(mb, foot, pb, r)
        for f in (0.4, 0.75):
            _pipe(mb, foot.lerp(pa, f), foot.lerp(pb, f), 0.16, 8)
    ys_ = min(max(hang_at, ys[0] + 4.0), yb[-1] - 4.0)
    _stabilizer(mb, X_IN + 0.1, ys_, zb(ys_) - CHORD / 2)
    return mb, rail


def _arm_short(length, hang_at):
    """The second tower's arm: deeper, of round tube a metre through, its top chords box girders,
    its bottom chords starting at the kickers' heads: inboard of them only the fan of tubes from
    the lower hinge."""
    mb = MeshBuilder()
    rail = MeshBuilder()
    xi, xo = SHORT_X_IN, SHORT_X_OUT
    rc = 0.5  # the bottom chords' radius
    girder = 1.3  # the top chords' depth
    x_rail = -RAIL_IN + RAIL_W / 2
    zt = RAIL_TOP - 0.25 - 0.55  # the outer top chord's centre line (its top a hand under the rail's)
    top_in, top_out = RAIL_TOP - girder, zt - 0.55  # the top chords' undersides
    zb = RAIL_TOP - SHORT_DEPTH + rc  # the bottom chords' centre line
    y_end = length - SHORT_TIP
    n = max(2, round((y_end - SHORT_KNEE) / 5.0))
    ys = [SHORT_KNEE + (y_end - SHORT_KNEE) * k / n for k in range(n + 1)]

    # The top chords: the rail girder along the inner edge, its top the pale wearing surface the
    # pins come down on, and a box girder along the outer.
    mb.add_box((x_rail, (ROOT + length) / 2, RAIL_TOP - 0.12 - (girder - 0.12) / 2), (RAIL_W, length - ROOT, girder - 0.12))
    rail.add_box((x_rail, (ROOT + 0.4 + length - 0.3) / 2, RAIL_TOP - 0.06), (RAIL_W, length - ROOT - 0.7, 0.12))
    mb.add_box((xo, (ROOT + length) / 2, zt), (0.8, length - ROOT, 1.1))
    # The bottom chords, from the kickers' heads to short of the tip.
    for x in (xi, xo):
        _pipe(mb, (x, ys[0] - 0.4, zb), (x, y_end + 0.35, zb), rc, 14)
    # The webs: a vertical at every node and one diagonal a panel, all leaning out toward the tip
    # as they go down; the two sides tied across at every node, and braced in plan.
    for k, y in enumerate(ys):
        for x, z in ((xi, top_in), (xo, top_out)):
            _pipe(mb, (x, y, zb), (x, y, z + 0.1), 0.3)
        _pipe(mb, (xi, y, zb), (xo, y, zb), 0.28)
        if k == n:
            break
        y1 = ys[k + 1]
        for x, z in ((xi, top_in), (xo, top_out)):
            _pipe(mb, (x, y, z + 0.1), (x, y1, zb), 0.38)
        xa, xb = (xi, xo) if k % 2 == 0 else (xo, xi)
        _pipe(mb, (xa, y, zb), (xb, y1, zb), 0.2, 8)
    tops = [ROOT, STEEP_OUT, (STEEP_OUT + SHORT_KNEE) / 2] + ys + [length - 0.25]
    for k, y in enumerate(tops):
        mb.add_beam((x_rail, y, zt), (xo, y, zt), 0.35)
        if k + 1 < len(tops):
            xa, xb = (x_rail, xo) if k % 2 == 0 else (xo, x_rail)
            mb.add_beam((xa, y, zt), (xb, tops[k + 1], zt), 0.22)
    # The tip: a bumper on the rail's end.
    mb.add_box((x_rail, length - 0.15, RAIL_TOP - 0.7), (RAIL_W, 0.3, 1.4))
    _walkway(mb, x_rail + RAIL_W / 2 + 0.1, xo - 0.5, ROOT, length - 0.3, zt + 0.55, hang_at)

    # The root: the hinge post, the top chords run in to it, and from the lower hinge the fan:
    # the kickers to the bottom chords' ends, a steeper pair to the top chords four metres out,
    # and from the kickers' heads a tube back up to where those land. (Nothing here reaches
    # further in toward the vehicle than the rail: the constants' note on the colliders says why.)
    _root(mb, zt, xo)
    for x in (x_rail, xo):
        _pipe(mb, (0.0, 0.1, zt - 0.05), (x, ROOT + 0.3, zt - 0.05), 0.4)
    foot = Vector((0.0, 0.1, -KICKER_DROP))
    heads = [(Vector((xi, ys[0], zb)), Vector((xo, ys[0], zb)), 0.5),
             (Vector((xi, STEEP_OUT, top_in + 0.1)), Vector((xo, STEEP_OUT, top_out + 0.1)), 0.42)]
    for pa, pb, r in heads:
        _pipe(mb, foot, pa, r, 14)
        _pipe(mb, foot, pb, r, 14)
        for f in (0.4, 0.75):
            _pipe(mb, foot.lerp(pa, f), foot.lerp(pb, f), 0.2, 8)
    for (ka, kb, _), (sa, sb, _) in ((heads[0], heads[1]),):
        _pipe(mb, ka, sa, 0.4)
        _pipe(mb, kb, sb, 0.4)
    _stabilizer(mb, xi + 0.1, min(max(hang_at, ys[0] + 3.2), y_end - 3.2), zb - rc)
    return mb, rail


def build_actuator(side):
    """One arm's swing cylinder (side: +1 the right-hand arm's, -1 the left's), in the carriage's
    frame, the arm shut. Returns (anchor, lug, barrel, cover, rod): the two pins it turns on, and
    three MeshBuilders: the barrel from the anchor toward the lug, the pale housing boxed round
    its tower end, and the rod from the lug back into the barrel. The app keeps the barrel and
    the rod pointing at each other as the arm swings (render/armActuators.ts)."""
    anchor = Vector((side * ACT_ANCHOR[0], ACT_ANCHOR[1], ACT_Z))
    lug = Vector((side * (HINGE_X + ACT_LUG[0]), ACT_LUG[1], ACT_Z))
    d = (lug - anchor).normalized()
    barrel, cover, rod = MeshBuilder(), MeshBuilder(), MeshBuilder()
    _pipe(barrel, anchor - d * 0.3, anchor + d * ACT_BARREL, ACT_R, 14)
    _pipe(barrel, anchor + d * (ACT_BARREL - 0.5), anchor + d * (ACT_BARREL + 0.05), ACT_R + 0.08, 14)  # the gland
    _pipe(barrel, anchor - Vector((0, 0, 0.75)), anchor + Vector((0, 0, 0.75)), 0.22, 10)  # its pin
    turn = Matrix.Rotation(math.atan2(d.y, d.x), 3, "Z")
    cover.add_box(anchor + d * 0.9, (1.9, 1.25, 1.3), turn)
    _pipe(rod, lug, lug - d * ACT_ROD, 0.2, 12)
    _pipe(rod, lug - Vector((0, 0, 0.5)), lug + Vector((0, 0, 0.5)), 0.34, 10)  # the eye on the lug's pin
    return anchor, lug, barrel, cover, rod


def build_carriage(col_r, corner_d):
    """The carriage: the frame the arms hinge on, wrapped round the tower's corner toward the
    vehicle. A heavy box beam round its top, level with the arms' top chords, and another round
    its foot, each with a fork at either end for an arm's pin; between them a front truss as
    tall as the arms' kickers are long and a side truss from each hinge back along the tower's
    face to the next column; skates on that column, on the far one and on the corner's own;
    railed walkways along the top and half way down the sides; the swing cylinders' brackets.

    In the carriage's frame: the origin midway between the hinges, +Y toward the vehicle, +Z up.
    `corner_d`: the tower's centre behind the origin; `col_r`: its columns' centres out from
    that centre."""
    mb = MeshBuilder()
    z1 = RAIL_TOP - 0.9  # the top beam's centre line (its top a hand under the rails')
    z0 = -KICKER_DROP
    levels = [z1, z1 - 6.3, z0 + 6.3, z0]
    size = {z1: (0.8, 1.3), z0: (0.8, 1.2)}  # the two heavy beams; the rest are lighter
    yf = -0.95  # the front truss's plane, behind the hinges
    hx = HINGE_X

    def chord(a, b, z):
        w, h = size.get(z, (0.45, 0.45))
        mb.add_beam(Vector(a) + Vector((0, 0, z)), Vector(b) + Vector((0, 0, z)), w, h)

    # The posts behind the hinges, and the forks: a plate over and under each pin's barrel.
    for sx in (-1, 1):
        mb.add_beam((sx * hx, yf, z0 - 0.6), (sx * hx, yf, z1 + 0.65), 0.8)
        for lo, hi in (BARREL_Z, (z0 - 0.7, z0 + 0.7)):
            for z in (lo - 0.14, hi + 0.14):
                mb.add_box((sx * hx, (yf - 0.4 + 0.75) / 2, z), (1.9, 0.75 - (yf - 0.4), 0.28))
    # The front truss between them.
    for z in levels:
        chord((-hx, yf, 0.0), (hx, yf, 0.0), z)
    for i in range(len(levels) - 1):
        a, b = levels[i], levels[i + 1]
        mb.add_beam((0.0, yf, a), (0.0, yf, b), 0.4)
        for sx in (-1, 1):
            lo, hi = (0.0, sx * hx) if i % 2 == 0 else (sx * hx, 0.0)
            mb.add_beam((lo, yf, a), (hi, yf, b), 0.32)
    # The side trusses: from each hinge post back to stand off the side column.
    side_col = Vector((col_r, -corner_d, 0.0))
    q = math.sqrt(0.5)
    for sx in (-1, 1):
        a = Vector((sx * hx, yf, 0.0))
        b = Vector((sx * (side_col.x + 1.7), side_col.y + 0.5, 0.0))
        along = (b - a).normalized()
        out = Vector((along.y, -along.x, 0.0))  # square to it, away from the tower
        if out.x * sx < 0:
            out = -out
        for z in levels:
            chord(a, b, z)
        nb = 2
        for k in range(1, nb + 1):
            p = a.lerp(b, k / nb)
            mb.add_beam(p + Vector((0, 0, z0 - (0.6 if k == nb else 0.0))), p + Vector((0, 0, z1 + (0.65 if k == nb else 0.0))), 0.6 if k == nb else 0.4)
        for i in range(len(levels) - 1):
            for k in range(nb):
                p, r = a.lerp(b, k / nb), a.lerp(b, (k + 1) / nb)
                lo, hi = (levels[i], levels[i + 1]) if (i + k) % 2 == 0 else (levels[i + 1], levels[i])
                mb.add_beam(p + Vector((0, 0, lo)), r + Vector((0, 0, hi)), 0.3)
        # Skates on the side column's rail (on its face toward the vehicle), top and bottom, and
        # the arms out to them.
        turn = Matrix.Rotation(sx * math.pi / 4, 3, "Z")
        for z in (z1 - 1.0, z0 + 1.0):
            skate = Vector((sx * (side_col.x + 1.45 * q), side_col.y + 1.45 * q, z))
            mb.add_box(skate, (1.6, 1.1, 1.8), turn)
            mb.add_beam(b + Vector((0, 0, z)), skate, 0.5)
        # A walkway along the top beam and another half way down, each railed on its outer side.
        for z, w in ((z1 + 0.65, 1.1), (levels[1] + 0.25, 1.3)):
            pa, pb = a + along * 0.6 + Vector((0, 0, z)), b - along * 0.3 + Vector((0, 0, z))
            off = out * (0.0 if z > z1 else 0.85)
            mb.add_beam(pa + off + Vector((0, 0, 0.04)), pb + off + Vector((0, 0, 0.04)), w, 0.08)
            _handrail(mb, pa + off + out * (w / 2 - 0.05) + Vector((0, 0, 0.08)), pb + off + out * (w / 2 - 0.05) + Vector((0, 0, 0.08)))
            if z < z1:
                # (Brackets under the lower one, off the truss.)
                for f in (0.1, 0.5, 0.9):
                    p = pa.lerp(pb, f)
                    mb.add_beam(p - Vector((0, 0, 0.1)), p + out * 1.5 - Vector((0, 0, 0.1)), 0.2)
        # The swing cylinder's bracket: out from the top beam to its pin, braced back down to
        # the truss.
        anchor = Vector((sx * ACT_ANCHOR[0], ACT_ANCHOR[1], 0.0))
        t = (anchor - a).dot(along)
        for dt in (-1.5, 1.5):
            mb.add_beam(a + along * (t + dt) + Vector((0, 0, z1 - 0.3)), anchor + Vector((0, 0, ACT_Z + 0.75)), 0.45)
            mb.add_beam(a + along * (t + dt) + Vector((0, 0, ACT_Z - 2.6)), anchor + Vector((0, 0, ACT_Z - 0.75)), 0.36)
        mb.add_beam(a + along * (t - 1.5) + Vector((0, 0, ACT_Z - 2.6)), a + along * (t + 1.5) + Vector((0, 0, ACT_Z - 2.6)), 0.36)
        for z in (ACT_Z + 0.75, ACT_Z - 0.75):
            mb.add_box(anchor + Vector((0, 0, z)), (1.1, 1.1, 0.25))
    # Skates on the corner's own column (on both its faces toward the vehicle), off the front truss.
    front_col_y = -corner_d + col_r
    for z in (z1 - 1.0, z0 + 1.0):
        for sx in (-1, 1):
            skate = Vector((sx * 1.45 * q, front_col_y + 1.45 * q, z))
            mb.add_box(skate, (1.6, 1.1, 1.8), Matrix.Rotation(sx * math.pi / 4, 3, "Z"))
            mb.add_beam((sx * 1.6, yf, z), skate, 0.5)
    # The walkway along the front beam's top, railed toward the vehicle (grating: no wider than
    # the beam, so the arms' roots swing clear of it).
    mb.add_box((0.0, yf, z1 + 0.69), (2 * hx - 1.2, 0.9, 0.08))
    _handrail(mb, (-hx + 0.8, yf + 0.4, z1 + 0.73), (hx - 0.8, yf + 0.4, z1 + 0.73))
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
