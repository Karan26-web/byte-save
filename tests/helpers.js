/* Shared helpers for the Playwright suite. DEV-ONLY — not deployed. */
"use strict";

const { expect } = require("@playwright/test");

/* Collect console errors + non-2xx/3xx responses for the life of a page. Returns an
   object whose arrays fill as the page runs. */
function watch(page) {
  const errors = [];
  const failed = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("response", (r) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  });
  page.on("requestfailed", (r) => {
    // Deliberately aborted preload probes are expected; a real navigation failure is not.
    const err = r.failure() && r.failure().errorText;
    if (err && /ERR_ABORTED|net::ERR_ABORTED/.test(err)) return;
    failed.push(`requestfailed ${err} ${r.url()}`);
  });
  return { errors, failed };
}

/* The Play button breathes forever, so Playwright's stability check never settles —
   force the click. A real tap is unaffected. */
const FORCE = { force: true };

/* Boot the page, wait for Stage A to reveal the Start button, open the book and wait
   until the cover-open animation has finished (ready === true). */
async function openBook(page, url = "/index.html") {
  await page.goto(url);
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });
  await page.locator("#hint").click(FORCE);
  await page.waitForFunction(
    () => window.Flipbook && window.Flipbook.gateState().ready,
    null, { timeout: 20000 }
  );
}

const state = (page) => page.evaluate(() => window.Flipbook.gateState());

/* Release the CURRENT page's video gate the honest way: seek to just before the end
   and let the element fire its own real `ended` event. No synthetic events. */
async function playVideoToEnd(page, timeout = 30000) {
  await page.evaluate(() => {
    const idx = window.Flipbook.gateState().page;
    const v = document.querySelectorAll(".leaf")[idx].querySelector("video.page-media");
    if (!v) return;
    const seek = () => {
      if (isFinite(v.duration) && v.duration > 0) {
        try { v.currentTime = Math.max(0, v.duration - 0.15); } catch (_) {}
        const p = v.play(); if (p && p.catch) p.catch(() => {});
      } else {
        v.addEventListener("loadedmetadata", seek, { once: true });
      }
    };
    seek();
  });
  await page.waitForFunction(
    () => window.Flipbook.gateState().videoCompleted,
    null, { timeout }
  );
}

/* Turn forward via the visible arrow and wait for the page index to advance. */
async function clickNext(page) {
  const before = (await state(page)).page;
  await page.locator("#cornerNext").click(FORCE);
  await page.waitForFunction((b) => window.Flipbook.gateState().page === b + 1, before, { timeout: 20000 });
  await settle(page);
}

async function clickBack(page) {
  const before = (await state(page)).page;
  await page.locator("#cornerPrev").click(FORCE);
  await page.waitForFunction((b) => window.Flipbook.gateState().page === b - 1, before, { timeout: 20000 });
  await settle(page);
}

/* Wait for a flip to FULLY settle. The gate arms at flip START (so the target page's
   video begins as it is revealed), which means `armedFor === page` is true long before
   the turn finishes — we must also wait for the engine to clear `animating`, or the
   next click lands mid-flip and is correctly ignored. */
async function settle(page) {
  await page.waitForFunction(
    () => {
      const s = window.Flipbook.gateState();
      return s.armedFor === s.page && !s.animating;
    },
    null, { timeout: 20000 }
  );
  await page.waitForTimeout(120);
}

/* Walk forward from page 0 to `target`, satisfying each page's gate on the way. */
async function gotoPage(page, target) {
  for (let guard = 0; guard < 20; guard++) {
    const s = await state(page);
    if (s.page >= target) return;
    if (s.hasVideo && !s.videoCompleted) await playVideoToEnd(page);
    if (s.hasInteraction && !s.interactionCompleted) {
      await page.evaluate(() => window.Flipbook.markInteractionComplete());
    }
    await clickNext(page);
  }
  throw new Error("gotoPage: did not reach page " + target);
}

/* The live game document inside the overlay iframe.
   NOTE: we must NOT use waitForSelector("#lbdFrame") with its default `visible` state —
   the whole design warms the game while the overlay is hidden, so the iframe is
   legitimately invisible for most of its life. Resolve through page.frames() instead,
   which does not care about visibility. */
async function gameFrame(page) {
  await page.waitForSelector("#lbdFrame", { state: "attached" });
  for (let i = 0; i < 120; i++) {
    const f = page.frames().find((fr) => {
      const u = fr.url();
      return u && u !== "about:blank" && /LBD(%20|\s)\d/.test(u);
    });
    if (f) return f;
    await page.waitForTimeout(250);
  }
  throw new Error("gameFrame: no game iframe ever loaded (still about:blank)");
}

/* Throttle the network via CDP so the Stage A loading sequence is observable. */
async function throttle(page, { downloadKbps = 400, latencyMs = 120 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: latencyMs,
    downloadThroughput: (downloadKbps * 1024) / 8,
    uploadThroughput: (downloadKbps * 1024) / 8,
  });
  return cdp;
}

module.exports = {
  watch, openBook, state, playVideoToEnd, clickNext, clickBack, settle,
  gotoPage, gameFrame, throttle, FORCE,
};
