import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(__dirname, "../../src/app/api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return routeFiles(path);
    return entry === "route.ts" ? [path] : [];
  });
}

/** The `request` parameter, if `GET` declares one. Next treats reading it as an opt out of caching. */
function getTakesRequest(source: string): boolean {
  const signature = source.match(/export\s+(?:async\s+)?function\s+GET\s*\(([^)]*)\)/s);
  return signature !== null && signature[1].trim().length > 0;
}

function declaresDynamic(source: string): boolean {
  return /export\s+const\s+dynamic\s*=\s*["'](force-dynamic|force-static)["']/.test(source);
}

/**
 * Route handlers answer at request time, or say why not.
 *
 * Next decides statically: a `GET` that never touches `request` has nothing request-shaped in it,
 * so the handler is run once during the build and its response is served afterwards as a file.
 * Nothing warns about this. The handler still compiles, still returns the right shape, and still
 * looks completely correct in the source — it is simply answering a question nobody asked again.
 *
 * Both endpoints that had no `request` were ones where a frozen answer is a lie with consequences:
 * `/api/status` reported a dead indexer as healthy, and `/api/price` would have pinned MON/USD to
 * its value at deploy time. Both had careful runtime machinery — a staleness cutoff, a sixty-second
 * refresh — that ran exactly once, at build, and was never reached again.
 *
 * So the rule is not "be dynamic". It is that the choice has to be written down, because the
 * default is invisible and the failure it produces is a stale number rather than an error.
 */
describe("api route freshness", () => {
  const files = routeFiles(API_DIR);

  it("finds the route handlers to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((file) => [file.slice(file.indexOf("src/app/api")), file]))(
    "%s is dynamic by request, or declares what it is",
    (_label, file) => {
      const source = readFileSync(file, "utf8");
      expect(getTakesRequest(source) || declaresDynamic(source)).toBe(true);
    }
  );

  /**
   * The two that prompted this, named rather than merely covered by the sweep above: a later
   * refactor that drops the parameter is exactly how the caching would come back, and it would come
   * back silently.
   */
  it.each([["status"], ["price"]])("/api/%s is pinned to request time", (name) => {
    const source = readFileSync(join(API_DIR, name, "route.ts"), "utf8");
    expect(source).toMatch(/export const dynamic = "force-dynamic"/);
  });
});
