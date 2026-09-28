"""Shared helpers for the procedural Starship / Starbase model scripts.

Run inside Blender (headless is fine):
    Blender -b --factory-startup -P art/blender/build_all.py

Conventions
- Blender units are metres. Z is up (glTF export converts to +Y up).
- Vehicle models: Blender X = body +y, Blender Y = body +z, Blender Z = body +x (the
  stack axis). This matches the three.js mesh frame used at runtime.
- Pad model: Blender X = East, Y = North, Z = Up, origin at the launch mount axis at
  ellipsoid height 0.
- UVs are in metres divided by each texture's physical size, so tileable textures keep a
  true-to-scale look (weld seams every ~1.83 m, ~0.29 m heat-shield tiles).
"""

import json
import math
import os

import bmesh  # noqa: F401  (kept for ad-hoc experiments)
import bpy
import numpy as np
from mathutils import Matrix, Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
GEOMETRY_JSON = os.path.join(ROOT, "art", "generated", "geometry.json")
TEX_DIR = os.path.join(ROOT, "art", "generated", "textures")
OUT_DIR = os.path.join(ROOT, "art", "generated", "glb")
PREVIEW_DIR = os.path.join(ROOT, "art", "generated", "previews")


def load_geometry():
    with open(GEOMETRY_JSON) as f:
        return json.load(f)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def body_to_blender(p):
    """Body (x along axis, y, z) -> Blender (X, Y, Z)."""
    return Vector((p[1], p[2], p[0]))


# ---------------------------------------------------------------------------
# Mesh building
# ---------------------------------------------------------------------------


class MeshBuilder:
    """Accumulates geometry (with per-corner UVs) and emits a single Blender object."""

    def __init__(self):
        self.verts = []
        self.faces = []
        self.uvs = []  # one (u, v) per face corner, in face order
        self.smooth = []

    # -- primitives ----------------------------------------------------------

    def add_face(self, pts, uvs, smooth=False):
        base = len(self.verts)
        self.verts.extend(Vector(p) for p in pts)
        self.faces.append(list(range(base, base + len(pts))))
        self.uvs.extend(uvs)
        self.smooth.append(smooth)

    def add_grid(self, rows, uv_rows, smooth=True, close_u=False):
        """rows: list of rows of points (a quad grid); uv_rows matches in shape."""
        base = len(self.verts)
        nr, nc = len(rows), len(rows[0])
        for row in rows:
            self.verts.extend(Vector(p) for p in row)
        cols = nc if close_u else nc - 1
        for i in range(nr - 1):
            for j in range(cols):
                j1 = (j + 1) % nc
                a, b = base + i * nc + j, base + i * nc + j1
                c, d = base + (i + 1) * nc + j1, base + (i + 1) * nc + j
                self.faces.append([a, b, c, d])
                self.uvs.extend([uv_rows[i][j], uv_rows[i][j1], uv_rows[i + 1][j1], uv_rows[i + 1][j]])
                self.smooth.append(smooth)

    def add_box(self, center, size, rot=None, uv_size=1.0):
        """Axis-aligned box (then rotated by the 3x3/4x4 matrix `rot` about its center)."""
        c = Vector(center)
        sx, sy, sz = (s / 2 for s in size)
        m = rot.to_3x3() if rot is not None else Matrix.Identity(3)
        corners = {}
        for ix in (-1, 1):
            for iy in (-1, 1):
                for iz in (-1, 1):
                    corners[(ix, iy, iz)] = c + m @ Vector((ix * sx, iy * sy, iz * sz))
        faces = [
            ((1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1), (size[1], size[2])),
            ((-1, 1, -1), (-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (size[1], size[2])),
            ((1, 1, -1), (-1, 1, -1), (-1, 1, 1), (1, 1, 1), (size[0], size[2])),
            ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1), (size[0], size[2])),
            ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1), (size[0], size[1])),
            ((-1, 1, -1), (1, 1, -1), (1, -1, -1), (-1, -1, -1), (size[0], size[1])),
        ]
        for a, b, cc, d, (w, h) in faces:
            u, v = w / uv_size, h / uv_size
            self.add_face([corners[a], corners[b], corners[cc], corners[d]], [(0, 0), (u, 0), (u, v), (0, v)])

    def add_beam(self, p0, p1, width, height=None, up=(0, 0, 1), uv_size=1.0):
        """Rectangular beam between two points."""
        p0, p1 = Vector(p0), Vector(p1)
        axis = p1 - p0
        length = axis.length
        if length < 1e-6:
            return
        x = axis.normalized()
        upv = Vector(up)
        if abs(x.dot(upv)) > 0.99:
            upv = Vector((1, 0, 0)) if abs(x.x) < 0.9 else Vector((0, 1, 0))
        y = upv.cross(x).normalized()
        z = x.cross(y)
        m = Matrix((x, y, z)).transposed()
        self.add_box((p0 + p1) / 2, (length, width, height or width), m, uv_size)

    def add_lathe(self, profile, segments, theta0=0.0, theta1=2 * math.pi, u_size=4.0, v_size=4.0,
                  smooth=True, matrix=None, v_offset=0.0):
        """Surface of revolution about Z. profile: [(r, z), ...] from bottom to top.
        UVs: u = arc length at the base radius / u_size, v = distance along profile / v_size."""
        full = abs(theta1 - theta0 - 2 * math.pi) < 1e-9
        n = segments + 1
        s_along = [v_offset]
        for k in range(1, len(profile)):
            (r0, z0), (r1, z1) = profile[k - 1], profile[k]
            s_along.append(s_along[-1] + math.hypot(r1 - r0, z1 - z0))
        r_ref = max(r for r, _ in profile)
        rows, uv_rows = [], []
        for k, (r, z) in enumerate(profile):
            row, uvr = [], []
            for j in range(n):
                t = theta0 + (theta1 - theta0) * j / segments
                p = Vector((r * math.cos(t), r * math.sin(t), z))
                if matrix is not None:
                    p = matrix @ p
                row.append(p)
                uvr.append(((t - theta0) * r_ref / u_size, s_along[k] / v_size))
            rows.append(row)
            uv_rows.append(uvr)
        # A full revolution keeps a duplicated seam column so UVs don't wrap backwards.
        self.add_grid(rows, uv_rows, smooth=smooth, close_u=False)
        return full

    def add_disc(self, radius, z, segments, inner=0.0, uv_size=4.0, facing_up=True):
        rows, uvs = [], []
        for r in ((radius, inner) if facing_up else (inner, radius)):
            row, uvr = [], []
            for j in range(segments + 1):
                t = 2 * math.pi * j / segments
                x, y = r * math.cos(t), r * math.sin(t)
                row.append((x, y, z))
                uvr.append((x / uv_size, y / uv_size))
            rows.append(row)
            uvs.append(uvr)
        self.add_grid(rows, uvs, smooth=False)

    def add_prism(self, outline, z0, z1, uv_size=1.0, matrix=None):
        """Extrude a convex 2D outline (XY, counter-clockwise) from z0 to z1."""
        pts0 = [Vector((x, y, z0)) for x, y in outline]
        pts1 = [Vector((x, y, z1)) for x, y in outline]
        if matrix is not None:
            pts0 = [matrix @ p for p in pts0]
            pts1 = [matrix @ p for p in pts1]
        n = len(outline)
        self.add_face(list(reversed(pts0)), [(x / uv_size, y / uv_size) for x, y in reversed(outline)])
        self.add_face(pts1, [(x / uv_size, y / uv_size) for x, y in outline])
        for i in range(n):
            j = (i + 1) % n
            w = (Vector(outline[j]) - Vector(outline[i])).length / uv_size
            h = (z1 - z0) / uv_size
            self.add_face([pts0[i], pts0[j], pts1[j], pts1[i]], [(0, 0), (w, 0), (w, h), (0, h)])

    # -- output ----------------------------------------------------------------

    def build(self, name, material, parent=None, collection=None):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in self.verts], [], self.faces)
        uv = mesh.uv_layers.new(name="UVMap")
        flat = [c for uvp in self.uvs for c in uvp]
        uv.data.foreach_set("uv", flat)
        mesh.polygons.foreach_set("use_smooth", self.smooth)
        mesh.validate()
        mesh.materials.append(material)
        obj = bpy.data.objects.new(name, mesh)
        (collection or bpy.context.scene.collection).objects.link(obj)
        if parent is not None:
            obj.parent = parent
        return obj


def empty(name, location=(0, 0, 0), parent=None, rotation=None):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 1.0
    obj.location = location
    if rotation is not None:
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = rotation
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


def parent_keep(child, parent):
    """Parent without moving the child (geometry built in world space rotates about the parent)."""
    bpy.context.view_layer.update()
    child.parent = parent
    child.matrix_parent_inverse = parent.matrix_world.inverted()


def pivot(name, location, z_axis=(0, 0, 1), parent=None):
    """Empty whose local +Z is the hinge axis; the runtime rotates it about local Z."""
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_size = 1.0
    obj.location = location
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = Vector(z_axis).normalized().to_track_quat("Z", "Y")
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        parent_keep(obj, parent)
    return obj


def link_mesh(name, mesh, parent=None, location=(0, 0, 0), rotation=None):
    """Object sharing mesh data (exported as a shared glTF mesh)."""
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    if rotation is not None:
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = rotation
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
    return obj


# ---------------------------------------------------------------------------
# Procedural, tileable textures (numpy; periodic by construction)
# ---------------------------------------------------------------------------

_rng = np.random.default_rng(7)


def fractal_noise(h, w, beta=2.0, seed=0):
    """Periodic 1/f^beta noise in [0, 1] via FFT filtering of white noise."""
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((h, w))
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.fftfreq(w)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    spec = np.fft.fft2(white) / f ** (beta / 2)
    spec[0, 0] = 0
    n = np.real(np.fft.ifft2(spec))
    n -= n.min()
    return n / max(n.max(), 1e-9)


def normal_from_height(height, strength, px_per_m):
    """Tangent-space normal map (OpenGL / glTF convention) from a periodic height field in metres."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * px_per_m / 2
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * px_per_m / 2
    nx, ny = -dx * strength, -dy * strength
    nz = np.ones_like(height)
    inv = 1 / np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx * inv * 0.5 + 0.5, ny * inv * 0.5 + 0.5, nz * inv * 0.5 + 0.5], axis=-1)


def save_image(name, rgb, non_color=False):
    """rgb: (H, W, 3) or (H, W) in [0, 1], row 0 = bottom (Blender convention)."""
    os.makedirs(TEX_DIR, exist_ok=True)
    if rgb.ndim == 2:
        rgb = np.repeat(rgb[..., None], 3, axis=-1)
    h, w, _ = rgb.shape
    rgba = np.concatenate([np.clip(rgb, 0, 1), np.ones((h, w, 1))], axis=-1).astype(np.float32)
    img = bpy.data.images.new(name, width=w, height=h, alpha=False, float_buffer=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(rgba.ravel())
    path = os.path.join(TEX_DIR, name + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def srgb(linear):
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(np.maximum(linear, 0), 1 / 2.4) - 0.055)


# Physical sizes of the tileable textures, metres.
STEEL_U, STEEL_V = 4.0, 3.66  # two 1.83 m rings per tile vertically
TILE_A = 0.17  # hex circumradius -> ~0.29 m flat-to-flat tiles
TILE_U, TILE_V = 4 * math.sqrt(3) * TILE_A, 6 * TILE_A
CONCRETE_SIZE = 8.0


def make_steel_textures(res=1024):
    h, w = res, res
    px_per_m = w / STEEL_U
    y = (np.arange(h)[:, None] + 0.5) / h * STEEL_V  # metres
    # Weld seams every 1.83 m: a shallow bead with a groove on each side.
    d = np.minimum(np.abs((y % 1.83)), np.abs(1.83 - (y % 1.83)))
    seam = 0.0015 * np.exp(-((d / 0.008) ** 2)) - 0.0006 * np.exp(-(((d - 0.018) / 0.007) ** 2))
    seam = np.repeat(seam, w, axis=1)
    # Vertical sheet seams: two per tile width, offset between rings.
    x = (np.arange(w)[None, :] + 0.5) / w * STEEL_U
    ring = np.floor(y / 1.83)
    xs = (x + ring * 1.0) % 2.0
    dv = np.minimum(xs, 2.0 - xs)
    seam = seam + 0.001 * np.exp(-((dv / 0.006) ** 2))
    brushed = fractal_noise(h, w, beta=1.2, seed=1)
    streak = np.repeat(fractal_noise(1, w, beta=1.0, seed=2), h, axis=0)
    height = seam + 0.00008 * brushed + 0.00006 * streak
    normal = normal_from_height(height, 1.0, px_per_m)
    blotch = fractal_noise(h, w, beta=2.6, seed=3)
    rough = 0.22 + 0.1 * blotch + 0.05 * streak + 0.15 * (seam > 0.0004)
    panel = 0.96 + 0.02 * ((ring % 2) * 2 - 1) + 0.012 * (blotch - 0.5)
    color = np.stack([panel * 0.80, panel * 0.81, panel * 0.83], axis=-1)
    nrm = save_image("steel_normal", normal, non_color=True)
    rgh = save_image("steel_rough", rough, non_color=True)
    soot = color * np.array([0.44, 0.43, 0.41]) * (0.8 + 0.4 * blotch[..., None])
    return (
        (save_image("steel_color", srgb(color)), nrm, rgh),
        (save_image("steel_sooty_color", srgb(soot)), nrm, rgh),
    )


def make_tile_textures(res=1024):
    """Hexagonal heat-shield tiles (pointy-top lattice), periodic in both directions."""
    w = res
    h = int(round(res * TILE_V / TILE_U))
    px_per_m = w / TILE_U
    a = TILE_A
    xs = (np.arange(w)[None, :] + 0.5) / px_per_m
    ys = (np.arange(h)[:, None] + 0.5) / px_per_m
    X = np.broadcast_to(xs, (h, w))
    Y = np.broadcast_to(ys, (h, w))
    # Axial coordinates for a pointy-top hex lattice.
    q = (math.sqrt(3) / 3 * X - 1 / 3 * Y) / a
    r = (2 / 3 * Y) / a
    # Cube rounding.
    cx, cz = q, r
    cy = -cx - cz
    rx, ry, rz = np.round(cx), np.round(cy), np.round(cz)
    dx, dy, dz = np.abs(rx - cx), np.abs(ry - cy), np.abs(rz - cz)
    fix_x = (dx > dy) & (dx > dz)
    fix_y = ~fix_x & (dy > dz)
    rx = np.where(fix_x, -ry - rz, rx)
    ry = np.where(fix_y, -rx - rz, ry)
    rz = np.where(~fix_x & ~fix_y, -rx - ry, rz)
    center_x = a * math.sqrt(3) * (rx + rz / 2)
    center_y = a * 1.5 * rz
    ddx, ddy = X - center_x, Y - center_y
    inr = a * math.sqrt(3) / 2
    proj = np.maximum.reduce([
        np.abs(ddx),
        np.abs(ddx * 0.5 + ddy * math.sqrt(3) / 2),
        np.abs(-ddx * 0.5 + ddy * math.sqrt(3) / 2),
    ])
    edge = inr - proj  # distance to the tile edge, m
    gap = 0.004
    bevel = 0.006
    face = np.clip((edge - gap) / bevel, 0, 1)
    height = 0.003 * np.sqrt(face)
    normal = normal_from_height(height, 1.0, px_per_m)
    # Per-tile variation, keyed on the tile's position wrapped into the texture.
    kx = np.round((center_x % TILE_U) / (a * math.sqrt(3) / 2)).astype(np.int64)
    ky = np.round((center_y % TILE_V) / (a * 1.5)).astype(np.int64)
    key = ((kx % 4096) * 73856093) ^ ((ky % 4096) * 19349663)
    rnd = ((key % 1000003) * 7919 % 1000) / 1000.0
    base = 0.018 + 0.012 * rnd
    speck = fractal_noise(h, w, beta=0.8, seed=5)
    val = base * (0.85 + 0.3 * speck) * face + 0.012 * (1 - face)
    # A few lighter replacement / crunch-wrap tiles.
    val = np.where(rnd > 0.985, 0.18 * face + 0.012 * (1 - face), val)
    color = np.stack([val * 1.02, val, val * 0.98], axis=-1)
    rough = 0.72 + 0.12 * speck - 0.1 * (rnd > 0.985)
    return (
        save_image("tiles_color", srgb(color)),
        save_image("tiles_normal", normal, non_color=True),
        save_image("tiles_rough", rough, non_color=True),
    )


def make_concrete_textures(res=1024):
    h = w = res
    px_per_m = w / CONCRETE_SIZE
    n1 = fractal_noise(h, w, beta=2.2, seed=11)
    n2 = fractal_noise(h, w, beta=0.9, seed=12)
    y = (np.arange(h)[:, None] + 0.5) / px_per_m
    x = (np.arange(w)[None, :] + 0.5) / px_per_m
    joints = np.minimum(np.minimum(y % 4.0, 4.0 - y % 4.0), np.minimum(x % 4.0, 4.0 - x % 4.0))
    joint = np.exp(-((joints / 0.01) ** 2))
    height = 0.002 * n2 - 0.004 * joint
    normal = normal_from_height(height, 1.0, px_per_m)
    v = 0.48 + 0.12 * n1 + 0.05 * n2 - 0.15 * joint
    color = np.stack([v * 1.02, v, v * 0.95], axis=-1)
    rough = 0.85 + 0.1 * n2
    return (
        save_image("concrete_color", srgb(np.clip(color, 0, 1))),
        save_image("concrete_normal", normal, non_color=True),
        save_image("concrete_rough", rough, non_color=True),
    )


def make_panel_textures(res=512):
    """Cast concrete panels for the launch mounts and tower plinths: one panel per texture tile
    (the pad models map 1 UV unit to 3 m), with seams, rain streaks and grime."""
    h = w = res
    n1 = fractal_noise(h, w, beta=2.0, seed=21)
    n2 = fractal_noise(h, w, beta=1.0, seed=22)
    # Vertical streaks: noise stretched along v.
    streak = fractal_noise(h // 16, w, beta=1.5, seed=23)
    streak = np.repeat(streak, 16, axis=0)[:h]
    y = (np.arange(h)[:, None] + 0.5) / h
    x = (np.arange(w)[None, :] + 0.5) / w
    edge = np.minimum(np.minimum(y, 1 - y), np.minimum(x, 1 - x))
    seam = np.exp(-((edge / 0.008) ** 2))
    height = 0.003 * n2 - 0.01 * seam
    normal = normal_from_height(height, 1.0, w / 3.0)
    v = 0.40 + 0.07 * n1 + 0.03 * n2 - 0.06 * streak - 0.14 * seam
    color = np.stack([v * 1.02, v, v * 0.96], axis=-1)
    rough = 0.88 + 0.08 * n2
    return (
        save_image("panel_color", srgb(np.clip(color, 0, 1))),
        save_image("panel_normal", normal, non_color=True),
        save_image("panel_rough", rough, non_color=True),
    )


# ---------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------


def _principled(name):
    mat = bpy.data.materials.new(name)
    if hasattr(mat, "use_nodes") and not mat.use_nodes:
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    return mat, nt, bsdf


def material(name, color, metallic=0.0, roughness=0.5, textures=None, emission=None, double_sided=False):
    """Principled material. textures = (color_img, normal_img, rough_img) or None."""
    mat, nt, bsdf = _principled(name)
    # The glTF exporter maps backface culling to doubleSided = false.
    mat.use_backface_culling = not double_sided
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    if textures:
        col_img, nrm_img, rgh_img = textures
        tc = nt.nodes.new("ShaderNodeTexImage")
        tc.image = col_img
        nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = nrm_img
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        tr = nt.nodes.new("ShaderNodeTexImage")
        tr.image = rgh_img
        # glTF reads roughness from the G channel of the metallic-roughness texture.
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tr.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission[0], 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission[1]
    return mat


class Materials:
    """The shared material palette. Textures are generated once per Blender session."""

    def __init__(self):
        steel, sooty = make_steel_textures()
        tiles = make_tile_textures()
        concrete = make_concrete_textures()
        self.steel = material("Steel", (0.8, 0.81, 0.83), metallic=1.0, roughness=0.3, textures=steel)
        self.steel_dark = material("SteelSooty", (0.8, 0.8, 0.8), metallic=0.9, roughness=0.5, textures=sooty)
        self.steel_inner = material("SteelInner", (0.35, 0.35, 0.36), metallic=0.8, roughness=0.55, double_sided=True)
        self.tiles = material("HeatShieldTiles", (1, 1, 1), metallic=0.0, roughness=0.8, textures=tiles)
        self.metal_tiles = material("MetalTiles", (0.22, 0.21, 0.2), metallic=0.8, roughness=0.55)
        self.engine = material("RaptorBell", (0.36, 0.29, 0.23), metallic=1.0, roughness=0.42, double_sided=True)
        self.engine_inner = material("RaptorInner", (0.08, 0.07, 0.07), metallic=0.6, roughness=0.6, double_sided=True)
        self.engine_parts = material("RaptorParts", (0.62, 0.62, 0.64), metallic=1.0, roughness=0.35)
        self.grid_fin = material("GridFin", (0.55, 0.55, 0.56), metallic=0.9, roughness=0.45, double_sided=True)
        self.tower = material("TowerSteel", (0.28, 0.29, 0.31), metallic=0.7, roughness=0.6)
        self.tower_light = material("TowerSteelLight", (0.55, 0.56, 0.58), metallic=0.8, roughness=0.5)
        self.chopstick = material("Chopstick", (0.12, 0.12, 0.13), metallic=0.6, roughness=0.55)
        self.concrete = material("Concrete", (1, 1, 1), metallic=0.0, roughness=0.9, textures=concrete)
        self.tank_white = material("TankWhite", (0.86, 0.87, 0.88), metallic=0.3, roughness=0.45)
        self.pipe = material("Pipe", (0.7, 0.71, 0.73), metallic=1.0, roughness=0.3)
        # Flame trench lining and diverter: stainless, but scorched and sooty from launches.
        self.trench_steel = material("TrenchSteel", (0.3, 0.29, 0.28), metallic=0.6, roughness=0.75)
        self.diverter = material("DiverterPipe", (0.45, 0.43, 0.41), metallic=0.8, roughness=0.55)
        # Launch mount / tower plinth concrete: cast panels, weathered darker than the pad slab.
        self.mount_concrete = material("MountConcrete", (1, 1, 1), metallic=0.0, roughness=0.9, textures=make_panel_textures())
        self.dark = material("Dark", (0.05, 0.05, 0.05), metallic=0.2, roughness=0.8)


# ---------------------------------------------------------------------------
# Export / preview
# ---------------------------------------------------------------------------


def export_glb(name):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_cameras=False,
        export_lights=False,
    )
    print(f"exported {path}")
    return path


def render_preview(name, target, distance, elevation_deg=12, azimuth_deg=-40, lens=50, size=(900, 1200)):
    """Quick lit preview PNG so the models can be checked without opening Blender."""
    os.makedirs(PREVIEW_DIR, exist_ok=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    if hasattr(world, "use_nodes") and not world.use_nodes:
        world.use_nodes = True
    sky = world.node_tree.nodes.new("ShaderNodeTexSky")
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.35
    sun_data = bpy.data.lights.new("Sun", "SUN")
    sun_data.energy = 4.0
    sun = bpy.data.objects.new("Sun", sun_data)
    sun.rotation_euler = (math.radians(50), 0, math.radians(120))
    scene.collection.objects.link(sun)
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = lens
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam)
    t = Vector(target)
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    cam.location = t + distance * Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    direction = t - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(PREVIEW_DIR, name + ".png")
    bpy.ops.render.render(write_still=True)
    # Remove preview-only objects so they never end up in an export.
    for o in (cam, sun):
        bpy.data.objects.remove(o)
    print(f"preview {scene.render.filepath}")
