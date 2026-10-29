// The 3D scene: a "room behind the screen", grabbable shapes with simple physics,
// hand skeleton visuals, and a head-coupled (off-axis) perspective camera.
import * as THREE from "three";

export const SCREEN_W = 16; // world units across the physical screen
export const ROOM_D = 22; // how deep the room goes behind the screen
const GRAVITY = -28;
const MAX_OBJECTS = 30;

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const SHAPES = [
  { name: "cube", r: 1.05, geo: () => new THREE.BoxGeometry(1.7, 1.7, 1.7) },
  { name: "sphere", r: 1.1, geo: () => new THREE.SphereGeometry(1.1, 40, 24) },
  { name: "torus", r: 1.2, geo: () => new THREE.TorusGeometry(0.9, 0.34, 20, 48) },
  { name: "cone", r: 1.05, geo: () => new THREE.ConeGeometry(1.0, 2.0, 32) },
  { name: "cylinder", r: 1.05, geo: () => new THREE.CylinderGeometry(0.8, 0.8, 1.8, 32) },
  { name: "icosahedron", r: 1.1, geo: () => new THREE.IcosahedronGeometry(1.15, 0) },
  { name: "octahedron", r: 1.1, geo: () => new THREE.OctahedronGeometry(1.25, 0) },
  { name: "torus knot", r: 1.15, geo: () => new THREE.TorusKnotGeometry(0.7, 0.24, 120, 16) },
  { name: "capsule", r: 1.05, geo: () => new THREE.CapsuleGeometry(0.6, 1.0, 8, 24) },
];
const COLORS = [0xff6b6b, 0xffd166, 0x06d6a0, 0x4cc9f0, 0x9b5de5, 0xf15bb5, 0xff9f1c, 0x2ec4b6, 0xe9ff70];

const rand = (a, b) => a + Math.random() * (b - a);
const UP = new THREE.Vector3(0, 1, 0);

function gridTexture(repeatX, repeatY) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#131824";
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = "#2c3b5e";
  g.lineWidth = 4;
  g.strokeRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d12);
    this.camera = new THREE.PerspectiveCamera(); // projection is set manually each frame
    this.eye = new THREE.Vector3(0, 0, 22); // viewer's eye, in world units (screen plane is z = 0)

    this.objects = [];
    this.hands = [];
    this.room = null;
    this.hh = 4.5;

    this.buildLights();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  get hw() {
    return SCREEN_W / 2;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.hh = (SCREEN_W / 2) * (h / w);
    this.buildRoom();
    this.placeLights();
    for (const o of this.objects) this.keepInside(o);
  }

  // ---------- room + lights ----------
  buildRoom() {
    if (this.room) {
      this.scene.remove(this.room);
      this.room.traverse((o) => {
        if (o.isMesh) {
          o.geometry.dispose();
          o.material.map?.dispose();
          o.material.dispose();
        }
      });
    }
    const g = new THREE.Group();
    const { hw, hh } = this;
    const d = ROOM_D;
    const wall = (w, h, x, y, z, rx, ry) => {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshStandardMaterial({ map: gridTexture(w / 2, h / 2), roughness: 0.95 })
      );
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, 0);
      m.receiveShadow = true;
      g.add(m);
    };
    wall(2 * hw, 2 * hh, 0, 0, -d, 0, 0); // back
    wall(2 * hw, d, 0, -hh, -d / 2, -Math.PI / 2, 0); // floor
    wall(2 * hw, d, 0, hh, -d / 2, Math.PI / 2, 0); // ceiling
    wall(d, 2 * hh, -hw, 0, -d / 2, 0, Math.PI / 2); // left
    wall(d, 2 * hh, hw, 0, -d / 2, 0, -Math.PI / 2); // right
    this.room = g;
    this.scene.add(g);
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1a24, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    sun.shadow.camera.up.set(0, 0, -1); // light points straight down; avoid a degenerate up vector
    this.sun = sun;
    this.scene.add(sun, sun.target);

    this.fill = new THREE.PointLight(0xffffff, 120, 0, 2);
    this.scene.add(this.fill);
  }

  placeLights() {
    const { hw, hh } = this;
    const d = ROOM_D;
    this.sun.position.set(1.5, hh + 20, -d / 2 + 2);
    this.sun.target.position.set(0, -hh, -d / 2);
    const cam = this.sun.shadow.camera;
    cam.left = -hw - 3;
    cam.right = hw + 3;
    cam.top = d / 2 + 4;
    cam.bottom = -d / 2 - 4;
    cam.near = 1;
    cam.far = hh * 2 + 40;
    cam.updateProjectionMatrix();
    this.fill.position.set(0, hh - 1, 3);
  }

  // ---------- objects ----------
  spawn(index = Math.floor(Math.random() * SHAPES.length), position = null) {
    const shape = SHAPES[index % SHAPES.length];
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.15 });
    const mesh = new THREE.Mesh(shape.geo(), mat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.position.copy(
      position ?? new THREE.Vector3(rand(-this.hw + 2, this.hw - 2), this.hh - 2, rand(-ROOM_D + 4, -5))
    );
    mesh.rotation.set(rand(0, Math.PI), rand(0, Math.PI), 0);
    const obj = {
      mesh,
      name: shape.name,
      r: shape.r,
      color: new THREE.Color(color),
      vel: new THREE.Vector3(),
      spin: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)),
      heldBy: null,
    };
    this.scene.add(mesh);
    this.objects.push(obj);
    while (this.objects.length > MAX_OBJECTS) {
      const old = this.objects.find((o) => !o.heldBy);
      if (!old) break;
      this.remove(old);
    }
    return obj;
  }

  remove(obj) {
    this.scene.remove(obj.mesh);
    obj.mesh.geometry.dispose();
    obj.mesh.material.dispose();
    this.objects.splice(this.objects.indexOf(obj), 1);
  }

  reset() {
    for (const o of [...this.objects]) this.remove(o);
    // Lay out one of each shape on the floor in a 3x3 grid.
    const cols = 3;
    SHAPES.forEach((s, i) => {
      const cx = i % cols;
      const cz = Math.floor(i / cols);
      const x = THREE.MathUtils.lerp(-this.hw + 3, this.hw - 3, cx / (cols - 1));
      const z = THREE.MathUtils.lerp(-6, -ROOM_D + 5, cz / 2);
      const o = this.spawn(i, new THREE.Vector3(x, -this.hh + s.r, z));
      o.mesh.rotation.set(0, rand(0, Math.PI), 0);
      o.spin.set(0, 0, 0);
    });
  }

  keepInside(o) {
    const p = o.mesh.position;
    p.x = THREE.MathUtils.clamp(p.x, -this.hw + o.r, this.hw - o.r);
    p.y = THREE.MathUtils.clamp(p.y, -this.hh + o.r, this.hh - o.r);
    p.z = THREE.MathUtils.clamp(p.z, -ROOM_D + o.r, 2);
  }

  /** Highlight level: 0 none, 1 hovered (in reach), 2 held. */
  setHighlight(o, level) {
    const k = level === 2 ? 0.45 : level === 1 ? 0.22 : 0;
    o.mesh.material.emissive.copy(o.color).multiplyScalar(k);
  }

  // ---------- physics ----------
  step(dt) {
    const SUB = 2;
    const h = dt / SUB;
    for (let s = 0; s < SUB; s++) this.substep(h);
  }

  substep(dt) {
    const { hw, hh } = this;
    for (const o of this.objects) {
      if (o.heldBy) continue;
      const p = o.mesh.position;
      const v = o.vel;
      const r = o.r;
      v.y += GRAVITY * dt;
      p.addScaledVector(v, dt);

      if (p.y < -hh + r) {
        p.y = -hh + r;
        if (v.y < 0) v.y = -v.y * 0.4;
        if (Math.abs(v.y) < 0.8) v.y = 0;
        const f = Math.exp(-4 * dt); // floor friction
        v.x *= f;
        v.z *= f;
        o.spin.multiplyScalar(Math.exp(-3 * dt));
      }
      if (p.y > hh - r) { p.y = hh - r; if (v.y > 0) v.y *= -0.5; }
      if (p.x < -hw + r) { p.x = -hw + r; if (v.x < 0) v.x *= -0.6; }
      if (p.x > hw - r) { p.x = hw - r; if (v.x > 0) v.x *= -0.6; }
      if (p.z < -ROOM_D + r) { p.z = -ROOM_D + r; if (v.z < 0) v.z *= -0.6; }
      if (p.z > -r) { p.z = -r; if (v.z > 0) v.z *= -0.6; } // invisible glass at the screen

      o.mesh.rotation.x += o.spin.x * dt;
      o.mesh.rotation.y += o.spin.y * dt;
      o.mesh.rotation.z += o.spin.z * dt;
    }

    // Sphere-sphere collisions (equal mass). Held objects act as immovable pushers.
    const n = new THREE.Vector3();
    for (let i = 0; i < this.objects.length; i++) {
      for (let j = i + 1; j < this.objects.length; j++) {
        const a = this.objects[i];
        const b = this.objects[j];
        if (a.heldBy && b.heldBy) continue;
        n.subVectors(b.mesh.position, a.mesh.position);
        const dist = n.length();
        const min = a.r + b.r;
        if (dist >= min || dist < 1e-5) continue;
        n.divideScalar(dist);
        const overlap = min - dist;
        const rv = b.vel.clone().sub(a.vel).dot(n); // relative velocity along normal
        if (a.heldBy) {
          b.mesh.position.addScaledVector(n, overlap);
          if (rv < 0) b.vel.addScaledVector(n, -rv * 1.3);
        } else if (b.heldBy) {
          a.mesh.position.addScaledVector(n, -overlap);
          if (rv < 0) a.vel.addScaledVector(n, rv * 1.3);
        } else {
          a.mesh.position.addScaledVector(n, -overlap / 2);
          b.mesh.position.addScaledVector(n, overlap / 2);
          if (rv < 0) {
            const imp = (-(1 + 0.5) * rv) / 2;
            a.vel.addScaledVector(n, -imp);
            b.vel.addScaledVector(n, imp);
          }
        }
      }
    }
  }

  // ---------- hands ----------
  createHandVisual(color) {
    const group = new THREE.Group();
    const jointMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.3 });
    const boneMat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: true, opacity: 0.85 });
    const jointGeo = new THREE.SphereGeometry(0.17, 16, 12);
    const boneGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 8);

    const joints = [];
    for (let i = 0; i < 21; i++) {
      const m = new THREE.Mesh(jointGeo, jointMat);
      if ([4, 8, 12, 16, 20].includes(i)) m.scale.setScalar(1.25);
      m.castShadow = true;
      joints.push(m);
      group.add(m);
    }
    const bones = HAND_CONNECTIONS.map(() => {
      const m = new THREE.Mesh(boneGeo, boneMat);
      m.castShadow = true;
      group.add(m);
      return m;
    });

    const cursor = new THREE.Mesh(
      new THREE.TorusGeometry(0.5, 0.06, 12, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 })
    );
    group.add(cursor);

    // Soft blob on the floor under the pinch point: a strong depth cue.
    const blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.7, 32),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;

    group.visible = blob.visible = false;
    this.scene.add(group, blob);

    const tmp = new THREE.Vector3();
    const world = this;
    return {
      setVisible(v) {
        group.visible = blob.visible = v;
      },
      update(points, cursorPos, pinching) {
        points.forEach((p, i) => joints[i].position.copy(p));
        HAND_CONNECTIONS.forEach(([a, b], k) => {
          const bone = bones[k];
          tmp.subVectors(points[b], points[a]);
          const len = tmp.length();
          bone.position.copy(points[a]).addScaledVector(tmp, 0.5);
          bone.scale.set(1, Math.max(len, 1e-3), 1);
          if (len > 1e-5) bone.quaternion.setFromUnitVectors(UP, tmp.divideScalar(len));
        });
        cursor.position.copy(cursorPos);
        cursor.lookAt(world.eye);
        cursor.material.color.setHex(pinching ? 0x4ade80 : 0xffffff);
        cursor.scale.setScalar(pinching ? 0.65 : 1);

        const height = cursorPos.y + world.hh;
        blob.position.set(
          THREE.MathUtils.clamp(cursorPos.x, -world.hw, world.hw),
          -world.hh + 0.02,
          THREE.MathUtils.clamp(cursorPos.z, -ROOM_D, 0)
        );
        blob.scale.setScalar(1 + height * 0.08);
        blob.material.opacity = THREE.MathUtils.clamp(0.45 - height * 0.03, 0.08, 0.45);
      },
    };
  }

  // ---------- camera + render ----------
  /** Off-axis projection: the screen is a fixed window at z = 0, and the eye looks through it. */
  updateCamera() {
    const e = this.eye;
    e.z = Math.max(e.z, 2);
    const near = 0.1;
    const far = 300;
    const k = near / e.z;
    this.camera.position.copy(e);
    this.camera.quaternion.identity();
    this.camera.updateMatrixWorld();
    this.camera.projectionMatrix.makePerspective(
      (-this.hw - e.x) * k,
      (this.hw - e.x) * k,
      (this.hh - e.y) * k,
      (-this.hh - e.y) * k,
      near,
      far
    );
    this.camera.projectionMatrixInverse.copy(this.camera.projectionMatrix).invert();
  }

  render() {
    this.updateCamera();
    this.renderer.render(this.scene, this.camera);
  }
}
