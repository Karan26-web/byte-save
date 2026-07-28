# Byte Saves the Day — LBD re-integration, optimisation & test report

Development report. **Not part of the deployed payload** (excluded via `.vercelignore`).

---

## 0. Scope note — how the prompt's inputs mapped onto this repo

The brief's three inputs arrived unfilled (`<FLIPBOOK_FOLDER_PATH>`, `<GAME_FOLDER_PATH>`, `<N>`).
What the repository actually contained:

| Brief | Reality |
|---|---|
| `FLIPBOOK_ROOT` | the repo root itself — `index.html` + `script.js` + `styles.css` + `sfx-data.js` |
| `NEW_LBD_SOURCE` | **no separate folder.** `git status` showed `LBD 1/index.html` and `LBD 2/Right-and-Left/index.html` *modified in the working tree*: fresh game builds had been dropped on top of the already-integrated copies, and the `lbd-complete` wiring present in `HEAD` was gone from both. The "new LBD source" was the uncommitted build already in place. |
| `INSERT_LBD_AFTER_PAGE` | already satisfied — LBD 1 sits after story page 3, LBD 2 after story page 4. |

**Deviations from the brief, and why:**

1. **The games were not moved into `flipbook/game/`.** There are **two** games, and the
   brief's single-game `game/` convention cannot represent two. They stay at `LBD 1/` and
   `LBD 2/Right-and-Left/` (rule 5: preserve existing structure unless a change is
   explicitly required). Each game got its own `embed-bridge.js` and `asset-manifest.json`
   in its own folder, so the bridge contract from Phase 6 is met per game.
2. **"Do not modify the original `NEW_LBD_SOURCE`" could not apply literally** — the new
   build *is* the embedded copy; there is no separate pristine source to leave alone. The
   pre-optimisation originals that *did* exist (the `.mp4`/`.png`/`.mp3` media) are
   preserved untouched in `quarantine/`, and `HEAD` still holds the exact bytes of the
   builds as they were dropped in.
3. **The book had to shrink ~12%** to satisfy Phase 14. See §17.

---

## 1. Project structure discovered

```
index.html          flipbook markup: 3D cover, leaf container, body-level game overlay
styles.css          all styling, the night/tech theme, every animation
script.js           flip engine + page content (the `pages[]` array) + all behaviour
sfx-data.js         two one-shot SFX inlined as base64 for Web Audio on file://
preload.js          NEW — two-stage asset preloader
asset-manifest.json NEW — generated, drives the preloader
assets/             story videos + posters + cover art
sfx/                page-flip / cover-flip one-shots
LBD 1/              game 1, "Byte's Energy Hunt" (single-file build + assets/ + audios/)
LBD 2/Right-and-Left/  game 2, "Right & Left — deliver the parcels"
tools/              DEV-ONLY: server, media optimiser, manifest generator, measurement
tests/              DEV-ONLY: Playwright suite
quarantine/         DEV-ONLY: pre-optimisation source media
```

## 2. Page-indexing logic

`pages[]` in `script.js` is a flat array; `flipped` is the current index; one CSS-3D
`.leaf` is built per entry. "Page N" in the brief = a **visual story page**, which is also
the array index + 1.

| idx | type | content |
|---|---|---|
| 0 | video | `assets/1.webm` — **the first story page** |
| 1 | video | `assets/2.webm` |
| 2 | video | `assets/3.webm` |
| 3 | **lbd** | LBD 1 — immediately after story page 3 |
| 4 | video | `assets/4.webm` |
| 5 | **lbd** | LBD 2 — immediately after story page 4 |
| 6 | end | THE END + Replay |

## 3. Original LBD implementation removed

The previous integration (old `script.js` lines ~283-392) was replaced wholesale:

* `#lbdStage` → `#lbdOverlay`; `.fullscreen` → `.lbd-is-fullscreen`.
* **Removed:** `ensureLbdLoaded()` (loaded the game only on arrival), and the behaviour
  where landing on a game page **jumped straight to fullscreen** — the opposite of the
  required page-frame-then-expand flow.
* **Removed** the assumption, stated in the old comments, that the games autoplay audio on
  load. They do not (§5), which is what makes hidden warm-up possible.
* No second integration is left active: `grep` for `lbdStage`, `positionLbdStage`,
  `.lbd-stage.fullscreen` returns nothing but the intentional historical note.

## 4. New LBD boot flow

Both games are single-file builds whose entire runtime starts from `window.load`.

* **LBD 1** — `audio.init()` creates every `Audio` object (theme, SFX, VO) at load with
  `preload="auto"`; `new GameManager()`; the start screen waits on
  `#startScreen .play-btn`. That click is the only thing that calls `audio.resume()`,
  `audio.startTheme()`, `playVoice('title')` and `game.start()`.
* **LBD 2** — builds the level map and parks Byte at load; a `preloadGate` IIFE holds
  `#startBtn` `disabled` with a spinner until its essential images/audio are decoded
  (6 s hard release). `#startBtn` → `ensureAudio()` → `welcomeThenStart()`, which is where
  music and narration begin.

## 5. Audio-autoplay finding — **both games are silent on boot**

Verified by reading every audio entry point and then by test: a game is booted hidden and
polled for ~4 s across all its DOM media *and* its JS-created `Audio` objects
(`audio.theme` / `audio.files` / `audio.voices`, `bgm`, `VO{}`, `endVideo`); nothing is
ever playing. Consequence: the brief's "silent on boot" branch applies, so the **live
iframe is warmed during idle** rather than merely HTTP-prefetched.

## 6. Start-button hook

`document.addEventListener("click", handler, true)` — capture phase on the *document*, not
the button. Capture on the document is strictly stronger than capture on the button here:
during the AT_TARGET phase listeners fire in registration order regardless of the capture
flag, and the bridge loads *after* the game, so a button-level listener would run second —
after LBD 1's `begin` has already removed itself and hidden the start screen.

Guards: `e.isTrusted` (never a synthetic/preload click), button not `disabled` (LBD 2's
preload gate), start screen not already hidden (game not already running), and once per
session.

## 7. Completion flow

The real success paths, found by reading the code rather than watching for a final screen:

* **LBD 1** — `GameManager.win()` reveals `#win` and plays `audio.voices.byteSaved`
  ("Byte saved the day!"). The bridge **wraps `win()`** so completion can only ever be
  reached from the genuine success function — never from a failed level, a restart or a
  pause.
* **LBD 2** — `endGame()` → cloud sweep → `#endScreen` + the 33 s celebration video →
  `revealEndBtn()` awaits `voSay("byte-saved-the-day")` and only then reveals `#endBtn`.

**`lbd-complete` fires when the learner taps the game's final Next button, and that button
is itself gated behind the closing narration.** This satisfies "wait for the real `ended`
event" while preserving the celebration: auto-posting the instant the 2.5 s line ended
would have cut LBD 1's 5 s confetti and LBD 2's 33 s video mid-play. The parent still
advances *automatically* on receiving the message — the learner never taps a flipbook
control to continue.

## 8. Final voice-over handling

| | LBD 1 | LBD 2 |
|---|---|---|
| closing line | `Byte Saved the Day.ogg` (2.51 s) | `Byte Saved the Day.ogg` (2.51 s) |
| success path | `ended` | `ended` |
| error path | `error` listener | `voSay`'s `play()` rejection handler |
| watchdog | `duration + 4 s`, or 30 s if duration unknown | `voSay`'s own 4 s net |
| extra net | — | 40 s `MutationObserver` net that force-reveals `#endBtn` if the finale stalls |

Until one of those fires, LBD 1's Next is held inert (`opacity:0; pointer-events:none;
disabled`); a tap during that window is swallowed and asserted not to advance the story.

## 9. Files added

| File | Purpose | Ships? |
|---|---|---|
| `preload.js` | two-stage byte-aware preloader + shell loading bar | ✅ |
| `asset-manifest.json` | generated Stage A/B manifest | ✅ |
| `LBD 1/embed-bridge.js` | bridge + idle asset warmer | ✅ |
| `LBD 1/asset-manifest.json` | LBD 1 warm-up list | ✅ |
| `LBD 2/Right-and-Left/embed-bridge.js` | bridge + idle asset warmer | ✅ |
| `LBD 2/Right-and-Left/asset-manifest.json` | LBD 2 warm-up list | ✅ |
| `assets/1-4.webm`, `assets/posters/1-4.webp`, `assets/coverpage.webp`, `assets/play button.webp`, `sfx/*.ogg` | optimised media | ✅ |
| `tools/server.js` | Range-capable dev server | ❌ |
| `tools/convert-media.js` | media optimiser + validator | ❌ |
| `tools/gen-manifest.js` | manifest generator | ❌ |
| `tools/gen-sfx-data.js` | regenerates the inlined base64 SFX | ❌ |
| `tools/measure.js` | before/after measurement harness | ❌ |
| `tests/*.spec.js`, `tests/helpers.js`, `playwright.config.js`, `package.json` | test suite | ❌ |
| `.vercelignore`, `.gitignore` | deployment / VCS hygiene | ❌ |

## 10. Files modified

* **`index.html`** — shell loader markup; overlay renamed and given `src="about:blank"`,
  a generic `title`, `allow="autoplay; fullscreen"`; `preload.js` added before `script.js`.
* **`styles.css`** — Phase 14 control geometry; shell-loader theme + pop-in; overlay
  fullscreen class with `100dvh` + `@supports` fallback; page-windowing and
  backface/ghost rules; dead-rule removal (§11).
* **`script.js`** — see §§3-8, 14-19. Also: `bgMusic` `preload="auto"` → `"none"`
  (it was pulling 3.8 MB during boot for a track that cannot legally play until the
  learner taps Play); SFX fallbacks → `preload="none"`; `fitScale()` reworked.
* **`sfx-data.js`** — regenerated from the Ogg/Opus one-shots (138.6 KB → 37.5 KB).
* **`LBD 1/index.html`** — debug bar (CSS + markup + handlers) and the `jumpToLevel`
  god-mode method removed; leftover `window.game` global removed; `window.__lbd` +
  `lbd:boot` added; bridge `<script>` loaded last; two dead VO filenames fixed (§11).
* **`LBD 2/Right-and-Left/index.html`** — `?auto=` self-play driver, `?map=`/`?dogtest=`
  previews and the `?lvl=` level-skip removed; commented-out `screen.js` tag removed;
  `window.__lbd` (+ read-only `levelIdx`/`runActive`/`awaitingPick`) added; bridge loaded
  last; missing `byte-delivery-mission.ogg` reference removed (§11).

## 11. Files removed or quarantined

**Deleted**

* `LBD 2/Right-and-Left/screen.js` — dev-only screen navigator (its `<script>` was already
  commented out). Verified no runtime code referenced it.
* `LBD 1/.gitignore`, `LBD 2/.gitignore`, `LBD 2/Right-and-Left/.gitignore` — superseded by
  the root ignore files; one still listed a `debug.js` that no longer exists.

**Quarantined to `quarantine/`** (kept for reference, never deployed)

`assets/1-4.mp4`, `assets/coverpage.png`, `assets/play button.png`,
`sfx/Page flip.mp3`, `sfx/cover page flip.mp3`,
`LBD 2/Right-and-Left/Assets/Start.png` (unreferenced duplicate of the cover art).

**Dead code removed**

* CSS: `.page-base`, `.bookplate`, `.end-note`/`.book.at-end`, `.cover .subtitle`,
  `.cover-photo`/`.tape`, `.cover .back .name-line`, `.toolbar`/`.progress`, and the
  `.bubble.neel` / `.bubble.everywhere` artwork rules (which pointed at two bubble images
  that were never shipped). Custom properties `--accent`, `--cover-edge`, `--tape`.
  A selector audit now reports **0 unused selectors of 91** and **0 unused custom
  properties**.
* JS: the title-voice-over block (pointed at `sfx/the story night.ogg`, never shipped — a
  guaranteed 404 plus a rejected `play()` on every load); the `assets/hand-nudge.png`
  `<img>`-then-fallback dance (that art was never shipped either, so every load spent a
  404 to reach the same emoji).

**Broken references repaired** — all six baseline 404s plus three found later:

| Reference | Fix |
|---|---|
| `assets/posters/{1..4}.webp` ×4 | **generated** from each clip's frame 0 |
| `assets/hand-nudge.png` | reference removed (emoji hint drawn directly) |
| `sfx/the story night.ogg` | reference removed (feature was dead) |
| `LBD 1` `Byte_s Energy Hunt.ogg` | repointed to `Energy Hunt.ogg`, the shipped title sting that was sitting on an unused key |
| `LBD 1` `Near and Far.ogg` | not in the pack — key + call removed, wipe plays silently |
| `LBD 2` `byte-delivery-mission.ogg` | not in the pack — removed from the VO list, the call and the preload gate |

## 12. Media conversion results

Encoder settings, and every validation gate, are recorded in `media-size-report.json`.
Each output had to decode under `ffprobe`, keep its source dimensions, stay within 0.35 s
of source duration, and be **strictly smaller** — or it was deleted and the original kept.

| Type | Source | Output | Saved |
|---|---|---|---|
| video (4 clips) | 41.20 MB | 14.91 MB | **−63.8 %** |
| image (2 files) | 3.19 MB | 0.20 MB | **−93.8 %** |
| audio (2 one-shots) | 0.10 MB | 0.03 MB | **−72.7 %** |
| **total** | **44.48 MB** | **15.13 MB** | **−66.0 %** |

* **Video** — WebM, VP9 + Opus, `-pix_fmt yuv420p`, **constrained quality**: `-crf 32`
  with `-b:v` capped at 75 % of the source *video* bitrate. All four passed on the first
  attempt, so the two-pass 70/60/50 % ladder never had to run.
  Fidelity spot-check: `1.webm` vs `1.mp4` scores **SSIM 0.986** (Y 0.985), and a
  side-by-side frame at t=20 s shows identical text crispness and colour.
* **Audio** — Ogg/Opus, `-vbr on`: 96 kbps for the stereo page-flip whoosh, 64 kbps for
  the short mono cover-flip. Both are *also* inlined as base64 in `sfx-data.js`, which was
  regenerated from the Opus files with the MIME type corrected to `audio/ogg`.
* **Images** — WebP `-quality 82/85`, `-compression_level 6`, original pixel dimensions,
  alpha preserved on the transparent play-button art.
* **Posters** — 4 new WebP stills (frame 0 of each clip, 1280×720, 283 KB total). Because
  a poster *is* where playback starts, there is no jump when the video begins.

**Browser support:** WebM/VP9, Ogg/Opus and WebP are supported by Chrome, Edge, Firefox
and Safari 15+ (macOS 12+ / iOS 15+). Noted in `script.js`, `sfx-data.js` and the report.

## 13. Unavoidable conversion exceptions

**None.** Every conversion passed validation and every output is smaller than its source.
`LBD 2/Right-and-Left/Assets/Video/Lastscreen.webm` was already WebM/VP9/Opus and was left
alone; the games' art and VO were already WebP/Ogg.

## 14. Asset preload architecture

Two stages, and only the first can delay the Start button.

**Stage A — blocking shell (10 files, 0.84 MB)**
The cover art, the play button, **all four video posters**, both SFX one-shots, and the two
game-page intro posters. Queued **smallest-first**, ~5 concurrent, each with a 20 s abort
timeout.

> Deliberately **no html/css/js**: those are render-blocking resources the document requests
> for itself while parsing, so by the time `preload.js` executes they are already loaded and
> re-fetching them was a pure duplicate request (§21).

Progress is byte-aware: real on-disk sizes from the manifest, refined by `Content-Length`
when it differs, advanced by bytes actually pulled from a streaming `fetch()` reader, and
clamped monotonic. The Start button is `display:none` until 100 %, then pops in.

> **No `.webm` is in Stage A.** Every video page paints its own frame-0 poster instantly
> and the clips stream over Range requests, so blocking Start on a 5 MB download would add
> seconds of dead wait *and* regress the shell against baseline. Page 1's clip is the first
> Stage B item and is additionally warmed to `preload="auto"` the moment the book opens.

**Stage B — non-blocking (149 files, 37.21 MB)**
Kicked off from the flipbook's own `window.load` handler via `requestIdleCallback`
(`setTimeout` fallback for Safari), two starts per idle slice. Ordered:
`themeMusic.ogg` (needed the instant the book opens) → the four story videos in page order
→ both games' bulk. Uses the exact URLs the iframe will request, so the game's own request
is a cache hit. No Blob swapping in Stage B — nothing inside the iframe consumes parent
Blob URLs.

**Stage B, iframe half** — `warmLbd()` boots the *upcoming* game into the hidden overlay
during idle after `window.load`, so the learner arrives at a live, already-painted intro.
One iframe serves both games; after LBD 1 completes, the re-warm targets LBD 2.

**Inside each game** — `embed-bridge.js` runs an idle chunked warmer ~1 s after its intro
paints: **3 images / 2 audio / 4 bulk files per idle slice**, deduplicated, from that
game's generated manifest. Level backgrounds, VO filenames and `houseFile(colour, variant)`
paths are all built dynamically at runtime, so a static generated manifest is the only
reliable way to cover sprites that only ever appear in `display:none` later levels. Audio
is warmed through the game's **own** `Audio` objects (`preload="auto"` + `load()`, never
played) *and* `fetch()`ed for whole-file HTTP caching.

**Never blocked:** a failed, aborted, unsupported, stalled or `file://`-blocked request
counts as *complete* for progress and leaves the original URL in place. Plus a 25 s hard
cap that reveals the button regardless, and immediate reveal if the manifest itself cannot
be read.

## 15. Blob fallback behaviour

Where a Stage A fetch fully succeeded and the manifest marks the asset `blobOk`, the bytes
are handed to the real element as a Blob URL so the file is not downloaded twice. Each swap
stores `data-originalSrc`, registers a **one-time** `error` listener that restores the
original URL, calls `load()`, restores `currentTime` and resumes playback if the element
was playing. Audio elements fed by the preloader are set to `preload="none"` first so the
element does not start a parallel download of the same file. `blobOk` is `false` for
everything under `LBD 1/` and `LBD 2/`.

## 16. GPU / windowing changes

* **Page windowing** — `applyPageWindow()` keeps only `flipped ± 1` renderable (a turn only
  ever involves `flipped` and its neighbours), plus any leaf mid-turn. Everything else gets
  `.is-far` → `visibility:hidden; will-change:auto; pointer-events:none`, handing the GPU
  layer back. `visibility`, **not** `display:none`, because the leaf stack's geometry and
  z-ordering are what position the page.
  Re-windowed from `updateZ()` — which every state change funnels through (page arrival,
  turn completion, drag release, Home, Replay, peek cancel) — plus explicitly on resize and
  orientation change.
  Measured at page index 2: leaves 1-3 `visible`/`will-change:transform`, leaves 0 and 4-6
  `hidden`/`will-change:auto`.
* **Ghost layers** — `backface-visibility:hidden` (+ `-webkit-`) on `.page-media`,
  `.bubble`, `.sbub` and `.end-page-inner`, and `.leaf.flipped:not(.flipping) .face.front >
  *` hard-hides the children of a face that has turned away. A child with its own filter or
  animation gets its own compositing layer, which some engines keep painting even when the
  parent face is backface-hidden — that is the classic "ghost text above an unrelated page"
  bug. `:not(.flipping)` keeps the change off-screen during the turn itself.

## 17. Navigation control implementation

Exactly the required geometry, verified by measurement rather than by reading the CSS:

| | Back | Next | Home |
|---|---|---|---|
| box | `clamp(84px,10vw,124px)` | same | same |
| anchor | `bottom: clamp(-10px,-0.5vh,-2px)` / `left: clamp(12px,2.5vw,34px)` | same `bottom` / `right: clamp(12px,2.5vw,34px)` | `top: clamp(-12px,-0.9vh,-4px)` / `right: clamp(8px,1.6vw,22px)` |
| z-index | 700 | 700 | 720 |
| glyph fill | 62 % | 62 % | 65 % |

Shared: hidden by default, revealed only after the experience starts, `display:flex`,
centred, `opacity .96`, 400 ms fade, `cursor:pointer`, hover `scale(1.12)`, active
`scale(0.9)`, 150 ms transform transitions, selection and iOS long-press suppressed, focus
ring removed while remaining real `<button>`s with `aria-label`s. Disabled →
`opacity:.22; pointer-events:none` plus the real `disabled` property and `aria-disabled`.
Back is **mirrored on the nested `<svg>`** (`scaleX(-1)`), so the button's hover/active
scale composes with the mirror instead of overwriting it — asserted in both states.

> **The book had to shrink.** The controls went from 52-70 px to 84-124 px, and at
> 1366×768 the enlarged Next and Home glyphs overlapped the content frame's corners by
> ~33×34 px and ~23×32 px. `fitScale()` now derives its reserved margin from the same
> `clamp(84px,10vw,124px)` the CSS uses (times 0.82, since only the centred glyph is
> visible, plus `.book-frame`'s 16/42 px outsets) instead of a fixed `CTRL = 64`. Net
> effect at 1366×768: book scale 0.853 → 0.740, content frame `197,106 → 1188,662`.
> Measured result: all three glyphs clear the frame, and Home sits fully above **and**
> right of its corner.

**Both arrows anchor to the BOOK on both axes** — the current rule, superseding the
viewport-edge offsets in the table above. Vertically, `--book-bottom + --nav-gap` drops them
into the reserved gutter below the book. Horizontally, `--gutter-l` / `--gutter-r` (the clear
room outside the book's visible box, published by `fitScale()`) line each arrow's outer edge
up with the book's matching edge, so each one sits directly **below the book's bottom corner**
instead of stranded out in the empty screen margin — which is what viewport-edge anchoring did
on any viewport wider than the book. `--nav-edge-x` is the floor (safe-area insets), and
`calc(50% - var(--nav-btn))` is the cap, so the pair can never cross the centre line and
collide. `nav-layout.spec.js` asserts the alignment across all nine acceptance viewports plus
both browser-zoom levels; measured at 1366×768 the arrows land at x 175–237 and 1149–1211
against a book spanning 175–1211.

**First story page**, per the appended rules: Back is `display:none !important` (absent,
not faded — there is no previous page, the cover is not one). Next is absent until
`firstPageVideoCompleted && firstPageInteractionCompleted`; `updateNavControls()` toggles
`.is-visible`, `disabled` and `aria-hidden` exactly as specified.

**Game pages** follow the same absent-until-open rule (`nextArrowHiddenWhileLocked()`):
completing the game is the only route forward, so a visible-but-dead arrow there would read
as a way to skip it. On the remaining video pages Next is present but disabled until that
page's video finishes. Back stays usable while a page video plays.

**Revisits are free.** A page whose gate has been satisfied once is recorded in
`clearedPages` and arrives unlocked on every later visit, so paging back shows both arrows
live immediately instead of making the learner sit through the video (or replay the game)
a second time. `resetToStart()` empties the set, so a fresh read from the cover gates
every page again.

## 18. Video-gating implementation

One state guard, `canNavigateForward()`, consulted by **every** forward route: the Next
arrow, `ArrowRight`, pointer drag/swipe, the clickable page corner, and every programmatic
turn (`Flipbook.goNext()`). Disabling the visible button is never the only lock — each
route is probed independently in the suite.

* Re-armed on **every** arrival, including arriving backwards. A page listed in
  `clearedPages` (its gate was satisfied earlier in this read) arms already-open; anything
  else arms locked rather than inheriting a stale unlock from a different page.
  `disarmForwardGate()` drops the previous page's listeners and timers first, so a watchdog
  armed on page 2 can never unlock page 3.
* Three release paths, always: `ended`, `error`, and a watchdog of `duration + 4 s`
  (30 s when duration is unknown, re-armed from `loadedmetadata` once the real duration
  arrives so a long clip is not cut off at 30 s). An element that *already* errored before
  the listener attached is caught by checking `v.error` directly.
* Pages with no video are never gated *by the video gate*. A page can also declare
  `interactive: true`, adding a second requirement satisfied only by
  `Flipbook.markInteractionComplete()` — stray taps do not count. Every `lbd` page counts as
  interactive whatever its config entry says (`pageHasInteraction()` derives it from the
  type), so a newly added game page can never ship with an open gate; `exitLbd()` satisfies
  it from the game's own `lbd-complete` message.
* `animating` doubles as the one-page-per-turn lock (set synchronously in `goNext`), so a
  double- or triple-tap advances exactly one page.
* Bug found and fixed: the previous page's one-shot "turn the page" arrow cue survived the
  page change, and a CSS animation outranks the `[disabled]` opacity rule — so a *locked*
  Next arrow kept pulsing at full brightness, reading as available. `armForwardGate()` now
  calls `stopNextPulse()` and clears `blink`.
* The cue itself is now a **glow pulse** (`.corner-arrow.glow-pulse` → `nextGlowPulse`,
  3 × 600 ms of a neon-cyan halo plus a matching scale, then back to the resting state). It
  replaced the old opacity-dipping `blink1`, which read as *disabled* on the very button it
  was advertising. It is fired from `releaseVideoGate()` / `markInteractionComplete()` — the
  instant the arrow really becomes available — not from the video's own `ended` listener,
  which races the gate's and could fire while the button was still hidden. `pulseNextArrow()`
  refuses to animate a hidden or disabled arrow, and runs once per page arrival.

## 19. Playwright test results

**46 / 46 passing at 1366×768 · 43 / 43 passing at 844×390.**

Run against the local **Range-capable** dev server (`tools/server.js`, 206 verified before
browser testing — never `file://`), at **1366×768** and at **844×390** (narrow mobile-like
landscape; the book is landscape-locked, so a portrait viewport would only ever show the
rotate gate). The narrow viewport runs 43 of the 46 — the three multi-minute playthrough
tests are layout-independent and would only double an already long run.

Highlights from the final run:

* **LBD 2 played for real, end to end** — 31 answers across all 8 rounds (including retries
  on the three practice levels), then the celebration video, the closing narration, NEXT,
  `lbd-complete`, and an automatic turn to THE END page.
* **Stage A progress**, throttled to 350 kbps: `0 → 6 → 12 → 19 → 20 → 27 → 28 → 29 → 41 →
  59 → 81 → 100` — twelve distinct byte-driven steps, monotonic throughout.
* **Zero console errors and zero failed requests** on the 7-page crawl at *both* viewports,
  and across the full LBD 2 playthrough.
* **Control geometry measured, not assumed.** At 844×390: frame `221.9,80.3 → 630.0,309.7`;
  Back glyph `37.1→89.4`, Next glyph `754.5→806.9`, Home glyph `760.9→815.7 × 10.8→65.6` —
  every one clear of the frame, Home above *and* right of its corner. Control boxes measure
  84.4 px (`clamp(84px,10vw,124px)` at 844 px wide) with 62 % / 65 % glyph fills.
* **24 screenshots** written to `screenshots/` (12 per viewport) and reviewed.

One test failed in the first pass of the final run and was fixed: the Stage-A bypass test
throttled to 60 kbps, where the ~117 KB of head resources ahead of `preload.js` take longer
to arrive than the wait allowed — a limit I had just introduced myself by adding
`actionTimeout: 30000` to the config. Re-tuned to 150 kbps (Stage A still ≈46 s, so it is
genuinely still in flight while the four bypass routes are attacked) with an explicit 60 s
wait; passes at both viewports.

`tests/` contents:

| Spec | What it covers |
|---|---|
| `loading.spec.js` | Stage A loader, monotonic byte-aware progress, pop-in, bypass attempts, failed-fetch resilience, small-before-large ordering, Stage B timing |
| `nav.spec.js` | control geometry + glyph/frame overlap, cover state, first-page Back absence, last-page state, mirroring under hover/active, disabled styling, accessibility, return-to-cover |
| `nav-layout.spec.js` | the geometry matrix: nine acceptance viewports + two zoom levels — no clipping, no book overlap, no arrow-on-arrow overlap, the `0.35 x --nav-btn` gutter, and book-corner anchoring on both axes; plus a live resize and the page-turn hint's book-edge glue |
| `gating.spec.js` | every video page locked; **all five** forward routes blocked; broken-video `error` path; stalled-video watchdog; cleared pages stay unlocked on revisit (both arrows live) while un-cleared pages stay gated; the game page's absent Next + all five routes blocked until completion; the one-shot glow pulse; Replay re-gating; the first-page dual gate in all four combinations |
| `lbd.spec.js` | hidden silent warm-up, dev-tool absence, idle asset warming, page-frame reveal, `lbd-start`→fullscreen, no reload during expansion, playability, narration-gated completion, auto-advance, teardown/re-warm, leave-before-start, Home, Replay, LBD 2 full playthrough, focus |
| `crawl.spec.js` | all 7 pages: JS errors, response codes, image `naturalWidth`/`complete`, posters, video error state, gate release, nav state, screenshots + blank/uniform-colour detection; GPU windowing; ghosting |
| `smoke.spec.js` | fast boot diagnostic (not an acceptance test) |

**Things the suite found, which were then fixed in the product** (not test-only fixes):

1. The Stage A bar reported **100 % immediately**. The initial `paint()` ran before the
   manifest resolved, so `totalBytes === 0` was rendered as 100 % and pinned the monotonic
   guard at the top — defeating byte-aware progress entirely. Now progress is only computed
   once the total is known. Verified: `0 → 1 → 2 → … → 29 → 100`.
2. A **locked Next arrow kept pulsing at full brightness.** The previous page's `blink1`
   "turn the page" cue survived the page change, and a CSS animation outranks the
   `[disabled]` opacity rule, so a disabled control read as available. `armForwardGate()`
   now clears `blink`/`blink1`.
3. **Next could reappear on the cover.** After Home from the first story page,
   `firstPageVideoCompleted` kept its `true` value, so `updateFirstPageNextArrow()` still
   saw both requirements met. `disarmForwardGate()` now clears both flags, and
   `updateNavControls()` hides all three controls unconditionally when `!opened`.
4. **Three shipped-broken asset references** surfaced by the zero-404 assertion:
   `LBD 1` `Byte_s Energy Hunt.ogg`, `LBD 1` `Near and Far.ogg`, and
   `LBD 2` `byte-delivery-mission.ogg` (§11).

Test-harness bugs fixed along the way, recorded for honesty: `waitForSelector("#lbdFrame")`
defaults to waiting for *visibility*, which can never happen for a deliberately hidden
warm-up iframe (now resolved via `page.frames()`); `settle()` returned while `animating` was
still true, so the next click was correctly swallowed; and the GPU mid-turn test clicked a
legitimately disabled Next.

## 20. Console and network results

**Zero JavaScript console errors and zero unexpected 4xx/5xx**, asserted per page across the
full 7-page crawl and again over LBD 2's complete playthrough. Both games were also booted
standalone and played, each reporting **no failed requests**.

The baseline had **6 console errors / 6 failed responses** on every single load; all six are
gone (§11).

Expected-and-asserted exceptions: the deliberately broken-video and stalled-video gating
tests intentionally abort a request, and the "failed shell fetches" loader test aborts two
Stage A assets. Those tests assert the learner is *not* blocked, which is the point.

## 21. Baseline versus final measurements

Both columns measured by the **same harness** (`tools/measure.js`), at 1366×768, against the
same Range-capable server with the same caching policy. "Baseline" is a `git worktree` at
`HEAD` — the original flipbook with the original `.mp4`/`.png`/`.mp3` media. Timing figures
are the **median of 3 runs** (single samples on a local server are noisy — one final run
showed 544 ms DCL and the next 298 ms).

| Metric | Baseline | Final | Δ |
|---|---|---|---|
| initial requests | 21 | **19** | −2 |
| initial transferred bytes | 7.66 MB | **1.13 MB** | **−85.2 %** |
| DOMContentLoaded | 285 ms | 306 ms | +21 ms (+7 %) |
| window load | 496 ms | **332 ms** | **−164 ms (−33 %)** |
| cover usable | ~1 ms | 67 ms | +66 ms |
| **Start button available** | 0 ms | **1 ms** | **unchanged** |
| console errors | **6** | **0** | −6 |
| failed responses (4xx) | **6** | **0** | −6 |
| landing on game page → intro interactive | n/a | **13 ms** | — |
| deployed payload | 69.02 MB | **38.76 MB** | **−43.8 %** |

Payload by type (deployed, i.e. after `.vercelignore`):

| Type | Baseline | Final | Δ |
|---|---|---|---|
| video | 46.34 MB | 20.05 MB | −56.7 % |
| image | 15.92 MB | 11.80 MB | −25.9 % |
| audio | 5.84 MB | 5.98 MB | +2.4 % |
| code | 0.93 MB | 0.94 MB | +1.1 % |
| **total** | **69.02 MB** | **38.76 MB** | **−43.8 %** |

**Reading these numbers honestly:**

* **The Start button's readiness is unchanged** — 0 ms vs 1 ms measured from `window.load`.
  Stage A is only 0.84 MB, so on a fast connection it completes inside the load window. The
  gate is real and does hold the button: under 350 kbps CDP throttling `loading.spec.js`
  observes the bar climb `0 → 1 → 2 → … → 29 → 100` before the button appears, and four
  separate bypass routes are proven not to open the book early.
* **`window load` improved by a third** almost entirely because `bgMusic` no longer carries
  `preload="auto"`. The baseline pulled the **3.84 MB** theme track during boot for a
  track that cannot legally play until the learner taps Play.
* **DOMContentLoaded is ~21 ms slower** — `preload.js` is one extra parser-blocking script.
  That is the honest cost of the loading bar, and it is inside run-to-run noise.
* **`cover usable` went from ~1 ms to 67 ms.** This is a measurement artifact, not a
  regression a learner can perceive: the metric decodes the CSS background URL into a fresh
  `Image()`, and the baseline's PNG was already in the *decoded* image cache from its CSS
  use. Both are far below one frame's worth of budget and the cover paints from CSS either
  way.
* **The audio total rose 0.14 MB** — not a conversion regression. The new game builds added
  three files that did not exist at `HEAD` (`Byte Saved the Day.ogg` ×2 and
  `confettiSound.ogg`). My conversions reduced audio by 72.7 %.
* **Payload −43.8 % vs media −66 %.** The whole-payload figure includes ~24 MB of the games'
  own art and narration, which was already WebP/Ogg and was correctly left alone. The 66 %
  figure in §12 is the media I actually converted.
* **No asset is downloaded twice.** Two duplication bugs were found by inspecting the
  measured request list and fixed: html/css/js were in Stage A even though the document
  requests them itself while parsing, and images were fetched with `fetch()` in parallel
  with the document's own CSS-background / `poster` requests, so neither could serve the
  other from cache. Stage A now contains no self-loaded code, and images are warmed through
  the browser's **image cache** (`new Image()` + `decode()`), which the CSS background and
  `poster` attribute share. Initial transfer fell 2.14 MB → 1.13 MB as a result.
  *Deviation noted:* the brief asks for streaming `fetch()` readers throughout; they are
  used for audio/video (where nothing else requests the file, so there is no duplication and
  per-byte granularity is real), while images are credited their full manifest weight on
  decode. Progress stays byte-weighted and monotonic either way.
* **The learner never waits on the game.** By the time the game page is reached, 60-100 of
  its requests have already been served during idle and `lbd-ready` has arrived, so
  landing → interactive is **~13 ms**. Requests continuing afterwards are the bridge's idle
  warmer still filling the cache for later levels; they block nothing.

## 22. Remaining known limitations

1. **Blob-URL replacement is implemented but currently dormant.** Stage A deliberately
   contains no `<video>`, and the two SFX are `new Audio()` objects that never enter the DOM
   (they are fallbacks; the normal path is the inlined base64 via Web Audio). So there is no
   element for `attachBlob()` to swap. The swap, the stored original URL, the one-time
   `error` fallback with playback-state restore, and blob revocation are all implemented and
   reviewed, but **not exercised by a test** — I am not claiming that path as verified. It
   activates automatically if a future page puts a DOM media element in Stage A. Requesting
   blob bytes is now also restricted to media types so images are not buffered twice.
2. **`window.__lbd` is a deliberate, minimal integration handle.** The bridge needs the real
   Play button and (for LBD 1) the real `win()` function to wrap — wrapping the genuine
   success path is what stops completion being guessed from a visible screen. It is not a UI
   cheat surface: nothing is discoverable on screen, unlike the `D`-key level-jump bar that
   was removed. A user with a devtools console could still call it; for a children's
   learning flipbook that is an acceptable trade for a correct handshake.
3. **LBD 1's nine level variants are not each played.** Its completion test drives the real
   `win()` rather than tapping through the tutorial plus eight energy cells (several minutes
   of animation per run). Its playability is asserted separately (pods spawn, narration
   plays), and its hidden-level *assets* are asserted warm. **LBD 2 is played for real,
   round by round, through its complete flow.**
4. **Google Fonts remain external and render-blocking** — three cross-origin requests
   (~60 KB) on the critical path, which the manifest cannot cover. Self-hosting them would
   remove two DNS/TLS handshakes from first paint. Not requested, so not changed.
5. **LBD 1 preloads its own audio pack eagerly.** `audio.init()` creates ~21 `Audio` objects
   with `preload="auto"` at boot. That is warming we want, but it does partly bypass Stage
   B's ordering, so `warmLbd()` is delayed 2 s after `window.load` to let the theme and
   story videos queue first. The brief warns against broad rewrites of the games' audio
   architecture, so the game's own behaviour was left alone.
6. **The book is ~12 % smaller than before** at 1366×768. This is a direct, unavoidable
   consequence of the mandated 84–124 px control boxes (§17), not a regression.

---

## 23. Acceptance checklist

| # | Item | Status |
|---|---|---|
| 1 | New LBD copied into the flipbook | **Adapted** — the new builds were already in place as `LBD 1/` and `LBD 2/Right-and-Left/`; not collapsed into a single `game/` because there are two games (§0) |
| 2 | Original LBD source folder untouched | **N/A as written** — no separate pristine source exists; the pre-optimisation media originals are preserved in `quarantine/`, and `HEAD` holds the builds as dropped in (§0) |
| 3 | Previous embedded LBD fully removed | ✅ old overlay, `ensureLbdLoaded`, straight-to-fullscreen behaviour and `.fullscreen` class all gone; no competing integration (§3) |
| 4 | LBD inserted immediately after page `<N>` | ✅ LBD 1 after story page 3, LBD 2 after story page 4 |
| 5 | Body-level iframe outside transformed ancestors | ✅ direct child of `<body>`; asserted true fullscreen fills the viewport |
| 6 | Flipbook shell is the only blocking application | ✅ Stage A = 10 files / 0.84 MB, no game code |
| 7 | Start button waits only on Stage A shell assets | ✅ and 4 bypass routes proven blocked |
| 8 | LBD warms in the background | ✅ idle after `window.load` (+2 s), verified booted before arrival |
| 9 | Hidden LBD is silent | ✅ polled across DOM media *and* the games' JS `Audio` objects |
| 10 | Hidden-level sprites + later audio warmed | ✅ `Background8.webp`, a late VO line and the closing VO all asserted requested during idle |
| 11 | LBD intro appears instantly on landing | ✅ landing → interactive **13 ms**, no spinner |
| 12 | Play/"Let's Go" sends `lbd-start` | ✅ capture-phase hook, trusted-event guarded |
| 13 | Smooth expansion page frame → fullscreen | ✅ 400 ms box-morph; overlay matches the page frame before Play, viewport after |
| 14 | Flipbook controls disappear in fullscreen | ✅ all three `display:none` asserted |
| 15 | Completion waits for final narration | ✅ Next held inert; an early tap asserted not to advance |
| 16 | `lbd-complete` returns to the flipbook | ✅ both games |
| 17 | Flipbook advances automatically after completion | ✅ |
| 18 | Leaving kills all audio and timers | ✅ `about:blank` teardown, asserted silent |
| 19 | Revisiting starts instantly from a fresh intro | ✅ asserted start screen shown, win splash gone |
| 20 | Home/Close/Replay/Reset clear the overlay | ✅ Home and Replay asserted. **Note:** this flipbook has no separate Close/Reset control — Home *is* that route |
| 21 | Videos use WebM where validation passed | ✅ 4/4 |
| 22 | Audio uses Ogg/Opus where validation passed | ✅ 2/2 (+ base64 regenerated) |
| 23 | Images use WebP where validation passed | ✅ 2/2 (+ 4 new posters) |
| 24 | No converted output larger than its source | ✅ enforced by the converter; 0 exceptions |
| 25 | All live media references updated | ✅ plus 6 pre-existing broken refs repaired |
| 26 | Progress byte-aware and monotonic | ✅ `0 → 1 → … → 29 → 100` under throttling |
| 27 | Failed preloads never trap the learner | ✅ aborted + 500 shell assets still reach 100 % |
| 28 | Blob media has original-URL error fallback | **Implemented, not exercised** — see §22.1. Not claimed as verified |
| 29 | GPU page windowing active | ✅ measured per-leaf |
| 30 | No blank textures or ghost overlays | ✅ 12 screenshots inspected + programmatic uniform-colour check + a DOM ghost assertion |
| 31 | Dead files and dead code removed safely | ✅ 0 unused selectors of 91, 0 unused custom properties |
| 32 | Back/Next/Home use the required sizes | ✅ measured, not just read from CSS |
| 33 | Controls do not overlap artwork at 1366×768 | ✅ required shrinking the book ~12 % (§17) |
| 34 | Home sits fully in the top-right margin | ✅ above **and** right of the frame corner |
| 35 | Next gated on every video page | ✅ pages 0, 1, 2, 4 |
| 36 | Keyboard/swipe/corner/programmatic respect the gate | ✅ all five routes probed per page |
| 37 | Broken-video fallback unlocks Next | ✅ `error` path and a separate stalled-video watchdog path (released at 23.9 s) |
| 38 | Local server supports Range requests | ✅ 206 + `Content-Range` verified before browser testing |
| 39 | Every page crawled | ✅ all 7. **LBD levels:** LBD 2 played through all 8 rounds; LBD 1's nine variants are not each played (§22.3) |
| 40 | Screenshots inspected | ✅ opened and reviewed, not just captured |
| 41 | Zero JavaScript console errors | ✅ across the crawl and the full playthrough |
| 42 | Zero unexpected 4xx/5xx | ✅ (6 → 0) |
| 43 | Before/after measurements reported | ✅ §21 |

## 24. How to run any of this

```bash
npm install                 # dev-only: Playwright
npm run serve               # Range-capable dev server on :8080  (NEVER test on file://)
npm test                    # the full Playwright suite, both viewports
npm run media               # re-encode media + rewrite media-size-report.{json,csv}
npm run sfx-data            # regenerate the inlined base64 SFX from sfx/*.ogg
npm run manifest            # regenerate asset-manifest.json + both per-game manifests
node tools/measure.js final . 8299 --lbd     # the measurement in §21
```

**Generated artefacts** (all development-only, none deployed):

| Path | Contents |
|---|---|
| `IMPLEMENTATION_REPORT.md` | this document |
| `media-size-report.json` / `.csv` | per-file conversion record + validation outcomes |
| `asset-manifest.json` | the parent's Stage A/B manifest (plus one per game, which **do** ship) |
| `baseline-metrics.json` / `final-metrics.json` | the §21 measurements, including the full initial-request list |
| `screenshots/` | 24 reviewed screenshots, 12 per viewport |
| `test-results/`, `playwright-report/` | Playwright output (cleared each run) |

**Deployment is unchanged and build-free:** publish the repo as static files; `index.html`
is the entry point. `.vercelignore` keeps `tools/`, `tests/`, `quarantine/`, `node_modules/`,
`screenshots/`, the reports and the config out of the payload.

> ⚠️ If a fresh LBD build is ever dropped in again, it will **overwrite `index.html` and
> delete `embed-bridge.js`'s hook**, exactly as happened before this work. After any such
> drop, re-apply: the `window.__lbd = {…}` export + `lbd:boot` event at the end of the
> game's own load handler, and the `<script src="embed-bridge.js"></script>` tag as the last
> script in the file. Then re-run `npm run manifest` and `npm test`.
