/* DEV-ONLY Playwright config. Runs against the local Range-capable dev server
   (tools/server.js) — never file://, so byte-range video seeking behaves like the
   real deployment. Excluded from the deployment payload via .vercelignore. */
const { defineConfig, devices } = require("@playwright/test");

const PORT = 8080;

module.exports = defineConfig({
  testDir: "./tests",
  fullyParallel: false,          // one browser at a time: the media is heavy
  workers: 1,
  timeout: 180000,               // page-1 video alone is 53s, and we watch it finish
  expect: { timeout: 15000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // Without this a hung click has NO timeout and silently eats the whole test budget,
    // which is exactly how a passing playthrough came to look like a failure.
    actionTimeout: 30000,
    trace: "retain-on-failure",
    video: "off",
    screenshot: "off",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",  // let the page videos start
        "--mute-audio",
      ],
    },
  },
  projects: [
    { name: "desktop-1366", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } } },
    // Narrower, mobile-like LANDSCAPE viewport (the book is landscape-locked).
    { name: "landscape-844", use: { ...devices["Desktop Chrome"], viewport: { width: 844, height: 390 } } },
  ],
  webServer: {
    command: `node tools/server.js ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: true,
    timeout: 30000,
  },
});
