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

/* Centre crop used for the curtain frames — small enough to capture and analyse inside the
   transition's own timing, large enough to be representative (both the sky bed and the level
   are broad flat regions here). */
const CLIP = { x: 390, y: 305, width: 300, height: 200 };

/* Classify a PNG by what the learner would actually see in it: how much is the curtain's
   flat sky bed (#71B6E3) and how much is the level's grass. Done in a blank page so the
   game document is never touched by the measurement. */
async function frameMakeup(page, pngPath) {
  const fs = require("fs");
  const probe = await page.context().newPage();
  const out = await probe.evaluate(async (b64) => {
    const im = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
    const x = c.getContext("2d"); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, im.width, im.height).data;
    let sky = 0, green = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 113) < 14 && Math.abs(g - 182) < 14 && Math.abs(b - 227) < 14) sky++;
      else if (g > 90 && g > r + 25 && g > b + 25) green++;
    }
    return { sky: +(100 * sky / n).toFixed(1), level: +(100 * green / n).toFixed(1) };
  }, fs.readFileSync(pngPath).toString("base64"));
  await probe.close();
  return out;
}

test("tablet: the clouds part onto the level, never onto a flat blue screen", async ({ page }, testInfo) => {
  /* The curtain is an OPAQUE sky-blue bed with clouds on top. While it is closed that bed is
     load-bearing — it hides the scene swap. But if it stays opaque while the clouds LEAVE,
     they uncover the bed instead of the level: a dead flat-blue frame, measured at 100% of
     the viewport from +750ms to +1150ms, which testers reported as "the blue screen after
     the cloud transition". This pins BOTH directions — the bed must be gone when the clouds
     part, and still hiding the level while they are closed. */
  test.setTimeout(180000);
  const dir = testInfo.outputPath();
  await page.goto("/LBD%202/Right-and-Left/index.html");
  await page.waitForSelector("#startBtn");
  await page.locator("#startBtn").click({ force: true });

  // While CLOSED: the level must be completely hidden (this is what the bed is for).
  await page.waitForFunction(() => {
    const c = document.getElementById("fieldCurtain").classList;
    return c.contains("show") && !c.contains("part");
  }, null, { timeout: 15000 });
  await page.waitForTimeout(1000);
  const closedShot = `${dir}/closed.png`;
  await page.screenshot({ path: closedShot, clip: CLIP });

  /* Timing discipline, learned the hard way — an earlier version of this test passed with the
     bug deliberately reinstated. Two rules keep the frames meaningful:
       - Grab a small centre CROP, not the whole 2160x1620 screen. A full-res capture plus a
         3.5M-pixel walk costs enough that the ~2.8s transition finishes underneath you, and
         you end up photographing the settled level no matter what the curtain did.
       - Analyse only AFTER both frames are captured, and confirm the curtain is still up
         BEFORE the shutter, not after. */
  await page.waitForFunction(() => document.getElementById("fieldCurtain").classList.contains("part"), null, { timeout: 15000 });
  await page.waitForTimeout(700);          // clouds are clear of frame by now, curtain still up
  const stillUp = await page.evaluate(() => {
    const fc = document.getElementById("fieldCurtain");
    return fc.classList.contains("part") && getComputedStyle(fc).visibility === "visible"
        && +getComputedStyle(fc).opacity > 0.9;
  });
  const partShot = `${dir}/parting.png`;
  await page.screenshot({ path: partShot, clip: CLIP });
  expect(stillUp, "curtain had already torn down — this frame proves nothing either way").toBe(true);

  const closed = await frameMakeup(page, closedShot);
  const parting = await frameMakeup(page, partShot);

  console.log(`closed: ${JSON.stringify(closed)}   parting+750ms: ${JSON.stringify(parting)}`);
  expect(closed.level, `level leaked through the closed curtain — ${JSON.stringify(closed)}`).toBeLessThan(0.5);
  expect(parting.sky, `flat sky bed still on screen as the clouds part — ${JSON.stringify(parting)}`).toBeLessThan(5);
  expect(parting.level, `level should be revealed as the clouds part — ${JSON.stringify(parting)}`).toBeGreaterThan(20);
});

test("tablet: tearing the curtain down does not flash the sky bed back on", async ({ page }, testInfo) => {
  /* The LAST blue frame, and the one the part-phase test above cannot see. cloudTransition
     ends with `classList.remove('show','part')`. While the bed lived on the base rule and
     `.part{background-color:transparent}` merely overrode it, that single call put the bed
     back to opaque IN THE SAME TICK — but opacity still had its .2s fade to run, so the
     curtain spent those 200ms as a full-screen flat-blue veil over a level that was already
     fully revealed. Filmed at 40ms: +2473ms level 68.8% green, +2875ms one uniform blue frame
     (avg rgb 114,180,214, zero colour variance), +3074ms level back.

     Driven directly rather than through Play: the teardown fade is a 200ms window and racing
     a screenshot into it from the real flow is flaky, while add show -> add part -> remove
     both reproduces the exact class sequence cloudTransition performs.

     LBD 1 is deliberately not covered — it keeps an opaque bed for its whole sweep by design
     (no .part override at all), so this invariant is Byte's Delivery Mission's alone. */
  test.setTimeout(120000);
  await page.goto("/LBD%202/Right-and-Left/index.html");
  await page.waitForSelector("#startBtn");
  await page.locator("#startBtn").click({ force: true });
  /* Wait out the whole opening beat — sweep, welcome title, un-blur — so the crop sees the
     bare level. Shooting while #welcome is still up put its tinted blur and title art over
     the crop and the liveness check read 4% grass on the short landscape viewport. */
  await page.waitForFunction(() => {
    const fc = document.getElementById("fieldCurtain");
    return !fc.classList.contains("show") && getComputedStyle(fc).opacity === "0"
        && !document.getElementById("welcome").classList.contains("show");
  }, null, { timeout: 40000 });

  /* Take the curtain away from the game before driving it by hand. Once the welcome clears,
     introSequence runs and nextRound() fires its OWN labelled cloudTransition, which re-adds
     show/closed underneath this test — it passed in isolation and failed inside the full
     suite, purely on where that sweep landed. Stubbing the transition (still invoking
     onCover, so the game keeps progressing normally) leaves #fieldCurtain ours alone. */
  await page.evaluate(() => { window.cloudTransition = async (label, onCover) => { if (onCover) onCover(); }; });

  // centre crop sized off the real viewport — the shared CLIP overhangs the 844x390 project
  const vp = page.viewportSize();
  const clip = { x: Math.round(vp.width * 0.3), y: Math.round(vp.height * 0.3),
                 width: Math.round(vp.width * 0.4), height: Math.round(vp.height * 0.4) };

  const fc = page.locator("#fieldCurtain");
  await fc.evaluate((el) => el.classList.add("show"));
  await page.waitForTimeout(1100);                    // clouds drift in and cover
  await fc.evaluate((el) => el.classList.add("part"));
  await page.waitForTimeout(1100);                    // clouds clear the frame, curtain still up
  const beforeShot = `${testInfo.outputPath()}/pre-teardown.png`;
  await page.screenshot({ path: beforeShot, clip });
  await fc.evaluate((el) => el.classList.remove("show", "part"));   // <- the teardown under test
  const afterShot = `${testInfo.outputPath()}/teardown.png`;
  await page.screenshot({ path: afterShot, clip });    // lands inside the .2s fade

  const before = await frameMakeup(page, beforeShot);
  const after = await frameMakeup(page, afterShot);

  console.log(`pre-teardown: ${JSON.stringify(before)}   teardown: ${JSON.stringify(after)}`);
  // the crop must be showing the level, or neither frame proves anything
  expect(before.level, `crop never saw the level — ${JSON.stringify(before)}`).toBeGreaterThan(20);
  expect(after.sky, `sky bed flashed back on as the curtain tore down — ${JSON.stringify(after)}`).toBeLessThan(5);
  // the invariant in one line: dropping the classes must change nothing on screen
  expect(Math.abs(after.level - before.level),
    `teardown changed the frame — before ${JSON.stringify(before)} after ${JSON.stringify(after)}`).toBeLessThan(10);
});

test("tablet: the parting curtain animates nothing that forces a repaint", async ({ page }) => {
  /* Learned by shipping the mistake: dropping the sky bed with a .3s background-color fade
     removed the blue frame but re-rasterised this full-viewport layer every frame — 434
     RasterTasks across the part phase against 241 for an instant drop. Invisible on desktop,
     stutter on a tablet GPU, and it read as "the cloud transition is lagging again".
     transform and opacity are compositor-only and fine; background/background-color, filter,
     width/height/top/left are not. Applies to both games. */
  const PAINTY = /\b(background|background-color|box-shadow|filter|width|height|top|left|border-radius)\b/;
  for (const url of ["/LBD%202/Right-and-Left/index.html", "/LBD%201/index.html"]) {
    await page.goto(url);
    await page.waitForSelector("#fieldCurtain .cloud", { state: "attached" });
    const props = await page.evaluate(() => {
      const fc = document.getElementById("fieldCurtain");
      fc.classList.add("show", "part");                 // the parting state, measured directly
      const read = (el) => getComputedStyle(el).transitionProperty;
      const out = {
        curtain: read(fc),
        sheets: [...document.querySelectorAll("#fieldCurtain .clouds")].map(read),
        clouds: [...document.querySelectorAll("#fieldCurtain .cloud")].slice(0, 4).map(read),
      };
      fc.classList.remove("show", "part");
      return out;
    });
    expect(props.curtain, `${url} curtain transitions a paint property: ${props.curtain}`).not.toMatch(PAINTY);
    for (const p of props.sheets) {
      expect(p, `${url} cloud sheet transitions a paint property: ${p}`).not.toMatch(PAINTY);
    }
    for (const p of props.clouds) {
      expect(p, `${url} cloud transitions a paint property: ${p}`).not.toMatch(PAINTY);
    }
  }
});

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
