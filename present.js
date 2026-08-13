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
  let block = 0;            // canonical: which speaking beat within the slide
  let lastHeard = '';
  let lastNavAt = 0;        // debounce so one clicker press can't jump two beats
  let rev = 0;
  let lastRev = -1;
  let lastAppliedT = -1;
  let clockStart = null;
  let rec = null;
  let voiceOn = false;
  let wordPos = 0;
  let scriptWords = [];
  let folded = false;
  let hearStream = null, hearCtx = null, hearAnalyser = null, hearRaf = null, hearLiveUntil = 0;

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
  // Group a slide's raw items into presentation beats, so one click = one meaningful
  // beat instead of one per item. A `say` (or an action/cut explicitly flagged
  // stop:true) starts a beat; do/cut/note attach to the current beat and ride along.
  // A `note` is never its own click — it just shows with the beat it belongs to.
  function beatsOf(n) {
    const beats = [];
    let cur = null, pending = [];
    itemsFor(n).forEach((it, idx) => {
      const standalone = (it.t === 'do' || it.t === 'cut') && it.stop === true;
      if (it.t === 'say' || standalone) {
        cur = pending.concat([{ it: it, idx: idx }]);
        beats.push(cur);
        pending = [];
      } else if (cur) {
        cur.push({ it: it, idx: idx });
      } else {
        pending.push({ it: it, idx: idx });   // leading note/action → rides the first beat
      }
    });
    if (pending.length) beats.push(pending);
    if (!beats.length) beats.push([]);
    return beats;
  }
  function beatCount(n) {
    return beatsOf(n).length;
  }
  function firstSay(s) {
    if (!s) return '';
    for (const it of itemsFor(s.n)) {
      if (it.t === 'say' && it.lines && it.lines[0]) return it.lines[0];
    }
    return s.title || '';
  }
  // Rows carry their BEAT index (not their raw item index) so a whole beat highlights
  // and scrolls as one unit.
  function rowsFor(n) {
    const rows = [];
    let lastWho = null;
    beatsOf(n).forEach((beat, bi) => {
      beat.forEach(node => {
        const it = node.it;
        if (it.t === 'say') {
          const showWho = it.who !== lastWho;
          lastWho = it.who;
          (it.lines || []).forEach((text, li) => {
            rows.push({ kind: 'say', who: it.who, text, showWho: showWho && li === 0, block: bi });
          });
        } else {
          lastWho = null;
          rows.push({ kind: it.t, text: it.text || '', block: bi });
        }
      });
    });
    return rows;
  }
  function speakerName(who) {
    if (who === 'BOTH') return 'WILL + CAROLINE';
    return NAME[who] || who || '—';
  }
  // Huge banner follows the current beat's speaker, not only the slide lead.
  function whoNow() {
    const beat = beatsOf(slideN)[block] || [];
    const say = beat.find(node => node.it && node.it.t === 'say');
    if (say) return say.it.who;
    const s = slideOf(slideN);
    return (s && s.who) || 'C';
  }
  function paintSpeaker() {
    const who = whoNow();
    const whoEl = $('pvWho');
    if (whoEl) {
      whoEl.textContent = speakerName(who);
      whoEl.className = 'pv-who ' + who;
    }
    const s = slideOf(slideN);
    const mini = $('pvMini');
    if (mini && s) {
      const nxt = nextSlide(slideN);
      let t = speakerName(who) + ' · SLIDE ' + s.n + ' / ' + DECK_LEN;
      if (nxt && nxt.who && nxt.who !== s.who && nxt.who !== 'NONE') {
        t += ' · HANDOFF → ' + speakerName(nxt.who);
      }
      mini.textContent = t;
    }
  }
  function warmSlides() {
    DECK.forEach(s => {
      const img = new Image();
      img.src = 'slides/' + String(s.n).padStart(2, '0') + '.jpg';
    });
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
        slide: slideN, block: block, line: line, rev: rev, clockStart: clockStart, wordPos: wordPos
      }));
    } catch (e) { /* private mode */ }
  }
  function restore() {
    try {
      const s = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (!s || typeof s.slide !== 'number') return;
      if (DECK.some(d => d.n === s.slide)) slideN = s.slide;
      if (typeof s.block === 'number') block = Math.max(0, Math.min(beatCount(slideN) - 1, s.block | 0));
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
    post({ type: 'state', slide: slideN, block: block, line: line, rev: rev, t: Date.now(), force: !!(opts && opts.force) });
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
    const bl = typeof msg.block === 'number' ? Math.max(0, Math.min(beatCount(n) - 1, msg.block | 0)) : 0;
    const changedSlide = n !== slideN;
    slideN = n;
    block = bl;
    persist();
    // Audience only ever cares about the slide; the beat is presenter-only.
    if (isAudience) renderAudience();
    else if (changedSlide) renderPresent();
    else highlightBlock();
  }

  // Canonical move to {slide, beat}. Audience redraws only when the slide changes.
  function gotoBeat(nSlide, nBlock, opts) {
    if (!DECK.some(s => s.n === nSlide)) return;
    const fromNav = opts && opts.fromNav;
    const changedSlide = nSlide !== slideN;
    if (fromNav) {
      ensureClock();
      const setup = $('pvSetup');
      if (setup) setup.hidden = true;
    }
    slideN = nSlide;
    block = Math.max(0, Math.min(beatCount(nSlide) - 1, nBlock | 0));
    wordPos = firstWordOfBlock(block);
    lastHeard = '';
    if (isPresent) {
      if (changedSlide) renderPresent();
      else highlightBlock();
      broadcastState();
    }
  }

  // Clicker Next/Prev walk the beat list; crossing a slide edge moves the audience.
  function nav(dir) {
    const now = Date.now();
    if (now - lastNavAt < 300) return;   // ignore a bounced double-press
    lastNavAt = now;
    if (dir === 'next') {
      if (block + 1 < beatCount(slideN)) { gotoBeat(slideN, block + 1, { fromNav: true }); return; }
      const nx = nextSlide(slideN);
      if (nx) gotoBeat(nx.n, 0, { fromNav: true });
    } else {
      if (block > 0) { gotoBeat(slideN, block - 1, { fromNav: true }); return; }
      const pi = deckIndex(slideN) - 1;
      if (pi >= 0) gotoBeat(DECK[pi].n, beatCount(DECK[pi].n) - 1, { fromNav: true });
    }
  }

  // Emergency: skip whatever beats remain and land on the next slide's first beat.
  function nextSlideNow() {
    const nx = nextSlide(slideN);
    if (nx) gotoBeat(nx.n, 0, { fromNav: true });
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
    if (isAudience && (e.key === 'f' || e.key === 'F' || e.key === 'F8')) {
      e.preventDefault();
      toggleFullscreen();
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

  function toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    const req = root.requestFullscreen || root.webkitRequestFullscreen;
    if (req) req.call(root).catch(() => {});
  }

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

  function firstWordOfBlock(blk) {
    const i = scriptWords.findIndex(w => w.block === blk);
    return i >= 0 ? i : 0;
  }

  // Word-level marks are a voice-only reading aid; blank when voice is off.
  function paintWordHint() {
    scriptWords.forEach((w, i) => {
      const inBlock = w.block === block;
      w.el.classList.toggle('heard', voiceOn && inBlock && i < wordPos);
      w.el.classList.toggle('now', voiceOn && inBlock && i === wordPos);
    });
  }

  function scrollBlockToRead(el) {
    const box = $('pvScript');
    if (!box) return;
    if (!el) {
      if (box.scrollTo) box.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      else box.scrollTop = 0;
      return;
    }
    const br = box.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const y = box.scrollTop + (er.top - br.top) - Math.floor(box.clientHeight * 0.10);
    const top = Math.max(0, Math.round(y));
    if (box.scrollTo) box.scrollTo({ top: top, behavior: reduceMotion ? 'auto' : 'smooth' });
    else box.scrollTop = top;
  }

  function scrollToWord() {
    const box = $('pvScript');
    const w = scriptWords[wordPos];
    if (!box || !w || !w.el) return;
    const br = box.getBoundingClientRect();
    const er = w.el.getBoundingClientRect();
    const y = box.scrollTop + (er.top - br.top) - Math.floor(box.clientHeight * 0.32);
    box.scrollTop = Math.max(0, Math.round(y));
  }

  // Clicker path: highlight the whole active beat and pin its top near the read line.
  function highlightBlock() {
    const box = $('pvScript');
    if (!box) return;
    const onRows = [];
    box.querySelectorAll('.pv-row').forEach(el => {
      const b = +el.dataset.block;
      const on = b === block;
      el.classList.toggle('on', on);
      el.classList.toggle('past', b < block);
      el.classList.remove('on-first', 'on-last');
      if (on) onRows.push(el);
    });
    if (onRows.length) {
      onRows[0].classList.add('on-first');
      onRows[onRows.length - 1].classList.add('on-last');
    }
    paintSpeaker();
    paintWordHint();
    scrollBlockToRead(onRows[0] || null);
  }

  function appendSayText(el, text, blk) {
    String(text || '').split(/(\s+)/).forEach(tok => {
      if (!tok) return;
      if (/^\s+$/.test(tok)) {
        el.appendChild(document.createTextNode(tok));
        return;
      }
      const span = document.createElement('span');
      span.className = 'pv-w';
      span.dataset.block = String(blk);
      span.textContent = tok;
      span.onclick = ev => {
        ev.stopPropagation();
        gotoBeat(slideN, blk, { fromNav: true });
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
      scriptWords.push({ el: span, block: +span.dataset.block || 0, norm: norm });
    });
    if (wordPos >= scriptWords.length) wordPos = Math.max(0, scriptWords.length - 1);
  }

  function renderPresent() {
    const s = slideOf(slideN);
    const nxt = nextSlide(slideN);
    const rows = rowsFor(s.n);
    block = Math.max(0, Math.min(beatCount(s.n) - 1, block));

    const who = s.who || 'C';
    paintSpeaker();

    $('pvSlide').textContent = 'SLIDE ' + s.n + ' / ' + DECK_LEN;
    $('pvAct').textContent = s.act || '';
    const cap = $('pvCap');
    if (cap) cap.hidden = !s.capture;

    // Orientation only: mirror the audience slide. Non-interactive.
    const thumb = $('pvSlideImg');
    if (thumb) {
      const tsrc = 'slides/' + String(s.n).padStart(2, '0') + '.jpg';
      if (thumb.getAttribute('src') !== tsrc) thumb.src = tsrc;
      thumb.alt = 'Slide ' + s.n;
    }

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

    const box = $('pvScript');
    box.innerHTML = '';
    rows.forEach((row) => {
      const el = document.createElement('div');
      el.className = 'pv-row ' + row.kind;
      el.dataset.block = String(row.block);
      if (row.kind === 'say') {
        if (row.showWho) {
          const tag = document.createElement('span');
          tag.className = 'who-tag ' + row.who;
          tag.textContent = speakerName(row.who);
          el.appendChild(tag);
        }
        appendSayText(el, row.text, row.block);
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
      el.onclick = () => gotoBeat(slideN, row.block, { fromNav: true });
      box.appendChild(el);
    });
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'pv-row note';
      empty.dataset.block = '0';
      empty.textContent = 'No script on this slide.';
      box.appendChild(empty);
    }
    rebuildWords();
    wordPos = firstWordOfBlock(block);
    requestAnimationFrame(() => highlightBlock());
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

  // Return the teleprompter to the first beat of THIS slide. Audience does not move.
  function resetNotes() {
    block = 0;
    wordPos = firstWordOfBlock(0);
    lastHeard = '';
    persist();
    if (rec) {
      try { rec.abort(); } catch (e) { /* ignore */ }
      rec = null;
      if (voiceOn) startVoice();
    }
    highlightBlock();
    requestAnimationFrame(() => highlightBlock());
  }

  function audienceUrl() {
    const u = new URL(location.href);
    u.searchParams.set('mode', 'audience');
    return u.toString();
  }
  function popupBox() {
    const aw = Math.max(800, Math.floor((screen.availWidth || 1280) * 0.55));
    const ah = Math.max(520, (screen.availHeight || 800) - 40);
    const left = Math.max(0, (screen.availLeft || 0) + (screen.availWidth || 1280) - aw);
    const top = screen.availTop || 0;
    return { aw: aw, ah: ah, left: left, top: top };
  }
  function openAudiencePopup() {
    const box = popupBox();
    const feats = 'popup=yes,width=' + box.aw + ',height=' + box.ah
      + ',left=' + box.left + ',top=' + box.top
      + ',menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes';
    const w = window.open(audienceUrl(), 'house-audience', feats);
    if (w) {
      try {
        w.resizeTo(box.aw, box.ah);
        w.moveTo(box.left, box.top);
        w.focus();
      } catch (e) { /* ignore */ }
    }
    return w;
  }

  function openAudience() {
    const w = openAudiencePopup();
    const alert = $('pvAlert');
    if (!w) {
      if (alert) {
        alert.textContent = 'Popup blocked. In the address bar, allow popups for this site, then click Open Audience View again.';
        alert.classList.remove('hidden');
      }
      return;
    }
    if (alert) {
      alert.textContent = '';
      alert.classList.add('hidden');
    }
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

  // Voice reading aid: advance the word marker WITHIN the current beat only.
  // It never changes the canonical beat or slide — the clicker owns those.
  function followTranscript(text) {
    if (!voiceOn || !scriptWords.length) return;
    let lo = -1, hi = -1;
    for (let i = 0; i < scriptWords.length; i++) {
      if (scriptWords[i].block === block) { if (lo < 0) lo = i; hi = i; }
    }
    if (lo < 0) return;
    const heard = tokens(text);
    if (!heard.length) return;
    const tail = heard.slice(-16);
    let cursor = Math.max(lo, wordPos);
    let lastHit = -1;
    for (let t = 0; t < tail.length; t++) {
      const w = tail[t];
      for (let j = cursor; j <= hi; j++) {
        if (closeWord(w, scriptWords[j].norm)) { lastHit = j; cursor = j + 1; break; }
      }
    }
    if (lastHit < 0 || lastHit === wordPos) { scrollToWord(); return; }
    wordPos = Math.max(lo, Math.min(hi, lastHit));
    paintWordHint();
    scrollToWord();
  }
  function setHearCaption(text, live) {
    const wrap = $('pvHearWrap');
    const lab = $('pvHearLab');
    const cap = $('pvHear');
    if (wrap) wrap.hidden = !voiceOn;
    if (lab) lab.textContent = !voiceOn ? 'Voice off' : live ? 'Hearing you' : 'Listening…';
    if (wrap) wrap.classList.toggle('hot', !!live);
    if (cap && text) cap.textContent = '“' + text.trim() + '”';
    const vl = $('pvVoiceLab');
    if (vl) vl.classList.toggle('live', !!live);
  }

  function stopHearMeter() {
    if (hearRaf) cancelAnimationFrame(hearRaf);
    hearRaf = null;
    if (hearStream) {
      hearStream.getTracks().forEach(t => t.stop());
      hearStream = null;
    }
    if (hearCtx) {
      hearCtx.close().catch(() => {});
      hearCtx = null;
    }
    hearAnalyser = null;
    const bar = $('pvHearBar');
    if (bar) bar.style.transform = 'scaleX(0)';
  }

  function tickHearMeter() {
    if (!hearAnalyser) return;
    const data = new Uint8Array(hearAnalyser.fftSize);
    hearAnalyser.getByteTimeDomainData(data);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
    const lvl = Math.min(1, peak / 36);
    const bar = $('pvHearBar');
    if (bar) bar.style.transform = 'scaleX(' + lvl + ')';
    if (lvl > 0.1) hearLiveUntil = Date.now() + 400;
    const live = Date.now() < hearLiveUntil;
    const wrap = $('pvHearWrap');
    const lab = $('pvHearLab');
    if (wrap) wrap.classList.toggle('hot', live);
    if (lab && voiceOn) lab.textContent = live ? 'Hearing you' : 'Listening…';
    hearRaf = requestAnimationFrame(tickHearMeter);
  }

  function startHearMeter() {
    stopHearMeter();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ audio: true, video: false }).then(stream => {
      if (!voiceOn) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      hearStream = stream;
      hearCtx = new (window.AudioContext || window.webkitAudioContext)();
      hearAnalyser = hearCtx.createAnalyser();
      hearAnalyser.fftSize = 512;
      hearCtx.createMediaStreamSource(stream).connect(hearAnalyser);
      tickHearMeter();
    }).catch(() => {
      setHearCaption('', false);
    });
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
    wordPos = firstWordOfBlock(block);
    const app = $('presentApp');
    if (app) app.classList.add('pv-follow');
    setHearCaption('', false);
    startHearMeter();
    paintWordHint();
    requestAnimationFrame(scrollToWord);
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
      const shown = (interim || lastHeard).trim().split(' ').slice(-12).join(' ');
      hearLiveUntil = Date.now() + 800;
      setHearCaption(shown, true);
      followTranscript(lastHeard + ' ' + interim);
    };
    rec.onerror = () => { /* stay on current line; slides never move */ };
    rec.onend = () => { if (voiceOn) { try { rec.start(); } catch (e) { /* ignore */ } } };
    try { rec.start(); }
    catch (e) {
      voiceOn = false;
      $('pvVoice').checked = false;
      $('pvVoiceLab').classList.remove('on');
      stopHearMeter();
      setHearCaption('', false);
    }
  }
  function stopVoice() {
    if (!rec) return;
    const r = rec;
    rec = null;
    try { r.onend = null; r.abort(); } catch (e) { /* ignore */ }
    stopHearMeter();
    const app = $('presentApp');
    if (app) app.classList.remove('pv-follow');
    const wrap = $('pvHearWrap');
    if (wrap) wrap.hidden = true;
    const vl = $('pvVoiceLab');
    if (vl) vl.classList.remove('live');
  }

  if (isPresent) {
    restore();
    // If the talk clock is already running (mid-talk refresh), don't re-show the setup hint.
    if (clockStart) { const st = $('pvSetup'); if (st) st.hidden = true; }
    $('pvBack').onclick = () => nav('prev');
    $('pvNext').onclick = () => nav('next');
    $('pvReset').onclick = resetNotes;
    const nsb = $('pvNextSlide'); if (nsb) nsb.onclick = nextSlideNow;
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
      else { stopVoice(); highlightBlock(); }
    };
    setInterval(tickClock, 1000);
    renderPresent();
    warmSlides();
    broadcastState();
    window.addEventListener('pageshow', () => broadcastState({ force: true }));
    window.addEventListener('beforeunload', e => {
      e.preventDefault();
      e.returnValue = '';
    });
  } else {
    try { if (sessionStorage.getItem(STORE)) restore(); } catch (e) { /* ignore */ }
    renderAudience();
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
    const fullBtn = $('audFull');
    if (fullBtn) fullBtn.onclick = () => toggleFullscreen();
    const wrap = document.querySelector('.aud-wrap');
    if (wrap) wrap.addEventListener('dblclick', () => toggleFullscreen());
    let allowClose = false;
    function leaveAudience() {
      allowClose = true;
      const u = new URL(location.href);
      u.searchParams.set('mode', 'present');
      if (window.opener && !window.opener.closed) {
        try { window.opener.focus(); } catch (e) { /* ignore */ }
        window.close();
        setTimeout(() => { if (!window.closed) location.href = u.toString(); }, 200);
        return;
      }
      location.href = u.toString();
    }
    const backBtn = $('audBack');
    if (backBtn) backBtn.onclick = leaveAudience;
    const popBtn = $('audPop');
    if (window.opener && !window.opener.closed) {
      if (popBtn) popBtn.hidden = true;
    } else if (popBtn) {
      popBtn.onclick = () => {
        const w = openAudiencePopup();
        if (!w) {
          popBtn.textContent = 'Allow popups, then click again';
          return;
        }
        allowClose = true;
        const u = new URL(location.href);
        u.searchParams.set('mode', 'present');
        location.href = u.toString();
      };
    }
    window.addEventListener('beforeunload', e => {
      if (allowClose) return;
      e.preventDefault();
      e.returnValue = '';
    });
    let hideCursor = null;
    const idle = () => {
      if (document.fullscreenElement) document.documentElement.classList.add('aud-idle');
    };
    document.addEventListener('mousemove', () => {
      document.documentElement.classList.remove('aud-idle');
      clearTimeout(hideCursor);
      hideCursor = setTimeout(idle, 2000);
    });
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) document.documentElement.classList.remove('aud-idle');
    });
  }
})();
