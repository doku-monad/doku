import StatusPage from "components/pages/status-page";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import React from "react";
import { ROUTES } from "router/routes";

/*
 * No `"use client"` on this file, deliberately.
 *
 * A client module cannot export `metadata` — Next drops it without an error — which is why this
 * route's tab came back empty the first time a title was added here. The page's only job is to
 * render `StatusPage`, which carries its own `"use client"`, so the boundary belongs there and not
 * on the file that owns the route's metadata.
 */
export const metadata = generateMetadataHelper({
  title: "Launching soon",
  description: "This part of DOKU is not open yet.",
});

/**
 * A route that exists but isn't open yet.
 *
 * The previous version was the matrix-rain screen again — a black viewport of falling emoji with
 * "LAUNCHING SOON" scrambling across it at 7vw. Same treatment as maintenance and the error
 * boundary, so all three were indistinguishable from each other and from an outage.
 */
export default function LaunchingPage() {
  return (
    <StatusPage
      eyebrow="Not open yet"
      title="Launching soon"
      code="Soon"
      actions={[{ label: "Browse markets", href: ROUTES.explore, variant: "secondary" }]}
    >
      <p>This part of DOKU isn&apos;t live yet. Everything else is.</p>
    </StatusPage>
  );
}
