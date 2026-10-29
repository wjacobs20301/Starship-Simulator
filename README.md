# Starship Launch Sim

Browser-based Starship V3 launch simulator: Three.js rendering, with a float64 6DOF flight simulator running in a Web Worker.

**Status: step 2 done.** Blender-built models of Super Heavy V3, Starship V3 and Starbase Pad 2 fly on the step-1 physics. Terrain is still a placeholder (step 3).

```bash
npm install
npm run dev     # open the printed URL, press Space
npm test        # physics validation
npm run fly     # headless flight, prints a telemetry table + event log
npm run models  # rebuild the 3D models (needs Blender at /Applications/Blender.app)
```

### Map data
The terrain and globe tiles (~10 GB, ~750k files) aren't in the repo. Without them the game still runs, but over a bare globe. To download and build all of it in one go:

```bash
pip3 install numpy scipy pillow   # needed by the build
npm run data                      # download + build everything; several hours, resumable
```

`npm run data` runs `terrain:fetch`, `terrain:build`, `globe:fetch` and `globe:build` (see [Terrain and globe](#terrain-and-globe)). No accounts or API keys are needed. If a download is interrupted, run it again and it picks up where it left off.

## 3D models
`npm run models` runs Blender headless (`art/blender/build_all.py`) and writes optimized GLBs to `public/models/`. All output is meshopt-compressed with WebP textures.

- **Starship + Super Heavy:** `vehicle_import.py` converts Clarence365's Block 3 model (`art/source/vehicle/`):
  - scales it to full size and rotates it into the sim's body frame
  - splits it into booster and ship
  - adds pivots for the engines, grid fins and flaps
  - decimates it for real time
  - replaces the procedural steel shaders that glTF can't carry
- **Tower, chopsticks, QD arm, launch mount:** `tower_kit.py` scales and assembles MikeNotBrick's 1:144 kit (`art/source/tower/`).
- **Apron, flame trench, tank farm:** procedural, in `pad.py`.
- **Physics match:** sim engine positions (`src/sim/config/starshipV3.ts`) match the Raptor positions in the vehicle model.
- **Previews:** `npm run models:preview` also renders PNG previews to `art/generated/previews/`.

Nodes the game drives (pivots rotate about their hinge axis):
- Booster: `Engine_00`–`Engine_32` (gimbal from the sim) and `GridFin_Catch_A/B` / `GridFin_Rudder`. V3 has three fins in a 90/90/180 layout.
- Ship: `Engine_00`–`Engine_05` and `Flap_Fwd_L/R` / `Flap_Aft_L/R`.
- Pad: `Carriage`, `Chopstick_N/S`, `ShipQD`. The QD arm retracts during the terminal count.

## Terrain and globe
The ground is streamed like a map app: a quadtree of Web Mercator tiles (zoom 8–18), each a curved-Earth height mesh with imagery, loaded on demand around the camera.

| Area | Imagery | Elevation |
|---|---|---|
| 200 × 200 km around Starbase, US side | USDA NAIP 2022, 0.6 m | Copernicus GLO-30, 30 m |
| 200 × 200 km, Mexico and offshore | Copernicus Sentinel-2 cloud-free mosaic (2025–26), 10 m | Copernicus GLO-30, 30 m |
| 40 × 40 km core around the pads | NAIP 0.6 m | USGS 3DEP lidar, 3 m |
| Rest of the world | NASA Blue Marble (2004, 500 m source), streamed tiles z0–z7 (~1.2 km/px), 154 MB | none (smooth globe) |

- **Water:** anything within ~0.25 m of sea level is shaded as water, with animated swell that fades with distance.
- **Region edge:** over its outer 40 km, the streamed region fades out to reveal the globe tiles underneath.
- **Colour matching:** globe land near Starbase is colour-matched to the region's imagery (a gain measured over the overlap, fading out by ~500 km). A small 7 km/px image covers the poles.
- **Facilities:** OpenStreetMap buildings and tanks are extruded to their tagged heights. This covers the Mega Bays, the Gigabay and the tank farm, including everything built after the 2022 photos.
- **Pads:** Pad 1 (launch) and Pad 2 are built at their OpenStreetMap positions.
- **Hero edits** (`scripts/terrain/build-tiles.ts`): the fenced launch site is flattened, both pad aprons are painted as concrete, and the 2022 photo of the leaning Pad 1 tower is painted out.

```bash
npm run terrain:fetch   # NAIP, Sentinel-2, 3DEP and Copernicus sources -> art/source/terrain (resumable; hours for NAIP)
npm run terrain:build   # writes public/terrain (imagery pyramid, height tiles, index, facilities), then the flat-water fix; ~25 min
npm run globe:fetch     # NASA Blue Marble 500 m sources (8 tiles, 420 MB) -> art/source/globe (resumable)
npm run globe:build     # art/source/globe/bmng_*.jpg -> public/globe/tiles; ~11 min
npx tsx scripts/terrain/build-tiles.ts --water-only=0.98   # quick: re-bake water colour into coarse tiles only
```
The flat-water fix (`scripts/terrain/fix-flatwater.py`, Python 3 with numpy, scipy and Pillow: `pip3 install numpy scipy pillow`) lowers lagoon and channel water that lidar surveys "hydro-flattened" above sea level, which would otherwise draw as land (teal strips). It works in place on `public/terrain/dem` and is safe to run again.

Builds go to `public/terrain.building` and swap in when finished, so a running game never sees a half-built set. The dev server doesn't watch the ~750k tile files (`vite.config.ts`); watching them runs it out of memory.

## Settings
`src/settings.ts` holds player settings that persist per browser. Change them with `updateSettings({...})`; anything that depends on a setting subscribes with `onSettingsChange()`.

- **Ship serial** (`shipSerial`, default `SN44`): painted on the ship's side and shown in the HUD. It is redrawn live when changed (`src/render/decals.ts`).

## Controls
Space launch · C camera · V switch vehicle · 1–5 time warp · P telemetry plot · K pause · R reset · drag/scroll to orbit

## Layout
- `src/sim/`: pure TypeScript physics (no DOM, no Three.js)
  - `config/starshipV3.ts`: **every vehicle and mission number**, all approximate. This is the only file to edit when tuning against real telemetry.
  - `dynamics.ts`: 6DOF equations of motion with changing mass and inertia, RK4 at 100 Hz, ECI frame
  - `atmosphere.ts` (US Standard Atmosphere 1976), `gravity.ts` (point mass + J2), `engine.ts` (thrust drops with ambient pressure), `aero.ts` (drag vs Mach, normal force + crossflow)
  - `guidance.ts`, `control.ts`: gravity turn, ship insertion law, thrust-vector + RCS attitude control
  - `sequencer.ts`: countdown → liftoff → max-Q → MECO → hot staging → SECO
  - `reference/ift.ts`: approximate reference profile. Replace it with transcribed webcast telemetry for real validation.
- `src/worker/`: runs the sim off the main thread
- `src/render/`: floating-origin Three.js scene, glTF model loading, plumes, cameras, shadows
- `src/ui/`: HUD, telemetry plot, key bindings

## Not modeled yet
Booster boostback and catch, ship reentry and flip, detailed models, real terrain and imagery, atmosphere scattering, audio.

## Credits
- Launch tower, chopsticks, QD arm and launch mount: "Starship Launch Tower & Launch Pad with Functional Chopsticks (1:144 scale)" by [MikeNotBrick](https://www.thingiverse.com/thing:5908857), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Scaled, re-assembled and re-materialed.
- Starship / Super Heavy: "SpaceX Starship Block 3" by [Clarence365](https://sketchfab.com/3d-models/spacex-starship-block-3-6f6c6f88a3eb4b4d822fdca66733fbb2), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Aerial imagery: USDA NAIP 2022 (public domain), via Microsoft Planetary Computer.
- Satellite imagery: contains modified Copernicus Sentinel data 2025–2026, via Microsoft Planetary Computer.
- Global imagery: NASA Blue Marble Next Generation (NASA Earth Observatory, public domain).
- Elevation: USGS 3D Elevation Program (public domain); Copernicus GLO-30 DEM © DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018, provided under COPERNICUS by the European Union and ESA.
- Buildings and tanks: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).

An independent fan-made simulator, not affiliated with or endorsed by SpaceX.

## License
The code is [MIT](LICENSE). The third-party models and data credited above keep their own licenses.
