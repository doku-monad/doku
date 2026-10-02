"use client";

import { useQuery } from "@tanstack/react-query";
import { FormattedNumber } from "components/FormattedNumber";
import { InputNumeric } from "components/inputs/input-numeric";
import { translationFunction } from "context/language-context";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { cn } from "lib/utils/class-name";
import { compactQuote } from "lib/utils/format-compact";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  getMaxSlippageSettings,
  MAX_UI_SLIPPAGE_BPS,
  MIN_SLIPPAGE_BPS,
  setMaxSlippage as persistMaxSlippage,
  setMaxSlippageMode,
} from "utils/slippage";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import { AssetIcon } from "@/components/ui/asset-icon";
import { CoinMark } from "@/components/ui/coin-mark";
import { Notice } from "@/components/ui/notice";
import { displaySymbolText } from "@/lib/assets/display-symbol";
import {
  NATIVE_QUOTE_ADDRESS,
  nativeQuoteAsset,
  QUOTE_ASSET_KIND_NAMES,
  type QuoteAsset,
  type QuoteAssetKind,
} from "@/lib/assets/quote-assets";
import { curveAbi, graduationAbi, tokenAbi } from "@/lib/chain/abis";
import { CONTRACTS, poolKeyOf, ZAP_ROUTER } from "@/lib/chain/addresses";
import { formatAssetAmount } from "@/lib/chain/amount-display";
/* Every launched token is eighteen decimals; the QUOTE asset is the side that varies, and it is
   read off the market row. Aliased rather than imported under its own name so no line in this file
   can quietly use "the" decimals for an amount that is not the token's. */
import { TOKEN_DECIMALS as BASE_DECIMALS } from "@/lib/chain/config";
import {
  maxNativeSpend,
  nativeGasHeadroom,
  reserveShortfall,
  reserveVerdict,
} from "@/lib/chain/monad-reserve";
import { quotePoolBuy, quotePoolSell } from "@/lib/chain/pool";
import { receiptNotices } from "@/lib/chain/receipt-notices";
import { clampSlippageBps } from "@/lib/chain/slippage";
import { canSubmitTrade, chooseVenue, isStranded } from "@/lib/chain/venue";
import {
  buyQuoteFrom,
  curveIsClosed,
  isNativeQuote,
  minimumOut,
  sellQuoteFrom,
} from "@/lib/chain/writes";
import {
  quotePoolSellZapRoutes,
  quotePoolZapRoutes,
  quoteSellZapRoutes,
  quoteZapRoutes,
  readMaxZapValue,
} from "@/lib/chain/zap";
import {
  formatImpactBps,
  formatMonAmount,
  impactSeverity,
  poolSellZapPlan,
  poolZapPlan,
  restateAmount,
  sellZapPlan,
  type SideAsset,
  sideAssetOptions,
  zapPlan,
  zapSlippageBps,
} from "@/lib/chain/zap-plan";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";
import { identityFor } from "@/lib/token-identity";

import type { SwapComponentProps } from "../../types";
import { GraduateButton } from "./GraduateButton";
import { PayWithControl } from "./PayWith";
import type { ZapIntent } from "./SwapButton";
import { SwapButton } from "./SwapButton";

/**
 * The field eyebrow — the pixel label voice the rest of the product uses.
 *
 * It was tracked mono at `--mute`, which is the same setting as a trade-feed row: the two fields
 * you type money into were labelled in the voice used for a table cell.
 */
/**
 * The field eyebrow.
 *
 * `--ash`, not `--mute`. These two words are the only thing telling a trader which side of the
 * trade they are typing into now that the Buy/Sell tabs are gone, and at 11px in the mute grey they
 * were the quietest text in the panel — a label doing load-bearing work in the voice of a footnote.
 */
/**
 * The label over an amount.
 *
 * 12.5px in the display face at `--ash`. It was 11.5 — a *chrome* size, the one a rank plate is set
 * in — over a 26px figure, so the two fields a person types money into were headed by the smallest
 * type in the panel. The plates under them carry the ticker at 14 for the same reason.
 */
const fieldLabel =
  "font-ui font-semibold text-[12.5px] uppercase leading-none tracking-[0.04em] text-ash";

/**
 * The amount, at the size an amount deserves.
 *
 * 26px rather than 20px, and no fixed height — a fixed one clipped the descender of a fraction and
 * pushed the label above it out of line with the balance beside it.
 */
const inputAndOutputStyles = `
  block text-[26px] font-semibold leading-none outline-none w-full bg-transparent
  font-numeric tabular-nums
  border-transparent !p-0 text-ink placeholder:text-mute
`;

/**
 * The unit beside an amount, as a mounted mark.
 *
 * ## Why this replaced the emoji and the word "MON"
 *
 * The two fields you type money into were labelled with a raw emoji glyph on one side and the
 * letters `MON` on the other — two different kinds of thing, neither of them the way this product
 * names a coin anywhere else. Every other surface (the board card, the tape, the pair rail, the
 * market header) identifies an asset as *mark plus ticker*, and a trader arriving from a card
 * should see the same object they clicked.
 *
 * It is also the one place where getting identity wrong costs money: the whole risk in a swap
 * widget is being confused about which side is which. A mounted mark with the ticker beside it is
 * unmistakable at a glance, where a glyph and a word are two things you have to read.
 */
const TokenPlate = ({
  mark,
  ticker,
  caption,
  onFlip,
  title,
}: {
  mark: React.ReactNode;
  ticker: string;
  /** What the asset *is*, in two or three words. The line that stops a ticker being a code. */
  caption: string;
  /** Pressing a token puts it on the other side of the trade. See the note below. */
  /** Absent on this page: see the note on `flip`. Kept so the plate stays reusable as a control. */
  onFlip?: () => void;
  title?: string;
}) => {
  const showCaption =
    caption.trim().replace(/\s+/g, "").toUpperCase() !== ticker.trim().toUpperCase();

  /*
   * A plate with no handler is not a button, and must not be one.
   *
   * It used to render `<button>` either way — `tabIndex={-1}` and no `onClick`, on the theory that
   * this made it "a label". It did not. It stayed a button in the accessibility tree, and the
   * material still answered the pointer: `.doku-swap-plate:hover` lit the rim in the brand hue and
   * cast a green glow, and `:active` pressed it a pixel down. So the two largest objects in the
   * panel — the ones that look exactly like the token selector every other swap widget has —
   * invited a press and swallowed it.
   *
   * A control that lies to the pointer costs more than a flat one. The hover and press rules are
   * scoped to `button.doku-swap-plate` in `global.css` now, so the affordance exists only where
   * there is something to afford, and the plate keeps its full material either way.
   */
  const Tag = onFlip ? "button" : "div";

  return (
    <Tag
      {...(onFlip
        ? { type: "button" as const, onClick: onFlip }
        : /* Not `aria-hidden`: the ticker and caption are the only thing naming which asset this
             field is counted in, so a screen reader still has to read them — as text, not as a
             control. */
          { role: undefined })}
      title={title}
      aria-label={onFlip ? title : undefined}
      /*
      A fixed width, and it matters.
      --------------------------------------------------------------------------------------
      The plate used to size to its own content, so flipping the trade — or simply loading a coin
      with a longer ticker — moved the field's whole right edge and reflowed the amount beside it.
      A control that changes size when you press it is a control that feels loose. 168px holds
      `MOON / THIS COIN` and `TBILLx / US Treasury Bills` alike; anything longer truncates, which is
      the correct failure for a label whose full text is in the `title`.
    */
      className="doku-swap-plate group/plate flex w-[152px] shrink-0 items-center gap-3 rounded-doku-xl p-[5px] pr-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
    >
      {/*
      The mark, on a mount of its own.

      Two materials in one 48px object — a raised plate holding a seated mark — which is the whole
      reason this corner of the widget has any depth. It was a flat chip with a favicon on it, and a
      flat chip beside a 26px number is what makes a swap box look drawn rather than built.

      A *mount*, not the recess it used to be. `--mat-well-bg` is a near-black slab in both themes,
      which is fine behind a coloured disc and wrong behind everything else: half the marks in this
      registry are logos published on a transparent ground, so the plate drew a black box around
      somebody's trademark — most obviously in Lite Mode, where a 38px hole opened in a white key.
      The seat is neutral film now, which frames a mark in either theme and tints none of them. Same
      lesson as `.doku-token-pair-well` on the masthead.
    */}
      <span className="doku-swap-plate-well relative grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[12px]">
        {mark}
      </span>

      {/*
      The ticker, and the caption only when it says something the ticker did not.

      `quoteFromRow` resolves an asset's `name` to its own SYMBOL when the `/quotes` registry has
      not landed — a deliberate fallback, and a true statement about the asset. Rendered blindly it
      produced a two-line plate reading `MON` over `MON`: a second line whose whole job is to stop a
      ticker being a code, saying the code again. The comparison is case- and space-insensitive so
      `XAUt0` over `XAUT0` collapses too.

      Centred when it is alone, so the ticker does not sit high in a plate with a gap under it.
    */}
      <span
        className={cn(
          "flex min-w-0 flex-1 flex-col items-start",
          showCaption ? "gap-[6px]" : "justify-center"
        )}
      >
        <span className="w-full truncate text-left font-pixel text-[15px] uppercase leading-none tracking-[0.02em] text-ink">
          {ticker}
        </span>
        {showCaption && (
          <span className="w-full truncate text-left font-numeric text-[11px] uppercase leading-none tracking-[0.07em] text-ash">
            {caption}
          </span>
        )}
      </span>

      {/*
      Nothing inside the plate.

      It carried a pair of chevrons, because pressing it used to reverse the trade. That gesture is
      gone, so the glyph pointed at nothing — an icon inside a control that does not act is worse
      than no icon at all. What is left is what a plate is for: the token's mark, its ticker, and
      what it is. `onFlip` stays a prop so the plate is reusable where a direction *is* implied, and
      the cue is drawn only there.
    */}
      {onFlip && (
        <span
          aria-hidden
          className="doku-swap-plate-cue grid h-6 w-5 shrink-0 place-items-center rounded-[7px] text-mute"
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
            <path d="M7 4v16M7 20l-3.2-3.4M7 20l3.2-3.4M17 20V4M17 4l-3.2 3.4M17 4l3.2 3.4" />
          </svg>
        </span>
      )}
    </Tag>
  );
};

const OUTPUT_DISPLAY_TOKEN_DECIMALS = 4;

/** Cells in the curve band at the foot of the widget. */
const CURVE_SEGMENTS = 28;

/**
 * Raw quote units to a compact figure. The band is 40px tall; no decimals is all it can carry.
 *
 * Scaled by the QUOTE ASSET'S decimals, through `formatUnits` in one step. The version this
 * replaces divided by a hard-coded 1e15 and then by a thousand — right for an eighteen-decimal
 * MON market and a factor of a million out for six-decimal gold, on the one figure that says how
 * close a market is to graduating.
 */

/**
 * Gas held back from a "max" buy, in MON.
 *
 * Monad bills the gas LIMIT, not the gas used, so this is a limit times a fee rather than an
 * estimate of consumption. A curve buy measures around 131,000 gas on mainnet; the ceiling below
 * is generous against that and against a fee that moves between quoting and signing.
 *
 * It was a flat 0.01 MON, which is LESS than a buy actually reserves — so a max buy could not pay
 * for the transaction that made it. See `lib/chain/monad-reserve` for the other half of the same
 * failure, which is the protocol's 10 MON reserve.
 *
 * It applies to a MON-quoted market and to nothing else. Gas is paid in MON whatever the market is
 * priced in, so withholding a hundredth of a USDC or of a troy ounce from a buy protects nothing
 * and silently shrinks the trade — and against an eight-decimal wrapped bitcoin it would withhold
 * roughly a thousand dollars.
 */
const BUY_GAS_LIMIT = 400_000n;
const ASSUMED_MAX_FEE_PER_GAS = parseUnits("300", 9);
const GAS_HEADROOM = nativeGasHeadroom(BUY_GAS_LIMIT, ASSUMED_MAX_FEE_PER_GAS);

/**
 * MON's decimals.
 *
 * Eighteen, like a launched token's, and a DIFFERENT thing being counted — which is exactly why it
 * is named rather than reusing `BASE_DECIMALS`. The two are equal today and a line that uses one
 * for the other is wrong on purpose-built markets the moment either changes.
 */
const MON_DECIMALS = 18;

/**
 * How long to wait before measuring a route.
 *
 * A route quote is up to six candidate paths quoted twice each, so it is a dozen round trips — and
 * it runs while somebody is typing an amount, one keystroke at a time. Long enough that a typed
 * number settles first, short enough that it does not feel like waiting.
 */
const ZAP_QUOTE_DEBOUNCE_MS = 350;

/**
 * MON, for the moment before the registry answers.
 *
 * `/quotes` is a second request and it can be slow, or failing. A panel that renders a blank plate
 * where the asset being spent should be named is worse than one that names it without its mark —
 * so this carries what the plate needs and nothing else. It is never used to scale an amount: the
 * decimals a trade is built from come from the market row and from `MON_DECIMALS`.
 */
const MON_ASSET_FALLBACK: QuoteAsset = {
  id: "mon",
  symbol: "MON",
  name: "Monad",
  kind: "native",
  status: "live",
  decimals: MON_DECIMALS,
  address: NATIVE_QUOTE_ADDRESS,
  blurb: "The chain's own asset",
};

export default function SwapComponent({ market }: SwapComponentProps) {
  const { t } = translationFunction();
  const searchParams = useSearchParams();
  const { address, monBalance, status } = useDokuWallet();

  const curve = market.market.marketAddress as `0x${string}`;
  const token = market.market.tokenAddress as `0x${string}`;
  const quoteAsset = market.market.quote.asset as `0x${string}`;
  const nativeQuote = isNativeQuote(quoteAsset);

  /**
   * The market's own pool key — the RECORDED one wherever the indexer carries it.
   *
   * It is the last hop of a MON route into a graduated market, and taking its fee, spacing and
   * hook from this app's constants instead would be wrong for every market that graduated under
   * the older hook: the path would address a pool nobody ever initialised, quote zero, and read as
   * "no route" on a market that trades perfectly well.
   */
  const marketPoolKey = useMemo(
    () => poolKeyOf(token, quoteAsset, market.state.poolKey),
    [token, quoteAsset, market.state.poolKey]
  );

  /**
   * What this coin is called, and what it trades against, resolved the way every other surface
   * resolves it — including the QUOTE'S OWN DECIMALS, which every amount on this panel scales by.
   *
   * The widget used to label its fields with the raw emoji symbol, so a coin that reads as
   * "MOONSHOT PROTOCOL / $MOON" on the card it was clicked from became a rocket glyph here. Same
   * function, same answer, everywhere.
   */
  /**
   * The quote-asset registry, read here rather than a thousand lines down.
   *
   * It is needed in three places: the tickers for the addresses a ROUTE passes through, MON's own
   * row for the funding keys — and, now, `identityFor`, which is why it moved up.
   *
   * Without it `quoteFromRow` resolves the quote's `name` to its own SYMBOL and its `kind` to
   * `crypto`, both deliberate fallbacks for an address the catalogue has never heard of. Handing
   * them to the token plate meant MON described itself as `CRYPTO` in the trade panel while the
   * masthead — which does pass the registry — called the same asset a native one four hundred
   * pixels away. One page, two answers about the same token.
   */
  const { assets: quoteAssets } = useQuoteAssets();

  const identity = useMemo(
    () => identityFor(market.market, quoteAssets),
    [market.market, quoteAssets]
  );
  const quoteDecimals = identity.quote.decimals;
  const quoteSymbol = identity.quote.symbol;

  /**
   * Which venue, asked of the CURVE rather than of the indexer.
   *
   * Graduation is atomic on chain — the buy that fills the curve creates the pool in the same
   * transaction — but the indexer learns of the fill and of the pool from two different log
   * records, and between them it reports a market that is full with no pool. In that window this
   * panel offered a curve buy on a closed curve: quoted zero, showed the whole input as a refund,
   * kept the button lit, and reverted on every click. `readyToGraduate` is the same flag the
   * revert is guarded on, which makes this question and the contract's answer the same boolean.
   */
  const { data: readyOnChain } = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: "readyToGraduate",
    query: { refetchInterval: 15_000 },
  });
  /**
   * Whether the graduation actually HAPPENED — which a closed curve does not tell you.
   *
   * Asked only once the curve says it is full, and asked of the graduation contract rather than of
   * the curve, because "the raise is complete" is equally true of a market whose pool exists and
   * one whose pool was never created. The second case is real: graduation runs inside the filling
   * buy behind a swallow, so a buy carrying an ordinary gas limit into a transaction that also has
   * to create a pool leaves the market filled, closed and poolless.
   *
   * Polled, because the cure is a transaction anybody can send — including from another tab.
   */
  const { data: graduatedOnChain, refetch: refetchGraduated } = useReadContract({
    address: CONTRACTS.graduation,
    abi: graduationAbi,
    functionName: "graduated",
    args: [curve],
    query: { enabled: readyOnChain === true, refetchInterval: 15_000 },
  });
  const { venue, known: venueKnown } = chooseVenue({
    poolAddress: market.state.poolAddress,
    readyToGraduate: readyOnChain as boolean | undefined,
    graduated: graduatedOnChain as boolean | undefined,
  });
  const graduated = venue === "pool";
  /** Filled, closed, and with no pool to trade on until somebody finishes the job. */
  const stranded = isStranded(venue, venueKnown);

  const presetInputAmount =
    searchParams.get("buy") !== null ? searchParams.get("buy") : searchParams.get("sell");
  const presetIsValid =
    presetInputAmount !== null &&
    presetInputAmount !== "" &&
    !Number.isNaN(Number(presetInputAmount));

  const [isSell, setIsSell] = useState(searchParams.get("sell") !== null);

  /**
   * Which asset this trade is settled in — paid with on a buy, received on a sell.
   *
   * `quote` is the market's own asset, the default, and today's behaviour unchanged. `native` bolts
   * a Uniswap swap onto the same transaction: MON into the quote asset on the way to the curve, or
   * the curve's payout on to MON on the way back out — one signature instead of acquiring or
   * disposing of the quote asset separately.
   */
  const [payWith, setPayWith] = useState<SideAsset>("quote");
  const payOptions = useMemo(
    () =>
      sideAssetOptions({
        // The whole feature hangs off this. With no `NEXT_PUBLIC_ZAP_ROUTER` there is no contract,
        // the list comes back with one entry, the control renders nothing and every branch below
        // that mentions a zap is unreachable.
        routerConfigured: ZAP_ROUTER !== null,
        quoteAsset,
        isSell,
        venue,
        venueKnown,
      }),
    [quoteAsset, isSell, venue, venueKnown]
  );

  /**
   * The derived truth every branch below asks, rather than `payWith` itself.
   *
   * The selection is state and the options are a function of the market AND of the direction, so a
   * market that graduates on a router-less deployment — or a direction whose side of the route
   * graph is empty — has to withdraw the choice rather than leave a stale selection driving a
   * transaction the router would refuse.
   */
  const zapping = payWith === "native" && payOptions.includes("native");

  /**
   * The two sides of the trade, each in its OWN asset's units.
   *
   * `inputAmount` is raw units of whatever is being spent, which flips with the direction AND with
   * the pay-with choice: MON when zapping, the quote asset on an ordinary buy, the eighteen-decimal
   * token on a sell. Scaling both by one global was correct only while every market was priced in
   * MON — against six-decimal gold it typed a trillion-fold overstatement into the field.
   */
  const inputDecimals = isSell ? BASE_DECIMALS : zapping ? MON_DECIMALS : quoteDecimals;
  /*
    The OUTPUT flips with the choice too, and on the other side of the trade.

    A sell paid out in MON is quoted in wei, not in the market's quote asset — and against a
    six-decimal quote the two differ by a factor of a trillion, on the one figure that says what
    the seller walks away with. It reads as the market's own asset only when the seller is taking
    it; `zapping` is what says which.
  */
  const outputDecimals = isSell ? (zapping ? MON_DECIMALS : quoteDecimals) : BASE_DECIMALS;

  const [inputAmount, setInputAmount] = useState(() =>
    parseUnits(
      presetIsValid ? presetInputAmount! : "1",
      searchParams.get("sell") !== null ? BASE_DECIMALS : market.market.quote.decimals
    )
  );
  /**
   * Putting the selection back when the option is withdrawn under the trader.
   *
   * A market graduating mid-session removes MON as a way to pay, and the field's units change with
   * it — so the amount has to be restated at the same time. Without that, one MON in the box
   * becomes 1e18 raw units of a six-decimal quote: a trillion dollars, rendered perfectly.
   *
   * `inputDecimals` is already the NEW asset's by the time this runs, because `zapping` is derived
   * from the options rather than stored.
   *
   * It no longer has anything to do with a FLIP. MON used to be offered on a buy and never on a
   * sell, so changing direction always withdrew the option and this effect always fired; now it is
   * offered on both sides, and `flip` puts the choice back itself for the reason stated there. This
   * is left with the case it was written for: the option going away under a trader who did not
   * touch it — a market graduating mid-session on a deployment with no zap router, or the venue
   * read going unknown.
   */
  useEffect(() => {
    if (payOptions.includes(payWith)) return;
    setInputAmount((amount) => restateAmount(amount, MON_DECIMALS, inputDecimals));
    setPayWith("quote");
  }, [payOptions, payWith, inputDecimals]);

  const [submit, setSubmit] = useState<(() => Promise<void>) | null>(null);
  const [maxSlippage, setMaxSlippage] = useState(getMaxSlippageSettings().maxSlippage);

  const slippagePct = Number(maxSlippage) / 100;

  /**
   * The tolerance, clamped where it is set rather than where it is read.
   *
   * `0.1%` to `5%`. Both ends are real: below a tenth a normal fill reverts on the curve's own
   * movement, and above five the setting has stopped being protection — it is a blank cheque for
   * whatever the pool does between signing and landing. The value is persisted through
   * `utils/slippage`, so it survives the page the way it always has.
   */
  const commitSlippage = (pct: number) => {
    const bps = clampSlippageBps(Number.isFinite(pct) ? Math.round(pct * 100) : 100);
    setMaxSlippageMode("custom");
    persistMaxSlippage(bps);
    setMaxSlippage(bps);
  };

  const { data: tokenBalance } = useReadContract({
    address: token,
    abi: tokenAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) && status === "ready" },
  });

  /**
   * What the buyer has of the market's quote asset.
   *
   * `monBalance` is the native balance and answers for a MON market only. A USDC market's buyer is
   * spending USDC, and checking their MON balance would light the button for a trade they cannot
   * pay for — and refuse one they can.
   */
  const { data: quoteTokenBalance } = useReadContract({
    address: quoteAsset,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) && status === "ready" && !nativeQuote },
  });
  const quoteBalance = nativeQuote
    ? (monBalance ?? 0n)
    : ((quoteTokenBalance as bigint | undefined) ?? 0n);

  /**
   * What the buyer is actually spending, and whether that spend leaves the account in MON.
   *
   * Paying with MON on a USDC market spends MON, so the balance to check, the max button to size
   * and Monad's reserve rule all follow the pay-with choice rather than the market's quote asset.
   * Checking the USDC balance for a trade paid in MON would light the button for a trade the wallet
   * cannot fund and refuse one it can.
   */
  const payBalance = zapping ? (monBalance ?? 0n) : quoteBalance;
  /*
    SPENDING native, which is not the same question as "is MON involved".

    It was `nativeQuote || zapping`, and it was right for exactly as long as `zapping` could only
    mean a buy. On a sell MON is what comes OUT: the balance to check is the token's, nothing is
    withheld for gas from an amount that is not MON, and Monad's reserve rule has nothing to bite
    on. Every reader of this is already `!isSell`-guarded, so today this changes no behaviour at
    all — it stops the NAME being a lie, which is the state a wrong branch gets written from.
  */
  const paysNative = !isSell && (nativeQuote || zapping);

  const publicClient = usePublicClient();

  /**
   * The typed amount, held still long enough to be worth quoting.
   *
   * Only the zap needs this. The curve and the pool are single reads that wagmi and react-query
   * already coalesce; a route quote is up to twelve simulations, and firing that per keystroke is
   * how a text field becomes a load test.
   */
  const [debouncedSpend, setDebouncedSpend] = useState(inputAmount);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSpend(inputAmount), ZAP_QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [inputAmount]);

  /**
   * What the CURVE will pay for the tokens being sold, before anything is done with it.
   *
   * Hoisted above the route query, which is the only reason it sits here rather than beside the
   * buy's quote below. A curve sell paid out in MON has two legs and they are measured in that
   * order: the curve names a quote-asset payout, and only then can the swap that carries that
   * payout to MON be quoted on it. `quoteSellZapRoutes` says the same thing from the other end —
   * handing it the token amount quotes a route with the wrong asset and usually the wrong decimals
   * behind the number, and the result is a price that is plausible and wrong.
   */
  const sellQuote = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: "quoteSell",
    args: [inputAmount],
    query: { enabled: !graduated && isSell && inputAmount > 0n },
  });

  /**
   * That payout as one figure, `undefined` until the curve has answered.
   *
   * `undefined` rather than `0n`, and the distinction is load-bearing twice below: it is what keeps
   * the route query from firing on a payout nobody has been told yet, and what makes the plan say
   * "quoting" instead of "no route".
   */
  const sellQuoteOut = useMemo(() => {
    const data = sellQuote.data as readonly [bigint, bigint, bigint] | undefined;
    return data ? sellQuoteFrom(data).quoteOut : undefined;
  }, [sellQuote.data]);

  /**
   * The best route between MON and this market, measured at this trade's size and in the direction
   * it is going.
   *
   * `null` is a real answer and is rendered as one — see `zapPlan`. `enabled` is what keeps the
   * whole feature inert without a router: `zapping` cannot be true when `payOptions` has no
   * `native` in it, which it cannot have when `ZAP_ROUTER` is null.
   *
   * ## The key carries the direction, and on one road a second amount
   *
   * It was keyed on the venue, the pair and the raw spend. With MON now on both sides of the trade
   * that is not a unique description of anything: a buy of 1e18 and a sell of 1e18 on the same
   * market are two different routes — MON → quote and quote → MON are not one list reversed, see
   * `routesBetween` — and they would land on one cache entry and serve each other's answer.
   *
   * The curve sell needs one field more, because it is the only road quoted on a number the trader
   * did not type: the CURVE'S payout. Two different token amounts can quote the same payout and one
   * payout is all the route ever sees, so that figure — not the tokens — is what identifies this
   * measurement.
   */
  const zapRoute = useQuery({
    queryKey: [
      "zap-route",
      venue,
      quoteAsset,
      token,
      isSell ? "sell" : "buy",
      debouncedSpend.toString(),
      (isSell && !graduated ? (sellQuoteOut ?? 0n) : 0n).toString(),
    ],
    /*
      The curve sell waits for the curve.

      Its payout arrives a round trip after the keystroke, and firing while it is `undefined` hands
      the quoter `0n`, gets `null` back, and renders "the pools are too thin" about a trade nobody
      has asked about. Held here, `route` stays `undefined` and folds into `quoting` — which is the
      `undefined`-versus-`null` distinction the plans are built around, kept at the point where the
      two could first be confused.
    */
    enabled:
      zapping &&
      debouncedSpend > 0n &&
      Boolean(publicClient) &&
      (!isSell || graduated || (sellQuoteOut ?? 0n) > 0n),
    // Pool prices move with every trade, so a cached route quote is a stale price.
    staleTime: 0,
    queryFn: () => {
      /*
        Four roads, measured differently because they start and end in different places.

        A curve zap is quoted only as far as the market's QUOTE ASSET on a buy, and only from it on
        a sell — the curve is not a pool and cannot be walked by the quoter, so the leg it owns is
        quoted by the curve itself: `quoteBuy` below on a buy, `quoteSell` above on a sell. A
        graduated market is quoted all the way THROUGH its own pool in both directions, so its
        answer is already the figure the trader receives. Measuring a pool route only to the quote
        asset would hide the case that matters most: a route that is deep everywhere except the
        market's own pool.
      */
      if (isSell) {
        return graduated
          ? quotePoolSellZapRoutes(publicClient!, {
              quoteAsset,
              market: { token, poolKey: marketPoolKey },
              // The tokens themselves: the market's pool is the first hop, so there is no curve
              // payout in front of this one.
              amountIn: debouncedSpend,
            })
          : quoteSellZapRoutes(publicClient!, {
              quoteAsset,
              // What the CURVE will pay, never the tokens typed — see the note on the key above.
              // `enabled` is what guarantees this is a figure and not a fallback.
              amountIn: sellQuoteOut ?? 0n,
            });
      }
      return graduated
        ? quotePoolZapRoutes(publicClient!, {
            quoteAsset,
            market: { token, poolKey: marketPoolKey },
            amountIn: debouncedSpend,
          })
        : quoteZapRoutes(publicClient!, { quoteAsset, amountIn: debouncedSpend });
    },
  });

  /**
   * The router's own spend ceiling.
   *
   * Read so the panel can refuse an oversized zap in words, before the wallet opens. It moves on an
   * owner transaction rather than on a trade, so it is cached — and it is read rather than assumed,
   * because a ceiling this app believed in and the contract did not would refuse trades that work.
   */
  const zapCap = useQuery({
    queryKey: ["zap-cap", ZAP_ROUTER],
    // Curve only. The ceiling belongs to the ZapRouter, and a graduated market's MON trade does not
    // go near it — reading one there would be a limit this app invented.
    enabled: zapping && !graduated && Boolean(publicClient) && ZAP_ROUTER !== null,
    staleTime: 5 * 60_000,
    queryFn: () => readMaxZapValue(publicClient!, ZAP_ROUTER!),
  });

  /**
   * What reaches the CURVE, which is not what the trader typed when they are paying with MON.
   *
   * The curve prices in its own quote asset and knows nothing about the swap in front of it, so
   * every figure on the receipt below is quoted from the route's output. Zero while that output is
   * unknown, which disables the read rather than quoting a curve buy of nothing.
   */
  const curveInput = zapping ? (zapRoute.data?.amountOut ?? 0n) : inputAmount;

  /**
   * The quote comes from the curve itself.
   *
   * Every figure on the receipt below — output, fee, tax, refund — is what the contract says it
   * will do, not a reimplementation of its arithmetic in JavaScript. That copy would start correct
   * and drift, and a quote that disagrees with the fill reads as the protocol taking more than it
   * said.
   */
  const buyQuote = useReadContract({
    address: curve,
    abi: curveAbi,
    functionName: "quoteBuy",
    args: [curveInput],
    query: { enabled: !graduated && !isSell && curveInput > 0n },
  });

  /**
   * The pool quote, for a graduated market.
   *
   * A separate query because the quoter is not a `view` function — it performs the swap and
   * reverts with the answer — so it has to be simulated rather than read, and wagmi's
   * `useReadContract` will not do that.
   */
  const poolQuote = useQuery({
    queryKey: ["pool-quote", token, quoteAsset, isSell, inputAmount.toString()],
    // Not while paying with MON: the amount typed is then wei of MON, and quoting the pool with it
    // as though it were the market's own asset prices a trade nobody is making.
    enabled: graduated && !zapping && inputAmount > 0n && Boolean(publicClient),
    // Pool prices move with every trade, so a cached quote is a stale one.
    staleTime: 0,
    queryFn: async () =>
      isSell
        ? quotePoolSell(publicClient!, { token, quoteAsset }, inputAmount)
        : quotePoolBuy(publicClient!, { token, quoteAsset }, inputAmount),
  });

  /**
   * The receipt, read from the tuple the contract actually returns.
   *
   * `quoteBuy` returns FIVE values and `quoteSell` THREE. They returned four and two, and
   * `creatorTax` was inserted into both — so a destructure that still expects the old shape reads
   * the creator's charge as the refund on a buy, and never sees the refund at all. That is the
   * difference between "you will get some of this back" and "this market has graduated".
   * `buyQuoteFrom` and `sellQuoteFrom` name the fields once so no call site counts positions.
   */
  const quote = useMemo(() => {
    if (graduated) {
      /*
        Trading in MON, the route already went through the market's own pool — in front of it on a
        buy, behind it on a sell — so its answer IS the output and there is no second quote to
        combine it with. It is tokens one way and wei the other, which is why `outputDecimals` and
        the ticker beside the figure follow the same two conditions this branch does. `undefined`
        and `null` are both "no figure yet" here; `poolZapPlan` and `poolSellZapPlan` are what tell
        the trader which of the two it is.
      */
      if (zapping) {
        const out = zapRoute.data?.amountOut;
        if (out === undefined) return null;
        return { out, fee: 0n, tax: 0n, creatorTax: 0n, refund: 0n, closed: false };
      }
      if (poolQuote.data === undefined) return null;
      // The levy is skimmed inside the swap rather than quoted separately, and there is no launch
      // tax after graduation — reporting either here would be inventing a line item.
      return { out: poolQuote.data, fee: 0n, tax: 0n, creatorTax: 0n, refund: 0n, closed: false };
    }
    if (isSell) {
      /*
        Being paid in MON out of a LIVE curve, where the curve's own payout is not the answer.

        `quoteSell` names an amount of the market's quote asset, and on this path the seller never
        holds it: the swap behind the curve carries it on to MON in the same transaction, and the
        wei that swap returns are the only figure they receive. It is the same number
        `sellZapPlan` publishes as `nativeOut` — taken from the route here rather than from the
        plan because the plans are measured BELOW this memo, and the buy's is measured from it.

        It has to happen inside the memo. Converting downstream would leave every other reader of
        `quote.out` — the floor, the submit guard, `canSubmitTrade` — holding a quote-asset amount
        while the panel showed MON.
      */
      if (zapping) {
        const out = zapRoute.data?.amountOut;
        if (out === undefined) return null;
        return { out, fee: 0n, tax: 0n, creatorTax: 0n, refund: 0n, closed: false };
      }
      const data = sellQuote.data as readonly [bigint, bigint, bigint] | undefined;
      if (!data) return null;
      const q = sellQuoteFrom(data);
      return {
        out: q.quoteOut,
        fee: q.fee,
        tax: 0n,
        creatorTax: q.creatorTax,
        refund: 0n,
        closed: false,
      };
    }
    const data = buyQuote.data as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
    if (!data) return null;
    const q = buyQuoteFrom(data);
    return {
      out: q.baseOut,
      fee: q.fee,
      tax: q.antiSniperTax,
      creatorTax: q.creatorTax,
      refund: q.refund,
      // A closed curve quotes the whole input back rather than reverting. It is a state, not a
      // small trade — see `curveIsClosed`.
      closed: curveIsClosed(q, curveInput),
    };
  }, [
    graduated,
    zapping,
    zapRoute.data,
    poolQuote.data,
    isSell,
    buyQuote.data,
    sellQuote.data,
    curveInput,
  ]);

  // What the receipt has to say in words: see `receiptNotices`.
  const notices = useMemo(
    () =>
      receiptNotices({
        isSell,
        antiSniperTax: quote?.tax ?? 0n,
        curveInput,
        creatorFeePct: identity.creatorFeePct,
      }),
    [isSell, quote, curveInput, identity.creatorFeePct]
  );

  /**
   * Whether the route is still being measured, which includes the pause before it is asked.
   *
   * The debounce is part of "quoting", not part of "idle". Between a keystroke and the request the
   * panel is holding a figure that belongs to the previous amount, and presenting that as settled
   * is how somebody signs for a quote that was never theirs.
   */
  const zapQuoting = zapping && (zapRoute.isFetching || debouncedSpend !== inputAmount);

  const isLoading =
    zapQuoting ||
    (graduated
      ? !zapping && poolQuote.isFetching
      : isSell
        ? sellQuote.isFetching
        : buyQuote.isFetching);
  const outputAmount = quote?.out ?? 0n;

  /**
   * The tolerance, clamped on its way out of `localStorage`.
   *
   * The slippage box accepts up to 100% and the write path throws above 50%, because a 100%
   * tolerance is a floor of zero. That throw would happen HERE, while the panel renders — see
   * `zapSlippageBps`.
   */
  const slippageBps = zapSlippageBps(maxSlippage);

  /**
   * Everything about paying with MON, in one value: what to show, what to say, and the two floors.
   *
   * Meaningful only while `zapping`; every read of it below is guarded by that, and the plan is
   * computed unconditionally only so the hook order never changes with the pay-with choice.
   */
  const curvePlan = useMemo(
    () =>
      zapPlan({
        amountIn: inputAmount,
        quoting: zapRoute.isFetching || debouncedSpend !== inputAmount,
        route: zapRoute.data,
        baseOut: quote?.out,
        slippageBps,
        maximum: zapCap.data,
        quoteSymbol,
      }),
    [
      inputAmount,
      zapRoute.isFetching,
      zapRoute.data,
      debouncedSpend,
      quote?.out,
      slippageBps,
      zapCap.data,
      quoteSymbol,
    ]
  );

  /**
   * The same verdict for a graduated market, where the swap IS the trade.
   *
   * One leg, one floor, no ceiling — see `poolZapPlan`. Both plans are computed on every render
   * rather than one of them, so the hook order never moves when a market graduates mid-session.
   */
  const poolPlan = useMemo(
    () =>
      poolZapPlan({
        amountIn: inputAmount,
        quoting: zapRoute.isFetching || debouncedSpend !== inputAmount,
        route: zapRoute.data,
        slippageBps,
        quoteSymbol,
      }),
    [inputAmount, zapRoute.isFetching, zapRoute.data, debouncedSpend, slippageBps, quoteSymbol]
  );

  /**
   * The same two verdicts for a sell that walks away with MON — the buy's two, read backwards.
   *
   * `amountIn` is the market's TOKEN on both of them, which is the difference worth stating: on a
   * buy it is the MON being spent, and `sellZapPlan` documents at length why that makes the
   * router's ceiling uncheckable until the route has answered in wei.
   *
   * The curve's plan is the only one of the four that waits on a second quote. `quoteOut` is what
   * the curve will pay, and it reaches the plan as `undefined` until the curve says so — which the
   * plan renders as "quoting" rather than as a route that failed.
   */
  const curveSellPlan = useMemo(
    () =>
      sellZapPlan({
        amountIn: inputAmount,
        quoting: zapRoute.isFetching || debouncedSpend !== inputAmount,
        route: zapRoute.data,
        quoteOut: sellQuoteOut,
        slippageBps,
        maximum: zapCap.data,
        quoteSymbol,
      }),
    [
      inputAmount,
      zapRoute.isFetching,
      zapRoute.data,
      debouncedSpend,
      sellQuoteOut,
      slippageBps,
      zapCap.data,
      quoteSymbol,
    ]
  );

  const poolSellPlan = useMemo(
    () =>
      poolSellZapPlan({
        amountIn: inputAmount,
        quoting: zapRoute.isFetching || debouncedSpend !== inputAmount,
        route: zapRoute.data,
        slippageBps,
        quoteSymbol,
      }),
    [inputAmount, zapRoute.isFetching, zapRoute.data, debouncedSpend, slippageBps, quoteSymbol]
  );

  /**
   * Which of the four is this trade's, chosen on both axes.
   *
   * The venue alone stopped being enough the moment MON could be received as well as spent: a sell
   * measured by the buy's plan would check the router's MON ceiling against a token amount, print
   * the buy's "you would have to go and acquire" sentence when the route is thin, and bound the
   * trade with a floor in the wrong asset. All four are computed on every render rather than one of
   * them, so the hook order never moves when the direction or the venue does.
   */
  const plan = isSell
    ? graduated
      ? poolSellPlan
      : curveSellPlan
    : graduated
      ? poolPlan
      : curvePlan;

  /**
   * The trade the button will send when it is paid for in MON, or `undefined` for every other
   * trade — which is the ordinary path and the only path on a market priced in MON.
   *
   * Built here rather than in the button so the two roads are chosen once, beside the plans that
   * measured them. A graduated market carries no router address at all: its buy is one swap
   * through Uniswap's own, so a missing `NEXT_PUBLIC_ZAP_ROUTER` cannot withhold it.
   */
  const zapIntent = useMemo((): ZapIntent | undefined => {
    if (!zapping || !zapRoute.data) return undefined;
    /*
      The sell's two, built from the sell's own plans and carrying the sell's own floors.

      `path` is the same field on all four and a different route on each — quoted in the direction
      being traded, by the query above. It is never one list reversed: see `routesBetween`.
    */
    if (isSell) {
      if (graduated) {
        if (poolSellPlan.kind !== "ready") return undefined;
        return {
          venue: "pool",
          direction: "sell",
          path: zapRoute.data.pathKeys,
          minNativeOut: poolSellPlan.minNativeOut,
        };
      }
      if (curveSellPlan.kind !== "ready" || ZAP_ROUTER === null) return undefined;
      return {
        venue: "curve",
        direction: "sell",
        router: ZAP_ROUTER,
        path: zapRoute.data.pathKeys,
        minQuoteOut: curveSellPlan.minQuoteOut,
        minNativeOut: curveSellPlan.minNativeOut,
      };
    }
    if (graduated) {
      if (poolPlan.kind !== "ready") return undefined;
      return {
        venue: "pool",
        direction: "buy",
        path: zapRoute.data.pathKeys,
        minBaseOut: poolPlan.minBaseOut,
      };
    }
    if (curvePlan.kind !== "ready" || ZAP_ROUTER === null) return undefined;
    return {
      venue: "curve",
      direction: "buy",
      router: ZAP_ROUTER,
      path: zapRoute.data.pathKeys,
      minQuoteOut: curvePlan.minQuoteOut,
      minBaseOut: curvePlan.minBaseOut,
      expectedQuoteOut: curvePlan.quoteOut,
    };
  }, [zapping, isSell, graduated, zapRoute.data, poolPlan, curvePlan, poolSellPlan, curveSellPlan]);

  /**
   * The floor the direct path signs, through the same clamp the zap uses.
   *
   * This was its own arithmetic on the RAW stored setting. The box clamped what it wrote and the
   * zap clamped what it read, and this — the floor on every ordinary curve and pool trade — clamped
   * nothing, so a wallet whose storage still held 100% signed `minBaseOut = 0` on every buy.
   */
  const minOutputAmount = useMemo(
    () => minimumOut(outputAmount, maxSlippage),
    [outputAmount, maxSlippage]
  );

  const ownedBalance = (tokenBalance as bigint | undefined) ?? 0n;
  /**
   * The most that can be spent on a buy.
   *
   * On an ERC-20 market paid in its own asset it is the whole token balance: gas is paid in MON, so
   * nothing is withheld from the quote. Whenever the spend is in MON — a MON market, or any market
   * paid for with MON through the zap — it is gas AND the protocol's 10 MON reserve, which is the
   * threshold a balance-decrementing transaction may not end below. A zap spends MON like any other
   * transaction, so the same rule applies to it; see `lib/chain/monad-reserve`.
   */
  const availableQuote = useMemo(() => {
    if (!paysNative) return payBalance;
    return maxNativeSpend({ balance: payBalance, gas: GAS_HEADROOM });
  }, [paysNative, payBalance]);

  /**
   * Whether this particular trade lands under Monad's reserve, and therefore needs the chain's
   * emptying exemption to go through at all.
   *
   * Surfaced rather than blocked. Whether the exemption applies depends on what this wallet did in
   * the last second or two, which nothing here can see, so refusing would refuse trades the chain
   * accepts. Saying so turns an unexplained revert into a thing the trader can act on.
   */
  const reserve = useMemo(() => {
    if (!paysNative || isSell || !address) return "safe" as const;
    return reserveVerdict({ balance: payBalance, spend: inputAmount, gas: GAS_HEADROOM });
  }, [paysNative, isSell, address, payBalance, inputAmount]);

  /**
   * How much short of the reserve this trade lands — the number, not the rule.
   *
   * "Keep 10 MON spare" is arithmetic over three figures the trader cannot see: their balance, the
   * amount in the field, and a gas reservation nobody quotes them. Every one of the three moves as
   * they type. `Add 9.9643 MON` is that sum already done, and it is the same sentence the launch
   * form gives, so the two surfaces do not describe one chain rule two different ways.
   */
  const reserveGap = useMemo(
    () =>
      reserve === "emptying"
        ? reserveShortfall({ balance: payBalance, spend: inputAmount, gas: GAS_HEADROOM })
        : 0n,
    [reserve, payBalance, inputAmount]
  );

  const sufficientBalance = useMemo(() => {
    if (!address) return false;
    return isSell ? ownedBalance >= inputAmount : payBalance >= inputAmount;
  }, [address, isSell, ownedBalance, payBalance, inputAmount]);

  /* `avgPrice` and the curve price impact were computed here for two receipt rows that no longer
     exist — see the note on the statement slip. `price-impact.ts` still carries the arithmetic if
     either figure is ever wanted back. */

  const inputIsEmpty = inputAmount === 0n;

  /**
   * Switching sides.
   *
   * Buy and Sell call this. The plates no longer do: with the direction stated in two words at the
   * top of the panel, a token plate that silently reverses the trade when pressed is a second,
   * unlabelled control for a decision that already has a labelled one — and it sits beside the
   * amount, which is where people click to type.
   */
  const flip = () => {
    setInputAmount(outputAmount);
    setIsSell((v) => !v);
    /*
      And the asset choice goes back to the market's own, because nothing else will put it back.

      The effect above restates the amount and clears the choice when the option is WITHDRAWN, and
      that used to cover this: MON was offered on a buy and never on a sell, so every flip withdrew
      it. It is offered on both sides now, so the effect does not fire, and `payWith` would survive
      the flip pointing at a field that has changed asset under it — the amount carried across is
      MON on one side of the flip and the market's token on the other, both eighteen decimals, both
      rendering perfectly, and nothing on screen to say which one you are looking at.
    */
    setPayWith("quote");
  };

  /**
   * Switching what you pay with keeps the NUMBER, not the raw amount — on a BUY.
   *
   * Somebody who typed 5 and then chose MON meant five MON. Leaving the raw value alone turns that
   * into five millionths of one — a field that goes on rendering a plausible number while meaning
   * something a million times smaller.
   *
   * On a SELL the restatement is not merely unnecessary, it is the same bug pointed the other way.
   * The choice names what the seller is PAID IN; the field above it holds the market's own token
   * either way, and its decimals do not move. Restating would rescale a correct token amount by the
   * ratio between MON and the quote asset — silently dividing a sell by a million on six-decimal
   * gold — to express a change that happened on the other side of the trade.
   */
  const changePayWith = (next: SideAsset) => {
    if (next === payWith) return;
    if (!isSell) {
      setInputAmount(
        restateAmount(inputAmount, inputDecimals, next === "native" ? MON_DECIMALS : quoteDecimals)
      );
    }
    setPayWith(next);
  };

  /* Native MON's own registry row, for its mark on the funding keys. `null` while `/quotes` is in
     flight, which the key handles by drawing a monogram rather than an empty square. */
  const nativeAsset = useMemo(
    () => quoteAssets.find((a) => a.id === "mon" || a.kind === "native") ?? null,
    [quoteAssets]
  );

  /*
   * What to write under a ticker when the registry has not named the asset.
   *
   * `quoteFromRow` resolves `name` to the SYMBOL for an address the catalogue has never heard of —
   * a true statement, and deliberately not an invented company name. `TokenPlate` then drops the
   * caption rather than printing `MON` over `MON`, which left the ticker alone in a 168px plate
   * with eighty pixels of nothing beside it: the reason this control read as unfinished.
   *
   * The asset's CLASS is the other true thing the registry always has. `Native asset`, `Stablecoin`,
   * `Tokenized equity` — it is what the second line was for in the first place, and it is never
   * absent, so the plate is always the same object rather than sometimes one line and sometimes two.
   */
  const assetCaption = (asset: { symbol: string; name: string; kind: QuoteAssetKind }) =>
    asset.name.trim().replace(/\s+/g, "").toUpperCase() === asset.symbol.trim().toUpperCase()
      ? QUOTE_ASSET_KIND_NAMES[asset.kind]
      : asset.name;

  const coinPlate = (
    <TokenPlate
      ticker={identity.ticker}
      caption={t("This coin")}
      mark={
        <CoinMark
          logo={identity.logo}
          ticker={identity.ticker}
          name={identity.name}
          size={30}
          className="rounded-[9px]"
        />
      }
    />
  );
  const quotePlate = (
    <TokenPlate
      ticker={displaySymbolText(identity.quote)}
      caption={assetCaption(identity.quote)}
      mark={<AssetIcon asset={identity.quote} size={30} className="rounded-[9px]" />}
    />
  );

  /**
   * MON's own plate, for a buy that is paid in MON on a market priced in something else.
   *
   * Preferred from the registry, which carries the mark, and falling back to a plain row rather
   * than to nothing: the plate beside the amount is what says which asset that amount is in, and
   * showing the market's quote there while MON is being spent is the exact confusion a swap widget
   * exists to prevent.
   */
  const monAsset = useMemo(
    () => nativeQuoteAsset(quoteAssets) ?? MON_ASSET_FALLBACK,
    [quoteAssets]
  );
  const monPlate = (
    <TokenPlate
      ticker={displaySymbolText(monAsset)}
      caption={assetCaption(monAsset)}
      mark={<AssetIcon asset={monAsset} size={30} className="rounded-[9px]" />}
    />
  );

  const inputPlate = isSell ? coinPlate : zapping ? monPlate : quotePlate;
  /* `receivePlate` went with the second field: what comes back is named by the ticker beside the
     figure in the slip now, which is the whole of what that plate was saying. */

  /* `priceImpact` and the spot price it needed lived here. They were read by one row of the
     receipt, and the receipt is gone — see the note where the slippage control replaced it. */

  /*
   * The quote's dollar price, from the registry rather than from the market row.
   *
   * A market row carries its quote's address, decimals and symbol and no price — that is a registry
   * fact on its own refresh clock, which is why the masthead looks it up the same way. Without this
   * the dollar ladder silently fell back to quote units on every market, which looks exactly like
   * the feature not existing.
   *
   * The registry itself is already read above, for the route's asset names.
   */
  const quoteUsd = useMemo(() => {
    const key = (market.market.quote.id ?? market.market.quote.asset ?? "").toLowerCase();
    const match = quoteAssets.find(
      (a) => a.id.toLowerCase() === key || (a.address ?? "").toLowerCase() === key
    );
    const price = match?.usdPrice;
    return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  }, [quoteAssets, market.market.quote.id, market.market.quote.asset]);
  /*
   * Dollars whenever there is a rate, the quote asset when there is not.
   *
   * There was a pair of keys here to switch between the two. It was a control for a preference
   * nobody has: the ladder is a shortcut for "about this much money", and the only reason to count
   * it in MON instead is that the market's quote has no price to convert through — which is not a
   * choice, it is a fact about the market, and the panel can read it without asking.
   */
  /* `spotPrice` and `priceImpact` were computed here for a receipt row that no longer exists — see
     the note where the statement slip replaced it. `price-impact.ts` still carries the arithmetic
     if the figure is ever wanted back. */

  /*
   * The ladder is counted in dollars whenever the asset being spent has a price.
   *
   * `zapping` — a buy funded with MON on a market priced in something else — spends MON, so the
   * rate that converts `$20` into an amount is MON's and not the market quote's. Getting that wrong
   * would fill the field with the right number of the wrong asset.
   */
  const payUsd = zapping ? (monAsset.usdPrice ?? null) : quoteUsd;
  const usdMode = !isSell && payUsd !== null && payUsd > 0;

  const quickAmounts: { label: string; value: bigint }[] = isSell
    ? [
        { label: "25%", value: ownedBalance / 4n },
        { label: "50%", value: ownedBalance / 2n },
        { label: "75%", value: (ownedBalance * 3n) / 4n },
        { label: "Max", value: ownedBalance },
      ]
    : usdMode
      ? [5, 10, 20, 100, 500].map((usd) => ({
          label: `$${usd}`,
          /* Six places of the quote asset, then parsed at its real decimals — enough precision for
             a dollar amount in an asset worth thousands, and it never produces more digits than
             `parseUnits` will accept for a six-decimal quote. */
          value: parseUnits((usd / (payUsd as number)).toFixed(6), inputDecimals),
        }))
      : [
          // Whole units of the QUOTE asset — 0.1 USDC, 0.1 troy ounces, 0.1 MON. Parsed at that
          // asset's own decimals, so "0.1" means the same thing on the label and on the wire.
          { label: "0.1", value: parseUnits("0.1", inputDecimals) },
          { label: "0.5", value: parseUnits("0.5", inputDecimals) },
          { label: "1", value: parseUnits("1", inputDecimals) },
          { label: "5", value: parseUnits("5", inputDecimals) },
          { label: "Max", value: availableQuote },
        ];

  /** A quote-asset amount for the receipt. Scaled by the QUOTE'S decimals, never by a global. */

  /**
   * The recessed field both amounts sit in — one recipe, so input and output are a matched pair.
   *
   * The literal near-black gradient it used to carry is gone: it was correct on the dark stage and
   * a grey slab in Lite Mode, on a widget whose whole job is to look trustworthy in both. The well
   * is `--mat-well-bg`, the same recess the market card mounts a logo in and the runner board sets
   * its symbols in, so the field is made of the product's own material rather than of one page's
   * colour.
   */
  const fieldShell = "doku-swap-field flex flex-col gap-3 rounded-[16px] px-4 py-3.5";

  return (
    <div className="flex w-full flex-col">
      {/*
        ---- The header rail --------------------------------------------------------------

        Three facts in one 44px band: that this is the trade panel, which venue the trade will go
        through, and the one setting that changes what it costs. The venue is a *chip* rather than
        an eyebrow — "Bonding curve" and "Pool" are two different contracts with different fee
        behaviour, which makes it a state worth reading, not a caption.
      */}
      {/*
        ---- The header -------------------------------------------------------------------

        One word. It carried two more things and neither earned its place: a venue chip reading
        "Bonding curve" or "Pool", which is the *contract* this trade routes through — true, and a
        piece of protocol trivia at the top of the one panel where somebody is deciding how much to
        spend — and a slippage gear as far from its consequence as it could be put. The venue still
        shows where it means something: the fee line, the spec sheet, and the state plate on the
        masthead. The slippage control is at the foot of this panel, next to the button it protects.
      */}
      <div className="doku-swap-head flex items-center gap-3 px-4 py-3.5 sm:px-5">
        <span className="font-ui font-semibold text-[13px] uppercase leading-none tracking-[0.06em] text-ink">
          {t("Trade")}
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 pb-4 pt-3.5 sm:px-5 sm:pb-5">
        {/*
          ---- Buy or sell, decided first -------------------------------------------------

          This was a swap: two fields with a rotation key on the seam between them, and the
          direction of the trade was whatever the last press of that key left behind. That is the
          right shape for an exchange, where the question is genuinely "which of these two do I want
          more of". It is the wrong shape here. Somebody opening a coin's page has already decided
          which coin; the only question is which side of it they are on, and a rotation key answers
          that by implication — you work out that you are selling because the plate on top says the
          coin's ticker.

          So the direction is a control, first, in the two words people actually use. Buy carries
          the brand; Sell carries the loss hue. Nothing else in the panel is tinted, so which side
          you are on is legible from across the room rather than by reading two token plates.
        */}
        {/*
          Two keys in a tray, at the size of the decision they carry.

          They were 40px segmented tabs in the app's small-control voice — the same object a chart
          uses to switch between 1H and 1D. This is not that: it is the first and only question this
          panel asks, and on a memecoin page the answer is "buy" nine times out of ten. So they are
          set in the display face, and the chosen one takes its own colour — brand for buy, the loss
          hue for sell, the pair every trader reads without being taught.

          ## One height for the whole panel

          48px, and so is the action key at the foot, and so is the connect key that stands in for
          it before a wallet is attached. It was 44 / 52 / 32: the mode keys, the button that signs,
          and a navigation-bar control borrowed for the slot in between — three different vertical
          rhythms in one 300px column, which is what makes a panel read as assembled out of parts
          from elsewhere. The hierarchy that used to be carried by *size* is carried by material
          instead: the mode keys are tinted, the action key is filled paint.

          ## What was wrong with the last build

          Three things, and they compounded. The rim was the brand at 55% over a face at 22%, so the
          edge was three times the weight of the fill and the key read as a *neon outline* — the
          look of a focus ring, on a control that is not focused. The foot was shaded in green
          rather than black, so instead of sitting on the tray it hazed into it. And the radii did
          not nest: a 12px key inside a 16px tray with 6px of padding needs a 10px corner, and at 12
          the key's corner ran proud of the tray's, which is the small wrongness that makes a
          control look assembled rather than machined.

          Now the fill carries the colour and the rim only closes it, the foot is in shadow like
          every other key in this product, and the corners are concentric.

          The arrows are not decoration. Direction is the whole subject of this control, and up and
          down are how it is written everywhere money moves — they carry it before the words are
          read, and they give the unchosen side a shape rather than leaving it a word floating in an
          empty half of the tray.
        */}
        <div
          role="group"
          aria-label={t("Trade direction")}
          className="doku-seg doku-trade-tray grid grid-cols-2 gap-1.5 rounded-[16px] p-1.5"
        >
          {[
            { sell: false, label: t("Buy") },
            { sell: true, label: t("Sell") },
          ].map((side) => {
            const on = isSell === side.sell;
            return (
              <button
                key={side.label}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  if (isSell !== side.sell) flip();
                }}
                className={[
                  "inline-flex h-12 items-center justify-center gap-2 rounded-[10px]",
                  "font-ui font-semibold text-[15px] uppercase leading-none tracking-[0.08em]",
                  /* No `transition-*` or `active:*` here. `.doku-trade-key` declares the
                     `transition` SHORTHAND, and every rule in `global.css` is later in source
                     order than `@tailwind utilities` at equal specificity — so a `duration-150`
                     written here never applied. The press comes from the global
                     `button:active:not(:disabled)` rule, which `translateY`s by the same pixel. */
                  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
                  on
                    ? side.sell
                      ? "doku-trade-key doku-trade-key--sell"
                      : "doku-trade-key doku-trade-key--buy"
                    : "doku-trade-key doku-trade-key--off",
                ].join(" ")}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="3.5"
                  strokeLinejoin="round"
                  aria-hidden
                  className="shrink-0"
                >
                  {side.sell ? <path d="M12 18 4.5 7h15z" /> : <path d="M12 6l7.5 11h-15z" />}
                </svg>
                {side.label}
              </button>
            );
          })}
        </div>

        {/*
          ---- Which asset the trade is settled in ------------------------------------------

          Above the fields rather than inside one, because it changes what the field beneath it
          MEANS: on a buy the units, the balance, the presets and the max all follow it; on a sell
          it is the figure in the slip and the floor under it that move. Renders nothing at all
          unless there are two real choices, which on a deployment with no zap router there never
          are.

          Labelled by DIRECTION, because the same control is two questions. On a buy MON is what
          you hand over; on a sell it is what you are handed back, and "Pay with MON" over a field
          holding the coin you are selling describes a trade that is not on offer.
        */}
        <PayWithControl
          options={payOptions}
          value={payWith}
          onChange={changePayWith}
          quoteSymbol={quoteSymbol}
          quoteAsset={identity.quote}
          nativeAsset={nativeAsset}
          label={isSell ? t("Receive in") : t("Pay with")}
          /* The verb on the keys themselves. It was the fixed string "Buy using", which on a sell
             offered to buy with the asset you are being paid in. */
          verb={isSell ? t("Receive in") : t("Buy using")}
          nativeHint={
            isSell
              ? t("This market's asset is swapped into MON in the same transaction")
              : t("MON is swapped into this market's asset in the same transaction")
          }
        />

        {/*
          ---- The two amounts ------------------------------------------------------------

          One stack, no key between them. The rotation key that used to sit on the seam is what the
          Buy/Sell control above replaced — and with it goes a 44px row, a hairline and a gesture
          that had to be explained.
        */}
        <div className="flex flex-col gap-1.5">
          {/* ---- What you put in --------------------------------------------------------- */}
          <div className={fieldShell}>
            <div className="flex items-center justify-between gap-3">
              <span className={fieldLabel}>{isSell ? t("You sell") : t("You pay")}</span>
              {/*
                The balance, as a control rather than a caption.

                It was `(Balance: 1.2345)` in parentheses beside the label — a fact you were left to
                act on by typing. Here the figure is the button: pressing it fills the field with
                everything you can spend, which is the single most-used action in any swap widget.
                On a buy that is the balance minus gas AND minus Monad's 10 MON reserve, which is
                why it is not simply the balance — see `lib/chain/monad-reserve`.
              */}
              {address && (
                <button
                  type="button"
                  onClick={() => setInputAmount(isSell ? ownedBalance : availableQuote)}
                  className="doku-swap-balance group/bal inline-flex shrink-0 items-center gap-1.5 rounded-doku-lg px-2 py-1 font-numeric text-[11.5px] leading-none text-mute focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku"
                >
                  <span className={sufficientBalance ? "text-ash" : "text-loss-ink"}>
                    {/*
                      The same rule the receipt's quote amounts used before those rows were culled,
                      and the same bug if it is broken: `toFixed(4)` on an
                      eight-decimal balance shows a real holding of 0.00005 WBTC as `0.0000`, while
                      the MAX button beside it sets a non-zero amount. A balance that reads zero
                      next to a button that spends it is the worst version of this.
                    */}
                    {formatAssetAmount(isSell ? ownedBalance : payBalance, inputDecimals, {
                      minPlaces: 4,
                    })}
                  </span>
                  <span className="font-semibold uppercase tracking-[0.1em] text-doku-ink">
                    {t("Max")}
                  </span>
                </button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3">
              <InputNumeric
                className={inputAndOutputStyles}
                /* Names the field for what it is on THIS panel — the amount being spent, in the
                   asset the direction implies — rather than the component's generic default. */
                aria-label={
                  isSell
                    ? `Amount of ${identity.ticker} to sell`
                    : `Amount of ${zapping ? monAsset.symbol : quoteSymbol} to spend`
                }
                value={inputAmount}
                onUserInput={(v) => setInputAmount(v)}
                onSubmit={() => (submit ? submit() : {})}
                decimals={inputDecimals}
              />
              {inputPlate}
            </div>
          </div>

          {/*
            There is no second field.

            "You receive" was a 26px figure in a box the same size as the one above it — two fields
            of equal weight for one number you type and one you are told. It is a line of the
            statement now, in the slip under the presets, which takes about ninety pixels off the
            panel and puts the figure beside the floor it is checked against.
          */}
        </div>

        {/* ---- The presets, and what they are counted in ---------------------------------- */}
        <div className="flex items-center gap-1.5">
          <div
            className="grid flex-1 gap-1.5"
            style={{ gridTemplateColumns: `repeat(${quickAmounts.length}, minmax(0, 1fr))` }}
          >
            {quickAmounts.map(({ label, value }) => (
              <button
                key={label}
                type="button"
                onClick={() => setInputAmount(value)}
                className="doku-swap-preset h-9 rounded-[10px] font-numeric text-[13px] font-semibold leading-none text-ash focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-doku"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/*
          ---- The statement ----------------------------------------------------------------

          One recessed slip carrying the three things that are true of the trade as configured: what
          comes back, the floor it may not fall below, and the tolerance that sets that floor. The
          panel used to answer this with a seven-row receipt above the button and a gear in the
          header; both are here now, in the order they are read, on a surface that is visibly not a
          control — pressed into the panel rather than standing on it.

          The tolerance is presets plus a box. Three values cover almost every trade and the box is
          for the rest, and both are bounded at five percent: past that this has stopped protecting
          anybody, and a widget that offers fifty is a widget that will one day take fifty.
        */}
        <dl className="doku-swap-receipt mt-1 flex flex-col rounded-doku-xl px-3.5 py-1">
          <div className="doku-swap-receipt-row flex items-baseline gap-2.5 py-2.5">
            <dt className="shrink-0 font-ui text-[13px] leading-none text-ash">
              {t("You receive")}
            </dt>
            <span aria-hidden className="h-px min-w-3 flex-1 bg-[var(--film-2)]" />
            <dd
              className="min-w-0 truncate text-right font-numeric text-[15px] font-semibold leading-none tabular-nums text-ink transition-opacity duration-200"
              style={{ opacity: isLoading ? 0.45 : 1 }}
            >
              {inputIsEmpty ? (
                "—"
              ) : (
                <span className="inline-flex items-baseline gap-1.5">
                  <FormattedNumber
                    value={Number(formatUnits(outputAmount, outputDecimals))}
                    decimals={OUTPUT_DISPLAY_TOKEN_DECIMALS}
                  />
                  {/* The unit the figure beside it is counted in, on the same two conditions
                      `outputDecimals` is: a sell settled in MON says MON, and saying the market's
                      quote there would name the one asset this trade deliberately does not end in. */}
                  <span className="text-[0.72em] font-medium text-mute">
                    {isSell ? (zapping ? monAsset.symbol : quoteSymbol) : identity.ticker}
                  </span>
                </span>
              )}
            </dd>
          </div>

          {/*
            The route is not a row any more.

            `Route`, `Route impact` and `Swap delivers` were three lines of small grey type
            describing the MACHINERY of a MON-funded buy — which pools it crosses, what the swap leg
            costs, what the curve is handed in between. All true, and none of it a number the buyer
            can act on: the size was chosen two controls up, there is no lever here to move any of
            them with, and the only figures that bound the trade are the two directly below —
            what arrives, and the floor it may not fall through.

            Three rows of mechanism above those two made the panel read as a disclosure document
            and pushed the floor — the row that actually protects somebody — to the bottom of a
            list people stop reading. `You receive`, `Minimum after slippage` and `Max slippage` are
            the trade.

            What is NOT dropped is the protection. A route too thin or too large to serve still
            takes over the band above the button (`unavailable` / `over-cap`), the min-out floor is
            still signed and still reverts the trade beneath it, and a route whose impact is
            genuinely severe still says so — once, below, as a sentence rather than as a permanent
            readout. A number nobody can act on is noise; a number that changes what the next click
            should be is not.
          */}
          {zapping && plan.kind === "ready" && impactSeverity(plan.impactBps) === "high" && (
            <p role="status" className="py-2.5 font-ui text-[12px] leading-snug text-loss-ink">
              {/* Both directions, because this sentence renders whenever a ZAP is severe and a
                  zap is no longer buy-only. Told on a sell that "most of what you PAY is your own
                  size" and to "BUY less", a seller is being described somebody else's trade — and
                  the asset named is the one they would TAKE instead of MON, not one they pay
                  with. Same measurement, same threshold, the reader's own side of it. */}
              {t("This trade moves the swap price by")} {formatImpactBps(plan.impactBps)}
              {isSell
                ? t(" — most of what you get back is your own size. Take ")
                : t(" — most of what you pay is your own size. Pay with ")}
              {quoteSymbol}
              {isSell ? t(" instead, or sell less.") : t(", or buy less.")}
            </p>
          )}

          {/*
            Two charges, as sentences, by the same rule the route rows were dropped under: a number
            that changes what the next click should be is not noise. Both are already inside
            `You receive`; these say why that figure is what it is.

            The anti-sniper tax is up to half of a buy in a market's first seconds and is avoided
            by waiting — the quote has always carried it and nothing showed it. A creator tax is a
            stranger's charge on every buy AND sell, stated on the masthead as part of one "Fees"
            figure and nowhere near the button.
          */}
          {notices.antiSniperPct !== null && (
            <p role="status" className="py-2.5 font-ui text-[12px] leading-snug text-loss-ink">
              {`${notices.antiSniperPct}% ${t("of this buy is the anti-sniper tax: it is burned, not paid to anyone, and you get no coins for it. It falls to zero moments after launch — waiting avoids it.")}`}
            </p>
          )}
          {notices.creatorTaxPct !== null && (
            <p role="status" className="py-2.5 font-ui text-[12px] leading-snug text-mute">
              {`${t("This coin's creator takes")} ${notices.creatorTaxPct}% ${isSell ? t("of every sell") : t("of every buy")}${t(", and the same on the way back, on top of the 1% trade fee. It is already out of the figure above.")}`}
            </p>
          )}

          <div className="doku-swap-receipt-row flex items-baseline gap-2.5 py-2.5">
            <dt
              title={t("The trade reverts below this")}
              className="shrink-0 font-ui text-[13px] leading-none text-ash"
            >
              {t("Minimum after slippage")}
            </dt>
            <span aria-hidden className="h-px min-w-3 flex-1 bg-[var(--film-2)]" />
            <dd className="min-w-0 truncate text-right font-numeric text-[13px] font-semibold leading-none tabular-nums text-ink">
              {inputIsEmpty ? (
                "—"
              ) : (
                <FormattedNumber
                  value={Number(formatUnits(minOutputAmount, outputDecimals))}
                  decimals={OUTPUT_DISPLAY_TOKEN_DECIMALS}
                />
              )}
            </dd>
          </div>

          <div className="doku-swap-receipt-row flex items-center gap-2.5 py-2.5">
            {/* "Max slippage", not "Slippage". The row holds a ceiling the trader sets, not a
                measurement of what the trade will suffer — and the figure directly above it,
                `Minimum after slippage`, is what that ceiling produces. One of the two had to say
                which it was. */}
            <dt className="shrink-0 font-ui text-[13px] leading-none text-ash">
              {t("Max slippage")}
            </dt>
            <dd className="ml-auto flex shrink-0 items-center gap-1.5">
              {[1, 3, 5].map((pct) => (
                <button
                  key={pct}
                  type="button"
                  aria-pressed={Math.abs(slippagePct - pct) < 0.001}
                  data-selected={Math.abs(slippagePct - pct) < 0.001}
                  onClick={() => commitSlippage(pct)}
                  className={[
                    "doku-pair-key h-7 rounded-doku-lg px-2 font-numeric text-[11.5px] font-semibold leading-none",
                    Math.abs(slippagePct - pct) < 0.001 ? "text-doku-ink" : "text-mute",
                  ].join(" ")}
                >
                  {`${pct}%`}
                </button>
              ))}

              <span className="doku-swap-slip-box flex shrink-0 items-center gap-0.5 rounded-doku-lg px-2 py-1">
                <input
                  type="number"
                  inputMode="decimal"
                  min={Number(MIN_SLIPPAGE_BPS) / 100}
                  max={Number(MAX_UI_SLIPPAGE_BPS) / 100}
                  step={0.1}
                  value={slippagePct}
                  onChange={(e) => commitSlippage(Number(e.target.value))}
                  aria-label={t("Max slippage")}
                  className="w-[34px] border-0 bg-transparent p-0 text-right font-numeric text-[12.5px] font-semibold leading-none tabular-nums text-ink outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="font-numeric text-[11.5px] font-semibold leading-none text-mute">
                  %
                </span>
              </span>
            </dd>
          </div>
        </dl>

        {/*
          The closed curve, said out loud.

          `quoteBuy` on a filled curve does not revert — it hands the whole input back as `refund`
          and quotes nothing out. Rendered as numbers that is a zero-output trade, so the panel
          showed 0.0000 with the button lit and reverted `CurveClosed()` on every click. It is a
          state, and the only thing to say about it is that the market moved.
        */}
        {quote?.closed && !stranded && (
          <p
            role="status"
            className="doku-token-band -mx-4 px-4 py-2.5 font-ui text-[12px] leading-snug text-mute sm:-mx-5 sm:px-5"
          >
            {t(
              "This market has graduated — its curve is closed for good. Reload to trade it in the pool."
            )}
          </p>
        )}

        {/*
          FILLED, AND WITH NOWHERE TO TRADE — the one state a holder cannot act on, and until now
          the one the panel said nothing about.

          Graduation runs inside the buy that fills the curve, behind a wrapper that must never take
          that buyer's own trade down with it. So a buy carrying an ordinary gas limit into a
          transaction that also has to create a Uniswap pool starves the graduation, the failure is
          swallowed, and the market lands here: raise complete, curve shut for good, no pool.

          Nothing is lost and nothing is at risk — `graduate` is permissionless, so the pool can
          still be created by anyone, at any time, for the price of the gas. That is why this is an
          ACTION and not an apology. Before it existed the panel read a closed curve as proof of a
          pool, quoted one that had never been initialised, got zeros back and greyed the button
          with no explanation at all.
        */}
        {stranded && (
          <div className="doku-token-band -mx-4 flex flex-col gap-2.5 px-4 py-3 sm:-mx-5 sm:px-5">
            <p role="status" className="font-ui text-[12px] leading-snug text-warn-ink">
              {t(
                "This market raised its full target, but its pool was never created — the buy that filled the curve ran out of gas before it could finish. Nothing is lost: anyone can finish it, and trading opens the moment somebody does."
              )}
            </p>
            <GraduateButton curve={curve} onDone={() => refetchGraduated()} />
          </div>
        )}

        {/*
          Monad's reserve, said before the wallet opens rather than after it reverts.

          A trade that would leave this account under 10 MON goes through only as the chain's
          "emptying transaction", which needs the wallet to have been quiet for a few blocks. That
          is why the failure is intermittent and why it hits hardest right after a launch: the
          launch is the transaction that disqualifies the buy. Nothing here can see whether the
          exemption applies, so this warns rather than blocks — refusing would refuse trades the
          chain accepts.
        */}
        {reserve === "emptying" && (
          /*
            A heading and a sentence, in the app's own message material.

            It was one 12px line of `warn-ink` in a tinted strip — the same object as the three
            notices around it — carrying the most actionable sentence in the panel. Four clauses,
            opening with an amount and closing on the chain's emptying exemption, all at one weight
            with nothing to fix the eye. `Notice` is the object this always wanted to be: the
            severity mark pressed into a well, the subject on its own line, and the body in reading
            ink beneath it.

            The mark is DRAWN, not an emoji. A `⚠️` cannot take `currentColor`, so it does not
            follow the theme or the tone it sits in and arrives at whatever weight and palette the
            reader's OS chose — see the note in `Notice`, which is where this product's severity
            glyphs live precisely so they are consistent and legible.

            It still warns rather than blocks, which is why it is amber and not coral: Monad exempts
            a transaction from a wallet that has been quiet for a few blocks, so a trade this size
            may well go through. Nothing here can see whether it will.
          */
          <Notice tone="warn" title={t("Low MON Balance")}>
            {`${t("Your balance is below the required 10 MON reserve.")} ${t("Add")} ${formatMonAmount(
              reserveGap
            )} MON ${t("or reduce your buy amount.")} ${t("This can happen when using MetaMask.")}`}
          </Notice>
        )}

        {/*
          When MON cannot be used, say so — rather than showing a broken quote or a dead button.

          Two different refusals and each names the way out. There is no route deep enough at this
          size, and the market's own asset always works; or the trade is above the router's spend
          ceiling, and a smaller one is not. A disabled button with neither sentence beside it is
          the failure this whole feature would otherwise ship with.
        */}
        {zapping && (plan.kind === "unavailable" || plan.kind === "over-cap") && (
          <p
            role="status"
            className="doku-token-band -mx-4 px-4 py-2.5 font-ui text-[12px] leading-snug text-warn-ink sm:-mx-5 sm:px-5"
          >
            {plan.message}
          </p>
        )}

        <div className="swap-cta mt-1.5 flex w-full">
          <SwapButton
            inputAmount={inputAmount}
            isSell={isSell}
            market={market}
            venue={venue}
            setSubmit={setSubmit}
            /*
              A quote of zero is not a small trade, it is a trade the venue will refuse — and the
              button was left lit for it, so the only way to find out was to sign and pay for the
              revert. `canSubmitTrade` is the one place that judgement is made.
            */
            disabled={
              isLoading ||
              !quote ||
              quote.closed ||
              // A zap with no measured route is not a trade that might work — the router would be
              // handed an empty path and revert. The sentence above says why the button is dark.
              (zapping && plan.kind !== "ready") ||
              !canSubmitTrade({
                inputAmount,
                outputAmount,
                quoteKnown: Boolean(quote),
                venueKnown,
                sufficientBalance: !address || sufficientBalance,
              })
            }
            minOutputAmount={minOutputAmount}
            /*
              The zap, present only when a route has actually been measured and priced.
              `undefined` is the ordinary path — the button buys with the market's own asset, which
              is what every trade does today and every trade does on a deployment with no router.
            */
            zap={zapIntent}
            /* The coin's ticker, not its glyph. "Buy 🚀🌕" names nothing a person can say out
               loud; "Buy MOON" is the sentence they came here to complete. */
            /*
              The label says why the key is held, not just what it would have done.

              It read `Buy MOON` in every state, including the one where the wallet holds none of
              what the trade spends — so a buyer without the pair's asset got a key that named the
              trade, refused to fire, and offered no reason anywhere on the panel. (It was also
              literally invisible while it did so: `.doku-key--off` set no colour, so the label
              rendered in the canvas colour on a near-canvas fill. Fixed in `global.css`.)

              Naming the ASSET is the whole value of the sentence. "Insufficient balance" sends
              somebody to look at a panel with two figures on it; "Insufficient WBTC" is the answer.
              Which asset that is follows the pay-with choice rather than the market's quote — a
              buy paid in MON on a WBTC market is short of MON, not of WBTC — for exactly the reason
              `payBalance` does.
            */
            label={
              inputIsEmpty
                ? t("Enter an amount")
                : address && !sufficientBalance
                  ? `${t("Insufficient")} ${isSell ? identity.ticker : zapping ? "MON" : quoteSymbol}`
                  : `${isSell ? t("Sell") : t("Buy")} ${identity.ticker}`
            }
          />
        </div>
      </div>

      {/*
        ---- The curve, as this panel's own foot --------------------------------------------

        A band rather than a second panel underneath. It was its own card for one pass and that is
        what made this column read as a stack of unrelated boxes: the curve is not a separate
        subject, it is the state of the thing the control above it operates. Past 100% the market
        graduates, this curve closes forever and the next buy goes through a pool at a different
        fee — so it belongs inside the same object, at its foot, the way a card's meter sits across
        the foot of its banner.

        Segments, because the market card and every other progress reading in this product are
        segments. A graduated market gets a full band in the halo hue: done is a different state,
        not 100% of the same one.
      */}
      <div className="doku-swap-curve flex flex-col gap-2 px-4 py-3 sm:px-5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-ui font-semibold text-[11px] uppercase leading-none tracking-[0.04em] text-mute">
            {graduated ? t("Graduated") : t("Curve")}
          </span>
          <span className="font-numeric text-[11.5px] leading-none tabular-nums text-mute">
            {graduated ? (
              t("Trading in the pool")
            ) : (
              <>
                <span className="font-semibold text-ash">
                  {compactQuote(market.state.quoteRaised, quoteDecimals)}
                </span>
                {` / ${compactQuote(market.state.quoteTarget, quoteDecimals)} ${quoteSymbol}`}
              </>
            )}
          </span>
        </div>

        <span aria-hidden className="flex items-center gap-[3px]">
          {Array.from({ length: CURVE_SEGMENTS }, (_, i) => {
            const filled = graduated
              ? CURVE_SEGMENTS
              : Math.round(market.state.progress * CURVE_SEGMENTS);
            const on = i < filled;
            const hot = on && !graduated && i === filled - 1;
            return (
              <span
                key={i}
                className="h-[6px] flex-1 rounded-[1px]"
                style={{
                  background: on
                    ? hot
                      ? "var(--doku-ink)"
                      : graduated
                        ? "var(--halo)"
                        : "var(--doku)"
                    : "var(--film-2)",
                  boxShadow: hot ? "0 0 7px rgb(var(--doku-rgb) / 0.75)" : undefined,
                }}
              />
            );
          })}
        </span>
        {/*
          Where the trade goes, at the foot of the panel.

          The venue was a chip in the header — protocol trivia over the amount fields. As a line
          under the button it is what it actually is: the sentence explaining what you just read.
          The reference does the same thing in the same place, and for the same reason.
        */}
        <p className="border-t border-line pt-3 font-ui text-[12px] leading-snug text-mute">
          {graduated
            ? `${t("Priced in")} ${quoteSymbol}. ${t("Trades route through this coin's Uniswap v4 pool.")}`
            : `${t("Priced in")} ${quoteSymbol}. ${t("Trades route through the bonding curve until it fills, then through a Uniswap v4 pool.")}`}
        </p>
      </div>
    </div>
  );
}
