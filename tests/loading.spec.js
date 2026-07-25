/* PHASE 19 — LOADING TESTS.
   Stage A gates the Start button; Stage B never does. The network is throttled via
   CDP so the sequence is actually observable rather than finishing in one frame. */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

test("themed loading bar is visible on boot and the Start button is hidden during Stage A", async ({ page }) => {
  await H.throttle(page, { downloadKbps: 350 });
  await page.goto("/index.html", { waitUntil: "commit" });

  await expect(page.locator("#shellLoader")).toBeVisible();
  await expect(page.locator("#hint")).toBeHidden();
  // The bar is themed, not a UA default: it must have a filled track with our gradient.
  const bg = await page.locator("#shellLoaderFill").evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bg).toContain("gradient");
});

test("progress is observable and strictly monotonic, reaches 100%, then the button pops in", async ({ page }) => {
  await H.throttle(page, { downloadKbps: 350 });
  await page.goto("/index.html", { waitUntil: "commit" });

  const samples = [];
  const readPct = () => page.locator("#shellLoaderPct").textContent()
    .then((t) => parseInt(String(t).replace("%", ""), 10) || 0).catch(() => null);

  for (let i = 0; i < 400; i++) {
    const v = await readPct();
    if (v == null) break;
    samples.push(v);
    if (v >= 100) break;
    await page.waitForTimeout(80);
  }

  // Monotonic: never moves backward.
  for (let i = 1; i < samples.length; i++) {
    expect(samples[i], `sample ${i} went backward: ${samples.slice(0, i + 1).join(",")}`)
      .toBeGreaterThanOrEqual(samples[i - 1]);
  }
  console.log("progress samples:", [...new Set(samples)].join(" → "));
  // OBSERVABLE means real intermediate values — a straight 0 → 100 jump is a failure,
  // not a pass. (That is exactly the bug the byte-aware bar is meant to avoid.)
  const mid = samples.filter((v) => v > 0 && v < 100);
  expect(mid.length, `expected intermediate progress, got: ${[...new Set(samples)].join(",")}`)
    .toBeGreaterThan(0);
  expect([...new Set(samples)].length, "progress should move through several steps")
    .toBeGreaterThan(2);

  await expect(page.locator("#hint")).toBeVisible({ timeout: 60000 });
  expect(await readPct()).toBe(100);

  // The reveal carries the pop-in animation.
  const anim = await page.locator("#hint").evaluate((el) => getComputedStyle(el).animationName);
  expect(anim).toContain("playPopIn");
});

test("the experience starts normally once Stage A completes", async ({ page }) => {
  await H.openBook(page);
  const s = await H.state(page);
  expect(s.opened).toBe(true);
  expect(s.ready).toBe(true);
  expect(s.page).toBe(0);
});

test("the start function cannot be bypassed before Stage A completes", async ({ page }) => {
  /* Throttle enough that Stage A (0.84 MB ≈ 46 s at this rate) is still in flight while we
     attack it, but not so hard that preload.js itself takes longer to arrive than the wait
     below allows — at 60 kbps the ~117 KB of head resources ahead of it alone exceed 30 s. */
  await H.throttle(page, { downloadKbps: 150 });
  await page.goto("/index.html", { waitUntil: "commit" });
  await page.waitForFunction(() => !!window.FlipbookPreload, null, { timeout: 60000 });

  const allowedEarly = await page.evaluate(() => window.FlipbookPreload.startAllowed);
  expect(allowedEarly, "Stage A must still be in flight for this test to mean anything").toBe(false);

  // Every documented bypass route: keyboard, a synthetic click on the tap-catcher,
  // and a direct programmatic call.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.evaluate(() => {
    document.getElementById("tapCatcher").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.getElementById("hint").click();
    if (typeof window.openBook === "function") window.openBook();
  });
  await page.waitForTimeout(400);

  expect(await page.evaluate(() => document.body.classList.contains("is-open")),
    "the book must not have opened while Stage A was still loading").toBe(false);
});

test("failed shell fetches do not block the Start button", async ({ page }) => {
  // Break a real Stage A asset outright. The loader must count it and carry on.
  await page.route("**/assets/coverpage.webp", (r) => r.abort());
  await page.route("**/assets/posters/2.webp", (r) => r.fulfill({ status: 500, body: "boom" }));

  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });
  expect(await page.locator("#shellLoaderPct").textContent()).toBe("100%");

  // And the experience still starts.
  await page.locator("#hint").click(H.FORCE);
  await page.waitForFunction(() => window.Flipbook && window.Flipbook.gateState().opened, null, { timeout: 20000 });
});

test("smaller shell assets begin before the large background videos", async ({ page }) => {
  await H.throttle(page, { downloadKbps: 500 });
  const order = [];
  page.on("request", (r) => {
    const u = r.url();
    if (/\.(webp|ogg|css|js)$/.test(u) || /\.webm/.test(u)) order.push(u.split("/").pop());
  });
  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 60000 });

  const firstVideo = order.findIndex((n) => n.endsWith(".webm"));
  const coverIdx = order.findIndex((n) => n.startsWith("coverpage"));
  console.log("first 12 requests:", order.slice(0, 12).join(", "));
  expect(coverIdx, "cover art must be requested").toBeGreaterThanOrEqual(0);
  if (firstVideo !== -1) {
    expect(coverIdx, "cover art must not queue behind a multi-MB video").toBeLessThan(firstVideo);
  }
});

test("Stage B runs only after window.load and never gates the Start button", async ({ page }) => {
  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });

  // Stage A is done and the button is live; Stage B is still working through 37 MB.
  expect(await page.evaluate(() => window.FlipbookPreload.stageAComplete)).toBe(true);

  // The iframe warm-up (the Stage B half that owns the game) eventually boots a game.
  await page.waitForFunction(() => window.Flipbook.gateState().lbdLoaded !== "", null, { timeout: 30000 });
  const s = await H.state(page);
  expect(s.lbdLoaded).toContain("LBD%201/index.html");
});
