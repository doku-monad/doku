/*
 * The Windows-95 theme sheet is imported HERE, not in the root layout, and it has to stay here.
 *
 * `@react95/core/themes/win95.css` ships Eric Meyer's reset inside it — `html, body, div, span,
 * ... { margin: 0; padding: 0; border: 0; ... }`. Imported in `app/layout.tsx` it landed AFTER
 * Tailwind's preflight, and `div` (0,0,1) outranks preflight's `*` (0,0,0), so every div, span,
 * header, section and li in the product computed `border-style: none`.
 *
 * A `border-style` of `none` makes the USED border-width zero no matter what sets the width, so
 * `.border { border-width: 1px }` painted nothing: every Tailwind border utility in the app was
 * dead on anything that is not a button, an input or an svg. The symptom that finally named it
 * was the dock — its rim is a `border` on a div, so the bar came out with the bezel's own inline
 * `border-top` and no bottom and no sides.
 *
 * Scoped to this route, the reset only reaches the one page that wants 1995 back.
 */
import "@react95/core/themes/win95.css";

import CultClientPage from "components/pages/cult/CultClientPage";
import FEATURE_FLAGS from "lib/feature-flags";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import { notFound } from "next/navigation";

export const dynamic = "force-static";

export const metadata = generateMetadataHelper({
  title: "The cult",
  description: "we speak in tickers and tongues. welcome to the inner circle.",
});

export default function CultPage() {
  // Disabled by flag rather than deleted: the page and its component are untouched, so flipping
  // NEXT_PUBLIC_CULT_ENABLED brings it back with no code change. Without this the route stays
  // reachable by URL even though the nav no longer offers it.
  if (!FEATURE_FLAGS.Cult) notFound();
  return <CultClientPage />;
}
