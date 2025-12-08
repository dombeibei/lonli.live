/**
 * main.js — Retro UI edition
 * Complete client script implementing:
 * - stations.json load
 * - geolocation with fallback
 * - Interactie leaflet map & station markers
 * - retro UI wiring (freq slider/number/dial)
 * - Start / Stop / Scan buttons
 * - propagation model (distance, freq match, day/night)
 * - QSB (ionospheric fading) via JS LFO + stochastic term
 * - Static (white noise) mixing and station bandpass shaping
 *
 * Requirements:
 * - audio/station.mp3 exists and is reachable
 * - index.html contains the elements referenced here (provided)
 */

/* -----------------------
   DOM references & state
   ----------------------- */
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
const qsbDepthDisplay = document.getElementById('qsb-depth-display');
const scanStepDisplay = document.getElementById('scan-step-display');

let stations = [];
let userLat = null, userLng = null;
let map = null, markersLayer = null;

/* Audio nodes */
let audioCtx = null;
let audioEl = document.getElementById('radio-audio');
let mediaSource = null;
let stationFilter = null;
let stationGain = null;
let masterGain = null;

let noiseBufferSource = null;
let noiseGain = null;
let noiseFilter = null;

/* Logic & timers */
let updateInterval = null;
let scanning = false;
let scanTimer = null;

/* Tuning state */
let tunedFreq = Number(freqRange.value || 6000);
let scanStepKHz = 100; // default scan step
scanStepDisplay.textContent = `${scanStepKHz} kHz`;

/* -----------------------
   Utility
   ----------------------- */
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }
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

/* -----------------------
   Propagation & matching
   ----------------------- */
function isStationNight(station){
  const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  const offset = station.lng / 15.0;
  let local = nowUtcH + offset;
  local = ((local % 24) + 24) % 24;
  return (local < 6) || (local >= 18);
}

function frequencyMatchFactor(stationFreqKHz, tunedFreqKHz, stationIsNight){
  const bandwidth = stationIsNight ? 14000 : 18000;
  const delta = Math.abs(stationFreqKHz - tunedFreqKHz);
  return Math.exp(- (delta * delta) / (2 * bandwidth * bandwidth));
}

function computeStationSignalFraction(station, freqKHz){
  const POWER_SCALE = 1500;
  const DIST_MIN_KM = 5.0;
  const DIST_EXP = 1.7;

  if (userLat == null || userLng == null) return 0;

  const dKm = haversineKm(userLat, userLng, station.lat, station.lng) + 0.0001;
  const distPart = (station.power_watts * POWER_SCALE) / Math.pow(Math.max(dKm, DIST_MIN_KM), DIST_EXP);

  const night = isStationNight(station);
  const freqPart = frequencyMatchFactor(station.frequency_khz, freqKHz, night);
  const nightBoost = night ? lerp(1.0, 1.5, clamp01(1 - (freqKHz - 3000)/12000)) : 1.0;

  const x = distPart * freqPart * nightBoost;
  return clamp01(x / (1 + x));
}

/* -----------------------
   Stations load & map
   ----------------------- */
async function loadStations(){
  try{
    const r = await fetch('stations.json', {cache:'no-store'});
    stations = await r.json();
    console.log('stations loaded', stations);
  }catch(e){
    console.error('Failed to load stations.json', e);
    stations = [];
  }
}

function initMap(){
  try{
    if (!map){
      map = L.map('map').setView([userLat || 52.4895, userLng || -1.8980], 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
    }
    markersLayer.clearLayers();
    if (userLat != null && userLng != null){
      L.circleMarker([userLat, userLng], {radius:6,color:'#cfa24a'}).addTo(markersLayer).bindPopup('You');
    }
    for(const s of stations){
      L.marker([s.lat, s.lng]).addTo(markersLayer).bindPopup(`${s.label}<br>${s.frequency_khz} kHz`);
    }
    if (markersLayer.getBounds && markersLayer.getBounds().isValid()){
      map.fitBounds(markersLayer.getBounds(), {padding:[30,30]});
    }
  }catch(e){
    console.error('initMap error', e);
  }
}

/* -----------------------
   Audio graph
   ----------------------- */
function initAudio(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // ensure audio element exists
  if (!audioEl){
    audioEl = document.getElementById('radio-audio');
    if (!audioEl){
      audioEl = new Audio('audio/station.mp3');
      audioEl.loop = true;
    }
  }

  try {
    mediaSource = audioCtx.createMediaElementSource(audioEl);
  } catch(e) {
    // if creating MediaElementSource fails (rare), create a new Audio element
    audioEl = new Audio('audio/station.mp3');
    audioEl.loop = true;
    mediaSource = audioCtx.createMediaElementSource(audioEl);
  }

  // station processing
  stationFilter = audioCtx.createBiquadFilter();
  stationFilter.type = 'bandpass';
  stationFilter.Q.value = 1.0;

  stationGain = audioCtx.createGain();
  stationGain.gain.value = 0;

  // noise
  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.6;

  noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 6000;

  // master
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  // white noise buffer source
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i=0;i<d.length;i++) d[i] = (Math.random()*2 - 1) * 0.45;
  noiseBufferSource = audioCtx.createBufferSource();
  noiseBufferSource.buffer = buf;
  noiseBufferSource.loop = true;

  // connections
  mediaSource.connect(stationFilter);
  stationFilter.connect(stationGain);
  stationGain.connect(masterGain);

  noiseBufferSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);

  masterGain.connect(audioCtx.destination);

  // start noise loop
  noiseBufferSource.start();

  // attempt to play (may require user gesture)
  audioEl.play().catch(()=>{ /* ok */ });
}

/* -----------------------
   QSB & update loop
   ----------------------- */
let qsbPhase = 0;
let lastTick = performance.now();

function applyQSBandAudio(freqKHz, bestStation, strength){
  if (!audioCtx) return;

  // station filter center (creative mapping)
  const filtHz = Math.max(300, freqKHz * 10);
  stationFilter.frequency.setTargetAtTime(filtHz, audioCtx.currentTime, 0.05);
  stationFilter.Q.setTargetAtTime(1 + (1 - strength) * 4, audioCtx.currentTime, 0.05);

  // station gain
  const baseGain = clamp01(Math.pow(strength, 0.9));
  stationGain.gain.setTargetAtTime(baseGain, audioCtx.currentTime, 0.05);

  // noise
  const noiseLevel = lerp(0.9, 0.02, strength);
  noiseGain.gain.setTargetAtTime(noiseLevel, audioCtx.currentTime, 0.05);
  noiseFilter.frequency.setTargetAtTime(lerp(9000, 2000, strength), audioCtx.currentTime, 0.12);

  // QSB depth/rate
  const qsbDepth = clamp01(1 - strength); // weaker -> more depth
  const qsbRate = lerp(0.08, 1.2, qsbDepth);

  // JS LFO: update qsbPhase by elapsed time
  const now = performance.now();
  const dt = (now - lastTick) / 1000;
  lastTick = now;
  qsbPhase += qsbRate * dt;
  const lfo = Math.sin(2 * Math.PI * qsbPhase);
  const stochastic = (Math.random() - 0.5) * 0.2; // small randomness
  const mod = lfo * qsbDepth * (0.4 + stochastic) * baseGain;
  stationGain.gain.setTargetAtTime(Math.max(0, baseGain + mod), audioCtx.currentTime, 0.05);

  // reflect qsb depth in UI
  if (qsbDepthDisplay) qsbDepthDisplay.textContent = qsbDepth > 0.66 ? 'high' : (qsbDepth > 0.33 ? 'medium' : 'low');
}

/* -----------------------
   Find best station for freq
   ----------------------- */
function findBestStation(freqKHz){
  if (!stations || stations.length === 0) return {station:null, fraction:0};
  let best = null, bestF = 0;
  for (const s of stations){
    const f = computeStationSignalFraction(s, freqKHz);
    if (f > bestF){ bestF = f; best = s; }
  }
  return {station: best, fraction: bestF};
}

/* -----------------------
   main periodic update
   ----------------------- */
function startUpdateLoop(){
  if (updateInterval) return;
  updateInterval = setInterval(() => {
    const freq = Number(freqNumber.value || freqRange.value || 6000);
    tunedFreq = freq;
    // compute best station
    const r = findBestStation(freq);
    // update UI
    const pct = Math.round(r.fraction * 100);
    if (signalLevelEl) signalLevelEl.style.width = pct + '%';
    if (nearestEl) nearestEl.textContent = r.station ? `${r.station.label} — ${r.station.frequency_khz} kHz — ${pct}%` : 'Nearest: —';

    // dial needle mapping
    if (dialNeedle){
      const min = Number(freqRange.min);
      const max = Number(freqRange.max);
      const angle = lerp(-50, 50, clamp01((freq - min)/(max - min)));
      dialNeedle.style.transform = `rotate(${angle}deg)`;
    }
    if (freqReadout) freqReadout.textContent = `${toFixed(freq)} kHz`;

    // ensure audio exists
    initAudio();

    // if a station has a distinct audio url, switch source
    if (r.station && r.station.audio){
      if (!audioEl.src || audioEl.src.indexOf(r.station.audio) === -1){
        audioEl.src = r.station.audio;
        audioEl.loop = true;
        audioEl.play().catch(()=>{/* maybe blocked */});
      }
    }

    // apply audio params including QSB
    applyQSBandAudio(freq, r.station, r.fraction);

  }, 100); // 10Hz updates
}

function stopUpdateLoop(){
  if (updateInterval){ clearInterval(updateInterval); updateInterval = null; }
}

/* -----------------------
   Start / Stop / Scan handlers
   ----------------------- */
function startRadio(){
  initAudio();
  audioCtx.resume().catch(()=>{});
  audioEl.play().catch(()=>{});
  startBtn.disabled = true;
  stopBtn.disabled = false;
  scanBtn.disabled = false;
  startUpdateLoop();
}

function stopRadio(){
  try{ audioEl.pause(); }catch(e){}
  // fade out nodes
  if (stationGain) stationGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
  if (noiseGain) noiseGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
  startBtn.disabled = false;
  stopBtn.disabled = true;
  scanBtn.disabled = false;
  stopUpdateLoop();
}

function startScan(){
  if (scanning) return;
  scanning = true;
  scanBtn.textContent = 'Scanning...';
  const step = scanStepKHz;
  scanTimer = setInterval(()=>{
    let v = Number(freqNumber.value || freqRange.value);
    v += step;
    if (v > Number(freqRange.max)) v = Number(freqRange.min);
    // update controls
    freqRange.value = v; freqNumber.value = v;
    // check station
    const r = findBestStation(v);
    if (r.fraction >= 0.18){
      // lock onto it
      scanning = false;
      clearInterval(scanTimer);
      scanTimer = null;
      scanBtn.textContent = 'Scan/Seek';
      // apply once immediately
      applyQSBandAudio(v, r.station, r.fraction);
    }
  }, 180);
}

function stopScan(){
  if (!scanning) return;
  scanning = false;
  if (scanTimer){ clearInterval(scanTimer); scanTimer = null; }
  scanBtn.textContent = 'Scan/Seek';
}

/* -----------------------
   UI wiring & boot
   ----------------------- */
function toFixed(v){ return Math.round(v); }

function wireUI(){
  // freq sync
  freqRange.addEventListener('input', () => {
    freqNumber.value = freqRange.value;
    freqReadout.textContent = `${toFixed(freqRange.value)} kHz`;
  });
  freqNumber.addEventListener('change', () => {
    let v = Number(freqNumber.value);
    if (isNaN(v)) v = Number(freqRange.value);
    v = Math.max(Number(freqRange.min), Math.min(Number(freqRange.max), v));
    freqNumber.value = v; freqRange.value = v;
    freqReadout.textContent = `${toFixed(v)} kHz`;
  });

  // buttons
  startBtn.addEventListener('click', () => startRadio());
  stopBtn.addEventListener('click', () => stopRadio());
  scanBtn.addEventListener('click', () => {
    if (scanning) stopScan(); else startScan();
  });

  // enable start when page ready
  startBtn.disabled = false;
}

async function boot(){
  await loadStations();
  wireUI();

  // geolocate
  if (navigator.geolocation){
    navigator.geolocation.getCurrentPosition((pos) => {
      userLat = pos.coords.latitude; userLng = pos.coords.longitude;
      if (statusEl) statusEl.textContent = `Location: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;
      initMap();
    }, (err) => {
      console.warn('geolocation failed', err);
      userLat = 52.4895; userLng = -1.8980; // Birmingham fallback
      if (statusEl) statusEl.textContent = 'Geolocation denied — using Birmingham fallback';
      initMap();
    }, {timeout:8000, maximumAge:60000});
  } else {
    userLat = 52.4895; userLng = -1.8980;
    if (statusEl) statusEl.textContent = 'Geolocation unavailable — using Birmingham fallback';
    initMap();
  }
}

/* Start */
boot();
