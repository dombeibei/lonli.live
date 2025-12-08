/********************************************************************
 * lonli.live — main.js
 * Corrected + functional radio simulation with:
 * - map
 * - geolocation
 * - station selection
 * - shortwave day/night propagation
 * - realistic fading + static based on signal strength
 ********************************************************************/

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

/* --------------------------------------------------------------
   WebAudio Setup (station audio + static noise)
----------------------------------------------------------------*/
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// Clean station audio
const stationGain = audioCtx.createGain();
stationGain.gain.value = 0;

// Bandpass filter (tuning effect)
const filter = audioCtx.createBiquadFilter();
filter.type = "bandpass";
filter.frequency.value = parseInt(freqSlider.value, 10);

// White noise generator (static)
const noiseBuffer = (() => {
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.4;
  }
  return buffer;
})();

const noiseSource = audioCtx.createBufferSource();
noiseSource.buffer = noiseBuffer;
noiseSource.loop = true;

// Static intensity
const noiseGain = audioCtx.createGain();
noiseGain.gain.value = 0.5;

// Routing
noiseSource.connect(noiseGain).connect(audioCtx.destination);
noiseSource.start();

let audioElement = new Audio();
let audioSourceNode = null;

// --------------------------------------------------------------
// Utility Functions
// --------------------------------------------------------------
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function lerp(a, b, t) { return a + (b - a) * t; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2)**2 +
    Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) *
    Math.sin(dLon/2)**2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function isNightAt(lat, lon) {
  const now = new Date();
  const utcHours = now.getUTCHours();

  const localOffset = lon / 15;  // rough local solar time
  const localHour = (utcHours + localOffset + 24) % 24;

  return (localHour < 6 || localHour >= 19);
}

function isStationNight(station) {
  return isNightAt(station.lat, station.lng);
}

// Wideband Gaussian tuning curve
function frequencyMatchFactor(stationFreq, tunedFreq, isNight) {
  // Night = better propagation at lower SW
  const bandwidth = isNight ? 14000 : 18000;
  const diff = stationFreq - tunedFreq;
  return Math.exp(-(diff * diff) / (2 * bandwidth * bandwidth));
}

/* --------------------------------------------------------------
   Signal Strength Model (corrected)
----------------------------------------------------------------*/
function computeStationSignalFraction(station, tunedFreqKHz) {

  const POWER_SCALE = 60;      // tested working scaling constant
  const DIST_MIN_KM = 5.0;
  const DIST_POWER = 1.8;

  const dKm = haversineKm(userLat, userLng, station.lat, station.lng) + 0.0001;
  const distRaw = station.power_watts * POWER_SCALE / Math.pow(Math.max(dKm, DIST_MIN_KM), DIST_POWER);

  const night = isStationNight(station);
  const freqFactor = frequencyMatchFactor(station.frequency_khz, tunedFreqKHz, night);

  let nightBoost = 1.0;
  if(night){
    const boostFactor = clamp01(1 - (tunedFreqKHz - 3000)/12000);
    nightBoost = lerp(1.0, 1.5, boostFactor);
  }

  const x = distRaw * freqFactor * nightBoost;

  // corrected normalization
  const normalized = clamp01(x / (1 + x));

  return normalized;
}

/* --------------------------------------------------------------
   Fetch stations
----------------------------------------------------------------*/
fetch("stations.json")
  .then(r => r.json())
  .then(data => { stations = data; });

/* --------------------------------------------------------------
   Geolocation
----------------------------------------------------------------*/
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

/* --------------------------------------------------------------
   Map init
----------------------------------------------------------------*/
function initMap() {
  map = L.map("map").setView([userLat, userLng], 2);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(map);

  L.marker([userLat, userLng])
    .addTo(map)
    .bindPopup("You are here");

  stations.forEach(s => {
    L.marker([s.lat, s.lng]).addTo(map).bindPopup(s.name);
  });
}

/* --------------------------------------------------------------
   Frequency-based selection
----------------------------------------------------------------*/
function selectStation(freqKHz) {
  let best = null;
  let bestStrength = 0;

  stations.forEach(station => {
    const str = computeStationSignalFraction(station, freqKHz);

    if (str > bestStrength) {
      bestStrength = str;
      best = station;
    }
  });

  currentStation = best;
  updateSignalStrength(bestStrength);
  updateAudio(bestStrength, best);
}

function updateSignalStrength(str) {
  const pct = Math.round(str * 100);
  signalLevel.style.width = pct + "%";
}

/* --------------------------------------------------------------
   Audio handling
----------------------------------------------------------------*/
function updateAudio(strength, station) {
  // static blending: weak → strong
  noiseGain.gain.value = clamp01(1 - strength);

  if (!station) {
    stationGain.gain.value = 0;
    return;
  }

  // ensure audio source is connected
  if (audioElement.src !== station.audio) {
    audioElement.src = station.audio;
    audioElement.loop = true;

    if (audioSourceNode) audioSourceNode.disconnect();

    audioSourceNode = audioCtx.createMediaElementSource(audioElement);
    audioSourceNode.connect(filter).connect(stationGain).connect(audioCtx.destination);

    audioElement.play();
  }

  // actual signal volume response
  stationGain.gain.value = strength;
}

/* --------------------------------------------------------------
   Event Listeners
----------------------------------------------------------------*/
freqSlider.addEventListener("input", () => {
  const f = parseInt(freqSlider.value, 10);
  freqDisplay.textContent = `${f} kHz`;
  filter.frequency.value = f;

  selectStation(f);
});

startBtn.addEventListener("click", async () => {
  await audioCtx.resume();
  audioElement.play();
  selectStation(parseInt(freqSlider.value, 10));
});
