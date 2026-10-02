"use client";

import { useCallback, useEffect, useState } from "react";

import { copyText } from "@/lib/utils/copy-text";

/**
 * Copy something, and say so for a moment.
 *
 * Five places wrote this by hand — the market page's address chip, the card's CA chip, the launch
 * form's link request, the status pages' reference and the wallet menu — and each wrote it slightly
 * differently: two flags or one, a `setTimeout` cleared on unmount or not, 1400ms or 1600. One of
 * them set state after unmount, which is a live warning on a board that re-sorts while a tick is
 * showing.
 *
 * The three parts that were being rewritten each time are the ones here: the copy itself (through
 * `copyText`, which never throws — see its note on non-secure contexts), a flag that says what
 * happened, and a timer that clears it and is cancelled on unmount.
 *
 * `reset` is a parameter rather than a constant because two call sites genuinely differ: the
 * inline chips hold their tick for 1400ms and the two full-width "Copy" buttons for 1600. Rather
 * than quietly normalise those, the hook takes the number.
 *
 * A single `state` rather than a `copied` and a `failed` boolean: they are mutually exclusive, and
 * as two booleans nothing stopped both being true at once — which is what happens when a second
 * copy fails while the first one's tick is still up.
 */
export const useCopyFlag = (resetMs = 1400) => {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), resetMs);
    return () => clearTimeout(timer);
  }, [state, resetMs]);

  const copy = useCallback(
    (text: string) => copyText(text).then((ok) => setState(ok ? "copied" : "failed")),
    []
  );

  return { copied: state === "copied", failed: state === "failed", copy };
};

export default useCopyFlag;
