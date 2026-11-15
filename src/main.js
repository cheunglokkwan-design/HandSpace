import * as THREE from "three";
import { createTracker } from "./tracking.js";
import { World, SCREEN_W, ROOM_D, HAND_CONNECTIONS } from "./world.js";
import { BoxingMode } from "./boxing.js";
import { isFist } from "./boxingLogic.js";

// ---------------- tuning ----------------
const CONFIG = {
  // Head → eye
  baseEyeZ: 22, // eye distance from the screen when you sit at your calibrated position
  headGain: 2.2, // how strongly head movement shifts the view
  headSmoothing: 0.25,
  // Hand → world
  handGain: 1.3, // camera-frame → world scale (higher = reach the room edges with less movement)
  handCenterY: 0.55, // image row treated as "middle of the screen" (hands usually sit a bit low in frame)
  palmFar: 0.09, // palm length (fraction of frame height) when your hand is far from the camera
  palmNear: 0.3, // ...and when it's close
  handSmoothing: 0.5,
  // Interaction
  pinchOn: 0.38, // thumb-index distance / palm length to start a pinch
  pinchOff: 0.55, // ...and to release it (hysteresis prevents flicker)
  grabReach: 1.3, // extra reach beyond an object's radius
  maxThrow: 35,
};

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const video = $("video");
const overlay = $("overlay");
const octx = overlay.getContext("2d");
const statusEl = $("status");
const statsEl = $("stats");
const setStatus = (s) => (statusEl.textContent = s);

// ---------------- world ----------------
const world = new World($("scene"));
world.reset();

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;

class HandSlot {
  constructor(label, color) {
    this.label = label;
    this.color = color;
    this.vis = world.createHandVisual(color);
    // Palm centre (knuckles) + velocity, and fist state: used by the Boxing tab.
    this.palmPos = new THREE.Vector3();
    this.prevPalm = new THREE.Vector3();
    this.palmVel = new THREE.Vector3();
    this.fist = false;
    this.inBag = false;
    this.boxCooldown = 0;
    this.joints = Array.from({ length: 21 }, () => new THREE.Vector3());
    this.active = false;
    this.lostFor = 0;
    this.pinching = false;
    this.cursor = new THREE.Vector3();
    this.prevCursor = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.held = null;
    this.grabOffset = new THREE.Vector3();
    this.grabHandQuatInv = new THREE.Quaternion();
    this.grabObjQuat = new THREE.Quaternion();
  }
}
// MediaPipe labels handedness assuming a mirrored (selfie) image. Our feed isn't mirrored,
// so its "Left" is your right hand. Keys follow MediaPipe; labels are what you see.
const slots = { Left: new HandSlot("right hand", 0x4cc9f0), Right: new HandSlot("left hand", 0xf15bb5) };

// ---------------- tabs / modes ----------------
// "playground": the original grab-and-throw room. "boxing": heavy bag + focus mitt.
const MODES = ["playground", "boxing"];
let mode = "playground";
let savedShapes = null; // Playground shapes kept aside while you box

const popEl = $("pop");
let popTimer = 0;
const boxing = new BoxingMode(world, {
  onStats({ score, hits, best, combo }) {
    $("score").innerHTML =
      `<b>${score}</b> pts · ${hits} hits · best power ${best}` + (combo > 1 ? ` · <b>${combo}× combo</b>` : "");
  },
  onPop(text, sub) {
    popEl.innerHTML = `<div class="big">${text}</div><div class="sub">${sub}</div>`;
    popEl.classList.remove("show");
    void popEl.offsetWidth; // restart the animation
    popEl.classList.add("show");
    clearTimeout(popTimer);
    popTimer = setTimeout(() => popEl.classList.remove("show"), 900);
  },
});

function setMode(next) {
  if (!MODES.includes(next) || next === mode) return;
  if (mode === "playground") {
    for (const s of Object.values(slots)) release(s, false);
    savedShapes = world.stashObjects();
  } else {
    boxing.exit();
  }
  mode = next;
  if (mode === "playground") {
    if (savedShapes) world.restoreObjects(savedShapes);
    savedShapes = null;
  } else {
    boxing.enter();
  }
  for (const s of Object.values(slots)) s.vis.showCursor = mode === "playground";
  document.querySelectorAll("#tabs .tab").forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on);
  });
  document.querySelectorAll("#hud [data-mode]").forEach((el) => (el.hidden = el.dataset.mode !== mode));
  history.replaceState(null, "", mode === "playground" ? location.pathname : `#${mode}`);
  if (tracker) setStatus(mode === "boxing" ? "Punch towards the screen to hit the bag." : "Pinch near a shape to grab it.");
}

// ---------------- state ----------------
let tracker = null;
let headEnabled = true;
let headCalib = null; // { x, y, d } neutral face position + eye distance
let faceSeen = false;
const mouse = new THREE.Vector2(0, 0);

// ---------------- head tracking ----------------
const eyeTarget = new THREE.Vector3();
function updateHead(face) {
  const va = tracker?.videoAspect ?? 16 / 9;
  faceSeen = !!face;
  if (headEnabled && face) {
    if (!headCalib) headCalib = { x: face.x, y: face.y, d: face.eyeDist };
    const s = SCREEN_W * CONFIG.headGain;
    // Camera image is not mirrored: moving to your right moves your face left in the image.
    eyeTarget.set(
      -(face.x - headCalib.x) * s,
      (-(face.y - headCalib.y) * s) / va,
      clamp((CONFIG.baseEyeZ * headCalib.d) / face.eyeDist, 8, 60)
    );
  } else {
    // Fallback: the mouse nudges the viewpoint so the parallax effect is still visible.
    eyeTarget.set(mouse.x * 5, mouse.y * 3, CONFIG.baseEyeZ);
  }
  world.eye.lerp(eyeTarget, CONFIG.headSmoothing);
}

// ---------------- hand tracking ----------------
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const basis = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3(), m: new THREE.Matrix4() };

function landmarkToWorld(l, baseZ, va, out, zSign = 1) {
  const s = SCREEN_W * CONFIG.handGain;
  // x mirrored so your hand moves like in a mirror; y in the same units as x (no distortion).
  // zSign flips per-joint depth in the Boxing tab, where "towards the camera" means "into the room".
  return out.set((0.5 - l.x) * s, ((CONFIG.handCenterY - l.y) * s) / va, baseZ - zSign * l.z * s);
}

function handOrientation(j, out) {
  // Palm frame: y = wrist → middle knuckle, x = pinky knuckle → index knuckle.
  basis.y.subVectors(j[9], j[0]).normalize();
  basis.x.subVectors(j[5], j[17]);
  basis.z.crossVectors(basis.x, basis.y).normalize();
  basis.x.crossVectors(basis.y, basis.z).normalize();
  basis.m.makeBasis(basis.x, basis.y, basis.z);
  return out.setFromRotationMatrix(basis.m);
}

function processHand(slot, lm, dt) {
  const va = tracker.videoAspect;
  // Hand depth from apparent palm size (wrist → middle-finger knuckle), aspect-corrected to frame-height units.
  const palm = Math.hypot((lm[0].x - lm[9].x) * va, lm[0].y - lm[9].y);
  const t = clamp((palm - CONFIG.palmFar) / (CONFIG.palmNear - CONFIG.palmFar), 0, 1);
  // Playground: hand closer to the camera = front of the room (reach in by pulling back).
  // Boxing: hand closer to the camera = deeper into the room, so punching at the screen hits the bag.
  const boxingMode = mode === "boxing";
  const baseZ = boxingMode ? boxing.depth(t) : lerp(-ROOM_D + 2, 1, t);

  const a = slot.active ? CONFIG.handSmoothing : 1;
  lm.forEach((l, i) => slot.joints[i].lerp(landmarkToWorld(l, baseZ, va, tmpV, boxingMode ? -1 : 1), a));

  // Palm centre (average of the four knuckles) + its velocity, and whether the hand is a fist.
  slot.prevPalm.copy(slot.palmPos);
  slot.palmPos.set(0, 0, 0);
  for (const k of [5, 9, 13, 17]) slot.palmPos.add(slot.joints[k]);
  slot.palmPos.multiplyScalar(0.25);
  if (slot.active && dt > 0) {
    tmpV.subVectors(slot.palmPos, slot.prevPalm).divideScalar(dt);
    slot.palmVel.lerp(tmpV, 0.5);
  } else {
    slot.palmVel.set(0, 0, 0);
  }
  slot.fist = isFist(lm, va);

  // Pinch detection with hysteresis.
  const pinchDist =
    Math.hypot((lm[4].x - lm[8].x) * va, lm[4].y - lm[8].y, (lm[4].z - lm[8].z) * va) / Math.max(palm, 1e-3);
  const wasPinching = slot.pinching;
  slot.pinching = wasPinching ? pinchDist < CONFIG.pinchOff : pinchDist < CONFIG.pinchOn;

  // Pinch point (between thumb tip and index tip) + its velocity for throwing.
  slot.prevCursor.copy(slot.cursor);
  slot.cursor.addVectors(slot.joints[4], slot.joints[8]).multiplyScalar(0.5);
  if (slot.active && dt > 0) {
    tmpV.subVectors(slot.cursor, slot.prevCursor).divideScalar(dt);
    slot.velocity.lerp(tmpV, 0.35);
  } else {
    slot.velocity.set(0, 0, 0);
  }

  handOrientation(slot.joints, tmpQ);
  if (slot.active) slot.quat.slerp(tmpQ, 0.4);
  else slot.quat.copy(tmpQ);

  slot.active = true;
  slot.lostFor = 0;
  slot.vis.setVisible(true);
  slot.vis.update(slot.joints, slot.cursor, slot.pinching);

  if (boxingMode) return; // no grabbing in the Boxing tab
  if (slot.pinching && !wasPinching) tryGrab(slot);
  if (!slot.pinching && wasPinching) release(slot, true);
  if (slot.held) moveHeld(slot);
}

function tryGrab(slot) {
  let best = null;
  let bestD = Infinity;
  for (const o of world.objects) {
    const d = o.mesh.position.distanceTo(slot.cursor) - o.r;
    if (d < CONFIG.grabReach && d < bestD) {
      best = o;
      bestD = d;
    }
  }
  if (!best) return;
  if (best.heldBy) release(best.heldBy, false); // take it from the other hand
  slot.held = best;
  best.heldBy = slot;
  best.spin.set(0, 0, 0);
  slot.grabOffset.subVectors(best.mesh.position, slot.cursor);
  slot.grabHandQuatInv.copy(slot.quat).invert();
  slot.grabObjQuat.copy(best.mesh.quaternion);
}

function moveHeld(slot) {
  const o = slot.held;
  slot.grabOffset.multiplyScalar(0.88); // ease the object into your fingers
  tmpV.addVectors(slot.cursor, slot.grabOffset);
  o.mesh.position.lerp(tmpV, 0.6);
  world.keepInside(o);
  o.vel.copy(slot.velocity); // so held objects shove others realistically
  // Rotate with the hand: object = (handNow * handAtGrab⁻¹) * objectAtGrab
  o.mesh.quaternion.copy(slot.quat).multiply(slot.grabHandQuatInv).multiply(slot.grabObjQuat);
}

function release(slot, throwIt) {
  const o = slot.held;
  if (!o) return;
  o.heldBy = null;
  slot.held = null;
  if (throwIt) {
    o.vel.copy(slot.velocity).clampLength(0, CONFIG.maxThrow);
    o.spin.set(o.vel.y, -o.vel.x, o.vel.z).multiplyScalar(0.15);
  } else {
    o.vel.set(0, 0, 0);
  }
}

function loseHand(slot) {
  release(slot, false);
  slot.active = false;
  slot.pinching = false;
  slot.vis.setVisible(false);
}

function updateHands(hands, dt) {
  const seen = new Set();
  for (const h of hands) {
    let slot = slots[h.handedness] ?? slots.Right;
    if (seen.has(slot)) slot = slot === slots.Left ? slots.Right : slots.Left; // both labelled the same
    seen.add(slot);
    processHand(slot, h.landmarks, dt);
  }
  for (const slot of Object.values(slots)) {
    if (seen.has(slot) || !slot.active) continue;
    slot.lostFor += dt;
    if (slot.lostFor > 0.3) loseHand(slot); // brief dropouts don't drop your object
  }
}

function updateHighlights() {
  for (const o of world.objects) {
    if (o.heldBy) {
      world.setHighlight(o, 2);
      continue;
    }
    let near = false;
    for (const s of Object.values(slots)) {
      if (s.active && !s.held && o.mesh.position.distanceTo(s.cursor) - o.r < CONFIG.grabReach) near = true;
    }
    world.setHighlight(o, near ? 1 : 0);
  }
}

// ---------------- camera preview overlay ----------------
function drawOverlay(res) {
  const w = (overlay.width = video.videoWidth || 640);
  const h = (overlay.height = video.videoHeight || 360);
  octx.clearRect(0, 0, w, h);
  if (res.face) {
    const b = res.face.box;
    octx.strokeStyle = headEnabled ? "#ffd166" : "#666";
    octx.lineWidth = 3;
    octx.strokeRect(b.x * w, b.y * h, b.w * w, b.h * h);
  }
  for (const hand of res.hands) {
    const lm = hand.landmarks;
    octx.strokeStyle = hand.handedness === "Left" ? "#4cc9f0" : "#f15bb5";
    octx.lineWidth = 3;
    octx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      octx.moveTo(lm[a].x * w, lm[a].y * h);
      octx.lineTo(lm[b].x * w, lm[b].y * h);
    }
    octx.stroke();
    octx.fillStyle = "#fff";
    for (const p of lm) {
      octx.beginPath();
      octx.arc(p.x * w, p.y * h, 4, 0, Math.PI * 2);
      octx.fill();
    }
  }
}

// ---------------- main loop ----------------
let last = performance.now();
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 0;
let lastHands = [];

function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;

  if (tracker) {
    const res = tracker.detect();
    if (res.fresh) {
      lastHands = res.hands;
      updateHands(res.hands, dt);
      if (!$("pip").classList.contains("hidden")) drawOverlay(res);
    } else {
      for (const s of Object.values(slots)) if (s.held) moveHeld(s);
    }
    updateHead(res.face);
  } else {
    updateHead(null);
  }

  if (mode === "boxing") boxing.update(Object.values(slots), dt);
  else updateHighlights();
  world.step(dt);
  world.render();

  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsFrames / fpsAcc);
    fpsAcc = fpsFrames = 0;
    const held = Object.values(slots).filter((s) => s.held).map((s) => `${s.label}: ${s.held.name}`);
    statsEl.textContent =
      `${fps} fps · hands ${lastHands.length} · face ${faceSeen ? "yes" : "no"}` +
      (held.length ? ` · holding ${held.join(", ")}` : "");
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------- input ----------------
window.addEventListener("mousemove", (e) => {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1));
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLButtonElement) return;
  switch (e.key.toLowerCase()) {
    case "1":
      setMode("playground");
      break;
    case "2":
      setMode("boxing");
      break;
    case "h":
      headEnabled = !headEnabled;
      document.querySelectorAll(".headState").forEach((el) => (el.textContent = headEnabled ? "on" : "off"));
      break;
    case "c":
      headCalib = null; // recalibrates on the next detected face
      setStatus("Head recentered");
      break;
    case "v":
      $("pip").classList.toggle("hidden");
      break;
    case " ":
      e.preventDefault();
      if (mode === "playground") world.spawn();
      break;
    case "r":
      if (mode === "boxing") {
        boxing.reset();
        break;
      }
      for (const s of Object.values(slots)) release(s, false);
      world.reset();
      break;
  }
});

document.querySelectorAll("#tabs .tab").forEach((btn) =>
  btn.addEventListener("click", () => {
    setMode(btn.dataset.mode);
    btn.blur(); // keep keyboard shortcuts working after clicking a tab
  })
);
setMode(location.hash.slice(1)); // open straight into #boxing if the link says so

$("startBtn").addEventListener("click", async () => {
  const btn = $("startBtn");
  btn.disabled = true;
  try {
    tracker = await createTracker(video, (s) => {
      setStatus(s);
      btn.textContent = s;
    });
    $("start").classList.add("hidden");
    setStatus(
      mode === "boxing" ? "Tracking. Punch towards the screen to hit the bag." : "Tracking. Pinch near a shape to grab it."
    );
  } catch (err) {
    console.error(err);
    const msg =
      err?.name === "NotAllowedError"
        ? "Camera permission was denied."
        : err?.name === "NotFoundError"
          ? "No camera found."
          : `Couldn't start tracking: ${err?.message ?? err}`;
    setStatus(msg);
    btn.textContent = "Try again";
    btn.disabled = false;
  }
});
