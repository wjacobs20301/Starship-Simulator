"""Starbase launch tower, chopsticks and ship QD arm from MikeNotBrick's 1:144 print kit
(the V3 launch mount and flame trench are built in pad_v3.py).

Source: "Starship Launch Tower & Launch Pad with Functional Chopsticks (1:144 scale)"
by MikeNotBrick, https://www.thingiverse.com/thing:5908857, licensed CC BY 4.0.
Changes: parts scaled 144x to full size, re-assembled for the game, print-only parts
(base tripod, pegs, spools, segment locks) dropped, PBR materials applied.

The STL files live in art/source/tower/stl/STLs (see art/source/README.md).
"""

import math
import os

import bpy
from mathutils import Matrix, Vector

from lib import ROOT, MeshBuilder, parent_keep, pivot

KIT = os.path.join(ROOT, "art", "source", "tower", "stl", "STLs")
SCALE = 0.144  # 1 mm at 1:144 -> 0.144 m

# Kit dimensions (mm, model scale), measured from the STLs.
BASE_TOP = 76.4  # top of the tower's base block
SEGMENT_PITCH = 127.2  # main segment body height (bottom 75.5 + top 51.7), pegs excluded
N_SEGMENTS = 7
PAD_TOP = 162.1  # top of the launch mount ring
PAD_GROUND = -15.0  # bottom of the launch mount base plate


def import_part(rel, name, material, world_offset, loc=(0, 0, 0), rot_z=0.0, mirror_y=False):
    """Import one STL; bake scale / mirror / rotation into the mesh.
    loc is in kit millimetres (applied before rotation), world_offset in metres."""
    bpy.ops.wm.stl_import(filepath=os.path.join(KIT, rel))
    obj = bpy.context.selected_objects[0]
    obj.name = name
    obj.data.name = name
    m = (Matrix.Translation(Vector(world_offset)) @ Matrix.Rotation(rot_z, 4, "Z")
         @ Matrix.Diagonal((SCALE, -SCALE if mirror_y else SCALE, SCALE, 1.0))
         @ Matrix.Translation(Vector(loc)))
    obj.data.transform(m)
    if mirror_y:
        obj.data.flip_normals()
    obj.data.materials.clear()
    obj.data.materials.append(material)
    obj.data.polygons.foreach_set("use_smooth", [False] * len(obj.data.polygons))
    return obj


def join(objs, name):
    """Merge meshes (fewer draw calls at runtime)."""
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    return objs[0]


# How far the connected QD hood's face sits from the ship's hull, m (touching).
QD_CONTACT_GAP = 0.02


# Layout (kit millimetres). The kit's +Y points from the tower to the rocket. The real towers
# stand with a CORNER toward the launch mount: the carriage rides the rails on that corner's leg
# and its two neighbours, and the chopsticks and the ship QD arm come off that corner edge. The
# kit has the tower square to the rocket and the arms hinged at its centre, so the lattice is
# turned 45 deg and the arms hinge at the corner instead (their part inside the tower trimmed).
CARRIAGE_Z = 680.0  # arms straddle the booster's upper section / grid fins
TOWER_HALF = 52.8  # the lattice's half-width, kit mm (15.2 m)
CORNER = TOWER_HALF * math.sqrt(2.0)  # tower centre to its corner, kit mm (10.75 m)


def trim(obj, plane_co, plane_no):
    """Delete geometry on the +normal side of a plane (mesh coordinates = world here)."""
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=plane_co, plane_no=plane_no,
                           clear_outer=True)
    bm.to_mesh(obj.data)
    bm.free()


def build_tower_kit(root, mats, geo, spec):
    """spec: {prefix, mount: [east, north] m, tower: [east, north] m relative to the mount}.
    Pad-local ground is z = 0; node names get the prefix (e.g. Pad1_Carriage)."""
    pad = geo["pad"]
    pre = spec["prefix"]
    s = SCALE
    mount = Vector((spec["mount"][0], spec["mount"][1], 0.0))
    to_mount = -Vector((spec["tower"][0], spec["tower"][1], 0.0))
    ROCKET_DIST = to_mount.length / s  # kit mm
    # Rotate the kit so its +Y (tower -> rocket) points from this pad's tower to its mount.
    KIT_TO_WORLD = Matrix.Rotation(math.atan2(-to_mount.x, to_mount.y), 4, "Z")
    tower_origin = mount - to_mount + Vector((0.0, 0.0, -2.0 * s))  # base block bottom sits on the ground

    def place(rel, name, mat, loc=(0, 0, 0), mirror_x=False, extra=None):
        bpy.ops.wm.stl_import(filepath=os.path.join(KIT, rel))
        obj = bpy.context.selected_objects[0]
        obj.name = obj.data.name = name
        m = Matrix.Translation(Vector(loc))
        if mirror_x:
            m = Matrix.Diagonal((-1, 1, 1, 1)) @ m
        if extra is not None:
            m = extra @ m
        m = Matrix.Translation(tower_origin) @ KIT_TO_WORLD @ Matrix.Diagonal((s, s, s, 1)) @ m
        obj.data.transform(m)
        if mirror_x:
            obj.data.flip_normals()
        obj.data.materials.clear()
        obj.data.materials.append(mat)
        obj.data.polygons.foreach_set("use_smooth", [False] * len(obj.data.polygons))
        return obj

    # --- Tower: base block, 7 lattice segments, top segment (a corner toward the rocket) ----
    corner_on = Matrix.Rotation(math.pi / 4, 4, "Z")
    parts = [place("Launch tower/BaseTop.stl", pre + "Tower_Base", mats.concrete, extra=corner_on)]
    z = BASE_TOP
    steel = []
    for i in range(N_SEGMENTS):
        steel.append(place("Launch tower/MainSegmentBottom.stl", f"Seg{i}A", mats.tower, (0, 0, z), extra=corner_on))
        steel.append(place("Launch tower/MainSegmentTop.stl", f"Seg{i}B", mats.tower, (0, 0, z), extra=corner_on))
        z += SEGMENT_PITCH
    steel.append(place("Launch tower/TopSegmentBottom.stl", "TopA", mats.tower, (0, 0, z), extra=corner_on))
    steel.append(place("Launch tower/TopSegmentTop.stl", "TopB", mats.tower, (0, 0, z), extra=corner_on))
    tower = join(steel, pre + "Tower")
    for o in parts + [tower]:
        o.parent = root

    # --- Carriage and chopsticks ------------------------------------------------
    # The carriage (and the arms' hinge) on the tower's corner toward the rocket.
    hinge = tower_origin + KIT_TO_WORLD @ Vector((0, CORNER * s, CARRIAGE_Z * s))
    inside = KIT_TO_WORLD.to_3x3() @ Vector((0, -1, 0))  # from the corner back into the tower
    carriage = pivot(pre + "Carriage", tuple(hinge), parent=root)
    # (The kit's carriage plate, where its hand-crank cable hooked on, is left out: the carriage
    # hangs from the travelling block of the hoisting rigging, built at runtime.)
    # Arm "R" lies on the kit's +X side (right of the tower -> mount line) when closed; "L" is its mirror.
    # Opening = rotating L by +angle and R by -angle about the vertical hinge.
    for tag, mirror in (("R", False), ("L", True)):
        node = pivot(f"{pre}Chopstick_{tag}", tuple(hinge), parent=carriage)
        arm = place("Chopsticks/Chopstick.stl", f"{pre}Chopstick_{tag}_Arm", mats.chopstick, (0, 0, CARRIAGE_Z), mirror_x=mirror)
        trim(arm, hinge, inside)
        parent_keep(arm, node)

    # --- Ship quick-disconnect arm ------------------------------------------------
    # The kit arm is modeled for a longer tower-to-mount distance; shorten its straight run so the
    # hood sits against the ship's leeward side at the QD plate height (connected, as it is while
    # the ship is fuelled). The hood's front isn't one known point of the kit, so fit it: measure
    # how far the placed arm's nearest part stops from the hull and correct, a few times.
    ship_qd_z = pad["mountHeight"] + geo["ship"]["xBase"] + 3.4
    qd_kit_z = (ship_qd_z - tower_origin.z) / s - 35.0  # the arm's hood sits ~35 mm above its base
    root_kit = Vector((-43.0, 0.0))
    tip_kit = Vector((190.0, -136.0))
    ship_r = geo["ship"]["radius"]

    # Hinged on the tower's side corner leg (not the front corner the carriage rides), reaching
    # across to the ship; it swings out the other way, clear of the rocket and the carriage.
    qd_hinge_kit = Vector((-CORNER, 0.0))
    to_ship = Vector((0.0, ROCKET_DIST)) - qd_hinge_kit

    def qd_matrix(reach_kit):
        target = to_ship.normalized() * reach_kit
        d_tip = tip_kit - root_kit
        k = target.length / d_tip.length
        ang = math.atan2(target.y, target.x) - math.atan2(d_tip.y, d_tip.x)
        extra = (Matrix.Translation((qd_hinge_kit.x, qd_hinge_kit.y, qd_kit_z)) @ Matrix.Rotation(ang, 4, "Z")
                 @ Matrix.Diagonal((k, k, 1, 1)) @ Matrix.Translation((-root_kit.x, -root_kit.y, 0)))
        return Matrix.Translation(tower_origin) @ KIT_TO_WORLD @ Matrix.Diagonal((s, s, s, 1)) @ extra

    bpy.ops.wm.stl_import(filepath=os.path.join(KIT, "QD Arm/QD Arm.stl"))
    arm = bpy.context.selected_objects[0]
    arm.name = arm.data.name = pre + "ShipQD_Arm"
    kit_verts = [v.co.copy() for v in arm.data.vertices]
    reach = to_ship.length - ship_r / s

    def gap(reach_kit):
        m = qd_matrix(reach_kit)
        return min(((m @ v).xy - mount.xy).length for v in kit_verts) - ship_r

    for _ in range(4):
        reach += (gap(reach) - QD_CONTACT_GAP) / s
    arm.data.transform(qd_matrix(reach))
    arm.data.materials.clear()
    arm.data.materials.append(mats.chopstick)
    arm.data.polygons.foreach_set("use_smooth", [False] * len(arm.data.polygons))
    print(f"{pre}ShipQD hood gap to the hull: {gap(reach):.3f} m")
    qd_root = tower_origin + KIT_TO_WORLD @ Vector((qd_hinge_kit.x * s, qd_hinge_kit.y * s, qd_kit_z * s))
    node = pivot(pre + "ShipQD", tuple(qd_root), parent=root)
    parent_keep(arm, node)
    # Its hinge: a post on the tower's corner leg, with brackets top and bottom (fixed to the tower).
    hinge_mb = MeshBuilder()
    yaw = Matrix.Rotation(math.atan2(-to_mount.x, to_mount.y) + math.pi / 4, 4, "Z")
    hinge_mb.add_box(tuple(qd_root + Vector((0, 0, 2.0))), (1.4, 1.4, 9.0), yaw)
    to_leg = (KIT_TO_WORLD.to_3x3() @ Vector((1, 0, 0))).normalized()  # from the hinge in toward the tower
    for dz in (-2.0, 6.0):
        hinge_mb.add_box(tuple(qd_root + to_leg * 0.9 + Vector((0, 0, dz))), (2.2, 2.2, 0.8), yaw)
    hinge_mb.build(pre + "ShipQD_Hinge", mats.tower, parent=root)
    return tower
