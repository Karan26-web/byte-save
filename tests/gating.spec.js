/* PHASE 19 — VIDEO GATE + FIRST-PAGE GATE TESTS (Phases 13 & 15 + the first-page rules).
   Every forward route is probed, not just the visible button. */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

/* Try to move forward by SWIPE (a real pointer drag across the leaf stack). */
async function swipeForward(page) {
  const b = await page.locator("#flipbook").boundingBox();
  const y = b.y + b.height / 2;
  await page.mouse.move(b.x + b.width * 0.85, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(b.x + b.width * (0.85 - 0.09 * i), y, { steps: 2 });
  }
  await page.mouse.up();
  await page.waitForTimeout(1500);          // long enough for a turn to have happened
}

/* Try to move forward by clicking the forward page CORNER of the leaf. */
async function clickCorner(page) {
  const b = await page.locator("#flipbook").boundingBox();
  await page.mouse.click(b.x + b.width - 12, b.y + b.height - 12);
  await page.waitForTimeout(1000);
}

test("every video page starts locked, and every forward route is blocked", async ({ page }) => {
  await H.openBook(page);

  for (const idx of [0, 1, 2, 4]) {          // the four story video pages
    if (idx > 0) {
      // Reach this page by satisfying the previous ones.
      await H.gotoPage(page, idx);
    }
    const s = await H.state(page);
    expect(s.page, "should be on page index " + idx).toBe(idx);
    expect(s.hasVideo, "page " + idx + " should own a video").toBe(true);
    expect(s.videoCompleted, "page " + idx + " must start LOCKED").toBe(false);
    expect(s.canForward, "page " + idx + " must not allow forward yet").toBe(false);

    // 1) the Next arrow
    if (idx === 0) {
      await expect(page.locator("#cornerNext"), "page 0 Next must be absent").toBeHidden();
    } else {
      await expect(page.locator("#cornerNext"), "page " + idx + " Next must be disabled").toBeDisabled();
    }

    // 2) keyboard
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(600);
    expect((await H.state(page)).page, "keyboard bypassed the gate on page " + idx).toBe(idx);

    // 3) swipe / drag
    await swipeForward(page);
    expect((await H.state(page)).page, "swipe bypassed the gate on page " + idx).toBe(idx);

    // 4) page corner
    await clickCorner(page);
    expect((await H.state(page)).page, "corner click bypassed the gate on page " + idx).toBe(idx);

    // 5) programmatic
    await page.evaluate(() => window.Flipbook.goNext());
    await page.waitForTimeout(600);
    expect((await H.state(page)).page, "programmatic call bypassed the gate on page " + idx).toBe(idx);

    // Now release it honestly and confirm it unlocks.
    await H.playVideoToEnd(page);
    const after = await H.state(page);
    expect(after.videoCompleted, "page " + idx + " should unlock on ended").toBe(true);
    expect(after.canForward).toBe(true);
    await expect(page.locator("#cornerNext")).toBeEnabled();
  }
});

test("Next moves exactly one page, and rapid double-taps cannot skip", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);
  await expect(page.locator("#cornerNext")).toBeVisible();

  // Three taps in quick succession: the nav lock must collapse them to ONE turn.
  const btn = page.locator("#cornerNext");
  await btn.click(H.FORCE);
  await btn.click(H.FORCE);
  await btn.click(H.FORCE);
  await page.waitForTimeout(2500);           // well past one FLIP_MS (1150ms)

  expect((await H.state(page)).page, "double/triple tap must advance exactly one page").toBe(1);
});

test("the gate is RE-ARMED when a video page is revisited from the next page", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);
  await H.clickNext(page);                   // page index 1
  expect((await H.state(page)).page).toBe(1);

  await H.clickBack(page);                   // back to page 0
  const s = await H.state(page);
  expect(s.page).toBe(0);
  expect(s.armedFor).toBe(0);
  expect(s.videoCompleted, "revisiting must re-lock, not inherit the old unlock").toBe(false);
  expect(s.canForward).toBe(false);
  // And on page 0 specifically, Next goes back to being ABSENT.
  await expect(page.locator("#cornerNext")).toBeHidden();
});

test("a BROKEN video source still releases the gate via the error path", async ({ page }) => {
  // Break page 1's clip outright before the book ever opens.
  await page.route("**/assets/1.webm", (r) => r.abort());

  const w = H.watch(page);
  await H.openBook(page);

  // No ended event will ever come; the element's `error` must release the gate.
  await page.waitForFunction(() => window.Flipbook.gateState().videoCompleted, null, { timeout: 40000 });
  const s = await H.state(page);
  expect(s.videoCompleted).toBe(true);
  expect(s.canForward).toBe(true);
  await expect(page.locator("#cornerNext")).toBeVisible();

  // The learner is not trapped: forward actually works.
  await H.clickNext(page);
  expect((await H.state(page)).page).toBe(1);

  // Back stayed usable throughout.
  await expect(page.locator("#cornerPrev")).toBeEnabled();
  console.log("broken-video console errors (resource 404/abort is expected):", w.errors.length);
});

test("a STALLED video that never errors is released by the watchdog", async ({ page }) => {
  // Hang the request forever: no data, no error, no metadata → duration unknown, so
  // the 30-second default watchdog is the only release path.
  await page.route("**/assets/1.webm", () => { /* never fulfilled */ });

  await H.openBook(page);
  const before = await H.state(page);
  expect(before.videoCompleted, "must start locked").toBe(false);

  const t0 = Date.now();
  await page.waitForFunction(() => window.Flipbook.gateState().videoCompleted, null, { timeout: 60000 });
  const elapsed = Date.now() - t0;
  console.log("watchdog released the stalled video after", (elapsed / 1000).toFixed(1), "s");

  expect((await H.state(page)).canForward).toBe(true);
  await H.clickNext(page);
  expect((await H.state(page)).page).toBe(1);
});

test("pages WITHOUT a video are never locked by the video gate", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, 3);                 // the LBD 1 game page — no page-owned video
  const s = await H.state(page);
  expect(s.page).toBe(3);
  expect(s.hasVideo).toBe(false);
  expect(s.videoCompleted, "a page with no video starts satisfied").toBe(true);
  expect(s.canForward, "a page with no video must not be gated").toBe(true);
});

/* ---------------- the FIRST-PAGE dual gate (video AND interaction) ------------- */

async function firstPageWithInteraction(page) {
  await H.openBook(page);
  // Declare a required activity on the first story page, then re-arm its gate.
  await page.evaluate(() => {
    window.Flipbook.pages[0].interactive = true;
    window.Flipbook.rearmGate();
  });
  const s = await H.state(page);
  expect(s.hasInteraction).toBe(true);
  expect(s.interactionCompleted).toBe(false);
  return s;
}

test("first page: completing ONLY the video does not reveal Next", async ({ page }) => {
  await firstPageWithInteraction(page);
  await H.playVideoToEnd(page);

  const s = await H.state(page);
  expect(s.videoCompleted).toBe(true);
  expect(s.interactionCompleted).toBe(false);
  expect(s.canForward, "video alone must not open the gate").toBe(false);
  await expect(page.locator("#cornerNext"), "Next must stay ABSENT").toBeHidden();

  // And no route gets through.
  await page.keyboard.press("ArrowRight");
  await swipeForward(page);
  await page.evaluate(() => window.Flipbook.goNext());
  await page.waitForTimeout(500);
  expect((await H.state(page)).page).toBe(0);
});

test("first page: completing ONLY the interaction does not reveal Next", async ({ page }) => {
  await firstPageWithInteraction(page);
  await page.evaluate(() => window.Flipbook.markInteractionComplete());

  const s = await H.state(page);
  expect(s.interactionCompleted).toBe(true);
  expect(s.videoCompleted, "the video is still playing").toBe(false);
  expect(s.canForward, "interaction alone must not open the gate").toBe(false);
  await expect(page.locator("#cornerNext"), "Next must stay ABSENT").toBeHidden();

  await page.keyboard.press("ArrowRight");
  await swipeForward(page);
  await page.waitForTimeout(500);
  expect((await H.state(page)).page).toBe(0);
});

test("first page: completing BOTH reveals Next, which then turns exactly one page", async ({ page }) => {
  await firstPageWithInteraction(page);
  await H.playVideoToEnd(page);
  await page.evaluate(() => window.Flipbook.markInteractionComplete());

  const s = await H.state(page);
  expect(s.videoCompleted).toBe(true);
  expect(s.interactionCompleted).toBe(true);
  expect(s.canForward).toBe(true);

  const next = page.locator("#cornerNext");
  await expect(next).toBeVisible();
  expect(await next.getAttribute("aria-hidden")).toBe("false");
  await expect(next).toBeEnabled();

  await H.clickNext(page);
  expect((await H.state(page)).page).toBe(1);
});

test("first page: an incorrect interaction attempt does not count as completion", async ({ page }) => {
  await firstPageWithInteraction(page);
  await H.playVideoToEnd(page);

  // Taps that are not the successful completion of the activity: random clicks on the
  // page surface must not satisfy the interaction requirement.
  const b = await page.locator("#flipbook").boundingBox();
  for (const [fx, fy] of [[0.2, 0.3], [0.5, 0.7], [0.8, 0.2]]) {
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
    await page.waitForTimeout(120);
  }
  const s = await H.state(page);
  expect(s.interactionCompleted, "stray taps must not complete the activity").toBe(false);
  expect(s.canForward).toBe(false);
  await expect(page.locator("#cornerNext")).toBeHidden();

  // Only the explicit success callback completes it.
  await page.evaluate(() => window.Flipbook.markInteractionComplete());
  expect((await H.state(page)).canForward).toBe(true);
});

test("first page: state resets correctly when the learner returns to it", async ({ page }) => {
  await firstPageWithInteraction(page);
  await H.playVideoToEnd(page);
  await page.evaluate(() => window.Flipbook.markInteractionComplete());
  await H.clickNext(page);
  expect((await H.state(page)).page).toBe(1);

  await H.clickBack(page);
  const s = await H.state(page);
  expect(s.page).toBe(0);
  expect(s.videoCompleted, "video gate must re-arm on return").toBe(false);
  expect(s.interactionCompleted, "interaction gate must re-arm on return").toBe(false);
  await expect(page.locator("#cornerNext"), "Next must not be stale-visible").toBeHidden();
});
