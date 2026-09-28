"""Starship / Super Heavy from Clarence365's "SpaceX Starship Block 3" (Sketchfab, CC BY 4.0).

Source: https://sketchfab.com/3d-models/spacex-starship-block-3-6f6c6f88a3eb4b4d822fdca66733fbb2
Changes: scaled to full size (~1:5 in the source), rotated to the sim's body frame, split into
booster and ship, engines/fins/flaps given pivot nodes the runtime drives, meshes decimated
for real-time use, broken texture paths relinked.

Frame written to the GLBs (see lib.py): Blender Z = body x (stack axis), X = body y, Y = body z.
Booster: nozzle exits at z = 0. Ship: stack frame shifted down by the booster length, so the
runtime can place it at y = BOOSTER_LENGTH exactly like before.
"""

import math
import os

import bpy
from mathutils import Matrix, Vector

from lib import ROOT, empty, parent_keep, pivot

SRC_DIR = os.path.join(ROOT, "art", "source", "vehicle")
BLEND = os.path.join(SRC_DIR, "source", "Starship Block 3 V4.blend")
TEX_DIR = os.path.join(SRC_DIR, "textures")

BOOSTER_ROOT = "Superheavy Block 3 V4"
SHIP_ROOT = "Starship Block 3 V4"
# Source units: booster spans z = 0.0 (nozzle exits) .. 14.55 (top of the hot stage).
SRC_BOOSTER_TOP = 14.55
SRC_AXIS = Vector((0.042, -0.030))  # stack axis in the source file (booster object origin)

# Triangle budgets (fraction kept by the Decimate modifier).
DECIMATE = {"engine": 0.12, "booster": 0.35, "ship": 0.6, "small": 1.0}


def open_source():
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    relink_images()
    fix_materials()
    for name in ("Camera", "Sun"):
        if name in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[name])


# Materials whose look comes from procedural nodes glTF can't carry (they export as flat
# white). Replaced with plain PBR stainless steel.
STEEL_MATERIALS = {"Cryo Section1", "Cryo Section3", "Material.461", "Material.464"}
# Decals the source overlays onto steel with a blend node. Baked into colour + metal/roughness
# textures. The serial number is also redrawn at runtime from a setting (src/settings.ts).
DECALS = {"Logo": "starshipxlogov2.png", "Serial Number": "Starship_S45.png"}
# Keep in sync with src/render/decals.ts. The background matches the hull around the decals
# (the source's steel material: white, 96% metallic, roughness texture averaging 0.48).
STEEL_SRGB = (255, 255, 255)
STEEL_METAL, STEEL_ROUGH = 0.96, 0.48
PAINT_SRGB = (8, 8, 8)
PAINT_METAL, PAINT_ROUGH = 0.0, 0.55


def bake_decal(mat, image_file):
    """Black paint on steel: colour texture plus a glTF metal/roughness texture (G = roughness,
    B = metalness) so the paint is matte and non-metallic while the steel stays polished."""
    import numpy as np

    from lib import TEX_DIR as GENERATED_TEX_DIR

    src = bpy.data.images.load(os.path.join(TEX_DIR, image_file))
    w, h = src.size
    px = np.array(src.pixels[:], dtype=np.float32).reshape(h, w, 4)
    lum = px[..., :3].mean(axis=-1)
    paint = np.clip((0.55 - lum) / 0.3, 0.0, 1.0)[..., None]
    steel = np.array(STEEL_SRGB, dtype=np.float32) / 255
    ink = np.array(PAINT_SRGB, dtype=np.float32) / 255
    color = steel * (1 - paint) + ink * paint
    rough = STEEL_ROUGH + (PAINT_ROUGH - STEEL_ROUGH) * paint
    metal = STEEL_METAL + (PAINT_METAL - STEEL_METAL) * paint
    mr = np.concatenate([np.ones_like(paint), rough, metal], axis=-1)
    os.makedirs(GENERATED_TEX_DIR, exist_ok=True)

    def save(name, rgb, non_color):
        img = bpy.data.images.new(name, width=w, height=h, alpha=False)
        if non_color:
            img.colorspace_settings.name = "Non-Color"
        img.pixels.foreach_set(np.concatenate([rgb, np.ones((h, w, 1), np.float32)], axis=-1).ravel())
        img.filepath_raw = os.path.join(GENERATED_TEX_DIR, name + ".png")
        img.file_format = "PNG"
        img.save()
        return img

    key = mat.name.lower().replace(" ", "_")
    col_img = save(f"decal_{key}_color", color, False)
    mr_img = save(f"decal_{key}_mr", mr, True)
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type != "OUTPUT_MATERIAL":
            nt.nodes.remove(n)
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tc = nt.nodes.new("ShaderNodeTexImage")
    tc.image = col_img
    nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    tm = nt.nodes.new("ShaderNodeTexImage")
    tm.image = mr_img
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(tm.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])


def fix_materials():
    for mat in bpy.data.materials:
        if not mat.node_tree:
            continue
        bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is None:
            continue
        if mat.name in DECALS:
            bake_decal(mat, DECALS[mat.name])
        elif mat.name in STEEL_MATERIALS:
            nt = mat.node_tree
            for n in list(nt.nodes):
                if n.type not in ("BSDF_PRINCIPLED", "OUTPUT_MATERIAL"):
                    nt.nodes.remove(n)
            out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
            nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
            bsdf.inputs["Base Color"].default_value = (0.62, 0.63, 0.65, 1)
            bsdf.inputs["Metallic"].default_value = 1.0
            bsdf.inputs["Roughness"].default_value = 0.32
        elif mat.name == "Heatshield Tiles":
            # Ceramic tiles: not metallic.
            for link in list(mat.node_tree.links):
                if link.to_socket == bsdf.inputs["Metallic"]:
                    mat.node_tree.links.remove(link)
            bsdf.inputs["Metallic"].default_value = 0.0


def relink_images():
    """The .blend points at the author's folders; use the textures shipped in the zip."""
    available = {f.lower().replace("_", " "): os.path.join(TEX_DIR, f) for f in os.listdir(TEX_DIR)}
    for img in bpy.data.images:
        if not img.filepath:
            continue
        base = os.path.basename(img.filepath.replace("\\", "/")).lower().replace("_", " ")
        stem = os.path.splitext(base)[0]
        match = available.get(base) or next((p for k, p in available.items() if os.path.splitext(k)[0] == stem), None)
        if match:
            img.filepath = match
            img.reload()


def bake_modifiers(obj):
    """Replace the mesh with its evaluated version (applies the 'Auto Smooth' geometry nodes)."""
    dg = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    obj.modifiers.clear()
    obj.data = mesh


def world_transform(ship_shift=0.0):
    """Source -> sim frame: center on the stack axis, rotate 180 deg about Z (the source has the
    heat shield / rudder fin on -X; the sim puts them on +X), and scale to 72.3 m booster length."""
    s = 72.3 / SRC_BOOSTER_TOP
    return (Matrix.Translation((0, 0, -ship_shift)) @ Matrix.Rotation(math.pi, 4, "Z")
            @ Matrix.Diagonal((s, s, s, 1)) @ Matrix.Translation((-SRC_AXIS.x, -SRC_AXIS.y, 0)))


def decimate(obj, ratio):
    if ratio >= 1.0:
        return
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    mod.ratio = ratio
    mod.use_collapse_triangulate = True


def bbox(obj):
    xs = [v.co for v in obj.data.vertices]
    mn = Vector((min(v.x for v in xs), min(v.y for v in xs), min(v.z for v in xs)))
    mx = Vector((max(v.x for v in xs), max(v.y for v in xs), max(v.z for v in xs)))
    return mn, mx


def build_stage(stage, geo):
    """Keep one stage of the source, bake it into the sim frame and add pivot nodes."""
    keep_root = BOOSTER_ROOT if stage == "booster" else SHIP_ROOT
    drop_root = SHIP_ROOT if stage == "booster" else BOOSTER_ROOT
    for o in list(bpy.data.objects[drop_root].children_recursive) + [bpy.data.objects[drop_root]]:
        bpy.data.objects.remove(o)

    shift = 0.0 if stage == "booster" else geo["booster"]["length"]
    m = world_transform(shift)
    objs = [bpy.data.objects[keep_root]] + list(bpy.data.objects[keep_root].children_recursive)
    worlds = {o.name: o.matrix_world.copy() for o in objs}
    for o in objs:
        if o.data.users > 1:
            o.data = o.data.copy()
        bake_modifiers(o)
    for o in objs:
        o.parent = None
        o.data.transform(m @ worlds[o.name])
        o.matrix_world = Matrix.Identity(4)

    root = empty("Booster" if stage == "booster" else "Ship")
    body = bpy.data.objects[keep_root]
    body.name = f"{root.name}_Body"
    body.parent = root
    decimate(body, DECIMATE[stage])

    sim_engines = geo[stage]["engines"]
    x_base = geo[stage]["xBase"]
    engines = [o for o in objs if o.name.startswith("Raptor")]
    used = set()
    for o in engines:
        mn, mx = bbox(o)
        center = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2))
        gimbal = Vector((center.x, center.y, mx.z))
        # Nearest simulated engine of the same kind (sim body (y, z) == Blender (x, y)).
        vac = "Vac" in o.name
        # The source models the booster's 13 steerable engines individually; the fixed outer
        # ring is part of the body mesh.
        cands = [e for e in sim_engines if e["vacuum"] == vac and e["gimbals"] == (not vac)
                 and e["index"] not in used]
        best = min(cands, key=lambda e: (Vector((e["pos"][1], e["pos"][2])) - center).length)
        used.add(best["index"])
        node = empty(f"Engine_{best['index']:02d}", tuple(gimbal), parent=root)
        o.name = f"Engine_{best['index']:02d}_Mesh"
        parent_keep(o, node)
        decimate(o, DECIMATE["engine"])
        print(f"engine {o.name}: sim {best['pos']} model {tuple(round(v, 2) for v in gimbal)} (z base {x_base})")

    for o in objs:
        n = o.name
        if n.startswith("Grid Fin"):
            mn, mx = bbox(o)
            c = (mn + mx) / 2
            radial = Vector((c.x, c.y, 0)).normalized()
            if abs(radial.y) > abs(radial.x):
                name = "GridFin_Catch_A" if radial.y > 0 else "GridFin_Catch_B"
            else:
                name = "GridFin_Rudder"
            hinge = radial * min(Vector((v.co.x, v.co.y, 0)).length for v in o.data.vertices)
            hinge.z = c.z
            node = pivot(name, tuple(hinge), z_axis=tuple(radial), parent=root)
            o.name = name + "_Mesh"
            parent_keep(o, node)
        elif "Flap" in n:
            fwd = n.startswith("Foward")
            mn, mx = bbox(o)
            c = (mn + mx) / 2
            side = "L" if c.y > 0 else "R"
            name = f"Flap_{'Fwd' if fwd else 'Aft'}_{side}"
            # Hinge line: the flap's inner (hull-side) edge. Per height band take the vertex
            # closest to the stack axis, and run the hinge from the bottom band's to the top
            # band's. (The forward flaps sit on the tapering nosecone, so the vertices closest
            # to the axis overall all lie near their top: a hinge from those is badly skewed.)
            verts = [v.co.copy() for v in o.data.vertices]
            z0 = min(v.z for v in verts)
            z1 = max(v.z for v in verts)
            bands = 8
            edge = []
            for b in range(bands):
                lo_z = z0 + (z1 - z0) * b / bands
                hi_z = z0 + (z1 - z0) * (b + 1) / bands
                band = [v for v in verts if lo_z <= v.z <= hi_z]
                if band:
                    edge.append(min(band, key=lambda v: Vector((v.x, v.y)).length))
            lo = edge[0]
            hi = edge[-1]
            print(f"{name}: hinge {tuple(round(x, 2) for x in lo)} -> {tuple(round(x, 2) for x in hi)}")
            node = pivot(name, tuple(lo), z_axis=tuple((hi - lo).normalized()), parent=root)
            o.name = name + "_Mesh"
            parent_keep(o, node)
        elif o is not body and not n.startswith("Engine_") and o.parent is None:
            o.parent = root
    return root
