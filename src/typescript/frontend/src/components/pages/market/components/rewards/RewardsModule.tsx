"use client";

import { translationFunction } from "context/language-context";
import React, { useMemo } from "react";
import { formatUnits } from "viem";

/* The launched token is always eighteen decimals. The QUOTE asset's decimals arrive on the
   ledger itself, and every money figure below scales by those. */
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";
import { PROTOCOL_FEE_PCT } from "@/lib/launch/submit";
import type { MarketModel } from "@/lib/models";
import { identityFor } from "@/lib/token-identity";

import { DividendsPanel } from "./DividendsPanel";
import { useMarketRewards } from "./useMarketRewards";

/**
 * What the creator's share of every trade is doing — dividends, or a burn.
 *
 * ## Why only two of the three routings render
 *
 * A launcher points their share of the protocol fee at their own wallet, at their holders, or at a
 * buyback. The first is the default and the honest one, and it is **not a feature to advertise**:
 * "the creator keeps their fees" is what happens everywhere by default, so a module announcing it
 * would be filler on the one surface where filler costs credibility. The other two are promises
 * made to whoever buys the coin, and a promise deserves a panel that reports on it.
 *
 * So: dividends → a panel, buyback → a panel, creator or nothing recorded → nothing at all.
 *
 * ## Every figure here is measured, and none of it is arithmetic on volume any more
 *
 * This is a page about somebody's money, so the rule is absolute: no invented totals, and no
 * figure whose derivation cannot be stated in the line beneath it.
 *
 * Every one now comes from `GET /markets/:address/rewards`, which sums what the fee events
 * actually recorded:
 *
 *   - **Burned** is `burnedTokens`, against `mintedSupply`.
 *   - **Pending** is `pending`: routed fees generated and not yet funded, shown only before
 *     graduation. A graduated dividends market is read off its vault instead — see
 *     `DividendsPanel` — because the vault holds every wei to the wei and a counter does not.
 *
 * What this replaces was `volume × 0.7%`, less `pendingFees()` off the curve. That guess is right
 * only while every market charges the same fee, none of it is a creator tax, and no market has
 * graduated onto a hook with a different levy — all three false on generation 2. It also read
 * every amount at eighteen decimals, so a market quoted in six-decimal gold reported its dividends
 * a trillion-fold short.
 *
 * ## A buyback market's `pending` is zero by construction
 *
 * Not by subtraction. Its routed share is spent buying the token back and destroying it inside the
 * same transaction, so there is never a balance sitting anywhere for anyone to claim. The zero is
 * a fact about the design, and rendering a claim — or even a "pending" pill — from it would offer
 * somebody money that does not exist.
 */

/** The creator's share of the protocol fee — the part they get to point somewhere. */
const CREATOR_SHARE = 0.7;
const ROUTED_PCT = Number((PROTOCOL_FEE_PCT * CREATOR_SHARE).toFixed(2));

/** A figure at three significant digits with its magnitude as a suffix. */
const compact = (n: number) =>
  n >= 1_000_000_000
    ? `${(n / 1_000_000_000).toFixed(2)}B`
    : n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(2)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}K`
        : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const DividendGlyph = () => (
  <svg
    width="21"
    height="21"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.4v9.2M14.4 9.4a2.6 2.6 0 0 0-2.4-1.3c-1.5 0-2.5.8-2.5 1.9 0 2.6 5 1.4 5 4 0 1.2-1.1 2-2.6 2a2.7 2.7 0 0 1-2.5-1.4" />
  </svg>
);

const BurnGlyph = () => (
  <svg
    width="21"
    height="21"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 21c3.6 0 6.2-2.5 6.2-5.9 0-3.9-3.4-5.6-4.5-9.4-1.9 1.3-2.6 3-2.4 4.9-1.2-.4-2-1.5-2.3-2.7C7.2 9.6 5.8 12 5.8 15.1 5.8 18.5 8.4 21 12 21Z" />
    <path d="M12 21c1.6 0 2.8-1.2 2.8-2.7 0-1.7-1.5-2.5-2-4.2-1 .8-1.5 1.9-1.4 3-.6-.3-1-.9-1.1-1.5-.8.9-1.1 1.8-1.1 2.7 0 1.5 1.2 2.7 2.8 2.7Z" />
  </svg>
);

/**
 * The proportion meter.
 *
 * A channel with the measured share drawn from the left, ticks every tenth for scale, and a floor
 * on the fill so a real-but-tiny figure is still visible as a sliver rather than as nothing. The
 * curve's segmented meter would be the wrong instrument here: that one measures progress toward an
 * *event*, this one measures a share of a *whole*, and at 1.2% a segmented bar reads as empty.
 */
const ProportionMeter = ({ pct, tone }: { pct: number; tone: "doku" | "warn" }) => (
  <div className="doku-reward-channel relative flex h-[10px] w-full overflow-hidden rounded-[3px]">
    <span
      className="relative z-10 h-full rounded-[2px]"
      style={{
        width: `${pct > 0 ? Math.max(1.5, Math.min(100, pct)) : 0}%`,
        background:
          tone === "doku"
            ? "linear-gradient(180deg, var(--doku-ink) 0%, var(--doku) 100%)"
            : "linear-gradient(180deg, #ffb457 0%, var(--warn) 100%)",
        boxShadow:
          tone === "doku"
            ? "0 0 10px -2px rgb(var(--doku-rgb) / 0.65)"
            : "0 0 10px -2px rgb(var(--warn-rgb) / 0.6)",
      }}
    />

    {/* Ticks every tenth, so a sliver has a scale to be a sliver *of*. */}
    <span aria-hidden className="doku-reward-ticks pointer-events-none absolute inset-0" />
  </div>
);

export function RewardsModule({ market }: { market: MarketModel }) {
  const { t } = translationFunction();
  const identity = useMemo(() => identityFor(market.market), [market.market]);
  const routing = identity.feeRouting;
  const isBurn = routing === "buyback";
  const isDividend = routing === "holders";

  const { rewards } = useMarketRewards(market.market.marketAddress);

  // The quote's dollar price, matched the way the masthead matches it: by catalogue id or by
  // address, whichever the market row carried. The identity itself is never handed the catalogue.
  const { assets: quoteAssets } = useQuoteAssets();
  const quoteUsdPrice = useMemo(() => {
    const key = (identity.quote.id ?? identity.quote.address ?? "").toLowerCase();
    const match = quoteAssets.find((a) => a.id.toLowerCase() === key || (a.address ?? "").toLowerCase() === key);
    const price = match?.usdPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  }, [quoteAssets, identity.quote.id, identity.quote.address]);

  /**
   * The burn, from the ledger's own count.
   *
   * It used to be three chain reads summed — `TOTAL_SUPPLY() - totalSupply()` for a real `_burn`
   * plus `balanceOf(0x…dEaD)` for tokens sent away. That was measurement in the absence of an
   * endpoint; the endpoint counts the same burns from the events that caused them, and does it for
   * a market whose curve has closed as readily as for one still on it.
   */
  const burn = useMemo(() => {
    if (!rewards) return null;
    const minted = BigInt(rewards.mintedSupply);
    if (minted === 0n) return null;
    const mintedNum = Number(formatUnits(minted, BASE_DECIMALS));
    const burnedNum = Number(formatUnits(BigInt(rewards.burnedTokens), BASE_DECIMALS));
    return { mintedNum, burnedNum, pct: mintedNum > 0 ? (burnedNum / mintedNum) * 100 : 0 };
  }, [rewards]);

  // The two states that are not a promise to anybody render nothing at all.
  if (!isBurn && !isDividend) return null;

  const tone = isBurn ? "warn" : "doku";

  return (
    <section className="doku-token-tray relative rounded-[17px] p-[3px]">
      <span
        aria-hidden
        className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[20px]"
      />

      <div className="doku-token-face relative overflow-hidden rounded-[14px]">
        {/* ---- The head: what this is, and the rate that feeds it ---------------------- */}
        <div className="doku-swap-head flex items-center justify-between gap-3 px-4 py-3">
          <span className="flex items-center gap-2.5">
            <span
              className={`doku-reward-mark grid h-8 w-8 shrink-0 place-items-center rounded-doku-lg ${
                isBurn ? "text-warn-ink" : "text-doku-ink"
              }`}
              data-tone={tone}
            >
              {isBurn ? <BurnGlyph /> : <DividendGlyph />}
            </span>
            <span className="font-pixel text-[12px] uppercase leading-none tracking-[0.04em] text-ash">
              {isBurn ? t("Buyback & burn") : t("Dividends")}
            </span>
          </span>

          <span className="doku-swap-venue flex shrink-0 items-center rounded-doku-lg px-2 py-1 font-numeric text-[11px] font-semibold leading-none tabular-nums text-mute">
            {`${ROUTED_PCT}% ${t("of trades")}`}
          </span>
        </div>

        {/* ---- The figure, the meter, and how it was arrived at ------------------------ */}
        <div className="flex flex-col gap-3.5 px-4 py-4">
          {isBurn ? (
            <>
              <div className="flex items-end justify-between gap-3">
                <span className="flex min-w-0 flex-col gap-2">
                  <span className="font-pixel text-[11px] uppercase leading-none tracking-[0.04em] text-ash">
                    {t("Burned")}
                  </span>
                  <span className="truncate font-numeric text-[24px] font-semibold leading-none tabular-nums text-ink">
                    {burn ? compact(burn.burnedNum) : "—"}
                    <span className="ml-1.5 font-numeric text-[0.55em] font-medium text-mute">
                      {identity.ticker}
                    </span>
                  </span>
                </span>

                <span className="shrink-0 rounded-doku-sm border border-solid border-warn/30 bg-warn/10 px-2 py-1 font-numeric text-[12px] font-semibold leading-none tabular-nums text-warn-ink">
                  {burn
                    ? `${burn.pct < 0.01 && burn.pct > 0 ? "<0.01" : burn.pct.toFixed(2)}%`
                    : "—"}
                </span>
              </div>

              <ProportionMeter pct={burn?.pct ?? 0} tone="warn" />

              <p className="font-ui text-[12px] leading-snug text-mute">
                {burn
                  ? `${compact(burn.mintedNum)} ${identity.ticker} ${t("minted at launch. Burned supply can never return.")}`
                  : t("Reading the burn address…")}
              </p>
              <p className="font-ui text-[12px] leading-snug text-mute">
                {market.state.poolAddress !== null
                  ? `${t("Since graduation the burn share is taken from each trade in")} ${identity.ticker} ${t("itself and burned about once a day, once enough has built up. What is waiting is already out of circulation.")}`
                  : t("On the curve the burn share buys the coin and burns it inside every trade.")}
              </p>
            </>
          ) : (
            <>
              {/* The vault in four figures, read off the chain, and a claim for whoever is owed
                  one. The indexer's counters feed only the pre-graduation state. */}
              <DividendsPanel
                curve={market.market.marketAddress as `0x${string}`}
                token={market.market.tokenAddress as `0x${string}`}
                ticker={identity.ticker}
                graduated={market.state.poolAddress !== null}
                quoteSymbol={identity.quote.symbol}
                quoteDecimals={rewards?.quoteDecimals ?? identity.quote.decimals}
                quoteAddress={identity.quote.address as `0x${string}`}
                usdPrice={quoteUsdPrice}
                pendingOnCurve={rewards ? BigInt(rewards.pending) : null}
              />
            </>
          )}
        </div>
      </div>

      <span
        aria-hidden
        className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[14px]"
      />
    </section>
  );
}

export default RewardsModule;
