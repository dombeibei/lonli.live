/**
 * main.js — Hybrid Retro final
 *
 * Implements:
 *  - stations.json load
 *  - geolocation (fallback to Birmingham)
 *  - Leaflet map and markers
 *  - Hybrid UI wiring (range, number, knob, fine buttons)
 *  - Start/Stop/Scan/Seek
 *  - Propagation model (distance, freq match, day/night)
 *  - Per-station audio switching with fade
 *  - Static noise, bandpass shaping, QSB fading (LFO + stochastic)
 *
 * Notes:
 *  - audio/station.mp3 must exist
 *  - Browsers require user gesture to allow audio; Start provides it
 */

/* -----------------------
   DOM refs & state
   ----------------------- */
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const scanBtn = document.getElementById('scan-btn');

const freqRange = document.getElementById('freq');
const freqNumber = document.getElementById('freq-number');
const freqReadout = document.getElementById('freq-readout');
const knobEl = document.getElementById('knob');
const fineUp = document.getElementById('fine-up');
const fineDown = document.getElementById('fine-down');

const signalLevelEl = document.getElementById('signal-level');
const nearestEl = document.getElementById('nearest');
const qsbDepthDisplay = document.getElementById('qsb-depth-display');
const scanStepDisplay = document.getElementById('scan-step-display');

let stations = [];
let userLat = null, userLng = null;
let map = null, markersLayer = null;

/* Audio nodes */
let audioCtx = null;
let currentMediaSource = null;   // current MediaElementSource
let audioElement = null;         // active HTMLAudioElement
let stationGain = null;
let stationFilter = null;
let masterGain = null;

let noiseSource = null;
let noiseGain = null;
let noiseFilter = null;

/* runtime */
let updateTimer = null;
let scanning = false;
let scanTimer = null;
let tunedFreq = Number(freqRange.value || 6000);
let scanStepKHz = 100;
scanStepDisplay.textContent = `${scanStepKHz} kHz`;

let lastSwitch = { audioEl: null, gainNode: null };

/* -----------------------
   Utilities
   ----------------------- */
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function toFixedInt(x){ return Math.round(x); }

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
   Audio graph & switching
   ----------------------- */
function createAudioGraphForElement(el){
  // Returns {sourceNode, gainNode, filterNode}
  const source = audioCtx.createMediaElementSource(el);
  const filter = audioCtx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 1.0;

  const gain = audioCtx.createGain();
  gain.gain.value = 0;

  source.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  return { source, filter, gain };
}

function initAudioCore(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  // noise buffer source
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i=0;i<d.length;i++) d[i] = (Math.random()*2 - 1) * 0.45;

  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = buf;
  noiseSource.loop = true;

  noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 6000;

  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.6;

  // route noise -> lowpass -> gain -> master
  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);

  // master -> destination
  masterGain.connect(audioCtx.destination);

  noiseSource.start();
}

async function switchToStationAudio(station){
  // station.audio expected (local audio path). Create new audio element each switch to avoid MediaElementSource reuse errors.
  if (!station || !station.audio){
    // fade out current
    if (lastSwitch.gainNode){
      lastSwitch.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
      lastSwitch.gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.25);
    }
    if (audioElement){
      try{ audioElement.pause(); }catch(e){}
    }
    lastSwitch.audioEl = null;
    lastSwitch.gainNode = null;
    return;
  }

  // if already playing this station, keep it
  if (lastSwitch.audioEl && lastSwitch.audioEl.src && lastSwitch.audioEl.src.indexOf(station.audio) !== -1){
    return;
  }

  // create new HTMLAudioElement for station
  const el = new Audio(station.audio);
  el.crossOrigin = "anonymous";
  el.loop = true;
  el.preload = "auto";

  // connect
  const { source, filter, gain } = createAudioGraphForElement(el);

  // fade out previous
  if (lastSwitch.gainNode){
    lastSwitch.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    lastSwitch.gainNode.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.25);
    // stop and disconnect old element after fade
    const oldEl = lastSwitch.audioEl;
    setTimeout(()=> {
      try{ if (oldEl) oldEl.pause(); }catch(e){}
    }, 300);
  }

  // set new as active
  lastSwitch.audioEl = el;
  lastSwitch.gainNode = gain;
  lastSwitch.filterNode = filter;

  // start play (may be blocked until user gesture)
  try{
    await el.play();
  }catch(e){
    // Silence until user clicks Start (Start handler resumes audioCtx and plays)
  }
}

/* -----------------------
   QSB & periodic update
   ----------------------- */
let qsbPhase = 0;
let lastTime = performance.now();

function applyAudioParams(freqKHz, bestStation, strength){
  if (!audioCtx) return;

  // station filter center mapping applied to currently active filter node
  if (lastSwitch.filterNode){
    const filtHz = Math.max(300, freqKHz * 10);
    lastSwitch.filterNode.frequency.setTargetAtTime(filtHz, audioCtx.currentTime, 0.05);
    lastSwitch.filterNode.Q.setTargetAtTime(1 + (1 - strength) * 4, audioCtx.currentTime, 0.05);
  }

  // station gain
  if (lastSwitch.gainNode){
    const baseGain = clamp01(Math.pow(strength, 0.9));
    lastSwitch.gainNode.gain.cancelScheduledValues(audioCtx.currentTime);
    lastSwitch.gainNode.gain.linearRampToValueAtTime(baseGain, audioCtx.currentTime + 0.1);
  }

  // noise
  if (noiseGain && noiseFilter){
    const noiseLvl = lerp(0.9, 0.02, strength);
    noiseGain.gain.setTargetAtTime(noiseLvl, audioCtx.currentTime, 0.05);
    noiseFilter.frequency.setTargetAtTime(lerp(9000, 2000, strength), audioCtx.currentTime, 0.12);
  }

  // QSB (JS LFO + stochastic)
  const qsbDepth = clamp01(1 - strength);
  const qsbRate = lerp(0.08, 1.2, qsbDepth);

  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  qsbPhase += qsbRate * dt;
  const lfo = Math.sin(2 * Math.PI * qsbPhase);
  const stochastic = (Math.random() - 0.5) * 0.2;
  const mod = lfo * qsbDepth * (0.4 + stochastic);

  if (lastSwitch.gainNode){
    const base = clamp01(Math.pow(strength, 0.9));
    lastSwitch.gainNode.gain.setTargetAtTime(Math.max(0, base + mod * base), audioCtx.currentTime, 0.05);
  }

  if (qsbDepthDisplay) qsbDepthDisplay.textContent = qsbDepth > 0.66 ? 'high' : (qsbDepth > 0.33 ? 'medium' : 'low');
}

/* -----------------------
   Find best station
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
   Update loop
   ----------------------- */
function startUpdateLoop(){
  if (updateTimer) return;
  updateTimer = setInterval(async () => {
    const freq = Number(freqNumber.value || freqRange.value || 6000);
    tunedFreq = freq;

    const result = findBestStation(freq);
    const pct = Math.round(result.fraction * 100);
    if (signalLevelEl) signalLevelEl.style.width = pct + '%';
    if (nearestEl) nearestEl.textContent = result.station ? `${result.station.label} — ${result.station.frequency_khz} kHz — ${pct}%` : 'Nearest: —';

    if (freqReadout) freqReadout.textContent = `${toFixedInt(freq)} kHz`;

    // ensure core audio
    initAudioCore();

    // switch station audio if necessary (non-blocking)
    if (result.station) await switchToStationAudio(result.station);
    else await switchToStationAudio(null);

    // apply audio params and QSB
    applyAudioParams(freq, result.station, result.fraction);

  }, 100); // 10Hz
}

function stopUpdateLoop(){
  if (updateTimer){ clearInterval(updateTimer); updateTimer = null; }
}

/* -----------------------
   Start / Stop / Scan
   ----------------------- */
function startRadio(){
  initAudioCore();
  audioCtx.resume().catch(()=>{});
  if (lastSwitch.audioEl){
    try{ lastSwitch.audioEl.play(); }catch(e){}
  }
  startBtn.disabled = true;
  stopBtn.disabled = false;
  scanBtn.disabled = false;
  startUpdateLoop();
}

function stopRadio(){
  try{ if (lastSwitch.audioEl) lastSwitch.audioEl.pause(); }catch(e){}
  if (lastSwitch.gainNode) lastSwitch.gainNode.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
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
  scanTimer = setInterval(()=> {
    let v = Number(freqNumber.value || freqRange.value);
    v += scanStepKHz;
    if (v > Number(freqRange.max)) v = Number(freqRange.min);
    freqRange.value = v; freqNumber.value = v;
    const r = findBestStation(v);
    if (r.fraction >= 0.18){
      // lock
      stopScan();
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
   UI wiring and helpers
   ----------------------- */
function initUI(){
  // sync range <-> number
  freqRange.addEventListener('input', () => {
    freqNumber.value = freqRange.value;
    freqReadout.textContent = `${toFixedInt(freqRange.value)} kHz`;
  });
  freqNumber.addEventListener('change', () => {
    let v = Number(freqNumber.value);
    if (isNaN(v)) v = Number(freqRange.value);
    v = Math.max(Number(freqRange.min), Math.min(Number(freqRange.max), v));
    freqNumber.value = v; freqRange.value = v;
    freqReadout.textContent = `${toFixedInt(v)} kHz`;
  });

  // fine buttons
  fineUp.addEventListener('click', () => {
    let v = Number(freqNumber.value) + 1;
    v = Math.min(Number(freqRange.max), v);
    freqNumber.value = v; freqRange.value = v; freqReadout.textContent = `${toFixedInt(v)} kHz`;
  });
  fineDown.addEventListener('click', () => {
    let v = Number(freqNumber.value) - 1;
    v = Math.max(Number(freqRange.min), v);
    freqNumber.value = v; freqRange.value = v; freqReadout.textContent = `${toFixedInt(v)} kHz`;
  });

  // knob drag
  let dragging = false;
  let startY = 0;
  let startVal = 0;
  knobEl.addEventListener('pointerdown', (ev) => {
    dragging = true;
    startY = ev.clientY;
    startVal = Number(freqNumber.value);
    knobEl.setPointerCapture(ev.pointerId);
  });
  window.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dy = startY - ev.clientY;
    const sensitivity = 18; // pixels per 10kHz
    const delta = Math.round(dy / sensitivity) * 10;
    let v = startVal + delta;
    v = Math.max(Number(freqRange.min), Math.min(Number(freqRange.max), v));
    freqNumber.value = v; freqRange.value = v; freqReadout.textContent = `${toFixedInt(v)} kHz`;
  });
  window.addEventListener('pointerup', (ev) => {
    dragging = false;
    try{ knobEl.releasePointerCapture(ev.pointerId); }catch(e){}
  });

  // Buttons
  startBtn.addEventListener('click', () => startRadio());
  stopBtn.addEventListener('click', () => stopRadio());
  scanBtn.addEventListener('click', () => { if (scanning) stopScan(); else startScan(); });

  // initial states
  startBtn.disabled = false;
  stopBtn.disabled = true;
  scanBtn.disabled = false;
}

/* -----------------------
   Core audio init
   ----------------------- */
function initAudioCore(){
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;
  masterGain.connect(audioCtx.destination);

  // noise
  const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 2, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i=0;i<d.length;i++) d[i] = (Math.random()*2 - 1) * 0.45;
  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = buf;
  noiseSource.loop = true;

  noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 6000;

  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.6;

  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);

  noiseSource.start();
}

/* -----------------------
   Boot sequence
   ----------------------- */
async function boot(){
  await loadStations();
  initUI();

  // geolocation
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

boot();
