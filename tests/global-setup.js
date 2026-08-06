/* Verify the dev server on the test port serves THIS checkout — then let the suite run.

   Why this exists: playwright.config sets `reuseExistingServer: true`, which makes
   Playwright adopt whatever is already listening on the port without asking where it
   serves from. With two clones side by side (byte-save / byte-save-1), a server left
   running in one silently answers the other's whole suite. That produced a green
   curtain-perf run against a tree four commits stale — tests that passed while proving
   nothing about the code under test. A silent wrong-tree run is worse than a crash.

   Comparing one served file against disk is NOT enough: the clones' root index.html was
   byte-identical while the game files differed, so the check passed and the suite still
   ran against the wrong tree. Instead we ask the server which root it serves
   (/__server-root, added in tools/server.js) and compare that to this repo. A server too
   old to answer the probe is by definition not this checkout, which is also a failure. */
"use strict";

const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");

function explain(port, detail) {
  return (
    `\n\n  The dev server on port ${port} is NOT serving this checkout.\n` +
    `    ${detail}\n` +
    `    this repo: ${REPO_ROOT}\n\n` +
    `  Playwright reuses whatever already listens on ${port}, so the suite would have\n` +
    `  tested that other tree and reported success. Fix it one of two ways:\n\n` +
    `    - stop the other server:   lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs kill\n` +
    `    - or run on your own port: BYTE_TEST_PORT=8181 npx playwright test\n`
  );
}

module.exports = async function globalSetup(config) {
  const baseURL = config.projects[0].use.baseURL;
  const port = new URL(baseURL).port;

  let res;
  try {
    res = await fetch(`${baseURL}/__server-root`);
  } catch {
    // Nothing listening yet — Playwright's webServer block starts our own server after
    // this hook, so there is no foreign tree to worry about. Only a wrong ANSWER is a bug.
    return;
  }

  if (!res.ok) {
    throw new Error(explain(port, `it does not answer /__server-root (HTTP ${res.status}) — an older or unrelated server`));
  }

  let served;
  try {
    served = (await res.json()).root;
  } catch {
    throw new Error(explain(port, "its /__server-root reply was not JSON — an unrelated server"));
  }

  if (path.resolve(served) !== REPO_ROOT) {
    throw new Error(explain(port, `it serves:  ${served}`));
  }
};
