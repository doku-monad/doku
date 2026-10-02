// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";

/// Re-enters `sell` from its MON receive hook.
contract ReentrantSeller {
    BondingCurve curve;
    DokuToken token;
    bool armed;

    constructor(BondingCurve c, DokuToken t) {
        curve = c;
        token = t;
    }

    function attack(uint256 amount) external {
        armed = true;
        token.approve(address(curve), type(uint256).max);
        curve.sell(amount, 0, block.timestamp);
    }

    receive() external payable {
        if (armed) {
            armed = false;
            curve.sell(1e18, 0, block.timestamp);
        }
    }
}

/// Refuses MON, to prove fee collection failure cannot stop trading.
contract RevertingTreasury {
    receive() external payable {
        revert("no");
    }
}

/// Identical to ReentrantSeller minus the re-entry. The control for the reentrancy test.
contract BenignSeller {
    BondingCurve curve;
    DokuToken token;

    constructor(BondingCurve c, DokuToken t) {
        curve = c;
        token = t;
    }

    function sell(uint256 amount) external {
        token.approve(address(curve), type(uint256).max);
        curve.sell(amount, 0, block.timestamp);
    }

    receive() external payable {}
}

contract BondingCurveTest is Test {
    BondingCurve curve;
    DokuToken token;

    uint256 constant QUOTE_TARGET = 1_000e18;
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant TREASURY = address(0x7EA);

    function setUp() public {
        BondingCurve curveImpl = new BondingCurve();
        DokuToken tokenImpl = new DokuToken();
        curve = BondingCurve(payable(Clones.clone(address(curveImpl))));
        token = DokuToken(Clones.clone(address(tokenImpl)));
        token.initialize(unicode"🔥", unicode"🔥", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
        vm.deal(ALICE, 10_000e18);
        vm.deal(BOB, 10_000e18);
    }

    /// Moves past the anti-sniper window so a test can isolate curve or fee behaviour. Without
    /// this, every buy at t=0 also pays 50% tax and the assertion under test is confounded.
    function _skipTaxWindow() internal {
        vm.warp(block.timestamp + curve.TAX_WINDOW() + 1);
    }

    // ------------------------------------------------------------------------------------ buy

    function test_buyDeliversTokens() public {
        _skipTaxWindow();
        vm.prank(ALICE);
        uint256 out = curve.buy{value: 10e18}(0, block.timestamp);
        assertGt(out, 0);
        assertEq(token.balanceOf(ALICE), out);
    }

    function test_buyMovesReserves() public {
        _skipTaxWindow();
        (uint128 b0, uint128 q0) = curve.reserves();
        vm.prank(ALICE);
        uint256 out = curve.buy{value: 10e18}(0, block.timestamp);
        (uint128 b1, uint128 q1) = curve.reserves();
        // Only the protocol's 30 bps is held before pricing, so the curve absorbs 99.7% of what
        // was sent — on a BURN market the routed share reaches the reserve too, because it is
        // spent buying on the curve rather than held aside.
        assertEq(q1 - q0, 9.97e18, "quote reserve did not take the payment net of fee");
        // The base reserve sheds the buyer's tokens AND the ones the routed share bought to burn,
        // so a single-call expectation understates it. Both legs together are the shed amount.
        assertEq(b0 - b1, out + curve.burnedByTax(), "base reserve did not shed both legs");
        assertGt(curve.burnedByTax(), 0, "the routed share bought nothing to burn");
    }

    function test_buyRespectsMinOut() public {
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.InsufficientOutput.selector);
        curve.buy{value: 1e18}(type(uint256).max, block.timestamp);
    }

    function test_buyRespectsDeadline() public {
        vm.warp(1000);
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.Expired.selector);
        curve.buy{value: 1e18}(0, 999);
    }

    function test_zeroValueBuyReverts() public {
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buy{value: 0}(0, block.timestamp);
    }

    // ----------------------------------------------------------------------------------- sell

    function test_sellReturnsMon() public {
        _skipTaxWindow();
        vm.startPrank(ALICE);
        uint256 bought = curve.buy{value: 10e18}(0, block.timestamp);
        token.approve(address(curve), bought);
        uint256 before = ALICE.balance;
        uint256 back = curve.sell(bought, 0, block.timestamp);
        assertEq(ALICE.balance - before, back);
        assertLt(back, 10e18, "round trip returned more than it cost");
    }

    function test_sellRespectsMinOut() public {
        _skipTaxWindow();
        vm.startPrank(ALICE);
        uint256 bought = curve.buy{value: 10e18}(0, block.timestamp);
        token.approve(address(curve), bought);
        vm.expectRevert(BondingCurve.InsufficientOutput.selector);
        curve.sell(bought, type(uint256).max, block.timestamp);
    }

    // ----------------------------------------------------------------------------- graduation

    function test_overshootIsRefundedNotAbsorbed() public {
        _skipTaxWindow();
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        curve.buy{value: 5_000e18}(0, block.timestamp);

        // The curve takes exactly its target and not a wei more...
        assertEq(curve.quoteRaised(), QUOTE_TARGET, "curve absorbed more than the target");
        // ...and the buyer is charged the fee only on the part that was actually filled, so the
        // total paid is the target grossed up by 1%. No fee is levied on the refund.
        //
        // The refund is computed with a division that rounds down, so the buyer can pay up to a
        // wei more than the ideal and that wei lands in fees. Asserting `>=` rather than `==` is
        // the point: rounding must never resolve in the user's favour, because the opposite
        // direction is what a refund loop would farm.
        uint256 ideal = (QUOTE_TARGET * 10_000) / 9_970;
        uint256 paid = before - ALICE.balance;
        assertGe(paid, ideal, "rounding favoured the buyer");
        assertLe(paid - ideal, 2, "buyer overcharged by more than dust");
        assertTrue(curve.readyToGraduate(), "target reached but not flagged");
    }

    function test_tradingClosesOnceReadyToGraduate() public {
        _skipTaxWindow();
        vm.prank(ALICE);
        curve.buy{value: 5_000e18}(0, block.timestamp);
        vm.prank(BOB);
        vm.expectRevert(BondingCurve.CurveClosed.selector);
        curve.buy{value: 1e18}(0, block.timestamp);
    }

    /// The curve must never take more quote than its target, at any input size.
    function testFuzz_neverExceedsQuoteTarget(uint96 amount) public {
        _skipTaxWindow();
        amount = uint96(bound(amount, 1e12, 50_000e18));
        vm.deal(ALICE, uint256(amount) + 1e18);
        vm.prank(ALICE);
        curve.buy{value: amount}(0, block.timestamp);
        assertLe(curve.quoteRaised(), QUOTE_TARGET, "raised past the target");
    }

    // -------------------------------------------------------------------------------- safety

    /// The guard fires inside the attacker's receive hook, so the re-entrant `sell` reverts; the
    /// outer `call` then returns false and the whole transaction unwinds with TransferFailed.
    /// Asserting the specific selector matters — a bare expectRevert() would also pass if the
    /// attacker simply lacked an approval, which would prove nothing.
    function test_reentrantSellReverts() public {
        _skipTaxWindow();
        ReentrantSeller attacker = new ReentrantSeller(curve, token);
        vm.prank(ALICE);
        uint256 bought = curve.buy{value: 50e18}(0, block.timestamp);
        vm.prank(ALICE);
        token.transfer(address(attacker), bought);
        vm.expectRevert(BondingCurve.TransferFailed.selector);
        attacker.attack(bought / 2);
    }

    /// Control for the test above: an otherwise identical contract that does not re-enter sells
    /// fine. Without this, the reentrancy test could be passing because contracts cannot sell at
    /// all, and would still go green if the guard were removed.
    function test_nonReentrantContractCanSell() public {
        _skipTaxWindow();
        BenignSeller seller = new BenignSeller(curve, token);
        vm.prank(ALICE);
        uint256 bought = curve.buy{value: 50e18}(0, block.timestamp);
        vm.prank(ALICE);
        token.transfer(address(seller), bought);
        seller.sell(bought / 2);
        assertGt(address(seller).balance, 0, "benign contract could not sell");
    }

    // -------------------------------------------------------------------------- protocol fee

    function test_buyChargesOnePercentOfMon() public {
        _skipTaxWindow();
        vm.prank(ALICE);
        curve.buy{value: 100e18}(0, block.timestamp);
        assertEq(curve.pendingProtocol(), 0.3e18, "protocol share is not 30 bps of MON in");
        assertEq(curve.pendingFees(), 0, "a BURN market held its routed share");
        assertEq(curve.quoteRaised(), 99.7e18, "the protocol share was counted toward the raise");
    }

    function test_sellChargesOnePercentOfMon() public {
        _skipTaxWindow();
        vm.startPrank(ALICE);
        uint256 bought = curve.buy{value: 100e18}(0, block.timestamp);
        uint256 protocolAfterBuy = curve.pendingProtocol();
        token.approve(address(curve), bought);
        uint256 before = ALICE.balance;
        uint256 received = curve.sell(bought, 0, block.timestamp);
        vm.stopPrank();

        uint256 protocolCut = curve.pendingProtocol() - protocolAfterBuy;
        assertEq(ALICE.balance - before, received, "return value disagrees with MON delivered");
        // The fee is 1% of the gross and the protocol's share is 30 bps of it, so the seller keeps
        // 9900/30 = 330 times what the treasury books.
        assertApproxEqRel(protocolCut * 330, received, 1e12, "sell protocol share is not 30 bps");
    }

    function testFuzz_feeIsExactlyOnePercentOnBuys(uint96 amount) public {
        _skipTaxWindow();
        amount = uint96(bound(amount, 1e14, 900e18));
        vm.prank(ALICE);
        curve.buy{value: amount}(0, block.timestamp);
        assertEq(
            curve.pendingProtocol(),
            (uint256(amount) * 30) / 10_000,
            "the protocol share drifted from 30 bps"
        );
    }

    /// A treasury that reverts must not be able to brick trading, which is why fees accrue and
    /// are pulled rather than pushed inside the trade.
    function test_revertingTreasuryCannotBrickTrading() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("x", "x", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), address(new RevertingTreasury()), address(this), address(0));
        curve = c;
        token = t;
        _skipTaxWindow();
        vm.prank(ALICE);
        curve.buy{value: 10e18}(0, block.timestamp);
        assertGt(curve.pendingProtocol(), 0, "fee did not accrue");
        vm.expectRevert(BondingCurve.TransferFailed.selector);
        curve.collectProtocolFees();
        // Trading still works even though collection cannot.
        vm.prank(BOB);
        curve.buy{value: 10e18}(0, block.timestamp);
    }

    function test_collectFeesPaysTheRecipient() public {
        _skipTaxWindow();
        vm.prank(ALICE);
        curve.buy{value: 100e18}(0, block.timestamp);
        uint256 before = TREASURY.balance;
        curve.collectProtocolFees();
        assertEq(TREASURY.balance - before, 0.3e18);
        assertEq(curve.pendingProtocol(), 0, "pending fees not cleared");
    }

    /// Fees are held for the treasury, so they are not part of the raise and must never be lent
    /// to the curve's own accounting.
    function testFuzz_monIsFullyAccountedWithFees(uint96 a, uint96 b) public {
        _skipTaxWindow();
        a = uint96(bound(a, 1e14, 300e18));
        b = uint96(bound(b, 1e14, 300e18));
        vm.prank(ALICE);
        curve.buy{value: a}(0, block.timestamp);
        vm.prank(BOB);
        curve.buy{value: b}(0, block.timestamp);
        assertEq(
            address(curve).balance,
            curve.quoteRaised() + curve.pendingProtocol() + curve.pendingFees(),
            "unaccounted MON in the curve"
        );
    }

    // ------------------------------------------------------------------ anti-sniper buy tax

    function test_taxIsFiftyPercentAtLaunch() public {
        vm.prank(ALICE);
        curve.buy{value: 100e18}(0, block.timestamp);
        // 100 MON in: 0.3 to the protocol, 99.7 absorbed by the curve, of which 50% is the
        // anti-sniper tax.
        assertEq(curve.taxEscrow(), 49.85e18, "launch tax is not 50% of the net");
        // D5: the tax is SPENT on the curve, so both legs count toward the raise. The old
        // assertion here was that the escrow stayed out of the raise; that is exactly what D5
        // reverses, and `burnedByTax` is where the tax went.
        assertEq(curve.quoteRaised(), 99.7e18, "both legs should raise the curve");
        assertGt(curve.burnedByTax(), 0, "the tax bought nothing to burn");
    }

    function test_taxIsZeroAfterWindow() public {
        vm.warp(block.timestamp + 300);
        vm.prank(ALICE);
        curve.buy{value: 100e18}(0, block.timestamp);
        assertEq(curve.taxEscrow(), 0, "tax outlived its window");
        assertEq(curve.quoteRaised(), 99.7e18);
    }

    function test_taxHalvesAtMidpoint() public {
        vm.warp(block.timestamp + 150);
        vm.prank(ALICE);
        curve.buy{value: 100e18}(0, block.timestamp);
        assertEq(curve.taxEscrow(), 24.925e18, "midpoint tax is not 25%");
    }

    /// The decision in 01-§9: sells are never taxed, only buys.
    function test_sellsAreNeverTaxed() public {
        vm.startPrank(ALICE);
        uint256 bought = curve.buy{value: 100e18}(0, block.timestamp);
        uint256 escrowAfterBuy = curve.taxEscrow();
        token.approve(address(curve), bought);
        curve.sell(bought, 0, block.timestamp);
        assertEq(curve.taxEscrow(), escrowAfterBuy, "a sell was taxed");
    }

    /// Escrowed tax is destined for the launch liquidity, so it must never be lent to the curve's
    /// reserves - doing so would move the price out from under the invariant and shift the
    /// graduation threshold. See 01-§8.2.
    /// D5 REVERSES THIS TEST'S ORIGINAL CLAIM, deliberately. The escrow used to be held aside and
    /// added to the launch liquidity; it now buys on this curve and burns what it buys, so BOTH
    /// legs enter the reserves. What must still hold is that nothing is left unspent — an escrow
    /// with no drain would be stranded on the curve forever once graduation stopped taking it.
    function testFuzz_theWholeAbsorbedAmountEntersTheReserves(uint96 amount) public {
        amount = uint96(bound(amount, 1e14, 500e18));
        (, uint128 q0) = curve.reserves();
        vm.prank(ALICE);
        curve.buy{value: amount}(0, block.timestamp);
        (, uint128 q1) = curve.reserves();

        uint256 absorbed = uint256(amount) - (uint256(amount) * 30) / 10_000;
        assertApproxEqAbs(q1 - q0, absorbed, 1, "the absorbed amount did not reach the reserves");
        assertApproxEqAbs(curve.taxEscrow(), absorbed / 2, 1, "tax wrong at launch"); // t=0 -> 50%
        assertGt(curve.burnedByTax(), 0, "the tax was recorded but bought nothing");
    }

    /// Regression: the overshoot cap must be applied after the tax, not before it.
    ///
    /// Capping first hands the curve exactly `remaining` and then lets the tax eat into it, so a
    /// 50% tax stalls the curve at half its target and it can never graduate no matter how much
    /// MON arrives. Caught by this test during Task 8.
    function test_curveCanStillFillDuringTheTaxWindow() public {
        // t = 0, so the tax is at its 50% maximum.
        vm.prank(ALICE);
        curve.buy{value: 9_000e18}(0, block.timestamp);
        assertEq(curve.quoteRaised(), QUOTE_TARGET, "curve stalled below target under tax");
        assertTrue(curve.readyToGraduate(), "curve filled but did not close");
    }

    /// The buyer filling the curve under a 50% tax pays roughly double, and every wei of it is
    /// accounted for across the three buckets.
    function test_fillingUnderTaxIsFullyAccounted() public {
        vm.prank(ALICE);
        curve.buy{value: 9_000e18}(0, block.timestamp);
        // D5: three buckets became two. The tax is inside `quoteRaised` because it was spent on
        // the curve, so the balance backs the raise and the fees and nothing else.
        assertEq(
            address(curve).balance,
            curve.quoteRaised() + curve.pendingProtocol() + curve.pendingFees(),
            "unaccounted MON after filling under tax"
        );
        assertGt(curve.burnedByTax(), 0, "no burn under a 50% tax");
    }

    /// Documents the accepted equilibrium: waiting out the clock buys untaxed at the bottom.
    function test_waitingOutTheWindowBuysUntaxed() public {
        vm.warp(block.timestamp + 301);
        vm.prank(ALICE);
        uint256 out = curve.buy{value: 100e18}(0, block.timestamp);
        assertEq(curve.taxEscrow(), 0);

        // And the price is unchanged from launch, because nobody bought during the window.
        BondingCurve fresh = _freshCurve();
        vm.prank(BOB);
        uint256 outAtLaunch = fresh.buy{value: 100e18}(0, block.timestamp);
        assertGt(out, outAtLaunch, "waiting did not beat buying at launch");
    }

    function testFuzz_monIsFullyAccountedWithTax(uint96 a) public {
        a = uint96(bound(a, 1e14, 500e18));
        vm.prank(ALICE);
        curve.buy{value: a}(0, block.timestamp);
        // D5: the tax is not a held balance any more, so it is not a term here.
        assertEq(
            address(curve).balance,
            curve.quoteRaised() + curve.pendingProtocol() + curve.pendingFees(),
            "unaccounted MON once the tax has been spent"
        );
    }

    function _freshCurve() internal returns (BondingCurve c) {
        BondingCurve impl = new BondingCurve();
        DokuToken tImpl = new DokuToken();
        c = BondingCurve(payable(Clones.clone(address(impl))));
        DokuToken t = DokuToken(Clones.clone(address(tImpl)));
        t.initialize(unicode"x", unicode"x", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
    }

    /// The uint128 reserve casts are only safe because the target is bounded. Without this
    /// check they would be safe by luck rather than by construction.
    function test_oversizedTargetIsRejected() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("x", "x", address(c), false, "https://cdn.doku.family/metadata/test.json");
        // Read the bound first: an external call inside the argument list would itself be the
        // "next call" that expectRevert latches onto, and it does not revert.
        uint256 tooBig = c.MAX_QUOTE_TARGET() + 1;
        vm.expectRevert(BondingCurve.TargetTooLarge.selector);
        c.initialize(address(t), address(0), tooBig, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
    }

    // ------------------------------------------------------------------------ progress

    /// `progress` is what the UI reads to draw the bonding-curve bar, and what PROGRESS/MAX tax
    /// modes decay against, so it is worth asserting directly rather than only through the tax.
    function test_progressStartsAtZeroAndEndsAtOne() public {
        _skipTaxWindow();
        assertEq(curve.progress(), 0, "fresh curve is not at zero");

        vm.prank(ALICE);
        curve.buy{value: 9_000e18}(0, block.timestamp);
        assertEq(curve.progress(), 1e18, "filled curve is not at one");
    }

    function test_progressIsTheFractionRaised() public {
        _skipTaxWindow();
        vm.prank(ALICE);
        // 250 MON net of the protocol's 30 bps lands 249.25 against a 1000 target.
        curve.buy{value: 250e18}(0, block.timestamp);
        assertEq(curve.progress(), 0.24925e18, "progress does not track the raise");
    }

    function testFuzz_progressNeverExceedsOne(uint96 amount) public {
        _skipTaxWindow();
        amount = uint96(bound(amount, 1e12, 50_000e18));
        vm.deal(ALICE, uint256(amount) + 1e18);
        vm.prank(ALICE);
        curve.buy{value: amount}(0, block.timestamp);
        assertLe(curve.progress(), 1e18, "progress ran past one");
    }

    // ------------------------------------------------------------------------ event shape

    event Bought(
        address indexed buyer,
        uint256 quoteIn,
        uint256 baseOut,
        uint256 fee,
        uint256 antiSniperTax,
        uint256 creatorTax,
        uint256 quoteRaised,
        uint256 price
    );
    event Sold(
        address indexed seller,
        uint256 baseIn,
        uint256 quoteOut,
        uint256 fee,
        uint256 creatorTax,
        uint256 quoteRaised,
        uint256 price
    );

    /// The indexer builds a row from this log alone. If `quoteRaised` were emitted pre-trade the
    /// progress bar would lag by one trade, and every candle would be attributed to the wrong
    /// point on the curve — silently, because both values are plausible.
    function test_boughtEmitsPostTradeState() public {
        vm.recordLogs();
        vm.prank(ALICE);
        curve.buy{value: 100e18}(0, block.timestamp);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Bought.selector) continue;
            (,,, uint256 tax,, uint256 raised, uint256 price) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            assertEq(raised, curve.quoteRaised(), "emitted raise is not the post-trade value");
            assertEq(tax, curve.taxEscrow(), "emitted tax does not match escrow");
            (uint128 b, uint128 q) = curve.reserves();
            assertEq(price, (uint256(q) * 1e36) / b, "emitted price is not the post-trade spot");
            return;
        }
        fail();
    }

    function test_soldEmitsPostTradeState() public {
        _skipTaxWindow();
        vm.startPrank(ALICE);
        uint256 bought = curve.buy{value: 100e18}(0, block.timestamp);
        token.approve(address(curve), bought);
        vm.recordLogs();
        curve.sell(bought / 2, 0, block.timestamp);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Sold.selector) continue;
            (,,,, uint256 raised,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256));
            assertEq(raised, curve.quoteRaised(), "emitted raise is not the post-trade value");
            return;
        }
        fail();
    }

    // ---------------------------------------------------------------------------- release

    function _fill() internal {
        vm.prank(ALICE);
        curve.buy{value: 9_000e18}(0, block.timestamp);
    }

    /// D4a: the MON raised, and the token side LATCHED when the curve filled. The anti-sniper
    /// escrow deliberately stays behind — it was the entire cause of the pool opening above the
    /// curve's close, worth +20.63% to a fill-graduate-dump attacker on a hot launch.
    function test_releaseSendsQuoteAndTheLatchedBase() public {
        _fill();
        uint256 expectedQuote = curve.quoteRaised();
        uint256 expectedBase = curve.seedBase();
        assertGt(expectedBase, 0, "the seed was never latched");

        (uint256 quoteOut, uint256 baseOut) = curve.release();

        assertEq(quoteOut, expectedQuote, "wrong MON released");
        assertEq(baseOut, expectedBase, "wrong token amount released");
        assertEq(token.balanceOf(address(this)), expectedBase, "tokens did not arrive");
    }

    /// The seed is latched at the fill rather than read at graduation, so a donation cannot change
    /// what the pool opens at.
    function test_aDonationAfterTheFillCannotMoveTheSeed() public {
        _fill();
        uint256 latched = curve.seedBase();
        // A stranger donating tokens to the curve after the fill.
        deal(address(token), ALICE, 1_000e18, true);
        vm.prank(ALICE);
        token.transfer(address(curve), 1_000e18);
        (, uint256 baseOut) = curve.release();
        assertEq(baseOut, latched, "a donation moved the graduation seed");
    }

    /// The reason release computes from accounting rather than from address(this).balance: those
    /// fees are the treasury's and already earned. Sweeping the balance would quietly move them
    /// into someone else's liquidity.
    function test_releaseLeavesProtocolFeesBehind() public {
        _fill();
        uint256 fees = curve.pendingProtocol();
        assertGt(fees, 0, "no fees accrued, test proves nothing");

        curve.release();

        assertEq(curve.pendingProtocol(), fees, "fees were released with the liquidity");
        // After release the only MON left is the treasury's. The anti-sniper tax was spent on the
        // curve as it accrued, and a BURN market's routed share with it, so there is no third
        // bucket to strand.
        assertEq(address(curve).balance, fees, "curve balance no longer backs its fees");

        uint256 before = TREASURY.balance;
        curve.collectProtocolFees();
        assertEq(TREASURY.balance - before, fees, "fees unreachable after release");
    }

    function test_releaseRequiresAFilledCurve() public {
        vm.expectRevert(BondingCurve.NotReady.selector);
        curve.release();
    }

    function test_releaseIsGraduatorOnly() public {
        _fill();
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.NotGraduator.selector);
        curve.release();
    }

    /// A second release would send money that is no longer ours to send.
    function test_releaseIsOneShot() public {
        _fill();
        curve.release();
        vm.expectRevert(BondingCurve.AlreadyReleased.selector);
        curve.release();
    }

    function test_releaseZeroesTheReleasedAccounting() public {
        _fill();
        curve.release();
        assertEq(curve.quoteRaised(), 0, "quoteRaised not cleared");
        // D4a: the escrow is NOT cleared by release, because release no longer takes it.
        assertGt(curve.taxEscrow(), 0, "escrow should survive release under D4a");
    }

    receive() external payable {}

    // -------------------------------------------------- initialisation and guard coverage

    function test_zeroTokenIsRejected() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        vm.expectRevert(BondingCurve.ZeroAddress.selector);
        c.initialize(address(0), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
    }

    function test_zeroProtocolRecipientIsRejected() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        vm.expectRevert(BondingCurve.ZeroAddress.selector);
        c.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), address(0), address(this), address(0));
    }

    /// The routed recipient IS a CREATOR market's configuration and is meaningless elsewhere.
    function test_theRoutedRecipientIsACreatorMarketsAlone() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        vm.expectRevert(BondingCurve.InvalidRecipient.selector);
        c.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0xC0DE), 0, address(0), TREASURY, address(this), address(0));
        vm.expectRevert(BondingCurve.InvalidRecipient.selector);
        c.initialize(address(token), address(0), QUOTE_TARGET, Sinks.CREATOR, address(0), 0, address(0), TREASURY, address(this), address(0));
    }

    function test_aCreatorTaxNeedsARecipientAndACap() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        vm.expectRevert(BondingCurve.TaxTooHigh.selector);
        c.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 1001, address(0x7A0), TREASURY, address(this), address(0));
        vm.expectRevert(BondingCurve.InvalidRecipient.selector);
        c.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 10, address(0), TREASURY, address(this), address(0));
    }

    function test_initializeRecordsEveryTerm() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        c.initialize(address(token), address(0x05DC), QUOTE_TARGET, Sinks.CREATOR, address(0xC0DE), 250, address(0x7A0), TREASURY, address(0x6AD), address(0x51));
        assertEq(c.quoteAsset(), address(0x05DC));
        assertEq(c.sink(), Sinks.CREATOR);
        assertEq(c.routedRecipient(), address(0xC0DE));
        assertEq(c.creatorTaxBps(), 250);
        assertEq(c.taxRecipient(), address(0x7A0));
        assertEq(c.protocolRecipient(), TREASURY);
        assertEq(c.graduator(), address(0x6AD));
        assertEq(c.creatorSink(), address(0x51));
        assertEq(c.factory(), address(this), "the factory is whoever initialised the clone");
    }

    function test_zeroGraduatorIsRejected() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        vm.expectRevert(BondingCurve.ZeroAddress.selector);
        c.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(0), address(0));
    }

    function test_zeroQuoteTargetIsRejected() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        vm.expectRevert(
            abi.encodeWithSelector(BondingCurve.TargetTooSmall.selector, 0, c.MIN_QUOTE_TARGET())
        );
        c.initialize(address(token), address(0), 0, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
    }

    /**
     * A target of 1 or 2 used to produce a market that could never be traded.
     *
     * `initialize` seeds the virtual quote reserve at `(quoteTarget * 2) / 5` — integer division,
     * so 1 and 2 both truncate to zero. Only `quoteTarget == 0` was rejected, and the two values
     * either side of the boundary sailed through.
     *
     * The failure was the worst available shape. Every `buy` reverted with **Panic 0x11**
     * (arithmetic overflow) permanently, because `quoteTarget` has no setter — while `quoteBuy`
     * kept returning the entire 49,000,000e18 virtual base ceiling, so an interface would render a
     * confident, enormous, unfillable quote. Nothing looks wrong until someone signs.
     *
     * 3 and 4 are here too, and they are not the same defect: their floors survive the division,
     * they simply are not multiples of five, and the minimum moved up to five so that the two
     * rules meet at one number. Every target below the minimum is refused by magnitude, so this
     * test now covers the whole span rather than just the pair that truncated to zero.
     */
    function test_launchRejectsEveryTargetBelowTheMinimum() public {
        for (uint256 target = 1; target < 5; ++target) {
            BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
            vm.expectRevert(
                abi.encodeWithSelector(BondingCurve.TargetTooSmall.selector, target, uint256(5))
            );
            c.initialize(address(token), address(0), target, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
        }
    }

    /**
     * A target that is not a multiple of five produces a market that fills and can never graduate.
     *
     * `initialize` seeds the virtual quote reserve at `(target * 2) / 5`. That division truncates
     * unless five divides the target, and a truncated floor leaves the curve's final base reserve
     * strictly ABOVE `BASE_VIRTUAL_FLOOR` — so the seed handed to graduation lands BELOW
     * `DOKU_SEED_BASE`, which `DokuGraduation` refuses with no tolerance below. `release` is only
     * reachable through `graduate`, so the market holds its whole raise permanently.
     *
     * Enforced here as well as in `QuoteRegistry` because the factory SNAPSHOTS the target between
     * the two, and this is the contract the money actually sits in.
     */
    function test_launchRejectsATargetWhoseQuoteFloorTruncates() public {
        // The three shapes this took: 2,424,242 raw of six-decimal gold is the natural conversion
        // of this project's own spec figure, 1_000e18 + 1 is an 18-decimal target one wei off, and
        // 7 is the smallest illegal value above the minimum. Every one of them bricked.
        uint256[3] memory targets = [uint256(2_424_242), 1_000e18 + 1, 7];
        for (uint256 i = 0; i < targets.length; ++i) {
            BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
            vm.expectRevert(abi.encodeWithSelector(BondingCurve.TargetNotDivisibleByFive.selector, targets[i]));
            c.initialize(address(token), address(0), targets[i], Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
        }
    }

    /**
     * With the divisibility rule in place the seed covers `DOKU_SEED_BASE` at every scale, with no
     * shortfall — which is what lets graduation keep an exact lower bound instead of a tolerance.
     *
     * The arithmetic, because it is the whole reason the rule exists. Reserves open at
     * `(CEILING, 2T/5)` and the curve closes at `quoteRaised == T`, so the quote reserve ends at
     * `2T/5 + T == 7T/5`. Every rounding favours the pool, so `base_final >= k0 / quote_final ==
     * CEILING · (2T/5) / (7T/5) == CEILING · 2/7 == FLOOR` — the `T` cancels, which is why the
     * value below is the same number at every scale, and why it is only true when `5 | T`.
     *
     * The scales are the ones that matter rather than a fuzz: an 18-decimal native target, a
     * six-decimal stablecoin one, an eight-decimal one, and the gold-shaped target that is four
     * orders of magnitude coarser per dollar than USDC and is where the truncation was found.
     */
    function test_theSeedCoversTheGraduationBaseAtEveryScale() public {
        uint256[4] memory targets = [uint256(1_000e18), 10_000e6, 100_000e8, 2_424_240];
        for (uint256 i = 0; i < targets.length; ++i) {
            BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
            DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
            t.initialize(unicode"m", unicode"m", address(c), false, "https://cdn.doku.family/metadata/test.json");
            c.initialize(address(t), address(0), targets[i], Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
            // Past the anti-sniper window, so the fill is one clean trade and the number below is
            // the arithmetic rather than a function of when the block landed.
            vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
            uint256 gross = 4 * targets[i];
            vm.deal(ALICE, gross);
            vm.prank(ALICE);
            c.buy{value: gross}(0, block.timestamp);
            assertTrue(c.readyToGraduate(), "the curve did not fill");
            assertGe(c.seedBase(), 222_222_222e18, "the seed is SHORT: graduation would refuse it");
            // One wei over, identically at all four scales: `seedBase` is
            // `SUPPLY + base_final - CEILING` and `CEILING - FLOOR` IS `CURVE_SUPPLY`, so the dust
            // is exactly `base_final - FLOOR` — the single ceil in the pool's favour on the closing
            // trade. Comfortably inside the tolerance the upper bound carries.
            assertEq(c.seedBase() - 222_222_222e18, 1, "the pool-favouring dust moved");
        }
    }

    /**
     * The bound is exactly where the arithmetic breaks — every value below it fails, the value
     * itself works.
     *
     * Asserted rather than trusted, because `MIN_QUOTE_TARGET` is a derived number: it is the
     * smallest input for which `(target * 2) / 5` is both non-zero and EXACT. If that ratio ever
     * changes, this is the test that notices the constant no longer matches it.
     */
    function test_theMinimumTargetIsTheSmallestTargetWithAnExactQuoteFloor() public {
        uint256 min = curve.MIN_QUOTE_TARGET();
        assertEq(min, 5, "the documented bound moved");
        assertGt(min * 2 / 5, 0, "the bound itself truncates to zero, so it is too low");
        assertEq(min * 2 % 5, 0, "the bound's own floor is not exact, so it is not a legal target");
        // And it is the SMALLEST such value: everything under it is refused, so there is no legal
        // target below the bound that the constant is quietly excluding.
        for (uint256 t = 1; t < min; ++t) {
            assertTrue(t % 5 != 0, "a legal target sits below the bound");
        }

        // And the market it produces actually trades, which is the property the number stands for.
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        t.initialize(unicode"m", unicode"m", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), min, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));

        (, uint128 q) = c.reserves();
        assertGt(q, 0, "the virtual quote reserve is still zero at the minimum");

        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        c.buy{value: 1 ether}(0, block.timestamp + 1);
        assertGt(t.balanceOf(ALICE), 0, "a buy at the minimum target delivered nothing");
    }

    function test_zeroAmountSellIsRejected() public {
        _skipTaxWindow();
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.sell(0, 0, block.timestamp);
    }

    function test_sellRespectsDeadline() public {
        _skipTaxWindow();
        vm.startPrank(ALICE);
        uint256 bought = curve.buy{value: 10e18}(0, block.timestamp);
        token.approve(address(curve), bought);
        vm.warp(block.timestamp + 100);
        vm.expectRevert(BondingCurve.Expired.selector);
        curve.sell(bought, 0, block.timestamp - 1);
        vm.stopPrank();
    }

    /// The tax is a property of the curve phase, so it must read zero the moment the curve closes
    /// even if the clock says otherwise.
    function test_taxRateReadsZeroOnceClosed() public {
        assertEq(curve.taxRate(), curve.TAX_START_BPS(), "not taxed at launch");
        vm.prank(ALICE);
        curve.buy{value: 9_000e18}(0, block.timestamp); // fills the curve while still taxed
        assertTrue(curve.readyToGraduate());
        assertEq(curve.taxRate(), 0, "tax outlived the curve phase");
    }

    function test_collectFeesWithNothingPendingReverts() public {
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.collectFees();
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.collectProtocolFees();
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.collectTax();
    }

    function test_cannotReinitialise() public {
        vm.expectRevert(BondingCurve.AlreadyInitialised.selector);
        curve.initialize(address(token), address(0), QUOTE_TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
    }
}
