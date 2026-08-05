// Projection-mapping editor. Load a photo shot from the projector's viewpoint,
// draw 4-corner surfaces over the real surfaces in it, assign a source, Save.
// Corners are stored NORMALISED (0..1) in order TL, TR, BL, BR — the projector
// scales them to its own resolution and corner-pins each source into the quad.
//
// Works two ways: inside Firebird (Electron, via window.showControl IPC) or from
// a phone (served over HTTP, token from the page URL).

const TOKEN = new URLSearchParams(location.search).get("t") || "";
const IPC = window.showControl && window.showControl.setMapping ? window.showControl : null;

const stage = document.querySelector("#stage");
const svg = document.querySelector("#svg");
const img = document.querySelector("#img");
const statusEl = document.querySelector("#status");
svg.setAttribute("viewBox", "0 0 1 1");
svg.setAttribute("preserveAspectRatio", "none");

let surfaces = [];
let selected = -1;
let drag = null; // { s, c }

function defaultSurface() {
  return {
    source: "solid", color: "#D4A017", opacity: 1,
    corners: [{ x: 0.35, y: 0.35 }, { x: 0.65, y: 0.35 }, { x: 0.35, y: 0.65 }, { x: 0.65, y: 0.65 }]
  };
}

function setStatus(t) { statusEl.textContent = t; }

function render() {
  // Polygons (order TL,TR,BR,BL for a non-crossing outline = indices 0,1,3,2).
  svg.innerHTML = surfaces.map((s, i) => {
    const p = [s.corners[0], s.corners[1], s.corners[3], s.corners[2]].map((c) => `${c.x},${c.y}`).join(" ");
    const stroke = i === selected ? "#D4A017" : "#7A5E00";
    const fill = s.source === "solid" ? s.color : "none";
    const fo = (0.35 * (s.opacity == null ? 1 : s.opacity)).toFixed(2);
    return `<polygon points="${p}" fill="${fill}" fill-opacity="${fo}" stroke="${stroke}" stroke-width="0.004" data-i="${i}" style="pointer-events:auto;cursor:pointer"></polygon>`;
  }).join("");
  // Handles for the selected surface only.
  [...stage.querySelectorAll(".handle")].forEach((h) => h.remove());
  if (surfaces[selected]) {
    surfaces[selected].corners.forEach((c, ci) => {
      const h = document.createElement("div");
      h.className = "handle";
      h.style.left = c.x * 100 + "%";
      h.style.top = c.y * 100 + "%";
      h.dataset.c = ci;
      stage.appendChild(h);
    });
  }
  const sel = surfaces[selected];
  document.querySelector("#source").value = sel ? sel.source : "solid";
  document.querySelector("#color").value = sel ? sel.color : "#D4A017";
  document.querySelector("#opacity").value = Math.round((sel ? (sel.opacity == null ? 1 : sel.opacity) : 1) * 100);
  document.querySelector("#track").checked = !!(sel && sel.track);
}

function pointToNorm(ev) {
  const r = img.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height))
  };
}

stage.addEventListener("pointerdown", (ev) => {
  const handle = ev.target.closest(".handle");
  if (handle) { drag = { s: selected, c: Number(handle.dataset.c) }; handle.setPointerCapture?.(ev.pointerId); return; }
  const poly = ev.target.closest("polygon");
  if (poly) { selected = Number(poly.dataset.i); render(); }
});
window.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  surfaces[drag.s].corners[drag.c] = pointToNorm(ev);
  render();
});
window.addEventListener("pointerup", () => (drag = null));

document.querySelector("#photo").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (file) img.src = URL.createObjectURL(file);
});
document.querySelector("#add").onclick = () => { surfaces.push(defaultSurface()); selected = surfaces.length - 1; render(); };
document.querySelector("#del").onclick = () => { if (selected >= 0) { surfaces.splice(selected, 1); selected = surfaces.length - 1; render(); } };
document.querySelector("#source").onchange = (e) => { if (surfaces[selected]) { surfaces[selected].source = e.target.value; render(); } };
document.querySelector("#color").oninput = (e) => { if (surfaces[selected]) { surfaces[selected].color = e.target.value; render(); } };
document.querySelector("#opacity").oninput = (e) => { if (surfaces[selected]) { surfaces[selected].opacity = Number(e.target.value) / 100; render(); } };
document.querySelector("#track").onchange = (e) => { if (surfaces[selected]) { surfaces[selected].track = e.target.checked; } };
document.querySelector("#dup").onclick = () => {
  if (!surfaces[selected]) return;
  const clone = JSON.parse(JSON.stringify(surfaces[selected]));
  clone.corners.forEach((c) => { c.x = Math.min(1, c.x + 0.05); c.y = Math.min(1, c.y + 0.05); });
  surfaces.push(clone); selected = surfaces.length - 1; render();
};
document.querySelector("#preview").onclick = (e) => { stage.classList.toggle("preview"); e.target.classList.toggle("on", stage.classList.contains("preview")); };
// Arrow keys nudge the whole selected surface for fine alignment.
window.addEventListener("keydown", (ev) => {
  if (selected < 0 || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(ev.key)) return;
  if (["INPUT", "SELECT"].includes(ev.target.tagName)) return;
  ev.preventDefault();
  const step = ev.shiftKey ? 0.02 : 0.002;
  const dx = (ev.key === "ArrowRight" ? step : 0) - (ev.key === "ArrowLeft" ? step : 0);
  const dy = (ev.key === "ArrowDown" ? step : 0) - (ev.key === "ArrowUp" ? step : 0);
  surfaces[selected].corners.forEach((c) => { c.x = Math.max(0, Math.min(1, c.x + dx)); c.y = Math.max(0, Math.min(1, c.y + dy)); });
  render();
});

document.querySelector("#save").onclick = async () => {
  const mapping = { surfaces };
  try {
    if (IPC) IPC.setMapping(mapping);
    else await fetch(`/mapping?t=${encodeURIComponent(TOKEN)}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Firebird-Token": TOKEN }, body: JSON.stringify(mapping)
    });
    setStatus(`Saved ${surfaces.length} surface(s) → projector`);
  } catch (e) { setStatus("Save failed: " + e.message); }
};

async function load() {
  try {
    let mapping;
    if (IPC) mapping = await IPC.getMapping();
    else mapping = await (await fetch(`/mapping?t=${encodeURIComponent(TOKEN)}`)).json();
    surfaces = mapping && Array.isArray(mapping.surfaces) ? mapping.surfaces : [];
    selected = surfaces.length ? 0 : -1;
    render();
  } catch { render(); }
}
load();
