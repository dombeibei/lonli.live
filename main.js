/**
 * Corrected main.js for lonli.live
 * - fixed DOM ID mismatches
 * - safe audio graph (looped white-noise buffer)
 * - robust map initialization (won't be blocked by earlier errors)
 * - propagation model and signal update kept functional
 *
 * Assumes your HTML contains:
 *  - <input id="freq">  (range)
 *  - <input id="freq-number"> (number)
 *  - <div id="freq-readout">
 *  - <div id="signal-level">
 *  - <div id="map">
 *  - <div id="status">
 *  - <button id="start-btn">, #stop-btn, #scan-btn (optional)
 *  - <audio id="radio-audio" src="audio/station.mp3">
 */

let stations = [];
let userLat = null;
let userLng = null;
let map = null;
let markersLayer = null;

let audioCtx = null;
let audioEl = null;
let mediaSource = null;
let stationGain = null;
let stationFilter = null;
let noiseSource = null;
let noiseGain = null;
let noiseFilter = null;
let qsbOsc = null;
let qsbGain = null;

// UI refs (match IDs from your HTML)
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const stopBtn  = document.getElementById('stop-btn');
const scanBtn  = document.getElementById('scan-btn');

const freqRange = document.getElementById('freq');           // range input
const freqNumber = document.getElementById('freq-number');  // number input
const freqReadout = document.getElementById('freq-readout'); // display
const signalLevelEl = document.getElementById('signal-level');
const nearestEl = document.getElementById('nearest'); // may be present in UI

// defensive: if some optional elements are missing, avoid throwing
function elSafe(id){ return document.getElementById(id) || null; }

// simple utilities
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

/* Frequency match and propagation (kept from previous working model) */
function isStationNight(station){
  const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  const offset = station.lng / 15.0;
  let local = nowUtcH + offset;
  local = ((local % 24) + 24) % 24;
  return (local < 6) || (local >= 18);
}

function frequencyMatchFactor(stationFreqKHz, tunedFreqKHz, stationIsNight){
  const bandwidth = stationIsNight ? 14000 : 18000;
  const delta = stationFreqKHz - tunedFreqKHz;
  return Math.exp(- (delta * delta) / (2 * bandwidth * bandwidth));
}

function computeStationSignalFraction(station, tunedFreqKHz){
  const POWER_SCALE = 1500;
  const DIST_MIN_KM = 5.0;
  const DIST_POWER = 1.7;

  if (userLat == null || userLng == null) return 0;

  const dKm = haversineKm(userLat, userLng, station.lat, station.lng) + 0.0001;
  const distRaw = station.power_watts * POWER_SCALE / Math.pow(Math.max(dKm, DIST_MIN_KM), DIST_POWER);

  const night = isStationNight(station);
  const freqFactor = frequencyMatchFactor(station.frequency_khz, tunedFreqKHz, night);
  const nightBoost = night ? lerp(1.0, 1.5, clamp01(1 - (tunedFreqKHz - 3000)/12000)) : 1.0;

  const x = distRaw * freqFactor * nightBoost;

  return clamp01(x / (1 + x));
}

/* Load stations.json */
async function loadStations(){
  try{
    const r = await fetch('stations.json', {cache:'no-store'});
    stations = await r.json();
    console.log('stations loaded', stations);
  }catch(e){
    console.error('failed to load stations.json', e);
    stations = [];
  }
}

/* Initialize Leaflet map — defensive; will run even if stations not loaded yet */
function initMap(){
  try{
    if (!map){
      map = L.map('map', { attributionControl: false }).setView([userLat || 51.5, userLng || 0], 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      markersLayer = L.layerGroup().addTo(map);
    }
    // clear & add markers
    markersLayer.clearLayers();
    if (userLat != null && userLng != null){
      L.circleMarker([userLat, userLng], { radius:6, color:'#4caf50' }).addTo(markersLayer).bindPopup('You');
    }
    for(const s of stations){
      L.marker([s.lat, s.lng]).addTo(markersLayer).bindPopup(`${s.label || s.name || s.id || 'Station'}<br>${s.frequency_khz || s.frequency} kHz`);
    }
    if (markersLayer.getBounds && markersLayer.getBounds().isValid()){
      map.fitBounds(markersLayer.getBounds(), { padding:[30,30] });
    }
  }catch(err){
    console.error('initMap error', err);
  }
}

/* Audio graph creation (safely) */
function initAudioIfNeeded(){
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // audio element (use the <audio> if present in HTML else create one)
  audioEl = document.getElementById('radio-audio') || new Audio('audio/station.mp3');
  audioEl.loop = true;
  audioEl.crossOrigin = "anonymous";

  // Media source
  try{
    mediaSource = audioCtx.createMediaElementSource(audioEl);
  }catch(e){
    // Safari/older browsers may throw if element already used; create a new element fallback
    audioEl = new Audio('audio/station.mp3');
    audioEl.loop = true;
    audioEl.crossOrigin = "anonymous";
    mediaSource = audioCtx.createMediaElementSource(audioEl);
  }

  // station filter & gain
  stationFilter = audioCtx.createBiquadFilter();
  stationFilter.type = 'bandpass';
  stationFilter.Q.value = 0.9;

  stationGain = audioCtx.createGain();
  stationGain.gain.value = 0;

  // noise: buffer-based white noise loop
  const bufferSizeSec = 2.0;
  const noiseBuffer = audioCtx.createBuffer(1, Math.floor(audioCtx.sampleRate * bufferSizeSec), audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for(let i=0;i<data.length;i++) data[i] = (Math.random()*2 - 1) * 0.45;
  noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;

  noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 6000;

  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0.6;

  // QSB: simple LFO controlling small gain modulation (we'll implement as Gain node modulation)
  qsbOsc = audioCtx.createOscillator();
  qsbOsc.type = 'sine';
  qsbOsc.frequency.value = 0.25; // base
  qsbGain = audioCtx.createGain();
  qsbGain.gain.value = 0.0; // depth controlled later

  // Connect graph:
  // media -> filter -> stationGain -> destination
  mediaSource.connect(stationFilter);
  stationFilter.connect(stationGain);
  stationGain.connect(audioCtx.destination);

  // noise -> noiseFilter -> noiseGain -> destination
  noiseSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(audioCtx.destination);

  // qsb LFO: connect to stationGain.gain param (via setValueAtTime modulation)
  // WebAudio doesn't allow direct audio-rate connection to AudioParam in all browsers; use setInterval to apply small modulation
  // We'll use a lightweight JS LFO instead to avoid compatibility problems (see applyQSB below)

  // start noise & LFO sources
  noiseSource.start();
  qsbOsc.start();

  // attempt to play audio element (will require user gesture in many browsers)
  audioEl.play().catch(e=>{/* user gesture required; fine */});
}

/* JS-based QSB (modulates stationGain.gain value smoothly) */
let qsbPhase = 0;
function applyQSB(depth, rate, baseGain){
  // depth: 0..1 relative, rate Hz, baseGain = stationVol
  // Called periodically by main update loop; produce small modulation added to baseGain
  qsbPhase += rate * (1/30); // assuming ~30 fps calls
  if (qsbPhase > 1e6) qsbPhase = qsbPhase % 1;
  const lfo = Math.sin(2 * Math.PI * qsbPhase);
  const mod = lfo * depth * baseGain * 0.4; // scale down
  // Apply safely
  try{
    stationGain.gain.setTargetAtTime(Math.max(0, baseGain + mod), audioCtx.currentTime, 0.05);
  }catch(e){
    // ignore if audioCtx not ready
  }
}

/* Main update: compute best station, update UI, audio params */
let updateHandle = null;
function startMainLoop(){
  if (updateHandle) return;
  updateHandle = setInterval(()=>{
    // current tuned freq: from UI (prefer number input)
    const freq = (freqNumber && freqNumber.value) ? Number(freqNumber.value) : (freqRange ? Number(freqRange.value) : 10000);
    // find best station
    let best = null;
    let bestStrength = 0;
    for(const s of stations){
      const strength = computeStationSignalFraction(s, freq);
      if (strength > bestStrength){ bestStrength = strength; best = s; }
    }

    // UI updates
    if (signalLevelEl) signalLevelEl.style.width = Math.round(bestStrength*100) + '%';
    if (nearestEl) nearestEl.textContent = best ? `${best.label || best.name} — ${best.frequency_khz || best.frequency} kHz` : 'Nearest: —';
    if (freqReadout) freqReadout.textContent = `${toFixedInt(freq)} kHz`;
    // dial/needle (if present) left to previous CSS/JS; omitted here for brevity

    // ensure audio graph
    initAudioIfNeeded();

    // audio behavior
    // station volume
    if (stationGain) {
      // map strength to reasonable gain (linear)
      const baseGain = clamp01(Math.pow(bestStrength, 0.9));
      stationGain.gain.setTargetAtTime(baseGain, audioCtx.currentTime, 0.05);
      // filter center mapping (creative)
      if (stationFilter) {
        const filtHz = Math.max(300, freq * 10); // mapping 1 kHz -> 10 Hz for creative effect
        stationFilter.frequency.setTargetAtTime(filtHz, audioCtx.currentTime, 0.05);
        stationFilter.Q.setTargetAtTime(1 + (1 - bestStrength) * 4, audioCtx.currentTime, 0.05);
      }
      // noise parameters
      if (noiseGain && noiseFilter){
        const noiseLvl = lerp(0.9, 0.02, bestStrength);
        noiseGain.gain.setTargetAtTime(noiseLvl, audioCtx.currentTime, 0.05);
        const noiseCut = lerp(9000, 2000, bestStrength);
        noiseFilter.frequency.setTargetAtTime(noiseCut, audioCtx.currentTime, 0.1);
      }
      // QSB: depth increases as signal weakens
      const qsbDepth = clamp01(1 - bestStrength);
      const qsbRate = lerp(0.08, 1.2, qsbDepth);
      // apply JS LFO modulation
      applyQSB(qsbDepth, qsbRate, baseGain);
    }

  }, 1000 / 10); // 10 updates per second
}

/* Helper to round */
function toFixedInt(x){ return Math.round(x); }

/* Safe startup sequence */
async function boot(){
  await loadStations();

  // Try get geolocation
  if (navigator.geolocation){
    navigator.geolocation.getCurrentPosition((pos) => {
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      if (statusEl) statusEl.textContent = `Location: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;
      initMap();
      startMainLoop();
    }, (err) => {
      console.warn('geolocation failed', err);
      // fallback location: Birmingham approximate
      userLat = 52.4895;
      userLng = -1.8980;
      if (statusEl) statusEl.textContent = 'Geolocation denied — using fallback (Birmingham)';
      initMap();
      startMainLoop();
    }, { timeout: 8000, maximumAge: 60000 });
  } else {
    if (statusEl) statusEl.textContent = 'Geolocation not available';
    userLat = 52.4895; userLng = -1.8980;
    initMap();
    startMainLoop();
  }

  // wire up UI safely
  try{
    if (freqRange && freqNumber){
      // sync controls
      freqRange.addEventListener('input', () => {
        freqNumber.value = freqRange.value;
      });
      freqNumber.addEventListener('change', () => {
        let v = Number(freqNumber.value);
        if (isNaN(v)) v = Number(freqRange.value);
        v = Math.max(Number(freqRange.min), Math.min(Number(freqRange.max), v));
        freqNumber.value = v;
        freqRange.value = v;
      });
    }
    if (startBtn){
      startBtn.disabled = false;
      startBtn.addEventListener('click', async () => {
        initAudioIfNeeded();
        try{ await audioCtx.resume(); }catch(e){}
        try{ audioEl.play(); }catch(e){}
      });
    }
    if (stopBtn){
      stopBtn.addEventListener('click', () => {
        try{ audioEl.pause(); }catch(e){}
        try{
          if (stationGain) stationGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
          if (noiseGain) noiseGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.05);
        }catch(e){}
      });
    }
  }catch(e){
    console.warn('UI wiring error (non fatal)', e);
  }
}

/* start */
boot();
