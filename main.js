/**
 * main.js — lonli.live
 *
 * Features:
 * - loads stations.json
 * - geolocation & Leaflet map rendering
 * - simple day/night HF propagation model (heuristic)
 * - deterministic signal strength (distance + power + freq match + day/night preference)
 * - WebAudio: station audio (media element) + generated noise; noise & filter respond to signal strength
 *
 * Notes:
 * - The propagation model is intentionally simple: it's a practical, tunable heuristic, not
 *   a full ionospheric solver. It is sufficient for a convincing interactive simulation.
 */

// DOM refs
const statusEl = document.getElementById('status');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const freqRange = document.getElementById('freq');
const freqNumber = document.getElementById('freq-number');
const signalLevelEl = document.getElementById('signal-level');
const nearestEl = document.getElementById('nearest');

const audioEl = document.getElementById('radio-audio');

let userLat = null, userLng = null;
let map = null, markersLayer = null;
let stations = [];
let updateTimer = null;

// Audio nodes
let audioCtx = null;
let stationSource = null;   // MediaElementSource for audioEl
let stationGain = null;
let stationFilter = null;   // Biquad bandpass/lowpass for tone shaping
let masterGain = null;

let noiseBufferSource = null;
let noiseGain = null;
let noiseFilter = null;

/* ----------------------
   Utility functions
   ---------------------- */

// Haversine distance (km)
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

// Normalize to [0,1]
function clamp01(x){ return Math.max(0, Math.min(1, x)); }

// Linear interpolation
function lerp(a,b,t){ return a + (b-a)*t; }

/* ----------------------
   Propagation model
   ---------------------- */

/**
 * Determine whether the station is in local day or night.
 * Use a simple solar time estimate: UTC hours + longitude/15
 * Returns true if local hour is night (roughly 18:00-06:00).
 */
function isStationNight(station){
  const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes()/60;
  // convert longitude to hour offset (-180..180 -> -12..12)
  const offset = station.lng / 15.0;
  let local = nowUtcH + offset;
  // wrap to 0..24
  local = ((local % 24) + 24) % 24;
  return (local < 6) || (local >= 18);
}

/**
 * Frequency preference heuristic:
 * - nighttime prefers lower HF bands (e.g. ~3000-9000 kHz)
 * - daytime prefers higher HF bands (e.g. ~9000-20000 kHz)
 *
 * Return a frequency-matching factor in [0,1] for a given station and tuned frequency.
 */
function frequencyMatchFactor(stationFreqKHz, tunedFreqKHz, stationIsNight){
  // preferred center frequency depends on day/night
  const pref = stationIsNight ? 6000 : 15000; // kHz, tunable
  const bandwidth = stationIsNight ? 8000 : 12000; // kHz (wide, artistic)
  const delta = Math.abs(stationFreqKHz - tunedFreqKHz);
  // gaussian-like falloff
  const t = Math.exp(- (delta*delta) / (2 * (bandwidth/2)*(bandwidth/2)));
  return clamp01(t);
}

/**
 * computeStationSignalFraction(station, tunedFreq)
 * returns value in 0..1 combining:
 *  - inverse-square distance attenuation (station power vs distance)
 *  - frequency match factor (bandwidth & day/night)
 *  - optional enhancement for night propagation on low freq
 *
 * Tunable constants are at top of function.
 */
function computeStationSignalFraction(station, tunedFreqKHz){
  // Tunables
  const POWER_SCALE = 1e-4; // scale station.power_watts to manageable range
  const DIST_MIN_KM = 1.0;  // avoid divide-by-zero
  const DIST_POWER = 2.0;   // inverse-power (2 => inverse-square)

  // distance factor (0..1) using inverse-power law and softcap
  const dKm = haversineKm(userLat, userLng, station.lat, station.lng) + 0.0001;
  const distRaw = station.power_watts * POWER_SCALE / Math.pow(Math.max(dKm, DIST_MIN_KM), DIST_POWER);

  // frequency match (0..1)
  const night = isStationNight(station);
  const freqFactor = frequencyMatchFactor(station.frequency_khz, tunedFreqKHz, night);

  // night enhancement for lower freq bands: small multiplier if night and tuned low
  let nightBoost = 1.0;
  if(night){
    // prefer lower frequencies at night; tunedFreqKHz < 10000 -> boost
    const boostFactor = clamp01(1 - (tunedFreqKHz - 3000)/12000); // tuned 3000 -> ~1, tuned 15000 -> ~0
    nightBoost = lerp(1.0, 1.8, boostFactor); // up to 1.8x at low night freq
  }

  // Combine and clamp
  const raw = distRaw * freqFactor * nightBoost;

  // final normalization to 0..1: use sigmoid-like map to keep values in 0..1 for UI
  // tuning constant chosen to give sensible demo ranges.
  const x = raw;
  const normalized = clamp01(x / (x + 0.5)); // roughly maps small x to ~ x/0.5 range

  return normalized;
}

/* ----------------------
   Audio graph (station + noise)
   ---------------------- */

function initAudioIfNeeded(){
  if(audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // station nodes
  stationSource = audioCtx.createMediaElementSource(audioEl);
  stationFilter = audioCtx.createBiquadFilter();
  stationFilter.type = 'bandpass';
  stationFilter.frequency.value = 1000; // placeholder; will map tuned freq below
  stationFilter.Q.value = 0.8;

  stationGain = audioCtx.createGain();
  stationGain.gain.value = 0;

  // noise nodes (buffered white noise loop)
  noiseGain = audioCtx.createGain();
  noiseGain.gain.value = 0;

  noiseFilter = audioCtx.createBiquadFilter();
  noiseFilter.type = 'lowpass';
  noiseFilter.frequency.value = 6000; // noise tone shaping

  // master
  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  // connect: stationSource -> stationFilter -> stationGain -> master
  stationSource.connect(stationFilter);
  stationFilter.connect(stationGain);
  stationGain.connect(masterGain);

  // noise: generate buffer, looped
  const sampleRate = audioCtx.sampleRate;
  const bufferSizeSec = 2.0;
  const buffer = audioCtx.createBuffer(1, Math.floor(sampleRate * bufferSizeSec), sampleRate);
  const data = buffer.getChannelData(0);
  for(let i=0;i<data.length;i++){
    // white noise in [-1,1], then shaped a little by multiplying by small factor
    data[i] = (Math.random()*2 - 1) * 0.5;
  }
  noiseBufferSource = audioCtx.createBufferSource();
  noiseBufferSource.buffer = buffer;
  noiseBufferSource.loop = true;

  // connect noise -> noiseFilter -> noiseGain -> master
  noiseBufferSource.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(masterGain);

  // master to destination
  masterGain.connect(audioCtx.destination);

  // start noise immediately but muted (we will ramp noiseGain on start)
  noiseBufferSource.start(0);
}

/* Map tuned kHz -> audible audio filter center frequency (creative mapping)
   WebAudio filter works in Hz, but our audio file is audible; the bandpass is not a literal RF filter.
   We map kHz -> audible Hz with a multiplier to create a perceptible effect.
*/
function tunedKHzToFilterHz(khz){
  // mapping constant: 1 kHz -> 10 Hz center (artistic)
  const c = 10;
  return Math.max(100, khz * c);
}

/* ----------------------
   Setup, map, UI wiring
   ---------------------- */

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

function initMap(){
  map = L.map('map').setView([userLat, userLng], 3);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19}).addTo(map);
  markersLayer = L.layerGroup().addTo(map);

  // user marker
  L.circleMarker([userLat, userLng], {radius:6,color:'#4caf50'}).addTo(markersLayer).bindPopup('You');

  // station markers
  for(const s of stations){
    L.marker([s.lat, s.lng]).addTo(markersLayer).bindPopup(`${s.label}<br>${s.frequency_khz} kHz<br>Power:${s.power_watts}W`);
  }

  map.fitBounds(markersLayer.getBounds(), {padding:[40,40]});
}

/* Update UI: nearest station label and bar width */
function updateUI(bestStation, fraction){
  if(!bestStation){
    signalLevelEl.style.width = '0%';
    nearestEl.textContent = 'Nearest station: —';
    return;
  }
  const pct = Math.round(fraction*100);
  signalLevelEl.style.width = pct + '%';
  nearestEl.textContent = `Nearest station: ${bestStation.label} (${bestStation.frequency_khz} kHz) — ${pct}%`;
}

/* Apply audio parameters according to computed strength */
function applyAudioParameters(tunedFreqKHz, bestStation, fraction){
  if(!audioCtx) return;

  // station filter center frequency (audible mapping)
  const filtHz = tunedKHzToFilterHz(tunedFreqKHz);
  stationFilter.frequency.setTargetAtTime(filtHz, audioCtx.currentTime, 0.05);

  // station gain: scale fraction to audible volume (use small ramp)
  const stationVol = clamp01(fraction * 1.2); // slightly amplify fraction
  stationGain.gain.linearRampToValueAtTime(stationVol, audioCtx.currentTime + 0.05);

  // noise gain increases when fraction is low (more static)
  const noiseLevel = clamp01(lerp(0.9, 0.04, fraction)); // fraction 0 -> 0.9 noise, fraction 1 -> 0.04 noise
  noiseGain.gain.linearRampToValueAtTime(noiseLevel, audioCtx.currentTime + 0.05);

  // noise filter: when weak signal, let more high-frequency noise through; when strong, lowpass the noise
  const noiseCut = lerp(9000, 2000, fraction); // weak->9000Hz strong->2000Hz
  noiseFilter.frequency.setTargetAtTime(noiseCut, audioCtx.currentTime, 0.1);

  // small additional lowpass on station when weak so it sounds muffled
  if(stationFilter.type !== 'bandpass') stationFilter.type = 'bandpass';
  stationFilter.Q.setTargetAtTime(clamp01(1 + (1 - fraction)*4), audioCtx.currentTime, 0.05);
}

/* Main selection logic: compute best station for current tuned frequency */
function chooseBestStation(tunedFreqKHz){
  if(!stations || stations.length === 0) return {station:null, fraction:0};

  let best = null;
  let bestFrac = 0;
  for(const s of stations){
    const frac = computeStationSignalFraction(s, tunedFreqKHz);
    if(frac > bestFrac){
      bestFrac = frac;
      best = s;
    }
  }
  return {station: best, fraction: bestFrac};
}

/* Start/Stop logic and periodic updates */
function startRadio(){
  initAudioIfNeeded();

  // Must resume audio context on user gesture
  audioCtx.resume().then(()=> {
    audioEl.loop = true;
    audioEl.play().catch(e=> console.warn('audio play prevented', e));
  });

  // enable stop button
  stopBtn.disabled = false;

  // one immediate update then periodic
  const freq = Number(freqNumber.value);
  const chosen = chooseBestStation(freq);
  updateUI(chosen.station, chosen.fraction);
  applyAudioParameters(freq, chosen.station, chosen.fraction);

  if(updateTimer) clearInterval(updateTimer);
  updateTimer = setInterval(()=>{
    const f = Number(freqNumber.value);
    const c = chooseBestStation(f);
    updateUI(c.station, c.fraction);
    applyAudioParameters(f, c.station, c.fraction);
  }, 900);
}

function stopRadio(){
  if(updateTimer){ clearInterval(updateTimer); updateTimer = null; }
  if(audioCtx){
    // fade out quickly
    stationGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
    noiseGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.05);
  }
  try{ audioEl.pause(); }catch(e){}
  stopBtn.disabled = true;
}

/* ----------------------
   UI wiring & startup
   ---------------------- */

freqRange.addEventListener('input', () => {
  freqNumber.value = freqRange.value;
});

freqNumber.addEventListener('change', () => {
  let v = Number(freqNumber.value);
  if(isNaN(v)) v = Number(freqRange.value);
  v = Math.max(Number(freqRange.min), Math.min(Number(freqRange.max), v));
  freqNumber.value = v;
  freqRange.value = v;
});

startBtn.addEventListener('click', async () => {
  // enable audio on user gesture
  try{
    initAudioIfNeeded();
    await audioCtx.resume();
  }catch(e){ console.warn('AudioContext resume error', e); }
  startRadio();
  startBtn.disabled = true;
});

stopBtn.addEventListener('click', () => {
  stopRadio();
  startBtn.disabled = false;
});

/* Startup sequence */
(async function boot(){
  await loadStations();

  // request geolocation
  if(navigator.geolocation){
    navigator.geolocation.getCurrentPosition(pos=>{
      userLat = pos.coords.latitude;
      userLng = pos.coords.longitude;
      statusEl.textContent = `Location: ${userLat.toFixed(4)}, ${userLng.toFixed(4)}`;
      startBtn.disabled = false;
      initMap();
    }, err=>{
      console.warn('geolocation failed', err);
      // fallback to London for demo
      userLat = 51.5074; userLng = -0.1278;
      statusEl.textContent = 'Geolocation denied — using fallback (London)';
      startBtn.disabled = false;
      initMap();
    }, {timeout:8000, maximumAge:60000});
  } else {
    statusEl.textContent = 'Geolocation not supported';
    startBtn.disabled = false;
    userLat = 51.5074; userLng = -0.1278;
    initMap();
  }

})();
