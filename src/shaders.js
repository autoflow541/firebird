/**
 * shaders.js — built-in generator library for the compositor (GLSL ES 3.00).
 *
 * Dual-use (browser <script> + Node tests). Each generator supplies only
 *   vec3 fx(vec2 uv, vec2 p, float t)
 * where uv is 0..1, p is aspect-corrected centred coords (zoomed by the clip's
 * scale), and t is the clip's own clock (already multiplied by clip speed).
 * HEADER provides audio/beat uniforms + helpers, FOOTER applies hue + intensity.
 *
 * Audio uniforms (all 0..1, smoothed on the CPU): uLevel uBass uMid uHigh uOnset
 * (decaying pulse) and uBands[16] (log spectrum, low -> high). uBeat is a
 * continuous beat counter locked to Ableton/BPM. `uAudio` is the clip's
 * reactivity amount; generators multiply their audio terms by it.
 *
 * PHOTOSENSITIVITY: generators avoid full-frame hard flashes — onset energy only
 * ever lifts brightness gently (see `lift`). A global strobe clamp is still on the
 * roadmap (REVIEW.md §4).
 */
(function (root) {
  "use strict";

  const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uRes;
uniform float uTime, uBeat, uBass, uMid, uHigh, uLevel, uOnset;
uniform float uBands[16];
uniform float uHue, uAmt, uAudio, uScale;
uniform vec3 uColor;
const float PI = 3.14159265;
vec3 pal(float t){ return 0.5 + 0.5 * cos(6.28318 * (vec3(0.0, 0.33, 0.67) + t)); }
vec3 hueRot(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a * 6.28318), sa = sin(a * 6.28318);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.02 + 7.1; a *= 0.5; } return v; }
float band(float x){
  float f = clamp(x, 0.0, 1.0) * 15.0; int i = int(floor(f)); int j = min(i + 1, 15);
  return mix(uBands[i], uBands[j], fract(f));
}
float beatPulse(){ return exp(-fract(uBeat) * 5.0); }
`;

  const FOOTER = `
void main(){
  float asp = uRes.x / uRes.y;
  vec2 p = (vUv - 0.5) * vec2(asp, 1.0) * 2.0 / max(uScale, 0.05);
  vec3 c = fx(vUv, p, uTime);
  c = hueRot(clamp(c, 0.0, 1.0), uHue) * mix(0.4, 1.6, uAmt);
  fragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

  const LIST = [
    {
      id: "plasma", name: "Plasma",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  float v = sin(p.x * 3.0 + t) + sin(p.y * 3.0 + t * 1.3) + sin((p.x + p.y) * 2.0 + t * 0.7)
          + sin(length(p) * 4.0 - t * 1.5 - uBass * a * 3.0);
  vec3 c = pal(v * 0.125 + t * 0.05 + uMid * a * 0.3);
  return c * (0.6 + 0.4 * uLevel * a + 0.2 * beatPulse() * a);
}`
    },
    {
      id: "tunnel", name: "Tunnel",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  float r = length(p), ang = atan(p.y, p.x);
  float z = 1.0 / max(r, 0.03);
  vec2 q = vec2(ang / PI * 3.0 + t * 0.2, z * 0.5 + t * 0.8 + uBass * a * 0.25);
  float chk = mod(floor(q.x * 2.0) + floor(q.y * 2.0), 2.0);
  vec3 c = mix(pal(q.y * 0.08), pal(q.y * 0.08 + 0.5) * 0.15, chk);
  c *= smoothstep(0.0, 0.7, r);
  c += pal(t * 0.1) * 0.12 / (r + 0.12) * (0.5 + uLevel * a);
  return c;
}`
    },
    {
      id: "kaleido", name: "Kaleidoscope",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  float r = length(p), ang = atan(p.y, p.x);
  float n = 8.0, seg = 2.0 * PI / n;
  ang = abs(mod(ang + t * 0.1, seg) - seg * 0.5);
  vec2 q = r * vec2(cos(ang), sin(ang));
  q *= 1.0 + uBass * a * 0.25;
  float f = fbm(q * 3.0 + t * 0.2);
  float g = fbm(q * 5.0 - t * 0.15 + f);
  vec3 c = pal(f + g * 0.6 + r * 0.2 + t * 0.03);
  return c * (0.35 + 0.9 * g) * smoothstep(1.9, 0.2, r);
}`
    },
    {
      id: "rings", name: "Rings",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  float r = length(p);
  float x = r * 3.0 - t * 0.5 - uBass * a * 0.5;
  float d = abs(fract(x) - 0.5);
  float w = 0.08 + 0.12 * beatPulse() * a + 0.1 * uMid * a;
  float ring = smoothstep(w, 0.0, d);
  vec3 c = pal(floor(x) * 0.13 + t * 0.02) * ring;
  c += pal(0.6 + t * 0.03) * 0.05 / (r + 0.1);
  return c * smoothstep(2.4, 0.3, r) * (0.8 + 0.4 * uLevel * a);
}`
    },
    {
      id: "nebula", name: "Nebula",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  vec2 q = vec2(fbm(p + t * 0.1), fbm(p + vec2(5.2, 1.3) - t * 0.12));
  float f = fbm(p + 3.0 * q + uMid * a * 0.6);
  vec3 c = mix(pal(f + 0.2 + q.x * 0.3) * 0.9, pal(f + 0.6) * 0.2, 1.0 - f);
  c *= f * f * 2.2 + 0.15;
  float lift = uOnset * a * 0.25;
  return c * (0.8 + 0.5 * uLevel * a) + c * lift;
}`
    },
    {
      id: "starfield", name: "Starfield",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  vec3 col = vec3(0.0);
  float speed = 0.12 * (1.0 + uBass * a * 2.0);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float f = fract(fi * 0.25 + t * speed);
    float scale = mix(18.0, 1.5, f);
    float fade = smoothstep(0.0, 0.15, f) * smoothstep(1.0, 0.85, f);
    vec2 g = p * scale + fi * 37.7;
    vec2 id = floor(g), gv = fract(g) - 0.5;
    float n = hash21(id);
    vec2 off = (vec2(hash21(id + 1.7), hash21(id + 9.2)) - 0.5) * 0.7;
    float d = length(gv - off);
    float star = smoothstep(0.12 + 0.08 * uHigh * a, 0.0, d) * step(0.65, n);
    col += pal(n + t * 0.02) * star * fade;
  }
  return col * 1.4;
}`
    },
    {
      id: "spectrum", name: "Spectrum",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  float bars = 32.0;
  float cell = fract(uv.x * bars);
  float gap = smoothstep(0.0, 0.12, cell) * smoothstep(1.0, 0.88, cell);
  float b = band((floor(uv.x * bars) + 0.5) / bars);
  float h = 0.04 + b * a * 0.9 + 0.05 * beatPulse() * a;
  float y = abs(uv.y - 0.5) * 2.0;
  float on = smoothstep(h + 0.01, h - 0.01, y) * gap;
  vec3 c = pal(uv.x * 0.6 + t * 0.05) * on;
  c += pal(uv.x * 0.6 + t * 0.05) * 0.06 * (1.0 - y);
  return c;
}`
    },
    {
      id: "neongrid", name: "Neon Grid",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  float y = p.y + 0.25;
  vec3 sky = mix(vec3(0.05, 0.0, 0.12), vec3(0.45, 0.05, 0.35), smoothstep(0.9, -0.25, y));
  vec2 sc = p - vec2(0.0, 0.35);
  float sun = smoothstep(0.42 + 0.06 * uBass * a, 0.38 + 0.06 * uBass * a, length(sc));
  sky = mix(sky, vec3(1.0, 0.55, 0.2), sun * 0.9);
  if (y >= 0.0) return sky;
  float z = 1.0 / -y;
  float gx = abs(fract(p.x * z * 0.5) - 0.5);
  float gz = abs(fract(z * 0.5 + t * 0.6) - 0.5);
  float w = 0.03 + 0.012 * z * 0.3;
  float line = max(smoothstep(w, 0.0, gx), smoothstep(w, 0.0, gz));
  vec3 gc = pal(0.55 + uHigh * a * 0.1) * line * clamp(1.4 - z * 0.06, 0.0, 1.0) * (1.0 + 0.5 * beatPulse() * a);
  return gc + vec3(0.02, 0.0, 0.05);
}`
    },
    {
      id: "voronoi", name: "Voronoi",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  vec2 q = p * 3.0;
  vec2 g = floor(q), f = fract(q);
  float md = 8.0; vec2 mid = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j));
    vec2 h = vec2(hash21(g + o), hash21(g + o + 7.3));
    h = 0.5 + 0.5 * sin(t * 0.8 + 6.28318 * h);
    float d = length(o + h - f);
    if (d < md) { md = d; mid = g + o; }
  }
  vec3 c = pal(hash21(mid) + t * 0.04);
  float core = smoothstep(0.55, 0.0, md);
  return c * (0.25 + 0.75 * core) * (0.8 + 0.5 * uBass * a);
}`
    },
    {
      id: "aurora", name: "Aurora",
      body: `vec3 fx(vec2 uv, vec2 p, float t){
  float a = uAudio;
  vec3 c = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    float y = sin(p.x * (1.0 + fi * 0.4) + t * (0.4 + fi * 0.1) + fi * 1.7) * (0.22 + uBass * a * 0.2) - 0.12 * fi + 0.25;
    float d = abs(p.y - y);
    c += pal(fi * 0.17 + p.x * 0.05 + t * 0.03) * (0.012 / (d + 0.012)) * 0.35;
  }
  return c * (0.7 + 0.5 * uLevel * a);
}`
    }
  ];

  function buildFragment(id) {
    const g = LIST.find((s) => s.id === id) || LIST[0];
    return HEADER + g.body + FOOTER;
  }

  // Programs that are not generators (solid colour, media quad, blend, output).
  const SOLID_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform vec3 uColor; uniform float uAmt;
void main(){ fragColor = vec4(uColor * mix(0.4, 1.6, uAmt), 1.0); }
`;

  // Media: sample a texture with cover-fit; uTexAspect = texW/texH. Straight alpha.
  const MEDIA_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTex; uniform vec2 uRes; uniform float uTexAspect, uHue, uAmt, uScale;
vec3 hueRot(vec3 c, float a){
  const vec3 k = vec3(0.57735);
  float ca = cos(a * 6.28318), sa = sin(a * 6.28318);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
void main(){
  float scr = uRes.x / uRes.y;
  vec2 uv = vUv - 0.5;
  if (scr > uTexAspect) uv.y *= uTexAspect / scr; else uv.x *= scr / uTexAspect;
  uv = uv / max(uScale, 0.05) + 0.5;
  vec4 s = texture(uTex, uv);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec3 c = hueRot(s.rgb, uHue) * mix(0.4, 1.6, uAmt);
  fragColor = vec4(clamp(c, 0.0, 1.0), s.a * inside);
}
`;

  const BLEND_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uBase, uTop; uniform float uOpacity; uniform int uMode;
vec3 blend(vec3 b, vec3 s){
  if (uMode == 1) return b + s;
  if (uMode == 2) return 1.0 - (1.0 - b) * (1.0 - s);
  if (uMode == 3) return b * s;
  if (uMode == 4) return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b));
  if (uMode == 5) return abs(b - s);
  if (uMode == 6) return max(b, s);
  if (uMode == 7) return min(b, s);
  return s;
}
void main(){
  vec3 b = texture(uBase, vUv).rgb;
  vec4 s = texture(uTop, vUv);
  vec3 r = clamp(blend(b, s.rgb), 0.0, 1.0);
  fragColor = vec4(mix(b, r, uOpacity * s.a), 1.0);
}
`;

  const OUT_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTex; uniform float uMaster;
void main(){ fragColor = vec4(texture(uTex, vUv).rgb * uMaster, 1.0); }
`;

  const VERT = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;


  // Custom (live-coded) generator: the user supplies fx(); same header/footer.
  function buildCustom(code) { return HEADER + String(code || "") + FOOTER; }

  // Crossfade between two layer renders (straight alpha). uHasPrev/uHasCur let one
  // side be "nothing" so fade-in from empty and fade-out to empty both work.
  const MIX_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uPrev, uCur; uniform float uP; uniform int uHasPrev, uHasCur;
void main(){
  vec4 a = uHasPrev == 1 ? texture(uPrev, vUv) : vec4(0.0);
  vec4 b = uHasCur == 1 ? texture(uCur, vUv) : vec4(0.0);
  float ca = mix(a.a, b.a, uP);
  vec3 pm = mix(a.rgb * a.a, b.rgb * b.a, uP);
  fragColor = vec4(pm / max(ca, 0.0001), ca);
}
`;

  // Separable blur: 9 taps, step in UV units per tap (set per axis by the caller).
  const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTex; uniform vec2 uStep;
void main(){
  vec4 c = texture(uTex, vUv) * 0.2270270270;
  c += texture(uTex, vUv + uStep * 1.3846153846) * 0.3162162162;
  c += texture(uTex, vUv - uStep * 1.3846153846) * 0.3162162162;
  c += texture(uTex, vUv + uStep * 3.2307692308) * 0.0702702703;
  c += texture(uTex, vUv - uStep * 3.2307692308) * 0.0702702703;
  fragColor = c;
}
`;

  // Single-pass per-layer effects. uType indices match clips.js FX_INDEX
  // (0 color, 1 transform, 2 mirror, 3 mosaic, 4 rgbsplit, [5 blur = BLUR_FRAG],
  // 6 trails, 7 invert). uP are already audio/LFO-modulated by the compositor.
  const FX_FRAG = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 fragColor;
uniform sampler2D uTex, uPrev; uniform vec2 uRes; uniform int uType; uniform vec4 uP;
const float PI = 3.14159265;
vec2 rot(vec2 q, float a){ float c = cos(a), s = sin(a); return vec2(c * q.x - s * q.y, s * q.x + c * q.y); }
vec4 samp(vec2 uv){
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  vec4 c = texture(uTex, clamp(uv, 0.0, 1.0));
  return vec4(c.rgb, c.a * inside);
}
void main(){
  float asp = uRes.x / uRes.y;
  vec2 uv = vUv;
  vec4 c;
  if (uType == 0) {                       // color
    c = texture(uTex, uv);
    float contrast = pow(3.0, (uP.y - 0.5) * 2.0);
    vec3 rgb = (c.rgb - 0.5) * contrast + 0.5 + (uP.x - 0.5);
    float g = dot(rgb, vec3(0.299, 0.587, 0.114));
    rgb = mix(vec3(g), rgb, uP.z * 2.0);
    c = vec4(clamp(rgb, 0.0, 1.0), c.a);
  } else if (uType == 1) {                // transform
    vec2 q = uv - 0.5; q.x *= asp;
    q -= vec2(uP.z - 0.5, uP.w - 0.5);
    q = rot(q, -uP.y * 2.0 * PI);
    q /= pow(4.0, (uP.x - 0.5) * 2.0);
    q.x /= asp;
    c = samp(q + 0.5);
  } else if (uType == 2) {                // mirror / kaleidoscope
    if (uP.x < 0.02) { c = texture(uTex, uv); }
    else {
      float n = 2.0 + floor(uP.x * 10.99);
      vec2 q = uv - 0.5; q.x *= asp;
      float r = length(q), ang = atan(q.y, q.x) + uP.y * 2.0 * PI;
      float seg = 2.0 * PI / n;
      ang = abs(mod(ang, seg) - seg * 0.5);
      q = r * vec2(cos(ang), sin(ang)); q.x /= asp;
      c = samp(q + 0.5);
    }
  } else if (uType == 3) {                // mosaic
    if (uP.x < 0.01) { c = texture(uTex, uv); }
    else {
      float cells = mix(240.0, 6.0, uP.x);
      vec2 g = vec2(cells * asp, cells);
      c = texture(uTex, (floor(uv * g) + 0.5) / g);
    }
  } else if (uType == 4) {                // rgb split
    vec2 d = vec2(cos(uP.y * 2.0 * PI), sin(uP.y * 2.0 * PI)) * uP.x * 0.04;
    d.x /= asp;
    vec4 m = texture(uTex, uv);
    c = vec4(texture(uTex, uv + d).r, m.g, texture(uTex, uv - d).b, m.a);
  } else if (uType == 6) {                // trails (feedback)
    vec4 cur = texture(uTex, uv), pv = texture(uPrev, uv);
    float d = uP.x * 0.97;
    c = vec4(max(cur.rgb, pv.rgb * d), max(cur.a, pv.a * d));
  } else {                                // 7 invert
    c = texture(uTex, uv);
    c.rgb = mix(c.rgb, 1.0 - c.rgb, uP.x);
  }
  fragColor = c;
}
`;

  const api = {
    LIST, ids: LIST.map((s) => s.id), buildFragment, buildCustom, HEADER, FOOTER,
    MIX_FRAG, BLUR_FRAG, FX_FRAG,
    VERT, SOLID_FRAG, MEDIA_FRAG, BLEND_FRAG, OUT_FRAG
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FirebirdShaders = api;
})(typeof window !== "undefined" ? window : this);
