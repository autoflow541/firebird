// Projector renderer. Shows the full-frame look until a projection MAPPING is
// defined; then it corner-pins each mapped surface onto its real-world quad using
// the warp math. Master blackout blanks everything.
//
// Coordinate model: the mapping editor stores each surface corner as normalized
// [0..1] in the reference photo's frame. Because the photo is shot from the
// projector's viewpoint, photo space == projector output space, so we scale by
// the projector's pixel size. Corner order per surface: TL, TR, BL, BR.

const colors = { INTRO: "#ee3659", HEAVY: "#f04a31", BREAKDOWN: "#856cff", AMBIENT: "#4ed6cc", BLACKOUT: "#000" };
let mapping = { surfaces: [] };

// Shared webcam stream (opened on demand when a webcam surface is first used).
let webcamStream = null;
async function ensureWebcam() {
  if (webcamStream) return webcamStream;
  try { webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
  catch (error) { console.error("[projector] webcam unavailable:", error.message); }
  return webcamStream;
}

function renderState(state) {
  document.body.classList.toggle("blackout", state.blackout);
  const stage = document.querySelector("#stage");
  stage.style.color = colors[state.scene] || "#fff";
  document.querySelector("#title").textContent = state.scene === "INTRO" ? "FIREBIRD" : state.scene;
  stage.style.display = mapping.surfaces.length ? "none" : "grid";
}

function renderMapping() {
  const map = document.querySelector("#map");
  if (!map || !window.FirebirdWarp) return;
  map.innerHTML = "";
  const W = window.innerWidth, H = window.innerHeight;
  for (const surface of mapping.surfaces) {
    if (!surface.corners || surface.corners.length !== 4) continue;
    const el = document.createElement("div");
    el.className = "surface " + (surface.source || "solid");
    el.style.width = W + "px";
    el.style.height = H + "px";
    el.style.opacity = surface.opacity == null ? 1 : surface.opacity;
    const source = surface.source || "solid";
    if (source === "solid") el.style.background = surface.color || "#ffffff";
    if (source === "webcam") {
      const v = document.createElement("video");
      v.autoplay = true; v.muted = true; v.playsInline = true;
      v.style.width = "100%"; v.style.height = "100%"; v.style.objectFit = "cover"; v.style.display = "block";
      el.appendChild(v);
      ensureWebcam().then((s) => { if (s) v.srcObject = s; });
    }
    const px = surface.corners.map((c) => ({ x: c.x * W, y: c.y * H })); // normalized -> px
    el.style.transform = window.FirebirdWarp.matrix3dFor(W, H, px);
    map.appendChild(el);
  }
  const stage = document.querySelector("#stage");
  if (stage) stage.style.display = mapping.surfaces.length ? "none" : "grid";
}

window.showControl.onState(renderState);
// Mapping arrives from the operator/editor via the main process (forward-compatible;
// projector works with no mapping = full-frame look).
if (window.showControl.onMapping) {
  window.showControl.onMapping((next) => {
    mapping = next && Array.isArray(next.surfaces) ? next : { surfaces: [] };
    renderMapping();
  });
}
window.addEventListener("resize", renderMapping);
