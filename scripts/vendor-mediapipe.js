// Vendors MediaPipe locally so the AR features work OFFLINE (no CDN, no file://
// CORS). Copies the tasks-vision bundle + wasm from node_modules and downloads the
// pose model into src/vendor/mediapipe/. Runs on `npm install` (postinstall) and
// via `npm run vendor:mediapipe`. Non-fatal: if it can't (e.g. offline), the app
// still runs and AR falls back to the CDN.

const fs = require("fs");
const path = require("path");
const https = require("https");

const SRC = path.join(__dirname, "..", "node_modules", "@mediapipe", "tasks-vision");
const DEST = path.join(__dirname, "..", "src", "vendor", "mediapipe");
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const MODEL_DEST = path.join(DEST, "pose_landmarker_lite.task");

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.headers.location) { file.close(); return download(res.headers.location, dest).then(resolve, reject); }
      if (res.statusCode !== 200) { file.close(); return reject(new Error("HTTP " + res.statusCode)); }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (e) => { file.close(); fs.rmSync(dest, { force: true }); reject(e); });
  });
}

async function main() {
  if (!fs.existsSync(SRC)) { console.log("[vendor-mediapipe] @mediapipe/tasks-vision not installed yet — skipping."); return; }
  fs.mkdirSync(path.join(DEST, "wasm"), { recursive: true });
  fs.copyFileSync(path.join(SRC, "vision_bundle.mjs"), path.join(DEST, "vision_bundle.mjs"));
  for (const f of fs.readdirSync(path.join(SRC, "wasm"))) {
    fs.copyFileSync(path.join(SRC, "wasm", f), path.join(DEST, "wasm", f));
  }
  console.log("[vendor-mediapipe] copied bundle + wasm.");
  if (fs.existsSync(MODEL_DEST) && fs.statSync(MODEL_DEST).size > 1e6) { console.log("[vendor-mediapipe] model already present."); return; }
  console.log("[vendor-mediapipe] downloading pose model…");
  await download(MODEL_URL, MODEL_DEST);
  console.log("[vendor-mediapipe] done:", DEST);
}

main().catch((e) => { console.warn("[vendor-mediapipe] skipped (AR will use CDN):", e.message); process.exit(0); });
