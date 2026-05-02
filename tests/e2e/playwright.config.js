// Playwright config for the Electron e2e suite.
//
// We don't use any browsers — Electron is the only target. The test
// files invoke `_electron.launch` directly. Keeping the config minimal.

const path = require('path');

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = {
  testDir: __dirname,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    // Electron has no browser context; standard browser opts don't apply.
    trace: 'retain-on-failure',
  },
  // Run serially — they all share global state (the registry, the index).
  workers: 1,
  fullyParallel: false,
};
