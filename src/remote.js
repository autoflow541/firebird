// Phone / browser remote. This is a CONTROL SURFACE, not the operator console:
// it can engage a blackout (the safe direction) but cannot release one, cannot
// arm the laser, and cannot open the projector. Those stay at the local desktop.

// The per-session token is carried in the page URL (?t=...). Every request must
// present it; the server rejects anything without it.
const TOKEN = new URLSearchParams(location.search).get("t") || "";
let state;

const send = (action, value) =>
  fetch(`/command?t=${encodeURIComponent(TOKEN)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Firebird-Token": TOKEN },
    body: JSON.stringify({ action, value })
  });

const format = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;

const online = document.querySelector(".online");
const es = new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`);
// EventSource auto-reconnects; surface the state so the performer knows if the
// link drops (Wi-Fi roam, bridge restart) rather than trusting a stale screen.
es.onopen = () => { if (online) { online.textContent = "● LIVE"; online.classList.remove("offline"); } };
es.onerror = () => { if (online) { online.textContent = "● RECONNECTING…"; online.classList.add("offline"); } };
es.onmessage = ({ data }) => {
  state = JSON.parse(data);
  document.querySelector("#remoteScene").textContent = state.blackout ? "BLACKOUT" : state.scene;
  document.querySelector("#remoteTime").textContent = `${format(state.elapsed)} · ${state.bpm} BPM`;
  document.querySelector("#remotePlay").textContent = state.playing ? "Ⅱ" : "▶";
  document.querySelector("#remoteMaster").value = state.master;
  document.querySelector("#remoteLevel").textContent = `${state.master}%`;
  const blackoutBtn = document.querySelector("#remoteBlackout");
  blackoutBtn.classList.toggle("active", state.blackout);
  blackoutBtn.textContent = state.blackout ? "BLACKOUT ENGAGED · release at console" : "MASTER BLACKOUT";
  document.querySelectorAll("[data-scene]").forEach((button) => button.classList.toggle("active", button.dataset.scene === state.scene));
};

document.querySelector(".remote-scenes").onclick = (event) => {
  const button = event.target.closest("[data-scene]");
  if (button) send("scene", button.dataset.scene);
};
// Engage-only. Releasing a blackout is a deliberate local-operator action.
document.querySelector("#remoteBlackout").onclick = () => send("blackout", true);
document.querySelector("#remotePlay").onclick = () => send("togglePlay");
document.querySelector("#remoteBack").onclick = () => send("stepCue", -1);
document.querySelector("#remoteGo").onclick = () => send("stepCue", 1);
document.querySelector("#remoteMaster").oninput = (event) => send("master", event.target.value);
