/* Regression guard for the cloud-curtain transition (the "Play button stutters on
   tablets" bug). The root cause was NOT the image format — it was CSS filters
   (drop-shadow on every animating cloud + saturate/brightness on the back banks)
   forcing ~60 moving layers through an offscreen re-raster every frame, plus the
   welcome/route screens ANIMATING backdrop-filter's blur radius behind a closed
   curtain. These tests pin the fix, deliberately WITHOUT pinning the asset format:
   converting SVG↔WebP neither caused nor fixes this, so it stays a free choice.

   The frame-rate test is an A/B inside one run (shipped CSS vs the old filters
   re-injected, same page, same CPU throttle) so a loaded machine can't flake it. */
"use strict";

const { test, expect, devices } = require("@playwright/test");

const GAMES = [
  { name: "LBD 1", url: "/LBD%201/index.html" },
  { name: "LBD 2", url: "/LBD%202/Right-and-Left/index.html" },
];

/* The old, removed effects — re-injected only to prove the shipped CSS beats them. */
const LEGACY_FILTERS = `
  #fieldCurtain .cloud{filter:drop-shadow(0 14px 18px rgba(30,60,90,.35)) !important;}
  #fieldCurtain .clouds.back{filter:saturate(.82) brightness(1.06) !important;}
`;

/* Drive one full curtain sweep purely through the CSS classes the game itself uses
   (.show → .part) and count real rendered frames with requestAnimationFrame. */
async function measureSweep(page) {
  return page.evaluate(async () => {
    const fc = document.getElementById("fieldCurtain");
    fc.classList.remove("warm", "part", "closed");
    const deltas = [];
    let running = true, last = 0;
    const tick = (t) => {
      if (last) deltas.push(t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    fc.classList.add("show");                      // clouds drift in
    await new Promise((r) => setTimeout(r, 850));
    fc.classList.add("part");                      // clouds part back out
    await new Promise((r) => setTimeout(r, 850));
    running = false;
    fc.classList.remove("show", "part");
    const total = deltas.reduce((a, b) => a + b, 0);
    return {
      fps: deltas.length / (total / 1000),
      worst: Math.max(...deltas),
      freezes: deltas.filter((d) => d > 250).length,
    };
  });
}

for (const game of GAMES) {
  test.describe(`${game.name} curtain`, () => {
    test("clouds carry no CSS filters (the tablet-stutter root cause)", async ({ page }) => {
      await page.goto(game.url);
      await page.waitForSelector("#fieldCurtain .cloud", { state: "attached" });
      const audit = await page.evaluate(() => {
        const layers = [
          ...document.querySelectorAll("#fieldCurtain .cloud"),
          ...document.querySelectorAll("#fieldCurtain .clouds"),
          ...document.querySelectorAll("#fieldCurtain .cloud-bank"),
        ];
        return {
          clouds: document.querySelectorAll("#fieldCurtain .cloud").length,
          filtered: layers
            .filter((el) => getComputedStyle(el).filter !== "none")
            .map((el) => el.className),
        };
      });
      // If the curtain markup ever changes shape, fail loudly instead of vacuously passing.
      expect(audit.clouds).toBeGreaterThan(20);
      // The actual pin: not one animating curtain layer may carry a filter.
      expect(audit.filtered).toEqual([]);
    });

    test("sweep holds frame rate — shipped CSS vs legacy filters, same run", async ({ page }) => {
      await page.goto(game.url);
      await page.waitForSelector("#fieldCurtain .cloud", { state: "attached" });
      // Curtain sits under the start screen (z 82 vs 95); lift it so the compositor
      // treats it exactly like a real, visible sweep.
      await page.evaluate(() => {
        document.getElementById("fieldCurtain").style.zIndex = "9999";
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

      await measureSweep(page);                       // untimed pass: first-paint SVG rasters land here
      const shipped = await measureSweep(page);
      const legacy = await page.addStyleTag({ content: LEGACY_FILTERS });
      const filtered = await measureSweep(page);
      await legacy.evaluate((el) => el.remove());
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

      // A/B: shipped must never be slower than the filtered build it replaced.
      expect(shipped.fps + 2).toBeGreaterThanOrEqual(filtered.fps);
      // Absolute floor under 4× CPU throttle — the shipped sweep is transform-only,
      // so anything below this means a per-frame raster cost crept back in.
      expect(shipped.fps).toBeGreaterThan(25);
      expect(shipped.freezes).toBeLessThanOrEqual(1);
    });
  });
}

test.describe("LBD 2 welcome/route blur", () => {
  test("touch devices snap the backdrop blur instead of animating its radius", async ({ browser }) => {
    // pointer:coarse context — the profile the fix targets (tablets).
    const ctx = await browser.newContext({
      ...devices["iPad (gen 7) landscape"],
      baseURL: test.info().project.use.baseURL,
    });
    const page = await ctx.newPage();
    await page.goto("/LBD%202/Right-and-Left/index.html");
    const probe = await page.evaluate(() => ({
      coarse: matchMedia("(pointer:coarse)").matches,
      welcome: getComputedStyle(document.getElementById("welcome")).transitionProperty,
      route: getComputedStyle(document.getElementById("routeScreen")).transitionProperty,
    }));
    expect(probe.coarse).toBe(true);                 // emulation sanity — keeps the pin honest
    expect(probe.welcome).not.toContain("backdrop-filter");
    expect(probe.route).not.toContain("backdrop-filter");
    await ctx.close();
  });

  test("desktops keep the animated blur radius (the fix is touch-only)", async ({ page }) => {
    await page.goto("/LBD%202/Right-and-Left/index.html");
    const probe = await page.evaluate(() => ({
      coarse: matchMedia("(pointer:coarse)").matches,
      welcome: getComputedStyle(document.getElementById("welcome")).transitionProperty,
    }));
    expect(probe.coarse).toBe(false);
    expect(probe.welcome).toContain("backdrop-filter");
  });
});

test.describe("LBD 2 first-sweep warm-up", () => {
  test("curtain pre-paints invisibly on the start screen, then fully retracts", async ({ page }) => {
    // The .warm pass lasts exactly two frames and is gone within ~32ms, so it cannot be
    // polled for after the fact — sample every frame from before any page script runs.
    // (A MutationObserver is the obvious tool and does NOT work here: init scripts run
    // before the parser creates documentElement, so observe() has no node to watch.)
    await page.addInitScript(() => {
      window.__warm = { seen: false, maxOpacity: 0, clouds: 0 };
      const sample = () => {
        const fc = document.getElementById("fieldCurtain");
        if (fc && fc.classList.contains("warm")) {
          window.__warm.seen = true;
          window.__warm.clouds = fc.querySelectorAll(".cloud").length;
          window.__warm.maxOpacity = Math.max(
            window.__warm.maxOpacity,
            parseFloat(getComputedStyle(fc).opacity) || 0
          );
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto("/LBD%202/Right-and-Left/index.html");
    await page.waitForFunction(() => window.__warm.seen, null, { timeout: 10000 });
    const seen = await page.evaluate(() => window.__warm);
    // The point of the warm pass is rasterising the real clouds — an empty curtain would
    // "warm" nothing, so assert it had the full set to paint.
    expect(seen.clouds).toBeGreaterThan(20);
    expect(seen.maxOpacity).toBeLessThan(0.01);      // the learner must never see the warm pass
    await expect
      .poll(async () => page.evaluate(() =>
        document.getElementById("fieldCurtain").classList.contains("warm")))
      .toBe(false);                                  // …and it must fully strip itself
    // The start screen must still be the visible one: warming may not leak the playscreen.
    await expect(page.locator("#startScreen")).not.toHaveClass(/hide/);
  });
});
