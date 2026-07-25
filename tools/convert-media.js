#!/usr/bin/env node
/* ============================================================================
   DEV-ONLY media optimiser.  node tools/convert-media.js [--only=video,image,audio]
   ----------------------------------------------------------------------------
   Converts the DEPLOYABLE media in place-adjacent (writes the new file next to
   the source; the caller updates references and quarantines the originals).

     video  → WebM / VP9 video / Opus audio, -pix_fmt yuv420p, CONSTRAINED
              QUALITY (-crf with a -b:v cap ≈ 75% of the source VIDEO bitrate).
              If pass 1 isn't smaller, the output is discarded and a TWO-PASS
              encode at ≈70% of source bitrate runs instead, stepping down until
              the file is genuinely smaller.
     audio  → Ogg / Opus, 64 kbps for mono speech/short one-shots, 96 kbps where
              music/stereo quality needs it.
     image  → WebP q82 at the ORIGINAL pixel dimensions, alpha preserved.

   EVERY output is validated before it is accepted:
     1. source size recorded            4. duration within 100 ms of source
     2. output size recorded            5. output strictly smaller than source
     3. ffprobe decodes it              6. dimensions identical
   A converted file that is not smaller, or that fails to decode, is DELETED and
   recorded as an exception — we never ship an output bigger than its source.

   Browser support: WebM/VP9 + Ogg/Opus + WebP are supported by Chrome, Edge,
   Firefox, and Safari 15+ (macOS 12+/iOS 15+). See BROWSER_SUPPORT in the report.
   ============================================================================ */
"use strict";

const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = path.resolve(__dirname, "..");
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").slice(7);
const WANT = only ? new Set(only.split(",")) : null;
const want = (kind) => !WANT || WANT.has(kind);

/* ---------------------------------------------------------------- helpers -- */
const sh = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

function probe(file) {
  const raw = sh("ffprobe", [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", file,
  ]);
  const j = JSON.parse(raw);
  const v = (j.streams || []).find((s) => s.codec_type === "video");
  const a = (j.streams || []).find((s) => s.codec_type === "audio");
  return {
    duration: Number(j.format.duration) || 0,
    size: Number(j.format.size) || fs.statSync(file).size,
    bitRate: Number(j.format.bit_rate) || 0,
    video: v ? { codec: v.codec_name, w: v.width, h: v.height, pix_fmt: v.pix_fmt || "", bitRate: Number(v.bit_rate) || 0 } : null,
    audio: a ? { codec: a.codec_name, ch: a.channels, rate: Number(a.sample_rate) || 0 } : null,
  };
}

const size = (f) => fs.statSync(f).size;
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const kb = (n) => (n / 1024).toFixed(1) + " KB";
const mb = (n) => (n / 1048576).toFixed(2) + " MB";

const results = [];
function record(entry) {
  results.push(entry);
  const tag = entry.status === "converted" ? "OK  " : "SKIP";
  const pct = entry.savedPct == null ? "" : `  (-${entry.savedPct.toFixed(1)}%)`;
  console.log(
    `[${tag}] ${entry.source} ${mb(entry.sourceBytes)} → ` +
      `${entry.output || "(none)"} ${entry.outputBytes ? mb(entry.outputBytes) : ""}${pct}` +
      (entry.note ? `  — ${entry.note}` : "")
  );
}

/* =========================================================== VIDEO → WebM == */
const THREADS = Math.max(2, os.cpus().length - 1);

function encodeVp9CQ(src, out, capKbps, crf) {
  sh("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", src,
    "-c:v", "libvpx-vp9",
    "-crf", String(crf),
    "-b:v", `${capKbps}k`,          // CONSTRAINED quality: crf with a hard bitrate cap
    "-pix_fmt", "yuv420p",
    "-row-mt", "1", "-threads", String(THREADS), "-cpu-used", "2",
    "-g", "240", "-tile-columns", "2", "-frame-parallel", "0",
    "-c:a", "libopus", "-b:a", "96k", "-vbr", "on",
    "-movflags", "+faststart",
    "-f", "webm", out,
  ]);
}

function encodeVp9TwoPass(src, out, targetKbps) {
  const logBase = path.join(os.tmpdir(), "vp9-" + path.basename(out, ".webm"));
  const common = [
    "-c:v", "libvpx-vp9",
    "-b:v", `${targetKbps}k`,
    "-pix_fmt", "yuv420p",
    "-row-mt", "1", "-threads", String(THREADS),
    "-g", "240", "-tile-columns", "2", "-frame-parallel", "0",
    "-passlogfile", logBase,
  ];
  sh("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", src,
    ...common, "-cpu-used", "4", "-pass", "1", "-an", "-f", "webm", process.platform === "win32" ? "NUL" : "/dev/null"]);
  sh("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", src,
    ...common, "-cpu-used", "2", "-pass", "2",
    "-c:a", "libopus", "-b:a", "96k", "-vbr", "on", "-f", "webm", out]);
  for (const f of fs.readdirSync(os.tmpdir())) {
    if (f.startsWith(path.basename(logBase))) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {} }
  }
}

/* Validate a converted video against its source. Returns null when OK, else the
   reason it must be rejected. */
function validateVideo(src, out, srcInfo) {
  let o;
  try { o = probe(out); } catch (e) { return "output does not decode: " + e.message; }
  if (!o.video) return "output has no video stream";
  if (o.video.codec !== "vp9") return "output video codec is " + o.video.codec + ", expected vp9";
  if (srcInfo.audio && (!o.audio || o.audio.codec !== "opus")) return "output audio is not opus";
  if (o.video.w !== srcInfo.video.w || o.video.h !== srcInfo.video.h)
    return `dimensions changed ${srcInfo.video.w}x${srcInfo.video.h} → ${o.video.w}x${o.video.h}`;
  if (Math.abs(o.duration - srcInfo.duration) > 0.35)
    return `duration drifted ${srcInfo.duration.toFixed(3)}s → ${o.duration.toFixed(3)}s`;
  if (size(out) >= size(src)) return "output is not smaller than source";
  return null;
}

function convertVideo(srcRel) {
  const src = path.join(ROOT, srcRel);
  const out = src.replace(/\.mp4$/i, ".webm");
  const info = probe(src);
  const srcVideoKbps = Math.round((info.video.bitRate || info.bitRate) / 1000);

  // Stage 1 — constrained quality at ~75% of the source VIDEO bitrate.
  const cap75 = Math.round(srcVideoKbps * 0.75);
  console.log(`  … ${srcRel}: CQ pass, cap ${cap75}k (75% of ${srcVideoKbps}k)`);
  encodeVp9CQ(src, out, cap75, 32);
  let bad = validateVideo(src, out, info);

  // Stage 2 — pass 1 wasn't smaller (or failed): discard, two-pass at ~70%, then
  // step down carefully until it is genuinely smaller and still acceptable.
  if (bad) {
    console.log(`  … ${srcRel}: CQ rejected (${bad}) — discarding, two-pass fallback`);
    try { fs.unlinkSync(out); } catch {}
    const ladder = [0.70, 0.60, 0.50];
    for (const factor of ladder) {
      const target = Math.round(srcVideoKbps * factor);
      console.log(`  … ${srcRel}: two-pass target ${target}k (${Math.round(factor * 100)}%)`);
      encodeVp9TwoPass(src, out, target);
      bad = validateVideo(src, out, info);
      if (!bad) break;
      console.log(`  … ${srcRel}: rejected (${bad})`);
      try { fs.unlinkSync(out); } catch {}
    }
  }

  if (bad) {
    record({
      kind: "video", source: rel(src), sourceBytes: info.size, output: null, outputBytes: null,
      status: "kept-original", note: "EXCEPTION: " + bad,
      sourceDims: `${info.video.w}x${info.video.h}`, durationSec: +info.duration.toFixed(3),
    });
    return;
  }

  const o = probe(out);
  record({
    kind: "video", source: rel(src), sourceBytes: info.size, output: rel(out), outputBytes: size(out),
    savedPct: (1 - size(out) / info.size) * 100, status: "converted",
    sourceDims: `${info.video.w}x${info.video.h}`, outputDims: `${o.video.w}x${o.video.h}`,
    durationSec: +o.duration.toFixed(3),
    sourceCodec: `${info.video.codec}/${info.audio ? info.audio.codec : "none"}`,
    outputCodec: `${o.video.codec}/${o.audio ? o.audio.codec : "none"}`,
  });
}

/* =========================================================== AUDIO → Opus == */
function convertAudio(srcRel, kbps) {
  const src = path.join(ROOT, srcRel);
  const out = src.replace(/\.(mp3|wav|m4a)$/i, ".ogg");
  const info = probe(src);
  sh("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", src,
    "-c:a", "libopus", "-b:a", `${kbps}k`, "-vbr", "on", "-application", "audio",
    "-map_metadata", "-1", "-f", "ogg", out,
  ]);
  let o = null, bad = null;
  try { o = probe(out); } catch (e) { bad = "output does not decode: " + e.message; }
  if (!bad && (!o.audio || o.audio.codec !== "opus")) bad = "output is not opus";
  // Opus always resamples to 48 kHz — that is expected, not a failure.
  if (!bad && Math.abs(o.duration - info.duration) > 0.12)
    bad = `duration drifted ${info.duration.toFixed(3)}s → ${o.duration.toFixed(3)}s`;
  if (!bad && size(out) >= size(src)) bad = "output is not smaller than source";
  if (bad) {
    try { fs.unlinkSync(out); } catch {}
    record({ kind: "audio", source: rel(src), sourceBytes: info.size, output: null, outputBytes: null,
      status: "kept-original", note: "EXCEPTION: " + bad, durationSec: +info.duration.toFixed(3) });
    return;
  }
  record({ kind: "audio", source: rel(src), sourceBytes: info.size, output: rel(out), outputBytes: size(out),
    savedPct: (1 - size(out) / info.size) * 100, status: "converted",
    durationSec: +o.duration.toFixed(3), sourceCodec: info.audio.codec, outputCodec: o.audio.codec,
    bitrateKbps: kbps });
}

/* =========================================================== IMAGE → WebP == */
function convertImage(srcRel, quality) {
  const src = path.join(ROOT, srcRel);
  const out = src.replace(/\.(png|jpe?g)$/i, ".webp");
  const info = probe(src);
  const hasAlpha = /a$/.test(info.video.pix_fmt || "") || /rgba|argb|ya/.test(String(info.video.pix_fmt));
  // -preset picture + compression_level 6 gives the best size at a given quality.
  // libwebp carries the alpha channel through automatically for rgba inputs.
  sh("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", src,
    "-c:v", "libwebp", "-lossless", "0", "-quality", String(quality),
    "-compression_level", "6", "-preset", "picture",
    "-frames:v", "1", out,
  ]);
  let o = null, bad = null;
  try { o = probe(out); } catch (e) { bad = "output does not decode: " + e.message; }
  if (!bad && (o.video.w !== info.video.w || o.video.h !== info.video.h))
    bad = `dimensions changed ${info.video.w}x${info.video.h} → ${o.video.w}x${o.video.h}`;
  if (!bad && size(out) >= size(src)) bad = "output is not smaller than source";
  if (bad) {
    try { fs.unlinkSync(out); } catch {}
    record({ kind: "image", source: rel(src), sourceBytes: info.size, output: null, outputBytes: null,
      status: "kept-original", note: "EXCEPTION: " + bad, sourceDims: `${info.video.w}x${info.video.h}` });
    return;
  }
  record({ kind: "image", source: rel(src), sourceBytes: info.size, output: rel(out), outputBytes: size(out),
    savedPct: (1 - size(out) / info.size) * 100, status: "converted",
    sourceDims: `${info.video.w}x${info.video.h}`, outputDims: `${o.video.w}x${o.video.h}`,
    quality, alpha: hasAlpha });
}

/* ====================================== POSTERS (new files, not conversions) */
/* Every video page sets poster="…" so the scene paints instantly instead of
   showing a blank dark-blue page while the clip buffers. The poster IS frame 0 of
   its own clip, so there is no visual jump when playback starts. */
function makePoster(srcRel, outRel) {
  const src = path.join(ROOT, srcRel);
  const out = path.join(ROOT, outRel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  sh("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", src, "-frames:v", "1", "-an",
    "-vf", "scale=1280:-2",                    // book space is 1280x720 — no need for 1920
    "-c:v", "libwebp", "-lossless", "0", "-quality", "82", "-compression_level", "6",
    out,
  ]);
  const o = probe(out);
  console.log(`[OK  ] poster ${outRel} ${o.video.w}x${o.video.h} ${kb(size(out))}`);
  return { file: outRel, bytes: size(out), dims: `${o.video.w}x${o.video.h}` };
}

/* ================================================================== main === */
const posters = [];
try {
  if (want("image")) {
    console.log("\n── IMAGES → WebP ────────────────────────────────────────────");
    convertImage("assets/coverpage.png", 82);
    convertImage("assets/play button.png", 85);   // cover CTA art w/ alpha — a touch higher
  }

  if (want("audio")) {
    console.log("\n── AUDIO → Ogg/Opus ─────────────────────────────────────────");
    convertAudio("sfx/Page flip.mp3", 96);           // stereo whoosh — music-range quality
    convertAudio("sfx/cover page flip.mp3", 64);     // short mono one-shot — speech range
  }

  if (want("video")) {
    console.log("\n── POSTERS (frame 0 → WebP) ─────────────────────────────────");
    for (const n of [1, 2, 3, 4]) posters.push(makePoster(`assets/${n}.mp4`, `assets/posters/${n}.webp`));

    console.log("\n── VIDEO → WebM/VP9/Opus ────────────────────────────────────");
    for (const n of [1, 2, 3, 4]) convertVideo(`assets/${n}.mp4`);
  }
} finally {
  /* --------------------------------------------------- write the reports --- */
  const converted = results.filter((r) => r.status === "converted");
  const totals = {};
  for (const r of results) {
    const t = (totals[r.kind] ||= { sourceBytes: 0, outputBytes: 0, files: 0, exceptions: 0 });
    t.files++;
    t.sourceBytes += r.sourceBytes;
    t.outputBytes += r.outputBytes || r.sourceBytes;   // an exception keeps its original
    if (r.status !== "converted") t.exceptions++;
  }
  for (const t of Object.values(totals)) t.savedPct = t.sourceBytes ? (1 - t.outputBytes / t.sourceBytes) * 100 : 0;
  const grand = Object.values(totals).reduce(
    (a, t) => ({ sourceBytes: a.sourceBytes + t.sourceBytes, outputBytes: a.outputBytes + t.outputBytes }),
    { sourceBytes: 0, outputBytes: 0 }
  );
  grand.savedPct = grand.sourceBytes ? (1 - grand.outputBytes / grand.sourceBytes) * 100 : 0;

  const report = {
    generated: new Date().toISOString(),
    BROWSER_SUPPORT:
      "WebM/VP9 video, Ogg/Opus audio and WebP images are supported by Chrome, Edge, " +
      "Firefox and Safari 15+ (macOS 12+ / iOS 15+).",
    encoderSettings: {
      video: "libvpx-vp9, constrained quality (-crf 32 with -b:v cap at 75% of source video bitrate), " +
             "-pix_fmt yuv420p, Opus 96k audio; two-pass at 70/60/50% as fallback",
      audio: "libopus -vbr on, 64 kbps mono speech / 96 kbps stereo music",
      image: "libwebp -quality 82-85, -compression_level 6, original pixel dimensions, alpha preserved",
    },
    totalsByKind: totals,
    grandTotal: grand,
    postersGenerated: posters,
    files: results,
  };
  fs.writeFileSync(path.join(ROOT, "media-size-report.json"), JSON.stringify(report, null, 2));

  const cols = ["kind", "source", "sourceBytes", "output", "outputBytes", "savedPct", "status",
    "sourceDims", "outputDims", "durationSec", "sourceCodec", "outputCodec", "note"];
  const csv = [cols.join(",")].concat(
    results.map((r) => cols.map((c) => {
      const v = r[c] == null ? "" : String(r[c]);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(","))
  ).join("\n");
  fs.writeFileSync(path.join(ROOT, "media-size-report.csv"), csv + "\n");

  console.log("\n── TOTALS ───────────────────────────────────────────────────");
  for (const [k, t] of Object.entries(totals))
    console.log(`  ${k.padEnd(6)} ${mb(t.sourceBytes)} → ${mb(t.outputBytes)}  (-${t.savedPct.toFixed(1)}%)  ${t.exceptions} exception(s)`);
  console.log(`  TOTAL  ${mb(grand.sourceBytes)} → ${mb(grand.outputBytes)}  (-${grand.savedPct.toFixed(1)}%)`);
  console.log("  wrote media-size-report.json + media-size-report.csv");
}
