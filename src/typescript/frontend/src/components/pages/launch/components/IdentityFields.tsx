"use client";

import { useId } from "react";

import { Field, FIELD_CLASS, FIELD_CLASS_ERROR, FieldGroup, useAutoGrow } from "./Field";
import { ImageField } from "./ImageField";

/**
 * Who the coin is.
 *
 * Name, ticker, images, a description and the socials — everything that ends up on the card, in
 * the order somebody fills it in.
 *
 * ## Why this is one column and not two
 *
 * It was a two-column grid: the basics on the left, artwork and links stacked on the right. The
 * two sides had no reason to be the same height and never were — the right column ran to five
 * controls, the left to three — so the step carried a permanent rectangle of nothing under the
 * description, and the fix that had been applied to it (stretch the textarea to eat the slack,
 * with a media-query listener in JavaScript to stop `useAutoGrow` fighting the stretch) was a
 * hundred-odd lines of machinery whose entire job was to hide a gap.
 *
 * Full-width rows have no gap to hide. Each row is a complete thought — what it is called, what it
 * looks like, what it says, where to find it — every control is as wide as it can usefully be, and
 * the two fields that genuinely pair up (name and ticker, at a 1.6:1 split) are the only place a
 * row is divided. The JavaScript that measured the viewport is gone with the layout that needed it.
 *
 * ## Every control says what it is and what it does
 *
 * This was seven bare inputs with placeholders and no labels. A placeholder disappears the moment
 * somebody types, fails contrast by design, and is announced by nothing — so a form built out of
 * them is one you have to remember rather than read. Each control now carries a visible label, a
 * required marker, a sentence saying where the value ends up, and inline validation that fires
 * when the value is wrong rather than when the button is pressed.
 *
 * ## The ticker is normalised in the field
 *
 * Upper-cased, letters and digits only, as you type. A field that accepts `doge` and shows `DOGE`
 * two screens later is a field that lied about what it was collecting — and the preview beside
 * this form is rendering the real value the whole time, so the two have to agree at every
 * keystroke.
 */
export interface Identity {
  name: string;
  ticker: string;
  logo: string;
  /** The wide image across the top of the coin's card, roughly 3:1. */
  banner: string;
  description: string;
}

export const EMPTY_IDENTITY: Identity = {
  name: "",
  ticker: "",
  logo: "",
  banner: "",
  description: "",
};

export const NAME_MAX = 42;
export const TICKER_MAX = 12;
export const DESCRIPTION_MAX = 240;

/** The height of the artwork row. Both targets share it, so the row has no short side. */
const ARTWORK_H = 116;

/** Letters and digits only, upper case, capped. What the card and the tape can actually render. */
export const normalizeTicker = (raw: string) =>
  raw
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase()
    .slice(0, TICKER_MAX);

/**
 * What is wrong with a value, if anything.
 *
 * Returned rather than thrown, and `null` for an untouched field: a form that shows "Name is
 * required" before anybody has typed is a form that opens by telling you off.
 */
export const identityErrors = (identity: Identity) => ({
  name:
    identity.name.length > 0 && identity.name.trim().length < 2
      ? "A name needs at least two characters."
      : null,
  ticker:
    identity.ticker.length > 0 && identity.ticker.length < 2
      ? "A ticker needs at least two characters."
      : null,
});

export const IdentityFields = ({
  value,
  onChange,
  links,
}: {
  value: Identity;
  onChange: (next: Identity) => void;
  /**
   * The socials block.
   *
   * Passed in rather than rendered here because the links are their own state with their own
   * validation — but they are the last row of this step, and a layout that lives half in one
   * component and half in its caller is one nobody can change safely.
   */
  links?: React.ReactNode;
}) => {
  const id = useId();
  const errors = identityErrors(value);
  const description = useAutoGrow(value.description);

  const set = <K extends keyof Identity>(key: K, v: Identity[K]) =>
    onChange({ ...value, [key]: v });

  return (
    <div className="flex flex-col gap-7">
      <FieldGroup title="The basics">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Field
            id={`${id}-name`}
            label="Name"
            required
            counter={`${value.name.length}/${NAME_MAX}`}
            error={errors.name}
          >
            <input
              id={`${id}-name`}
              value={value.name}
              onChange={(e) => set("name", e.target.value.slice(0, NAME_MAX))}
              placeholder="Mars Coin"
              autoComplete="off"
              aria-describedby={errors.name ? `${id}-name-error` : undefined}
              className={errors.name ? FIELD_CLASS_ERROR : FIELD_CLASS}
            />
          </Field>

          <Field
            id={`${id}-ticker`}
            label="Ticker"
            required
            counter={`${value.ticker.length}/${TICKER_MAX}`}
            error={errors.ticker}
          >
            <div className="relative">
              <span
                aria-hidden
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 font-numeric text-[15px] text-mute"
              >
                $
              </span>
              <input
                id={`${id}-ticker`}
                value={value.ticker}
                onChange={(e) => set("ticker", normalizeTicker(e.target.value))}
                placeholder="MARS"
                autoComplete="off"
                spellCheck={false}
                aria-describedby={errors.ticker ? `${id}-ticker-error` : undefined}
                className={`${errors.ticker ? FIELD_CLASS_ERROR : FIELD_CLASS} pl-8 font-numeric font-semibold tracking-[0.04em]`}
              />
            </div>
          </Field>
        </div>

        <Field
          id={`${id}-description`}
          label="Description"
          optional
          counter={`${value.description.length}/${DESCRIPTION_MAX}`}
        >
          <textarea
            ref={description}
            id={`${id}-description`}
            value={value.description}
            onChange={(e) => set("description", e.target.value.slice(0, DESCRIPTION_MAX))}
            placeholder="What is this coin, and why should anyone hold it?"
            rows={3}
            autoComplete="off"
            className={`${FIELD_CLASS} min-h-[92px] leading-relaxed`}
          />
        </Field>
      </FieldGroup>

      {/*
        Two images, and they do different jobs.

        The logo is the coin's mark — 44px on the card, 30px in the hero, so it has to read square
        and small. The banner is the card's headline image and the only thing on a board of coins
        legible from across the grid. Both optional: without them the board draws a monogram and a
        banner from the ticker, which works and makes every unbranded coin look like every other.

        They sit on one row at one height, so the row has no short side and therefore no dead
        rectangle under it. The banner takes whatever the square leaves, which is close enough to
        the 3:1 it is cropped to on the card that what you drop is what you see.
      */}
      <FieldGroup title="Artwork">
        <div
          className="grid items-start gap-3 sm:gap-4"
          style={{ gridTemplateColumns: `${ARTWORK_H}px minmax(0,1fr)` }}
        >
          {/* Both say `optional`, because both are: `draftProblems` asks for neither, and a label
              with no marker on a form that stars its required fields reads as required. The banner
              was the one launchers kept stopping at. */}
          <ImageField
            label="Logo"
            optional
            shape="square"
            height={ARTWORK_H}
            value={value.logo}
            onChange={(next) => set("logo", next)}
          />
          <ImageField
            label="Banner"
            optional
            shape="wide"
            height={ARTWORK_H}
            value={value.banner}
            onChange={(next) => set("banner", next)}
          />
        </div>
      </FieldGroup>

      {/* No group rule over it: the socials are their own dropdown key, and a heading reading
          "Where to find it" above a key reading "Social links" would say it twice. */}
      {links}
    </div>
  );
};

export default IdentityFields;
