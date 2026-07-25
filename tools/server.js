#!/usr/bin/env node
/* ============================================================================
   DEV-ONLY static file server with HTTP byte-range (206 Partial Content) support.
   ----------------------------------------------------------------------------
   The flipbook + both embedded games are a pure static site — this server exists
   ONLY so local testing behaves like the real deployment (Vercel):
     • Range requests → 206, so <video> seeking/replay doesn't re-download the
       whole clip (the whole point of Phase 18).
     • Correct MIME types for .webm / .ogg / .webp, which file:// gets wrong.
     • Case-sensitive path resolution, matching Linux hosts, so a wrong-case
       reference fails here instead of silently working on Windows and 404ing
       in production.
   It is NOT part of the build or the deployment payload.

   Usage:  node tools/server.js [port] [root]
   ============================================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const PORT = Number(process.argv[2] || 8080);
const ROOT = path.resolve(process.argv[3] || path.join(__dirname, ".."));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

/* Resolve a URL path to a real file, verifying EVERY segment's case against the
   real directory listing. Windows/macOS are case-insensitive, Linux is not — this
   turns a deploy-only 404 into a local one. */
async function resolveCaseSensitive(relPath) {
  const segments = relPath.split("/").filter((s) => s.length && s !== ".");
  let current = ROOT;
  for (const seg of segments) {
    if (seg === "..") return null; // never escape the root
    let entries;
    try {
      entries = await fsp.readdir(current);
    } catch {
      return null;
    }
    if (!entries.includes(seg)) return null; // exact-case match required
    current = path.join(current, seg);
  }
  return current;
}

/* Parse a single-range "bytes=start-end" header. Returns null for absent /
   unsupported / multi-range, and {unsatisfiable:true} for an out-of-bounds range. */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  if (!hasStart && !hasEnd) return null;
  let start, end;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
  } else {
    // suffix range: last N bytes
    const n = Number(m[2]);
    if (n === 0) return { unsatisfiable: true };
    start = Math.max(0, size - n);
    end = size - 1;
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (urlPath.endsWith("/")) urlPath += "index.html";

  const filePath = await resolveCaseSensitive(urlPath);
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found: " + urlPath);
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("404 Not Found");
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(302, { Location: urlPath.replace(/\/?$/, "/") + "index.html" }).end();
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  /* Caching policy, chosen so local measurements are REPRESENTATIVE of production:
       code/markup → no-cache, so edits show up immediately while iterating.
       media       → a short max-age, so when the preloader has already fetched a file the
                     element's own request is served from the browser cache instead of the
                     network. With "no-store" every preloaded asset was downloaded TWICE
                     locally, which is not what a real host does and made the measured
                     initial-bytes figure roughly double the truth. */
  const isMedia = /^\.(webp|png|jpe?g|svg|gif|webm|mp4|ogg|oga|opus|mp3|m4a|wav|woff2?|ttf)$/.test(ext);
  const base = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": isMedia ? "public, max-age=300" : "no-cache",
    "Last-Modified": stat.mtime.toUTCString(),
  };

  const range = parseRange(req.headers.range, stat.size);

  if (range && range.unsatisfiable) {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${stat.size}` }).end();
    return;
  }

  if (range) {
    const len = range.end - range.start + 1;
    res.writeHead(206, {
      ...base,
      "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
      "Content-Length": String(len),
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath, { start: range.start, end: range.end })
      .on("error", () => res.destroy())
      .pipe(res);
    return;
  }

  res.writeHead(200, { ...base, "Content-Length": String(stat.size) });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[dev-server] http://127.0.0.1:${PORT}/  root=${ROOT}`);
  console.log(`[dev-server] Range (206) support: enabled`);
});
