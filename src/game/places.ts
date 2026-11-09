// Where a ship coming home to Starbase is: the places under its entry, for the readout. A ship
// from a Starbase orbit comes in from the west at the top of its ground track: over the Pacific,
// across Baja California Sur and the Gulf of California, then Sinaloa, Durango, Coahuila and
// Nuevo León (past Torreón, Saltillo and Monterrey) and down over Tamaulipas to the coast.

interface Place {
  name: string;
  lat: number;
  lon: number;
  /** A range or region (said "over", never "40 km north of"). */
  region?: boolean;
}

/** Cities and towns along (and near) the corridor, and a few landmarks. */
const PLACES: Place[] = [
  { name: 'Cabo San Lucas, Baja California Sur', lat: 22.89, lon: -109.91 },
  { name: 'La Paz, Baja California Sur', lat: 24.14, lon: -110.31 },
  { name: 'Ciudad Constitución, Baja California Sur', lat: 25.03, lon: -111.66 },
  { name: 'Loreto, Baja California Sur', lat: 26.01, lon: -111.35 },
  { name: 'Guerrero Negro, Baja California Sur', lat: 27.96, lon: -114.06 },
  { name: 'Los Mochis, Sinaloa', lat: 25.79, lon: -108.99 },
  { name: 'Culiacán, Sinaloa', lat: 24.8, lon: -107.39 },
  { name: 'Mazatlán, Sinaloa', lat: 23.24, lon: -106.41 },
  { name: 'Hermosillo, Sonora', lat: 29.07, lon: -110.96 },
  { name: 'Ciudad Obregón, Sonora', lat: 27.49, lon: -109.94 },
  { name: 'the Sierra Madre Occidental', lat: 25.3, lon: -106.3, region: true },
  { name: 'Starbase, Texas', lat: 25.997, lon: -97.155 },
  { name: 'Durango, Durango', lat: 24.02, lon: -104.67 },
  { name: 'Hidalgo del Parral, Chihuahua', lat: 26.93, lon: -105.67 },
  { name: 'Chihuahua, Chihuahua', lat: 28.63, lon: -106.07 },
  { name: 'Torreón, Coahuila', lat: 25.54, lon: -103.41 },
  { name: 'Monclova, Coahuila', lat: 26.91, lon: -101.42 },
  { name: 'Saltillo, Coahuila', lat: 25.42, lon: -101.0 },
  { name: 'Monterrey, Nuevo León', lat: 25.67, lon: -100.31 },
  { name: 'Nuevo Laredo, Tamaulipas', lat: 27.48, lon: -99.51 },
  { name: 'Ciudad Victoria, Tamaulipas', lat: 23.74, lon: -99.15 },
  { name: 'Reynosa, Tamaulipas', lat: 26.08, lon: -98.29 },
  { name: 'Matamoros, Tamaulipas', lat: 25.87, lon: -97.5 },
  { name: 'Brownsville, Texas', lat: 25.9, lon: -97.5 },
  { name: 'Zacatecas, Zacatecas', lat: 22.77, lon: -102.58 },
  { name: 'San Luis Potosí', lat: 22.15, lon: -100.98 },
  { name: 'Guadalajara, Jalisco', lat: 20.67, lon: -103.35 },
  { name: 'Tepic, Nayarit', lat: 21.5, lon: -104.89 },
];

const R = 6371;
const rad = Math.PI / 180;

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** Which way b is from a, in words. */
function bearingWord(aLat: number, aLon: number, bLat: number, bLon: number): string {
  const y = Math.sin((bLon - aLon) * rad) * Math.cos(bLat * rad);
  const x = Math.cos(aLat * rad) * Math.sin(bLat * rad) - Math.sin(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLon - aLon) * rad);
  const deg = (Math.atan2(y, x) / rad + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/** Water the corridor crosses, by rough boxes (lat / lon ranges). */
function water(lat: number, lon: number): string | null {
  // (Baja's Pacific coast runs from ~-110 at Cabo up to ~-114 by 28 N.)
  const coast = lat < 23.5 ? -110 - (lat - 22.8) * 3 : -112.1 - Math.max(0, lat - 25) * 0.7;
  if (lon < coast || (lat < 22.8 && lon < -105.7)) return 'the Pacific Ocean';
  // The Gulf of California, between the peninsula and the mainland (rough diagonal edges).
  const peninsulaEast = -110.0 - (lat - 23) * 0.55;
  const mainlandWest = -108.9 - (lat - 25.5) * 0.95;
  if (lat > 22.8 && lat < 31 && lon > peninsulaEast && lon < mainlandWest) return 'the Gulf of California';
  if (lon > -97.3 && lat < 29) return 'the Gulf of Mexico';
  return null;
}

/**
 * What's below a point, for the readout: "over Monterrey, Nuevo León", "40 km south of Saltillo,
 * Coahuila", "over the Gulf of California". Null far from the corridor (no names for half the
 * world).
 */
export function overflight(lat: number, lon: number): string | null {
  if (lat < 15 || lat > 35 || lon < -135 || lon > -90) return null;
  const town = (region: boolean) => {
    let best: Place | null = null;
    let bestKm = Infinity;
    for (const p of PLACES) {
      if (!!p.region !== region) continue;
      const d = distanceKm(lat, lon, p.lat, p.lon);
      if (d < bestKm) [best, bestKm] = [p, d];
    }
    return { best: best as Place | null, bestKm };
  };
  const { best, bestKm } = town(false);
  if (best && bestKm < 15) return `over ${best.name}`;
  const sea = water(lat, lon);
  const range = town(true);
  if (!sea && range.best && range.bestKm < 110 && bestKm > 40) return `over ${range.best.name}`;
  if (best && bestKm < 90 && !sea) return `${Math.round(bestKm / 5) * 5} km ${bearingWord(best.lat, best.lon, lat, lon)} of ${best.name}`;
  if (sea) return `over ${sea}`;
  return best && bestKm < 200 ? `over Mexico, ${Math.round(bestKm / 10) * 10} km ${bearingWord(best.lat, best.lon, lat, lon)} of ${best.name}` : 'over Mexico';
}
