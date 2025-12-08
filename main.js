//--------------------------------------------------------
// MVP Shortwave Radio Simulator
//--------------------------------------------------------

// Hardcoded simulated transmitter
const transmitter = {
  lat: 51.0,      // Example: 51°N (London-ish)
  lon: -0.1,      // Example: 0.1°W
  power: 50000,   // Arbitrary power value
  frequency: 9.6  // MHz
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
// Step 1: Get geolocation
//--------------------------------------------------------
navigator.geolocation.getCurrentPosition(
  pos => {
    userPos = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude
    };
    statusEl.textContent = `Location acquired: ${userPos.lat.toFixed(3)}, ${userPos.lon.toFixed(3)}`;
    startBtn.disabled = false;
  },
  err => {
    statusEl.textContent = "Geolocation permission denied. Cannot simulate propagation.";
  }
);

//--------------------------------------------------------
// Utility: Haversine distance (km)
//--------------------------------------------------------
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
// MVP Propagation Model
// - distance attenuation
// - simple random fading
// - optional time-of-day factor
//--------------------------------------------------------
function computeSignalStrength() {
  if (!userPos) return 0;

  // Distance
  const d = distanceKm(userPos.lat, userPos.lon, transmitter.lat, transmitter.lon);

  // Base path loss (very rough)
  let base = transmitter.power / (d * d);

  // Normalise
  base = base / 50000;

  // Fading (slow amplitude wobble + random dips)
  const t = performance.now() / 1000;
  const slowWobble = 0.85 + 0.15 * Math.sin(t * 0.5);
  const randomDip = 0.9 + 0.1 * Math.random();

  let fading = slowWobble * randomDip;

  // Time of day effect (simple: night better for ~10 MHz)
  const hour = new Date().getUTCHours();
  const nightBoost = (hour >= 18 || hour <= 6) ? 1.3 : 0.7;

  let signal = base * fading * nightBoost;

  // Clamp 0–1
  signal = Math.max(0, Math.min(1, signal));
  return signal;
}

//--------------------------------------------------------
// Audio: Create noise + station audio loop
//--------------------------------------------------------
async function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Noise source
  const bufferSize = 2 * audioCtx.sampleRate;
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.4;
  }
  noiseNode = audioCtx.createBufferSource();
  noiseNode.buffer = noiseBuffer;
  noiseNode.loop = true;

  // Load station audio file
  const audioFile = await fetch('audio/station.mp3');
  const audioArray = await audioFile.arrayBuffer();
  const stationBuffer = await audioCtx.decodeAudioData(audioArray);

  stationNode = audioCtx.createBufferSource();
  stationNode.buffer = stationBuffer;
  stationNode.loop = true;

  // Gain
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;

  // Connect
  noiseNode.connect(gainNode);
  stationNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  noiseNode.start();
  stationNode.start();
}


//--------------------------------------------------------
// Animation loop: update gain + UI
//--------------------------------------------------------
function update() {
  if (!running) return;

  const signal = computeSignalStrength();

  // UI update
  signalLevelEl.style.width = (signal * 100).toFixed(1) + "%";

  // Audio update
  if (gainNode) {
    // mix of noise vs station
    const noiseAmount = 1 - signal;
    const stationAmount = signal;

    gainNode.gain.value = 0.2 + stationAmount * 0.8; 
  }

  requestAnimationFrame(update);
}

//--------------------------------------------------------
// Start Button
//--------------------------------------------------------
startBtn.addEventListener("click", () => {
  if (running) return;

  statusEl.textContent = "Starting radio…";
  running = true;
  startBtn.disabled = true;

  startAudio();
  update();

  statusEl.textContent = `Tuned to ${transmitter.frequency} MHz`;
});
