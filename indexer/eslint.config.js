import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Lint for the indexer.
 *
 * Deliberately close to the recommended sets rather than a house style: the value here is catching
 * the mistakes that survive `tsc` — a floating promise in the ingest loop, an unawaited
 * transaction, an unused import left behind by a refactor — not enforcing formatting.
 *
 * `no-floating-promises` is the one that earns its place. Every write in this service is async, and
 * a dropped `await` inside a transaction commits an empty transaction while the work happens
 * afterwards, outside it.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "generated/**",
      "src/generated/**",
      "prisma/generated/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // `allowDefaultProject` covers this config file itself, which is not in any tsconfig's
        // `include` and would otherwise fail to parse.
        projectService: { allowDefaultProject: ["eslint.config.js", "prisma.config.ts", "vitest.config.ts", "scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // Underscore-prefixed arguments are the conventional way to say "required by the signature,
      // unused by this implementation" — a Hono handler that ignores its context, for one.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // The codebase passes `unknown` around at the RPC and DB boundaries on purpose; requiring a
      // cast at every use would add noise without adding safety.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Build scripts are plain Node ESM, not part of a tsconfig. `no-undef` does not know Node's
    // globals; TypeScript handles that for everything else, which is why the rule is only a
    // problem here.
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    // Tests reach into internals and assert on shapes the type system cannot see.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Assertion messages interpolate values whose type is deliberately `unknown`.
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-base-to-string": "off",
      // Test doubles implement async signatures they have no reason to await.
      "@typescript-eslint/require-await": "off",
    },
  },
);
