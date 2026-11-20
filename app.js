'use strict';

/* =========================================================================
   Talk Rehearsal — practise a presentation sentence by sentence:
   listen → hide → say it aloud → see which words you missed → recite the
   whole slide from hint words against its target time.
   ========================================================================= */

const STORE_KEY = 'talk-rehearsal.v1';
const WPM = 130; // speaking pace used to estimate slide time when none is given
const MAX_CHUNK_WORDS = 28; // longer sentences are split at commas/semicolons

const LANGS = [
  ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['tr-TR', 'Türkçe'],
  ['de-DE', 'Deutsch'], ['fr-FR', 'Français'], ['es-ES', 'Español'],
  ['it-IT', 'Italiano'], ['pt-BR', 'Português (BR)'], ['nl-NL', 'Nederlands'],
  ['pl-PL', 'Polski'], ['ru-RU', 'Русский'], ['ar-SA', 'العربية'],
];

const SR = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const HAS_TTS = 'speechSynthesis' in window;

/* ---------------------------- utilities -------------------------------- */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const fmt = (sec) => {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const wordCount = (s) => (s.match(/\S+/g) || []).length;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------------------- storage ---------------------------------- */

const defaultData = () => ({
  decks: [],
  settings: { threshold: 80, rate: 1, hintLetters: false, apiKey: '' },
  importDraft: null,
});

function loadData() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultData();
    const d = JSON.parse(raw);
    return { ...defaultData(), ...d, settings: { ...defaultData().settings, ...(d.settings || {}) } };
  } catch {
    return defaultData();
  }
}
function saveData() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); }
  catch { /* private mode / storage full: app keeps working in memory */ }
}

let data = loadData();

/* ---------------------------- script parsing --------------------------- */

function parseHeading(text) {
  // "Slide title | 0:45"  or  "Slide title [0:45]"  or  "Slide title (45s)"
  let m = text.match(/^(.*?)\s*(?:\||\[|\()\s*(\d{1,2}):(\d{2})\s*[\])]?\s*$/);
  if (m) return { title: m[1].trim(), target: +m[2] * 60 + +m[3] };
  m = text.match(/^(.*?)\s*(?:\||\[|\()\s*(\d{1,4})\s*s(?:ec)?\s*[\])]?\s*$/i);
  if (m) return { title: m[1].trim(), target: +m[2] };
  return { title: text.trim(), target: null };
}

const ABBREV = /(?:^|\s)(?:Dr|Mr|Mrs|Ms|Prof|Doç|Sn|St|Jr|Sr|vs|etc|vb|Fig|No|Nr|Inc|Ltd|Co|e\.g|i\.e|z\.B|bzw)\.$/i;

function chunkLongSentence(sentence) {
  if (wordCount(sentence) <= MAX_CHUNK_WORDS) return [sentence];
  const parts = sentence.split(/(?<=[,;:–—])\s+/);
  const out = [];
  let cur = '';
  for (const p of parts) {
    if (cur && wordCount(cur) + wordCount(p) > MAX_CHUNK_WORDS) { out.push(cur); cur = p; }
    else cur = cur ? `${cur} ${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

function splitSentences(body) {
  const out = [];
  for (let line of body.split('\n')) {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim(); // strip bullet markers
    if (!line) continue;
    const pieces = line.split(/(?<=[.!?…]["'”’)\]]?)\s+(?=["“'(\p{Lu}\p{N}])/u);
    // Re-join splits that happened after an abbreviation such as "Dr." or "e.g."
    const parts = [];
    for (const p of pieces) {
      const prev = parts[parts.length - 1];
      if (prev && ABBREV.test(prev)) parts[parts.length - 1] = `${prev} ${p}`;
      else parts.push(p);
    }
    for (const p of parts) if (p.trim()) out.push(...chunkLongSentence(p.trim()));
  }
  return out;
}

function parseScript(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const hasHeadings = lines.some((l) => /^#{2,3}\s+\S/.test(l));
  let deckTitle = null;
  const raw = [];

  if (hasHeadings) {
    let cur = null;
    for (const l of lines) {
      const h = l.match(/^#{2,3}\s+(.*)$/);
      const t = l.match(/^#\s+(.*)$/);
      if (h) { if (cur) raw.push(cur); cur = { ...parseHeading(h[1]), body: '' }; }
      else if (t && !cur) deckTitle = t[1].trim();
      else { if (!cur) cur = { title: 'Introduction', target: null, body: '' }; cur.body += l + '\n'; }
    }
    if (cur) raw.push(cur);
  } else {
    // No headings: every paragraph (blank-line separated) becomes a slide.
    String(src || '').replace(/\r/g, '').split(/\n\s*\n/).forEach((b) => {
      const t = b.match(/^#\s+(.*)$/m);
      if (t && !raw.length) { deckTitle = t[1].trim(); b = b.replace(/^#\s+.*$/m, ''); }
      if (b.trim()) raw.push({ title: null, target: null, body: b });
    });
  }

  const slides = raw
    .map((s) => ({ ...s, sentences: splitSentences(s.body) }))
    .filter((s) => s.sentences.length)
    .map((s, i) => {
      const words = s.sentences.reduce((n, x) => n + wordCount(x), 0);
      return {
        title: s.title || `Slide ${i + 1}`,
        target: s.target ?? Math.max(10, Math.round((words / WPM) * 60)),
        estimated: s.target == null,
        sentences: s.sentences,
        words,
      };
    });
  return { deckTitle, slides };
}

const slidesCache = new Map();
function getSlides(deck) {
  const c = slidesCache.get(deck.id);
  if (c && c.script === deck.script) return c.slides;
  const slides = parseScript(deck.script).slides;
  slidesCache.set(deck.id, { script: deck.script, slides });
  return slides;
}

/* ---------------------------- word matching ---------------------------- */

// Recognisers often write numbers as digits ("7") while scripts spell them out
// ("seven"), or the other way round. Map common number words to digits.
const NUMBER_WORDS = {
  en: 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty',
  tr: 'sıfır bir iki üç dört beş altı yedi sekiz dokuz on',
  de: 'null eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf',
  fr: 'zéro un deux trois quatre cinq six sept huit neuf dix onze douze',
  es: 'cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce',
};
const TENS = {
  en: { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000 },
  tr: { 'yirmi': 20, 'otuz': 30, 'kırk': 40, 'elli': 50, 'altmış': 60, 'yetmiş': 70, 'seksen': 80, 'doksan': 90, 'yüz': 100, 'bin': 1000 },
};
const numberMaps = {};
function numberMap(lang) {
  const k = lang.slice(0, 2);
  if (!numberMaps[k]) {
    const m = {};
    (NUMBER_WORDS[k] || '').split(' ').filter(Boolean).forEach((w, i) => { m[w] = String(i); });
    Object.entries(TENS[k] || {}).forEach(([w, n]) => { m[w] = String(n); });
    numberMaps[k] = m;
  }
  return numberMaps[k];
}

const norm = (w, lang) => {
  const n = w.toLocaleLowerCase(lang).normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');
  return numberMap(lang)[n] ?? n;
};

function tokenize(text, lang) {
  return text.split(/\s+/).filter(Boolean).map((raw) => ({ raw, n: norm(raw, lang) }));
}

function lev(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Lenient match: speech recognisers often get suffixes or a letter wrong.
function similar(a, b) {
  if (a === b) return true;
  const L = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) < 3) return false;
  return 1 - lev(a, b) / L >= 0.75;
}

// Longest-common-subsequence alignment: which expected words were spoken, in order.
function alignWords(expected, spoken) {
  const n = expected.length, m = spoken.length;
  const sim = expected.map((e) => spoken.map((s) => similar(e, s)));
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = sim[i][j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hit = new Array(n).fill(false);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (sim[i][j] && dp[i][j] === dp[i + 1][j + 1] + 1) { hit[i] = true; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return hit;
}

function grade(expectedText, spokenText, lang) {
  const exp = tokenize(expectedText, lang);
  const countable = exp.filter((t) => t.n);
  const spoken = tokenize(spokenText, lang).map((t) => t.n).filter(Boolean);
  const hits = alignWords(countable.map((t) => t.n), spoken);
  let k = 0;
  const tokens = exp.map((t) => (t.n ? { ...t, hit: hits[k++] } : { ...t, hit: null }));
  const got = hits.filter(Boolean).length;
  return { tokens, score: countable.length ? Math.round((got / countable.length) * 100) : 0, got, total: countable.length };
}

/* ---------------------------- speech ----------------------------------- */

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  const l = lang.toLowerCase();
  return voices.find((v) => v.lang.replace('_', '-').toLowerCase() === l)
      || voices.find((v) => v.lang.toLowerCase().startsWith(l.slice(0, 2)));
}
if (HAS_TTS) speechSynthesis.onvoiceschanged = () => {}; // warm up voice list

function speak(sentences, lang) {
  if (!HAS_TTS) { toast('Text-to-speech is not available in this browser.'); return; }
  speechSynthesis.cancel();
  const voice = pickVoice(lang);
  if (!voice) toast(`No ${lang} voice installed — using the default voice.`);
  // One utterance per sentence avoids Chrome cutting off long utterances.
  for (const s of sentences) {
    const u = new SpeechSynthesisUtterance(s);
    u.lang = lang;
    u.rate = data.settings.rate;
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }
}
const stopSpeaking = () => HAS_TTS && speechSynthesis.cancel();

class Listener {
  constructor(lang, { onUpdate, onFatal }) {
    this.lang = lang; this.onUpdate = onUpdate; this.onFatal = onFatal;
    this.final = ''; this.interim = ''; this.active = false; this.rec = null; this.done = null;
  }
  text() { return (this.final + ' ' + this.interim).replace(/\s+/g, ' ').trim(); }
  start() { this.active = true; this.spawn(); }
  spawn() {
    const r = new SR();
    r.lang = this.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) this.final += ' ' + t; else interim += ' ' + t;
      }
      this.interim = interim;
      this.onUpdate(this.text());
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) {
        this.active = false;
        this.onFatal(e.error);
      }
    };
    r.onend = () => {
      if (this.interim) { this.final += ' ' + this.interim; this.interim = ''; }
      if (this.active) { try { this.spawn(); } catch { this.active = false; } } // browser stops after silence: resume
      else if (this.done) this.done();
    };
    this.rec = r;
    try { r.start(); } catch (err) { this.active = false; this.onFatal(String(err.message || err)); }
  }
  stop() {
    this.active = false;
    return new Promise((resolve) => {
      let settled = false;
      this.done = () => { if (!settled) { settled = true; resolve(this.text()); } };
      try { this.rec && this.rec.stop(); } catch { this.done(); }
      setTimeout(() => this.done(), 1500); // safety net if onend never fires
    });
  }
}

const MIC_ERRORS = {
  'not-allowed': 'Microphone access was blocked. Allow it in the address bar, or switch to typing.',
  'service-not-allowed': 'Speech recognition is blocked here. Open the app from http://localhost or https, or switch to typing.',
  'audio-capture': 'No microphone was found.',
  'language-not-supported': 'This browser cannot recognise that language. Switch to typing.',
};

/* ---------------------------- state ------------------------------------ */

const ui = {
  view: 'home', // home | edit | practice
  editId: null,
  deckId: null,
  slide: 0,
  step: 0, // sentence index, 'full' or 'done'
  phase: 'learn', // learn | recite | result
  typed: !SR,
  listening: false,
  listener: null,
  live: '',
  result: null,
  startedAt: 0,
  elapsed: 0,
  micError: null,
};
let timerHandle = null;

const deckById = (id) => data.decks.find((d) => d.id === id);
const curDeck = () => deckById(ui.deckId);
const thr = () => data.settings.threshold;

const sentenceKey = (text) => 's:' + text;
const slideKey = (slide) => 'f:' + slide.sentences.join(' ');

function bestOf(deck, key) { return deck.progress?.[key]?.best ?? null; }

function slideStatus(deck, slide) {
  const fullBest = slide.sentences.length > 1 ? bestOf(deck, slideKey(slide)) : bestOf(deck, sentenceKey(slide.sentences[0]));
  if (fullBest != null && fullBest >= thr()) return 'done';
  const any = slide.sentences.some((s) => bestOf(deck, sentenceKey(s)) != null);
  return any ? 'part' : 'none';
}

function deckProgress(deck) {
  const slides = getSlides(deck);
  const done = slides.filter((s) => slideStatus(deck, s) === 'done').length;
  return { done, total: slides.length };
}

/* ---------------------------- rendering -------------------------------- */

function render() {
  const app = $('#app');
  const top = $('#topRight');
  top.innerHTML = '';
  if (ui.view === 'home') app.innerHTML = renderHome();
  else if (ui.view === 'edit') { app.innerHTML = renderEditor(); updatePreview(); }
  else if (ui.view === 'import') app.innerHTML = renderImport();
  else if (ui.view === 'practice') {
    const deck = curDeck();
    if (!deck) { ui.view = 'home'; return render(); }
    top.innerHTML = `<span class="muted small">${SR ? '' : 'Typing mode'}</span>`;
    app.innerHTML = renderPractice(deck);
  } else if (ui.view === 'progress') {
    const deck = curDeck();
    if (!deck) { ui.view = 'home'; return render(); }
    app.innerHTML = renderProgress(deck);
  } else if (ui.view === 'rehearse') {
    app.innerHTML = renderRehearsal();
  }
  document.body.classList.toggle('reh-mode', ui.view === 'rehearse' && ui.reh?.phase === 'live');
  if (installPrompt && ui.view !== 'rehearse') top.insertAdjacentHTML('beforeend', '<button class="btn small" data-act="install">⤓ Install app</button>');
}

function renderHome() {
  const decks = [...data.decks].sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const list = decks.length ? decks.map((d) => {
    const { done, total } = deckProgress(d);
    const pct = total ? Math.round((done / total) * 100) : 0;
    const lang = LANGS.find((l) => l[0] === d.lang)?.[1] || d.lang;
    const due = dueItems(d).length;
    return `<article class="card deck">
      <div class="info">
        <h3>${esc(d.title)}</h3>
        <div class="muted small">${esc(lang)} · ${done} / ${total} slides mastered${due ? ` · <span class="warnc">${due} due for review</span>` : ''}</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        ${renderPlan(d, true)}
      </div>
      <div class="row">
        <button class="btn primary" data-act="practice" data-id="${d.id}">Practise</button>
        ${due ? `<button class="btn" data-act="review" data-id="${d.id}">Review (${due})</button>` : ''}
        <button class="btn" data-act="rehearse" data-id="${d.id}">🎤 Rehearse</button>
        <button class="btn" data-act="progress" data-id="${d.id}">Progress</button>
        <button class="btn ghost small" data-act="edit" data-id="${d.id}">Edit</button>
        <button class="btn ghost small" data-act="export" data-id="${d.id}" title="Download as JSON">Export</button>
        <button class="btn ghost small danger" data-act="delete" data-id="${d.id}">Delete</button>
      </div>
    </article>`;
  }).join('') : `<div class="card empty">
      <p>No presentations yet.</p>
      <p class="small">Paste your speaker script, or load the sample to see how it works.</p>
    </div>`;

  const s = data.settings;
  return `
    <section class="hero">
      <div>
        <h1>Rehearse your talk until you can give it without notes.</h1>
        <p>Paste your script. For each sentence: listen, hide the text, say it aloud, and see which words you missed.
           Then recite the whole slide from hint words, timed against your target.</p>
        <div class="row">
          <button class="btn primary" data-act="import">Import slides (.pptx / .pdf)</button>
          <button class="btn" data-act="new">Paste a script</button>
          <button class="btn" data-act="sample">Load sample</button>
          <label class="btn">Import JSON<input type="file" id="importFile" accept=".json,application/json" hidden></label>
        </div>
      </div>
      <figure class="hero-card" aria-label="Example: a recited sentence with said, missed and hidden words" style="margin:0">
        <div class="passage" aria-hidden="true"><span class="w hit">Last</span> <span class="w hit">quarter</span> <span class="w hit">we</span> <span class="w miss">halved</span> <span class="w hit">the</span> <span class="w hit">time</span> <span class="w hit">it</span> <span class="w hit">takes</span> <span class="w hit">to</span> <span class="mask" style="width:2.6em"></span> <span class="mask" style="width:1.4em"></span> <span class="mask" style="width:3.4em"></span></div>
        <figcaption class="hero-legend">
          <span><i style="background:color-mix(in srgb, var(--good) 35%, transparent)"></i>said</span>
          <span><i style="background:var(--bad)"></i>missed</span>
          <span><i style="background:var(--mask)"></i>still hidden</span>
        </figcaption>
      </figure>
    </section>
    <div class="home-grid">
      <section>
        <h2>Your presentations</h2>
        <div class="deck-list">${list}</div>
      </section>
      <aside class="card">
        <h2>Settings</h2>
        <label class="field"><span>Pass mark: <b id="thrVal">${s.threshold}%</b> of words</span>
          <input type="range" min="50" max="100" step="5" value="${s.threshold}" data-setting="threshold"></label>
        <label class="field"><span>Voice speed: <b id="rateVal">${s.rate.toFixed(2)}×</b></span>
          <input type="range" min="0.6" max="1.4" step="0.05" value="${s.rate}" data-setting="rate"></label>
        <label class="field"><span>Claude API key <span class="muted small">(for AI-written scripts)</span></span>
          <input type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(s.apiKey || '')}" data-setting="apiKey"></label>
        <p class="muted small" style="margin-top:-8px">Stored only in this browser and sent only to the Claude API. Get one at console.anthropic.com.</p>
        <h2 style="margin-top:8px">This browser</h2>
        <ul class="support">
          <li class="${SR ? 'ok' : 'no'}">${SR ? '✓ Speech recognition' : '✗ No speech recognition — you can type instead (use Chrome or Edge to speak)'}</li>
          <li class="${HAS_TTS ? 'ok' : 'no'}">${HAS_TTS ? '✓ Text-to-speech' : '✗ No text-to-speech'}</li>
          ${location.protocol === 'file:' ? '<li class="no">⚠ Opened as a file — the microphone may be blocked. Serve it from localhost (see README).</li>' : ''}
        </ul>
        <p class="muted small" style="margin-top:12px">Progress is stored in this browser only. Export a presentation to back it up or move it to another device.</p>
      </aside>
    </div>`;
}

function renderEditor() {
  const deck = ui.editId ? deckById(ui.editId) : null;
  const lang = deck?.lang || (navigator.language && LANGS.find((l) => l[0].startsWith(navigator.language.slice(0, 2)))?.[0]) || 'en-US';
  return `
    <h1>${deck ? 'Edit presentation' : 'New presentation'}</h1>
    <div class="editor">
      <section>
        <div class="editor-meta">
          <label class="field"><span>Title</span>
            <input type="text" id="fTitle" value="${esc(deck?.title || '')}" placeholder="e.g. Thesis defence"></label>
          <label class="field"><span>Language</span>
            <select id="fLang">${LANGS.map(([v, n]) => `<option value="${v}" ${v === lang ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        </div>
        <label class="field"><span>Speaker script</span>
          <textarea id="fScript" rows="20" spellcheck="true" placeholder="## Opening | 0:40&#10;Good morning everyone. Today I want to show you…&#10;&#10;## The problem | 1:00&#10;…">${esc(deck?.script || '')}</textarea></label>
        <div class="row">
          <button class="btn primary" data-act="save">Save</button>
          <button class="btn" data-act="home">Cancel</button>
        </div>
      </section>
      <aside class="card">
        <details class="help" open>
          <summary>Script format</summary>
          <p>Start each slide with <code>##</code> and its title. Add a target time after <code>|</code> (optional — otherwise it is estimated at ${WPM} words per minute).</p>
          <pre># My talk
## Opening | 0:40
Good morning. Today I will…

## Results | 1:15
- Each bullet or sentence
- becomes a practice step.</pre>
          <p class="muted">No <code>##</code> headings? Each paragraph becomes a slide. Very long sentences are split at commas.</p>
        </details>
        <h2 style="margin-top:16px">Preview</h2>
        <div id="preview" class="muted small"></div>
      </aside>
    </div>`;
}

function updatePreview() {
  const box = $('#preview');
  if (!box) return;
  const { deckTitle, slides } = parseScript($('#fScript').value);
  if (deckTitle && !$('#fTitle').value) $('#fTitle').placeholder = deckTitle;
  if (!slides.length) { box.innerHTML = 'Nothing to practise yet.'; return; }
  const total = slides.reduce((n, s) => n + s.target, 0);
  const sentences = slides.reduce((n, s) => n + s.sentences.length, 0);
  box.innerHTML = `<p><b>${slides.length}</b> slides · <b>${sentences}</b> steps · about <b>${fmt(total)}</b></p>
    <ol class="preview-list">${slides.map((s) => `<li><span>${esc(s.title)}</span>
      <span>${s.sentences.length} · ${fmt(s.target)}${s.estimated ? '*' : ''}</span></li>`).join('')}</ol>
    ${slides.some((s) => s.estimated) ? '<p class="small" style="margin-top:8px">* estimated time</p>' : ''}`;
}

function stepState(deck, slide, step) {
  const key = step === 'full' ? slideKey(slide) : sentenceKey(slide.sentences[step]);
  const b = bestOf(deck, key);
  return b == null ? '' : b >= thr() ? 'passed' : 'tried';
}

function renderPractice(deck) {
  const slides = getSlides(deck);
  if (!slides.length) return `<div class="card empty"><p>This presentation has no text to practise.</p>
    <button class="btn primary" data-act="edit" data-id="${deck.id}">Edit script</button></div>`;
  if (ui.slide >= slides.length) ui.slide = slides.length - 1;
  const { done, total } = deckProgress(deck);

  const side = `<aside class="card sidebar">
    <h2>${esc(deck.title)}</h2>
    <div class="muted small">${done} / ${total} slides mastered</div>
    <div class="bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
    <div class="side-actions">
      <button class="btn small" data-act="review" data-id="${deck.id}" ${dueItems(deck).length ? '' : 'disabled'}>Review (${dueItems(deck).length})</button>
      <button class="btn small" data-act="rehearse" data-id="${deck.id}">🎤 Rehearse</button>
      <button class="btn small ghost" data-act="progress" data-id="${deck.id}">Progress</button>
    </div>
    <ol class="slide-list">${slides.map((s, i) => {
      const st = slideStatus(deck, s);
      const icon = st === 'done' ? '✓' : st === 'part' ? '◐' : '○';
      const best = s.sentences.length > 1 ? bestOf(deck, slideKey(s)) : bestOf(deck, sentenceKey(s.sentences[0]));
      return `<li><button class="${i === ui.slide && ui.step !== 'done' ? 'active' : ''}" data-act="slide" data-i="${i}">
        <span class="st ${st}">${icon}</span><span class="t">${i + 1}. ${esc(s.title)}</span>
        <span class="sc">${best != null ? best + '%' : ''}</span></button></li>`;
    }).join('')}</ol>
  </aside>`;

  return `<div class="practice">${side}<section class="card stage">${
    ui.step === 'done' ? renderDone(deck, slides) : ui.step === 'reviewdone' ? renderReviewDone(deck) : renderStage(deck, slides)}</section></div>`;
}

function renderDone(deck, slides) {
  const { done, total } = deckProgress(deck);
  const totalTarget = slides.reduce((n, s) => n + s.target, 0);
  const totalTime = slides.reduce((n, s) => n + (deck.progress?.[slideKey(s)]?.time || 0), 0);
  return `<h1>You reached the end 🎉</h1>
    <p>${done} of ${total} slides mastered (≥ ${thr()}% recall).</p>
    ${totalTime ? `<p class="muted">Recorded whole-slide time: ${fmt(totalTime)} · target ${fmt(totalTarget)}</p>` : ''}
    <div class="row">
      <button class="btn primary" data-act="slide" data-i="${slides.findIndex((s) => slideStatus(deck, s) !== 'done') === -1 ? 0 : slides.findIndex((s) => slideStatus(deck, s) !== 'done')}">
        ${done === total ? 'Practise again' : 'Go to first unmastered slide'}</button>
      <button class="btn" data-act="home">Back to presentations</button>
    </div>`;
}

function renderReviewDone(deck) {
  const next = nextDueTime(deck);
  return `<h1>Review finished ✓</h1>
    <p>${ui.reviewCount} item${ui.reviewCount === 1 ? '' : 's'} reviewed. Items you passed come back later at growing intervals; missed ones come back in about 10 minutes.</p>
    ${next ? `<p class="muted">Next review ${relTime(next)}.</p>` : ''}
    <div class="row">
      <button class="btn primary" data-act="practice" data-id="${deck.id}">Continue learning</button>
      <button class="btn" data-act="progress" data-id="${deck.id}">See progress</button>
    </div>`;
}

function renderStage(deck, slides) {
  const slide = slides[ui.slide];
  const multi = slide.sentences.length > 1;
  const isFull = ui.step === 'full';
  const text = isFull ? slide.sentences.join(' ') : slide.sentences[ui.step];
  const stepLabel = isFull ? 'Whole slide' : multi ? `Sentence ${ui.step + 1} of ${slide.sentences.length}` : 'Single sentence';

  const steps = `<nav class="steps" aria-label="Steps">${slide.sentences.map((_, i) =>
    `<button class="${stepState(deck, slide, i)} ${ui.step === i ? 'current' : ''}" data-act="step" data-i="${i}" title="Sentence ${i + 1}">${i + 1}</button>`).join('')}
    ${multi ? `<button class="${stepState(deck, slide, 'full')} ${isFull ? 'current' : ''}" data-act="step" data-i="full">Whole slide</button>` : ''}
  </nav>`;

  const head = `<div class="stage-head">
      <h1>${ui.slide + 1}. ${esc(slide.title)}</h1>
      <span class="pill" title="Target time for the whole slide">⏱ ${fmt(slide.target)}${slide.estimated ? ' (est.)' : ''}</span>
    </div>
    <div class="muted small">Slide ${ui.slide + 1} of ${slides.length} · ${stepLabel}</div>${steps}`;

  const rv = ui.review;
  const reviewBanner = rv ? `<div class="banner info row"><b>Review</b> ${rv.pos + 1} of ${rv.queue.length}
      <span class="muted small">· last score ${rv.queue[rv.pos].last}%</span><span class="spacer"></span>
      <button class="btn small ghost" data-act="review-stop">End review</button></div>` : '';
  const banner = reviewBanner + (ui.micError ? `<div class="banner">${esc(MIC_ERRORS[ui.micError] || 'Speech recognition error: ' + ui.micError)}</div>` : '');
  let body = '';

  if (ui.phase === 'learn') {
    body = `<p class="instruction">${isFull
      ? 'Read the whole slide once more, then recite it from hint words. The timer runs while you speak.'
      : 'Read the sentence and listen to it. When you are ready, hide it and say it from memory.'}</p>
      <div class="passage ${isFull ? 'full' : ''}">${esc(text)}</div>
      <div class="row">
        <button class="btn" data-act="listen">🔊 Listen</button>
        <button class="btn primary" data-act="recite">${isFull ? 'Start whole-slide recall →' : 'Hide & recite →'}</button>
      </div>`;
  } else if (ui.phase === 'recite') {
    const hidden = isFull
      ? `<p class="muted small" style="margin-bottom:8px">Hints — the first words of each sentence:</p>
         <ol class="hints">${slide.sentences.map((s) => `<li>${esc(s.split(/\s+/).slice(0, 2).join(' '))} …</li>`).join('')}</ol>`
      : renderMasked(text, deck.lang);
    const target = isFull || !multi ? slide.target : Math.max(3, Math.round((wordCount(text) / WPM) * 60));
    body = `<p class="instruction">${ui.typed ? 'Type the text from memory, then check it.' : 'Press the microphone (or <span class="kbd">Space</span>) and say it aloud. Press again when you finish.'}</p>
      <div class="passage ${isFull ? 'full' : ''}">${hidden}</div>
      ${ui.typed ? `
        <textarea id="typed" rows="${isFull ? 8 : 3}" placeholder="Type what you remember…"></textarea>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-act="check">Check</button>
          <button class="btn" data-act="peek">Show text again</button>
          ${SR ? '<button class="btn ghost" data-act="mode">🎙 Speak instead</button>' : ''}
        </div>` : `
        <div class="mic-zone">
          <div class="timer"><span id="timer">${fmt(ui.listening ? (Date.now() - ui.startedAt) / 1000 : 0)}</span> <span class="of">/ ${fmt(target)}</span></div>
          <button class="mic ${ui.listening ? 'on' : ''}" data-act="mic" aria-label="${ui.listening ? 'Stop and check' : 'Start speaking'}">${ui.listening ? '■' : '🎙'}</button>
          <div class="live" id="live">${ui.live ? esc(ui.live) : ui.listening ? 'Listening…' : 'Your words will appear here.'}</div>
        </div>
        <div class="row">
          ${!isFull ? `<button class="btn ghost" data-act="letters">${data.settings.hintLetters ? 'Hide first letters' : 'Show first letters'}</button>` : ''}
          <button class="btn ghost" data-act="peek">Show text again</button>
          <button class="btn ghost" data-act="mode">⌨ Type instead</button>
        </div>`}`;
  } else if (ui.phase === 'result') {
    const r = ui.result;
    const pass = r.score >= thr();
    const timing = (isFull || !multi) && r.elapsed
      ? `<span class="pill">⏱ ${fmt(r.elapsed)} / ${fmt(slide.target)} ${r.elapsed > slide.target * 1.1 ? '— too long' : r.elapsed < slide.target * 0.7 ? '— quite fast' : '— on time'}</span>` : '';
    body = `<div class="score-row">
        <div class="score ${pass ? 'pass' : 'fail'}">${r.score}%</div>
        <div>
          <div><b>${pass ? 'Well done!' : 'Not yet.'}</b> ${r.got} of ${r.total} words recalled.</div>
          <div class="muted small">Green words you said; red words were missing or not recognised.</div>
        </div>
        ${timing}
      </div>
      <div class="passage ${isFull ? 'full' : ''}">${r.tokens.map((t) =>
        `<span class="w ${t.hit === true ? 'hit' : t.hit === false ? 'miss' : ''}">${esc(t.raw)}</span>`).join(' ')}</div>
      ${renderDelivery(r.stats, deck.lang)}
      <p class="heard">${ui.typed ? 'You typed' : 'We heard'}: <b>${r.heard ? esc(r.heard) : '(nothing)'}</b></p>
      <div class="row">
        <button class="btn ${pass ? '' : 'primary'}" data-act="retry">↻ Try again</button>
        <button class="btn" data-act="peek">Review text</button>
        <span class="spacer"></span>
        <button class="btn ${pass ? 'primary' : ''}" data-act="next">${nextLabel(slides)} →</button>
      </div>`;
  }
  return head + banner + body;
}

function renderMasked(text, lang) {
  const letters = data.settings.hintLetters;
  return tokenize(text, lang).map((t) => {
    if (!t.n) return esc(t.raw);
    if (letters) return `<span class="letters">${esc(t.raw[0])}${'_'.repeat(Math.max(0, t.raw.length - 1))}</span>`;
    return `<span class="mask" style="width:${Math.min(12, t.raw.length) * 0.55}em"></span>`;
  }).join(' ');
}

function nextLabel(slides) {
  if (ui.review) return ui.review.pos < ui.review.queue.length - 1 ? 'Next review item' : 'Finish review';
  const slide = slides[ui.slide];
  if (ui.step !== 'full' && ui.step < slide.sentences.length - 1) return 'Next sentence';
  if (ui.step !== 'full' && slide.sentences.length > 1) return 'Whole slide';
  return ui.slide < slides.length - 1 ? 'Next slide' : 'Finish';
}

/* ---------------------------- actions ---------------------------------- */

function goStep(step, slide = ui.slide, phase = 'learn') {
  abortListening();
  stopSpeaking();
  Object.assign(ui, { slide, step, phase, live: '', result: null, micError: null, elapsed: 0 });
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function currentText(deck) {
  const slide = getSlides(deck)[ui.slide];
  return ui.step === 'full' ? slide.sentences.join(' ') : slide.sentences[ui.step];
}

async function toggleMic() {
  if (ui.listening) {
    const heard = await ui.listener.stop();
    ui.listening = false;
    ui.listener = null;
    clearInterval(timerHandle);
    ui.elapsed = (Date.now() - ui.startedAt) / 1000;
    evaluate(heard);
    return;
  }
  const deck = curDeck();
  ui.micError = null;
  ui.live = '';
  ui.listener = new Listener(deck.lang, {
    onUpdate: (txt) => { ui.live = txt; const el = $('#live'); if (el) el.textContent = txt || 'Listening…'; },
    onFatal: (err) => {
      ui.listening = false; ui.listener = null; clearInterval(timerHandle);
      ui.micError = err; render();
    },
  });
  ui.listening = true;
  ui.startedAt = Date.now();
  stopSpeaking();
  ui.listener.start();
  clearInterval(timerHandle);
  timerHandle = setInterval(() => {
    const el = $('#timer');
    if (el) el.textContent = fmt((Date.now() - ui.startedAt) / 1000);
  }, 250);
  render();
}

function abortListening() {
  if (ui.listener) { ui.listener.active = false; try { ui.listener.rec.abort(); } catch { /* ignore */ } }
  ui.listener = null;
  ui.listening = false;
  clearInterval(timerHandle);
}

function evaluate(heard) {
  const deck = curDeck();
  const slide = getSlides(deck)[ui.slide];
  const text = currentText(deck);
  const r = grade(text, heard, deck.lang);
  const stats = ui.typed ? null : deliveryStats(heard, text, ui.elapsed, deck.lang);
  ui.result = { ...r, heard, elapsed: ui.typed ? 0 : ui.elapsed, stats };
  ui.phase = 'result';

  deck.progress = deck.progress || {};
  const keys = [ui.step === 'full' ? slideKey(slide) : sentenceKey(text)];
  for (const key of keys) {
    const prev = deck.progress[key] || { best: 0, attempts: 0 };
    const rec = { ...prev, best: Math.max(prev.best, r.score), attempts: prev.attempts + 1, last: r.score };
    if (ui.step === 'full' && ui.result.elapsed) rec.time = ui.result.elapsed;
    scheduleReview(rec, r.score);
    deck.progress[key] = rec;
  }
  recordDay(deck);
  deck.updated = Date.now();
  saveData();
  render();
}

function next() {
  if (ui.review) {
    const rv = ui.review;
    rv.pos += 1;
    if (rv.pos < rv.queue.length) { const it = rv.queue[rv.pos]; return goStep(it.step, it.slide, 'recite'); }
    ui.reviewCount = rv.queue.length;
    ui.review = null;
    return goStep('reviewdone');
  }
  const deck = curDeck();
  const slides = getSlides(deck);
  const slide = slides[ui.slide];
  if (ui.step !== 'full' && ui.step < slide.sentences.length - 1) return goStep(ui.step + 1);
  if (ui.step !== 'full' && slide.sentences.length > 1) return goStep('full');
  if (ui.slide < slides.length - 1) return goStep(0, ui.slide + 1);
  goStep('done');
}

function saveDeck() {
  const script = $('#fScript').value;
  const parsed = parseScript(script);
  if (!parsed.slides.length) { toast('Add some text to practise first.'); return; }
  const title = $('#fTitle').value.trim() || parsed.deckTitle || 'Untitled presentation';
  const lang = $('#fLang').value;
  let deck = ui.editId ? deckById(ui.editId) : null;
  if (deck) Object.assign(deck, { title, lang, script, updated: Date.now() });
  else { deck = { id: uid(), title, lang, script, progress: {}, updated: Date.now() }; data.decks.push(deck); }
  saveData();
  toast('Saved.');
  openPractice(deck.id);
}

function openReview(id) {
  const deck = deckById(id);
  if (!deck) return;
  const queue = dueItems(deck).slice(0, 30);
  if (!queue.length) { toast('Nothing is due for review right now.'); return; }
  abortListening();
  Object.assign(ui, { view: 'practice', deckId: id, review: { queue, pos: 0 } });
  goStep(queue[0].step, queue[0].slide, 'recite');
}

function openPractice(id, slideIdx) {
  abortListening();
  ui.review = null;
  const deck = deckById(id);
  if (!deck) return;
  if (slideIdx != null) { Object.assign(ui, { view: 'practice', deckId: id }); return goStep(0, slideIdx); }
  const slides = getSlides(deck);
  const first = slides.findIndex((s) => slideStatus(deck, s) !== 'done');
  Object.assign(ui, { view: 'practice', deckId: id, slide: Math.max(0, first), step: 0, phase: 'learn', result: null, live: '', micError: null });
  render();
}

function exportDeck(id) {
  const d = deckById(id);
  if (!d) return;
  const blob = new Blob([JSON.stringify({ format: 'talk-rehearsal', version: 1, deck: d }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (d.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'presentation') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importDeck(file) {
  try {
    const obj = JSON.parse(await file.text());
    const d = obj.deck || obj;
    if (typeof d.script !== 'string') throw new Error('missing script');
    const deck = {
      id: uid(),
      title: String(d.title || 'Imported presentation').slice(0, 200),
      lang: LANGS.some((l) => l[0] === d.lang) ? d.lang : 'en-US',
      script: d.script,
      progress: d.progress && typeof d.progress === 'object' ? d.progress : {},
      updated: Date.now(),
    };
    data.decks.push(deck);
    saveData();
    toast(`Imported “${deck.title}”.`);
    render();
  } catch {
    toast('That file is not a Talk Rehearsal export.');
  }
}

const SAMPLE = `# Why Sleep Matters

## Opening | 0:30
Good morning, everyone. How many of you slept less than seven hours last night? Keep that number in mind, because today I want to show you what it costs.

## What happens while we sleep | 0:45
Sleep is not a pause button for the brain. During deep sleep, the brain replays what we learned during the day and moves it into long-term memory. At the same time, it clears out waste products that build up while we are awake.

## The cost of too little | 0:40
After just one night of poor sleep, attention and reaction time drop sharply. Over months, short sleep is linked to weaker immunity, weight gain, and a higher risk of heart disease.

## Three simple habits | 0:45
- Go to bed and wake up at the same time every day, even at weekends.
- Keep your bedroom dark, quiet, and cool.
- Put your phone away at least thirty minutes before you sleep.

## Closing | 0:20
Sleep is the cheapest performance boost you will ever get. Tonight, give yourself one extra hour. Thank you.`;

function loadSample() {
  const deck = { id: uid(), title: 'Why Sleep Matters (sample)', lang: 'en-US', script: SAMPLE, progress: {}, updated: Date.now() };
  data.decks.push(deck);
  saveData();
  openPractice(deck.id);
}

/* ---------------------------- slide import ----------------------------- */
// ui.imp holds the import in progress; a copy (without transient fields) is
// kept in data.importDraft so generated scripts survive a page reload.

const langName = (code) => LANGS.find((l) => l[0] === code)?.[1] || code;
const defaultLang = () =>
  (navigator.language && LANGS.find((l) => l[0].startsWith(navigator.language.slice(0, 2)))?.[0]) || 'en-US';

let draftTimer;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const { busy, busyMsg, regen, error, ...keep } = ui.imp || {};
    data.importDraft = ui.imp ? keep : null;
    saveData();
  }, 400);
}

function openImport() {
  abortListening();
  ui.imp = data.importDraft ? { ...data.importDraft } : { step: 'pick' };
  ui.view = 'import';
  render();
}

async function importSlides(file) {
  ui.imp = { step: 'pick', busy: true, busyMsg: `Reading ${file.name}…` };
  render();
  try {
    const raw = await Importer.extractSlides(file);
    ui.impImages = raw.map((s) => s.image || null);
    const slides = raw.map((s, i) => ({
      title: s.title || `Slide ${i + 1}`,
      text: s.text,
      notes: s.notes,
    }));
    const totalMin = Math.max(1, Math.round(slides.length * 0.75));
    ui.imp = {
      step: 'review',
      fileName: file.name,
      slides,
      title: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim() || slides[0].title,
      lang: defaultLang(),
      totalMin,
      audience: '',
      method: data.settings.apiKey ? 'claude' : 'basic',
      useNotes: slides.some((s) => (s.notes.match(/\S+/g) || []).length >= 8),
      targets: Importer.planTargets(slides, totalMin * 60),
      scripts: null,
      source: null,
    };
    saveDraft();
  } catch (err) {
    ui.imp = { step: 'pick', error: err.message || String(err) };
  }
  render();
}

function onImportInput(el) {
  const imp = ui.imp;
  if (!imp || imp.step !== 'review') return;
  const f = el.dataset.f;
  if (f === 'script') {
    const i = +el.dataset.i;
    imp.scripts[i] = el.value;
    imp.source[i] = 'edited';
    const meta = document.querySelector(`[data-meta="${i}"]`);
    if (meta) meta.innerHTML = scriptMeta(i);
  } else if (f === 'totalMin') {
    imp.totalMin = Math.max(1, Math.min(180, +el.value || 1));
    imp.targets = Importer.planTargets(imp.slides, imp.totalMin * 60);
    imp.targets.forEach((t, i) => {
      const p = document.querySelector(`[data-target="${i}"]`);
      if (p) p.textContent = `⏱ ${fmt(t)}`;
      const meta = document.querySelector(`[data-meta="${i}"]`);
      if (meta) meta.innerHTML = scriptMeta(i);
    });
  } else if (f === 'useNotes') { imp.useNotes = el.checked; }
  else if (f === 'method') { if (el.checked) { imp.method = el.value; render(); } }
  else if (f === 'apiKey') { data.settings.apiKey = el.value.trim(); saveData(); }
  else if (f) imp[f] = el.value;
  saveDraft();
}

function scriptMeta(i) {
  const imp = ui.imp;
  const w = wordCount(imp.scripts?.[i] || '');
  const spoken = Math.round((w / WPM) * 60);
  const target = imp.targets[i];
  const cls = spoken > target * 1.25 ? 'no' : spoken < target * 0.6 ? 'warnc' : 'ok';
  return `${w} words · <span class="${cls}">~${fmt(spoken)} spoken</span> / ${fmt(target)} target`;
}

const SOURCE_LABEL = { claude: 'Written by Claude', notes: 'From speaker notes', basic: 'Template draft', edited: 'Edited' };

function renderImport() {
  const imp = ui.imp || { step: 'pick' };
  if (imp.step === 'pick') {
    return `<div id="impView">
      <h1>Import a presentation</h1>
      <p class="muted" style="max-width:680px">Upload a PowerPoint (.pptx) or PDF. The file is read in your browser.
        You will get a draft script for each slide to review and edit, then you can rehearse it.</p>
      ${imp.error ? `<div class="banner">${esc(imp.error)}</div>` : ''}
      <label class="dropzone card" id="drop">
        <input type="file" id="slideFile" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden>
        ${imp.busy ? `<span class="spinner" aria-hidden="true"></span><b>${esc(imp.busyMsg)}</b>`
          : `<span class="drop-icon" aria-hidden="true">⇪</span><b>Choose a file</b><span class="muted">or drop it here · .pptx or .pdf</span>`}
      </label>
      <p class="muted small" style="margin-top:16px">Speaker notes are read from .pptx files. For Keynote or Google Slides, export as .pptx or PDF first.</p>
    </div>`;
  }

  const hasKey = !!data.settings.apiKey;
  const notesCount = imp.slides.filter((s) => (s.notes.match(/\S+/g) || []).length >= 8).length;
  const generated = !!imp.scripts;
  const busy = imp.busy;
  const totalTarget = imp.targets.reduce((a, b) => a + b, 0);

  const options = `<aside class="card imp-options">
    <h2>Script options</h2>
    <label class="field"><span>Title</span><input type="text" data-f="title" value="${esc(imp.title)}"></label>
    <label class="field"><span>Language of the talk</span>
      <select data-f="lang">${LANGS.map(([v, n]) => `<option value="${v}" ${v === imp.lang ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
    <label class="field"><span>Total speaking time (minutes)</span>
      <input type="text" inputmode="numeric" data-f="totalMin" value="${imp.totalMin}"></label>
    <label class="field"><span>Audience and tone <span class="muted small">(optional)</span></span>
      <input type="text" data-f="audience" value="${esc(imp.audience)}" placeholder="e.g. thesis jury, formal"></label>
    <fieldset class="field radio-group">
      <legend>Who writes the scripts?</legend>
      <label><input type="radio" name="method" value="claude" data-f="method" ${imp.method === 'claude' ? 'checked' : ''}>
        <span>Claude <span class="muted small">— natural, connected talk (uses your API key)</span></span></label>
      <label><input type="radio" name="method" value="basic" data-f="method" ${imp.method === 'basic' ? 'checked' : ''}>
        <span>Simple template <span class="muted small">— offline, turns slide text into sentences</span></span></label>
    </fieldset>
    ${imp.method === 'claude' && !hasKey ? `<label class="field"><span>Claude API key</span>
      <input type="password" autocomplete="off" spellcheck="false" data-f="apiKey" placeholder="sk-ant-…"></label>` : ''}
    <label class="check"><input type="checkbox" data-f="useNotes" ${imp.useNotes ? 'checked' : ''} ${notesCount ? '' : 'disabled'}>
      <span>Use speaker notes as the script where they exist <span class="muted small">(${notesCount} slide${notesCount === 1 ? '' : 's'})</span></span></label>
    <div class="row" style="margin-top:16px">
      <button class="btn ${generated ? '' : 'primary'}" data-act="imp-generate" ${busy ? 'disabled' : ''}>${generated ? '↻ Regenerate all' : 'Generate scripts'}</button>
      ${generated ? `<button class="btn primary" data-act="imp-save" ${busy ? 'disabled' : ''}>Save &amp; rehearse →</button>` : ''}
    </div>
    <p class="muted small" style="margin-top:14px">${imp.slides.length} slides from <b>${esc(imp.fileName)}</b> · target ${fmt(totalTarget)}</p>
    <button class="btn ghost small" data-act="imp-reset" ${busy ? 'disabled' : ''}>Import a different file</button>
  </aside>`;

  const cards = imp.slides.map((s, i) => `<article class="card imp-slide">
    <div class="stage-head">
      <h3>${i + 1}. ${esc(s.title)}</h3>
      <span class="pill" data-target="${i}">⏱ ${fmt(imp.targets[i])}</span>
    </div>
    <details class="slide-src" ${generated ? '' : 'open'}>
      <summary>Slide content${s.notes ? ' + speaker notes' : ''}</summary>
      ${s.text.length ? `<ul>${s.text.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="muted small">(no text on this slide)</p>'}
      ${s.notes ? `<p class="notes"><b>Notes:</b> ${esc(s.notes)}</p>` : ''}
    </details>
    ${generated ? `
      <textarea class="script" rows="5" data-f="script" data-i="${i}" ${imp.regen === i ? 'disabled' : ''}>${esc(imp.scripts[i])}</textarea>
      <div class="row small" style="margin-top:8px">
        <span class="tag">${SOURCE_LABEL[imp.source[i]] || ''}</span>
        <span class="muted" data-meta="${i}">${scriptMeta(i)}</span>
        <span class="spacer"></span>
        ${aiReady(imp) ? `<button class="btn small" data-act="imp-regen" data-i="${i}" ${busy || imp.regen != null ? 'disabled' : ''}>${imp.regen === i ? 'Writing…' : '✨ Rewrite with Claude'}</button>` : ''}
        <button class="btn small ghost" data-act="imp-basic" data-i="${i}" ${busy ? 'disabled' : ''}>Template</button>
        ${s.notes ? `<button class="btn small ghost" data-act="imp-notes" data-i="${i}" ${busy ? 'disabled' : ''}>Notes</button>` : ''}
      </div>` : ''}
  </article>`).join('');

  return `<div id="impView">
    <h1>${generated ? 'Review your scripts' : 'Imported slides'}</h1>
    <p class="muted" style="max-width:720px">${generated
      ? 'Edit any script directly. These exact words become your rehearsal text, so make them sound like you.'
      : 'Check the extracted text, set the options, then generate a script for each slide.'}</p>
    ${imp.error ? `<div class="banner">${esc(imp.error)}</div>` : ''}
    ${busy ? `<div class="banner info row"><span class="spinner" aria-hidden="true"></span> <span id="busyMsg">${esc(imp.busyMsg)}</span>
      <span class="spacer"></span><button class="btn small" data-act="imp-stop">Stop</button></div>` : ''}
    <div class="imp-grid">${options}<section class="imp-slides">${cards}</section></div>
  </div>`;
}

function aiOptions(imp) {
  return {
    method: imp.method, useNotes: imp.useNotes, apiKey: data.settings.apiKey,
    lang: imp.lang, langName: langName(imp.lang), title: imp.title, audience: imp.audience,
    totalSeconds: imp.totalMin * 60,
  };
}

function aiError(err) {
  return Importer.friendlyError(err);
}

const aiReady = (imp) => imp.method === 'claude' && !!data.settings.apiKey;

let aiAbort = null;

async function importGenerate() {
  const imp = ui.imp;
  if (imp.method === 'claude' && !data.settings.apiKey) { imp.error = 'Add your Claude API key first, or choose another option.'; render(); return; }
  if (imp.scripts && imp.source.some((s) => s === 'edited') && !confirm('Regenerating replaces your edits. Continue?')) return;
  const busyMsg = imp.method === 'claude' ? 'Claude is writing your scripts… this can take a minute.' : 'Generating…';
  Object.assign(imp, { busy: true, error: null, busyMsg });
  aiAbort = new AbortController();
  render();
  const started = Date.now();
  try {
    const res = await Importer.generateScripts(imp.slides, { ...aiOptions(imp), signal: aiAbort.signal }, (p) => {
      const el = document.getElementById('busyMsg');
      if (!el) return;
      el.textContent = `Claude is writing your scripts… ${Math.round((Date.now() - started) / 1000)}s · ${p.toLocaleString()} characters so far`;
    });
    Object.assign(imp, res);
    if (imp.method === 'claude' && res.source.includes('basic') && !res.source.includes('claude')) {
      imp.error = 'Claude returned no scripts, so template drafts were used.';
    }
  } catch (err) {
    imp.error = aiAbort?.signal.aborted ? 'Stopped.' : aiError(err);
  }
  aiAbort = null;
  imp.busy = false;
  saveDraft();
  render();
}

async function importRegen(i) {
  const imp = ui.imp;
  imp.regen = i;
  imp.error = null;
  aiAbort = new AbortController();
  render();
  try {
    imp.scripts[i] = await Importer.regenerateSlide(imp.slides, imp.targets, i, {
      ...aiOptions(imp), previous: imp.scripts[i], prevScript: imp.scripts[i - 1] || '', signal: aiAbort.signal,
    });
    imp.source[i] = 'claude';
  } catch (err) {
    if (err.name === 'AbortError' || aiAbort?.signal.aborted) err = new Error('Stopped.');
    imp.error = `Slide ${i + 1}: ${aiError(err)}`;
  }
  aiAbort = null;
  imp.regen = null;
  saveDraft();
  render();
}

function importSave() {
  const imp = ui.imp;
  const parts = [`# ${imp.title}`];
  const kept = [];
  imp.slides.forEach((s, i) => {
    const text = (imp.scripts[i] || '').trim();
    if (!text) return;
    kept.push(i);
    const title = s.title.replace(/[|#\[\]]/g, ' ').replace(/\s+/g, ' ').trim() || `Slide ${i + 1}`;
    parts.push(`## ${title} | ${fmt(imp.targets[i])}\n${text}`);
  });
  if (parts.length === 1) { imp.error = 'All scripts are empty.'; render(); return; }
  const deck = {
    id: uid(), title: imp.title.trim() || 'Imported presentation', lang: imp.lang,
    script: parts.join('\n\n'), progress: {}, updated: Date.now(),
    // What each slide shows, for the dress rehearsal (images go to IndexedDB).
    visuals: kept.map((i) => ({ title: imp.slides[i].title, text: imp.slides[i].text.slice(0, 10) })),
  };
  const imgs = ui.impImages && kept.map((i) => ui.impImages[i] || null);
  if (imgs && imgs.some(Boolean)) saveImages(deck.id, imgs);
  ui.impImages = null;
  data.decks.push(deck);
  data.importDraft = null;
  ui.imp = null;
  saveData();
  toast('Saved. Time to rehearse!');
  openPractice(deck.id);
}

/* ---------------------------- events ----------------------------------- */

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  switch (act) {
    case 'home':
      if (ui.view === 'rehearse') { exitRehearsal(); ui.view = 'home'; render(); break; }
      abortListening(); stopSpeaking(); ui.review = null; ui.view = 'home'; render(); break;
    case 'review': openReview(id); break;
    case 'review-stop': ui.reviewCount = ui.review ? ui.review.pos : 0; ui.review = null; goStep('reviewdone'); break;
    case 'progress': abortListening(); stopSpeaking(); ui.review = null; ui.deckId = id; ui.view = 'progress'; render(); window.scrollTo(0, 0); break;
    case 'slide-go': openPractice(id, +el.dataset.i); break;
    case 'clear-date': { const d = deckById(id); if (d) { delete d.talkDate; saveData(); render(); } break; }
    case 'rehearse': openRehearsal(id); break;
    case 'reh-start': startRehearsal(); break;
    case 'reh-next': rehGo(1); break;
    case 'reh-prev': rehGo(-1); break;
    case 'reh-hints': ui.reh.hints = !ui.reh.hints; render(); break;
    case 'reh-finish': finishRehearsal(); break;
    case 'reh-exit': exitRehearsal(); break;
    case 'reh-again': openRehearsal(ui.reh.deckId); break;
    case 'install': if (installPrompt) { installPrompt.prompt(); installPrompt = null; render(); } break;
    case 'new': ui.editId = null; ui.view = 'edit'; render(); break;
    case 'edit': abortListening(); ui.editId = id; ui.view = 'edit'; render(); break;
    case 'save': saveDeck(); break;
    case 'sample': loadSample(); break;
    case 'practice': openPractice(id); break;
    case 'export': exportDeck(id); break;
    case 'delete': {
      const d = deckById(id);
      if (d && confirm(`Delete “${d.title}” and its progress?`)) {
        data.decks = data.decks.filter((x) => x.id !== id);
        deleteImages(id);
        saveData(); render();
      }
      break;
    }
    case 'slide': goStep(0, +el.dataset.i); break;
    case 'step': goStep(el.dataset.i === 'full' ? 'full' : +el.dataset.i); break;
    case 'listen': {
      const deck = curDeck();
      const slide = getSlides(deck)[ui.slide];
      speak(ui.step === 'full' ? slide.sentences : [slide.sentences[ui.step]], deck.lang);
      break;
    }
    case 'recite': stopSpeaking(); Object.assign(ui, { phase: 'recite', live: '', micError: null }); render();
      if (ui.typed) $('#typed')?.focus();
      break;
    case 'peek': case 'retry':
      abortListening();
      Object.assign(ui, { phase: act === 'retry' ? 'recite' : 'learn', live: '', result: null, micError: null });
      render();
      if (ui.typed && act === 'retry') $('#typed')?.focus();
      break;
    case 'mic': toggleMic(); break;
    case 'check': evaluate($('#typed').value); break;
    case 'mode': abortListening(); ui.typed = !ui.typed; ui.micError = null; render(); if (ui.typed) $('#typed')?.focus(); break;
    case 'letters': data.settings.hintLetters = !data.settings.hintLetters; saveData(); render(); break;
    case 'next': next(); break;
    case 'import': openImport(); break;
    case 'imp-reset': ui.imp = { step: 'pick' }; data.importDraft = null; saveData(); render(); break;
    case 'imp-generate': importGenerate(); break;
    case 'imp-regen': importRegen(+el.dataset.i); break;
    case 'imp-stop': if (aiAbort) aiAbort.abort(); break;
    case 'imp-save': importSave(); break;
    case 'imp-basic': case 'imp-notes': {
      const i = +el.dataset.i;
      const imp = ui.imp;
      imp.scripts[i] = act === 'imp-notes'
        ? imp.slides[i].notes.replace(/\s+/g, ' ').trim()
        : Importer.basicScript(imp.slides[i], i, imp.slides.length, imp.lang);
      imp.source[i] = act === 'imp-notes' ? 'notes' : 'basic';
      saveDraft(); render();
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'fScript') updatePreview();
  if (e.target.closest && e.target.closest('#impView')) { onImportInput(e.target); return; }
  const s = e.target.dataset?.setting;
  if (s === 'apiKey') { data.settings.apiKey = e.target.value.trim(); saveData(); return; }
  if (s) {
    data.settings[s] = +e.target.value;
    if (s === 'threshold') $('#thrVal').textContent = `${data.settings.threshold}%`;
    if (s === 'rate') $('#rateVal').textContent = `${data.settings.rate.toFixed(2)}×`;
    saveData();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'talkDate') {
    const d = deckById(e.target.dataset.id);
    if (d) { if (e.target.value) d.talkDate = e.target.value; else delete d.talkDate; saveData(); render(); }
  }
  if (e.target.id === 'importFile' && e.target.files[0]) importDeck(e.target.files[0]);
  if (e.target.id === 'slideFile' && e.target.files[0]) importSlides(e.target.files[0]);
  if (e.target.closest && e.target.closest('#impView') && e.target.type !== 'file') onImportInput(e.target);
});

document.addEventListener('dragover', (e) => {
  const z = e.target.closest && e.target.closest('#drop');
  if (z) { e.preventDefault(); z.classList.add('over'); }
});
document.addEventListener('dragleave', (e) => {
  const z = e.target.closest && e.target.closest('#drop');
  if (z) z.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  const z = e.target.closest && e.target.closest('#drop');
  if (!z) return;
  e.preventDefault();
  z.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) importSlides(f);
});

document.addEventListener('keydown', (e) => {
  if (ui.view !== 'practice') return;
  const tag = e.target.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') {
    if (e.target.id === 'typed' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); evaluate(e.target.value); }
    return;
  }
  if (e.key === ' ' && ui.phase === 'recite' && !ui.typed) { e.preventDefault(); toggleMic(); }
  else if (e.key === 'Enter' && ui.phase === 'learn') { e.preventDefault(); $('[data-act="recite"]')?.click(); }
  else if (e.key === 'Enter' && ui.phase === 'result') { e.preventDefault(); next(); }
});

/* ---------------------------- installable app -------------------------- */

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; toast('Installed. You can open it from your apps.'); render(); });
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
