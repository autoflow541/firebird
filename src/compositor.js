/**
 * compositor.js — WebGL2 layer compositor for the clip deck.
 *
 * Browser-only. FirebirdCompositor.create(canvas) returns a controller, or null if
 * WebGL2 is unavailable (callers then fall back to the non-GPU look).
 *
 *   per frame, for each layer (bottom -> top):
 *     1. render the active clip (generator | live GLSL | solid | image | video | webcam)
 *     2. if the layer is crossfading (trigger / stop with fade > 0), also render the
 *        outgoing clip and mix the two
 *     3. run the layer's effect chain (color, transform, mirror, mosaic, rgb split,
 *        blur, trails, invert), each optionally modulated by audio / beat / LFO
 *     4. blend the result over the accumulator with the layer's mode + opacity
 *   then output the accumulator x master to the canvas.
 *
 * The same module drives the projector output and the operator's preview, so the
 * CLIPS tab shows the real render path.
 *
 * SAFETY: setBlackout(true) renders solid black and pauses all media decode. The
 * projector additionally hides the canvas via CSS; this is belt-and-braces.
 */
(function (root) {
  "use strict";

  const S = root.FirebirdShaders;
  const C = root.FirebirdClips;

  // Shared webcam stream, opened lazily the first time a webcam clip plays.
  let webcamPromise = null;
  function ensureWebcam() {
    if (!webcamPromise) {
      webcamPromise = navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        .catch((e) => { console.error("[compositor] webcam unavailable:", e.message); webcamPromise = null; return null; });
    }
    return webcamPromise;
  }

  function hashStr(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function create(canvas, options) {
    if (!S || !C) return null;
    const opts = options || {};
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: "high-performance" });
    if (!gl) return null;

    // ---------- program helpers ----------
    const programs = new Map(); // key -> { prog, loc:{}, ok, error }
    const customKeys = [];

    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(log || "shader compile failed");
      }
      return sh;
    }
    function program(key, fragSrc) {
      let p = programs.get(key);
      if (p) return p;
      try {
        const prog = gl.createProgram();
        const v = compile(gl.VERTEX_SHADER, S.VERT), f = compile(gl.FRAGMENT_SHADER, fragSrc);
        gl.attachShader(prog, v); gl.attachShader(prog, f);
        gl.linkProgram(prog);
        gl.deleteShader(v); gl.deleteShader(f);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        p = { prog, loc: {}, ok: true };
      } catch (e) {
        if (!key.startsWith("glsl:")) console.error(`[compositor] program '${key}' failed:`, e.message);
        p = { prog: null, loc: {}, ok: false, error: e.message };
      }
      programs.set(key, p);
      if (key.startsWith("glsl:")) {
        // live editing compiles one program per edit; keep only the newest few
        customKeys.push(key);
        while (customKeys.length > 16) {
          const old = customKeys.shift(), op = programs.get(old);
          if (op && op.prog) gl.deleteProgram(op.prog);
          programs.delete(old);
        }
      }
      return p;
    }
    function uni(p, name) {
      if (!(name in p.loc)) p.loc[name] = gl.getUniformLocation(p.prog, name);
      return p.loc[name];
    }
    const genProgram = (id) => program("gen:" + id, S.buildFragment(id));
    const customProgram = (code) => program("glsl:" + hashStr(code), S.buildCustom(code));
    const solidProgram = () => program("solid", S.SOLID_FRAG);
    const mediaProgram = () => program("media", S.MEDIA_FRAG);
    const blendProgram = () => program("blend", S.BLEND_FRAG);
    const outProgram = () => program("out", S.OUT_FRAG);
    const mixProgram = () => program("mix", S.MIX_FRAG);
    const blurProgram = () => program("blur", S.BLUR_FRAG);
    const fxProgram = () => program("fx", S.FX_FRAG);

    // ---------- render targets ----------
    let W = 2, H = 2;
    let layerT, prevT, mixT, accA, accB;
    let fxPool = [];
    const trails = new Map(); // "layer:fxIndex" -> { t:[T0,T1], i, touched }
    function makeTarget(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      return { tex, fbo };
    }
    function freeTarget(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); } }
    function freeTrails() { for (const tr of trails.values()) tr.t.forEach(freeTarget); trails.clear(); }
    function resize(w, h) {
      w = Math.max(2, Math.floor(w)); h = Math.max(2, Math.floor(h));
      if (w === W && h === H && layerT) return;
      W = w; H = h;
      canvas.width = W; canvas.height = H;
      [layerT, prevT, mixT, accA, accB].forEach(freeTarget);
      fxPool.forEach(freeTarget); freeTrails();
      layerT = makeTarget(W, H); prevT = makeTarget(W, H); mixT = makeTarget(W, H);
      accA = makeTarget(W, H); accB = makeTarget(W, H);
      fxPool = [makeTarget(W, H), makeTarget(W, H), makeTarget(W, H)];
    }

    // ---------- media (image / video / webcam) ----------
    const media = new Map(); // "layer:col" -> entry
    function disposeMedia(entry) {
      if (!entry) return;
      if (entry.el && entry.kind === "video") { try { entry.el.pause(); entry.el.removeAttribute("src"); entry.el.srcObject = null; entry.el.load(); } catch {} }
      if (entry.tex) gl.deleteTexture(entry.tex);
    }
    function newTexture() {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      return tex;
    }
    function upload(entry, el, w, h) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el); entry.ready = true; entry.aspect = w / h; }
      catch (e) { entry.ready = false; }
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    }
    function mediaFor(li, ci, clip) {
      const key = li + ":" + ci;
      const sig = clip.type + "|" + clip.src;
      let m = media.get(key);
      if (m && m.sig === sig) return m;
      disposeMedia(m);
      m = { sig, kind: clip.type, tex: newTexture(), ready: false, aspect: 1, el: null, lastTime: -1 };
      media.set(key, m);
      if (clip.type === "image") {
        const img = new Image();
        img.onload = () => upload(m, img, img.naturalWidth, img.naturalHeight);
        img.onerror = () => console.warn("[compositor] image failed to load:", clip.src);
        img.src = clip.src;
        m.el = img;
      } else if (clip.type === "video") {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true; v.preload = "auto"; v.loop = clip.loop !== false;
        v.onerror = () => console.warn("[compositor] video failed to load:", clip.src);
        v.src = clip.src;
        m.el = v;
      } else if (clip.type === "webcam") {
        const v = document.createElement("video");
        v.muted = true; v.playsInline = true;
        m.el = v;
        ensureWebcam().then((s) => { if (s && media.get(key) === m) { v.srcObject = s; v.play().catch(() => {}); } });
      }
      return m;
    }
    function pruneMedia() {
      if (!deck) return;
      const live = new Set();
      deck.layers.forEach((l, li) => l.clips.forEach((c, ci) => { if (c && (c.type === "image" || c.type === "video" || c.type === "webcam")) live.add(li + ":" + ci + "|" + c.type + "|" + c.src); }));
      for (const [key, m] of media) {
        if (!live.has(key + "|" + m.sig)) { disposeMedia(m); media.delete(key); }
      }
    }

    // ---------- state ----------
    const blankTex = newTexture();
    let deck = null;
    let master = 1;
    let blackout = false;
    let running = false;
    let raf = 0;
    let lastT = 0;
    let beatPos = 0, bpm = 120, lastBeat = 0;
    let frameNo = 0;
    let busy = false;
    const audio = { level: 0, bass: 0, mid: 0, high: 0, onset: 0, bands: new Float32Array(16) };
    const target = { level: 0, bass: 0, mid: 0, high: 0, bands: new Float32Array(16) };
    // Per layer: cur = { key, ci, clip(live ref), time }, prev = snapshot being faded out, p = 0..1 fade progress.
    const layerStates = [];
    const frameCallbacks = [];
    const stats = { fps: 0, frames: 0, last: 0 };
    let glslErrors = {}; // code hash -> message, for the editor

    // ---------- drawing ----------
    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, W, H);
    }
    function tri() { gl.drawArrays(gl.TRIANGLES, 0, 3); }
    function tex(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); }
    function hexToRgb(h) {
      const n = parseInt(String(h || "#ffffff").slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    function setAudioUniforms(p, time) {
      gl.uniform2f(uni(p, "uRes"), W, H);
      gl.uniform1f(uni(p, "uTime"), time);
      gl.uniform1f(uni(p, "uBeat"), beatPos);
      gl.uniform1f(uni(p, "uBass"), audio.bass);
      gl.uniform1f(uni(p, "uMid"), audio.mid);
      gl.uniform1f(uni(p, "uHigh"), audio.high);
      gl.uniform1f(uni(p, "uLevel"), audio.level);
      gl.uniform1f(uni(p, "uOnset"), audio.onset);
      const bl = uni(p, "uBands");
      if (bl) gl.uniform1fv(bl, audio.bands);
    }
    function setClipUniforms(p, clip) {
      gl.uniform1f(uni(p, "uHue"), clip.hue);
      gl.uniform1f(uni(p, "uAmt"), clip.amount);
      gl.uniform1f(uni(p, "uAudio"), clip.audio);
      gl.uniform1f(uni(p, "uScale"), clip.scale);
    }

    // Render one clip into `dst`. Returns false if nothing drawable.
    function renderClip(dst, li, ci, clip, time) {
      bindTarget(dst);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (clip.type === "shader" || clip.type === "glsl") {
        const p = clip.type === "shader" ? genProgram(clip.shader) : customProgram(clip.code);
        if (clip.type === "glsl") { const h = hashStr(clip.code); if (p.ok) delete glslErrors[h]; else glslErrors[h] = p.error; }
        if (!p.ok) return false;
        gl.useProgram(p.prog);
        setAudioUniforms(p, time); setClipUniforms(p, clip);
        tri(); return true;
      }
      if (clip.type === "solid") {
        const p = solidProgram();
        if (!p.ok) return false;
        gl.useProgram(p.prog);
        gl.uniform3fv(uni(p, "uColor"), hexToRgb(clip.color));
        gl.uniform1f(uni(p, "uAmt"), clip.amount);
        tri(); return true;
      }
      // media
      if (!clip.src && clip.type !== "webcam") return false;
      const m = mediaFor(li, ci, clip);
      if (m.kind === "video" && m.el) {
        const v = m.el;
        if (v.paused) { v.playbackRate = Math.max(0.0625, clip.speed || 1); v.play().catch(() => {}); }
        v.loop = clip.loop !== false;
        if (v.readyState >= 2 && v.videoWidth && v.currentTime !== m.lastTime) { m.lastTime = v.currentTime; upload(m, v, v.videoWidth, v.videoHeight); }
      } else if (m.kind === "webcam" && m.el) {
        const v = m.el;
        if (v.readyState >= 2 && v.videoWidth) upload(m, v, v.videoWidth, v.videoHeight);
      }
      if (!m.ready) return false;
      const p = mediaProgram();
      if (!p.ok) return false;
      gl.useProgram(p.prog);
      tex(0, m.tex);
      gl.uniform1i(uni(p, "uTex"), 0);
      gl.uniform2f(uni(p, "uRes"), W, H);
      gl.uniform1f(uni(p, "uTexAspect"), m.aspect || 1);
      setClipUniforms(p, clip);
      tri(); return true;
    }

    // ---------- per-layer effect chain ----------
    function modValue(mod) {
      switch (mod) {
        case "level": return audio.level;
        case "bass": return audio.bass;
        case "mid": return audio.mid;
        case "high": return audio.high;
        case "beat": return Math.exp(-(beatPos - Math.floor(beatPos)) * 5);
        case "lfo": return 0.5 + 0.5 * Math.sin(beatPos * Math.PI / 2);          // one cycle per bar
        case "ramp": return (beatPos / 4) - Math.floor(beatPos / 4);            // saw, once per bar
        case "noise": { const x = lastT / 1000 * 0.7; const i = Math.floor(x), f = x - i; const r = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }; const u = f * f * (3 - 2 * f); return r(i) * (1 - u) + r(i + 1) * u; }
        default: return 0;
      }
    }
    const near = (v, n, e) => Math.abs(v - n) <= e;
    // Skip a pass when the effect would be a no-op (keeps empty-looking chains free).
    function isNoop(type, p) {
      switch (type) {
        case "color": return near(p[0], 0.5, 0.01) && near(p[1], 0.5, 0.01) && near(p[2], 0.5, 0.01);
        case "transform": return near(p[0], 0.5, 0.005) && p[1] < 0.003 && near(p[2], 0.5, 0.003) && near(p[3], 0.5, 0.003);
        case "mirror": return p[0] < 0.02;
        default: return p[0] < 0.01; // mosaic, rgbsplit, blur, trails, invert
      }
    }
    // Pick a pool target whose texture isn't one of `avoid`.
    function freeTarget2(avoid) { return fxPool.find((t) => !avoid.includes(t.tex)); }

    // Run the chain on `srcTex`; returns the final texture (may be srcTex itself).
    function runFx(li, layer, srcTex) {
      let curTex = srcTex;
      const touchedNow = [];
      layer.fx.forEach((fx, ei) => {
        if (!fx.on) return;
        const p = fx.p.slice(0, 4); while (p.length < 4) p.push(0);
        if (fx.mod !== "none") p[0] = Math.max(0, Math.min(1, p[0] + modValue(fx.mod) * fx.amt));
        if (isNoop(fx.type, p)) return;
        if (fx.type === "blur") {
          const bp = blurProgram(); if (!bp.ok) return;
          const px = p[0] * p[0] * 14;              // quadratic: fine control near 0
          const t1 = freeTarget2([curTex]), t2 = freeTarget2([curTex, t1.tex]);
          gl.useProgram(bp.prog);
          bindTarget(t1); tex(0, curTex); gl.uniform1i(uni(bp, "uTex"), 0); gl.uniform2f(uni(bp, "uStep"), px / W, 0); tri();
          bindTarget(t2); tex(0, t1.tex); gl.uniform2f(uni(bp, "uStep"), 0, px / H); tri();
          curTex = t2.tex;
          return;
        }
        const fp = fxProgram(); if (!fp.ok) return;
        gl.useProgram(fp.prog);
        gl.uniform1i(uni(fp, "uType"), C.FX_INDEX[fx.type]);
        gl.uniform4f(uni(fp, "uP"), p[0], p[1], p[2], p[3]);
        gl.uniform2f(uni(fp, "uRes"), W, H);
        gl.uniform1i(uni(fp, "uTex"), 0); gl.uniform1i(uni(fp, "uPrev"), 1);
        let dst;
        // uPrev is an active sampler in FX_FRAG, so unit 1 must never hold the texture
        // we are about to render into (WebGL feedback loop => the draw is silently dropped).
        tex(1, blankTex);
        if (fx.type === "trails") {
          const key = li + ":" + ei;
          let tr = trails.get(key);
          if (!tr) { tr = { t: [makeTarget(W, H), makeTarget(W, H)], i: 0, touched: frameNo }; trails.set(key, tr); }
          tr.touched = frameNo; touchedNow.push(key);
          tex(1, tr.t[tr.i].tex);
          dst = tr.t[1 - tr.i]; tr.i = 1 - tr.i;
        } else {
          dst = freeTarget2([curTex]);
        }
        bindTarget(dst); tex(0, curTex); tri();
        curTex = dst.tex;
      });
      return curTex;
    }
    function sweepTrails() {
      if (frameNo % 90) return;
      for (const [k, tr] of trails) if (frameNo - tr.touched > 90) { tr.t.forEach(freeTarget); trails.delete(k); }
    }

    // ---------- blend ----------
    function blendInto(src, dst, layer, topTex) {
      const p = blendProgram();
      if (!p.ok) return;
      bindTarget(dst);
      gl.useProgram(p.prog);
      tex(0, src.tex); tex(1, topTex);
      gl.uniform1i(uni(p, "uBase"), 0);
      gl.uniform1i(uni(p, "uTop"), 1);
      gl.uniform1f(uni(p, "uOpacity"), layer.opacity);
      gl.uniform1i(uni(p, "uMode"), Math.max(0, C.BLEND_MODES.indexOf(layer.blend)));
      tri();
      gl.activeTexture(gl.TEXTURE0);
    }

    function pauseAllMedia() {
      for (const m of media.values()) if (m.kind === "video" && m.el && !m.el.paused) m.el.pause();
    }

    // ---------- crossfade bookkeeping ----------
    // Seconds for a trails effect to fall to ~2% (per-frame decay = p * 0.97 at 60 fps), capped.
    function trailTail(layer) {
      let secs = 0;
      for (const fx of layer.fx) {
        if (!fx.on || fx.type !== "trails") continue;
        const d = Math.min(0.999, fx.p[0] * 0.97);
        if (d > 0.01) secs = Math.max(secs, Math.min(5, Math.log(0.02) / Math.log(d) / 60));
      }
      return secs;
    }
    function clipKey(ci, clip) { return ci + "|" + clip.type + "|" + clip.shader + "|" + clip.src + "|" + (clip.type === "glsl" ? hashStr(clip.code) : ""); }

    // Detect that the layer's active clip changed and start / advance its crossfade.
    function advanceLayer(li, layer, dt) {
      const st = layerStates[li] || (layerStates[li] = { cur: null, prev: null, p: 1, tail: 0 });
      const ci = layer.active;
      const clip = ci >= 0 ? layer.clips[ci] : null;
      const key = clip ? clipKey(ci, clip) : "";
      const curKey = st.cur ? st.cur.key : "";
      if (key !== curKey) {
        if (layer.fade > 0 && !layer.bypass) {
          // outgoing = a frozen copy, so editing the cell later can't change what is fading out
          st.prev = st.cur ? { key: st.cur.key, ci: st.cur.ci, clip: Object.assign({}, st.cur.clip), time: st.cur.time } : null;
          st.p = 0;
        } else { st.prev = null; st.p = 1; }
        st.cur = clip ? { key, ci, clip, time: 0 } : null;
      } else if (st.cur) st.cur.clip = clip; // keep following live edits (speed, hue, ...)
      if (st.p < 1) {
        st.p = Math.min(1, st.p + dt / Math.max(0.01, layer.fade));
        if (st.p >= 1) st.prev = null;
      }
      // Trails keep dissolving after the clip is gone: while a trails effect still has
      // energy the layer keeps running its chain on an empty source (see tailFor).
      if (st.cur || st.prev) st.tail = trailTail(layer);
      else if (st.tail > 0) st.tail -= dt;
      return st;
    }

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0.016);
      lastT = now;
      frameNo++;
      if (opts.autoSize) resize(canvas.clientWidth * (opts.scale || 1), canvas.clientHeight * (opts.scale || 1));

      // smooth audio: fast attack, slower release
      const att = 1 - Math.exp(-dt * 30), rel = 1 - Math.exp(-dt * 7);
      for (const k of ["level", "bass", "mid", "high"]) audio[k] += (target[k] - audio[k]) * (target[k] > audio[k] ? att : rel);
      for (let i = 0; i < 16; i++) audio.bands[i] += (target.bands[i] - audio.bands[i]) * (target.bands[i] > audio.bands[i] ? att : rel);
      audio.onset = Math.max(0, audio.onset - dt * 4);
      beatPos += dt * bpm / 60;

      stats.frames++;
      if (now - stats.last >= 1000) { stats.fps = stats.frames * 1000 / (now - stats.last); stats.frames = 0; stats.last = now; }

      let didRender = false;
      let anyBusy = false;
      if (deck) {
        // Keep fade state moving even under blackout so timing is right on release.
        deck.layers.forEach((layer, li) => { const st = advanceLayer(li, layer, dt); if (st.cur || st.prev || st.tail > 0) anyBusy = true; });
      }
      busy = anyBusy;

      if (blackout || !deck) {
        bindTarget(null);
        gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        pauseAllMedia();
      } else {
        let acc = accA, other = accB;
        bindTarget(acc); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
        const activeMedia = new Set();
        deck.layers.forEach((layer, li) => {
          const st = layerStates[li];
          if (!st || (!st.cur && !st.prev && !(st.tail > 0)) || layer.bypass || layer.opacity <= 0) return;
          if (!st.cur && !st.prev) {
            // tail: nothing to draw, but let the trails buffer decay
            bindTarget(layerT); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
            blendInto(acc, other, layer, runFx(li, layer, layerT.tex));
            const t0 = acc; acc = other; other = t0;
            didRender = true;
            return;
          }

          let curOk = false, prevOk = false;
          if (st.cur) {
            st.cur.time += dt * st.cur.clip.speed;
            activeMedia.add(li + ":" + st.cur.ci);
            curOk = renderClip(layerT, li, st.cur.ci, st.cur.clip, st.cur.time);
          }
          if (st.prev) {
            st.prev.time += dt * st.prev.clip.speed;
            activeMedia.add(li + ":" + st.prev.ci);
            prevOk = renderClip(prevT, li, st.prev.ci, st.prev.clip, st.prev.time);
          }
          let top;
          if (st.p < 1) {
            const mp = mixProgram();
            if (!mp.ok) return;
            bindTarget(mixT);
            gl.useProgram(mp.prog);
            tex(0, prevT.tex); tex(1, layerT.tex);
            gl.uniform1i(uni(mp, "uPrev"), 0); gl.uniform1i(uni(mp, "uCur"), 1);
            gl.uniform1f(uni(mp, "uP"), st.p * st.p * (3 - 2 * st.p)); // smoothstep ease
            gl.uniform1i(uni(mp, "uHasPrev"), prevOk ? 1 : 0); gl.uniform1i(uni(mp, "uHasCur"), curOk ? 1 : 0);
            tri();
            top = mixT.tex;
          } else if (curOk) top = layerT.tex;
          else return;

          if (layer.fx.length) top = runFx(li, layer, top);
          blendInto(acc, other, layer, top);
          const t = acc; acc = other; other = t;
          didRender = true;
        });
        for (const [key, m] of media) if (m.kind === "video" && m.el && !m.el.paused && !activeMedia.has(key)) m.el.pause();
        sweepTrails();
        const p = outProgram();
        bindTarget(null);
        if (p.ok) {
          gl.useProgram(p.prog);
          tex(0, acc.tex);
          gl.uniform1i(uni(p, "uTex"), 0);
          gl.uniform1f(uni(p, "uMaster"), master);
          tri();
        }
      }
      for (const cb of frameCallbacks) { try { cb(canvas, didRender); } catch (e) { console.error(e); } }
    }

    // ---------- public controller ----------
    const api = {
      setDeck(next) { deck = next; pruneMedia(); },
      setAudio(f) {
        if (!f) return;
        target.level = +f.level || 0; target.bass = +f.bass || 0; target.mid = +f.mid || 0; target.high = +f.high || 0;
        if (f.onset) audio.onset = 1;
        if (f.bands) for (let i = 0; i < 16; i++) target.bands[i] = +f.bands[i] || 0;
      },
      // bpm + current beat-in-bar (1..4). A change of beat snaps the continuous
      // beat counter to that beat so visuals stay locked to Ableton.
      setClock(nextBpm, beat) {
        if (Number.isFinite(nextBpm) && nextBpm > 0) bpm = nextBpm;
        if (beat && beat !== lastBeat) {
          lastBeat = beat;
          const base = Math.floor(beatPos / 4) * 4 + (beat - 1);
          const cands = [base - 4, base, base + 4];
          beatPos = cands.reduce((best, c) => (Math.abs(c - beatPos) < Math.abs(best - beatPos) ? c : best), cands[0]);
        }
      },
      setMaster(v) { master = Math.max(0, Math.min(1, v)); },
      setBlackout(b) { blackout = !!b; },
      resize,
      start() { if (running) return; running = true; lastT = 0; raf = requestAnimationFrame(frame); },
      stop() { running = false; cancelAnimationFrame(raf); pauseAllMedia(); },
      isRunning: () => running,
      // true while any layer still has a clip showing or fading out
      isBusy: () => busy,
      onFrame(cb) { frameCallbacks.push(cb); },
      stats,
      // Compile-check live GLSL without playing it. Returns "" or the driver's message.
      checkGlsl(code) { const p = customProgram(code); return p.ok ? "" : String(p.error || "compile failed"); },
      shaderErrors() {
        const out = [];
        for (const [k, p] of programs) if (!p.ok && !k.startsWith("glsl:")) out.push(k + ": " + p.error);
        return out;
      },
      // compile everything up-front so a first trigger never stalls a frame mid-show
      warm() {
        S.ids.forEach(genProgram); solidProgram(); mediaProgram(); blendProgram(); outProgram();
        mixProgram(); blurProgram(); fxProgram();
        return api.shaderErrors();
      },
      dispose() { api.stop(); for (const m of media.values()) disposeMedia(m); media.clear(); freeTrails(); }
    };

    resize(opts.width || canvas.width || 640, opts.height || canvas.height || 360);
    return api;
  }

  root.FirebirdCompositor = { create };
})(typeof window !== "undefined" ? window : this);
