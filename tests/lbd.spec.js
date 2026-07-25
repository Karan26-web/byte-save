/* PHASE 19 — EMBEDDED LBD TESTS (Phases 3-10 + the parent overlay behaviour). */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

const LBD1_PAGE = 3;      // immediately after story page 3
const LBD2_PAGE = 5;      // immediately after story page 4

/* Is ANY sound actually playing inside the game? Covers the DOM media elements plus
   the JS-created Audio objects the games hold (which never appear in the DOM). */
async function audioActivity(frame) {
  return frame.evaluate(() => {
    const playing = [];
    const check = (a, name) => {
      if (!a) return;
      if (!a.paused && !a.ended && a.currentTime > 0) playing.push(name + " @" + a.currentTime.toFixed(2));
    };
    document.querySelectorAll("audio,video").forEach((el, i) => check(el, "dom:" + (el.id || el.tagName + i)));
    const api = window.__lbd || {};
    if (api.audio) {                                  // LBD 1's AudioManager
      check(api.audio.theme, "theme");
      for (const k in api.audio.files) check(api.audio.files[k], "sfx:" + k);
      for (const k in api.audio.voices) check(api.audio.voices[k], "vo:" + k);
    }
    check(api.bgm, "bgm");                            // LBD 2
    for (const k in (api.VO || {})) check(api.VO[k], "vo:" + k);
    check(api.endVideo, "endVideo");
    return playing;
  });
}

test("iframe src is assigned during idle AFTER window.load, and the game boots HIDDEN and SILENT", async ({ page }) => {
  const w = H.watch(page);
  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });

  // Nothing is loaded into the iframe before window.load + an idle slice.
  await page.waitForFunction(() => window.Flipbook.gateState().lbdLoaded !== "", null, { timeout: 30000 });
  const s = await H.state(page);
  expect(s.lbdLoaded, "the UPCOMING game (LBD 1) is the one warmed").toContain("LBD%201/index.html");

  // It reported ready, so its intro has painted — while still hidden.
  await page.waitForFunction(() => window.Flipbook.gateState().lbdReadySrc !== "", null, { timeout: 30000 });
  expect((await H.state(page)).overlayVisible, "the overlay must stay hidden").toBe(false);
  await expect(page.locator("#lbdOverlay")).toHaveAttribute("aria-hidden", "true");

  // …and it is SILENT. Give it several seconds of hidden runtime to misbehave in.
  const frame = await H.gameFrame(page);
  for (let i = 0; i < 6; i++) {
    const playing = await audioActivity(frame);
    expect(playing, "hidden game must be silent, but heard: " + playing.join(", ")).toEqual([]);
    await page.waitForTimeout(700);
  }
  expect(w.failed).toEqual([]);
});

test("no dev / QA / cheat controls survive in either game", async ({ page }) => {
  const requested = [];
  page.on("request", (r) => requested.push(r.url()));

  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });
  const frame = await H.gameFrame(page);

  // LBD 1's level-jump / win / restart panel is gone, markup and all.
  expect(await frame.locator("#debugBar").count(), "#debugBar must not exist").toBe(0);
  expect(await frame.evaluate(() => document.querySelectorAll("[data-jump]").length)).toBe(0);
  expect(await frame.evaluate(() => typeof window.game)).toBe("undefined");
  expect(await frame.evaluate(() => !!(window.__lbd && window.__lbd.game && window.__lbd.game.jumpToLevel)),
    "the jumpToLevel god-mode entry point must be gone").toBe(false);

  // Pressing D must not summon anything.
  await frame.locator("body").press("d").catch(() => {});
  await page.waitForTimeout(250);
  expect(await frame.locator("#debugBar").count()).toBe(0);

  // LBD 2's dev screen navigator is never requested (the file is deleted).
  expect(requested.some((u) => /screen\.js/.test(u)), "screen.js must not be requested").toBe(false);
});

test("?debug=1 and other dev query params do nothing", async ({ page }) => {
  await page.goto("/LBD%201/index.html?debug=1");
  await page.waitForLoadState("load");
  expect(await page.locator("#debugBar").count()).toBe(0);

  await page.goto("/LBD%202/Right-and-Left/index.html?auto=correct&map=1&lvl=3");
  await page.waitForLoadState("load");
  await page.waitForTimeout(1500);
  // The start screen is still up: no self-play, no map preview, no level skip.
  await expect(page.locator("#startScreen")).toBeVisible();
  expect(await page.evaluate(() => window.__lbd.levelIdx), "?lvl must not skip ahead").toBe(0);
  expect(await page.evaluate(() => window.__lbd.runActive)).toBe(false);
});

test("hidden-level sprites and later narration are warmed during idle", async ({ page }) => {
  const got = new Set();
  page.on("response", (r) => { if (r.status() === 200) got.add(decodeURIComponent(r.url())); });

  await page.goto("/index.html");
  await expect(page.locator("#hint")).toBeVisible({ timeout: 40000 });
  await H.gameFrame(page);
  await page.waitForTimeout(9000);            // let the idle warmer work through its slices

  const has = (frag) => [...got].some((u) => u.includes(frag));
  // A background only reachable on a LATER level (never shown on the intro screen):
  expect(has("Background8.webp"), "hidden-level sprite should be warmed").toBe(true);
  // Narration that only plays deep in the game:
  expect(has("That pod is far from Byte.ogg"), "later narration should be warmed").toBe(true);
  // The closing line, needed only at the very end:
  expect(has("Byte Saved the Day.ogg"), "closing VO should be warmed").toBe(true);
});

test("the overlay stays hidden on every page before the game page", async ({ page }) => {
  await H.openBook(page);
  for (const target of [0, 1, 2]) {
    await H.gotoPage(page, target);
    const s = await H.state(page);
    expect(s.page).toBe(target);
    expect(s.overlayVisible, "overlay must be hidden on page " + target).toBe(false);
    await expect(page.locator("#lbdOverlay")).toHaveAttribute("aria-hidden", "true");
    expect(s.lbdFullscreen).toBe(false);
  }
});

test("landing on the game page reveals the warmed intro at PAGE-FRAME size with no spinner", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, LBD1_PAGE);

  const s = await H.state(page);
  expect(s.page).toBe(LBD1_PAGE);
  expect(s.overlayVisible, "the overlay should be revealed on arrival").toBe(true);
  expect(s.lbdFullscreen, "it must NOT jump straight to fullscreen").toBe(false);
  expect(s.lbdStarted).toBe(false);
  await expect(page.locator("#lbdOverlay")).toHaveAttribute("aria-hidden", "false");

  // It is parked over the content frame, not filling the viewport.
  const geo = await page.evaluate(() => {
    const o = document.getElementById("lbdOverlay").getBoundingClientRect();
    const f = document.querySelector(".flip-scale").getBoundingClientRect();
    return { o: { l: o.left, t: o.top, w: o.width, h: o.height },
             f: { l: f.left, t: f.top, w: f.width, h: f.height },
             vw: innerWidth, vh: innerHeight };
  });
  expect(Math.abs(geo.o.w - geo.f.w), "overlay width should match the page frame").toBeLessThan(2);
  expect(Math.abs(geo.o.h - geo.f.h), "overlay height should match the page frame").toBeLessThan(2);
  expect(geo.o.w, "overlay must not be viewport-wide before Play").toBeLessThan(geo.vw - 10);

  // No spinner / second loading screen: the game's own intro is already painted, and
  // its Play button is live (LBD 1 has no loading gate; LBD 2's would have released).
  const frame = await H.gameFrame(page);
  await expect(frame.locator("#startScreen .play-btn")).toBeVisible();
  expect(await frame.evaluate(() => document.querySelector("#startScreen .play-btn").disabled)).toBe(false);
  // Still silent until the learner taps.
  expect(await audioActivity(frame)).toEqual([]);
});

test("tapping the real Play button sends lbd-start → fullscreen, chrome hidden, no reload", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, LBD1_PAGE);
  const frame = await H.gameFrame(page);

  // Count iframe navigations so we can prove the expansion does not reload the game.
  const navs = [];
  page.on("framenavigated", (f) => { if (f !== page.mainFrame()) navs.push(f.url()); });
  const navsBefore = navs.length;

  await frame.locator("#startScreen .play-btn").click(H.FORCE);

  await page.waitForFunction(() => window.Flipbook.gateState().lbdFullscreen, null, { timeout: 10000 });
  const s = await H.state(page);
  expect(s.lbdStarted, "lbd-start must have been received").toBe(true);
  expect(s.lbdFullscreen).toBe(true);

  // The documented fullscreen class is applied to the overlay and to <body>.
  await expect(page.locator("#lbdOverlay")).toHaveClass(/lbd-is-fullscreen/);
  expect(await page.evaluate(() => document.body.classList.contains("lbd-fullscreen"))).toBe(true);

  await page.waitForTimeout(600);   // let the 400ms box-morph finish

  // TRUE fullscreen: the overlay fills the viewport.
  const geo = await page.evaluate(() => {
    const o = document.getElementById("lbdOverlay").getBoundingClientRect();
    return { w: o.width, h: o.height, l: o.left, t: o.top, vw: innerWidth, vh: innerHeight };
  });
  expect(geo.l).toBeCloseTo(0, 0);
  expect(geo.t).toBeCloseTo(0, 0);
  expect(geo.w).toBeCloseTo(geo.vw, 0);
  expect(geo.h).toBeCloseTo(geo.vh, 0);

  // ALL flipbook chrome is removed from the layout.
  for (const sel of ["#cornerPrev", "#cornerNext", "#homeBtn"]) {
    const d = await page.locator(sel).evaluate((e) => getComputedStyle(e).display);
    expect(d, sel + " must be display:none in fullscreen").toBe("none");
  }

  // The iframe did NOT reload during the expansion.
  expect(navs.length, "the iframe must not navigate while expanding").toBe(navsBefore);
  expect(await frame.evaluate(() => document.querySelector("#startScreen").classList.contains("hide")),
    "the game moved on from its start screen — it kept running").toBe(true);

  // No story page can turn underneath the live game, by any route.
  const pageBefore = (await H.state(page)).page;
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await page.evaluate(() => { window.Flipbook.goNext(); window.Flipbook.goPrev(); });
  await page.waitForTimeout(800);
  expect((await H.state(page)).page, "navigation must be blocked while fullscreen").toBe(pageBefore);
});

test("LBD 1 is playable, and completion waits for the closing narration before advancing", async ({ page }) => {
  test.setTimeout(180000);
  await H.openBook(page);
  await H.gotoPage(page, LBD1_PAGE);
  const frame = await H.gameFrame(page);
  await frame.locator("#startScreen .play-btn").click(H.FORCE);
  await page.waitForFunction(() => window.Flipbook.gateState().lbdFullscreen, null, { timeout: 10000 });

  // PLAYABLE: the game runs its intro, narrates, and reaches its interactive state.
  await page.waitForFunction(() => {
    const d = document.getElementById("lbdFrame").contentDocument;
    return d && d.querySelectorAll(".pod").length > 0;
  }, null, { timeout: 60000 });
  expect(await frame.evaluate(() => document.querySelectorAll(".pod").length),
    "pods should be on the field — the game is live").toBeGreaterThan(0);
  const sounding = await audioActivity(frame);
  console.log("LBD 1 audio after Play (expected non-empty):", sounding.join(", ") || "(none yet)");

  // Drive the game's REAL success function (the same one the bridge wraps). This is
  // the game's own completion path, not a debug shortcut.
  await frame.evaluate(() => window.__lbd.game.win());

  // The win splash is up and the closing line is playing — Next must be held inert
  // until that narration finishes, so completion cannot fire early.
  await expect(frame.locator("#win")).toHaveClass(/show/);
  const heldState = await frame.evaluate(() => {
    const b = document.getElementById("replayBtn");
    return { disabled: b.disabled, opacity: b.style.opacity, pe: b.style.pointerEvents };
  });
  expect(heldState.disabled, "Next must be inert while the closing VO plays").toBe(true);

  // Tapping it while held must NOT complete.
  await frame.locator("#replayBtn").click(H.FORCE).catch(() => {});
  await page.waitForTimeout(400);
  expect((await H.state(page)).page, "an early tap must not advance the story").toBe(LBD1_PAGE);

  // The narration's real `ended` (2.5s clip; watchdog would be duration+4s) releases it.
  await frame.locator("#replayBtn").evaluate((b) =>
    new Promise((res) => {
      if (!b.disabled) return res();
      const iv = setInterval(() => { if (!b.disabled) { clearInterval(iv); res(); } }, 100);
      setTimeout(() => { clearInterval(iv); res(); }, 20000);
    }));
  expect(await frame.evaluate(() => document.getElementById("replayBtn").disabled),
    "Next should be live once the closing VO has finished").toBe(false);

  // NOW the tap completes: overlay leaves fullscreen and the story advances by itself.
  await frame.locator("#replayBtn").click(H.FORCE);
  await page.waitForFunction((p) => window.Flipbook.gateState().page === p + 1, LBD1_PAGE, { timeout: 20000 });

  const s = await H.state(page);
  expect(s.page, "the flipbook must advance automatically on completion").toBe(LBD1_PAGE + 1);
  expect(s.lbdFullscreen, "must leave fullscreen").toBe(false);
  expect(s.overlayVisible, "the overlay must be hidden after completion").toBe(false);
  expect(await page.evaluate(() => document.body.classList.contains("lbd-fullscreen"))).toBe(false);

  // Chrome is back for the new page.
  await expect(page.locator("#homeBtn")).toBeVisible();
  await expect(page.locator("#cornerPrev")).toBeVisible();
  // The new page is a video page, so its gate re-armed.
  expect(s.hasVideo).toBe(true);
  expect(s.videoCompleted, "the new page's video gate must be armed").toBe(false);
});

test("after completion the iframe is torn down, silenced and re-warmed; revisiting shows a fresh intro", async ({ page }) => {
  test.setTimeout(180000);
  await H.openBook(page);
  await H.gotoPage(page, LBD1_PAGE);
  let frame = await H.gameFrame(page);
  await frame.locator("#startScreen .play-btn").click(H.FORCE);
  await page.waitForFunction(() => window.Flipbook.gateState().lbdFullscreen, null, { timeout: 10000 });
  await page.waitForTimeout(1500);

  await frame.evaluate(() => window.__lbd.game.win());
  await frame.locator("#replayBtn").evaluate((b) =>
    new Promise((res) => { const iv = setInterval(() => { if (!b.disabled) { clearInterval(iv); res(); } }, 100); setTimeout(() => { clearInterval(iv); res(); }, 20000); }));
  await frame.locator("#replayBtn").click(H.FORCE);
  await page.waitForFunction((p) => window.Flipbook.gateState().page === p + 1, LBD1_PAGE, { timeout: 20000 });

  // ALL game audio is dead after leaving — nothing bleeds onto the story page.
  await page.waitForTimeout(1200);
  const stillPlaying = await page.evaluate(() => {
    const d = document.getElementById("lbdFrame").contentDocument;
    if (!d) return ["(no document — torn down)"];
    const out = [];
    d.querySelectorAll("audio,video").forEach((el) => { if (!el.paused) out.push(el.src); });
    return out;
  });
  expect(stillPlaying.filter((x) => !x.startsWith("(")), "no game media may still be playing").toEqual([]);

  // It re-warmed in the background — and to the NEXT game, since LBD 1 is behind us.
  await page.waitForFunction(() => window.Flipbook.gateState().lbdLoaded !== "", null, { timeout: 30000 });
  const s = await H.state(page);
  expect(s.lbdLoaded, "the upcoming game (LBD 2) should now be the warm one").toContain("LBD%202");
  expect(s.lbdStarted, "a fresh session, not a resumed one").toBe(false);

  // Going BACK to LBD 1's page shows a fresh intro, instantly.
  await H.clickBack(page);
  expect((await H.state(page)).page).toBe(LBD1_PAGE);
  await page.waitForFunction(() => window.Flipbook.gateState().overlayVisible, null, { timeout: 15000 });
  frame = await H.gameFrame(page);
  await expect(frame.locator("#startScreen")).toBeVisible();
  expect(await frame.evaluate(() => document.querySelector("#startScreen").classList.contains("hide")),
    "revisit must start from the intro, not mid-game").toBe(false);
  expect(await frame.locator("#win").evaluate((e) => e.classList.contains("show")),
    "the old win splash must not persist").toBe(false);
  expect((await H.state(page)).lbdFullscreen, "revisit must not be fullscreen").toBe(false);
});

test("leaving the game page BEFORE starting kills it and re-warms", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, LBD1_PAGE);
  expect((await H.state(page)).overlayVisible).toBe(true);

  await H.clickBack(page);                      // leave without ever tapping Play
  const s = await H.state(page);
  expect(s.page).toBe(LBD1_PAGE - 1);
  expect(s.overlayVisible, "overlay must hide").toBe(false);
  expect(s.lbdFullscreen).toBe(false);

  // Silently re-warmed for the next visit.
  await page.waitForFunction(() => window.Flipbook.gateState().lbdReadySrc !== "", null, { timeout: 30000 });
  const frame = await H.gameFrame(page);
  expect(await audioActivity(frame), "the re-warmed game must be silent").toEqual([]);
});

test("HOME from a live fullscreen game clears the overlay, fullscreen and all audio", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, LBD1_PAGE);
  const frame = await H.gameFrame(page);
  await frame.locator("#startScreen .play-btn").click(H.FORCE);
  await page.waitForFunction(() => window.Flipbook.gateState().lbdFullscreen, null, { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Home is display:none in fullscreen (correctly), so use the same entry point the
  // button uses — this is the "Home activated from the LBD page" route.
  await page.evaluate(() => document.getElementById("homeBtn").click());
  await page.waitForTimeout(600);

  const s = await H.state(page);
  expect(s.lbdFullscreen, "fullscreen must be dropped").toBe(false);
  expect(s.overlayVisible, "overlay must be hidden").toBe(false);
  expect(await page.evaluate(() => document.body.classList.contains("lbd-fullscreen")),
    "stale fullscreen class must be cleared").toBe(false);
  expect(await page.evaluate(() =>
    document.getElementById("lbdOverlay").classList.contains("lbd-is-fullscreen"))).toBe(false);

  const stillPlaying = await page.evaluate(() => {
    const d = document.getElementById("lbdFrame").contentDocument;
    if (!d) return [];
    const out = []; d.querySelectorAll("audio,video").forEach((el) => { if (!el.paused) out.push(el.src); });
    return out;
  });
  expect(stillPlaying, "Home must stop all game audio").toEqual([]);

  // We end up back at the cover, ready to read again.
  await page.waitForFunction(() => !document.body.classList.contains("is-open"), null, { timeout: 10000 });
});

test("REPLAY from THE END clears the overlay and leaves no game running", async ({ page }) => {
  await H.openBook(page);
  await H.gotoPage(page, 6);
  await expect(page.locator("#replayBtn")).toBeVisible();
  await page.locator("#replayBtn").click(H.FORCE);
  await page.waitForFunction(() => !document.body.classList.contains("is-open"), null, { timeout: 10000 });

  const s = await H.state(page);
  expect(s.overlayVisible).toBe(false);
  expect(s.lbdFullscreen).toBe(false);
  expect(s.page).toBe(0);
  expect(await page.evaluate(() => document.body.classList.contains("lbd-fullscreen"))).toBe(false);
});

test("the hidden iframe never steals focus from the parent", async ({ page }) => {
  await H.openBook(page);
  // Focus something in the parent and confirm the warming iframe does not take it.
  await page.evaluate(() => document.getElementById("homeBtn").focus());
  await page.waitForTimeout(2500);
  const activeIsParent = await page.evaluate(() =>
    document.activeElement && document.activeElement.id === "homeBtn");
  expect(activeIsParent, "the parent must keep focus while the game warms hidden").toBe(true);
});
