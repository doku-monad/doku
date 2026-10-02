"use client";

import { cn } from "lib/utils/class-name";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * One labelled control on the launch form.
 *
 * ## What this fixes
 *
 * Every field on this page was a bare input with a placeholder. Three of them — the social links —
 * had no label at all, only an icon and a greyed example, which means the moment somebody types
 * into one the only thing identifying it disappears. A placeholder is not a label: it vanishes on
 * focus, it fails at 3:1 by design, and screen readers announce nothing.
 *
 * So every control now carries the same three parts, in the same order, at the same sizes:
 *
 *   **Label** — always visible, always associated with the control by `htmlFor`.
 *   **Required / Optional** — stated, never inferred. A form where some fields are required and
 *      none say so is a form you find out about by pressing the button.
 *   **Error / counter** — the counter sits on the label row, right-aligned, so it does not move
 *      when an error appears beneath.
 *
 * There was a fourth, a hint under each control saying what the value does. It is gone, and so is
 * the prop: the audience for this form deploys contracts, and "The headline on the coin's card"
 * under a field labelled NAME is a line of type that costs every launcher a scroll and tells them
 * nothing. What survives is everything a label cannot say on its own — the counter, the required
 * mark, the error, and the warnings that state a *consequence* rather than a description.
 *
 * `HINT_CLASS` stays, because two places still need that voice: a control explaining why it is
 * unavailable, and a link field showing what is wrong with a URL.
 *
 * The error slot reserves no height when empty, on purpose: these are inline validations that only
 * ever appear after somebody has typed something wrong, and every field reserving two blank lines
 * would double the page.
 *
 * ## The type scale
 *
 * Every size here went up one step, and the labels moved off `--mute`.
 *
 * The form was set almost entirely in 11px and 12px: labels, hints, counters, errors, and every
 * row of the summary rail. Eleven pixels is a *chrome* size — it is what a rank plate or a unit
 * suffix is set in — and a page built out of it is one where nothing is chrome because everything
 * is. On the one screen in the product where somebody is making permanent decisions about money,
 * the instructions were the smallest and lowest-contrast type on it.
 *
 * The scale below is the whole fix, and it is exported as constants rather than typed at each call
 * site so the next control added here cannot land at 11px by copying its neighbour.
 */

/** The label above a control. 12px, `--ash`, so it survives a light theme at a glance. */
export const LABEL_CLASS =
  "flex items-baseline gap-1.5 font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.07em] text-ash";

/** What the value does, under the control. 13px — a readable sentence, not a footnote. */
export const HINT_CLASS = "font-ui text-[13px] leading-snug text-mute";

/** The same line, when something is wrong with the value. */
export const ERROR_CLASS = "font-ui text-[13px] leading-snug text-loss-ink";

export const Field = ({
  id,
  label,
  required,
  optional,
  counter,
  error,
  children,
  className,
}: {
  id: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  /** e.g. `12/42`. Sits on the label row so an error below does not shift it. */
  counter?: string;
  /** Shown under the control, in the loss hue, and wired to `aria-describedby`. */
  error?: string | null;
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn("flex min-w-0 flex-col gap-2", className)}>
    <div className="flex items-baseline justify-between gap-3">
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
        {required && (
          <span className="text-doku-ink" title="Required">
            *
          </span>
        )}
        {optional && (
          <span className="font-normal normal-case tracking-normal text-mute">optional</span>
        )}
      </label>
      {counter && (
        <span className="shrink-0 font-numeric text-[12px] leading-none text-mute">{counter}</span>
      )}
    </div>

    {children}

    {error && (
      <p id={`${id}-error`} role="alert" className={ERROR_CLASS}>
        {error}
      </p>
    )}
  </div>
);

/**
 * A textarea that grows to fit what is typed in it.
 *
 * The resize grip is gone globally (see `global.css` — Chrome painted it through the field's
 * rounded corner), and this is what it was there to let you do. The field starts at its `rows`
 * height and grows to `maxPx`, after which it scrolls: unbounded growth on a form with a sticky
 * rail beside it means the rail and the field disagree about how tall the page is.
 *
 * Height is reset to `auto` before reading `scrollHeight` on purpose — `scrollHeight` never
 * reports *less* than the element's current height, so without the reset the field can only ever
 * grow, and deleting a paragraph leaves the hole it was in.
 */
export const useAutoGrow = (value: string, maxPx = 220) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.dataset.autogrow === "off") return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxPx)}px`;
    el.style.overflowY = el.scrollHeight > maxPx ? "auto" : "hidden";
  }, [value, maxPx]);

  return ref;
};

/**
 * The shared input surface. One declaration, so no two fields drift apart.
 *
 * 15px type in a 44px-tall box. It was 14px in a 41px one — under the 44px minimum every other
 * control in the product hits, on the page with the most typing in it.
 *
 * ## A recess, not a bordered box
 *
 * It was `border-line bg-well` with `focus:border-doku` — a flat hairline rectangle, which is the
 * one material this product does not otherwise use. `.doku-swap-field` is the recipe the swap
 * widget gives the field you type an amount into: a well with an inset shadow, a hairline carried
 * as a shadow rather than a border, and a lit lower lip. Its rim lights on `:focus-within` WITHOUT
 * changing size, which a border cannot do — and a 1px shift under a name you are typing is the
 * cheapest way to make a form feel loose.
 *
 * One declaration means the launch form's name, ticker, links, dev-buy amount and creator-tax
 * address are now all the same object. They were four different ones.
 */
export const FIELD_CLASS =
  "doku-swap-field w-full rounded-doku-xl border-transparent bg-transparent px-3.5 py-3 font-ui text-[15px] leading-tight text-ink placeholder:text-mute focus:outline-none";

/**
 * The same surface, in the error state.
 *
 * `focus-visible:outline` is restated here because this variant cancels the global ring the same
 * way its valid twin does — `global.css` turns the outline off for inputs in favour of
 * `border-color: var(--doku)` — but then keeps `border-loss` on focus, so there was no focus
 * signal of any kind. The field you got wrong was the one field you could not see yourself tabbing
 * into. The border stays red, because the error has not gone away; the ring says where you are.
 */
export const FIELD_CLASS_ERROR =
  "doku-swap-field doku-swap-field--error w-full rounded-doku-xl border-transparent bg-transparent px-3.5 py-3 font-ui text-[15px] leading-tight text-ink placeholder:text-mute focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku";

/**
 * A titled group of fields inside a step.
 *
 * The launch form's steps are large — Identity alone carries seven controls — and a step that is
 * one undifferentiated column of inputs is exactly the thing numbered steps were introduced to
 * avoid, reintroduced one level down.
 *
 * The title is a rule with a word on it rather than a line of small caps floating over a gap: a
 * group heading has to be findable by shape, and at 12px it is not unless something draws the eye
 * to it.
 */
export const FieldGroup = ({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) => (
  <div className={cn("flex min-w-0 flex-col gap-3.5", className)}>
    <h3 className="flex items-center gap-2.5 font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.09em] text-ash">
      <span className="shrink-0">{title}</span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
    </h3>
    {children}
  </div>
);

export default Field;
