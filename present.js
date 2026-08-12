/* Show-day presenter + audience. Loaded after app.js. No-ops in rehearsal mode. */
(function () {
  if (typeof IS_SHOW === 'undefined' || !IS_SHOW) return;

  const CHANNEL = 'house-present';
  const STORE = 'house-present';
  const PACE_SLACK = 60;
  const isPresent = SHOW_MODE === 'present';
  const isAudience = SHOW_MODE === 'audience';
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.documentElement.classList.add(isPresent ? 'mode-present' : 'mode-audience');
  document.body.classList.add(isPresent ? 'mode-present' : 'mode-audience');
  document.title = isPresent
    ? 'Presenter — The House That AI Built'
    : 'Audience — The House That AI Built';

  const PLAN_AT = [];
  let acc = 0;
  DECK.forEach((s, idx) => { PLAN_AT[idx] = acc; acc += parseTime(s.len); });

  let slideN = DECK[0].n;
  let line = 0;
  let rev = 0;
  let lastRev = -1;
  let lastAppliedT = -1;
  let clockStart = null;
  let rec = null;
  let voiceOn = false;
  let wordPos = 0;
  let scriptWords = [];
  let folded = false;
  let lastHeard = '';

  let ch = null;
  try { ch = new BroadcastChannel(CHANNEL); }
  catch (e) { ch = null; }

  function onChannelMessage(ev) {
    const msg = ev.data || {};
    if ((msg.type === 'hello' || msg.type === 'request-state') && isPresent) broadcastState({ force: true });
    else if (msg.type === 'nav' && isPresent) {
      if (msg.direction === 'next' || msg.direction === 'prev') nav(msg.direction);
    } else if (msg.type === 'state') applyState(msg);
  }
  if (ch) ch.onmessage = onChannelMessage;

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function deckIndex(n) {
    const i = DECK.findIndex(s => s.n === n);
    return i < 0 ? 0 : i;
  }
  function slideOf(n) { return DECK[deckIndex(n)]; }
  function nextSlide(n) {
    const i = deckIndex(n);
    return i < DECK.length - 1 ? DECK[i + 1] : null;
  }
  function firstSay(s) {
    if (!s) return '';
    for (const it of itemsFor(s.n)) {
      if (it.t === 'say' && it.lines && it.lines[0]) return it.lines[0];
    }
    return s.title || '';
  }
  function rowsFor(n) {
    const rows = [];
    let lastWho = null;
    for (const it of itemsFor(n)) {
      if (it.t === 'say') {
        const showWho = it.who !== lastWho;
        lastWho = it.who;
        (it.lines || []).forEach((text, li) => {
          rows.push({ kind: 'say', who: it.who, text, showWho: showWho && li === 0 });
        });
      } else {
        lastWho = null;
        rows.push({ kind: it.t, text: it.text || '' });
      }
    }
    return rows;
  }
  function speakerName(who) {
    if (who === 'BOTH') return 'WILL + CAROLINE';
    return NAME[who] || who || '—';
  }

  function elapsedSecs() {
    if (!clockStart) return 0;
    return Math.max(0, Math.floor((Date.now() - clockStart) / 1000));
  }
  function ensureClock() {
    if (!clockStart) clockStart = Date.now();
  }

  function persist() {
    try {
      sessionStorage.setItem(STORE, JSON.stringify({
        slide: slideN, line: line, rev: rev, clockStart: clockStart, wordPos: wordPos
      }));
    } catch (e) { /* private mode */ }
  }
  function restore() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (!s || typeof s.slide !== 'number') return;
      if (DECK.some(d => d.n === s.slide)) slideN = s.slide;
      const rows = rowsFor(slideN);
      line = Math.max(0, Math.min(rows.length ? rows.length - 1 : 0, s.line | 0));
      if (typeof s.rev === 'number') {
        rev = s.rev;
        lastRev = s.rev;
      }
      if (typeof s.clockStart === 'number' && s.clockStart > 0) clockStart = s.clockStart;
      if (typeof s.wordPos === 'number') wordPos = Math.max(0, s.wordPos | 0);
    } catch (e) { /* ignore */ }
  }

  function post(msg) {
    if (!ch) return;
    try { ch.postMessage(msg); } catch (e) { /* ignore */ }
  }
  function broadcastState(opts) {
    rev += 1;
    persist();
    post({ type: 'state', slide: slideN, line: line, rev: rev, t: Date.now(), force: !!(opts && opts.force) });
  }

  function applyState(msg) {
    if (!msg || typeof msg.slide !== 'number') return;
    // Order by wall-clock t. Presenter and audience are two windows on ONE machine, so
    // Date.now() is a shared clock that never resets when a tab restarts — unlike the
    // per-window rev counter, which could blackhole a refreshed audience (or even a
    // Resync) after the presenter window is reopened. A forced reply always applies.
    const t = typeof msg.t === 'number' ? msg.t : 0;
    if (!msg.force && t && t < lastAppliedT) return;
    if (t) lastAppliedT = Math.max(lastAppliedT, t);
    if (typeof msg.rev === 'number') lastRev = msg.rev;
    const n = DECK.some(s => s.n === msg.slide) ? msg.slide : DECK[0].n;
    const rows = rowsFor(n);
    const ln = Math.max(0, Math.min(rows.length ? rows.length - 1 : 0, msg.line | 0));
    const changedSlide = n !== slideN;
    slideN = n;
    line = ln;
    persist();
    if (isAudience) renderAudience();
    else if (changedSlide) renderPresent({ keepLine: true });
    else highlightLine();
  }

  function gotoSlide(n, { fromNav } = {}) {
    if (!DECK.some(s => s.n === n)) return;
    if (fromNav && n !== slideN) {
      ensureClock();
      const setup = $('pvSetup');
      if (setup) setup.hidden = true;
    }
    slideN = n;
    line = 0;
    wordPos = 0;
    lastHeard = '';
    if (isPresent) {
      renderPresent();
      broadcastState();
    }
  }

  function nav(dir) {
    const i = deckIndex(slideN);
    const j = i + (dir === 'next' ? 1 : -1);
    if (j < 0 || j >= DECK.length) return;
    gotoSlide(DECK[j].n, { fromNav: true });
  }

  function isNextKey(e) {
    return e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === 'ArrowDown';
  }
  function isPrevKey(e) {
    return e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'ArrowUp';
  }
  function isIgnored(e) {
    return e.key === '.' || e.code === 'Period' || e.key === 'b' || e.key === 'B';
  }

  document.addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.code === 'Space') { e.preventDefault(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      return;
    }
    if (isIgnored(e)) { e.preventDefault(); return; }
    if (isNextKey(e) || isPrevKey(e)) {
      e.preventDefault();
      const direction = isNextKey(e) ? 'next' : 'prev';
      if (isPresent) nav(direction);
      else post({ type: 'nav', direction: direction, t: Date.now() });
    }
  });

  /* ---------- audience ---------- */
  function renderAudience() {
    const s = slideOf(slideN);
    const img = $('audImg');
    if (!img || !s) return;
    const src = 'slides/' + String(s.n).padStart(2, '0') + '.jpg';
    if (img.getAttribute('src') !== src) img.src = src;
    img.alt = '';
  }

  /* ---------- presenter ---------- */
  function setFold(on) {
    folded = !!on;
    const app = $('presentApp');
    const btn = $('pvFold');
    if (app) app.classList.toggle('pv-compact', folded);
    if (btn) btn.textContent = folded ? 'Expand' : 'Collapse';
    try { sessionStorage.setItem(STORE + '-fold', folded ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  function paintWords() {
    scriptWords.forEach((w, i) => {
      w.el.classList.toggle('heard', i < wordPos);
      w.el.classList.toggle('now', i === wordPos);
    });
    if (scriptWords[wordPos]) line = scriptWords[wordPos].line;
    const box = $('pvScript');
    if (!box) return;
    box.querySelectorAll('.pv-row').forEach((el, idx) => {
      el.classList.toggle('on', idx === line);
      el.classList.toggle('past', idx < line);
    });
  }

  function scrollToCurrent(force) {
    const box = $('pvScript');
    if (!box) return;
    if (wordPos <= 0 && line === 0) {
      box.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      return;
    }
    const el = (scriptWords[wordPos] && scriptWords[wordPos].el) || box.querySelector('.pv-row.on');
    if (!el) return;
    const er = el.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const lo = br.top + br.height * 0.18;
    const hi = br.top + br.height * 0.62;
    if (force || er.top < lo || er.bottom > hi) {
      el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
    }
  }

  function highlightLine() {
    paintWords();
    scrollToCurrent(true);
  }

  function jumpToWord(idx) {
    if (!scriptWords.length) return;
    wordPos = Math.max(0, Math.min(scriptWords.length - 1, idx | 0));
    line = scriptWords[wordPos].line;
    persist();
    paintWords();
    scrollToCurrent(true);
  }

  function appendSayText(el, text, lineIdx) {
    String(text || '').split(/(\s+)/).forEach(tok => {
      if (!tok) return;
      if (/^\s+$/.test(tok)) {
        el.appendChild(document.createTextNode(tok));
        return;
      }
      const span = document.createElement('span');
      span.className = 'pv-w';
      span.dataset.line = String(lineIdx);
      span.textContent = tok;
      span.onclick = ev => {
        ev.stopPropagation();
        const i = scriptWords.findIndex(w => w.el === span);
        if (i >= 0) jumpToWord(i);
        broadcastState();
      };
      el.appendChild(span);
    });
  }

  function rebuildWords() {
    scriptWords = [];
    const box = $('pvScript');
    if (!box) return;
    box.querySelectorAll('.pv-w').forEach(span => {
      const norm = tokens(span.textContent)[0] || '';
      if (!norm) return;
      scriptWords.push({ el: span, line: +span.dataset.line || 0, norm: norm });
    });
    if (wordPos >= scriptWords.length) wordPos = Math.max(0, scriptWords.length - 1);
  }

  function renderPresent(opts) {
    const keepLine = opts && opts.keepLine;
    const s = slideOf(slideN);
    const nxt = nextSlide(slideN);
    const rows = rowsFor(s.n);
    if (!keepLine) line = 0;
    if (line >= rows.length) line = Math.max(0, rows.length - 1);

    const who = s.who || 'C';
    const whoEl = $('pvWho');
    whoEl.textContent = speakerName(who);
    whoEl.className = 'pv-who ' + who;

    $('pvSlide').textContent = 'SLIDE ' + s.n + ' / ' + DECK_LEN;
    $('pvAct').textContent = s.act || '';

    const hand = $('pvHand');
    if (nxt && nxt.who && nxt.who !== who && nxt.who !== 'NONE') {
      hand.hidden = false;
      hand.innerHTML = 'HANDOFF → ' + esc(speakerName(nxt.who))
        + '<span class="nextline">NEXT: “' + esc(firstSay(nxt)) + '”</span>';
    } else {
      hand.hidden = true;
      hand.textContent = '';
    }

    const nextBox = $('pvNextBeat');
    if (!nxt) nextBox.textContent = 'End of deck';
    else nextBox.textContent = speakerName(nxt.who) + ' · “' + firstSay(nxt) + '”';

    const mini = $('pvMini');
    if (mini) {
      let t = speakerName(who) + ' · SLIDE ' + s.n + ' / ' + DECK_LEN;
      if (nxt && nxt.who && nxt.who !== who && nxt.who !== 'NONE') {
        t += ' · HANDOFF → ' + speakerName(nxt.who);
      }
      mini.textContent = t;
    }

    const box = $('pvScript');
    box.innerHTML = '';
    rows.forEach((row, idx) => {
      const el = document.createElement('div');
      el.className = 'pv-row ' + row.kind + (idx === line ? ' on' : idx < line ? ' past' : '');
      el.dataset.i = String(idx);
      if (row.kind === 'say') {
        if (row.showWho) {
          const tag = document.createElement('span');
          tag.className = 'who-tag ' + row.who;
          tag.textContent = speakerName(row.who);
          el.appendChild(tag);
        }
        appendSayText(el, row.text, idx);
      } else if (row.kind === 'do') {
        const lab = document.createElement('span'); lab.className = 'pv-lab'; lab.textContent = 'ACTION';
        el.appendChild(lab);
        el.appendChild(document.createTextNode(row.text));
      } else if (row.kind === 'cut') {
        const lab = document.createElement('span'); lab.className = 'pv-lab'; lab.textContent = 'OPTIONAL / CUT IF NEEDED';
        el.appendChild(lab);
        el.appendChild(document.createTextNode(row.text));
      } else {
        const lab = document.createElement('span'); lab.className = 'pv-lab'; lab.textContent = 'NOTE';
        el.appendChild(lab);
        el.appendChild(document.createTextNode(row.text));
      }
      el.onclick = () => {
        line = idx;
        const first = scriptWords.findIndex(w => w.line === idx);
        wordPos = first >= 0 ? first : wordPos;
        persist();
        highlightLine();
        broadcastState();
      };
      box.appendChild(el);
    });
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'pv-row note';
      empty.textContent = 'No script on this slide.';
      box.appendChild(empty);
    }
    rebuildWords();
    if (!keepLine) wordPos = 0;
    else {
      const first = scriptWords.findIndex(w => w.line === line);
      if (first >= 0 && (wordPos < first || (scriptWords[wordPos] && scriptWords[wordPos].line !== line))) {
        wordPos = first;
      }
    }
    requestAnimationFrame(() => highlightLine());
    tickClock();
  }

  function tickClock() {
    const el = $('pvTime');
    const pace = $('pvPace');
    if (!el) return;
    const e = elapsedSecs();
    const plan = PLAN_AT[deckIndex(slideN)] || 0;
    el.textContent = 'Elapsed ' + fmtTime(e) + ' · Plan ~' + fmtTime(plan) + ' · Slot ~30 min';
    pace.className = 'pv-pace';
    if (!clockStart) {
      pace.textContent = 'Holding';
      pace.classList.add('ok');
    } else if (Math.abs(e - plan) <= PACE_SLACK) {
      pace.textContent = 'On pace';
      pace.classList.add('ok');
    } else if (e < plan - PACE_SLACK) {
      pace.textContent = 'A little fast';
      pace.classList.add('fast');
    } else {
      pace.textContent = 'A little slow';
      pace.classList.add('slow');
    }
  }

  function resetNotes() {
    line = 0;
    wordPos = 0;
    lastHeard = '';
    persist();
    if (rec) {
      try { rec.abort(); } catch (e) { /* ignore */ }
      rec = null;
      if (voiceOn) startVoice();
    }
    const box = $('pvScript');
    if (box) box.scrollTop = 0;
    highlightLine();
    requestAnimationFrame(() => highlightLine());
  }

  function openAudience() {
    const u = new URL(location.href);
    u.searchParams.set('mode', 'audience');
    const aw = Math.max(720, Math.floor((screen.availWidth || 1280) / 2));
    const ah = Math.max(480, screen.availHeight || 800);
    const left = Math.max(0, (screen.availLeft || 0) + (screen.availWidth || 1280) - aw);
    const top = screen.availTop || 0;
    const w = window.open(
      u.toString(),
      'house-audience',
      'width=' + aw + ',height=' + ah + ',left=' + left + ',top=' + top + ',menubar=no,toolbar=no,location=yes'
    );
    const alert = $('pvAlert');
    if (!w) {
      if (alert) {
        alert.textContent = 'Popup blocked. Allow popups, or open this in another tab: ' + u.toString();
        alert.classList.remove('hidden');
      }
      return;
    }
    if (alert) {
      alert.textContent = '';
      alert.classList.add('hidden');
    }
    try { w.focus(); } catch (e) { /* ignore */ }
    setTimeout(() => broadcastState({ force: true }), 250);
    setTimeout(() => broadcastState({ force: true }), 1000);
  }

  /* ---------- optional speech follow (never changes slides) ---------- */
  const FILLER = { um: 1, uh: 1, er: 1, ah: 1, hmm: 1, huh: 1, mm: 1, mmm: 1, uhuh: 1 };

  function tokens(s) {
    return String(s || '').toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w && !FILLER[w]);
  }

  function closeWord(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
    if (Math.abs(a.length - b.length) > 1 || a.length < 5 || b.length < 5) return false;
    const x = a.length >= b.length ? a : b;
    const y = a.length >= b.length ? b : a;
    let i = 0, j = 0, miss = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) { i++; j++; continue; }
      miss++;
      if (miss > 1) return false;
      if (x.length > y.length) i++;
      else { i++; j++; }
    }
    return miss + (x.length - i) + (y.length - j) <= 1;
  }

  function followTranscript(text) {
    if (!scriptWords.length) return;
    const heard = tokens(text);
    if (heard.length < 1) return;
    const tail = heard.slice(-14);
    const from = wordPos;
    const lo = Math.max(0, from - 6);
    const hi = Math.min(scriptWords.length, from + 48);
    let bestN = 0, bestPos = from;

    for (let o = 0; o < tail.length; o++) {
      const seq = tail.slice(o);
      if (!seq.length) continue;
      for (let i = lo; i < hi; i++) {
        let n = 0;
        while (n < seq.length && i + n < scriptWords.length && closeWord(seq[n], scriptWords[i + n].norm)) n++;
        const enough = n >= 2 || (n === 1 && seq[0].length >= 4);
        if (!enough) continue;
        const pos = Math.min(scriptWords.length - 1, i + n - 1);
        if (n > bestN || (n === bestN && Math.abs(pos - from) < Math.abs(bestPos - from))) {
          bestN = n;
          bestPos = pos;
        }
      }
    }
    if (bestN < 1) return;
    if (bestPos < from - 8) return;
    if (bestPos > from + 24 && bestN < 3) return;
    if (bestPos === wordPos) return;
    wordPos = bestPos;
    line = scriptWords[wordPos].line;
    persist();
    paintWords();
    scrollToCurrent(false);
  }
  function speechAvailable() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      voiceOn = false;
      const box = $('pvVoice');
      if (box) box.checked = false;
      return;
    }
    stopVoice();
    lastHeard = '';
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    rec.lang = 'en-US';
    rec.onresult = ev => {
      let interim = '';
      let finals = lastHeard;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const alt = ev.results[i][0] && ev.results[i][0].transcript || '';
        if (ev.results[i].isFinal) finals += ' ' + alt;
        else interim += ' ' + alt;
        for (let a = 1; a < ev.results[i].length; a++) {
          const extra = ev.results[i][a] && ev.results[i][a].transcript;
          if (extra) followTranscript(finals + ' ' + extra + ' ' + interim);
        }
      }
      lastHeard = finals.replace(/\s+/g, ' ').trim().split(' ').slice(-40).join(' ');
      followTranscript(lastHeard + ' ' + interim);
    };
    rec.onerror = () => { /* stay on current line; slides never move */ };
    rec.onend = () => { if (voiceOn) { try { rec.start(); } catch (e) { /* ignore */ } } };
    try { rec.start(); }
    catch (e) {
      voiceOn = false;
      $('pvVoice').checked = false;
      $('pvVoiceLab').classList.remove('on');
    }
  }
  function stopVoice() {
    if (!rec) return;
    const r = rec;
    rec = null;
    try { r.onend = null; r.abort(); } catch (e) { /* ignore */ }
  }

  if (isPresent) {
    restore();
    $('pvBack').onclick = () => nav('prev');
    $('pvNext').onclick = () => nav('next');
    $('pvReset').onclick = resetNotes;
    $('pvResync').onclick = () => broadcastState({ force: true });
    $('pvOpenAud').onclick = openAudience;
    $('pvFold').onclick = () => setFold(!folded);
    try { if (sessionStorage.getItem(STORE + '-fold') === '1') setFold(true); } catch (e) { /* ignore */ }
    if (!speechAvailable()) {
      $('pvVoice').disabled = true;
      $('pvVoiceLab').title = 'Speech recognition is not available in this browser';
    }
    $('pvVoice').onchange = e => {
      voiceOn = !!e.target.checked;
      $('pvVoiceLab').classList.toggle('on', voiceOn);
      if (voiceOn) startVoice();
      else stopVoice();
    };
    setInterval(tickClock, 1000);
    renderPresent({ keepLine: true });
    broadcastState();
    window.addEventListener('beforeunload', e => {
      e.preventDefault();
      e.returnValue = '';
    });
  } else {
    let hadStore = false;
    try { hadStore = !!sessionStorage.getItem(STORE); } catch (e) { /* ignore */ }
    if (hadStore) {
      restore();
      renderAudience();
    }
    function requestState() {
      const t = Date.now();
      post({ type: 'request-state', t: t });
      post({ type: 'hello', t: t });
    }
    requestState();
    window.addEventListener('pageshow', requestState);
    setTimeout(requestState, 50);
    setTimeout(requestState, 250);
    setTimeout(requestState, 1000);
    window.addEventListener('beforeunload', e => {
      e.preventDefault();
      e.returnValue = '';
    });
    let hideCursor = null;
    const idle = () => {
      document.documentElement.classList.add('aud-idle');
    };
    document.addEventListener('mousemove', () => {
      document.documentElement.classList.remove('aud-idle');
      clearTimeout(hideCursor);
      hideCursor = setTimeout(idle, 2000);
    });
    hideCursor = setTimeout(idle, 2000);
  }
})();
