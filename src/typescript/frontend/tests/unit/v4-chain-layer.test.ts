import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

/**
 * The v4 chain layer is still reachable — and some of it is reachable only from here.
 *
 * ## What this is guarding
 *
 * Seven files under `src/lib/chain/` were written against the generation-2 contracts and survive
 * from before the interface was replaced: `addresses`, `maker-levy`, `pool-id`, `pool-key`,
 * `position-info`, `revert-reason` and `venue`. They do not exist on the branch the UI came from,
 * because that branch never had the v4 work — so a wholesale `git checkout` of either `src/` or
 * `tests/` deletes them, and the second of those two is the one nobody looks at.
 *
 * Some of them can end up imported by **nothing but their own unit tests** — three of them were,
 * until the v4 liquidity UI that reads them was restored (see `TEST_ONLY`). When that happens the
 * tests are load-bearing in a second way: they are the only reference the module has, and deleting
 * one turns its subject into something that reads, to the next person with a linter, as dead code.
 *
 * So this test exists to make that fact **executable** rather than a paragraph in a plan:
 *
 *   - every one of the seven still exists;
 *   - every one of them is referenced by at least one other file;
 *   - and the set that is referenced ONLY by tests is exactly the set declared below, so that
 *     wiring one into the app, or letting one fall out of the app, is a deliberate edit here
 *     rather than a silent change of status.
 *
 * The failure it is really written against: delete `tests/unit/maker-levy.test.ts` and
 * `src/lib/chain/maker-levy.ts` has no referrer left in the repository. Nothing else in any gate
 * would say so.
 */

const FRONTEND = join(__dirname, "..", "..");
const SRC = join(FRONTEND, "src");
const TESTS = join(FRONTEND, "tests");
const CHAIN = join(SRC, "lib", "chain");

/** The seven files that came from the v4 work and are not on the fork's branch. */
const V4_FILES = [
  "addresses",
  "maker-levy",
  "pool-id",
  "pool-key",
  "position-info",
  "revert-reason",
  "venue",
] as const;

/**
 * The ones whose only referrer is a test. **Empty, and that is a finding.**
 *
 * The plan named five. When this test was written it was three — the market page had since taken
 * up `pool-id` and `venue`. It is now none, and the reason is the whole story of the trap:
 *
 * The liquidity UI — `use-liquidity`, `use-liquidity-actions` and the `/pools` components — HAD
 * been rewritten against exactly this chain layer, on the branch these contracts came from. Then
 * `git checkout <fork> -- src/` brought the new interface across, and the fork's older, V3 version
 * of that UI landed on top of it. The chain layer was preserved by hand because the plan named it;
 * the four hundred lines of v4 UI reading it were not, because nobody had listed them. What was
 * left behind was seven v4 modules with no consumer, three of which had nothing but a unit test
 * pointing at them — which is exactly what "dead code" looks like from the outside.
 *
 * Restoring that UI gave every one of the seven a referrer in `src` again. So the list is empty
 * because the modules are in use, not because they were removed.
 *
 * Keep the assertion. A module falling back onto this list means something in `src` stopped
 * importing it, and that is worth a diff either way.
 */
const TEST_ONLY: readonly string[] = [];

/** Every `.ts`/`.tsx` under a directory, recursively. */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });

/** Every module specifier a file imports, re-exports, or `require`s. */
const specifiers = (source: string): string[] => [
  ...[...source.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]),
];

const srcFiles = walk(SRC);
const testFiles = walk(TESTS);

/**
 * Who imports a given chain module, by basename.
 *
 * Basename rather than a resolved path because the same module is reached three ways — `@/lib/
 * chain/venue` from a component, `lib/chain/venue` from an older import, `./venue` from a sibling
 * inside the chain layer — and a rule that only recognises one of them would report a module as
 * unreferenced the day someone tidies an import.
 *
 * The module's own file is never counted as its own referrer.
 */
const referrers = (name: string, files: string[]): string[] =>
  files
    .filter((file) => file !== join(CHAIN, `${name}.ts`))
    .filter((file) => specifiers(readFileSync(file, "utf8")).some((s) => basename(s) === name))
    .map((file) => relative(FRONTEND, file));

describe("the preserved v4 chain layer", () => {
  it.each(V4_FILES)("src/lib/chain/%s.ts is still here", (name) => {
    expect(() => statSync(join(CHAIN, `${name}.ts`))).not.toThrow();
  });

  it.each(V4_FILES)("something still imports %s", (name) => {
    expect([...referrers(name, srcFiles), ...referrers(name, testFiles)]).not.toEqual([]);
  });

  /**
   * The status list, held to the code.
   *
   * A module moving on or off it is a real event — "the app now uses this" or "the app stopped
   * using this, and its test is the last thing holding it" — and both deserve a diff.
   */
  it("names exactly the modules whose only referrer is a test", () => {
    const testOnly = V4_FILES.filter(
      (name) => referrers(name, srcFiles).length === 0 && referrers(name, testFiles).length > 0
    );
    expect(testOnly).toEqual(TEST_ONLY);
  });
});
