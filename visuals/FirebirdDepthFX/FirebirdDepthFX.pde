/**
 * FirebirdDepthFX — Kinect depth-tracking projector layer for Firebird Show Control.
 *
 * Grabs the Kinect depth stream, isolates the performer with a near/far depth
 * window, and paints them with:
 *   - TRACERS  : a feedback buffer that fades each frame, so motion leaves trails.
 *   - HYPERCOLOR: hue driven by depth + time, so the silhouette shifts colour.
 *
 * Firebird controls it over OSC (see the CONTROL section) exactly like it drives
 * Blaize. MASTER BLACKOUT blanks this layer — blackout always wins over the camera.
 *
 * Requires (Processing 4):
 *   - Library "KinectPV2" (Sketch > Import Library > Add Library) for Kinect v2.
 *   - Library "oscP5" (same menu) for OSC.
 *   - Kinect for Windows SDK 2.0 + a USB3 port + the Xbox-One Kinect adapter.
 *
 * v1 (Xbox 360) instead? See the CAPTURE section below — swap KinectPV2 for the
 * "Open Kinect for Processing" library; only ~10 lines change. Nothing else moves.
 */

import KinectPV2.*;            // <-- CAPTURE (v2). For v1: import org.openkinect.processing.*;
import oscP5.*;
import netP5.*;

// ---- Output ---------------------------------------------------------------
final int DISPLAY = 2;         // projector display number (1 = primary). Change to 1 if single-screen.
final int OSC_PORT = 42073;    // must match FIREBIRD DEPTHFX_PORT

// ---- Effect state (driven by Firebird over OSC) ---------------------------
boolean blackout = false;      // Firebird master blackout -> blank this layer
boolean enabled  = true;
float   trails   = 0.85;       // 0..0.99 feedback persistence (higher = longer tracers)
float   colorSpeed = 1.0;      // hue cycle rate
float   near = 500, far = 2500;// depth window in mm that isolates the performer
boolean mirror = true;         // flip X so on-screen motion matches you

// ---- Internals ------------------------------------------------------------
KinectPV2 kinect;              // <-- CAPTURE (v2)
OscP5 oscP5;
PGraphics fx;                  // feedback/accumulation buffer
PImage silh;                   // this-frame silhouette
int dw, dh;                    // depth frame dimensions

void settings() {
  fullScreen(P2D, DISPLAY);
  // Prefer windowed while testing? Comment the line above and use: size(1280, 720, P2D);
}

void setup() {
  colorMode(HSB, 360, 100, 100, 255);
  frameRate(60);

  // ---- CAPTURE (v2): start the Kinect --------------------------------------
  kinect = new KinectPV2(this);
  kinect.enableDepthImg(true);
  kinect.init();
  dw = KinectPV2.WIDTHDepth;   // 512
  dh = KinectPV2.HEIGHTDepth;  // 424
  // For v1 (Open Kinect for Processing) this whole block becomes:
  //   kinect = new Kinect(this); kinect.initDepth(); dw = kinect.width; dh = kinect.height;
  // and getRawDepthData() below becomes kinect.getRawDepth().
  // --------------------------------------------------------------------------

  silh = createImage(dw, dh, ARGB);
  fx = createGraphics(1280, 720, P2D);
  fx.beginDraw(); fx.background(0); fx.endDraw();

  oscP5 = new OscP5(this, OSC_PORT);
  background(0);
}

void draw() {
  // Blackout / disabled => hard blank. Blackout wins over any camera input.
  if (blackout || !enabled) { background(0); return; }

  int[] depth = getDepth();            // CAPTURE-agnostic accessor (see below)
  if (depth == null || depth.length != dw * dh) { image(fx, 0, 0, width, height); return; }

  // 1) Build this frame's coloured silhouette from the depth window.
  silh.loadPixels();
  float hueBase = (frameCount * colorSpeed) % 360;
  for (int i = 0; i < depth.length; i++) {
    int d = depth[i];
    if (d >= near && d <= far) {
      float hue = ((map(d, near, far, 0, 360) + hueBase) % 360 + 360) % 360;
      silh.pixels[i] = color(hue, 90, 100, 255);   // HSB
    } else {
      silh.pixels[i] = color(0, 0, 0, 0);           // transparent
    }
  }
  silh.updatePixels();

  // 2) Fade the trail buffer a touch, then stamp the new silhouette on top.
  fx.beginDraw();
  fx.noStroke();
  fx.fill(0, (1.0 - trails) * 255);                 // RGB black w/ alpha = fade amount
  fx.rect(0, 0, fx.width, fx.height);
  fx.pushMatrix();
  if (mirror) { fx.translate(fx.width, 0); fx.scale(-1, 1); }
  fx.image(silh, 0, 0, fx.width, fx.height);
  fx.popMatrix();
  fx.endDraw();

  // 3) Blit the accumulated buffer to the projector.
  image(fx, 0, 0, width, height);
}

// ---- CAPTURE-agnostic depth accessor -------------------------------------
// Returns per-pixel depth in millimetres, or null if not ready yet.
int[] getDepth() {
  return kinect.getRawDepthData();          // v2
  // v1 (Open Kinect for Processing): return kinect.getRawDepth();
}

// ---- CONTROL (from Firebird over OSC on OSC_PORT) -------------------------
void oscEvent(OscMessage m) {
  String a = m.addrPattern();
  if      (a.equals("/depthfx/blackout"))   blackout   = m.get(0).intValue() == 1;
  else if (a.equals("/depthfx/enabled"))    enabled    = m.get(0).intValue() == 1;
  else if (a.equals("/depthfx/trails"))     trails     = constrain(m.get(0).floatValue(), 0, 0.99);
  else if (a.equals("/depthfx/colorspeed")) colorSpeed = m.get(0).floatValue();
  else if (a.equals("/depthfx/near"))       near       = m.get(0).floatValue();
  else if (a.equals("/depthfx/far"))        far        = m.get(0).floatValue();
  else if (a.equals("/depthfx/mirror"))     mirror     = m.get(0).intValue() == 1;
}

// ---- Local keys (for solo testing without Firebird) ----------------------
void keyPressed() {
  if (key == 'b' || key == 'B') blackout = !blackout; // simulate a blackout
  if (key == 'm' || key == 'M') mirror = !mirror;
  if (key == '[')  trails = constrain(trails - 0.05, 0, 0.99);
  if (key == ']')  trails = constrain(trails + 0.05, 0, 0.99);
}
