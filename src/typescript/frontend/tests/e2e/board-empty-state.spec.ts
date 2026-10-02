import { expect, test } from "@playwright/test";

/**
 * A search that matches nothing shows the empty state, not the error boundary.
 *
 * `/explore` used to crash here, and the path to it was one keystroke: `LiveStatus` renders the
 * board's total through `<FormattedNumber decimals={0} />`, sliding precision sends anything under
 * 1 down the significant-digits branch, and `Intl.NumberFormat` throws a `RangeError` on
 * `maximumSignificantDigits: 0` rather than rounding. The throw is inside a `useMemo`, so it
 * happened during render and escaped to `app/error.tsx` — the whole board replaced by "This page
 * didn't load" in every state where the count is zero: a search with no matches, any of the
 * zero-count pair chips `PairFilter` deliberately renders as clickable, an indexer outage, and a
 * deployment with nothing launched on it yet.
 *
 * It is asserted through the URL rather than by typing, so the test does not depend on the search
 * field's 260ms debounce or on the indexer being up — `?q=` is what the field commits to anyway.
 */
test("a board search with no matches renders the empty state", async ({ page }) => {
  await page.goto("/explore?q=zzzzzzzz");

  // The empty state, which is the thing that was never reached.
  await expect(page.getByText(/Nobody has launched this one/i)).toBeVisible({ timeout: 30_000 });

  // And emphatically not the route's error boundary.
  await expect(page.getByText(/This page didn't load/i)).toHaveCount(0);
  await expect(page.getByText(/Something broke/i)).toHaveCount(0);
});

/**
 * The same count, rendered rather than thrown.
 *
 * `0 markets` is the figure that did the throwing, so it is worth asserting that it is on the page
 * at all — a fix that merely swallowed the error would pass the test above and fail this one.
 */
test("the board states a zero count without crashing", async ({ page }) => {
  await page.goto("/explore?q=zzzzzzzz");
  await expect(page.getByText(/^0$/).first()).toBeVisible({ timeout: 30_000 });
});
