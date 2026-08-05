// Firebird stream view — an OBS Browser Source. Renders a live lower-third (song
// / scene / BPM) over a transparent background, plus an optional moving scene
// background with ?bg=1. Updates live over SSE. Token comes from the page URL.
//
// In OBS: add a Browser Source pointing at the /stream URL the operator shows
// (include ?t=<token>; add &bg=1 for a full background layer).

const params = new URLSearchParams(location.search);
const TOKEN = params.get("t") || "";
if (params.get("bg") === "1") document.querySelector("#bg").classList.add("on");

const colors = { INTRO: "#ee3659", HEAVY: "#f04a31", BREAKDOWN: "#856cff", AMBIENT: "#4ed6cc", BLACKOUT: "#000" };

new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`).onmessage = ({ data }) => {
  const state = JSON.parse(data);
  document.body.classList.toggle("blackout", state.blackout);
  document.querySelector("#song").textContent = state.song || "Firebird";
  document.querySelector("#sub").textContent = `${state.blackout ? "BLACKOUT" : state.scene} · ${state.bpm} BPM`;
  const bg = document.querySelector("#bg");
  if (bg.classList.contains("on")) {
    bg.style.background = state.blackout
      ? "#000"
      : `radial-gradient(circle at 50% 55%, ${colors[state.scene] || "#482033"}55, transparent 32%), radial-gradient(circle at 50% 50%, #160c12, #000 70%)`;
  }
};
