/**
 * @jest-environment node
 */
import { decodeFunctionData, erc20Abi, maxUint256 } from "viem";

import {
  encodeMaxApproval,
  planZappedSell,
  readBatchSupport,
  zappedSellCalls,
} from "../../src/lib/chain/sell-batch";
import { encodeZapSellToNative, zapRouterAbi } from "../../src/lib/chain/zap";

const CHAIN = 10143;
const OTHER_CHAIN = 1;
/* Digits only, deliberately: viem checksums an address on the way back out of a decode, and a
 * fixture with letters in it would be comparing "0xab…" against "0xAb…" rather than testing this
 * module. */
const ROUTER = "0x0000000000000000000000000000000000001234" as `0x${string}`;
const TOKEN = "0x0000000000000000000000000000000000005678" as `0x${string}`;
const CURVE = "0x0000000000000000000000000000000000009012" as `0x${string}`;
const QUOTE = "0x0000000000000000000000000000000000003456" as `0x${string}`;

/** Whatever `wallet_getCapabilities` answered, keyed the way viem hands it back: by number. */
const byNumber = (entry: unknown) => ({ [CHAIN]: entry });

describe("reading the wallet's batching capability", () => {
  it("takes the current shape's `supported` as atomic", () => {
    expect(readBatchSupport(byNumber({ atomic: { status: "supported" } }), CHAIN)).toBe("atomic");
  });

  it("takes `ready` as atomic too, because an upgrade prompt is still one prompt", () => {
    expect(readBatchSupport(byNumber({ atomic: { status: "ready" } }), CHAIN)).toBe("atomic");
  });

  it("reads `unsupported` as sequential batching, not as no batching", () => {
    // A wallet only answers the `atomic` capability if it implements `wallet_sendCalls`. What it
    // is declining is the guarantee, not the batch — and sequential is exactly today's two
    // transactions minus one prompt.
    expect(readBatchSupport(byNumber({ atomic: { status: "unsupported" } }), CHAIN)).toBe(
      "sequential"
    );
  });

  it("takes the earlier shape's `atomicBatch: { supported: true }`", () => {
    expect(readBatchSupport(byNumber({ atomicBatch: { supported: true } }), CHAIN)).toBe("atomic");
  });

  it("refuses the earlier shape when it says false", () => {
    expect(readBatchSupport(byNumber({ atomicBatch: { supported: false } }), CHAIN)).toBe("none");
  });

  it("refuses a `supported` that is merely truthy", () => {
    // `"true"`, `1`, `{}` — a wallet answering something else is a wallet this build has not been
    // read against, and the fallback costs one extra prompt rather than a sell that never lands.
    for (const supported of ["true", 1, {}, null, undefined]) {
      expect(readBatchSupport(byNumber({ atomicBatch: { supported } }), CHAIN)).toBe("none");
    }
  });

  it("finds the entry under a hex-quantity key, which is how the raw answer arrives", () => {
    const hex = { "0x279f": { atomic: { status: "supported" } } };
    expect(Number("0x279f")).toBe(CHAIN);
    expect(readBatchSupport(hex, CHAIN)).toBe("atomic");
    expect(readBatchSupport({ "0X279F": { atomic: { status: "supported" } } }, CHAIN)).toBe(
      "atomic"
    );
  });

  it("finds it under a decimal string key as well", () => {
    expect(readBatchSupport({ "10143": { atomic: { status: "supported" } } }, CHAIN)).toBe(
      "atomic"
    );
  });

  it("will not read another chain's answer", () => {
    // Capabilities are per chain: a wallet that batches on its own L2 need not batch on Monad, and
    // borrowing the neighbouring entry is how `wallet_sendCalls` gets sent somewhere it is unknown.
    const elsewhere = { [OTHER_CHAIN]: { atomic: { status: "supported" } } };
    expect(readBatchSupport(elsewhere, CHAIN)).toBe("none");
  });

  it("prefers the current shape where a wallet answers both", () => {
    const both = byNumber({ atomic: { status: "unsupported" }, atomicBatch: { supported: true } });
    expect(readBatchSupport(both, CHAIN)).toBe("sequential");
  });

  it("falls back on every uncertain answer", () => {
    // The whole point of the type: `none` is the safe answer, and everything unrecognised is it.
    expect(readBatchSupport(undefined, CHAIN)).toBe("none");
    expect(readBatchSupport(null, CHAIN)).toBe("none");
    expect(readBatchSupport("atomic", CHAIN)).toBe("none");
    expect(readBatchSupport([{ atomic: { status: "supported" } }], CHAIN)).toBe("none");
    expect(readBatchSupport({}, CHAIN)).toBe("none");
    expect(readBatchSupport(byNumber(null), CHAIN)).toBe("none");
    expect(readBatchSupport(byNumber("supported"), CHAIN)).toBe("none");
    expect(readBatchSupport(byNumber({}), CHAIN)).toBe("none");
    expect(readBatchSupport(byNumber({ atomic: {} }), CHAIN)).toBe("none");
    expect(readBatchSupport(byNumber({ atomic: { status: "maybe" } }), CHAIN)).toBe("none");
    expect(readBatchSupport(byNumber({ paymasterService: { supported: true } }), CHAIN)).toBe(
      "none"
    );
  });

  it("does not match an empty key against chain zero-ish arithmetic", () => {
    // `Number("")` is 0, and a blank key must not be allowed to answer for any chain.
    expect(readBatchSupport({ "": { atomic: { status: "supported" } } }, 0)).toBe("none");
  });

  /**
   * The already-narrowed shape, which is one optional argument away at every call site.
   *
   * viem's `getCapabilities` returns the whole chain-keyed map when it is given no `chainId` and
   * the ENTRY for that chain when it is given one — `viem/actions/wallet/getCapabilities.ts:86-88`,
   * forwarded by wagmi at `@wagmi/core/src/actions/getCapabilities.ts:33-38`. Neither caller passes
   * a `chainId` today, so the map is what actually arrives; but an edit adding one would look like
   * a tightening and would turn batching off for good, with no error anywhere to say so.
   */
  describe("the shape viem returns when it is asked about one chain", () => {
    it("reads a bare entry, since a chain map can never have `atomic` at its top level", () => {
      expect(readBatchSupport({ atomic: { status: "supported" } }, CHAIN)).toBe("atomic");
      expect(readBatchSupport({ atomic: { status: "unsupported" } }, CHAIN)).toBe("sequential");
      expect(readBatchSupport({ atomicBatch: { supported: true } }, CHAIN)).toBe("atomic");
    });

    it("still refuses everything uncertain in that shape", () => {
      expect(readBatchSupport({ atomic: { status: "maybe" } }, CHAIN)).toBe("none");
      expect(readBatchSupport({ atomic: null }, CHAIN)).toBe("none");
      expect(readBatchSupport({ atomicBatch: { supported: "true" } }, CHAIN)).toBe("none");
      expect(readBatchSupport({ paymasterService: { supported: true } }, CHAIN)).toBe("none");
    });

    it("never lets it override the keyed map, which is read FIRST and still decides", () => {
      /*
       * The per-chain discipline is the whole module, so the narrowed read is a fallback and never
       * a shortcut: an answer that HAS an entry for this chain is answered from that entry, and an
       * answer that has one for another chain still says nothing about Monad.
       */
      const conflicting = {
        [CHAIN]: { atomic: { status: "unsupported" } },
        atomic: { status: "supported" },
      };
      expect(readBatchSupport(conflicting, CHAIN)).toBe("sequential");

      const elsewhere = { [OTHER_CHAIN]: { atomic: { status: "supported" } } };
      expect(readBatchSupport(elsewhere, CHAIN)).toBe("none");

      // An entry present for this chain but unreadable is unreadable — not a reason to fall
      // through to a top-level field that happens to be friendlier.
      expect(readBatchSupport({ [CHAIN]: null, atomic: { status: "supported" } }, CHAIN)).toBe(
        "none"
      );
    });
  });

  /**
   * The newer field decides where a wallet answered it, even when it answered it badly.
   *
   * A wallet that returns `atomic` is speaking the spec as it now stands. An `atomic` this build
   * cannot read is an unreadable answer, and looking past it to a legacy field that says something
   * more convenient is exactly the direction that ends in a `wallet_sendCalls` nobody advertised.
   */
  it("does not fall through from an unreadable `atomic` to a friendlier `atomicBatch`", () => {
    for (const atomic of [null, "supported", 1, [], {}, { status: "maybe" }]) {
      expect(readBatchSupport(byNumber({ atomic, atomicBatch: { supported: true } }), CHAIN)).toBe(
        "none"
      );
    }
  });

  /**
   * The third published shape: `atomic: { supported: true }`, with no `status`.
   *
   * Not the spec — the spec is `status`. It is read because Coinbase publishes all three shapes at
   * once (`atomicBatch.supported` in the batching guide, `atomic.status` in the CDP SDK types, and
   * this one in the JSON-RPC reference's "Full Capabilities Response"), and because the wallet it
   * belongs to reaches this app as an injected provider whose answer is documented nowhere.
   */
  describe("the third shape, `atomic` carrying `supported` instead of `status`", () => {
    it("takes an explicit `supported: true`", () => {
      expect(readBatchSupport(byNumber({ atomic: { supported: true } }), CHAIN)).toBe("atomic");
    });

    it("refuses it when it is anything other than literally `true`", () => {
      for (const supported of ["true", 1, {}, false, null, undefined]) {
        expect(readBatchSupport(byNumber({ atomic: { supported } }), CHAIN)).toBe("none");
      }
    });

    it("never lets it speak over a `status`, which is the shape the spec actually defines", () => {
      // A wallet that answered `status` has answered the spec. A `status` this build cannot parse
      // is unreadable, and `supported` beside it is not a second opinion to fall back on.
      expect(
        readBatchSupport(byNumber({ atomic: { status: "unsupported", supported: true } }), CHAIN)
      ).toBe("sequential");
      expect(
        readBatchSupport(byNumber({ atomic: { status: "maybe", supported: true } }), CHAIN)
      ).toBe("none");
    });
  });

  /**
   * Not every key in the map is a chain.
   *
   * Coinbase's documented capability response carries a `"0x0"` pseudo-entry for
   * `gasLimitOverride` alongside the real chains. There is no chain 0, so nothing that parses to
   * one may be allowed to answer for one.
   */
  it("ignores the `0x0` pseudo-chain, and every other non-chain key", () => {
    expect(readBatchSupport({ "0x0": { atomic: { status: "supported" } } }, 0)).toBe("none");
    expect(readBatchSupport({ "-1": { atomic: { status: "supported" } } }, -1)).toBe("none");
    expect(readBatchSupport({ "1.5": { atomic: { status: "supported" } } }, 1.5)).toBe("none");
    // And the real entry beside it is still found.
    const mixed = {
      "0x0": { gasLimitOverride: { supported: true } },
      [CHAIN]: { atomic: { status: "supported" } },
    };
    expect(readBatchSupport(mixed, CHAIN)).toBe("atomic");
  });

  it("reads own properties only, never something inherited", () => {
    // `Object.create` is not a wallet, but `in` walking a prototype is how a lookup starts
    // answering for things nothing ever said.
    const inherited = Object.create({ atomic: { status: "supported" } }) as object;
    expect(readBatchSupport(byNumber(inherited), CHAIN)).toBe("none");
    expect(readBatchSupport(inherited, CHAIN)).toBe("none");
  });
});

describe("choosing how to send a zapped sell", () => {
  const AMOUNT = 1_000n;

  it("sends the sell alone when the allowance already covers it", () => {
    // A batch of one call is a worse ordinary transaction, whatever the wallet can do.
    for (const support of ["atomic", "sequential", "none"] as const) {
      expect(planZappedSell({ allowance: AMOUNT, amount: AMOUNT, support })).toEqual({
        kind: "sell-only",
      });
      expect(planZappedSell({ allowance: AMOUNT + 1n, amount: AMOUNT, support })).toEqual({
        kind: "sell-only",
      });
    }
  });

  it("keeps the two-transaction path when the wallet cannot batch", () => {
    expect(planZappedSell({ allowance: 0n, amount: AMOUNT, support: "none" })).toEqual({
      kind: "approve-then-sell",
    });
  });

  /*
   * A SELL IS NEVER BATCHED, whatever the wallet can do, and these three pin the reason.
   *
   * `zapSellToNative` clamps its gas limit because Monad bills the LIMIT and the estimator returns
   * ~4,795,725 for a call that costs ~270,000. EIP-5792 v2.0.0 dropped per-call `gas` and viem's
   * `Call` has no field for it, so a batch hands the limit straight back to the estimator the
   * clamp exists to correct — about 0.44 MON a sell, 10.5x the clamped ceiling.
   *
   * These used to assert the opposite. If someone re-enables batching here, they should have to
   * delete a test that says why not.
   */
  it("refuses to batch even when the wallet promises atomicity", () => {
    expect(planZappedSell({ allowance: 0n, amount: AMOUNT, support: "atomic" })).toEqual({
      kind: "approve-then-sell",
    });
  });

  it("refuses to batch on a sequencing wallet too", () => {
    expect(planZappedSell({ allowance: 0n, amount: AMOUNT, support: "sequential" })).toEqual({
      kind: "approve-then-sell",
    });
  });

  it("treats a short allowance as short, not as close enough", () => {
    expect(planZappedSell({ allowance: AMOUNT - 1n, amount: AMOUNT, support: "atomic" })).toEqual({
      kind: "approve-then-sell",
    });
  });

  it("still sends ONE call when the allowance already covers it", () => {
    // The saving that survives: no approval needed, so no second prompt and no batch to want.
    expect(planZappedSell({ allowance: AMOUNT, amount: AMOUNT, support: "none" })).toEqual({
      kind: "sell-only",
    });
  });
});

describe("the calls the batch carries", () => {
  const sell = encodeZapSellToNative({
    router: ROUTER,
    curve: CURVE,
    path: [
      {
        intermediateCurrency: QUOTE,
        fee: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
        hookData: "0x",
      },
    ],
    baseIn: 5n,
    minQuoteOut: 3n,
    minNativeOut: 2n,
  });

  it("approves the ROUTER for the max, exactly as the two-transaction path does", () => {
    const call = encodeMaxApproval(TOKEN, ROUTER);
    expect(call.to).toBe(TOKEN);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(decoded.functionName).toBe("approve");
    expect(decoded.args).toEqual([ROUTER, maxUint256]);
  });

  it("puts the approval FIRST", () => {
    // Reversed, the sell runs before the allowance exists: an atomic wallet reverts the pair, and a
    // sequential one lands the approval alone — a signature spent and no sale.
    const calls = zappedSellCalls({ token: TOKEN, spender: ROUTER, sell });
    expect(calls).toHaveLength(2);
    expect(calls[0].to).toBe(TOKEN);
    expect(calls[1]).toBe(sell);
  });

  it("encodes the sell against the router, with the floors the seller agreed to", () => {
    expect(sell.to).toBe(ROUTER);
    const decoded = decodeFunctionData({ abi: zapRouterAbi, data: sell.data });
    expect(decoded.functionName).toBe("zapSellToNative");
    const args = decoded.args as unknown as readonly [
      `0x${string}`,
      readonly unknown[],
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    expect(args[0]).toBe(CURVE);
    expect(args[2]).toBe(5n);
    expect(args[3]).toBe(3n);
    expect(args[4]).toBe(2n);
    // The deadline is stamped at encode time and is in the future — an expired batch is refused by
    // the router rather than executed at a price nobody agreed to.
    expect(args[5]).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it("carries no value on either call, because neither moves native in", () => {
    for (const call of zappedSellCalls({ token: TOKEN, spender: ROUTER, sell })) {
      expect(Object.keys(call).sort()).toEqual(["data", "to"]);
    }
  });
});
