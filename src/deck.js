// CLIPS tab (operator window): the Resolume-style grid. Click a clip to trigger it
// and select it for editing; the column buttons fire a whole column; each layer row
// has opacity / blend / bypass / stop. A live preview runs the SAME compositor the
// projector uses, so what you see here is the real render path.
//
// The operator holds its own copy of the deck and applies each op locally AND sends
// it to the main process (which pushes to the projector). Main does not echo local
// ops back, so dragging a slider is never fought by a stale update. Ops that come
// from OSC / the phone remote are echoed via onDeck.

(function () {
  const C = window.FirebirdClips;
  const S = window.FirebirdShaders;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let deck = null;
  let sel = { l: 0, c: 0 };
  let preview = null;

  // ---- ops -----------------------------------------------------------------
  function op(o) {
    if (!deck) return;
    C.applyOp(deck, { ...o, shaderIds: S.ids }, { trusted: true });
    window.showControl.deckOp(o);
  }
  let pendingClipOp = null;
  function editClip(patch) {
    const clip = deck.layers[sel.l] && deck.layers[sel.l].clips[sel.c];
    if (!clip) return;
    const next = { ...clip, ...patch };
    deck.layers[sel.l].clips[sel.c] = C.normalizeClip(next, S.ids);
    // coalesce slider drags to one IPC per frame
    pendingClipOp = { op: "clip", layer: sel.l, col: sel.c, clip: next };
    requestAnimationFrame(() => { if (pendingClipOp) { window.showControl.deckOp(pendingClipOp); pendingClipOp = null; } });
    renderGrid();
  }

  // ---- grid ----------------------------------------------------------------
  function clipLabel(clip) {
    if (!clip) return "";
    if (clip.type === "shader") return (S.LIST.find((s) => s.id === clip.shader) || { name: clip.shader }).name;
    if (clip.type === "solid") return "Solid";
    if (clip.type === "glsl") return "GLSL";
    if (clip.type === "webcam") return "Webcam";
    return clip.name || clip.src.split("/").pop() || clip.type;
  }

  function renderGrid() {
    const grid = $("#deckGrid");
    if (!grid || !deck) return;
    const cols = deck.columns;
    grid.style.gridTemplateColumns = `190px repeat(${cols}, minmax(84px, 1fr))`;
    let html = `<div class="dk-corner"></div>`;
    for (let c = 0; c < cols; c++) html += `<button class="colbtn" data-col="${c}" aria-label="Trigger column ${c + 1}">▶ ${c + 1}</button>`;
    // top layer first (like Resolume); data-l keeps the real index (0 = bottom)
    for (let l = deck.layers.length - 1; l >= 0; l--) {
      const L = deck.layers[l];
      html += `<div class="layerctl ${L.bypass ? "bypassed" : ""}">
        <input class="lname" data-l="${l}" data-k="name" value="${esc(L.name)}" aria-label="Layer ${l + 1} name" maxlength="24">
        <div class="lrow">
          <input type="range" min="0" max="100" value="${Math.round(L.opacity * 100)}" data-l="${l}" data-k="opacity" aria-label="Layer ${l + 1} opacity">
          <select data-l="${l}" data-k="blend" aria-label="Layer ${l + 1} blend mode">${C.BLEND_MODES.map((m) => `<option ${m === L.blend ? "selected" : ""}>${m}</option>`).join("")}</select>
        </div>
        <label class="lrow fade">FADE <input type="range" min="0" max="50" value="${Math.round(L.fade * 10)}" data-l="${l}" data-k="fade" aria-label="Layer ${l + 1} crossfade time"><output>${L.fade.toFixed(1)}s</output></label>
        <div class="lrow">
          <button class="mini ${L.bypass ? "on" : ""}" data-l="${l}" data-act="bypass" aria-pressed="${L.bypass}" title="Bypass layer">BYPASS</button>
          <button class="mini" data-l="${l}" data-act="stop" title="Stop this layer">■ STOP</button>
        </div>
      </div>`;
      for (let c = 0; c < cols; c++) {
        const clip = L.clips[c];
        const on = L.active === c;
        const selected = sel.l === l && sel.c === c;
        const label = clipLabel(clip);
        html += `<button class="clip ${clip ? "" : "empty"} ${on ? "on" : ""} ${selected ? "sel" : ""}" data-l="${l}" data-c="${c}" aria-pressed="${on}"
          aria-label="Layer ${l + 1} column ${c + 1}: ${clip ? esc(label) + (on ? ", playing" : "") : "empty"}">
          ${clip ? `<span class="ctype">${esc(clip.type)}</span><b>${esc(label)}</b>${clip.type === "solid" ? `<i class="swatch" style="background:${clip.color}"></i>` : ""}` : `<span class="plus">+</span>`}
        </button>`;
      }
    }
    grid.innerHTML = html;
    renderInspector();
    renderFx();
  }

  // ---- inspector -----------------------------------------------------------
  function slider(label, key, min, max, step, value, fmt) {
    return `<label class="insp-row">${label}<input type="range" data-ik="${key}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${fmt(value)}</output></label>`;
  }
  function renderInspector() {
    const host = $("#deckInspector");
    if (!host || !deck) return;
    const L = deck.layers[sel.l];
    const clip = L && L.clips[sel.c];
    const title = `<div class="insp-title">LAYER ${sel.l + 1} · COLUMN ${sel.c + 1}</div>`;
    if (!clip) {
      host.innerHTML = title + `<button id="inspNew" class="soft">+ NEW CLIP</button>`;
      return;
    }
    const mediaType = clip.type === "image" || clip.type === "video";
    host.innerHTML = title + `
      <label class="insp-row">SOURCE
        <select data-ik="type">${C.SOURCE_TYPES.map((t) => `<option ${t === clip.type ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      ${clip.type === "shader" ? `<label class="insp-row">GENERATOR
        <select data-ik="shader">${S.LIST.map((s) => `<option value="${s.id}" ${s.id === clip.shader ? "selected" : ""}>${s.name}</option>`).join("")}</select></label>` : ""}
      ${clip.type === "glsl" ? `<textarea id="inspCode" class="glsl-code" spellcheck="false" aria-label="GLSL generator code">${esc(clip.code)}</textarea>
        <div id="inspCodeStatus" class="glsl-status" role="status"></div>` : ""}
      ${clip.type === "solid" ? `<label class="insp-row">COLOUR <input type="color" data-ik="color" value="${clip.color}"></label>` : ""}
      ${mediaType ? `<label class="insp-row">FILE <input id="inspFile" type="file" accept="${clip.type === "image" ? "image/*" : "video/*"}"></label>
        <div class="insp-path">${clip.src ? esc(decodeURI(clip.src.split("/").pop())) : "no file chosen"}</div>` : ""}
      ${clip.type === "video" ? `<label class="insp-row chk"><input type="checkbox" data-ik="loop" ${clip.loop ? "checked" : ""}> LOOP</label>` : ""}
      ${slider("SPEED", "speed", 0, 4, 0.05, clip.speed, (v) => (+v).toFixed(2) + "×")}
      ${slider("SCALE", "scale", 0.1, 8, 0.05, clip.scale, (v) => (+v).toFixed(2) + "×")}
      ${slider("HUE", "hue", 0, 1, 0.01, clip.hue, (v) => Math.round(v * 360) + "°")}
      ${slider("INTENSITY", "amount", 0, 1, 0.01, clip.amount, (v) => Math.round(v * 100) + "%")}
      ${clip.type === "shader" || clip.type === "glsl" ? slider("AUDIO REACT", "audio", 0, 1, 0.01, clip.audio, (v) => Math.round(v * 100) + "%") : ""}
      <button id="inspClear" class="soft">CLEAR CLIP</button>`;
  }

  function fileUrl(p) {
    return encodeURI("file:///" + String(p).replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F");
  }

  // ---- layer FX ------------------------------------------------------------
  function checkCode(code) {
    const el = $("#inspCodeStatus");
    if (!el) return;
    if (!preview) { el.textContent = ""; return; }
    const err = preview.checkGlsl(code);
    el.textContent = err ? err.replace(/\0/g, "").split("\n").filter((l) => l.trim()).slice(0, 3).join("\n") : "✓ compiled";
    el.classList.toggle("bad", !!err);
  }

  function renderFx() {
    const host = $("#deckFx");
    if (!host || !deck) return;
    const L = deck.layers[sel.l];
    if (!L) { host.innerHTML = ""; return; }
    const rows = L.fx.map((fx, i) => {
      const def = C.EFFECTS[fx.type];
      return `<div class="fx ${fx.on ? "" : "off"}">
        <div class="fx-head">
          <label class="chk"><input type="checkbox" data-fi="${i}" data-fk="on" ${fx.on ? "checked" : ""} aria-label="Enable effect ${i + 1}"></label>
          <select data-fi="${i}" data-fk="type" aria-label="Effect ${i + 1} type">${C.FX_TYPES.map((t) => `<option value="${t}" ${t === fx.type ? "selected" : ""}>${C.EFFECTS[t].label}</option>`).join("")}</select>
          <button class="mini" data-fdel="${i}" aria-label="Remove effect ${i + 1}">✕</button>
        </div>
        ${def.params.map((pr, pi) => `<label class="insp-row">${pr[0].toUpperCase()}<input type="range" min="0" max="1" step="0.01" value="${fx.p[pi]}" data-fi="${i}" data-pi="${pi}"><output>${Math.round(fx.p[pi] * 100)}%</output></label>`).join("")}
        <label class="insp-row">MODULATE<select data-fi="${i}" data-fk="mod" aria-label="Effect ${i + 1} modulation source">${C.FX_MODS.map((m) => `<option ${m === fx.mod ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        ${fx.mod !== "none" ? `<label class="insp-row">DEPTH<input type="range" min="0" max="1" step="0.01" value="${fx.amt}" data-fi="${i}" data-fk="amt"><output>${Math.round(fx.amt * 100)}%</output></label>` : ""}
      </div>`;
    }).join("");
    host.innerHTML = `<div class="insp-title">LAYER ${sel.l + 1} FX · ${esc(L.name)}</div>${rows || '<div class="insp-path">no effects — add one</div>'}
      ${L.fx.length < C.MAX_FX ? `<select id="fxAdd" aria-label="Add effect"><option value="">+ ADD EFFECT…</option>${C.FX_TYPES.map((t) => `<option value="${t}">${C.EFFECTS[t].label}</option>`).join("")}</select>` : ""}`;
  }

  function fxEdit(index, mutate) {
    const L = deck.layers[sel.l];
    const next = JSON.parse(JSON.stringify(L.fx[index]));
    mutate(next);
    op({ op: "fx", layer: sel.l, index, effect: next });
  }

  // ---- events --------------------------------------------------------------
  function wire() {
    const grid = $("#deckGrid");

    grid.addEventListener("click", (e) => {
      const col = e.target.closest(".colbtn");
      if (col) return op({ op: "column", col: Number(col.dataset.col) }), renderGrid();
      const act = e.target.closest("[data-act]");
      if (act) {
        const l = Number(act.dataset.l);
        if (act.dataset.act === "stop") op({ op: "stop", layer: l });
        else op({ op: "layer", layer: l, patch: { bypass: !deck.layers[l].bypass } });
        return renderGrid();
      }
      const clipBtn = e.target.closest(".clip");
      if (clipBtn) {
        sel = { l: Number(clipBtn.dataset.l), c: Number(clipBtn.dataset.c) };
        if (deck.layers[sel.l].clips[sel.c]) op({ op: "trigger", layer: sel.l, col: sel.c });
        renderGrid();
      }
    });

    // Layer name / opacity / blend. Re-render only for blend+name commit, not mid-drag.
    grid.addEventListener("input", (e) => {
      const t = e.target;
      if (t.dataset.k === "fade") { const v = Number(t.value) / 10; op({ op: "layer", layer: Number(t.dataset.l), patch: { fade: v } }); t.nextElementSibling.textContent = v.toFixed(1) + "s"; }
      else if (t.dataset.k === "opacity") op({ op: "layer", layer: Number(t.dataset.l), patch: { opacity: Number(t.value) / 100 } });
      else if (t.dataset.k === "name") op({ op: "layer", layer: Number(t.dataset.l), patch: { name: t.value } });
    });
    grid.addEventListener("change", (e) => {
      const t = e.target;
      if (t.dataset.k === "blend") { op({ op: "layer", layer: Number(t.dataset.l), patch: { blend: t.value } }); renderGrid(); }
    });

    const insp = $("#deckInspector");
    insp.addEventListener("click", (e) => {
      if (e.target.id === "inspNew") {
        op({ op: "clip", layer: sel.l, col: sel.c, clip: C.defaultClip() });
        renderGrid();
      } else if (e.target.id === "inspClear") {
        op({ op: "clip", layer: sel.l, col: sel.c, clip: null });
        renderGrid();
      }
    });
    let codeTimer;
    insp.addEventListener("input", (e) => {
      if (e.target.id === "inspCode") {
        clearTimeout(codeTimer);
        codeTimer = setTimeout(() => { editClip({ code: e.target.value }); checkCode(e.target.value); }, 250);
        return;
      }
      const k = e.target.dataset.ik;
      if (!k) return;
      if (e.target.type === "range") {
        editClip({ [k]: Number(e.target.value) });
        // keep the readout live without rebuilding the control mid-drag
        const out = e.target.nextElementSibling;
        if (out) {
          const v = Number(e.target.value);
          out.textContent = k === "hue" ? Math.round(v * 360) + "°" : (k === "amount" || k === "audio") ? Math.round(v * 100) + "%" : v.toFixed(2) + "×";
        }
      } else if (e.target.type === "color") {
        editClip({ color: e.target.value });
      }
    });
    insp.addEventListener("change", (e) => {
      const k = e.target.dataset.ik;
      if (e.target.id === "inspFile") {
        const file = e.target.files[0];
        if (!file) return;
        let p = "";
        try { p = window.showControl.pathForFile(file); } catch {}
        if (!p) return;
        editClip({ src: fileUrl(p), name: file.name });
        return;
      }
      if (!k) return;
      if (e.target.type === "checkbox") editClip({ [k]: e.target.checked });
      else if (e.target.tagName === "SELECT") { editClip({ [k]: e.target.value }); renderInspector(); }
    });

    const fxHost = $("#deckFx");
    fxHost.addEventListener("input", (e) => {
      const t = e.target, i = Number(t.dataset.fi);
      if (t.dataset.pi !== undefined) {
        fxEdit(i, (fx) => { fx.p[Number(t.dataset.pi)] = Number(t.value); });
        t.nextElementSibling.textContent = Math.round(Number(t.value) * 100) + "%";
      } else if (t.dataset.fk === "amt") {
        fxEdit(i, (fx) => { fx.amt = Number(t.value); });
        t.nextElementSibling.textContent = Math.round(Number(t.value) * 100) + "%";
      }
    });
    fxHost.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "fxAdd") {
        if (t.value) { op({ op: "fx", layer: sel.l, index: deck.layers[sel.l].fx.length, effect: C.defaultEffect(t.value) }); renderFx(); }
        return;
      }
      const i = Number(t.dataset.fi);
      if (Number.isNaN(i)) return;
      if (t.dataset.fk === "on") fxEdit(i, (fx) => { fx.on = t.checked; });
      else if (t.dataset.fk === "type") op({ op: "fx", layer: sel.l, index: i, effect: C.defaultEffect(t.value) });
      else if (t.dataset.fk === "mod") fxEdit(i, (fx) => { fx.mod = t.value; });
      renderFx();
    });
    fxHost.addEventListener("click", (e) => {
      const del = e.target.closest("[data-fdel]");
      if (del) { op({ op: "fx", layer: sel.l, index: Number(del.dataset.fdel), effect: null }); renderFx(); }
    });

    $("#deckStopAll").onclick = () => { op({ op: "stopAll" }); renderGrid(); };

    // Q W E R T Y U I fire columns 1–8 while the CLIPS tab is open.
    const KEYS = "qwertyui";
    window.addEventListener("keydown", (e) => {
      if (!$('.tabpanel.active[data-tab="clips"]')) return;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      const i = KEYS.indexOf(e.key.toLowerCase());
      if (i >= 0 && i < deck.columns) { op({ op: "column", col: i }); renderGrid(); }
    });
  }

  // ---- preview -------------------------------------------------------------
  function startPreview() {
    if (preview) return preview.start();
    const canvas = $("#deckPreview");
    preview = window.FirebirdCompositor ? window.FirebirdCompositor.create(canvas, { width: 320, height: 180 }) : null;
    const gpu = $("#deckGpu");
    if (!preview) { if (gpu) { gpu.textContent = "WEBGL2 UNAVAILABLE"; gpu.classList.remove("online"); } return; }
    const errors = preview.warm();
    if (gpu) { gpu.textContent = errors.length ? "SHADER ERROR · see console" : "GPU READY"; gpu.classList.toggle("online", !errors.length); }
    preview.setDeck(deck);
    if (window.__lastState) { preview.setBlackout(window.__lastState.blackout); preview.setMaster(window.__lastState.master / 100); preview.setClock(window.__lastState.bpm, window.__lastState.beat); }
    preview.start();
    checkCode((((deck.layers[sel.l] || {}).clips || [])[sel.c] || {}).code || "");
  }
  function stopPreview() { if (preview) preview.stop(); }

  function onTab() {
    const active = !!$('.tabpanel.active[data-tab="clips"]');
    if (active) { renderGrid(); startPreview(); } else stopPreview();
  }

  window.addEventListener("DOMContentLoaded", async () => {
    if (!$("#deckGrid")) return;
    deck = C.normalizeDeck(await window.showControl.getDeck(), S.ids);
    wire();
    renderGrid();
    // Lets MIDI (Push 2 pads) trigger clips through the same path as a click.
    window.firebirdDeckOp = (o) => { op(o); renderGrid(); };
    $("#tabstrip").addEventListener("click", () => setTimeout(onTab, 0));
    // Ops from OSC / the phone remote arrive here; local ops are never echoed.
    window.showControl.onDeck((next) => { deck = C.normalizeDeck(next, S.ids); if (preview) preview.setDeck(deck); renderGrid(); });
    window.showControl.onState((s) => {
      window.__lastState = s;
      if (preview) { preview.setBlackout(s.blackout); preview.setMaster(s.master / 100); preview.setClock(s.bpm, s.beat); }
    });
    window.addEventListener("firebird:audio", (e) => preview && preview.setAudio(e.detail));
  });
})();
