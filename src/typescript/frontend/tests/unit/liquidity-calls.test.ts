import { decodeAbiParameters, type Hex, parseAbiParameters } from "viem";

import {
  ACTIONS,
  buildAddLiquidity,
  buildCollectFees,
  buildRemoveLiquidity,
  encodeActions,
} from "../../src/lib/chain/liquidity-calls";

const TOKEN = "0x5755b8edcd8765d7319fc6ae05389c1e7c7fa17e" as const;
const USER = "0xea12f846d7a298caa94469d398eb099be3c8d034" as const;
const NATIVE = "0x0000000000000000000000000000000000000000";
const DEADLINE = 1_800_000_000n;

/** What `poolKeyFor` builds for a DOKU market: native MON first, no fee, the levy hook. */
const POOL_KEY = {
  currency0: NATIVE as `0x${string}`,
  currency1: TOKEN,
  fee: 0,
  tickSpacing: 60,
  hooks: "0x0c0f84f5c2cba0c2ce058da755bd6f7215d76fcf" as `0x${string}`,
} as const;

/** `unlockData` back into the action bytes and their parameter blobs. */
function decodePlan(unlockData: Hex): { actions: number[]; params: Hex[] } {
  const [packed, params] = decodeAbiParameters(parseAbiParameters("bytes, bytes[]"), unlockData);
  const actions: number[] = [];
  for (let i = 2; i < packed.length; i += 2) {
    actions.push(Number.parseInt(packed.slice(i, i + 2), 16));
  }
  return { actions, params: params as Hex[] };
}

const MINT_PARAMS = parseAbiParameters(
  "(address,address,uint24,int24,address), int24, int24, uint256, uint128, uint128, address, bytes"
);
const MODIFY_PARAMS = parseAbiParameters("uint256, uint256, uint128, uint128, bytes");
const BURN_PARAMS = parseAbiParameters("uint256, uint128, uint128, bytes");
const TAKE_PARAMS = parseAbiParameters("address, address, address");

/**
 * v4 has one entry point and no selectors, so nothing here is checked by a compiler.
 *
 * `modifyLiquidities` takes `abi.encode(bytes actions, bytes[] params)`, where the actions are one
 * PACKED byte each. An action byte that is off by one is a different, valid operation decoded
 * against the wrong parameter layout — no revert at the encoding stage, no type error, just a
 * transaction that does something else. So these tests decode what the builders actually produced
 * rather than comparing it to a fixture that could be wrong in the same direction as the code.
 */
describe("v4 liquidity calldata", () => {
  describe("encodeActions", () => {
    it("packs actions one byte each", () => {
      const { actions } = decodePlan(encodeActions([0x02, 0x0d, 0x14], ["0x", "0x", "0x"]));
      expect(actions).toEqual([0x02, 0x0d, 0x14]);
    });

    it("refuses a params array that does not line up with the actions", () => {
      expect(() => encodeActions([0x02, 0x0d], ["0x"])).toThrow(
        /every action needs its parameters/
      );
    });

    it("refuses an action that is not a byte", () => {
      expect(() => encodeActions([256], ["0x"])).toThrow(/single byte/);
    });
  });

  describe("adding liquidity", () => {
    const params = {
      poolKey: POOL_KEY,
      recipient: USER,
      liquidity: 5_000_000n,
      amountMon: 10n ** 18n,
      amountToken: 2_000_000n * 10n ** 18n,
      tickLower: -600,
      tickUpper: 600,
      slippageBps: 100,
      deadline: DEADLINE,
    };

    it("mints, settles both sides, and sweeps the unspent MON", () => {
      const { actions } = decodePlan(buildAddLiquidity(params).unlockData);
      expect(actions).toEqual([ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR, ACTIONS.SWEEP]);
    });

    it("puts native MON on currency0 and the market token on currency1", () => {
      const plan = buildAddLiquidity(params);
      const [key, tickLower, tickUpper, liquidity, , , owner] = decodeAbiParameters(
        MINT_PARAMS,
        decodePlan(plan.unlockData).params[0]!
      );
      expect(key[0].toLowerCase()).toBe(NATIVE);
      expect(key[1].toLowerCase()).toBe(TOKEN);
      // Zero, because the levy is skimmed from flash accounting and a fee makes that impossible.
      expect(key[2]).toBe(0);
      expect(tickLower).toBe(-600);
      expect(tickUpper).toBe(600);
      expect(liquidity).toBe(5_000_000n);
      expect(owner.toLowerCase()).toBe(USER);
    });

    /**
     * The inversion that V3 muscle memory gets wrong.
     *
     * V3's `amount0Min` was a floor: protection against receiving too little position for the
     * money. v4's `amount0Max` is a ceiling: protection against paying too much money for the
     * position. Flooring it — the instinct carried over — sets the maximum BELOW what the mint
     * costs, so the deposit reverts exactly when the price moved, which is when slippage
     * protection was supposed to help.
     */
    it("widens the spending maximums with slippage rather than narrowing them", () => {
      const [, , , , amount0Max, amount1Max] = decodeAbiParameters(
        MINT_PARAMS,
        decodePlan(buildAddLiquidity(params).unlockData).params[0]!
      );
      expect(amount0Max).toBeGreaterThan(params.amountMon);
      expect(amount1Max).toBeGreaterThan(params.amountToken);
      expect(amount0Max).toBe((params.amountMon * 10_100n) / 10_000n);
    });

    /** Sending only the expected amount reverts precisely when the ceiling was doing its job. */
    it("attaches the ceiling as value, not the expected amount", () => {
      const plan = buildAddLiquidity(params);
      expect(plan.value).toBe((params.amountMon * 10_100n) / 10_000n);
      expect(plan.deadline).toBe(DEADLINE);
    });

    /**
     * The maker levy, which the ceiling has to clear before slippage is applied at all.
     *
     * `DokuHook._makerLevy` returns a delta and v4 folds it into the CALLER's, so the amount
     * `validateMaxIn` is checked against is the paired amount plus the levy. A ceiling that only
     * carried slippage covered a BURN market's seventy-five basis points by the twenty-five it had
     * spare — and covered a REWARDS market's hundred by nothing at all.
     */
    it("clears the levy before slippage, on the currency that carries it", () => {
      const burn = { ...params, levyBps0: 25, levyBps1: 75 };
      const [, , , , amount0Max, amount1Max] = decodeAbiParameters(
        MINT_PARAMS,
        decodePlan(buildAddLiquidity(burn).unlockData).params[0]!
      );
      const levied0 = params.amountMon + (params.amountMon * 25n) / 10_000n;
      const levied1 = params.amountToken + (params.amountToken * 75n) / 10_000n;
      expect(amount0Max).toBe((levied0 * 10_100n) / 10_000n);
      expect(amount1Max).toBe((levied1 * 10_100n) / 10_000n);
    });

    it("attaches the levied ceiling as value, so the MON leg settles too", () => {
      const rewards = buildAddLiquidity({ ...params, levyBps0: 100, levyBps1: 0 });
      const levied = params.amountMon + (params.amountMon * 100n) / 10_000n;
      expect(rewards.value).toBe((levied * 10_100n) / 10_000n);
      // The whole point: a ceiling built from slippage alone does not reach the levied cost.
      expect(rewards.value).toBeGreaterThan((params.amountMon * 10_100n) / 10_000n);
    });

    it("encodes exactly as before when nothing is levied", () => {
      expect(buildAddLiquidity({ ...params, levyBps0: 0, levyBps1: 0 })).toEqual(
        buildAddLiquidity(params)
      );
    });

    it("refuses a negative levy", () => {
      expect(() => buildAddLiquidity({ ...params, levyBps1: -1 })).toThrow(
        /levy cannot be negative/
      );
    });

    it("skips the sweep when no MON is being deposited", () => {
      const { actions } = decodePlan(buildAddLiquidity({ ...params, amountMon: 0n }).unlockData);
      expect(actions).toEqual([ACTIONS.MINT_POSITION, ACTIONS.SETTLE_PAIR]);
    });

    it("refuses a position made of nothing", () => {
      expect(() => buildAddLiquidity({ ...params, amountMon: 0n, amountToken: 0n })).toThrow(
        /at least one side funded/
      );
      expect(() => buildAddLiquidity({ ...params, liquidity: 0n })).toThrow(/some liquidity/);
    });

    it("refuses an inverted range", () => {
      expect(() => buildAddLiquidity({ ...params, tickLower: 600, tickUpper: -600 })).toThrow(
        /empty or inverted/
      );
    });
  });

  describe("removing liquidity", () => {
    const params = {
      tokenId: 42n,
      liquidity: 5_000_000n,
      poolKey: POOL_KEY,
      recipient: USER,
      minMon: 9n * 10n ** 17n,
      minToken: 1_900_000n * 10n ** 18n,
      deadline: DEADLINE,
      burnPosition: false,
    };

    it("decreases and takes both sides to the user", () => {
      const plan = buildRemoveLiquidity(params);
      const { actions, params: encoded } = decodePlan(plan.unlockData);
      expect(actions).toEqual([ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR]);

      const [tokenId, liquidity, min0, min1] = decodeAbiParameters(MODIFY_PARAMS, encoded[0]!);
      expect(tokenId).toBe(42n);
      expect(liquidity).toBe(5_000_000n);
      // MON is currency0, so its floor is the first of the pair.
      expect(min0).toBe(params.minMon);
      expect(min1).toBe(params.minToken);

      const [c0, c1, recipient] = decodeAbiParameters(TAKE_PARAMS, encoded[1]!);
      expect(c0.toLowerCase()).toBe(NATIVE);
      expect(c1.toLowerCase()).toBe(TOKEN);
      expect(recipient.toLowerCase()).toBe(USER);
      expect(plan.value).toBe(0n);
    });

    /** `BURN_POSITION` decreases to zero on the way, so closing is one action rather than two. */
    it("burns in a single action when the whole position goes", () => {
      const { actions, params: encoded } = decodePlan(
        buildRemoveLiquidity({ ...params, burnPosition: true }).unlockData
      );
      expect(actions).toEqual([ACTIONS.BURN_POSITION, ACTIONS.TAKE_PAIR]);
      const [tokenId, min0, min1] = decodeAbiParameters(BURN_PARAMS, encoded[0]!);
      expect(tokenId).toBe(42n);
      expect(min0).toBe(params.minMon);
      expect(min1).toBe(params.minToken);
    });

    it("refuses a withdrawal of nothing", () => {
      expect(() => buildRemoveLiquidity({ ...params, liquidity: 0n })).toThrow(/no liquidity/);
    });
  });

  describe("collecting fees", () => {
    /**
     * A decrease of ZERO liquidity is v4's idiom for it: the position is untouched and the accrued
     * fees fall out as the delta. In a DOKU pool that delta is always zero — the pool charges no
     * fee — but this is still the correct encoding of the verb.
     */
    it("decreases nothing and takes what falls out", () => {
      const { actions, params: encoded } = decodePlan(
        buildCollectFees({ tokenId: 7n, poolKey: POOL_KEY, recipient: USER, deadline: DEADLINE })
          .unlockData
      );
      expect(actions).toEqual([ACTIONS.DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR]);
      const [tokenId, liquidity, min0, min1] = decodeAbiParameters(MODIFY_PARAMS, encoded[0]!);
      expect(tokenId).toBe(7n);
      expect(liquidity).toBe(0n);
      // No floors: the fees are whatever the pool says when it lands, and a floor could only
      // reject the collection for returning less than quoted.
      expect(min0).toBe(0n);
      expect(min1).toBe(0n);
    });
  });
});
