// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

/**
 * # Generation 5 — the seed mint no longer sweeps, so a stranger's MON is never moved
 *
 * ## What this is a change to, and what it is NOT
 *
 * This file exercises `src/DokuGraduation.sol` AS IT STANDS, which since this change is the
 * GENERATION-5 graduator. It is **not** the contract at
 * `0xe095018ddeBFe600d456cd8171EDa32823C2b3aA`. That one is generation 4, it is deployed, it is
 * immutable, and it still ends `_mintSeed` with `Actions.SWEEP`. Its behaviour on the native quote
 * is a documented STRAND — a third party's MON resting on the shared PositionManager is dragged
 * into the graduator by the sweep, kept out of every market's ledger by `notOurs` (so it is not
 * theft, and M-02 stays closed), and then cannot be pushed back because v4-periphery's
 * `NativeWrapper.receive()` reverts for any sender that is not WETH9 or the PoolManager. It has no
 * owner, no rescue and no upgrade, so it stays stranded. `test/audit/Gen4LiveCanaryFork.t.sol`
 * exercises the deployed generation-4 stack and must be completely unaffected by anything here.
 *
 * ## The change
 *
 * `_mintSeed`'s action list is now `MINT_POSITION, SETTLE_PAIR` — no third action. Nothing is ever
 * dragged out of POSM, so nothing has to be given back, and the `posmHeld` measure-and-return
 * machinery in `_sweepDust` is gone rather than merely scoped.
 *
 * The price is that the graduator's OWN unspent native no longer comes home either. `msg.value` is
 * `seed.quoteAmount`; `SETTLE_PAIR` settles the exact debt v4-core computed for `seed.liquidity`;
 * the difference stays in POSM, where `Actions.SWEEP` makes it collectable by any v4 caller — the
 * same status as everything else resting there. This file's job is to put a NUMBER on that
 * difference and assert a ceiling on it, so that a future change which turns wei into money fails
 * loudly instead of quietly.
 *
 * ## Why a fork
 *
 * The whole question is about the CANONICAL PositionManager: its `receive()`, its `_settle`, its
 * `_sweep`, and the fact that third parties leave balances on it. So the stack here is built on the
 * real Monad-mainnet PoolManager, PositionManager and Permit2, with a freshly compiled DOKU hook
 * and graduator on top — the same shape `test/audit/HookJitDonateFork.t.sol` uses.
 */
contract Gen5NoNativeSweepForkTest is Test {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;

    address internal constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address internal constant POSITION_MANAGER = 0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @dev The shipped MON quote target, from `QuoteRegistry`. The canary graduated on this number
    ///      and its residue is one of the two measurements this file is calibrated against.
    uint256 internal constant SHIPPED_MON_TARGET = 305_868_390_948_742_537_150_460;
    /// @dev The round target `M02DustScope` measures on, kept so the two files report the same
    ///      quantity at two sizes and the growth law is legible.
    uint256 internal constant SMALL_MON_TARGET = 1_000e18;

    /**
     * @dev THE CEILING ON WHAT THE PROTOCOL FORFEITS, PER GRADUATION, ON A NATIVE QUOTE.
     *
     * One gwei. Measured values are 25,622 wei at a 1,000 MON target and 447,495 wei at the shipped
     * 305,868 MON one — the residue grows like the SQUARE ROOT of the raise, because it is the gap
     * between the amounts `getLiquidityForAmounts` rounded down from and the amounts v4-core rounds
     * up to for the liquidity that produced. At that law a 1-billion-MON market forfeits about
     * 2.6e7 wei, still three orders of magnitude under this line.
     *
     * So this is not a tight bound; it is a TRIPWIRE. It is chosen to be unreachable by the
     * rounding mechanism at any size this protocol can mint, and reachable immediately by anything
     * that is not that mechanism — a slippage-headroom `msg.value`, an amount maximum that stops
     * being the amount consumed, a settle path that stops settling the exact debt. One gwei of MON
     * is worth a small fraction of a cent; if a graduation ever forfeits more than this, the reason
     * is structural and the assertion should be read as "the design changed", not as "retune the
     * constant".
     */
    uint256 internal constant FORFEIT_CEILING_WEI = 1 gwei;

    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0x4A110C);
    /// @dev The unrelated third party whose MON is resting on the shared PositionManager.
    address internal constant STRANGER = address(0x57A3);

    IPoolManager internal pm = IPoolManager(POOL_MANAGER);
    IPositionManager internal posm = IPositionManager(POSITION_MANAGER);

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    SeedLocker internal locker;
    CreatorSink internal creatorSink;
    MarketsStub internal markets;

    address internal curveImpl;
    address internal tokenImpl;

    bool internal forked;

    function setUp() public {
        string memory url = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        forked = true;

        creatorSink = new CreatorSink(address(this));
        markets = new MarketsStub();

        bytes memory args = abi.encode(pm, address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(pm, address(this), TREASURY, address(creatorSink));

        graduation = new DokuGraduation(POOL_MANAGER, POSITION_MANAGER, PERMIT2, address(dokuHook), address(markets));
        locker = graduation.locker();
        dokuHook.setGraduator(address(graduation), true);
        creatorSink.setGraduator(address(graduation));
        creatorSink.setFactory(address(markets));

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
    }

    // ------------------------------------------------------------------------------- the harness

    function _market(uint256 target, uint8 sink, address routed) internal returns (BondingCurve c) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"Gen5", unicode"GEN5", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            address(0),
            target,
            sink,
            routed,
            0,
            ALICE,
            TREASURY,
            address(graduation),
            address(creatorSink)
        );
    }

    /// @dev One buy past the anti-sniper window that overshoots the target; the curve clamps,
    ///      refunds and graduates inside the same transaction.
    function _fill(BondingCurve c, address buyer, uint256 target) internal {
        // Hoisted, all of it: `c.buy{value: 2 * c.quoteTarget()}(...)` would evaluate the inner
        // calls first and eat the prank, so the buy would go out from this test contract instead.
        uint256 window = c.TAX_WINDOW();
        vm.warp(vm.getBlockTimestamp() + window + 1);
        uint256 spend = 2 * target;
        uint256 deadline = vm.getBlockTimestamp();
        vm.deal(buyer, spend + 1 ether);
        vm.prank(buyer);
        c.buy{value: spend}(0, deadline);
        assertTrue(graduation.graduated(address(c)), "the native market did not auto-graduate");
    }

    /// @dev The one number this file exists to bound: what the graduation left behind in POSM.
    ///      The `assertGe` is not decoration — under the generation-4 action list POSM ends at ZERO
    ///      and the subtraction below underflows, which reports as an unattributed arithmetic panic
    ///      rather than as the thing that actually happened. Checked first so a reverted source
    ///      change says so in words.
    function _graduateAndMeasureForfeit(uint256 target, uint8 sink, address routed)
        internal
        returns (BondingCurve c, uint256 forfeited)
    {
        uint256 posmBefore = POSITION_MANAGER.balance;
        c = _market(target, sink, routed);
        _fill(c, MALLORY, target);
        assertGe(POSITION_MANAGER.balance, posmBefore, "the graduation took native out of POSM");
        forfeited = POSITION_MANAGER.balance - posmBefore;
    }

    // ------------------------------------------------------- 1. the stranger's MON is not touched

    /**
     * @notice A third party's MON resting on the canonical PositionManager is not moved by a DOKU
     *         graduation — not into a market's ledger, and not into the graduator either.
     *
     * @dev This is the direct inversion of `Gen4PosmReturnNative`, which asserts the generation-4
     *      outcome on the same fork: `POSM balance == 0` and `graduator balance == parked`. Here
     *      POSM keeps every wei it started with and the graduator ends holding nothing at all.
     */
    function test_thirdPartyNativeOnPosmIsUntouchedByAGraduation() public {
        uint256 posmBefore = POSITION_MANAGER.balance;
        uint256 parked = 3 ether;
        vm.deal(POSITION_MANAGER, posmBefore + parked);
        uint256 staged = POSITION_MANAGER.balance;
        assertEq(staged, posmBefore + parked, "stage failed");

        BondingCurve c = _market(SHIPPED_MON_TARGET, Sinks.CREATOR, MALLORY);
        _fill(c, MALLORY, SHIPPED_MON_TARGET);

        // Before the subtraction, so that a source without this change fails with this sentence
        // instead of with an arithmetic panic: generation 4 leaves POSM at zero.
        assertGe(POSITION_MANAGER.balance, staged, "the graduation took native out of POSM");
        uint256 forfeited = POSITION_MANAGER.balance - staged;

        emit log_string("--- generation 5: the sweep is gone ---");
        emit log_named_decimal_uint("third-party MON parked on POSM", parked, 18);
        emit log_named_uint("POSM balance moved by our graduation (wei, ours only)", forfeited);
        emit log_named_uint("left in the graduator (wei)", address(graduation).balance);

        // The stranger's money never left POSM. Stated as `>=` against the staged balance rather
        // than `==`, because our own forfeited residue is now ALSO in POSM and is part of the same
        // balance; the exact split is asserted below.
        assertGe(POSITION_MANAGER.balance, staged, "POSM lost native to a DOKU graduation");

        // And the graduator is empty — the generation-4 strand cannot happen, because nothing
        // arrives to be stranded.
        assertEq(address(graduation).balance, 0, "the graduator is holding native after a graduation");

        // Nothing of the stranger's reached the market's recipient either: M-02 stays closed, now
        // by never moving the money rather than by subtracting it back out.
        creatorSink.pull(address(c));
        assertEq(creatorSink.claimable(MALLORY, address(0)), 0, "third-party MON reached a market recipient");

        // What DID move is only ours, and it is dust.
        assertLt(forfeited, FORFEIT_CEILING_WEI, "the protocol forfeited more than dust into POSM");
    }

    // -------------------------------------------------------------- 2. the market graduated fine

    /// @notice The seed position, the pool and the sink are exactly what they were before the
    ///         action list changed. Dropping a trailing SWEEP must not cost the market anything.
    function test_theMarketGraduatesNormallyWithTheSweepGone() public {
        uint256 posmBefore = POSITION_MANAGER.balance;
        vm.deal(POSITION_MANAGER, posmBefore + 3 ether);

        uint256 nextTokenId = posm.nextTokenId();
        BondingCurve c = _market(SHIPPED_MON_TARGET, Sinks.CREATOR, MALLORY);
        _fill(c, MALLORY, SHIPPED_MON_TARGET);

        PoolId id = graduation.poolIdOf(address(c));
        assertTrue(PoolId.unwrap(id) != bytes32(0), "no pool id recorded");
        assertTrue(graduation.sinkOf(address(c)) != address(0), "no sink recorded");

        // The pool is real and carries the seed.
        (uint160 sqrtPriceX96,,,) = pm.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "the pool was never initialised");
        assertGt(pm.getLiquidity(id), 0, "the pool has no liquidity: the seed did not mint");

        // The position is the locker's, and the locker knows which pool it belongs to.
        (PoolKey memory key, address sink, uint8 sinkKind,) = locker.positionOf(nextTokenId);
        assertEq(address(key.hooks), address(dokuHook), "the locked position is not in a DOKU pool");
        assertEq(sink, graduation.sinkOf(address(c)), "the locked position points at the wrong sink");
        assertEq(sinkKind, Sinks.CREATOR, "the locked position recorded the wrong sink kind");

        // And the whole raise went into it: the curve is empty and the graduator kept nothing.
        assertEq(c.quoteRaised(), 0, "release did not move the raise");
        assertEq(address(graduation).balance, 0, "the graduator kept native");
        assertEq(c.token().balanceOf(address(graduation)), 0, "the graduator kept launch tokens");
    }

    // ------------------------------------------------------- 3. how big the forfeited dust really is

    /**
     * @notice The measurement, at two sizes, with nothing else on POSM to confuse it.
     *
     * @dev The two numbers printed here are what the ceiling above is calibrated from, and the
     *      reason the ceiling can be loose without being useless: the residue is sublinear in the
     *      raise, so the gap between "what the mechanism produces" and "one gwei" only widens as
     *      markets get bigger.
     */
    function test_theForfeitedResidueIsWeiScaleAtBothSizes() public {
        (, uint256 smallForfeit) = _graduateAndMeasureForfeit(SMALL_MON_TARGET, Sinks.BURN, address(0));
        (, uint256 shippedForfeit) = _graduateAndMeasureForfeit(SHIPPED_MON_TARGET, Sinks.CREATOR, MALLORY);

        emit log_string("--- what generation 5 forfeits into POSM, per graduation ---");
        emit log_named_decimal_uint("target A", SMALL_MON_TARGET, 18);
        emit log_named_uint("forfeited A (wei)", smallForfeit);
        emit log_named_decimal_uint("target B (the shipped MON target)", SHIPPED_MON_TARGET, 18);
        emit log_named_uint("forfeited B (wei)", shippedForfeit);
        emit log_named_uint(
            "forfeited B as a fraction of the raise, in parts per QUINTILLION",
            (shippedForfeit * 1e18) / SHIPPED_MON_TARGET
        );

        assertLt(smallForfeit, FORFEIT_CEILING_WEI, "a 1,000 MON market forfeited more than dust");
        assertLt(shippedForfeit, FORFEIT_CEILING_WEI, "a shipped-target market forfeited more than dust");
        // Sublinear, and the point of measuring twice: a 306x bigger raise forfeits nowhere near
        // 306x more. If this ever flips, the residue has stopped being a rounding artefact.
        assertLt(shippedForfeit, smallForfeit * 306, "the residue stopped being sublinear in the raise");
        // And the graduator holds nothing on either path.
        assertEq(address(graduation).balance, 0, "the graduator kept native");
    }

    // ------------------------------------------ 4. forfeited is not the same word as stranded

    /**
     * @notice What "forfeited into POSM" actually means for the money: anyone can take it out with
     *         a bare `Actions.SWEEP`, which is exactly the status every other stray balance on the
     *         canonical PositionManager already has.
     *
     * @dev This is the whole difference between generation 4's outcome and generation 5's, stated
     *      as an executable claim rather than as prose. Generation 4 moved a stranger's MON into a
     *      contract with no owner and no rescue, where NOBODY can ever reach it. Generation 5
     *      leaves the protocol's own dust where EVERYBODY can — including the stranger whose money
     *      generation 4 would have taken.
     */
    function test_whatIsForfeitedIntoPosmIsReachableByAnyone() public {
        uint256 posmBefore = POSITION_MANAGER.balance;
        (, uint256 forfeited) = _graduateAndMeasureForfeit(SHIPPED_MON_TARGET, Sinks.CREATOR, MALLORY);
        assertGt(forfeited, 0, "nothing was forfeited: this test would prove nothing");

        // An unrelated v4 caller, sweeping native out of POSM. One action, no positions, no deltas.
        bytes memory actions = abi.encodePacked(uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(Currency.wrap(address(0)), STRANGER);
        uint256 deadline = vm.getBlockTimestamp() + 1;
        bytes memory unlockData = abi.encode(actions, params);

        uint256 strangerBefore = STRANGER.balance;
        vm.prank(STRANGER);
        posm.modifyLiquidities(unlockData, deadline);

        emit log_named_uint("forfeited by the graduation (wei)", forfeited);
        emit log_named_uint("recovered from POSM by an unrelated caller (wei)", STRANGER.balance - strangerBefore);

        assertEq(
            STRANGER.balance - strangerBefore,
            posmBefore + forfeited,
            "POSM's native balance was not reachable by a third party"
        );
        assertEq(POSITION_MANAGER.balance, 0, "the sweep left native on POSM");
    }

    // --------------------------------------------------- 5. the mechanism the strand rested on

    /// @notice POSM still refuses a bare native send, which is why generation 4 could not push the
    ///         money back and why generation 5 does not try. Kept as the standing proof that the
    ///         constraint is v4-periphery's and not ours.
    function test_posmStillRefusesABareNativeSend() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = POSITION_MANAGER.call{value: 1 ether}("");
        assertFalse(ok, "POSM accepts a bare native send now: the whole G4-05 constraint moved");
    }

    receive() external payable {}
}
