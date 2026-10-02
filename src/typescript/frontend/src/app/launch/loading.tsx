"use client";

import LaunchBenchSkeleton from "components/pages/launch/LaunchBenchSkeleton";
import React from "react";

/**
 * The `/launch` route's loading state.
 *
 * ## Why this is not the emoji card
 *
 * It was `components/loading` — a 300px box with a random symbol emoji cycling in it over an
 * indeterminate bar, centred in a `py-16` flex box. That component exists for the seconds after a
 * launch, while the market page resolves, where it can show the launcher the coin they just made.
 * Here it showed a stranger's emoji in the middle of an empty screen, and then the page appeared
 * around it at four times the height.
 *
 * This route and `LaunchBench` now hand over to each other without the page changing shape: the
 * route draws the heading and the bench's skeleton, the bench draws the same skeleton while the
 * quote registry is in flight, and the form replaces it in the same box. What used to be three
 * different layouts in sequence — spinner, status line, form — is one.
 *
 * The heading is the real one, copied from `ClientLaunchPage` rather than skeletoned, because it
 * is not waiting for anything: it is the same three lines on every visit. Keep it in step with
 * that file — a heading of a different height here is a shift with extra steps.
 */
export default function Loading() {
  return (
    <div className="flex grow flex-col gap-6 pb-4">
      <header className="flex flex-col gap-3">
        <span className="font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.1em] text-doku-ink">
          {"{ new coin }"}
        </span>
        <h1 className="font-pixel font-medium text-[clamp(1.75rem,3.4vw,2.5rem)] uppercase leading-[1.05] tracking-[0.02em] text-ink">
          Launch a coin
        </h1>
        <p className="max-w-[68ch] font-ui text-[15px] leading-relaxed text-ash">
          One transaction mints the whole supply into a pool whose liquidity is locked forever.
          Everything below is permanent.
        </p>
      </header>

      <LaunchBenchSkeleton />
    </div>
  );
}
