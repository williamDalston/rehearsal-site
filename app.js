/* The House That AI Built — rehearsal tool
   Static. No backend. Recordings live in this browser only (IndexedDB). */

const $ = id => document.getElementById(id);
const NAME = { W: 'WILL', C: 'CAROLINE', BOTH: 'BOTH', NONE: '—' };

if (typeof DECK === 'undefined' || !Array.isArray(DECK) || !DECK.length) {
  document.body.innerHTML = '<p style="padding:24px;font:16px system-ui">Could not load the deck (data.js). Check the network tab and refresh.</p>';
  throw new Error('DECK missing');
}

const DECK_LEN = DECK.length;

// "M:SS" -> seconds; anything unparseable (or "—") -> 0, meaning "no target".
const parseTime = t => {
  const m = /^(\d+):(\d{2})$/.exec(String(t == null ? '' : t).trim());
  return m ? (+m[1] * 60 + +m[2]) : 0;
};
const fmtTime = s => {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

// Take durations live in localStorage (tiny) rather than IndexedDB, so boot never
// has to read every video blob just to show timings. Kept in sync with the blobs.
function loadTakeMeta() {
  try {
    const o = JSON.parse(localStorage.getItem('takeMeta') || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) {
    return {};
  }
}
function saveTakeMeta() {
  try { localStorage.setItem('takeMeta', JSON.stringify(takeMeta)); }
  catch (e) { /* private mode / quota — timings just won't persist */ }
}

function loadFlags() {
  try {
    const raw = JSON.parse(localStorage.getItem('flags') || '[]');
    return new Set((Array.isArray(raw) ? raw : []).map(Number).filter(n => n > 0));
  } catch (e) {
    return new Set();
  }
}

/* Script edits — local only, keyed by slide number. Original DECK stays untouched. */
function loadScriptEdits() {
  try {
    const o = JSON.parse(localStorage.getItem('scriptEdits') || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) {
    return {};
  }
}
function saveScriptEdits() {
  try { localStorage.setItem('scriptEdits', JSON.stringify(scriptEdits)); }
  catch (e) { showErr('Could not save script edits in this browser.'); }
}
const cloneItems = items => JSON.parse(JSON.stringify(items));
const itemsKey = items => JSON.stringify(items);
function originalItems(n) {
  const s = DECK.find(d => d.n === n);
  return s ? s.items : [];
}
function itemsFor(n) {
  return scriptEdits[n] ? cloneItems(scriptEdits[n]) : cloneItems(originalItems(n));
}
function slideIsEdited(n) {
  return !!scriptEdits[n] && itemsKey(scriptEdits[n]) !== itemsKey(originalItems(n));
}

let view = DECK.slice();      // current filtered/ordered list
let i = 0;                    // index into view
let shuffled = false;
let flags = loadFlags();
let scriptEdits = loadScriptEdits(); // { [slideN]: items[] }
let haveTake = new Set();     // slide numbers with a saved recording
let takeMeta = loadTakeMeta();// { [slideN]: { d: seconds } } — take durations
let mobileView = 'slide';     // 'slide' | 'script' on narrow screens
let scriptSaveTimer = null;

/* ---------------- storage: IndexedDB (localStorage cannot hold video) --------------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('rehearsal', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('takes')) d.createObjectStore('takes');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
function tx(mode, fn) {
  return new Promise((res, rej) => {
    if (!db) return rej(new Error('IndexedDB not open'));
    let settled = false;
    const t = db.transaction('takes', mode);
    const s = t.objectStore('takes');
    let rq;
    try { rq = fn(s); }
    catch (e) { return rej(e); }
    const done = (ok, val) => {
      if (settled) return;
      settled = true;
      ok ? res(val) : rej(val);
    };
    if (rq) {
      rq.onsuccess = () => done(true, rq.result);
      rq.onerror = () => done(false, rq.error);
    }
    t.oncomplete = () => { if (!rq) done(true); };
    t.onerror = () => done(false, t.error);
    t.onabort = () => done(false, t.error || new Error('aborted'));
  });
}
const putTake = (n, blob) => tx('readwrite', s => s.put(blob, n));
const getTake = n => tx('readonly', s => s.get(n));
const delTake = n => tx('readwrite', s => s.delete(n));
const allKeys = () => tx('readonly', s => s.getAllKeys());

/* ---------------- media ---------------- */
let stream = null, recorder = null, chunks = [], recording = false;
let recordingFor = null;      // slide number locked when the take starts
let t0 = 0, tick = null, audioCtx = null, raf = null, analyser = null;
let recElapsedMs = 0;         // length of the take being stopped, measured at stop
let recTargetSecs = 0;        // target length of the slide being recorded

function showErr(msg) { $('err').textContent = msg; $('err').classList.remove('hidden'); }
function hideErr() { $('err').classList.add('hidden'); }

function setRecLabel(kind) {
  // kind: 'record' | 'again' | 'stop'
  const long = kind === 'stop' ? 'Stop' : kind === 'again' ? 'Record again' : 'Record this slide';
  const short = kind === 'stop' ? 'Stop' : kind === 'again' ? 'Again' : 'Record';
  $('recTxt').innerHTML = `<span class="long">${long}</span><span class="short">${short}</span>`;
  $('rec').setAttribute('aria-label', long);
}

function stopMeter() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  analyser = null;
  if ($('lvl')) $('lvl').style.width = '0%';
}

function watchStreamEnd() {
  if (!stream) return;
  stream.getTracks().forEach(track => {
    track.onended = () => {
      if (!stream) return;
      const live = stream.getTracks().some(t => t.readyState === 'live');
      if (live) return;
      if (recording) stopRec();
      stream = null;
      stopMeter();
      $('live').srcObject = null;
      $('pip').classList.add('hidden');
      $('camBtn').textContent = 'Camera';
      $('camBtn').classList.remove('on');
      $('camBtn').setAttribute('aria-pressed', 'false');
      showErr('Camera or microphone disconnected. Press Camera to reconnect.');
    };
  });
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
  applySavedPipPos();
  $('camBtn').textContent = 'Camera on';
  $('camBtn').classList.add('on');
  $('camBtn').setAttribute('aria-pressed', 'true');
  $('rec').disabled = false;
  watchStreamEnd();
  meter();
  return true;
}

function meter() {
  stopMeter();
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 64;
    src.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    (function loop() {
      if (!analyser) return;
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      $('lvl').style.width = Math.min(100, (avg / 110) * 100) + '%';
      raf = requestAnimationFrame(loop);
    })();
  } catch (e) { /* meter is cosmetic */ }
}

function pickMime() {
  if (!window.MediaRecorder) return '';
  const want = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
                'video/webm', 'video/mp4'];
  for (const m of want) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function toggleRec() {
  if (!view.length) return;
  if (recording) { stopRec(); return; }
  if (!stream || !stream.getTracks().some(t => t.readyState === 'live')) {
    stream = null;
    const ok = await camOn();
    if (!ok) return;
  }
  startRec();
}

function startRec() {
  if (!view.length || !stream || recording) return;
  chunks = [];
  const mt = pickMime();
  let rec;
  try { rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined); }
  catch (e) { showErr('Recording is not supported in this browser. Chrome, Edge or Firefox will work.'); return; }

  // Capture slide number in this closure so jump/filter mid-stop cannot reassign it.
  const slideN = view[i].n;
  recordingFor = slideN;
  recTargetSecs = parseTime(view[i].len);
  recorder = rec;

  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onerror = () => {
    showErr('Recording failed. Try Chrome or Edge, or toggle the camera and record again.');
    recording = false;
    recordingFor = null;
    clearInterval(tick);
    $('rec').classList.remove('live');
    setRecLabel(haveTake.has(slideN) ? 'again' : 'record');
    $('timer').hidden = true;
    $('timer').classList.remove('over');
  };
  rec.onstop = async () => {
    const mime = rec.mimeType || mt || 'video/webm';
    const blob = new Blob(chunks, { type: mime });
    if (recorder === rec) recorder = null;
    if (!blob.size) {
      showErr('That take was empty — hold record for a second, then stop.');
      if (recordingFor === slideN) recordingFor = null;
      renderTake();
      return;
    }
    try {
      await putTake(slideN, blob);
      haveTake.add(slideN);
      takeMeta[slideN] = { d: Math.round(recElapsedMs / 1000), at: Date.now() };
      saveTakeMeta();
      hideErr();
    } catch (e) {
      showErr('Could not save the take in this browser.');
    }
    if (recordingFor === slideN) recordingFor = null;
    renderTake();
    // refresh badge if still on this slide
    if (view[i] && view[i].n === slideN) {
      $('sNum').className = 'num'
        + (haveTake.has(slideN) ? ' has-take' : '')
        + (flags.has(slideN) ? ' flagged' : '');
    }
  };

  try { rec.start(500); }
  catch (e) {
    showErr('Could not start recording. Check camera permission and try again.');
    recordingFor = null;
    return;
  }

  recording = true;
  t0 = Date.now();
  $('rec').classList.add('live');
  setRecLabel('stop');
  $('timer').hidden = false;
  $('timer').classList.remove('over');
  $('timer').textContent = '0:00';
  tick = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('timer').textContent = fmtTime(s);
    $('timer').classList.toggle('over', recTargetSecs > 0 && s > recTargetSecs);
  }, 250);
}

function stopRec() {
  if (!recording && !(recorder && recorder.state !== 'inactive')) return;
  if (recording && t0) recElapsedMs = Math.max(0, Date.now() - t0);
  recording = false;
  clearInterval(tick);
  $('rec').classList.remove('live');
  setRecLabel('record');
  $('timer').hidden = true;
  $('timer').classList.remove('over');
  $('timer').textContent = '0:00';
  if (recorder && recorder.state !== 'inactive') {
    try {
      if (recorder.state === 'recording') recorder.requestData();
      recorder.stop();
    } catch (e) { /* already stopped */ }
  }
}

/* ---------------- rendering ---------------- */
function updateRecCount() {
  $('recCount').textContent = haveTake.size + ' / ' + DECK_LEN;
  const btn = $('playAll');
  if (btn) {
    btn.hidden = haveTake.size === 0;
    btn.textContent = haveTake.size ? ('▶ Play all (' + haveTake.size + ')') : '▶ Play all';
  }
}

// One-line readout for a saved take: actual length vs the slide's target.
function takeInfoHTML(s) {
  const meta = takeMeta[s.n];
  const target = parseTime(s.len);
  if (!meta || typeof meta.d !== 'number') {
    return target > 0 ? 'saved · target ' + fmtTime(target) : 'saved';
  }
  const d = meta.d;
  const base = '<b>' + fmtTime(d) + '</b>';
  if (target <= 0) return base;
  const diff = d - target;
  const cmp = '/ ' + fmtTime(target);
  if (diff > 5) return base + ' ' + cmp + ' <span class="over">' + fmtTime(diff) + ' over</span>';
  if (diff < -5) return base + ' ' + cmp + ' <span class="under">' + fmtTime(-diff) + ' under</span>';
  return base + ' ' + cmp + ' <span>on target</span>';
}

function renderTake() {
  const s = view[i];
  const n = s && s.n;
  const has = haveTake.has(n);
  $('take').hidden = !has;
  if (has) $('takeInfo').innerHTML = takeInfoHTML(s);
  if (!recording) setRecLabel(has ? 'again' : 'record');
  updateRecCount();
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

function makeEditable(el) {
  // plaintext-only when supported; otherwise true + paste stripping
  try { el.contentEditable = 'plaintext-only'; }
  catch (e) { el.contentEditable = 'true'; }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.classList.add('edit');
  el.spellcheck = true;
  el.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (document.execCommand) document.execCommand('insertText', false, text);
    else {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      sel.deleteFromDocument();
      sel.getRangeAt(0).insertNode(document.createTextNode(text));
      sel.collapseToEnd();
    }
    scheduleScriptSave();
  });
  return el;
}

function updateEditUi(n) {
  const edited = !!(n && slideIsEdited(n));
  $('sEdited').hidden = !edited;
  $('resetScript').hidden = !edited;
}

function itemsFromDom(box) {
  const items = [];
  for (const el of box.children) {
    if (el.classList.contains('empty')) continue;
    if (el.classList.contains('run')) {
      const whoEl = el.querySelector('.who');
      const who = whoEl
        ? (['W', 'C', 'BOTH', 'NONE'].find(c => whoEl.classList.contains(c)) || 'C')
        : 'C';
      const lines = [...el.querySelectorAll('.lines .edit, .lines p')]
        .map(p => (p.innerText || p.textContent || '').replace(/\u00a0/g, ' ').trimEnd())
        .map(t => t.trim())
        .filter(Boolean);
      if (lines.length) items.push({ t: 'say', who, lines });
    } else if (el.classList.contains('do') || el.classList.contains('note') || el.classList.contains('cut')) {
      const edit = el.querySelector('.edit');
      let text = edit
        ? (edit.innerText || edit.textContent || '')
        : (el.textContent || '');
      text = text.replace(/\u00a0/g, ' ').replace(/^▸\s*/, '').trim();
      if (!text) continue;
      items.push({ t: el.classList.contains('do') ? 'do' : el.classList.contains('cut') ? 'cut' : 'note', text });
    }
  }
  return items;
}

function persistScriptFromDom() {
  if (!view.length) return;
  const n = view[i].n;
  const items = itemsFromDom($('script'));
  if (!items.length) {
    // Don't wipe a slide to nothing by accident — keep last good edit / original.
    return;
  }
  if (itemsKey(items) === itemsKey(originalItems(n))) {
    delete scriptEdits[n];
  } else {
    scriptEdits[n] = items;
  }
  saveScriptEdits();
  updateEditUi(n);
}

function scheduleScriptSave() {
  clearTimeout(scriptSaveTimer);
  scriptSaveTimer = setTimeout(persistScriptFromDom, 200);
}

function resetScript() {
  if (!view.length) return;
  const n = view[i].n;
  delete scriptEdits[n];
  saveScriptEdits();
  render();
}

/* ---------------- script export / copy ---------------- */
function formatItemPlain(it) {
  if (it.t === 'say') {
    const who = NAME[it.who] || it.who;
    return who + '\n' + it.lines.map(L => L).join('\n');
  }
  if (it.t === 'do') return '▸ ' + it.text;
  if (it.t === 'cut') return 'CUT IF LONG — ' + it.text;
  return '(' + it.text + ')';
}

function formatSlidePlain(s) {
  const bits = [];
  bits.push('─'.repeat(56));
  bits.push('SLIDE ' + s.n + ' · ' + s.title);
  const meta = [
    NAME[s.who] || s.who,
    s.len,
    s.run && s.run !== '—' ? 'run ' + s.run : '',
    s.act || '',
    s.capture ? 'CAPTURE' : '',
    slideIsEdited(s.n) ? 'edited' : ''
  ].filter(Boolean).join(' · ');
  bits.push(meta);
  bits.push('─'.repeat(56));
  for (const it of itemsFor(s.n)) bits.push(formatItemPlain(it), '');
  return bits.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function formatDeckPlain(slides) {
  const head = [
    'The House That AI Built — rehearsal script',
    'Drupal GovCon 2026',
    'Exported ' + new Date().toISOString().slice(0, 10),
    slides.length + ' slides' + (Object.keys(scriptEdits).length ? ' (includes local edits)' : ''),
    ''
  ].join('\n');
  return head + '\n' + slides.map(formatSlidePlain).join('\n');
}

function formatItemMd(it) {
  if (it.t === 'say') {
    return '**' + (NAME[it.who] || it.who) + '**\n\n' + it.lines.map(L => L).join('\n\n');
  }
  if (it.t === 'do') return '> ▸ *' + it.text + '*';
  if (it.t === 'cut') return '> **CUT IF LONG** — ' + it.text;
  return '> ' + it.text;
}

function formatSlideMd(s) {
  const bits = [];
  bits.push('## Slide ' + s.n + ' — ' + s.title);
  bits.push('');
  bits.push('*' + [
    NAME[s.who] || s.who,
    s.len,
    s.act || '',
    s.capture ? 'CAPTURE' : ''
  ].filter(Boolean).join(' · ') + '*');
  bits.push('');
  for (const it of itemsFor(s.n)) {
    bits.push(formatItemMd(it));
    bits.push('');
  }
  return bits.join('\n');
}

function formatDeckMd(slides) {
  return [
    '# The House That AI Built — rehearsal script',
    '',
    'Drupal GovCon 2026 · exported ' + new Date().toISOString().slice(0, 10),
    '',
    slides.length + ' slides' + (Object.keys(scriptEdits).length ? ' (includes local edits)' : ''),
    '',
    '---',
    '',
    slides.map(formatSlideMd).join('\n---\n\n')
  ].join('\n');
}

function exportSlides() {
  // Prefer the current filtered view; fall back to the full deck.
  const slides = (view && view.length) ? view.slice() : DECK.slice();
  // Keep talk order even if the view is shuffled.
  slides.sort((a, b) => a.n - b.n);
  return slides;
}

async function copyText(text, btn, okLabel) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  } catch (e) {
    showErr('Could not copy to the clipboard in this browser.');
    return false;
  }
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = okLabel || 'Copied';
    btn.classList.add('on');
    setTimeout(() => {
      btn.textContent = prev;
      btn.classList.remove('on');
    }, 1400);
  }
  return true;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function copyAllScript() {
  persistScriptFromDom();
  const slides = exportSlides();
  await copyText(formatDeckPlain(slides), $('copyScript'), 'Copied');
}

async function copySlideScript() {
  if (!view.length) return;
  persistScriptFromDom();
  await copyText(formatSlidePlain(view[i]), $('copySlide'), 'Copied');
}

function exportAllScript(e) {
  persistScriptFromDom();
  const slides = exportSlides();
  const plain = e && e.shiftKey;
  if (plain) downloadText('house-that-ai-built-script.txt', formatDeckPlain(slides));
  else downloadText('house-that-ai-built-script.md', formatDeckMd(slides));
  const btn = $('exportScript');
  const prev = btn.textContent;
  btn.textContent = plain ? 'Saved .txt' : 'Saved .md';
  btn.classList.add('on');
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('on');
  }, 1400);
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
    updateEditUi(null);
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
  updateEditUi(s.n);

  // script — editable; speaker named once per run
  const box = $('script'); box.innerHTML = '';
  for (const it of itemsFor(s.n)) {
    if (it.t === 'say') {
      const run = document.createElement('div'); run.className = 'run';
      const who = document.createElement('div');
      who.className = 'who ' + it.who; who.textContent = NAME[it.who];
      const lines = document.createElement('div'); lines.className = 'lines';
      for (const L of it.lines) {
        const p = document.createElement('p');
        p.textContent = L;
        makeEditable(p);
        lines.appendChild(p);
      }
      run.append(who, lines); box.appendChild(run);
    } else {
      const d = document.createElement('div');
      d.className = it.t === 'do' ? 'do' : it.t === 'cut' ? 'cut' : 'note';
      if (it.t === 'do') {
        d.appendChild(document.createTextNode('▸ '));
        const span = document.createElement('span');
        span.textContent = it.text;
        makeEditable(span);
        d.appendChild(span);
      } else if (it.t === 'cut') {
        const label = document.createElement('b');
        label.textContent = 'CUT IF LONG';
        d.append(label, document.createTextNode(' — '));
        const span = document.createElement('span');
        span.textContent = it.text;
        makeEditable(span);
        d.appendChild(span);
      } else {
        const span = document.createElement('span');
        span.textContent = it.text;
        makeEditable(span);
        d.appendChild(span);
      }
      box.appendChild(d);
    }
  }
  box.scrollTop = 0;

  $('bar').style.width = ((i + 1) / view.length * 100) + '%';
  $('pos').textContent = (i + 1) + ' / ' + view.length;
  $('jump').value = String(i);
  renderTake();
}

const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

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
let preloadUrl = null;
let lastFocus = null;         // restored when the playback dialog closes
let playlist = [];            // [{ n, title, at }]
let plIndex = 0;
let plMode = false;           // continuous run vs single-take watch
let plAdvance = true;         // auto-advance on ended

function revokePlayUrl() {
  if (playUrl) { URL.revokeObjectURL(playUrl); playUrl = null; }
}
function revokePreload() {
  if (preloadUrl) { URL.revokeObjectURL(preloadUrl); preloadUrl = null; }
}

/** Recorded takes in the order they were captured (fallback: talk order for older takes). */
function buildPlaylist() {
  return DECK
    .filter(s => haveTake.has(s.n))
    .map(s => ({
      n: s.n,
      title: s.title,
      at: (takeMeta[s.n] && typeof takeMeta[s.n].at === 'number') ? takeMeta[s.n].at : s.n
    }))
    .sort((a, b) => a.at - b.at || a.n - b.n);
}

function setModalMode(run) {
  plMode = run;
  $('modal').classList.toggle('run', run);
  $('mPos').hidden = !run;
  $('mSub').textContent = run
    ? 'Recording order · plays straight through'
    : '';
}

async function preloadPlaylistItem(idx) {
  revokePreload();
  if (!plMode || idx < 0 || idx >= playlist.length) return;
  try {
    const blob = await getTake(playlist[idx].n);
    if (blob) preloadUrl = URL.createObjectURL(blob);
  } catch (e) { /* preload is best-effort */ }
}

async function loadPlaylistItem(idx, { autoplay = true } = {}) {
  if (idx < 0 || idx >= playlist.length) return;
  plIndex = idx;
  const item = playlist[idx];
  let blob;
  try { blob = await getTake(item.n); }
  catch (e) { showErr('Could not open take for slide ' + item.n + '.'); return; }
  if (!blob) {
    // Skip missing blob and keep going in a run.
    if (plMode && plAdvance) return playRunStep(1);
    return;
  }

  const v = $('playback');
  // Prefer a preloaded URL for the seamless handoff.
  let url = null;
  if (preloadUrl) {
    url = preloadUrl;
    preloadUrl = null;
  } else {
    revokePlayUrl();
    url = URL.createObjectURL(blob);
  }
  // If we created a fresh URL, drop any old playUrl first.
  if (playUrl && playUrl !== url) revokePlayUrl();
  playUrl = url;

  v.src = playUrl;
  $('mTitle').textContent = 'Slide ' + item.n + ' — ' + item.title;
  $('mPos').textContent = (idx + 1) + ' / ' + playlist.length;
  const mImg = $('mSlide');
  if (mImg) {
    mImg.src = 'slides/' + String(item.n).padStart(2, '0') + '.jpg';
    mImg.alt = 'Slide ' + item.n + ' — ' + item.title;
  }
  $('mPrev').disabled = idx <= 0;
  $('mNext').disabled = idx >= playlist.length - 1;

  if (autoplay) {
    try { await v.play(); }
    catch (e) { /* user gesture / autoplay policy — controls still work */ }
  }
  preloadPlaylistItem(idx + 1);
}

async function playRunStep(delta) {
  const next = plIndex + delta;
  if (next < 0 || next >= playlist.length) {
    if (delta > 0) closeTake(); // finished the run
    return;
  }
  await loadPlaylistItem(next);
}

async function openTake() {
  if (!view.length) return;
  if (recording) stopRec();
  const n = view[i].n;
  let blob;
  try { blob = await getTake(n); }
  catch (e) { showErr('Could not open that take.'); return; }
  if (!blob) return;
  revokePreload();
  revokePlayUrl();
  playUrl = URL.createObjectURL(blob);
  setModalMode(false);
  playlist = [];
  plIndex = 0;
  $('playback').src = playUrl;
  $('mTitle').textContent = 'Slide ' + n + ' — ' + view[i].title;
  lastFocus = document.activeElement;
  $('modal').classList.remove('hidden');
  $('mClose').focus();
  $('playback').play().catch(() => {});
}

async function openRun() {
  if (haveTake.size === 0) {
    showErr('Record at least one slide before playing the full run.');
    return;
  }
  if (recording) stopRec();
  playlist = buildPlaylist();
  if (!playlist.length) {
    showErr('No takes to play yet.');
    return;
  }
  revokePreload();
  revokePlayUrl();
  setModalMode(true);
  lastFocus = document.activeElement;
  $('modal').classList.remove('hidden');
  $('mClose').focus();
  plAdvance = true;
  await loadPlaylistItem(0);
}

function closeTake() {
  plAdvance = false;
  $('playback').pause();
  $('playback').removeAttribute('src');
  $('playback').load();
  const mImg = $('mSlide');
  if (mImg) { mImg.removeAttribute('src'); mImg.alt = ''; }
  $('modal').classList.add('hidden');
  setModalMode(false);
  revokePreload();
  revokePlayUrl();
  playlist = [];
  if (lastFocus && typeof lastFocus.focus === 'function') {
    try { lastFocus.focus(); } catch (e) { /* element gone */ }
  }
  lastFocus = null;
}
async function download() {
  const n = plMode && playlist[plIndex] ? playlist[plIndex].n : (view[i] && view[i].n);
  if (n == null) return;
  let blob;
  try { blob = await getTake(n); }
  catch (e) { showErr('Could not download that take.'); return; }
  if (!blob) return;
  const ext = (blob.type || '').includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `slide-${String(n).padStart(2, '0')}-take.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function removeTake() {
  if (!view.length) return;
  const n = view[i].n;
  try { await delTake(n); }
  catch (e) { showErr('Could not delete that take.'); return; }
  haveTake.delete(n);
  delete takeMeta[n]; saveTakeMeta();
  renderTake();
  if (view[i]) {
    $('sNum').className = 'num'
      + (haveTake.has(view[i].n) ? ' has-take' : '')
      + (flags.has(view[i].n) ? ' flagged' : '');
  }
}

/* ---------------- wiring ---------------- */
function go(d) {
  if (!view.length) return;
  persistScriptFromDom();
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
    if (!hidden) applySavedPipPos();
  } else camOn();
};
$('pipX').onclick = () => {
  $('pip').classList.add('hidden');
  if (stream) $('camBtn').textContent = 'Camera hidden';
};
$('playBtn').onclick = openTake;
$('playAll').onclick = openRun;
$('dlBtn').onclick = download;
$('delBtn').onclick = removeTake;
$('mDl').onclick = download;
$('mClose').onclick = closeTake;
$('mPrev').onclick = () => { if (plMode) playRunStep(-1); };
$('mNext').onclick = () => { if (plMode) playRunStep(1); };
$('modal').onclick = e => { if (e.target === $('modal')) closeTake(); };
$('playback').addEventListener('ended', () => {
  if (plMode && plAdvance) playRunStep(1);
});
$('filter').onchange = () => {
  persistScriptFromDom();
  if (recording) stopRec();
  applyFilter();
};
$('jump').onchange = e => {
  if (!view.length) return;
  persistScriptFromDom();
  if (recording) stopRec();
  i = +e.target.value; render();
};
$('resetScript').onclick = resetScript;
$('copySlide').onclick = copySlideScript;
$('copyScript').onclick = copyAllScript;
$('exportScript').onclick = exportAllScript;
$('exportScript').title = 'Download the full script (.md). Shift-click for plain .txt';
$('script').addEventListener('input', scheduleScriptSave);
$('script').addEventListener('blur', persistScriptFromDom, true);
$('flagBtn').onclick = () => {
  if (!view.length) return;
  const n = view[i].n;
  flags.has(n) ? flags.delete(n) : flags.add(n);
  try { localStorage.setItem('flags', JSON.stringify([...flags])); }
  catch (e) { showErr('Could not save flags in this browser.'); }
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

// Narrow layout only: tap the slide to read the script; tap off the text to return.
function mobileFlipActive() {
  const tabs = document.querySelector('.view-tabs');
  return !!(tabs && getComputedStyle(tabs).display !== 'none');
}
function flipTo(which) {
  if (!mobileFlipActive() || mobileView === which) return;
  persistScriptFromDom();
  setMobileView(which);
}

let suppressSlideFlipUntil = 0;
let scriptPtrOrigin = null; // 'edit' | 'other' — avoid flip after drag-selecting text

document.querySelector('.slide-wrap').addEventListener('click', e => {
  if (Date.now() < suppressSlideFlipUntil) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  flipTo('script');
});

$('script').addEventListener('pointerdown', e => {
  scriptPtrOrigin = e.target.closest('.edit') ? 'edit' : 'other';
});
$('script').addEventListener('click', e => {
  // Drag-select that ends outside the edit field should not flip.
  if (scriptPtrOrigin === 'edit') { scriptPtrOrigin = null; return; }
  scriptPtrOrigin = null;
  // Anywhere in the script pane that isn't editable text / a control → back to slide.
  if (e.target.closest('.edit, button, a, select, input')) return;
  // Ignore tiny accidental clicks while a text selection is active in the script.
  const sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && $('script').contains(sel.anchorNode)) return;
  flipTo('slide');
});
document.querySelector('.pane-script .pane-hd').addEventListener('click', e => {
  if (e.target.closest('button, a, select, input')) return;
  flipTo('slide');
});

$('sImg').onerror = () => {
  showErr('Slide image failed to load. Check that slides/' + String(view[i] && view[i].n).padStart(2, '0') + '.jpg is present.');
};

document.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.target.closest('input, select, textarea, [contenteditable]')) return;
  if (e.key === 'Escape') { closeTake(); return; }
  // Continuous run: arrow keys skip takes while the dialog is open.
  if (!$('modal').classList.contains('hidden')) {
    if (plMode && e.key === 'ArrowRight') { e.preventDefault(); playRunStep(1); }
    else if (plMode && e.key === 'ArrowLeft') { e.preventDefault(); playRunStep(-1); }
    return;
  }
  if (e.target.closest('video')) return;
  // Space on a focused button already activates it — don't double-fire record.
  if (e.code === 'Space') {
    if (e.target.closest('button, a, [role="button"]')) return;
    e.preventDefault();
    toggleRec();
  } else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  else if (e.key.toLowerCase() === 'f') { e.preventDefault(); $('flagBtn').click(); }
  else if (e.key.toLowerCase() === 's') { e.preventDefault(); $('shuffle').click(); }
  else if (e.key === '1') setMobileView('slide');
  else if (e.key === '2') setMobileView('script');
});

/* swipe between slides on the slide pane; a short tap opens the script (mobile) */
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
    if (Math.abs(dx) >= 56 && Math.abs(dx) >= Math.abs(dy) * 1.2) {
      // Block the synthetic click that follows a swipe so we don't also flip to script.
      suppressSlideFlipUntil = Date.now() + 450;
      go(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
})();

/* ---------------- draggable camera pip ---------------- */
const PIP_MARGIN = 6;

function clampPip() {
  const pip = $('pip');
  if (!pip || pip.classList.contains('hidden')) return;
  const w = pip.offsetWidth, h = pip.offsetHeight;
  if (!w || !h) return;
  const r = pip.getBoundingClientRect();
  const maxLeft = Math.max(PIP_MARGIN, window.innerWidth - w - PIP_MARGIN);
  const maxTop = Math.max(PIP_MARGIN, window.innerHeight - h - PIP_MARGIN);
  const left = Math.min(Math.max(PIP_MARGIN, r.left), maxLeft);
  const top = Math.min(Math.max(PIP_MARGIN, r.top), maxTop);
  pip.style.left = left + 'px';
  pip.style.top = top + 'px';
  pip.style.right = 'auto';
  pip.style.bottom = 'auto';
}

function savePipPos() {
  try {
    const pip = $('pip');
    if (pip.style.left && pip.style.top) {
      localStorage.setItem('pipPos', JSON.stringify({ left: parseFloat(pip.style.left), top: parseFloat(pip.style.top) }));
    }
  } catch (e) { /* position just won't persist */ }
}

// Called after the pip is made visible: restore its last spot (clamped) if any.
function applySavedPipPos() {
  const pip = $('pip');
  if (!pip || pip.classList.contains('hidden')) return;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem('pipPos') || 'null'); } catch (e) { pos = null; }
  if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
    pip.style.left = pos.left + 'px';
    pip.style.top = pos.top + 'px';
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
  }
  clampPip();
}

(function enablePipDrag() {
  const pip = $('pip');
  if (!pip) return;
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  pip.addEventListener('pointerdown', e => {
    if (e.target.closest('#pipX')) return;            // let the hide button work
    if (e.button != null && e.button > 0) return;     // primary button / touch only
    const r = pip.getBoundingClientRect();
    pip.style.left = r.left + 'px';                   // switch from right/bottom anchoring
    pip.style.top = r.top + 'px';
    pip.style.right = 'auto';
    pip.style.bottom = 'auto';
    dragging = true;
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    pip.classList.add('dragging');
    try { pip.setPointerCapture(e.pointerId); } catch (er) { /* ignore */ }
  });
  pip.addEventListener('pointermove', e => {
    if (!dragging) return;
    const w = pip.offsetWidth, h = pip.offsetHeight;
    const maxLeft = Math.max(PIP_MARGIN, window.innerWidth - w - PIP_MARGIN);
    const maxTop = Math.max(PIP_MARGIN, window.innerHeight - h - PIP_MARGIN);
    const left = Math.min(Math.max(PIP_MARGIN, ox + (e.clientX - sx)), maxLeft);
    const top = Math.min(Math.max(PIP_MARGIN, oy + (e.clientY - sy)), maxTop);
    pip.style.left = left + 'px';
    pip.style.top = top + 'px';
  });
  const end = e => {
    if (!dragging) return;
    dragging = false;
    pip.classList.remove('dragging');
    try { pip.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ }
    savePipPos();
  };
  pip.addEventListener('pointerup', end);
  pip.addEventListener('pointercancel', end);
})();

window.addEventListener('resize', clampPip);

window.addEventListener('beforeunload', e => {
  if (recording) { e.preventDefault(); e.returnValue = ''; }
});

/* keep Tab inside the playback dialog while it is open */
$('modal').addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  const focusable = Array.from($('modal').querySelectorAll('button, video, [href], [tabindex]:not([tabindex="-1"])'))
    .filter(el => !el.hidden && !el.disabled && el.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0], last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

(async function boot() {
  $('rec').disabled = false;

  // Keep the "All N slides" label and the header runtime honest if the deck grows.
  const allOpt = $('filter').querySelector('option[value="all"]');
  if (allOpt) allOpt.textContent = 'All ' + DECK_LEN + ' slides';
  const totalSecs = DECK.reduce((a, s) => a + parseTime(s.len), 0);
  const brandFull = document.querySelector('.brand .full');
  if (brandFull && totalSecs > 0) brandFull.textContent = '· rehearsal · ~' + Math.round(totalSecs / 60) + ' min';

  try {
    await openDB();
    const keys = await allKeys() || [];
    keys.forEach(k => haveTake.add(Number(k)));
  } catch (e) {
    showErr('This browser blocked local storage, so takes will not be kept after you close the tab.');
  }

  // Forget durations whose recordings are no longer present.
  let pruned = false;
  for (const k of Object.keys(takeMeta)) {
    if (!haveTake.has(Number(k))) { delete takeMeta[k]; pruned = true; }
  }
  if (pruned) saveTakeMeta();

  fillJump();
  render();
})();
