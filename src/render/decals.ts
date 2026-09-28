// Runtime ship serial decal. The ship model's "Serial Number" material (baked from the source
// model's "S45" texture by art/blender/vehicle_import.py) gets its textures redrawn here so the
// serial comes from settings. Layout matches the source texture: black lettering centred at
// (47.7%, 45.6%) with a cap height of 17% of the texture height.

import * as THREE from 'three';

// Keep in sync with art/blender/vehicle_import.py. The background matches the surrounding hull
// steel (white, 96% metallic, roughness ~0.48); the paint is matte black.
const STEEL = 'rgb(255, 255, 255)';
const PAINT = 'rgb(8, 8, 8)';
/** glTF metal/roughness texture: G = roughness, B = metalness. */
const STEEL_MR = `rgb(255, ${Math.round(0.48 * 255)}, ${Math.round(0.96 * 255)})`;
const PAINT_MR = `rgb(255, ${Math.round(0.55 * 255)}, 0)`;

const W = 1024;
const H = 724; // same aspect as the 2000 x 1414 source texture

function draw(text: string, background: string, ink: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, W, H);
  // Helvetica-style bold: cap height ~0.72 of the font size.
  let size = (0.172 * H) / 0.72;
  const font = (px: number) => `bold ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  ctx.font = font(size);
  const maxWidth = 0.8 * W;
  const width = ctx.measureText(text).width;
  if (width > maxWidth) {
    size *= maxWidth / width;
    ctx.font = font(size);
  }
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 0.477 * W, 0.456 * H + (0.72 * size) / 2);
  return canvas;
}

let current: { color: THREE.CanvasTexture; mr: THREE.CanvasTexture } | null = null;

/** Repaints the serial on every mesh using the ship model's "Serial Number" material. */
export function applyShipSerial(ship: THREE.Object3D, serial: string): void {
  const color = new THREE.CanvasTexture(draw(serial, STEEL, PAINT));
  color.colorSpace = THREE.SRGBColorSpace;
  const mr = new THREE.CanvasTexture(draw(serial, STEEL_MR, PAINT_MR));
  for (const tex of [color, mr]) {
    tex.flipY = false; // glTF texture convention
    tex.anisotropy = 8;
  }
  ship.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.name !== 'Serial Number' || !(m instanceof THREE.MeshStandardMaterial)) continue;
      m.map = color;
      m.metalnessMap = mr;
      m.roughnessMap = mr;
      m.color.set(0xffffff);
      m.metalness = 1;
      m.roughness = 1;
      m.needsUpdate = true;
    }
  });
  current?.color.dispose();
  current?.mr.dispose();
  current = { color, mr };
}
