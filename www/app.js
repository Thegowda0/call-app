// =========================================================
// Call System Client v3
// =========================================================
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const WORKER_HOST = 'call-system.mohan0.workers.dev';
const API_BASE = IS_NATIVE ? ('https://' + WORKER_HOST) : '';
const WS_BASE = IS_NATIVE
  ? ('wss://' + WORKER_HOST)
  : ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);

function apiFetch(path, options) {
  const url = path.startsWith('http') ? path : (API_BASE + path);
  return fetch(url, Object.assign({ credentials: 'include' }, options || {}));
}
// =========================================================
// NATIVE BRIDGE — talks to the Android AudioRoute plugin
// =========================================================
let _AudioRouteNative = null;
async function getNativeAudioRoute() {
  if (!IS_NATIVE) return null;
  if (_AudioRouteNative) return _AudioRouteNative;
  try {
    const { registerPlugin } = await import('@capacitor/core');
    _AudioRouteNative = registerPlugin('AudioRoute');
    return _AudioRouteNative;
  } catch (e) {
    console.warn('Native bridge unavailable:', e);
    return null;
  }
}
async function nativeNotifyIncoming(callerName) {
  try { const A = await getNativeAudioRoute(); if (!A) return; await A.notifyIncoming({ callerName: callerName || 'Someone' }); }
  catch (e) { console.warn('notifyIncoming failed:', e); }
}
async function nativeCancelIncoming() {
  try { const A = await getNativeAudioRoute(); if (!A) return; await A.cancelIncoming(); }
  catch (e) { console.warn('cancelIncoming failed:', e); }
}
async function nativeStartService() {
  try { const A = await getNativeAudioRoute(); if (!A) return; await A.startService(); }
  catch (e) { console.warn('startService failed:', e); }
}
async function nativeStopService() {
  try { const A = await getNativeAudioRoute(); if (!A) return; await A.stopService(); }
  catch (e) { console.warn('stopService failed:', e); }
}
// =========================================================
const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const IS_IOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
const IS_STANDALONE = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const FALLBACK_ICE = { iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
], iceCandidatePoolSize: 10 };
let cachedIceServers = null;

async function getIceServers() {
  if (cachedIceServers) return cachedIceServers;
  try {
    const res = await apiFetch('/api/turn-credentials');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    let servers = [];
    if (Array.isArray(data.iceServers)) servers = data.iceServers;
    else if (data.iceServers && data.iceServers.urls) servers = [data.iceServers];
    servers.unshift({ urls: 'stun:stun.l.google.com:19302' });
    cachedIceServers = { iceServers: servers, iceCandidatePoolSize: 10 };
    return cachedIceServers;
  } catch (e) {
    cachedIceServers = FALLBACK_ICE;
    return cachedIceServers;
  }
}

const SOUNDS = {
  ringtone: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
  dialTone: 'https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3',
  connected: 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3',
  hangup: 'https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3',
  error: 'https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3'
};
let audioCache = {};
function preloadSounds() {
  for (const [name, url] of Object.entries(SOUNDS)) {
    const a = new Audio(url); a.preload = 'auto'; a.volume = 0.6; audioCache[name] = a;
  }
}
function playSound(name, loop) {
  const a = audioCache[name]; if (!a) return;
  try { a.loop = !!loop; a.currentTime = 0; a.play().catch(() => {}); } catch (e) {}
}
function stopSound(name) {
  const a = audioCache[name]; if (!a) return;
  try { a.pause(); a.currentTime = 0; } catch (e) {}
}

// STATE
let me = null, settings = null;
let myCode = null;
let myPeerId = crypto.randomUUID();
let ws = null, wsQueue = [], wsRoomId = null, wsJoined = false, heartbeatInterval = null;
let currentCall = null, timerInterval = null, incomingCallData = null;
let mediaRecorder = null, recordedChunks = [], recordingStart = null, recordingId = null;
let currentRecordingHasVideo = false;
let devices = { mics: [], cams: [] };
let currentFacingMode = 'user';
let isScreenSharing = false, originalVideoTrack = null;
let audioOutputDevice = null, networkMonitor = null;
let currentCallType = 'video';
let uiIdleTimer = null, localVideoIdleTimer = null;
let recordingFilter = 'all';
let editingUserId = null;
let currentRecordingId = null;
let deferredInstallPrompt = null;

// =========================================================
// BOOT
// =========================================================
window.addEventListener('DOMContentLoaded', async () => {
  preloadSounds();
  setupPWA();
  initCallScreenGestures();

  const input = document.getElementById('code-input');
  if (input) input.addEventListener('input', () => { input.value = input.value.replace(/\\D/g, '').slice(0, 6); });

  ['login-username', 'login-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  });

  document.addEventListener('click', function () {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, { once: true });

  setInterval(() => {
    if (currentCall) return;
    const onCreate = document.getElementById('screen-create').classList.contains('active');
    if (!onCreate || !myCode) return;
    if (ws && wsRoomId === myCode && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    openSocket(myCode, 'receiver-listener');
  }, 5000);

  try {
    const res = await apiFetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated) { me = data.user; await afterLogin(); }
    }
  } catch (e) {}

  document.addEventListener('click', (e) => {
    const item = e.target.closest('.rec-item');
    if (!item || !item.dataset.recId) return;
    openRecording(item.dataset.recId, item.dataset.hasVideo === '1');
  });
});

// =========================================================
// AUDIO ROUTING (defined early so nothing throws)
// =========================================================
async function setDefaultAudioRoute() {
  const v = document.getElementById('remote-video');
  const btn = document.getElementById('btn-speaker');
  if (!v) { if (btn) btn.classList.add('active'); return; }
  if (!v.setSinkId) {
    if (btn) btn.classList.add('active');
    return;
  }
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const sp = devs.filter(d => d.kind === 'audiooutput');
    const speaker = sp.find(s => /speaker|loud/i.test(s.label))
      || sp.find(s => s.deviceId !== 'default' && s.deviceId !== '');
    if (speaker) {
      await v.setSinkId(speaker.deviceId);
      audioOutputDevice = speaker.deviceId;
    } else {
      audioOutputDevice = null;
    }
    if (btn) btn.classList.add('active');
  } catch (e) {
    if (btn) btn.classList.add('active');
  }
}

// =========================================================
// PWA
// =========================================================
function setupPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!IS_STANDALONE && localStorage.getItem('hideInstallBanner') !== '1') {
      document.getElementById('install-banner').classList.remove('hidden');
    }
  });
if (!IS_NATIVE && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}
function installPWA() {
  if (IS_IOS) { showIosInstall(); return; }
  if (deferredInstallPrompt) { deferredInstallPrompt.prompt(); deferredInstallPrompt.userChoice.then(() => { deferredInstallPrompt = null; }); }
  else if (IS_STANDALONE) alert('App is already installed.');
  else alert('To install: open the browser menu → "Install App" or "Add to Home Screen".');
}
function hideInstallBanner() { document.getElementById('install-banner').classList.add('hidden'); localStorage.setItem('hideInstallBanner', '1'); }
function showIosInstall() { document.getElementById('modal-ios-install').classList.remove('hidden'); }
function closeIosInstall() { document.getElementById('modal-ios-install').classList.add('hidden'); }

// =========================================================
// AUTH
// =========================================================
async function doLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.add('hidden');
  if (!username || !password) { errEl.textContent = 'Enter username and password'; errEl.classList.remove('hidden'); return; }
  try {
    const res = await apiFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Login failed'; errEl.classList.remove('hidden'); playSound('error'); return; }
    me = data.user;
    document.getElementById('login-password').value = '';
    await afterLogin();
  } catch (e) { errEl.textContent = 'Network error'; errEl.classList.remove('hidden'); }
}
async function doLogout() { await apiFetch('/api/auth/logout', { method: 'POST' }); me = null; location.reload(); }

async function afterLogin() {
  document.getElementById('top-username').textContent = me.username;
  if (me.is_admin) document.getElementById('card-admin').classList.remove('hidden');
  if (IS_NATIVE) nativeStartService();
  try { const r = await apiFetch('/api/settings'); const d = await r.json(); settings = d.settings; } catch (e) {}
  getIceServers().catch(() => {});
  showScreen('screen-home');
}

// =========================================================
// SCREENS
// =========================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function openSettings() { if (!me) return; document.getElementById('set-retention').value = me.recording_retention_days || 30; showScreen('screen-settings'); }
async function saveSettings() {
  const days = parseInt(document.getElementById('set-retention').value, 10);
  if (isNaN(days) || days < 1 || days > 30) { alert('Retention 1-30 days'); return; }
  await apiFetch('/api/settings/user', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recording_retention_days: days }) });
  me.recording_retention_days = days;
  alert('Saved');
}
async function changePassword() {
  const oldPw = document.getElementById('set-old-pw').value;
  const newPw = document.getElementById('set-new-pw').value;
  if (!oldPw || !newPw) { alert('Both fields required'); return; }
  const res = await apiFetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  alert('Password changed. Please log in again.'); location.reload();
}

// =========================================================
// CREATE / JOIN
// =========================================================
async function goCreate() { showScreen('screen-create'); if (!myCode) await regenerateCode(); ensureListenerSocket(); }
function backFromCreate() { showScreen('screen-home'); }
function goJoin() { const input = document.getElementById('code-input'); if (input) input.value = ''; document.getElementById('join-error').classList.add('hidden'); showScreen('screen-join'); }
async function regenerateCode() {
  const res = await apiFetch('/api/code', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const data = await res.json();
  myCode = data.code;
  document.getElementById('generated-code').textContent = myCode;
  if (ws && wsRoomId !== myCode) closeSocket();
  ensureListenerSocket();
}
async function copyCode(e) {
  if (!myCode) return;
  await navigator.clipboard.writeText(myCode);
  const btn = e.currentTarget; const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
  setTimeout(() => (btn.innerHTML = orig), 1200);
}

// =========================================================
// WEBSOCKET
// =========================================================
function ensureListenerSocket() {
  if (!myCode || currentCall) return;
  if (ws && wsRoomId === myCode && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  openSocket(myCode, 'receiver-listener');
}
function openSocket(roomId, role) {
  closeSocket();
  wsRoomId = roomId; wsJoined = false; wsQueue = [];
  try { ws = new WebSocket(WS_BASE + '/ws/' + roomId); } catch (e) { return; }
  ws.onopen = () => {
    wsJoined = true;
    try { ws.send(JSON.stringify({ type: 'join', peerId: myPeerId, role, username: me ? me.username : '' })); } catch (e) {}
    for (const m of wsQueue) { try { ws.send(JSON.stringify(m)); } catch (e) {} }
    wsQueue = [];
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) {} } }, 25000);
  };
  ws.onmessage = (e) => { let msg; try { msg = JSON.parse(e.data); } catch { return; } if (msg.type === 'pong') return; handleSignal(msg); };
  ws.onclose = () => { if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; } wsJoined = false; };
  ws.onerror = () => {};
}
function closeSocket() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (ws) { try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch (e) {} ws = null; }
  wsJoined = false; wsQueue = [];
}
function wsSend(msg) { if (ws && ws.readyState === WebSocket.OPEN && wsJoined) { try { ws.send(JSON.stringify(msg)); } catch (e) {} } else wsQueue.push(msg); }

// =========================================================
// SIGNALS
// =========================================================
async function handleSignal(msg) {
  switch (msg.type) {
    case 'call-request':
      if (msg.code === myCode) handleIncomingCall(msg);
      break;
    case 'call-accepted':
      if (currentCall && currentCall.role === 'caller' && currentCall.state === 'dialing') {
        currentCall.state = 'connecting';
        currentCall.remotePeerId = msg.from;
        currentCall.remoteUsername = msg.username || 'Peer';
        setCallStatus('Connecting…');
        stopSound('dialTone');
        await setupCallerPeerConnection();
      }
      break;
    case 'call-declined':
      if (currentCall && currentCall.role === 'caller') { stopSound('dialTone'); playSound('error'); endCall(true); alert('Call declined.'); }
      break;
    case 'signal':
      if (currentCall && currentCall.pc) await applyRemoteSignal(msg.signal);
      break;
    case 'peer-left':
      if (currentCall) { setCallStatus('Peer ended call'); stopSound('ringtone'); stopSound('dialTone'); playSound('hangup'); setTimeout(() => { if (currentCall) endCall(true); }, 400); }
      break;
    case 'leave':
      if (currentCall) { stopSound('ringtone'); stopSound('dialTone'); playSound('hangup'); setTimeout(() => { if (currentCall) endCall(true); }, 400); }
      break;
    case 'mode-switched':
      await handlePeerModeSwitch(msg.callType);
      break;
    case 'time-warning':
      showNetworkBanner('Call ends in ' + (msg.minutesLeft || 5) + ' minutes');
      break;
    case 'time-limit-reached':
      showNetworkBanner('Time limit reached', true);
      setTimeout(() => endCall(), 2000);
      break;
    case 'quality':
      showNetworkBanner('Poor connection');
      break;
  }
}

// =========================================================
// MODE SWITCHING — track.enabled toggle approach (NO renegotiation)
// =========================================================
async function switchMode() {
  if (!currentCall) return;
  const newType = currentCallType === 'video' ? 'audio' : 'video';
  await applyMode(newType);
  wsSend({ type: 'switch-mode', callType: newType });
}

async function applyMode(newType) {
  if (!currentCall) return;
  const pc = currentCall.pc;
  if (!pc) return;

  // Find video sender (the transceiver may not have a track if peer disabled their camera, so search transceivers too)
  let videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
  if (!videoSender) {
    // Look at transceivers for one that carries video
    for (const tr of pc.getTransceivers()) {
      if (tr.sender && tr.sender.track && tr.sender.track.kind === 'video') {
        videoSender = tr.sender; break;
      }
      if (tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video') {
        videoSender = tr.sender; break;
      }
    }
  }

  if (newType === 'audio') {
    // Turn OFF our camera track (but keep the transceiver alive)
    if (videoSender && videoSender.track) {
      videoSender.track.enabled = false;
    }
    const localVideoTrack = currentCall.localStream ? currentCall.localStream.getVideoTracks()[0] : null;
    if (localVideoTrack) localVideoTrack.enabled = false;

    document.getElementById('local-video').classList.add('hidden');
    document.getElementById('local-show-pill').classList.add('hidden');
  } else {
    // Turn ON our camera track
    let track = currentCall.localStream ? currentCall.localStream.getVideoTracks()[0] : null;

    // If we have no track at all (rare), try to acquire one
    if (!track) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode, width: 1280, height: 720 } });
        track = s.getVideoTracks()[0];
        currentCall.localStream.addTrack(track);
        if (videoSender) { try { await videoSender.replaceTrack(track); } catch (e) {} }
        else { try { pc.addTrack(track, currentCall.localStream); } catch (e) {} }
      } catch (e) {
        showNetworkBanner('Camera unavailable');
        return;
      }
    } else {
      // Just re-enable
      track.enabled = true;
      if (videoSender && videoSender.track !== track) {
        try { await videoSender.replaceTrack(track); } catch (e) {}
      }
    }

    const lv = document.getElementById('local-video');
    lv.srcObject = currentCall.localStream;
    lv.play().catch(() => {});
    lv.classList.remove('hidden', 'dimmed');
  }

  // Switch UI
  currentCallType = newType;
  document.getElementById('screen-call').dataset.mode = newType;
  updateModeUI();

  if (newType === 'audio') {
    document.getElementById('remote-placeholder').classList.remove('hidden');
    document.getElementById('placeholder-text').textContent = 'Audio call';
    document.getElementById('audio-peer-name').textContent = currentCall.remoteUsername || 'Peer';
  } else {
    // Show peer video container
    const rv = document.getElementById('remote-video');
    const rs = currentCall.remoteStream;
    if (rs) {
      rv.srcObject = rs;
      rv.play().catch(() => {});
      // If we have a live video track, hide placeholder
      const hasLiveVideo = rs.getVideoTracks().some(t => t.readyState === 'live');
      if (hasLiveVideo) {
        document.getElementById('remote-placeholder').classList.add('hidden');
      }
    }
  }

  resetUIIdleTimer();
  resetLocalVideoIdleTimer();
}

async function handlePeerModeSwitch(newType) {
  if (!currentCall) return;
  if (newType === currentCallType) return;
  showNetworkBanner('Peer switched to ' + newType);
  await applyMode(newType);
}

function updateModeUI() {
  const btn = document.getElementById('btn-mode');
  if (!btn) return;
  const icon = btn.querySelector('i');
  const label = btn.querySelector('small');
  if (currentCallType === 'video') {
    icon.className = 'fa-solid fa-phone-slash';
    label.textContent = 'Audio';
    btn.classList.remove('active', 'mode-highlight');
    btn.title = 'Switch to audio call';
  } else {
    icon.className = 'fa-solid fa-video';
    label.textContent = 'Video';
    btn.classList.add('active', 'mode-highlight');
    btn.title = 'Switch to video call';
  }
}

// =========================================================
// INCOMING
// =========================================================

function handleIncomingCall(msg) {
  if (incomingCallData || currentCall) return;
  incomingCallData = msg;
  if (IS_NATIVE) nativeNotifyIncoming(msg.username || 'Someone');
  document.getElementById('caller-name').textContent = msg.username || 'someone';
  showScreen('screen-home');
  document.getElementById('incoming-toast').classList.remove('hidden');
  playSound('ringtone', true);
  if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 500]);
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification('Incoming call from ' + (msg.username || 'someone')); } catch (e) {}
}

async function acceptIncoming() {
  stopSound('ringtone');
  if (IS_NATIVE) nativeCancelIncoming();
  if (!incomingCallData) return;
  stopSound('ringtone');
  if (!incomingCallData) return;
  document.getElementById('incoming-toast').classList.add('hidden');
  const { callerId, code, username } = incomingCallData;
  incomingCallData = null;
  const ok = await requestPermissions();
  if (!ok) return;
  await enumerateDevices();

  if (!ws || ws.readyState !== WebSocket.OPEN || wsRoomId !== code) openSocket(code, 'receiver');
  else { try { ws.send(JSON.stringify({ type: 'join', peerId: myPeerId, role: 'receiver', username: me.username })); } catch (e) {} }

  openCallScreen({ role: 'receiver', code, remotePeerId: callerId, remoteUsername: username || 'Peer' });
  setCallStatus('Connecting…');
  currentCallType = 'video';
  document.getElementById('screen-call').dataset.mode = 'video';
  updateModeUI();

  await setupReceiverPeerConnection();
  wsSend({ type: 'call-accepted', to: callerId, username: me.username });
  wsSend({ type: 'call-start', callType: 'video' });

  const offer = await currentCall.pc.createOffer();
  await currentCall.pc.setLocalDescription(offer);
  wsSend({ type: 'signal', signal: offer });

  // removed: setTimeout(setDefaultAudioRoute, 800);
}

function declineIncoming() {
  stopSound('ringtone');
  if (IS_NATIVE) nativeCancelIncoming();
  if (!incomingCallData) return;
  wsSend({ type: 'call-declined' });
  incomingCallData = null;
  document.getElementById('incoming-toast').classList.add('hidden');
  playSound('hangup');
}

// =========================================================
// JOIN
// =========================================================
async function joinCall() {
  const input = document.getElementById('code-input');
  const errEl = document.getElementById('join-error');
  const code = input.value.trim();
  if (!/^\\d{6}$/.test(code)) { errEl.textContent = 'Enter a valid 6-digit code'; errEl.classList.remove('hidden'); playSound('error'); return; }
  errEl.classList.add('hidden');
  const res = await apiFetch('/api/code/' + code);
  if (!res.ok) { errEl.textContent = 'Invalid or expired code'; errEl.classList.remove('hidden'); playSound('error'); return; }
  const codeData = await res.json();

  const ok = await requestPermissions();
  if (!ok) return;
  await enumerateDevices();

  myPeerId = crypto.randomUUID();
  openCallScreen({ role: 'caller', code, remotePeerId: null, remoteUsername: codeData.username || 'Peer' });
  setCallStatus('Calling…');
  currentCallType = 'video';
  document.getElementById('screen-call').dataset.mode = 'video';
  updateModeUI();
  playSound('dialTone');

  openSocket(code, 'caller');
  wsSend({ type: 'call-request', code, callerId: myPeerId, username: me.username });
  wsSend({ type: 'call-start', callType: 'video' });

  setTimeout(() => { if (currentCall && currentCall.role === 'caller' && currentCall.state === 'dialing') { stopSound('dialTone'); endCall(true); alert('No answer.'); } }, 30000);
}

// =========================================================
// PEER CONNECTION
// =========================================================
async function getLocalMedia() {
  if (currentCall.localStream) return currentCall.localStream;
  try {
    currentCall.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, facingMode: currentFacingMode }
    });
  } catch (e) {
    currentCall.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    showNetworkBanner('Camera unavailable — audio only');
  }
  const lv = document.getElementById('local-video');
  lv.srcObject = currentCall.localStream;
  lv.play().catch(() => {});
  return currentCall.localStream;
}

async function createPeerConnection() {
  const config = await getIceServers();
  const pc = new RTCPeerConnection(config);
  const remoteStream = new MediaStream();
  currentCall.remoteStream = remoteStream;

  const rv = document.getElementById('remote-video');
  rv.srcObject = remoteStream;
  rv.play().catch(() => {});

  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(t => {
      if (!remoteStream.getTracks().find(x => x.id === t.id)) remoteStream.addTrack(t);
    });
    rv.play().catch(() => {});
    const hasLiveVideo = remoteStream.getVideoTracks().some(t => t.readyState === 'live');
    if (hasLiveVideo && currentCallType === 'video') {
      document.getElementById('remote-placeholder').classList.add('hidden');
    }
  };

  // Also listen for track mute/unmute
  remoteStream.addEventListener('addtrack', (ev) => {
    if (ev.track.kind === 'video') {
      ev.track.onunmute = () => {
        if (currentCallType === 'video') {
          document.getElementById('remote-placeholder').classList.add('hidden');
          rv.play().catch(() => {});
        }
      };
      ev.track.onmute = () => {
        if (currentCallType === 'video') {
          document.getElementById('remote-placeholder').classList.remove('hidden');
          document.getElementById('placeholder-text').textContent = 'Peer video paused';
        }
      };
    }
  });

  pc.onicecandidate = (ev) => { if (ev.candidate) wsSend({ type: 'signal', signal: { candidate: ev.candidate } }); };

  const onConnected = () => {
    if (!currentCall || currentCall.state === 'connected') return;
    currentCall.state = 'connected';
    setCallStatus('Connected');
    startTimer();
    startNetworkMonitor();
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') onConnected();
    else if (pc.connectionState === 'failed') showNetworkBanner('Connection failed', true);
  };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') onConnected(); };
  pc.onnegotiationneeded = async () => {
    try { if (!currentCall || pc.signalingState !== 'stable') return; const offer = await pc.createOffer(); await pc.setLocalDescription(offer); wsSend({ type: 'signal', signal: offer }); } catch (e) {}
  };

  currentCall.pc = pc;
  return pc;
}

async function setupReceiverPeerConnection() {
  if (!currentCall) return;
  const stream = await getLocalMedia();
  const pc = await createPeerConnection();
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  // removed: setTimeout(setDefaultAudioRoute, 800);
}
async function setupCallerPeerConnection() {
  if (!currentCall) return;
  const stream = await getLocalMedia();
  const pc = await createPeerConnection();
  stream.getTracks().forEach(t => pc.addTrack(t, stream));
  // removed: setTimeout(setDefaultAudioRoute, 800);
}

async function applyRemoteSignal(sig) {
  if (!sig || !currentCall.pc) return;
  const pc = currentCall.pc;
  try {
    if (sig.type === 'offer') {
      await pc.setRemoteDescription(sig);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'signal', signal: answer });
    } else if (sig.type === 'answer') {
      if (pc.signalingState !== 'stable') await pc.setRemoteDescription(sig);
    } else if (sig.candidate) {
      try { await pc.addIceCandidate(sig.candidate); } catch (e) {}
    }
  } catch (e) {}
}

// =========================================================
// CALL SCREEN
// =========================================================
function openCallScreen({ role, code, remotePeerId, remoteUsername }) {
  currentCall = {
    role, code,
    remotePeerId: remotePeerId || null,
    remoteUsername: remoteUsername || 'Peer',
    state: role === 'caller' ? 'dialing' : 'connecting',
    pc: null, localStream: null, remoteStream: null, startedAt: null
  };
  document.getElementById('remote-placeholder').classList.remove('hidden');
  document.getElementById('placeholder-text').textContent = 'Waiting…';
  document.getElementById('remote-video').srcObject = null;
  document.getElementById('local-video').srcObject = null;
  document.getElementById('local-video').classList.remove('hidden', 'dimmed');
  document.getElementById('local-show-pill').classList.add('hidden');
  document.getElementById('call-timer').textContent = '00:00';
  document.getElementById('btn-record').classList.remove('active');
  document.getElementById('rec-indicator').classList.add('hidden');
  document.getElementById('btn-speaker').classList.add('active');
  document.getElementById('audio-peer-name').textContent = currentCall.remoteUsername;
  hideNetworkBanner();
  showScreen('screen-call');
  resetUIIdleTimer();
  resetLocalVideoIdleTimer();
  updateFullscreenBtn();
  attachLocalVideoDrag();
}

function setCallStatus(t) { const el = document.getElementById('call-status'); if (el) el.textContent = t; }

function startTimer() {
  if (timerInterval) return;
  currentCall.startedAt = Date.now();
  timerInterval = setInterval(() => {
    if (!currentCall) return;
    const sec = Math.floor((Date.now() - currentCall.startedAt) / 1000);
    const el = document.getElementById('call-timer');
    if (el) el.textContent = formatTime(sec);
  }, 1000);
}
function formatTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}

// =========================================================
// FULLSCREEN
// =========================================================
function toggleFullscreen() {
  const el = document.getElementById('screen-call');
  const isFs = !!document.fullscreenElement || !!document.webkitFullscreenElement;
  if (!isFs) {
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
  setTimeout(updateFullscreenBtn, 100);
}
function updateFullscreenBtn() {
  const btn = document.getElementById('btn-fullscreen-video');
  if (!btn) return;
  const isFs = !!document.fullscreenElement || !!document.webkitFullscreenElement;
  btn.innerHTML = isFs ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
}
document.addEventListener('fullscreenchange', updateFullscreenBtn);

// =========================================================
// GESTURES
// =========================================================
function initCallScreenGestures() {
  const screen = document.getElementById('screen-call');
  if (!screen) return;
  screen.addEventListener('click', (e) => {
    if (e.target.closest('.call-controls, .call-top, #local-video, .local-show-pill')) return;
    resetUIIdleTimer();
  });
  screen.addEventListener('touchstart', (e) => {
    if (e.target.closest('.call-controls, .call-top, #local-video, .local-show-pill')) return;
    resetUIIdleTimer();
  }, { passive: true });
  const lv = document.getElementById('local-video');
  if (lv) lv.addEventListener('click', (e) => { e.stopPropagation(); lv.classList.remove('dimmed'); resetLocalVideoIdleTimer(); });
}

function resetUIIdleTimer() {
  const ctrl = document.getElementById('call-controls');
  const top = document.getElementById('call-top');
  if (ctrl) ctrl.classList.remove('hidden-ui');
  if (top) top.classList.remove('hidden-ui');
  if (uiIdleTimer) clearTimeout(uiIdleTimer);
  uiIdleTimer = setTimeout(() => {
    if (ctrl) ctrl.classList.add('hidden-ui');
    if (top) top.classList.add('hidden-ui');
  }, 6000);
}
function resetLocalVideoIdleTimer() {
  const lv = document.getElementById('local-video');
  if (!lv) return;
  if (lv.classList.contains('hidden')) return;
  lv.classList.remove('dimmed');
  if (localVideoIdleTimer) clearTimeout(localVideoIdleTimer);
  localVideoIdleTimer = setTimeout(() => {
    if (lv) { lv.classList.add('dimmed'); document.getElementById('local-show-pill').classList.remove('hidden'); }
  }, 15000);
}
function restoreLocalVideo() {
  const lv = document.getElementById('local-video');
  lv.classList.remove('dimmed', 'hidden');
  document.getElementById('local-show-pill').classList.add('hidden');
  resetLocalVideoIdleTimer();
}
function attachLocalVideoDrag() {
  const lv = document.getElementById('local-video');
  if (!lv || lv._dragAttached) return;
  lv._dragAttached = true;
  let startX, startY, startLeft, startTop, dragging = false;
  const onDown = (e) => {
    const touch = e.touches ? e.touches[0] : e;
    dragging = true;
    lv.classList.add('dragging');
    const rect = lv.getBoundingClientRect();
    startLeft = rect.left; startTop = rect.top;
    startX = touch.clientX; startY = touch.clientY;
    lv.style.left = startLeft + 'px'; lv.style.top = startTop + 'px';
    lv.style.right = 'auto'; lv.style.bottom = 'auto';
    e.preventDefault && e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    const touch = e.touches ? e.touches[0] : e;
    const dx = touch.clientX - startX; const dy = touch.clientY - startY;
    const newLeft = Math.max(8, Math.min(window.innerWidth - lv.offsetWidth - 8, startLeft + dx));
    const newTop = Math.max(80, Math.min(window.innerHeight - lv.offsetHeight - 100, startTop + dy));
    lv.style.left = newLeft + 'px'; lv.style.top = newTop + 'px';
    e.preventDefault && e.preventDefault();
  };
  const onUp = () => { if (!dragging) return; dragging = false; lv.classList.remove('dragging'); resetLocalVideoIdleTimer(); };
  lv.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  lv.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

// =========================================================
// SPEAKER
// =========================================================
async function toggleSpeaker() {
  const btn = document.getElementById('btn-speaker');
  const v = document.getElementById('remote-video');
  const willBeSpeaker = !btn.classList.contains('active');

  // Native app path — use custom AudioRoute plugin
  if (IS_NATIVE) {
    try {
      const { registerPlugin } = await import('@capacitor/core');
      const AudioRoute = registerPlugin('AudioRoute');
      await AudioRoute.setSpeaker({ on: willBeSpeaker });
      btn.classList.toggle('active', willBeSpeaker);
      showNetworkBanner(willBeSpeaker ? 'Speaker ON' : 'Earpiece');
      return;
    } catch (e) {
      console.warn('Native audio toggle failed:', e);
    }
  }

  // Web path
  if (!v.setSinkId) {
    btn.classList.toggle('active', willBeSpeaker);
    showNetworkBanner(willBeSpeaker ? 'Speaker ON' : 'Earpiece');
    return;
  }

  try {
    if (willBeSpeaker) {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const sp = devs.filter(d => d.kind === 'audiooutput');
      const speaker = sp.find(s => /speaker|loud/i.test(s.label))
        || sp.find(s => s.deviceId !== 'default' && s.deviceId !== '');
      if (speaker) {
        await v.setSinkId(speaker.deviceId);
        audioOutputDevice = speaker.deviceId;
      } else {
        await v.setSinkId('');
        audioOutputDevice = '';
      }
      btn.classList.add('active');
      showNetworkBanner('Speaker ON');
    } else {
      await v.setSinkId('');
      audioOutputDevice = null;
      btn.classList.remove('active');
      showNetworkBanner('Earpiece');
    }
  } catch (e) {
    btn.classList.toggle('active', willBeSpeaker);
    showNetworkBanner(willBeSpeaker ? 'Speaker ON' : 'Earpiece');
  }
}

// =========================================================
// CONTROLS
// =========================================================
function toggleMute() {
  if (!currentCall?.localStream) return;
  const t = currentCall.localStream.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  const btn = document.getElementById('btn-mute');
  btn.querySelector('i').className = t.enabled ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash';
  btn.classList.toggle('active', !t.enabled);
  resetUIIdleTimer();
}
function toggleCamera() {
  if (!currentCall?.localStream) return;
  const t = currentCall.localStream.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  const btn = document.getElementById('btn-camera');
  btn.querySelector('i').className = t.enabled ? 'fa-solid fa-video' : 'fa-solid fa-video-slash';
  btn.classList.toggle('active', !t.enabled);
  resetUIIdleTimer();
}
async function flipCamera() {
  if (!currentCall?.localStream) return;
  const old = currentCall.localStream.getVideoTracks()[0];
  if (!old) return;
  currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: currentFacingMode, width: 1280, height: 720 } });
    const nt = s.getVideoTracks()[0];
    const sender = currentCall.pc.getSenders().find(x => x.track && x.track.kind === 'video');
    if (sender) await sender.replaceTrack(nt);
    currentCall.localStream.removeTrack(old); old.stop(); currentCall.localStream.addTrack(nt);
    document.getElementById('local-video').srcObject = currentCall.localStream;
  } catch (e) {}
  resetUIIdleTimer();
}
async function switchMic(id) {
  if (!currentCall?.localStream) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id } } });
    const nt = s.getAudioTracks()[0];
    const old = currentCall.localStream.getAudioTracks()[0];
    const sender = currentCall.pc.getSenders().find(x => x.track && x.track.kind === 'audio');
    if (sender) await sender.replaceTrack(nt);
    currentCall.localStream.removeTrack(old); old.stop(); currentCall.localStream.addTrack(nt);
  } catch (e) {}
}
async function switchCamera(id) {
  if (!currentCall?.localStream) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: id }, width: 1280, height: 720 } });
    const nt = s.getVideoTracks()[0];
    const old = currentCall.localStream.getVideoTracks()[0];
    const sender = currentCall.pc.getSenders().find(x => x.track && x.track.kind === 'video');
    if (sender) await sender.replaceTrack(nt);
    currentCall.localStream.removeTrack(old); old.stop(); currentCall.localStream.addTrack(nt);
    document.getElementById('local-video').srcObject = currentCall.localStream;
  } catch (e) {}
}

// =========================================================
// SCREEN SHARE
// =========================================================
async function toggleScreenShare() {
  if (!currentCall?.pc) return;
  const btn = document.getElementById('btn-share');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    alert('Screen sharing is not supported on this device/browser.\\n\\nIt works on desktop browsers only.');
    return;
  }
  if (!isScreenSharing) {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
      const st = s.getVideoTracks()[0];
      originalVideoTrack = currentCall.localStream.getVideoTracks()[0];
      const sender = currentCall.pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (sender) await sender.replaceTrack(st);
      if (originalVideoTrack) currentCall.localStream.removeTrack(originalVideoTrack);
      currentCall.localStream.addTrack(st);
      document.getElementById('local-video').srcObject = currentCall.localStream;
      isScreenSharing = true;
      btn.classList.add('active');
      st.onended = () => stopScreenShare();
      showNetworkBanner('Screen sharing active');
    } catch (e) { if (e.name !== 'NotAllowedError') showNetworkBanner('Share failed'); }
  } else { await stopScreenShare(); }
  resetUIIdleTimer();
}
async function stopScreenShare() {
  if (!currentCall || !originalVideoTrack) return;
  const sender = currentCall.pc.getSenders().find(x => x.track && x.track.kind === 'video');
  if (sender) await sender.replaceTrack(originalVideoTrack);
  const st = currentCall.localStream.getVideoTracks()[0];
  if (st && st !== originalVideoTrack) { currentCall.localStream.removeTrack(st); st.stop(); }
  currentCall.localStream.addTrack(originalVideoTrack);
  document.getElementById('local-video').srcObject = currentCall.localStream;
  isScreenSharing = false;
  document.getElementById('btn-share').classList.remove('active');
  hideNetworkBanner();
}

// =========================================================
// RECORDING
// =========================================================
function toggleRecording() {
  const btn = document.getElementById('btn-record');
  const ind = document.getElementById('rec-indicator');
  if (!settings || !settings.recording_enabled) { alert('Recording is disabled by the administrator.'); return; }
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    const hasVideo = currentCallType === 'video' && currentCall?.localStream && currentCall.localStream.getVideoTracks().length > 0;
    const tracks = [];
    if (currentCall?.localStream) {
      if (hasVideo) tracks.push(...currentCall.localStream.getVideoTracks());
      tracks.push(...currentCall.localStream.getAudioTracks());
    }
    if (currentCall?.remoteStream) {
      if (hasVideo) tracks.push(...currentCall.remoteStream.getVideoTracks());
      tracks.push(...currentCall.remoteStream.getAudioTracks());
    }
    if (tracks.length === 0) { alert('Nothing to record'); return; }
    currentRecordingHasVideo = hasVideo;
    const combined = new MediaStream(tracks);
    recordedChunks = []; recordingStart = Date.now(); recordingId = crypto.randomUUID();
    let opts;
    if (hasVideo) {
      const quality = settings.video_recording_quality || '720p';
      const videoBits = quality === '1080p' ? 2500000 : quality === '720p' ? 1500000 : 800000;
      opts = { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: videoBits, audioBitsPerSecond: 64000 };
      if (!MediaRecorder.isTypeSupported(opts.mimeType)) opts = { mimeType: 'video/webm' };
    } else {
      opts = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 };
      if (!MediaRecorder.isTypeSupported(opts.mimeType)) opts = { mimeType: 'audio/webm' };
    }
    try { mediaRecorder = new MediaRecorder(combined, opts); } catch (e) { mediaRecorder = new MediaRecorder(combined); }
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = uploadRecording;
    mediaRecorder.start(1000);
    btn.classList.add('active');
    btn.querySelector('i').className = 'fa-solid fa-stop';
    ind.classList.remove('hidden');
    document.getElementById('rec-label').textContent = hasVideo ? 'REC · VIDEO' : 'REC · AUDIO';
  } else {
    mediaRecorder.stop();
    btn.classList.remove('active');
    btn.querySelector('i').className = 'fa-solid fa-circle';
    ind.classList.add('hidden');
  }
  resetUIIdleTimer();
}
async function uploadRecording() {
  if (recordedChunks.length === 0) { mediaRecorder = null; return; }
  const mimeType = currentRecordingHasVideo ? 'video/webm' : 'audio/webm';
  const blob = new Blob(recordedChunks, { type: mimeType });
  const duration = Math.floor((Date.now() - recordingStart) / 1000);
  const id = recordingId;
  try {
    await apiFetch('/api/recording/upload?id=' + id, { method: 'PUT', body: blob, headers: { 'Content-Type': mimeType } });
    await apiFetch('/api/recording', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId: id, callCode: currentCall ? currentCall.code : '', callerId: myPeerId, duration, fileSize: blob.size, hasVideo: currentRecordingHasVideo })
    });
    showNetworkBanner('Recording saved');
  } catch (e) {}
  mediaRecorder = null; recordedChunks = [];
}

// =========================================================
// NETWORK
// =========================================================
function startNetworkMonitor() {
  if (networkMonitor) clearInterval(networkMonitor);
  let poor = 0;
  networkMonitor = setInterval(async () => {
    if (!currentCall?.pc) return;
    try {
      const stats = await currentCall.pc.getStats();
      let rtt = 0;
      stats.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded') rtt = (r.currentRoundTripTime || 0) * 1000; });
      if (rtt > 500) { poor++; if (poor >= 3) { showNetworkBanner('Poor connection'); poor = 0; } }
      else if (poor > 0) poor--;
    } catch (e) {}
  }, 3000);
}
function showNetworkBanner(text, bad) {
  const b = document.getElementById('network-banner');
  if (!b) return;
  document.getElementById('network-banner-text').textContent = text;
  b.classList.toggle('bad', !!bad);
  b.classList.remove('hidden');
  clearTimeout(b._hideTimer);
  b._hideTimer = setTimeout(() => { b.classList.add('hidden'); }, 4000);
}
function hideNetworkBanner() { const b = document.getElementById('network-banner'); if (b) b.classList.add('hidden'); }

// =========================================================
// END CALL
// =========================================================
 function endCall(silent) {
  if (!currentCall) return;
  if (IS_NATIVE) nativeCancelIncoming();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch (e) {} }
  if (networkMonitor) { clearInterval(networkMonitor); networkMonitor = null; }
  if (uiIdleTimer) { clearTimeout(uiIdleTimer); uiIdleTimer = null; }
  if (localVideoIdleTimer) { clearTimeout(localVideoIdleTimer); localVideoIdleTimer = null; }
  stopSound('dialTone'); stopSound('ringtone'); stopSound('connected');
  if (!silent) { playSound('hangup'); wsSend({ type: 'leave' }); }
  if (currentCall.pc) { try { currentCall.pc.close(); } catch (e) {} }
  if (currentCall.localStream) currentCall.localStream.getTracks().forEach(t => t.stop());
  clearInterval(timerInterval); timerInterval = null;
  const wasReceiver = currentCall.role === 'receiver';
  currentCall = null;
  closeSocket();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (wasReceiver) { showScreen('screen-create'); if (myCode) setTimeout(() => openSocket(myCode, 'receiver-listener'), 400); }
  else showScreen('screen-home');
}

// =========================================================
// PERMISSIONS
// =========================================================
async function requestPermissions() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    s.getTracks().forEach(t => t.stop());
    return true;
  } catch (err) { showPermissionModal(err); return false; }
}
function showPermissionModal(err) {
  const modal = document.getElementById('perm-modal');
  const title = document.getElementById('perm-title');
  const msg = document.getElementById('perm-message');
  if (err.name === 'NotAllowedError') {
    title.textContent = 'Permission Blocked';
    msg.innerHTML = 'Click the <strong>lock icon</strong> in the address bar → set Camera & Microphone to <strong>Allow</strong> → reload.';
  } else if (err.name === 'NotFoundError') {
    title.textContent = 'No Device Found';
    msg.textContent = 'No camera or microphone detected.';
  } else {
    title.textContent = 'Permission Error';
    msg.textContent = err.message || 'Unable to access media devices.';
  }
  modal.classList.remove('hidden');
}
async function retryPermissions() { document.getElementById('perm-modal').classList.add('hidden'); await requestPermissions(); }
function showPermHelp() { alert('Chrome/Edge:\\n1. Click lock icon in URL bar\\n2. Set Camera & Microphone to Allow\\n3. Reload'); }

async function enumerateDevices() {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    devices.mics = list.filter(d => d.kind === 'audioinput');
    devices.cams = list.filter(d => d.kind === 'videoinput');
  } catch (e) {}
}

// =========================================================
// RECORDINGS UI
// =========================================================
function setRecordingFilter(f) {
  recordingFilter = f;
  document.querySelectorAll('.filter-btn[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === f));
  renderRecordings();
}
async function renderRecordings() {
  const c = document.getElementById('recordings-list');
  const subtitle = document.getElementById('recordings-subtitle');
  if (me && me.is_admin) subtitle.textContent = "All users recordings";
  else subtitle.textContent = "Your saved calls";
  try {
    const res = await apiFetch('/api/recordings');
    const data = await res.json();
    let list = data.recordings || [];
    if (recordingFilter === 'audio') list = list.filter(r => !r.has_video);
    else if (recordingFilter === 'video') list = list.filter(r => r.has_video);
    if (list.length === 0) { c.innerHTML = '<div class="empty"><i class="fa-solid fa-inbox"></i><br>No recordings</div>'; return; }
    c.innerHTML = '';
    for (const r of list) {
      const date = new Date(r.created_at).toLocaleString();
      const daysLeft = Math.max(0, Math.ceil((r.expires_at - Date.now()) / 86400000));
      const item = document.createElement('div');
      item.className = 'rec-item';
      item.dataset.recId = r.id;
      item.dataset.hasVideo = r.has_video ? '1' : '0';
      const header = document.createElement('div'); header.className = 'rec-item-header';
      const dateSpan = document.createElement('span'); dateSpan.className = 'date'; dateSpan.innerHTML = '<i class="fa-solid fa-calendar"></i> ' + date;
      const timeSpan = document.createElement('span'); timeSpan.innerHTML = '<i class="fa-solid fa-clock"></i> ' + formatTime(r.duration || 0);
      header.appendChild(dateSpan); header.appendChild(timeSpan);
      const sub = document.createElement('div'); sub.className = 'rec-item-sub';
      const typeBadge = document.createElement('span'); typeBadge.className = 'badge'; typeBadge.textContent = r.has_video ? 'Video' : 'Audio';
      sub.appendChild(typeBadge);
      if (me.is_admin && r.owner_username) {
        const ob = document.createElement('span'); ob.className = 'badge'; ob.textContent = r.owner_username; sub.appendChild(ob);
      }
      const leftSpan = document.createElement('span'); leftSpan.textContent = daysLeft + 'd left'; sub.appendChild(leftSpan);
      item.appendChild(header); item.appendChild(sub); c.appendChild(item);
    }
  } catch (e) { c.innerHTML = '<div class="empty">Failed to load</div>'; }
}
function openRecording(id, hasVideo) {
  currentRecordingId = id;
  const modal = document.getElementById('modal-rec');
  const v = document.getElementById('rec-view-video');
  const a = document.getElementById('rec-view-audio');
  const modes = document.getElementById('rec-view-modes');
  const meta = document.getElementById('rec-view-meta');
  v.src = API_BASE + '/api/recording/' + id;
  a.src = API_BASE + '/api/recording/' + id;
  if (hasVideo) { v.classList.remove('hidden'); a.classList.add('hidden'); modes.classList.remove('hidden'); }
  else { v.classList.add('hidden'); a.classList.remove('hidden'); modes.classList.add('hidden'); }
  meta.textContent = 'ID: ' + id;
  modal.classList.remove('hidden');
}
function switchRecView(mode) {
  const v = document.getElementById('rec-view-video');
  const a = document.getElementById('rec-view-audio');
  const wasPlaying = !v.paused;
  if (mode === 'audio') {
    v.classList.add('hidden'); a.classList.remove('hidden');
    a.currentTime = v.currentTime; if (wasPlaying) a.play();
  } else {
    a.classList.add('hidden'); v.classList.remove('hidden');
    v.currentTime = a.currentTime; if (wasPlaying) v.play();
  }
  document.querySelectorAll('#rec-view-modes .filter-btn').forEach(b => b.classList.toggle('active', b.dataset.recView === mode));
}
function closeModalRec() {
  const v = document.getElementById('rec-view-video');
  const a = document.getElementById('rec-view-audio');
  v.pause(); a.pause(); v.src = ''; a.src = '';
  document.getElementById('modal-rec').classList.add('hidden');
  currentRecordingId = null;
}
async function deleteCurrentRecording() {
  if (!currentRecordingId) return;
  if (!confirm('Delete this recording permanently?')) return;
  const res = await apiFetch('/api/recording/' + currentRecordingId, { method: 'DELETE' });
  if (!res.ok) { alert('Delete failed'); return; }
  closeModalRec(); renderRecordings();
}

// =========================================================
// ADMIN
// =========================================================
async function openAdmin() { showScreen('screen-admin'); await loadAdminUsers(); await loadAdminSettings(); }
async function loadAdminUsers() {
  const c = document.getElementById('admin-users-list');
  const res = await apiFetch('/api/admin/users');
  const data = await res.json();
  c.innerHTML = (data.users || []).map(u => {
    const badge = u.is_admin ? '<span class="badge">Admin</span>' : '';
    return '<div class="admin-user"><div class="admin-user-info"><strong>' + u.username + badge + '</strong><small>Retention: ' + u.recording_retention_days + 'd</small></div>' +
      '<div class="admin-user-actions">' +
        '<button data-uid="' + u.id + '" data-uname="' + u.username + '" data-uadmin="' + (u.is_admin ? 1 : 0) + '" data-uret="' + u.recording_retention_days + '" class="edit-user-btn"><i class="fa-solid fa-pen"></i></button>' +
        '<button data-uid="' + u.id + '" data-uname="' + u.username + '" class="danger del-user-btn"><i class="fa-solid fa-trash"></i></button>' +
      '</div></div>';
  }).join('') || '<div class="empty">No users</div>';
  c.querySelectorAll('.edit-user-btn').forEach(b => b.onclick = () => editUser(b.dataset.uid, b.dataset.uname, b.dataset.uadmin === '1', parseInt(b.dataset.uret, 10)));
  c.querySelectorAll('.del-user-btn').forEach(b => b.onclick = () => deleteUser(b.dataset.uid, b.dataset.uname));
}
async function loadAdminSettings() {
  const res = await apiFetch('/api/settings');
  const data = await res.json();
  document.getElementById('admin-video-min').value = data.settings.max_video_call_minutes;
  document.getElementById('admin-audio-min').value = data.settings.max_audio_call_minutes;
  document.getElementById('admin-retention').value = data.settings.default_retention_days;
  document.getElementById('admin-rec-enabled').value = data.settings.recording_enabled ? 'true' : 'false';
  document.getElementById('admin-rec-quality').value = data.settings.video_recording_quality;
}
async function saveAdminSettings() {
  const updates = {
    max_video_call_minutes: parseInt(document.getElementById('admin-video-min').value, 10),
    max_audio_call_minutes: parseInt(document.getElementById('admin-audio-min').value, 10),
    default_retention_days: parseInt(document.getElementById('admin-retention').value, 10),
    recording_enabled: document.getElementById('admin-rec-enabled').value === 'true',
    video_recording_quality: document.getElementById('admin-rec-quality').value
  };
  const res = await apiFetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (!res.ok) { alert('Save failed'); return; }
  alert('Saved');
}
function openCreateUser() {
  editingUserId = null;
  document.getElementById('modal-user-title').textContent = 'Add User';
  document.getElementById('mu-username').value = '';
  document.getElementById('mu-password').value = '';
  document.getElementById('mu-admin').checked = false;
  document.getElementById('mu-retention').value = '30';
  document.getElementById('modal-user').classList.remove('hidden');
}
function editUser(id, username, isAdmin, retention) {
  editingUserId = id;
  document.getElementById('modal-user-title').textContent = 'Edit User';
  document.getElementById('mu-username').value = username;
  document.getElementById('mu-password').value = '';
  document.getElementById('mu-admin').checked = !!isAdmin;
  document.getElementById('mu-retention').value = retention;
  document.getElementById('modal-user').classList.remove('hidden');
}
function closeModalUser() { document.getElementById('modal-user').classList.add('hidden'); editingUserId = null; }
async function saveUserModal() {
  const username = document.getElementById('mu-username').value.trim();
  const password = document.getElementById('mu-password').value;
  const isAdmin = document.getElementById('mu-admin').checked;
  const retention = parseInt(document.getElementById('mu-retention').value, 10) || 30;
  if (!username) { alert('Username required'); return; }
  let res;
  if (editingUserId) {
    const body = { username, is_admin: isAdmin, recording_retention_days: retention };
    if (password) body.password = password;
    res = await apiFetch('/api/admin/users/' + editingUserId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } else {
    if (!password || password.length < 6) { alert('Password min 6 chars'); return; }
    res = await apiFetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, is_admin: isAdmin, recording_retention_days: retention }) });
  }
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed'); return; }
  closeModalUser(); await loadAdminUsers();
}
async function deleteUser(id, username) {
  if (!confirm('Delete user "' + username + '"?')) return;
  const res = await apiFetch('/api/admin/users/' + id, { method: 'DELETE' });
  if (!res.ok) { const d = await res.json(); alert(d.error || 'Failed'); return; }
  await loadAdminUsers();
}

const _origShow = showScreen;
window.showScreen = function (id) {
  _origShow(id);
  if (id === 'screen-recordings') renderRecordings();
};
