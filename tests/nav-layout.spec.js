/* NAV LAYOUT MATRIX — the structural non-overlap / non-clipping contract.
   Runs the SAME geometry checks at every viewport in the acceptance list, plus the
   two browser-zoom levels (browser zoom presents to CSS as a smaller CSS viewport,
   so 150% on 1366x768 is measured as 911x512 and 200% as 683x384).

   This is a pure GEOMETRY suite: it opens the book and then force-shows the nav
   controls instead of playing 53s of video per viewport, because none of the
   gating classes change the layout maths — only whether a control is painted.
   Gating itself is covered by nav.spec.js / gating.spec.js. */
"use strict";

const { test, expect } = require("@playwright/test");
const H = require("./helpers");

/* The acceptance list, in the order it was specified. */
const VIEWPORTS = [
  { name: "1920x1080  16:9 desktop",            w: 1920, h: 1080 },
  { name: "1536x864   Windows laptop scaling",  w: 1536, h: 864  },
  { name: "1366x768   small laptop",            w: 1366, h: 768  },
  { name: "1280x800   16:10 laptop",            w: 1280, h: 800  },
  { name: "1194x834   iPad Air landscape",      w: 1194, h: 834  },
  { name: "1024x768   4:3 tablet landscape",    w: 1024, h: 768  },
  { name: "962x601    worst-case short window", w: 962,  h: 601  },
  { name: "911x512    1366x768 @ 150% zoom",    w: 911,  h: 512  },
  { name: "683x384    1366x768 @ 200% zoom",    w: 683,  h: 384  },
];

/* Every control that must obey the contract. Home is gone, so the pair of corner
   arrows is the whole nav surface. */
const CONTROLS = ["#cornerPrev", "#cornerNext"];

const MIN_TOUCH = 44;          // WCAG 2.5.5 minimum touch target, in CSS px
/* The 12px floor in --nav-edge-x. env() safe-area insets are 0 in a headless window,
   so the floor is the whole token here. */
const NAV_EDGE_X = 12;

/* Mirror of CSS clamp(): returns MIN when MIN > MAX, exactly as the spec requires. */
const cssClamp = (min, val, max) => (max < min ? min : Math.min(Math.max(val, min), max));

/* Where the CSS should put each arrow: outer edge flush with the book's matching edge,
   floored at the safe-area inset and capped so neither can cross the centre line. */
function expectedInsets(m) {
  const cap = m.vw / 2 - m.navBtn;
  return {
    "#cornerPrev": cssClamp(NAV_EDGE_X, m.book.l, cap),          // distance from the LEFT
    "#cornerNext": cssClamp(NAV_EDGE_X, m.vw - m.book.r, cap),   // distance from the RIGHT
  };
}

/* Read every box we care about in one round trip, in the page's own coordinates. */
function measure(page, controls) {
  return page.evaluate((sels) => {
    const rect = (sel) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") return null;
      const r = e.getBoundingClientRect();
      return { sel, l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height };
    };
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      book: rect(".book-frame"),                       // the book's TRUE visible edge
      navBtn: parseFloat(getComputedStyle(document.documentElement)
        .getPropertyValue("--nav-btn-px")) || null,    // resolved size, published by fitScale
      controls: sels.map(rect).filter(Boolean),
    };
  }, controls);
}

const overlap = (a, b) => {
  const x = Math.min(a.r, b.r) - Math.max(a.l, b.l);
  const y = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return x > 0.5 && y > 0.5 ? { x, y } : null;
};

test.describe("nav layout matrix", () => {
  for (const vp of VIEWPORTS) {
    test(`no overlap and no clipping at ${vp.name}`, async ({ page }, testInfo) => {
      // Every case sets its own viewport, so running the matrix once is enough — pin it
      // to the desktop project so landscape-844 doesn't repeat all nine.
      test.skip(testInfo.project.name !== "desktop-1366",
        "geometry matrix sets its own viewports; run it once");

      await page.setViewportSize({ width: vp.w, height: vp.h });
      await H.openBook(page);

      // Force every nav control to be PAINTED without satisfying its page gate: the
      // layout maths is identical either way, and this keeps the matrix fast.
      await page.evaluate((sels) => {
        sels.forEach((s) => {
          const e = document.querySelector(s);
          if (!e) return;
          e.classList.remove("is-hidden");
          e.classList.add("is-visible");
          e.disabled = false;
        });
      }, CONTROLS);
      await page.waitForTimeout(120);            // let the opacity transition paint

      const m = await measure(page, CONTROLS);

      // ---- report the actual landing position of every control -------------------
      const where = (c) => `${c.sel} ${Math.round(c.w)}x${Math.round(c.h)} at ` +
        `x ${Math.round(c.l)}..${Math.round(c.r)}, y ${Math.round(c.t)}..${Math.round(c.b)}`;
      console.log(`\n  ${vp.name}   (viewport ${m.vw}x${m.vh}, --nav-btn ${m.navBtn}px)`);
      console.log(`    book-frame  x ${Math.round(m.book.l)}..${Math.round(m.book.r)}, ` +
                  `y ${Math.round(m.book.t)}..${Math.round(m.book.b)}`);
      m.controls.forEach((c) => {
        console.log(`    ${where(c)}   gap-below-book ${(c.t - m.book.b).toFixed(1)}px`);
      });

      expect(m.controls.length, "both corner arrows must be present").toBe(CONTROLS.length);

      for (const c of m.controls) {
        // 5. fully inside the visible viewport — no negative offsets, no clipping
        expect(c.l, `${c.sel} clipped off the LEFT`).toBeGreaterThanOrEqual(-0.5);
        expect(c.t, `${c.sel} clipped off the TOP`).toBeGreaterThanOrEqual(-0.5);
        expect(c.r, `${c.sel} clipped off the RIGHT`).toBeLessThanOrEqual(m.vw + 0.5);
        expect(c.b, `${c.sel} clipped off the BOTTOM`).toBeLessThanOrEqual(m.vh + 0.5);

        // 6. touch targets stay tappable at every size
        expect(c.w, `${c.sel} narrower than ${MIN_TOUCH}px`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5);
        expect(c.h, `${c.sel} shorter than ${MIN_TOUCH}px`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5);

        // 3 + 7. the guaranteed gutter: a control may never sit on the book, or the
        // book's corner page-curl hover is dead under it.
        expect(overlap(c, m.book), `${c.sel} overlaps the book frame`).toBeNull();
      }

      // 1 + 6. controls may never overlap each other
      for (let i = 0; i < m.controls.length; i++) {
        for (let j = i + 1; j < m.controls.length; j++) {
          const a = m.controls[i], b = m.controls[j];
          expect(overlap(a, b), `${a.sel} overlaps ${b.sel}`).toBeNull();
        }
      }

      // 6. the structural minimum gap: >= 0.35 x the button size below the book.
      if (m.navBtn) {
        const minGap = m.navBtn * 0.35;
        for (const c of m.controls) {
          expect(c.t - m.book.b, `${c.sel} is closer than ${minGap.toFixed(1)}px to the book`)
            .toBeGreaterThanOrEqual(minGap - 1);
        }
      }

      // 8. BOOK-CORNER ANCHORING: each arrow sits directly below the book's own bottom
      // corner — its outer edge flush with the book's matching edge — instead of being
      // stranded out at the screen edge on a wide viewport.
      if (m.navBtn) {
        const want = expectedInsets(m);
        const prev = m.controls.find((c) => c.sel === "#cornerPrev");
        const next = m.controls.find((c) => c.sel === "#cornerNext");
        console.log(`    anchoring: left inset ${prev.l.toFixed(1)} (want ${want["#cornerPrev"].toFixed(1)}), ` +
                    `right inset ${(m.vw - next.r).toFixed(1)} (want ${want["#cornerNext"].toFixed(1)})`);
        expect(prev.l, "Back must line up with the book's LEFT edge")
          .toBeCloseTo(want["#cornerPrev"], 0);
        expect(m.vw - next.r, "Next must line up with the book's RIGHT edge")
          .toBeCloseTo(want["#cornerNext"], 0);
        // ...which for these viewports means genuinely inside the screen margin.
        expect(next.r, "Next must not sit past the book's right edge").toBeLessThanOrEqual(m.book.r + 0.5);
        expect(prev.l, "Back must not sit past the book's left edge").toBeGreaterThanOrEqual(m.book.l - 0.5);
      }
    });
  }

  /* A LIVE resize, not a fresh load at a new size — this is the path that actually
     broke on other people's laptops. fitScale() must republish the book geometry and
     the controls must follow it, with the freeze class still doing its job.
     CDP rather than setViewportSize() because the book goes fullscreen when it opens
     and Chrome refuses setWindowBounds on a fullscreen window. */
  test("a live resize republishes the geometry and the controls follow", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1366", "sets its own viewports");

    await page.setViewportSize({ width: 1366, height: 768 });
    await H.openBook(page);
    await page.evaluate((sels) => sels.forEach((s) => {
      const e = document.querySelector(s);
      if (!e) return;
      e.classList.remove("is-hidden"); e.classList.add("is-visible"); e.disabled = false;
    }), CONTROLS);

    const cdp = await page.context().newCDPSession(page);
    const before = await measure(page, CONTROLS);

    for (const [w, h] of [[1024, 768], [962, 601], [1920, 1080], [683, 384]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride",
        { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await page.waitForTimeout(350);              // past the 220ms is-resizing settle

      const m = await measure(page, CONTROLS);
      expect(m.vw, "the CSS viewport must have actually changed").toBe(w);
      console.log(`    resized to ${w}x${h}: --nav-btn ${m.navBtn}px, ` +
        `book y ${Math.round(m.book.t)}..${Math.round(m.book.b)}, ` +
        m.controls.map((c) => `${c.sel} y ${Math.round(c.t)}..${Math.round(c.b)}`).join(", "));

      // The geometry really was republished, not left at the old load-time values.
      expect(m.book.b, "the book must have been re-fitted").not.toBeCloseTo(before.book.b, 1);

      for (const c of m.controls) {
        expect(overlap(c, m.book), `${c.sel} overlaps the book after resizing to ${w}x${h}`).toBeNull();
        expect(c.b, `${c.sel} clipped after resizing to ${w}x${h}`).toBeLessThanOrEqual(m.vh + 0.5);
        expect(c.t, `${c.sel} clipped after resizing to ${w}x${h}`).toBeGreaterThanOrEqual(-0.5);
        expect(c.h, `${c.sel} lost its touch target at ${w}x${h}`).toBeGreaterThanOrEqual(MIN_TOUCH - 0.5);
      }
      expect(overlap(m.controls[0], m.controls[1]), `the arrows overlap at ${w}x${h}`).toBeNull();
    }
  });

  /* The page-turn hint is glued to the BOOK's right edge (positionFlipHint reads the
     book's live rect), so the new positioning must not have stranded it. */
  test("the page-turn hint still lands on the book's right edge", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1366", "sets its own viewports");

    await page.setViewportSize({ width: 1024, height: 768 });   // a previously broken size
    await H.openBook(page);

    const g = await page.evaluate(() => {
      window.__hint = document.querySelector(".flip-hint");
      return !!window.__hint;
    });
    expect(g, "the flip-hint element must exist").toBe(true);

    // Show it through the app's own path so positionFlipHint() runs.
    await page.evaluate(() => {
      const h = document.querySelector(".flip-hint");
      h.classList.add("show");
      window.dispatchEvent(new Event("resize"));      // -> fitScale -> positionFlipHint
    });
    await page.waitForTimeout(350);

    const r = await page.evaluate(() => {
      const h = document.querySelector(".flip-hint").getBoundingClientRect();
      const p = document.getElementById("flipScale").getBoundingClientRect();
      const n = document.getElementById("cornerNext").getBoundingClientRect();
      return { h: { l: h.left, t: h.top, r: h.right, b: h.bottom },
               p: { l: p.left, t: p.top, r: p.right, b: p.bottom },
               n: { t: n.top } };
    });
    console.log(`    hint x ${Math.round(r.h.l)}..${Math.round(r.h.r)} ` +
                `y ${Math.round(r.h.t)}..${Math.round(r.h.b)}; ` +
                `page area right edge ${Math.round(r.p.r)}`);

    // Inside the book's page area, hugging its right edge, vertically centred-ish.
    expect(r.h.r).toBeLessThanOrEqual(r.p.r + 1);
    expect(r.h.l).toBeGreaterThan(r.p.l + (r.p.r - r.p.l) * 0.5);
    const mid = (r.p.t + r.p.b) / 2, hMid = (r.h.t + r.h.b) / 2;
    expect(Math.abs(hMid - mid), "the hint must stay vertically centred on the book")
      .toBeLessThan((r.p.b - r.p.t) * 0.15);
  });
});
