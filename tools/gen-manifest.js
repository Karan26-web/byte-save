#!/usr/bin/env node
/* ============================================================================
   DEV-ONLY asset-manifest generator.   node tools/gen-manifest.js
   ----------------------------------------------------------------------------
   Walks the REAL deployable tree and writes manifests built from real files and
   real on-disk byte sizes — nothing here is a guessed number.

   Outputs
     asset-manifest.json                     the parent flipbook's two-stage list
     LBD 1/asset-manifest.json               LBD 1's idle warm-up list
     LBD 2/Right-and-Left/asset-manifest.json  LBD 2's idle warm-up list

   Every parent entry carries:
     url        request URL exactly as the page asks for it (encoded, with any
                query string) — so the preloader and the element share one cache key
     type       image | video | audio | script | style | json | font | other
     bytes      real size on disk
     stage      "shell"      → Stage A, may block the Start button
                "background" → Stage B, idle warm-up only, never blocks
     game       true when the file belongs to an embedded game
     blobOk     whether the parent may swap in a Blob URL for it
     target     the element/usage it belongs to, where there is a specific one

   STAGE RULES (these decide the Start button's latency, so they matter):
     shell      = cover art, the play button, the flipbook's own CSS/JS, the FIRST
                  story page's poster + video, every video poster, and the two SFX.
     background = later-page videos, both games in full, later narration.
   ============================================================================ */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

/* Directories/files that are tooling or reports — never part of the payload. */
const EXCLUDE_DIRS = new Set([".git", ".vscode", ".claude", "node_modules", "tools", "tests",
  "test-results", "playwright-report", "quarantine"]);
const EXCLUDE_FILES = new Set([".DS_Store", ".gitignore", ".vercelignore", "package.json",
  "package-lock.json", "asset-manifest.json", "media-size-report.json", "media-size-report.csv",
  "IMPLEMENTATION_REPORT.md", "playwright.config.js"]);

const TYPE_BY_EXT = {
  ".webp": "image", ".png": "image", ".jpg": "image", ".jpeg": "image", ".svg": "image", ".gif": "image",
  ".webm": "video", ".mp4": "video",
  ".ogg": "audio", ".oga": "audio", ".opus": "audio", ".mp3": "audio", ".m4a": "audio", ".wav": "audio",
  ".js": "script", ".css": "style", ".json": "json",
  ".woff": "font", ".woff2": "font", ".ttf": "font",
  ".html": "html",
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");
/* The browser asks for percent-encoded paths (spaces especially). Encode each
   segment so the manifest URL is byte-identical to what the element requests —
   that shared cache key is what stops a double download. */
const urlOf = (rel) => rel.split("/").map(encodeURIComponent).join("/");
const typeOf = (rel) => TYPE_BY_EXT[path.extname(rel).toLowerCase()] || "other";

const LBD1 = "LBD 1";
const LBD2 = "LBD 2/Right-and-Left";

/* ------------------------------------------------------------------ parent -- */
/* Only these actually gate the Start button. Everything else is Stage B. */
/* Stage A deliberately contains NO html/css/js. Those are render-blocking resources the
   document requests itself while parsing — by the time preload.js executes they are
   already loaded, so fetching them again is a pure duplicate request that also made the
   progress bar measure work the preloader wasn't really doing. Stage A is exactly the set
   of assets the first screens need that the document does NOT request for itself. */
const SHELL = new Set([
  "assets/coverpage.webp",
  "assets/play button.webp",
  "assets/posters/1.webp", "assets/posters/2.webp", "assets/posters/3.webp", "assets/posters/4.webp",
  "sfx/Page flip.ogg", "sfx/cover page flip.ogg",
  // NOTE: no .webm is in Stage A. Every video page paints its own frame-0 poster
  // instantly, and the clips stream over Range requests — so blocking the Start
  // button on a 5 MB download would add seconds of wait for no visible benefit and
  // would regress the shell's readiness against the pre-integration baseline.
  // Page 1's video is the FIRST Stage B item and is additionally warmed to
  // preload="auto" the moment the book opens (see warmVideo() in script.js).
  // The two game-page poster thumbnails: they are painted on the leaf during the
  // flip toward the game page, so they belong to the visible interface.
  `${LBD1}/assets/start.webp`,
  `${LBD2}/Assets/UI/start-screen.webp`,
]);

/* Files the parent must never Blob-swap: HTML/JS/CSS it does not own the loading
   of, and anything inside an iframe (the game does not consume parent Blob URLs). */
function blobAllowed(rel, type) {
  if (rel.startsWith(LBD1 + "/") || rel.startsWith(LBD2 + "/")) return false;
  return type === "image" || type === "video" || type === "audio";
}

function targetOf(rel) {
  if (rel === "assets/coverpage.webp") return ".cover-img background";
  if (rel === "assets/play button.webp") return ".play-btn background";
  if (/^assets\/posters\/(\d)\.webp$/.test(rel)) return `page ${RegExp.$1} video poster`;
  if (/^assets\/(\d)\.webm$/.test(rel)) return `page ${RegExp.$1} video.page-media`;
  if (rel.startsWith("sfx/")) return "one-shot SFX (Web Audio)";
  if (rel === `${LBD1}/assets/start.webp`) return "LBD 1 page poster";
  if (rel === `${LBD2}/Assets/UI/start-screen.webp`) return "LBD 2 page poster";
  return null;
}

/* Stage B priority: the story videos are wanted within seconds of the book opening,
   so they precede the two games' bulk — which the learner cannot reach until at
   least page 4. Lower number = warmed earlier. */
function priorityOf(rel) {
  // The looping background theme is wanted the moment the book opens (it plays under
  // every page), and it is preload="none" in script.js precisely so it does NOT
  // compete with Stage A — so it is the very FIRST thing Stage B warms.
  if (rel === `${LBD1}/audios/themeMusic.ogg`) return 0;
  const m = /^assets\/(\d)\.webm$/.exec(rel);
  if (m) return Number(m[1]);          // then the story videos, in page order
  return 10;                           // everything else (both games) after them
}

const all = walk(ROOT).map(relOf).sort();
const parentEntries = [];
for (const rel of all) {
  const type = typeOf(rel);
  if (type === "html" && rel !== "index.html") continue;      // game HTML loads via the iframe
  const isGame = rel.startsWith(LBD1 + "/") || rel.startsWith(LBD2 + "/");
  parentEntries.push({
    url: urlOf(rel),
    type,
    bytes: fs.statSync(path.join(ROOT, rel)).size,
    stage: SHELL.has(rel) ? "shell" : "background",
    prio: priorityOf(rel),
    game: isGame,
    blobOk: blobAllowed(rel, type),
    target: targetOf(rel),
  });
}

/* Queue smaller files first WITHIN a priority group, so cover art / UI / posters
   are never stuck behind a multi-megabyte video. */
const order = (a, b) => a.prio - b.prio || a.bytes - b.bytes;
const shell = parentEntries.filter((e) => e.stage === "shell").sort(order);
const background = parentEntries.filter((e) => e.stage === "background").sort(order);

const sum = (list) => list.reduce((n, e) => n + e.bytes, 0);
const manifest = {
  generated: new Date().toISOString(),
  note: "Generated by tools/gen-manifest.js from real files on disk. Do not hand-edit.",
  stages: {
    shell: { files: shell.length, bytes: sum(shell), blocking: true,
      description: "Stage A — cover, flipbook shell, first story page, posters, UI, SFX. Only these gate the Start button." },
    background: { files: background.length, bytes: sum(background), blocking: false,
      description: "Stage B — embedded games, later-page videos, later narration, hidden-level sprites. Idle only." },
  },
  totalBytes: sum(parentEntries),
  assets: shell.concat(background),
};
fs.writeFileSync(path.join(ROOT, "asset-manifest.json"), JSON.stringify(manifest, null, 2));

/* -------------------------------------------------------------- per-game --- */
/* The bridge warms these from INSIDE the iframe, in small idle chunks. Paths are
   relative to the game folder — exactly the strings the game itself requests, so
   the HTTP cache is shared and nothing is fetched twice. Sorted small-first. */
function gameManifest(prefix, outRel) {
  const files = all.filter((r) => r.startsWith(prefix + "/") && typeOf(r) !== "html");
  const group = { images: [], audio: [], video: [], other: [] };
  const bytes = {};
  for (const rel of files) {
    const sub = rel.slice(prefix.length + 1);
    if (sub === "asset-manifest.json" || sub === "embed-bridge.js") continue;
    const url = sub.split("/").map(encodeURIComponent).join("/");
    const t = typeOf(rel);
    bytes[url] = fs.statSync(path.join(ROOT, rel)).size;
    if (t === "image") group.images.push(url);
    else if (t === "audio") group.audio.push(url);
    else if (t === "video") group.video.push(url);
    else group.other.push(url);
  }
  const smallFirst = (a, b) => bytes[a] - bytes[b];
  for (const k of Object.keys(group)) group[k].sort(smallFirst);
  const out = {
    generated: new Date().toISOString(),
    note: "Generated by tools/gen-manifest.js. Warmed in idle chunks by embed-bridge.js.",
    totalBytes: Object.values(bytes).reduce((a, b) => a + b, 0),
    bytes,
    ...group,
  };
  fs.writeFileSync(path.join(ROOT, outRel), JSON.stringify(out, null, 2));
  return out;
}

const g1 = gameManifest(LBD1, `${LBD1}/asset-manifest.json`);
const g2 = gameManifest(LBD2, `${LBD2}/asset-manifest.json`);

const fmt = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`asset-manifest.json          ${manifest.assets.length} files, ${fmt(manifest.totalBytes)}`);
console.log(`  Stage A (shell)            ${shell.length} files, ${fmt(sum(shell))}  ← blocks Start`);
console.log(`  Stage B (background)       ${background.length} files, ${fmt(sum(background))}`);
console.log(`${LBD1}/asset-manifest.json  ${g1.images.length} img / ${g1.audio.length} audio / ${g1.video.length} video, ${fmt(g1.totalBytes)}`);
console.log(`${LBD2}/asset-manifest.json  ${g2.images.length} img / ${g2.audio.length} audio / ${g2.video.length} video, ${fmt(g2.totalBytes)}`);
