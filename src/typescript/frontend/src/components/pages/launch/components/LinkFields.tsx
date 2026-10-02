"use client";

import { DISCORD_METADATA_REQUEST_CHANNEL, LINKS } from "lib/env";
import Link from "next/link";
import { useCallback, useId, useState } from "react";

import { useCopyFlag } from "@/lib/hooks/use-copy-flag";

import { ERROR_CLASS, LABEL_CLASS } from "./Field";

export type MarketLinks = { x: string; telegram: string; website: string };

export const EMPTY_LINKS: MarketLinks = { x: "", telegram: "", website: "" };

const FIELDS: {
  key: keyof MarketLinks;
  label: string;
  placeholder: string;
  icon: React.ReactNode;
}[] = [
  {
    key: "x",
    label: "X",
    placeholder: "https://x.com/…",
    icon: (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18.2 2h3.4l-7.4 8.5L23 22h-6.8l-5.3-7-6.1 7H1.4l7.9-9.1L1 2h7l4.8 6.4L18.2 2Zm-1.2 18h1.9L7.1 3.9H5.1L17 20Z" />
      </svg>
    ),
  },
  {
    key: "telegram",
    label: "Telegram",
    placeholder: "https://t.me/…",
    icon: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M21.9 4.3 18.9 19c-.2 1-.8 1.3-1.7.8l-4.6-3.4-2.2 2.1c-.2.3-.5.5-1 .5l.3-4.7 8.5-7.7c.4-.3-.1-.5-.6-.2L6.9 12.9 2.4 11.5c-1-.3-1-1 .2-1.4l17.9-6.9c.8-.3 1.5.2 1.4 1.1Z" />
      </svg>
    ),
  },
  {
    key: "website",
    label: "Website",
    placeholder: "https://…",
    icon: (
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
      </svg>
    ),
  },
];

/** Anything that isn't a well-formed http(s) URL is rejected before it can go in a request. */
const isValidUrl = (value: string) => {
  if (!value.trim()) return true;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/** A chevron on the form's 1.8-weight icon grid. Points down; the key rotates it when open. */
const ChevronDown = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

/** Two links of a chain — what the closed key is about, before its words are read. */
const LinkGlyph = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M10 13.5a4.2 4.2 0 0 0 6 .3l2.9-2.9a4.2 4.2 0 0 0-6-6L11.3 6.5" />
    <path d="M14 10.5a4.2 4.2 0 0 0-6-.3l-2.9 2.9a4.2 4.2 0 0 0 6 6l1.6-1.6" />
  </svg>
);

/**
 * Optional social links for the market being launched.
 *
 * These deliberately do *not* claim to write anything on-chain. `set_market_properties` and
 * `add_market_properties` both run `assert!(registry.admins.contains(signer), E_NOT_ADMIN)` — only
 * a metadata-registry admin can attach links to a market, never the account that launched it. A
 * form that quietly discarded what you typed would be worse than no form, so what this does instead
 * is assemble the request a moderator needs and hand it to you on one click.
 *
 * ## Closed by default
 *
 * Three URL fields were always open under the identity step, the last row before the pair — so the
 * one decision on the page that cannot be undone sat a screen further down behind three inputs
 * most launches leave empty. They are a dropdown now: one key that says what is behind it and how
 * much of it is filled in, and opens in place.
 *
 * The key is never a place to lose information. Its three plates light for each link that is
 * filled and turn coral for one that is wrong, so a launcher who closes the drawer on a typo can
 * still see it from the closed state — and a draft arriving with links already in it (a preset)
 * starts open, because hiding what somebody already typed is the opposite of optional.
 */
export const LinkFields = ({
  symbol,
  links,
  setLinks,
}: {
  symbol: string;
  links: MarketLinks;
  setLinks: (links: MarketLinks) => void;
}) => {
  const { copied, copy } = useCopyFlag(1600);
  const anyFilled = FIELDS.some(({ key }) => links[key].trim());
  const allValid = FIELDS.every(({ key }) => isValidUrl(links[key]));
  const filledCount = FIELDS.filter(({ key }) => links[key].trim()).length;
  const [open, setOpen] = useState(anyFilled);
  const bodyId = useId();

  const copyRequest = useCallback(() => {
    const lines = [
      `Coin: ${symbol ? `$${symbol}` : "(name it first)"}`,
      ...FIELDS.filter(({ key }) => links[key].trim()).map(
        ({ key, label }) => `${label}: ${links[key].trim()}`
      ),
    ];
    void copy(lines.join("\n"));
  }, [links, symbol, copy]);

  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        /* Only while the drawer exists. `aria-controls` pointing at an id that is not in the
           document is a relationship to nothing, which assistive tech reports as a broken
           reference — and this drawer is conditionally rendered. */
        aria-controls={open ? bodyId : undefined}
        data-open={open}
        className="doku-links-key group/links flex min-h-[60px] w-full items-center gap-3 rounded-doku-xl py-2.5 pl-2.5 pr-3.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
      >
        <span className="doku-well grid h-10 w-10 shrink-0 place-items-center rounded-doku-lg text-ash transition-colors group-hover/links:text-ink">
          <LinkGlyph />
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className={LABEL_CLASS}>
            Social links
            <span className="font-normal normal-case tracking-normal text-mute">optional</span>
          </span>
          <span className="truncate font-ui text-[13px] leading-none text-mute">
            {!allValid
              ? "One of these links needs fixing"
              : filledCount === 0
                ? "X, Telegram and a website"
                : `${filledCount} of ${FIELDS.length} added`}
          </span>
        </span>

        {/* One plate per destination, lit when it holds a link. The count in words above says the
            same thing; these say WHICH, at a glance, without opening anything. */}
        <span aria-hidden className="hidden shrink-0 items-center gap-1.5 min-[420px]:flex">
          {FIELDS.map(({ key, icon }) => {
            const value = links[key].trim();
            const state = !value ? "empty" : isValidUrl(value) ? "set" : "invalid";
            return (
              <span
                key={key}
                data-state={state}
                className="doku-links-plate grid h-7 w-7 place-items-center rounded-full"
              >
                {icon}
              </span>
            );
          })}
        </span>

        <span
          aria-hidden
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-mute transition-[transform,color] duration-200 group-hover/links:text-ink ${
            open ? "rotate-180" : ""
          }`}
        >
          <ChevronDown />
        </span>
      </button>

      {open && (
        <div id={bodyId} className="doku-links-drawer">
          {/*
            Three across, each labelled.

            They were three anonymous inputs distinguished only by a placeholder and a 12px icon —
            and a placeholder disappears the instant somebody types into it, so the moment you
            filled one in you could no longer tell which of the three it was. A column of them also
            cost three rows on a form whose whole problem was length.
          */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {FIELDS.map(({ key, label, placeholder, icon }) => {
              const invalid = !isValidUrl(links[key]);
              const id = `link-${key}`;
              return (
                <div key={key} className="flex flex-col gap-2">
                  {/* The label carried an emoji (`🐦`, `💬`, `🌐`) while the input beside it
                      carried the brand's own SVG — two different marks for the same destination,
                      one of them drawn by the reader's OS in full colour on a monochrome form. The
                      label now has no mark at all: the field's own icon sits ten pixels below it
                      and says the same thing once.

                      No `optional` either. The key that opens this drawer says it, once, for all
                      three — the same word under every label is a word nobody reads. */}
                  <label htmlFor={id} className={LABEL_CLASS}>
                    {label}
                  </label>

                  <span
                    /* `focus-within:ring` on BOTH branches. The invalid branch used to get
                       `border-loss` and nothing else, so a link you had typed wrongly was the one
                       row that gave no sign of being focused — the same gap `FIELD_CLASS_ERROR`
                       had. The red border stays; the ring is added beside it. */
                    className={`flex items-center gap-2.5 rounded-doku-xl border border-solid bg-well px-3.5 py-3 transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-doku ${
                      invalid ? "border-loss" : "border-line focus-within:border-doku"
                    }`}
                  >
                    <span className="shrink-0 text-mute">{icon}</span>
                    <input
                      id={id}
                      type="url"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      value={links[key]}
                      placeholder={placeholder}
                      aria-invalid={invalid}
                      aria-describedby={invalid ? `${id}-hint` : undefined}
                      onChange={(e) => setLinks({ ...links, [key]: e.target.value })}
                      className="w-full min-w-0 border-0 bg-transparent p-0 font-ui text-[15px] leading-tight text-ink outline-none placeholder:text-mute"
                    />
                  </span>

                  {/* Only when it is wrong. Each field used to carry a line saying what the link
                      was for — "The account that will post about it." under a field labelled X —
                      which is three lines of type telling a deployer what X is. */}
                  {invalid && (
                    <p id={`${id}-hint`} className={ERROR_CLASS}>
                      That is not a valid link — it needs to start with https://
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {DISCORD_METADATA_REQUEST_CHANNEL && LINKS?.discord && (
            <p className="mt-3 font-ui text-[13px] leading-snug text-mute">
              Copy your request and post it in{" "}
              <Link
                href={LINKS.discord}
                target="_blank"
                rel="noopener noreferrer"
                className="text-doku-ink underline underline-offset-2"
              >
                #{DISCORD_METADATA_REQUEST_CHANNEL}
              </Link>
              .
            </p>
          )}

          {anyFilled && (
            <button
              type="button"
              onClick={copyRequest}
              disabled={!allValid}
              className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-doku-pill border border-line bg-surface px-3.5 font-numeric text-[12px] font-semibold text-ash transition-colors hover:border-doku hover:text-doku-ink disabled:cursor-not-allowed disabled:text-mute"
            >
              {copied ? "Copied" : allValid ? "Copy link request" : "Fix the invalid URL"}
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export default LinkFields;
