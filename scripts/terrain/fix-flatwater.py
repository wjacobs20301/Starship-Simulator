"""Water the DEM left above sea level: lidar surveys "hydro-flatten" water surfaces to a constant
height, and some flattened the Laguna Madre and channels at 0.3-1.0 m, above the terrain's water
level (0.25 m). There the terrain shader drew land (the aerial photo's teal shallows, without the
sea colour or waves), in long stair-stepped strips along survey boundaries.

Nothing natural is flat to a centimetre or two over hundreds of metres, so: in every DEM tile,
cells near sea level (-1.2 to +1.1 m) whose 5x5 neighbourhood varies by no more than 6 cm, in
connected patches big enough (~1.3 ha at z16, scaled for coarser zooms), are
flattened water, if the aerial photo there looks like water too (blue or teal, or dark: the
wind-tidal flats are as flat but dry sand in the photo): set to -0.6 m (with the cells ringing
them that are still near sea level). The launch site (flattened on purpose, 1.5 m) is left alone.

Works in place on public/terrain/dem (never through a hard link). Usage:
  python3 scripts/terrain/fix-flatwater.py [--dry-run]
"""
import math, os, re, sys
import numpy as np
from scipy import ndimage
from PIL import Image

DRY = '--dry-run' in sys.argv
ROOT = 'public/terrain/dem'
G = 129
LO, HI = -120, 110          # cm: near sea level (flattened water seen at -0.6, 0.3 and 1.0 m)
FLAT = 6                    # cm: most a 5x5 neighbourhood of flattened water varies
WATER = -60                 # cm: what it becomes
SITE_KEEP_M = 2500          # around the pad (flattened on purpose)

src = open('src/sim/constants.ts').read()
LAT0 = float(re.search(r'latDeg:\s*([-\d.]+)', src).group(1))
LON0 = float(re.search(r'lonDeg:\s*([-\d.]+)', src).group(1))


def tile_center_m(z, x, y):
    lon = (x + 0.5) / 2 ** z * 360 - 180
    n = math.pi - 2 * math.pi * (y + 0.5) / 2 ** z
    lat = math.degrees(math.atan(math.sinh(n)))
    return ((lon - LON0) * 111320 * math.cos(math.radians(LAT0)), (lat - LAT0) * 110574)


def tile_size_m(z):
    return 40075016 * math.cos(math.radians(LAT0)) / 2 ** z


def photo(z, x, y):
    """The tile's imagery sampled on the DEM grid (G x G x 3, 0-255), or None if there isn't any."""
    p = f'public/terrain/img/{z}/{x}/{y}.jpg'
    if not os.path.exists(p):
        return None
    im = Image.open(p).convert('RGB').resize((G, G), Image.BILINEAR)
    return np.asarray(im, dtype=np.float32)


total_tiles = changed_tiles = changed_cells = 0
for z in sorted(int(d) for d in os.listdir(ROOT) if d.isdigit()):
    min_cells = max(10, int(600 / 4 ** (16 - z)))  # ~1.3 ha at z16 (a strip is cut up at tile edges)
    for xs in os.listdir(f'{ROOT}/{z}'):
        for f in os.listdir(f'{ROOT}/{z}/{xs}'):
            if not f.endswith('.bin'):
                continue
            x, y = int(xs), int(f[:-4])
            total_tiles += 1
            e, n = tile_center_m(z, x, y)
            if math.hypot(e, n) < SITE_KEEP_M + tile_size_m(z):
                continue
            path = f'{ROOT}/{z}/{xs}/{f}'
            h = np.fromfile(path, dtype='<i2').reshape(G, G).astype(np.int32)
            near = (h >= LO) & (h <= HI) & (h != 0)
            if not near.any():
                continue
            rng = ndimage.maximum_filter(h, 5) - ndimage.minimum_filter(h, 5)
            flat = near & (rng <= FLAT)
            if flat.sum() < min_cells:
                continue
            labels, count = ndimage.label(flat)
            sizes = ndimage.sum(flat, labels, range(1, count + 1))
            # The aerial photo of the same ground has to look like water too (blue / teal, or dark):
            # the wind-tidal flats are as flat, but dry sand in the imagery, and stay land.
            rgb = photo(z, x, y)
            keep = []
            for i, s in enumerate(sizes):
                if s < min_cells:
                    continue
                if rgb is not None:
                    r, g, b = (rgb[..., k][labels == i + 1].mean() for k in range(3))
                    if not (b >= r - 4 or (r + g + b) / 3 < 70):
                        continue
                keep.append(i + 1)
            water = np.isin(labels, keep)
            if not water.any():
                continue
            # The ring round it, where the edge blends into the sea or shore, if still near sea level.
            ring = ndimage.binary_dilation(water, iterations=2) & ~water & (h <= HI) & (h > WATER)
            fix = water | ring
            h[fix] = WATER
            changed_tiles += 1
            changed_cells += int(fix.sum())
            if not DRY:
                os.remove(path)  # (may be a hard link to a source tile: never write through it)
                h.astype('<i2').tofile(path)
print(f'{total_tiles} DEM tiles, {changed_tiles} with flattened water fixed ({changed_cells} cells){" (dry run)" if DRY else ""}')
