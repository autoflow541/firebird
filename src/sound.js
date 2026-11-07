// Sound-reactive engine (operator window). Uses the browser's native Web Audio
// AnalyserNode — no build step, no dependency — to extract level + bass/mid/high
// + onsets from a chosen audio input, maps them to control commands via the pure
// soundmap.js, and sends them tagged source:"sound".
//
// SAFETY: everything here goes out as source "sound", which the engine restricts
// to visuals / master / depth-FX only. Sound can never black the stage out or
// touch the laser. See engine.js SOUND_ALLOWED + soundmap.js.

(function () {
  let ctx, analyser, source, stream, raf;
  let running = false;
  const freq = () => new Uint8Array(analyser.frequencyBinCount);
  let freqBuf, timeBuf;

  const cfg = { sensitivity: 1, master: false, depthfx: false };
  const lastSent = {};
  let lastSend = 0;
  const levelHistory = [];
  let lastOnset = 0;

  const $ = (id) => document.querySelector(id);

  function bandAvg(data, loHz, hiHz) {
    const nyquist = ctx.sampleRate / 2;
    const lo = Math.max(1, Math.floor((loHz / nyquist) * data.length));
    const hi = Math.min(data.length - 1, Math.ceil((hiHz / nyquist) * data.length));
    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += data[i];
    return (sum / Math.max(1, hi - lo + 1)) / 255; // 0..1
  }

  function rms(time) {
    let s = 0;
    for (let i = 0; i < time.length; i++) { const v = (time[i] - 128) / 128; s += v * v; }
    return Math.min(1, Math.sqrt(s / time.length) * 1.6);
  }

  function analyse() {
    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(timeBuf);
    const level = rms(timeBuf);
    const bass = bandAvg(freqBuf, 20, 250);
    const mid = bandAvg(freqBuf, 250, 2000);
    const high = bandAvg(freqBuf, 2000, 8000);

    // Simple onset: energy well above the recent average, with a refractory gap.
    levelHistory.push(level);
    if (levelHistory.length > 43) levelHistory.shift();
    const avg = levelHistory.reduce((a, b) => a + b, 0) / levelHistory.length;
    const now = performance.now();
    const onset = level > 0.14 && level > avg * 1.4 && now - lastOnset > 120;
    if (onset) lastOnset = now;

    meters(bass, mid, high, level);
    publishFeatures(level, bass, mid, high, onset, now);

    // Emit at ~20 fps, only values that changed (keeps the bus quiet).
    if (now - lastSend >= 50) {
      lastSend = now;
      const cmds = window.FirebirdSoundMap.featuresToCommands({ level, bass, mid, high, onset }, cfg);
      for (const cmd of cmds) {
        const key = cmd.action + (cmd.key || "");
        if (lastSent[key] !== cmd.value) { lastSent[key] = cmd.value; window.showControl.sound(cmd); }
      }
    }
    raf = requestAnimationFrame(analyse);
  }

  // Feed the clip-deck compositor (operator preview via a window event, projector
  // via IPC). Byte spectrum data sits high for music, so shape it to use the full
  // 0..1 range — shaders then see real dynamics. Visual-only; never a control path.
  const shape = (v) => Math.max(0, Math.min(1, (v - 0.3) / 0.6));
  let lastAudioSend = 0;
  function publishFeatures(level, bass, mid, high, onset, now) {
    const bands = new Array(16);
    for (let i = 0; i < 16; i++) {
      bands[i] = shape(bandAvg(freqBuf, 40 * Math.pow(350, i / 16), 40 * Math.pow(350, (i + 1) / 16)));
    }
    const f = { level: shape(level + 0.25), bass: shape(bass), mid: shape(mid), high: shape(high), onset, bands };
    window.dispatchEvent(new CustomEvent("firebird:audio", { detail: f }));
    if (now - lastAudioSend >= 33 && window.showControl.audio) { lastAudioSend = now; window.showControl.audio(f); }
  }

  function meters(b, m, h, l) {
    const set = (id, v) => { const el = $(id); if (el) el.style.width = Math.round(v * 100) + "%"; };
    set("#mBass", b); set("#mMid", m); set("#mHigh", h); set("#mLevel", l);
  }

  async function start() {
    try {
      const deviceId = $("#soundDevice").value || undefined;
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") await ctx.resume();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.7;
      freqBuf = freq(); timeBuf = new Uint8Array(analyser.fftSize);
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser); // analyser only — we do NOT route audio to output
      running = true;
      $("#soundToggle").textContent = "● SOUND ON";
      $("#soundToggle").classList.add("active");
      document.querySelector('#tabstrip [data-tab="sound"]')?.classList.add("live");
      populateDevices(); // labels become available once permission is granted
      analyse();
    } catch (error) {
      $("#soundToggle").textContent = "MIC BLOCKED";
      console.error("[sound] getUserMedia failed:", error.message);
    }
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (ctx) ctx.close();
    ctx = analyser = source = stream = null;
    $("#soundToggle").textContent = "SOUND OFF";
    $("#soundToggle").classList.remove("active");
    document.querySelector('#tabstrip [data-tab="sound"]')?.classList.remove("live");
    meters(0, 0, 0, 0);
    const silent = { level: 0, bass: 0, mid: 0, high: 0, onset: false, bands: new Array(16).fill(0) };
    window.dispatchEvent(new CustomEvent("firebird:audio", { detail: silent }));
    if (window.showControl.audio) window.showControl.audio(silent);
  }

  async function populateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const sel = $("#soundDevice");
      const current = sel.value;
      sel.innerHTML = '<option value="">Default input</option>' +
        devices.filter((d) => d.kind === "audioinput")
          .map((d) => `<option value="${d.deviceId}">${d.label || "Input " + d.deviceId.slice(0, 6)}</option>`).join("");
      if (current) sel.value = current;
    } catch {}
  }

  window.addEventListener("DOMContentLoaded", () => {
    $("#soundToggle").onclick = () => (running ? stop() : start());
    $("#soundSens").oninput = (e) => (cfg.sensitivity = Number(e.target.value) / 100);
    $("#soundMaster").onchange = (e) => (cfg.master = e.target.checked);
    $("#soundDepth").onchange = (e) => (cfg.depthfx = e.target.checked);
    populateDevices();
  });
})();
