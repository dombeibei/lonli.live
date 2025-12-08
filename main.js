/**
 * lonli.live v0.1.0
 * --------------------------------------------------------
 * Handles:
 * - Geolocation
 * - Map initialization
 * - Signal strength simulation
 * - Radio audio playback
 * --------------------------------------------------------
 */

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start-btn");
const signalLevel = document.getElementById("signal-level");

let userLat = null;
let userLng = null;
let map = null;
let signalInterval = null;

// Optional audio (this will auto-load from /audio/station.mp3)
const radioAudio = new Audio("audio/station.mp3");
radioAudio.loop = true;  // Continuous playback


// ---------------------------------------------------------
// 1. Request Geolocation
// ---------------------------------------------------------
navigator.geolocation.getCurrentPosition(
  (pos) => {
    userLat = pos.coords.latitude;
    userLng = pos.coords.longitude;

    statusEl.textContent =
      `Your location: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;

    startBtn.disabled = false;
    initMap();
  },
  (err) => {
    statusEl.textContent = "Geolocation failed or denied.";
  }
);


// ---------------------------------------------------------
// 2. Initialize Leaflet Map
// ---------------------------------------------------------
function initMap() {
  map = L.map("map").setView([userLat, userLng], 11);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19
  }).addTo(map);

  L.marker([userLat, userLng]).addTo(map)
    .bindPopup("You are here.")
    .openPopup();
}


// ---------------------------------------------------------
// 3. Start Radio Simulation
// ---------------------------------------------------------
startBtn.addEventListener("click", () => {
  statusEl.textContent = "Radio active…";

  // Start audio if available
  try {
    radioAudio.play();
  } catch (e) {
    console.warn("Audio could not play automatically.");
  }

  // Begin simulated signal updates
  signalInterval = setInterval(updateSignalStrength, 1000);
});


// ---------------------------------------------------------
// 4. Signal Strength Logic
// ---------------------------------------------------------
function updateSignalStrength() {
  // Example random noise simulation (placeholder)
  const strength = Math.floor(Math.random() * 100);

  signalLevel.style.width = strength + "%";
}
