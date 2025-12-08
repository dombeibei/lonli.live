let userLat = null;
let userLng = null;

let map = null;
let stations = [];
let currentStation = null;

const statusEl = document.getElementById("status");
const startBtn = document.getElementById("start-btn");
const freqSlider = document.getElementById("freq");
const freqDisplay = document.getElementById("freq-display");
const signalLevel = document.getElementById("signal-level");

// WebAudio Pipeline ------------------------------------
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const gainNode = audioCtx.createGain();
const filter = audioCtx.createBiquadFilter();

gainNode.gain.value = 0;
filter.type = "bandpass";
filter.frequency.value = 10000; // default frequency

filter.connect(gainNode).connect(audioCtx.destination);

let audioElement = new Audio();
let audioSource = null;

// -------------------------------------------------------
// Load transmitters
fetch("stations.json")
  .then(r => r.json())
  .then(data => { stations = data; });

// -------------------------------------------------------
// Geolocation
navigator.geolocation.getCurrentPosition(
  pos => {
    userLat = pos.coords.latitude;
    userLng = pos.coords.longitude;

    statusEl.textContent =
      `Your location: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;

    startBtn.disabled = false;
    initMap();
  },
  err => {
    statusEl.textContent = "Geolocation failed.";
  }
);

// -------------------------------------------------------
// Map
function initMap() {
  map = L.map("map").setView([userLat, userLng], 3);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

  L.marker([userLat, userLng]).addTo(map)
    .bindPopup("You are here.")
    .openPopup();

  stations.forEach(s => {
    L.marker([s.lat, s.lng]).addTo(map).bindPopup(s.name);
  });
}

// -------------------------------------------------------
// Frequency tuning
freqSlider.addEventListener("input", () => {
  const f = parseInt(freqSlider.value, 10);
  freqDisplay.textContent = `${f} kHz`;
  filter.frequency.value = f;
  selectStation(f);
});

// -------------------------------------------------------
// Select station with strongest signal at this frequency
function selectStation(frequency) {
  let best = null;
  let bestStrength = 0;

  stations.forEach(s => {
    const df = Math.abs(s.freq - frequency);
    const tunedPenalty = Math.max(0, 1 - df / 3000); // within 3 kHz = strong

    const distance = haversine(userLat, userLng, s.lat, s.lng);
    const distancePenalty = 1 / Math.max(distance, 1);

    const strength = tunedPenalty * distancePenalty * (s.power / 10000);

    if (strength > bestStrength) {
      bestStrength = strength;
      best = s;
    }
  });

  currentStation = best;

  updateSignalBar(bestStrength);
  updateAudio(best);
}

function updateSignalBar(str) {
  const pct = Math.min(100, Math.max(0, str * 100));
  signalLevel.style.width = pct + "%";
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
    Math.sin(dLon/2)**2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// -------------------------------------------------------
// Audio control
function updateAudio(station) {
  if (!station) {
    gainNode.gain.value = 0;
    return;
  }

  if (audioElement.src !== station.audio) {
    audioElement.src = station.audio;
    audioElement.loop = true;

    if (audioSource) audioSource.disconnect();
    audioSource = audioCtx.createMediaElementSource(audioElement);
    audioSource.connect(filter);

    if (!audioElement.paused) audioElement.play();
  }

  gainNode.gain.value = 0.8;
}

// -------------------------------------------------------
startBtn.addEventListener("click", async () => {
  await audioCtx.resume();
  audioElement.play();
  selectStation(parseInt(freqSlider.value, 10));
});
