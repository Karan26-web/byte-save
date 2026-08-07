/* THE BUG REPORT'S OWN REPRO, pinned: a tablet opens the flipbook, selects Byte's Delivery
   Mission, and TAPS PLAY. Reported as "the transition flickers, stutters, or momentarily
   freezes before abruptly loading the game screen" — measured at 15.9 fps with 11 freezes.

   curtain-perf.spec.js is NOT a substitute for this file. It drives .show/.part directly on
   a desktop viewport, so it never exercises welcomeThenStart(): the real tap ALSO swaps the
   screens, builds level 1, raises a full-viewport backdrop blur, and drives the flipbook
   overlay into fullscreen — all in the same frames the clouds are sweeping. A regression in
   any of that is invisible to the class-toggle guard but lands squarely on the learner.

   Deliberately NOT pinned: the cloud asset format. Converting SVG->WebP neither caused nor
   fixed this bug (deleting the cloud art entirely moved the frame rate 15.9 -> 15.2), so
   the format stays a free choice and nobody should "fix" a future stall by converting art. */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

/* iPad landscape geometry on Chromium — the descriptor for a real iPad selects WebKit,
   which this repo does not install. Coarse pointer + touch is what matters here: it is the
   branch where the backdrop blur snaps instead of animating its radius. */
test.use({
  viewport: { width: 1080, height: 810 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  trace: "off",
});

const LBD2_PAGE = 5;
const THROTTLE = 4;              // slow-tablet proxy; 6x and 8x also measured clean by hand

/* Record every frame the game document actually presents, plus any main-thread long task.
   Both matter: the original defect was pure raster cost (main thread idle, ScriptDuration
   0.018s), so an assertion on long tasks alone would have missed it entirely. */
async function armSampler(frame) {
  await frame.evaluate(() => {
    window.__m = { d: [], long: [], last: 0, on: false };
    const tick = (t) => {
      if (window.__m.on) { if (window.__m.last) window.__m.d.push(t - window.__m.last); window.__m.last = t; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (window.__m.on) window.__m.long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch (e) {}
  });
}

async function collect(frame) {
  return frame.evaluate(() => {
    window.__m.on = false;
    const d = window.__m.d, total = d.reduce((a, b) => a + b, 0);
    return {
      frames: d.length,
      fps: +(d.length / (total / 1000)).toFixed(1),
      worst: Math.round(Math.max(...d)),
      freezes: d.filter((x) => x > 250).length,
      over100: d.filter((x) => x > 100).length,
      longtasks: window.__m.long,
    };
  });
}

/* Assertions shared by both routes into the transition. Thresholds sit between the measured
   good state (~50 fps, worst 51-68ms, zero freezes across five consecutive runs) and the
   reported defect (15.9 fps, 11 freezes, worst 234ms) — loose enough for a busy machine,
   tight enough that the actual bug cannot slip through. */
function assertSmooth(r, label) {
  expect(r.frames, `${label}: sampled no frames — the measurement itself is broken`).toBeGreaterThan(60);
  expect(r.freezes, `${label}: frames over 250ms (visible freezes) — ${JSON.stringify(r)}`).toBe(0);
  expect(r.worst, `${label}: worst frame ms — ${JSON.stringify(r)}`).toBeLessThan(150);
  expect(r.fps, `${label}: mean fps — ${JSON.stringify(r)}`).toBeGreaterThan(30);
}

test("tablet: curtain uses the 4-sheet LOD, not 60 composited cloud layers", async ({ page }) => {
  /* On coarse pointers the four .clouds containers are the animated layers and the
     individual clouds are plain paint inside them. 60 will-change clouds = ~94MB of
     GPU textures and ~7x viewport overdraw at 2x DPR — smooth on desktop GPUs and in
     CPU-throttled profiling, a stutter on real tablet GPUs. See the CURTAIN LOD note
     in each game's CSS before changing this. */
  for (const url of ["/LBD%202/Right-and-Left/index.html", "/LBD%201/index.html"]) {
    await page.goto(url);
    await page.waitForSelector("#fieldCurtain .cloud", { state: "attached" });
    const layers = await page.evaluate(() => ({
      coarse: matchMedia("(pointer:coarse)").matches,
      sheets: [...document.querySelectorAll("#fieldCurtain .clouds")]
        .filter((el) => getComputedStyle(el).willChange === "transform").length,
      cloudLayers: [...document.querySelectorAll("#fieldCurtain .cloud")]
        .filter((el) => getComputedStyle(el).willChange === "transform").length,
    }));
    expect(layers.coarse, url + " must be a coarse-pointer profile").toBe(true);
    expect(layers.sheets, url + " animated cloud sheets").toBe(4);
    expect(layers.cloudLayers, url + " per-cloud composited layers").toBe(0);
  }
});

test("tablet: tapping Play in the flipbook transitions smoothly into the level", async ({ page }) => {
  test.setTimeout(300000);

  /* Warm the browser BEFORE measuring. A fresh Chromium spends its first render on GPU
     process spin-up and first-ever asset decode; measured cold, that alone produced a
     20.3 fps / 233ms outlier that five subsequent runs never reproduced. This is a harness
     artifact, not something a learner meets — the flipbook preloads the game iframe while
     they are still reading the story pages, which the gotoPage() walk below reproduces. */
  await page.goto("/LBD%202/Right-and-Left/index.html");
  await page.waitForSelector("#fieldCurtain .cloud", { state: "attached" });
  await page.waitForTimeout(600);

  await H.openBook(page);
  await H.gotoPage(page, LBD2_PAGE);
  const frame = await H.gameFrame(page);
  await expect(frame.locator("#startBtn")).toBeVisible();
  await armSampler(frame);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  await page.waitForTimeout(400);

  await frame.evaluate(() => { window.__m.on = true; window.__m.last = 0; });
  await frame.locator("#startBtn").click(H.FORCE);
  // Cover the whole sweep: clouds in (~950ms) + hold (~900ms) + clouds out (~980ms).
  await page.waitForTimeout(3400);
  const r = await collect(frame);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  console.log("tablet Play transition: " + JSON.stringify(r));

  // The transition must actually have run — otherwise a broken Play button would read as
  // a flawlessly smooth 60 fps of nothing happening.
  await expect(frame.locator("#gameScreen")).not.toHaveClass(/hide/);
  expect(await page.evaluate(() => window.Flipbook.gateState().lbdStarted)).toBe(true);

  assertSmooth(r, "flipbook Play tap");
});

test("tablet: an impatient first tap, before the idle warm-up, is still smooth", async ({ page }) => {
  test.setTimeout(300000);
  /* The warm-up pre-rasterises the 60 cloud layers at idle (requestIdleCallback, 2500ms
     timeout). A learner who taps Play the instant it appears can beat it, so the sweep would
     pay for all 60 first-paint rasters mid-animation — the original "freeze then blue flash".
     No settling wait here on purpose: this is the race, not the happy path. */
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
  await page.goto("/LBD%202/Right-and-Left/index.html");
  const frame = page.mainFrame();
  await armSampler(frame);
  await frame.evaluate(() => { window.__m.on = true; window.__m.last = 0; });
  await page.locator("#startBtn").click(H.FORCE);
  await page.waitForTimeout(3400);
  const r = await collect(frame);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  console.log("impatient first tap: " + JSON.stringify(r));

  await expect(page.locator("#gameScreen")).not.toHaveClass(/hide/);
  assertSmooth(r, "impatient first tap");
});
