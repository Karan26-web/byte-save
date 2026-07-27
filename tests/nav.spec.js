/* PHASE 19 — NAVIGATION CONTROL TESTS (Phase 14 spec + the first-page rules). */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

const box = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
}, sel);

const overlaps = (a, b) =>
  a && b && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 &&
  Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;

/* The corner-arrow pair is the WHOLE nav surface: Home and the duplicate #prev/#next
   circles were removed, so there is nothing left that could share a screen edge. */
const NAV = ["#cornerPrev", "#cornerNext"];

test("no controls on the cover / start screen", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });
  for (const sel of NAV) {
    await expect(page.locator(sel), sel + " must be hidden on the cover").toBeHidden();
  }
});

test("the removed controls are really gone from the DOM", async ({ page }) => {
  await H.openBook(page);
  for (const sel of ["#homeBtn", "#prev", "#next"]) {
    await expect(page.locator(sel), sel + " must no longer exist").toHaveCount(0);
  }
});

test("controls appear after Start; Back is ABSENT on the first story page", async ({ page }) => {
  await H.openBook(page);

  // Back is display:none — not merely disabled or faded.
  const prevDisplay = await page.locator("#cornerPrev").evaluate((e) => getComputedStyle(e).display);
  expect(prevDisplay, "Back must be display:none on the first story page").toBe("none");
  await expect(page.locator("#cornerPrev")).toBeHidden();

  // Next is also absent initially — the first page's video has not finished.
  await expect(page.locator("#cornerNext")).toBeHidden();
});

/* Home used to be the route back to the cover; Replay on THE END page is now the only
   one. What this test really guards is unchanged: a satisfied first-page gate must not
   survive the reset and leave a stale Next arrow on the cover. */
test("returning to the cover via Replay hides every control again (no stale Next)", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);                     // page 0's gate is now OPEN, Next visible
  await expect(page.locator("#cornerNext")).toBeVisible();

  await H.gotoPage(page, 6);                        // THE END
  await page.locator("#replayBtn").click(H.FORCE);
  await page.waitForFunction(() => !document.body.classList.contains("is-open"), null, { timeout: 12000 });
  await page.waitForTimeout(400);

  // Back on the cover, the satisfied first-page gate must NOT leave Next on screen.
  for (const sel of NAV) {
    await expect(page.locator(sel), sel + " must be hidden after returning to the cover").toBeHidden();
  }
  const s = await H.state(page);
  expect(s.opened).toBe(false);
  expect(s.videoCompleted, "the first-page gate must be cleared on reset").toBe(false);
});

test("Next is disabled on the last page", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, 6);                       // THE END
  const s = await H.state(page);
  expect(s.page).toBe(6);
  await expect(page.locator("#cornerNext")).toBeHidden();   // no forward from THE END
  expect(await page.evaluate(() => document.getElementById("cornerNext").disabled)).toBe(true);
  // Back is still available here; THE END has its own Replay.
  await expect(page.locator("#cornerPrev")).toBeVisible();
});

test("the visible glyphs sit in the clear gutter BELOW the content frame", async ({ page }, testInfo) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);                    // reveal Next
  await H.clickNext(page);                         // page 2: both controls present
  await page.waitForTimeout(250);

  const frame = await box(page, ".book-frame");
  const prev = await box(page, "#cornerPrev svg");
  const next = await box(page, "#cornerNext svg");

  console.log(testInfo.project.name, "frame", JSON.stringify(frame));
  console.log("  prev", JSON.stringify(prev), "next", JSON.stringify(next));

  expect(prev, "Back must be visible on page 2").not.toBeNull();
  expect(next, "Next must be visible on page 2").not.toBeNull();

  expect(overlaps(prev, frame), "Back glyph overlaps the content frame").toBe(false);
  expect(overlaps(next, frame), "Next glyph overlaps the content frame").toBe(false);

  // Both arrows live in the gutter BELOW the book, so the book's turnable corners are
  // never under a button. (nav-layout.spec.js proves this across the whole matrix.)
  expect(prev.t, "Back glyph must sit below the content frame").toBeGreaterThanOrEqual(frame.b - 0.5);
  expect(next.t, "Next glyph must sit below the content frame").toBeGreaterThanOrEqual(frame.b - 0.5);
});

test("control geometry matches the required responsive sizes", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);
  await H.clickNext(page);

  // The single --nav-btn token: clamp(56px, min(8vmin, 22dvh, 30vw), 112px). fitScale()
  // mirrors it in JS to size the reserved gutter and publishes the result as
  // --nav-btn-px; if the mirror ever drifts from the CSS, this fails.
  const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
  const expected = Math.max(56, Math.min(
    0.08 * Math.min(vp.w, vp.h), 0.22 * vp.h, 0.30 * vp.w, 112));
  const published = await page.evaluate(() => parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--nav-btn-px")));
  expect(published, "--nav-btn-px must match the CSS token").toBeCloseTo(expected, 1);

  for (const sel of NAV) {
    const b = await box(page, sel);
    expect(Math.round(b.w), sel + " width").toBe(Math.round(expected));
    expect(Math.round(b.h), sel + " height").toBe(Math.round(expected));
    expect(b.w, sel + " must stay a 44px touch target").toBeGreaterThanOrEqual(44);
    expect(b.h, sel + " must stay a 44px touch target").toBeGreaterThanOrEqual(44);
  }
  // Glyph fill ratio: ~62% of the button box for both arrows.
  const ratio = async (btn) => {
    const a = await box(page, btn), g = await box(page, btn + " svg");
    return g.w / a.w;
  };
  expect(await ratio("#cornerPrev")).toBeCloseTo(0.62, 1);
  expect(await ratio("#cornerNext")).toBeCloseTo(0.62, 1);

  // Corner anchoring — opposite ends of the bottom gutter, and FULLY on screen (the
  // old rule allowed the box to hang off the bottom edge on a negative offset).
  const prev = await box(page, "#cornerPrev"), next = await box(page, "#cornerNext");
  expect(prev.l).toBeLessThan(vp.w / 2);
  expect(next.r).toBeGreaterThan(vp.w / 2);
  expect(prev.b, "Back must be fully inside the viewport").toBeLessThanOrEqual(vp.h + 0.5);
  expect(next.b, "Next must be fully inside the viewport").toBeLessThanOrEqual(vp.h + 0.5);
  expect(prev.t, "Back must not be clipped off the top").toBeGreaterThanOrEqual(-0.5);
  expect(next.t, "Next must not be clipped off the top").toBeGreaterThanOrEqual(-0.5);
});

test("Back stays mirrored, and hover / active transforms work without un-mirroring it", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);
  await H.clickNext(page);

  // The mirror lives on the nested <svg>, so the button's own scale can't overwrite it.
  const svgT = await page.locator("#cornerPrev svg").evaluate((e) => getComputedStyle(e).transform);
  expect(svgT, "Back arrow must be mirrored via scaleX(-1)").toMatch(/matrix\(-1,\s*0,\s*0,\s*1/);

  // Hover scales the BUTTON; the svg keeps its mirror.
  await page.locator("#cornerPrev").hover({ force: true });
  await page.waitForTimeout(220);
  const hoverT = await page.locator("#cornerPrev").evaluate((e) => getComputedStyle(e).transform);
  expect(hoverT, "hover should scale the button").toMatch(/matrix\(1\.1/);
  const svgStill = await page.locator("#cornerPrev svg").evaluate((e) => getComputedStyle(e).transform);
  expect(svgStill, "mirror must survive hover").toMatch(/matrix\(-1,\s*0,\s*0,\s*1/);

  // Active state scales down.
  const active = await page.locator("#cornerNext").evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    return getComputedStyle(el).transform + "|" + r.width;
  });
  expect(active).toBeTruthy();
  const activeRule = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText === ".corner-arrow:active") return r.style.transform;
      }
    }
    return null;
  });
  expect(activeRule).toBe("scale(0.9)");
});

test("disabled controls are faded and non-interactive", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);
  await H.clickNext(page);                         // page 2 — its video is playing, Next disabled
  await page.waitForTimeout(500);                  // let the 400ms opacity transition settle

  const st = await page.locator("#cornerNext").evaluate((e) => ({
    disabled: e.disabled,
    ariaDisabled: e.getAttribute("aria-disabled"),
    opacity: getComputedStyle(e).opacity,
    pointerEvents: getComputedStyle(e).pointerEvents,
  }));
  expect(st.disabled).toBe(true);
  expect(st.ariaDisabled).toBe("true");
  expect(Number(st.opacity)).toBeCloseTo(0.22, 2);
  expect(st.pointerEvents).toBe("none");
});

test("controls keep accessible names and remain real buttons (focus ring removed, semantics kept)", async ({ page }) => {
  await H.openBook(page);
  const info = await page.evaluate((sels) => sels.map((s) => {
    const e = document.querySelector(s);
    return { sel: s, tag: e.tagName, label: e.getAttribute("aria-label"), outline: getComputedStyle(e).outlineStyle };
  }), NAV);
  for (const i of info) {
    expect(i.tag, i.sel + " must stay a real <button>").toBe("BUTTON");
    expect(i.label, i.sel + " needs an accessible name").toBeTruthy();
  }
});

test("Back remains usable while a page video is playing", async ({ page }) => {
  await H.openBook(page);
  await H.playVideoToEnd(page);
  await H.clickNext(page);                        // page 2, video playing → Next locked

  await expect(page.locator("#cornerNext")).toBeDisabled();
  await expect(page.locator("#cornerPrev")).toBeEnabled();

  await H.clickBack(page);                        // Back works mid-video
  expect((await H.state(page)).page).toBe(0);
});
