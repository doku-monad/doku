import { useEmojiFontConfig } from "lib/hooks/use-emoji-font-family";
import { type DetailedHTMLProps, type HTMLAttributes, useMemo } from "react";

import { type AnyEmojiData, getEmojisInString } from "@/sdk/index";

/**
 * Displays emoji as a simple span element containing text representing one or more emojis.
 *
 * It uses the emoji font determined by @see {@link useEmojiFontConfig}.
 */
export const Emoji = ({
  emojis,
  ...props
}: Omit<DetailedHTMLProps<HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>, "children"> & {
  emojis: AnyEmojiData[] | string;
}) => {
  const { emojiFontClassName } = useEmojiFontConfig();

  const data = useMemo(
    () =>
      typeof emojis === "string"
        ? getEmojisInString(emojis).join("")
        : emojis.map((e) => e.emoji).join(""),
    [emojis]
  );

  return (
    // Wrap this in div so that any font families from tailwind utility classes don't clash with the emoji font class
    // name. This means it's not necessary to manually change each usage of font utility classes in the codebase, and
    // instead just let the font size / line height cascade downwards but override the font family with the emoji font.
    <span className={props.className}>
      <span
        {...props}
        className={emojiFontClassName}
        style={{ fontVariantEmoji: "emoji", display: "inline", ...props.style }}
      >
        {data}
      </span>
    </span>
  );
};

declare global {
  /* eslint-disable-next-line @typescript-eslint/no-namespace */
  namespace JSX {
    interface IntrinsicElements {
      "em-emoji": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        size?: string;
        native?: string;
        key?: string;
        set?: string;
      };
    }
  }
}
