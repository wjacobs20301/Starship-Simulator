"""South Padre Island and Port Isabel from OpenStreetMap -> public/data/spi.json (compact).

Input: an Overpass JSON export (buildings, the Queen Isabella Causeway, Port Isabel Lighthouse)
for lat 26.04-26.20, lon -97.25 to -97.13. Heights are rarely tagged, so they're estimated:
big footprints on the island's beachfront are the condo and hotel towers, the rest 1-2 storeys.
Positions are pad-local east / north metres (Pad 1's launch mount), rounded to 0.5 m.
Usage: python3 scripts/terrain/build-spi.py overpass.json
"""
import json, math, re, sys

src = open('src/sim/constants.ts').read()
LAT0 = float(re.search(r'latDeg:\s*([-\d.]+)', src).group(1))
LON0 = float(re.search(r'lonDeg:\s*([-\d.]+)', src).group(1))
KX = 111320 * math.cos(math.radians(LAT0))


def en(p):
    return ((p['lon'] - LON0) * KX, (p['lat'] - LAT0) * 110574)


def parse_height(t):
    for k in ('height', 'building:height'):
        v = t.get(k)
        if v:
            try:
                return float(re.match(r'[\d.]+', v).group(0))
            except Exception:
                pass
    if t.get('building:levels'):
        try:
            return float(t['building:levels'].split(';')[0]) * 3.2 + 1
        except ValueError:
            pass
    return None


def hash01(x, y):
    s = math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    return s - math.floor(s)


d = json.load(open(sys.argv[1]))
buildings, bridges, light = [], [], None
for el in d['elements']:
    t = el.get('tags', {})
    g = el.get('geometry') or next((m.get('geometry') for m in el.get('members', []) if m.get('role') == 'outer' and m.get('geometry')), None)
    if not g:
        continue
    pts = [en(p) for p in g]
    if t.get('bridge') == 'yes' and t.get('name') == 'Queen Isabella Causeway':
        bridges.append([[round(x * 2) / 2, round(y * 2) / 2] for x, y in pts])
        continue
    if t.get('man_made') == 'lighthouse':
        light = [round(sum(p[0] for p in pts) / len(pts), 1), round(sum(p[1] for p in pts) / len(pts), 1)]
        continue
    if 'building' not in t or len(pts) < 4:
        continue
    area = abs(sum(pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1] for i in range(len(pts) - 1))) / 2
    if area < 12:
        continue
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    lon = LON0 + cx / KX
    h = parse_height(t)
    on_island = lon > -97.185
    r = hash01(cx, cy)
    if h is None:
        if on_island and area > 700:
            # Condo / hotel towers: bigger footprints stand taller (Sapphire, Bridgepoint... reach ~30 floors).
            h = min(95, 16 + area / 45 * (0.7 + 0.6 * r))
        elif area > 1500:
            h = 9 + 4 * r  # big low commercial buildings
        elif t.get('building') in ('stilt_house',):
            h = 8 + 2 * r
        else:
            h = 5 + (3.5 if r > 0.6 and area > 90 else 0)
    # Style: 0 = house (pastel, windows), 1 = tower / hotel (window ribbons), 2 = commercial shed.
    style = 1 if h > 14 else 2 if area > 1200 else 0
    ring = [v for p in pts[:-1] for v in (round(p[0] * 2) / 2, round(p[1] * 2) / 2)]
    buildings.append([round(h, 1), style] + ring)

out = {'buildings': buildings, 'causeway': bridges, 'lighthouse': light,
       'attribution': '© OpenStreetMap contributors (ODbL)'}
json.dump(out, open('public/data/spi.json', 'w'), separators=(',', ':'))
print(len(buildings), 'buildings,', len(bridges), 'causeway ways, lighthouse', light,
      'towers', sum(1 for b in buildings if b[1] == 1), 'max h', max(b[0] for b in buildings))
