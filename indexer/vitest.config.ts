import { defineConfig } from "vitest/config";

/**
 * Test files run one at a time, deliberately.
 *
 * Most suites here start a real anvil, compile `../contracts`, or spin up an in-process Postgres in
 * WebAssembly. Run several at once and they compete for CPU and file descriptors; the losers fail
 * with timeout-shaped errors that have nothing to do with the code under test. On an untouched
 * checkout `db-client` failed five of eight that way, and every one of those tests passes when the
 * file is run alone. Capping the worker count at three was not enough — a later run failed seven
 * tests across four different suites.
 *
 * So: no file parallelism. It costs wall-clock and buys the only thing a test suite is for, which
 * is an answer that means the same thing twice. A flaky suite is worse than a slow one, because it
 * teaches everyone to re-run rather than to read.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
