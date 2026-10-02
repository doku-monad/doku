// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {PositionConfig} from "@uniswap/v4-periphery/test/shared/PositionConfig.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {console2} from "forge-std/Test.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";
import {Sinks} from "../../src/lib/Sinks.sol";

// Imported ONLY so forge compiles their artifacts: v4-periphery's test `Deploy` library builds them
// through `vm.getCode(...)`, which resolves against the build OUTPUT rather than the source tree, so
// a contract nothing here imports is never compiled and `setUp` fails on "no matching artifact
// found". Same note as `GraduationV4.t.sol` and `SeedLocker.t.sol`.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract R4Tok is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 1e33);
    }
}

/**
 * # Round 4 — the swap levy's 70 bps reaches the SINK, and no position can reach it
 *
 * ## The change this proves
 *
 * Round 3 (docs/doku/audit/gen4/README.md §Round 3) measured `_settleLeg`'s `poolManager.donate`
 * paying 70 bps of the WHOLE swap to whatever liquidity happened to be in range at the POST-swap
 * tick — pro rata to liquidity, never pro rata to service. Against a pool that also carries the
 * full-range graduation seed, a narrow band anchored at a trade's END tick therefore collected a
 * large share for absorbing the last step of a journey the seed carried: 23 of 48 configurations
 * profitable, best ROI 8,111 bps, 83% of a donation taken by 0.027% of the pool. The money came out
 * of the market's SINK, whose only post-graduation income the donation was.
 *
 * The protocol owner took option 2: the 70 bps is no longer donated. `_settleLeg` books it straight
 * to `pendingSink[id]`, in `sinkCurrency(id)`, which is the leg it was levied on by construction.
 *
 * ## Why a NEW file, and what "paired" means here
 *
 * `Round3Jit.t.sol` is the inverted attack — the same bundles, now asserting a capture of exactly
 * zero. That proves the money is not stealable. It does not prove the money ARRIVES: a hook that
 * dropped the 70 bps on the floor, or minted it and booked it to the treasury, would pass every
 * assertion in that file. This is the other half of the pair, and it asserts the arithmetic:
 *
 *   (a) for each of the three sink kinds, over swaps in BOTH directions, the sink's ledger grows by
 *       exactly 70 bps of the levied leg and the treasury's by exactly 30 — computed from a base
 *       this fixture names rather than from one it reads back out of the hook;
 *   (b) an external narrow band sitting exactly on the trade's end tick collects nothing at all;
 *   (c) the hook's ledger partition — `manager.balanceOf(hook, C) == Σ books denominated in C`,
 *       per currency — survives the whole sequence, so the new `pendingSink` credit is backed by a
 *       claim rather than conjured;
 *   (d) `SeedLocker.collect` on the real, locked seed position returns cleanly with nothing to
 *       forward, which is the operational consequence of (b) applied to the seed itself.
 *
 * ## Making the base KNOWN, which is the whole trick of (a)
 *
 * `_beforeSwap` levies the SPECIFIED leg off `amountSpecified` — the caller's own number — while
 * `_afterSwap` levies the unspecified leg off a pool delta this test would have to re-derive. So
 * every swap below is shaped so that the leg under test is the SPECIFIED one:
 *
 *     quote as EXACT INPUT   -> specified is the quote   (buy)
 *     quote as EXACT OUTPUT  -> specified is the quote   (sell)
 *     token as EXACT INPUT   -> specified is the token   (sell)
 *     token as EXACT OUTPUT  -> specified is the token   (buy)
 *
 * and that holds on either orientation of the key, because `_isQuote` reads the market's recorded
 * `quoteIsCurrency0` rather than the index. Both rows of each pair are exercised, so "both
 * directions" is literal: one buy and one sell per assertion, not one swap run twice.
 */
contract Round4SinkShareTest is PosmTestSetup {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5EE);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    int24 internal constant SPACING = 60;
    /// @dev Full range on spacing 60, which is the shape `DokuGraduation._seed` mints.
    int24 internal SEED_LO;
    int24 internal SEED_HI;
    /// @dev Large enough that the swaps below move the price by a few ticks rather than by a
    ///      percent — the point of this file is the arithmetic of the split, not price impact.
    uint128 internal constant SEED_LIQ = 2_000_000e18;

    uint16 internal constant PROT_BPS = 30;
    uint16 internal constant SINK_SHARE_BPS = 70;

    DokuHook internal dokuHook;
    SeedLocker internal locker;
    R4Tok internal quote;

    struct M {
        PoolKey key;
        PoolId id;
        R4Tok tok;
        uint8 sink;
        address sinkAddr;
        uint16 tax;
        bool quoteIsC0;
        uint256 seedTokenId;
    }

    M internal rewards;
    M internal creator;
    M internal burnMkt;

    // No `receive()`: `Deployers` declares a non-virtual one.

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        dokuHook.setGraduator(address(this), true);
        locker = new SeedLocker(IPositionManager(address(lpm)), address(dokuHook), address(manager));

        SEED_LO = TickMath.minUsableTick(SPACING);
        SEED_HI = TickMath.maxUsableTick(SPACING);

        quote = new R4Tok("Q");
        quote.approve(address(swapRouter), type(uint256).max);
        quote.approve(address(modifyLiquidityRouter), type(uint256).max);
        approvePosmCurrency(Currency.wrap(address(quote)));

        // Both orientations, so no assertion below can be an accident of where one token landed.
        rewards = _open(Sinks.REWARDS, address(0x5100), 0, true);
        creator = _open(Sinks.CREATOR, CREATOR_SINK, 500, false);
        burnMkt = _open(Sinks.BURN, address(0x5102), 0, true);
    }

    /// @dev Built the way `DokuGraduation` builds one, because the seed waiver is not decoration:
    ///      without it the seed's own add pays the maker levy and every ledger figure below starts
    ///      from a number this test would have to model. `register -> beginSeed -> mint -> endSeed`
    ///      is production's order, and the position is minted to the real `SeedLocker` so part (d)
    ///      has something real to collect from.
    function _open(uint8 sink, address sinkAddr, uint16 tax, bool quoteIsC0) internal returns (M memory m) {
        m.sink = sink;
        m.sinkAddr = sinkAddr;
        m.tax = tax;
        m.quoteIsC0 = quoteIsC0;
        m.tok = _tokenSorting(quoteIsC0);

        m.key = PoolKey({
            currency0: Currency.wrap(quoteIsC0 ? address(quote) : address(m.tok)),
            currency1: Currency.wrap(quoteIsC0 ? address(m.tok) : address(quote)),
            fee: 0,
            tickSpacing: SPACING,
            hooks: IHooks(address(dokuHook))
        });
        m.id = m.key.toId();

        manager.initialize(m.key, SQRT_1_1);
        dokuHook.registerPool(m.key, address(m.tok), sink, sinkAddr, tax);

        m.tok.approve(address(swapRouter), type(uint256).max);
        m.tok.approve(address(modifyLiquidityRouter), type(uint256).max);
        approvePosmCurrency(Currency.wrap(address(m.tok)));

        PositionConfig memory cfg = PositionConfig({poolKey: m.key, tickLower: SEED_LO, tickUpper: SEED_HI});
        m.seedTokenId = lpm.nextTokenId();
        dokuHook.beginSeed(m.id, SEED_LIQ, SEED_LO, SEED_HI);
        mint(cfg, SEED_LIQ, address(locker), "");
        dokuHook.endSeed(m.id);
        locker.lock(m.seedTokenId, m.key, sinkAddr, sink, quoteIsC0);
    }

    /// @dev Deploy until a token lands on the requested side of the quote. Copied in spirit from
    ///      `SeedLocker.t.sol`: computing the orientation from wherever a token happened to land is
    ///      a property of the deployment nonces, not of the test.
    function _tokenSorting(bool quoteFirst) internal returns (R4Tok t) {
        for (uint256 i; i < 128; ++i) {
            t = new R4Tok("T");
            if ((address(quote) < address(t)) == quoteFirst) return t;
        }
        revert("no deployment nonce puts a token on the requested side of the quote");
    }

    // ------------------------------------------------------------------------------ books

    struct Books {
        uint256 claimsQ;
        uint256 claimsT;
        uint256 prot;
        uint256 protTok;
        uint256 sink;
        uint256 tax;
    }

    function _books(M memory m) internal view returns (Books memory b) {
        b.claimsQ = manager.balanceOf(address(dokuHook), Currency.wrap(address(quote)).toId());
        b.claimsT = manager.balanceOf(address(dokuHook), Currency.wrap(address(m.tok)).toId());
        b.prot = dokuHook.pendingProtocol(m.id);
        b.protTok = dokuHook.pendingProtocolToken(m.id);
        b.sink = dokuHook.pendingSink(m.id);
        b.tax = dokuHook.owedTax(m.id);
    }

    // ------------------------------------------------------------------------------ swaps

    /// @dev One swap, named by which currency is SPECIFIED and whether that currency is the input.
    ///      `exactInput` decides the sign of `amountSpecified`; `specIsQuote` decides the direction,
    ///      because the specified currency is the quote exactly when the quote is the one being
    ///      named — which on an exact input means the quote goes IN and on an exact output means it
    ///      comes OUT.
    function _swapSpecifying(M memory m, bool specIsQuote, bool exactInput, uint256 base) internal {
        // Which currency is entering the pool? The specified one on an exact input, the other on an
        // exact output.
        bool quoteIsInput = specIsQuote == exactInput;
        bool zeroForOne = quoteIsInput == m.quoteIsC0;
        swapRouter.swap(
            m.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: exactInput ? -int256(base) : int256(base),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ------------------------------------------------------- (a) the split, to the unit

    /// @notice REWARDS: the sink is paid in the QUOTE, so the quote leg carries the whole 100 bps
    ///         and the token leg carries nothing. Four swaps, two in each direction.
    function test_a_rewardsSinkTakesSeventyBpsOfEverySwapAndTheTreasuryThirty() public {
        _assertQuoteLegSplit(rewards, "REWARDS");
    }

    /// @notice CREATOR: the same currency and the same 70/30, with a 500 bps creator tax riding on
    ///         top of the levy — which must come out of the TAX line and dilute neither the sink
    ///         nor the treasury. This is the case `_settleLeg` sizes `taxCut` off the ORIGINAL levy
    ///         for, and the reverse orientation (`quoteIsCurrency0 == false`) is the case that
    ///         catches a rate keyed on the index instead of on the market.
    function test_a_creatorSinkTakesSeventyBpsWithTheTaxOnTop() public {
        _assertQuoteLegSplit(creator, "CREATOR");
    }

    /// @dev What one quote-specified swap must do to the four books, and the expectation it is
    ///      measured against — computed from `base`, which is this test's own number, never read
    ///      back out of the contract under test.
    struct Split {
        uint256 levy;
        uint256 sink;
        uint256 tax;
        uint256 prot;
    }

    /// @dev ONE SWAP, IN ITS OWN FRAME. Extracted from the loop below rather than inlined, and not
    ///      for tidiness: with the four accumulators, the two `Books` snapshots and a `string.concat`
    ///      per assertion all live at once, the loop body is `Yul exception: ... too deep in the
    ///      stack by 2 slots`. The same pressure is why the failure messages here are literals
    ///      instead of tagged with the market — the failing TEST name says which sink it was.
    function _oneQuoteSwap(M memory m, bool exactIn, uint256 base) internal returns (Split memory e) {
        uint256 total = uint256(PROT_BPS) + SINK_SHARE_BPS + m.tax;
        Books memory b0 = _books(m);
        _swapSpecifying(m, true, exactIn, base);
        Books memory b1 = _books(m);

        e.levy = (base * total) / 10_000;
        e.sink = (e.levy * SINK_SHARE_BPS) / total;
        e.tax = m.tax == 0 ? 0 : (e.levy * m.tax) / total;
        e.prot = e.levy - e.sink - e.tax;

        assertEq(b1.claimsQ - b0.claimsQ, e.levy, "the quote leg's levy is not the rate");
        assertEq(b1.claimsT, b0.claimsT, "the token leg was levied on a quote-paying sink");
        assertEq(b1.sink - b0.sink, e.sink, "the sink's 70 bps is wrong");
        assertEq(b1.tax - b0.tax, e.tax, "the creator's cut is wrong");
        assertEq(b1.prot - b0.prot, e.prot, "the treasury's 30 bps is wrong");
        assertEq(b1.protTok, b0.protTok, "the token maker bucket moved on a swap");
    }

    /// @dev The shared body for the two quote-paying sinks. Every swap names the QUOTE, so the base
    ///      is this function's own number and nothing is read back out of the contract under test.
    ///
    ///      The materialised books are read as DELTAS because this body is called more than once in
    ///      `test_c_...` and `owedTreasury` is keyed by CURRENCY across every market sharing it.
    function _assertQuoteLegSplit(M memory m, string memory tag) internal {
        uint256 owedSink0 = dokuHook.owedSink(m.id);
        uint256 owedTreasury0 = dokuHook.owedTreasury(Currency.wrap(address(quote)));

        uint256[4] memory bases = [uint256(500e18), 1_200e18, 30e18, 777e18];
        // buy, sell, buy, sell -- alternating, so the price walks both ways across the seed.
        bool[4] memory exactIn = [true, false, true, false];

        Split memory sum;
        for (uint256 i; i < bases.length; ++i) {
            Split memory e = _oneQuoteSwap(m, exactIn[i], bases[i]);
            sum.levy += e.levy;
            sum.sink += e.sink;
            sum.tax += e.tax;
            sum.prot += e.prot;
        }

        console2.log(tag);
        console2.log("  levied in total :", sum.levy);
        console2.log("  to the sink     :", sum.sink);
        console2.log("  to the treasury :", sum.prot);
        console2.log("  to the creator  :", sum.tax);
        assertEq(sum.sink + sum.prot + sum.tax, sum.levy, "the three books do not sum to the levy");

        // 70/30 of the levy net of the tax, to within the two truncations. Stated as a bound rather
        // than an equality because `sink` and `tax` each round down independently and the dust falls
        // into `prot` -- the pre-existing rounding convention, unchanged by this change, and
        // `_settleLeg`'s docblock says so.
        uint256 netLevy = sum.levy - sum.tax;
        assertLe(sum.sink, (netLevy * 70) / 100, "the sink was over-paid");
        assertGe(sum.sink + 16, (netLevy * 70) / 100, "the sink was under-paid by more than dust");

        // And the sweep materialises exactly what accrued.
        dokuHook.sweep(m.id);
        assertEq(dokuHook.pendingSink(m.id), 0, "sweep left the sink's pending book");
        assertEq(dokuHook.owedSink(m.id) - owedSink0, sum.sink, "owedSink is not what accrued");
        assertEq(
            dokuHook.owedTreasury(Currency.wrap(address(quote))) - owedTreasury0,
            sum.prot,
            "owedTreasury is not what accrued"
        );
    }

    /// @notice BURN: the sink destroys the TOKEN, so its 70 bps is levied on the token leg and the
    ///         quote leg is the treasury's 30 alone. Both halves are asserted against a base this
    ///         test names, which needs two families of swap rather than one — the token is the
    ///         specified leg in the first, the quote in the second.
    ///
    /// @dev Split across three frames for the same stack reason as `_oneQuoteSwap`; the two
    ///      families are two helpers, and this body only sums what they return.
    function test_a_burnSinkTakesSeventyBpsOfTheTokenLegAndTheTreasuryThirtyOfTheQuote() public {
        M memory m = burnMkt;
        uint256 sumSink;
        uint256 sumProt;

        // Family one: the TOKEN is specified, so the SINK's leg has a base this test named. The
        // quote leg of the same swap is levied too, off a pool delta, and is asserted as a claim
        // identity inside the helper rather than predicted.
        sumSink += _burnTokenSpecified(m, true, 400e18);
        sumSink += _burnTokenSpecified(m, false, 900e18);

        // Family two: the QUOTE is specified, so the TREASURY's leg has a base this test named.
        (uint256 p1, uint256 s1) = _burnQuoteSpecified(m, true, 600e18);
        (uint256 p2, uint256 s2) = _burnQuoteSpecified(m, false, 250e18);
        sumProt += p1 + p2;
        sumSink += s1 + s2;

        console2.log("BURN");
        console2.log("  to the sink (token) :", sumSink);
        console2.log("  to the treasury (q) :", sumProt);
        assertGt(sumSink, 0, "the sink took nothing");

        dokuHook.sweep(m.id);
        assertEq(dokuHook.owedSink(m.id), sumSink, "owedSink is not what accrued");
        assertEq(dokuHook.pendingSink(m.id), 0, "sweep left the sink's pending book");
        assertEq(
            ERC20(address(m.tok)).balanceOf(address(dokuHook)),
            sumSink + dokuHook.owedTreasury(Currency.wrap(address(m.tok))),
            "the hook's real token balance does not back what it owes"
        );
    }

    /// @dev A swap naming the TOKEN. `_tokenBps` and `_lpTokenBps` are both 70 on a BURN market, so
    ///      every unit of this leg is the sink's — asserted as an equality against a base this
    ///      caller chose, which is the "exactly 70 bps of the levied leg" claim in its strongest
    ///      form. Returns what the sink took.
    function _burnTokenSpecified(M memory m, bool exactIn, uint256 base) internal returns (uint256 expSink) {
        Books memory b0 = _books(m);
        _swapSpecifying(m, false, exactIn, base);
        Books memory b1 = _books(m);

        expSink = (base * SINK_SHARE_BPS) / 10_000;
        assertEq(b1.claimsT - b0.claimsT, expSink, "the token leg's levy is not 70 bps");
        assertEq(b1.sink - b0.sink, expSink, "the sink did not take the whole token leg");
        assertEq(b1.protTok, b0.protTok, "a swap fed the token MAKER bucket");
        // The quote leg is the treasury's, whole: `_lpQuoteBps` is zero on a BURN market.
        assertEq(b1.prot - b0.prot, b1.claimsQ - b0.claimsQ, "the quote leg is not all the treasury's");
        assertEq(b1.tax, b0.tax, "an untaxed market accrued a creator cut");
    }

    /// @dev A swap naming the QUOTE. 30 bps and nothing else — a BURN market's quote leg carries no
    ///      sink share at all. Returns (what the treasury took, what the sink took on the other leg).
    function _burnQuoteSpecified(M memory m, bool exactIn, uint256 base)
        internal
        returns (uint256 expProt, uint256 sinkDelta)
    {
        Books memory b0 = _books(m);
        _swapSpecifying(m, true, exactIn, base);
        Books memory b1 = _books(m);

        expProt = (base * PROT_BPS) / 10_000;
        assertEq(b1.claimsQ - b0.claimsQ, expProt, "the quote leg's levy is not 30 bps");
        assertEq(b1.prot - b0.prot, expProt, "the treasury did not take the whole quote leg");
        sinkDelta = b1.sink - b0.sink;
        // The token leg of the same swap is the sink's, whole.
        assertEq(sinkDelta, b1.claimsT - b0.claimsT, "the token leg is not all the sink's");
    }

    // ------------------------------------------- (b) the band at the end tick gets nothing

    /// @notice An external LP parked exactly on the tick the trade ends at collects NOTHING — and
    ///         pays 60 bps of its capital for the privilege.
    ///
    /// @dev This is `Round3Jit.t.sol`'s attack reduced to its essential claim and re-run on the
    ///      real graduation fixture (a locker-held full-range seed minted through POSM), so the two
    ///      files are not proving the same thing about the same harness. The band is sized at 5% of
    ///      the seed and anchored at the unperturbed end tick — the configuration that returned ROI
    ///      1,107 bps under the donating hook.
    ///
    ///      `inRange` is asserted. A band that missed would make the zero-collect vacuous, and the
    ///      point is that the attack EXECUTES and finds nothing.
    function test_b_anExternalBandAtTheEndTickCollectsNothing() public {
        M memory m = rewards;
        uint256 victim = 200_000e18;
        bytes32 bandSalt = bytes32(uint256(0xB4D));

        int24 lo = _floorSpacing(_unperturbedEndTick(m, victim));
        int24 hi = lo + 120;

        _band(m, lo, hi, int256(uint256(SEED_LIQ) / 20), bandSalt);

        uint256 sinkBefore = dokuHook.pendingSink(m.id);
        _swapSpecifying(m, true, true, victim);
        uint256 sinkAfter = dokuHook.pendingSink(m.id);

        {
            int24 endTick = _tick(m.id);
            assertTrue(endTick >= lo && endTick < hi, "the band missed: this proof requires it to be in range");
        }

        BalanceDelta collected = _band(m, lo, hi, 0, bandSalt);
        console2.log("band collect delta0       :", int256(collected.amount0()));
        console2.log("band collect delta1       :", int256(collected.amount1()));
        console2.log("sink credited by the swap :", sinkAfter - sinkBefore);

        assertEq(collected.amount0(), 0, "the band collected currency0");
        assertEq(collected.amount1(), 0, "the band collected currency1");
        // ... and the money it used to take went where it was always supposed to.
        assertEq(sinkAfter - sinkBefore, (victim * 70) / 10_000, "the sink was not credited the whole 70 bps");
    }

    /// @dev Where does this trade end with no band present? Simulate, then rewind — the band has to
    ///      be anchored at the tick the victim would reach on their own, which is the anchoring
    ///      round 3 found profitable and round 0's harness did not test.
    function _unperturbedEndTick(M memory m, uint256 victim) internal returns (int24 t) {
        uint256 snap = vm.snapshotState();
        _swapSpecifying(m, true, true, victim);
        t = _tick(m.id);
        vm.revertToState(snap);
    }

    function _band(M memory m, int24 lo, int24 hi, int256 delta, bytes32 salt) internal returns (BalanceDelta) {
        return modifyLiquidityRouter.modifyLiquidity(
            m.key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: delta, salt: salt}), ""
        );
    }

    function _tick(PoolId id) internal view returns (int24 t) {
        (, t,,) = StateLibrary.getSlot0(IPoolManager(address(manager)), id);
    }

    function _floorSpacing(int24 t) internal pure returns (int24) {
        int24 f = (t / SPACING) * SPACING;
        if (t < 0 && f != t) f -= SPACING;
        return f;
    }

    // ------------------------------------------------ (c) the partition, per currency

    /// @notice The hook's core invariant, over the whole fixture, after everything above has run in
    ///         one sequence: per currency, the hook's ERC-6909 claims equal the sum of the books
    ///         denominated in it, and its real balance equals the sum of the materialised ones.
    ///
    /// @dev The new `pendingSink` credit is the reason this is re-asserted here rather than left to
    ///      `Round3Ledger.t.sol`. Under the donating hook the 70 bps was SPENT, and `_settleLeg`
    ///      minted claims only for the remainder; now the full `amount` is minted and one more book
    ///      shares the currency. A version of the change that booked the sink's share without
    ///      minting for it would balance every per-swap assertion in part (a) and fail here.
    function test_c_theLedgerPartitionSurvivesTheWholeSequence() public {
        _partition("start");

        _assertQuoteLegSplit(rewards, "REWARDS");
        _partition("after rewards");
        _assertQuoteLegSplit(creator, "CREATOR");
        _partition("after creator");

        // A maker round trip on each, so the levy path and the maker path share the books.
        for (uint256 i; i < 3; ++i) {
            M memory m = i == 0 ? rewards : (i == 1 ? creator : burnMkt);
            modifyLiquidityRouter.modifyLiquidity(
                m.key,
                ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500e18, salt: 0}),
                ""
            );
            _swapSpecifying(m, true, true, 100e18);
            modifyLiquidityRouter.modifyLiquidity(
                m.key,
                ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -500e18, salt: 0}),
                ""
            );
            _partition("after a maker round trip");
        }

        dokuHook.sweep(burnMkt.id);
        _partition("after sweep");

        vm.prank(rewards.sinkAddr);
        dokuHook.pullSink(rewards.id);
        vm.prank(CREATOR_SINK);
        dokuHook.pullSink(creator.id);
        vm.prank(burnMkt.sinkAddr);
        dokuHook.pullSink(burnMkt.id);
        _partition("after pullSink");

        vm.prank(CREATOR_SINK);
        dokuHook.pullTax(creator.id);
        _partition("after pullTax");

        dokuHook.pullTreasury(Currency.wrap(address(quote)));
        dokuHook.pullTreasury(Currency.wrap(address(rewards.tok)));
        dokuHook.pullTreasury(Currency.wrap(address(creator.tok)));
        dokuHook.pullTreasury(Currency.wrap(address(burnMkt.tok)));
        _partition("after pullTreasury");
    }

    function _partition(string memory where) internal view {
        Currency[4] memory cs = [
            Currency.wrap(address(quote)),
            Currency.wrap(address(rewards.tok)),
            Currency.wrap(address(creator.tok)),
            Currency.wrap(address(burnMkt.tok))
        ];
        for (uint256 i; i < cs.length; ++i) {
            assertEq(
                manager.balanceOf(address(dokuHook), cs[i].toId()),
                _claimBooks(cs[i]),
                string.concat("claims != books @ ", where)
            );
            assertEq(
                ERC20(Currency.unwrap(cs[i])).balanceOf(address(dokuHook)),
                _realBooks(cs[i]),
                string.concat("real != owed @ ", where)
            );
        }
    }

    function _claimBooks(Currency c) internal view returns (uint256 s) {
        for (uint256 i; i < 3; ++i) {
            M memory m = i == 0 ? rewards : (i == 1 ? creator : burnMkt);
            if (Currency.unwrap(c) == address(quote)) {
                s += dokuHook.pendingProtocol(m.id) + dokuHook.owedTax(m.id);
            }
            if (Currency.unwrap(c) == Currency.unwrap(_sinkCurrency(m))) {
                s += dokuHook.pendingSink(m.id);
            }
            if (Currency.unwrap(c) == address(m.tok)) {
                s += dokuHook.pendingProtocolToken(m.id);
            }
        }
    }

    function _realBooks(Currency c) internal view returns (uint256 s) {
        s = dokuHook.owedTreasury(c);
        for (uint256 i; i < 3; ++i) {
            M memory m = i == 0 ? rewards : (i == 1 ? creator : burnMkt);
            if (Currency.unwrap(c) == Currency.unwrap(_sinkCurrency(m))) s += dokuHook.owedSink(m.id);
        }
    }

    function _sinkCurrency(M memory m) internal view returns (Currency) {
        return m.sink == Sinks.BURN ? Currency.wrap(address(m.tok)) : Currency.wrap(address(quote));
    }

    // ------------------------------------------------- (d) the locker, with nothing to collect

    /// @notice `SeedLocker.collect` still works when the seed has earned nothing — which, after
    ///         this change, is always.
    ///
    /// @dev The operational half of the decision, and the one most likely to be discovered in
    ///      production rather than here. The locker's whole reason for existing was that
    ///      `LP_LEVY_BPS` donated to in-range positions and the seed was one of them, so fees at a
    ///      dead address would have been unreachable forever. That income now arrives at the sink
    ///      through the hook's ledger instead, and the locker's collect finds an empty position on
    ///      every call.
    ///
    ///      It must therefore not revert, not forward, and not credit — for every sink kind, and
    ///      with swaps having happened, which is the case where a reader's intuition says there
    ///      ought to be fees. `collect` is permissionless, so "reverts when there is nothing" would
    ///      be a permanent nuisance rather than a safety property, and a locker that credited a
    ///      zero would put a `CurveTaxCredited(0)` in every indexer.
    function test_d_seedLockerCollectReturnsZeroAndDoesNotRevert() public {
        // Trade on all three first, so the pool has seen real volume before the collect.
        _assertQuoteLegSplit(rewards, "REWARDS");
        _swapSpecifying(burnMkt, false, true, 400e18);
        _swapSpecifying(creator, true, true, 500e18);

        for (uint256 i; i < 3; ++i) {
            M memory m = i == 0 ? rewards : (i == 1 ? creator : burnMkt);
            uint256 owedBefore = dokuHook.owedSink(m.id);
            uint256 sinkTokBefore = m.tok.balanceOf(m.sinkAddr);
            uint256 lockQBefore = quote.balanceOf(address(locker));
            uint256 lockTBefore = m.tok.balanceOf(address(locker));

            locker.collect(m.seedTokenId); // must not revert

            assertEq(dokuHook.owedSink(m.id), owedBefore, "collect credited a market that earned nothing");
            assertEq(m.tok.balanceOf(m.sinkAddr), sinkTokBefore, "collect forwarded token that was never earned");
            assertEq(quote.balanceOf(address(locker)), lockQBefore, "the locker's quote balance moved");
            assertEq(m.tok.balanceOf(address(locker)), lockTBefore, "the locker's token balance moved");
        }

        // Twice in a row, because a permissionless no-op is called by keepers that do not check.
        locker.collect(rewards.seedTokenId);
        locker.collect(rewards.seedTokenId);
    }
}
