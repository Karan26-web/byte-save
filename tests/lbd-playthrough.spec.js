/* PHASE 19 — LBD 2 PLAYED FOR REAL, END TO END.
   ----------------------------------------------------------------------------
   Its own file so `trace: "off"` can be set at top level (Playwright refuses
   test.use({trace}) inside a describe). This test plays all eight rounds through the
   game's own buttons, so it runs for many minutes; capturing a trace of that much
   media-heavy activity added minutes of teardown on top and pushed the test past its
   budget even though every assertion had already passed.

   Nothing here reads the answer to a round — only which round is in progress. */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

test.use({ trace: "off" });

const LBD2_PAGE = 5;      // immediately after story page 4

/* Is ANY sound actually playing inside the game? DOM media plus the JS-created Audio
   objects the game holds (which never appear in the DOM). */
async function audioActivity(frame) {
  return frame.evaluate(() => {
    const playing = [];
    const check = (a, name) => {
      if (!a) return;
      if (!a.paused && !a.ended && a.currentTime > 0) playing.push(name + " @" + a.currentTime.toFixed(2));
    };
    document.querySelectorAll("audio,video").forEach((el, i) => check(el, "dom:" + (el.id || el.tagName + i)));
    const api = window.__lbd || {};
    check(api.bgm, "bgm");
    for (const k in (api.VO || {})) check(api.VO[k], "vo:" + k);
    check(api.endVideo, "endVideo");
    return playing;
  });
}

test("LBD 2 plays through its complete flow, waits for its finale, and completes", async ({ page }) => {
  test.setTimeout(1800000);         // 8 rounds of real play + a 33s celebration video
  const w = H.watch(page);
  await H.openBook(page);
  await H.gotoPage(page, LBD2_PAGE);

  const s0 = await H.state(page);
  expect(s0.page).toBe(LBD2_PAGE);
  expect(s0.overlayVisible).toBe(true);
  expect(s0.lbdFullscreen, "not fullscreen until Play").toBe(false);

  const frame = await H.gameFrame(page);
  expect(await audioActivity(frame), "silent before Play").toEqual([]);

  await frame.locator("#startBtn").click(H.FORCE);
  await page.waitForFunction(() => window.Flipbook.gateState().lbdFullscreen, null, { timeout: 15000 });
  expect((await H.state(page)).lbdStarted).toBe(true);

  /* PLAY IT FOR REAL. Each round asks left or right; we guess, and if the round did not
     advance (the first three levels replay a missed delivery) we try the other way next
     time. Deadline-driven rather than a fixed iteration count: a round takes as long as
     its walk and delivery animations take, so counting loop passes under-runs the real
     playthrough. */
  const readState = () => frame.evaluate(() => ({
    done: !document.getElementById("endScreen").classList.contains("hide"),
    ready: window.__lbd.awaitingPick,
    lvl: window.__lbd.levelIdx,
  }));

  const deadline = Date.now() + 600000;                    // up to 10 minutes of real play
  let lastLevel = -1, guess = "left", picks = 0;
  while (Date.now() < deadline) {
    const st = await readState();
    if (st.done) break;
    if (!st.ready) { await page.waitForTimeout(400); continue; }   // mid-animation

    if (st.lvl !== lastLevel) { guess = "left"; lastLevel = st.lvl; }
    else { guess = guess === "left" ? "right" : "left"; }   // that one missed — try the other

    await frame.locator(guess === "left" ? "#leftBtn" : "#rightBtn").click(H.FORCE);
    picks++;
    // Wait until the pick has been consumed, so we never double-answer a round.
    await frame.waitForFunction(() => !window.__lbd.awaitingPick, null, { timeout: 15000 })
      .catch(() => {});
  }
  console.log(`LBD 2: answered ${picks} rounds, reached level ${lastLevel + 1}`);

  /* The finale: the celebration video + the closing "Byte saved the day" line, after
     which the game reveals NEXT. voSay resolves on ended / play-rejection / its own 4 s
     net, so this cannot hang. */
  await expect(frame.locator("#endScreen")).toBeVisible({ timeout: 180000 });
  await expect(frame.locator("#endBtn")).toHaveClass(/show/, { timeout: 90000 });
  console.log("LBD 2 reached its end screen and revealed NEXT after the closing VO");

  // NEXT completes: back out of fullscreen, and the story advances on its own.
  await frame.locator("#endBtn").click(H.FORCE);
  await page.waitForFunction((p) => window.Flipbook.gateState().page === p + 1, LBD2_PAGE, { timeout: 25000 });

  const s = await H.state(page);
  expect(s.page, "should land on THE END page").toBe(LBD2_PAGE + 1);
  expect(s.lbdFullscreen).toBe(false);
  expect(s.overlayVisible).toBe(false);

  await page.waitForTimeout(1200);
  const stillPlaying = await page.evaluate(() => {
    const d = document.getElementById("lbdFrame").contentDocument;
    if (!d) return [];
    const out = []; d.querySelectorAll("audio,video").forEach((el) => { if (!el.paused) out.push(el.src); });
    return out;
  });
  expect(stillPlaying, "the celebration video/music must not outlive the game").toEqual([]);
  expect(w.failed, "no failed requests during the full playthrough").toEqual([]);
});
