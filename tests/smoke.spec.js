/* Quick diagnostic smoke run — surfaces console errors and failed requests early,
   before the full suite. Not part of the acceptance criteria. */
const { test, expect } = require("@playwright/test");

test("smoke: boot, Stage A, open, first page", async ({ page }) => {
  const errors = [];
  const failed = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("response", (r) => { if (r.status() >= 400) failed.push(r.status() + " " + r.url()); });

  await page.goto("/index.html");

  // Stage A completes → button appears. (Stage A is only ~0.9 MB, so over localhost
  // it finishes almost instantly; the throttled loader assertions live in
  // loading.spec.js where CDP slows the network enough to observe the sequence.)
  await expect(page.locator("#hint")).toBeVisible({ timeout: 30000 });
  const pct = await page.locator("#shellLoaderPct").textContent();
  console.log("Stage A final:", pct);

  // force: the Play button carries an infinite "breathing" animation, so Playwright's
  // stability check never settles. A real tap is unaffected.
  await page.locator("#hint").click({ force: true });
  await page.waitForFunction(() => window.Flipbook && window.Flipbook.gateState().ready, null, { timeout: 15000 });

  const st = await page.evaluate(() => window.Flipbook.gateState());
  console.log("gate on page 1:", JSON.stringify(st));

  console.log("CONSOLE ERRORS:", errors.length ? errors : "none");
  console.log("FAILED REQUESTS:", failed.length ? failed : "none");
  expect(errors, "console errors").toEqual([]);
  expect(failed, "failed requests").toEqual([]);
});
