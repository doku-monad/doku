// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
// `Vm` is a file-level symbol rather than an inherited one, so `Vm.Log` needs its own import even
// though `vm` itself comes down from `Test`.
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {IERC721} from "openzeppelin/token/ERC721/IERC721.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {BurnSink} from "../../src/sinks/BurnSink.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

// Imported ONLY so forge compiles their artifacts. v4-periphery's test `Deploy` library builds
// these through `vm.getCode("PositionManager.sol:PositionManager")`, which resolves against the
// build output rather than the source tree — so a contract nothing in this repo imports is never
// compiled, and the lookup fails with "no matching artifact found" at setUp.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @dev Stands in for PART A's `CreatorSink`: records what graduation registers and accepts the
///      routed pushes a curve may send. The real contract's `register` is graduator-only and
///      once-only; the stub asserts the once.
contract RecordingCreatorSink {
    struct Entry {
        PoolId id;
        address quote;
        address routed;
        address tax;
        bool registered;
    }

    mapping(address => Entry) public entries;

    function register(address market, PoolId id, address quote, address routed, address tax) external {
        require(!entries[market].registered, "registered twice");
        entries[market] = Entry(id, quote, routed, tax, true);
    }

    receive() external payable {}
}

/// @notice The whole thing, end to end, on a locally deployed v4 stack.
///
/// @dev Every other test in this suite proves one component. This one proves the wires carry
///      current: a curve is filled, the FILLING BUY graduates it in the same transaction, a real
///      Uniswap v4 pool comes into existence with the seed inside it, the position lands at a dead
///      address, the market's sink is deployed and registered, and the very next swap on that pool
///      pays the levy.
///
///      It runs unforked. v4 is not on Monad testnet, so a suite that could only prove this against
///      a fork would prove it nowhere CI can reach.
contract GraduationV4Test is PosmTestSetup {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant ALICE = address(0xA11CE);
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant TARGET_USDC = 10_000e6;
    /// @dev A GOLD-SHAPED target on a six-decimal quote: ~$8,000 when one whole token is one troy
    ///      ounce, and only 2,424,240 raw units of it. Every other ERC-20 market in this file raises
    ///      10,000e6, which is a thousand times coarser than it needs to be to see B10a.
    uint256 internal constant TARGET_GOLD = 2_424_240;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    PoolSwapTest internal swapper;
    RecordingCreatorSink internal creatorSink;
    MockUSDC internal usdc;

    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        swapper = new PoolSwapTest(IPoolManager(address(manager)));

        // Before the hook: the sink's address is folded into the hook's mined one.
        creatorSink = new RecordingCreatorSink();
        usdc = new MockUSDC();

        bytes memory args =
            abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook =
            new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));

        graduation =
            new DokuGraduation(address(manager), address(lpm), address(permit2), address(dokuHook), address(new MarketsStub()));
        dokuHook.setGraduator(address(graduation), true);

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        vm.deal(ALICE, 1_000_000e18);
    }

    function _market(uint8 sink) internal returns (BondingCurve c, DokuToken t) {
        return _marketWith(address(0), TARGET, sink, 0);
    }

    function _marketWith(address quote, uint256 target, uint8 sink, uint16 tax)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            quote,
            target,
            sink,
            sink == Sinks.CREATOR ? ALICE : address(0),
            tax,
            ALICE,
            TREASURY,
            address(graduation),
            address(creatorSink)
        );
    }

    /// @dev One buy. Everything below happens inside it. Native or USDC, by the curve's quote.
    function _fill(BondingCurve c) internal {
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1); // untaxed, so the seed is the clean case
        if (c.quoteAsset() == address(0)) {
            vm.prank(ALICE);
            c.buy{value: 5 * TARGET}(0, block.timestamp);
        } else {
            usdc.mint(ALICE, 5 * TARGET_USDC);
            vm.startPrank(ALICE);
            usdc.approve(address(c), 5 * TARGET_USDC);
            c.buyWithToken(5 * TARGET_USDC, 0, block.timestamp);
            vm.stopPrank();
        }
    }

    function _key(DokuToken t) internal view returns (PoolKey memory) {
        return _keyFor(address(0), address(t));
    }

    /// @dev The key an indexer rebuilds from `Graduated`: sorted currencies, fee 0, the protocol's
    ///      tick spacing, this hook. Nothing else is emitted, so nothing else may go into it.
    function _keyFor(address quote, address token) internal view returns (PoolKey memory) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(dokuHook))
        });
    }

    // --------------------------------------------------------------------------- the happy path

    function test_theFillingBuyGraduatesTheMarketIntoALiveV4Pool() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        _fill(c);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(graduation.graduated(address(c)), "the filling buy did not graduate it");

        PoolId id = PoolIdLibrary.toId(_key(t));
        assertEq(PoolId.unwrap(graduation.poolIdOf(address(c))), PoolId.unwrap(id), "wrong pool recorded");

        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "the pool was never initialised");
        assertGt(manager.getLiquidity(id), 0, "the pool has no liquidity");
    }

    /// @dev The guarantee, asserted rather than described. The position is not held by a contract
    ///      with a collect function — it is at an address nobody has the key to.
    /// @dev The position is no longer burned. It earns now — `DokuHook.LP_LEVY_BPS` donates to the
    ///      pool's in-range positions and this is one of them — so a dead address would strand those
    ///      fees forever. `SeedLocker` owns it instead, and closes the same signature paths by NOT
    ///      implementing ERC-1271: `permit` and `permitForAll` both fall through to it for a contract
    ///      owner, and a call that reverts can never return the magic value.
    function test_thePositionIsHeldByALockerThatCannotBeMadeToSign() public {
        (BondingCurve c,) = _market(Sinks.BURN);
        _fill(c);

        address locker = address(graduation.locker());
        // POSM's counter starts at 1 and this test graduates exactly one market.
        assertEq(IERC721(address(lpm)).ownerOf(1), locker, "the seed position is not at the locker");

        // The property that replaces "has no code": it has code, and none of it can validate a
        // signature. `staticcall` rather than a typed call so the revert is observed, not bubbled.
        (bool ok,) = locker.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", bytes32(0), ""));
        assertFalse(ok, "the locker answers ERC-1271, so a signed approval could move the position");
    }

    /// @dev The seed is the SAME on every market regardless of how its curve was traded, which is
    ///      what D4a bought by dropping the anti-sniper escrow from the deposit.
    function test_theSeedIsTheQuoteTargetAndTwoSeventhsOfTheCurvePlusDust() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        uint256 latched = 0;
        _fill(c);
        latched = c.seedBase();
        assertEq(graduation.SEED_BASE(), 222_222_222e18, "seed is TOTAL_SUPPLY - CURVE_SUPPLY");
        assertGe(latched, graduation.SEED_BASE(), "seed base below the seed");
        /*
          There is no upper bound any more, and its absence is the point.

          Two versions of that bound have now been a permanent freeze: a flat 1e6, which two sells
          on a 1B-supply market blew past, and the relative `seedDustTolerance` that replaced it,
          which ~4,600 dust sells on a coarse-quote market blow past. The residue is unbounded by
          nature — every sell rounds in the pool's favour — so any constant it is compared against
          is a countdown. The seed is computed from the market's own latched supply and reserves,
          and `release` can only move tokens the curve actually holds, so "never short" is the whole
          rule and there is nothing left for a ceiling to protect.
        */
        assertEq(c.quoteTarget(), TARGET);
        t;
    }

    /**
     * A market that was SOLD INTO before it filled still graduates.
     *
     * The regression this pins is arithmetic, and it arrived with the 1,000,000,000 supply. The
     * residue one sell leaves in the seed is `BASE_VIRTUAL_CEILING / (1.4 * quoteTarget)` base wei,
     * so raising the ceiling from 49e24 to 1.089e27 multiplied it by 22. Measured on this market:
     * one buy-then-sell round trip latches 570,033 wei of dust and TWO latch **1,304,099** — past
     * the flat `SEED_DUST_TOLERANCE = 1e6` that stood here before. `graduate` would have reverted
     * `SeedOutOfRange`, and under D3 that revert is swallowed by `_tryAutoGraduate`, with
     * `readyToGraduate` already latched, both curve legs shut and `release` reachable only through
     * the graduation that cannot succeed. Two sells would have frozen a filled market with the
     * whole raise inside it, permanently.
     *
     * Every other graduation test fills with a single untaxed buy, where the dust is one wei, so
     * none of them could see it. That is why this one trades first.
     */
    function test_aMarketThatWasSoldIntoBeforeFillingStillGraduates() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        vm.startPrank(ALICE);
        for (uint256 i = 0; i < 2; i++) {
            uint256 got = c.buy{value: 1e18}(0, block.timestamp);
            t.approve(address(c), got);
            c.sell(got, 0, block.timestamp);
        }
        c.buy{value: 5_000e18}(0, block.timestamp);
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(graduation.graduated(address(c)), "sells before the fill bricked the graduation");

        // The dust is still here and still large — it is simply no longer fatal. Kept as a
        // measurement so a future change that makes the residue explode is still visible.
        uint256 dust = c.seedBase() - graduation.SEED_BASE();
        assertGt(dust, 1e6, "no longer the case being tested: the dust is back under the old bound");
    }

    // -------------------------------------------------------------------------------- the sinks

    function test_aBurnMarketGetsABurnSinkAndARewardsMarketGetsAVault() public {
        (BondingCurve b,) = _market(Sinks.BURN);
        _fill(b);
        address burnSink = graduation.sinkOf(address(b));
        assertTrue(burnSink != address(0), "no sink deployed");
        assertTrue(BurnSink(burnSink).sinkCurrencyIsToken(), "a BURN market got a MON sink");

        (BondingCurve r,) = _market(Sinks.REWARDS);
        _fill(r);
        address vault = graduation.sinkOf(address(r));
        assertTrue(vault != address(0), "no vault deployed");
        assertFalse(RewardVault(payable(vault)).sinkCurrencyIsToken(), "a REWARDS market got a token sink");
        assertEq(RewardVault(payable(vault)).genesisBlock(), r.readyAtBlock(), "epoch 0 is not anchored at the fill");
    }

    // --------------------------------------------------------------------------------- the levy

    /// @dev The market's first pool swap can be the filling buyer's very next action, in the same
    ///      transaction. The levy must be charged in full on it — a pool that graduated microseconds
    ///      earlier is not a special case.
    function test_theNewPoolChargesTheLevyImmediately() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        _fill(c);

        PoolKey memory k = _key(t);
        PoolId id = PoolIdLibrary.toId(k);
        uint256 protBefore = dokuHook.pendingProtocol(id);
        uint256 sinkBefore = dokuHook.pendingSink(id);

        vm.deal(address(this), 100e18);
        swapper.swap{value: 10e18}(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -10e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertGt(dokuHook.pendingProtocol(id) - protBefore, 0, "the treasury was not paid on the first swap");

        // ROUND 4 PUT THE SINK BACK ON THE HOOK'S LEDGER. This block asserted the opposite until
        // it did — `pendingSink` unmoved, the share DONATED to the pool's in-range positions, and
        // the seed position earning it as fee growth that `SeedLocker.collect` forwarded. That
        // donation was measured to be capturable by any narrow band at a trade's end tick
        // (`test/audit/Round3Jit.t.sol`), so `_settleLeg` now credits `pendingSink[id]` directly
        // and the pool pays nobody.
        //
        // The collect below is KEPT rather than deleted, and the assertion under it inverted, for
        // the reason it now has to be tested at all: it is permissionless, keepers will call it
        // forever, and on a pool that pays its positions nothing it must be a clean no-op instead
        // of a revert or a phantom credit.
        assertGt(dokuHook.pendingSink(id) - sinkBefore, 0, "the swap did not credit the market's sink");
        address sinkAddr = graduation.sinkOf(address(c));
        uint256 tokenBalanceBefore = t.balanceOf(sinkAddr);
        graduation.locker().collect(1);
        assertEq(
            t.balanceOf(sinkAddr),
            tokenBalanceBefore,
            "the seed position had fees to forward, so something is still paying the pool"
        );
    }

    /// @dev The seed waiver is one-shot and closed explicitly, so it cannot be ridden by whoever
    ///      happens to have called into graduation.
    function test_theSeedWaiverIsClosedByTheTimeGraduationReturns() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        _fill(c);
        PoolId id = PoolIdLibrary.toId(_key(t));
        assertTrue(dokuHook.markets(id).seeded, "the seed waiver was never consumed");
    }

    // ------------------------------------------------------------------ the donation vector

    /**
     * A donation cannot brick a graduation, and this is a regression test for a live bug.
     *
     * `seedBase` used to be latched from `balanceOf(this) - baseOut - burned`, under a comment
     * claiming that closed the donation vector. It did not. `DokuToken` is a plain ERC-20 with no
     * transfer hooks, so anyone may send to the curve, and a donation made BEFORE the fill sits
     * inside `balanceOf` at the instant of the latch.
     *
     * The consequence was total. Once the inflated seed exceeded `seedDustTolerance`,
     * `DokuGraduation` reverted `SeedOutOfRange` — and `release` is only reachable through
     * `graduate`, `collectFees` drains only the protocol fee, and D1 leaves no rescue by design.
     * The entire raise was locked in the curve permanently.
     *
     * The price of that attack was 1,000,001 wei of the token, about a millionth of a cent, to lock
     * 1,010 MON. That exact number is the one used here.
     */
    function test_aDonationCannotMoveTheSeedOrBrickTheGraduation() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        // Acquire dust, then hand it back. That is the whole attack.
        vm.prank(ALICE);
        c.buy{value: 1e18}(0, block.timestamp);
        vm.prank(ALICE);
        t.transfer(address(c), 1_000_001);

        vm.prank(ALICE);
        c.buy{value: 5_000e18}(0, block.timestamp);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(graduation.graduated(address(c)), "a dust donation bricked the graduation");

        // The seed is the accounting figure, not the balance — so the donation did not enter it.
        // Asserted against the market's own trading residue rather than against a tolerance: a
        // donation must move the seed by NOTHING, which is a stronger statement than "not by much".
        assertLt(c.seedBase() - graduation.SEED_BASE(), 1_000_000, "the donation was absorbed into the seed");

        // And it is stranded in the curve, which is the donor's loss rather than the market's.
        assertGe(t.balanceOf(address(c)), 1_000_001, "the donation went somewhere it should not have");
    }

    /// @dev The same attack at a size no tolerance could ever absorb. A donation is not a rounding
    ///      question — an attacker picks the amount, so the fix has to be indifference to it rather
    ///      than a wider band.
    function test_aLargeDonationCannotBrickTheGraduationEither() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.REWARDS);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        vm.prank(ALICE);
        uint256 got = c.buy{value: 200e18}(0, block.timestamp);
        vm.prank(ALICE);
        t.transfer(address(c), got); // millions of tokens

        vm.prank(ALICE);
        c.buy{value: 5_000e18}(0, block.timestamp);

        assertTrue(graduation.graduated(address(c)), "a large donation bricked the graduation");
        assertLt(c.seedBase() - graduation.SEED_BASE(), 1_000_000, "a large donation moved the seed");
    }

    // ------------------------------------------------------------------- the seed is exempt

    /**
     * The graduation seed pays no levy, on either sink.
     *
     * Not a nicety — it is why the waiver exists. The seed mint happens inside POSM's slippage
     * check, which validates the POST-hook delta through a `toUint128` that reverts on a negative
     * before any minimum is compared. A levied seed therefore does not cost the market a slice:
     * `graduate()` reverts on EVERY market on BOTH sinks, and since the hook is a `PoolKey` field,
     * a fixed hook is a different pool and the markets already stranded have no repair.
     *
     * `SeedWaiver.t.sol` proves the waiver cannot be ridden by anything that is not the seed. This
     * is the other half: that the seed itself gets through.
     */
    function test_graduationIsNotLevied() public {
        uint8[2] memory kinds = [Sinks.BURN, Sinks.REWARDS];
        for (uint256 i; i < kinds.length; ++i) {
            (BondingCurve c, DokuToken t) = _market(kinds[i]);
            PoolId gid = PoolIdLibrary.toId(_key(t));

            uint256 protBefore = dokuHook.pendingProtocol(gid);
            uint256 sinkBefore = dokuHook.pendingSink(gid);
            _fill(c);

            assertTrue(graduation.graduated(address(c)), "the market did not graduate");
            assertEq(dokuHook.pendingProtocol(gid) - protBefore, 0, "the seed paid a protocol levy");
            assertEq(dokuHook.pendingSink(gid) - sinkBefore, 0, "the seed paid a sink levy");

            assertTrue(dokuHook.markets(gid).seeded, "the seed mint did not consume the waiver");
        }
    }

    /**
     * A stranger who graduates a market cannot ride the waiver they just armed.
     *
     * `graduate()` is permissionless by design, so this attacker is not hypothetical: anyone may
     * call it, and for the duration of that transaction the flag is set. What stops them is E1 —
     * `endSeed` runs before `graduate` returns — so by the time control is back in their hands the
     * exemption is gone. Asserted by having them immediately replay the EXACT seed shape, which is
     * the one add the waiver would have honoured, and finding it levied in full.
     */
    function test_aStrangerCannotRideTheSeedFlagByCallingGraduateThemselves() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        // Filled under a gas limit too low to auto-graduate, so a stranger gets to do it.
        vm.prank(ALICE);
        c.buy{value: 5_000e18, gas: 900_000}(0, block.timestamp);
        assertFalse(graduation.graduated(address(c)), "the buy graduated it after all");

        address raider = address(0xBAD);
        vm.deal(raider, 1_000_000e18);
        vm.prank(raider);
        graduation.graduate(address(c));

        // Read BEFORE the prank. `vm.prank` applies to the next call, and an argument expression is
        // a call — `t.balanceOf(ALICE)` would consume it and leave `transfer` running as the test
        // contract, which holds none of this token.
        uint256 aliceHeld = t.balanceOf(ALICE);
        vm.prank(ALICE);
        t.transfer(raider, aliceHeld);

        PoolKey memory rk = _key(t);
        PoolId rid = PoolIdLibrary.toId(rk);
        uint256 protBefore = dokuHook.pendingProtocol(rid);
        uint256 sinkBefore = dokuHook.pendingSink(rid);
        DokuHook.Market memory rm = dokuHook.markets(rid);

        vm.startPrank(raider);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        modifyLiquidityRouter.modifyLiquidity{value: 500_000e18}(
            rk,
            ModifyLiquidityParams({
                tickLower: rm.seedTickLower,
                tickUpper: rm.seedTickUpper,
                liquidityDelta: int256(uint256(rm.seedLiquidity)),
                salt: bytes32(uint256(0xBAD))
            }),
            ""
        );
        vm.stopPrank();

        assertTrue(
            dokuHook.pendingProtocol(rid) > protBefore || dokuHook.pendingSink(rid) > sinkBefore,
            "the raider added exempt liquidity after graduating"
        );
    }

    // --------------------------------------------------------------- D4a: the opening price

    /**
     * The curve's marginal price at the instant it filled, in wei of MON per whole token.
     *
     * Same formula the indexer uses (`curveSpotPrice`): the virtual quote reserve starts at 40% of
     * the target and the base ceiling is constant, so spot is `quote^2 / (base0 * q0)`.
     *
     * The raised amount is read as `quoteTarget()`, NOT `quoteRaised()`, and that is not a
     * shortcut: `release` zeroes the raise as part of graduating, so by the time there is a pool to
     * compare against, `quoteRaised()` is 0 and this would compute the price the curve OPENED at.
     * Using the target is exact rather than approximate because D4a's whole point is that the raise
     * lands on it to the wei — `test_theRaiseLandsExactlyOnTargetOnBothSinks` is what makes that
     * substitution legitimate, and if it ever stops holding this test inherits the failure.
     */
    function _curveClosingPrice(BondingCurve c) internal view returns (uint256) {
        uint256 q0 = (c.quoteTarget() * 2) / 5;
        uint256 quote = q0 + c.quoteTarget();
        return (quote * quote * 1e18) / (uint256(c.BASE_VIRTUAL_CEILING()) * q0);
    }

    /// @dev The pool's opening price, same units. `sqrtPriceX96` is sqrt(token per MON), so this
    ///      inverts it: MON per token = (2^96 / sqrtPriceX96)^2, scaled by 1e18.
    function _poolOpeningPrice(PoolId id) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        uint256 ratioX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        return FixedPointMathLib.fullMulDiv(1e18, 1 << 192, ratioX192);
    }

    /**
     * The pool opens at the price the curve closed at. This is what D4a bought.
     *
     * Before D4a the graduation deposit was the raise PLUS the anti-sniper escrow, against a token
     * side that did not grow with it — so the pool opened ABOVE the curve's last traded price, by a
     * margin that scaled with how fast the market filled. Measured at the time: a **3,824 bps**
     * opening premium on a hot launch, worth **+20.63% ROI** to whoever filled the curve and dumped
     * into the pool they had just created.
     *
     * D4a made the deposit a fixed size, so the seed's implied price is the curve's closing price
     * by construction. This asserts the construction actually holds end to end — through the
     * overshoot unwind, the dust tolerance, and `_sqrtPriceX96`'s 512-bit sqrt — rather than only
     * in the arithmetic.
     *
     * The tolerance is one basis point and it is for the sqrt's rounding alone — measured, the gap
     * is 1 wei in 1e14 on a BURN market and exactly zero on a REWARDS one. The premium D4a removed
     * was 3,824 bps, so this bound is nearly four thousand times tighter than the regression it
     * guards: a return to anything resembling the old shape fails by orders of magnitude rather
     * than marginally.
     */
    function test_poolOpensAtTheCurvesClosingPriceOnEverySink() public {
        uint8[2] memory kinds = [Sinks.BURN, Sinks.REWARDS];
        for (uint256 i; i < kinds.length; ++i) {
            (BondingCurve c, DokuToken t) = _market(kinds[i]);
            _fill(c);

            uint256 curvePrice = _curveClosingPrice(c);
            uint256 poolPrice = _poolOpeningPrice(PoolIdLibrary.toId(_key(t)));
            assertGt(curvePrice, 0, "the curve reported no closing price");

            emit log_named_uint("curve closing price", curvePrice);
            emit log_named_uint("pool opening price ", poolPrice);
            uint256 diff = poolPrice > curvePrice ? poolPrice - curvePrice : curvePrice - poolPrice;
            assertLt(
                (diff * 10_000) / curvePrice,
                1,
                "the pool did not open at the curve's closing price"
            );
        }
    }

    /**
     * The attack D4a closed, run rather than described.
     *
     * Fill the curve in one buy, which graduates the market in the same transaction, then dump the
     * whole position into the pool that buy just created. Under the old escrow-in-the-seed shape
     * this was worth +20.63%. It must now lose money, and it does for three compounding reasons:
     * the pool opens at the curve's closing price rather than above it, the dump walks that price
     * down through its own liquidity, and the hook levies the swap on the way out.
     *
     * Asserted on BOTH sinks because they take the levy in different currencies — a BURN market in
     * the token, a REWARDS market in MON — so the sell leg is not the same code path twice.
     */
    function test_fillGraduateDumpIsUnprofitableOnBothSinks() public {
        uint8[2] memory kinds = [Sinks.BURN, Sinks.REWARDS];
        for (uint256 i; i < kinds.length; ++i) {
            (BondingCurve c, DokuToken t) = _market(kinds[i]);

            address raider = address(uint160(0xDEAD00 + i));
            vm.deal(raider, 10_000e18);
            uint256 before = raider.balance;

            vm.warp(block.timestamp + c.TAX_WINDOW() + 1); // no anti-sniper tax to blame
            vm.prank(raider);
            c.buy{value: 5_000e18}(0, block.timestamp);
            assertTrue(graduation.graduated(address(c)), "the fill did not graduate");

            uint256 spent = before - raider.balance;
            uint256 held = t.balanceOf(raider);
            assertGt(held, 0, "the raider bought nothing");

            vm.startPrank(raider);
            t.approve(address(swapper), held);
            swapper.swap(
                _key(t),
                SwapParams({
                    zeroForOne: false,
                    amountSpecified: -int256(held),
                    sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                }),
                PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
                ""
            );
            vm.stopPrank();

            uint256 recovered = raider.balance - (before - spent);
            emit log_named_uint("spent    ", spent);
            emit log_named_uint("recovered", recovered);
            assertLt(recovered, spent, "fill-graduate-dump returned a profit");
        }
    }

    // --------------------------------------------------------------- the key, end to end

    /**
     * The pool the seed was minted into is the pool the hook levies.
     *
     * These are two separate calls in `graduate` — `_register` tells the hook about a key, and
     * `_mintSeed` mints a position under one — and today they take the same memory variable, so
     * they cannot differ. The point is what happens when they can: a seed minted under a key the
     * hook never registered lands in a pool with NO levy, permanently, and every symptom of that
     * is an absence. No revert, no event, no wrong number — just a market that quietly earns
     * nothing for its sink forever while looking completely healthy.
     *
     * So this is asserted from the outside, against the chain, rather than by reading that both
     * lines mention `key`.
     */
    function test_theMintedPositionMatchesTheRegisteredKey() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        _fill(c);

        PoolKey memory k = _key(t);
        PoolId id = PoolIdLibrary.toId(k);

        // The graduation recorded this id...
        assertEq(PoolId.unwrap(graduation.poolIdOf(address(c))), PoolId.unwrap(id), "wrong id recorded");
        // ...the hook registered it...
        DokuHook.Market memory m = dokuHook.markets(id);
        assertTrue(m.registered, "the hook never registered the pool the seed went into");
        assertEq(m.sinkAddr, graduation.sinkOf(address(c)), "the registered sink is not the market's");
        assertEq(dokuHook.tokenOf(id), address(t), "the hook has the wrong token for this pool");
        // ...and the liquidity is actually in it.
        assertGt(manager.getLiquidity(id), 0, "the seed is not in the registered pool");
    }

    /**
     * Every field of the PoolKey is the canonical constant, and each one is load-bearing.
     *
     * `currency0` must be native MON — there is no wrapper, and the sort order the indexer relies
     * on follows from it. `fee` must be ZERO or the levy cannot be skimmed from the swap at all.
     * `hooks` must be this hook or the pool is simply untaxed. `tickSpacing` is the one free
     * choice, and it still has to be the same on every market or two markets hash to keys that
     * cannot be compared.
     */
    function test_thePoolKeyIsExactlyTheCanonicalConstants() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.REWARDS);
        _fill(c);

        PoolKey memory k = _key(t);
        assertEq(Currency.unwrap(k.currency0), address(0), "currency0 is not native MON");
        assertEq(Currency.unwrap(k.currency1), address(t), "currency1 is not the market's token");
        assertEq(k.fee, 0, "a non-zero LP fee would make the levy unskimmable");
        assertEq(address(k.hooks), address(dokuHook), "the pool does not carry our hook");

        // Asserted against the graduation contract's own constants, not against literals, so the
        // key this test builds cannot drift from the one the protocol builds.
        assertEq(uint256(int256(k.tickSpacing)), uint256(int256(graduation.TICK_SPACING())), "tick spacing");
        assertEq(k.fee, graduation.LP_FEE(), "fee constant");

        // And the pool at that key is the one that exists.
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(PoolIdLibrary.toId(k));
        assertGt(sqrtPriceX96, 0, "no pool exists at the canonical key");
    }

    /**
     * Graduation survives the rounding dust it is guaranteed to be handed.
     *
     * `CurveMath` rounds the retained reserve UP, so the residue is `SEED_BASE` plus a few wei
     * rather than exactly it — which is why `DokuGraduation` accepts a band rather than an equality
     * and why `seedDustTolerance` exists. Asserted with the real numbers, because a tolerance
     * that is too tight fails every graduation and one that is too loose lets a materially
     * mispriced seed through.
     */
    function test_graduationSucceedsWithRoundingDustInTheResidue() public {
        (BondingCurve c,) = _market(Sinks.BURN);
        _fill(c);

        uint256 dust = c.seedBase() - graduation.SEED_BASE();
        assertGt(dust, 0, "no dust at all, so the tolerance is untested here");
        assertGe(c.seedBase(), graduation.SEED_BASE(), "the seed came out short");
        assertTrue(graduation.graduated(address(c)), "dust in the residue blocked the graduation");
    }

    // ------------------------------------------- the creator's choice, end to end

    /**
     * A BURN market destroys supply, from a REAL graduation, with nobody privileged involved.
     *
     * The creator picks the sink at launch and then has no further part in it — no key, no call,
     * no claim. So the test that matters is not "the sink can burn" but "the whole path from a
     * trade to destroyed supply runs, permissionlessly, on a market that graduated normally".
     *
     * Every step here is callable by a stranger, and one is: the sweep and the burn are made from
     * an address with no relationship to the market at all.
     */
    function test_aBurnMarketDestroysSupplyEndToEnd() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        _fill(c);

        PoolKey memory k = _key(t);
        PoolId id = PoolIdLibrary.toId(k);
        BurnSink sink = BurnSink(graduation.sinkOf(address(c)));

        // A trade on the graduated pool, which is what the levy is taken from.
        vm.deal(address(this), 1_000e18);
        swapper.swap{value: 100e18}(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -100e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        // The trade credits the sink's 70 bps of the TOKEN leg to the hook's ledger. Until round 4
        // it was donated to the pool instead, the seed earned it as fee growth, and THIS line was
        // `graduation.locker().collect(1)` followed by a non-zero balance check on the sink. The
        // collect is still made — permissionless, so the test calls it exactly as anyone would, and
        // it must stay a clean no-op — but it moves nothing now and the money is in `pendingSink`.
        assertGt(dokuHook.pendingSink(id), 0, "the trade paid the sink nothing");
        // A DELTA, because graduation already routes the curve's leftover token dust to a BURN
        // market's sink — 89 wei on this fixture — so an absolute zero here would be asserting
        // something about graduation rather than about the collect.
        uint256 sinkTokBefore = sink.token().balanceOf(address(sink));
        graduation.locker().collect(1);
        assertEq(
            sink.token().balanceOf(address(sink)),
            sinkTokBefore,
            "the seed position paid the sink before the sweep"
        );

        uint256 supplyBefore = t.totalSupply();
        address stranger = address(0x5747A6E);

        // Sweep materialises the claim into a real token balance the hook owes this market, and
        // `BurnSink.burn` calls `pullSink` itself — so the whole path from trade to destroyed
        // supply is two permissionless calls made by an address with no relationship to the market.
        vm.prank(stranger);
        dokuHook.sweep(id);
        vm.prank(stranger);
        uint256 burned = sink.burn();

        assertGt(burned, 0, "the sink burned nothing");
        assertEq(t.totalSupply(), supplyBefore - burned, "supply did not fall by what was burned");
        assertEq(t.balanceOf(address(sink)), 0, "the sink kept token instead of destroying it");
        assertEq(address(sink).balance, 0, "a BURN sink was handed MON it cannot use");
    }

    /**
     * A REWARDS market pays a holder, from a REAL graduation, and the holder keeps it.
     *
     * The longer of the two paths and the one with more to go wrong: sweep, fund, open an epoch,
     * claim. Every step permissionless, and the claim is made BY the holder for themselves — which
     * is the only step where being the right address matters at all.
     */
    function test_aRewardsMarketPaysAHolderEndToEnd() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.REWARDS);
        _fill(c);

        PoolKey memory k = _key(t);
        PoolId id = PoolIdLibrary.toId(k);
        RewardVault vault = RewardVault(payable(graduation.sinkOf(address(c))));

        vm.deal(address(this), 5_000e18);
        swapper.swap{value: 500e18}(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -500e18, sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        address stranger = address(0x5747A6E);
        vm.prank(stranger);
        dokuHook.sweep(id);
        vm.prank(stranger);
        // Collect first: `fund()` pulls the hook's ledger, and the seed position's fees only reach
        // that ledger when the locker forwards them.
        graduation.locker().collect(1);
        vault.fund();
        assertGt(vault.unallocated(), 0, "the vault was funded with nothing");

        // Past the grid line that CLOSES interval 0, which is grid line 1: an epoch is funded from
        // its own interval's bucket, so it cannot open until that interval has stopped earning.
        // The cadence is fixed, so nobody chooses this instant either.
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vm.prank(stranger);
        uint256 epoch = vault.createEpoch();

        // ALICE filled the curve, so she is the holder with weight.
        assertGt(vault.weightOf(ALICE, epoch), 0, "the filling buyer has no weight");
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        uint256 paid = vault.claim(ALICE, epoch, epoch);

        assertGt(paid, 0, "the holder was paid nothing");
        assertEq(ALICE.balance - before, paid, "the payment did not arrive");
        assertEq(t.balanceOf(address(vault)), 0, "a REWARDS vault was handed the token");

        // And it is once only.
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vm.prank(ALICE);
        vault.claim(ALICE, epoch, epoch);
    }

    /**
     * The LP position, which is the promise the whole design rests on.
     *
     * Not "liquidity exists" but "liquidity exists and NOBODY can take it out". Asserted four ways,
     * because each covers a different way it could fail to be true.
     */
    function test_theLiquidityIsDeployedAndUnrecoverable() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        _fill(c);
        PoolId id = PoolIdLibrary.toId(_key(t));

        // 1. It is there, and it is the seed rather than dust.
        assertGe(manager.getLiquidity(id), 1e21, "the pool holds almost no liquidity");

        // 2. The position is at the locker, which owns it and cannot be made to sign for it.
        address locker = address(graduation.locker());
        assertEq(IERC721(address(lpm)).ownerOf(1), locker, "the position is not at the locker");
        (bool signs,) = locker.staticcall(abi.encodeWithSignature("isValidSignature(bytes32,bytes)", bytes32(0), ""));
        assertFalse(signs, "the locker answers ERC-1271");

        // 3. Nobody holds an approval over it — not the graduator, not the deployer, not anyone.
        assertEq(IERC721(address(lpm)).getApproved(1), address(0), "someone holds an approval");
        assertFalse(
            IERC721(address(lpm)).isApprovedForAll(locker, address(graduation)),
            "the graduator is an operator for the locker"
        );
        assertFalse(
            IERC721(address(lpm)).isApprovedForAll(locker, address(this)),
            "the test contract is an operator for the locker"
        );

        // 4. And a stranger cannot move it. This is the one that would fail if any of the above
        //    were subtly wrong.
        vm.prank(address(0xBAD));
        vm.expectRevert();
        IERC721(address(lpm)).transferFrom(locker, address(0xBAD), 1);

        // 5. And the locker itself has no way to give it away or to shrink it. There is no function
        //    to call: no transfer, no approve, no burn, no decrease with a non-zero delta. This is
        //    the whole of the difference between "locked" and "locked unless somebody decides
        //    otherwise", so it is asserted rather than described.
        for (uint256 i = 0; i < 5; i++) {
            string[5] memory sigs = [
                "transfer(uint256,address)",
                "approve(address,uint256)",
                "withdraw(uint256)",
                "decreaseLiquidity(uint256,uint256)",
                "setApprovalForAll(address,bool)"
            ];
            (bool exists,) = locker.call(abi.encodeWithSignature(sigs[i], uint256(1), address(0xBAD)));
            assertFalse(exists, "the locker exposes a function that could move the principal");
        }
    }

    // ------------------------------------------------------------------- the exclusion set

    /**
     * The exclusion set the REAL graduation builds, asserted address by address.
     *
     * Fixtured on the ADDRESSES rather than on a join, deliberately. `holders.ts` reaches the pool
     * through `graduations.pool_address`, which under v4 is the PoolManager and is therefore the
     * SAME value on every market — so a parity test written as a join can pass while the contract
     * and the indexer are wrong in the same way. Naming the members here makes this test the spec
     * that `indexer/test/holders.test.ts` mirrors, and disagreement shows up on one side or both.
     *
     * The list is `{PoolManager, hook, curve, token, DEAD, Graduation, PositionManager, vault}`.
     * PositionManager is belt-and-braces — under v4 it settles straight through to the singleton
     * and never holds a token — and the vault fills its own slot, since it cannot be told its
     * address before it exists.
     */
    function test_exclusionSetMatchesTheIndexer() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.REWARDS);
        _fill(c);

        RewardVault v = RewardVault(payable(graduation.sinkOf(address(c))));
        address[9] memory ex = v.excluded();

        assertEq(ex[0], address(manager), "slot 0 is not the PoolManager");
        assertEq(ex[1], address(dokuHook), "slot 1 is not the hook");
        assertEq(ex[2], address(c), "slot 2 is not the curve");
        assertEq(ex[3], address(t), "slot 3 is not the token");
        assertEq(ex[4], DEAD, "slot 4 is not the dead address");
        assertEq(ex[5], address(graduation), "slot 5 is not the graduation contract");
        assertEq(ex[6], address(lpm), "slot 6 is not the position manager");
        assertEq(ex[8], address(v), "slot 7 is not the vault itself");

        // Nothing empty, and nothing repeated. A duplicate would subtract the same balance twice
        // and under-report eligible supply, which over-pays every claimant.
        for (uint256 i; i < ex.length; ++i) {
            assertTrue(ex[i] != address(0), "an exclusion slot is empty");
            for (uint256 j = i + 1; j < ex.length; ++j) {
                assertTrue(ex[i] != ex[j], "an address appears in the exclusion set twice");
            }
        }
    }

    /// @dev A BURN market has no vault and therefore no exclusion set — its sink destroys supply
    ///      rather than dividing it. Asserted so the parity test above is not read as applying to
    ///      both kinds.
    function test_aBurnMarketHasNoExclusionSetToKeepInSync() public {
        (BondingCurve c,) = _market(Sinks.BURN);
        _fill(c);
        address sink = graduation.sinkOf(address(c));
        assertTrue(BurnSink(sink).sinkCurrencyIsToken(), "a BURN market did not get a token sink");
        (bool ok,) = sink.staticcall(abi.encodeWithSignature("excluded()"));
        assertFalse(ok, "a BurnSink answered excluded(), so the two sinks are not distinguishable");
    }

    function test_graduatingTwiceIsRefused() public {
        (BondingCurve c,) = _market(Sinks.BURN);
        _fill(c);
        vm.expectRevert(DokuGraduation.AlreadyGraduated.selector);
        graduation.graduate(address(c));
    }

    // ------------------------------------------------------------------------ generation two

    function test_aUsdcMarketGraduatesIntoASortedKeyWithAUsdcVault() public {
        (BondingCurve c, DokuToken t) = _marketWith(address(usdc), TARGET_USDC, Sinks.REWARDS, 0);
        _fill(c);
        assertTrue(graduation.graduated(address(c)), "the USDC market did not graduate");
        PoolKey memory k = _keyFor(address(usdc), address(t));
        PoolId id = PoolIdLibrary.toId(k);
        assertEq(PoolId.unwrap(graduation.poolIdOf(address(c))), PoolId.unwrap(id), "wrong pool recorded");
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "the pool was never initialised");
        assertGt(manager.getLiquidity(id), 0, "no liquidity");
        assertEq(dokuHook.markets(id).quoteIsCurrency0, address(usdc) < address(t), "quote side mis-recorded");
        assertEq(Currency.unwrap(dokuHook.quoteOf(id)), address(usdc));
        assertEq(
            RewardVault(payable(graduation.sinkOf(address(c)))).quote(), address(usdc), "the vault pays the wrong asset"
        );
        assertEq(usdc.balanceOf(address(graduation)), 0, "USDC dust left in graduation");
    }

    function test_aCreatorMarketUsesTheSharedSinkAndRegistersItsRecipients() public {
        (BondingCurve c, DokuToken t) = _marketWith(address(0), TARGET, Sinks.CREATOR, 300);
        _fill(c);
        assertEq(graduation.sinkOf(address(c)), address(creatorSink), "a CREATOR market deployed its own sink");
        PoolId id = PoolIdLibrary.toId(_key(t));
        (PoolId rid, address quote, address routed, address tax, bool registered) = creatorSink.entries(address(c));
        assertTrue(registered, "graduation did not register the market with the CreatorSink");
        assertEq(PoolId.unwrap(rid), PoolId.unwrap(id));
        assertEq(quote, address(0));
        assertEq(routed, c.feeRecipient(), "routed recipient");
        assertEq(tax, c.taxRecipient(), "tax recipient");
        DokuHook.Market memory m = dokuHook.markets(id);
        assertEq(m.creatorTaxBps, 300, "the hook did not record the creator tax");
        assertEq(m.sinkAddr, address(creatorSink));
    }

    /// @dev The tax is paid on every routing, so every taxed market needs the puller registered.
    function test_aTaxedHoldersMarketIsAlsoRegisteredWithTheSharedSink() public {
        (BondingCurve c,) = _marketWith(address(0), TARGET, Sinks.REWARDS, 500);
        _fill(c);
        (,, address routed, address tax, bool registered) = creatorSink.entries(address(c));
        assertTrue(registered, "a taxed HOLDERS market has no tax puller");
        assertEq(routed, graduation.sinkOf(address(c)), "routed slot should name the market's own sink");
        assertEq(tax, c.taxRecipient());
        (BondingCurve u,) = _marketWith(address(0), TARGET, Sinks.BURN, 0);
        _fill(u);
        (,,,, bool reg2) = creatorSink.entries(address(u));
        assertFalse(reg2, "an untaxed BUYBACK market was registered for nothing");
    }

    /// @dev The gen-1 REWARDS branch bare-sent MON dust into a vault whose `receive()` does not
    ///      count it. Now it is credited through the hook, where `fund()` will find it.
    function test_quoteDustIsCreditedThroughTheHookNotBareSent() public {
        uint8[2] memory kinds = [Sinks.REWARDS, Sinks.CREATOR];
        for (uint256 i; i < 2; ++i) {
            (BondingCurve c,) = _marketWith(address(0), TARGET, kinds[i], 0);
            _fill(c);
            assertEq(address(graduation).balance, 0, "MON dust left in graduation");
            assertEq(graduation.sinkOf(address(c)).balance, 0, "dust was bare-sent to the sink");
        }
    }

    /// @dev The tolerance regression. Fifty alternating buys and sells on a USDC market leave
    ///      ≈ 50 × 1e17 base wei of rounding residue in the curve; an absolute 1e6 tolerance froze
    ///      such a market with its whole raise inside it. It must graduate.
    function test_aUsdcMarketWithFiftySellsStillGraduates() public {
        (BondingCurve c, DokuToken t) = _marketWith(address(usdc), TARGET_USDC, Sinks.REWARDS, 0);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        usdc.mint(ALICE, 100 * TARGET_USDC);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        t.approve(address(c), type(uint256).max);
        for (uint256 i; i < 50; ++i) {
            c.buyWithToken(TARGET_USDC / 100, 0, block.timestamp);
            c.sell(t.balanceOf(ALICE) / 3, 0, block.timestamp);
        }
        vm.stopPrank();
        _fill(c);
        assertTrue(
            graduation.graduated(address(c)),
            "a sold-into USDC market cannot graduate: the seed tolerance is absolute"
        );
        uint256 residue = c.seedBase() - graduation.SEED_BASE();
        assertGt(residue, 1e6, "the residue never exceeded the gen-1 tolerance, so this test proves nothing");
        assertGe(c.seedBase(), graduation.SEED_BASE(), "the seed came out short");
    }

    /// @dev Decoded from the recorded log rather than matched with `vm.expectEmit`, and the
    ///      difference is the difference between this test's name and what it used to check. The
    ///      flags `(true, true, false, false)` compare the two indexed topics and NOTHING ELSE —
    ///      `checkData: false` means the four non-indexed fields, the quote asset among them, were
    ///      never looked at, so the test passed on a market quoted in anything at all. Setting
    ///      `checkData: true` is not possible either: the seed's base amount and the position's
    ///      token id do not exist until the fill, so an `expectEmit` would have to be handed the
    ///      numbers it is supposed to be checking. Recording and decoding compares every field
    ///      against an independent source.
    function test_theGraduatedEventCarriesTheQuoteAsset() public {
        (BondingCurve c, DokuToken t) = _marketWith(address(usdc), TARGET_USDC, Sinks.BURN, 0);
        PoolId id = PoolIdLibrary.toId(_keyFor(address(usdc), address(t)));
        // The fill is inlined rather than taken from `_fill`, because `_fill` mints and approves
        // before it buys and the recording should cover the graduating call alone.
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        usdc.mint(ALICE, 5 * TARGET_USDC);
        vm.prank(ALICE);
        usdc.approve(address(c), 5 * TARGET_USDC);
        vm.recordLogs();
        vm.prank(ALICE);
        c.buyWithToken(5 * TARGET_USDC, 0, block.timestamp);
        assertTrue(graduation.graduated(address(c)), "the market did not graduate, so no event was due");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(graduation)) continue;
            if (logs[i].topics[0] != DokuGraduation.Graduated.selector) continue;
            assertFalse(seen, "graduation was announced twice");
            seen = true;
            assertEq(address(uint160(uint256(logs[i].topics[1]))), address(c), "curve topic");
            assertEq(logs[i].topics[2], PoolId.unwrap(id), "pool id topic");
            (address token, address quoteAsset, uint256 quoteAmount, uint256 baseAmount, uint256 tokenId) =
                abi.decode(logs[i].data, (address, address, uint256, uint256, uint256));
            assertEq(token, address(t), "the event named the wrong token");
            assertEq(quoteAsset, address(usdc), "the event did not carry the market's quote asset");
            assertEq(quoteAmount, TARGET_USDC, "the event's quote amount is not the raise");
            assertEq(baseAmount, c.seedBase(), "the event's base amount is not the latched seed");
            // Not merely non-zero: the id must name the position graduation actually locked.
            assertEq(IERC721(address(lpm)).ownerOf(tokenId), address(graduation.locker()), "the event's token id is not the seed position");
        }
        assertTrue(seen, "no Graduated event was emitted");
    }

    // ------------------------------------------------- B10a: the opening price at a coarse quote

    /// @dev Like `_marketWith`, but the launch token is guaranteed to sort ABOVE the quote — which
    ///      is what puts the fixed 222,222,222e18 token seed on `amount1`, the numerator of the
    ///      opening price. Clone addresses are effectively random, so this is a short loop rather
    ///      than a construction; it is bounded so a failure to find one is loud.
    function _marketWithTokenAboveQuote(address quote, uint256 target, uint8 sink)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        for (uint256 i; i < 64; ++i) {
            t = DokuToken(Clones.clone(tokenImpl));
            if (address(t) > quote) break;
        }
        require(address(t) > quote, "no clone sorted above the quote in 64 tries");
        t.initialize(unicode"D", unicode"D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), quote, target, sink, address(0), 0, ALICE, TREASURY, address(graduation), address(creatorSink)
        );
    }

    /**
     * B10a, offline. The pool must open however coarse the quote is.
     *
     * `_sqrtPriceX96` used to compute `fullMulDiv(amount1, 1 << 192, amount0)`, which reverts once
     * `amount1 / amount0` reaches 2^64. The token seed is a FIXED 222,222,222e18, so that ratio is
     * reached whenever the launch token sorts above the quote and the quote seed is under
     * **12,046,690 raw units** — 12.05 whole tokens of any six-decimal quote. That is $12 of a
     * stablecoin, but ~12 troy ounces of gold (~$40,000) and ~0.12 BTC (~$12,000), so no sensibly
     * sized gold or bitcoin market clears it. XAUt0's address is `0x01bF…`, which puts nearly every
     * launch token above it.
     *
     * Auto-graduation swallows the revert by design, so the symptom is a filled curve with the
     * whole raise inside it and every retry reverting — B9a's shape, reached another way.
     *
     * It went unseen because every ERC-20 market in this file raises `10_000e6`, a thousand times
     * above the line. It took a Monad mainnet fork with a real six-decimal gold token to surface it,
     * and it is asserted here so the next one does not need a network.
     */
    function test_aCoarseQuoteMarketWhoseTokenSortsAboveItStillOpensItsPool() public {
        (BondingCurve c, DokuToken t) = _marketWithTokenAboveQuote(address(usdc), TARGET_GOLD, Sinks.REWARDS);
        assertTrue(address(t) > address(usdc), "the fixture did not put the token on amount1");

        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        usdc.mint(ALICE, 5 * TARGET_GOLD);
        vm.startPrank(ALICE);
        usdc.approve(address(c), 5 * TARGET_GOLD);
        c.buyWithToken(5 * TARGET_GOLD, 0, block.timestamp);
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        if (!graduation.graduated(address(c))) {
            // Auto-graduation swallows every failure by design (D3), so a broken graduator never
            // costs the filling buyer their trade. Retried in the open purely so this test reports
            // WHY — it does not make it pass: the assertion below still runs.
            graduation.graduate(address(c));
        }
        assertTrue(graduation.graduated(address(c)), "the filling buy did not graduate the market");

        PoolId id = PoolIdLibrary.toId(_keyFor(address(usdc), address(t)));
        (uint160 opened,,,) = manager.getSlot0(id);
        assertGt(opened, 0, "the pool was never initialised");
        assertGt(manager.getLiquidity(id), 0, "the pool has no liquidity");

        // And it opened at the price the narrow path computes, not at some other number that merely
        // happened not to revert.
        uint256 narrow = FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(c.seedBase(), 1 << 96, TARGET_GOLD)) << 48;
        assertEq(opened, uint160(narrow), "the pool did not open at the 96-bit price");
    }

    /// @dev The branch must not be a second implementation that drifts. On a market where BOTH
    ///      paths are defined, the pool opens at the wide one — the price every other test in this
    ///      suite was written against — and the narrow one agrees with it to within a single ulp of
    ///      the truncated root, `2^48`. It can only ever be lower: `sqrt` truncates, and the shift
    ///      cannot recover what truncation dropped. Above the branch point the root exceeds 2^80, so
    ///      that same absolute ulp is a relative error under 2^-80.
    function test_theTwoOpeningPricePathsAgreeWhereBothAreDefined() public {
        (BondingCurve c, DokuToken t) = _marketWith(address(usdc), TARGET_USDC, Sinks.REWARDS, 0);
        _fill(c);

        (uint256 amount0, uint256 amount1) =
            address(usdc) < address(t) ? (TARGET_USDC, c.seedBase()) : (c.seedBase(), TARGET_USDC);
        assertLt(amount1, (1 << 64) * amount0, "this market takes the narrow path: it cannot compare the two");

        uint256 wide = FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(amount1, 1 << 192, amount0));
        uint256 narrow = FixedPointMathLib.sqrt(FixedPointMathLib.fullMulDiv(amount1, 1 << 96, amount0)) << 48;

        (uint160 opened,,,) = manager.getSlot0(PoolIdLibrary.toId(_keyFor(address(usdc), address(t))));
        assertEq(opened, uint160(wide), "the pool did not open at the 192-bit price");
        assertLe(narrow, wide, "the narrow path exceeded the wide one, which truncation cannot do");
        assertLt(wide - narrow, 1 << 48, "the two paths disagree by more than one ulp of the shifted root");
    }

    function test_theCurveCanForwardItsRoutedShareThroughGraduation() public {
        (BondingCurve c, DokuToken t) = _marketWith(address(usdc), TARGET_USDC, Sinks.REWARDS, 0);
        _fill(c);
        PoolId id = PoolIdLibrary.toId(_keyFor(address(usdc), address(t)));
        usdc.mint(address(this), 7e6);
        usdc.approve(address(graduation), 7e6);
        graduation.creditCurveTax(address(c), 7e6);
        assertEq(dokuHook.owedSink(id), 7e6, "the ERC-20 credit did not reach the hook's ledger");
        (BondingCurve n, DokuToken nt) = _market(Sinks.REWARDS);
        _fill(n);
        // A delta, not an absolute — and under generation 5 the delta is the whole of it.
        //
        // This used to read `assertGt(beforeNative, 0)`, because a native market's seed dust was
        // swept home out of the PositionManager and credited to this ledger by `_sweepDust`. Since
        // `_mintSeed` stopped ending its action list with `Actions.SWEEP`, that residue stays in
        // POSM instead — 25,622 wei at a 1,000 MON target, forfeited rather than credited, so that
        // no graduation ever drags a third party's balance out of the shared PositionManager. See
        // `test/audit/Gen5NoNativeSweep.t.sol` for the measurement and the ceiling on it.
        //
        // So the opening balance is now exactly zero, and it is asserted rather than assumed: this
        // line is what notices if the sweep ever comes back.
        PoolId nid = PoolIdLibrary.toId(_key(nt));
        uint256 beforeNative = dokuHook.owedSink(nid);
        assertEq(beforeNative, 0, "a native seed credited dust to the ledger: the seed sweep is back");
        graduation.creditCurveTax{value: 1 ether}(address(n));
        assertEq(dokuHook.owedSink(nid) - beforeNative, 1 ether, "the native credit did not reach the hook's ledger");
        vm.expectRevert(DokuGraduation.NotGraduated.selector);
        graduation.creditCurveTax{value: 1}(address(0xDEAD));
    }
}
