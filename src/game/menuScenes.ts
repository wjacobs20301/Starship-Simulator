// The main menu's backdrops: the sim sets each one up (Simulation.scene), the camera frames it
// and turns slowly round it; they change every so often through a fade to black (main.ts).

import type { StarbaseWeather } from '../settings';
import type { MenuScene } from '../sim/simulation';

/**
 * shift: how far right of centre (fraction of the width) the scene is framed, clear of the menu;
 * azimuth: the range the camera starts in (rad; it turns ~1 rad while the scene is up), else anywhere.
 */
export const MENU_SCENES: {
  kind: MenuScene;
  caption: string;
  track: string;
  elevation: number;
  distance: number;
  shift?: number;
  azimuth?: [number, number];
  /** How long it stays up, s (default SCENE_SECONDS). */
  seconds?: number;
  /** Its own weather over Starbase (else the Settings'). */
  weather?: StarbaseWeather;
}[] = [
  { kind: 'pad', caption: 'Stacked on Pad 1 · rain over Starbase', track: 'stack', elevation: 0.12, distance: 420, weather: 'rain' },
  { kind: 'liftoff', caption: 'Liftoff · Pad 1', track: 'stack', elevation: 0.08, distance: 520, weather: 'overcast', seconds: 34 },
  { kind: 'orbit', caption: 'Starship in orbit · 250 km over Starbase', track: 'ship', elevation: 0.8, distance: 190, shift: 0.26, azimuth: [-0.2, 1.2], weather: 'partly' },  // looking over the coast, not out to sea
  // The ship against the black sky with the Earth's curved horizon below it: the camera nearly
  // level with it (from 250 km the horizon is 16 deg down), on its sunlit side.
  { kind: 'orbit', caption: 'Starship in orbit · Earth and space', track: 'ship', elevation: 0.13, distance: 170, shift: 0.26, azimuth: [0.6, 1.3], weather: 'partly' },
  // (Back and up: above the dust its engines raise, the whole approach in view.)
  { kind: 'reentry', caption: 'Starship reentry · 72 km, Mach 23', track: 'ship', elevation: 0.25, distance: 150, shift: 0.26, seconds: 24 },
  { kind: 'boosterCatch', caption: 'Super Heavy returning to the tower', track: 'booster', elevation: 0.16, distance: 620, shift: 0.3, seconds: 42, weather: 'partly' },
  // The ship home from orbit: flip, landing burn, and the catch by Pad 1's chopsticks, live.
  { kind: 'shipCatch', caption: 'Starship returning to the tower', track: 'ship', elevation: 0.14, distance: 420, shift: 0.3, seconds: 70 },
];
/** Seconds each backdrop stays up. */
export const SCENE_SECONDS = 28;
