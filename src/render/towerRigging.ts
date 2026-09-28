// The chopstick carriage's hoisting rigging, which the print kit the tower comes from leaves out
// (it used a hand crank). Like a drilling rig's: wire rope from the drawworks (a big winch) by
// the tower base enters the tower low down and runs up inside it to the crown block (sheaves at
// the tower top), then reeves back and forth between the crown and the travelling block (the
// hook block the carriage hangs from) and back up to the dead line, which runs down to the dead
// spool and deadline anchor. Pad 1 reeves 5 passes, Pad 2 6 (NSF, Aug 2025 / Jan 2026).
//
// Where it is (photos of the towers): all on the FRONT, the face toward the launch mount. The
// falls hang outside that face, straight above the carriage, from the crown at the top, which
// sits in a clad shroud that caps the tower and overhangs its front (an open steel frame, the
// roof section's "appendage" of 2021, is kept as an option). The dead and fast lines go inside the
// tower and leave it through the back face one section (Pad 1) or two (Pad 2) above the base.
//
// Sizes approximate (from photos). Built at runtime in the tower's (toppling) group, so the
// falls can follow the carriage every frame.

import * as THREE from 'three';
import { mergeStatic } from './merge';

/** Rope diameter (~2.5 in wire rope), m. */
const ROPE_R = 0.035;
/** Sheave diameter and spacing along the axles, m. */
const SHEAVE_D = 1.6;
const SHEAVE_PITCH = 0.3;
/** How far out from the tower's front face the falls hang, m. */
const FALLS_OUT = 1.6;
/** The travelling block: height of its side plates, and the shackle under it to the carriage's header beam. */
const BLOCK_H = 2.2;
const SHACKLE_H = 0.8;
/** The carriage's header beam across the tower's front face (the block hangs the carriage by it), m. */
const HEADER_H = 1.4;
/**
 * Crown housing under the roof out front (height), how far the roof runs out past the tower's
 * front face, and its front edge's width as a fraction of the tower's (it tapers, 45 deg), m.
 */
const CROWN_H = 8;
const CROWN_OUT = 6;
/**
 * The roof's plan (tower standing corner-on to the mount): it keeps the tower's back and side
 * corners and pulls the front corner out along the diagonal by this fraction of the half
 * diagonal, its tip clipped this far back (m), its sides running straight from the side corners.
 */
const ROOF_PULL = 0.45;
const ROOF_TIP_CLIP = 1.5;
/** Kit lattice section pitch, m (for where the lines leave the tower). */
const SECTION = 18.3;

export interface RiggingSpec {
  /** Rope passes between the blocks (lines = 2 x passes). */
  passes: number;
  /** A clad shroud over the tower top, or the open steel frame (Pad 1's roof section in 2021). */
  housing: boolean;
  /** Tower sections above the base where the fast and dead lines leave the tower. */
  exitSection: number;
}

interface Fall {
  mesh: THREE.Mesh;
  /** Offset along the sheave axles, m. */
  offset: number;
}

export class TowerRigging {
  private readonly group = new THREE.Group();
  private readonly block = new THREE.Group();
  private readonly falls: Fall[] = [];
  /** In the fall group's frame: the crown sheaves' axle; the block's axle relative to the carriage. */
  private readonly crownAxle: THREE.Vector3;
  private readonly blockAxleLocal: THREE.Vector3;
  /** Horizontal unit along the sheave axles (across the tower's front face). */
  private readonly across: THREE.Vector3;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  /**
   * fall: the tower's toppling group (everything here lives in it); carriage: the carriage node
   * (slides up and down in the fall group); frame: a part of the carriage whose top the block
   * sits on (the arms); tower: the lattice
   * mesh; front: a point in front of the tower (where the arms reach); groundY: the pad ground
   * in the fall group's frame.
   */
  constructor(
    fall: THREE.Object3D,
    private carriage: THREE.Object3D,
    frame: THREE.Object3D,
    tower: THREE.Object3D,
    front: THREE.Vector3,
    groundY: number,
    spec: RiggingSpec,
  ) {
    this.group.name = 'Rigging';
    fall.add(this.group);
    fall.updateMatrixWorld(true);
    const local = (o: THREE.Object3D) => {
      const b = new THREE.Box3().setFromObject(o);
      return new THREE.Box3(fall.worldToLocal(b.min.clone()), fall.worldToLocal(b.max.clone()));
    };
    const towerBox = local(tower);
    // The lattice's own footprint, from a band of plain sections below the top (the kit's top
    // segment and the base are wider).
    const topBox = new THREE.Box3();
    {
      const m = tower as THREE.Mesh;
      const pos = m.geometry.getAttribute('position');
      const v = new THREE.Vector3();
      tower.updateMatrixWorld(true);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(tower.matrixWorld);
        fall.worldToLocal(v);
        if (v.y > towerBox.max.y - 40 && v.y < towerBox.max.y - 20) topBox.expandByPoint(v);
      }
    }
    const frameBox = local(frame);
    const towerC = topBox.getCenter(new THREE.Vector3());
    const frontL = fall.worldToLocal(front.clone());
    // Toward the mount (the tower's front), and across its front face.
    const fwd = new THREE.Vector3(frontL.x - towerC.x, 0, frontL.z - towerC.z).normalize();
    this.across = new THREE.Vector3().crossVectors(this.up, fwd).normalize();
    const sizeX = topBox.max.x - topBox.min.x;
    const sizeZ = topBox.max.z - topBox.min.z;
    const half = (Math.abs(fwd.x) * sizeX + Math.abs(fwd.z) * sizeZ) / 2;
    const halfAcross = (Math.abs(this.across.x) * sizeX + Math.abs(this.across.z) * sizeZ) / 2;
    const top = towerBox.max.y;
    const at = (out: number, y: number, side = 0) =>
      new THREE.Vector3(towerC.x + fwd.x * out + this.across.x * side, y, towerC.z + fwd.z * out + this.across.z * side);
    // The carriage (and everything that hangs it) is on the hinge line, a little off the lattice's
    // centre line in the kit.
    this.carriage.updateMatrixWorld(true);
    const hingeL = fall.worldToLocal(this.carriage.getWorldPosition(new THREE.Vector3()));
    const hs = (hingeL.x - towerC.x) * this.across.x + (hingeL.z - towerC.z) * this.across.z;

    const n = spec.passes * 2;
    const width = (n - 1) * SHEAVE_PITCH;
    const steel = new THREE.MeshStandardMaterial({ color: 0x55595e, metalness: 0.8, roughness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2d30, metalness: 0.7, roughness: 0.5 });
    const cladding = new THREE.MeshStandardMaterial({ color: 0x9a9da1, metalness: 0.6, roughness: 0.5 });
    const rope = new THREE.MeshStandardMaterial({ color: 0x232426, metalness: 0.6, roughness: 0.5 });
    const sheaveGeo = new THREE.CylinderGeometry(SHEAVE_D / 2, SHEAVE_D / 2, 0.16, 24);
    sheaveGeo.rotateZ(Math.PI / 2);
    // Groups get +z toward the front and x along the axles once placed (lookAt is world-space).
    const fwdWorld = fall.localToWorld(fwd.clone()).sub(fall.localToWorld(new THREE.Vector3()));
    const face = (o: THREE.Object3D) => {
      o.updateMatrixWorld(true);
      o.lookAt(o.getWorldPosition(new THREE.Vector3()).add(fwdWorld));
    };

    // --- Crown: sheaves at the top of the front face, in a housing or on an open frame ---------
    const fallsOut = half + FALLS_OUT;
    // (Under the housing the crown block hangs below its platform.)
    this.crownAxle = at(fallsOut, spec.housing ? top - CROWN_H - 0.9 : top + 2.4, hs);
    const crown = new THREE.Group();
    crown.position.copy(at(0, top));
    this.group.add(crown);
    face(crown);
    const depth = 2 * half + CROWN_OUT;
    if (spec.housing) {
      // From above (aerial photos, and the tower standing corner-on): the roof keeps the tower's
      // back and side corners and runs its two front edges straight out from the side corners to
      // a clipped tip well out past the front corner, over the carriage. It's an open grid of
      // light steel beams with diagonal bracing over a deck. Under the part out front, a housing
      // with clad walls following the same outline; the crown block hangs under it. The rest of
      // the top section stays open lattice.
      const zT = half * (1 + ROOF_PULL);
      const f = (zT - ROOF_TIP_CLIP) / zT;
      const tipX = half * (1 - f);
      const zClip = zT - ROOF_TIP_CLIP;
      // Plan outlines (x across, z out from the tower's centre toward the mount).
      const roofOutline: [number, number][] = [[0, -half], [half, 0], [tipX + hs, zClip], [-tipX + hs, zClip], [-half, 0]];
      const housingOutline: [number, number][] = [[half, 0], [tipX + hs, zClip], [-tipX + hs, zClip], [-half, 0], [0, half - 1.5]];
      // A vertical prism over a plan outline, from y0 to y1 (crown frame).
      const prism = (outline: [number, number][], y0: number, y1: number, mat: THREE.Material) => {
        const shape = new THREE.Shape(outline.map(([x, z]) => new THREE.Vector2(x, -z)));
        const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, y0, 0);
        return new THREE.Mesh(geo, mat);
      };
      crown.add(prism(housingOutline, -CROWN_H, 0, cladding));
      crown.add(prism(roofOutline, 0, 0.25, dark));
      // Ribs up the housing's outer walls (its first three edges; the last two run inside the tower).
      for (let i = 0; i < 3; i++) {
        const [x0, z0] = housingOutline[i];
        const [x1, z1] = housingOutline[i + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        const n = Math.max(1, Math.round(len / 1.1));
        for (let k = 0; k <= n; k++) {
          const r = new THREE.Mesh(new THREE.BoxGeometry(0.14, CROWN_H, 0.14), dark);
          r.position.set(x0 + ((x1 - x0) * k) / n, -CROWN_H / 2, z0 + ((z1 - z0) * k) / n);
          crown.add(r);
        }
        const band = new THREE.Mesh(new THREE.BoxGeometry(len, 0.4, 0.25), steel);
        band.position.set((x0 + x1) / 2, -CROWN_H + 0.2, (z0 + z1) / 2);
        band.rotation.y = Math.atan2(-(z1 - z0), x1 - x0);
        crown.add(band);
      }
      // The roof's beam grid (light grey steel): the perimeter, beams both ways every ~3 m
      // clipped to the outline, and X bracing in the whole bays.
      const roofSteel = new THREE.MeshStandardMaterial({ color: 0xb4b8bd, metalness: 0.7, roughness: 0.45 });
      const beam = (ax: number, az: number, bx: number, bz: number, size = 0.45) => {
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.2) return;
        const b = new THREE.Mesh(new THREE.BoxGeometry(len, size, size), roofSteel);
        b.position.set((ax + bx) / 2, 0.25 + size / 2, (az + bz) / 2);
        b.rotation.y = Math.atan2(-(bz - az), bx - ax);
        crown.add(b);
      };
      const m = roofOutline.length;
      for (let i = 0; i < m; i++) beam(...roofOutline[i], ...roofOutline[(i + 1) % m], 0.6);
      // Where a line x = c (or z = c) crosses the (convex) outline.
      const span = (axis: 0 | 1, c: number): [number, number] | null => {
        const hits: number[] = [];
        for (let i = 0; i < m; i++) {
          const p = roofOutline[i];
          const q = roofOutline[(i + 1) % m];
          if ((p[axis] - c) * (q[axis] - c) > 0 || p[axis] === q[axis]) continue;
          const t = (c - p[axis]) / (q[axis] - p[axis]);
          hits.push(p[1 - axis] + t * (q[1 - axis] - p[1 - axis]));
        }
        return hits.length >= 2 ? [Math.min(...hits), Math.max(...hits)] : null;
      };
      const inside = (x: number, z: number) => {
        for (let i = 0; i < m; i++) {
          const [px, pz] = roofOutline[i];
          const [qx, qz] = roofOutline[(i + 1) % m];
          if ((qx - px) * (z - pz) - (qz - pz) * (x - px) < -0.01) return false;
        }
        return true;
      };
      const pitch = 3.2;
      for (let x = -half + pitch; x < half - 0.3; x += pitch) {
        const sp = span(0, x);
        if (sp) beam(x, sp[0], x, sp[1], 0.35);
      }
      for (let z = -half + pitch; z < zClip - 0.3; z += pitch) {
        const sp = span(1, z);
        if (sp) beam(sp[0], z, sp[1], z, 0.35);
      }
      for (let x = -half; x < half; x += pitch) {
        for (let z = -half; z < zClip; z += pitch) {
          const x1 = x + pitch;
          const z1 = z + pitch;
          if (inside(x, z) && inside(x1, z) && inside(x, z1) && inside(x1, z1)) {
            beam(x, z, x1, z1, 0.25);
            beam(x1, z, x, z1, 0.25);
          }
        }
      }
      // Its underside: a grating deck the crown block hangs through.
      crown.add(prism(housingOutline, -CROWN_H - 0.25, -CROWN_H, dark));
    } else {
      // Open steel frame: girders on the roof section, cantilevered over the front, with struts.
      for (const s of [-1, 1]) {
        const x = s * (width / 2 + 0.9);
        const beam = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.4, depth), steel);
        beam.position.set(x, 3.2, CROWN_OUT / 2);
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.7, 5.5, 0.7), steel);
        post.position.set(x, 2.75, -half + 1);
        const strutLen = Math.hypot(3.2, half + FALLS_OUT);
        const strut = new THREE.Mesh(new THREE.BoxGeometry(0.5, strutLen, 0.5), steel);
        strut.position.set(x, 1.6, (half + FALLS_OUT) / 2);
        strut.rotation.x = Math.atan2(half + FALLS_OUT, 3.2);
        crown.add(beam, post, strut);
      }
      const deck = new THREE.Mesh(new THREE.BoxGeometry(width + 2.6, 0.5, 3.2), steel);
      deck.position.set(0, 3.9, half + FALLS_OUT);
      crown.add(deck);
    }
    // The crown sheaves themselves, where the falls go up into it.
    const sheaves = new THREE.Group();
    sheaves.position.copy(this.crownAxle);
    this.group.add(sheaves);
    face(sheaves);
    for (let i = 0; i <= spec.passes; i++) {
      const s = new THREE.Mesh(sheaveGeo, steel);
      s.position.x = -width / 2 + i * 2 * SHEAVE_PITCH;
      sheaves.add(s);
    }
    for (const x of [-(width / 2 + 0.4), width / 2 + 0.4]) {
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.2, SHEAVE_D + 0.6, 1.6), dark);
      cheek.position.x = x;
      sheaves.add(cheek);
    }

    // --- The carriage's header beam and the travelling block shackled to it ------------------
    // The carriage wraps the tower's front corner (riding that corner's leg and its two
    // neighbours); across its front, at the arms' top, a header beam the block hangs it by, with
    // struts back to shoes on the two front faces.
    const toCarriage = (p: THREE.Vector3) => this.carriage.worldToLocal(fall.localToWorld(p.clone()));
    const headerTop = frameBox.max.y + 0.2;
    const header = new THREE.Group();
    header.position.copy(toCarriage(at(half + FALLS_OUT / 2, headerTop, hs)));
    this.carriage.add(header);
    face(header);
    const beamW = Math.max(width + 3, 8);
    const beam = new THREE.Mesh(new THREE.BoxGeometry(beamW, HEADER_H, FALLS_OUT + 1.2), dark);
    beam.position.y = -HEADER_H / 2;
    header.add(beam);
    for (const sx of [-1, 1]) {
      // Back from the beam's end to the tower face (at 45 deg from the corner).
      const x = sx * (beamW / 2 - 0.5);
      const back = Math.abs(x) + FALLS_OUT / 2;
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.8, HEADER_H, back), steel);
      strut.position.set(x, -HEADER_H / 2, -back / 2);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(1.4, HEADER_H + 2.4, 1.2), steel);
      shoe.position.set(x, -HEADER_H / 2 - 0.6, -back);
      shoe.rotation.y = sx * Math.PI / 4;
      header.add(strut, shoe);
    }
    const lug = new THREE.Mesh(new THREE.BoxGeometry(0.9, SHACKLE_H, 0.4), steel);
    lug.position.set(0, SHACKLE_H / 2, (FALLS_OUT) / 2);
    header.add(lug);

    const blockBottom = at(fallsOut, headerTop + SHACKLE_H, hs);
    const blockAxle = blockBottom.clone().add(new THREE.Vector3(0, BLOCK_H * 0.55, 0));
    this.blockAxleLocal = toCarriage(blockAxle);
    this.block.position.copy(toCarriage(blockBottom));
    this.carriage.add(this.block);
    face(this.block);
    // A hook block: two side plates, the sheaves between them, a top bar and a yoke underneath.
    for (const x of [-(width / 2 + 0.3), width / 2 + 0.3]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.18, BLOCK_H, SHEAVE_D + 0.5), dark);
      plate.position.set(x, BLOCK_H / 2, 0);
      this.block.add(plate);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(width + 0.8, 0.3, 0.5), steel);
    bar.position.y = BLOCK_H - 0.1;
    const yoke = new THREE.Mesh(new THREE.BoxGeometry(width + 0.8, 0.45, SHEAVE_D + 0.5), dark);
    yoke.position.y = 0.2;
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, width + 0.8, 12), steel);
    axle.rotation.z = Math.PI / 2;
    axle.position.y = BLOCK_H * 0.55;
    this.block.add(bar, yoke, axle);
    for (let i = 0; i < spec.passes; i++) {
      const sv = new THREE.Mesh(sheaveGeo, steel);
      sv.position.set(-width / 2 + (2 * i + 0.5) * SHEAVE_PITCH, BLOCK_H * 0.55, 0);
      this.block.add(sv);
    }
    // The shackle from the yoke down to the header's lug.
    const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 8, 16), steel);
    shackle.position.set(0, -SHACKLE_H / 2 + 0.1, 0);
    shackle.rotation.y = Math.PI / 2;
    this.block.add(shackle);

    // --- Falls: vertical lines between the crown and block sheaves -----------------------------
    const ropeGeo = new THREE.CylinderGeometry(ROPE_R, ROPE_R, 1, 6);
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(ropeGeo, rope);
      this.group.add(mesh);
      this.falls.push({ mesh, offset: -width / 2 + i * SHEAVE_PITCH });
    }

    // --- Fast and dead lines: from the crown into the tower, down inside it, out its back face
    //     low down, to the drawworks and the deadline anchor on the ground behind the base -----
    const exitY = towerBox.min.y + spec.exitSection * SECTION;
    const behind = half + 11;
    const drawworksAt = at(-behind, groundY, halfAcross * 0.6);
    const anchorAt = at(-behind + 2, groundY, -halfAcross * 0.6);
    const line = (side: number, end: THREE.Vector3) => {
      const s = side * (width / 2 + 0.3);
      const pts = [
        this.crownAxle.clone().addScaledVector(this.across, s),
        at(half - 1.2, top - 1, s),
        at(half - 1.2, exitY + 3, s),
        at(-half + 0.6, exitY, s),
        end,
      ];
      for (let i = 0; i < pts.length - 1; i++) this.segment(pts[i], pts[i + 1], rope);
    };
    line(1, drawworksAt.clone().add(new THREE.Vector3(0, 3.2, 0)));
    line(-1, anchorAt.clone().add(new THREE.Vector3(0, 2.2, 0)));

    // Drawworks: a winch drum and its motors on a skid, under a shelter.
    const dw = new THREE.Group();
    dw.position.copy(drawworksAt);
    this.group.add(dw);
    face(dw);
    const skid = new THREE.Mesh(new THREE.BoxGeometry(8, 1, 5), steel);
    skid.position.y = 0.5;
    const drumGeo = new THREE.CylinderGeometry(1.3, 1.3, 4.4, 28);
    drumGeo.rotateZ(Math.PI / 2);
    const drum = new THREE.Mesh(drumGeo, dark);
    drum.position.y = 2.4;
    dw.add(skid, drum);
    for (const x of [-3.2, 3.2]) {
      const motor = new THREE.Mesh(new THREE.BoxGeometry(1.5, 2.2, 2.4), steel);
      motor.position.set(x, 2.1, -0.4);
      dw.add(motor);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(9, 0.3, 6), cladding);
    roof.position.y = 5.2;
    dw.add(roof);
    for (const x of [-4.2, 4.2]) {
      for (const z of [-2.7, 2.7]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 4.8, 0.3), steel);
        post.position.set(x, 2.8, z);
        dw.add(post);
      }
    }

    // Dead spool and deadline anchor.
    const an = new THREE.Group();
    an.position.copy(anchorAt);
    this.group.add(an);
    face(an);
    const base = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.2, 3), steel);
    base.position.y = 0.6;
    const spoolGeo = new THREE.CylinderGeometry(0.9, 0.9, 2.2, 24);
    spoolGeo.rotateZ(Math.PI / 2);
    const spool = new THREE.Mesh(spoolGeo, dark);
    spool.position.y = 2.0;
    an.add(base, spool);

    for (const g of [this.group, this.block]) {
      g.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
    }
    // Everything but the falls (restretched as the carriage moves) is fixed to its frame: one
    // mesh per material for the crown and lines, the header, and the block.
    mergeStatic(this.group, new Set(this.falls.map((f) => f.mesh)));
    mergeStatic(header);
    mergeStatic(this.block);
    this.update();
  }

  /** A straight rope between two points (fall-group frame). */
  private segment(a: THREE.Vector3, b: THREE.Vector3, mat: THREE.Material): void {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(ROPE_R, ROPE_R, 1, 6), mat);
    this.stretch(m, a, b);
    this.group.add(m);
  }

  private stretch(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    const d = this.tmp2.subVectors(b, a);
    const len = d.length();
    m.position.addVectors(a, b).multiplyScalar(0.5);
    m.scale.set(1, len, 1);
    m.quaternion.setFromUnitVectors(this.up, d.divideScalar(len || 1));
  }

  /** Follow the carriage: the falls run from the crown's sheaves down to the block's. */
  update(): void {
    // Carriage frame -> fall-group frame (the carriage slides; no rotation relative to it).
    const axle = this.tmp.copy(this.blockAxleLocal).applyQuaternion(this.carriage.quaternion).add(this.carriage.position);
    for (const f of this.falls) {
      const topPt = this.crownAxle.clone().addScaledVector(this.across, f.offset);
      topPt.y -= SHEAVE_D / 2 - 0.1;
      const bottom = axle.clone().addScaledVector(this.across, f.offset);
      bottom.y += SHEAVE_D / 2 - 0.1;
      this.stretch(f.mesh, topPt, bottom);
    }
  }
}
