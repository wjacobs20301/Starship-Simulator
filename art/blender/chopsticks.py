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

and, for the arms' hinges and the carriage, press photos that aren't free to reuse (looked at,
not copied: nothing of them is in the model but the shapes and sizes read off them):

  - NASASpaceflight (bocachicagal) and Starship Gazer, Aug 2021 to Jan 2022, in Teslarati's
    reports on the first tower's arms: the arms and carriage on their stands seen end on and
    side on, the lift onto the tower, the arms spread wide at night, the water-bag load test.
  - RGV Aerial Photography's view straight down on the first tower with its arms on (Nov 2021).
  - McOfficialPlays' view from in front of the Florida tower's arms going on (Jan 2023): the
    second design.
  - StarshipGazer's side-on view of the second tower's arms and carriage on the ground, people
    on them to scale by, and Max Evans / NASASpaceflight's long-lens view up at one of them
    with a ship in it (Starship SpaceX Wiki, "Chopsticks").

What they show, and what's here:

  - The two arms hinge SIDE BY SIDE at the tower's corner toward the mount, their posts under
    three metres apart (plain from in front, and from above: both arms leave the corner from
    almost one point). So shut on a vehicle they are a narrow V, a dozen degrees either side,
    not a parallel pair; folded back they lie along the tower's faces.
  - Each arm is a straight truss of round tube, near black, a metre through in its chords: a
    rail girder along the inner top edge (the landing rail on it pale), a chord along the outer,
    two bottom chords, a post at every node and one diagonal a panel, all leaning the same way.
    The first tower's are 6.6 m deep (by the booster's 9 m, in the long-lens view); the second's
    shorter design is deeper, 9 m, with box girders for top chords.
  - The bottom chords do NOT run in to the hinge: they start at the kickers' heads, nine or ten
    metres out. Inboard of that an arm is a round hinge post, standing from the lower pin (20 m
    under the arm's top) to the upper, and a fan of heavy tubes from its foot: the kickers to
    the bottom chords, a steeper pair to the top chords four metres out.
  - Each arm is swung by a hydraulic cylinder as thick as its tubes, lying level just under the
    arm's top, its tower end boxed in pale covers. (Where its ends are pinned is the least sure
    thing here: one long-lens view shows the housing beside a tower column and the barrel
    running forward to the arm's root. It is put outboard, on the carriage's side frame.)
  - The carriage is NOT a box of trussing. It is two flat frames of open lattice, one level with
    the arms' tops and one at their lower hinges, each wrapped round the tower's corner and
    hooked behind the next column either side, with nothing between them but the arms' own
    hinge posts and a slim stair mast: the tower shows clean through.
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
# (The hinges stand side by side at the tower's corner, 2.8 m apart: plain in every photo of the
# arms from in front, their two posts next to each other. So the arms, shut on a vehicle, are
# not parallel but a narrow V, each one's own line through its hinge ARM_LINE from the vehicle's
# centre: arm_splay() below. The app's padCollision.ts ARM_LINE must say the same.)
HINGE_X = 1.4
RAIL_IN = 1.10
ARM_LINE = RAIL_IN + 4.5
ROOT = 1.6  # where the top chords start, out from the hinge
TIP_RAKE = 1.8  # how far the first tower's bottom chords stop short of the tip
KICKER_DROP = 17.6  # the lower hinge below the hinge point
KICKER_OUT = 9.0  # where the first tower's kickers meet the bottom chords, out from the hinge


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
# frame, well back along the tower's face, to a lug on the arm outboard of its hinge (arm's frame).
ACT_Z = RAIL_TOP - 2.1
ACT_LUG = (2.4, 2.2)
ACT_BACK = 9.0  # the bracket, back along the carriage's side frame from its nose
ACT_R = 0.42
# The two designs of arm: the first tower's long one and the second's, shorter and deeper.
ARM_STYLES = {
    False: dict(depth=6.6, x_in=-0.6, x_out=1.9, chord=0.42, post=0.26, diag=0.32, knee=KICKER_OUT, tip=TIP_RAKE, panel=4.6, girder=0.9, outer=(0.84, 0.84)),
    True: dict(depth=9.0, x_in=-0.55, x_out=2.35, chord=0.5, post=0.3, diag=0.38, knee=10.4, tip=3.2, panel=5.0, girder=1.3, outer=(0.8, 1.1)),
}


def arm_splay(hang):
    """How far out of square an arm stands when shut on a vehicle `hang` in front of the carriage
    (rad). The hinges are side by side at the tower's corner, so the arms, shut, are a narrow V:
    each one's own line, through its hinge, passes ARM_LINE from the vehicle's centre."""
    return math.asin(ARM_LINE / math.hypot(HINGE_X, hang)) - math.atan2(HINGE_X, hang)


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
    """One arm (the right-hand one), `length` from its hinge to its tip, the vehicle hanging
    `hang_at` out from the hinge; `short`: the second tower's design. Returns (steel, rail): the
    truss, and the landing rail's pale top, each a MeshBuilder.

    Of round tube, as built: a rail girder along the inner top edge and a chord along the outer;
    two bottom chords that start at the kickers' heads, well out from the hinge; a post at every
    node and one diagonal a panel, all leaning out toward the tip as they go down. Inboard of the
    kickers there is no truss, only the hinge post and the fan of tubes from the lower hinge.

    Local frame: the origin at this arm's hinge, +Y along the arm, +X away from the vehicle (the
    left arm is the mirror), +Z up. (On the tower the arm stands arm_splay() out of square.)"""
    st = ARM_STYLES[short]
    mb = MeshBuilder()
    rail = MeshBuilder()
    xi, xo, rc, girder = st["x_in"], st["x_out"], st["chord"], st["girder"]
    ow, oh = st["outer"]
    x_rail = -RAIL_IN + RAIL_W / 2
    zt = RAIL_TOP - 0.18 - oh / 2  # the outer top chord's centre line (its top a hand under the rail's)
    top_in, top_out = RAIL_TOP - girder, zt - oh / 2  # the top chords' undersides
    zb = RAIL_TOP - st["depth"] + rc  # the bottom chords' centre line
    y_end = length - st["tip"]
    n = max(2, round((y_end - st["knee"]) / st["panel"]))
    ys = [st["knee"] + (y_end - st["knee"]) * k / n for k in range(n + 1)]

    # The top chords: the rail girder along the inner edge, its top the pale wearing surface the
    # pins come down on, and the outer chord (a tube on the first tower's arms, a box girder on
    # the second's).
    mb.add_box((x_rail, (ROOT + length) / 2, RAIL_TOP - 0.12 - (girder - 0.12) / 2), (RAIL_W, length - ROOT, girder - 0.12))
    rail.add_box((x_rail, (ROOT + 0.4 + length - 0.3) / 2, RAIL_TOP - 0.06), (RAIL_W, length - ROOT - 0.7, 0.12))
    if short:
        mb.add_box((xo, (ROOT + length) / 2, zt), (ow, length - ROOT, oh))
    else:
        _pipe(mb, (xo, ROOT, zt), (xo, length, zt), ow / 2, 14)
    # The bottom chords, from the kickers' heads to short of the tip.
    for x in (xi, xo):
        _pipe(mb, (x, ys[0] - 0.4, zb), (x, y_end + 0.35, zb), rc, 14)
    # The webs; the two sides tied across at every node, and braced in plan.
    for k, y in enumerate(ys):
        for x, z in ((xi, top_in), (xo, top_out)):
            _pipe(mb, (x, y, zb), (x, y, z + 0.1), st["post"])
        _pipe(mb, (xi, y, zb), (xo, y, zb), 0.26)
        if k == n:
            break
        y1 = ys[k + 1]
        for x, z in ((xi, top_in), (xo, top_out)):
            _pipe(mb, (x, y, z + 0.1), (x, y1, zb), st["diag"])
        xa, xb = (xi, xo) if k % 2 == 0 else (xo, xi)
        _pipe(mb, (xa, y, zb), (xb, y1, zb), 0.18, 8)
    tops = [ROOT, STEEP_OUT, (STEEP_OUT + st["knee"]) / 2] + ys + [length - 0.25]
    for k, y in enumerate(tops):
        mb.add_beam((x_rail, y, zt), (xo, y, zt), 0.32)
        if k + 1 < len(tops):
            xa, xb = (x_rail, xo) if k % 2 == 0 else (xo, x_rail)
            mb.add_beam((xa, y, zt), (xb, tops[k + 1], zt), 0.2)
    # The tip: a bumper on the rail's end.
    mb.add_box((x_rail, length - 0.15, RAIL_TOP - girder / 2), (RAIL_W, 0.3, girder + 0.1))
    _walkway(mb, x_rail + RAIL_W / 2 + 0.1, xo - ow / 2 - 0.1, ROOT, length - 0.3, zt + oh / 2, hang_at)

    # The root: the hinge post, the top chords run in to it, and from the lower hinge the fan:
    # the kickers to the bottom chords' ends, a steeper pair to the top chords four metres out,
    # and from the kickers' heads a tube back up to where those land. (Nothing here reaches
    # further in toward the vehicle than the rail: the constants' note on the colliders says why.)
    _root(mb, zt, xo)
    for x in (x_rail, xo):
        _pipe(mb, (0.0, 0.1, zt - 0.05), (x, ROOT + 0.3, zt - 0.05), min(0.4, rc))
    foot = Vector((0.0, 0.1, -KICKER_DROP))
    heads = [(Vector((xi, ys[0], zb)), Vector((xo, ys[0], zb)), rc),
             (Vector((xi, STEEP_OUT, top_in + 0.1)), Vector((xo, STEEP_OUT, top_out + 0.1)), rc - 0.08)]
    for pa, pb, r in heads:
        _pipe(mb, foot, pa, r, 14)
        _pipe(mb, foot, pb, r, 14)
        for f in (0.4, 0.75):
            _pipe(mb, foot.lerp(pa, f), foot.lerp(pb, f), 0.18, 8)
    _pipe(mb, heads[0][0], heads[1][0], rc - 0.1)
    _pipe(mb, heads[0][1], heads[1][1], rc - 0.1)
    _stabilizer(mb, xi + 0.1, min(max(hang_at, ys[0] + 3.2), y_end - 3.2), zb - rc)
    return mb, rail


def _side_frame(col_r, corner_d):
    """The line a carriage side frame runs along, the right-hand one (carriage's frame, plan):
    its start beside the nose, the unit vector back along the tower's face, the unit vector out
    from that face, and how far along the side column stands."""
    q = math.sqrt(0.5)
    u, n = Vector((q, -q, 0.0)), Vector((q, q, 0.0))
    front = Vector((0.0, -(corner_d - col_r), 0.0))  # the corner's own column
    return front + n * 1.95, u, n, col_r * math.sqrt(2.0)


def _mirror(v, side):
    return Vector((side * v.x, v.y, v.z))


def build_actuator(side, splay, col_r, corner_d):
    """One arm's swing cylinder (side: +1 the right-hand arm's, -1 the left's), in the carriage's
    frame, the arm shut. Returns (anchor, lug, barrel, cover, rod): the two pins it turns on, and
    three MeshBuilders: the barrel from the anchor toward the lug, the pale housing boxed round
    its tower end, and the rod from the lug back into the barrel. The app keeps the barrel and
    the rod pointing at each other as the arm swings (render/armActuators.ts): the lengths are
    set here so that, from an arm folded square out to one swung 65 deg inward, the rod neither
    leaves the barrel nor comes out of its back."""
    p0, u, n, _ = _side_frame(col_r, corner_d)
    anchor_r = p0 + u * ACT_BACK + n * 1.25 + Vector((0, 0, ACT_Z))

    def lug_at(turn):
        """The lug, the right-hand arm turned out by `turn` on its hinge (rad)."""
        a = splay + turn
        c, s_ = math.cos(a), math.sin(a)
        return Vector((HINGE_X + ACT_LUG[0] * c + ACT_LUG[1] * s_, -ACT_LUG[0] * s_ + ACT_LUG[1] * c, ACT_Z))

    spans = [(lug_at(math.radians(t)) - anchor_r).length for t in range(-65, 91, 5)]
    rod_len = min(spans) - 0.2
    barrel_len = max(spans) - rod_len + 0.25
    assert barrel_len < min(spans) - 0.1, (min(spans), max(spans))
    anchor, lug = _mirror(anchor_r, side), _mirror(lug_at(0.0), side)
    d = (lug - anchor).normalized()
    barrel, cover, rod = MeshBuilder(), MeshBuilder(), MeshBuilder()
    _pipe(barrel, anchor - d * 0.3, anchor + d * barrel_len, ACT_R, 14)
    _pipe(barrel, anchor + d * (barrel_len - 0.5), anchor + d * (barrel_len + 0.05), ACT_R + 0.08, 14)  # the gland
    _pipe(barrel, anchor - Vector((0, 0, 0.75)), anchor + Vector((0, 0, 0.75)), 0.22, 10)  # its pin
    cover.add_box(anchor + d * 0.9, (1.9, 1.25, 1.3), Matrix.Rotation(math.atan2(d.y, d.x), 3, "Z"))
    _pipe(rod, lug, lug - d * rod_len, 0.2, 12)
    _pipe(rod, lug - Vector((0, 0, 0.5)), lug + Vector((0, 0, 0.5)), 0.34, 10)  # the eye on the lug's pin
    return anchor, lug, barrel, cover, rod


def _lattice_beam(mb, p, q, w, h, panel=1.6):
    """A box beam of open lattice from p to q (its centre line), w wide and h deep: four chords,
    a frame at every panel point, the two side faces cross-braced, top and bottom braced in plan."""
    p, q = Vector(p), Vector(q)
    d = q - p
    along = d.normalized()
    side = Vector((along.y, -along.x, 0.0)).normalized() * (w / 2)
    up = Vector((0, 0, h / 2))
    for sx in (-1, 1):
        for sz in (-1, 1):
            mb.add_beam(p + side * sx + up * sz, q + side * sx + up * sz, 0.3)
    k = max(1, round(d.length / panel))
    for i in range(k + 1):
        a = p + d * (i / k)
        for sx in (-1, 1):
            mb.add_beam(a + side * sx - up, a + side * sx + up, 0.2)
        for sz in (-1, 1):
            mb.add_beam(a - side + up * sz, a + side + up * sz, 0.2)
        if i == k:
            break
        b = p + d * ((i + 1) / k)
        for sx in (-1, 1):
            mb.add_beam(a + side * sx - up, b + side * sx + up, 0.14)
            mb.add_beam(a + side * sx + up, b + side * sx - up, 0.14)
        s0, s1 = (side, -side) if i % 2 == 0 else (-side, side)
        for sz in (-1, 1):
            mb.add_beam(a + s0 + up * sz, b + s1 + up * sz, 0.14)


def build_carriage(col_r, corner_d):
    """The carriage, as the photos of it going up the first tower and of the one in Florida show
    it: two flat frames of open lattice, one level with the arms' tops and one at their lower
    hinges, each wrapped round the tower's corner toward the vehicle: a solid nose in front of
    the corner's own column, with a fork either side of the centre line for an arm's pin, and
    from it a side frame back along each face of the tower, hooked round the next column.
    Skates on the three columns, on each frame. BETWEEN the two frames there is nothing but the
    arms' own hinge posts and a slim stair mast behind them: the tower shows clean through.

    In the carriage's frame: the origin midway between the hinges, +Y toward the vehicle, +Z up.
    `corner_d`: the tower's centre behind the origin; `col_r`: its columns' centres out from
    that centre."""
    mb = MeshBuilder()
    z1 = RAIL_TOP - 0.9  # the upper frame's centre line (its top a hand under the rails')
    z0 = -KICKER_DROP  # the lower frame's
    w, h = 1.3, 1.3  # the side frames' section
    hx = HINGE_X
    p0, u, n, at_col = _side_frame(col_r, corner_d)
    front = Vector((0.0, -(corner_d - col_r), 0.0))
    for z, barrel in ((z1, BARREL_Z), (z0, (z0 - 0.7, z0 + 0.7))):
        up = Vector((0, 0, z))
        # The nose, and the forks: a plate over and under each pin's barrel.
        mb.add_box((0.0, -1.0, z), (2 * hx + 2.2, 0.95, h))
        for sx in (-1, 1):
            for zp in (barrel[0] - 0.14, barrel[1] + 0.14):
                mb.add_box((sx * hx, -0.3, zp), (1.9, 2.1, 0.28))
        for sx in (-1, 1):
            a = _mirror(p0, sx) + up
            end = _mirror(p0 + u * (at_col + 1.25), sx) + up
            hook = _mirror(p0 + u * (at_col + 1.25) - n * 2.7, sx) + up
            _lattice_beam(mb, a, end, w, h)
            _lattice_beam(mb, end, hook, w, h)
            mb.add_box(end, (w + 0.3, w + 0.3, h + 0.1), Matrix.Rotation(sx * -math.pi / 4, 3, "Z"))
            # Skates: on the corner's own column, on the side column beside the frame, and
            # behind it on the hook.
            turn = Matrix.Rotation(sx * -math.pi / 4, 3, "Z")
            side_col = Vector((col_r, -corner_d, 0.0))
            for c, size in ((front + n * 1.12, (1.5, 0.55, 1.7)), (side_col + n * 1.12, (1.6, 0.55, 1.7)), (side_col + u * 1.12, (0.55, 1.6, 1.7))):
                mb.add_box(_mirror(c, sx) + up, size, turn)
    # A walkway along the upper frame's top, railed on its outer side.
    top = z1 + h / 2
    for sx in (-1, 1):
        a = _mirror(p0 + u * 0.4, sx) + Vector((0, 0, top + 0.04))
        b = _mirror(p0 + u * (at_col + 1.6), sx) + Vector((0, 0, top + 0.04))
        mb.add_beam(a, b, w, 0.08)
        out = _mirror(n, sx) * (w / 2 - 0.05)
        _handrail(mb, a + out, b + out)
    # The stair mast between the frames, behind the hinge posts: four slim legs, cross-braced,
    # a landing every few metres.
    mx, my, mw, md = 0.0, -1.0, 0.55, 0.42
    legs = [(mx - mw, my - md), (mx + mw, my - md), (mx + mw, my + md), (mx - mw, my + md)]
    for x, y in legs:
        mb.add_beam((x, y, z0), (x, y, z1), 0.14)
    k = max(2, round((z1 - z0) / 2.6))
    for i in range(k):
        za, zc = z0 + (z1 - z0) * i / k, z0 + (z1 - z0) * (i + 1) / k
        for j in range(4):
            (xa, ya), (xb, yb) = legs[j], legs[(j + 1) % 4]
            lo, hi = (za, zc) if (i + j) % 2 == 0 else (zc, za)
            mb.add_beam((xa, ya, lo), (xb, yb, hi), 0.08)
            mb.add_beam((xa, ya, zc), (xb, yb, zc), 0.08)
        if i % 2 == 1:
            mb.add_box((mx, my, zc), (2 * mw, 2 * md, 0.06))
    # The swing cylinders' brackets, hung under the upper frame's outer side.
    for sx in (-1, 1):
        on = _mirror(p0 + u * ACT_BACK, sx)
        pin = _mirror(p0 + u * ACT_BACK + n * 1.25, sx)
        for z in (ACT_Z + 0.75, ACT_Z - 0.75):
            mb.add_box(pin + Vector((0, 0, z)), (1.1, 1.1, 0.25))
            mb.add_beam(on + _mirror(n, sx) * (w / 2) + Vector((0, 0, z1 - h / 2)), pin + Vector((0, 0, z)), 0.4)
        mb.add_beam(pin + Vector((0, 0, ACT_Z - 0.75)), pin + Vector((0, 0, z1 - h / 2)), 0.3)
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
