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
    { id: "speed", label: "Visual speed (knob)", kind: "value", fire: (v) => cmd({ action: "visual", key: "speed", value: Math.round(v / 127 * 100) }) }
  ];

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
    init();
  });
})();
