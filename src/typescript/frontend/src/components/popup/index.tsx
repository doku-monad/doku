import "./styles.css";

import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import React, { useEffect, useState } from "react";
import isTouchDevice from "utils/is-touch-device";

/**
 * A tooltip on a pointer, a popover on a touchscreen.
 *
 * ## Why the touch read is in an effect
 *
 * `isTouchDevice()` reads `window`/`navigator`, and it was called **during render** to choose
 * between two completely different subtrees. The server has neither, so it always rendered the
 * Tooltip branch; a phone then rendered the Popover branch on its first client pass, and React
 * found a different tree than the HTML it was hydrating. That is a hydration mismatch on a
 * component reached from `ConnectWalletButton` whenever the geoblock check has not answered yet —
 * which is every visitor, for the length of one round trip.
 *
 * So the first client render matches the server's (Tooltip), and the swap to Popover happens in an
 * effect a frame later. A touchscreen cannot hover, so nothing is lost in that frame: the Tooltip
 * branch simply does not open, and by the time a finger lands the Popover is mounted.
 */
const Popup: React.FC<
  React.PropsWithChildren<{ content: React.ReactNode; className?: string; uppercase?: boolean }>
> = ({ children, content, className, uppercase = true }) => {
  const [touch, setTouch] = useState(false);
  useEffect(() => setTouch(isTouchDevice()), []);

  const tooltipContent = (
    <div className={`text-ink font-ui text-[14px] ${uppercase ? "uppercase" : ""}`}>{content}</div>
  );

  return touch ? (
    <RadixPopover.Root>
      <RadixPopover.Trigger asChild>{children}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={`TooltipContent ${className}`} sideOffset={5}>
          {tooltipContent}
          <RadixPopover.Arrow className="TooltipArrow" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  ) : (
    <RadixTooltip.Provider delayDuration={200}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className={`TooltipContent ${className}`} sideOffset={5}>
            {tooltipContent}
            <RadixTooltip.Arrow className="TooltipArrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
};

export default Popup;
