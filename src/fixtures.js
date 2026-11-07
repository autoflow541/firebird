// FIXTURES tab: pick the DMX interface (ENTTEC USB Pro / Art-Net), patch the audience
// lights (address, profile), and set how each one reacts to sound and the beat.
//
// Rows update in place so typing an address or dragging a slider is never fought by
// the 4 Hz state broadcast; they are rebuilt only when the patch structure changes.
// Patch edits (address / profile / enabled) are local-operator only (engine.js).

(function () {
  const D = window.FirebirdDMX;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const send = (id, value) => window.showControl.command({ action: "fixture", id, value });

  let sig = "";
  let lastState = null;

  const REACT_LABELS = { none: "Steady", level: "Sound level", bass: "Bass", mid: "Mids", high: "Highs", beat: "Beat pulse", flash: "Flash on beat" };

  function structSig(fixtures) {
    return JSON.stringify(fixtures.map((f) => [f.id, f.profile, f.locked, f.profile === "custom" ? f.map : ""]));
  }

  function rowHtml(f) {
    if (f.locked) {
      return `<div class="fx-card locked" data-id="${f.id}"><span class="swatch" style="background:${f.color};color:${f.color}"></span>
        <div class="fx-name"><b>${esc(f.name)}</b><small>Held safe — controlled from the LASER tab only</small></div></div>`;
    }
    return `<div class="fx-card" data-id="${f.id}">
      <div class="fx-top">
        <input class="fx-nm" data-f="name" value="${esc(f.name)}" aria-label="Fixture name" maxlength="32">
        <label class="chk"><input type="checkbox" data-f="enabled" aria-label="${esc(f.name)} patched"> PATCHED</label>
        <button class="mini" data-act="identify" title="Light this fixture white for 1.5 s so you can find it">IDENTIFY</button>
        <button class="mini" data-act="remove" aria-label="Remove ${esc(f.name)}">✕</button>
      </div>
      <div class="fx-grid">
        <label>PROFILE<select data-f="profile">${Object.entries(D.PROFILES).map(([id, p]) => `<option value="${id}" ${id === f.profile ? "selected" : ""}>${p.label}</option>`).join("")}</select></label>
        <label>DMX ADDRESS<input type="number" min="1" max="512" data-f="addr" placeholder="1–512"></label>
        ${f.profile === "custom" ? `<label class="wide">CHANNEL MAP<input data-f="map" placeholder="dim,r,g,b,f0" aria-label="Custom channel map"><small>dim r g b w · f0–f255 = fixed value · - = off</small></label>` : ""}
        <label>COLOUR<input type="color" data-f="color"></label>
        <label>LEVEL<input type="range" min="0" max="100" data-f="level"><output data-o="level"></output></label>
        <label>REACTS TO<select data-f="react">${D.REACT_MODES.map((m) => `<option value="${m}">${REACT_LABELS[m]}</option>`).join("")}</select></label>
        <label>DEPTH<input type="range" min="0" max="100" data-f="amt"><output data-o="amt"></output></label>
      </div>
    </div>`;
  }

  // push current values into the controls, skipping whichever one the user is touching
  function fillRow(card, f) {
    if (f.locked) return;
    const set = (key, val) => {
      const el = card.querySelector(`[data-f="${key}"]`);
      if (!el || el === document.activeElement) return;
      if (el.type === "checkbox") el.checked = !!val; else el.value = val;
    };
    set("name", f.name); set("enabled", f.enabled); set("addr", f.addr || ""); set("color", f.color);
    set("level", Math.round(f.level)); set("react", f.react); set("amt", Math.round(f.amt * 100)); set("map", f.map);
    card.querySelector('[data-o="level"]').textContent = Math.round(f.level) + "%";
    card.querySelector('[data-o="amt"]').textContent = f.react === "none" ? "—" : Math.round(f.amt * 100) + "%";
    card.classList.toggle("unpatched", !f.enabled);
    const en = card.querySelector('[data-f="enabled"]');
    if (en) en.disabled = !(f.addr >= 1) && !f.enabled; // can't patch until an address is set
  }

  function renderDmxStatus(dmx) {
    const el = $("#dmxStatus");
    if (!el || !dmx) return;
    let text, cls = "bridge-status";
    if (dmx.output === "none") text = "DMX OFF";
    else if (dmx.output === "artnet") { text = "ART-NET · SENDING"; cls += " online"; }
    else if (dmx.connected) { text = `ENTTEC · ${dmx.port}`; cls += " online"; }
    else text = dmx.error ? dmx.error.slice(0, 60) : "ENTTEC · CONNECTING…";
    el.textContent = text; el.className = cls;
    const out = $("#dmxOutput"); if (out && out !== document.activeElement) out.value = dmx.output;
    $("#dmxPortWrap").hidden = dmx.output !== "enttec";
    const fl = $("#dmxFlash"); if (fl && fl !== document.activeElement) fl.checked = !!dmx.flash;
  }

  function render(state) {
    lastState = state;
    const grid = $("#fixtureGrid");
    if (!grid) return;
    const s = structSig(state.fixtures);
    if (s !== sig) { sig = s; grid.innerHTML = state.fixtures.map(rowHtml).join(""); }
    for (const f of state.fixtures) {
      const card = grid.querySelector(`[data-id="${CSS.escape(f.id)}"]`);
      if (card) fillRow(card, f);
    }
    renderDmxStatus(state.dmx);
  }

  async function refreshPorts() {
    try {
      const info = await window.showControl.getDmx();
      const sel = $("#dmxPort");
      const cur = (lastState && lastState.dmx && lastState.dmx.port) || "";
      sel.innerHTML = '<option value="">Auto-detect ENTTEC</option>' + info.ports.map((p) => `<option value="${esc(p.path)}">${esc(p.label)}${p.enttec ? " ✓" : ""}</option>`).join("");
      sel.value = info.ports.some((p) => p.path === cur) ? cur : "";
      renderDmxStatus(info.status);
    } catch {}
  }

  function applyOutput() {
    const output = $("#dmxOutput").value;
    window.showControl.setDmx({ output, port: output === "enttec" ? $("#dmxPort").value : "" }).then(renderDmxStatus);
  }

  window.addEventListener("DOMContentLoaded", () => {
    const grid = $("#fixtureGrid");
    if (!grid || !D) return;

    grid.addEventListener("input", (e) => {
      const t = e.target, card = t.closest("[data-id]");
      if (!card || !t.dataset.f) return;
      const id = card.dataset.id;
      if (t.type === "range") {
        const v = Number(t.value);
        send(id, t.dataset.f === "amt" ? { amt: v / 100 } : { level: v });
        t.nextElementSibling.textContent = v + "%";
      } else if (t.type === "color") send(id, { color: t.value });
      else if (t.dataset.f === "name") send(id, { name: t.value });
      else if (t.dataset.f === "map") send(id, { map: t.value });
    });
    grid.addEventListener("change", (e) => {
      const t = e.target, card = t.closest("[data-id]");
      if (!card || !t.dataset.f) return;
      const id = card.dataset.id, k = t.dataset.f;
      if (k === "enabled") send(id, { enabled: t.checked });
      else if (k === "addr") send(id, { addr: Number(t.value), enabled: Number(t.value) >= 1 }); // typing an address patches it
      else if (k === "profile") send(id, { profile: t.value });
      else if (k === "react") send(id, { react: t.value });
    });
    grid.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (!b) return;
      const id = b.closest("[data-id]").dataset.id;
      if (b.dataset.act === "identify") window.showControl.identifyFixture(id);
      else if (b.dataset.act === "remove") window.showControl.command({ action: "fixtureRemove", id });
    });

    $("#fxAddFixture").onclick = () => window.showControl.command({ action: "fixtureAdd" });
    $("#dmxOutput").onchange = applyOutput;
    $("#dmxPort").onchange = applyOutput;
    $("#dmxRefresh").onclick = refreshPorts;
    $("#dmxFlash").onchange = (e) => window.showControl.command({ action: "lights", key: "flash", value: e.target.checked });
    window.showControl.onState(render);
    window.showControl.getState().then((s) => { render(s); refreshPorts(); });
  });
})();
