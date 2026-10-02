import { formatUnits } from "viem";

import type { QuoteAsset } from "@/lib/assets/quote-assets";
import { explainChainError } from "@/lib/chain/explain-error";
import {
  encodeLaunchApproval,
  encodeLaunchCall,
  monDevBuyCalls,
  planMonDevBuy,
} from "@/lib/chain/launch-batch";
import { encodeSwapNativeFor } from "@/lib/chain/pool";
import type { LaunchChain, LaunchParams } from "@/lib/chain/writes";
import type { PathKey } from "@/lib/chain/zap";

/**
 * The launch draft — everything the form collects.
 *
 * This is the shape a general-purpose launchpad needs and, deliberately, not the shape the current
 * factory accepts. Writing it the other way round — a draft that mirrors `launch(indices, emojis,
 * proofs)` — would mean designing the form around a contract that is about to be replaced, and
 * then rewriting both.
 */
export interface LaunchDraft {
  /** Display name. Required. */
  name: string;
  /** Ticker without the `$`. Required, upper case, letters and digits. */
  ticker: string;
  /**
   * Square logo. Optional — the coin falls back to a mark generated from its ticker.
   *
   * An `ipfs://` URI from `POST /api/uploads/image`, or an `https:` URL the launcher pasted.
   * **Never a `data:` URL**: the on-chain field is 128 bytes and a data URL is tens of kilobytes,
   * so one arriving here means the upload has not finished and `draftProblems` says so rather than
   * letting the transaction revert on a field nobody mentioned.
   */
  logo?: string;
  /** Wide card image, roughly 3:1. Same two forms as `logo`, same rule. */
  banner?: string;
  description?: string;
  /** What the coin trades against. */
  quote: QuoteAsset;
  /** Total supply, in whole tokens. Fixed at launch and never minted again. */
  supply: number;
  /**
   * Where the creator's share of the swap fee goes.
   *
   * A property of the launch rather than a setting changed later, because it is the part a buyer
   * reads before they buy: "the creator keeps it" and "it buys the coin back" are different
   * products, and finding out which one afterwards is the complaint.
   */
  feeRouting: FeeRouting;
  /**
   * An additional creator tax, as a percentage of every trade.
   *
   * Separate from `feeRouting`, which decides where the creator's share of the *protocol's* 1%
   * goes. This is a second, optional charge on top of that 1%, so a trader pays
   * `PROTOCOL_FEE_PCT + creatorFee` percent — which is why the control states the total rather
   * than only the creator's part. Somebody choosing 10% should see "11% per trade" while they are
   * choosing it, not learn it from the first person who complains.
   *
   * Zero means no tax at all, and zero is the default. Fixed at launch.
   */
  creatorFee: number;
  /**
   * Where the creator tax is paid.
   *
   * Optional, and absent is a real answer rather than a missing one: with no address the tax goes
   * to the wallet that signs the launch. The field exists because those are often not the same
   * wallet — a launcher signing from a hot wallet rarely wants a permanent revenue stream paid
   * into it — and the recipient is as unchangeable as the rate, so it has to be set here.
   */
  creatorFeeRecipient?: string;
  links?: {
    website?: string;
    x?: string;
    telegram?: string;
    /**
     * **Not carried on chain.** `DokuFactory.Metadata` has name, ticker, two URIs, a description,
     * a website, an X handle and a Telegram — and no Discord.
     *
     * Kept in the shape because the card renders one where a market has it, and dropped explicitly
     * in `toLaunchParams` rather than silently. No field on the launch form writes it today, which
     * is the reason there is nothing in the form saying so: a note beside an input that does not
     * exist is a note about nothing. If a Discord input is ever added, it needs that note in the
     * same commit.
     */
    discord?: string;
  };
  /**
   * The creator's own buy, executed in the launch transaction.
   *
   * In whole units of the quote asset. Zero and absent mean the same thing and both render as
   * "none" — a dev buy of 0 is not a dev buy.
   */
  devBuy?: number;
  /**
   * The dev buy, paid for in MON rather than in the pair's own asset.
   *
   * Present only when the launcher chose MON and a route was actually measured. `devBuy` beside it
   * is the ESTIMATE the swap is expected to deliver, which is what the summary shows; the launch
   * itself spends the measured balance instead, because a swap delivers what it delivers.
   *
   * Absent on a MON pair, always: there is nothing to swap, and that pair keeps its single
   * signature.
   */
  devBuyWithMon?: {
    /** MON to spend on the swap, in wei. */
    amountInWei: bigint;
    /** The route, ending at the pair's asset. From `quoteZapRoutes`. */
    path: PathKey[];
    /** The floor the swap is signed with, in the pair's asset. */
    minQuoteOut: bigint;
  };
}

/** Where the creator's 0.7% of every swap goes. */
export type FeeRouting = "creator" | "holders" | "buyback";

export const FEE_ROUTING: {
  id: FeeRouting;
  title: string;
  blurb: string;
}[] = [
  {
    id: "creator",
    title: "You keep them",
    blurb:
      "Your share of every trade is paid to your wallet, as it would be without any of this. The default, and the only one that is not a promise to somebody else.",
  },
  {
    id: "holders",
    title: "Holder rewards",
    blurb:
      "Your share of every trade goes to your holders, in the pair's asset, in daily epochs: a wallet earns a day by holding at both of its snapshots, and claims it afterwards. Nothing is paid before the market graduates, and if it never graduates this share is never paid out.",
  },
  {
    id: "buyback",
    title: "Buyback and burn",
    blurb:
      "Your share of every trade destroys your coin. On the curve it buys the coin and burns it inside the trade. After graduation it is taken from each trade in the coin itself and burned about once a day. Nothing is handed out; supply falls, so every remaining holder owns a larger share.",
  },
];

/** The supply every launch mints. Fixed, and stated rather than asked. */
export const FIXED_SUPPLY = 1_000_000_000;

/** The protocol's cut of every swap, in percent. Not a parameter — the same for every market. */
export const PROTOCOL_FEE_PCT = 1;

/**
 * The ceiling on a creator's own fee.
 *
 * Ten percent, and the cap exists rather than being left open because the fee is permanent: a
 * market launched at 40% is a market nobody can rescue, including its creator. Ten is high enough
 * to be a real revenue decision and low enough that the pair still trades.
 */
export const MAX_CREATOR_FEE_PCT = 10;

/**
 * A 20-byte hex address.
 *
 * Deliberately not a checksum test: a launcher pasting a lower-cased address from a block explorer
 * has given a perfectly valid one, and rejecting it would be the form being pedantic about a
 * convention rather than correct about a value.
 */
export const isAddress = (value: string) => /^0x[0-9a-fA-F]{40}$/.test(value.trim());

/** Clamps to the allowed range and to one decimal place, which is the granularity the UI offers. */
export const clampCreatorFee = (value: number) =>
  Number.isFinite(value)
    ? Math.min(MAX_CREATOR_FEE_PCT, Math.max(0, Math.round(value * 10) / 10))
    : 0;

/**
 * What a submit attempt can come back as.
 *
 * A discriminated union rather than a thrown error, because "the contract for this does not exist
 * yet" is not an exception — it is a known, permanent-for-now state that the UI has to render
 * differently from a wallet rejection or an RPC failure. Modelling it as a `throw` puts a product
 * fact in a `catch` block beside genuine faults.
 */
export type LaunchResult =
  | { status: "submitted"; marketAddress: string; tokenAddress: string; txHash: string }
  /**
   * The factory refused the terms because they moved between the quote and the send —
   * `EconomicsChanged()`. Not a failure and not the launcher's mistake: nothing was spent, the
   * draft is still good, and pressing again reads the new terms.
   */
  | { status: "terms-changed"; reason: string }
  | { status: "awaiting-contract"; reason: string }
  | { status: "rejected"; reason: string }
  /**
   * Something went wrong on chain or on the way to it.
   *
   * `reason` is one sentence a launcher can act on; `detail` is the original error, kept so the
   * failure stays reportable and rendered only behind a disclosure. They used to be the same
   * string, which is how a failed `predictMarket` read put an RPC URL, a JSON request body and a
   * viem version stamp under the launch button — see `explainChainError`.
   */
  | { status: "failed"; reason: string; detail?: string };

/* ------------------------------------------------------------------ what the contract enforces */

/**
 * The metadata caps, in **BYTES**.
 *
 * `DokuFactory` measures `bytes(s).length`, which is UTF-8 bytes and not characters. A name of
 * twenty-one rocket emoji is twenty-one characters and eighty-four bytes: half the visible limit
 * and twice the real one. A form that counted characters would let it through and the launcher
 * would learn the rule from a revert, after the images were uploaded and the fee was quoted.
 */
export const META_LIMITS = {
  name: { min: 2, max: 42 },
  ticker: { min: 2, max: 12 },
  uri: 128,
  description: 240,
} as const;

/** UTF-8 bytes. `TextEncoder` rather than `Buffer`, because this runs in the browser too. */
export const byteLength = (value: string): number => new TextEncoder().encode(value).length;

/** `[A-Za-z0-9]` only, enforced on chain. No spaces, no punctuation, no `$`. */
export const TICKER_CHARSET = /^[A-Za-z0-9]+$/;

/** The sink number for each routing. The names are the UI's; the numbers are `Sinks.sol`'s. */
export const SINK_FOR_ROUTING: Record<FeeRouting, 0 | 1 | 2> = {
  buyback: 0,
  holders: 1,
  creator: 2,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/**
 * A URI that cannot go on chain.
 *
 * A `data:` URL is what `ImageField` produced before it uploaded anything, and it is tens of
 * kilobytes against a 128-byte field. Named separately from "too long" because the fix is
 * completely different: one is "shorten it", the other is "the upload has not finished".
 */
const isDataUrl = (value: string) => value.trim().toLowerCase().startsWith("data:");

/** `address(0)` as a quote asset means the chain's own coin, which is paid as `msg.value`. */
export const isNativeQuote = (quote: QuoteAsset): boolean =>
  (quote.address ?? ZERO_ADDRESS).toLowerCase() === ZERO_ADDRESS;

/**
 * Everything still wrong with a draft, in the words the summary panel prints.
 *
 * A list rather than a boolean, and the list is the point: a disabled button with no explanation is
 * the most common way a launch form wastes somebody's afternoon. Every unmet requirement is shown
 * at once instead of one at a time as each is fixed.
 *
 * These are the CONTRACT's rules, not a house style. Each one of them reverts.
 */
/**
 * Names and tickers nobody may launch under, compared after folding case, dropping everything but
 * letters and digits, and reading a zero as an O — so `$DOKU`, `D.O.K.U` and `D0KU` are all DOKU,
 * while a word that merely contains it (`DOKUCAT`, "Doku Cat") is not.
 *
 * Enforced by this site only. The factory itself would accept the name.
 */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["doku"]);
const isReservedName = (value: string): boolean =>
  RESERVED_NAMES.has(value.toLowerCase().replace(/0/g, "o").replace(/[^a-z0-9]/g, ""));

export const draftProblems = (draft: Partial<LaunchDraft>): string[] => {
  const problems: string[] = [];

  if (isReservedName(draft.name ?? "") || isReservedName(draft.ticker ?? "")) {
    problems.push("DOKU is reserved and cannot be used as a coin's name or ticker");
  }

  const name = draft.name?.trim() ?? "";
  if (!name) problems.push("Name your coin");
  else if (byteLength(name) < META_LIMITS.name.min) {
    problems.push("A name needs at least two characters");
  } else if (byteLength(name) > META_LIMITS.name.max) {
    // The count is stated because it is not the one the launcher can see: an emoji costs four.
    problems.push(
      `The name is ${byteLength(name)} bytes — the limit is ${META_LIMITS.name.max}. ` +
        "Emoji and accents cost more than one each."
    );
  }

  const ticker = draft.ticker?.trim() ?? "";
  if (!ticker) problems.push("Pick a ticker");
  else if (byteLength(ticker) < META_LIMITS.ticker.min) {
    problems.push("A ticker needs at least two characters");
  } else if (byteLength(ticker) > META_LIMITS.ticker.max) {
    problems.push(`A ticker can be at most ${META_LIMITS.ticker.max} characters`);
  } else if (!TICKER_CHARSET.test(ticker)) {
    problems.push("A ticker can only contain letters and digits");
  }

  for (const [label, uri] of [
    ["logo", draft.logo],
    ["banner", draft.banner],
    ["website", draft.links?.website],
    ["X link", draft.links?.x],
    ["Telegram link", draft.links?.telegram],
  ] as const) {
    const value = uri?.trim();
    if (!value) continue;
    if (isDataUrl(value)) {
      problems.push(
        `The ${label} has not been uploaded yet — wait for it to finish, or choose it again`
      );
    } else if (byteLength(value) > META_LIMITS.uri) {
      problems.push(`The ${label} URL is longer than ${META_LIMITS.uri} bytes`);
    }
  }

  const description = draft.description?.trim();
  if (description && byteLength(description) > META_LIMITS.description) {
    problems.push(
      `The description is ${byteLength(description)} bytes — the limit is ${META_LIMITS.description}`
    );
  }

  if (!draft.quote) problems.push("Pick what to price it against — the choice is permanent");
  else if (draft.quote.status !== "live") {
    // The factory reverts `QuoteNotEnabled()`. Better here than in the wallet.
    problems.push(`${draft.quote.symbol} is not enabled on the launchpad yet`);
  }

  const fee = draft.creatorFee;
  if (fee !== undefined) {
    if (fee < 0 || fee > MAX_CREATOR_FEE_PCT) {
      problems.push(`Creator tax must be between 0% and ${MAX_CREATOR_FEE_PCT}%`);
    } else if (!Number.isInteger(Math.round(fee * 100)) || Math.round(fee * 100) % 10 !== 0) {
      // 2.5% is 250 bps and legal; 2.55% is 255 and reverts. The control offers one decimal
      // place, so this is unreachable through the UI and reachable through a pasted draft.
      problems.push("Creator tax must be a multiple of 0.1%");
    }
  }

  if (draft.creatorFeeRecipient && !isAddress(draft.creatorFeeRecipient)) {
    problems.push("Tax recipient is not a valid address");
  }

  if (draft.devBuy !== undefined && (!Number.isFinite(draft.devBuy) || draft.devBuy < 0)) {
    problems.push("The dev buy must be a positive amount");
  }

  const withMon = draft.devBuyWithMon;
  if (withMon) {
    // Each of these is a swap that would be signed and buy nothing, and the launcher would have
    // paid for it before finding out.
    if (withMon.amountInWei <= 0n) problems.push("Enter how much MON to spend on the dev buy");
    if (withMon.path.length === 0) problems.push("No route from MON to this pair's asset");

    /*
     * A floor that rounds to zero, which only the BATCHED path can act on.
     *
     * A batch cannot read a balance between its calls, so the batched launch spends
     * `minQuoteOut` rather than the measured delta. Nothing else bounds it: with a floor of zero
     * the swap still happens and the launch buys NOTHING — the launcher's MON is spent and the
     * coin opens with no dev buy, while the identical draft through a non-batching wallet buys
     * with the delta. Reachable on a dust amount or a wide tolerance on a small one.
     */
    if (withMon.minQuoteOut <= 0n) {
      problems.push("The dev buy's floor rounds to zero — raise the amount or tighten slippage");
    }

    /*
     * The route must END at the asset the launch is going to spend.
     *
     * The swap `TAKE_ALL`s the last currency in the path while the launch approves and spends
     * `quoteAsset`. Where they differ, a batch swaps MON into one asset and then spends another —
     * one the launcher may already hold — at a floor computed in the wrong decimals. The
     * sequential path is protected by its before/after balance read; the batch has no equivalent,
     * so this is the only thing standing between the two.
     *
     * Not reachable through the bench today (changing the pair resets the route), which is why it
     * is an invariant rather than a bug report.
     */
    const terminus = withMon.path[withMon.path.length - 1]?.intermediateCurrency;
    if (draft.quote?.address && terminus?.toLowerCase() !== draft.quote.address.toLowerCase()) {
      problems.push("The MON route does not end at this pair's asset");
    }
    if (draft.quote && isNativeQuote(draft.quote)) {
      problems.push("A MON pair needs no swap — pay the dev buy in MON directly");
    }
  }

  return problems;
};

/** Whether a draft is complete enough to send. Shared by the button's disabled state and submit. */
export const draftIsComplete = (draft: Partial<LaunchDraft>): draft is LaunchDraft =>
  draftProblems(draft).length === 0;

/**
 * A whole-unit amount in the quote asset's own raw units.
 *
 * The decimals are the QUOTE's — six for USDC and gold, eight for cbBTC, eighteen for MON — and
 * never a global 18. Twenty-five USDC scaled by 18 asks the factory to pull twenty-five trillion
 * dollars, which fails on the allowance and reads to the launcher as a wallet problem.
 *
 * Built through a string rather than `Number * 10 ** d`, because a float times 1e18 loses the low
 * digits and this is an amount of somebody's money.
 */
export const toRawAmount = (whole: number, decimals: number): bigint => {
  if (!Number.isFinite(whole) || whole <= 0) return 0n;
  const [intPart, fracPart = ""] = whole.toFixed(decimals).split(".");
  return BigInt(intPart + fracPart.padEnd(decimals, "0"));
};

/**
 * The draft as the struct the factory takes, minus the pin.
 *
 * `economicsPin` is deliberately not built here: it has to be read immediately before the send,
 * and a mapping function that returned one would invite it being read early and carried across an
 * approval. `submitLaunch` fills it in as the last thing it does.
 */
export const toLaunchParams = (
  draft: LaunchDraft,
  opts: { creator: `0x${string}`; deadlineSecs?: number; nowMs?: number }
): Omit<LaunchParams, "economicsPin"> => {
  const sink = SINK_FOR_ROUTING[draft.feeRouting];
  const taxRecipient = (draft.creatorFeeRecipient?.trim() || opts.creator) as `0x${string}`;

  return {
    meta: {
      name: draft.name.trim(),
      ticker: draft.ticker.trim(),
      logoURI: draft.logo?.trim() ?? "",
      bannerURI: draft.banner?.trim() ?? "",
      description: draft.description?.trim() ?? "",
      website: draft.links?.website?.trim() ?? "",
      x: draft.links?.x?.trim() ?? "",
      // `links.discord` is collected by the form and has NO field in `DokuFactory.Metadata`. It is
      // dropped here, and `LinkFields` says so beside the input rather than letting somebody type
      // a link that quietly never arrives anywhere.
      telegram: draft.links?.telegram?.trim() ?? "",
    },
    quoteAsset: (draft.quote.address ?? ZERO_ADDRESS) as `0x${string}`,
    sink,
    /*
     * Zero unless the routing is `creator`.
     *
     * `routedRecipient` names who receives this market's share of the PROTOCOL fee, which only
     * exists as a destination when the creator keeps it. A holders market pays its rewards sink
     * and a buyback market burns; naming an address on either is a statement about money that
     * does not go there.
     */
    routedRecipient: sink === SINK_FOR_ROUTING.creator ? taxRecipient : ZERO_ADDRESS,
    // Percent to basis points. The form holds one decimal place, so this always lands on a
    // multiple of ten, which is what the contract requires.
    creatorTaxBps: Math.round((draft.creatorFee ?? 0) * 100),
    taxRecipient,
    firstBuyQuote: toRawAmount(draft.devBuy ?? 0, draft.quote.decimals),
    // Zero, and that is a decision. The first buy happens inside the launch transaction, at a
    // price nothing can front-run because the market does not exist until this call creates it —
    // so there is no slippage to protect against and a non-zero floor could only reject a fill
    // that was always going to be exactly what the curve says.
    firstBuyMinOut: 0n,
    deadline: BigInt(
      Math.floor((opts.nowMs ?? Date.now()) / 1000) + Math.floor(opts.deadlineSecs ?? 600)
    ),
  };
};

/** The factory's own name for "the terms moved between your quote and your send". */
const ECONOMICS_CHANGED = /EconomicsChanged/i;

/**
 * Submitting a launch.
 *
 * **The one place the app turns a draft into a transaction.**
 *
 * The order below is the whole of it, and it is not arbitrary:
 *
 *   1. **Validate** what the contract validates, so nothing reaches the wallet that a revert would
 *      have refused. Byte caps, ticker charset, an unenabled quote, a `data:` URI.
 *   2. **Predict** the market address. `predictMarket(creator)` answers before the transaction
 *      lands, so the market page can open the moment it confirms rather than after the indexer
 *      catches up.
 *   3. **Read the launch fee.** Owner-tunable, so it is read and not compiled in.
 *   4. **Approve, if the quote is an ERC-20 and there is a first buy** — the **factory**, not the
 *      curve. The curve is the natural guess: it holds the reserves and it is what every later buy
 *      approves. But the launch pulls the first buy itself, so an allowance granted to the curve
 *      leaves the launch reverting on an approval the launcher can see they made.
 *   5. **Read the economics pin, last.** It is a commitment to the terms as they stand right now,
 *      and step 4 is a whole transaction the launcher waits on. A pin read before the approval is a
 *      pin read across a gap of arbitrary length.
 *   6. **Send**, with an EXACT value. `msg.value == launchFee + firstBuyQuote` for a native quote
 *      and `== launchFee` for an ERC-20 one. Exact, not a minimum — the usual instinct to add a
 *      margin reverts here.
 *
 * ## The one wallet prompt, where the wallet can take one
 *
 * A dev buy funded in MON is the only launch that costs three signatures: swap, approve, launch.
 * Where the wallet implements EIP-5792 those three travel as one `wallet_sendCalls` — still the
 * launcher's own `msg.sender` on every call, so the factory still records them as the creator, and
 * a batch is emphatically not the router `pay-with` explains cannot exist.
 *
 * The reads keep their order. `predictMarket`, `launchFee` and then the pin, last, immediately
 * before the send: the pin is a commitment to the terms as they stand and everything above it is
 * a read rather than a transaction, so the gap it spans is one round trip either way.
 *
 * What the batched branch cannot do is step 4's balance read — there is nothing to read between
 * two calls of a batch — so it buys with `minQuoteOut`, the floor the swap is signed with. That is
 * safe, spends nothing the launcher already held, and is slightly SMALLER than the measured buy;
 * `launch-batch` sets out all three consequences, and the dev-buy step says the last one on screen.
 */
export async function submitLaunch(
  draft: Partial<LaunchDraft>,
  chain: LaunchChain
): Promise<LaunchResult> {
  const problems = draftProblems(draft);
  if (problems.length > 0 || !draftIsComplete(draft)) {
    return { status: "rejected", reason: problems[0] ?? "The draft is not complete." };
  }

  /**
   * What the swap actually delivered, once it has.
   *
   * Held out here so the catch below can say it. A launch that fails AFTER the swap has landed
   * leaves the launcher holding the pair's asset, and a bare "launch failed" invites them to
   * assume the swap is lost too — or to swap again.
   */
  let swapped: bigint | null = null;

  /**
   * Whether this attempt went out as a batch the wallet does NOT guarantee atomically.
   *
   * Only that case is ambiguous after a failure. An atomic batch landed all three calls or none of
   * them, and a rejection is a rejection of the whole thing — the single prompt comes before any of
   * it executes. A sequential one can land a prefix: a swap, or a swap and an approval, and then
   * stop. The launcher is owed that sentence rather than "nothing was spent", which would be a
   * guess in the direction that costs them money if it is wrong.
   */
  let sequentialBatch = false;

  try {
    const [{ curve, token }, fee] = await Promise.all([
      chain.predictMarket(chain.account),
      chain.launchFee(chain.account),
    ]);

    const params = toLaunchParams(draft, { creator: chain.account });
    const native = isNativeQuote(draft.quote);

    /*
     * How this launch travels: as it always has, or as one prompt.
     *
     * `batchSupport` is absent on every port that predates batching and on every wallet that could
     * not answer, and absent reads as `none` — so this is `sequential` unless a wallet positively
     * said otherwise, which is the fallback discipline `readBatchSupport` and `planMonDevBuy` both
     * exist to enforce.
     */
    const withMon = !native ? draft.devBuyWithMon : undefined;
    const plan = planMonDevBuy({
      support: chain.batchSupport ?? "none",
      hasDevBuyWithMon: Boolean(withMon),
    });

    if (plan.kind === "batched" && withMon && chain.sendBatch) {
      /*
       * The batched launch: swap, approve, launch, one signature.
       *
       * `firstBuyQuote` is `minQuoteOut` and NOT a measured balance, because a batch cannot read
       * one between its own calls. The swap's `amountOutMinimum` is that same floor, enforced by
       * the pool inside the transaction, so at least this much arrives or the swap reverts and
       * nothing downstream of it runs — the launch cannot be short. What it does not include is
       * the overshoot: the difference between the floor and what actually arrived stays in the
       * launcher's wallet as the pair's asset. See `launch-batch` for the whole argument.
       */
      params.firstBuyQuote = withMon.minQuoteOut;

      // Last, and for the same reason as ever — except that here the gap it spans is a single
      // round trip rather than two transactions, because nothing has been sent yet.
      const economicsPin = await chain.economicsPin(
        params.quoteAsset,
        params.sink,
        params.creatorTaxBps
      );

      sequentialBatch = !plan.atomic;
      const txHash = await chain.sendBatch(
        monDevBuyCalls({
          swap: encodeSwapNativeFor({
            path: withMon.path,
            amountIn: withMon.amountInWei,
            minOut: withMon.minQuoteOut,
          }),
          approve: encodeLaunchApproval(params.quoteAsset, chain.factory, withMon.minQuoteOut),
          // The fee alone: a batched launch is never a native-quote launch, so there is no first
          // buy riding in `msg.value`. Exact, not a minimum — the factory reverts on more.
          launch: encodeLaunchCall(chain.factory, { ...params, economicsPin }, fee),
        }),
        { atomic: plan.atomic }
      );

      return { status: "submitted", marketAddress: curve, tokenAddress: token, txHash };
    }

    /**
     * The swap, when the dev buy is being paid for in MON.
     *
     * Its own transaction, before everything else, and the launch then spends what it MEASURED
     * rather than what it was quoted. A swap delivers what it delivers: launching against the
     * estimate would approve and pull an amount the wallet does not hold, reverting for a
     * shortfall the launcher already paid for.
     *
     * The balance is read before and after rather than taken from a log, because the difference is
     * the only figure that is true of this wallet — a launcher who already held some of the pair's
     * asset must not have it swept into the dev buy, and one whose swap under-delivered must not
     * have the launch reverted on their behalf.
     */
    if (draft.devBuyWithMon && !native) {
      const before = await chain.balanceOf(params.quoteAsset, chain.account);
      await chain.swapNativeFor({
        path: draft.devBuyWithMon.path,
        amountIn: draft.devBuyWithMon.amountInWei,
        minOut: draft.devBuyWithMon.minQuoteOut,
      });
      const after = await chain.balanceOf(params.quoteAsset, chain.account);
      const received = after - before;
      if (received <= 0n) {
        return {
          status: "failed",
          reason:
            `The swap landed but delivered no ${draft.quote.symbol}, so there is nothing to buy with. ` +
            "Nothing was launched.",
        };
      }
      params.firstBuyQuote = received;
      swapped = received;
    }

    if (!native && params.firstBuyQuote > 0n) {
      const allowance = await chain.allowance(params.quoteAsset, chain.account, chain.factory);
      // Only when it is short. Re-approving an allowance that already covers the buy is a
      // transaction and a wallet prompt for nothing.
      if (allowance < params.firstBuyQuote) {
        await chain.approve(params.quoteAsset, chain.factory, params.firstBuyQuote);
      }
    }

    const economicsPin = await chain.economicsPin(
      params.quoteAsset,
      params.sink,
      params.creatorTaxBps
    );

    const value = native ? fee + params.firstBuyQuote : fee;
    const txHash = await chain.launch({ ...params, economicsPin }, value);

    return { status: "submitted", marketAddress: curve, tokenAddress: token, txHash };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (ECONOMICS_CHANGED.test(message)) {
      return {
        status: "terms-changed",
        reason:
          "The launch terms changed while you were reviewing them — the fee or the routing moved. " +
          "Nothing was signed and nothing was spent. Press launch again to read the new terms.",
      };
    }

    /*
      What is still true after a failure, and it changes with the swap.

      Once the swap has landed the launcher holds the pair's asset, so "nothing was spent" would be
      false and "try again" would swap a second time. Both sentences below say what they hold and
      what to do with it.
    */
    const held =
      swapped !== null
        ? ` The swap already landed: this wallet holds ${formatUnits(swapped, draft.quote.decimals)} ${draft.quote.symbol}, and launching again will use it rather than swapping more.`
        : sequentialBatch
          ? ` This went to your wallet as one batch, and your wallet does not guarantee those land together — part of it may have: check whether this wallet now holds ${draft.quote.symbol} before launching again.`
          : "";

    // A wallet rejection is the launcher's decision, not a fault, and must not be dressed up as
    // one: "user rejected" in red beside a warning triangle reads as something having gone wrong.
    if (/user rejected|denied transaction|rejected the request/i.test(message)) {
      return {
        status: "rejected",
        reason:
          swapped === null
            ? "You cancelled the transaction. Nothing was spent."
            : `You cancelled the launch.${held}`,
      };
    }

    const explained = explainChainError(error);
    return { status: "failed", reason: `${explained.headline}${held}`, detail: explained.detail };
  }
}
