"use client";

import StatusPage from "components/pages/status-page";
import { useEffect } from "react";
import { ROUTES } from "router/routes";

/**
 * The market route's error boundary.
 *
 * It used to render the "no such market" panel for every error, which told a visitor the market
 * did not exist whenever a component threw — with no way back but a reload. Most of what lands
 * here is transient (a chain read that timed out, a stream that dropped), so this offers `reset`
 * and says what happened. A market that genuinely does not exist never reaches this file: the
 * page renders its own not-found screen for that.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Market page failed to render", error);
  }, [error]);

  return (
    <StatusPage
      eyebrow="Something broke"
      title="This market didn't load"
      code="ERR"
      tone="error"
      reference={error.digest}
      actions={[
        { label: "Try again", onClick: reset },
        { label: "Back to markets", href: ROUTES.explore, variant: "secondary" },
      ]}
    >
      <p>Something on this page threw an error. Retrying is usually enough.</p>
    </StatusPage>
  );
}
