// MIDI input + MIDI-learn (Web MIDI API). Bind any pad/key/knob on a controller
// (e.g. an Ableton Push 2) to Firebird actions. Bindings persist in localStorage.
//
// SAFETY: MIDI can trigger the SAFE direction of blackout (engage) and drive
// visuals/master, but it is never offered a blackout-release or laser-arm target
// — those stay deliberate local actions.

(function () {
  const cmd = (c) => window.showControl.command(c);

  // Learnable targets. kind "trigger" fires on a note/CC press; "value" maps a
  // CC 0..127 to 0..100.
  const TARGETS = [
    { id: "sceneIntro", label: "Scene · Intro", kind: "trigger", fire: () => cmd({ action: "scene", value: "INTRO" }) },
    { id: "sceneHeavy", label: "Scene · Heavy", kind: "trigger", fire: () => cmd({ action: "scene", value: "HEAVY" }) },
    { id: "sceneBreak", label: "Scene · Breakdown", kind: "trigger", fire: () => cmd({ action: "scene", value: "BREAKDOWN" }) },
    { id: "sceneAmbient", label: "Scene · Ambient", kind: "trigger", fire: () => cmd({ action: "scene", value: "AMBIENT" }) },
    { id: "blackout", label: "Master Blackout (engage)", kind: "trigger", fire: () => cmd({ action: "blackout", value: true }) },
    { id: "cueBack", label: "Cue ← Back", kind: "trigger", fire: () => cmd({ action: "stepCue", value: -1 }) },
    { id: "cueGo", label: "Cue Go →", kind: "trigger", fire: () => cmd({ action: "stepCue", value: 1 }) },
    { id: "play", label: "Transport play/stop", kind: "trigger", fire: () => cmd({ action: "togglePlay" }) },
    { id: "master", label: "Master level (knob)", kind: "value", fire: (v) => cmd({ action: "master", value: Math.round(v / 127 * 100) }) },
    { id: "brightness", label: "Visual brightness (knob)", kind: "value", fire: (v) => cmd({ action: "visual", key: "brightness", value: Math.round(v / 127 * 100) }) },
    { id: "speed", label: "Visual speed (knob)", kind: "value", fire: (v) => cmd({ action: "visual", key: "speed", value: Math.round(v / 127 * 100) }) },
    // Audience lights (DMX fixtures): bulk controls over every patched fixture.
    { id: "lightsAmt", label: "Lights · reactivity depth (knob)", kind: "value", fire: (v) => cmd({ action: "lights", key: "amt", value: Math.round(v / 127 * 100) }) },
    { id: "lightsLevel", label: "Lights · level (knob)", kind: "value", fire: (v) => cmd({ action: "lights", key: "level", value: Math.round(v / 127 * 100) }) },
    { id: "lightsFlash", label: "Lights · flash-to-beat on/off", kind: "trigger", fire: () => cmd({ action: "lights", key: "flash", value: !(window.state && window.state.dmx && window.state.dmx.flash) }) },
    { id: "lightsBeat", label: "Lights · react to BEAT", kind: "trigger", fire: () => cmd({ action: "lights", key: "react", value: "beat" }) },
    { id: "lightsFlashOn", label: "Lights · FLASH on beat (rate-limited)", kind: "trigger", fire: () => cmd({ action: "lights", key: "react", value: "flash" }) },
    { id: "lightsLevelMode", label: "Lights · react to SOUND level", kind: "trigger", fire: () => cmd({ action: "lights", key: "react", value: "level" }) },
    { id: "lightsBass", label: "Lights · react to BASS", kind: "trigger", fire: () => cmd({ action: "lights", key: "react", value: "bass" }) },
    { id: "lightsSteady", label: "Lights · steady (no reaction)", kind: "trigger", fire: () => cmd({ action: "lights", key: "react", value: "none" }) },
    // Clip deck: fire a whole column, or stop everything.
    ...Array.from({ length: 8 }, (_, i) => ({ id: "col" + (i + 1), label: "Clips · fire column " + (i + 1), kind: "trigger", fire: () => deckOp({ op: "column", col: i }) })),
    { id: "clipStop", label: "Clips · stop all", kind: "trigger", fire: () => deckOp({ op: "stopAll" }) }
  ];

  // Ops go through deck.js so the operator's grid + preview update too.
  const deckOp = (o) => (window.firebirdDeckOp ? window.firebirdDeckOp(o) : window.showControl.deckOp(o));

  // Ableton Push 2 pad grid (notes 36..99, 8x8, bottom-left = 36): pad row = layer from the
  // bottom, pad column = clip column. Opt-in; persisted.
  let padGrid = localStorage.getItem("firebird.midi.pads") === "1";
  const PUSH_FIRST = 36, PUSH_LAST = 99;

  let bindings = {};
  try { bindings = JSON.parse(localStorage.getItem("firebird.midi") || "{}"); } catch {}
  let learning = null;

  const save = () => localStorage.setItem("firebird.midi", JSON.stringify(bindings));
  const keyOf = (isCC, number) => `${isCC ? "cc" : "n"}${number}`;
  const $ = (s) => document.querySelector(s);
  const setStatus = (t) => { const el = $("#midiState"); if (el) el.textContent = t; };

  function render() {
    const list = $("#midiList");
    if (!list) return;
    list.innerHTML = TARGETS.map((t) => {
      const b = bindings[t.id];
      const label = b ? `${b.cc ? "CC" : "Note"} ${b.number}` : "—";
      return `<div class="midi-row"><span>${t.label}</span><b class="midi-bind">${label}</b>` +
        `<button data-learn="${t.id}" class="soft${learning === t.id ? " active" : ""}">${learning === t.id ? "PRESS A CONTROL…" : "LEARN"}</button></div>`;
    }).join("");
  }

  function onMessage(msg) {
    const [status, d1, d2] = msg.data;
    const type = status & 0xf0;
    const isCC = type === 0xb0;
    const isNoteOn = type === 0x90 && d2 > 0;
    if (!isCC && !isNoteOn) return;

    if (learning) {
      bindings[learning] = { cc: isCC, number: d1 };
      learning = null; save(); render();
      return;
    }
    if (padGrid && isNoteOn && d1 >= PUSH_FIRST && d1 <= PUSH_LAST) {
      const i = d1 - PUSH_FIRST;
      deckOp({ op: "trigger", layer: Math.floor(i / 8), col: i % 8 });
      return;
    }
    for (const t of TARGETS) {
      const b = bindings[t.id];
      if (!b || b.cc !== isCC || b.number !== d1) continue;
      if (t.kind === "value") t.fire(isCC ? d2 : 127);
      else t.fire();
    }
  }

  async function init() {
    if (!navigator.requestMIDIAccess) { setStatus("Web MIDI not available"); render(); return; }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      const attach = () => {
        let n = 0;
        access.inputs.forEach((inp) => { inp.onmidimessage = onMessage; n++; });
        setStatus(n ? `● ${n} MIDI input${n > 1 ? "s" : ""}` : "No MIDI inputs");
      };
      attach();
      access.onstatechange = attach;
    } catch (error) { setStatus("MIDI blocked: " + error.message); }
    render();
  }

  window.addEventListener("DOMContentLoaded", () => {
    $("#midiList")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-learn]");
      if (!btn) return;
      learning = learning === btn.dataset.learn ? null : btn.dataset.learn;
      render();
    });
    $("#midiClear")?.addEventListener("click", () => { bindings = {}; save(); render(); });
    const pg = $("#midiPads");
    if (pg) { pg.checked = padGrid; pg.addEventListener("change", () => { padGrid = pg.checked; localStorage.setItem("firebird.midi.pads", padGrid ? "1" : "0"); }); }
    init();
  });
})();
