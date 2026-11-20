# Talk Rehearsal

A browser app for memorising and rehearsing a presentation. It needs no build step and no backend.

## How a practice session works
1. **Learn**: read a sentence and press **Listen** to hear it (text-to-speech).
2. **Hide & recite**: the text is masked (you can turn on first-letter hints). Press the mic or <kbd>Space</kbd> and say the sentence aloud.
3. **Feedback**: each word turns green (said) or red (missed), with a score. The sentence passes at the pass mark (80% by default).
4. **Whole slide**: after the last sentence, recite the whole slide from hint words. A timer compares your time with the slide's target time.
5. A slide counts as mastered once the whole-slide recall passes. The sidebar shows ✓ for mastered slides, ◐ for slides you have started, and ○ for slides you haven't tried.

## Spaced review
Every sentence and whole-slide recall you practise gets a next-review time:
- Missed (below the pass mark): it comes back in **10 minutes**.
- Passed: it comes back after **1 day**, then 2.5 days, about 6 days, and so on (each interval × 2.5).

**Review weak spots** (on the home card, the practice sidebar and the progress page) goes through everything that is due, weakest first, straight in recite mode.

## Pace and filler words
After every spoken attempt you see your **words per minute** and any **filler words**.
- The comfortable pace range is 110–170 wpm, or 85–140 for Turkish.
- Filler words have lists for English, Turkish, German, French, Spanish, Italian, Portuguese and Dutch, e.g. "um", "you know", "yani", "şey", "işte".
- A filler word that is part of your script isn't counted.
- Chrome's speech recognition often leaves out pure hesitation sounds ("um", "eee"), so word fillers like "yani" or "basically" are detected more reliably than sounds.

## Dress rehearsal
**🎤 Rehearse** runs the whole talk in full screen, the way you will give it:
- **What you see:** PDF imports show the real slide images. Other presentations show the slide title and text.
- **Controls:** <kbd>→</kbd>, <kbd>Space</kbd> or a presentation clicker goes to the next slide, <kbd>←</kbd> goes back, and <kbd>H</kbd> shows hint words. The bottom bar shows the slide and total timers against their targets.
- **Listening:** the app listens throughout. Afterwards the report shows the total time, the % of the script recalled, the pace, the filler words, a time-per-slide chart (bar = your time, tick = target), and per-slide recall with a **Practise** button for weak slides.

## Progress and talk date
**Progress** (on each presentation card) shows:
- slides mastered, items due for review, the days you practised, and your last rehearsal's recall,
- charts of mastery by day, rehearsal recall and rehearsal time against the target,
- a table of every dress rehearsal.

**Set the talk date** to get a **daily plan**:
- the unmastered slides are spread over the days left, keeping the last day for dress rehearsals,
- due reviews are added each day, and dress rehearsals are added as the day gets close,
- on the day itself, the plan is one calm rehearsal.

The plan also appears on the home page card.

## Install as an app
When the app is served from `localhost` or `https`, Chrome and Edge show **⤓ Install app** in the top bar.
- Once installed, it opens in its own window and works offline.
- Importing and Claude still need internet the first time; the libraries are cached after that.
- **To use it on a phone**, the app must be hosted on `https`, for example GitHub Pages or Netlify (free). It's a static site, so you just upload the folder. Android Chrome supports the microphone; on iPhone speech recognition is limited, and typing mode works everywhere.

## Import slides and generate scripts
On the home page, click **Import slides (.pptx / .pdf)** and choose or drop a file.

1. **The file is read in your browser.**
   - .pptx: each slide's title, body text, table text and **speaker notes** are read. Hidden slides are skipped.
   - .pdf: the text of each page is read, and the largest line on the page is used as the slide title.
   - Keynote, Google Slides and .ppt files must be exported to .pptx or PDF first.
2. **Set the options:** title, language, total speaking time, and audience and tone.
   - The total time is split across the slides by how much content each slide has. That split gives every slide a target time and a target word count.
3. **Choose who writes the scripts:**
   - **Claude** (`claude-opus-5-5`) writes a natural, connected spoken script for the whole deck in one request. It sticks to the slide content and notes and fits each slide's word target. This needs your own API key (Settings on the home page). The key is stored only in this browser, and requests go straight from the browser to the Claude API.
   - **Simple template** works offline. It turns the slide text into sentences and adds an opening, transitions and a closing (English and Turkish templates). Use it as a rough draft.
   - **Use speaker notes:** if this is ticked, slides with notes of 8 or more words use those notes as their script.
4. **Review:** each slide gets an editable script showing its word count, estimated spoken time and target time.
   - You can rewrite a single slide with Claude, or switch it back to the template draft or the notes.
   - The draft is saved automatically, so a reload doesn't lose it.
5. **Save & rehearse:** this turns the scripts into a presentation and opens practice mode.

**Libraries:** these are loaded from a CDN only when needed: JSZip 3.10.1, pdf.js 3.11.174 and `@anthropic-ai/sdk` 1.6.0. Importing therefore needs an internet connection.

## Script format
```
# Presentation title
## Opening | 0:40
Good morning. Today I will show you…

## Results | 1:15
- Each bullet or sentence becomes one practice step.
```
- If a slide has no target time, it is estimated at 130 words per minute.
- If the script has no `##` headings, each paragraph becomes a slide.
- Sentences longer than 28 words are split at commas or semicolons.

## Run it
Speech recognition needs `http://localhost` or `https`. It usually does not work from `file://`.

- Windows: double-click `start.bat`. It runs `py -m http.server 8000` and opens the browser.
- Or use any static server, e.g. `npx serve .`

**Browsers:**
- Chrome and Edge support both speaking and listening.
- Firefox and Safari have no (or limited) Web Speech recognition, so the app switches to typing mode there. Typing mode is also available everywhere with **Type instead**.
- Chrome's speech recognition sends the audio to Google's servers to transcribe it.

## Matching
- Words are compared after lower-casing in the script's language and removing punctuation, so Turkish İ/ı is handled correctly.
- Small number words are treated as equal to digits ("seven" = "7").
- Matching is fuzzy (≥ 75% letter similarity), so a recogniser mistake or a different suffix still counts as a hit.
- Words are aligned in order using the longest common subsequence.

## Data
- Presentations, progress, review schedule and rehearsal history are stored in `localStorage`, in this browser only.
- PDF slide images are stored in IndexedDB.
- Use **Export** / **Import JSON** to back up a presentation or move it to another device.

## Files
- `index.html`: the page shell
- `styles.css`: styles, with light and dark themes
- `app.js`: rehearsal logic and UI (parsing, speech, matching, import screens)
- `import.js`: .pptx and .pdf extraction (plus page images), time planning, and script generation (Claude or template)
- `features.js`: spaced review, pace and filler words, history, the talk-date plan, and the progress page and charts
- `rehearsal.js`: full-screen dress rehearsal, its report, and slide-image storage
- `manifest.webmanifest`, `sw.js`, `icons/`: installable app and offline support
