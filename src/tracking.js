// Webcam + MediaPipe Tasks Vision: hand landmarks (up to 2 hands) and face detection (for head position).
import { FilesetResolver, HandLandmarker, FaceDetector } from "@mediapipe/tasks-vision";

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

async function createTask(TaskClass, fileset, options) {
  // Try the GPU delegate first, fall back to CPU (some browsers / drivers refuse WebGL2 compute).
  for (const delegate of ["GPU", "CPU"]) {
    try {
      return await TaskClass.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate },
      });
    } catch (err) {
      if (delegate === "CPU") throw err;
      console.warn(`${TaskClass.name}: GPU delegate failed, retrying on CPU`, err);
    }
  }
}

/** Picks the largest face and returns its eye midpoint (normalized 0..1) plus eye distance (fraction of frame width). */
function parseFace(result, vw, vh) {
  const dets = result?.detections ?? [];
  if (!dets.length) return null;
  const det = dets.reduce((a, b) => (b.boundingBox.width > a.boundingBox.width ? b : a));
  const [eyeR, eyeL] = det.keypoints; // BlazeFace keypoints: 0 right eye, 1 left eye (normalized)
  const bb = det.boundingBox; // pixels
  return {
    x: (eyeR.x + eyeL.x) / 2,
    y: (eyeR.y + eyeL.y) / 2,
    eyeDist: Math.hypot(eyeR.x - eyeL.x, ((eyeR.y - eyeL.y) * vh) / vw),
    box: { x: bb.originX / vw, y: bb.originY / vh, w: bb.width / vw, h: bb.height / vh },
  };
}

export async function createTracker(video, onStatus = () => {}) {
  onStatus("Loading vision models…");
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);

  const [hands, face] = await Promise.all([
    createTask(HandLandmarker, fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }),
    createTask(FaceDetector, fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL },
      runningMode: "VIDEO",
      minDetectionConfidence: 0.5,
    }),
  ]);

  onStatus("Requesting camera…");
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  let lastVideoTime = -1;
  let latest = { hands: [], face: null, fresh: false };

  return {
    get videoAspect() {
      return video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    },
    /** Runs detection on the current video frame (only if a new frame arrived). */
    detect() {
      if (video.readyState < 2 || video.currentTime === lastVideoTime) {
        latest.fresh = false;
        return latest;
      }
      lastVideoTime = video.currentTime;
      const ts = performance.now();
      const h = hands.detectForVideo(video, ts);
      const f = face.detectForVideo(video, ts);
      latest = {
        fresh: true,
        hands: (h.landmarks ?? []).map((landmarks, i) => ({
          landmarks,
          handedness: h.handednesses?.[i]?.[0]?.categoryName ?? "Unknown",
        })),
        face: parseFace(f, video.videoWidth, video.videoHeight),
      };
      return latest;
    },
  };
}
