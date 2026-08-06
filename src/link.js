// Ableton Link — network tempo/beat sync used by Ableton Live, Traktor, many DJ
// apps and lighting tools. This makes Firebird's "Ableton is the clock" claim
// work the industry-standard way: any Link peer on the LAN shares tempo.
//
// Optional native module: `npm install abletonlink` (a native addon). This loads
// it lazily and DEGRADES GRACEFULLY — if it isn't installed, Firebird runs exactly
// as before and reports Link unavailable. OSC clocking still works either way.

let AbletonLink = null;
let link = null;
const status = { available: false, enabled: false, peers: 0, bpm: 0, error: "" };

function start(config, onTempo) {
  if (!config.ABLETON_LINK_ENABLED) return status;
  try {
    AbletonLink = require("abletonlink");
  } catch (error) {
    status.error = "abletonlink not installed — `npm install abletonlink`";
    return status;
  }
  try {
    link = new AbletonLink();
    if (typeof link.enable === "function") link.enable();
    status.available = true;
    status.enabled = true;
    link.startUpdate(50, (_beat, _phase, bpm) => {
      status.bpm = Math.round(bpm);
      status.peers = typeof link.numPeers === "number" ? link.numPeers : (link.numPeers ? link.numPeers() : 0);
      if (onTempo) onTempo(status.bpm);
    });
  } catch (error) {
    status.error = error && error.message ? error.message : "Link failed to start";
  }
  return status;
}

// Push Firebird's tempo out to the Link session (e.g. from a tap or manual BPM).
function setBpm(bpm) {
  if (!link) return;
  try { link.bpm = Number(bpm); } catch {}
}

function getStatus() { return { ...status }; }

module.exports = { start, setBpm, getStatus };
