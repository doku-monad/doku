"use client";

import StatusPage from "components/pages/status-page";
import React from "react";

/**
 * The maintenance screen, reachable only through the `MAINTENANCE_MODE` redirect in `middleware.ts`.
 *
 * It was a black full-viewport panel with a rain of random emoji behind it and "{ MAINTENANCE }"
 * scrambling in pixel type on top, boxed in by a 30px black shadow. It is now the same status page
 * every other dead end uses — and it no longer doubles as the error boundary, which is what made
 * "maintenance" appear whenever any component happened to throw.
 */
export default function Maintenance() {
  return (
    <StatusPage eyebrow="Maintenance" title="DOKU is down for a moment" code="503" tone="warn">
      <p>
        We&apos;re shipping something. Markets are untouched and nothing on-chain is affected —
        trading picks up exactly where it left off when this page goes away.
      </p>
    </StatusPage>
  );
}
