// The catch arms' swing cylinders. Each arm is swung by a hydraulic cylinder lying level under its
// top: the barrel on a pin on the carriage's side, beside the tower, the rod on a pin on a lug
// on the arm, outboard of its hinge. In the model (art/blender/chopsticks.py: build_actuator)
// the barrel and the rod are each a node at its own pin, drawn with the arm shut. As an arm
// swings, the two are turned about their pins here to keep facing each other: the rod slides in
// the barrel, and is long enough, and the barrel deep enough, for every swing an arm makes.

import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);

export class ArmActuator {
  private readonly barrelBase: THREE.Quaternion;
  private readonly rodBase: THREE.Quaternion;
  private readonly barrelHome: number;
  private readonly rodHome: number;
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  /** barrel: the node at the carriage's pin; rod: the node at the arm's lug (the arm shut, as modelled). */
  constructor(
    private readonly barrel: THREE.Object3D,
    private readonly rod: THREE.Object3D,
  ) {
    this.barrelBase = barrel.quaternion.clone();
    this.rodBase = rod.quaternion.clone();
    this.barrelHome = this.bearing(barrel, rod);
    this.rodHome = this.bearing(rod, barrel);
  }

  /** The bearing from one pin to the other, about the up axis of the first one's parent (rad). */
  private bearing(from: THREE.Object3D, to: THREE.Object3D): number {
    const parent = from.parent!;
    parent.updateWorldMatrix(true, false);
    to.getWorldPosition(this.v);
    parent.worldToLocal(this.v).sub(from.position);
    return Math.atan2(this.v.x, this.v.z);
  }

  /** After the arm has been posed. */
  update(): void {
    this.barrel.quaternion.copy(this.barrelBase).premultiply(this.q.setFromAxisAngle(UP, this.bearing(this.barrel, this.rod) - this.barrelHome));
    this.rod.quaternion.copy(this.rodBase).premultiply(this.q.setFromAxisAngle(UP, this.bearing(this.rod, this.barrel) - this.rodHome));
  }
}
