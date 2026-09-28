"""Starbase Pads 1 and 2 in their V3 form: towers, chopsticks and ship QD arms from a CC BY model
kit (tower_kit.py), V3 launch mounts and flame trenches built from references (pad_v3.py). The ground, aprons and
surrounding facilities come from the streamed terrain and OpenStreetMap at runtime.

Frame: X = East, Y = North, Z = Up; origin on the Pad 1 launch mount at ground level.
Node names the runtime drives (pivots rotate about local Z), per pad prefix PadN_:
  Carriage (moves along Z), Chopstick_L / Chopstick_R (open/close), ShipQD (retract)
"""

from lib import empty
from pad_v3 import build_v3_pad
from tower_kit import build_tower_kit


def build_pad(geo, mats):
    root = empty("Pads")
    for spec in geo["pads"]:
        build_tower_kit(root, mats, geo, spec)
        build_v3_pad(root, mats, geo, spec)
    return root
