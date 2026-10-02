/**
 * @jest-environment node
 */
import {
  epochRows,
  estimateBlockTime,
  formatQuote,
  formatUsd,
  holderShareOf,
  holderStanding,
  oldestClaimableEpoch,
  openableEpochs,
  usdOf,
  vaultSummary,
} from "../../src/lib/dividends";

const E = (index: number, amount: bigint, supply: bigint, claimed = 0n, opensAt = 1000n + BigInt(index) * 100n) => ({
  index,
  snapshotBlock: 900n + BigInt(index) * 100n,
  amount,
  eligibleSupply: supply,
  claimed,
  opensAtBlock: opensAt,
});

describe("holderShareOf", () => {
  it("divides in integers, the way the vault does", () => {
    expect(holderShareOf({ amount: 1_000n, eligibleSupply: 3n }, 1n)).toBe(333n);
    expect(holderShareOf({ amount: 507_820274138880245344n, eligibleSupply: 1_000_000_000n * 10n ** 18n }, 782_033_585n * 10n ** 18n)).toBe(
      (507_820274138880245344n * (782_033_585n * 10n ** 18n)) / (1_000_000_000n * 10n ** 18n),
    );
  });
  it("is zero on an empty epoch, a zero weight, or a zero eligible supply", () => {
    expect(holderShareOf({ amount: 0n, eligibleSupply: 10n }, 5n)).toBe(0n);
    expect(holderShareOf({ amount: 10n, eligibleSupply: 10n }, 0n)).toBe(0n);
    expect(holderShareOf({ amount: 10n, eligibleSupply: 0n }, 5n)).toBe(0n);
  });
});

describe("epochRows", () => {
  it("names each epoch's status from the current block and the holder's record", () => {
    const epochs = [E(0, 100n, 10n), E(1, 200n, 10n), E(2, 300n, 10n)];
    const holder = { weights: { 0: 5n, 1: 5n, 2: 5n }, claimed: { 0: true } };
    const ledger = epochRows({ epochs, currentBlock: 1150n, holder });
    expect(ledger.rows.map((r) => r.status)).toEqual(["claimed", "claimable", "accruing"]);
    expect(ledger.rows[1]!.holderShare).toBe(100n);
    expect(ledger.rows[1]!.holderClaimable).toBe(100n);
    expect(ledger.rows[0]!.holderClaimable).toBe(0n);
    expect(ledger.claimableRange).toEqual({ from: 1, to: 1 });
    expect(ledger.totals.holderClaimable).toBe(100n);
  });

  it("is matured, not claimable, for a reader with no wallet or no weight", () => {
    const epochs = [E(0, 100n, 10n)];
    expect(epochRows({ epochs, currentBlock: 5000n }).rows[0]!.status).toBe("matured");
    expect(epochRows({ epochs, currentBlock: 5000n, holder: { weights: {}, claimed: {} } }).rows[0]!.status).toBe("matured");
  });

  it("opens exactly one block after the next snapshot", () => {
    const epochs = [E(0, 100n, 10n, 0n, 1000n)];
    const holder = { weights: { 0: 1n }, claimed: {} };
    expect(epochRows({ epochs, currentBlock: 1000n, holder }).rows[0]!.status).toBe("accruing");
    expect(epochRows({ epochs, currentBlock: 1001n, holder }).rows[0]!.status).toBe("claimable");
  });

  it("returns the contiguous range spanning the claimable epochs", () => {
    const epochs = [E(0, 100n, 10n), E(1, 0n, 10n), E(2, 300n, 10n), E(3, 400n, 10n)];
    const holder = { weights: { 0: 1n, 1: 1n, 2: 1n, 3: 1n }, claimed: {} };
    const ledger = epochRows({ epochs, currentBlock: 9000n, holder });
    expect(ledger.rows.map((r) => r.status)).toEqual(["claimable", "matured", "claimable", "claimable"]);
    expect(ledger.claimableRange).toEqual({ from: 0, to: 3 });
  });

  it("sums totals and never lets remaining go negative", () => {
    const epochs = [E(0, 100n, 10n, 100n), E(1, 50n, 10n, 60n)];
    const ledger = epochRows({ epochs, currentBlock: 9000n });
    expect(ledger.totals).toEqual({ distributed: 150n, claimed: 160n, remaining: 0n, holderClaimable: 0n });
    expect(ledger.claimableRange).toBeNull();
  });

  it("sorts by index whatever order the reads arrived in", () => {
    const ledger = epochRows({ epochs: [E(2, 1n, 1n), E(0, 1n, 1n), E(1, 1n, 1n)], currentBlock: 0n });
    expect(ledger.rows.map((r) => r.index)).toEqual([0, 1, 2]);
  });
});

describe("formatting", () => {
  it("prints quote amounts at the asset's decimals", () => {
    expect(formatQuote(507_820274138880245344n, 18)).toBe("507.82");
    expect(formatQuote(5274343742376188n, 18)).toBe("0.00527");
    expect(formatQuote(0n, 6)).toBe("0");
    expect(formatQuote(8_000_000_000n, 6)).toBe("8K");
  });
  it("estimates a block's time from the chain's pace", () => {
    const now = 1_000_000_000_000;
    expect(estimateBlockTime(1100n, 1000n, now).getTime()).toBe(now + 100 * 400);
    expect(estimateBlockTime(900n, 1000n, now).getTime()).toBe(now - 100 * 400);
  });
});

describe("openableEpochs", () => {
  it("counts consecutive closed intervals from the vault's epoch count", () => {
    expect(openableEpochs(0, [100n, 200n, 300n], 250n)).toBe(2);
    expect(openableEpochs(0, [100n, 200n, 300n], 301n)).toBe(3);
    expect(openableEpochs(2, [100n, 200n], 150n)).toBe(1);
  });
  it("stops at the first interval still open, and opens only past the close", () => {
    expect(openableEpochs(0, [100n, 200n], 100n)).toBe(0);
    expect(openableEpochs(0, [100n, 200n], 101n)).toBe(1);
    expect(openableEpochs(0, [300n, 100n], 200n)).toBe(0);
  });
  it("is zero with nothing to read", () => {
    expect(openableEpochs(0, [], 999n)).toBe(0);
  });
});

describe("vaultSummary", () => {
  it("adds paid, waiting and awaiting-split back up to everything funded, off the balance", () => {
    const rows = [
      { distributed: 100n, claimed: 40n },
      { distributed: 50n, claimed: 0n },
    ];
    // The vault holds what is waiting (110) plus what awaits a split (30).
    expect(vaultSummary(rows, 30n, 140n)).toEqual({ funded: 180n, paid: 40n, waiting: 110n, awaitingSplit: 30n });
  });
  it("is all zeros on a vault nobody has funded", () => {
    expect(vaultSummary([], 0n, 0n)).toEqual({ funded: 0n, paid: 0n, waiting: 0n, awaitingSplit: 0n });
  });
  it("does not count a swept remainder twice", () => {
    // Epoch 0 closed 26 epochs ago with 60 unclaimed; sweepResidue moved the 60 into unallocated
    // and left the row as it was. The balance is still 60.
    const rows = [{ distributed: 100n, claimed: 40n }];
    expect(vaultSummary(rows, 60n, 60n)).toEqual({ funded: 100n, paid: 40n, waiting: 0n, awaitingSplit: 60n });
  });
  it("matches TR1's vault: four epochs of 0.011156 MON plus 0.101358 MON unallocated is the vault's balance", () => {
    const epoch = { distributed: 11155878849485338n, claimed: 0n };
    const balance = 145981414449446895n;
    const out = vaultSummary([{ ...epoch, distributed: 11155878849485341n }, epoch, epoch, epoch], 101357899051505540n, balance);
    expect(out.funded).toBe(balance);
    expect(out.waiting).toBe(44623515397941355n);
    expect(out.paid).toBe(0n);
  });
});

describe("dollars", () => {
  it("prices a quote amount when the quote has a price and refuses when it does not", () => {
    expect(usdOf(2_000_000_000_000_000_000n, 18, 0.5)).toBe(1);
    expect(usdOf(1n, 18, null)).toBeNull();
    expect(usdOf(1n, 18, 0)).toBeNull();
  });
  it("prints cents above a dollar and significant digits below", () => {
    expect(formatUsd(1234.5)).toBe("$1.23K");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(0.003369)).toBe("$0.00337");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(null)).toBe("");
  });
});

/**
 * What a holder is told about the epoch that is accruing now. Every case below was run against the
 * real vault on a fork of mainnet first (2026-09-19): an epoch pays a wallet on the LOWER of its
 * balance at the opening snapshot and at the closing one, 216,000 blocks later. A wallet that held
 * for twenty minutes between the two, or across only one of them, was paid nothing.
 */
describe("holderStanding", () => {
  const OPEN = 1_000_000n;
  const CLOSE = OPEN + 216_000n;
  const MID = OPEN + 100_000n;
  const T = 10n ** 18n;
  const at = (over: Partial<Parameters<typeof holderStanding>[0]>) =>
    holderStanding({ currentBlock: MID, opensAtBlock: OPEN, closesAtBlock: CLOSE, balanceAtOpen: 0n, balanceNow: 0n, ...over });

  it("says nothing is accruing to a wallet that held none at the snapshot and holds none now", () => {
    expect(at({})).toEqual({ kind: "none" });
  });

  it("tells a wallet that bought after the snapshot when it starts earning and when it can first claim", () => {
    // The day it bought in pays it nothing; the next epoch opens at this one's close, and is
    // claimable one epoch after that. Bought twenty minutes after a snapshot, that is ~47h40m away.
    expect(at({ balanceNow: 100n * T })).toEqual({
      kind: "bought-after-snapshot",
      startsAtBlock: CLOSE,
      firstClaimAtBlock: CLOSE + 216_000n,
    });
  });

  it("counts the lower of the two balances for a wallet that held at the snapshot", () => {
    expect(at({ balanceAtOpen: 100n * T, balanceNow: 100n * T })).toEqual({
      kind: "earning",
      counted: 100n * T,
      soldSince: false,
      claimableAtBlock: CLOSE,
    });
    // Sold sixty percent at midday: paid on forty.
    expect(at({ balanceAtOpen: 100n * T, balanceNow: 40n * T })).toEqual({
      kind: "earning",
      counted: 40n * T,
      soldSince: true,
      claimableAtBlock: CLOSE,
    });
    // Bought more at midday: the extra does not count until the next epoch.
    expect(at({ balanceAtOpen: 40n * T, balanceNow: 100n * T })).toEqual({
      kind: "earning",
      counted: 40n * T,
      soldSince: false,
      claimableAtBlock: CLOSE,
    });
  });

  it("warns a wallet that held at the snapshot and has sold everything since", () => {
    expect(at({ balanceAtOpen: 100n * T, balanceNow: 0n })).toEqual({
      kind: "sold-out",
      heldAtOpen: 100n * T,
      closesAtBlock: CLOSE,
    });
  });

  it("before the first snapshot of a market's life, tells a holder to hold through both lines", () => {
    // The first day after graduation: the opening line is still ahead, so there is no snapshot
    // balance to read, and the token would revert if asked for one.
    expect(at({ currentBlock: OPEN - 5_000n, balanceAtOpen: null, balanceNow: 100n * T })).toEqual({
      kind: "before-first-snapshot",
      snapshotAtBlock: OPEN,
      claimableAtBlock: CLOSE,
    });
    expect(at({ currentBlock: OPEN, balanceAtOpen: null, balanceNow: 100n * T }).kind).toBe("before-first-snapshot");
    expect(at({ currentBlock: OPEN - 5_000n, balanceAtOpen: null, balanceNow: 0n })).toEqual({ kind: "none" });
  });

  it("says it does not know rather than guess when the snapshot balance could not be read", () => {
    expect(at({ balanceAtOpen: null, balanceNow: 100n * T })).toEqual({ kind: "unknown" });
  });
});

describe("oldestClaimableEpoch", () => {
  it("names the epoch whose claim window closes first, which is the one the deadline comes from", () => {
    const ledger = epochRows({
      epochs: [E(0, 100n, 10n), E(1, 100n, 10n), E(2, 100n, 10n)],
      currentBlock: 5_000n,
      holder: { weights: { 0: 5n, 1: 5n, 2: 5n }, claimed: { 0: true, 1: false, 2: false } },
    });
    expect(oldestClaimableEpoch(ledger.rows)).toBe(1);
  });

  it("is null when there is nothing to claim", () => {
    const ledger = epochRows({ epochs: [E(0, 100n, 10n)], currentBlock: 5_000n, holder: { weights: { 0: 0n }, claimed: {} } });
    expect(oldestClaimableEpoch(ledger.rows)).toBeNull();
    expect(oldestClaimableEpoch([])).toBeNull();
  });
});
