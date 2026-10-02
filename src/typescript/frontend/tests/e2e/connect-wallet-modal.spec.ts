import { expect, test } from "@playwright/test";

/**
 * The connect dialog in a browser with no wallet.
 *
 * A headless browser injects no provider and announces nothing over EIP-6963, so this is the one
 * state Playwright can actually observe — and it is not a corner case. It is every phone browser
 * opened outside a wallet's own app, which on a launchpad is a large share of first visits.
 *
 * The assertion that matters is that the dialog says why the list is empty and offers somewhere to
 * go. An empty box is indistinguishable from a broken dialog, and this is the surface where looking
 * broken costs the most.
 *
 * Needs a frontend running at the config's `baseURL` — see the note in `playwright.config.js`. As
 * of writing, `next dev` serves a bundle that lowers `10n ** 18n` in `lib/chain/quote-scale.ts` to
 * `Math.pow`, which throws on a BigInt and takes the whole client render with it, so this spec and
 * `market-navigation` both fail locally for a reason that has nothing to do with either of them.
 */
test("the connect dialog invites an install when no wallet is injected", async ({ page }) => {
  await page.goto("/");

  const connect = page.getByRole("button", { name: /^Connect$/i }).first();
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();

  const dialog = page.getByRole("heading", { name: /Connect a wallet/i });
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  await expect(page.getByText(/No wallet detected in this browser/i)).toBeVisible();

  // Somewhere to go, and it leaves the app: an install row is a link to the wallet's own download
  // page, not a connect action wearing a wallet's logo.
  const install = page.getByRole("link", { name: /^Install MetaMask$/i });
  await expect(install).toBeVisible();
  await expect(install).toHaveAttribute("href", /^https:\/\//);
  await expect(install).toHaveAttribute("target", "_blank");

  /*
   * And no connect rows at all.
   *
   * The dialog's other branch renders these, and rendering both — connectable rows in a browser
   * that has nothing to connect — is the failure this catches.
   *
   * `exact` is load-bearing, and its absence is why this line could never pass. The empty-state
   * paragraph asserted four lines above begins "No wallet DETECTED IN THIS BROWSER", so a loose
   * `/Detected in this browser/i` matched the very prose the test had just demanded be visible:
   * the spec contradicted itself and failed on a dialog that was behaving exactly as written.
   * A connect row's caption is that phrase and nothing else, so an exact match tells them apart.
   */
  await expect(page.getByText("Detected in this browser", { exact: true })).toHaveCount(0);
});

/**
 * The dialog can be closed by its own close key.
 *
 * This is the assertion the suite did not have, and its absence is the whole reason the close key
 * shipped broken. The key was centred with `-translate-y-1/2`, and the app's global press
 * affordance is `button:active { transform: translateY(1px) }` — one property, so pressing the key
 * did not nudge it, it threw its centring away and dropped it 17px on mousedown. The pointer came
 * up over the heading behind it and the browser fired `click` on the row the two had in common, so
 * the handler never ran.
 *
 * Nothing static could see it: the markup was correct, the handler was wired, `tsc`, `eslint` and
 * the build were all green, and `page.getByRole(...).click()` in Playwright would have passed too,
 * because Playwright's click is a real pointer sequence at the element's CENTRE — computed BEFORE
 * the press moves it. So this asserts on the outcome, which is the only part that was ever wrong.
 */
test("the connect dialog closes on its close key", async ({ page }) => {
  await page.goto("/");

  const connect = page.getByRole("button", { name: /^Connect$/i }).first();
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();

  const heading = page.getByRole("heading", { name: /Connect a wallet/i });
  await expect(heading).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Close" }).click();
  await expect(heading).toBeHidden({ timeout: 10_000 });
});

/**
 * And on Escape, which is the path a keyboard user has.
 *
 * Separate from the one above on purpose: they fail for different reasons. Escape is HeadlessUI's,
 * the key is ours, and a change to `BaseModal`'s `Transition`/`Dialog` wiring can break either one
 * without touching the other.
 */
test("the connect dialog closes on Escape", async ({ page }) => {
  await page.goto("/");

  const connect = page.getByRole("button", { name: /^Connect$/i }).first();
  await expect(connect).toBeVisible({ timeout: 30_000 });
  await connect.click();

  const heading = page.getByRole("heading", { name: /Connect a wallet/i });
  await expect(heading).toBeVisible({ timeout: 15_000 });

  await page.keyboard.press("Escape");
  await expect(heading).toBeHidden({ timeout: 10_000 });
});
