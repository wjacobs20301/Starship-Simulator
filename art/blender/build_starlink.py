"""Build the Starlink V3 model alone, export it and render previews.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/blender/build_starlink.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
from lib import export_glb, render_preview, reset_scene  # noqa: E402
from starlink_v3 import build_starlink_v3, preview_pose  # noqa: E402

reset_scene()
build_starlink_v3()
export_glb("starlink_v3")
args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def space_preview(name, target, distance, elevation_deg, azimuth_deg, size, sun=(40, 0, 130)):
    """As lib.render_preview, but in space: a black sky, hard sunlight and a dim blue fill from
    the Earth below."""
    import math

    from mathutils import Vector

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x, scene.render.resolution_y = size
    world = bpy.data.worlds.new("Space")
    scene.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    sun_data = bpy.data.lights.new("SunL", "SUN")
    sun_data.energy = 6.0
    sun_data.angle = math.radians(0.53)
    s = bpy.data.objects.new("SunL", sun_data)
    s.rotation_euler = tuple(math.radians(a) for a in sun)
    scene.collection.objects.link(s)
    earth_data = bpy.data.lights.new("EarthL", "SUN")
    earth_data.energy = 0.6
    earth_data.color = (0.45, 0.6, 1.0)
    earth_data.angle = math.radians(120)
    e = bpy.data.objects.new("EarthL", earth_data)
    e.rotation_euler = (math.radians(180), 0, 0)
    scene.collection.objects.link(e)
    cam_data = bpy.data.cameras.new("CamS")
    cam_data.lens = 50
    cam_data.clip_end = 5000
    cam = bpy.data.objects.new("CamS", cam_data)
    scene.collection.objects.link(cam)
    t = Vector(target)
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    cam.location = t + distance * Vector((math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = os.path.join(os.path.dirname(__file__), "..", "generated", "previews", name + ".png")
    bpy.ops.render.render(write_still=True)
    for o in (cam, s, e):
        bpy.data.objects.remove(o)


if "--no-preview" not in args:
    # The bus close up from the back (zenith) and from below (the arrays), then deployed.
    for o in (bpy.data.objects["SolarPanel"], bpy.data.objects["Yoke"]):
        o.location = (0, 40, 0)
    space_preview("starlink_back", (0, 0, 0), 11, 35, -60, (1200, 800))
    space_preview("starlink_front", (0, 0, 0), 11, -35, -120, (1200, 800), sun=(150, 0, 130))
    preview_pose(bpy.data.objects["StarlinkV3"])
    space_preview("starlink_deployed", (0, 0, 0), 50, 25, -35, (1400, 900))
    space_preview("starlink_wing", (0, 9, 0), 9, 20, -70, (1200, 800))
