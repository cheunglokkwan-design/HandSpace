# HandSpace

A browser experiment in webcam-only spatial interaction. Your **hands** become a 3D skeleton inside a virtual room, where you can pick up, rotate and throw shapes. Your **head position** drives a head-coupled perspective: the screen behaves like a window, and the room shifts as you move. Everything runs locally with your webcam. No headset and no extra hardware.

## Features

- **Hand tracking (up to 2 hands)**: MediaPipe Hand Landmarker, 21 joints per hand, rendered as a 3D skeleton that casts shadows.
- **Pinch to grab**: bring your thumb and index finger together near a shape. Shapes highlight when they're in reach.
- **Rotate while holding**: twist your hand and the object turns with it, using a palm orientation frame built from the knuckles.
- **Throw**: release mid-motion and the object keeps your hand's velocity, then bounces off the walls, floor and other shapes.
- **Depth from palm size**: move your hand toward the camera to reach the front of the room, or away to reach the back. A shadow blob on the floor shows where you are.
- **Head-coupled perspective**: a face detector tracks your eye position, and the camera uses an off-axis projection, the "Johnny Lee" window effect. Lean left or right, up or down, in or out to look around the room.
- **Hand-off**: grab an object that your other hand is holding to take it from that hand.
- Mouse fallback: without a camera, the mouse nudges the viewpoint so you can still see the parallax.

## Run it

The camera needs a secure context, so serve the folder over `localhost` (opening the file directly won't work):

```bash
# any static server works
python3 -m http.server 8000
# or
npx serve .
```

Then open http://localhost:8000 and press **Start camera**. Use Chrome or Edge for the best results, since MediaPipe uses the GPU delegate there.

| Key | Action |
| --- | --- |
| Pinch | Grab / release (throw) |
| `H` | Toggle head tracking |
| `C` | Recenter head (sit where you want "neutral", then press) |
| `V` | Toggle camera preview with landmark overlay |
| `Space` | Spawn a random shape |
| `R` | Reset the room |

## How it works

```
webcam ──► MediaPipe HandLandmarker ──► 21 landmarks/hand ──► world joints ──► pinch / grab / rotate / throw
       └─► MediaPipe FaceDetector  ──► eye midpoint + eye distance ──► eye position ──► off-axis projection
```

- `src/tracking.js` handles the webcam and MediaPipe tasks: hands and face, VIDEO mode, GPU with CPU fallback.
- `src/world.js` contains the three.js room, shapes, simple sphere physics, hand visuals and the head-coupled camera.
- `src/main.js` maps landmarks to world space, runs the pinch state machine and grab logic, and handles input.

**Head-coupled camera.** The screen is a fixed rectangle at `z = 0` and the eye sits at `(ex, ey, ez)`. Each frame, the projection is an asymmetric frustum through that rectangle:
`left = (-w/2 - ex)·near/ez`, `right = (w/2 - ex)·near/ez`, and the same for top and bottom.
Eye x/y comes from the face position in the frame. Eye z comes from the inverse of the distance between the eyes.

**Hand depth.** A single webcam has no true depth, so the palm length (wrist to middle knuckle) stands in for distance. Per-joint depth uses MediaPipe's relative `z`.

**Pinch.** The thumb-tip to index-tip distance is normalized by palm length, with hysteresis (on below `0.38`, off above `0.55`) so grabs don't flicker.

## Tuning

All the knobs are in `CONFIG` at the top of `src/main.js`: head gain, hand reach, palm-size range for depth, pinch thresholds, smoothing, and grab reach. If grabbing feels too far or too close, adjust `palmFar` and `palmNear` first.

## Ideas to try next

- Two-hand gestures: scale or stretch an object held by both hands.
- Swap palm-size depth for a depth camera or stereo pair.
- Proper rigid-body physics (cannon-es / Rapier) with real collision shapes.
- Build or stack mode: snap shapes together.
