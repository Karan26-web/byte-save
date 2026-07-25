/* ============================================================================
   TWO-STAGE ASSET PRELOADER
   ----------------------------------------------------------------------------
   STAGE A (blocking)  — the cover, the flipbook shell, every video poster, the UI
       and the two one-shot SFX. The Start/Play button is HIDDEN and a themed
       progress bar sits in its place; the button is revealed (with a pop-in) only
       when Stage A reaches 100%. Byte-aware: progress is computed from real
       on-disk sizes in asset-manifest.json, refined by Content-Length, and
       advanced by bytes actually streamed out of the response reader.

   STAGE B (non-blocking) — both embedded games, the later-page videos, later
       narration and hidden-level sprites, warmed during idle time AFTER
       window.load. Stage B can never delay the Start button. The iframe warm-up
       itself lives in script.js (it owns the overlay); this file warms the bytes.

   SAFETY — the learner is never trapped:
     • every request has an abort timeout;
     • a failed / aborted / unsupported / stalled / file://-blocked request counts
       as COMPLETE for progress and leaves the original URL in place, so the
       browser's normal media loading path still works;
     • progress is monotonic — it never moves backward;
     • if the manifest itself can't be read, Stage A is skipped and the button is
       revealed immediately.

   BLOB URLs — where a fetch fully succeeded and the manifest marks the asset
   blobOk, the bytes are handed to the real element as a Blob URL so it is not
   downloaded twice. Every swap keeps the original URL and restores it once on
   error. Nothing inside the iframe is ever Blob-swapped: the games are not
   written to consume parent Blob URLs.
   ============================================================================ */
(function () {
  "use strict";

  var MANIFEST_URL = "asset-manifest.json";
  var CONCURRENCY = 5;                  // ~5 parallel transfers
  var REQUEST_TIMEOUT_MS = 20000;       // per-request abort
  var MANIFEST_TIMEOUT_MS = 8000;
  var STAGE_A_HARD_CAP_MS = 25000;      // absolute ceiling — reveal the button regardless

  var loaderEl = document.getElementById("shellLoader");
  var fillEl = document.getElementById("shellLoaderFill");
  var pctEl = document.getElementById("shellLoaderPct");

  /* Public surface script.js uses. `startAllowed` is the loader's gate: script.js
     refuses to open the book until it is true, so keyboard, touch, direct calls
     and synthetic calls all funnel through the same check. */
  var API = (window.FlipbookPreload = {
    startAllowed: false,
    stageAComplete: false,
    blobUrls: Object.create(null),      // originalUrl → blob: URL
    onReady: [],
    ready: function (fn) {
      if (API.startAllowed) fn();
      else API.onReady.push(fn);
    },
    /* Stage B is kicked off by script.js after window.load, so the flipbook's own
       load event is never competing with it. */
    startStageB: function () { beginStageB(); },
  });

  document.documentElement.classList.add("shell-loading");

  /* ------------------------------------------------------------- progress --- */
  var totalBytes = 0;
  var loadedBytes = 0;
  var lastShown = 0;                    // monotonic guard
  /* Until the manifest resolves we do NOT know the total, and "0 of 0 bytes" must not
     be reported as 100% — doing so would pin the monotonic guard at 100 and the bar
     would jump straight to full, defeating byte-aware progress entirely. */
  var totalKnown = false;

  function paint() {
    var pct;
    if (!totalKnown) pct = 0;                      // total not established yet
    else pct = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 100;
    if (pct < lastShown) pct = lastShown;          // never move backward
    if (pct > 100) pct = 100;
    lastShown = pct;
    var r = Math.round(pct);
    if (fillEl) fillEl.style.width = r + "%";
    if (pctEl) pctEl.textContent = r + "%";
    if (loaderEl) loaderEl.setAttribute("aria-valuenow", String(r));
  }
  paint();

  /* ---------------------------------------------------------------- image --- */
  /* IMAGES go through the browser's IMAGE cache, not fetch(). The document requests the
     cover art (a CSS background) and every video poster for itself while parsing, in
     parallel with us — so a fetch() of the same URL races the element's request and
     neither can serve the other from cache, downloading each file TWICE. An Image() load
     shares the image cache with CSS backgrounds and poster attributes, so exactly one
     network request happens no matter who asks first.
     Progress stays byte-aware: the asset's real manifest weight is credited on decode.
     (Audio/video still use the streaming reader below — nothing else requests those, so
     there is no duplication and we get true per-byte granularity.) */
  function warmImage(entry) {
    return new Promise(function (resolve) {
      var settled = false;
      var finish = function (ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        loadedBytes += entry.bytes || 0;
        paint();
        resolve({ ok: ok, blob: null });
      };
      var timer = setTimeout(function () { finish(false); }, REQUEST_TIMEOUT_MS);
      var im = new Image();
      im.decoding = "async";
      im.onload = function () {
        if (im.decode) im.decode().then(function () { finish(true); }, function () { finish(true); });
        else finish(true);
      };
      im.onerror = function () { finish(false); };   // a broken image must never block
      im.src = entry.url;
    });
  }

  /* ---------------------------------------------------------------- fetch --- */
  /* Stream a response so progress advances with bytes actually received, not just
     on completion. Returns { bytes, blob|null, ok } and NEVER rejects — a failure
     resolves as "counted, not swapped" so the loader can't trap anyone. */
  function fetchCounted(entry) {
    var declared = entry.bytes || 0;
    var counted = 0;                    // how much of `declared` we've credited

    function credit(n) {
      if (n <= 0) return;
      loadedBytes += n;
      counted += n;
      paint();
    }
    function settle(result) {
      // Credit any remainder so the bar always reaches this asset's full weight.
      var remainder = declared - counted;
      if (remainder > 0) credit(remainder);
      return result;
    }

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS);

    var opts = { cache: "force-cache" };
    if (ctrl) opts.signal = ctrl.signal;

    return fetch(entry.url, opts)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);

        /* Refine the weight with the server's Content-Length when it differs from
           the on-disk size (e.g. a transforming proxy). Adjust `totalBytes` rather
           than the credited amount, so the bar stays honest and monotonic. */
        var cl = Number(res.headers.get("content-length"));
        if (cl > 0 && cl !== declared) {
          totalBytes += cl - declared;
          declared = cl;
        }

        /* Only buffer bytes in memory when a Blob URL can actually be USED — i.e. for a
           <video>/<audio> element we can hand it to. Images and CSS are already served
           from the HTTP cache by the time the element asks for them, so keeping a second
           in-memory copy of every image would cost ~0.6 MB for no benefit. */
        var wantBlob = entry.blobOk && !entry.game &&
          (entry.type === "video" || entry.type === "audio");
        if (!res.body || !res.body.getReader) {
          // No streaming support → fall back to a single-shot read.
          return (wantBlob ? res.blob() : res.arrayBuffer()).then(function (data) {
            var size = data.size || data.byteLength || 0;
            credit(Math.min(size, declared));
            return settle({ ok: true, blob: wantBlob ? data : null });
          });
        }

        var reader = res.body.getReader();
        var chunks = wantBlob ? [] : null;
        var received = 0;
        var type = res.headers.get("content-type") || "";

        function pump() {
          return reader.read().then(function (step) {
            if (step.done) {
              var blob = null;
              if (wantBlob) {
                try { blob = new Blob(chunks, { type: type }); } catch (_) { blob = null; }
              }
              return settle({ ok: true, blob: blob });
            }
            var len = step.value ? step.value.length : 0;
            received += len;
            // Only credit up to the declared weight so one asset can't overshoot.
            credit(Math.min(len, Math.max(0, declared - counted)));
            if (wantBlob) chunks.push(step.value);
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        /* Failed, aborted, unsupported, stalled, or file://-blocked. Count it as
           done and leave the original URL alone — the element will load it the
           normal way. The learner is never blocked by this. */
        return settle({ ok: false, blob: null });
      })
      .then(function (result) {
        clearTimeout(timer);
        return result;
      });
  }

  /* Run a list through `worker` with a fixed concurrency. Resolves when all are
     settled (workers never reject). */
  function pool(items, limit, worker) {
    return new Promise(function (resolve) {
      if (!items.length) return resolve();
      var next = 0, active = 0, done = 0;
      function launch() {
        while (active < limit && next < items.length) {
          var item = items[next++];
          active++;
          worker(item).then(function () {
            active--; done++;
            if (done === items.length) resolve();
            else launch();
          });
        }
      }
      launch();
    });
  }

  /* ------------------------------------------------------- blob attachment --- */
  /* Swap a Blob URL into the real element so the bytes we already hold are reused
     instead of downloaded again. Keeps the original URL and restores it ONCE if the
     blob fails to decode, resuming the expected playback state for videos. */
  function attachBlob(entry, blob) {
    if (!blob) return;
    var url;
    try { url = URL.createObjectURL(blob); } catch (_) { return; }
    API.blobUrls[entry.url] = url;

    if (entry.type !== "video" && entry.type !== "audio") return;   // images/CSS use the cache directly

    var decoded = decodeURI(entry.url);
    var els = [].slice.call(document.querySelectorAll(entry.type));
    els.forEach(function (el) {
      var original = el.getAttribute("src");
      if (!original) return;
      if (decodeURI(original) !== decoded) return;
      if (el.dataset.blobApplied) return;
      el.dataset.blobApplied = "1";
      el.dataset.originalSrc = original;
      var wasPlaying = !el.paused && !el.ended;
      var at = el.currentTime || 0;
      el.addEventListener("error", function onErr() {
        el.removeEventListener("error", onErr);
        if (el.dataset.blobReverted) return;       // one-time fallback only
        el.dataset.blobReverted = "1";
        el.src = el.dataset.originalSrc;
        try { URL.revokeObjectURL(url); } catch (_) {}   // the blob is dead to us now
        delete API.blobUrls[entry.url];
        try { el.load(); } catch (_) {}
        if (at) { try { el.currentTime = at; } catch (_) {} }
        if (wasPlaying) { var p = el.play(); if (p && p.catch) p.catch(function () {}); }
      });
      el.src = url;
    });
  }

  /* --------------------------------------------------------------- stage A --- */
  var manifest = null;
  var revealed = false;

  function revealStartButton() {
    if (revealed) return;
    revealed = true;
    API.stageAComplete = true;
    API.startAllowed = true;
    totalKnown = true;
    loadedBytes = totalBytes;                     // snap the bar to 100%
    paint();
    var root = document.documentElement;
    root.classList.remove("shell-loading");
    root.classList.add("shell-ready");            // CSS reveals .play-btn with a pop-in
    if (loaderEl) loaderEl.setAttribute("aria-hidden", "true");
    var fns = API.onReady.slice();
    API.onReady.length = 0;
    fns.forEach(function (fn) { try { fn(); } catch (_) {} });
  }

  /* Absolute ceiling: whatever happens to the network or the manifest, the button
     appears. Requirement 8 — a learner must never become trapped. */
  var hardCap = setTimeout(revealStartButton, STAGE_A_HARD_CAP_MS);

  function loadManifest() {
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var t = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (_) {} }, MANIFEST_TIMEOUT_MS);
    var opts = {};
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(MANIFEST_URL, opts)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (m) { clearTimeout(t); return m; });
  }

  loadManifest().then(function (m) {
    manifest = m;
    if (!m || !m.assets) {
      // No manifest (e.g. file://) → nothing to gate on. Show the button now.
      revealStartButton();
      return;
    }
    var shell = m.assets.filter(function (a) { return a.stage === "shell"; });
    totalBytes = shell.reduce(function (n, a) { return n + (a.bytes || 0); }, 0);
    totalKnown = true;                            // from here the bar is byte-accurate
    paint();

    /* Audio elements that the preloader will feed get preload="none" first, so the
       element itself doesn't start a second, parallel download of the same file. */
    shell.forEach(function (a) {
      if (a.type !== "audio") return;
      var decoded = decodeURI(a.url);
      [].slice.call(document.querySelectorAll("audio")).forEach(function (el) {
        var src = el.getAttribute("src");
        if (src && decodeURI(src) === decoded) el.preload = "none";
      });
    });

    pool(shell, CONCURRENCY, function (entry) {
      if (entry.type === "image") return warmImage(entry);      // shares the image cache
      return fetchCounted(entry).then(function (res) {
        if (res.ok && res.blob) attachBlob(entry, res.blob);
      });
    }).then(function () {
      clearTimeout(hardCap);
      revealStartButton();
    });
  });

  /* --------------------------------------------------------------- stage B --- */
  var stageBStarted = false;

  var idle = window.requestIdleCallback
    ? function (fn) { return window.requestIdleCallback(fn, { timeout: 1500 }); }
    : function (fn) { return setTimeout(function () { fn(); }, 120); };

  function beginStageB() {
    if (stageBStarted || !manifest || !manifest.assets) return;
    stageBStarted = true;
    var list = manifest.assets.filter(function (a) { return a.stage === "background"; });
    var i = 0, inFlight = 0;
    var bytes = 0;

    function step() {
      // Two starts per idle slice keeps the main thread free for the page turn.
      var launched = 0;
      while (i < list.length && inFlight < CONCURRENCY && launched < 2) {
        var entry = list[i++];
        launched++;
        inFlight++;
        (function (e) {
          /* Stage B uses the exact URLs the iframe will request, including any
             query string, so the game's own request is a cache hit. No Blob
             swapping here — nothing inside the iframe consumes parent blobs. */
          var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
          var t = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (_) {} }, REQUEST_TIMEOUT_MS);
          var opts = { cache: "force-cache" };
          if (ctrl) opts.signal = ctrl.signal;
          fetch(e.url, opts)
            .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
            .catch(function () { return null; })
            .then(function (buf) {
              clearTimeout(t);
              if (buf) bytes += buf.byteLength;
              inFlight--;
              if (i < list.length || inFlight > 0) idle(step);
              else if (window.console && console.debug)
                console.debug("[preload] Stage B complete —", (bytes / 1048576).toFixed(2), "MB warmed");
            });
        })(entry);
      }
      if (launched && i < list.length) idle(step);
    }
    idle(step);
  }
})();
