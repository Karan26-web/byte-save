/* PHASE 19 — FULL FLIPBOOK CRAWL + GPU / GHOST-LAYER SCREENSHOTS.
   Every page is visited; every page is checked for JS errors, bad responses, broken
   images, dead posters and stuck video elements. Screenshots are written for visual
   inspection (and are themselves checked for blank / uniform output). */
"use strict";

const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");
const H = require("./helpers");

/* Outside test-results/ on purpose: Playwright clears its outputDir at the start of every
   run, so screenshots written there are destroyed as soon as the next project runs — which
   silently threw away the 1366 set the moment the 844 project started. */
const SHOTS = path.join(__dirname, "..", "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const shot = async (page, name, info) => {
  const file = path.join(SHOTS, `${info.project.name}-${name}.png`);
  await page.screenshot({ path: file });
  return file;
};

/* Report anything visually broken on the CURRENT page. */
async function pageHealth(page) {
  return page.evaluate(() => {
    const idx = window.Flipbook.gateState().page;
    const leaf = document.querySelectorAll(".leaf")[idx];
    const out = { idx, images: [], videos: [], notes: [] };
    if (!leaf) { out.notes.push("no leaf"); return out; }

    leaf.querySelectorAll("img").forEach((im) => {
      const vis = getComputedStyle(im).visibility !== "hidden" && im.offsetParent !== null;
      out.images.push({
        src: im.currentSrc || im.src, visible: vis,
        complete: im.complete, naturalWidth: im.naturalWidth,
      });
    });
    leaf.querySelectorAll("video").forEach((v) => {
      out.videos.push({
        src: v.currentSrc || v.src,
        errorCode: v.error ? v.error.code : null,
        readyState: v.readyState,
        poster: v.getAttribute("poster"),
        videoWidth: v.videoWidth,
      });
    });
    return out;
  });
}

/* Is a PNG effectively a single flat colour? Catches blank pages and missing textures.
   Reads the raw pixels via a canvas in the page context. */
async function looksBlank(page, file) {
  const b64 = fs.readFileSync(file).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + data; });
    const c = document.createElement("canvas");
    const W = 160, Hh = Math.max(1, Math.round((img.height / img.width) * W));
    c.width = W; c.height = Hh;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, W, Hh);
    const px = g.getImageData(0, 0, W, Hh).data;
    const seen = new Set();
    let sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
      // quantise so imperceptible noise doesn't read as "varied"
      seen.add(`${px[i] >> 4},${px[i + 1] >> 4},${px[i + 2] >> 4}`);
      sum += (px[i] + px[i + 1] + px[i + 2]) / 3; n++;
    }
    return { distinctColours: seen.size, meanLuma: sum / n };
  }, b64);
}

test("crawl every page: no JS errors, no bad responses, media healthy", async ({ page }, info) => {
  test.setTimeout(300000);
  const w = H.watch(page);
  await H.openBook(page);

  const report = [];
  for (let target = 0; target <= 6; target++) {
    await H.gotoPage(page, target);
    const s = await H.state(page);
    expect(s.page, "crawl should be on page " + target).toBe(target);

    const health = await pageHealth(page);

    for (const im of health.images) {
      if (!im.visible) continue;
      expect(im.complete, `page ${target}: image not complete — ${im.src}`).toBe(true);
      expect(im.naturalWidth, `page ${target}: image has no pixels — ${im.src}`).toBeGreaterThan(0);
    }
    for (const v of health.videos) {
      expect(v.errorCode, `page ${target}: video is in an error state — ${v.src}`).toBeNull();
      expect(v.poster, `page ${target}: video must declare a poster`).toBeTruthy();
      expect(v.videoWidth, `page ${target}: video never decoded a frame — ${v.src}`).toBeGreaterThan(0);
    }

    // Gated controls must eventually become available (or the page is the last one).
    if (target < 6) {
      await page.waitForFunction(() => window.Flipbook.gateState().canForward, null, { timeout: 70000 });
    }

    // Navigation state is correct for this page.
    const prevDisplay = await page.locator("#cornerPrev").evaluate((e) => getComputedStyle(e).display);
    if (target === 0) expect(prevDisplay, "Back must be absent on page 0").toBe("none");
    else expect(prevDisplay, "Back must be present after page 0").toBe("flex");

    const file = await shot(page, `page-${target}`, info);
    const px = await looksBlank(page, file);
    expect(px.distinctColours, `page ${target} screenshot looks blank (${JSON.stringify(px)})`)
      .toBeGreaterThan(12);

    report.push({ page: target, images: health.images.length, videos: health.videos.length, ...px });
  }

  console.log("crawl report:\n" + report.map((r) =>
    `  page ${r.page}: ${r.images} img, ${r.videos} video, ${r.distinctColours} colours, luma ${r.meanLuma.toFixed(1)}`
  ).join("\n"));
  console.log("CONSOLE ERRORS:", w.errors.length ? w.errors : "none");
  console.log("FAILED REQUESTS:", w.failed.length ? w.failed : "none");

  expect(w.failed, "failed requests during the crawl").toEqual([]);
  expect(w.errors, "console errors during the crawl").toEqual([]);
});

test("GPU windowing is active and releases distant pages", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, 2);

  const win = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".leaf").forEach((l, i) => {
      const cs = getComputedStyle(l);
      out.push({ i, far: l.classList.contains("is-far"), visibility: cs.visibility, willChange: cs.willChange });
    });
    return out;
  });
  console.log("page window at index 2:", JSON.stringify(win));

  // Current page and its immediate neighbours stay renderable…
  for (const i of [1, 2, 3]) {
    expect(win[i].far, `leaf ${i} must stay renderable`).toBe(false);
    expect(win[i].visibility).toBe("visible");
  }
  // …everything further away releases its layer.
  for (const i of [0, 4, 5, 6]) {
    expect(win[i].far, `leaf ${i} must be released`).toBe(true);
    expect(win[i].visibility, `leaf ${i} must not be rendered`).toBe("hidden");
    expect(win[i].willChange, `leaf ${i} must hand back its GPU layer`).toBe("auto");
  }
});

test("GPU: page-turn midpoint, neighbours and post-fullscreen return show no ghosting", async ({ page }, info) => {
  test.setTimeout(300000);
  await H.openBook(page);
  await H.gotoPage(page, 2);

  const files = {};

  files.current = await shot(page, "gpu-current-page", info);

  // Release page 2's video gate FIRST — otherwise Next is legitimately disabled
  // (pointer-events:none), a forced click hits nothing, and no turn ever starts.
  await H.playVideoToEnd(page);
  await expect(page.locator("#cornerNext")).toBeEnabled();

  // MID-TURN: start a real turn and grab the frame while the leaf is rotating.
  // Assert .flipping FIRST and screenshot second — a screenshot can take several
  // hundred ms, which is enough to push the check past the 1150ms flip window and
  // make a passing turn look like it never happened.
  await page.locator("#cornerNext").click(H.FORCE);
  await page.waitForFunction(
    () => document.querySelector(".leaf.flipping") !== null,
    null, { timeout: 3000 }
  );
  const midClasses = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".leaf").forEach((l, i) => {
      if (l.classList.contains("flipping")) out.push(i);
    });
    return out;
  });
  expect(midClasses.length, "a leaf should be mid-turn").toBeGreaterThan(0);
  await page.waitForTimeout(380);                 // ~1/3 through the turn
  files.mid = await shot(page, "gpu-turn-midpoint", info);
  await H.settle(page);

  // The turned-away leaf's animated/filtered children are hard-hidden, so nothing can
  // ghost through onto the page in front.
  const ghosts = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".leaf.flipped:not(.flipping)").forEach((l, i) => {
      l.querySelectorAll(".face.front > *").forEach((ch) => {
        if (getComputedStyle(ch).visibility !== "hidden") out.push(i + ":" + ch.className);
      });
    });
    return out;
  });
  expect(ghosts, "turned-away faces must not keep painting their children").toEqual([]);

  files.prevHidden = await shot(page, "gpu-prev-page-hidden", info);

  // Return from a live fullscreen game and make sure the book renders cleanly again.
  await H.gotoPage(page, 3);
  const frame = await H.gameFrame(page);
  await frame.locator("#startScreen .play-btn").click(H.FORCE);
  await page.waitForFunction(() => window.Flipbook.gateState().lbdFullscreen, null, { timeout: 10000 });
  await page.waitForTimeout(900);
  files.fullscreen = await shot(page, "gpu-lbd-fullscreen", info);

  // Home used to be the bail-out from a live fullscreen game; with that button gone,
  // COMPLETING the game is the only way back, so exit the way the game itself does.
  await frame.evaluate(() => parent.postMessage({ source: "lbd", type: "lbd-complete" }, "*"));
  await page.waitForFunction(() => !window.Flipbook.gateState().lbdFullscreen, null, { timeout: 12000 });
  await page.waitForTimeout(700);
  files.afterFullscreen = await shot(page, "gpu-return-from-fullscreen", info);

  for (const [name, file] of Object.entries(files)) {
    const px = await looksBlank(page, file);
    console.log(`  ${name}: ${px.distinctColours} colours, luma ${px.meanLuma.toFixed(1)}`);
    expect(px.distinctColours, `${name} looks blank / missing textures`).toBeGreaterThan(10);
  }
  console.log("screenshots written to test-results/screens/");
});
