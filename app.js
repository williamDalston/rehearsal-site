/* The House That AI Built — rehearsal tool
   Static. No backend. Recordings live in this browser only (IndexedDB). */

const $ = id => document.getElementById(id);
const NAME = { W: 'WILL', C: 'CAROLINE', BOTH: 'BOTH', NONE: '—' };

let view = DECK.slice();      // current filtered/ordered list
let i = 0;                    // index into view
let shuffled = false;
let flags = new Set(JSON.parse(localStorage.getItem('flags') || '[]'));
let haveTake = new Set();     // slide numbers with a saved recording
let mobileView = 'slide';     // 'slide' | 'script' on narrow screens

/* ---------------- storage: IndexedDB (localStorage cannot hold video) --------------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('rehearsal', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('takes');
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
const tx = (mode, fn) => new Promise((res, rej) => {
  const t = db.transaction('takes', mode), s = t.objectStore('takes');
  const rq = fn(s);
  t.oncomplete = () => res(rq && rq.result);
  t.onerror = () => rej(t.error);
});
const putTake = (n, blob) => tx('readwrite', s => s.put(blob, n));
const getTake = n => tx('readonly', s => s.get(n));
const delTake = n => tx('readwrite', s => s.delete(n));
const allKeys = () => tx('readonly', s => s.getAllKeys());

/* ---------------- media ---------------- */
let stream = null, recorder = null, chunks = [], recording = false;
let recordingFor = null;      // slide number locked when the take starts
let t0 = 0, tick = null, audioCtx = null, raf = null;

function showErr(msg) { $('err').textContent = msg; $('err').classList.remove('hidden'); }
function hideErr() { $('err').classList.add('hidden'); }

function setRecLabel(kind) {
  // kind: 'record' | 'again' | 'stop'
  const long = kind === 'stop' ? 'Stop' : kind === 'again' ? 'Record again' : 'Record this slide';
  const short = kind === 'stop' ? 'Stop' : kind === 'again' ? 'Again' : 'Record';
  $('recTxt').innerHTML = `<span class="long">${long}</span><span class="short">${short}</span>`;
  $('rec').setAttribute('aria-label', long);
}

async function camOn() {
  hideErr();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showErr('This browser cannot record. Camera access needs a modern browser served over https.');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true }
    });
  } catch (e) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      showErr('No camera available — recording audio only.');
    } catch (e2) {
      showErr('Camera and microphone were blocked. Allow access in the address bar, then press Camera again.');
      return false;
    }
  }
  $('live').srcObject = stream;
  $('pip').classList.remove('hidden');
  $('camBtn').textContent = 'Camera on';
  $('camBtn').classList.add('on');
  $('camBtn').setAttribute('aria-pressed', 'true');
  $('rec').disabled = false;
  meter();
  return true;
}

function meter() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser(); an.fftSize = 64;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    (function loop() {
      an.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      $('lvl').style.width = Math.min(100, (avg / 110) * 100) + '%';
      raf = requestAnimationFrame(loop);
    })();
  } catch (e) { /* meter is cosmetic */ }
}

function pickMime() {
  const want = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
                'video/webm', 'video/mp4'];
  for (const m of want) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function toggleRec() {
  if (!view.length) return;
  if (!stream) { const ok = await camOn(); if (!ok) return; }
  recording ? stopRec() : startRec();
}

function startRec() {
  if (!view.length) return;
  chunks = [];
  const mt = pickMime();
  try { recorder = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined); }
  catch (e) { showErr('Recording is not supported in this browser. Chrome, Edge or Firefox will work.'); return; }

  recordingFor = view[i].n;
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    const n = recordingFor;
    recordingFor = null;
    try { await putTake(n, blob); haveTake.add(n); }
    catch (e) { showErr('Could not save the take in this browser.'); }
    renderTake();
  };
  recorder.start(500);
  recording = true;
  t0 = Date.now();
  $('rec').classList.add('live');
  setRecLabel('stop');
  $('timer').hidden = false;
  tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('timer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 250);
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recording = false;
  clearInterval(tick);
  $('rec').classList.remove('live');
  setRecLabel('record');
  $('timer').hidden = true;
  $('timer').textContent = '0:00';
}

/* ---------------- rendering ---------------- */
function renderTake() {
  const n = view[i] && view[i].n;
  $('take').hidden = !haveTake.has(n);
  if (!recording) setRecLabel(haveTake.has(n) ? 'again' : 'record');
}

function setMobileView(which) {
  mobileView = which;
  $('main').dataset.mobileView = which;
  $('tabSlide').classList.toggle('on', which === 'slide');
  $('tabScript').classList.toggle('on', which === 'script');
  $('tabSlide').setAttribute('aria-selected', which === 'slide' ? 'true' : 'false');
  $('tabScript').setAttribute('aria-selected', which === 'script' ? 'true' : 'false');
}

function flashSlide() {
  const img = $('sImg');
  img.classList.add('swap');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => img.classList.remove('swap'));
  });
}

function render() {
  if (!view.length) {
    $('sNum').textContent = '—';
    $('sNum').className = 'num';
    $('sTitle').textContent = 'Nothing matches that filter';
    $('sAct').textContent = '—';
    $('sCap').hidden = true;
    $('sImg').style.visibility = 'hidden';
    $('sImg').alt = '';
    $('sWho').textContent = '—';
    $('sWho').className = 'tag who-NONE';
    $('sTime').textContent = '—';
    $('flagBtn').textContent = 'Flag';
    $('flagBtn').classList.remove('on');
    $('script').innerHTML = '<div class="empty">Nothing matches that filter.</div>';
    $('bar').style.width = '0%';
    $('pos').textContent = '0 / 0';
    $('take').hidden = true;
    if (!recording) setRecLabel('record');
    return;
  }
  if (i >= view.length) i = 0;
  if (i < 0) i = view.length - 1;
  const s = view[i];

  $('sNum').textContent = s.n;
  $('sNum').className = 'num'
    + (haveTake.has(s.n) ? ' has-take' : '')
    + (flags.has(s.n) ? ' flagged' : '');
  $('sTitle').textContent = s.title;
  $('sAct').textContent = s.act;
  $('sCap').hidden = !s.capture;

  const nextSrc = 'slides/' + String(s.n).padStart(2, '0') + '.jpg';
  if ($('sImg').getAttribute('src') !== nextSrc) {
    flashSlide();
    $('sImg').src = nextSrc;
  }
  $('sImg').alt = 'Slide ' + s.n + ': ' + s.title;
  $('sImg').style.visibility = '';

  $('sWho').textContent = NAME[s.who] || s.who;
  $('sWho').className = 'tag who-' + (s.who || 'C');
  $('sTime').textContent = s.len + ' · ' + s.run;

  $('flagBtn').textContent = flags.has(s.n) ? '★ Flagged' : 'Flag';
  $('flagBtn').classList.toggle('on', flags.has(s.n));

  // script — speaker named once per run
  const box = $('script'); box.innerHTML = '';
  for (const it of s.items) {
    if (it.t === 'say') {
      const run = document.createElement('div'); run.className = 'run';
      const who = document.createElement('div');
      who.className = 'who ' + it.who; who.textContent = NAME[it.who];
      const lines = document.createElement('div'); lines.className = 'lines';
      for (const L of it.lines) { const p = document.createElement('p'); p.textContent = L; lines.appendChild(p); }
      run.append(who, lines); box.appendChild(run);
    } else {
      const d = document.createElement('div');
      d.className = it.t === 'do' ? 'do' : it.t === 'cut' ? 'cut' : 'note';
      if (it.t === 'do') d.textContent = '▸ ' + it.text;
      else if (it.t === 'cut') d.innerHTML = '<b>CUT IF LONG</b> — ' + esc(it.text);
      else d.textContent = it.text;
      box.appendChild(d);
    }
  }
  box.scrollTop = 0;

  $('bar').style.width = ((i + 1) / view.length * 100) + '%';
  $('pos').textContent = (i + 1) + ' / ' + view.length;
  $('jump').value = String(i);
  renderTake();
}

const esc = t => t.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function fillJump() {
  $('jump').innerHTML = view.map((s, k) =>
    `<option value="${k}">${s.n}. ${esc(s.title).slice(0, 34)}</option>`).join('');
}

function applyFilter() {
  const v = $('filter').value;
  const keep = s =>
    v === 'all' ? true :
    v === 'capture' ? s.capture :
    v === 'flagged' ? flags.has(s.n) :
    v === 'unrecorded' ? !haveTake.has(s.n) :
    s.who === v;
  view = DECK.filter(keep);
  if (shuffled) shuffle(view);
  i = 0; fillJump(); render();
}

function shuffle(a) { for (let k = a.length - 1; k > 0; k--) { const j = Math.random() * (k + 1) | 0;[a[k], a[j]] = [a[j], a[k]]; } }

/* ---------------- playback ---------------- */
let playUrl = null;
async function openTake() {
  if (!view.length) return;
  const n = view[i].n;
  const blob = await getTake(n);
  if (!blob) return;
  if (playUrl) URL.revokeObjectURL(playUrl);
  playUrl = URL.createObjectURL(blob);
  $('playback').src = playUrl;
  $('mTitle').textContent = 'Slide ' + n + ' — ' + view[i].title;
  $('modal').classList.remove('hidden');
  $('playback').play().catch(() => {});
}
function closeTake() {
  $('playback').pause();
  $('modal').classList.add('hidden');
}
async function download() {
  if (!view.length) return;
  const n = view[i].n;
  const blob = await getTake(n); if (!blob) return;
  const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `slide-${String(n).padStart(2, '0')}-take.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function removeTake() {
  if (!view.length) return;
  const n = view[i].n;
  await delTake(n); haveTake.delete(n); renderTake();
  // refresh badge on slide number
  if (view[i]) {
    $('sNum').className = 'num'
      + (haveTake.has(view[i].n) ? ' has-take' : '')
      + (flags.has(view[i].n) ? ' flagged' : '');
  }
}

/* ---------------- wiring ---------------- */
function go(d) {
  if (!view.length) return;
  if (recording) stopRec();
  i += d; render();
}

$('prev').onclick = () => go(-1);
$('next').onclick = () => go(1);
$('rec').onclick = toggleRec;
$('camBtn').onclick = () => {
  if (stream) {
    const hidden = $('pip').classList.toggle('hidden');
    $('camBtn').textContent = hidden ? 'Camera hidden' : 'Camera on';
  } else camOn();
};
$('pipX').onclick = () => {
  $('pip').classList.add('hidden');
  if (stream) $('camBtn').textContent = 'Camera hidden';
};
$('playBtn').onclick = openTake;
$('dlBtn').onclick = download;
$('delBtn').onclick = removeTake;
$('mDl').onclick = download;
$('mClose').onclick = closeTake;
$('modal').onclick = e => { if (e.target === $('modal')) closeTake(); };
$('filter').onchange = () => { if (recording) stopRec(); applyFilter(); };
$('jump').onchange = e => {
  if (!view.length) return;
  if (recording) stopRec();
  i = +e.target.value; render();
};
$('flagBtn').onclick = () => {
  if (!view.length) return;
  const n = view[i].n;
  flags.has(n) ? flags.delete(n) : flags.add(n);
  localStorage.setItem('flags', JSON.stringify([...flags]));
  render();
};
$('shuffle').onclick = () => {
  if (recording) stopRec();
  shuffled = !shuffled;
  $('shuffle').textContent = shuffled ? 'Shuffle on' : 'Shuffle';
  $('shuffle').classList.toggle('on', shuffled);
  $('shuffle').setAttribute('aria-pressed', shuffled ? 'true' : 'false');
  applyFilter();
};

$('tabSlide').onclick = () => setMobileView('slide');
$('tabScript').onclick = () => setMobileView('script');

document.addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA', 'VIDEO'].includes(e.target.tagName)) return;
  if (e.key === 'Escape') { closeTake(); return; }
  if (!$('modal').classList.contains('hidden')) return;
  if (e.code === 'Space') { e.preventDefault(); toggleRec(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key.toLowerCase() === 'f') { e.preventDefault(); $('flagBtn').click(); }
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); $('shuffle').click(); }
  else if (e.key === '1') setMobileView('slide');
  else if (e.key === '2') setMobileView('script');
});

/* swipe between slides on the slide pane */
(function enableSwipe() {
  const el = document.querySelector('.pane-slide');
  if (!el) return;
  let x0 = 0, y0 = 0, t0 = 0, tracking = false;
  el.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    tracking = true;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
    t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0;
    const dy = t.clientY - y0;
    const dt = Date.now() - t0;
    if (dt > 600) return;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    go(dx < 0 ? 1 : -1);
  }, { passive: true });
})();

window.addEventListener('beforeunload', e => {
  if (recording) { e.preventDefault(); e.returnValue = ''; }
});

(async function boot() {
  $('rec').disabled = false;
  try { await openDB(); (await allKeys() || []).forEach(k => haveTake.add(k)); }
  catch (e) { showErr('This browser blocked local storage, so takes will not be kept after you close the tab.'); }
  fillJump(); render();
})();
