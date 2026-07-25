#!/usr/bin/env node
/* ============================================================================
   DEV-ONLY performance measurement — identical method for BEFORE and AFTER.
     node tools/measure.js <label> <rootDir> <port> [--lbd]
   ----------------------------------------------------------------------------
   Reports, for the given static root:
     • initial request count + initial transferred bytes  (everything up to
       window.load plus a 600 ms settle — so the AFTER build's Stage B, which
       starts only after load, is correctly EXCLUDED, exactly as the baseline had
       no such stage)
     • DOMContentLoaded and window.load, from the page's own Navigation Timing
     • time until the cover is usable  (cover artwork actually painted)
     • time until the Start button is available  (the key regression metric)
     • console errors + failed responses
     • total deployed payload on disk, broken down by media type
   With --lbd it also opens the book, walks to the embedded game page and measures
   landing → interactive, and whether ANY game request happened only after landing.

   Writes <label>-metrics.json next to the reports.
   ============================================================================ */
"use strict";

const { chromium } = require("@playwright/test");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const [label, rootArg, portArg] = process.argv.slice(2);
const WANT_LBD = process.argv.includes("--lbd");
if (!label || !rootArg || !portArg) {
  console.error("usage: node tools/measure.js <label> <rootDir> <port> [--lbd]");
  process.exit(1);
}
const ROOT = path.resolve(rootArg);
const PORT = Number(portArg);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve(__dirname, "..", `${label}-metrics.json`);

/* ------------------------------------------------------- payload on disk --- */
const SKIP_DIRS = new Set([".git", ".vscode", ".claude", "node_modules", "tools", "tests",
  "test-results", "playwright-report", "quarantine"]);
const SKIP_FILES = new Set([".DS_Store", ".gitignore", ".vercelignore", "package.json",
  "package-lock.json", "playwright.config.js", "IMPLEMENTATION_REPORT.md",
  "media-size-report.json", "media-size-report.csv",
  "baseline-metrics.json", "final-metrics.json"]);

const KIND = {
  ".webm": "video", ".mp4": "video",
  ".webp": "image", ".png": "image", ".jpg": "image", ".jpeg": "image", ".svg": "image", ".gif": "image",
  ".ogg": "audio", ".mp3": "audio", ".m4a": "audio", ".wav": "audio", ".opus": "audio",
  ".js": "code", ".css": "code", ".html": "code", ".json": "code",
};

function payload(dir, acc = { total: 0, byKind: {}, files: 0 }) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      payload(path.join(dir, e.name), acc);
    } else if (e.isFile()) {
      if (SKIP_FILES.has(e.name)) continue;
      const size = fs.statSync(path.join(dir, e.name)).size;
      const kind = KIND[path.extname(e.name).toLowerCase()] || "other";
      acc.total += size;
      acc.byKind[kind] = (acc.byKind[kind] || 0) + size;
      acc.files++;
    }
  }
  return acc;
}

/* ------------------------------------------------------------ dev server --- */
function serve() {
  const p = spawn(process.execPath, [path.join(__dirname, "server.js"), String(PORT), ROOT],
    { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("server did not start")), 10000);
    p.stdout.on("data", (d) => {
      if (String(d).includes("Range")) { clearTimeout(t); res(p); }
    });
    p.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  });
}

/* ---------------------------------------------------------------- measure --- */
(async () => {
  const server = await serve();
  const browser = await chromium.launch({
    args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();

  const errors = [];
  const failed = [];
  const requests = [];
  let loadFired = false;

  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("response", async (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${decodeURIComponent(r.url())}`);
    let bytes = 0;
    try {
      const h = r.headers();
      bytes = Number(h["content-length"]) || 0;
      if (!bytes) { try { bytes = (await r.body()).length; } catch { bytes = 0; } }
    } catch { /* ignore */ }
    requests.push({
      url: decodeURIComponent(r.url()).replace(BASE + "/", ""),
      status: r.status(), bytes,
      afterLoad: loadFired,
      t: Date.now() - t0,
    });
  });

  const t0 = Date.now();
  await page.goto(BASE + "/index.html", { waitUntil: "load", timeout: 90000 });
  loadFired = true;

  /* Cover usable = the cover artwork has actually painted (its background image is
     decoded and the element has real size). */
  const coverUsableMs = await page.evaluate(async () => {
    const start = performance.now();
    const el = document.querySelector(".cover .front .cover-img");
    if (!el) return null;
    const url = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
    if (!url) return null;
    const img = new Image();
    img.src = url[1];
    try { await img.decode(); } catch { /* still count it */ }
    return performance.now() - start;
  });

  /* Start button available = the real Play control is visible AND clickable. On the
     baseline that is immediate; on the final build it is when Stage A completes. */
  const startBtnMs = await page.evaluate(() => new Promise((res) => {
    const begin = performance.now();
    const sel = "#hint, .play-btn";
    const ok = () => {
      const e = document.querySelector(sel);
      if (!e) return false;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0;
    };
    if (ok()) return res(performance.now() - begin);
    const iv = setInterval(() => {
      if (ok()) { clearInterval(iv); res(performance.now() - begin); }
    }, 25);
    setTimeout(() => { clearInterval(iv); res(null); }, 60000);
  }));

  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] || {};
    return {
      domContentLoadedMs: Math.round(n.domContentLoadedEventEnd || 0),
      loadMs: Math.round(n.loadEventEnd || 0),
    };
  });

  await page.waitForTimeout(600);                        // settle window
  const initial = requests.filter((r) => !r.afterLoad);
  const initialBytes = initial.reduce((n, r) => n + r.bytes, 0);

  /* --------------------------------------------------- LBD landing timing --- */
  let lbd = null;
  if (WANT_LBD) {
    const isFinal = await page.evaluate(() => !!window.Flipbook);
    if (isFinal) {
      const gameReqBeforeLanding = requests.filter((r) => /^LBD /.test(r.url)).length;

      await page.locator("#hint").click({ force: true });
      await page.waitForFunction(() => window.Flipbook.gateState().ready, null, { timeout: 30000 });

      // Walk to the game page, releasing each video gate honestly.
      for (let g = 0; g < 12; g++) {
        const s = await page.evaluate(() => window.Flipbook.gateState());
        if (s.page >= 3) break;
        if (s.hasVideo && !s.videoCompleted) {
          await page.evaluate(() => {
            const i = window.Flipbook.gateState().page;
            const v = document.querySelectorAll(".leaf")[i].querySelector("video.page-media");
            if (v && isFinite(v.duration)) { v.currentTime = Math.max(0, v.duration - 0.15); v.play().catch(() => {}); }
          });
          await page.waitForFunction(() => window.Flipbook.gateState().videoCompleted, null, { timeout: 90000 });
        }
        const before = (await page.evaluate(() => window.Flipbook.gateState())).page;
        await page.locator("#cornerNext").click({ force: true });
        await page.waitForFunction((b) => window.Flipbook.gateState().page === b + 1, before, { timeout: 20000 });
        await page.waitForFunction(() => !window.Flipbook.gateState().animating, null, { timeout: 20000 });
      }

      const landT = Date.now();
      await page.waitForFunction(() => window.Flipbook.gateState().overlayVisible, null, { timeout: 20000 });
      // Interactive = the game's own Play control is visible and enabled inside the frame.
      await page.waitForFunction(() => {
        const d = document.getElementById("lbdFrame").contentDocument;
        if (!d) return false;
        const b = d.querySelector("#startScreen .play-btn, #startBtn");
        return b && !b.disabled && b.getBoundingClientRect().width > 0;
      }, null, { timeout: 30000 });
      const interactiveMs = Date.now() - landT;

      const gameReqAfterLanding = requests.filter((r) => /^LBD /.test(r.url)).length - gameReqBeforeLanding;
      lbd = {
        gameRequestsBeforeLanding: gameReqBeforeLanding,
        gameRequestsOnlyAfterLanding: gameReqAfterLanding,
        landingToInteractiveMs: interactiveMs,
        note: "Requests before landing = the background warm-up working as intended. " +
              "A low 'only after landing' count means the learner waits on nothing.",
      };
    }
  }

  const disk = payload(ROOT);

  const out = {
    label, root: ROOT, measuredAt: new Date().toISOString(),
    viewport: "1366x768",
    initialRequests: initial.length,
    initialTransferredBytes: initialBytes,
    domContentLoadedMs: nav.domContentLoadedMs,
    windowLoadMs: nav.loadMs,
    coverUsableMs: coverUsableMs == null ? null : Math.round(coverUsableMs),
    startButtonAvailableMs: startBtnMs == null ? null : Math.round(startBtnMs),
    consoleErrors: errors,
    failedResponses: failed,
    lbd,
    deployedPayload: { totalBytes: disk.total, files: disk.files, byKind: disk.byKind },
    initialRequestList: initial.map((r) => ({ url: r.url, status: r.status, bytes: r.bytes })),
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const mb = (n) => (n / 1048576).toFixed(2) + " MB";
  console.log(`\n── ${label.toUpperCase()} (${ROOT}) ─────────────────────────`);
  console.log(`  initial requests        ${out.initialRequests}`);
  console.log(`  initial transferred     ${mb(out.initialTransferredBytes)}`);
  console.log(`  DOMContentLoaded        ${out.domContentLoadedMs} ms`);
  console.log(`  window load             ${out.windowLoadMs} ms`);
  console.log(`  cover usable            ${out.coverUsableMs} ms`);
  console.log(`  START BUTTON available  ${out.startButtonAvailableMs} ms`);
  console.log(`  console errors          ${errors.length}`);
  console.log(`  failed responses        ${failed.length}${failed.length ? " → " + failed.join(", ") : ""}`);
  if (lbd) {
    console.log(`  LBD warm before landing ${lbd.gameRequestsBeforeLanding} requests`);
    console.log(`  LBD reqs after landing  ${lbd.gameRequestsOnlyAfterLanding}`);
    console.log(`  landing → interactive   ${lbd.landingToInteractiveMs} ms`);
  }
  console.log(`  deployed payload        ${mb(disk.total)} in ${disk.files} files`);
  for (const [k, v] of Object.entries(disk.byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${k.padEnd(6)} ${mb(v)}`);
  }
  console.log(`  wrote ${path.basename(OUT)}`);

  await browser.close();
  server.kill();
})().catch((e) => { console.error(e); process.exit(1); });
