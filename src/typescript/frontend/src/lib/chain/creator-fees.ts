import { creatorSinkAbi } from "./abis";
import { quoteAmountNumber } from "./quote-scale";

/**
 * What a creator is owed across their launches, and which contract is holding it right now.
 *
 * ## The money makes three hops, and each one has a different caller
 *
 * DOKU splits the 1% trade fee 30bps to the protocol and 70bps to whatever the creator chose at
 * launch. On a CREATOR market that 70bps, plus any creator tax of up to 10%, reaches the creator's
 * wallet through up to three separate transactions:
 *
 *   1. **On the curve, before graduation.** `BondingCurve.pendingFees` and `pendingTax` accrue as
 *      people trade. `collectFees()` / `collectTax()` are permissionless and PUSH to the
 *      recipient; if that push fails the amount is credited to the shared `CreatorSink` instead,
 *      so a wallet that cannot receive blocks nobody.
 *   2. **In the hook, after graduation.** `DokuHook` accrues the levy into `pendingSink[id]`, a
 *      `sweep` materialises it into `owedSink[id]`, and the creator tax accrues straight into
 *      `owedTax[id]`. The hook pushes to nobody — a push inside `afterSwap` that reverted would
 *      brick every swap in the pool, permanently.
 *   3. **In the sink.** `CreatorSink.pull(market)` is the one call that drains the hook's two
 *      ledgers into `claimable[who][quote]`, and `claim(quote)` is the one that pays the caller.
 *
 * So "claimable" is not one number and not one button. A creator can be owed money that no `claim`
 * would move, because it is still a hop behind.
 *
 * ## Which of them revert on nothing, which do not, and why that decides a button
 *
 * `collectFees` and `collectTax` revert `ZeroAmount`. `claim` reverts `NothingToClaim`. **`pull`
 * does not revert** — it sweeps nothing, pulls nothing, emits `Pulled(market, 0, 0)` and succeeds.
 * On Monad, where gas is billed at the LIMIT rather than at usage, that is a creator paying for a
 * transaction that achieves exactly what not pressing the button achieves, and nothing on screen
 * afterwards would say so. Every offer below is therefore decided on the raw `bigint`, never on a
 * rendered figure.
 *
 * ## Every amount here is raw units of the MARKET'S OWN quote asset
 *
 * Six decimals for USDC and for gold, eight for the wrapped bitcoins, eighteen for MON. Nothing in
 * this module divides by a constant and nothing sums across two assets: a creator paid in USDC and
 * in MON is owed two amounts of two different things, and their sum is a number with no unit.
 */

/** `Sinks.CREATOR`. The one routing whose 70bps share is a wallet's rather than a contract's. */
export const SINK_CREATOR = 2;

/** How the indexer names a market's routing. `null` where the row never said. */
export type CreatorRouting = "creator" | "holders" | "buyback" | null;

/**
 * Everything read off chain for one market, before any of it is interpreted.
 *
 * Split out as a plain shape so the decision below is a pure function of it: the reads are the
 * part that needs a chain, and the arithmetic is the part that needs a test.
 */
export interface CreatorMarketReads {
  marketAddress: string;
  /** The ERC-20 the market is priced in, or the zero address for native MON. */
  quoteAsset: string;
  /** That asset's OWN decimals. Never eighteen by default — see the note at the top. */
  quoteDecimals: number;
  quoteSymbol: string | null;
  routing: CreatorRouting;
  /** `BondingCurve.feeRecipient()` — the routed wallet on CREATOR, the sink contract otherwise. */
  feeRecipient: string | null;
  /** `BondingCurve.taxRecipient()`. Fixed at launch and never moved, as the launch form promises. */
  taxRecipient: string | null;
  /** `BondingCurve.pendingFees()` — the routed share `collectFees()` would move. */
  curvePendingFees: bigint;
  /** `BondingCurve.pendingTax()` — the creator tax `collectTax()` would move. */
  curvePendingTax: bigint;
  /** `CreatorSink.entries(market).registered`. False until the graduator binds the market. */
  sinkRegistered: boolean;
  /** `entries(market).routed` — a wallet on CREATOR, the vault or burn sink on anything else. */
  sinkRouted: string | null;
  /** `entries(market).tax`. Falls back to `routed` where the market has no tax recipient. */
  sinkTax: string | null;
  /** `DokuHook.pendingSink(id)` — accrued, not yet swept. A `pull` sweeps it on the way past. */
  hookPendingSink: bigint;
  /** `DokuHook.owedSink(id)` — swept, waiting for `pullSink`. */
  hookOwedSink: bigint;
  /** `DokuHook.owedTax(id)` — the creator tax, which never needs a sweep of its own. */
  hookOwedTax: bigint;
}

/** A transaction worth offering. Listed only when it would actually move money. */
export type CreatorFeeAction = "collectFees" | "collectTax" | "pull";

/** One market's answer: what the reader is owed, and what would move it one hop closer. */
export interface CreatorMarketFees {
  marketAddress: string;
  quoteAsset: string;
  quoteDecimals: number;
  quoteSymbol: string | null;
  /** `collectFees()` would pay the reader this, in raw quote units. */
  collectableFees: bigint;
  /** `collectTax()` would pay the reader this. */
  collectableTax: bigint;
  /** `CreatorSink.pull(market)` would credit the reader this. */
  pullable: bigint;
  /** Everything above. Money already in `claimable` is NOT here — that belongs to its asset's lot. */
  owed: bigint;
  actions: CreatorFeeAction[];
}

/**
 * Address equality as the chain and a wallet each spell it.
 *
 * `eth_call` returns EIP-55 checksummed addresses; a connected wallet supplies whatever casing it
 * pleases. A literal comparison of the two tells a creator that their own market pays a stranger,
 * and the claim button they need then never appears.
 */
const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  Boolean(a) && Boolean(b) && a!.toLowerCase() === b!.toLowerCase();

/**
 * What one market owes `viewer`, and the calls that would move it.
 *
 * @param viewer the connected wallet, or `null`. Null owes nothing and is offered nothing — the
 *        buttons here spend gas, and there is nobody to spend it.
 */
export function creatorMarketFees(
  reads: CreatorMarketReads,
  viewer: string | null
): CreatorMarketFees {
  const mine = (recipient: string | null) => sameAddress(recipient, viewer);

  // The curve's two ledgers. `feeRecipient()` already answers the sink contract's address on a
  // HOLDERS or BUYBACK market, so a routing that is not CREATOR falls out as zero here without a
  // special case — but only because the comparison is against a wallet, so keep it that way.
  const collectableFees = mine(reads.feeRecipient) ? reads.curvePendingFees : 0n;
  const collectableTax = mine(reads.taxRecipient) ? reads.curvePendingTax : 0n;

  /*
    The hook's two ledgers, reachable only through `CreatorSink.pull`, which reverts `NotRegistered`
    on a market the graduator has not bound — every market still on its curve.

    The routed leg is gated on the ROUTING as well as on the recipient. `DokuHook.pullSink` answers
    the shared sink zero for a market whose sink is a vault or a burn sink rather than reverting, so
    counting `owedSink` on one of those would promise a creator money that a `pull` returns none of;
    and a BURN market's ledger is denominated in the market's own TOKEN, which is not the quote this
    row is labelled in. The tax leg has no such restriction: it is pulled on every routing.
  */
  const routedIsCreators = reads.routing === "creator";
  const pullableRouted =
    reads.sinkRegistered && routedIsCreators && mine(reads.sinkRouted)
      ? reads.hookPendingSink + reads.hookOwedSink
      : 0n;
  const pullableTax = reads.sinkRegistered && mine(reads.sinkTax) ? reads.hookOwedTax : 0n;
  const pullable = pullableRouted + pullableTax;

  const actions: CreatorFeeAction[] = [];
  if (collectableFees > 0n) actions.push("collectFees");
  if (collectableTax > 0n) actions.push("collectTax");
  if (pullable > 0n) actions.push("pull");

  return {
    marketAddress: reads.marketAddress,
    quoteAsset: reads.quoteAsset,
    quoteDecimals: reads.quoteDecimals,
    quoteSymbol: reads.quoteSymbol,
    collectableFees,
    collectableTax,
    pullable,
    owed: collectableFees + collectableTax + pullable,
    actions,
  };
}

/**
 * One quote asset's worth of a creator's money, at all three hops.
 *
 * `claim` is per ASSET, not per market — `CreatorSink.claimable` is keyed `(who, quote)` and one
 * call empties the lot however many markets fed it — which is why this is the unit the claim
 * button acts on and the market row is not.
 */
export interface CreatorClaimLot {
  /** Lower-cased, because it is the map key as well as the argument to `claim`. */
  quoteAsset: string;
  /** `null` where no market of the reader's is priced in this asset; the amount is then unlabelled. */
  quoteSymbol: string | null;
  /** `null` for the same reason. Rendering an unknown scale as eighteen is the defect, not the fix. */
  quoteDecimals: number | null;
  /** `CreatorSink.claimable(you, quote)`. `claim(quote)` pays exactly this and nothing else. */
  claimable: bigint;
  /** What a `pull` on this asset's markets would add to it. Not claimable yet. */
  pullable: bigint;
  /** What is still on the curves, needing a `collectFees()` / `collectTax()` first. */
  onCurve: bigint;
  /** `claim(quote)` reverts `NothingToClaim` at zero, so the button has to be dead there. */
  canClaim: boolean;
}

/**
 * Group what the markets owe by the asset they owe it in, and fold in what the sink already holds.
 *
 * ## Order is insertion order, deliberately
 *
 * Sorting these by size would rank six-decimal USDC against eighteen-decimal MON — a comparison
 * across units, which is the same mistake as adding them, wearing a different hat. Markets keep the
 * order they arrived in, and an asset the sink holds a balance of but no current market prices is
 * appended rather than dropped: it is a real balance, credited by a curve whose push to the creator
 * failed, and a dropped row is not neutral.
 *
 * @param claimableByQuote `CreatorSink.claimable(you, quote)` keyed by LOWER-CASED quote address.
 */
export function creatorClaimLots(
  markets: readonly CreatorMarketFees[],
  claimableByQuote: ReadonlyMap<string, bigint>
): CreatorClaimLot[] {
  const lots = new Map<string, CreatorClaimLot>();

  for (const m of markets) {
    const key = m.quoteAsset.toLowerCase();
    const lot =
      lots.get(key) ??
      ({
        quoteAsset: key,
        quoteSymbol: m.quoteSymbol,
        quoteDecimals: m.quoteDecimals,
        claimable: claimableByQuote.get(key) ?? 0n,
        pullable: 0n,
        onCurve: 0n,
        canClaim: false,
      } satisfies CreatorClaimLot);
    lot.pullable += m.pullable;
    lot.onCurve += m.collectableFees + m.collectableTax;
    lots.set(key, lot);
  }

  for (const [rawKey, claimable] of claimableByQuote) {
    const key = rawKey.toLowerCase();
    if (lots.has(key)) continue;
    lots.set(key, {
      quoteAsset: key,
      // Nothing the reader launched is priced in this asset, so there is no row to learn its
      // symbol or its scale from. Both stay null and the amount goes unrendered — an unlabelled
      // figure at a guessed scale is worse than no figure, and the claim itself still works.
      quoteSymbol: null,
      quoteDecimals: null,
      claimable,
      pullable: 0n,
      onCurve: 0n,
      canClaim: false,
    });
  }

  return [...lots.values()].map((lot) => ({ ...lot, canClaim: lot.claimable > 0n }));
}

/**
 * The smallest figure `formatQuoteAmount` will print. Anything positive below it reads as "under".
 *
 * Four places, because the coarsest quote in the catalogue is six-decimal gold — one whole token is
 * one troy ounce — and a creator's early share of one is genuinely a four-figure fraction.
 */
const DISPLAY_FLOOR = 0.0001;

/**
 * A raw quote amount, as a person reads it.
 *
 * ## The two failures this exists to prevent
 *
 * **Formatting at the wrong scale.** The amount is raw units of the market's own quote asset, and
 * `quoteAmountNumber` is the one place that turns one of those into a number. A six-decimal gold
 * balance run through eighteen decimals prints as 0.00 while nothing throws, which is the single
 * most common defect in this codebase and looks exactly like a market that has earned nothing.
 *
 * **Printing dust as zero.** A positive balance that rounds to 0.0000 is money, and its claim
 * button is live. Showing it as "0" next to an enabled Claim reads as a bug in the button. It is
 * shown as "<0.0001" instead, so the figure and the button agree.
 *
 * The locale is pinned rather than left to the reader's, so a tested string is the string that
 * ships and a comma-decimal locale cannot turn "0.0012" into "0,0012" beside a tabular-nums column.
 *
 * @param quoteDecimals the asset's own decimals, or `null` where they are not known — which prints
 *        a dash, because a number at a guessed scale is indistinguishable from a real one.
 */
export function formatQuoteAmount(raw: bigint, quoteDecimals: number | null): string {
  if (quoteDecimals === null) return "—";
  if (raw === 0n) return "0";
  const n = quoteAmountNumber(raw, quoteDecimals);
  if (n > 0 && n < DISPLAY_FLOOR) return `<${DISPLAY_FLOOR}`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1 ? 2 : 4 });
}

/**
 * `CreatorSink.pull(market)`. Permissionless — anyone may press it — but the money can only ever
 * land on the recipients the graduator registered, so pressing it for somebody else is a gift of
 * gas and nothing worse.
 *
 * Returned as a descriptor rather than executed, so the function name and argument list are checked
 * against the generated ABI by the compiler instead of by a transaction reverting in somebody's
 * wallet.
 */
export const pullRequest = (sink: `0x${string}`, market: `0x${string}`) =>
  ({
    address: sink,
    abi: creatorSinkAbi,
    functionName: "pull",
    args: [market],
  }) as const;

/** `CreatorSink.claim(quote)`. Pays `msg.sender` and nobody else, which is what makes it safe. */
export const claimRequest = (sink: `0x${string}`, quoteAsset: `0x${string}`) =>
  ({
    address: sink,
    abi: creatorSinkAbi,
    functionName: "claim",
    args: [quoteAsset],
  }) as const;

/** One transaction of a creator's collection. */
export type CollectStep = { kind: "pull"; market: string } | { kind: "claim"; quoteAsset: string };

/**
 * Everything one press of "collect" has to send for one asset: a `pull` for each market with
 * something waiting in the hook, then one `claim`.
 *
 * There is no single call. `CreatorSink.pull` takes one market, and `claim(quote)` pays only what
 * earlier pulls have already moved into the sink — so a creator whose whole balance is "waiting on
 * a pull" faces a Claim that would revert `NothingToClaim`. Empty when there is nothing anywhere:
 * a claim of nothing reverts, and on Monad a revert is billed at the gas limit.
 */
export function collectPlan(
  lot: Pick<CreatorClaimLot, "quoteAsset" | "claimable" | "pullable">,
  markets: readonly Pick<CreatorMarketFees, "marketAddress" | "quoteAsset" | "pullable">[],
): CollectStep[] {
  const pulls: CollectStep[] = markets
    .filter((m) => m.quoteAsset.toLowerCase() === lot.quoteAsset.toLowerCase() && m.pullable > 0n)
    .map((m) => ({ kind: "pull", market: m.marketAddress }));
  if (pulls.length === 0 && lot.claimable === 0n) return [];
  return [...pulls, { kind: "claim", quoteAsset: lot.quoteAsset }];
}
