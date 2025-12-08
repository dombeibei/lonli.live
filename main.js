//--------------------------------------------------------
// lonli.live 0.1 (Map + Audio working)
// Patched to ensure Leaflet map displays correctly
//--------------------------------------------------------

// Hardcoded simulated transmitter
const transmitter = {
  lat: 51.0,
  lon: -0.1,
  power: 50000,
  frequency: 9.6
};

// DOM elements
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start-btn");
const signalLevelEl = document.getElementById("signal-level");

let userPos = null;
let audioCtx = null;
let noiseNode = null;
let stationNode = null;
let gainNode = null;

let running = false;

//--------------------------------------------------------
// MAP SETUP — Must occur after DOM loaded
//--------------------------------------------------------
let map = L.map('map', {
  zoomControl: true,
  attributionControl: true
}).setView([20, 0], 2); // initial world view until geolocation arrives

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 7,
  minZoom: 2,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let userMarker = null;
let txMarker = L.marker([transmitter.lat, transmitter.lon]).addTo(map);
txMarker.bindPopup(`Transmitter<br>${transmitter.frequency} MHz`);

//--------------------------------------------------------
// GEOLOCATION
//--------------------------------------------------------
navigator.geolocation.getCurrentPosition(
  pos => {
    userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    statusEl.textContent = `Location acquired: ${userPos.lat.toFixed(3)}, ${userPos.lon.toFixed(3)}`;
    startBtn.disabled = false;

    // Add user marker
    if (userMarker) map.removeLayer(userMarker);
    userMarker = L.marker([userPos.lat, userPos.lon]).addTo(map);
    userMarker.bindPopup("You");

    // Fit map bounds to show both markers
    const bounds = L.latLngBounds(
      [userPos.lat, userPos.lon],
      [transmitter.lat, transmitter.lon]
    );
    map.fitBounds(bounds, { padding: [40, 40] });

    // Force Leaflet to recalc size after layout settles
    setTimeout(() => { map.invalidateSize(); }, 200);
  },
  err => {
    statusEl.textContent = "Geolocation permission denied.";
  }
);

//--------------------------------------------------------
// Distance (Haversine)
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI/180;
  const dLon = (lon2 - lon1) * Math.PI/180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) *
            Math.cos(lat2*Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

//--------------------------------------------------------
// Signal Strength Model
function computeSignalStrength() {
  if (!userPos) return 0;

  const d = distanceKm(userPos.lat, userPos.lon, transmitter.lat, transmitter.lon);
  let base = transmitter.power / (d * d);
  base = base / 50000;

  const t = performance.now() / 1000;
  const slow = 0.85 + 0.15 * Math.sin(t * 0.5);
  const fast = 0.9 + 0.1 * Math.random();
  let
