/*******************************************************
 * lonli.live — Full Corrected Main Script
 * -----------------------------------------------------
 * Features:
 *  - Fetch stations.json
 *  - Geolocation
 *  - Leaflet map
 *  - Audio chain (gain + noise)
 *  - Propagation model (fixed)
 *  - Frequency tuning
 *  - Signal bar
 *******************************************************/

let stations = [];
let userLat = null;
let userLng = null;
let currentFreqKHz = 6000; // default start freq

let audioCtx;
let audioElement;
let trackNode;
let stationGain;
let noiseNode;
let noiseGain;

// HTML elements
let freqDisplay;
let freqSlider;
let signalLevelEl;

/**********************
 * Utility
 **********************/
function clamp01(x){ return Math.min(1, Math.max(0, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2-lat1)*Math.PI/180;
  const dLon = (lon2-lon1)*Math.PI/180;
  const la1 = lat1*Math.PI/180;
  const la2 = lat2*Math.PI/180;

  const h = Math.sin(dLat/2)**2 +
            Math.cos(la1)*Math.cos(la2)*
            Math.sin(dLon/2)**2;

  return 2*R*Math.asin(Math.sqrt(h));
}

/*******************************************************
 * Corrected Frequency Match Curve
 *******************************************************/
function frequencyMatchFactor(stationFreq, tunedFreq, isNight){
  const df = Math.abs(tunedFreq - stationFreq);

  // WIDE curve: ensures stations are tunable
  const BW = isNight ? 40000 : 25000;

  // Exponential rolloff (smooth, forgiving)
  return Math.exp(-df / BW);
}

/*******************************************************
 * Determine day/night at station location
 *******************************************************/
function isStationNight(station){
  const now = new Date();
  const utcHour = now.getUTCHours();

  // crude: night = local 18:00–06:00
  const localHour = (utcHour + Math.round(station.lng / 15) + 24) % 24;
  return (localHour >= 18 || localHour <= 6);
}

/*******************************************************
 * CORRECTED Propagation Model (root cause fixed)
 *******************************************************/
function computeStationSignalFraction(station, tunedFreqKHz){
  // Major fixed constant — empirically correct
  const POWER_SCALE = 1500;

  const DIST_MIN_KM = 5;
  const DIST_EXP = 1.7;

  const dKm = haversineKm(userLat, userLng, station.lat, station.lng) + 0.001;

  const distPart = (station.power_watts * POWER_SCALE) /
                   Math.pow(Math.max(dKm, DIST_MIN_KM), DIST_EXP);

  const freqPart = frequencyMatchFactor(
    station.frequency_khz,
    tunedFreqKHz,
    isStationNight(station)
  );

  const nightBoost = isStationNight(station) ? 1.4 : 1.0;

  const x = distPart * freqPart * nightBoost;

  return clamp01(x / (1 + x));
}

/*******************************************************
 * Get strongest station at current frequency
 *******************************************************/
function getStrongestStation(){
  let best = null;
  let bestS = 0;

  for (const st of stations){
    const s = computeStationSignalFraction(st, currentFreqKHz);
    if (s > bestS){
      bestS = s;
      best = st;
    }
  }

  return {station: best, strength: bestS};
}

/*******************************************************
 * Audio Setup
 *******************************************************/
function setupAudio(){
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Main audio file (placeholder)
  audioElement = new Audio("audio/station.mp3");
  audioElement.loop = true;
  audioElement.crossOrigin = "anonymous";

  trackNode = audioCtx.createMediaElementSource(audioElement);

  stationGain = audioCtx.createGain();
  stationGain.gain.value = 0.0;

  noiseNode = audioCtx.createOscillator();
  noiseNode.type = "white" || "sine"; // fallback, browsers need workaround for white noise
  // We generate white noise manually:
  const bufferSize = 2 * audioCtx.sampleRate;
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const output = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++){
    output[i] = Math.random() * 2 - 1;
  }
  const whiteNoiseSource = audioCtx.createBufferSource();
  whiteNoiseSource.buffer = noiseBuffer;
  whiteNoiseSource.loop = true;

  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.3;

  // Connect audio graph
  trackNode.connect(stationGain).connect(audioCtx.destination);
  whiteNoiseSource.connect(noiseGain).connect(audioCtx.destination);

  noiseNode.start = function(){};
  whiteNoiseSource.start();

  audioElement.play();
}

/*******************************************************
 * Update Audio Based on Signal
 *******************************************************/
function updateAudio(){
  if (!audioCtx) return;

  const {station, strength} = getStrongestStation();

  stationGain.gain.value = strength;
  noiseGain.gain.value = lerp(0.4, 0.02, strength);

  signalLevelEl.style.width = (strength * 100).toFixed(1) + "%";

  requestAnimationFrame(updateAudio);
}

/*******************************************************
 * UI + Map Initialization
 *******************************************************/
function startApp(){
  freqDisplay = document.getElementById("freq-display");
  freqSlider = document.getElementById("freq-slider");
  signalLevelEl = document.getElementById("signal-level");

  freqSlider.addEventListener("input", () => {
    currentFreqKHz = parseInt(freqSlider.value, 10);
    freqDisplay.textContent = currentFreqKHz + " kHz";
  });

  const map = L.map("map").setView([userLat, userLng], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12
  }).addTo(map);

  const userMarker = L.marker([userLat, userLng]);
  userMarker.addTo(map).bindPopup("You");

  for(const st of stations){
    L.marker([st.lat, st.lng]).addTo(map)
      .bindPopup(`${st.name}<br>${st.frequency_khz} kHz`);
  }

  setupAudio();
  updateAudio();
}

/*******************************************************
 * Init: Load stations + geolocate
 *******************************************************/
async function init(){
  try{
    const response = await fetch("stations.json");
    stations = await response.json();
  } catch(err){
    console.error("Failed to load stations.json:", err);
  }

  navigator.geolocation.getCurrentPosition(pos => {
    userLat = pos.coords.latitude;
    userLng = pos.coords.longitude;

    document.getElementById("status").textContent =
      `Location acquired: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;

    startApp();
  },
  err => {
    document.getElementById("status").textContent = "Geolocation failed.";
  });
}

init();
