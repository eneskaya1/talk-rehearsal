'use strict';

/* =========================================================================
   rehearsal.js — full-screen dress rehearsal.
   Shows each slide (the real page image for PDF imports, otherwise a text
   slide), listens continuously, and records time + recall per slide.
   Slide images live in IndexedDB (too large for localStorage).
   ========================================================================= */

/* ----------------------------- image store ----------------------------- */

const IMG_DB = 'talk-rehearsal-images';
function imgDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IMG_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('decks');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveImages(deckId, blobs) {
  try {
    const db = await imgDb();
    await new Promise((res, rej) => {
      const tx = db.transaction('decks', 'readwrite');
      tx.objectStore('decks').put(blobs, deckId);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch { /* storage unavailable: rehearsal falls back to text slides */ }
}
async function loadImages(deckId) {
  try {
    const db = await imgDb();
    return await new Promise((res) => {
      const req = db.transaction('decks').objectStore('decks').get(deckId);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    });
  } catch { return null; }
}
async function deleteImages(deckId) {
  try {
    const db = await imgDb();
    db.transaction('decks', 'readwrite').objectStore('decks').delete(deckId);
  } catch { /* ignore */ }
}

/* ------------------------------ rehearsal ------------------------------ */

let rehTimer = null;

async function openRehearsal(deckId) {
  abortListening();
  stopSpeaking();
  const deck = deckById(deckId);
  if (!deck) return;
  const blobs = await loadImages(deckId);
  if (ui.reh?.urls) ui.reh.urls.forEach((u) => u && URL.revokeObjectURL(u));
  ui.reh = {
    deckId, phase: 'intro', idx: 0, hints: false,
    urls: blobs ? blobs.map((b) => (b ? URL.createObjectURL(b) : null)) : [],
    times: [], segs: [], listener: null, lastLen: 0, micError: null,
  };
  ui.view = 'rehearse';
  ui.deckId = deckId;
  render();
}

function rehDeck() { return deckById(ui.reh?.deckId); }

function startRehearsal() {
  const r = ui.reh;
  const deck = rehDeck();
  const n = getSlides(deck).length;
  Object.assign(r, { phase: 'live', idx: 0, times: new Array(n).fill(0), segs: new Array(n).fill(''), lastLen: 0, started: Date.now(), slideStart: Date.now() });
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
  if (SR && !ui.typed) {
    r.listener = new Listener(deck.lang, {
      onUpdate: () => {},
      onFatal: (err) => { r.micError = err; r.listener = null; render(); },
    });
    r.listener.start();
  }
  clearInterval(rehTimer);
  rehTimer = setInterval(updateRehHud, 250);
  render();
}

// Close the current slide's segment: add its time and the words said on it.
function closeSegment() {
  const r = ui.reh;
  const now = Date.now();
  r.times[r.idx] += (now - r.slideStart) / 1000;
  r.slideStart = now;
  if (r.listener) {
    const text = r.listener.text();
    r.segs[r.idx] += ' ' + text.slice(r.lastLen);
    r.lastLen = text.length;
  }
}

function rehGo(delta) {
  const r = ui.reh;
  if (!r || r.phase !== 'live') return;
  const n = getSlides(rehDeck()).length;
  const to = r.idx + delta;
  if (to < 0) return;
  closeSegment();
  if (to >= n) { finishRehearsal(); return; }
  r.idx = to;
  render();
}

async function finishRehearsal() {
  const r = ui.reh;
  if (!r || r.phase !== 'live') return;
  closeSegment();
  clearInterval(rehTimer);
  if (r.listener) {
    const full = await r.listener.stop();
    // Words recognised after the last slide change belong to the last slide.
    if (full.length > r.lastLen) r.segs[r.idx] += ' ' + full.slice(r.lastLen);
    r.listener = null;
  }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  const deck = rehDeck();
  const slides = getSlides(deck);
  const listened = SR && !ui.typed && !r.micError;
  const rows = slides.map((s, i) => {
    const text = s.sentences.join(' ');
    const g = listened ? grade(text, r.segs[i], deck.lang) : null;
    return { title: s.title, time: Math.round(r.times[i]), target: s.target, coverage: g ? g.score : null, got: g?.got || 0, total: g?.total || 0 };
  });
  const duration = rows.reduce((a, b) => a + b.time, 0);
  const target = rows.reduce((a, b) => a + b.target, 0);
  const allSaid = r.segs.join(' ');
  const script = slides.map((s) => s.sentences.join(' ')).join(' ');
  const st = listened ? deliveryStats(allSaid, script, duration, deck.lang) : null;
  const totalWords = rows.reduce((a, b) => a + b.total, 0);
  const session = {
    at: Date.now(), duration, target,
    coverage: listened && totalWords ? Math.round((rows.reduce((a, b) => a + b.got, 0) / totalWords) * 100) : null,
    wpm: st?.wpm ?? null, fillers: st ? st.fillers.total : null,
    slides: rows.map(({ time, target, coverage }) => ({ time, target, coverage })),
  };
  recordRehearsal(deck, session);
  deck.updated = Date.now();
  saveData();
  Object.assign(r, { phase: 'report', rows, session, stats: st });
  render();
}

function exitRehearsal() {
  const r = ui.reh;
  clearInterval(rehTimer);
  if (r?.listener) { r.listener.active = false; try { r.listener.rec.abort(); } catch { /* ignore */ } }
  if (r?.urls) r.urls.forEach((u) => u && URL.revokeObjectURL(u));
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const id = r?.deckId;
  ui.reh = null;
  ui.view = id ? 'progress' : 'home';
  render();
}

function updateRehHud() {
  const r = ui.reh;
  if (!r || r.phase !== 'live') return;
  const deck = rehDeck();
  const slide = getSlides(deck)[r.idx];
  const slideSec = r.times[r.idx] + (Date.now() - r.slideStart) / 1000;
  const total = (Date.now() - r.started) / 1000;
  const a = document.getElementById('rehSlideT');
  const b = document.getElementById('rehTotalT');
  if (a) { a.textContent = fmt(slideSec); a.classList.toggle('over', slideSec > slide.target * 1.15); }
  if (b) b.textContent = fmt(total);
}

function renderRehearsal() {
  const r = ui.reh;
  const deck = rehDeck();
  if (!r || !deck) return '';
  const slides = getSlides(deck);
  const target = slides.reduce((n, s) => n + s.target, 0);

  if (r.phase === 'intro') {
    return `<div class="card reh-intro">
      <h1>🎤 Dress rehearsal</h1>
      <p>Give the whole talk as if the audience were in front of you: ${slides.length} slides, target <b>${fmt(target)}</b>.
        ${SR && !ui.typed ? 'The app listens the whole time and afterwards shows, per slide, your time and how much of the script you said.' : 'Speech recognition is off, so only your timing per slide is recorded.'}</p>
      <ul class="small muted">
        <li><span class="kbd">→</span> / <span class="kbd">Space</span> / clicker: next slide · <span class="kbd">←</span>: previous</li>
        <li><span class="kbd">H</span>: show or hide hint words · <span class="kbd">Esc</span> leaves full screen</li>
        <li>${r.urls.some(Boolean) ? 'Your real slides are shown.' : 'Slides are shown as text (real slide images are available for PDF imports).'}</li>
      </ul>
      <div class="row" style="margin-top:16px">
        <button class="btn primary" data-act="reh-start">Start rehearsal</button>
        <button class="btn" data-act="reh-exit">Cancel</button>
      </div>
    </div>`;
  }

  if (r.phase === 'live') {
    const slide = slides[r.idx];
    const visual = deck.visuals?.[r.idx];
    const img = r.urls[r.idx];
    const content = img
      ? `<img class="reh-img" src="${img}" alt="Slide ${r.idx + 1}">`
      : `<div class="reh-text"><h2>${esc(visual?.title || slide.title)}</h2>
          ${visual?.text?.length ? `<ul>${visual.text.slice(0, 8).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>`;
    return `<div class="reh-live">
      <div class="reh-stage" data-act="reh-next">${content}</div>
      ${r.hints ? `<div class="reh-hints">${slide.sentences.map((s) => `<span>${esc(s.split(/\s+/).slice(0, 3).join(' '))} …</span>`).join('')}</div>` : ''}
      <div class="reh-hud">
        <button class="btn small ghost" data-act="reh-prev" aria-label="Previous slide">◀</button>
        <span>${r.idx + 1} / ${slides.length}</span>
        <span>Slide <b id="rehSlideT">0:00</b> / ${fmt(slide.target)}</span>
        <span>Total <b id="rehTotalT">0:00</b> / ${fmt(target)}</span>
        <span class="${r.listener ? 'rec-on' : 'muted'}">${r.listener ? '● listening' : r.micError ? 'mic off' : 'timing only'}</span>
        <span class="spacer"></span>
        <button class="btn small ghost" data-act="reh-hints">${r.hints ? 'Hide hints' : 'Hints'}</button>
        <button class="btn small" data-act="reh-finish">Finish</button>
        <button class="btn small primary" data-act="reh-next" aria-label="Next slide">▶</button>
      </div>
    </div>`;
  }

  // Report
  const s = r.session;
  const timeOk = Math.abs(s.duration - s.target) <= s.target * 0.1;
  return `<div class="reh-report">
    <h1>Rehearsal report</h1>
    <div class="tiles">
      <div class="tile card"><span class="tile-v">${fmt(s.duration)}</span><span class="tile-l">${timeOk ? '✓ on time' : s.duration > s.target ? '⚠ over' : '⚠ under'} · target ${fmt(s.target)}</span></div>
      <div class="tile card"><span class="tile-v">${s.coverage != null ? s.coverage + '%' : '—'}</span><span class="tile-l">of the script recalled</span></div>
      <div class="tile card"><span class="tile-v">${s.wpm != null ? s.wpm : '—'}</span><span class="tile-l">words per minute</span></div>
      <div class="tile card"><span class="tile-v">${s.fillers != null ? s.fillers : '—'}</span><span class="tile-l">filler words</span></div>
    </div>
    ${r.stats ? renderDelivery(r.stats, deck.lang) : ''}
    <section class="card" style="margin-top:16px">
      <h2>Time per slide <span class="muted small">(bar = your time, tick = target)</span></h2>
      ${slideTimeBars(r.rows)}
    </section>
    <section class="card" style="margin-top:16px">
      <h2>Per slide</h2>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Slide</th><th>Time / target</th><th>Recalled</th><th></th></tr></thead>
        <tbody>${r.rows.map((row, i) => `<tr>
          <td>${i + 1}. ${esc(row.title)}</td>
          <td>${fmt(row.time)} / ${fmt(row.target)}</td>
          <td class="${row.coverage == null ? '' : row.coverage >= thr() ? 'ok' : 'no'}">${row.coverage != null ? row.coverage + '%' : '—'}</td>
          <td>${row.coverage != null && row.coverage < thr() ? `<button class="btn small ghost" data-act="slide-go" data-id="${deck.id}" data-i="${i}">Practise</button>` : ''}</td>
        </tr>`).join('')}</tbody></table></div>
    </section>
    <div class="row" style="margin-top:16px">
      <button class="btn primary" data-act="reh-again">Rehearse again</button>
      <button class="btn" data-act="reh-exit">See progress</button>
    </div>
  </div>`;
}

document.addEventListener('keydown', (e) => {
  if (ui.view !== 'rehearse' || ui.reh?.phase !== 'live') return;
  if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); rehGo(1); }
  else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); rehGo(-1); }
  else if (e.key === 'h' || e.key === 'H') { ui.reh.hints = !ui.reh.hints; render(); }
});
