//--------------------------------------------------------
// lonli.live 0.1 MVP — Audio MP3 + geolocation
//--------------------------------------------------------

// Simulated transmitter
const transmitter = { lat: 51.0, lon: -0.1, power: 50000, frequency: 9.6 };

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
// Distance (Haversine)
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) *
            Math.cos(lat2*Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

//--------------------------------------------------------
// Signal strength
function computeSignalStrength() {
  if (!userPos) return 0;
  const d = distanceKm(userPos.lat, userPos.lon, transmitter.lat, transmitter.lon);
  let base = transmitter.power / (d*d) / 50000;

  const t = performance.now() / 1000;
  const slow = 0.85 + 0.15 * Math.sin(t*0.5);
  const fast = 0.9 + 0.1 * Math.random();
  const hour = new Date().getUTCHours();
  const nightBoost = (hour >= 18 || hour <= 6) ? 1.3 : 0.7;

  return Math.max(0, Math.min(1, base * slow * fast * nightBoost));
}

//--------------------------------------------------------
// Audio setup
async function startAudio() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Noise
  const bufferSize = 2 * audioCtx.sampleRate;
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.4;
  }
  noiseNode = audioCtx.createBufferSource();
  noiseNode.buffer = noiseBuffer;
  noiseNode.loop = true;

  // Station MP3
  const audioFile = await fetch('audio/station.mp3');
  const audioArray = await audioFile.arrayBuffer();
  const stationBuffer = await audioCtx.decodeAudioData(audioArray);

  stationNode = audioCtx.createBufferSource();
  stationNode.buffer = stationBuffer;
  stationNode.loop = true;

  // Gain
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;

  noiseNode.connect(gainNode);
  stationNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  noiseNode.start();
  stationNode.start();
}

//--------------------------------------------------------
// Update loop
function update() {
  if (!running) return;
  const signal = computeSignalStrength();
  signalLevelEl.style.width = (signal * 100).toFixed(1) + "%";
  if (gainNode) gainNode.gain.value = 0.2 + signal*0.8;
  requestAnimationFrame(update);
}

//--------------------------------------------------------
// Start button
startBtn.addEventListener("click", () => {
  if (running) return;
  running = true;
  statusEl.textContent = "Requesting location…";

  if ("geolocation" in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        statusEl.textContent = `Location acquired: ${userPos.lat.toFixed(3)}, ${userPos.lon.toFixed(3)}`;

        startAudio();
        update();

        statusEl.textContent = `Tuned to ${transmitter.frequency} MHz`;
        startBtn.disabled = true;
      },
      err => {
        statusEl.textContent = "Geolocation permission denied or unavailable.";
        running = false;
      }
    );
  } else {
    statusEl.textContent = "Geolocation not supported by your browser.";
    running = false;
  }
});
