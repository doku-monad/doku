// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {Sinks} from "../../src/lib/Sinks.sol";

/// @dev Planted at chosen addresses with `deployCodeTo`, because the ONLY thing under test here
///      is which side of the key the quote sorts to, and a `new` lands wherever the nonce says.
contract LegToken is ERC20 {
    constructor() ERC20("Leg", "LEG") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice The levy keyed on "quote leg" and "token leg" rather than on the currency index.
/// @dev Gen-1 hard-required `currency0 == address(0)`. A market whose quote is an ERC-20 sorts
///      that quote to whichever side its address falls on, so every rate, every accrual and every
///      sweep has to read `quoteIsCurrency0` instead of assuming index 0. Both orderings are driven
///      through the same assertions here; native MON is the third case and keeps sorting to 0.
contract HookQuoteLegTest is Test {
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    // Two orderings, forced by address. Low quote → quote is currency0; high quote → currency1.
    address internal constant QUOTE_LO = address(0x1000);
    address internal constant TOKEN_HI = address(0xfFFf00000000000000000000000000000000FfFF);
    address internal constant TOKEN_LO = address(0x2000);
    address internal constant QUOTE_HI = address(0xEeEe00000000000000000000000000000000eeEE);

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;

    address internal graduator = address(0x6AD);
    address internal sinkAddr = address(0x51);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        deployCodeTo("HookQuoteLeg.t.sol:LegToken", "", QUOTE_LO);
        deployCodeTo("HookQuoteLeg.t.sol:LegToken", "", TOKEN_HI);
        deployCodeTo("HookQuoteLeg.t.sol:LegToken", "", TOKEN_LO);
        deployCodeTo("HookQuoteLeg.t.sol:LegToken", "", QUOTE_HI);
        address[4] memory all = [QUOTE_LO, TOKEN_HI, TOKEN_LO, QUOTE_HI];
        for (uint256 i; i < all.length; ++i) {
            ERC20(all[i]).approve(address(lp), type(uint256).max);
            ERC20(all[i]).approve(address(swapper), type(uint256).max);
        }
        vm.deal(address(this), 100_000 ether);
    }

    // ---------------------------------------------------------------------------------- helpers

    function _key(address quote, address token) internal view returns (PoolKey memory k) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        k = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function _open(address quote, address token, uint8 sink, uint16 tax) internal returns (PoolKey memory k) {
        k = _key(quote, token);
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, token, sink, sinkAddr, tax);
        vm.stopPrank();
        uint256 val = quote == address(0) ? 1_000 ether : 0;
        lp.modifyLiquidity{value: val}(
            k, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}), ""
        );
    }

    function _quoteIs0(PoolKey memory k) internal view returns (bool q) {
        q = hook.markets(PoolIdLibrary.toId(k)).quoteIsCurrency0;
    }

    /// @dev `quoteIn` true is a BUY (quote in, token out); false is a SELL. Direction is derived
    ///      from which side the quote sits on, which is the whole point of the file.
    function _swap(PoolKey memory k, bool quoteIn, int256 amountSpecified) internal returns (BalanceDelta) {
        bool zeroForOne = quoteIn == _quoteIs0(k);
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        bool nativeIn = Currency.unwrap(k.currency0) == address(0) && zeroForOne;
        uint256 val = nativeIn ? (amountSpecified < 0 ? uint256(-amountSpecified) : 20 ether) : 0;
        return swapper.swap{value: val}(
            k,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _claims(address c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), Currency.wrap(c).toId());
    }

    // ------------------------------------------------------------------------------ registration

    function test_registerRecordsWhichSideIsTheQuote() public {
        PoolKey memory lo = _open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 0);
        PoolKey memory hi = _open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 0);
        assertTrue(_quoteIs0(lo), "a low quote address must be currency0");
        assertFalse(_quoteIs0(hi), "a high quote address must be currency1");
        assertEq(Currency.unwrap(hook.quoteOf(PoolIdLibrary.toId(lo))), QUOTE_LO, "quoteOf (lo)");
        assertEq(Currency.unwrap(hook.quoteOf(PoolIdLibrary.toId(hi))), QUOTE_HI, "quoteOf (hi)");
        assertEq(hook.tokenOf(PoolIdLibrary.toId(hi)), TOKEN_LO, "tokenOf (hi)");
    }

    function test_nativeQuoteStillSortsToCurrencyZero() public {
        PoolKey memory k = _open(address(0), TOKEN_HI, Sinks.BURN, 0);
        assertTrue(_quoteIs0(k), "native MON is address(0) and therefore always currency0");
        assertTrue(hook.quoteOf(PoolIdLibrary.toId(k)).isAddressZero(), "quoteOf native");
    }

    function test_registerRejectsAKeyThatDoesNotContainTheToken() public {
        PoolKey memory k = _key(QUOTE_LO, TOKEN_HI);
        vm.prank(graduator);
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(k, TOKEN_LO, Sinks.BURN, sinkAddr, 0);
    }

    function test_registerRejectsAnUnsortedKey() public {
        PoolKey memory k = _key(QUOTE_LO, TOKEN_HI);
        (k.currency0, k.currency1) = (k.currency1, k.currency0);
        vm.prank(graduator);
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(k, TOKEN_HI, Sinks.BURN, sinkAddr, 0);
    }

    function test_theRegisteredEventCarriesTheGenerationTwoTerms() public {
        PoolKey memory k = _key(QUOTE_LO, TOKEN_HI);
        vm.prank(graduator);
        manager.initialize(k, SQRT_1_1);
        vm.expectEmit(true, false, false, true, address(hook));
        emit DokuHook.PoolRegistered(
            PoolIdLibrary.toId(k), TOKEN_HI, Sinks.REWARDS, sinkAddr, hook.PROTOCOL_LEVY_BPS(), hook.LP_LEVY_BPS(), 0
        );
        vm.prank(graduator);
        hook.registerPool(k, TOKEN_HI, Sinks.REWARDS, sinkAddr, 0);
    }

    // ---------------------------------------------------------------------------------- the levy

    /// @dev The table from `HookLevy.t.sol`, run on the ordering gen-1 could not express. A REWARDS
    ///      market must hold ONLY its quote on every shape whichever index the quote sits at.
    function test_theLevyFollowsTheQuoteLegOnBothOrderings() public {
        PoolKey[2] memory keys =
            [_open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 0), _open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 0)];
        address[2] memory quotes = [QUOTE_LO, QUOTE_HI];
        address[2] memory tokens = [TOKEN_HI, TOKEN_LO];
        for (uint256 i; i < 2; ++i) {
            PoolId id = PoolIdLibrary.toId(keys[i]);
            uint256 q0 = _claims(quotes[i]);
            // Delta, not absolute: since generation 4 the maker levy is symmetric, so `_open`'s own
            // LP add has already put token claims here. The property is that a SWAP adds none.
            uint256 t0 = _claims(tokens[i]);
            uint256 p0 = hook.pendingProtocol(id);
            _swap(keys[i], true, -1 ether); // exact-in buy
            _swap(keys[i], false, -1 ether); // exact-in sell
            _swap(keys[i], true, 1 ether); // exact-out buy
            _swap(keys[i], false, 1 ether); // exact-out sell
            assertGt(_claims(quotes[i]), q0, "no quote was levied");
            assertEq(_claims(tokens[i]), t0, "the token leg was levied on a REWARDS market");
            assertGt(hook.pendingProtocol(id) - p0, 0, "the treasury accrued nothing");
        }
    }

    /// @dev A BURN market levies the token leg for its SINK, and the treasury is still paid in the
    ///      quote — never in the token.
    ///
    ///      INVERTED BY ROUND 4, and the old name is worth keeping in view:
    ///      `test_aBurnMarketsTokenLegIsDonatedOnEitherOrdering`, whose body asserted
    ///      `_claims(TOKEN_LO) == t0` — the hook kept NOTHING of the token leg because it spent all
    ///      of it back into the pool through `poolManager.donate`. That donate is gone (see
    ///      `Round3Jit.t.sol` for why), so the whole token leg is now minted as claims and booked to
    ///      `pendingSink`, which is the ledger a BURN sink pulls from.
    ///
    ///      Asserted as an EQUALITY between the two, not as two independent "greater than zero"s: on
    ///      a BURN market `_tokenBps` and `_lpTokenBps` are the same 70, so every unit of the token
    ///      leg is the sink's and a single unit landing anywhere else is a defect.
    function test_aBurnMarketsTokenLegGoesToItsSinkOnEitherOrdering() public {
        PoolKey memory hi = _open(QUOTE_HI, TOKEN_LO, Sinks.BURN, 0);
        PoolId id = PoolIdLibrary.toId(hi);
        uint256 t0 = _claims(TOKEN_LO);
        uint256 p0 = hook.pendingProtocol(id);
        uint256 s0 = hook.pendingSink(id);
        _swap(hi, true, -1 ether);
        assertGt(hook.pendingProtocol(id) - p0, 0, "treasury unpaid");
        assertGt(_claims(TOKEN_LO) - t0, 0, "the token leg was not levied at all");
        assertEq(
            hook.pendingSink(id) - s0,
            _claims(TOKEN_LO) - t0,
            "the token leg went somewhere other than the sink"
        );
    }

    // --------------------------------------------------------------------------------- the sweep

    function test_sweepMaterialisesTheTreasuryInTheMarketsQuote() public {
        PoolKey memory hi = _open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 0);
        PoolId id = PoolIdLibrary.toId(hi);
        _swap(hi, true, -10 ether);
        uint256 prot = hook.pendingProtocol(id);
        assertGt(prot, 0);
        hook.sweep(id);
        assertEq(hook.owedTreasury(Currency.wrap(QUOTE_HI)), prot, "treasury not owed in the quote");
        assertEq(hook.owedTreasury(Currency.wrap(address(0))), 0, "treasury owed in MON on a USDC-style market");
        uint256 before = ERC20(QUOTE_HI).balanceOf(TREASURY);
        hook.pullTreasury(Currency.wrap(QUOTE_HI));
        assertEq(ERC20(QUOTE_HI).balanceOf(TREASURY) - before, prot, "pullTreasury paid the wrong amount");
    }

    function test_sinkCurrencyIsTheQuoteForRewardsAndTheTokenForBurn() public {
        PoolKey memory r = _open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 0);
        PoolKey memory b = _open(QUOTE_LO, TOKEN_HI, Sinks.BURN, 0);
        assertEq(Currency.unwrap(hook.sinkCurrency(PoolIdLibrary.toId(r))), QUOTE_HI);
        assertEq(Currency.unwrap(hook.sinkCurrency(PoolIdLibrary.toId(b))), TOKEN_HI);
    }

    /// @dev The seed shape now arrives with `beginSeed`, because `registerPool` no longer carries
    ///      it. The waiver is still graduator-only, still one-shot, still bound to the exact shape.
    function test_beginSeedRecordsTheShapeItWaives() public {
        PoolKey memory k = _open(QUOTE_LO, TOKEN_HI, Sinks.BURN, 0);
        PoolId id = PoolIdLibrary.toId(k);
        vm.prank(graduator);
        hook.beginSeed(id, 123e18, -600, 600);
        DokuHook.Market memory m = hook.markets(id);
        assertEq(m.seedLiquidity, 123e18);
        assertEq(m.seedTickLower, -600);
        assertEq(m.seedTickUpper, 600);
        vm.prank(graduator);
        hook.endSeed(id);
    }

    // ------------------------------------------------------------------------------- constants

    /// @dev §2 of the spec, one table for curve and pool: 30 to the treasury, 70 to the market's
    ///      SINK (the constant is still called `LP_LEVY_BPS`, which is ABI and is explained in its
    ///      own docblock), up to 1,000 to the creator. Asserted as literals on purpose — this is the
    ///      independent side, and the RATES did not move in round 4. Only the destination did.
    function test_theShippedRatesAreThirtySeventyAndTheCeilingIsElevenHundred() public view {
        assertEq(hook.PROTOCOL_LEVY_BPS(), 30, "protocol share");
        assertEq(hook.LP_LEVY_BPS(), 70, "LP share");
        assertEq(hook.SINK_LEVY_BPS(), 0, "sink share from swaps stays zero");
        assertEq(hook.MAX_LEVY_BPS(), 1100, "100 bps levy plus a 1,000 bps creator tax");
        assertEq(
            uint256(hook.PROTOCOL_LEVY_BPS()) + hook.LP_LEVY_BPS() + hook.SINK_LEVY_BPS() + 1000,
            hook.MAX_LEVY_BPS(),
            "the ceiling is exactly the maximum a market can be registered at"
        );
    }

    function test_registerAcceptsATaxAtTheCeilingAndRejectsOneAbove() public {
        PoolKey memory k = _key(QUOTE_LO, TOKEN_HI);
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        vm.expectRevert(DokuHook.InvalidBps.selector);
        hook.registerPool(k, TOKEN_HI, Sinks.REWARDS, sinkAddr, 1010);
        hook.registerPool(k, TOKEN_HI, Sinks.REWARDS, sinkAddr, 1000);
        vm.stopPrank();
        assertEq(hook.markets(PoolIdLibrary.toId(k)).creatorTaxBps, 1000, "the ceiling tax did not register");
    }

    // ------------------------------------------------------------------------------ creator tax

    /// @dev The tax rides the quote leg of every SWAP shape and never the token leg. Exact where
    ///      the quote is the specified amount (the input of an exact-in buy, the output of an
    ///      exact-out sell); merely positive where the pool computes it.
    function test_theCreatorTaxIsLeviedOnTheQuoteLegOfEverySwapShape() public {
        PoolKey memory k = _open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 500);
        PoolId id = PoolIdLibrary.toId(k);

        uint256 t0 = hook.owedTax(id);
        uint256 p0 = hook.pendingProtocol(id);
        _swap(k, true, -10 ether); // exact-in buy: 10 quote in
        assertEq(hook.owedTax(id) - t0, (10 ether * 500) / 10_000, "exact-in buy: tax is 5% of the quote in");
        assertEq(hook.pendingProtocol(id) - p0, (10 ether * 30) / 10_000, "exact-in buy: treasury still gets 30 bps");

        t0 = hook.owedTax(id);
        _swap(k, false, -1 ether); // exact-in sell: quote is the computed output
        assertGt(hook.owedTax(id) - t0, 0, "exact-in sell: no tax on the quote out");

        t0 = hook.owedTax(id);
        _swap(k, true, 1 ether); // exact-out buy: quote is the computed input
        assertGt(hook.owedTax(id) - t0, 0, "exact-out buy: no tax on the quote in");

        t0 = hook.owedTax(id);
        _swap(k, false, 1 ether); // exact-out sell: 1 quote out, specified
        assertEq(hook.owedTax(id) - t0, (1 ether * 500) / 10_000, "exact-out sell: tax is 5% of the quote out");
    }

    function test_theCreatorTaxIsNeverLeviedOnTheTokenLeg() public {
        PoolKey memory r = _open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 1000);
        PoolKey memory b = _open(QUOTE_HI, TOKEN_LO, Sinks.BURN, 1000);
        uint256 bTok = _claims(TOKEN_LO);
        uint256 rTok = _claims(TOKEN_HI);
        uint256 bSink = hook.pendingSink(PoolIdLibrary.toId(b));
        PoolKey[2] memory keys = [r, b];
        for (uint256 i; i < 2; ++i) {
            _swap(keys[i], true, -1 ether);
            _swap(keys[i], false, -1 ether);
            _swap(keys[i], true, 1 ether);
            _swap(keys[i], false, 1 ether);
        }
        assertEq(_claims(TOKEN_HI), rTok, "a REWARDS market's token leg was levied");
        // A BURN market's token leg IS levied — 70 bps, all of it the sink's since round 4 — so the
        // claim this test makes about it has to be stated against `pendingSink` rather than against
        // the hook keeping nothing. If any part of the token leg were the creator's, these two
        // numbers would differ by exactly that part.
        PoolId bid = PoolIdLibrary.toId(b);
        assertEq(
            _claims(TOKEN_LO) - bTok,
            hook.pendingSink(bid) - bSink,
            "part of a BURN market's token leg was not the sink's"
        );
        assertGt(hook.owedTax(bid), 0, "a BURN market's creator tax was not levied on the quote leg");
    }

    function test_makersNeverPayTheCreatorTax() public {
        PoolKey memory k = _open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 500);
        PoolId id = PoolIdLibrary.toId(k);
        uint256 t0 = hook.owedTax(id);
        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100 ether, salt: bytes32(uint256(3))}),
            ""
        );
        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -100 ether, salt: bytes32(uint256(3))}),
            ""
        );
        assertEq(hook.owedTax(id), t0, "liquidity add/remove was charged the creator tax");
    }

    function test_taxLeviedFiresWithTheExactAmount() public {
        PoolKey memory k = _open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 500);
        vm.expectEmit(true, false, false, true, address(hook));
        emit DokuHook.TaxLevied(PoolIdLibrary.toId(k), (10 ether * 500) / 10_000);
        _swap(k, true, -10 ether);
    }

    // ------------------------------------------------------------------------------ the ceiling

    /// @dev `_beforeSwap`'s natspec: "A POSITIVE specified delta is correct in both directions.
    ///      `Hooks` applies `amountToSwap += hookDeltaSpecified` and reverts only if the sign
    ///      flips ... At `bps <= MAX_LEVY_BPS` the sign can never flip, which is what makes the
    ///      ceiling load-bearing at registration." Re-proved here at 1,100 bps, on all four shapes,
    ///      on both orderings: exact-input `-N + ⌊0.11N⌋ < 0`, exact-output `M + ⌊0.11M⌋ > 0`.
    ///      The assertion is the trader-facing one — they still pay or receive EXACTLY what they
    ///      specified — because that is the property a sign flip would break.
    function test_atTheCeilingTheTraderStillPaysOrReceivesExactlyWhatTheySpecified() public {
        PoolKey[2] memory keys =
            [_open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 1000), _open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 1000)];
        for (uint256 i; i < 2; ++i) {
            bool q0 = _quoteIs0(keys[i]);
            BalanceDelta a = _swap(keys[i], true, -1 ether); // exact-in buy: quote is the specified INPUT
            assertEq(q0 ? a.amount0() : a.amount1(), -1 ether, "exact-in buy: the quote in moved");
            BalanceDelta b = _swap(keys[i], false, -1 ether); // exact-in sell: token is the specified INPUT
            assertEq(q0 ? b.amount1() : b.amount0(), -1 ether, "exact-in sell: the token in moved");
            BalanceDelta c = _swap(keys[i], true, 1 ether); // exact-out buy: token is the specified OUTPUT
            assertEq(q0 ? c.amount1() : c.amount0(), 1 ether, "exact-out buy: the token out moved");
            BalanceDelta d = _swap(keys[i], false, 1 ether); // exact-out sell: quote is the specified OUTPUT
            assertEq(q0 ? d.amount0() : d.amount1(), 1 ether, "exact-out sell: the quote out moved");
        }
    }

    function test_atTheCeilingTheWholeElevenPercentIsAccountedFor() public {
        PoolKey memory k = _open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 1000);
        PoolId id = PoolIdLibrary.toId(k);
        uint256 t0 = hook.owedTax(id);
        uint256 p0 = hook.pendingProtocol(id);
        uint256 s0 = hook.pendingSink(id);
        uint256 q0 = _claims(QUOTE_LO);
        _swap(k, true, -100 ether);
        assertEq(hook.owedTax(id) - t0, 10 ether, "tax at the ceiling is 10% of the quote in");
        assertEq(hook.pendingProtocol(id) - p0, 0.3 ether, "protocol share at the ceiling");
        assertEq(hook.pendingSink(id) - s0, 0.7 ether, "the sink's share at the ceiling");
        // The hook keeps ALL of it as claims now: 10 tax + 0.3 treasury + 0.7 sink. Until round 4
        // this line read `10.3 ether`, because the 0.7 was spent back into the pool by
        // `poolManager.donate` and only the remainder was minted. Nothing leaves the hook inside a
        // swap any more, so the whole eleven percent must be here — and the three books below it
        // must account for every unit of it, which is what makes this a conservation check rather
        // than three separate rate checks.
        assertEq(_claims(QUOTE_LO) - q0, 11 ether, "claims != tax + protocol + sink");
        assertEq(
            (hook.owedTax(id) - t0) + (hook.pendingProtocol(id) - p0) + (hook.pendingSink(id) - s0),
            _claims(QUOTE_LO) - q0,
            "a minted claim belongs to no book"
        );
    }

    // ------------------------------------------------------------------------------ maker levy

    /// @dev THE LIVE DEFECT. Both gen-1 hooks record `makerBps0/1 = 25/0` at `registerPool` and
    ///      charge `_bps0/_bps1` in `_makerLevy` — 100 bps on a REWARDS quote leg, 75 on a BURN
    ///      token leg. Here the recorded rate IS the charged rate, asserted to the wei on add and on
    ///      remove, on both orderings and both sinks, in markets carrying a creator tax so a tax
    ///      leaking into the maker path would show as a mismatch.
    function test_theRecordedMakerRateIsTheChargedMakerRate() public {
        _assertRecordedMakerRateIsCharged(_open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 500));
        _assertRecordedMakerRateIsCharged(_open(QUOTE_HI, TOKEN_LO, Sinks.BURN, 500));
    }

    /// @dev Split out of the test body and again per leg because the whole assertion in one frame
    ///      is `Stack too deep`, and `via_ir` is not available anywhere in this tree.
    function _assertRecordedMakerRateIsCharged(PoolKey memory k) internal {
        PoolId id = PoolIdLibrary.toId(k);
        DokuHook.Market memory rec = hook.markets(id);
        bool q = _quoteIs0(k);
        assertEq(q ? rec.makerBps0 : rec.makerBps1, hook.PROTOCOL_LEVY_BPS(), "the quote-leg maker rate is the protocol share");
        // Generation 4: symmetric. A zero token-side rate was a free entry for a JIT range order —
        // see `registerPool` and `test/audit/HookJitDonateFork.t.sol`.
        assertEq(
            q ? rec.makerBps1 : rec.makerBps0,
            hook.PROTOCOL_LEVY_BPS(),
            "the token-leg maker rate is not the protocol share"
        );

        uint256 tax0 = hook.owedTax(id);
        _assertMakerLegCharged(k, rec, int256(100 ether), true);
        assertEq(hook.owedTax(id), tax0, "add: the maker paid the creator tax");
        _assertMakerLegCharged(k, rec, -int256(100 ether), false);
        assertEq(hook.owedTax(id), tax0, "remove: the maker paid the creator tax");
    }

    /// @dev On ADD the returned delta is negative and already net of the hook's cut, so
    ///      principal = |delta| - levy. On REMOVE it is positive and net, so principal = delta + levy.
    function _assertMakerLegCharged(PoolKey memory k, DokuHook.Market memory rec, int256 liquidity, bool isAdd)
        internal
    {
        uint256 h0 = _claims(Currency.unwrap(k.currency0));
        uint256 h1 = _claims(Currency.unwrap(k.currency1));
        BalanceDelta d = lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: liquidity, salt: bytes32(uint256(7))}),
            ""
        );
        h0 = _claims(Currency.unwrap(k.currency0)) - h0;
        h1 = _claims(Currency.unwrap(k.currency1)) - h1;
        {
            uint256 p0 = isAdd ? uint256(uint128(-d.amount0())) - h0 : uint256(uint128(d.amount0())) + h0;
            assertEq(h0, (p0 * rec.makerBps0) / 10_000, "currency0 charged != recorded");
        }
        {
            uint256 p1 = isAdd ? uint256(uint128(-d.amount1())) - h1 : uint256(uint128(d.amount1())) + h1;
            assertEq(h1, (p1 * rec.makerBps1) / 10_000, "currency1 charged != recorded");
        }
    }

    /// @dev THE SWAP FUNDS A BURN SINK; THE MAKER STILL DOES NOT. Both halves are the point, and
    ///      the first half is what round 4 changed.
    ///
    ///      This test used to be `test_theHookFundsNoBurnSink` and asserted `pendingSink == 0`
    ///      after both a swap and a maker round trip, because the swap's token leg was donated whole
    ///      to the pool's LPs and the recorded maker rate on that leg was zero. Two of those three
    ///      premises have since moved: generation 4 made the maker rate symmetric (30 bps on the
    ///      token leg) and round 4 stopped donating. So the swap half is inverted here and the maker
    ///      half is not — and it is NOT inverted for a reason worth stating, because a reader who
    ///      knows the token leg is now levied twice will expect both to land in the same place.
    ///
    ///      They do not. `_accrueMaker` routes the token-leg MAKER levy to `pendingProtocolToken`,
    ///      a separate bucket that sweeps into `owedTreasury[token]`, precisely so a maker's money
    ///      never reaches a sink's ledger. A maker levy filling `pendingSink` would be the B4
    ///      defect back — recorded rates and charged rates disagreeing about who is being paid —
    ///      not a feature, and this is the test that says so.
    function test_aBurnSinkIsFundedByTheSwapLevyAndNeverByTheMakerLevy() public {
        PoolKey memory k = _open(QUOTE_HI, TOKEN_LO, Sinks.BURN, 500);
        PoolId id = PoolIdLibrary.toId(k);

        _swap(k, true, -10 ether);
        _swap(k, false, -1 ether);
        uint256 fromSwaps = hook.pendingSink(id);
        assertGt(fromSwaps, 0, "a swap did not fund a BURN market's sink");

        uint256 protTok = hook.pendingProtocolToken(id);
        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100 ether, salt: bytes32(uint256(11))}),
            ""
        );
        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -100 ether, salt: bytes32(uint256(11))}),
            ""
        );
        assertEq(hook.pendingSink(id), fromSwaps, "a maker add or remove funded a BURN market's sink");
        assertGt(hook.pendingProtocolToken(id) - protTok, 0, "the token-leg maker levy went missing entirely");
        assertGt(hook.pendingProtocol(id), 0, "nothing was levied at all, so this proves nothing");
    }

    // -------------------------------------------------------------------------- CREATOR routing

    function test_aCreatorMarketIsLeviedExactlyLikeARewardsMarket() public {
        PoolKey memory k = _open(QUOTE_HI, TOKEN_LO, Sinks.CREATOR, 300);
        PoolId id = PoolIdLibrary.toId(k);
        assertEq(hook.SINK_CREATOR(), Sinks.CREATOR);
        assertEq(Currency.unwrap(hook.sinkCurrency(id)), QUOTE_HI, "a CREATOR market's sink is paid in the quote");
        uint256 t0 = _claims(TOKEN_LO); // the maker levy on `_open`'s add; the swaps must add none
        _swap(k, true, -1 ether);
        _swap(k, false, -1 ether);
        _swap(k, true, 1 ether);
        _swap(k, false, 1 ether);
        assertEq(_claims(TOKEN_LO), t0, "a CREATOR market levied the token leg");
        assertGt(hook.pendingProtocol(id), 0, "treasury unpaid");
        assertGt(hook.owedTax(id), 0, "tax unpaid");
    }

    function test_creditCurveTaxAcceptsEveryQuotePayingSinkAndRefusesBurn() public {
        PoolId r = PoolIdLibrary.toId(_open(address(0), TOKEN_HI, Sinks.REWARDS, 0));
        PoolId c = PoolIdLibrary.toId(_open(address(0), TOKEN_LO, Sinks.CREATOR, 0));
        PoolId b = PoolIdLibrary.toId(_open(address(0), QUOTE_HI, Sinks.BURN, 0)); // any token will do
        hook.creditCurveTax{value: 1 ether}(r);
        hook.creditCurveTax{value: 2 ether}(c);
        assertEq(hook.owedSink(r), 1 ether);
        assertEq(hook.owedSink(c), 2 ether);
        vm.expectRevert(DokuHook.WrongSinkCurrency.selector);
        hook.creditCurveTax{value: 1 ether}(b);
    }

    /// @dev An ERC-20 quote cannot ride `msg.value`, so it is pulled with `safeTransferFrom`
    ///      through the two-argument form — same ledger, same predicate, same event.
    function test_creditCurveTaxPullsAnErc20QuoteAndRefusesTheWrongForm() public {
        PoolId usd = PoolIdLibrary.toId(_open(QUOTE_HI, TOKEN_LO, Sinks.REWARDS, 0));
        PoolId nat = PoolIdLibrary.toId(_open(address(0), TOKEN_HI, Sinks.REWARDS, 0));

        ERC20(QUOTE_HI).approve(address(hook), 5 ether);
        uint256 before = ERC20(QUOTE_HI).balanceOf(address(hook));
        vm.expectEmit(true, false, false, true, address(hook));
        emit DokuHook.CurveTaxCredited(usd, 5 ether);
        hook.creditCurveTax(usd, 5 ether);
        assertEq(hook.owedSink(usd), 5 ether);
        assertEq(ERC20(QUOTE_HI).balanceOf(address(hook)) - before, 5 ether, "the quote was not pulled");

        vm.expectRevert(DokuHook.WrongSinkCurrency.selector);
        hook.creditCurveTax{value: 1 ether}(usd); // native form on an ERC-20 market
        vm.expectRevert(DokuHook.WrongSinkCurrency.selector);
        hook.creditCurveTax(nat, 1 ether); // ERC-20 form on a native market
    }

    // ---------------------------------------------------------------------------------- pullTax

    function test_onlyTheCreatorSinkCanPullTheTax() public {
        PoolId id = PoolIdLibrary.toId(_open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 500));
        vm.prank(sinkAddr); // the market's OWN sink is not the tax puller
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullTax(id);
        vm.prank(address(0x5747A6E));
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullTax(id);
    }

    function test_pullTaxMaterialisesTheTaxAndPaysTheCreatorSink() public {
        PoolKey memory k = _open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 500);
        PoolId id = PoolIdLibrary.toId(k);
        // What `_open`'s own liquidity add already owes the treasury, before any swap: the maker
        // levy is the protocol share (B4), and it is not the tax's and not this test's subject.
        uint256 maker = hook.pendingProtocol(id);
        _swap(k, true, -10 ether);
        uint256 owed = hook.owedTax(id);
        assertEq(owed, 0.5 ether);
        uint256 claimsBefore = _claims(QUOTE_LO);

        vm.prank(CREATOR_SINK);
        uint256 got = hook.pullTax(id);

        assertEq(got, owed);
        assertEq(hook.owedTax(id), 0, "the tax ledger was not cleared");
        assertEq(ERC20(QUOTE_LO).balanceOf(CREATOR_SINK), owed, "the creator sink was not paid");
        assertEq(claimsBefore - _claims(QUOTE_LO), owed, "the claims were not burned for the tax");
        // Sweep is untouched by the tax: the treasury's claims are still there to materialise.
        assertGt(hook.pendingProtocol(id), 0);
        hook.sweep(id);
        assertEq(hook.owedTreasury(Currency.wrap(QUOTE_LO)), maker + (10 ether * 30) / 10_000);
    }

    function test_pullTaxPaysNativeQuoteToo() public {
        PoolKey memory k = _open(address(0), TOKEN_HI, Sinks.CREATOR, 1000);
        PoolId id = PoolIdLibrary.toId(k);
        _swap(k, true, -1 ether);
        uint256 before = CREATOR_SINK.balance;
        vm.prank(CREATOR_SINK);
        uint256 got = hook.pullTax(id);
        assertEq(got, 0.1 ether);
        assertEq(CREATOR_SINK.balance - before, got);
    }

    function test_pullTaxWithNothingOwedReturnsZero() public {
        PoolId id = PoolIdLibrary.toId(_open(QUOTE_LO, TOKEN_HI, Sinks.REWARDS, 0));
        vm.prank(CREATOR_SINK);
        assertEq(hook.pullTax(id), 0);
    }

    /// @dev `CreatorSink.pull(market)` asks for the routed share and the tax in one call, on every
    ///      market it was registered for. On a market whose routed share goes elsewhere (a HOLDERS
    ///      market's vault, a BUYBACK market's burn sink) the answer to the FIRST question is zero,
    ///      not a revert — otherwise the tax behind it would be unreachable. The market's own sink
    ///      still gets its money; nobody else does.
    function test_theCreatorSinkGetsZeroNotARevertFromAForeignMarketsPullSink() public {
        PoolId id = PoolIdLibrary.toId(_open(address(0), TOKEN_HI, Sinks.REWARDS, 0));
        hook.creditCurveTax{value: 1 ether}(id);
        vm.prank(CREATOR_SINK);
        assertEq(hook.pullSink(id), 0, "the creator sink pulled a vault's money");
        assertEq(hook.owedSink(id), 1 ether, "the ledger moved");
        vm.prank(address(0x5747A6E));
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullSink(id);
        vm.prank(sinkAddr);
        assertEq(hook.pullSink(id), 1 ether, "the market's own sink could not pull");
    }
}
