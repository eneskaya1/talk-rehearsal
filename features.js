'use strict';

/* =========================================================================
   features.js — spaced review, delivery stats (pace + filler words),
   practice history, the talk-date study plan and the progress page.
   Loaded before app.js; everything here runs only when called, so it can use
   app.js globals (data, ui, getSlides, grade, …) at runtime.
   ========================================================================= */

/* ---------------------------- spaced review ---------------------------- */

const MINUTE = 60e3;
const DAY = 864e5;

// Missed → back in 10 minutes. Passed → 1 day, then each interval × 2.5.
function scheduleReview(rec, score) {
  if (score >= data.settings.threshold) rec.ivl = rec.ivl >= DAY ? Math.round(rec.ivl * 2.5) : DAY;
  else rec.ivl = 10 * MINUTE;
  rec.due = Date.now() + rec.ivl;
}

// Every practised item (sentence or whole slide) whose review time has come.
function dueItems(deck, now = Date.now()) {
  const out = [];
  getSlides(deck).forEach((slide, si) => {
    slide.sentences.forEach((s, k) => {
      const rec = deck.progress?.[sentenceKey(s)];
      if (rec?.due && rec.due <= now) out.push({ slide: si, step: k, last: rec.last ?? rec.best, due: rec.due });
    });
    if (slide.sentences.length > 1) {
      const rec = deck.progress?.[slideKey(slide)];
      if (rec?.due && rec.due <= now) out.push({ slide: si, step: 'full', last: rec.last ?? rec.best, due: rec.due });
    }
  });
  // Weakest first; whole-slide recalls after the sentences of the same slide.
  return out.sort((a, b) => (a.last - b.last) || (a.slide - b.slide) || (a.step === 'full' ? 1 : -1));
}

function nextDueTime(deck) {
  let min = Infinity;
  for (const rec of Object.values(deck.progress || {})) if (rec.due && rec.due < min) min = rec.due;
  return min === Infinity ? null : min;
}

function relTime(ms) {
  const d = ms - Date.now();
  if (d <= 0) return 'now';
  if (d < 90 * MINUTE) return `in ${Math.max(1, Math.round(d / MINUTE))} min`;
  if (d < 36 * 3600e3) return `in ${Math.round(d / 3600e3)} h`;
  return `in ${Math.round(d / DAY)} days`;
}

/* ------------------------- pace + filler words ------------------------- */
// Note: Chrome's recogniser often drops pure hesitation sounds ("um", "eee"),
// so word fillers ("yani", "basically") are counted more reliably.

const FILLERS = {
  en: ['um', 'umm', 'uh', 'uhm', 'erm', 'er', 'ah', 'hmm', 'you know', 'i mean', 'basically', 'actually', 'literally', 'kind of', 'sort of'],
  tr: ['ee', 'eee', 'eh', 'ıı', 'ııı', 'hmm', 'şey', 'yani', 'işte', 'hani', 'aslında', 'falan', 'ne diyeyim', 'nasıl desem'],
  de: ['äh', 'ähm', 'öh', 'hm', 'halt', 'quasi', 'sozusagen', 'irgendwie', 'eigentlich'],
  fr: ['euh', 'heu', 'ben', 'bah', 'genre', 'en fait', 'du coup', 'voilà', 'quoi'],
  es: ['eh', 'em', 'este', 'pues', 'o sea', 'bueno', 'digamos', 'tipo'],
  it: ['ehm', 'eh', 'cioè', 'tipo', 'allora', 'praticamente', 'diciamo'],
  pt: ['é', 'hum', 'tipo', 'então', 'né', 'assim', 'quer dizer'],
  nl: ['eh', 'ehm', 'uh', 'zeg maar', 'eigenlijk', 'gewoon', 'dus'],
};

const PACE = { tr: [85, 140], de: [100, 160] }; // comfortable words per minute
const paceRange = (lang) => PACE[lang.slice(0, 2)] || [110, 170];

function countPhrase(normWords, phrase) {
  const p = phrase.split(' ');
  let n = 0;
  for (let i = 0; i + p.length <= normWords.length; i++) {
    if (p.every((w, k) => normWords[i + k] === w)) n++;
  }
  return n;
}

function normWords(text, lang) {
  return text.split(/\s+/).map((w) => w.toLocaleLowerCase(lang).replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
}

// Fillers in what was said, minus the ones the script itself contains.
function countFillers(heard, expected, lang) {
  const list = FILLERS[lang.slice(0, 2)] || [];
  const h = normWords(heard, lang);
  const e = normWords(expected, lang);
  const found = [];
  for (const f of list) {
    const n = countPhrase(h, f) - countPhrase(e, f);
    if (n > 0) found.push([f, n]);
  }
  return { total: found.reduce((a, [, n]) => a + n, 0), list: found.sort((a, b) => b[1] - a[1]) };
}

function deliveryStats(heard, expected, elapsedSec, lang) {
  const words = normWords(heard, lang).length;
  const wpm = elapsedSec >= 4 && words >= 5 ? Math.round(words / (elapsedSec / 60)) : null;
  const [lo, hi] = paceRange(lang);
  const pace = wpm == null ? null : wpm < lo ? 'slow' : wpm > hi ? 'fast' : 'good';
  return { wpm, pace, fillers: countFillers(heard, expected, lang) };
}

function renderDelivery(st, lang) {
  if (!st) return '';
  const [lo, hi] = paceRange(lang);
  const paceTxt = st.wpm == null ? '' : `<span class="pill ${st.pace === 'good' ? 'pill-good' : 'pill-warn'}" title="Comfortable: ${lo}–${hi} words per minute">
      ${st.pace === 'good' ? '✓' : '⚠'} ${st.wpm} wpm · ${st.pace === 'good' ? 'good pace' : st.pace === 'fast' ? 'too fast' : 'slow'}</span>`;
  const f = st.fillers;
  const fillTxt = `<span class="pill ${f.total ? 'pill-warn' : 'pill-good'}">${f.total ? `⚠ ${f.total} filler word${f.total > 1 ? 's' : ''}: ${f.list.map(([w, n]) => `“${esc(w)}”${n > 1 ? ' ×' + n : ''}`).join(', ')}` : '✓ No filler words'}</span>`;
  return `<div class="row delivery">${paceTxt}${fillTxt}</div>`;
}

/* ------------------------------ history -------------------------------- */

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// One row per day: attempts made and the mastery level reached that day.
function recordDay(deck) {
  deck.days = deck.days || {};
  const k = dayKey();
  const { done, total } = deckProgress(deck);
  const row = deck.days[k] || { attempts: 0 };
  row.attempts += 1;
  row.mastered = total ? Math.round((done / total) * 100) : 0;
  deck.days[k] = row;
  const keys = Object.keys(deck.days).sort();
  while (keys.length > 180) delete deck.days[keys.shift()];
}

function recordRehearsal(deck, session) {
  deck.history = deck.history || [];
  deck.history.push(session);
  if (deck.history.length > 60) deck.history.splice(0, deck.history.length - 60);
  recordDay(deck);
}

/* ---------------------------- study plan ------------------------------- */

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const talk = new Date(y, m - 1, d);
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  return Math.round((talk - today) / DAY);
}

function rangeLabel(idx) {
  if (!idx.length) return '';
  const parts = [];
  let a = idx[0], b = idx[0];
  for (const i of idx.slice(1).concat([null])) {
    if (i === b + 1) { b = i; continue; }
    parts.push(a === b ? `${a + 1}` : `${a + 1}–${b + 1}`);
    if (i != null) { a = b = i; }
  }
  return `slide${idx.length > 1 ? 's' : ''} ${parts.join(', ')}`;
}

function studyPlan(deck) {
  const left = daysUntil(deck.talkDate);
  if (left == null) return null;
  const slides = getSlides(deck);
  const open = slides.map((s, i) => (slideStatus(deck, s) === 'done' ? -1 : i)).filter((i) => i >= 0);
  const due = dueItems(deck).length;
  const rehearsedToday = (deck.history || []).some((h) => dayKey(new Date(h.at)) === dayKey());
  if (left < 0) return { left, past: true, tasks: [] };

  // Leave the last day before the talk for dress rehearsals when possible.
  const learnDays = left <= 1 ? 1 : left - 1;
  const today = open.slice(0, Math.ceil(open.length / learnDays));
  const tasks = [];
  if (left === 0) {
    tasks.push({ kind: 'rehearse', label: 'One calm dress rehearsal — then rest your voice', done: rehearsedToday });
    if (due) tasks.push({ kind: 'review', label: `Quick review of ${due} weak spot${due > 1 ? 's' : ''}` });
  } else {
    if (today.length) tasks.push({ kind: 'learn', label: `Learn ${rangeLabel(today)}`, slide: today[0] });
    if (due) tasks.push({ kind: 'review', label: `Review ${due} weak spot${due > 1 ? 's' : ''}` });
    if (left <= 2 || !open.length || (left <= 5 && open.length <= slides.length / 3)) {
      tasks.push({ kind: 'rehearse', label: left <= 1 ? 'Two full dress rehearsals' : 'A full dress rehearsal', done: rehearsedToday });
    }
  }
  if (!tasks.length) tasks.push({ kind: 'rehearse', label: 'Everything is learned — keep it fresh with a dress rehearsal', done: rehearsedToday });
  return { left, tasks, open: open.length, total: slides.length };
}

function renderPlan(deck, compact) {
  const plan = studyPlan(deck);
  if (!plan) {
    return compact ? '' : `<p class="muted small">Set the date of your talk to get a daily practice plan.</p>`;
  }
  if (plan.past) return `<div class="plan muted small">🗓 The talk date has passed. Set a new date if you are presenting again.</div>`;
  const when = plan.left === 0 ? 'Talk is <b>today</b>' : plan.left === 1 ? 'Talk is <b>tomorrow</b>' : `Talk in <b>${plan.left} days</b>`;
  const btn = (t) => t.kind === 'learn' ? `<button class="btn small" data-act="slide-go" data-id="${deck.id}" data-i="${t.slide}">Start</button>`
    : t.kind === 'review' ? `<button class="btn small" data-act="review" data-id="${deck.id}">Review</button>`
    : `<button class="btn small" data-act="rehearse" data-id="${deck.id}">Rehearse</button>`;
  return `<div class="plan">
    <div class="small">🗓 ${when} · today's plan:</div>
    <ul class="plan-list">${plan.tasks.map((t) => `<li class="${t.done ? 'done' : ''}"><span>${t.done ? '✓ ' : ''}${t.label}</span>${t.done ? '' : btn(t)}</li>`).join('')}</ul>
  </div>`;
}

/* ------------------------------ charts --------------------------------- */
// Small single-series SVG line charts (one hue, no legend; the title names
// the series). Hover any point for its value; the session table below the
// charts is the accessible table view.

function lineChart({ title, points, yMax, yFmt, ref, refLabel, height = 180 }) {
  if (points.length < 2) {
    return `<figure class="chart card"><figcaption>${esc(title)}</figcaption>
      <p class="muted small chart-empty">${points.length ? `So far: <b>${yFmt(points[0].y)}</b>. ` : ''}A trend appears after two or more ${points.length ? 'more ' : ''}sessions.</p></figure>`;
  }
  const W = 380, H = height, L = 40, R = 10, T = 12, B = 24;
  const max = yMax ?? (Math.max(...points.map((p) => p.y), ref || 0) * 1.15 || 1);
  const x = (i) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const every = Math.ceil(points.length / 6);
  return `<figure class="chart card"><figcaption>${esc(title)}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
      ${ticks.map((t) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>
        <text class="axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join('')}
      ${ref != null ? `<line class="ref" x1="${L}" x2="${W - R}" y1="${y(ref)}" y2="${y(ref)}"/>
        <text class="axis" x="${W - R}" y="${y(ref) - 5}" text-anchor="end">${esc(refLabel || '')}</text>` : ''}
      <path class="series" d="${path}"/>
      ${points.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.y)}" r="4"/>
        <circle class="hit" cx="${x(i)}" cy="${y(p.y)}" r="14" data-tip="${esc(p.tip)}"/>`).join('')}
      ${points.map((p, i) => (i % every === 0 || i === points.length - 1)
        ? `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.x)}</text>` : '').join('')}
    </svg></figure>`;
}

// Horizontal bars: time spent per slide, with the target as a tick.
function slideTimeBars(rows) {
  const max = Math.max(...rows.map((r) => Math.max(r.time, r.target)), 1) * 1.05;
  return `<div class="tbars" role="img" aria-label="Time per slide compared with target">${rows.map((r, i) => {
    const over = r.time > r.target * 1.15;
    return `<div class="tbar" data-tip="${esc(`${r.title}: ${fmt(r.time)} of ${fmt(r.target)} target${r.coverage != null ? ` · ${r.coverage}% recalled` : ''}`)}">
      <span class="tbar-label">${i + 1}. ${esc(r.title)}</span>
      <span class="tbar-track"><i class="${over ? 'over' : ''}" style="width:${(r.time / max) * 100}%"></i>
        <b class="tick" style="left:${(r.target / max) * 100}%"></b></span>
      <span class="tbar-val">${fmt(r.time)}${over ? ' ⚠' : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

// One shared tooltip for every element with data-tip.
(() => {
  let tip;
  const show = (el, ev) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; document.body.appendChild(tip); }
    tip.textContent = el.getAttribute('data-tip');
    tip.style.display = 'block';
    const x = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${ev.clientY - tip.offsetHeight - 10}px`;
  };
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) show(el, e); else if (tip) tip.style.display = 'none';
  });
})();

/* ---------------------------- progress page ---------------------------- */

function renderProgress(deck) {
  const slides = getSlides(deck);
  const { done, total } = deckProgress(deck);
  const days = Object.entries(deck.days || {}).sort(([a], [b]) => a.localeCompare(b));
  const hist = deck.history || [];
  const attempts = Object.values(deck.progress || {}).reduce((n, r) => n + (r.attempts || 0), 0);
  const due = dueItems(deck).length;
  const next = nextDueTime(deck);
  const last = hist[hist.length - 1];
  const target = slides.reduce((n, s) => n + s.target, 0);
  const shortDate = (k) => { const [, m, d] = k.split('-'); return `${+d}/${+m}`; };

  const tiles = `<div class="tiles">
    <div class="tile card"><span class="tile-v">${done}<small>/${total}</small></span><span class="tile-l">slides mastered</span></div>
    <div class="tile card"><span class="tile-v">${due}</span><span class="tile-l">${due ? 'due for review now' : next ? `nothing due · next ${relTime(next)}` : 'due for review'}</span></div>
    <div class="tile card"><span class="tile-v">${days.length}</span><span class="tile-l">days practised · ${attempts} attempts</span></div>
    <div class="tile card"><span class="tile-v">${last?.coverage != null ? last.coverage + '%' : '—'}</span><span class="tile-l">last dress rehearsal recall</span></div>
  </div>`;

  const weak = slides.map((s, i) => {
    const vals = s.sentences.map((x) => bestOf(deck, sentenceKey(x))).filter((v) => v != null);
    return { i, title: s.title, avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null };
  }).filter((r) => r.avg != null && r.avg < thr()).sort((a, b) => a.avg - b.avg).slice(0, 5);

  return `<div class="progress-page">
    <h1>${esc(deck.title)}</h1>
    <div class="progress-top">
      <section class="card">
        <h2>Talk date</h2>
        <div class="row"><input type="date" id="talkDate" data-id="${deck.id}" value="${esc(deck.talkDate || '')}" style="max-width:200px">
          ${deck.talkDate ? `<button class="btn ghost small" data-act="clear-date" data-id="${deck.id}">Clear</button>` : ''}</div>
        <div style="margin-top:12px">${renderPlan(deck)}</div>
      </section>
      <section class="card">
        <h2>Practise</h2>
        <div class="row">
          <button class="btn primary" data-act="practice" data-id="${deck.id}">Continue learning</button>
          <button class="btn" data-act="review" data-id="${deck.id}" ${due ? '' : 'disabled'}>Review weak spots (${due})</button>
          <button class="btn" data-act="rehearse" data-id="${deck.id}">🎤 Dress rehearsal</button>
        </div>
        ${weak.length ? `<p class="small" style="margin:14px 0 4px"><b>Weakest slides</b></p>
          <ul class="weak-list">${weak.map((w) => `<li><button class="link" data-act="slide-go" data-id="${deck.id}" data-i="${w.i}">${w.i + 1}. ${esc(w.title)}</button> <span class="muted">${w.avg}% avg</span></li>`).join('')}</ul>` : ''}
      </section>
    </div>
    ${tiles}
    <div class="charts">
      ${lineChart({ title: 'Slides mastered (%) by day', yMax: 100, yFmt: (v) => `${Math.round(v)}%`,
        points: days.map(([k, r]) => ({ x: shortDate(k), y: r.mastered, tip: `${k}: ${r.mastered}% mastered · ${r.attempts} attempts` })) })}
      ${lineChart({ title: 'Dress rehearsal: words recalled (%)', yMax: 100, yFmt: (v) => `${Math.round(v)}%`,
        points: hist.filter((h) => h.coverage != null).map((h) => ({ x: shortDate(dayKey(new Date(h.at))), y: h.coverage, tip: `${new Date(h.at).toLocaleString()}: ${h.coverage}% recalled` })) })}
      ${lineChart({ title: 'Dress rehearsal: total time', yFmt: (v) => fmt(v), ref: target, refLabel: `target ${fmt(target)}`,
        points: hist.map((h) => ({ x: shortDate(dayKey(new Date(h.at))), y: h.duration, tip: `${new Date(h.at).toLocaleString()}: ${fmt(h.duration)} (target ${fmt(h.target)})` })) })}
    </div>
    <section class="card" style="margin-top:20px">
      <h2>Dress rehearsals</h2>
      ${hist.length ? `<div class="table-wrap"><table class="data">
        <thead><tr><th>Date</th><th>Time / target</th><th>Recalled</th><th>Pace</th><th>Fillers</th></tr></thead>
        <tbody>${hist.slice().reverse().map((h) => `<tr>
          <td>${esc(new Date(h.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }))}</td>
          <td>${fmt(h.duration)} / ${fmt(h.target)}</td>
          <td>${h.coverage != null ? h.coverage + '%' : '—'}</td>
          <td>${h.wpm != null ? h.wpm + ' wpm' : '—'}</td>
          <td>${h.fillers != null ? h.fillers : '—'}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted small">No dress rehearsals yet. Do one when most slides are learned — it is the closest thing to the real talk.</p>'}
    </section>
  </div>`;
}
