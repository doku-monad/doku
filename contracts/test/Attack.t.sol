// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";

/// Routes a buy through a contract, to check the tax is not tied to `tx.origin` or EOA-ness.
contract ProxyBuyer {
    BondingCurve immutable curve;

    constructor(BondingCurve c) {
        curve = c;
    }

    function buyThrough() external payable returns (uint256) {
        return curve.buy{value: msg.value}(0, block.timestamp);
    }

    receive() external payable {}
}

/// @notice One test per threat in docs/doku/01-architecture-decisions.md §5.
contract AttackTest is Test {
    BondingCurve curve;
    DokuToken token;

    uint256 constant TARGET = 1_000e18;
    address constant ATTACKER = address(0xBAD);
    address constant TREASURY = address(0x7EA);

    function setUp() public {
        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        token = DokuToken(Clones.clone(address(new DokuToken())));
        token.initialize(unicode"🔥", unicode"🔥", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(address(token), address(0), TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
        vm.deal(ATTACKER, 100_000e18);
    }

    function _skipTax() internal {
        vm.warp(block.timestamp + curve.TAX_WINDOW() + 1);
    }

    // ------------------------------------------------------------------- value extraction

    /// The core economic guarantee: no sequence of trades returns more than it cost. Rounding is
    /// the thing being probed — a curve that rounds the user's output up leaks a wei per loop,
    /// which is cheap to farm on a 400ms chain.
    function test_roundingLoopCannotDrainCurve() public {
        _skipTax();
        uint256 opening = ATTACKER.balance;
        vm.startPrank(ATTACKER);
        token.approve(address(curve), type(uint256).max);
        for (uint256 i; i < 200; ++i) {
            uint256 got = curve.buy{value: 1e18}(0, block.timestamp);
            curve.sell(got, 0, block.timestamp);
        }
        vm.stopPrank();
        assertLt(ATTACKER.balance, opening, "attacker profited from a round-trip loop");
    }

    /// Same probe at dust size, where rounding error is proportionally largest.
    function test_dustLoopCannotDrainCurve() public {
        _skipTax();
        uint256 opening = ATTACKER.balance;
        vm.startPrank(ATTACKER);
        token.approve(address(curve), type(uint256).max);
        for (uint256 i; i < 200; ++i) {
            uint256 got = curve.buy{value: 1_000 wei}(0, block.timestamp);
            if (got != 0) curve.sell(got, 0, block.timestamp);
        }
        vm.stopPrank();
        assertLe(ATTACKER.balance, opening, "dust loop extracted value");
    }

    /// The curve must never pay out more MON than it holds.
    function test_curveCannotBeOverdrawn() public {
        _skipTax();
        vm.startPrank(ATTACKER);
        uint256 got = curve.buy{value: 500e18}(0, block.timestamp);
        token.approve(address(curve), type(uint256).max);
        curve.sell(got, 0, block.timestamp);
        vm.stopPrank();
        assertGe(
            address(curve).balance,
            curve.quoteRaised() + curve.pendingProtocol() + curve.pendingFees()
                + curve.pendingTax(),
            "curve paid out more than it held"
        );
    }

    // --------------------------------------------------------------------------- tax evasion

    /// The tax is a function of time, not of who is calling. Routing through a contract, so that
    /// msg.sender differs from tx.origin, must not change what is charged.
    function test_taxCannotBeEvadedByRoutingThroughAContract() public {
        ProxyBuyer proxy = new ProxyBuyer(curve);
        vm.deal(address(proxy), 100e18);
        proxy.buyThrough{value: 100e18}();
        // t = 0, so 50% of the amount net of the protocol's 30 bps must have been escrowed.
        assertEq(curve.taxEscrow(), 49.85e18, "a contract route avoided the tax");
    }

    /// Splitting a buy into many small ones must not reduce the tax paid in aggregate.
    function test_taxCannotBeEvadedBySplitting() public {
        vm.startPrank(ATTACKER);
        for (uint256 i; i < 10; ++i) {
            curve.buy{value: 10e18}(0, block.timestamp);
        }
        vm.stopPrank();
        // Ten 10-MON buys at t=0 escrow the same as one 100-MON buy, to within dust.
        assertApproxEqAbs(curve.taxEscrow(), 49.85e18, 10, "splitting reduced the tax");
    }

    // ------------------------------------------------------------------- graduation griefing

    /// Once the curve closes it must stay closed. A late seller cannot reopen it by pushing
    /// `quoteRaised` back below the target, which would let trading resume at a stale price.
    function test_graduationCannotBeReversed() public {
        _skipTax();
        vm.prank(ATTACKER);
        curve.buy{value: 5_000e18}(0, block.timestamp);
        assertTrue(curve.readyToGraduate());

        vm.startPrank(ATTACKER);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert(BondingCurve.CurveClosed.selector);
        curve.sell(1e18, 0, block.timestamp);
        vm.stopPrank();
        assertTrue(curve.readyToGraduate(), "graduation was reversed");
    }

    /// A dust buy must not be able to flip the curve closed before the target is genuinely met.
    function test_dustBuyCannotTriggerPrematureGraduation() public {
        _skipTax();
        vm.prank(ATTACKER);
        curve.buy{value: 1 wei}(0, block.timestamp);
        assertFalse(curve.readyToGraduate(), "dust closed the curve");
    }

    // -------------------------------------------------------------------------- fee accounting

    /// Fees are held for the treasury and must never be reachable as curve liquidity, or a seller
    /// could withdraw money that was already earned by the protocol.
    function test_feesCannotBeSoldOutOfTheCurve() public {
        _skipTax();
        vm.startPrank(ATTACKER);
        uint256 got = curve.buy{value: 500e18}(0, block.timestamp);
        uint256 fees = curve.pendingProtocol();
        token.approve(address(curve), type(uint256).max);
        curve.sell(got, 0, block.timestamp);
        vm.stopPrank();
        assertGe(curve.pendingProtocol(), fees, "selling consumed accrued fees");
        assertGe(address(curve).balance, curve.pendingProtocol(), "fees are not backed by balance");
    }

    /// Anyone may trigger collection, but the money can only ever go to the recipient.
    function test_anyoneCanCollectButOnlyRecipientIsPaid() public {
        _skipTax();
        vm.prank(ATTACKER);
        curve.buy{value: 100e18}(0, block.timestamp);
        uint256 attackerBefore = ATTACKER.balance;
        uint256 treasuryBefore = TREASURY.balance;
        vm.prank(ATTACKER);
        curve.collectProtocolFees();
        assertEq(ATTACKER.balance, attackerBefore, "caller was paid");
        assertGt(TREASURY.balance, treasuryBefore, "recipient was not paid");
    }

    // ------------------------------------------------------------------------------- misc

    // ------------------------------------------------------------------ sell path limits

    /// The virtual quote floor (40% of target) is virtual - the curve never holds it. `quoteOut`
    /// is computed against the virtual reserve, so a large enough sell could in principle compute
    /// a payout larger than the curve's real balance, underflowing `quoteRaised`. Buy almost the
    /// whole curve and dump all of it in one transaction.
    function test_dumpingTheWholeCurveDoesNotUnderflow() public {
        _skipTax();
        vm.startPrank(ATTACKER);
        uint256 got = curve.buy{value: 999e18}(0, block.timestamp);
        token.approve(address(curve), type(uint256).max);
        uint256 back = curve.sell(got, 0, block.timestamp);
        vm.stopPrank();

        assertLt(back, 999e18, "full dump returned more than it cost");
        assertGe(address(curve).balance, curve.pendingProtocol(), "fees no longer backed after dump");
    }

    /// Donating tokens to the curve must not create a claim on its MON. The donor is simply out
    /// of pocket; nobody else gains a withdrawal path.
    function test_donatedTokensCreateNoClaim() public {
        _skipTax();
        vm.startPrank(ATTACKER);
        uint256 got = curve.buy{value: 100e18}(0, block.timestamp);
        uint256 raisedBefore = curve.quoteRaised();
        token.transfer(address(curve), got); // straight donation, not a sell
        vm.stopPrank();

        assertEq(curve.quoteRaised(), raisedBefore, "a donation moved the raise");
        (uint128 base,) = curve.reserves();
        uint256 distributed = token.totalSupply() - token.balanceOf(address(curve));
        // Burned tokens leave the reserve AND totalSupply, so they need their own term — the
        // same third term the invariant suite carries. Without it this reports a shortfall exactly
        // equal to everything the market tax has destroyed, and reads as a donation bug.
        assertEq(
            uint256(base) + distributed + curve.burnedByTax(),
            curve.BASE_VIRTUAL_CEILING() - got,
            "donation was silently credited to the reserve"
        );
    }

    /// Selling more than was ever bought must fail on the token transfer rather than on curve
    /// accounting, so no partial state change survives.
    function test_sellingMoreThanExistsReverts() public {
        _skipTax();
        vm.startPrank(ATTACKER);
        curve.buy{value: 10e18}(0, block.timestamp);
        token.approve(address(curve), type(uint256).max);
        vm.expectRevert();
        curve.sell(30_000_000e18, 0, block.timestamp);
        vm.stopPrank();
    }

    /// A bare send must not sit in the contract unaccounted, or the balance invariant breaks and
    /// the surplus is claimable by whoever sells last.
    function test_bareSendIsRejected() public {
        vm.prank(ATTACKER);
        (bool ok,) = address(curve).call{value: 1e18}("");
        assertFalse(ok, "curve accepted an unaccounted transfer");
    }
}
