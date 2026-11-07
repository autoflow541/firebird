// Projector renderer. Shows the full-frame look until a clip plays or a projection
// MAPPING is defined. Clips come from the deck (layers x columns) and are composited
// on the GPU by compositor.js; a mapping surface with source "deck" corner-pins that
// composite onto a real surface using the warp math. Master blackout blanks everything.
//
// Coordinate model: the mapping editor stores each surface corner as normalized
// [0..1] in the reference photo's frame. Because the photo is shot from the
// projector's viewpoint, photo space == projector output space, so we scale by
// the projector's pixel size. Corner order per surface: TL, TR, BL, BR.

const colors = { INTRO: "#ee3659", HEAVY: "#f04a31", BREAKDOWN: "#856cff", AMBIENT: "#4ed6cc", BLACKOUT: "#000" };
let mapping = { surfaces: [] };
let deck = null;
let lastState = null;

// Shared webcam stream (opened on demand when a webcam surface is first used).
let webcamStream = null;
async function ensureWebcam() {
  if (webcamStream) return webcamStream;
  try { webcamStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
  catch (error) { console.error("[projector] webcam unavailable:", error.message); }
  return webcamStream;
}

// GPU compositor for the clip deck. null if WebGL2 is unavailable (the rest of the
// projector keeps working without it).
const deckCanvas = document.querySelector("#deck");
const compositor = window.FirebirdCompositor ? window.FirebirdCompositor.create(deckCanvas, { width: 1280, height: 720 }) : null;
let mirrors = []; // 2D canvases for mapping surfaces whose source is "deck"

function sizeCompositor() {
  if (!compositor) return;
  // Render at the window's pixel size, capped at 1080p so a 4K projector stays smooth.
  const k = Math.min(1, 1920 / Math.max(1, window.innerWidth), 1080 / Math.max(1, window.innerHeight));
  compositor.resize(window.innerWidth * k, window.innerHeight * k);
}

function deckVisible() {
  const hasDeckSurface = mapping.surfaces.some((s) => s.source === "deck");
  // keep drawing while a clip is still fading out after a stop
  const playing = (deck && window.FirebirdClips.anyActive(deck)) || (compositor && compositor.isBusy());
  return { full: !!(playing && !mapping.surfaces.length), surfaces: hasDeckSurface };
}

function syncOutput() {
  const v = deckVisible();
  deckCanvas.style.display = v.full ? "block" : "none";
  const stage = document.querySelector("#stage");
  // The Firebird logo look shows only when nothing else is drawing.
  if (stage) stage.style.display = (mapping.surfaces.length || v.full) ? "none" : "grid";
  // Compositor only needs to run while something consumes it.
  if (compositor) {
    if (v.full || (v.surfaces && mirrors.length)) compositor.start(); else compositor.stop();
  }
}

function renderState(state) {
  lastState = state;
  document.body.classList.toggle("blackout", state.blackout);
  const stage = document.querySelector("#stage");
  stage.style.color = colors[state.scene] || "#fff";
  document.querySelector("#title").textContent = state.scene === "INTRO" ? "FIREBIRD" : state.scene;
  if (compositor) {
    compositor.setBlackout(state.blackout);
    compositor.setMaster(state.master / 100);
    compositor.setClock(state.bpm, state.beat);
  }
  syncOutput();
}

function renderMapping() {
  const map = document.querySelector("#map");
  if (!map || !window.FirebirdWarp) return;
  map.innerHTML = "";
  mirrors = [];
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
    if (source === "deck" && compositor) {
      // One GL canvas can't live in several places, so each deck surface gets a 2D
      // canvas that copies the composite every frame (see onFrame below).
      const c = document.createElement("canvas");
      c.width = 960; c.height = 540;
      el.appendChild(c);
      mirrors.push({ canvas: c, ctx: c.getContext("2d") });
    }
    const px = surface.corners.map((c) => ({ x: c.x * W, y: c.y * H })); // normalized -> px
    el.style.transform = window.FirebirdWarp.matrix3dFor(W, H, px);
    map.appendChild(el);
  }
  syncOutput();
}

if (compositor) {
  let wasBusy = false;
  compositor.onFrame((glCanvas) => {
    // Called right after the draw, in the same task, so the drawing buffer is valid.
    for (const m of mirrors) m.ctx.drawImage(glCanvas, 0, 0, m.canvas.width, m.canvas.height);
    // A fade-out finished (or a fade-in began): re-evaluate what to show / run.
    const b = compositor.isBusy();
    if (b !== wasBusy) { wasBusy = b; syncOutput(); }
  });
  sizeCompositor();
  compositor.warm();
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
if (window.showControl.onDeck) {
  window.showControl.onDeck((next) => {
    deck = next;
    if (compositor) compositor.setDeck(deck);
    syncOutput();
  });
}
if (window.showControl.onAudio) window.showControl.onAudio((f) => compositor && compositor.setAudio(f));
window.addEventListener("resize", () => { sizeCompositor(); renderMapping(); });
