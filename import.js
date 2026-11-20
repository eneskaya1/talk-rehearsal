'use strict';

/* =========================================================================
   Presentation import + script generation.
   - extractSlides(file): reads .pptx (slide text + speaker notes) or .pdf
     (text per page) entirely in the browser.
   - generateScripts(...): writes a spoken script for each slide, either with
     Claude (user's own API key) or with a simple offline template.
   Exposed on window.Importer; used by app.js.
   ========================================================================= */

(() => {
  const LIBS = {
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    anthropic: 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.6.0/+esm',
  };
  const MODEL = 'claude-opus-5-5';
  const WPM = 130;

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) {
      loaded[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => { delete loaded[src]; reject(new Error(`Could not load ${src} — are you online?`)); };
        document.head.appendChild(s);
      });
    }
    return loaded[src];
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const words = (s) => (String(s).match(/\S+/g) || []).length;

  /* ------------------------------ PPTX --------------------------------- */

  const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  function resolvePath(baseFile, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = baseFile.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop();
      else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }

  async function readXml(zip, path) {
    const f = zip.file(path);
    if (!f) return null;
    return new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  }

  async function readRels(zip, partPath) {
    const dir = partPath.split('/').slice(0, -1).join('/');
    const name = partPath.split('/').pop();
    const doc = await readXml(zip, `${dir}/_rels/${name}.rels`);
    const rels = [];
    if (doc) for (const r of doc.getElementsByTagName('Relationship')) {
      rels.push({ id: r.getAttribute('Id'), type: r.getAttribute('Type') || '', target: resolvePath(partPath, r.getAttribute('Target') || '') });
    }
    return rels;
  }

  function placeholderType(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (n.localName === 'sp' || n.localName === 'graphicFrame') {
        const ph = n.getElementsByTagNameNS('*', 'ph')[0];
        return ph ? (ph.getAttribute('type') || 'body') : 'none';
      }
    }
    return 'none';
  }

  function paragraphText(p) {
    let out = '';
    for (const n of p.getElementsByTagNameNS(A_NS, '*')) {
      if (n.localName === 't') out += n.textContent;
      else if (n.localName === 'br') out += ' ';
    }
    return clean(out);
  }

  async function extractPptx(file) {
    await loadScript(LIBS.jszip);
    const zip = await window.JSZip.loadAsync(file);
    const pres = await readXml(zip, 'ppt/presentation.xml');
    if (!pres) throw new Error('This does not look like a PowerPoint (.pptx) file.');
    const presRels = await readRels(zip, 'ppt/presentation.xml');
    const relById = Object.fromEntries(presRels.map((r) => [r.id, r.target]));

    const slides = [];
    for (const sldId of pres.getElementsByTagNameNS('*', 'sldId')) {
      const rid = sldId.getAttributeNS(R_NS, 'id') || sldId.getAttribute('r:id');
      const path = relById[rid];
      const doc = path && await readXml(zip, path);
      if (!doc) continue;
      if (doc.documentElement.getAttribute('show') === '0') continue; // hidden slide

      let title = '';
      const text = [];
      for (const p of doc.getElementsByTagNameNS(A_NS, 'p')) {
        const t = paragraphText(p);
        if (!t) continue;
        const type = placeholderType(p);
        if (type === 'title' || type === 'ctrTitle') title = title ? `${title} ${t}` : t;
        else if (!['sldNum', 'dt', 'ftr'].includes(type)) text.push(t);
      }

      let notes = '';
      const notesRel = (await readRels(zip, path)).find((r) => r.type.endsWith('/notesSlide'));
      const notesDoc = notesRel && await readXml(zip, notesRel.target);
      if (notesDoc) {
        const parts = [];
        for (const p of notesDoc.getElementsByTagNameNS(A_NS, 'p')) {
          if (placeholderType(p) !== 'body') continue;
          const t = paragraphText(p);
          if (t) parts.push(t);
        }
        notes = parts.join('\n');
      }
      slides.push({ title, text, notes });
    }
    if (!slides.length) throw new Error('No slides were found in this file.');
    return slides;
  }

  /* ------------------------------ PDF ---------------------------------- */

  // A JPEG of the page (about 1280 px wide) for the dress rehearsal.
  async function renderPage(page) {
    try {
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1280 / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    } catch {
      return null;
    }
  }

  async function extractPdf(file) {
    await loadScript(LIBS.pdfjs);
    const pdfjs = window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const slides = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // Group text items into lines by their vertical position.
      const lines = [];
      let cur = null;
      for (const it of content.items) {
        if (!('str' in it)) continue;
        const y = it.transform[5];
        const h = Math.abs(it.transform[3]) || it.height || 0;
        if (!cur || Math.abs(cur.y - y) > Math.max(2, h * 0.5)) {
          cur = { y, size: h, str: '' };
          lines.push(cur);
        }
        cur.str += (cur.str && !cur.str.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
        cur.size = Math.max(cur.size, h);
        if (it.hasEOL) cur = null;
      }
      const texts = lines.map((l) => ({ ...l, str: clean(l.str) }))
        .filter((l) => l.str && !/^\d{1,3}$/.test(l.str)); // drop page numbers
      const image = await renderPage(page);
      if (!texts.length) { slides.push({ title: '', text: [], notes: '', image }); continue; }
      const maxSize = Math.max(...texts.map((l) => l.size));
      const titleIdx = texts.findIndex((l) => l.size >= maxSize * 0.98);
      slides.push({
        title: texts[titleIdx].str,
        text: texts.filter((_, k) => k !== titleIdx).map((l) => l.str),
        notes: '',
        image,
      });
    }
    return slides;
  }

  async function extractSlides(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.pptx')) return extractPptx(file);
    if (name.endsWith('.pdf')) return extractPdf(file);
    if (name.endsWith('.ppt') || name.endsWith('.key') || name.endsWith('.odp')) {
      throw new Error('Please save or export the presentation as .pptx or .pdf first.');
    }
    throw new Error('Unsupported file type. Use a .pptx or .pdf file.');
  }

  /* -------------------------- time planning ---------------------------- */

  // Split the total talk time across slides in proportion to how much is on
  // each slide, with a floor so title/section slides still get some time.
  function planTargets(slides, totalSeconds) {
    const weight = slides.map((s) => 1 + Math.min(words([s.title, ...s.text, s.notes].join(' ')), 120) / 20);
    const sum = weight.reduce((a, b) => a + b, 0) || 1;
    return weight.map((w) => Math.max(15, Math.round((totalSeconds * w) / sum / 5) * 5));
  }

  /* ------------------------ offline generator -------------------------- */

  const TEMPLATES = {
    tr: {
      open: (t) => `Herkese merhaba. Bugün sizlere ${t} hakkında konuşacağım.`,
      openNoTitle: 'Herkese merhaba, hoş geldiniz.',
      next: (t) => `Şimdi ${t} konusuna geçelim.`,
      close: 'Dinlediğiniz için teşekkür ederim. Sorularınızı almaktan memnuniyet duyarım.',
    },
    en: {
      open: (t) => `Hello everyone. Today I am going to talk about ${t}.`,
      openNoTitle: 'Hello everyone, and welcome.',
      next: (t) => `Next, let's look at ${t}.`,
      close: 'Thank you for listening. I am happy to take your questions.',
    },
  };

  const asSentence = (s, lang) => {
    s = clean(s).replace(/^[-•*–]\s*/, '');
    if (!s) return '';
    s = s[0].toLocaleUpperCase(lang) + s.slice(1);
    return /[.!?…:]$/.test(s) ? s.replace(/:$/, '.') : `${s}.`;
  };

  function basicScript(slide, i, n, lang) {
    const T = TEMPLATES[lang.slice(0, 2)] || null;
    const title = clean(slide.title);
    const parts = [];
    if (T) {
      if (i === 0) parts.push(title ? T.open(title) : T.openNoTitle);
      else if (title) parts.push(T.next(title));
    } else if (title) parts.push(asSentence(title, lang));
    for (const t of slide.text) {
      const s = asSentence(t, lang);
      if (s) parts.push(s);
    }
    if (T && i === n - 1 && n > 1) parts.push(T.close);
    return parts.join(' ');
  }

  /* ------------------------- Claude generator -------------------------- */

  const SCHEMA = {
    type: 'object',
    properties: {
      slides: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: '1-based slide number' },
            script: { type: 'string', description: 'What the speaker says while this slide is shown' },
          },
          required: ['index', 'script'],
          additionalProperties: false,
        },
      },
    },
    required: ['slides'],
    additionalProperties: false,
  };

  let clientPromise = null;
  let clientKey = null;
  async function getClient(apiKey) {
    if (!clientPromise || clientKey !== apiKey) {
      clientKey = apiKey;
      clientPromise = import(LIBS.anthropic).then((mod) => {
        const Anthropic = mod.default || mod.Anthropic;
        // The key belongs to the person using this page and stays in their
        // browser, so calling the API directly from the browser is acceptable.
        return new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
      }).catch((err) => { clientPromise = null; throw err; });
    }
    return clientPromise;
  }

  function systemPrompt(langName) {
    return [
      'You write speaker scripts for presentations. The speaker will memorise your script word for word and deliver it aloud while the slides are shown.',
      `Write in ${langName}, in the first person, in natural spoken language: clear sentences of moderate length, no bullet points, headings, stage directions, emojis or markdown.`,
      'Explain and connect the points on each slide rather than reading them out; add short transitions so the talk flows from one slide to the next. Open with a brief greeting on the first slide and close with a thank-you on the last.',
      'Stay faithful to the slide content and speaker notes. Do not invent statistics, names, dates or results that are not given; if a slide is only a title or an image, write a short bridging sentence or two.',
      'Write numbers, abbreviations and symbols the way the speaker should say them only when the spoken form is unambiguous; otherwise keep them as on the slide.',
      'Match the requested length for each slide closely; it is set from the time available for that slide.',
    ].join('\n');
  }

  function userPrompt(slides, targets, opts, onlyIndex) {
    const deck = slides.map((s, i) => ({
      index: i + 1,
      title: s.title || null,
      text: s.text,
      speaker_notes: s.notes || null,
      target_words: Math.max(15, Math.round((targets[i] / 60) * WPM)),
    }));
    const lines = [
      `Presentation: ${opts.title || 'untitled'}`,
      opts.audience ? `Audience and tone: ${opts.audience}` : null,
      `Total time: about ${Math.round(targets.reduce((a, b) => a + b, 0) / 60)} minutes.`,
      '',
      'Slides (JSON):',
      JSON.stringify(deck, null, 1),
      '',
      onlyIndex != null
        ? `Write a new script for slide ${onlyIndex + 1} only (return exactly one item). Make it fit between the slides before and after it.${opts.previous ? ` The current version, which the speaker wants replaced, is: """${opts.previous}"""` : ''}`
        : 'Write a script for every slide, in order, one item per slide.',
    ];
    return lines.filter((l) => l != null).join('\n');
  }

  async function callClaude(apiKey, system, user, maxTokens, onProgress, signal) {
    const client = await getClient(apiKey);
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system,
      messages: [{ role: 'user', content: user }],
    }, { signal });
    let chars = 0;
    stream.on('text', (delta) => { chars += delta.length; onProgress && onProgress(chars); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') {
      throw new Error('Claude declined to write this script' + (msg.stop_details?.explanation ? `: ${msg.stop_details.explanation}` : '.'));
    }
    if (msg.stop_reason === 'max_tokens') throw new Error('The response was cut off. Try fewer slides or a shorter total time.');
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('Claude returned an unexpected response. Please try again.'); }
    return parsed.slides || [];
  }

  function friendlyError(err) {
    const status = err && err.status;
    if (status === 401) return 'The API key was rejected. Check it in Settings.';
    if (status === 403) return 'This API key is not allowed to use the model.';
    if (status === 429) return 'Rate limit reached. Wait a moment and try again.';
    if (status === 529 || status >= 500) return 'The Claude API is busy or unavailable. Try again shortly.';
    if (status === 400) return `The request was rejected: ${err.message}`;
    return err && err.message ? err.message : String(err);
  }

  async function generateScripts(slides, opts, onProgress) {
    const targets = planTargets(slides, opts.totalSeconds);
    const scripts = new Array(slides.length).fill('');
    const source = new Array(slides.length).fill('basic');
    const needs = [];
    slides.forEach((s, i) => {
      if (opts.useNotes && words(s.notes) >= 8) { scripts[i] = clean(s.notes); source[i] = 'notes'; }
      else needs.push(i);
    });

    if (opts.method === 'claude' && needs.length) {
      const maxTokens = Math.min(64000, 4000 + Math.round(targets.reduce((a, b) => a + b, 0) / 60 * WPM * 4));
      const out = await callClaude(opts.apiKey, systemPrompt(opts.langName), userPrompt(slides, targets, opts), maxTokens, onProgress, opts.signal);
      for (const item of out) {
        const i = item.index - 1;
        if (i >= 0 && i < slides.length && needs.includes(i) && item.script) {
          scripts[i] = clean(item.script);
          source[i] = 'claude';
        }
      }
    }
    for (const i of needs) {
      if (!scripts[i]) { scripts[i] = basicScript(slides[i], i, slides.length, opts.lang); source[i] = 'basic'; }
    }
    return { scripts, targets, source };
  }

  async function regenerateSlide(slides, targets, index, opts) {
    const out = await callClaude(opts.apiKey, systemPrompt(opts.langName), userPrompt(slides, targets, opts, index), 6000, null, opts.signal);
    const item = out.find((x) => x.index === index + 1) || out[0];
    if (!item || !item.script) throw new Error('No script came back. Please try again.');
    return clean(item.script);
  }

  window.Importer = { extractSlides, generateScripts, regenerateSlide, planTargets, basicScript, friendlyError, MODEL };
})();
