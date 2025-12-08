//--------------------------------------------------------
// lonli.live 0.1 — Fixed geolocation + map + audio
//--------------------------------------------------------

// Hardcoded transmitter
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
// MAP SETUP
//--------------------------------------------------------
let map = L.map('map').setView([20,0],2);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 7,
  minZoom: 2,
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

let userMarker = null;
let txMarker = L.marker([transmitter.lat, transmitter.lon]).addTo(map);
txMarker.bindPopup(`Transmitter<br>${transmitter.frequency} MHz`);

//--------------------------------------------------------
// Distance (Haversine)
function distanceKm(lat1, lon1, lat2, lon2){
  const R=6371;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+
          Math.cos(lat1*Math.PI/180)*
          Math.cos(lat2*Math.PI/180)*
          Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

//--------------------------------------------------------
// Signal Strength
function computeSignalStrength(){
  if(!userPos) return 0;
  const d = distanceKm(userPos.lat,userPos.lon,transmitter.lat,transmitter.lon);
  let base = transmitter.power/(d*d)/50000;
  const t = performance.now()/1000;
  const slow = 0.85+0.15*Math.sin(t*0.5);
  const fast = 0.9+0.1*Math.random();
  const fading = slow*fast;
  const hour = new Date().getUTCHours();
  const nightBoost = (hour>=18||hour<=6)?1.3:0.7;
  return Math.max(0,Math.min(1,base*fading*nightBoost));
}

//--------------------------------------------------------
// Audio
async function startAudio(){
  audioCtx = new (window.AudioContext||window.webkitAudioContext)();

  // Noise
  const bufferSize = 2*audioCtx.sampleRate;
  const noiseBuffer = audioCtx.createBuffer(1,bufferSize,audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for(let i=0;i<bufferSize;i++) data[i]=(Math.random()*2-1)*0.4;

  noiseNode = audioCtx.createBufferSource();
  noiseNode.buffer=noiseBuffer;
  noiseNode.loop=true;

  // Station audio
  const audioFile = await fetch('audio/station.mp3');
  const audioArray = await audioFile.arrayBuffer();
  const stationBuffer = await audioCtx.decodeAudioData(audioArray);

  stationNode = audioCtx.createBufferSource();
  stationNode.buffer=stationBuffer;
  stationNode.loop=true;

  // Gain
  gainNode = audioCtx.createGain();
  gainNode.gain.value=0;

  noiseNode.connect(gainNode);
  stationNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  noiseNode.start();
  stationNode.start();
}

//--------------------------------------------------------
// Update loop
function update(){
  if(!running) return;
  const signal = computeSignalStrength();
  signalLevelEl.style.width=(signal*100).toFixed(1)+"%";
  if(gainNode) gainNode.gain.value=0.2+(signal*0.8);
  requestAnimationFrame(update);
}

//--------------------------------------------------------
// START BUTTON
//--------------------------------------------------------
startBtn.addEventListener("click",()=>{
  if(running) return;
  running=true;
  statusEl.textContent="Requesting location…";

  if("geolocation" in navigator){
    navigator.geolocation.getCurrentPosition(
      pos=>{
        userPos={lat:pos.coords.latitude,lon:pos.coords.longitude};
        statusEl.textContent=`Location acquired: ${userPos.lat.toFixed(3)}, ${userPos.lon.toFixed(3)}`;

        // Add user marker
        if(userMarker) map.removeLayer(userMarker);
        userMarker=L.marker([userPos.lat,userPos.lon]).addTo(map);
        userMarker.bindPopup("You");

        // Fit bounds
        const bounds=L.latLngBounds([userPos.lat,userPos.lon],[transmitter.lat,transmitter.lon]);
        map.fitBounds(bounds,{padding:[40,40]});

        // Force map redraw
        setTimeout(()=>map.invalidateSize(),200);

        // Start audio & update
        startAudio();
        update();

        statusEl.textContent=`Tuned to ${transmitter.frequency} MHz`;
        startBtn.disabled=true;
      },
