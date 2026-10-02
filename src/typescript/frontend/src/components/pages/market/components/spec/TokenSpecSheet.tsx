"use client";

import { translationFunction } from "context/language-context";
import { cn } from "lib/utils/class-name";
import { toExplorerLink } from "lib/utils/explorer-link";
import { formatCompact, formatSupply } from "lib/utils/format-compact";
import Link from "next/link";
import React, { useMemo } from "react";
import { ROUTES } from "router/routes";
import { formatUnits } from "viem";

/* The launched token is always eighteen decimals — this is the token's supply, not a quote
   amount, so it is the one place on this sheet where a fixed eighteen is the true answer. */
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import { poolIdFrom } from "@/lib/chain/pool-id";
import { quoteAmountNumber } from "@/lib/chain/quote-scale";
import { poolKeyFor } from "@/lib/chain/wagmi";
import { usePoolLiquidity } from "@/lib/hooks/doku/use-pool-liquidity";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";
import { PROTOCOL_FEE_PCT } from "@/lib/launch/submit";
import type { MarketModel } from "@/lib/models";
import { identityFor } from "@/lib/token-identity";

/**
 * The spec sheet — every fact about this coin that is not a price.
 *
 * ## Why a page like this needs one
 *
 * A market page answers "what is it worth" in its masthead and "is anyone trading it" in its deck,
 * and it used to answer *nothing else*. The questions a buyer actually asks before signing are
 * structural: can more of this be minted, who launched it, where does the liquidity live, can it be
 * pulled, what does a trade cost, and what happens when the curve fills. Those were spread across a
 * tab, a receipt line and two sentences of prose — or, in the case of supply and the mint function,
 * absent from the product entirely.
 *
 * Every row here is read from the contract, the indexer or a constant this app already ships. There
 * is no "audit score", no traffic light and no aggregate rating: those invent confidence out of
 * facts the reader can weigh themselves, and on a permissionless launchpad that is the one thing an
 * interface must not do.
 *
 * ## The two claims worth defending
 *
 * **"Fixed — no mint function."** The token ABI this app is built against exposes `TOTAL_SUPPLY` as
 * a constant and no mint entry point at all; supply is set once in `initialize`. The row states the
 * mechanism rather than a verdict, so a reader who wants to check can, and so it stays true if the
 * contract is ever replaced by one that does have a mint — at which point the ABI changes and this
 * row has to be revisited on purpose.
 *
 * **"Burned at graduation."** Graduation mints a full-range v4 position and sends the NFT to the
 * dead address. Liquidity therefore cannot be withdrawn by anybody, including the team. Stated
 * only once a market has actually graduated: before that it is a promise about the future, and
 * this sheet reports state.
 *
 * ## The venue row, and the address that is not one
 *
 * It said "Uniswap V3 · 1%", from `POOL_FEE_TIER` — a constant that was V3's one-percent tier and
 * is zero on every DOKU pool, because the levy is skimmed inside the hook and a non-zero pool fee
 * would make that impossible. So the row named the wrong protocol and divided the wrong number.
 *
 * It then said "Uniswap v4 + hook", which names the right protocol and spends half the row on an
 * implementation detail: every DOKU pool has a hook, so the phrase distinguishes this market from
 * nothing. It says **Uniswap v4**. A market still on its curve says `Bonding curve` and names
 * Uniswap underneath as where it is going — because the row reports where a trade goes *now*, and
 * a market that cannot be traded on Uniswap yet must not claim to be.
 *
 * It also linked `pool_address` to the explorer as an account. Under v4 there is no pool contract:
 * a pool is state inside one PoolManager, addressed by `keccak256(PoolKey)`, and `pool_address` is
 * the indexer's "has it graduated" flag and nothing else. The row states the `PoolId` instead, as
 * plain text, because it is an identifier and not somewhere to go.
 *
 * ## Total liquidity
 *
 * The one figure a buyer wants that no other panel on this page carries: how much is actually
 * behind this market. Before graduation that is the quote the curve is holding — the same number
 * the curve meter fills toward, said as an amount rather than as a fraction. After it, it is the
 * pool's two sides, derived from `L` and the current price; see `usePoolLiquidity` for why a
 * full-range position lets that be the quote side doubled rather than two separately priced legs.
 */

/** One row of the sheet: a label, a value, and optionally something to press. */
const Row = ({
  label,
  hint,
  children,
  tone,
  localTime,
}: {
  label: string;
  /** One line under the value, for a fact the figure alone does not carry. */
  hint?: React.ReactNode;
  children: React.ReactNode;
  tone?: "default" | "good" | "warn";
  /**
   * The value is a clock reading in the READER'S timezone, which the server does not have: its
   * text legitimately differs between the server render and the client, and React is told to
   * keep the client's without complaint. Without this the whole streamed page was thrown away
   * and rendered again from the client on every market visit. See `TradeFeed`'s time column.
   */
  localTime?: boolean;
}) => (
  <div className="doku-spec-row flex items-start justify-between gap-4 py-3">
    {/* The display face, like every other label on this page — see `FIGURE_LABEL` in the masthead
        for why these are not tracked mono any more. */}
    <span className="shrink-0 pt-[1px] font-pixel text-[12px] uppercase leading-none tracking-[0.05em] text-ash">
      {label}
    </span>
    <span className="flex min-w-0 flex-col items-end gap-1.5 text-right">
      <span
        suppressHydrationWarning={localTime}
        className={cn(
          "min-w-0 truncate font-numeric text-[13.5px] font-semibold leading-none tabular-nums",
          tone === "good" ? "text-doku-ink" : tone === "warn" ? "text-warn-ink" : "text-ink"
        )}
      >
        {children}
      </span>
      {hint && <span className="font-ui text-[12.5px] leading-none text-mute">{hint}</span>}
    </span>
  </div>
);

/** An address, truncated, linking out to wherever that address is worth looking at. */
const AddressLink = ({ href, address }: { href: string; address: string }) => (
  <Link
    href={href}
    target={href.startsWith("http") ? "_blank" : undefined}
    rel={href.startsWith("http") ? "noopener noreferrer" : undefined}
    className="inline-flex items-center gap-1.5 text-ink transition-colors hover:text-doku-ink"
  >
    {`${address.slice(0, 6)}…${address.slice(-4)}`}
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 text-mute"
    >
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  </Link>
);

/** A compact supply figure. Whole tokens only — a supply with decimals on it is noise. */
export function TokenSpecSheet({ market }: { market: MarketModel }) {
  const { t } = translationFunction();
  const { market: meta, state } = market;
  /* The catalogue, for the quote's real name and its dollar rate. Passing it to `identityFor` is
     what makes "Priced in MON / Monad" say Monad rather than MON twice. */
  const { assets: quoteAssets } = useQuoteAssets();
  const identity = useMemo(() => identityFor(meta, quoteAssets), [meta, quoteAssets]);
  const graduated = Boolean(state.poolAddress);

  /**
   * What is behind this market, in whole units of its own quote.
   *
   * Two different facts under one label, because they answer the same question at the two stages a
   * market has. On the curve it is the quote the curve is holding — every sale routes against it,
   * so it is the depth in the most literal sense. In the pool it is both sides of the position,
   * read from the chain.
   */
  const poolLiquidity = usePoolLiquidity(market);
  const curveLiquidity = quoteAmountNumber(state.quoteRaised, meta.quote.decimals);
  const liquidity = graduated ? poolLiquidity : curveLiquidity;

  /** Dollars per whole quote unit, or null where nothing has priced the asset. */
  const quoteUsdPrice = useMemo(() => {
    const price = identity.quote.usdPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  }, [identity.quote.usdPrice]);

  const supply = Number(formatUnits(state.totalSupply, BASE_DECIMALS));
  /** The pool's identity under v4: the hash of its key, not an address. */
  const poolId = poolIdFrom(
    poolKeyFor(meta.tokenAddress as `0x${string}`, meta.quote.asset as `0x${string}`)
  );
  /* The date *and* the time. On a launchpad the hour is the fact: a coin that launched this
     morning and one that launched three weeks ago are different instruments, and "12 Sep" alone
     cannot tell you whether you are early. The masthead's relative age answers "how old"; this
     answers "when", which is the one you can check against a chart or a screenshot. */
  const launched = meta.launchedAt.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-col">
      <Row label={t("Supply")} tone="good">
        {supply > 0 ? `${formatSupply(supply)} ${identity.ticker}` : "—"}
      </Row>

      <Row label={t("Priced in")} hint={identity.quote.name}>
        {identity.quote.symbol}
      </Row>

      <Row
        label={t("Venue")}
        hint={graduated ? t("Curve closed permanently") : t("Graduates to Uniswap v4")}
      >
        {graduated ? "Uniswap v4" : t("Bonding curve")}
      </Row>

      {/*
        How much is behind it.

        In dollars on the face where the quote has a rate, with the quote's own amount underneath —
        the two units a reader checks against two different things: the dollar figure against every
        other market they have looked at today, the quote figure against the curve meter in the
        trade panel, which counts in exactly these units.

        `null` renders "—" rather than a zero. A pool that has not answered yet and a market with
        nothing in it are different facts, and only one of them should make somebody close the tab.
      */}
      <Row
        label={t("Total liquidity")}
        hint={
          liquidity === null
            ? undefined
            : quoteUsdPrice === null
              ? graduated
                ? t("Both sides of the pool")
                : t("Held by the curve")
              : `${formatCompact(liquidity)} ${identity.quote.symbol}`
        }
      >
        {liquidity === null
          ? "—"
          : quoteUsdPrice === null
            ? `${formatCompact(liquidity)} ${identity.quote.symbol}`
            : `$${formatCompact(liquidity * quoteUsdPrice)}`}
      </Row>

      <Row
        label={t("Trade fee")}
        hint={graduated ? t("Taken inside the pool swap") : t("On every buy and sell")}
      >
        {identity.creatorFeePct > 0
          ? `${PROTOCOL_FEE_PCT}% + ${identity.creatorFeePct}%`
          : `${PROTOCOL_FEE_PCT.toFixed(2)}%`}
      </Row>

      {/* Only once there is a pool: before graduation this row would be a promise, and the sheet
          reports state. */}
      {graduated && (
        <>
          <Row label={t("Pool ID")} hint={t("A v4 pool is state, not a contract")}>
            {`${poolId.slice(0, 6)}…${poolId.slice(-4)}`}
          </Row>
          {/* "Liquidity" was this row's label until a `Total liquidity` row appeared four rows
              above it, at which point the sheet had two rows called liquidity answering different
              questions — how much, and whether anyone can take it. This one is the lock. */}
          <Row
            label={t("Liquidity lock")}
            tone="good"
            hint={t("The seed position is held by a contract with no withdrawal function")}
          >
            {t("Locked forever")}
          </Row>
        </>
      )}

      <Row label={t("Token")}>
        <AddressLink
          href={toExplorerLink({ linkType: "acc", value: meta.tokenAddress })}
          address={meta.tokenAddress}
        />
      </Row>

      <Row label={t("Creator")}>
        <AddressLink href={`${ROUTES.wallet}/${meta.creator}`} address={meta.creator} />
      </Row>

      <Row label={t("Launched")} localTime>
        {launched}
      </Row>
    </div>
  );
}

export default TokenSpecSheet;
