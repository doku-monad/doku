"use client";

import { useQuery } from "@tanstack/react-query";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { useEffect, useMemo, useRef, useState } from "react";
import { getMaxSlippageSettings } from "utils/slippage";
import { formatUnits, parseEther, zeroAddress } from "viem";
import { usePublicClient, useReadContract } from "wagmi";

import {
  launchableQuoteAssets,
  pickableQuoteAssets,
  type QuoteAsset,
} from "@/lib/assets/quote-assets";
import { factoryAbi } from "@/lib/chain/abis";
import { CONTRACTS } from "@/lib/chain/wagmi";
import { quoteZapRoutes } from "@/lib/chain/zap";
import { zapSlippageBps } from "@/lib/chain/zap-plan";
import { useBatchSupport } from "@/lib/hooks/use-batch-support";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";
import { useQuoteBalance } from "@/lib/hooks/use-quote-balance";
import { antiSniperLabel } from "@/lib/launch/anti-sniper";
import { formatQuote, launchAffordability, launchFeeLabel } from "@/lib/launch/cost";
import { devBuyPlan, type LaunchPayWith, launchPayWithOptions } from "@/lib/launch/pay-with";
import {
  clampCreatorFee,
  draftProblems,
  type FeeRouting,
  FIXED_SUPPLY,
  isNativeQuote,
  type LaunchDraft,
  PROTOCOL_FEE_PCT,
  toRawAmount,
} from "@/lib/launch/submit";

import { CoinPreview, CoinPreviewStrip } from "./components/CoinPreview";
import { CreatorFee } from "./components/CreatorFee";
import { DevBuy } from "./components/DevBuy";
import { FeeRoutingPicker } from "./components/FeeRouting";
import { EMPTY_IDENTITY, type Identity, IdentityFields } from "./components/IdentityFields";
import { LaunchAction } from "./components/LaunchAction";
import { LaunchSummary, type SummaryRow } from "./components/LaunchSummary";
import { EMPTY_LINKS, LinkFields, type MarketLinks } from "./components/LinkFields";
import { PairSelect } from "./components/PairSelect";
import { StepCard } from "./components/StepCard";
import LaunchBenchSkeleton from "./LaunchBenchSkeleton";

/**
 * The launch bench.
 *
 * Five numbered steps in a column, and a rail beside them that updates as you type.
 *
 * ## Why a rail rather than a review step
 *
 * A launch form is a list of decisions whose consequences are not visible from the field that made
 * them. Picking a quote asset sets the coin's denomination forever; picking a fee route decides who
 * gets paid on every trade for the life of the coin. A review screen at the end shows you all of
 * that once, after you have stopped thinking about it. A rail shows it while you are deciding, and
 * it is the same panel that lists what is still missing — so the button is never the first place
 * you find out something is wrong.
 *
 * ## The rail is capped, not sized
 *
 * It was `h-[calc(100vh - …)]`: a fixed viewport height, which meant the rail was exactly one
 * screen tall whether it had anything to put there or not. On a tall monitor the summary panel was
 * stretched to fill hundreds of pixels of nothing; on a laptop the eleven-row summary and the
 * button did not fit, so the rows scrolled inside a container with no scrollbar, no fade and no
 * indication that anything was below — and `100vh` on a phone is the pre-toolbar height, so the
 * bottom of the rail sat under the browser chrome.
 *
 * `max-h` with `100svh` is the whole fix. Short content sits at its own height; tall content is
 * capped at the small viewport height, which is the one that is always visible. The preview stays
 * `shrink-0` at the top, the action stays `shrink-0` at the bottom, and the only thing that ever
 * scrolls is the middle — which now holds five rows instead of eleven, because the protocol's
 * fixed terms moved behind a disclosure. See `LaunchSummary`.
 *
 * ## One preview, two shapes
 *
 * Above `lg` the full card lives in the rail and is always on screen. Below `lg` there is no rail,
 * so the card sits at the foot of the page after the steps that fill it in, and a one-line version
 * of it pins to the top of the form while you type. The strip is not a shrunken card — see
 * `CoinPreviewStrip`.
 *
 * ## The order of the steps
 *
 * Identity first, because it is the question the launcher already has an answer to: somebody
 * arrives knowing what their coin is called, not knowing whether they want it denominated in a
 * stablecoin or in tokenized NVIDIA. Then the pair, which is the decision that cannot be undone
 * and the one the later steps depend on — the dev buy spends the quote asset, so its unit is
 * unknown until this is answered. Then the two with real defaults: fees, and the optional buy. The
 * creator tax is last because it is the step most launches will skip.
 *
 * ## Nothing here signs anything
 *
 * `LaunchAction` owns the submit and `lib/launch/submit.ts` owns the transaction that does not
 * exist yet. Read the note there before wiring one up: the deployed factory cannot store any of
 * the fields these steps collect.
 */

/**
 * The sticky offset.
 *
 * Derived from `--topbar-h` rather than written as a number, so it cannot drift from the dock —
 * which is 12px shorter below `md`, and moves the moment anybody edits that token.
 *
 * ## There is no height cap any more
 *
 * There was: `lg:max-h-[calc(100svh-…)]`, which made the rail exactly one screen tall and pushed
 * the consequence down into the summary, where it became two scroll containers, a `min-height`
 * floor and a drawer with a cap — a panel whose job is "your whole configuration at a glance"
 * answering with a scrollbar. The cap is gone and the panel is its own height instead;
 * `lg:self-start` keeps the sticky rail from being stretched to the form's full height by the
 * grid, which is what would otherwise leave it pinned with nothing under it.
 */
const STICK_TOP = "top-[calc(var(--topbar-h)+0.75rem)]";

/**
 * The pair, handed over in the URL.
 *
 * `/assets` draws a card per live quote asset with `Launch against USDC` on it, and that press used
 * to land on a form whose pair step was on whatever the registry listed first — the launcher had
 * already made the one irreversible decision on this page and the page asked them to make it again.
 * One parameter carries it across.
 *
 * It is an id (`mon`, `usdc`), the same key the bench holds the pair as and the same one the board's
 * chips use, so a link can be written by hand and survives the registry being reordered. An id that
 * names nothing launchable falls through to the ordinary default at `quote` below — a URL cannot
 * select an asset the factory would refuse, because the lookup only ever runs against `launchable`.
 *
 * ## Why it is read in an effect and not from `useSearchParams`
 *
 * `/launch` is `force-static`. `useSearchParams` in a statically rendered route has to sit behind a
 * Suspense boundary or the build fails, and the boundary would exist for one string. It is read
 * from `location` in an effect for the reason every `location` read in this app is: the server and
 * the browser disagree about it, so it cannot happen during render.
 */
const PAIR_PARAM = "pair";

const pairFromUrl = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(PAIR_PARAM);
  } catch {
    return null;
  }
};

/** Takes `?pair=` back out of the address bar once it has been spent. See the note at its use. */
const forgetPairParam = () => {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(PAIR_PARAM);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  } catch {
    // A blocked or exotic History API. The pair is already applied; the only cost is a stale
    // parameter in the address bar, which is not worth an error anybody has to see.
  }
};

/**
 * A form already filled in.
 *
 * The bench has five steps, a preview card and an eleven-figure rail, and every one of them draws
 * its empty state until somebody types — so looking at the *filled* design means filling it in by
 * hand, every reload, including uploading two images. This is the same fields as a plain object,
 * so `/launch-preview` can hand over a complete draft and the whole bench renders populated.
 *
 * It is an initial value and nothing else: the fields stay editable, nothing here is written back,
 * and with no preset the bench behaves exactly as it always has. Only the preview route passes one
 * — see the guard note in `lib/dev/dummy-markets.ts`.
 */
export type LaunchPreset = {
  identity?: Partial<Identity>;
  links?: Partial<MarketLinks>;
  /** The quote asset's registry id (`mon`, `usdc`), not the asset — the bench holds an id too. */
  quoteId?: string;
  feeRouting?: FeeRouting;
  creatorFee?: number;
  creatorFeeRecipient?: string;
  /** As typed into the field, so a preset can carry `"0.5"` without inventing a number format. */
  devBuy?: string;
};

export const LaunchBench = ({ preset }: { preset?: LaunchPreset } = {}) => {
  const { address, monBalance } = useDokuWallet();

  /* What this wallet does with an EIP-5792 batch. One answer, three consumers: the dev-buy step's
     copy, the ceiling on the amount it offers, and the launch button that sends the batch — the
     button reads the same hook rather than a second capability call. See `useBatchSupport`. */
  const batchSupport = useBatchSupport(address);

  /* Whether the swap in front of a MON-funded dev buy rides INSIDE the launch. Derived once, here,
     and threaded to everything that has to agree about it: a batched swap is not a transaction of
     its own, so it costs no second signature and reserves no second lot of gas. */
  const batched = batchSupport !== "none";

  /**
   * What can be launched against, read from the chain's quote registry.
   *
   * Only the `live` ones: `DokuFactory.launch` reverts `QuoteNotEnabled()` for anything else, and
   * pre-selecting an asset the factory would refuse is a launch that fails in the wallet after the
   * whole form has been filled in. The picker still *draws* the rest — see `PairSelect`.
   */
  const { assets: allAssets, isPending: quotesPending, isError: quotesFailed } = useQuoteAssets();
  /* What the launchpad OFFERS, which is not everything the registry knows. See `HIDDEN_QUOTE_IDS`:
     a couple of these are registered on chain and cannot be deleted at the source, so the menu is
     narrowed here. `launchable` is derived from the narrowed list on purpose — otherwise a hidden
     asset could still be picked up as the fallback default at `quote` below. */
  const assets = useMemo(() => pickableQuoteAssets(allAssets), [allAssets]);
  const launchable = useMemo(() => launchableQuoteAssets(assets), [assets]);

  /*
   * The pair is held as an id, not as an object.
   *
   * The registry arrives after the first render, so a `QuoteAsset` in state would need a
   * hard-coded MON row to start from — which is the constant this task deleted, and the reason
   * gold spent a release at 18 decimals. An id survives a refetch and resolves against whatever
   * the chain currently says.
   */
  const [quoteId, setQuoteId] = useState<string | null>(preset?.quoteId ?? null);
  const quote = useMemo(
    () => launchable.find((a) => a.id === quoteId) ?? launchable[0] ?? null,
    [launchable, quoteId]
  );
  const setQuote = (asset: QuoteAsset) => setQuoteId(asset.id);
  const [identity, setIdentity] = useState<Identity>({ ...EMPTY_IDENTITY, ...preset?.identity });
  const [links, setLinks] = useState<MarketLinks>({ ...EMPTY_LINKS, ...preset?.links });
  const [feeRouting, setFeeRouting] = useState<FeeRouting>(preset?.feeRouting ?? "creator");
  /* Derived rather than its own preset field: the tax step is open precisely when there is a tax
     to show, and a preset that could set a 2% fee with the disclosure shut would draw a summary
     row nothing on the page accounts for. */
  const [taxEnabled, setTaxEnabled] = useState(Boolean(preset?.creatorFee));
  const [creatorFee, setCreatorFee] = useState(preset?.creatorFee ?? 0);
  const [creatorFeeRecipient, setCreatorFeeRecipient] = useState(preset?.creatorFeeRecipient ?? "");
  const [devBuy, setDevBuy] = useState(preset?.devBuy ?? "");

  /*
   * ---- The form starts empty, every time --------------------------------------------------
   *
   * This used to persist every field to `localStorage` and restore it on the next visit, on the
   * reasoning that a launch is not filled in one sitting. It is gone, and the module with it.
   *
   * A launch is permanent and it is public. A form that quietly refills itself with what somebody
   * typed days ago — on a shared machine, in a tab they opened to look at somebody else's coin, or
   * after they deliberately abandoned a draft — is a form that can mint a name, a ticker, an
   * artwork and a fee recipient nobody re-read before pressing the key. The cost of a wrong restore
   * is a token on chain forever; the cost of no restore is typing a name again.
   *
   * So the only thing that survives arriving at this page is the pair, and only from the URL, and
   * only for the one navigation that put it there — see the effect below.
   *
   * `seeded` is what is left of the flag that used to gate the restore. It still gates the
   * dev-buy reset further down, which must not fire on the commit where `?pair=` first resolves.
   *
   * A `preset` is the preview route's fixture and is already applied in the initialisers above, so
   * it starts seeded.
   */
  const [seeded, setSeeded] = useState(Boolean(preset));

  /*
   * The pair, seeded from the URL once and then forgotten.
   *
   * Arriving from `/assets` by pressing `Launch` on a card is a choice made a second ago, and this
   * is the only thing on the form that survives the navigation that carried it. Everything else
   * starts empty, deliberately — see the note by `seeded`.
   *
   * It is set unconditionally when present. `launchable` has not arrived on this render, so there
   * is nothing to validate the id against yet; the resolution at `quote` does that, and an id
   * naming nothing falls back exactly as a null would.
   *
   * Then it is stripped, because a seed that stays in the address bar stops being a seed. Leaving
   * it there means every reload — and every restore of this tab — re-applies a pair the launcher
   * may have changed three steps ago, and the form would keep snapping back to it with nothing on
   * screen explaining why. `replaceState` rather than a router push: this is not a navigation, and
   * it must not add an entry whose Back button undoes the pair without leaving the page.
   *
   * Read in an effect rather than during render for the reason `pairFromUrl` gives: the server and
   * the browser disagree about `location`, and React reports the disagreement as a hydration error.
   */
  useEffect(() => {
    if (preset) return;

    const fromUrl = pairFromUrl();
    if (fromUrl) {
      setQuoteId(fromUrl);
      forgetPairParam();
    }

    setSeeded(true);
    // Once, on mount. The dependency list is deliberately the preset alone.
  }, [preset]);

  /**
   * Which asset funds the dev buy.
   *
   * The pair's own by default — today's behaviour, unchanged, and the only option on a MON pair.
   * Choosing MON puts a swap in front of the launch; see `lib/launch/pay-with`.
   */
  const [payWith, setPayWith] = useState<LaunchPayWith>("quote");
  const payOptions = useMemo(() => launchPayWithOptions(quote), [quote]);

  /**
   * Nothing is held back any more.
   *
   * Funding a dev buy in the pair's own asset carried a `Soon` badge and was inert, on the grounds
   * that DOKU read no ERC-20 balances and so could not fill in a percentage or promise the buy was
   * affordable. Both halves of that are now false: the router is integrated, and `useQuoteBalance`
   * reads the balance — so the percentage keys divide a real number, the ceiling is the wallet's
   * own, and a buy larger than the balance holds the launch button with the shortfall on it rather
   * than reverting on the factory's `transferFrom`.
   *
   * `payUnavailable` stays in the prop tree rather than being deleted: `PayWithControl` is shared
   * with the trade panel, which still has genuinely unavailable funding assets to describe.
   */
  const payUnavailable = undefined;

  /**
   * What the funding control shows.
   *
   * `launchPayWithOptions` and nothing else. It was `quoteIsMon ? payOptions : ["quote", "native"]`
   * — both keys forced on every non-MON pair, which was right only while one of them was a
   * placeholder: it put a `Soon` badge somewhere a launcher would see it. With both keys live, a
   * hard-coded pair offers MON funding on an asset the chain has no route to, and that key opens a
   * swap that cannot be quoted. The helper already answers this correctly for every case — one
   * option on a MON pair, one on an asset with no pool, two where a swap is genuinely possible.
   */
  const payKeys = useMemo<LaunchPayWith[]>(() => [...payOptions], [payOptions]);

  /*
    Changing the pair can withdraw the choice — and the field's UNIT goes with it.

    The amount is cleared rather than converted. Five MON and five USDC are different amounts of
    money, and carrying the digits across would leave a number nobody typed in a field that now
    means something else. The trade panel restates because it holds raw units and can; this field
    holds what somebody typed.
  */
  useEffect(() => {
    /* Nothing is held back now — see `payUnavailable`. What remains is the ordinary case: a pair
       change that withdraws the funding asset currently selected, which is a real state whenever
       somebody moves from a routable asset to one with no pool. */
    if (payKeys.includes(payWith)) return;
    setPayWith("quote");
    setDevBuy("");
  }, [payKeys, payWith, payUnavailable]);

  /*
   * Changing the PAIR clears the amount, because the field's unit changed underneath it.
   *
   * The effect above only fires when a pair change withdraws the funding asset currently selected,
   * which is the rarer half of the problem — moving from USDC to cbBTC keeps `quote` selected and
   * kept the digits, so "500" silently stopped meaning five hundred dollars and started meaning
   * five hundred bitcoin. That was survivable while no balance was read and the number was only
   * ever a suggestion. It is not now: the amount is checked against a real balance, converted at
   * the new asset's decimals, and pulled by the factory.
   *
   * Cleared rather than converted, for the reason the note above gives: five hundred USDC and five
   * hundred cbBTC are different amounts of money, and carrying the digits across leaves a number
   * nobody typed in a field that now means something else.
   *
   * `seeded` gates it, and the ref's first run only records. Without both, the effect fires on
   * the commit where `?pair=` first resolves — clearing a dev buy against a pair change the
   * launcher never made.
   */
  const lastQuoteId = useRef<string | null>(null);
  useEffect(() => {
    if (!seeded || !quote) return;
    if (lastQuoteId.current === null || lastQuoteId.current === quote.id) {
      lastQuoteId.current = quote.id;
      return;
    }
    lastQuoteId.current = quote.id;
    setDevBuy("");
  }, [seeded, quote]);

  const choosePayWith = (next: LaunchPayWith) => {
    if (next === payWith) return;
    setPayWith(next);
    setDevBuy("");
  };

  /**
   * An empty wallet cannot launch, and that is all this decides.
   *
   * The rest of the cost — the fee, the dev buy, Monad's reserve — is `launchAffordability` below,
   * which needs the fee read to have answered before it can say anything. This one does not, so it
   * stays: a wallet holding nothing is refused the moment the balance arrives rather than a round
   * trip later. `undefined` while either query is in flight counts as sufficient, so a pending read
   * never disables the button.
   */
  const insufficientBalance = monBalance !== undefined && monBalance === 0n;

  /**
   * The fee, from the factory, keyed on whoever is about to pay it.
   *
   * `launchFee(who)` is `feeExempt[who] ? 0 : launchFeeWei` — owner-tunable with per-account
   * exemptions, so there is no number to compile in that would be right for both an exempt account
   * and everybody else. The rail said "Gas only" and went on saying it when the owner raised the
   * fee to 10 MON.
   *
   * Read against the zero address before a wallet connects. Nobody exempts the zero address, so
   * that is the headline fee — which is the figure somebody comparing launchpads wants, and the
   * alternative is a blank row for the whole of the visit that decides whether they launch here.
   * `submitLaunch` re-reads the real one at signing time and sends `msg.value` from that.
   */
  const { data: rawTaxTerms } = useReadContract({
    address: CONTRACTS.factory,
    abi: factoryAbi,
    functionName: "taxTerms",
  });
  const taxTerms = rawTaxTerms
    ? { startBps: Number(rawTaxTerms[0]), window: Number(rawTaxTerms[1]), mode: Number(rawTaxTerms[2]) }
    : undefined;
  const { data: launchFeeWei } = useReadContract({
    address: CONTRACTS.factory,
    abi: factoryAbi,
    functionName: "launchFee",
    args: [address ?? zeroAddress],
  });
  const launchFee = launchFeeWei as bigint | undefined;

  /**
   * The balance of the pair's own asset — read, rather than assumed away.
   *
   * It used to be `quote.id === "mon" ? monBalance : undefined`, with a note explaining that this
   * app could not read an ERC-20 balance. It can; the trade panel always could. That single gap is
   * what made a dev buy in the pair's own asset a half-feature: no percentage keys, no ceiling, no
   * check that the wallet held the amount being typed, and a launch that reverted on the factory's
   * `transferFrom` after the launcher had already paid for an approval.
   *
   * Native pairs still resolve to `monBalance` — the hook does that, so nothing downstream has to
   * ask which kind of asset it is holding.
   */
  const { balance: quoteBalance, isPending: quoteBalancePending } = useQuoteBalance(quote);
  const balanceLabel =
    quoteBalance === undefined || !quote
      ? undefined
      : `${formatQuote(quoteBalance, quote.decimals)} ${quote.symbol}`;

  /**
   * What the MON would buy, measured against the real pools.
   *
   * Debounced, because this runs on every keystroke in an amount field and each measurement is
   * two simulated calls per candidate route. Disabled unless MON is actually the funding asset,
   * which keeps the whole thing inert on every ordinary launch.
   */
  const publicClient = usePublicClient();
  const monIn = useMemo(() => {
    if (payWith !== "native") return 0n;
    try {
      return Number(devBuy) > 0 ? parseEther(devBuy as `${number}`) : 0n;
    } catch {
      // A half-typed number — "1." — is not an error to report, it is a person still typing.
      return 0n;
    }
  }, [payWith, devBuy]);

  const [debouncedMonIn, setDebouncedMonIn] = useState(0n);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedMonIn(monIn), 250);
    return () => clearTimeout(timer);
  }, [monIn]);

  const route = useQuery({
    queryKey: ["launch-zap-route", quote?.address, debouncedMonIn.toString()],
    enabled:
      payWith === "native" &&
      debouncedMonIn > 0n &&
      Boolean(publicClient) &&
      Boolean(quote?.address),
    // Pool prices move with every trade, so a cached quote is a stale price.
    staleTime: 0,
    queryFn: () =>
      quoteZapRoutes(publicClient!, { quoteAsset: quote!.address!, amountIn: debouncedMonIn }),
  });

  const plan = useMemo(
    () =>
      devBuyPlan({
        amountIn: monIn,
        quoting: route.isFetching || debouncedMonIn !== monIn,
        route: route.data,
        slippageBps: zapSlippageBps(getMaxSlippageSettings().maxSlippage),
        quoteSymbol: quote?.symbol ?? "the pair's asset",
      }),
    [monIn, route.isFetching, route.data, debouncedMonIn, quote?.symbol]
  );

  /**
   * The dev buy as the DRAFT sees it: always an amount of the pair's own asset.
   *
   * When the funding is MON that is the swap's estimate, which is what the summary shows and what
   * `toLaunchParams` turns into `firstBuyQuote`. The launch itself does not trust it — `submitLaunch`
   * replaces it with the balance the swap actually delivered — but a summary has to show a number
   * before the swap exists, and the estimate is the only honest one available.
   */
  const devBuyInQuote =
    payWith === "native"
      ? plan.kind === "ready" && quote
        ? Number(formatUnits(plan.quoteOut, quote.decimals))
        : undefined
      : Number(devBuy) > 0
        ? Number(devBuy)
        : undefined;

  const draft: Partial<LaunchDraft> = useMemo(
    () => ({
      name: identity.name.trim(),
      ticker: identity.ticker.trim(),
      logo: identity.logo.trim() || undefined,
      banner: identity.banner.trim() || undefined,
      description: identity.description.trim() || undefined,
      quote: quote ?? undefined,
      supply: FIXED_SUPPLY,
      feeRouting,
      creatorFee,
      creatorFeeRecipient: creatorFeeRecipient.trim() || undefined,
      links: {
        website: links.website || undefined,
        x: links.x || undefined,
        telegram: links.telegram || undefined,
      },
      devBuy: devBuyInQuote,
      devBuyWithMon:
        payWith === "native" && plan.kind === "ready" && route.data
          ? {
              amountInWei: monIn,
              path: route.data.pathKeys,
              minQuoteOut: plan.minQuoteOut,
            }
          : undefined,
    }),
    [
      identity,
      quote,
      feeRouting,
      creatorFee,
      creatorFeeRecipient,
      links,
      devBuyInQuote,
      payWith,
      plan,
      route.data,
      monIn,
    ]
  );

  /**
   * The one state the draft cannot express: MON was typed, and the swap has not been priced yet.
   *
   * The draft is complete and would launch — with no dev buy at all, because `devBuy` is undefined
   * until a route is measured. Launching through that silently drops the thing the launcher asked
   * for, so the button is held instead, saying which of the two it is waiting on.
   */
  const swapBlocked =
    payWith === "native" && monIn > 0n && plan.kind !== "ready"
      ? plan.kind === "unavailable"
        ? "No route from MON to this pair"
        : "Pricing the swap…"
      : null;

  /**
   * MON this flow takes out of the wallet for the buy, which is not the same as the buy.
   *
   * On a MON pair the first buy rides along in `msg.value` and is native. On any other pair the
   * launch pulls the first buy as a token and none of it is — unless the launcher is paying in MON,
   * in which case the swap in front of the launch spends that MON from this same balance, and the
   * launch has to still be affordable once it is gone. `parseEther` because the field holds MON in
   * both of those cases; a half-typed number is a person still typing, not an error.
   */
  const nativeFirstBuy = useMemo(() => {
    if (payWith === "native") return monIn;
    if (!quote || !isNativeQuote(quote)) return 0n;
    try {
      return Number(devBuy) > 0 ? parseEther(devBuy as `${number}`) : 0n;
    } catch {
      return 0n;
    }
  }, [payWith, monIn, quote, devBuy]);

  /**
   * The buy the factory will PULL from the wallet, in the pair's own asset.
   *
   * The other half of the funding choice, and the half nothing was checking. It exists in exactly
   * one case: the launcher is paying in the pair's asset, on a pair that is not MON. A MON pair
   * sends its first buy as `msg.value` and is `nativeFirstBuy`'s business; a buy funded in MON is
   * covered by the swap, which delivers the asset into this same wallet before the launch reads it.
   *
   * `toRawAmount` and not `parseEther`: the decimals are the QUOTE's — six for USDC, eight for
   * cbBTC — and it is the same conversion `toLaunchParams` will do at signing time, so what the
   * ledger checks and what the factory pulls are the same number.
   */
  const quoteFirstBuy = useMemo(() => {
    if (payWith === "native" || !quote || isNativeQuote(quote)) return 0n;
    const typed = Number(devBuy);
    return typed > 0 ? toRawAmount(typed, quote.decimals) : 0n;
  }, [payWith, quote, devBuy]);

  /**
   * Whether the wallet can pay for this, and whether the chain will let it.
   *
   * Two different answers and they are not interchangeable — see `lib/launch/cost`. A shortfall
   * holds the button, because no wallet can be talked into spending money it does not have. A dip
   * under Monad's 10 MON reserve only warns: it is measured against a gas figure this app assumed
   * rather than one the chain quoted, and refusing a launch on the strength of our own arithmetic
   * is worse than telling the launcher what is about to happen.
   *
   * Both assets, because the funding control means a launch can now be short of either. The MON
   * requirement is not a constant across the two: a dev buy paid in the pair's asset takes nothing
   * out of the MON balance, so the reserve arithmetic is the fee and the gas alone — and it gains
   * the approval that a pulled buy needs, which is a transaction of its own.
   */
  const affordability = useMemo(
    () =>
      launchAffordability({
        balance: monBalance,
        launchFee,
        nativeFirstBuy,
        quoteBuy:
          quote && quoteFirstBuy > 0n
            ? {
                symbol: quote.symbol,
                decimals: quote.decimals,
                amount: quoteFirstBuy,
                balance: quoteBalance,
              }
            : null,
        /* A swap runs in front of the launch exactly when a dev buy is funded in MON, and it costs
           gas out of the same balance the fee does — UNLESS the wallet takes the whole launch as
           one `wallet_sendCalls`, in which case the swap is a call inside the launch rather than a
           transaction in front of it and there is no second lot of gas to hold back. The same
           `batchSupport` sets the ceiling the dev-buy step offers, because a ceiling and a check
           that disagree is the bug `pay-with` has now fixed twice. */
        swapFirst: payWith === "native" && monIn > 0n && !batched,
      }),
    [
      monBalance,
      launchFee,
      nativeFirstBuy,
      quote,
      quoteFirstBuy,
      quoteBalance,
      payWith,
      monIn,
      batched,
    ]
  );

  const problems = draftProblems(draft);

  /** `2%`, not `2.0%`; `2.5%`, not `2.50%`. The trailing zero is precision the figure lacks. */
  const fmtPct = (n: number) => `${n % 1 === 0 ? n : n.toFixed(1)}%`;

  /*
   * The summary, as two lists.
   *
   * `rows` is what the launcher has decided and can still change. `terms` is what is true of every
   * launch on this protocol, and it sits behind a disclosure — they were interleaved in one
   * eleven-row list where "1%" being fixed and "USDC" being your decision were told apart only by
   * the colour of the value, which teaches nobody which of the two they can still act on.
   */
  const rows: SummaryRow[] = [
    {
      label: "Ticker",
      value: identity.ticker ? `$${identity.ticker}` : "—",
      emphasis: Boolean(identity.ticker),
      pending: !identity.ticker,
    },
    { label: "Priced in", value: quote?.symbol ?? "—", emphasis: Boolean(quote) },
    {
      label: "Fees go to",
      value:
        feeRouting === "creator"
          ? "Your wallet"
          : feeRouting === "holders"
            ? "Holders, pro-rata"
            : "Buyback and burn",
      emphasis: true,
    },
    {
      label: "Creator tax",
      value:
        creatorFee > 0
          ? `${fmtPct(creatorFee)} → ${creatorFeeRecipient.trim() ? "named wallet" : "deployer"}`
          : "None",
      emphasis: creatorFee > 0,
      pending: creatorFee === 0,
    },
    {
      label: "Dev buy",
      value:
        payWith === "native"
          ? monIn > 0n && quote
            ? /* Both halves: what leaves the wallet, and what it is expected to become. A summary
                 that showed only the estimate would name an amount the launcher never typed. */
              `${devBuy} MON → ~${devBuyInQuote?.toFixed(4).replace(/\.?0+$/, "") ?? "…"} ${quote.symbol}`
            : "None"
          : Number(devBuy) > 0 && quote
            ? `${devBuy} ${quote.symbol}`
            : "None",
      emphasis: Number(devBuy) > 0,
      pending: !(Number(devBuy) > 0),
    },
    /*
      Not a fixed term any more, and no longer behind the disclosure that holds them.

      It sat under "the same on every launch", closed by default, saying "Gas only" — which was a
      forgivable rounding of a 0.01 MON fee and is a lie about a 10 MON one. It is neither fixed
      (the owner tunes it) nor the same on every launch (an exempt account pays nothing), and at
      this size it is the largest number on the form. It belongs where the launcher is looking.
    */
    {
      label: "Launch fee",
      value: launchFeeLabel(launchFee),
      emphasis: launchFee !== undefined && launchFee > 0n,
      pending: launchFee === undefined,
    },
    /* `Your USDC`, not `Your balance`. The row is the pair's asset, and it appeared only on MON
       pairs when that was the only balance this app could read — so the generic label was never
       ambiguous. It is now: a launcher funding a USDC pair in MON has two balances in play, one of
       them in the ledger beside the button, and a row reading "Your balance · 0 USDC" under a
       launch they can comfortably afford reads as a warning. */
    ...(balanceLabel && quote ? [{ label: `Your ${quote.symbol}`, value: balanceLabel }] : []),
  ];

  const terms: SummaryRow[] = [
    { label: "Supply", value: FIXED_SUPPLY.toLocaleString() },
    {
      label: "Trade fee",
      value:
        creatorFee > 0
          ? `${fmtPct(PROTOCOL_FEE_PCT + creatorFee)} · ${PROTOCOL_FEE_PCT}% + ${fmtPct(creatorFee)} tax`
          : `${PROTOCOL_FEE_PCT}%`,
    },
    { label: "LP", value: "Locked forever" },
    // Read off the factory, not written here: it said "over 5 min" while mainnet ran three seconds.
    { label: "Anti-sniper tax", value: antiSniperLabel(taxTerms) },
  ];

  /*
   * Nothing to launch against, so nothing to launch.
   *
   * Three states, told apart rather than collapsed into one empty screen: the registry has not
   * answered yet, the indexer could not be reached, or it answered and no asset is enabled. Only
   * the last two are statements about the product, and a form whose pair step was simply empty
   * would make all three look like it.
   *
   * ## Waiting is not a message
   *
   * The first state used to be one: a centred box reading "Reading the quote registry", which named
   * an internal component to somebody who had pressed `Launch a coin`, and which stood in for a
   * five-step form at a fraction of its height — so the page measured 948px while it was up and
   * 2684px a second later. It is a skeleton of the bench now, at the bench's own size. See
   * `LaunchBenchSkeleton`.
   *
   * The other two stay as prose, because they are not waiting: nothing is coming, and the reader
   * needs the reason rather than a shape. They keep their own box.
   */
  if (!quote && quotesPending) return <LaunchBenchSkeleton />;

  if (!quote) {
    return (
      <div className="rounded-doku-3xl border border-line bg-glass px-5 py-8 text-center">
        <p className="font-numeric text-[13px] uppercase tracking-[0.08em] text-mute">
          Launching is unavailable
        </p>
        <p className="mx-auto mt-3 max-w-[52ch] text-[14px] leading-relaxed text-ash">
          {quotesFailed
            ? "The indexer did not answer, so the assets a coin can be priced against are unknown. Nothing is wrong with your draft — try again in a moment."
            : "No quote asset is enabled on the launchpad right now. The factory would refuse every pair, so the form is not offering one."}
        </p>
      </div>
    );
  }

  return (
    <div className="grid w-full grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6">
      {/*
        The steps, one per row.

        They were on a two-column grid, which is how a form ends up with a ragged bottom edge: two
        panels in a row are stretched to the taller of them, and "fee routing" and "dev buy" are
        not the same length in any locale. A column has no ragged edge to fix, every control gets
        the full width it was designed at — eight percentage chips in one row rather than two — and
        the reason the two-column grid existed in the first place (the launch button sitting three
        screens below the first field) is solved by the rail, which carries the button and never
        leaves the screen.
      */}
      <div className="flex min-w-0 flex-col gap-5">
        {/* The one-line preview, for the widths with no rail. `z-20` clears the panels it slides
            over; the dock above it is `z-40`. */}
        <CoinPreviewStrip
          identity={identity}
          quote={quote}
          className={`sticky z-20 lg:hidden ${STICK_TOP}`}
        />

        <StepCard index="01" title="Identity">
          <IdentityFields
            value={identity}
            onChange={setIdentity}
            links={<LinkFields symbol={identity.ticker} links={links} setLinks={setLinks} />}
          />
        </StepCard>

        {/* "Trading pair", not "Price it against".

            The old title was an instruction phrased as a verb with no object — the reader has to
            finish the sentence themselves — and it named a thing this product already has a name
            for. The market page says PAIRED WITH, the spec sheet says PRICED IN, `/assets` calls
            them quote assets, and the launch summary calls the choice a pair. Four surfaces, four
            phrasings, one decision. */}
        <StepCard index="02" title="Trading pair">
          <PairSelect assets={assets} value={quote} onChange={setQuote} />
        </StepCard>

        <StepCard index="03" title="Fee routing">
          <FeeRoutingPicker value={feeRouting} onChange={setFeeRouting} />
        </StepCard>

        <StepCard index="04" title="Dev buy" optional>
          <DevBuy
            value={devBuy}
            onChange={setDevBuy}
            quote={quote}
            quoteBalance={quoteBalance}
            quoteBalancePending={quoteBalancePending}
            payWith={payWith}
            payWithOptions={payKeys}
            onPayWith={choosePayWith}
            payUnavailable={payUnavailable}
            monBalance={monBalance}
            /* Distinct from the balance being undefined, which is also true while its read is in
               flight — see the prop's note in `DevBuy`. */
            walletConnected={Boolean(address)}
            plan={plan}
            /* Whether the swap in front of the launch costs its own signature, which is a fact
               about this wallet rather than about the draft — and the same answer `LaunchAction`
               sends the batch with, read through one hook so the copy, the ceiling and the button
               cannot disagree about how many prompts are coming. */
            oneSignature={batched}
            /* The fee comes out of the same balance the buy does, so the buy's ceiling cannot be
               computed without it — see `spendableMon`. */
            launchFee={launchFee}
          />
        </StepCard>

        {/*
          The creator tax, last and optional.

          Last because it is the only step most launches will skip, and putting an optional revenue
          decision in front of the required ones is how a form makes somebody feel they are being
          upsold before they have named the thing. Optional because zero is the default and zero is
          a perfectly good answer.
        */}
        <StepCard index="05" title="Creator tax" optional>
          <CreatorFee
            enabled={taxEnabled}
            onEnabledChange={setTaxEnabled}
            value={creatorFee}
            onChange={(v) => setCreatorFee(clampCreatorFee(v))}
            recipient={creatorFeeRecipient}
            onRecipientChange={setCreatorFeeRecipient}
          />
        </StepCard>
      </div>

      {/*
        The rail: the card, the summary, the button.

        Two things you can always see — what your coin looks like, and what pressing the button
        would do — and one thing that scrolls if it has to.
      */}
      <aside className={`flex flex-col gap-4 lg:sticky lg:self-start ${STICK_TOP}`}>
        <CoinPreview identity={identity} quote={quote} className="shrink-0" />

        <LaunchSummary rows={rows} terms={terms} problems={problems}>
          {/* The same draft the summary above is rendering — see `LaunchAction`. It used to
              rebuild its own from loose props and lose the creator tax on the way. */}
          <LaunchAction
            draft={draft}
            insufficientBalance={insufficientBalance}
            blockedReason={affordability.blockedReason ?? swapBlocked}
            warning={affordability.warning}
            /* The same sum, shown whether or not it refuses — see `LaunchLedger`. */
            ledger={affordability.ledger}
            /* And the pair's own asset, when that is what funds the buy. A second ledger rather
               than four more rows in the first: they are two units against two different rules,
               and only one of them has a chain floor under it. */
            quoteLedger={affordability.quoteLedger}
          />
        </LaunchSummary>
      </aside>
    </div>
  );
};

export default LaunchBench;
