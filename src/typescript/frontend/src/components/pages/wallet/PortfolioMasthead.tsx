"use client";

import { CopyAddress } from "components/pages/market/components/main-info/CopyAddress";
import { GeneratedBanner } from "components/ui/coin-card";
import { cn } from "lib/utils/class-name";
import { toExplorerLink } from "lib/utils/explorer-link";
import React, { useEffect, useRef } from "react";

/**
 * The label voice for this page.
 *
 * Geist Pixel Square at 11.5px in `--ash` — character for character the constant the token page's
 * masthead uses, because these two objects sit one click apart and a label a half-step smaller in
 * a weaker grey is exactly the kind of drift that makes a product look assembled. A pixel face is
 * a *drawn* face, its strokes are one pixel wide by construction, and at 10.5px in `--mute` these
 * were technically present and practically unreadable.
 */
export const PORTFOLIO_LABEL =
  "font-pixel text-[11.5px] uppercase leading-none tracking-[0.04em] text-ash";

/**
 * The address, as a mark.
 *
 * ## Why an account needs one at all
 *
 * Every other object in this product has a face — a coin has a logo, a quote asset has its
 * issuer's mark — and an account had a truncated hex string. A page about somebody's money should
 * be identifiably *theirs* at a glance, and the only identity an address actually carries is the
 * address itself. So it is drawn from it: a five-by-five symmetric grid, hue and cells seeded by
 * the characters, which makes the same wallet the same picture on every visit and two wallets
 * almost never the same one.
 *
 * Canvas rather than hand-written SVG paths, and deterministic rather than random — this renders
 * on the client only, so a seeded generator keeps it stable across re-renders instead of
 * reshuffling on every state change.
 */
export const AddressMark = ({ address, size = 62 }: { address: string; size?: number }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let h = 0;
    for (let i = 0; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
    const rand = () => (h = (h * 1664525 + 1013904223) >>> 0) / 4294967296;

    const hue = Math.floor(rand() * 360);
    const px = size * 2;
    canvas.width = px;
    canvas.height = px;

    ctx.fillStyle = `hsl(${hue} 42% 12%)`;
    ctx.fillRect(0, 0, px, px);

    const cells = 5;
    const s = px / cells;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < Math.ceil(cells / 2); x++) {
        const v = rand();
        if (v < 0.42) continue;
        ctx.fillStyle = v > 0.86 ? `hsl(${(hue + 48) % 360} 70% 62%)` : `hsl(${hue} 68% 58%)`;
        ctx.fillRect(x * s, y * s, s, s);
        // Mirrored, so the mark reads as a face rather than as noise.
        ctx.fillRect((cells - 1 - x) * s, y * s, s, s);
      }
    }
  }, [address, size]);

  return (
    <span
      aria-hidden
      /* The radius tracks the size, so the mount stays a rounded square rather than becoming a
         squircle at 72 and a near-rectangle at 92. Same ratio the coin masthead's mount uses. */
      className="doku-token-mount relative grid shrink-0 place-items-center rounded-[22px] p-[3px]"
    >
      <canvas ref={ref} style={{ width: size, height: size }} className="block rounded-[18px]" />
    </span>
  );
};

/** One figure in the vitals row. */
export const Vital = ({
  label,
  children,
  tone,
}: {
  label: string;
  children: React.ReactNode;
  tone?: "up" | "down";
}) => (
  <div className="doku-token-cell flex min-w-0 flex-col gap-2.5 px-4 py-3.5">
    <span className={cn(PORTFOLIO_LABEL, "truncate")}>{label}</span>
    <span
      className={cn(
        "truncate font-numeric text-[16px] font-semibold leading-none tabular-nums",
        tone === "up" ? "text-doku-ink" : tone === "down" ? "text-loss-ink" : "text-ink"
      )}
    >
      {children}
    </span>
  </div>
);

/**
 * The cover.
 *
 * An account has no artwork, so the band is the generated one, seeded from the address instead of
 * from a ticker — the same component the board card and the market page draw, so a coin without a
 * cover and a wallet without one are visibly the same surface rather than two things that happen
 * to resemble each other.
 *
 * It used to be a copy of that ground rather than a call to it, and the copy had already drifted:
 * a 22px rule grid where the card had a dot lattice, `--film-1` where the card had `--film-2`, a
 * fixed top-left light where the card picked a corner. Nobody was going to notice, which is the
 * problem with two files drawing the same object.
 *
 * The one thing this deliberately never had is the card's oversized ticker — an address tiled at
 * 44px behind the same address printed at 30px two lines below it. The card has since dropped it
 * too, for the same reason.
 */
const AddressCover = ({ address }: { address: string }) => <GeneratedBanner seed={address} />;

/** A wallet, drawn — the glyph in the isolated badge's well. */
const WalletGlyph = () => (
  <svg
    width="19"
    height="19"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.5A2.5 2.5 0 0 1 3 16.5Z" />
    <path d="M3 8.5V7a2 2 0 0 1 2-2h11" />
    <circle cx="16.5" cy="12.5" r="1.25" fill="currentColor" stroke="none" />
  </svg>
);

/**
 * The portfolio masthead.
 *
 * ## It is the token masthead, applied to an account
 *
 * The same object, built from the same parts: a **cover** that fades into the bezel, a **mark**
 * mounted in a well that overlaps its lower edge, the identity, one **isolated badge** at the
 * right, then the figures in a band, the reference numbers as ruled cells, and the addresses in a
 * foot band. An account page built out of flatter material than the coin pages it links to is how
 * a product ends up looking like two products.
 *
 * ## The cover
 *
 * An account has no artwork, so it gets the generated banner the board card draws for a coin with
 * none — seeded from the address, so the band, the mark pressed into it and the wallet's identity
 * are all the same wallet's. It is a real surface with real depth rather than a flat header, which
 * is the difference this page was missing.
 *
 * ## The two headline figures
 *
 * **Net worth** and **unrealised**: what it is worth now, and how much of that was never paid
 * for. Held-versus-liquidity, realised, the counts and the address itself are reference, and sit
 * in the bands beneath.
 */
export const PortfolioMasthead = ({
  address,
  isOwn,
  netWorth,
  unrealised,
  unrealisedPct,
  vitals,
  since,
  badge,
  loading,
}: {
  address: string;
  isOwn: boolean;
  netWorth: React.ReactNode;
  unrealised: React.ReactNode;
  /** `null` when there is no cost basis to compare against — the chip is then absent, not zero. */
  unrealisedPct: number | null;
  vitals: React.ReactNode;
  /** The oldest indexed trade. `null` for an address that has never traded here. */
  since: Date | null;
  /**
   * The one fact in the isolated badge.
   *
   * Chosen by the page rather than fixed here, because the most interesting thing about an
   * account depends on the account: a creator's launches, a trader's trade count. What it must
   * never be is a fact already printed beside it — the badge is the lit object on this masthead,
   * and spending it on a second copy of the address wastes the only emphasis the object has.
   */
  badge: { label: string; value: string };
  loading: boolean;
}) => (
  <section className="doku-token-tray relative rounded-[19px] p-[3px]">
    <span
      aria-hidden
      className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
    />

    <div className="doku-token-face relative overflow-hidden rounded-[16px]">
      {/* ---- The cover ------------------------------------------------------------------- */}
      <div className="relative h-[92px] sm:h-[104px]">
        <div className="doku-token-cover absolute inset-0">
          <AddressCover address={address} />
        </div>
        <span aria-hidden className="doku-token-cover-shade pointer-events-none absolute inset-0" />

        {isOwn && (
          <span className="doku-token-plate absolute right-4 top-4 inline-flex h-7 items-center gap-2 rounded-doku-lg border border-solid border-doku/35 bg-doku/10 px-2.5 font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-doku-ink sm:right-5 sm:top-5">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-doku" />
            Your wallet
          </span>
        )}
      </div>

      {/* ---- Who -------------------------------------------------------------------------

          The mark is 92px and hangs half out of the cover, matching the coin masthead.

          At 72px against a 92px cover the two read as a strip with a thumbnail parked on it rather
          than as one object — the complaint that this hero "feels flat" is mostly that the avatar
          was not big enough to be the anchor the composition is built around. Half-overlap is what
          makes the relationship legible: enough of the mark is over the cover that it is clearly in
          front of it, and enough is below that it belongs to the identity row.
         ------------------------------------------------------------------------------------ */}
      <div className="relative -mt-[46px] flex flex-wrap items-end gap-x-5 gap-y-4 px-4 pb-5 sm:px-5 sm:pb-6">
        <AddressMark address={address} size={92} />

        <div className="flex min-w-0 flex-1 flex-col gap-2.5 pb-0.5">
          {/*
            The identity, in the display face.

            It was JetBrains Mono at 20px — a figure's face, on the one line of this page that is
            not a figure. The token page sets a coin's name in Geist Pixel Square at 24/30px, and
            this is the same line about a different kind of object. The exact address stays in the
            mono face in the copy control below, where it is read character by character.
          */}
          <h1 className="min-w-0 truncate font-ui text-[24px] uppercase leading-none tracking-[0.02em] text-ink sm:text-[30px]">
            {`${address.slice(0, 6)}…${address.slice(-4)}`}
          </h1>
          <span className="font-numeric text-[12.5px] leading-none text-mute">
            {since
              ? `Trading here since ${since.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
              : "No trades indexed for this address"}
          </span>
        </div>

        {/*
          The isolated badge.

          The one lit object on the masthead at rest, standing alone at the right of the identity
          row — the same construction the token page's pair badge is cut from: a raised face, a
          brand hairline, a seam between the well and the type, and the brand's light pooled low
          beneath it.
        */}
        <span className="doku-token-pair hidden shrink-0 items-center gap-3 rounded-doku-xl p-1.5 pr-4 sm:flex">
          <span className="doku-token-pair-well grid h-10 w-10 shrink-0 place-items-center rounded-doku-lg text-doku-ink">
            <WalletGlyph />
          </span>
          <span className="doku-token-pair-seam flex flex-col gap-2 py-0.5 pl-3">
            <span className="font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
              {badge.label}
            </span>
            <span className="font-ui font-semibold text-[15px] uppercase leading-none tracking-[0.02em] text-ink">
              {badge.value}
            </span>
          </span>
        </span>
      </div>

      {/* ---- The two figures the page is about ------------------------------------------- */}
      <div className="doku-token-band flex flex-wrap items-stretch">
        <div className="doku-token-cell flex min-w-0 flex-1 flex-col gap-2.5 px-4 py-4 sm:px-5">
          <span className={PORTFOLIO_LABEL}>Net worth</span>
          <span className="truncate font-numeric text-[27px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink sm:text-[31px]">
            {loading ? <span className="text-mute">—</span> : netWorth}
          </span>
        </div>

        <div className="doku-token-cell flex min-w-0 flex-1 flex-col gap-2.5 px-4 py-4 sm:px-5">
          <span className={PORTFOLIO_LABEL}>Unrealised</span>
          {/* Wraps rather than truncates: at a phone width the figure and its percentage chip
              do not fit on one line, and a clipped "+11…" is the one thing a money figure must
              never be. The chip drops to a second line instead. */}
          <span className="flex flex-wrap items-baseline gap-x-2.5 gap-y-2">
            <span className="font-numeric text-[27px] font-semibold leading-none tracking-[-0.01em] tabular-nums text-ink sm:text-[31px]">
              {loading ? <span className="text-mute">—</span> : unrealised}
            </span>
            {unrealisedPct !== null && (
              <span
                className={cn(
                  "shrink-0 rounded-doku-sm border border-solid px-1.5 py-[3px] font-numeric text-[11px] font-semibold leading-none tabular-nums",
                  unrealisedPct < 0
                    ? "border-loss/30 bg-loss/10 text-loss-ink"
                    : "border-doku/30 bg-doku/10 text-doku-ink"
                )}
              >
                {`${unrealisedPct < 0 ? "−" : "+"}${Math.abs(unrealisedPct).toFixed(1)}%`}
              </span>
            )}
          </span>
        </div>
      </div>

      {/* ---- The reference figures ------------------------------------------------------- */}
      <div className="doku-token-vitals overflow-hidden">
        <div className="-ml-px -mt-px grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">{vitals}</div>
      </div>

      {/*
        ---- The address itself -------------------------------------------------------------

        A foot band, the same one the token page puts the contract and the deployer in. Both
        controls are whole-row buttons: an address is copied far more often than it is read, and a
        caption with a 20px icon beside it is how a copy control gets missed on the first press.
      */}
      <div className="doku-token-band flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
        <CopyAddress address={address} label="Copy address" />
        <a
          href={toExplorerLink({ linkType: "acc", value: address })}
          target="_blank"
          rel="noopener noreferrer"
          title={`${address} on the block explorer`}
          className="doku-token-addr group/addr flex shrink-0 items-center gap-2 rounded-doku-lg py-1.5 pl-2.5 pr-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
        >
          <span className="font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
            Explorer
          </span>
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-mute transition-colors group-hover/addr:text-ink">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </span>
        </a>
      </div>
    </div>

    <span
      aria-hidden
      className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[16px]"
    />
  </section>
);

export default PortfolioMasthead;
