"use client";

import { cn } from "lib/utils/class-name";
import React, { useEffect, useState } from "react";

/**
 * A key, as in a keyboard's — for every shortcut the interface names.
 *
 * The ⌘K beside the top bar's search was one grey glyph pair in the placeholder's own mute ink on
 * a dark plate: at 11px it was very nearly invisible, and a shortcut nobody can read is decoration.
 * This is a raised cap in the pair chips' key material (`--mat-pair-bg`) with an even hairline all
 * round and its legend in `ash`, two steps brighter than the placeholder — so it reads as the one
 * thing on the field you press rather than more of the field's own lettering.
 *
 * One legend per cap. A chord is two caps side by side (`⌘` `K`), the way the keyboard it refers to
 * draws it.
 */
export const Keycap = ({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <kbd
    className={cn(
      "doku-keycap inline-grid h-[22px] min-w-[22px] shrink-0 place-items-center rounded-[6px] px-1.5 font-numeric text-[11px] font-semibold not-italic leading-none text-ash",
      className
    )}
  >
    {children}
  </kbd>
);

/**
 * The modifier this visitor's keyboard actually has: `⌘` on Apple platforms, `Ctrl` everywhere
 * else. The handler in the header accepts either, and a Windows visitor told to press ⌘ is being
 * told about a key they do not have.
 *
 * Read after mount — the server cannot know the platform — so the first paint says `⌘`, the common
 * case, and anywhere else corrects on the first effect.
 */
export const useModifierKey = () => {
  const [key, setKey] = useState("⌘");
  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const platform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent;
    if (!/mac|iphone|ipad|ipod/i.test(platform)) setKey("Ctrl");
  }, []);
  return key;
};

export default Keycap;
