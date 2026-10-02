// @ts-check
/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */
/** @type {import('jest').Config} */
const config = {
  clearMocks: true,
  collectCoverage: false,
  coverageDirectory: "coverage",
  coverageProvider: "v8",
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  /**
   * Runs before any module is imported, which is the only place these can be set.
   *
   * `src/lib/chain/addresses.ts` reads its variables at module load, so a test that imports it
   * needs them present before the import — not in a `beforeAll`. See the file for what it fills
   * and why it never overrides an existing value.
   */
  setupFiles: ["<rootDir>/tests/integration/env.ts"],
  workerThreads: true,
  testEnvironment: "./tests/fixed-jsdom-environment.ts",
  testEnvironmentOptions: {
    customExportConditions: ["node", "node-addons"],
  },
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 55,
      lines: 55,
      statements: 55,
    },
  },
};

const nextJest = require("next/jest").default;
const createJestConfig = nextJest({
  dir: "./",
});
module.exports = createJestConfig(config);
