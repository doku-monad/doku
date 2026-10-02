import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import React from "react";

import Maintenance from "./component";

/* `"use client"` moved onto the component: a file that exports `metadata` cannot be a client
   module, and this page's only job was to render one. */
export const metadata = generateMetadataHelper({
  title: "Down for maintenance",
  description: "DOKU is briefly offline while we ship something. Back shortly.",
});

export default function MaintenancePage() {
  return <Maintenance />;
}
