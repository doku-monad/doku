import type React from "react";

/**
 * Whether the text-scramble effect can run on this label.
 *
 * The effect writes characters into the DOM node directly, so a scrambling button renders an empty
 * `<Text>` and lets the library fill it in. That only works when there is text to scramble. Handed
 * anything else it stringifies it, and a JSX label — a word with an emoji beside it, say — becomes
 * the literal "[object Object]", rendered in capitals because the button style uppercases.
 *
 * So the effect is a property of the label, not only of the caller's intent: asking for it on an
 * element is a request that cannot be honoured, and silently rendering the label plainly is much
 * better than rendering a stringified object.
 */
export function canScramble(requested: boolean, children: React.ReactNode): boolean {
  return requested && (typeof children === "string" || typeof children === "number");
}
