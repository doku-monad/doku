"use client";

/* `useState` for the details disclosure, so this is a client component. It is imported by server
   components — the preview banners among them — and without the directive their build fails. */
import { cn } from "lib/utils/class-name";
import { type ReactNode, useEffect, useState } from "react";

import { copyText } from "@/lib/utils/copy-text";

/**
 * An inline message about the thing next to it.
 *
 * ## Why this exists
 *
 * The app had six or seven of these, each written where it was needed: a coral sentence with a
 * `⚠️` in front of it under the dev-buy field, the same shape in coral under the image upload,
 * another in `ash` under the creator-fee slider, a tinted panel with its own layout in the preview
 * banner, and a bare `⏳` beside a pending transaction. They agreed on nothing — not the tint, not
 * the radius, not the type size, not whether the mark was an emoji or a glyph or absent — so the
 * product had no consistent way of saying "read this", and every new one was invented again.
 *
 * They also all leaned on emoji for severity. An emoji cannot take `currentColor`, so it does not
 * follow the theme or the tone it is sitting in, and it arrives at whatever weight and palette the
 * reader's OS chose — which on the paper canvas meant a small full-colour picture in the middle of
 * a monochrome form. Severity is exactly the thing that has to be consistent and legible, so it is
 * drawn here rather than delegated.
 *
 * ## The three tones
 *
 * `info`, `warn` and `error`, in the palette's informational blue, caution orange and loss coral —
 * the same three hues the trade widget, the delta chips and the market's status plate already use,
 * so a reader who has learned what coral means on one surface has learned it everywhere.
 *
 * ## Why it is built and not tinted
 *
 * Each was a 10% ground with a 1px rim — the one object in this app made out of colour rather than
 * out of material. On the launch rail that put a flat rectangle directly above a button with a lit
 * lip, a hairline and its own light under it, and a message drawn differently from everything
 * around it does not read as *more* important: it reads as something that has gone wrong with the
 * page.
 *
 * So it is the same four statements as every other object in the product, in the tone's own hue: a
 * face lighter at the top, a lit lip along its top edge, a hairline round it, and the hue's light
 * pooled underneath — with the severity mark pressed into a well, the way every other glyph here
 * is. See `.doku-notice` in `global.css`; the hue arrives as one custom property, so a tone is a
 * class and nothing else.
 *
 * ## `title` is optional and worth using
 *
 * With one, the notice gets a heading line in the tone's own colour and the body below it in the
 * reading face — which is what turns "a coloured sentence" into "a message with a subject". Without
 * one it is a single row, for the cases where the sentence *is* the message.
 */

export type NoticeTone = "info" | "warn" | "error";

const TONE: Record<NoticeTone, { shell: string; ink: string }> = {
  info: { shell: "doku-notice--info", ink: "text-halo-ink" },
  warn: { shell: "doku-notice--warn", ink: "text-warn-ink" },
  error: { shell: "doku-notice--error", ink: "text-loss-ink" },
};

/**
 * The severity marks.
 *
 * A circle for information, a triangle for caution, a circle-with-a-bar for a fault — the three
 * silhouettes that are distinguishable at 15px *by shape alone*, which matters because colour is
 * the one channel a colour-blind reader may not have. All three are on the product's 1.8-weight
 * icon grid and take `currentColor`.
 */
const MARKS: Record<NoticeTone, ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.4M12 7.9h.01" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.6 21 19.2H3z" />
      <path d="M12 9.6v4M12 16.6h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.6v5M12 16.1h.01" />
    </>
  ),
};

export const Notice = ({
  tone = "info",
  title,
  children,
  className,
  /** Set for messages a screen reader should be interrupted for — a failure, not a caution. */
  alert,
  detail,
}: {
  tone?: NoticeTone;
  title?: string;
  children: ReactNode;
  className?: string;
  alert?: boolean;
  /**
   * The machine's own account of what happened, behind a disclosure.
   *
   * A chain error is two audiences in one string: the person in front of it, who needs a sentence,
   * and whoever they forward it to, who needs the RPC URL and the call data. Printing the second at
   * the first is how a panel ends up carrying six hundred characters of hex under a button — see
   * `explainChainError`. Closed by default, monospaced, capped in height and scrollable, with a
   * copy key, because the only thing anybody does with this text is send it to somebody else.
   */
  detail?: string;
}) => {
  const t = TONE[tone];
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  /* The reset lives in an effect so its timer is cleared on unmount. Started inside the copy
     handler, it fired `setCopied` 1400ms later on a component that may well be gone — this notice
     is most often shown for an error the next render clears. */
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    if (!detail) return;
    copyText(detail).then(setCopied);
  };

  return (
    <div
      role={alert ? "alert" : undefined}
      className={cn(
        "doku-notice flex items-start gap-3 rounded-doku-xl px-3.5 py-3.5",
        t.shell,
        className
      )}
    >
      <span
        className={cn(
          "doku-notice-well grid h-8 w-8 shrink-0 place-items-center rounded-doku-lg",
          t.ink
        )}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {MARKS[tone]}
        </svg>
      </span>

      <div className="flex min-w-0 flex-col gap-2">
        {title && (
          <span
            className={cn(
              "font-ui font-semibold text-[12px] uppercase leading-none tracking-[0.05em]",
              t.ink
            )}
          >
            {title}
          </span>
        )}
        {/* The body is `ash` rather than the tone's own ink when it has a heading above it: the
            heading and the panel already carry the severity, and thirteen-pixel body copy in a
            signal hue is a colour doing a job twice — and it is the half a reader has to parse.
            Without a heading the text *is* the signal and keeps the tone's colour. */}
        {/* `break-words`: a message may carry an address or a URL, and an unbroken 66-character
            hex string is wider than any panel this renders in. */}
        <div
          className={cn(
            "min-w-0 break-words font-ui text-[13px] leading-[1.5]",
            title ? "text-ash" : t.ink
          )}
        >
          {children}
        </div>

        {detail && (
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="doku-token-key inline-flex h-7 shrink-0 items-center gap-1.5 rounded-doku-lg px-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.05em] text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex transition-transform duration-200",
                    open && "rotate-90"
                  )}
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 5.5 15.5 12 9 18.5" />
                  </svg>
                </span>
                Details
              </button>

              {open && (
                <button
                  type="button"
                  onClick={copy}
                  className="doku-token-key inline-flex h-7 shrink-0 items-center rounded-doku-lg px-2.5 font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.05em] text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
              )}
            </div>

            {open && (
              <pre className="doku-notice-detail max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-doku-lg px-3 py-2.5 font-numeric text-[11px] leading-[1.5] text-mute">
                {detail}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default Notice;
