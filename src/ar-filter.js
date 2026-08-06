// Firebird AR filter — ONE filter: a sombrero on the performer, head-tracked with
// MediaPipe Pose. Self-contained page (open as a window or use /ar as an OBS/
// projector source). Draws the webcam + a canvas-drawn sombrero via armap.headPose.
// Toggle the hat with the button or the "h" key ("...or not").
//
// MediaPipe assets: same as ar.js — window.FIREBIRD_MP_BASE / FIREBIRD_MP_MODEL
// (CDN by default; vendor locally for offline shows). Degrades gracefully: if the
// model can't load you still get the webcam, just no hat.

(function () {
  const MP_BASE = window.FIREBIRD_MP_BASE || "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const MODEL = window.FIREBIRD_MP_MODEL ||
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const setStatus = (t) => { statusEl.textContent = t; };

  let landmarker = null, video, stream, prev = null, hatOn = true;

  // Draw a stylized sombrero centred on the head. cx,cy = ear-midpoint (px),
  // w = ear-to-ear distance (px), angle = head tilt (rad).
  function drawSombrero(cx, cy, w, angle) {
    const brim = w * 2.4, crownW = w * 1.05, crownH = w * 0.95;
    ctx.save();
    ctx.translate(cx, cy - w * 0.7); // lift above the head
    ctx.rotate(angle);
    // brim
    ctx.fillStyle = "#c99a3a";
    ctx.beginPath(); ctx.ellipse(0, 0, brim / 2, brim * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#7a5e1f"; ctx.lineWidth = Math.max(1, w * 0.05); ctx.stroke();
    // crown
    ctx.fillStyle = "#b7862f";
    ctx.beginPath();
    ctx.moveTo(-crownW / 2, 0);
    ctx.quadraticCurveTo(-crownW / 2, -crownH, 0, -crownH * 1.05);
    ctx.quadraticCurveTo(crownW / 2, -crownH, crownW / 2, 0);
    ctx.closePath(); ctx.fill();
    // band
    ctx.fillStyle = "#8a2b2b";
    ctx.fillRect(-crownW / 2, -crownH * 0.32, crownW, crownH * 0.16);
    ctx.restore();
  }

  async function ensureModel() {
    if (landmarker) return true;
    try {
      const vision = await import(/* webpackIgnore: true */ `${MP_BASE}/vision_bundle.mjs`);
      const fileset = await vision.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
      landmarker = await vision.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL }, runningMode: "VIDEO", numPoses: 1
      });
      return true;
    } catch (error) {
      console.error("[ar-filter] MediaPipe unavailable:", error.message);
      setStatus("AR: no tracking (see AR.md) — webcam only");
      return false;
    }
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      video = document.createElement("video");
      video.autoplay = true; video.muted = true; video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      const tracking = await ensureModel();
      if (tracking) setStatus("● AR FILTER");
      loop(tracking);
    } catch (error) {
      setStatus("AR: camera blocked");
      console.error("[ar-filter]", error.message);
    }
  }

  function loop(tracking) {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (tracking && hatOn) {
      try {
        const res = landmarker.detectForVideo(video, performance.now());
        const lm = res && res.landmarks && res.landmarks[0];
        if (lm) {
          let pose = window.FirebirdArMap.headPose(lm);
          if (pose) {
            pose = window.FirebirdArMap.smoothPose(prev, pose, 0.4);
            prev = pose;
            drawSombrero(pose.x * canvas.width, pose.y * canvas.height, pose.width * canvas.width, pose.angle);
          }
        }
      } catch (error) { /* frame not ready */ }
    }
    requestAnimationFrame(() => loop(tracking));
  }

  function toggleHat() {
    hatOn = !hatOn;
    document.getElementById("hat").textContent = hatOn ? "🎩 HAT: ON" : "🎩 HAT: OFF";
  }
  document.getElementById("hat").onclick = toggleHat;
  window.addEventListener("keydown", (e) => { if (e.key === "h" || e.key === "H") toggleHat(); });

  start();
})();
