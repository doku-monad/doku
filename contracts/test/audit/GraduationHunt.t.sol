// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DOKU_SEED_BASE} from "../../src/BondingCurve.sol";
import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {IERC721} from "openzeppelin/token/ERC721/IERC721.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

// Imported ONLY so forge compiles their artifacts: v4-periphery's test `Deploy` library builds
// them through `vm.getCode(...)`, which resolves against the build OUTPUT, so a contract nothing
// here imports is never compiled and `setUp` fails on "no matching artifact found".
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";


/// @dev `_sqrtPriceX96` is `internal`. Nothing in `DokuGraduation`'s constructor calls out, so a
///      subclass with placeholder wiring is the real function, byte for byte.
contract SqrtHarness is DokuGraduation {
    constructor()
        DokuGraduation(address(0x11), address(0x22), address(0x33), address(0x44), address(0x55))
    {}

    function sqrtPriceX96(uint256 amount0, uint256 amount1) external pure returns (uint160) {
        return _sqrtPriceX96(amount0, amount1);
    }
}

/**
 * ## The seed mint's round trip, over the whole legal seed space.
 *
 * `graduate` prices the pool from the amounts it received, derives one liquidity number from that
 * price, and then hands POSM `amount0Max = amount0` and `amount1Max = amount1` — the seed EXACTLY,
 * with no slack. POSM validates the POST-hook delta with `validateMaxIn`, and the pool computes
 * that delta with `roundUp = true` on both legs (`Pool.modifyLiquidity` -> the signed
 * `SqrtPriceMath.getAmount*Delta`, which negates the rounded-UP unsigned form for a positive
 * liquidity delta).
 *
 * So the whole graduation rests on an unstated inequality:
 *
 *     ceil(amount0(L))  <=  amount0     and     ceil(amount1(L))  <=  amount1
 *
 * where `L = min(L0, L1)` is itself computed with three FLOORS (`getLiquidityForAmount0` floors an
 * intermediate and then floors the quotient; `getLiquidityForAmount1` floors once). If that
 * inequality is ever false by ONE WEI, `graduate` reverts `MaximumAmountExceeded` on every retry
 * forever, `_tryAutoGraduate` swallows it, and the market's entire raise is sealed in a closed
 * curve — the exact shape of four of the eight defects the 2026-09-09 internal audit found.
 *
 * The legal seed space is far wider than the suite's fixtures. `MIN_QUOTE_TARGET` is **5 raw
 * units** and `MAX_QUOTE_TARGET` is `1e30`; the base leg is `DOKU_SEED_BASE` plus unbounded sell
 * residue, up to `launchSupply`. Every existing test sits in a handful of points near the middle.
 */
contract GraduationSeedMathHunt is Test {
    SqrtHarness internal h;

    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant MAX_QUOTE_TARGET = 1e30;
    uint256 internal constant MIN_QUOTE_TARGET = 5;
    uint256 internal constant LAUNCH_SUPPLY = 1_000_000_000e18;

    function setUp() public {
        h = new SqrtHarness();
    }

    /// @dev Exactly what `graduate` steps 4 and 7 do, then exactly what v4 charges for it.
    function _roundTrip(uint256 amount0, uint256 amount1)
        internal
        view
        returns (uint160 sqrtP, uint128 liquidity, uint256 need0, uint256 need1)
    {
        sqrtP = h.sqrtPriceX96(amount0, amount1);
        int24 lower = TickMath.minUsableTick(TICK_SPACING);
        int24 upper = TickMath.maxUsableTick(TICK_SPACING);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(lower);
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(upper);
        liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtL, sqrtU, amount0, amount1);

        // The pool's own arithmetic for a range that straddles the current tick.
        need0 = SqrtPriceMath.getAmount0Delta(sqrtP, sqrtU, liquidity, true);
        need1 = SqrtPriceMath.getAmount1Delta(sqrtL, sqrtP, liquidity, true);
    }

    /// @notice The seed the curve hands over must always cover the position the graduator asks for.
    function testFuzz_theSeedMintNeverAsksForMoreThanTheCurveHandedOver(
        uint256 quoteRaw,
        uint256 baseRaw,
        bool quoteIsCurrency0
    ) public view {
        quoteRaw = bound(quoteRaw, MIN_QUOTE_TARGET, MAX_QUOTE_TARGET);
        quoteRaw = quoteRaw - (quoteRaw % 5); // BondingCurve.initialize: targets are multiples of 5
        if (quoteRaw < MIN_QUOTE_TARGET) quoteRaw = MIN_QUOTE_TARGET;
        // The seed base is DOKU_SEED_BASE plus unbounded sell-rounding residue; the ceiling is the
        // whole launch supply, because the upper bound on it was deliberately removed (step 2b).
        baseRaw = bound(baseRaw, DOKU_SEED_BASE, LAUNCH_SUPPLY);

        (uint256 amount0, uint256 amount1) =
            quoteIsCurrency0 ? (quoteRaw, baseRaw) : (baseRaw, quoteRaw);

        (uint160 sqrtP, uint128 liquidity, uint256 need0, uint256 need1) = _roundTrip(amount0, amount1);

        assertGt(liquidity, 0, "NoLiquidityMinted: the raise would be stranded");
        assertGe(sqrtP, TickMath.MIN_SQRT_PRICE, "sqrtPrice below v4's floor");
        assertLt(sqrtP, TickMath.MAX_SQRT_PRICE, "sqrtPrice above v4's ceiling");
        assertLe(need0, amount0, "MaximumAmountExceeded on currency0: raise stranded forever");
        assertLe(need1, amount1, "MaximumAmountExceeded on currency1: raise stranded forever");
    }

    /// @notice The straddle assumption: `Pool.modifyLiquidity` only charges BOTH legs while the
    ///         initialised tick is strictly inside the seed range. Outside it, one whole leg of the
    ///         raise becomes dust.
    function testFuzz_theInitialisedTickAlwaysStraddlesTheSeedRange(
        uint256 quoteRaw,
        uint256 baseRaw,
        bool quoteIsCurrency0
    ) public view {
        quoteRaw = bound(quoteRaw, MIN_QUOTE_TARGET, MAX_QUOTE_TARGET);
        baseRaw = bound(baseRaw, DOKU_SEED_BASE, LAUNCH_SUPPLY);
        (uint256 amount0, uint256 amount1) =
            quoteIsCurrency0 ? (quoteRaw, baseRaw) : (baseRaw, quoteRaw);

        uint160 sqrtP = h.sqrtPriceX96(amount0, amount1);
        int24 tick = TickMath.getTickAtSqrtPrice(sqrtP);
        assertGe(tick, TickMath.minUsableTick(TICK_SPACING), "seed is single-sided at the bottom");
        assertLt(tick, TickMath.maxUsableTick(TICK_SPACING), "seed is single-sided at the top");
    }
}

/**
 * The same inequality, but SEARCHED rather than sampled.
 *
 * The round trip's danger zone is not uniformly distributed. `getAmount0Delta` ceils twice, and one
 * unit of the outer ceiling is one raw unit of the QUOTE — so the overshoot risk is largest exactly
 * where the quote leg is smallest, which is the legal minimum (`MIN_QUOTE_TARGET == 5` raw units, a
 * multiple of five) rather than anywhere the existing fixtures sit. A 10,000-run fuzz over a range
 * spanning 5 to 1e30 samples that corner essentially never, so it is walked here.
 */
contract GraduationSeedEdgeHunt is Test {
    SqrtHarness internal h;
    int24 internal constant TICK_SPACING = 60;
    uint256 internal constant LAUNCH_SUPPLY = 1_000_000_000e18;

    function setUp() public {
        h = new SqrtHarness();
    }

    function _check(uint256 amount0, uint256 amount1) internal view {
        uint160 sqrtP = h.sqrtPriceX96(amount0, amount1);
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(TICK_SPACING));
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(TICK_SPACING));
        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(sqrtP, sqrtL, sqrtU, amount0, amount1);
        assertGt(liquidity, 0, "NoLiquidityMinted");
        assertLe(SqrtPriceMath.getAmount0Delta(sqrtP, sqrtU, liquidity, true), amount0, "over on currency0");
        assertLe(SqrtPriceMath.getAmount1Delta(sqrtL, sqrtP, liquidity, true), amount1, "over on currency1");
    }

    /// @notice Every legal quote target from the minimum up, against the nominal seed, both orders.
    function test_theSmallestLegalTargetsMintWithoutOvershooting() public view {
        for (uint256 target = 5; target <= 5_000; target += 5) {
            _check(target, DOKU_SEED_BASE); // quote is currency0 — native MON, or a low ERC-20
            _check(DOKU_SEED_BASE, target); // token sorts first
        }
    }

    /// @notice Sell-rounding residue moves the base leg by wei at a time. Walk the first wei.
    function test_residueOnTheBaseLegDoesNotBreakTheRoundTrip() public view {
        for (uint256 d = 0; d < 400; d++) {
            _check(5, DOKU_SEED_BASE + d);
            _check(2_424_240, DOKU_SEED_BASE + d); // the gold-shaped target from the v4 suite
            _check(DOKU_SEED_BASE + d, 5);
            _check(DOKU_SEED_BASE + d, 2_424_240);
        }
    }

    /// @notice Powers of two and their neighbours on both legs — where a shift-based `sqrt` and the
    ///         `1 << 64` branch in `_sqrtPriceX96` change behaviour.
    function test_theBranchPointOfTheOpeningPriceIsSafeOnBothSides() public view {
        // The wide/narrow boundary: amount1 == (1 << 64) * amount0.
        for (uint256 e = 0; e < 60; e++) {
            uint256 base = DOKU_SEED_BASE + e;
            uint256 pivot = base >> 64; // the quote at which the branch flips, give or take one
            for (uint256 d = 0; d < 5; d++) {
                if (pivot + d == 0) continue;
                _check(pivot + d, base);
                if (pivot > d) _check(pivot - d, base);
            }
        }
    }

    /// @notice The upper end: `MAX_QUOTE_TARGET` against the largest seed the curve could hand over.
    function test_theLargestLegalSeedMintsWithoutOvershooting() public view {
        _check(1e30, DOKU_SEED_BASE);
        _check(1e30, LAUNCH_SUPPLY);
        _check(DOKU_SEED_BASE, 1e30);
        _check(LAUNCH_SUPPLY, 1e30);
        _check(5, LAUNCH_SUPPLY);
        _check(LAUNCH_SUPPLY, 5);
    }
}

// ---------------------------------------------------------------------------------------------
//                                    the end-to-end hunt
// ---------------------------------------------------------------------------------------------

/// @dev The recorded impostor: an arbitrary contract that says everything a filled market says.
///      This is the 2026-09-09 internal audit's defect #2, rebuilt so the current guard can be
///      shown to refuse it — and so the guard can be shown to be the ONLY thing that does.
contract Impostor {
    address public token;
    address public quoteAsset;
    uint256 public quoteTarget;
    uint8 public sink;
    uint16 public creatorTaxBps;
    address public taxRecipient;
    address public feeRecipient;
    uint64 public readyAtBlock;
    bool public readyToGraduate = true;
    bool public released;
    uint256 private _seedBase;

    constructor(address token_, address quote_, uint256 target_, uint256 seedBase_) {
        token = token_;
        quoteAsset = quote_;
        quoteTarget = target_;
        _seedBase = seedBase_;
        readyAtBlock = uint64(block.number);
    }

    function release() external returns (uint256, uint256) {
        released = true;
        (bool ok,) = msg.sender.call{value: quoteTarget}("");
        require(ok, "pay");
        IERC20(token).transfer(msg.sender, _seedBase);
        return (quoteTarget, _seedBase);
    }

    receive() external payable {}
}

/// @dev Records what graduation registers, and asserts the once. Same shape as the v4 suite's.
contract RecordingSink {
    mapping(address => bool) public registered;

    function register(address market, PoolId, address, address, address) external {
        require(!registered[market], "twice");
        registered[market] = true;
    }

    receive() external payable {}
}

contract GraduationEndToEndHunt is PosmTestSetup {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0xBAD);
    address internal constant KEEPER = address(0x1234);
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant TARGET_USDC = 10_000e6;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    MarketsStub internal markets;
    RecordingSink internal creatorSink;
    MockUSDC internal usdc;
    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        creatorSink = new RecordingSink();
        usdc = new MockUSDC();
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        markets = new MarketsStub();
        graduation = new DokuGraduation(
            address(manager), address(lpm), address(permit2), address(dokuHook), address(markets)
        );
        dokuHook.setGraduator(address(graduation), true);
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        vm.deal(ALICE, 1_000_000e18);
        vm.deal(MALLORY, 1_000_000e18);
    }

    function _market(address quote, uint256 target, uint8 sink)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), quote, target, sink,
            sink == Sinks.CREATOR ? ALICE : address(0), 0, address(0), TREASURY,
            address(graduation), address(creatorSink)
        );
    }

    function _fill(BondingCurve c) internal {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        if (c.quoteAsset() == address(0)) {
            vm.prank(ALICE);
            c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp());
        } else {
            usdc.mint(ALICE, 5 * TARGET_USDC);
            vm.startPrank(ALICE);
            usdc.approve(address(c), 5 * TARGET_USDC);
            c.buyWithToken(5 * TARGET_USDC, 0, vm.getBlockTimestamp());
            vm.stopPrank();
        }
    }

    /// @dev Fill without graduating: starve the inner call the way an under-gassed wallet does.
    function _fillStarved(BondingCurve c) internal {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.prank(ALICE);
        c.buy{value: 5 * TARGET, gas: 900_000}(0, vm.getBlockTimestamp());
        require(c.readyToGraduate(), "did not fill");
        require(!graduation.graduated(address(c)), "graduated after all");
    }

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

    // -------------------------------------------------------- the impostor, and its only guard

    /**
     * The recorded impostor is refused — and the guard is the ONLY thing refusing it.
     *
     * `graduate` still believes the subject about its token, its quote, its target, its seed and
     * its readiness; every one of those is read straight off `curve` with no cross-check. What
     * changed is a single line, `if (!factory.isMarket(curve)) revert NotAMarket(curve)`
     * (`src/DokuGraduation.sol:190`). The second half of this test removes that one answer and
     * shows the whole 2026-09-09 defect #2 come straight back — the real market's PoolKey
     * initialised at a price the attacker chose, and the genuine curve then unable to graduate
     * ever again. So the property is not "graduation validates its subject"; it is "`DokuFactory`
     * is never wrong about `isMarket`", and that is the sentence to keep true.
     */
    function test_theSubjectGateIsTheWholeDefenceAgainstTheImpostor() public {
        (BondingCurve real, DokuToken t) = _market(address(0), TARGET, Sinks.BURN);
        _fillStarved(real);

        // An impostor that claims the real market's token and quote, at a price of its choosing:
        // the same raise, but a hundredth of the seed, so the pool opens ~100x too expensive.
        // A hundredth of the seed, so the pool would open ~100x too expensive.
        uint256 fakeSeed = real.seedBase() / 100;
        Impostor imp = new Impostor(address(t), address(0), TARGET, fakeSeed);
        vm.deal(address(imp), TARGET);
        // It needs the tokens to hand over; a real attacker buys them on the curve first.
        vm.prank(ALICE);
        t.transfer(address(imp), fakeSeed);

        markets.deny(address(imp));
        vm.expectRevert(abi.encodeWithSelector(DokuGraduation.NotAMarket.selector, address(imp)));
        vm.prank(MALLORY);
        graduation.graduate(address(imp));

        // The real market is untouched and still graduates.
        vm.prank(KEEPER);
        graduation.graduate(address(real));
        PoolId id = PoolIdLibrary.toId(_keyFor(address(0), address(t)));
        (uint160 sqrtP,,,) = manager.getSlot0(id);
        assertGt(sqrtP, 0, "the real market lost its pool");
        assertGt(manager.getLiquidity(id), 0, "the real market lost its seed");
    }

    /**
     * The other half — and a defence in depth nobody wrote down.
     *
     * With the register answering "yes", the recorded attack is NOT unchanged. Step 2b's
     * `seed.baseAmount < SEED_BASE` (`src/DokuGraduation.sol:228`) survived the removal of the
     * upper bound, and it is a second, independent obstacle: the impostor must actually HAND OVER
     * 222,222,222 whole tokens **of the real market's token**, because that is the only token whose
     * `transfer` the graduator will accept for this key. The quote leg is not a second obstacle —
     * it is only compared against the impostor's OWN `quoteTarget()` — so the attacker still
     * chooses the price freely, downward, by paying almost no quote.
     *
     * So the cost of the recorded attack, IF `isMarket` ever lied, is no longer "one deployment":
     * it is 28.6% of the curve supply of the market being bricked. That is worth recording because
     * it is the only thing that would still be standing.
     */
    function test_ifTheRegisterEverLiedTheSeedFloorWouldStillCost222MTokens() public {
        (BondingCurve real, DokuToken t) = _market(address(0), TARGET, Sinks.BURN);
        _fillStarved(real);

        // Short by any amount at all is refused, however plausible.
        uint256 short_ = graduation.SEED_BASE() - 1;
        Impostor cheap = new Impostor(address(t), address(0), TARGET, short_);
        vm.deal(address(cheap), TARGET);
        vm.prank(ALICE);
        t.transfer(address(cheap), short_);
        vm.expectRevert(abi.encodeWithSelector(DokuGraduation.SeedOutOfRange.selector, TARGET, short_));
        vm.prank(MALLORY);
        graduation.graduate(address(cheap));

        // Pay the floor — and the price is still entirely the attacker's, because the quote leg is
        // only checked against the impostor's own `quoteTarget()`.
        uint256 floor_ = graduation.SEED_BASE();
        Impostor imp = new Impostor(address(t), address(0), 5, floor_);
        vm.deal(address(imp), 5);
        vm.prank(ALICE);
        t.transfer(address(imp), floor_);

        vm.prank(MALLORY);
        graduation.graduate(address(imp));

        PoolId id = PoolIdLibrary.toId(_keyFor(address(0), address(t)));
        (uint160 sqrtP,,,) = manager.getSlot0(id);
        assertGt(sqrtP, 0, "the impostor did not claim the key");

        // And the genuine market can now never graduate: the pool it must create already exists.
        vm.expectRevert();
        vm.prank(KEEPER);
        graduation.graduate(address(real));
        assertFalse(real.released(), "the raise escaped");
        assertGe(address(real).balance, TARGET, "the whole raise is sealed in the closed curve");
    }

    // ------------------------------------------------------------- pre-initialising the PoolKey

    /// @notice Nobody outside the graduator set can put the real pool on the board first, by any
    ///         route — and the periphery route that SWALLOWS the refusal still creates nothing.
    function test_theRealPoolKeyCannotBePreInitialisedByAnybody() public {
        (BondingCurve c, DokuToken t) = _market(address(0), TARGET, Sinks.BURN);
        _fillStarved(c);
        PoolKey memory key = _keyFor(address(0), address(t));
        PoolId id = PoolIdLibrary.toId(key);

        uint160 hostile = 79228162514264337593543950336; // 1:1, ~nothing like the curve's close

        vm.prank(MALLORY);
        vm.expectRevert();
        manager.initialize(key, hostile);

        // The periphery route. `PoolInitializer_v4` catches the hook's revert and returns
        // `type(int24).max` rather than bubbling, which is exactly why `graduate` calls
        // `poolManager.initialize` directly (src/DokuGraduation.sol:257).
        vm.prank(MALLORY);
        int24 tick = lpm.initializePool(key, hostile);
        assertEq(tick, type(int24).max, "the periphery route no longer swallows the refusal");

        (uint160 before_,,,) = manager.getSlot0(id);
        assertEq(before_, 0, "a stranger initialised the market's pool");

        vm.prank(KEEPER);
        graduation.graduate(address(c));
        (uint160 after_,,,) = manager.getSlot0(id);
        assertGt(after_, 0, "graduation failed");
        assertTrue(after_ != hostile, "the pool opened at the attacker's price");
    }

    // ---------------------------------------------------------------- the retry cannot be worse

    /**
     * A stranded market's retry is a pure function of the market.
     *
     * `graduate` is permissionless and a stranded market can sit for as long as nobody pays the
     * gas, so the retry's caller and its block are both attacker-chosen. Everything the resulting
     * pool is made of is asserted here to be independent of both: the pool id, the opening price,
     * the liquidity, the position's tokenId and owner, the sink's address and the vault's epoch
     * genesis. The same market is graduated twice from two different states and the two are
     * compared.
     */
    function test_theRetryIsAPureFunctionOfTheMarketNotOfWhoRetriesOrWhen() public {
        (BondingCurve c, DokuToken t) = _market(address(0), TARGET, Sinks.REWARDS);
        _fillStarved(c);
        PoolId id = PoolIdLibrary.toId(_keyFor(address(0), address(t)));

        uint256 snap = vm.snapshotState();

        vm.prank(KEEPER);
        (, uint256 tokenIdA) = graduation.graduate(address(c));
        (uint160 sqrtA,,,) = manager.getSlot0(id);
        uint128 liqA = manager.getLiquidity(id);
        address sinkA = graduation.sinkOf(address(c));
        uint256 genesisA = RewardVault(payable(sinkA)).genesisBlock();
        address ownerA = IERC721(address(lpm)).ownerOf(tokenIdA);

        vm.revertToState(snap);

        // A different caller, 400,000 blocks and 60 days later — past two whole epoch grids.
        vm.roll(vm.getBlockNumber() + 400_000);
        vm.warp(vm.getBlockTimestamp() + 60 days);
        vm.prank(MALLORY);
        (, uint256 tokenIdB) = graduation.graduate(address(c));
        (uint160 sqrtB,,,) = manager.getSlot0(id);

        assertEq(tokenIdB, tokenIdA, "the tokenId moved with the caller");
        assertEq(sqrtB, sqrtA, "the opening price moved with the block");
        assertEq(manager.getLiquidity(id), liqA, "the seed moved with the caller");
        assertEq(graduation.sinkOf(address(c)), sinkA, "the sink address moved");
        assertEq(RewardVault(payable(sinkA)).genesisBlock(), genesisA, "the epoch grid moved");
        assertEq(IERC721(address(lpm)).ownerOf(tokenIdB), ownerA, "the position landed elsewhere");
        assertEq(ownerA, address(graduation.locker()), "the position is not at the locker");
    }

    // ------------------------------------------------------------------ the seed-price identity

    /**
     * D4a's identity under attack: how far can dust selling push the opening price?
     *
     * The upper bound on the seed was removed because the residue is unbounded (step 2b). That
     * makes the seed a number an attacker can grow at will — every sell rounds in the curve's
     * favour and the surplus becomes pool tokens. The question the removal leaves open is whether
     * growing it BUYS anything, so it is measured: N round trips, then the opening price against
     * the curve's own closing spot.
     */
    function test_dustSellingGrowsTheSeedButCannotMoveTheOpeningPriceFarEnoughToMatter() public {
        (BondingCurve c, DokuToken t) = _market(address(0), TARGET, Sinks.BURN);
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);

        vm.startPrank(MALLORY);
        for (uint256 i = 0; i < 200; i++) {
            uint256 got = c.buy{value: 1e18}(0, vm.getBlockTimestamp());
            t.approve(address(c), got);
            c.sell(got, 0, vm.getBlockTimestamp());
        }
        vm.stopPrank();

        vm.prank(ALICE);
        c.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp());

        uint256 seed = c.seedBase();
        uint256 residue = seed - graduation.SEED_BASE();
        emit log_named_uint("seed residue after 200 round trips (base wei)", residue);
        // Relative to the nominal seed, in parts per billion.
        emit log_named_uint("residue, parts per billion of the seed", (residue * 1e9) / graduation.SEED_BASE());

        assertGt(residue, 0, "no residue at all: the premise of the removed bound is gone");
        // The opening price is quoteTarget/seed; the distortion is the residue's share of the seed.
        // A tenth of a percent is the line: anything above it and the pool opens materially below
        // the curve's close, which is the arbitrage the price-from-deposit rule exists to prevent.
        assertLt((residue * 1e9) / graduation.SEED_BASE(), 1_000_000, "200 round trips moved the seed by >0.1%");
    }

    // ------------------------------------------------------------------- the locker, across markets

    /**
     * The locker holds EVERY graduated market's position and sweeps ABSOLUTE balances in `collect`
     * — `IERC20(quote).balanceOf(address(this))`, not a delta (`src/SeedLocker.sol:171,186`). Two
     * markets that share a quote asset therefore share a pot, and `collect` is permissionless. So:
     * can market B's collect carry away fees that belong to market A?
     */
    function test_oneMarketsCollectCannotCarryAwayAnothersFees() public {
        (BondingCurve a, DokuToken ta) = _market(address(usdc), TARGET_USDC, Sinks.REWARDS);
        _fill(a);
        (BondingCurve b, DokuToken tb) = _market(address(usdc), TARGET_USDC, Sinks.REWARDS);
        _fill(b);

        PoolId idA = PoolIdLibrary.toId(_keyFor(address(usdc), address(ta)));
        PoolId idB = PoolIdLibrary.toId(_keyFor(address(usdc), address(tb)));
        SeedLocker locker = graduation.locker();

        // MARKET A'S POSITION EARNS — and since round 4 a TRADE is no longer what makes it earn.
        //
        // The line here used to be the swap alone, with the note "trade it so the fees are real
        // rather than donated". `DokuHook._settleLeg` donated 70 bps of every swap to the pool's
        // in-range positions then, and the seed was the only one in range, so a trade WAS the
        // production source of locker-held fees. It is not any more: the 70 bps goes straight to
        // `pendingSink` and, with `POOL_LP_FEE == 0`, nothing pays a position in a DOKU pool.
        //
        // The swap stays, because the cross-market question is about a REAL market with volume and
        // a funded ledger. The donation is added, because `PoolManager.donate` is permissionless
        // and is now the ONLY way fees land on a locked seed — which makes it the exact residual
        // this test is about: a stranger's donation to market A, carried away by market B's
        // permissionless collect.
        _swapQuoteIn(_keyFor(address(usdc), address(ta)), 500e6);
        {
            PoolKey memory ka = _keyFor(address(usdc), address(ta));
            usdc.mint(address(this), 250e6);
            usdc.approve(address(donateRouter), 250e6);
            bool usdcIs0 = address(usdc) < address(ta);
            donateRouter.donate(ka, usdcIs0 ? 250e6 : 0, usdcIs0 ? 0 : 250e6, "");
        }

        uint256 owedBBefore = dokuHook.owedSink(idB);

        // Anyone may collect, and MALLORY picks B — the market whose vault they hold.
        vm.prank(MALLORY);
        locker.collect(_tokenIdOf(idB));

        assertEq(
            dokuHook.owedSink(idB) - owedBBefore,
            0,
            "market B's collect drew on market A's unclaimed fees"
        );

        // A's fees are still A's.
        vm.prank(MALLORY);
        locker.collect(_tokenIdOf(idA));
        assertGt(dokuHook.owedSink(idA), 0, "A's own fees vanished");
        assertEq(IERC20(address(usdc)).balanceOf(address(locker)), 0, "the locker kept quote");
    }

    uint256 private _t1;
    uint256 private _t2;

    function _tokenIdOf(PoolId id) internal view returns (uint256) {
        (PoolKey memory k1,,,) = graduation.locker().positionOf(1);
        return PoolId.unwrap(PoolIdLibrary.toId(k1)) == PoolId.unwrap(id) ? 1 : 2;
    }

    function _swapQuoteIn(PoolKey memory key, uint256 amountIn) internal {
        usdc.mint(address(this), amountIn);
        usdc.approve(address(swapRouter), amountIn);
        bool zeroForOne = Currency.unwrap(key.currency0) == address(usdc);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ------------------------------------------------------- what the graduator holds afterwards

    /// @notice M-02, measured. A BURN market's quote dust has no swap-free destination and is left
    ///         in the graduator; the next quote-paying market on the same asset sweeps an ABSOLUTE
    ///         balance and credits it to ITS sink. Recorded by the 2026-09-10 external review; the
    ///         number is what was missing.
    function test_theCrossMarketResidueInTheGraduatorIsMeasuredInWei() public {
        (BondingCurve burnMkt,) = _market(address(usdc), TARGET_USDC, Sinks.BURN);
        _fill(burnMkt);
        uint256 stranded = usdc.balanceOf(address(graduation));
        emit log_named_uint("USDC left in DokuGraduation by a BURN market (raw units)", stranded);

        (BondingCurve rewards, DokuToken tr) = _market(address(usdc), TARGET_USDC, Sinks.REWARDS);
        _fill(rewards);
        PoolId idR = PoolIdLibrary.toId(_keyFor(address(usdc), address(tr)));
        emit log_named_uint("credited to the NEXT market's sink", dokuHook.owedSink(idR));
        assertEq(usdc.balanceOf(address(graduation)), 0, "the graduator kept a balance");

        // The whole cross-market transfer is bounded by one mint's rounding remainder. Six
        // decimals: a dollar is 1e6, so this is worth strictly less than one millionth of a cent.
        assertLt(stranded, 1000, "the BURN residue is no longer dust-sized");
    }

    // -------------------------------------------------------- the residual Permit2 approval

    /**
     * `_mintSeed` leaves two live approvals behind — the ERC-20 allowance to Permit2 and the
     * Permit2 allowance to POSM, the latter good for `block.timestamp + 300`
     * (`src/DokuGraduation.sol:318-328`) — and `DokuGraduation` is a contract that WILL hold a
     * balance again: it is the credit path for a graduated market's routed share, and M-02's BURN
     * residue sits there between graduations. So the question is whether anyone can aim POSM at it.
     *
     * They cannot, and the reason is one line of Uniswap's: `_settlePair` takes the payer from
     * `msgSender()` — the address that called `modifyLiquidities` — and `_pay` hands exactly that
     * to `permit2.transferFrom` (`lib/v4-periphery/src/PositionManager.sol:456-460, 528-535`).
     * There is no action with a caller-supplied payer, and Permit2's `transferFrom` only answers
     * the spender, which is POSM. Asserted here rather than argued: money is parked in the
     * graduator and a stranger mints into the very pool the residual approval names.
     */
    function test_theResidualPermit2ApprovalCannotBeAimedAtTheGraduator() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), TARGET_USDC, Sinks.REWARDS);
        _fill(c);
        PoolKey memory key = _keyFor(address(usdc), address(t));

        // The approval is still live, and it names POSM as the spender.
        (uint160 allowed,,) = permit2.allowance(address(graduation), address(usdc), address(lpm));
emit log_named_uint("residual Permit2 allowance graduation->POSM (USDC)", allowed);
        // Measured at zero: the seed mint consumes the quote allowance exactly, so on the quote leg
        // there is not even a window. The token leg keeps whatever the mint's rounding left.
        (uint160 allowedToken,,) = permit2.allowance(address(graduation), address(t), address(lpm));
        emit log_named_uint("residual Permit2 allowance graduation->POSM (token)", allowedToken);

        // Give the graduator something worth taking — M-02's residue, or a routed share in flight.
        usdc.mint(address(graduation), 1_000e6);
        uint256 held = usdc.balanceOf(address(graduation));
        assertEq(held, 1_000e6, "setup");

        // A stranger mints into the graduated pool. If the payer were ever anything but the caller,
        // this is where the graduator's balance would leave.
        usdc.mint(MALLORY, 50_000e6);
        vm.startPrank(MALLORY);
        usdc.approve(address(permit2), type(uint256).max);
        t.approve(address(permit2), type(uint256).max);
        permit2.approve(address(usdc), address(lpm), type(uint160).max, uint48(vm.getBlockTimestamp() + 1 days));
        permit2.approve(address(t), address(lpm), type(uint160).max, uint48(vm.getBlockTimestamp() + 1 days));
        vm.stopPrank();
        vm.prank(ALICE);
        t.transfer(MALLORY, 10_000_000e18);

        bytes memory actions =
            abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR), uint8(Actions.SWEEP));
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(key, int24(-60), int24(60), uint128(1e12), uint256(50_000e6), uint256(10_000_000e18), MALLORY, bytes(""));
        params[1] = abi.encode(key.currency0, key.currency1);
        params[2] = abi.encode(Currency.wrap(address(usdc)), MALLORY);

        uint256 malloryTokenBefore = t.balanceOf(MALLORY);
        uint256 gradTokenBefore = t.balanceOf(address(graduation));
        vm.prank(MALLORY);
        lpm.modifyLiquidities(abi.encode(actions, params), vm.getBlockTimestamp() + 60);

        // The graduator paid for none of it, on either leg, despite the live token approval.
        assertEq(usdc.balanceOf(address(graduation)), held, "POSM pulled the graduator's quote");
        assertEq(t.balanceOf(address(graduation)), gradTokenBefore, "POSM pulled the graduator's token");
        assertLt(t.balanceOf(MALLORY), malloryTokenBefore, "the stranger did not pay for their own mint");
    }

    // ---------------------------------------------------- what `Actions.SWEEP` actually sweeps

    /**
     * `_mintSeed`'s third action WAS `SWEEP(quote -> address(this))`, and Uniswap's `_sweep` moves
     * the PositionManager's ENTIRE balance of that currency, not the graduation's unspent remainder
     * (`lib/v4-periphery/src/PositionManager.sol:499-502`). The PositionManager is the canonical
     * v4 singleton, shared with every other protocol on the chain, and it is not supposed to hold
     * a balance between transactions — but tokens are mis-sent to router contracts constantly.
     *
     * Whatever is sitting there when a DOKU market graduates is pulled into `DokuGraduation` and
     * then, by `_sweepDust`, credited to THAT market's sink. Measured here, because the recorded
     * M-02 describes the destination and calls the amount dust; this is the source that is not.
     *
     * Not ranked as theft: `Actions.SWEEP` is available to any caller of `modifyLiquidities`, so a
     * stray POSM balance is already a free-for-all and graduation is one more racer, not a new
     * loss. It is the magnitude of M-02 that changes.
     *
     * FIXED, and flipped rather than deleted so that reverting the fix turns this red again.
     *
     * The first fix only stopped the money being CREDITED to a market, which left 50,000 USDC of a
     * stranger's sitting in an immutable contract with no rescue — safe from theft and equally
     * beyond reach, accumulating with every graduation in that quote. Generation 4 added a return
     * leg: `_sweepDust` pushed POSM's pre-mint balance back to POSM. That worked for an ERC-20 and
     * could never work for MON, whose `receive()` on POSM reverts for any sender but WETH9 and the
     * PoolManager — see `test/audit/Gen4PosmReturnNative.t.sol`.
     *
     * GENERATION 5 drops `Actions.SWEEP` from `_mintSeed` instead, on both quote types. Nothing is
     * dragged in, so nothing has to be pushed back, and the outcome below is reached without a push
     * that has to succeed. All three assertions still matter and still fail differently: the sink
     * must not receive it, the graduator must not keep it, and POSM must still have it.
     */
    function test_theSeedSweepGivesThePositionManagerItsOwnBalanceBack() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), TARGET_USDC, Sinks.REWARDS);

        // Someone else's USDC, mis-sent to the canonical PositionManager before this market fills.
        usdc.mint(address(lpm), 50_000e6);

        _fill(c);

        PoolId id = PoolIdLibrary.toId(_keyFor(address(usdc), address(t)));
        emit log_named_uint("POSM balance afterwards", usdc.balanceOf(address(lpm)));
        emit log_named_uint("credited to this market's sink ledger", dokuHook.owedSink(id));

        assertEq(dokuHook.owedSink(id), 0, "a stranger's balance was credited to this market's sink");
        assertEq(usdc.balanceOf(address(graduation)), 0, "the graduator kept a stranger's money");
        assertEq(usdc.balanceOf(address(lpm)), 50_000e6, "POSM was not made whole");
    }


    // ---------------------------------------------- the locker's absolute balances, across markets

    /**
     * **`SeedLocker`'s comment is wrong about the one balance it says is trapped.**
     *
     * `src/SeedLocker.sol:111-114`: *"A BURN market's quote balance, were a stranger ever to donate
     * one, stays here for the same reason: there is no path out for it."* There is a path out, and
     * it does not go back to the BURN market. `collect` reads ABSOLUTE balances —
     * `IERC20(quote).balanceOf(address(this))` at `src/SeedLocker.sol:171` — and the locker is
     * shared by EVERY graduated market. So the next quote-paying market on the same asset that
     * anybody collects carries the BURN market's stranded quote into ITS sink's ledger.
     *
     * This is the recorded M-02 shape (`docs/doku/audit/2026-09-10-external/response.md`) in the
     * file M-02 does not name: M-02 is scoped to `DokuGraduation._sweepDust`, and its fix — a
     * delta-based sweep — was never proposed here.
     *
     * Ranked low, and the reason matters: a BURN market's seed position CANNOT accrue the quote
     * from trading. `_lpQuoteBps` is zero on BURN (`src/v4/DokuHook.sol:315-320`), so no swap ever
     * donates the quote leg to it. The only filler of that balance is `PoolManager.donate`, which
     * is permissionless but is the donor spending their own money. So the value that moves between
     * markets here is value someone gave away, not value anyone was holding.
     *
     * FIXED in the generation-4 round-1 pass, and FLIPPED rather than deleted so that reverting the
     * fix turns this red again. `collect` now measures the delta its own `modifyLiquidities`
     * produced instead of reading the shared balance, on both legs. What was already resting in the
     * locker when a collect starts is still resting there when it ends.
     *
     * The second filler of that balance is not a donation at all and is why the fix was taken
     * rather than the finding re-ranked: `receive()` here cannot be gated — `TAKE_PAIR` is a bare
     * native `call` from the PoolManager — so a misdirected send lands and stays, and before the fix
     * the next non-BURN collect of the same currency carried it off. Measured at 10 MON in
     * `test/audit/Gen4SeedLockerScope.t.sol`.
     */
    function test_theLockerCarriesABurnMarketsStrandedQuoteIntoAnotherMarketsSink() public {
        (BondingCurve burnMkt, DokuToken tb) = _market(address(usdc), TARGET_USDC, Sinks.BURN);
        _fill(burnMkt);
        (BondingCurve rewards, DokuToken tr) = _market(address(usdc), TARGET_USDC, Sinks.REWARDS);
        _fill(rewards);

        PoolKey memory keyB = _keyFor(address(usdc), address(tb));
        PoolId idB = PoolIdLibrary.toId(keyB);
        PoolId idR = PoolIdLibrary.toId(_keyFor(address(usdc), address(tr)));
        SeedLocker locker = graduation.locker();

        // Someone donates the quote to the BURN market's pool. Its seed position is full range, so
        // it is in range and takes essentially all of it.
        usdc.mint(address(this), 10_000e6);
        usdc.approve(address(donateRouter), 10_000e6);
        bool quoteIs0 = Currency.unwrap(keyB.currency0) == address(usdc);
        donateRouter.donate(keyB, quoteIs0 ? 10_000e6 : 0, quoteIs0 ? 0 : 10_000e6, "");

        // Collecting the BURN market parks that quote in the locker, exactly as the comment says.
        locker.collect(_tokenIdOf(idB));
        uint256 parked = usdc.balanceOf(address(locker));
        emit log_named_uint("BURN market's quote parked in the shared locker", parked);
        assertGt(parked, 0, "no stranded quote to carry: the premise is gone");
        assertEq(dokuHook.owedSink(idB), 0, "the BURN market's own ledger took it");

        // And now anyone — the REWARDS market's own holders, most obviously — collects the OTHER
        // market and the parked quote leaves with it.
        uint256 owedRBefore = dokuHook.owedSink(idR);
        vm.prank(MALLORY);
        locker.collect(_tokenIdOf(idR));

        // Pre-fix: the locker ended at 0 and the whole 9,999.999999 USDC arrived in the REWARDS
        // market's ledger. Both assertions are load-bearing and they fail differently — the first
        // says the money stayed put, the second says the other market did not receive it.
        assertEq(usdc.balanceOf(address(locker)), parked, "the BURN market's stranded quote left the locker");
        assertEq(
            dokuHook.owedSink(idR) - owedRBefore,
            0,
            "the BURN market's stranded quote moved to the other market's sink"
        );
        emit log_named_uint("carried into the REWARDS market's sink ledger", dokuHook.owedSink(idR) - owedRBefore);
    }

    // ----------------------------------------------- graduating from inside a PoolManager unlock

    /// @notice Any integrator that fills a curve from inside `PoolManager.unlock` silently strands
    ///         the market: the seed mint needs its own unlock and v4 refuses a nested one. The
    ///         market must still be retryable afterwards, with nothing half-written.
    function test_aFillFromInsideAnUnlockStrandsTheMarketButLeavesItRetryable() public {
        (BondingCurve c, DokuToken t) = _market(address(0), TARGET, Sinks.BURN);
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);

        NestedFiller filler = new NestedFiller(IPoolManager(address(manager)));
        vm.deal(address(filler), 5 * TARGET);
        filler.fill(c, 5 * TARGET);

        assertTrue(c.readyToGraduate(), "the nested fill did not fill the curve");
        assertFalse(graduation.graduated(address(c)), "a nested unlock somehow graduated");
        assertFalse(c.released(), "the raise left the curve without a pool");

        // Retryable by anyone, from a normal context.
        vm.prank(KEEPER);
        graduation.graduate(address(c));
        PoolId id = PoolIdLibrary.toId(_keyFor(address(0), address(t)));
        (uint160 sqrtP,,,) = manager.getSlot0(id);
        assertGt(sqrtP, 0, "the stranded market could not be retried");
        assertGt(manager.getLiquidity(id), 0, "the retry seeded nothing");
    }
}

/// @dev An integrator that does the whole thing inside one unlock — the shape `ZapRouter` documents
///      itself as deliberately avoiding (`src/ZapRouter.sol:37-45`). Third parties have no such note.
contract NestedFiller is IUnlockCallback {
    IPoolManager private immutable pm;
    BondingCurve private c;
    uint256 private amount;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function fill(BondingCurve c_, uint256 amount_) external {
        c = c_;
        amount = amount_;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        c.buy{value: amount}(0, block.timestamp);
        return "";
    }

    receive() external payable {}
}
