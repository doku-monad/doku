"use client";

import StatusPage from "components/pages/status-page";
import { useEffect } from "react";
import { ROUTES } from "router/routes";

/**
 * The route-level error boundary.
 *
 * It used to render `<Maintenance />` — the black matrix-rain screen with "MAINTENANCE" scrambling
 * in the middle of it. Two things were wrong with that. It claimed the site was down for
 * maintenance when what had actually happened was that a component threw, which sends people to
 * check a status page that will tell them everything is fine. And it dropped `reset`, the one
 * argument Next gives this file, so the only way back was a full reload — even for the transient
 * RPC hiccups that make up most of what lands here.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      eyebrow="Something broke"
      title="This page didn't load"
      code="ERR"
      tone="error"
      reference={error.digest}
      actions={[
        { label: "Try again", onClick: reset },
        { label: "Back to markets", href: ROUTES.explore, variant: "secondary" },
      ]}
    >
      <p>
        Something on this page threw an error. Retrying is usually enough — most of what lands here
        is a network call that timed out.
      </p>
    </StatusPage>
  );
}
