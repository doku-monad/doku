import { defineConfig, devices } from "@playwright/test";

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  /* Run tests in files in parallel. */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    [process.env.GITHUB_ACTIONS ? "github" : "list"],
    ["html", { outputFolder: "playwright-report" }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`.
     *
     * `PLAYWRIGHT_BASE_URL` so `deploy-web.sh` can point the suite at the `next start` it runs on
     * its own port against the build it just made, rather than at whatever happens to be on 3001 —
     * which during development is a `next dev` serving different code. The default is unchanged,
     * so running `pnpm test:e2e` by hand against your own dev server still works. */
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3001",

    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "retain-on-first-failure",

    launchOptions: {
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --conditions=react-server`,
      },
      slowMo: 0, // Change this to 1000-3000 to slow the test down and see what's going on.
    },
  },

  /*
   * No `setup`/`teardown` projects any more.
   *
   * They ran an Aptos Docker harness from `sdk/tests/utils/docker`, which does not exist in this
   * repository — DOKU is an EVM protocol on Monad, and the specs that depended on it
   * (`market-order`, `search`) were written against the deleted Aptos SDK client class,
   * `ONE_APT_BIGINT` and funded Aptos accounts. None of it had compiled since the fork;
   * `pnpm check:tests` failed on the imports rather than on anything real.
   *
   * What replaces it is not written yet. A DOKU end-to-end run needs three processes — anvil with
   * `LocalScenario`, the indexer, and `next dev` pointed at both — and the first of those already
   * works: `tests/integration/anvil.ts` boots a full v4 chain with a launched market and is what a
   * `globalSetup` here should call. The remaining specs run against a frontend the developer is
   * already running, which is what the `baseURL` above assumes.
   */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
