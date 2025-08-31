/** iSLAND Chat - Serverless P2P via WebRTC + Public Trackers
 *  - GitHub Pages deployable
 *  - No proprietary backend required
 *  - Room discovery/signaling via public WebRTC trackers (bittorrent-tracker)
 *  - Enforces mobile-only UI
 *  - PWA "앱으로 보기" button using beforeinstallprompt
 */

// ------------------ Constants ------------------
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
  'wss://tracker.btorrent.xyz'
];
const LSK = {
  UUID: 'island.uuid',
  NICK: 'island.nick',
  NICK_CHANGES: 'island.nick.changes', // timestamps
  CHAT_PREFIX: 'island.chat.',         // + roomCode
  OWN_ROOMS: 'island.ownRooms'         // local list for demo "열린 섬"
};
const DEFAULT_RULES_URL = 'rules.json';
const NICK_SUFFIX = 'iSLAND';
const MAX_NICK_CHANGES_PER_WEEK = 2;
const NICK_COOLDOWN_HOURS = 24;

// --- bittorrent-tracker 전역명 호환 ---
const TrackerClient =
  window.Client || (window.bittorrentTracker && window.bittorrentTracker.Client);
if (!TrackerClient) {
  console.error('bittorrent-tracker 전역을 찾을 수 없습니다. CDN 스크립트를 확인하세요.');
}


// ------------------ State ------------------
let state = {
  uuid: null,
  nick: null,
  peerId: null,        // 20-byte for tracker
  roomCode: null,      // 9-digit string
  client: null,        // bittorrent-tracker client
  peers: new Map(),    // peer.id -> peer(SimplePeer from tracker)
  rules: null,
  isOwner: false,
  deferredPrompt: null,
  muteMap: new Map(),  // offenderUUID -> { strikes, until: ts }
  spamCounter: new Map(), // uuid -> { count, windowStart }
};

// ------------------ Utilities ------------------
function $(id){ return document.getElementById(id); }
function hide(el){ el.classList.add('hidden'); }
function show(el){ el.classList.remove('hidden'); }
function now(){ return Date.now(); }
function hours(ms){ return ms/36e5; }
function days(ms){ return ms/864e5; }
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

function isMobile(){
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

function uuidv4(){
  // RFC4122 v4
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

function ensureUUID(){
  let u = localStorage.getItem(LSK.UUID);
  if(!u){ u = uuidv4(); localStorage.setItem(LSK.UUID, u); }
  state.uuid = u;
  // nick default => "<uuid4-last8>iSLAND"
  let n = localStorage.getItem(LSK.NICK);
  if(!n){
    const suffix = u.slice(-8);
    n = `${suffix}${NICK_SUFFIX}`;
    localStorage.setItem(LSK.NICK, n);
  }
  state.nick = n;
  // peerId for tracker must be 20-byte buffer; we'll derive from uuid
  state.peerId = new TextEncoder().encode((u.replace(/-/g,'') + '00000000000000000000').slice(0,20));
}

function formatCode(n){
  return String(n).padStart(9, '0');
}

function generateRoomCode(){
  // 9-digit random
  const x = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000;
  return formatCode(x);
}

function localOwnRoomsGet(){
  try{
    return JSON.parse(localStorage.getItem(LSK.OWN_ROOMS) || '[]');
  }catch{ return []; }
}
function localOwnRoomsAdd(code, title){
  const list = localOwnRoomsGet().filter(r=>r.code!==code);
  list.unshift({code, title, ts: now()});
  localStorage.setItem(LSK.OWN_ROOMS, JSON.stringify(list.slice(0, 20)));
}
function localOwnRoomsRender(){
  const c = $('openIslands');
  const items = localOwnRoomsGet();
  c.innerHTML = items.length ? items.map(r=>`
    <div class="row" style="margin:6px 0;">
      <div><b>${r.title}</b><div class="small">코드: ${r.code}</div></div>
      <button onclick="location.hash='#room:${r.code}'">입장</button>
    </div>
  `).join('') : '<div class="small">없음</div>';
}

function saveChat(roomCode, msgs){
  localStorage.setItem(LSK.CHAT_PREFIX + roomCode, JSON.stringify(msgs).slice(0, 1_000_000));
}
function loadChat(roomCode){
  try {
    return JSON.parse(localStorage.getItem(LSK.CHAT_PREFIX + roomCode) || '[]');
  } catch { return []; }
}
function clearChat(roomCode){
  localStorage.removeItem(LSK.CHAT_PREFIX + roomCode);
}

function sha1Hex(str){
  const enc = new TextEncoder().encode(str);
  return crypto.subtle.digest('SHA-1', enc).then(buf => {
    return new Uint8Array(buf);
  });
}

// ------------------ Nickname policy ------------------
function getNick(){ return localStorage.getItem(LSK.NICK); }
function setNick(v){
  localStorage.setItem(LSK.NICK, v);
  state.nick = v;
}
function canChangeNick(){
  const raw = localStorage.getItem(LSK.NICK_CHANGES) || '[]';
  let arr; try { arr = JSON.parse(raw); } catch { arr = []; }
  const nowTs = now();
  // remove older than 7 days
  arr = arr.filter(t => nowTs - t < 7*864e5);
  const lastChange = arr.length ? arr[arr.length-1] : 0;
  const canWeekly = arr.length < MAX_NICK_CHANGES_PER_WEEK;
  const cooled = nowTs - lastChange >= 24*36e5;
  return { ok: canWeekly && cooled, arr, canWeekly, cooled, lastChange };
}
function recordNickChange(ts){
  const info = canChangeNick();
  const arr = info.arr;
  arr.push(ts);
  localStorage.setItem(LSK.NICK_CHANGES, JSON.stringify(arr));
}

// ------------------ Rules & Moderation ------------------
async function fetchRules(){
  const url = DEFAULT_RULES_URL + '?_=' + Date.now(); // bypass cache
  const res = await fetch(url);
  if(!res.ok) throw new Error('rules fetch failed');
  state.rules = await res.json();
}

function violatesBannedWords(text){
  const words = (state.rules?.bannedWords || []);
  if(!words.length) return false;
  const lc = text.toLowerCase();
  return words.some(w => lc.includes(String(w).toLowerCase()));
}

function violatesSpam(uuid){
  const limit = state.rules?.spam?.maxMessagesPer10s || 9999;
  let s = state.spamCounter.get(uuid);
  const t = now();
  if(!s){ s = { count: 0, windowStart: t }; }
  if(t - s.windowStart > 10000){ s.count = 0; s.windowStart = t; }
  s.count++;
  state.spamCounter.set(uuid, s);
  return s.count > limit;
}

function escalateMute(uuid){
  const key = 'mute.' + uuid;
  let m = JSON.parse(localStorage.getItem(key) || 'null');
  if(!m) m = { strikes: 0, until: 0 };
  const durations = state.rules?.muteDurationsMinutes || [5,10,20,40];
  m.strikes = Math.min(m.strikes + 1, durations.length);
  const minutes = durations[m.strikes-1];
  m.until = now() + minutes*60*1000;
  localStorage.setItem(key, JSON.stringify(m));
  state.muteMap.set(uuid, m);
  return m;
}
function isMuted(uuid){
  const key = 'mute.' + uuid;
  let m; try { m = JSON.parse(localStorage.getItem(key) || 'null'); } catch { m = null; }
  if(!m) return false;
  if(now() > m.until) return false;
  return m;
}

// ------------------ UI Bindings ------------------
const viewHome = $('view-home');
const viewNick = $('view-nick');
const viewRoom = $('view-room');
const nickBadge = $('nickBadge');
const btnNick = $('btnNick');
const btnCreate = $('btnCreate');
const btnJoinByCode = $('btnJoinByCode');
const joinCode = $('joinCode');
const nickInput = $('nickInput');
const btnSaveNick = $('btnSaveNick');
const btnCancelNick = $('btnCancelNick');
const pcOverlay = $('pcOverlay');
const btnInstall = $('btnInstall');

const roomTitle = $('roomTitle');
const roomTitleInput = $('roomTitleInput');
const roomCodeLabel = $('roomCodeLabel');
const chatLog = $('chatLog');
const chatInput = $('chatInput');
const btnSend = $('btnSend');
const statusLine = $('statusLine');
const btnDestroy = $('btnDestroy');
const btnShare = $('btnShare'); // 추가

function route(){
  const hash = location.hash || '';
  if(!isMobile()){
    show(pcOverlay);
  } else {
    hide(pcOverlay);
  }
  if(hash.startsWith('#room:')){
    const code = hash.split(':')[1];
    gotoRoom(code);
  } else if(hash === '#nick'){
    showNick();
  } else {
    showHome();
  }
}

function showHome(){
  show(viewHome); hide(viewNick); hide(viewRoom);
  nickBadge.textContent = state.nick;
  localOwnRoomsRender();
}

function showNick(){
  hide(viewHome); show(viewNick); hide(viewRoom);
  nickInput.value = state.nick.replace(/iSLAND$/,''); // base without suffix for UX
}

async function gotoRoom(code){
  hide(viewHome); hide(viewNick); show(viewRoom);
  state.roomCode = code;
  roomCodeLabel.textContent = code;

  // Ensure rules loaded
  try { await fetchRules(); } catch(e){ console.warn(e); }

  // Compute default title: "닉네임의 섬이 발견되었습니다."
  let title = localStorage.getItem('room.title.'+code);
  if(!title){
    title = `${state.nick}의 섬이 발견되었습니다.`;
  }
  roomTitle.textContent = title;
  roomTitleInput.value = title;
  roomTitleInput.addEventListener('change', () => {
    const v = roomTitleInput.value.trim().slice(0, 80);
    roomTitle.textContent = v || title;
    localStorage.setItem('room.title.'+code, v || title);
  });

  // Load chat
  renderChat(loadChat(code));

  // Connect to P2P swarm
  await connectSwarm(code);
}

function renderChat(msgs){
  chatLog.innerHTML = msgs.map(m => {
    const own = m.uuid === state.uuid;
    const name = m.nick || '???';
    let content = m.type==='sys' ? `<em>${m.text}</em>` :
      m.text.replace(/[&<>]/g, s=>({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[s]));

    return `<div class="msg ${own?'me':''}">
      <div class="bubble">
        ${m.type==='sys'?'':`<div class="small">${name}</div>`}
        <div>${content}</div>
        <div class="small">${new Date(m.ts).toLocaleTimeString()}</div>
      </div>
    </div>`;
  }).join('');
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendMsg(m){
  const arr = loadChat(state.roomCode);
  arr.push(m);
  saveChat(state.roomCode, arr);
  renderChat(arr);
}

// ------------------ P2P (bittorrent-tracker) ------------------
async function connectSwarm(roomCode){
  statusLine.textContent = '연결 중...';
  // Derive 20-byte infoHash from roomCode via SHA-1
  const infoHash = await sha1Hex('island:' + roomCode);
  // Create tracker client
  if(state.client) try { state.client.destroy(); } catch {}
 state.client = new TrackerClient({
  infoHash,
  peerId: state.peerId,
  announce: [
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
    'wss://tracker.btorrent.xyz',
    'wss://tracker.files.fm:7073/announce'
  ]
});


  state.peers.clear();

  state.client.on('error', err => {
    console.warn('tracker error', err);
    statusLine.textContent = '트래커 오류: ' + err.message;
  });
  state.client.on('warning', err => {
    console.warn('tracker warn', err);
  });

  state.client.on('peer', peer => {
    // peer is a simple-peer instance (initiator=false by default)
    bindPeer(peer);
  });

  // periodically announce
  statusLine.textContent = '상대 찾는 중... (코드 공유로 상대 초대)';
  appendMsg({type:'sys', text:'섬에 입장했습니다.', ts: now()});

  // announce self presence
  try { state.client.start(); } catch(e){ console.warn(e); }
}

function bindPeer(peer){
  state.peers.set(peer.id, peer);

  peer.on('connect', () => {
    statusLine.textContent = '연결됨 · 참가자 수 ' + state.peers.size;
    // send hello payload
    const hello = { t: 'hello', uuid: state.uuid, nick: state.nick, ts: now() };
    try { peer.send(JSON.stringify(hello)); } catch {}
  });

  peer.on('data', buf => {
    try{
      const msg = JSON.parse(new TextDecoder().decode(buf));
      handleSignal(msg, peer);
    }catch(e){
      console.warn('bad packet', e);
    }
  });

  peer.on('close', ()=>{
    state.peers.delete(peer.id);
    statusLine.textContent = '연결 상태: ' + state.peers.size + '명';
  });

  peer.on('error', (e)=>{
    console.warn('peer error', e);
  });
}

function broadcast(obj){
  const s = JSON.stringify(obj);
  for(const p of state.peers.values()){
    try{ p.send(s); }catch{}
  }
}

// ------------------ Messaging & Moderation ------------------
function sendChat(){
  const text = chatInput.value.trim();
  if(!text) return;

  // Check self-mute
  const muted = isMuted(state.uuid);
  if(muted){
    const mins = Math.ceil((muted.until - now())/60000);
    alert(`채팅 금지 상태입니다. 남은 시간: 약 ${mins}분`);
    return;
  }

  // Apply rules
  if(violatesBannedWords(text) || violatesSpam(state.uuid)){
    const m = escalateMute(state.uuid);
    const mins = Math.ceil((m.until - now())/60000);
    appendMsg({type:'sys', text:`규칙 위반으로 채팅 금지 (${mins}분)`, ts: now()});
    // also broadcast moderation notice, so others locally mute us too
    broadcast({ t: 'moderate', uuid: state.uuid, until: m.until, strikes: m.strikes });
    chatInput.value='';
    return;
  }

  const packet = { t:'chat', uuid: state.uuid, nick: state.nick, text, ts: now() };
  appendMsg(packet);
  broadcast(packet);
  chatInput.value='';
}

function handleSignal(msg, peer){
  if(msg.t === 'hello'){
    // greet back
    const hello = { t: 'hello', uuid: state.uuid, nick: state.nick, ts: now() };
    try { peer.send(JSON.stringify(hello)); } catch {}
    return;
  }
  if(msg.t === 'chat'){
    // ignore if sender is muted
    const m = isMuted(msg.uuid);
    if(m){ return; }
    // apply rules for sender (local detection)
    const vban = violatesBannedWords(msg.text) || violatesSpam(msg.uuid);
    if(vban){
      const punish = escalateMute(msg.uuid);
      // share moderation
      broadcast({ t: 'moderate', uuid: msg.uuid, until: punish.until, strikes: punish.strikes });
      return;
    }
    appendMsg(msg);
    return;
  }
  if(msg.t === 'moderate'){
    // apply mute locally
    const key = 'mute.' + msg.uuid;
    const cur = { strikes: msg.strikes||1, until: msg.until|| (now()+5*60*1000) };
    localStorage.setItem(key, JSON.stringify(cur));
    state.muteMap.set(msg.uuid, cur);
    appendMsg({type:'sys', text:`참가자 제재 적용: ${cur.strikes}단계`, ts: now()});
    return;
  }
  if(msg.t === 'room:destroy'){
    // Clear local data and disconnect
    clearChat(state.roomCode);
    appendMsg({type:'sys', text:'이 섬은 방장에 의해 삭제되었습니다.', ts: now()});
    try { state.client?.destroy(); } catch {}
    for(const p of state.peers.values()){ try{ p.destroy(); }catch{} }
    state.peers.clear();
    statusLine.textContent = '방이 삭제되었습니다.';
    // navigate home after a short delay
    setTimeout(()=>{ location.hash = ''; }, 1200);
    return;
  }
}

// ------------------ Destroy Room ("섬떠나기") ------------------
function destroyRoom(){
  if(!confirm('정말로 이 섬을 완전히 삭제할까요? 대화 로그도 삭제됩니다.')) return;
  // broadcast destroy
  broadcast({ t: 'room:destroy' });
  // clear own chat and local title
  clearChat(state.roomCode);
  localStorage.removeItem('room.title.' + state.roomCode);
  // stop tracker & peers
  try { state.client?.destroy(); } catch {}
  for(const p of state.peers.values()){ try{ p.destroy(); }catch{} }
  state.peers.clear();
  appendMsg({type:'sys', text:'섬이 삭제되었습니다.', ts: now()});
  statusLine.textContent = '방 삭제 완료';
  setTimeout(()=>{ location.hash = ''; }, 600);
}

// ------------------ 공유 헬퍼 함수 2개 -------------------------
function getShareURL(code) {
  const url = new URL(location.href);
  url.hash = '#room:' + code; // 깃허브 페이지 하위경로 대응
  return url.toString();
}

async function shareRoom() {
  const code = state.roomCode;
  const url = getShareURL(code);
  const title = roomTitle.textContent || 'iSLAND 채팅방';
  const text = `섬 코드 ${code}로 입장하거나 링크로 바로 입장하세요.`;

  try {
    if (navigator.share) {
      await navigator.share({ title, text, url });
    } else {
      await navigator.clipboard.writeText(url);
      alert('공유 링크를 복사했습니다:\n' + url);
    }
  } catch {
    try {
      await navigator.clipboard.writeText(url);
      alert('공유 링크를 복사했습니다:\n' + url);
    } catch { alert(url); }
  }
}



// ------------------ PWA Install ------------------
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredPrompt = e;
  btnInstall.disabled = false;
});

btnInstall.addEventListener('click', async () => {
  if(state.deferredPrompt){
    state.deferredPrompt.prompt();
    const { outcome } = await state.deferredPrompt.userChoice;
    if(outcome === 'accepted'){
      btnInstall.textContent = '설치됨';
      btnInstall.disabled = true;
    }
    state.deferredPrompt = null;
  } else {
    alert('iOS 사파리에서는 공유 버튼 → "홈 화면에 추가"를 이용해주세요.');
  }
});

// ------------------ Event Bindings ------------------
btnNick.addEventListener('click', ()=> location.hash = '#nick');
btnCreate.addEventListener('click', ()=> {
  const code = generateRoomCode();
  localStorage.setItem('room.title.'+code, `${state.nick}의 섬이 발견되었습니다.`);
  localOwnRoomsAdd(code, `${state.nick}의 섬이 발견되었습니다.`);
  location.hash = '#room:' + code;
});
btnJoinByCode.addEventListener('click', ()=> {
  const code = formatCode(joinCode.value || '');
  if(!/^\d{9}$/.test(code)) { alert('9자리 숫자 코드를 입력하세요.'); return; }
  location.hash = '#room:' + code;
});

btnSaveNick.addEventListener('click', ()=> {
  const base = nickInput.value.trim();
  if(!base) return alert('닉네임을 입력하세요.');
  const { ok, canWeekly, cooled, lastChange } = canChangeNick();
  if(!ok){
    let msg='변경할 수 없습니다.\n';
    if(!canWeekly) msg += '주 2회 변경 제한을 초과했습니다.\n';
    if(!cooled){
      const mins = Math.ceil( (lastChange + NICK_COOLDOWN_HOURS*3600*1000 - now())/60000 );
      msg += `다음 변경까지 약 ${mins}분 남았습니다.`;
    }
    return alert(msg);
  }
  const finalNick = `${base}${NICK_SUFFIX}`;
  setNick(finalNick);
  recordNickChange(now());
  alert('닉네임이 변경되었습니다.');
  location.hash = '';
});

btnCancelNick.addEventListener('click', ()=> { location.hash = ''; });

btnSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e)=> { if(e.key==='Enter') sendChat(); });

btnDestroy.addEventListener('click', destroyRoom);
btnShare.addEventListener('click', shareRoom); // 추가


// ------------------ Init ------------------
function registerSW(){
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
}

function init(){
  ensureUUID();
  nickBadge.textContent = state.nick;
  btnInstall.disabled = true;
  registerSW();
  route();
  window.addEventListener('hashchange', route);
  localOwnRoomsRender();
}

document.addEventListener('DOMContentLoaded', init);
