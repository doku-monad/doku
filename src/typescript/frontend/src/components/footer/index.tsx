"use client";

import { BrandDisc, BrandWordmark } from "components/brand/BrandMark";
import { MONAD_URL, SOCIAL, SOCIAL_ICONS } from "components/footer/constants";
import { TelegramMark, XMark } from "components/footer/social-marks";
import { PixelArrow } from "components/svg";
import { AssetIcon } from "components/ui/asset-icon";
import { LINKS, VERSION } from "lib/env";
import FEATURE_FLAGS from "lib/feature-flags";
import Link from "next/link";
import React from "react";
import { EXTERNAL_LINKS } from "router/external-links";
import { ROUTES } from "router/routes";

import { IntentLink } from "@/components/ui/intent-link";
import { nativeQuoteAsset } from "@/lib/assets/quote-assets";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";

/**
 * The colophon.
 *
 * ## What was here before, and why it read as basic
 *
 * Three bands of bare content on the page's own ground: a lockup, two columns of links, a hairline,
 * a copyright. Every element in it was correct and the whole was furniture — because on a product
 * where *every* surface is machined out of a tray, a rim and a bezel, the footer was the one region
 * that was not made of anything. Content sitting directly on the canvas with two rules through it
 * reads as the page having run out, no matter how good the type is.
 *
 * ## What it is now
 *
 * One panel, built from the same four layers as a market card, with the content laid out as a
 * **grid of cells divided by seams** rather than as columns floating in a band. That single change
 * is most of the difference: a seam is a join between two panels, so a grid of them reads as a
 * console — an object with parts — where whitespace alone reads as a document.
 *
 * The grid is four cells at desktop and one column on a phone, and the seams follow: vertical
 * between columns where there are columns, horizontal between stacked cells where there are not.
 * The rule that draws them is in `global.css` (`.doku-footer-cell`) and it is one selector, not a
 * set of `border-l` utilities that have to be removed at the breakpoint.
 *
 *   1. **The identity cell**, at twice the width of the others: mark, wordmark, what this is in one
 *      sentence, the launch action, and the social keys. It is the widest cell because it is the
 *      only one that has to *say* anything; the other three are indexes.
 *   2. **Navigate** — the destinations the top bar carries.
 *   3. **Learn** — the ones it never will: stats, docs, terms.
 *   4. **Community** — the social destinations, as named rows. Two of them are also icon keys in
 *      the identity cell, and that is deliberate rather than sloppy: an icon is for somebody who
 *      already knows the mark, a labelled row is for somebody who does not, and the two readers do
 *      not overlap.
 *
 * Under them, inside the same panel, a base rail: copyright, the build, and what this runs on.
 *
 * ## Why the panel and not just a background
 *
 * Because the footer is the last thing on every route and it is where a product either looks
 * finished or looks like it stopped. The tray, rim, bezel and lit top edge cost four spans and they
 * make the block an *object* on the page — which is the same argument the page frame, the runner
 * board and the card all make. Consistency here is not tidiness; it is the reason the product looks
 * like one thing.
 */

/**
 * A destination in one of the three directory columns.
 *
 * `soon` is a destination that EXISTS as an idea and not yet as a page. It renders as a row with a
 * badge rather than as a link, for the same reason the `More` menu does it — see `MORE_LINKS`. A
 * footer is where somebody goes when the nav did not have what they wanted, so a row that silently
 * disappears sends them looking; a row that says "Soon" answers them.
 */
type FooterLink = {
  label: string;
  href: string;
  external?: boolean;
  soon?: boolean;
  /** A social mark, shown in place of the hover tick. See `LinkColumn`. */
  icon?: React.ComponentType<{
    width?: string | number;
    height?: string | number;
    className?: string;
  }>;
};

/*
 * `/pools` is behind `FEATURE_FLAGS.Liquidity` and answers 404 when it is off (see
 * `middleware.ts`). A link that is always rendered is a link to a 404 on every default build.
 */
const NAVIGATE: FooterLink[] = [
  { label: "Explore", href: ROUTES.explore },
  { label: "Assets", href: ROUTES.assets },
  ...(FEATURE_FLAGS.Liquidity ? [{ label: "Pools", href: ROUTES.pools }] : []),
  { label: "Launch", href: ROUTES.launch },
];

/**
 * The reference shelf, and two thirds of it is not open yet.
 *
 * Both rows were plain links and both went somewhere wrong. **Stats** is behind
 * `FEATURE_FLAGS.Stats`; with the flag off the route answers a coming-soon screen, so the footer
 * was advertising a page that exists only to apologise — and the `More` menu one bar up was already
 * marking the very same destination `Soon`. Two surfaces describing one route two different ways.
 *
 * **Docs** is worse: `EXTERNAL_LINKS.docs` is `https://docs.DOKU/category/--start-here`, a
 * placeholder with no registrable domain in it. Every click opened a new tab and failed to resolve.
 *
 * So both carry the badge the menu already uses, and neither is a link while it is unavailable. The
 * only surviving link here is the one that resolves.
 *
 * `Terms of use` is gone from this column. It pointed at `/not-found` unless a deployment set
 * `NEXT_PUBLIC_LINKS.tos`, and wearing a `Soon` badge it advertised a legal document as a feature
 * in development — which a legal document is not. It is either published or it is not mentioned.
 *
 * Note this is the footer only. `components/geoblocking` still names the terms in the sentence a
 * visitor reads before agreeing to anything, which is where that reference belongs; and `LINKS.tos`
 * is untouched, so a deployment that configures one can have the row back in a single line.
 */
const LEARN: FooterLink[] = [
  { label: "Stats", href: ROUTES.stats, soon: !FEATURE_FLAGS.Stats },
  { label: "Docs", href: EXTERNAL_LINKS.docs, external: true, soon: true },
];

/**
 * The social destinations, named.
 *
 * Filtered on whether the deployment actually configured them: `LINKS` is optional, and a column
 * whose rows all point at `/not-found` is worse than a column with one row in it. The icon keys in
 * the identity cell come from `SOCIAL_ICONS`, which has its own fallback for the same reason.
 */
const COMMUNITY: FooterLink[] = (
  [
    ["X", SOCIAL.x, XMark],
    ["Telegram", SOCIAL.telegram, TelegramMark],
    ["Discord", LINKS?.discord, undefined],
    ["GitHub", LINKS?.github, undefined],
  ] as const
)
  .filter(([, href]) => Boolean(href))
  .map(([label, href, icon]) => ({
    label,
    href: href as string,
    external: true,
    ...(icon ? { icon } : {}),
  }));

/**
 * One cell of the grid.
 *
 * The seams are drawn by `.doku-footer-cell` rather than by border utilities, because they change
 * axis at the breakpoint — horizontal while the cells are stacked, vertical once they are columns —
 * and a pair of `border-t md:border-t-0 md:border-l` classes on four elements is four places for
 * that to go wrong.
 */
const Cell = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <div
    /*
      `px-2.5` below `sm`, not `px-4`.

      Three columns on a 375px phone leave ~114px each, and 32px of horizontal padding took a
      quarter of that before a word was set — enough that `Terms of use` and `Docs` + its `Soon`
      pill reached the cell edge and were clipped by the footer face's own `overflow-hidden`.
      Twelve pixels back per column is the difference between fitting and eliding, and the seams
      between cells are what separate them visually rather than the gutter.
    */
    className={`doku-footer-cell flex min-w-0 flex-col px-2.5 py-5 sm:px-6 sm:py-6 ${className ?? ""}`}
  >
    {children}
  </div>
);

const ColumnTitle = ({ children }: { children: React.ReactNode }) => (
  <span className="font-numeric text-[11px] uppercase leading-none tracking-[0.16em] text-mute">
    {children}
  </span>
);

/**
 * One directory column.
 *
 * Hover is a colour step and a 12px hairline that grows in from the left — enough that the row
 * answers, not enough to move the text, because a footer with a dozen links that each translate on
 * hover shimmers when the pointer crosses it on the way to the scrollbar.
 */
const LinkColumn = ({ title, links }: { title: string; links: FooterLink[] }) => (
  <>
    <ColumnTitle>{title}</ColumnTitle>
    {/* `list-none` explicitly: the global stylesheet does not reset lists, so these came out with
        the browser's default bullets and read as an unstyled document rather than a nav column.

        The gap is tighter on a phone than on a desktop (10px against 10px at `sm`, from 10px flat)
        and the type a half-step smaller, because at 390px these three columns sit side by side
        rather than stacked — see the grid note in `Footer`. */}
    {/*
      Row pitch, not row gap.

      These were bare inline links about 17px tall with 8px between them — three columns of
      finger-sized ambiguity on a phone. `py-1.5` on each link takes the target to ~34px, and the
      gap comes down by the same amount so the column is no taller than it was. `-mx-1 px-1`
      widens the target to the cell's own edge without moving the text.
    */}
    <ul className="mt-3 flex list-none flex-col gap-0.5 sm:mt-4 sm:gap-1">
      {links.map((link) =>
        link.soon ? (
          /*
            Not a link, because it does not go anywhere.

            The same rule the `More` menu applies to the same two destinations: a row for a page that
            does not exist is a row that must not be clickable, or the only way to discover it is
            unfinished is to be sent somewhere broken. `aria-disabled` and no `href` at all, so the
            keyboard skips it rather than landing on a control that does nothing.

            The badge is deliberately the plainest object in the footer — a hairline pill in the
            film, at the row's own size. It has to be legible enough to answer the question and quiet
            enough not to become the thing the eye lands on in a column of three.
          */
          <li key={link.label}>
            <span
              aria-disabled
              className="-mx-1 inline-flex cursor-default items-center gap-1.5 px-1 py-1.5 font-ui text-[13px] text-mute sm:gap-2 sm:text-[14px]"
            >
              {link.label}
              {/* 11px, which is the readability floor `tests/unit/ui-readability.test.ts` enforces
                  and the size the `More` menu's own `Soon` pill is set at. Two badges saying one
                  thing in one product should be one size. */}
              <span className="shrink-0 rounded-doku-pill border border-solid border-line bg-[var(--film-2)] px-1.5 py-0.5 font-numeric text-[11px] uppercase leading-none tracking-[0.06em] text-mute">
                Soon
              </span>
            </span>
          </li>
        ) : (
          <li key={link.label}>
            <Link
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
              className="doku-footer-link group/link -mx-1 inline-flex items-center px-1 py-1.5 font-ui text-[13px] text-mute transition-colors duration-200 ease-out hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku sm:text-[14px]"
            >
              {/* The mark replaces the hover tick rather than joining it: a row cannot carry two
                  leading affordances without the label moving when one of them appears. Sized to
                  the row's own type and inheriting its colour, so it steps from mute to ink on
                  hover with the words rather than a beat behind them. */}
              {link.icon ? (
                <link.icon width={13} height={13} className="mr-2 shrink-0" />
              ) : (
                <span aria-hidden className="doku-footer-tick" />
              )}
              {link.label}
            </Link>
          </li>
        )
      )}
    </ul>
  </>
);

/**
 * What this runs on, with the chain's own mark.
 *
 * Its own component because it is the one part of the footer that reads data. The quote registry
 * is fetched from the chain now rather than imported from a constant, so resolving the native
 * asset needs a hook — and a hook cannot live in an expression-bodied `Footer`. Extracting it
 * keeps the rest of this file a pure tree.
 *
 * The mark is conditional and the sentence is not: "Running on Monad" is true whether or not a
 * third-party favicon came back, and a footer is not a place to hold a sentence hostage to one.
 */
const ChainBadge = () => {
  const { assets } = useQuoteAssets();
  const native = nativeQuoteAsset(assets);

  return (
    /*
      A key, not a caption.

      It was a `<span>` — a chain mark and a sentence naming the network this runs on, styled like a
      control and going nowhere. Monad is the one proper noun in the footer a visitor might not
      know, and the footer is exactly where somebody who has read the whole page goes looking. So it
      opens the chain's own site.

      `.doku-footer-key` rather than `.doku-footer-tab`: the tab material is the flat one this
      product uses for a passive chip, and a thing that navigates has to answer the pointer. Hover
      and focus-visible come with it; the label steps mute -> ink with the mark beside it, because
      both inherit `currentColor`.
    */
    <a
      href={MONAD_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Monad — the chain DOKU runs on"
      className="doku-footer-key group/chain flex w-fit items-center gap-2 rounded-[8px] py-1.5 pl-1.5 pr-2.5 text-mute transition-colors duration-200 ease-out hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
    >
      {native && <AssetIcon asset={native} size={15} className="rounded-[4px] border-0" />}
      <span className="font-numeric text-[11px] uppercase leading-none tracking-[0.1em]">
        Running on Monad
      </span>
      {/* The one cue that this leaves the site, at the weight of the label it follows. */}
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="shrink-0 opacity-70 transition-transform duration-200 ease-out group-hover/chain:translate-x-[1px] group-hover/chain:-translate-y-[1px] motion-reduce:transition-none"
      >
        <path d="M7 17 17 7M9 7h8v8" />
      </svg>
    </a>
  );
};

const Footer: React.FC = () => (
  /*
   * The footer sits on the *panel* rail, not the content rail.
   *
   * It renders inside `ContentWrapper`, whose padding is what the page's panels cancel with a
   * negative margin (see `PageFrame`) — so a footer that simply filled its container came out 48px
   * narrower than the board above it and 24px inside its edges on both sides. The same negative
   * margins put it on the same box as those panels and as the top bar, and the three surfaces of
   * the page finally share one set of edges. No padding is given back: unlike a page frame, this
   * panel *is* the content.
   */
  /*
   * Inset on a phone, and inset by the *panel's* gutter rather than by the content's.
   *
   * There were two wrong answers here before this one. `-mx-6` at every width put the rim hard
   * against both screen edges at 390px, so the one surface at the end of every route had no air
   * around it. Dropping the negative margin entirely below `sm` fixed that and overshot: the
   * footer's rim landed at x=13 while the hero and board frames above it — `-mx-2` against the
   * wrapper's `px-4`, with a rim floating 5px proud — put theirs at x=3. Ten pixels, on the two
   * objects a phone shows one directly above the other.
   *
   * `-mx-[10px]` is the arithmetic that agrees with them: 16 of wrapper padding, less 10 of margin,
   * less the shell's own 3px rim, is 3. The page's panels and its colophon now share one pair of
   * vertical edges at every width — 3 and W-3 on a phone, the 1240 rail from `sm` up.
   *
   * `pb-0`: the tail spacing below the footer is `.doku-bottomnav-gap` on the wrapper, which already
   * reserves the dock, its margin and the device inset. The `pb-10` that used to be here stacked on
   * top of that and left ~90px of dead canvas under the last panel on every route.
   */
  /*
    `-mx-[21px]`, not `-mx-6`, and the missing 3px are the whole point.

    `ContentWrapper` is `max-w-[1240px] px-6` and clips horizontally (it has to — see the
    `overflow-x: clip` note there, which is what keeps `position: sticky` working anywhere in the
    app). `-mx-6` cancelled that padding exactly, so the footer sat on the full 1240 panel rail —
    and its rim, `-inset-[3px]`, was then drawn 3px OUTSIDE a box that clips at 1240. The result
    was a footer with a top and a bottom border and no sides, at every viewport width.

    Pulling the margin in by the rim's own 3px puts the rim exactly on the 1240 edge instead of
    3px past it. The face gives up 6px of width and gains two borders, which is the right trade:
    the rim is the footer's outer edge, so it is the thing that has to land on the rail.
  */
  <footer className="-mx-[10px] pb-0 pt-10 sm:-mx-[21px] sm:pt-12">
    {/* 1. The tray the whole panel is pressed into. */}
    <div className="doku-footer-shell relative rounded-[19px] p-[3px]">
      {/* 2. The rim, floating proud of the tray — the same edge the cards and the board carry. */}
      <span
        aria-hidden
        className="doku-footer-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
      />

      {/* 3. The bezel, with the dot lattice the hero's ground uses. Same texture, one product. */}
      <div className="doku-footer-face relative overflow-hidden rounded-[16px]">
        <div className="doku-hero-ground pointer-events-none absolute inset-0" aria-hidden />

        {/*
          Three columns on a phone, four cells on a desktop.

          Stacked, this footer was 938px tall on a 390px screen — taller than the viewport, for
          eleven links and a sentence. The three directories are *indexes*: three, three and one
          rows of one or two words each. Giving each of them the full width of the phone and 48px of
          vertical padding is what made the block enormous, and length is what made it read as
          filler; nothing about the content needs it.

          Side by side they occupy one band roughly the height of a single stacked cell, the seams
          become vertical (which is what `.doku-footer-cell` already does above `md` — the rule is
          restated at `sm` in `global.css` so the axis follows the layout rather than the
          breakpoint), and the whole footer lands near 420px. The identity cell keeps the full width
          above them, because it is the one cell with a sentence in it.
        */}
        <div className="relative grid grid-cols-3 md:grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,0.75fr))]">
          {/* ---- The identity cell ------------------------------------------------------- */}
          <Cell className="col-span-3 md:col-span-1">
            <Link
              href={ROUTES.explore}
              className="flex w-fit items-center gap-2.5"
              aria-label="DOKU home"
            >
              <BrandDisc size={28} />
              <BrandWordmark className="text-[16px]" />
            </Link>

            {/* The footer's own line, and deliberately not the hero's.
                It used to restate the hero and the meta description verbatim — a paragraph
                explaining the mechanism to somebody who has just scrolled past the whole product.
                By the time a visitor reaches the footer they know what this is; what they have not
                done is act. So this is a prompt, not a description, and it sits directly above the
                launch key it is asking about. */}
            <p className="mt-3 max-w-[34ch] font-ui text-[15px] leading-relaxed text-ash sm:mt-4 sm:text-[16px]">
              The market&rsquo;s open. Where&rsquo;s your token?
            </p>

            {/*
              The one action in the footer, and it is now built like one.

              It was `.doku-ghost` at `text-mute`: an 11.5px mute label in a hairline box, which on
              the paper canvas is the exact recipe this product uses for a DISABLED control — the
              held launch key three panels up wears the same grey. So the last thing on every route,
              on a launchpad, was a primary action dressed as something you cannot press. Measured
              against the panel behind it, the label came out under 3:1.

              The argument for the ghost was that this restates a control the top bar already
              carries and should not compete with it. That reasoning has a hole in it: by the time
              somebody is reading the footer the top bar is a thousand pixels above them and out of
              the viewport, so there is nothing left to compete with. The footer is where a visitor
              who read the whole page arrives having decided, and the control they arrive at should
              be the one the product is for.

              So it is the brand key — the same material as `+ Create` in the dock and `Launch coin`
              on the bench: a filled `doku` pill, white label, the lit top lip and the hue's own
              light pooled under it, rising 1px under the pointer. One action, one appearance,
              wherever in the product you meet it.

              44px rather than 38: it is a touch target on the surface where the footer is longest,
              and it now has a label at a size somebody can read across a room.
            */}
            <IntentLink
              href={ROUTES.launch}
              className="doku-create group relative mt-4 inline-flex h-12 w-fit items-center justify-center gap-2.5 overflow-hidden rounded-[14px] px-5 font-ui text-[15px] font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku sm:mt-5"
            >
              <span aria-hidden className="doku-create-sheen" />
              Launch a coin
              <PixelArrow
                aria-hidden
                className="shrink-0 transition-transform duration-200 ease-out group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
              />
            </IntentLink>

            <div className="mt-4 flex items-center gap-2 sm:mt-6">
              {/*
                Keyed by index, not by `href`.

                `SOCIAL_ICONS` falls back to `ROUTES["not-found"]` for any link the deployment has
                not configured, so with `NEXT_PUBLIC_LINKS` unset every entry shares the same href
                and React saw two children with one key.
              */}
              {SOCIAL_ICONS.map(({ icon: Icon, href, label }, i) => (
                <a
                  key={i}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  /* An icon link has no text to name it, so it announced as its own URL. */
                  aria-label={label}
                  className="doku-footer-key grid h-9 w-9 place-items-center rounded-[10px] text-mute transition-colors duration-200 ease-out hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                >
                  <Icon width="15px" height="15px" />
                </a>
              ))}
            </div>
          </Cell>

          {/* ---- The three directories ---------------------------------------------------- */}
          <Cell>
            <LinkColumn title="Navigate" links={NAVIGATE} />
          </Cell>
          <Cell>
            <LinkColumn title="Learn" links={LEARN} />
          </Cell>
          <Cell>
            {COMMUNITY.length ? (
              <LinkColumn title="Community" links={COMMUNITY} />
            ) : (
              <>
                <ColumnTitle>Community</ColumnTitle>
                {/* Said plainly rather than left as an empty column or filled with dead rows. A
                    deployment with no `NEXT_PUBLIC_LINKS` is a real state — every local one — and
                    the honest version of it is a sentence. */}
                <p className="mt-4 font-ui text-[13.5px] leading-relaxed text-mute">
                  Channels are announced on the board as they open.
                </p>
              </>
            )}
          </Cell>
        </div>

        {/* ---- The base rail, inside the panel ------------------------------------------- */}
        {/*
          One row on a phone, not two.

          `flex-col-reverse` stacked the chain badge above the copyright and gave the rail two lines
          for two short strings that fit on one at 390px. Justified apart they read as what they are
          — the legal line at the start, what the product runs on at the end — and the rail costs
          one line instead of two. `flex-wrap` is the safety net for a long build string rather than
          a second permanent row.
        */}
        <div className="doku-footer-base relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3 font-numeric text-[11px] leading-none text-mute">
            <span>© {new Date().getFullYear()} DOKU</span>
            <span aria-hidden className="opacity-40">
              ·
            </span>
            {/* The build, as a machined tab — the same treatment as the bar's ⌘K key. Read from
                `package.json` through `VERSION` rather than typed here: this was `v1.8.2` as a
                literal, which is a number that is right on the day it is written and silently wrong
                on every deploy after it.

                `VERSION` is the raw string now — it used to be a parsed `SemVer`, and semver was
                carried into every route's bundle to produce it. The guard therefore only suppresses
                an EMPTY version rather than an unparseable one, which is the right trade: a
                malformed version in `package.json` is a build-time mistake to see, not one to hide
                from the only surface that reports it. */}
            {VERSION && (
              <span className="doku-footer-tab rounded-[5px] px-1.5 py-1 leading-none">
                v{VERSION}
              </span>
            )}
          </div>

          {/* The last line of a footer, and the one fact a visitor who read nothing else should
              leave with — resolved from the quote-asset registry rather than written out, so it
              cannot drift from what the pair picker, the cards and `/assets` say. */}
          <ChainBadge />
        </div>
      </div>
    </div>
  </footer>
);

export default Footer;
