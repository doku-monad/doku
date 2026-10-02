"use client";

import { useId } from "react";
import { createPortal } from "react-dom";
import { formatUnits } from "viem";

import { AssetIcon } from "@/components/ui/asset-icon";
import { Notice } from "@/components/ui/notice";
import { displaySymbolText } from "@/lib/assets/display-symbol";
import { isNativeQuoteAsset, type QuoteAsset } from "@/lib/assets/quote-assets";
import { useAnchoredMenu } from "@/lib/hooks/use-anchored-menu";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";
import type { DevBuyPlan, LaunchPayWith } from "@/lib/launch/pay-with";
import {
  monShareOfBalance,
  monTopUpForDevBuy,
  quoteShareOfBalance,
  spendableMon,
  trimAmount,
} from "@/lib/launch/pay-with";

import { HINT_CLASS, LABEL_CLASS } from "./Field";

/**
 * Which asset funds the buy — chosen ON the amount, not above it.
 *
 * This was a pair of full-width keys sitting over the field, which is the shape the swap widget
 * uses because there the choice changes what the whole panel means. Here it changes one thing: the
 * unit of the number beside it. A control that governs a field belongs on that field, where every
 * other exchange puts it, and moving it there also gives the step back a row of height.
 *
 * A dropdown rather than a toggle because the list is not fixed at two for ever — the funding
 * options come from `launchPayWithOptions`, which answers from the measured route table, and a
 * two-key segmented control is a shape that cannot grow.
 *
 * With one option it is not a control at all: it renders as a plain plate, no chevron, nothing to
 * press. A MON pair has nothing to swap into, and a badge that opens a menu of one is a promise of
 * a choice that does not exist.
 */
/**
 * The badge's face, shared by the trigger and by every row in the menu so the thing you press and
 * the thing you pick are visibly the same object.
 *
 * At module scope, not inside `FundingPicker`. Declared in the body it was a NEW component type on
 * every render, so React could not reconcile the old tree against the new one: it unmounted the
 * badge and every menu row and mounted fresh ones whenever the picker re-rendered, discarding
 * their DOM state. What it used to close over — the asset, its label and its name — arrives as
 * props.
 */
const Face = ({
  asset,
  label,
  name,
  size = 28,
  inMenu = false,
}: {
  asset?: QuoteAsset | null;
  label: string;
  name: string | null;
  size?: number;
  inMenu?: boolean;
}) => (
  <>
    {asset && (
      <span className="doku-swap-plate-well relative grid shrink-0 place-items-center rounded-doku-lg p-[3px]">
        <AssetIcon asset={asset} size={size} className="rounded-[8px]" />
      </span>
    )}
    <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
      <span className="w-full truncate text-left font-numeric text-[14px] font-semibold uppercase leading-none tracking-[0.02em] text-ink">
        {label}
      </span>
      {name && (
        /* Hidden on a phone. The badge and the figure share one row, and at 390px holding the
           name costs the amount about 30px — roughly a digit and a half of a 26px figure. The
           ticker and the mark identify the asset; the name is the part that can wait for room,
           and it is still there in the menu, where the rows have a line to themselves. */
        <span
          className={`w-full truncate text-left font-ui text-[11px] leading-none text-mute ${inMenu ? "" : "hidden sm:block"}`}
        >
          {name}
        </span>
      )}
    </span>
  </>
);

function FundingPicker({
  options,
  value,
  onChange,
  quote,
  nativeAsset,
  unavailable,
}: {
  options: readonly LaunchPayWith[];
  value: LaunchPayWith;
  onChange: (next: LaunchPayWith) => void;
  quote: QuoteAsset;
  nativeAsset: QuoteAsset | null;
  /** Options the bench is holding back, each with the reason. Empty today — see `LaunchBench`. */
  unavailable?: Partial<Record<LaunchPayWith, string>>;
}) {
  const MENU_W = 212;
  /* Portalled and viewport-placed — see `useAnchoredMenu` for why an `absolute` menu inside a card
     cannot work here. Height is row count times the row's 44px, plus the panel's own 6px padding. */
  const { open, setOpen, triggerRef, menuRef, pos, menuStyle } = useAnchoredMenu<HTMLDivElement>({
    width: MENU_W,
    height: options.length * 44 + 12,
  });

  const assetFor = (k: LaunchPayWith) => (k === "native" ? nativeAsset : quote);
  const labelFor = (k: LaunchPayWith) => (k === "native" ? "MON" : displaySymbolText(quote));
  const nameFor = (k: LaunchPayWith) => {
    const a = assetFor(k);
    if (!a) return null;
    return a.name.trim().replace(/\s+/g, "").toUpperCase() !== labelFor(k).toUpperCase()
      ? a.name
      : null;
  };

  const multiple = options.length > 1;

  if (!multiple) {
    return (
      <div className="doku-swap-plate flex w-[124px] shrink-0 items-center gap-2.5 rounded-doku-xl py-1.5 pl-1.5 pr-3 sm:w-[152px]">
        <Face asset={assetFor(value)} label={labelFor(value)} name={nameFor(value)} />
      </div>
    );
  }

  return (
    <div ref={triggerRef} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Fund the buy with ${labelFor(value)}. Change`}
        onClick={() => setOpen((v) => !v)}
        className="doku-swap-plate flex w-[124px] items-center gap-2.5 rounded-doku-xl py-1.5 pl-1.5 pr-2 sm:w-[152px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
      >
        <Face asset={assetFor(value)} label={labelFor(value)} name={nameFor(value)} />
        {/* The one cue that this opens. It rotates rather than swapping glyphs, so the badge does
            not reflow by a pixel when the menu appears. */}
        <span
          aria-hidden
          className={`doku-swap-plate-cue grid h-6 w-5 shrink-0 place-items-center rounded-[7px] text-mute transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        >
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          /* Right-aligned on the badge, because the field's right edge is what this is anchored to
             and a menu spilling left would cross the figure being typed. */
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Fund the buy with"
            style={menuStyle}
            className="doku-popover z-[200] rounded-[16px] p-1.5 overscroll-contain"
          >
            {options.map((k) => {
              const on = k === value;
              const held = unavailable?.[k];
              return (
                <button
                  key={k}
                  type="button"
                  role="option"
                  aria-selected={on}
                  aria-disabled={Boolean(held)}
                  title={held}
                  data-selected={on}
                  onClick={() => {
                    if (held) return;
                    onChange(k);
                    setOpen(false);
                  }}
                  className={`doku-fund-option flex w-full items-center gap-2.5 rounded-doku-lg py-1.5 pl-1.5 pr-2 text-left ${
                    held ? "cursor-not-allowed opacity-55" : ""
                  }`}
                >
                  <Face
                    asset={assetFor(k)}
                    label={labelFor(k)}
                    name={nameFor(k)}
                    size={26}
                    inMenu
                  />
                  {on && (
                    <span
                      aria-hidden
                      className="grid h-[15px] w-[15px] shrink-0 place-items-center rounded-full bg-doku text-[var(--mat-cta-ink)]"
                    >
                      <svg
                        width="9"
                        height="9"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12.5 10 17.5 19 7" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

/**
 * The creator's own buy, executed inside the launch transaction.
 *
 * ## Why it is on the form rather than left to the launcher afterwards
 *
 * Because "afterwards" is a block later, and a block is long enough for a bot watching the mempool
 * to buy first. A dev buy in the launch transaction is the only version of this that cannot be
 * front-run, and a launchpad that leaves it out is one where every creator either gets sniped or
 * writes their own script.
 *
 * ## Why it is gated on the pair
 *
 * The buy spends the quote asset, so its unit is not known until the pair is. A field reading
 * "Amount" with no unit is a field people type the wrong number into.
 *
 * ## Why the presets are percentages
 *
 * Because nobody decides a dev buy in absolute units. The question a launcher is actually asking
 * is "how much of what I have am I willing to put into this", and the four fixed amounts this had
 * before — 0.5, 1, 5, 10 — answered it only for whoever happened to hold about ten of the quote
 * asset. For a wallet holding 4,000 they were all the same button: nothing.
 *
 * So the row is eight percentages of the balance, and the field underneath states the amount they
 * work out to. The percentage is the decision; the number is the consequence, and both are on
 * screen at once.
 *
 * They are a percentage of **the launcher's balance**, not of supply, and the label says so. A
 * "% of supply" control would have to price the buy against a bonding curve this app does not have
 * a model of — see `lib/launch/submit.ts`, where the factory itself does not exist yet — so it
 * could only ever show an invented number on the one screen where somebody is deciding whether to
 * spend money.
 */

/**
 * The presets, and what is missing from both ends of them.
 *
 * They were `1, 2, 3, 5, 10, 20, 30, 50` — four steps inside the first five percent and then
 * nothing at all above half. Nobody has ever needed a button for the difference between two and
 * three percent of their balance; the launcher who does can type it. What was genuinely unreachable
 * was the top: a creator taking a real position in their own coin wants three quarters or the lot,
 * and had to work the number out by hand on the one screen where they are deciding how much money
 * to spend.
 *
 * So `2` and `3` come out and `75`, `80`, `90` and `100` go in — ten keys, five across and two
 * deep, and the row divides exactly.
 *
 * `100` is a share of what is SPENDABLE, not of the wallet. `monShareOfBalance` takes Monad's 10
 * MON reserve and a launch's worth of headroom off the top first, so the key that says "all of it"
 * still leaves a launch that can be signed.
 */
const PERCENTS = [1, 5, 10, 20, 30, 50, 75, 80, 90, 100] as const;

/** How close a typed amount has to land to a preset before that preset lights up. */
const PRESET_EPSILON = 0.05;

/**
 * A quote-asset amount, as short as it can be without lying.
 *
 * Up to six significant-ish decimals for dust, two for anything human-sized, and no trailing
 * zeros — `0.5`, not `0.500000`. The value goes straight into the text field, so it has to be a
 * string somebody could plausibly have typed.
 */
/**
 * What a person may type into an amount field.
 *
 * Digits and at most one point. It was `replace(/[^0-9.]/g, "")`, which accepts `1.2.3` and `....`
 * — both of which `Number()` reads as `NaN`, so the field looked filled, the share readout vanished
 * and the launch button reported the draft incomplete with no indication of which field was at
 * fault. Sixteen characters is well past any amount anybody types and short of the length at which
 * the field starts scrolling.
 */
const sanitiseAmount = (raw: string) => {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [head, ...rest] = cleaned.split(".");
  const joined = rest.length > 0 ? `${head}.${rest.join("")}` : head;
  return joined.slice(0, 16);
};

const formatAmount = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "";
  const decimals = n >= 1000 ? 2 : n >= 1 ? 4 : 6;
  return n.toFixed(decimals).replace(/\.?0+$/, "");
};

export const DevBuy = ({
  value,
  onChange,
  quote,
  quoteBalance,
  quoteBalancePending,
  payWith,
  payWithOptions,
  onPayWith,
  payUnavailable,
  monBalance,
  walletConnected,
  plan,
  launchFee,
  oneSignature = false,
}: {
  value: string;
  onChange: (next: string) => void;
  quote: QuoteAsset;
  /**
   * Raw units of the pair's own asset that the launcher holds.
   *
   * Read, at last. This was `number | undefined` and was `undefined` for every pair that was not
   * MON, because the app made no ERC-20 balance call at all — which is what closed the percentage
   * keys, emptied the ceiling and let somebody type a dev buy larger than their wallet. Raw rather
   * than whole units because the decimals are the asset's: six for USDC, eight for cbBTC, and a
   * float that has been through 1e18 and back is not an amount of somebody's money.
   *
   * Still `undefined` for the two honest reasons — no wallet, or a read in flight — which
   * `quoteBalancePending` tells apart.
   */
  quoteBalance?: bigint;
  /** Whether that read is still on its way, so the row can say "reading" rather than "none". */
  quoteBalancePending?: boolean;
  /** Which asset the buy is funded with. `quote` is the pair's own and is the default. */
  payWith: LaunchPayWith;
  payWithOptions: readonly LaunchPayWith[];
  onPayWith: (next: LaunchPayWith) => void;
  /** Funding options that exist but are not enabled yet. Rendered by `FundingPicker` as a
   *  disabled row carrying its reason, rather than being dropped from the menu. */
  payUnavailable?: Partial<Record<LaunchPayWith, string>>;
  /** Native balance in wei, for the percentage presets when the funding is MON. */
  monBalance?: bigint;
  /**
   * Whether a wallet is actually connected.
   *
   * Not derivable from a balance being `undefined`, and that was the bug. It is undefined for two
   * unrelated reasons — no wallet, and a read still in flight — and the step collapsed them into
   * one message. With a wallet connected and a USDC pair chosen, the dev-buy step said "Connect a
   * wallet to fund a dev buy" underneath the connected wallet's own address. Telling somebody to do
   * a thing they have already done is worse than saying nothing.
   */
  walletConnected?: boolean;
  /** What the swap is expected to deliver, while it is being priced. */
  plan: DevBuyPlan;
  /**
   * The chain's own launch fee, which comes out of the same MON balance this buy does.
   *
   * `undefined` while the read is in flight. It is the third subtraction the ceiling below needs
   * and the one that was missing — see `spendableMon`.
   */
  launchFee?: bigint;
  /**
   * Whether the launcher's wallet takes the swap, the approval and the launch as ONE prompt.
   *
   * A fact about the WALLET — EIP-5792 — and not about the draft, which is why it arrives as a prop
   * from the bench rather than being read here: the launch button reads the same answer from the
   * same hook, and copy that promised one signature over a button that asks for three would be the
   * worst version of this control.
   *
   * It decides more than the copy. A batched swap is not a transaction of its own, so its gas is
   * not held back from the ceiling either — the same condition the bench gives `launchAffordability`
   * as `swapFirst`, so what this step offers and what the button accepts cannot come apart.
   *
   * `false` by default, which is the sentence that has always been true: funding a dev buy in MON
   * costs an extra signature. A wallet is assumed not to batch until it says it does.
   */
  oneSignature?: boolean;
}) => {
  const id = useId();
  const amount = Number(value);
  const native = payWith === "native";

  /*
    The funding choice changes what every figure on this step MEANS, and the unit is the field's own.

    Both keys now have a real balance behind them, which is new: the percentages, the ceiling and
    the over-limit check used to exist only for MON, because the app made no ERC-20 balance call.
    What still differs between them is what the number is a share OF. MON is bounded by what is
    spendable rather than by the whole balance — Monad reverts a transaction ending below its 10 MON
    reserve, and the launch still has to be paid for afterwards — while the pair's own asset is
    bounded by nothing but itself, since the fee and the gas are claims on a different balance.
  */
  /* Native MON's registry row, for its mark on the funding keys — the quote's own row arrives as a
     prop, because this step cannot render at all until a pair is chosen. Found by address, not by
     the id `mon` or the kind: both are presentational columns an admin can edit, and the address is
     what the contracts agree on. */
  const { assets: quoteAssets } = useQuoteAssets();
  const nativeAsset = quoteAssets.find(isNativeQuoteAsset) ?? null;

  /* The asset this buy is funded in, and how it is named on screen.
     `displaySymbolText` so the unit here agrees with the pair picker two steps up — that is where
     `cbBTC` reads as `BTC` and `XAUt0` as `GOLD`, and a launcher should not meet two names for one
     asset inside one form. The name is dropped when it only repeats the ticker, which is the same
     dedupe the swap widget's plate applies for rows whose `name` falls back to their symbol. */
  const unit = native ? "MON" : displaySymbolText(quote);

  /*
   * The ceiling: how much of `unit` can actually go into this buy.
   *
   * Not the balance. Whenever the buy is funded in MON — because the launcher chose to, or because
   * the pair itself is MON — the same wallet also has to pay the launch fee and its gas, and end
   * above Monad's 10 MON reserve. `spendableMon` takes all three off and leaves room for whichever
   * extra transaction the funding choice adds, so "100%" produces a buy the launch can be signed
   * after.
   *
   * That is the whole of the bug this replaces. The presets were computed against the spendable
   * figure while the *readout* and the over-limit check were computed against the raw balance, so
   * pressing 100% on a MON pair filled the field with the entire wallet, the launch was blocked by
   * its own button, and the field said the number was fine. It also tripped a rounding edge:
   * `toFixed` rounds half up, so the formatted "whole balance" could come out a hair *above* it and
   * light the over-limit warning at exactly 100%.
   *
   * An ERC-20 pair keeps the whole token balance: MON pays the fee and the gas, and this buy does
   * not touch it.
   */
  /* Whether the buy comes out of the MON balance at all: either the launcher chose to fund it in
     MON, or the pair itself is MON and the first buy rides along in `msg.value`. */
  const fromMon = native || isNativeQuoteAsset(quote);
  /* Whether there is a swap AND the wallet takes it inside the launch. Only a MON-funded buy on a
     non-MON pair has a swap at all, so a MON pair keeps the unconditional reservation it always
     had; where the swap exists and the batch takes it, its gas stops being a second transaction's.
     Derived once, because every figure below has to be describing the same launch. */
  const swapBatched = native && oneSignature;
  const decimals = fromMon ? 18 : quote.decimals;

  /* What the wallet holds of whatever funds this buy, and the most of it the buy may take. On MON
     they differ by three deductions; on the pair's own asset they are the same number, because the
     fee, the gas and the reserve are all claims on a balance this buy does not touch. */
  const heldRaw = fromMon ? monBalance : quoteBalance;
  const ceilingRaw = fromMon
    ? monBalance === undefined
      ? undefined
      : spendableMon(monBalance, launchFee, swapBatched)
    : quoteBalance;

  const ceiling = ceilingRaw === undefined ? undefined : Number(formatUnits(ceilingRaw, decimals));
  const held = heldRaw === undefined ? undefined : Number(formatUnits(heldRaw, decimals));
  const hasBalance = ceiling !== undefined && ceiling > 0;
  const share = hasBalance && amount > 0 ? (amount / ceiling) * 100 : null;
  /* A hair of tolerance, because the field holds a *formatted* number and the ceiling does not. */
  const overBalance = hasBalance && amount > ceiling * 1.0000001;
  /* The ceiling as the 100% key would fill it in — one string for the readout, the notice and the
     button in it, so the figure a launcher is told is the ceiling is the figure the key sets. */
  const ceilingText = ceilingRaw === undefined ? "" : trimAmount(ceilingRaw, decimals);

  /**
   * How much MON has to arrive before this step has anything to offer at all.
   *
   * The mirror of the ceiling, and the number that was missing from every closed state this step
   * had. `spendableMon` returning zero was reported as "nothing left to buy with" — a true sentence
   * that leaves the reader with no idea whether they are four MON away or forty, on the one screen
   * where the answer decides what they do next.
   */
  const topUpWei = fromMon ? monTopUpForDevBuy(monBalance, launchFee, swapBatched) : 0n;
  const topUp = topUpWei > 0n ? Number(formatUnits(topUpWei, 18)) : 0;

  /* Whether there is somewhere else to send a launcher who holds none of the pair's asset. On a
     routable pair there is: the other key on the control directly above this row. */
  const canPayNative = payWithOptions.includes("native");

  /**
   * Why the percentage row has nothing to divide, in the row's own words.
   *
   * Three states that used to be two, and the pair of them were wrong in opposite directions.
   *
   *   - **No wallet.** Genuine, and the only one the old copy described correctly.
   *   - **A wallet, and a balance still being read.** It was the permanent state of every non-MON
   *     pair, because the app made no ERC-20 balance call — and the step answered it with "Connect
   *     a wallet to fund a dev buy" *underneath the connected wallet's address*. It is now a
   *     quarter of a second, and it says so rather than accusing the reader of not connecting.
   *   - **A wallet, a readable balance, and nothing above the floor.** The truly closed case, and
   *     the one that carries the figure that opens it — a MON top-up, or, on the pair's own asset,
   *     the other funding key directly above this row.
   *
   * `null` when the row works, so the caller needs no second condition.
   */
  const closedReason: string | null = (() => {
    if (hasBalance) return null;
    if (!walletConnected) {
      return "Connect a wallet and the percentages fill in from your balance. You can set an amount now either way — the draft keeps it.";
    }
    if (quoteBalancePending && !fromMon) {
      return `Reading your ${unit} balance…`;
    }
    if (ceiling === undefined) {
      return `DOKU can't read your ${unit} balance, so there is no percentage to take one of. Type the amount you want to spend.`;
    }
    if (fromMon && topUp > 0) {
      return `${formatAmount(topUp)} MON more and this opens. Monad keeps 10 MON back in every wallet, and the launch fee and its gas come out of what sits above it.`;
    }
    if (!fromMon) {
      /* The case that could not previously be stated, because the balance was never read: the
         wallet genuinely holds none of the pair's asset. It has an exact remedy on this same
         panel whenever the pair is routable, so the sentence names it rather than stopping at
         the diagnosis. */
      return canPayNative
        ? `You hold no ${unit}. Fund the buy with MON instead — the key above swaps it for you — or send some ${unit} to this wallet.`
        : `You hold no ${unit}, and there is no route from MON to it. Send some ${unit} to this wallet to fund a dev buy.`;
    }
    return "The launch fee, its gas and Monad's 10 MON reserve already account for this balance.";
  })();

  /**
   * One share, one amount.
   *
   * Kept as a function rather than inlined into the key's handler because the amount field below is
   * the other way into the same value, and the two must not drift.
   */
  const amountForShare = (pct: number) =>
    fromMon
      ? monShareOfBalance(monBalance, pct, launchFee, swapBatched)
      : /* Floored in RAW units, never rounded: `toFixed` rounds half up, and at 100% that is a
           number a hair above the ceiling — which lights the over-limit warning on the preset that
           means "all of it", and asks the wallet for money it does not have. */
        quoteShareOfBalance(quoteBalance, pct, quote.decimals);

  return (
    <div className="flex flex-col gap-4">
      {/*
        The percentages, first.

        Above the field rather than under it, because this is the control most people will use and
        the field is where its answer lands. A row of presets *below* an empty input reads as a
        shortcut for the input; above it, it reads as the question.
      */}
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className={LABEL_CLASS}>
            {fromMon ? "Share of your spendable MON" : `Share of your ${unit}`}
          </span>
          {ceiling !== undefined && (
            <span
              className="shrink-0 font-numeric text-[12px] leading-none text-mute"
              title={
                fromMon && held !== undefined
                  ? `Of ${formatAmount(held)} MON held. The launch fee, its gas and Monad's 10 MON reserve come off the top.`
                  : /* Nothing comes off a token balance, and saying so is the point: a launcher
                       who has just read the MON version of this line will otherwise assume the
                       same three deductions apply here. They cannot — they are claims on a
                       different balance. */
                    `All of it. The launch fee and its gas are paid in MON, not in ${unit}.`
              }
            >
              {ceilingText || "0"} {unit} available
            </span>
          )}
        </div>

        {/* Five across, two deep. Ten keys, and the grid divides exactly. */}
        <div className="grid grid-cols-5 gap-2">
          {PERCENTS.map((pct) => {
            /* Selected by what the amount *is*, not by what was last pressed — so typing 50% of
               your balance by hand lights the same chip that setting it would have. */
            const selected = share !== null && Math.abs(share - pct) < PRESET_EPSILON;
            return (
              <button
                key={pct}
                type="button"
                disabled={!hasBalance}
                /* A share of what can actually be SPENT when the funding is MON: the chain's 10
                   MON reserve and the launch that follows are both taken out first, so even the
                   100% key never produces an amount the wallet cannot sign for. */
                onClick={() => onChange(amountForShare(pct))}
                aria-pressed={selected}
                data-selected={selected}
                /* `.doku-pair-key` — the machined key the quote picker is built from, at chip
                   scale. Flat-bordered rectangles in a row was the one thing on this page that
                   still looked like a wireframe. */
                className={[
                  "doku-pair-key h-9 rounded-doku-lg font-numeric text-[13px] font-semibold leading-none",
                  "disabled:cursor-not-allowed disabled:text-mute",
                  selected ? "text-doku-ink" : "text-ash enabled:hover:text-ink",
                ].join(" ")}
              >
                {pct}%
              </button>
            );
          })}
        </div>

        {/*
          Why the row is closed, in the row's own place — and what opens it.

          A hint under a disabled control has one job, and this one was not doing it. It named three
          deductions without showing any of their values, so the reader learned that something had
          been subtracted and not whether they were four MON short or forty. `closedReason` carries
          the figure; the field below stays open regardless, so this is a note about the
          percentages rather than a locked door.
        */}
        {closedReason && <p className={HINT_CLASS}>{closedReason}</p>}
      </div>

      {/* The amount the percentage works out to, and the field for anyone who already knows the
          number they want. One value, two ways in. */}
      <div className="flex flex-col gap-2">
        {/*
          The amount, built like an amount.

          What this replaces was a `bg-well` box with a 1px `border-line` that turned brand on
          focus, a 17px figure, and the unit set as 12px grey text absolutely positioned in the
          right-hand padding. Measured, its `box-shadow` was `none` — so the one field on this page
          where somebody types a quantity of money had no recess, no lit lip and no material at all,
          while the swap widget two routes over gives the identical job a pressed well whose rim
          lights on focus.

          It is that well now — `.doku-swap-field`, the same recipe — and the asset is a PLATE
          rather than a caption: a raised face holding the mark in a recess of its own, which is how
          this product names an asset everywhere else it is spent. A launcher deciding how much of
          their own money to put into their own coin should be looking at the same object they will
          look at when they trade it.

          The figure goes 17px -> 26px to match the swap's, because it is the number this step is
          about and it was smaller than the step's own heading.
        */}
        <div
          data-invalid={overBalance || undefined}
          className="doku-swap-field flex flex-col gap-3 rounded-[16px] px-4 py-3.5"
        >
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor={id} className={LABEL_CLASS}>
              Amount
            </label>
            <span className="flex shrink-0 items-baseline gap-2.5">
              {share !== null && (
                <span
                  className={`font-numeric text-[12px] leading-none ${
                    overBalance ? "text-loss-ink" : "text-doku-ink"
                  }`}
                >
                  {share.toFixed(share < 10 ? 1 : 0)}% of your {fromMon ? "spendable MON" : unit}
                </span>
              )}
              {value && (
                <button
                  type="button"
                  onClick={() => onChange("")}
                  className="doku-token-key h-6 shrink-0 rounded-doku-sm px-2 font-numeric text-[11px] leading-none text-mute"
                >
                  Clear
                </button>
              )}
            </span>
          </div>

          <div className="flex items-center justify-between gap-3">
            {/*
              Always typeable, and this is the change.

              The field was disabled whenever the ceiling was zero or unknown, which locked it in
              three situations and was wrong in all three. With no wallet connected it locked a
              *draft* — the one this bench restores on the next visit — so somebody deciding a dev
              buy before they had a wallet in front of them could not write the decision down. On an
              ERC-20 pair it locked because DOKU cannot read that token's balance, which is a gap in
              what the app KNOWS and not a fact about what the launcher can afford. And with a
              balance under the floor it locked rather than saying how far under.

              A disabled field also cannot explain itself: it has no error state, so the launcher got
              a grey box and a sentence, where an open field gets a number, a ceiling and a way to
              correct it. Nothing is risked by letting them type — the launch button is the thing
              that holds, it reads the same arithmetic, and it shows the whole ledger beside it.
            */}
            <input
              id={id}
              value={value}
              onChange={(e) => onChange(sanitiseAmount(e.target.value))}
              placeholder="0"
              inputMode="decimal"
              autoComplete="off"
              aria-invalid={overBalance}
              className="block w-full min-w-0 flex-1 border-transparent bg-transparent !p-0 font-numeric text-[26px] font-semibold leading-none tabular-nums text-ink outline-none placeholder:text-mute"
            />

            {/*
              The asset, as a mounted mark.

              A `div`, not a `button`: the funding asset is chosen by the control directly above
              this field, so a plate that answered the pointer here would be a second, unlabelled
              way to make one decision. `.doku-swap-plate`'s hover and press are scoped to `button`
              for exactly that reason, so this keeps the material and makes no promise.
            */}
            <FundingPicker
              options={payWithOptions}
              value={payWith}
              onChange={onPayWith}
              quote={quote}
              nativeAsset={nativeAsset}
              unavailable={payUnavailable}
            />
          </div>
        </div>

        {/*
          Over the ceiling — and it says what the ceiling is.

          It said "that is more MON than this wallet holds — the launch would run out of gas before
          it bought anything", which was wrong twice over: the wallet usually *does* hold it, and
          the reason is not gas. What bounds a MON-funded buy is the fee, the gas and the reserve
          coming out of the same balance. Naming the number is what makes it fixable; naming a
          mechanism the launcher cannot see is not.
        */}
        {overBalance && ceiling !== undefined && (
          /*
            Correctable, not condemned.

            It was `tone="error"` and it ended on the mechanism — the fee, the gas and the reserve
            all coming out of one balance — which is the explanation and not the remedy. Somebody
            who has typed a number too large has made an ordinary mistake with an exact fix, and the
            fix is a single number this component already holds. So the ceiling is the sentence and
            the key sets it, which is the difference between a form that reports a fault and one
            that offers to clear it.

            Amber rather than coral, for the same reason: nothing has gone wrong yet. The launch
            button holds until this is resolved, and the ledger beside it says why.
          */
          <Notice tone="warn" title={`${ceilingText} ${unit} is the ceiling`} alert>
            <div className="flex min-w-0 flex-col gap-2.5">
              <p className="min-w-0">
                {fromMon
                  ? `A launch has to leave Monad's 10 MON reserve behind and still pay its fee and its gas, so this is what is left for the buy.`
                  : canPayNative
                    ? `That is more ${unit} than this wallet holds. Fund the buy with MON instead and the ceiling becomes your MON balance.`
                    : `That is more ${unit} than this wallet holds.`}
              </p>
              <button
                type="button"
                onClick={() => onChange(amountForShare(100))}
                className="doku-token-key inline-flex h-9 w-full items-center justify-center rounded-doku-lg px-3 font-ui font-semibold text-[11.5px] uppercase leading-none tracking-[0.05em] text-warn-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
              >
                Use {ceilingText} {unit}
              </button>
            </div>
          </Notice>
        )}
      </div>

      {/*
        What the MON actually buys, while it is being priced.

        The route is shown rather than summarised, for the same reason the trade panel shows it: a
        swap through USDC crosses a pool, pays its fee and depends on its liquidity, and a launcher
        told only "pay with MON" has been sold that pool without being shown it.
      */}
      {native && plan.kind !== "idle" && (
        <div className="rounded-doku-xl border border-line bg-well px-3.5 py-3">
          {plan.kind === "quoting" && (
            <p className="font-numeric text-[13px] leading-none text-mute">Pricing the swap…</p>
          )}
          {plan.kind === "unavailable" && (
            <p role="status" className="font-ui text-[13px] leading-snug text-warn-ink">
              {plan.message}
            </p>
          )}
          {/*
            What the MON buys, and nothing about how the pool felt about it.

            The route's price impact was stated here in basis points. On a *trade* that figure is
            the decision — a size is being chosen against a book. On a dev buy it is not: the size
            was already chosen as a share of a balance one control up, the swap is a means of
            reaching the market's own asset rather than a position being taken, and the launcher has
            no lever to move it with except a number they have already set. A percentage nobody can
            act on only makes a form look risky.
          */}
          {plan.kind === "ready" && (
            <div className="flex flex-col gap-1.5">
              <p className="font-numeric text-[14px] leading-none text-ink">
                ≈ {formatAmount(Number(formatUnits(plan.quoteOut, quote.decimals)))} {quote.symbol}
              </p>
              <p className="font-ui text-[12px] leading-snug text-mute">
                {oneSignature
                  ? "The swap travels with the launch, in one signature."
                  : "The swap is a separate signature, before the launch."}
              </p>
            </div>
          )}
        </div>
      )}

      {/* The description of what a dev buy *is* went with the rest of the form's explanatory copy —
          the audience deploys contracts. What stays is the consequence they cannot see, and there
          are now three of them — two for a buy funded in MON, one for a buy the factory pulls.

          Funding it in MON through a wallet that cannot batch is the old one: the coin does not
          exist until the launch creates it, so the swap cannot ride inside the same transaction and
          costs its own signature.

          With batching the wallet takes all three calls at once — and the launcher is told the
          thing they would otherwise find out from a balance. A batch cannot read what the swap
          delivered between its own calls, so the buy spends the swap's guaranteed MINIMUM and the
          overshoot stays in the wallet. It is a fraction of a percent, it is not a defect, and it
          is money: it belongs on screen rather than in a docblock.

          And a buy in the pair's own asset has an extra prompt of its own, which is the branch
          below. */}
      {native ? (
        /* Only the batching case says anything now. The other branch read "Funding it with MON
           adds one signature in front of the launch" — a line about prompt COUNT sitting above
           the launch button, which is where a wallet's prompts are actually counted. */
        oneSignature ? (
          <p className="font-ui text-[13px] leading-relaxed text-mute">
            {`Your wallet takes the swap and the launch together, so funding it with MON costs no extra signature. The buy spends the swap's guaranteed minimum, so whatever the swap delivers above that stays in your wallet as ${quote.symbol}.`}
          </p>
        ) : null
      ) : (
        /*
          The other extra signature, which nothing on this form used to mention.

          A dev buy in the pair's own asset is not sent with the launch — the factory PULLS it, so
          the launcher approves the factory first, in a transaction of its own. That is a wallet
          prompt arriving between "Launch coin" and anything happening, and a prompt nobody was
          told about reads as the site doing something it did not say it would. `submitLaunch`
          skips it when an allowance is already in place, which is why this says "may".

          Only once there is an amount: an empty dev-buy step should not be explaining approvals.
        */
        !isNativeQuoteAsset(quote) &&
        amount > 0 && (
          <p className="font-ui text-[13px] leading-relaxed text-mute">
            Paying in {unit} may add one approval signature in front of the launch — the factory
            pulls the buy from your wallet.
          </p>
        )
      )}
    </div>
  );
};

export default DevBuy;
