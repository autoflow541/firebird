// ar.js — "map a human". Runs MediaPipe Pose on the webcam and turns the body
// into a live projection-mapping quad, so any mapped surface flagged Track(AR)
// follows the performer. AR = projection mapping where the surface is a person.
//
// Library: MediaPipe Tasks Vision (Google, current/maintained — "use a good,
// recent library"). Loaded lazily via dynamic import so the app runs fine without
// it; if the assets aren't present it just reports AR unavailable.
//
// OFFLINE SHOWS: by default this pulls MediaPipe from a CDN (needs internet the
// first time). For a reliable show, vendor the files locally and set
// window.FIREBIRD_MP_BASE / window.FIREBIRD_MP_MODEL (see AR.md).

(function () {
  const MP_BASE = window.FIREBIRD_MP_BASE || "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const MODEL = window.FIREBIRD_MP_MODEL ||
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

  const cfg = { mode: "torso", margin: 0.15, smooth: 0.35 };
  let landmarker = null, video = null, stream = null, raf = null, running = false, prev = null;

  const setStatus = (t) => { const el = document.querySelector("#arState"); if (el) el.textContent = t; };

  async function ensureModel() {
    if (landmarker) return true;
    try {
      setStatus("AR loading…");
      const vision = await import(/* webpackIgnore: true */ `${MP_BASE}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL },
        runningMode: "VIDEO", numPoses: 1
      });
      return true;
    } catch (error) {
      console.error("[ar] MediaPipe unavailable:", error.message);
      setStatus("AR unavailable (see AR.md)");
      return false;
    }
  }

  async function start() {
    if (running) return;
    if (!(await ensureModel())) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      running = true;
      setStatus("● AR TRACKING");
      loop();
    } catch (error) {
      setStatus("AR: camera blocked");
      console.error("[ar]", error.message);
    }
  }

  function loop() {
    if (!running) return;
    try {
      const res = landmarker.detectForVideo(video, performance.now());
      const lm = res && res.landmarks && res.landmarks[0];
      if (lm) {
        let quad = window.FirebirdArMap.landmarksToQuad(lm, cfg);
        if (quad) {
          quad = window.FirebirdArMap.smoothQuad(prev, quad, cfg.smooth);
          prev = quad;
          window.showControl.arQuad(quad); // -> main updates tracked surfaces
        }
      }
    } catch (error) { /* frame not ready */ }
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = video = null; prev = null;
    setStatus("AR OFF");
  }

  window.FirebirdAR = { start, stop, toggle: () => (running ? stop() : start()), config: cfg };
})();
