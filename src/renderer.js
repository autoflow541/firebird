const command = (action, value, extra = {}) => window.showControl.command({ action, value, ...extra });
let state;
let taps = [];

const formatTime = (seconds) => {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
};

function render(next) {
  state = next;
  document.querySelector("#sceneTitle").textContent = next.blackout ? "BLACKOUT" : next.scene;
  document.querySelector("#blackout").classList.toggle("active", next.blackout);
  document.querySelector("#play").textContent = next.playing ? "Ⅱ" : "▶";
  document.querySelector("#elapsed").textContent = formatTime(next.elapsed);
  document.querySelector("#bpm").value = next.bpm;
  document.querySelector("#master").value = next.master;
  document.querySelector("#blaizeStatus").textContent = next.blaize.connected ? "BLAIZE ONLINE" : "BLAIZE OFFLINE · START SKETCH";
  document.querySelector("#blaizeStatus").classList.toggle("online", next.blaize.connected);
  document.querySelector("#abletonStatus").textContent = next.ableton.connected ? `ABLETON ONLINE · ${next.ableton.host}` : "WAITING FOR OSC";
  document.querySelector("#abletonStatus").classList.toggle("online", next.ableton.connected);
  document.querySelector("#abletonTop").textContent = next.ableton.connected ? "LIVE" : "WAITING";
  document.querySelector("#abletonTop").style.color = next.ableton.connected ? "var(--green)" : "var(--amber)";
  document.querySelector("#abletonClock").textContent = `${next.bpm} BPM · BEAT ${next.beat}`;
  const lk = next.ableton.link;
  document.querySelector("#abletonLink").textContent = lk && lk.enabled ? `${lk.peers} peer${lk.peers === 1 ? "" : "s"} · ${lk.bpm} BPM` : (lk && lk.error ? "not installed" : "off");
  document.querySelector("#abletonMessage").textContent = next.ableton.lastMessage;
  document.querySelector("#visualPreset").value = next.blaize.preset;
  document.querySelector("#visualPresetValue").textContent = String(next.blaize.preset).padStart(2, "0");
  document.querySelectorAll("[data-visual]").forEach((input) => {
    input.value = next.blaize[input.dataset.visual];
    input.nextElementSibling.textContent = `${input.value}%`;
  });
  document.querySelector("#multicolor").classList.toggle("active", next.blaize.multicolor);
  const total = (next.cues[next.cues.length - 1] && next.cues[next.cues.length - 1].time) || 104;
  document.querySelector("#playhead").style.left = `${Math.min(100, next.elapsed / total * 100)}%`;
  document.querySelector("#showName").textContent = next.song;
  renderTimeline(next.cues, total);
  document.querySelectorAll("[data-scene]").forEach((button) => button.classList.toggle("active", button.dataset.scene === next.scene));
  document.querySelectorAll("#beats i").forEach((beat, index) => beat.classList.toggle("on", index + 1 === next.beat && next.playing));
  document.querySelectorAll(".cue").forEach((cue, index) => cue.classList.toggle("current", index === next.cueIndex));
  document.querySelector("#fixtureGrid").innerHTML = next.fixtures.map((fixture) => `
    <div class="fixture-card ${fixture.locked ? "locked" : ""}">
      <span class="swatch" style="color:${fixture.color};background:${fixture.color}"></span>
      <div><b>${fixture.name}</b><small>${fixture.type} · ${fixture.level}%</small></div>
      ${fixture.locked ? "" : `<input data-fixture="${fixture.id}" type="range" min="0" max="100" value="${fixture.level}">`}
    </div>`).join("");
  renderLaser(next.laser);
}

function renderLaser(laser) {
  if (!laser) return;
  // Most people don't have a laser — hide the whole panel unless it's enabled.
  // Laser is a tab; show its tab only when enabled (most rigs have no laser).
  const tab = document.querySelector("#laserTab");
  if (tab) tab.hidden = !laser.enabled;
  if (!laser.enabled) return;
  const stateEl = document.querySelector("#laserState");
  const interlockOk = laser.interlock || !laser.requireInterlock;
  const armReady = laser.enabled && interlockOk && laser.output !== "none" && !state.blackout;
  stateEl.textContent = laser.armed ? "ARMED" : "SAFE HOLD";
  stateEl.className = "laser-state" + (laser.armed ? " armed" : " ready");
  document.querySelector("#laserInterlock").textContent = !laser.requireInterlock ? "KEY (hardware)" : laser.interlock ? "PRESENT" : "ABSENT";
  document.querySelector("#laserOutput").textContent = laser.output.toUpperCase();
  const outSel = document.querySelector("#laserOutputSelect");
  if (outSel && outSel.value !== laser.output) outSel.value = laser.output;
  const arm = document.querySelector("#laserArm");
  arm.textContent = laser.armed ? "DISARM LASER" : "ARM LASER";
  arm.classList.toggle("armed", laser.armed);
  arm.disabled = !laser.armed && !armReady; // can always DISARM; can only ARM when ready
}

// Data-driven timeline + cue list, rebuilt only when the cues change (e.g. after
// loading a show). fmtClock -> MM:SS.
let cuesSig = "";
const fmtClock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;
function renderTimeline(cues, total) {
  const sig = JSON.stringify(cues);
  if (sig === cuesSig) return;
  cuesSig = sig;
  document.querySelector("#ruler").innerHTML = [0, 0.25, 0.5, 0.75, 1].map((f) => `<span>${fmtClock(total * f)}</span>`).join("");
  document.querySelector("#timelineBlocks").innerHTML = cues.map((c, i) => {
    const nextT = cues[i + 1] ? cues[i + 1].time : total;
    const w = Math.max(0, (nextT - c.time) / total * 100);
    return w > 0.1 ? `<div class="block ${c.scene.toLowerCase()}" style="width:${w}%">${c.scene}</div>` : "";
  }).join("");
  document.querySelector("#cueList").innerHTML = cues.map((c) => `<div class="cue"><b>${fmtClock(c.time)}</b><small>${c.note || c.scene}</small></div>`).join("");
}

document.querySelector("#showSave").onclick = async () => { await window.showControl.saveShow(); };
document.querySelector("#showLoad").onclick = async () => { await window.showControl.loadShow(); };

document.querySelector("#scenes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-scene]");
  if (button) command("scene", button.dataset.scene);
});
document.querySelector("#blackout").onclick = () => command("blackout", !state.blackout);
document.querySelector("#cueBack").onclick = () => command("stepCue", -1);
document.querySelector("#cueGo").onclick = () => command("stepCue", 1);
document.querySelector("#play").onclick = () => command("togglePlay");
document.querySelector("#projector").onclick = () => window.showControl.openProjector();
document.querySelector("#mapEditor").onclick = () => window.showControl.openMapping();
document.querySelector("#arTrack").onclick = () => window.FirebirdAR && window.FirebirdAR.toggle();
document.querySelector("#arFilter").onclick = () => window.showControl.openArFilter();
document.querySelector("#tabstrip").addEventListener("click", (event) => {
  const button = event.target.closest("[data-tab]");
  if (!button) return;
  document.querySelectorAll("#tabstrip button").forEach((b) => b.classList.toggle("active", b === button));
  document.querySelectorAll(".tabpanel").forEach((p) => p.classList.toggle("active", p.dataset.tab === button.dataset.tab));
});

// FOH keyboard shortcuts: 1–5 = scenes (matches the tile numbers), ←/→ = cue
// back/next. (Space = engage blackout, handled above.) Ignored while typing.
const SCENE_KEYS = { "1": "INTRO", "2": "HEAVY", "3": "BREAKDOWN", "4": "AMBIENT", "5": "BLACKOUT" };
window.addEventListener("keydown", (event) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName) || event.metaKey || event.ctrlKey || event.altKey) return;
  if (SCENE_KEYS[event.key]) { event.preventDefault(); command("scene", SCENE_KEYS[event.key]); }
  else if (event.key === "ArrowLeft") { event.preventDefault(); command("stepCue", -1); }
  else if (event.key === "ArrowRight") { event.preventDefault(); command("stepCue", 1); }
});
document.querySelector("#bpm").onchange = (event) => command("bpm", event.target.value);
document.querySelector("#master").oninput = (event) => command("master", event.target.value);
document.querySelector("#visualPreset").oninput = (event) => window.showControl.command({ action: "visual", key: "preset", value: event.target.value });
document.querySelectorAll("[data-visual]").forEach((input) => input.oninput = (event) => window.showControl.command({ action: "visual", key: event.target.dataset.visual, value: event.target.value }));
document.querySelector("#multicolor").onclick = () => window.showControl.command({ action: "visual", key: "multicolor", value: !state.blaize.multicolor });
document.querySelector("#fixtureGrid").oninput = (event) => {
  if (event.target.dataset.fixture) command("fixture", { level: Number(event.target.value) }, { id: event.target.dataset.fixture });
};
document.querySelector("#timeline").onclick = (event) => command("seek", event.offsetX / event.currentTarget.clientWidth * 104);
document.querySelector("#laserOutputSelect").addEventListener("change", (event) => {
  window.showControl.command({ action: "laser", key: "output", value: event.target.value });
});
document.querySelector("#laserArm").onclick = () => window.showControl.command({ action: "laser", key: "arm", value: !(state.laser && state.laser.armed) });

// --- Streaming / OBS ---
function renderObs(s) {
  const el = document.querySelector("#obsState");
  el.textContent = !s.connected ? (s.error || "OBS OFFLINE") : s.streaming ? "● LIVE" : s.recording ? "● RECORDING" : "OBS ONLINE";
  el.className = "obs-state" + (s.streaming ? " live" : s.connected ? " ready" : "");
  const stream = document.querySelector("#obsStream");
  stream.textContent = s.streaming ? "■ STOP LIVE" : "● GO LIVE";
  stream.classList.toggle("active", s.streaming);
  const rec = document.querySelector("#obsRecord");
  rec.textContent = s.recording ? "■ STOP REC" : "● RECORD";
  rec.classList.toggle("active", s.recording);
  const tab = document.querySelector('#tabstrip [data-tab="stream"]');
  if (tab) tab.classList.toggle("live", s.streaming || s.recording);
}
document.querySelector("#obsConnect").onclick = () => window.showControl.obs({ op: "connect" });
document.querySelector("#obsStream").onclick = () => window.showControl.obs({ op: "toggleStream" });
document.querySelector("#obsRecord").onclick = () => window.showControl.obs({ op: "toggleRecord" });
document.querySelector("#capture").onclick = async () => {
  const file = await window.showControl.capture();
  const btn = document.querySelector("#capture");
  btn.textContent = file ? "SAVED ✓" : "CAPTURE FAILED";
  setTimeout(() => (btn.textContent = "CAPTURE PNG"), 1800);
};
window.showControl.onObsStatus(renderObs);
window.showControl.getObsStatus().then(renderObs);
window.showControl.getStreamUrl().then((url) => (document.querySelector("#streamUrl").textContent = url));
document.querySelector("#tap").onclick = () => {
  const now = performance.now();
  taps = [...taps.filter((tap) => now - tap < 3000), now].slice(-5);
  if (taps.length > 1) {
    const gaps = taps.slice(1).map((tap, index) => tap - taps[index]);
    command("bpm", Math.round(60000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)));
  }
};
window.addEventListener("keydown", (event) => {
  // Spacebar is an ENGAGE-only panic: it can slam blackout on but never release
  // it. Releasing is a deliberate click on the blackout button. This prevents a
  // stray keypress from un-blacking a dark stage.
  if (event.code === "Space" && !["INPUT", "BUTTON"].includes(event.target.tagName)) {
    event.preventDefault();
    command("blackout", true);
  }
});
setInterval(() => document.querySelector("#clock").textContent = new Date().toLocaleTimeString("en-US", { hour12: false }), 1000);
window.showControl.onState(render);
window.showControl.onRemoteAddress((address) => document.querySelector("#remoteAddress").textContent = address);
window.showControl.getState().then(render);
