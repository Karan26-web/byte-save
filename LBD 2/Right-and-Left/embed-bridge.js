/* ============================================================================
   EMBED BRIDGE  —  LBD 2 "Right & Left — deliver the parcels"  ←→  flipbook.
   Loaded LAST, after the game's own runtime. Touches no game logic.
   ----------------------------------------------------------------------------
   Same contract as LBD 1's bridge (see that file for the full rationale):

     lbd-ready     intro painted + its art usable → parent reveals with no spinner
     lbd-start     learner tapped the REAL #startBtn → parent goes fullscreen
     lbd-complete  game won, the closing celebration video and "Byte saved the day"
                   narration have run, and the learner tapped NEXT. Once per session.

   Plus an idle chunked asset warmer for the later levels' houses/dog rig/narration.

   Opened standalone this file does NOTHING — NEXT keeps replaying the game.
   ============================================================================ */
(function () {
  "use strict";

  if (window.parent === window) return;          // standalone → completely inert

  /* Post to the real origin — except on file://, where the parent's origin is an
     opaque unique origin that a "file://" targetOrigin never matches: the browser
     would drop every message silently and the game would stay boxed in the page
     frame. The wildcard is safe here: no sensitive payload, and the parent
     verifies e.source is this exact iframe. */
  var ORIGIN = (window.location.protocol !== "file:" &&
                window.location.origin && window.location.origin !== "null")
    ? window.location.origin : "*";

  function post(type, extra) {
    var msg = { source: "lbd", type: type };
    if (extra) for (var k in extra) msg[k] = extra[k];
    try { window.parent.postMessage(msg, ORIGIN); } catch (_) {}
  }

  function whenBooted(fn) {
    if (window.__lbd) return fn(window.__lbd);
    window.addEventListener("lbd:boot", function () { fn(window.__lbd); }, { once: true });
  }

  whenBooted(function (api) {
    var playBtn = api.playBtn;
    var startScreen = api.startScreen;
    var endBtn = api.endBtn;
    var endVideo = api.endVideo;
    var VO = api.VO || {};
    var bgm = api.bgm;

    /* ====================================================== READY handshake == */
    var readySent = false;
    function sendReady() {
      if (readySent) return;
      readySent = true;
      post("lbd-ready");
      scheduleWarmUp();
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
        im.addEventListener("error", one, { once: true });
      });
      setTimeout(paint, 2500);
    })();

    /* ====================================================== START handshake ==
       Capture phase on the document so we fire before the game's own #startBtn
       handler. This game's preloadGate keeps the button `disabled` (with a spinner)
       until its essentials are decoded, so the disabled check also stops us
       reporting a start the game itself is still refusing. */
    var startSent = false;
    document.addEventListener("click", function (e) {
      if (startSent) return;
      if (!e.isTrusted) return;
      var hit = e.target && e.target.closest && e.target.closest("#startBtn");
      if (!hit) return;
      if (playBtn.disabled) return;                       // preload gate still holding
      if (startScreen.classList.contains("hide")) return;  // already running
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
       This game already gates its finale correctly on its own: endGame() reveals
       #endScreen, plays the celebration video, then revealEndBtn() awaits
       voSay("byte-saved-the-day") — which resolves on the line's real `ended`, on a
       play rejection, or on its own 4s safety net — and only THEN adds .show to
       #endBtn. So #endBtn becoming visible already means "won, and the closing
       narration is done".

       We therefore only need to redirect the NEXT tap: embedded it continues the
       story instead of replaying. A tap while #endBtn is still hidden cannot reach
       us (pointer-events:none), so completion can never fire early — and a wrong
       delivery or a mid-run restart never reaches this path at all. */
    var completeSent = false;

    function sendComplete() {
      if (completeSent) return;
      completeSent = true;
      /* Kill the celebration video's audio and the music the moment we hand back,
         so nothing bleeds over the page turn. */
      try { endVideo.pause(); } catch (_) {}
      try { if (bgm) bgm.pause(); } catch (_) {}
      for (var k in VO) { try { VO[k].pause(); } catch (_) {} }
      post("lbd-complete");
    }

    document.addEventListener("click", function (e) {
      var hit = e.target && e.target.closest && e.target.closest("#endBtn");
      if (!hit) return;
      if (!endBtn.classList.contains("show")) return;   // not revealed yet → not a completion
      e.preventDefault();
      e.stopPropagation();                              // suppress the standalone replay
      sendComplete();
    }, true);

    /* Belt-and-braces watchdog: if the closing video errors AND the narration's own
       fallbacks somehow never fire, the learner would sit on a celebration screen
       with no NEXT button. Once #endScreen is up, force NEXT visible after 40s
       (the video is ~33s) so there is always a way onward. */
    (function endScreenWatchdog() {
      var es = api.endScreen;
      if (!es || !window.MutationObserver) return;
      var armed = false;
      new MutationObserver(function () {
        var up = !es.classList.contains("hide");
        if (up && !armed) {
          armed = true;
          setTimeout(function () {
            if (!endBtn.classList.contains("show")) endBtn.classList.add("show");
          }, 40000);
        } else if (!up) {
          armed = false;
        }
      }).observe(es, { attributes: true, attributeFilter: ["class"] });
    })();

    /* ========================================================== WARM-UP ======
       Idle chunked pre-fetch: every house/gate/dog-rig sprite (including the
       colour combinations only reachable in later rounds), the cloud SVGs, the
       road tiles, all VO lines, and the celebration video — from
       asset-manifest.json, generated from the real files on disk.

       Byte's and the dog's sprites are swapped by src at runtime and the houses are
       built from `houseFile(colour, variant)`, so a static manifest is the only way
       to be sure a sprite that only appears in a hidden later round is warm. Audio
       is warmed through the game's OWN Audio objects, so the element that will
       actually play is the one that gets buffered. Nothing is played while warming. */
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
      setTimeout(startWarmUp, 1000);
    }

    function audioIndex() {
      var byName = {};
      var add = function (a) {
        if (!a || !a.src) return;
        try { byName[decodeURIComponent(a.src.split("/").pop())] = a; } catch (_) {}
      };
      add(bgm);
      for (var k in VO) add(VO[k]);
      return byName;
    }

    function startWarmUp() {
      fetch("asset-manifest.json", { cache: "force-cache" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (m) { if (m) runWarmUp(m); })
        .catch(function () {});
    }

    function runWarmUp(m) {
      var seen = Object.create(null);
      var live = audioIndex();
      var queue = []
        .concat((m.images || []).map(function (u) { return { u: u, t: "image" }; }))
        .concat((m.audio || []).map(function (u) { return { u: u, t: "audio" }; }))
        /* The 5 MB celebration webm goes LAST and is treated as a bulk file so it
           never delays the sprites/VO the learner needs during play. */
        .concat((m.video || []).map(function (u) { return { u: u, t: "other" }; }))
        .concat((m.other || []).map(function (u) { return { u: u, t: "other" }; }));

      var i = 0;
      function slice() {
        var budget = { image: IMAGES_PER_SLICE, audio: AUDIO_PER_SLICE, other: OTHER_PER_SLICE };
        while (i < queue.length) {
          var item = queue[i];
          if (budget[item.t] <= 0) break;
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
        im.src = item.u;
        return;
      }
      if (item.t === "audio") {
        var name;
        try { name = decodeURIComponent(item.u.split("/").pop()); } catch (_) { name = item.u; }
        var el = live[name];
        if (el) { try { el.preload = "auto"; el.load(); } catch (_) {} }
        fetch(item.u, { cache: "force-cache" }).catch(function () {});
        return;
      }
      fetch(item.u, { cache: "force-cache" }).catch(function () {});
    }

    /* Never steal focus from the parent before the learner has started. */
    window.addEventListener("focus", function () {
      if (!startSent) { try { window.blur(); } catch (_) {} }
    });
  });
})();
