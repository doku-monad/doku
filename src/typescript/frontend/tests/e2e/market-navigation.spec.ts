import { expect, test } from "@playwright/test";

/**
 * You can leave a market page.
 *
 * This looks like the most trivial assertion in the suite and it is here because the market page
 * once could not do it. Every in-page control worked — the Buy/Sell tabs switched, the amount
 * presets filled the field, the chart ranges changed, the tab deck opened — and not one link
 * navigated anywhere.
 *
 * The cause was a render loop in `SwapButton`: it published its submit handler upward through an
 * effect keyed on that handler's identity, and the handler's dependencies included a callback the
 * parent rebuilt on every render. React throttles such a loop instead of blocking the thread, so
 * the page still painted at sixty frames a second with an idle main thread and no console error in
 * production — but a router transition cannot commit while rendering never settles, so `pushState`
 * was never reached and the URL simply stayed put.
 *
 * Nothing about that is visible from the outside except this: the links stop working. So this is
 * the test.
 *
 * Needs a frontend running at the config's `baseURL` with at least one market indexed — see the
 * note in `playwright.config.js`.
 */
test("a market page can navigate away", async ({ page }) => {
  await page.goto("/explore");
  /*
   * A card in the board, not merely the first market link on the page.
   *
   * The first `a[href^="/market/"]` on `/explore` is a ticket in the hero's coin tape, which
   * scrolls forever — so Playwright's actionability check ("visible, enabled and stable") can
   * never pass on it and this test timed out on an element that is working exactly as designed.
   * The tape pauses on hover, but the stability check samples the box before it hovers.
   *
   * The board grid is also what the test means: this is about a market page reached from the
   * board, and `#emoji-grid` is that board.
   */
  const card = page.locator('#emoji-grid a[href^="/market/"]').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  await page.waitForURL(/\/market\//, { timeout: 30_000 });

  // The panel has to be interactive before the assertion means anything: a market page that never
  // hydrated would also "fail to navigate", for an entirely different reason.
  /* The presets are dollar amounts now — they were bare `0.5`-style quote figures when this was
     written. Same rename trap as the two below; the panel is priced in USD across the app. */
  const preset = page
    .locator("button")
    .filter({ hasText: /^\$100$/ })
    .first();
  await expect(preset).toBeVisible({ timeout: 30_000 });
  await preset.click();

  /*
   * The direction control, which is a segmented Buy/Sell pair again.
   *
   * This has now been wrong twice. It first asked for `getByRole("tab", …)`, which the panel lost
   * when it became a single stack with a flip affordance; it was corrected to "Flip direction",
   * which the panel has since lost too — the direction is two `aria-pressed` keys again
   * (`SwapComponent`). Both times the suite missed the rename for the same reason: it needs a
   * running frontend and no gate ran it. That is what the e2e step in `deploy-web.sh` is for.
   *
   * Clicking it is still what this step is for: the assertion below is about a page that hydrated
   * and stayed interactive, and a control that does nothing when clicked would not prove that.
   */
  const sell = page.getByRole("button", { name: "Sell", exact: true }).first();
  await expect(sell).toBeVisible({ timeout: 30_000 });
  await sell.click();

  // The actual regression.
  /*
   * Selected by HREF, not by label.
   *
   * This filtered on the text "Explore" and found nothing: the link is called "Board" now — the
   * route stayed `/explore`, only the word changed (see `header/constants.ts`). The href is the
   * durable half of that pair and it is also the thing this test is actually about, so it is what
   * the locator keys on.
   */
  await page.locator("header a[href='/explore']").first().click();
  await page.waitForURL(/\/explore/, { timeout: 15_000 });
  expect(page.url()).toContain("/explore");
});
