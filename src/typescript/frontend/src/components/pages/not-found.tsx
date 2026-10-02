"use client";

import StatusPage from "components/pages/status-page";
import React from "react";
import { ROUTES } from "router/routes";

/**
 * 404.
 *
 * The old one set "NOT FOUND PAGE 404" at `pixelDisplay1` with no max width, so on a laptop it ran
 * the full width of the viewport and wrapped mid-phrase, above an unstyled "Go to home page"
 * button. It also said nothing about what was missing or what else you could do.
 */
const NotFoundComponent: React.FC = () => (
  <StatusPage
    eyebrow="Not found"
    title="This page doesn't exist"
    code="404"
    actions={[
      { label: "Browse launches", href: ROUTES.explore },
      { label: "Launch a coin", href: ROUTES.launch, variant: "secondary" },
    ]}
  >
    <p>
      The link is wrong, or whatever was here has moved. Every live market is one search away —
      press <kbd className="font-numeric text-[12px] text-ash">⌘K</kbd> from anywhere.
    </p>
  </StatusPage>
);

export default NotFoundComponent;
