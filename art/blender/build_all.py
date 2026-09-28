"""Build every model, export GLBs and render preview images.

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P art/blender/build_all.py [-- --no-preview]

Prefer `npm run models`, which also refreshes geometry.json and optimizes the output.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib import Materials, export_glb, load_geometry, render_preview, reset_scene  # noqa: E402
from pad import build_pad  # noqa: E402
from vehicle_import import build_stage, open_source  # noqa: E402

args = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
preview = "--no-preview" not in args
only = next((a.split("=")[1] for a in args if a.startswith("--only=")), None)

geo = load_geometry()
jobs = [
    ("booster", None, dict(target=(0, 0, 36), distance=120, elevation_deg=8)),
    ("ship", None, dict(target=(0, 0, 26), distance=90, elevation_deg=10, azimuth_deg=-20)),
    ("pad", build_pad, dict(target=(-10, 0, 60), distance=320, elevation_deg=14, azimuth_deg=-70, size=(1400, 1000))),
]
for name, build, view in jobs:
    if only and name != only:
        continue
    if build is None:
        # Vehicles come from the third-party source model (vehicle_import.py).
        open_source()
        build_stage(name, geo)
    else:
        reset_scene()
        build(geo, Materials())
    export_glb(name)
    if preview:
        render_preview(name, **view)
        if name == "booster":
            render_preview("booster_engines", target=(0, 0, 2), distance=24, elevation_deg=-55, azimuth_deg=-30)
        if name == "pad":
            # Close-up of Pad 1's launch mount, looking down the flame trench.
            trench = geo["pads"][0]["trench"]["axisDeg"]
            render_preview("pad_mount", target=(0, 0, 11), distance=95, elevation_deg=4, azimuth_deg=trench + 200, size=(1400, 900))
        if name == "ship":
            render_preview("ship_nose", target=(0, 0, 40), distance=34, elevation_deg=15, azimuth_deg=160)
