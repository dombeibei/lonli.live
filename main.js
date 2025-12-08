/**
 * main.js — lonli.live (final)
 *
 * Features:
 * - station DB (stations.json)
 * - geolocation & Leaflet map
 * - corrected propagation model (day/night bias)
 * - retro UI (dial readout)
 * - scanning/seek (auto sweep and lock-on)
 * - ionospheric fading (QSB) as LFO + stochastic modulation
 * - realistic static (noise) and fading (station gain & filter)
 *
 * Notes:
 * - All demo stations use a local demo audio file at audio/station.mp3.
 * - The propagation model is heuristic and tuned for interactive behavior.
 */

/* ------------------------------
   DOM references & initial state
   ------------------------------ */
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const scanBtn = document.getElementById('scan-btn');

const freqRange = document.getElementById('freq');
const freqNumber = document.getElementById('freq-number');
const freqReadout = document.getElementById('freq-readout');
const dialNeedle = document.getElementById('dial-needle');

const signalLevelEl = document.getElementById('signal-level');
const nearestEl = document.getElementById('nearest');

let userLat = null, userLng = null;
let stations = [];
let map = null, markersLayer = null;

/* ------------------------------
   Audio setup
   ------------------------------ */
let audioCtx = null;
const audioElement = document.getElementById('radio-audio');

let stationSource = null;
let stationFilter = null; // creative bandpass shaping
let stationGain = null;

let masterGain = null;

// Static noise
let noiseSource = null;
let noiseGain = null;
let noiseFilter = null;

// QSB (fading) oscillator
let qsbOsc = null;
let qsbGain = null; // controls depth of QSB added to stationGain

// scan state
let scanning = false;
let scanTimer = null;
let updateTimer = null;

/* ------------------------------
   Utility functions
   ------------------------------ */
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function toFixedInt(x){ return Math.round(x); }

/* Haversine distance (km) */
function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const toR = Math.PI/180;
  const dLat = (lat2-lat1)*toR;
  const dLon = (lon2-lon1)*toR;
  const a = Math.sin(dLat/2)*Math.sin(dLat/2) +
            Math.cos(lat1*toR)*Math.cos(lat2*toR) *
            Math.sin(dLon/2)*Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/* ------------------------------
   Propagation & frequency matching
   ------------------------------ */
function isStationNight(station){
  const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  const offset = station.lng / 15.0;
  let local = nowUtcH + offset;
  local = ((local % 24) + 24) % 24;
  return (local < 6) || (local >= 18);
}

/* Gaussian-like frequency match; wider bandwidth for day */
function frequencyMatchFactor(stationFreqKHz, tunedFreqKHz, stationIsNight){
  const bandwidth = stationIsNight ? 14000 : 18000; // kHz artistic
  const delta = stationFreqKHz - tunedFreqKHz;
  return Math.exp(- (delta * delta) / (2 * bandwidth * bandwidth));
}

/* Main signal fraction (0..1) */
function computeStationSignalFraction(station, tunedFreqKHz){
  const POWER_SCALE = 60;      // tuned constant for demo
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

  const normalized = clamp01(x / (1 + x));
  return normalized;
}

/* ------------------------------
   Audio graph creation
   ------------------------------ */
function initAudioGraph(){
  if(audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // station nodes
  stationSource = audioCtx.createMediaElementSource(audioElement);
  stationFilter = audioCtx.createBiquadFilter();
  stationFilter.type = 'bandpass';
  stationFilter.Q.value = 1.0;
  stationGain = audioCtx.createGain();
  stationGain.gain.value = 0;

  // noise nodes
  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.6;
  noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 7000;

  // master
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  // connect station: source -> filter -> stationGain -> master
  stationSource.connect(stationFilter);
  stationFilter.connect(stationGain);
  stationGain.connect(masterGain);

  // noise: generate buffer source and loop
  const buffer = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for(let i=0;i<data.length;i++){
    data[i] = (Math.random() * 2 - 1) * 0.4;
  }
  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = buffer;
  noiseSource.loop = true;
  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);

  // QSB oscillator: low-rate LFO to modulate stationGain
  qsbOsc = audioCtx.createOscillator();
  qsbGain = audioCtx.createGain();
  qsbGain.gain.value = 0.0; // depth will be set dynamically
  qsbOsc.type = 'sine';
  qsbOsc.frequency.value = 0.25; // base slow fading (0.1-1 Hz)
  qsbOsc.connect(qsbGain);
  // Connect LFO output to stationGain.gain AudioParam (adds to gain)
  qsbGain.connect(stationGain.gain);

  // master -> destination
  masterGain.connect(audioCtx.destination);

  // start noise and LFO
  noiseSource.start(0);
  qsbOsc.start(0);
}

/* ------------------------------
   Station selection & UI
   ------------------------------ */
function findBestStation(freqKHz){
  if(!stations || stations.length === 0) return {station:null, fraction:0};
  let best = null;
  let bestFrac = 0;
  for(const s of stations){
    const frac = computeStationSignalFraction(s, freqKHz);
    if(frac > bestFrac){ bestFrac = frac; best = s; }
  }
  return {station: best, fraction: bestFrac};
}

function updateUIForStation(station, fraction, freqKHz){
  const pct = Math.round(fraction * 100);
  signalLevelEl.style.width = pct + '%';
  nearestEl.textContent = station ? `${station.label} — ${station.frequency_khz} kHz — ${pct}%` : 'Nearest: —';

  // update dial needle: map 150..30000 kHz to -50deg..50deg
  const min = 150, max = 30000;
  const angle = lerp(-50, 50, clamp01((freqKHz - min)/(max - min)));
  dialNeedle.style.transform = `rotate(${angle}deg)`;

  freqReadout.textContent = `${toFixedInt(freqKHz)} kHz`;
}

/* ------------------------------
   Apply audio params (station gain, noise, QSB)
   ------------------------------ */
function applyAudioParams(freqKHz, station, fraction){
  if(!audioCtx) return;

  // Mapping of tuned freq to creative filter frequency (Hz)
  const filterHz = Math.max(500, freqKHz * 10); // artistic mapping
  stationFilter.frequency.setTargetAtTime(filterHz, audioCtx.currentTime, 0.05);

  // Station base volume: scaled with fraction (with slight curve)
  const stationVol = clamp01(Math.pow(fraction, 0.9) * 1.0);
  stationGain.gain.setTargetAtTime(stationVol, audioCtx.currentTime, 0.05);

  // Noise level: inversely proportional to signal
  const noiseLevel = clamp01(lerp(0.9, 0.02, fraction)); // weak signal -> lots of noise
  noiseGain.gain.setTargetAtTime(noiseLevel, audioCtx.currentTime, 0.05);

  // Noise filter: let more treble through when weak
  const noiseCut = lerp(9000, 2000, fraction);
  noiseFilter.frequency.setTargetAtTime(noiseCut, audioCtx.currentTime, 0.12);

  // QSB: set depth and rate based on conditions
  const baseDepth = clamp01(1 - fraction); // weaker -> deeper QSB
  // Add a small randomness factor (stochastic scintillation)
  const stochastic = Math.random() * 0.3;
  const qsbDepth = clamp01(baseDepth * (0.6 + stochastic)); // 0..1

  // Map qsbDepth to gain (we add/subtract around stationGain)
  // qsbGain should produce a small +/- amplitude (so scale down)
  qsbGain.gain.setTargetAtTime(qsbDepth * 0.6 * stationVol, audioCtx.currentTime, 0.05);

  // QSB rate: slower when strong, faster when weak
  const qsbRate = lerp(0.08, 1.2, qsbDepth); // 0.08 Hz -> 1.2 Hz
  qsbOsc.frequency.setTargetAtTime(qsbRate, audioCtx.currentTime, 0.1);
}

/* ------------------------------
   Map & station markers
   ------------------------------ */
async function initMap(){
  map = L.map('map').setView([userLat, userLng], 3);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(map);

  markersLayer = L.layerGroup().addTo(map);
  L.circleMarker([userLat, userLng], {radius:6, color:'#cfa24a'}).addTo(markersLayer).bindPopup('You');

  for(const s of stations){
    const m = L.marker([s.lat, s.lng]).addTo(markersLayer).bindPopup(`${s.label}<br>${s.frequency_khz} kHz<br>Power: ${s.power_watts} W`);
  }
  map.fitBounds(markersLayer.getBounds(), {padding:[30,30]});
}

/* ------------------------------
   Start / Stop / Periodic update
   ------------------------------ */
function startRadio(){
  initAudioGraph();
  audioCtx.resume().then(()=>{
    audioElement.loop = true;
    audioElement.play().catch(e => console.warn('audio play blocked', e));
  });

  startBtn.disabled = true;
  stopBtn.disabled = false;
  scanBtn.disabled = false;

  // immediate update + periodic refresh
  const freq = Number(freqNumber.value);
  const result = findAndApply(freq);
  updateUIForStation(result.station, result.fraction, freq);

  if(updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(()=>{
    const f = Number(freqNumber.value);
    const r = findAndApply(f);
    updateUIForStation(r.station, r.fraction, f);
  }, 800);
}

function stopRadio(){
  if(updateTimer){ clearInterval(updateTimer); updateTimer = null; }
  if(scanTimer){ clearInterval(scanTimer); scanTimer = null; scanning = false; }
  // fade out audio nodes
  if(audioCtx && stationGain) stationGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
  if(noiseGain) noiseGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
  try{ audioElement.pause(); }catch(e){}
  startBtn.disabled = false;
  stopBtn.disabled = true;
  scanBtn.disabled = false;
}

/* Find best station and apply audio */
function findAndApply(freqKHz){
  const best = findBestStation(freqKHz);
  const station = best.station;
  const fraction = best.fraction;

  // If station switched, change audio source (simple switch; same demo audio used here)
  if(station){
    if(audioElement.src.indexOf(station.audio) === -1){
      audioElement.src = station.audio;
      audioElement.loop = true;
      try{ audioElement.play(); }catch(e){}
    }
  }

  applyAudioParams(freqKHz, station, fraction);
  return best;
}

/* Helper: find best station for given freq */
function findBestStation(freqKHz){
  if(!stations || stations.length === 0) return {station:null, fraction:0};
  let best = null, bestF = 0;
  for(const s of stations){
    const f = computeStationSignalFraction(s, freqKHz);
    if(f > bestF){ bestF = f; best = s; }
  }
  return {station: best, fraction: bestF};
}

/* ------------------------------
   Scanning / Seek
   ------------------------------ */
let scanStepKHz = 100; // default
const MIN_FREQ = Number(freqRange.min);
const MAX_FREQ = Number(freqRange.max);
const SCAN_THRESHOLD = 0.18; // fraction above which scan locks onto station

function startScan(){
  if(scanning) return;
  scanning = true;
  scanBtn.textContent = 'Scanning...';
  // sweep up from current freq
  let pos = Number(freqNumber.value);
  const dir = 1;
  scanTimer = setInterval(()=>{
    pos += dir * scanStepKHz;
    if(pos > MAX_FREQ) pos = MIN_FREQ;
    // update UI slider/number
    freqRange.value = pos;
    freqNumber.value = pos;
    freqReadout.textContent = `${toFixedInt(pos)} kHz`;
    // check for signal
    const b = findBestStation(pos);
    updateUIForStation(b.station, b.fraction, pos);
    applyAudioParams(pos, b.station, b.fraction);

    if(b.fraction >= SCAN_THRESHOLD){
      // lock onto station and stop scanning
      stopScan();
    }
  }, 180); // scanning step interval
}

function stopScan(){
  if(!scanning) return;
  scanning = false;
  if(scanTimer){ clearInterval(scanTimer); scanTimer = null; }
  scanBtn.textContent = 'Scan/Seek';
}

/* ------------------------------
   UI wiring & startup
   ------------------------------ */
freqRange.addEventListener('input', () => {
  freqNumber.value = freqRange.value;
  freqReadout.textContent = `${toFixedInt(freqRange.value)} kHz`;
  // immediate update while dragging
  const f = Number(freqRange.value);
  const r = findAndApply(f);
  updateUIForStation(r.station, r.fraction, f);
});

freqNumber.addEventListener('change', () => {
  let v = Number(freqNumber.value);
  if(isNaN(v)) v = Number(freqRange.value);
  v = Math.max(MIN_FREQ, Math.min(MAX_FREQ, v));
  freqNumber.value = v;
  freqRange.value = v;
  freqReadout.textContent = `${toFixedInt(v)} kHz`;
  const r = findAndApply(v);
  updateUIForStation(r.station, r.fraction, v);
});

startBtn.addEventListener('click', () => startRadio());
stopBtn.addEventListener('click', () => stopRadio());
scanBtn.addEventListener('click', () => {
  if(scanning) stopScan(); else startScan();
});

/* ------------------------------
   Boot: load stations & geolocation
   ------------------------------ */
async function loadStations(){
  try{
    const res = await fetch('stations.json', {cache:'no-store'});
    stations = await res.json();
    console.log('stations loaded', stations);
  }catch(e){
    console.error('failed to load stations.json', e);
    stations = [];
  }
}

(async function boot(){
  await loadStations();

  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(pos=>{
      userLat = pos.coords.latitude; userLng = pos.coords.longitude;
      statusEl.textContent = `Location: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;
      startBtn.disabled = false;
      scanBtn.disabled = false;
      initMap();
    }, err=>{
      console.warn('geolocation failed', err);
      userLat = 51.5074; userLng = -0.1278; // fallback London
      statusEl.textContent = 'Geolocation denied — using fallback (London)';
      startBtn.disabled = false;
      scanBtn.disabled = false;
      initMap();
    }, {timeout:8000, maximumAge:60000});
  } else {
    statusEl.textContent = 'Geolocation not supported';
    userLat = 51.5074; userLng = -0.1278;
    startBtn.disabled = false;
    scanBtn.disabled = false;
    initMap();
  }
})();
