// Boxing tab: a heavy bag hanging from the ceiling, a focus mitt that pops up for bonus points,
// and boxing gloves on your tracked hands. Punch towards the screen to hit.
import * as THREE from "three";
import { BOX, Pendulum, scorePunch, inCylinder, movingToward } from "./boxingLogic.js";

const BAG_R = 1.6;
const BAG_H = 4.2;
const BAG_Z = -12; // bag hangs this far behind the screen
const MITT_R = 0.9;
const GLOVE_R = 0.7;

const rand = (a, b) => a + Math.random() * (b - a);

export class BoxingMode {
  /** ui: { onStats(stats), onPop(text, sub) } */
  constructor(world, ui) {
    this.world = world;
    this.ui = ui;
    this.group = new THREE.Group();
    this.group.visible = false;
    world.scene.add(this.group);

    // Heavy bag on a rope. The pivot sits on the ceiling and swings.
    this.pivot = new THREE.Group();
    this.group.add(this.pivot);
    this.rope = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.06, 1, 8),
      new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.6, metalness: 0.4 })
    );
    this.rope.castShadow = true;
    this.pivot.add(this.rope);

    this.bagMat = new THREE.MeshStandardMaterial({ color: 0xc1121f, roughness: 0.55 });
    this.bag = new THREE.Mesh(new THREE.CylinderGeometry(BAG_R, BAG_R * 0.94, BAG_H, 40), this.bagMat);
    this.bag.castShadow = this.bag.receiveShadow = true;
    const bandMat = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.7 });
    for (const y of [BAG_H / 2 - 0.35, -BAG_H / 2 + 0.35]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(BAG_R * 1.01, BAG_R * 1.01, 0.3, 40), bandMat);
      band.position.y = y;
      this.bag.add(band);
    }
    this.pivot.add(this.bag);

    // Focus mitt: a glowing pad facing you.
    this.mitt = new THREE.Group();
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(MITT_R, MITT_R, 0.35, 32),
      new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0xffd166, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    pad.rotation.x = Math.PI / 2;
    pad.castShadow = true;
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(MITT_R * 0.55, 0.07, 10, 40),
      new THREE.MeshBasicMaterial({ color: 0xc1121f })
    );
    ring.position.z = 0.19;
    this.mitt.add(pad, ring);
    this.group.add(this.mitt);

    this.gloves = new Map();
    this.pend = new Pendulum(4);
    this.bagCenter = new THREE.Vector3();
    this.flash = 0;
    this.reset();
  }

  reset() {
    this.score = 0;
    this.hits = 0;
    this.best = 0;
    this.combo = 0;
    this.t = 0;
    this.lastHitT = -99;
    this.pend.reset();
    this.layoutBag();
    this.placeMitt();
    this.emit();
  }

  enter() {
    this.group.visible = true;
    this.placeMitt();
  }

  exit() {
    this.group.visible = false;
    for (const g of this.gloves.values()) g.visible = false;
  }

  /** Hand depth for this tab: moving your hand towards the camera punches deeper into the room. */
  depth(t) {
    return THREE.MathUtils.lerp(-3, BAG_Z - 0.5, t);
  }

  /** Rope length and pivot follow the window shape so the bag always hangs mid-height. */
  layoutBag() {
    const hh = this.world.hh;
    const rope = Math.max(0.5, 2 * hh - BAG_H - 2.2);
    this.rope.scale.y = rope;
    this.rope.position.y = -rope / 2;
    this.bag.position.y = -(rope + BAG_H / 2);
    this.pend.L = rope + BAG_H / 2;
    this.pivot.position.set(0, hh, BAG_Z);
  }

  placeMitt() {
    const { hw, hh } = this.world;
    let x = rand(-hw + 2, hw - 2);
    if (Math.abs(x) < BAG_R + 1.8) x = Math.sign(x || 1) * (BAG_R + 1.8 + Math.random() * 1.5);
    x = THREE.MathUtils.clamp(x, -hw + 1.5, hw - 1.5);
    this.mitt.position.set(x, rand(-hh + 1.8, hh - 1.8), rand(-9.5, -6.5));
    this.mitt.scale.setScalar(0.01); // pops in
    this.mittLife = BOX.mittLife;
  }

  glove(slot) {
    let g = this.gloves.get(slot);
    if (!g) {
      g = new THREE.Mesh(
        new THREE.SphereGeometry(GLOVE_R, 24, 16),
        new THREE.MeshStandardMaterial({ color: slot.color, roughness: 0.35, emissive: slot.color, emissiveIntensity: 0.1 })
      );
      g.castShadow = true;
      g.visible = false;
      this.world.scene.add(g);
      this.gloves.set(slot, g);
    }
    return g;
  }

  update(slots, dt) {
    this.t += dt;
    this.layoutBag();
    this.pend.step(dt);
    this.pivot.rotation.set(-this.pend.az, 0, this.pend.ax);
    const o = this.pend.offset();
    this.bagCenter.set(this.pivot.position.x + o.x, this.pivot.position.y + o.y, this.pivot.position.z + o.z);

    this.flash = Math.max(0, this.flash - dt * 4);
    this.bagMat.emissive.setRGB(this.flash, this.flash * 0.6, this.flash * 0.2);

    this.mittLife -= dt;
    if (this.mittLife <= 0) this.placeMitt();
    const s = this.mitt.scale.x;
    this.mitt.scale.setScalar(s + (1 - s) * Math.min(1, dt * 10));
    this.mitt.lookAt(this.world.eye);

    if (this.combo && this.t - this.lastHitT > BOX.comboWindow) {
      this.combo = 0;
      this.emit();
    }

    for (const slot of slots) {
      const g = this.glove(slot);
      g.visible = slot.active;
      if (!slot.active) {
        slot.inBag = false;
        continue;
      }
      g.position.copy(slot.palmPos);
      g.scale.setScalar(slot.fist ? 1.15 : 0.9);
      g.material.emissiveIntensity = slot.fist ? 0.35 : 0.1;
      slot.boxCooldown = Math.max(0, (slot.boxCooldown ?? 0) - dt);

      const p = slot.palmPos;
      const v = slot.palmVel;
      const speed = v.length();
      const ready = slot.boxCooldown === 0 && speed > BOX.punchMin;

      // Heavy bag: count the moment the glove enters the bag while moving into it.
      const inBag = inCylinder(p, this.bagCenter, BAG_R + GLOVE_R * 0.6, BAG_H + GLOVE_R);
      if (inBag && !slot.inBag && ready && movingToward(p, v, this.bagCenter)) {
        this.pend.hit(v.x, v.z);
        this.flash = 0.8;
        this.registerHit(slot, speed, 0);
      }
      slot.inBag = inBag;

      // Focus mitt: generous in depth because webcam depth is only an estimate.
      const m = this.mitt.position;
      const dxy = Math.hypot(p.x - m.x, p.y - m.y);
      if (ready && dxy < MITT_R + GLOVE_R && Math.abs(p.z - m.z) < 2.2) {
        this.registerHit(slot, speed, BOX.mittBonus);
        this.placeMitt();
      }
    }
  }

  registerHit(slot, speed, bonus) {
    this.combo = this.t - this.lastHitT < BOX.comboWindow ? this.combo + 1 : 1;
    this.lastHitT = this.t;
    slot.boxCooldown = BOX.cooldown;
    const { power, points } = scorePunch(speed, slot.fist, this.combo);
    const total = points + bonus;
    this.score += total;
    this.hits++;
    this.best = Math.max(this.best, power);
    const sub = [
      bonus ? "MITT!" : null,
      this.combo > 1 ? `${this.combo}× combo` : null,
      slot.fist ? null : "make a fist for 1.5×",
    ].filter(Boolean);
    this.ui.onPop(`+${total}`, `power ${power}${sub.length ? " · " + sub.join(" · ") : ""}`);
    this.emit();
  }

  emit() {
    this.ui.onStats({ score: this.score, hits: this.hits, best: this.best, combo: this.combo });
  }
}
