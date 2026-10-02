/** @jest-environment node */
import {
  claimRequest,
  collectPlan,
  creatorClaimLots,
  creatorMarketFees,
  type CreatorMarketReads,
  formatQuoteAmount,
  pullRequest,
} from "../../src/lib/chain/creator-fees";

/**
 * What a creator is owed, and which of the three contracts is currently holding it.
 *
 * The money moves curve → hook → sink → wallet, and each hop has its own caller and its own
 * revert. `BondingCurve.collectFees`/`collectTax` reverts `ZeroAmount` on nothing, `CreatorSink
 * .claim` reverts `NothingToClaim` on nothing, and `CreatorSink.pull` does NOT revert on nothing —
 * it succeeds having moved zero, which spends a creator's gas to achieve exactly what not pressing
 * the button achieves. So every one of these has to be decided on the raw `bigint` before a button
 * is drawn, and that decision is what this file pins.
 *
 * The addresses are deliberately mixed case. `feeRecipient()` and `entries().routed` come back
 * checksummed from an `eth_call` while a connected wallet address arrives however the wallet felt
 * like sending it, and an ownership test that compared them literally would tell a creator their
 * own market pays somebody else.
 */

const CREATOR = "0x1111111111111111111111111111111111111111";
const CREATOR_CHECKSUMMED = "0x1111111111111111111111111111111111111111"
  .toUpperCase()
  .replace("0X", "0x");
const STRANGER = "0x2222222222222222222222222222222222222222";
/** A HOLDERS market's routed recipient is its RewardVault, never a wallet. */
const VAULT = "0x3333333333333333333333333333333333333333";

/** USDC on Monad: six decimals, which is the whole point of not assuming eighteen. */
const USDC = "0xAAAA000000000000000000000000000000000001";
/** Native MON, as a `PoolKey` carries it. */
const NATIVE = "0x0000000000000000000000000000000000000000";

const market = (over: Partial<CreatorMarketReads> = {}): CreatorMarketReads => ({
  marketAddress: "0xMarKet00000000000000000000000000000000A1",
  quoteAsset: USDC,
  quoteDecimals: 6,
  quoteSymbol: "USDC",
  routing: "creator",
  feeRecipient: CREATOR_CHECKSUMMED,
  taxRecipient: CREATOR_CHECKSUMMED,
  curvePendingFees: 0n,
  curvePendingTax: 0n,
  sinkRegistered: false,
  sinkRouted: null,
  sinkTax: null,
  hookPendingSink: 0n,
  hookOwedSink: 0n,
  hookOwedTax: 0n,
  ...over,
});

describe("what one market owes its creator", () => {
  it("offers nothing on a market that has earned nothing", () => {
    const fees = creatorMarketFees(market(), CREATOR);
    expect(fees).toMatchObject({
      collectableFees: 0n,
      collectableTax: 0n,
      pullable: 0n,
      owed: 0n,
      actions: [],
    });
  });

  it("offers nothing at all when no wallet is connected", () => {
    const fees = creatorMarketFees(market({ curvePendingFees: 500_000n }), null);
    expect(fees.actions).toEqual([]);
  });

  it("offers collectFees for the routed share still sitting on the curve", () => {
    const fees = creatorMarketFees(market({ curvePendingFees: 12_500_000n }), CREATOR);
    expect(fees).toMatchObject({ collectableFees: 12_500_000n, actions: ["collectFees"] });
  });

  it("offers collectTax separately from the routed share", () => {
    const fees = creatorMarketFees(market({ curvePendingFees: 1n, curvePendingTax: 7n }), CREATOR);
    expect(fees.actions).toEqual(["collectFees", "collectTax"]);
  });

  it("keeps a market whose fees pay somebody else out of the reader's total", () => {
    const fees = creatorMarketFees(
      market({
        feeRecipient: STRANGER,
        taxRecipient: STRANGER,
        curvePendingFees: 9_000_000n,
        curvePendingTax: 4n,
      }),
      CREATOR
    );
    expect(fees).toMatchObject({ collectableFees: 0n, collectableTax: 0n, owed: 0n, actions: [] });
  });

  // ------------------------------------------------------------------------------ the pull hop

  it("needs a pull before the hook's routed share can be claimed", () => {
    const fees = creatorMarketFees(
      market({
        sinkRegistered: true,
        sinkRouted: CREATOR_CHECKSUMMED,
        sinkTax: CREATOR_CHECKSUMMED,
        hookOwedSink: 250_000n,
      }),
      CREATOR
    );
    expect(fees).toMatchObject({ pullable: 250_000n, actions: ["pull"] });
  });

  it("counts the unswept accrual too, because pull sweeps before it pulls", () => {
    // `CreatorSink.pull` calls `hook.sweep(id)` whenever `pendingSink` is non-zero, so what one
    // press moves is both ledgers and not only the swept one.
    const fees = creatorMarketFees(
      market({
        sinkRegistered: true,
        sinkRouted: CREATOR,
        sinkTax: CREATOR,
        hookPendingSink: 40n,
        hookOwedSink: 60n,
      }),
      CREATOR
    );
    expect(fees.pullable).toBe(100n);
  });

  it("offers no pull on a market the sink has never registered", () => {
    // `pull` reverts `NotRegistered` there — the market has not graduated, so there is no pool.
    const fees = creatorMarketFees(
      market({ sinkRegistered: false, sinkRouted: CREATOR, sinkTax: CREATOR, hookOwedSink: 999n }),
      CREATOR
    );
    expect(fees).toMatchObject({ pullable: 0n, actions: [] });
  });

  it("pulls the creator tax off a market whose routed share is a vault's", () => {
    // A HOLDERS market with a creator tax is registered with `routed` set to its vault. Its routed
    // leg is never the creator's — `pullSink` answers the shared sink zero — but the tax leg is.
    const fees = creatorMarketFees(
      market({
        routing: "holders",
        feeRecipient: VAULT,
        sinkRegistered: true,
        sinkRouted: VAULT,
        sinkTax: CREATOR,
        hookPendingSink: 5_000_000n,
        hookOwedSink: 5_000_000n,
        hookOwedTax: 30_000n,
      }),
      CREATOR
    );
    expect(fees).toMatchObject({ pullable: 30_000n, owed: 30_000n, actions: ["pull"] });
  });

  it("never claims a buyback market's routed share even if the sink names the creator", () => {
    // Belt and braces against a mis-read entry: a BURN market's sink is paid in the TOKEN, so
    // nothing the shared CreatorSink pulls for it is quote the creator could be credited.
    const fees = creatorMarketFees(
      market({
        routing: "buyback",
        sinkRegistered: true,
        sinkRouted: CREATOR,
        sinkTax: CREATOR,
        hookOwedSink: 1_000n,
      }),
      CREATOR
    );
    expect(fees.pullable).toBe(0n);
  });

  it("adds the curve leg and the hook leg into one figure for the market", () => {
    const fees = creatorMarketFees(
      market({
        curvePendingFees: 1_000_000n,
        curvePendingTax: 500_000n,
        sinkRegistered: true,
        sinkRouted: CREATOR,
        sinkTax: CREATOR,
        hookOwedSink: 250_000n,
        hookOwedTax: 250_000n,
      }),
      CREATOR
    );
    expect(fees.owed).toBe(2_000_000n);
  });

  it("treats one raw unit as something to claim", () => {
    // Dust in raw units is still money, and a button decided on the FORMATTED number would be
    // dead here: 1 raw unit of six-decimal gold prints as 0.000001 and rounds to 0.00.
    const fees = creatorMarketFees(market({ curvePendingFees: 1n }), CREATOR);
    expect(fees.actions).toEqual(["collectFees"]);
  });
});

// ----------------------------------------------------------------------------- claim, per asset

describe("what the sink is already holding, per quote asset", () => {
  const usdcMarket = creatorMarketFees(
    market({ sinkRegistered: true, sinkRouted: CREATOR, sinkTax: CREATOR, hookOwedSink: 400_000n }),
    CREATOR
  );
  const monMarket = creatorMarketFees(
    market({
      marketAddress: "0xMarKet00000000000000000000000000000000B2",
      quoteAsset: NATIVE,
      quoteDecimals: 18,
      quoteSymbol: "MON",
      curvePendingFees: 10n ** 18n,
    }),
    CREATOR
  );

  it("gives each asset its own lot and never a total across them", () => {
    const lots = creatorClaimLots(
      [usdcMarket, monMarket],
      new Map([[USDC.toLowerCase(), 7_000_000n]])
    );
    expect(lots.map((l) => [l.quoteSymbol, l.claimable, l.pullable, l.onCurve])).toEqual([
      ["USDC", 7_000_000n, 400_000n, 0n],
      ["MON", 0n, 0n, 10n ** 18n],
    ]);
  });

  it("refuses to claim an asset the sink holds nothing of", () => {
    // `claim(quote)` reverts `NothingToClaim` at zero. A live button there costs gas and returns
    // an error a creator cannot act on.
    const [lot] = creatorClaimLots([monMarket], new Map());
    expect(lot.canClaim).toBe(false);
  });

  it("claims one raw unit rather than calling it nothing", () => {
    const [lot] = creatorClaimLots([usdcMarket], new Map([[USDC.toLowerCase(), 1n]]));
    expect(lot.canClaim).toBe(true);
  });

  it("holds a balance for an asset even when no market currently owes anything", () => {
    // `CreatorSink.credit` takes a failed push from a curve that may since have been collected
    // dry, so a lot can exist with no market behind it. Dropping it would hide real money.
    const lots = creatorClaimLots([], new Map([[USDC.toLowerCase(), 3n]]));
    expect(lots).toEqual([
      {
        quoteAsset: USDC.toLowerCase(),
        // Nothing the reader launched is priced in it, so there is no row to learn the scale from.
        quoteSymbol: null,
        quoteDecimals: null,
        claimable: 3n,
        pullable: 0n,
        onCurve: 0n,
        canClaim: true,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------- the labels

describe("the figure a creator reads", () => {
  it("scales by the market's own decimals and not by eighteen", () => {
    // One whole troy ounce of six-decimal gold. At eighteen decimals it prints 0.
    expect(formatQuoteAmount(1_000_000n, 6)).toBe("1");
  });

  it("says a dust balance is below the smallest figure it can print, never zero", () => {
    expect(formatQuoteAmount(1n, 6)).toBe("<0.0001");
  });

  it("prints a true zero as zero", () => {
    expect(formatQuoteAmount(0n, 6)).toBe("0");
  });

  it("keeps four places on a small balance", () => {
    expect(formatQuoteAmount(1_234n, 6)).toBe("0.0012");
  });

  it("abbreviates a large balance", () => {
    expect(formatQuoteAmount(2_500_000_000_000n, 6)).toBe("2.50M");
  });

  it("draws a dash rather than a number at a scale it does not know", () => {
    expect(formatQuoteAmount(3n, null)).toBe("—");
  });
});

describe("the calls", () => {
  /*
    The two transactions this page can send, pinned by NAME and by argument list. Both are checked
    against the generated `creatorSinkAbi` by the compiler; these assert the arguments that go with
    them, which the compiler only types as `readonly [\`0x${string}\`]`.
  */
  const SINK = "0x9999999999999999999999999999999999999999" as const;

  it("pulls a market's hook ledgers into the sink", () => {
    expect(pullRequest(SINK, "0x4444444444444444444444444444444444444444")).toMatchObject({
      address: SINK,
      functionName: "pull",
      args: ["0x4444444444444444444444444444444444444444"],
    });
  });

  it("claims one asset at a time, because that is how the ledger is keyed", () => {
    expect(claimRequest(SINK, "0x5555555555555555555555555555555555555555")).toMatchObject({
      functionName: "claim",
      args: ["0x5555555555555555555555555555555555555555"],
    });
  });
});

/**
 * One button for a creator's money.
 *
 * After graduation a creator's fees sit in the hook until somebody calls `CreatorSink.pull(market)`,
 * and only then can `claim(quote)` pay them. The panel offered those as two unrelated buttons, with
 * Claim DISABLED whenever the sink itself held nothing — which is exactly the state of a creator
 * whose whole balance is "waiting on a pull". The plan is what one press has to send.
 */
describe("collectPlan", () => {
  const lot = (over: { claimable?: bigint; pullable?: bigint }) => ({
    quoteAsset: "0xq",
    claimable: over.claimable ?? 0n,
    pullable: over.pullable ?? 0n,
  });
  const market = (marketAddress: string, pullable: bigint, quoteAsset = "0xQ") => ({ marketAddress, quoteAsset, pullable });

  it("pulls every market that has something waiting, in order, and then claims", () => {
    expect(collectPlan(lot({ pullable: 7n }), [market("0xa", 3n), market("0xb", 4n)])).toEqual([
      { kind: "pull", market: "0xa" },
      { kind: "pull", market: "0xb" },
      { kind: "claim", quoteAsset: "0xq" },
    ]);
  });

  it("is a plain claim when nothing is waiting on a pull", () => {
    expect(collectPlan(lot({ claimable: 5n }), [market("0xa", 0n)])).toEqual([{ kind: "claim", quoteAsset: "0xq" }]);
  });

  it("leaves out markets priced in another asset, and markets with nothing to pull", () => {
    expect(collectPlan(lot({ pullable: 3n }), [market("0xa", 3n), market("0xother", 9n, "0xZZ"), market("0xempty", 0n)])).toEqual([
      { kind: "pull", market: "0xa" },
      { kind: "claim", quoteAsset: "0xq" },
    ]);
  });

  it("is empty when there is nothing to collect at all: a claim of nothing reverts, and on Monad a revert is billed", () => {
    expect(collectPlan(lot({}), [market("0xa", 0n)])).toEqual([]);
  });
});
