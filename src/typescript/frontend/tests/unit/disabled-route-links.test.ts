import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "../../src");

/** Everything under `src`, minus the liquidity feature's own pages. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // The pools pages may link to themselves freely — the whole subtree is behind the gate.
      return entry === "pools" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/**
 * A link to a disabled route is a link to a 404.
 *
 * `middleware.ts` answers 404 for `/pools` whenever `FEATURE_FLAGS.Liquidity` is off, which is the
 * correct thing for the ROUTE to do and says nothing about what the rest of the app renders. Four
 * separate places linked there anyway: the header nav (which was gated), and the footer directory,
 * the mobile tab bar and a full-width primary-green "Add liquidity" button on every market page
 * (which were not). The button was the one people found — it sits directly under Buy.
 *
 * The rule is mechanical because the failure is: any file that mentions the route has to mention
 * the flag that decides whether the route exists. It cannot tell whether the gate is CORRECT, only
 * that the author had to think about it, which is the part that was skipped.
 */
describe("links to gated routes", () => {
  const offenders = sourceFiles(SRC)
    .filter(
      (file) =>
        // The route table names every route; the middleware and the flag file are where the gate
        // is DEFINED. All three mention `/pools` by necessity.
        !file.endsWith("middleware.ts") &&
        !file.endsWith("routes.ts") &&
        !file.endsWith("feature-flags.ts")
    )
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      if (!/ROUTES\.pools|["'`]\/pools/.test(source)) return false;
      return !source.includes("FEATURE_FLAGS.Liquidity");
    })
    .map((file) => file.slice(file.indexOf("src/")));

  it("never links to /pools without consulting the liquidity flag", () => {
    expect(offenders).toEqual([]);
  });
});
