// Pure boxing logic (no three.js) so it can be unit-tested in Node.

export const BOX = {
  punchMin: 9, // hand speed (world units/s) needed for a contact to count as a punch
  powerMax: 45, // speed that scores 100 power
  cooldown: 0.28, // seconds before the same hand can score again
  comboWindow: 1.4, // seconds between hits to keep a combo going
  fistBonus: 1.5, // multiplier for a closed fist
  fistRatio: 1.35, // average fingertip→wrist distance / palm length below this = fist
  mittBonus: 50,
  mittLife: 3.5, // seconds before an unhit mitt moves somewhere else
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Closed fist when the fingertips are curled back towards the wrist. Landmarks are MediaPipe-normalized. */
export function isFist(lm, va = 16 / 9) {
  const d = (a, b) => Math.hypot((a.x - b.x) * va, a.y - b.y, (a.z - b.z) * va);
  const palm = Math.max(d(lm[0], lm[9]), 1e-3);
  const tips = [8, 12, 16, 20];
  const avg = tips.reduce((s, t) => s + d(lm[t], lm[0]), 0) / tips.length / palm;
  return avg < BOX.fistRatio;
}

/** Power 1..100 from punch speed, and the points it is worth. */
export function scorePunch(speed, fist, combo = 1) {
  const power = clamp(Math.round((speed / BOX.powerMax) * 100), 1, 100);
  const comboMult = Math.min(1 + (combo - 1) * 0.1, 2);
  const points = Math.round(power * (fist ? BOX.fistBonus : 1) * comboMult);
  return { power, points };
}

/** Is point p inside a vertical cylinder (centre c, radius r, height h)? Points are {x,y,z}. */
export function inCylinder(p, c, r, h) {
  return Math.abs(p.y - c.y) <= h / 2 && Math.hypot(p.x - c.x, p.z - c.z) <= r;
}

/** Is the hand moving towards the target (horizontally)? */
export function movingToward(p, vel, c) {
  return (c.x - p.x) * vel.x + (c.z - p.z) * vel.z > 0;
}

/** Small-angle-safe 2D pendulum for the heavy bag: ax swings left/right, az swings front/back. */
export class Pendulum {
  constructor(length, gravity = 28, damping = 1.1) {
    this.L = length;
    this.g = gravity;
    this.damping = damping;
    this.reset();
  }
  reset() {
    this.ax = this.az = 0;
    this.vx = this.vz = 0;
  }
  step(dt) {
    const k = this.g / this.L;
    this.vx += (-k * Math.sin(this.ax) - this.damping * this.vx) * dt;
    this.vz += (-k * Math.sin(this.az) - this.damping * this.vz) * dt;
    this.ax = clamp(this.ax + this.vx * dt, -0.7, 0.7);
    this.az = clamp(this.az + this.vz * dt, -0.7, 0.7);
  }
  /** Push from a punch with hand velocity (vx, vz) in world units/s. */
  hit(vx, vz, transfer = 0.35) {
    this.vx += (vx / this.L) * transfer;
    this.vz += (vz / this.L) * transfer;
  }
  /** Offset of the bag centre from the pivot (matches three.js Euler XYZ with rotation.z = ax, rotation.x = -az). */
  offset() {
    const { L, ax, az } = this;
    return { x: L * Math.sin(ax), y: -L * Math.cos(ax) * Math.cos(az), z: L * Math.cos(ax) * Math.sin(az) };
  }
}
