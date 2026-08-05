/* ============================================================================
   EMBED BRIDGE  —  LBD 1 "Byte's Energy Hunt"  ←→  the flipbook parent.
   Loaded LAST, after the game's own runtime. Touches no game logic.
   ----------------------------------------------------------------------------
   Three messages go OUT to the parent (never anything in):

     lbd-ready     the intro screen has painted and its critical art is usable,
                   so the parent can reveal the overlay with no spinner.
     lbd-start     the learner tapped the REAL Play button — the parent expands
                   the overlay from the page frame to true fullscreen.
     lbd-complete  the game was WON and the closing narration has finished, and
                   the learner tapped Next — the parent shrinks back and turns
                   the page. Sent exactly once per session.

   Plus an idle, chunked asset warmer (see WARM-UP at the bottom) so later levels'
   sprites and narration are in cache long before the learner gets to them.

   Opened standalone (not in an iframe) this file does NOTHING — the game keeps
   its own replay-on-Next behaviour.
   ============================================================================ */
(function () {
  "use strict";

  /* ------------------------------------------------------------ inert check */
  if (window.parent === window) return;          // standalone → do nothing at all

  /* The iframe is same-site, so post to the REAL origin rather than "*" — except
     on file://. There the origin serialises to "file://" (or "null"), but the
     PARENT document's origin is an opaque unique origin, so a targetOrigin of
     "file://" never matches it and the browser drops the message SILENTLY — the
     game then runs boxed inside the page frame because lbd-start never arrives.
     Only the wildcard delivers on file://, and it is safe here: these messages
     carry no sensitive data and the parent verifies e.source is this iframe. */
  var ORIGIN = (window.location.protocol !== "file:" &&
                window.location.origin && window.location.origin !== "null")
    ? window.location.origin : "*";

  function post(type, extra) {
    var msg = { source: "lbd", type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    try { window.parent.postMessage(msg, ORIGIN); } catch (_) {}
  }

  /* Wait for the game to publish its hooks (window.__lbd is set at the end of the
     game's own load handler, which may fire before or after this script parses). */
  function whenBooted(fn) {
    if (window.__lbd) return fn(window.__lbd);
    window.addEventListener("lbd:boot", function () { fn(window.__lbd); }, { once: true });
  }

  whenBooted(function (api) {
    var playBtn = api.playBtn;
    var startScreen = api.startScreen;
    var game = api.game;
    var audio = api.audio;

    /* ====================================================== READY handshake ==
       Post lbd-ready once the intro is genuinely on screen: the start screen's
       artwork decoded, then two frames so the browser has actually painted it.
       A hard timeout guarantees the parent is never left waiting on this. */
    var readySent = false;
    function sendReady() {
      if (readySent) return;
      readySent = true;
      post("lbd-ready");
      scheduleWarmUp();                          // idle warm-up starts ~1s after this
    }
    (function waitForIntro() {
      var imgs = [].slice.call(startScreen.querySelectorAll("img"));
      var pending = imgs.filter(function (im) { return !im.complete; });
      var fired = false;
      var paint = function () {
        if (fired) return;
        fired = true;
        requestAnimationFrame(function () { requestAnimationFrame(sendReady); });
      };
      if (!pending.length) return paint();
      var left = pending.length;
      pending.forEach(function (im) {
        var one = function () { if (--left <= 0) paint(); };
        im.addEventListener("load", one, { once: true });
        im.addEventListener("error", one, { once: true });   // a broken image must not stall the reveal
      });
      setTimeout(paint, 2500);                   // fallback — never wait forever
    })();

    /* ====================================================== START handshake ==
       Capture phase on the document, so this runs BEFORE the game's own handler
       (which removes itself and hides the start screen synchronously). Guards:
       real user event only, button enabled, once per session, not already running. */
    var startSent = false;
    document.addEventListener("click", function (e) {
      if (startSent) return;
      if (!e.isTrusted) return;                        // never fire from synthetic/preload clicks
      var hit = e.target && e.target.closest && e.target.closest(".play-btn");
      if (!hit || hit !== playBtn) return;
      if (playBtn.disabled) return;                    // held by a loading gate
      if (startScreen.classList.contains("hide")) return;   // game already running
      startSent = true;
      post("lbd-start");
    }, true);
    /* BACKSTOP — the click sniffer above is the fast path, but the DEFINITIVE "the
       game has started" signal is the start screen going away. Post lbd-start from
       that too (deduped via startSent), so no start path — button, keyboard, or any
       future flow — can ever leave the game running un-fullscreened inside the page
       frame. And the guard is per GAME START, not per iframe load: when the start
       screen comes BACK without a reload (an in-game replay path), re-arm, so the
       next Play expands the parent again instead of being silently swallowed. */
    new MutationObserver(function () {
      var hidden = startScreen.classList.contains("hide");
      if (hidden && !startSent) { startSent = true; post("lbd-start"); }
      else if (!hidden && startSent) { startSent = false; }
    }).observe(startScreen, { attributes: true, attributeFilter: ["class"] });

    /* =================================================== COMPLETE handshake ==
       The real success path is GameManager.win() — it reveals #win and plays the
       closing line "Byte saved the day!" (audio.voices.byteSaved).

       Completion is NOT posted when the splash merely appears: the closing
       narration must finish first. Only then does the splash's Next button become
       live, and tapping it posts lbd-complete. That is the same shape LBD 2 uses
       (revealEndBtn) and it means a failed level, a restart, or leaving the page
       can never be mistaken for a win. */
    var completeSent = false;
    var narrationDone = false;
    var nextBtn = document.getElementById("replayBtn");

    function sendComplete() {
      if (completeSent) return;
      completeSent = true;
      try { audio.stopVoice(); } catch (_) {}
      post("lbd-complete");
    }

    /* Release the Next button through whichever comes first: the narration's real
       `ended`, its `error`, or a watchdog of (duration + 4s) — 30s when the
       duration is unknown. The learner can never be stranded on the win splash. */
    function gateOnNarration() {
      var vo = audio && audio.voices && audio.voices.byteSaved;
      var timer = null;
      var release = function () {
        if (narrationDone) return;
        narrationDone = true;
        clearTimeout(timer);
        if (nextBtn) {
          nextBtn.style.opacity = "";
          nextBtn.style.pointerEvents = "";
          nextBtn.disabled = false;
        }
      };
      if (nextBtn) {                              // hold Next inert while the line plays
        nextBtn.style.opacity = "0";
        nextBtn.style.pointerEvents = "none";
        nextBtn.disabled = true;
      }
      if (!vo) return release();                   // no closing line → nothing to wait for
      vo.addEventListener("ended", release, { once: true });
      vo.addEventListener("error", release, { once: true });
      var dur = isFinite(vo.duration) && vo.duration > 0 ? vo.duration : null;
      timer = setTimeout(release, dur ? dur * 1000 + 4000 : 30000);
    }

    /* Wrap win() rather than watching the DOM: it is the single real success path,
       so there is no way to reach completion from a fail/restart screen. */
    if (game && typeof game.win === "function") {
      var origWin = game.win.bind(game);
      game.win = function () {
        var r = origWin.apply(null, arguments);
        gateOnNarration();
        return r;
      };
    }

    /* restart() re-arms everything, so a replayed run can complete again cleanly
       (completeSent stays true for the session — the parent tears the iframe down
       on completion anyway, so a session is one playthrough). */
    if (game && typeof game.restart === "function") {
      var origRestart = game.restart.bind(game);
      game.restart = function () {
        narrationDone = false;
        return origRestart.apply(null, arguments);
      };
    }

    /* Next on the win splash → completion. Capture on the document so this runs
       BEFORE the game's own restart handler on the same button, and stop that
       handler: embedded, Next means "continue the story", not "play again". */
    document.addEventListener("click", function (e) {
      var hit = e.target && e.target.closest && e.target.closest("#replayBtn");
      if (!hit) return;
      if (!narrationDone) {                      // closing line still playing → ignore the tap
        e.preventDefault(); e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();                       // suppress the standalone restart()
      sendComplete();
    }, true);

    /* ========================================================== WARM-UP ======
       Idle, chunked pre-fetch of everything the later levels need — hidden-level
       backgrounds, every pod/cloud sprite, and all the narration that only plays
       deep into the game. Runs ~1s after the intro paints, in small slices, so it
       never competes with the intro or with the learner's first interactions.

       Assets come from LBD 1/asset-manifest.json, generated from the real files on
       disk (tools/gen-manifest.js) — level backgrounds and VO filenames are built
       dynamically at runtime, so a static list is the only reliable way to cover
       sprites that live in `display:none` levels.

       Audio is warmed through the game's OWN Audio objects (audio.files /
       audio.voices / audio.theme) so the exact element that will later play is the
       one that ends up buffered — plus a fetch() so the whole file lands in the
       HTTP cache. Nothing is ever played while warming. */
    var IMAGES_PER_SLICE = 3;
    var AUDIO_PER_SLICE = 2;
    var OTHER_PER_SLICE = 4;
    var warmStarted = false;

    var idle = window.requestIdleCallback
      ? function (fn) { return window.requestIdleCallback(fn, { timeout: 1200 }); }
      : function (fn) { return setTimeout(function () { fn({ timeRemaining: function () { return 8; } }); }, 90); };

    function scheduleWarmUp() {
      if (warmStarted) return;
      warmStarted = true;
      setTimeout(startWarmUp, 1000);             // "roughly one second after the intro has painted"
    }

    /* Index the game's own Audio elements by their src filename, so a manifest URL
       can be matched to the live object that will actually play it. */
    function audioIndex() {
      var byName = {};
      var add = function (a) {
        if (!a || !a.src) return;
        try { byName[decodeURIComponent(a.src.split("/").pop())] = a; } catch (_) {}
      };
      if (audio) {
        add(audio.theme);
        for (var k in audio.files) add(audio.files[k]);
        for (var v in audio.voices) add(audio.voices[v]);
      }
      return byName;
    }

    function startWarmUp() {
      fetch("asset-manifest.json", { cache: "force-cache" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { if (m) runWarmUp(m); })
        .catch(function () { /* no manifest → the game still works, just colder */ });
    }

    function runWarmUp(m) {
      var seen = Object.create(null);             // dedupe — never request the same URL twice
      var live = audioIndex();

      var queue = []
        .concat((m.images || []).map(function (u) { return { u: u, t: "image" }; }))
        .concat((m.audio || []).map(function (u) { return { u: u, t: "audio" }; }))
        .concat((m.video || []).map(function (u) { return { u: u, t: "other" }; }))
        .concat((m.other || []).map(function (u) { return { u: u, t: "other" }; }));

      var i = 0;
      function slice() {
        var budget = { image: IMAGES_PER_SLICE, audio: AUDIO_PER_SLICE, other: OTHER_PER_SLICE };
        while (i < queue.length) {
          var item = queue[i];
          if (budget[item.t] <= 0) break;         // this slice is full for that type
          i++;
          budget[item.t]--;
          if (seen[item.u]) continue;
          seen[item.u] = 1;
          warmOne(item, live);
        }
        if (i < queue.length) idle(slice);
      }
      idle(slice);
    }

    function warmOne(item, live) {
      if (item.t === "image") {
        var im = new Image();
        im.decoding = "async";
        im.src = item.u;                          // decodes into the image cache
        return;
      }
      if (item.t === "audio") {
        var name;
        try { name = decodeURIComponent(item.u.split("/").pop()); } catch (_) { name = item.u; }
        var el = live[name];
        if (el) {
          /* Warm the REAL element that will play this clip. preload="auto" + load()
             buffers it; it is never played here. */
          try { el.preload = "auto"; el.load(); } catch (_) {}
        }
        /* …and pull the complete file into the HTTP cache, so a later element that
           re-reads it (or a fresh iframe after teardown) is served from cache. */
        fetch(item.u, { cache: "force-cache" }).catch(function () {});
        return;
      }
      fetch(item.u, { cache: "force-cache" }).catch(function () {});
    }

    /* The hidden/pre-reveal iframe must never take focus or scroll away from the
       parent. The game itself never calls focus(), but a stray autofocus or a
       programmatic scroll would be visible to the learner as a jump. */
    window.addEventListener("focus", function () {
      /* Only relevant before the learner has started: until then the parent owns
         focus. Blur ourselves so the parent's keyboard handlers keep working. */
      if (!startSent) { try { window.blur(); } catch (_) {} }
    });
  });
})();
