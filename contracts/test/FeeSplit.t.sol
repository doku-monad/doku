// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve, DOKU_SEED_BASE} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {MockGraduator} from "./mocks/MockGraduator.sol";
import {MockCreatorSink} from "./mocks/MockCreatorSink.sol";

/// @dev A wallet that cannot be paid. The whole point of the deferred push is that this address
///      blocks nobody — not the market, and not whoever called the collection.
contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

/// @notice The one 1% fee, split 30/70, and the creator tax on top — on every sink, both legs.
///
/// @dev The property under test is the one that makes the whole design swap-free: the routed
///      share's CURRENCY follows the sink. A BURN market spends it on the curve and destroys what
///      it buys; a REWARDS market escrows it in the quote for the vault; a CREATOR market pays it
///      to a wallet. No sink is ever handed the currency it cannot use, so none ever has to sell.
contract FeeSplitTest is Test {
    uint256 constant TARGET = 1_000e18;
    address constant ALICE = address(0xA11CE);
    address constant TREASURY = address(0x7EA);
    address constant CREATOR_WALLET = address(0xC0DE);
    address constant TAX_WALLET = address(0x7A0);

    address internal curveImpl;
    address internal tokenImpl;
    MockCreatorSink internal sink;

    receive() external payable {}

    function setUp() public {
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        sink = new MockCreatorSink();
        vm.deal(ALICE, 1_000_000e18);
    }

    function _market(uint8 kind, uint16 taxBps, address routed, address tax, address graduator)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", address(c), kind == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            address(0),
            TARGET,
            kind,
            kind == Sinks.CREATOR ? routed : address(0),
            taxBps,
            taxBps == 0 ? address(0) : tax,
            TREASURY,
            graduator,
            address(sink)
        );
    }

    function _market(uint8 kind, uint16 taxBps) internal returns (BondingCurve c, DokuToken t) {
        return _market(kind, taxBps, CREATOR_WALLET, TAX_WALLET, address(this));
    }

    function _skipWindow(BondingCurve c) internal {
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
    }

    function _identity(BondingCurve c) internal view {
        assertEq(
            address(c).balance,
            c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax(),
            "the curve holds MON nothing accounts for"
        );
    }

    // ------------------------------------------------------------------------------ the split

    /// 100 MON in: 0.3 to the protocol, 0.7 routed. Where the 0.7 GOES is the sink's business;
    /// that it is 0.7 is not.
    function test_thirtySeventyOnEveryBuy() public {
        for (uint8 kind; kind <= Sinks.CREATOR; ++kind) {
            (BondingCurve c, DokuToken t) = _market(kind, 0);
            _skipWindow(c);
            vm.prank(ALICE);
            c.buy{value: 100e18}(0, block.timestamp);
            assertEq(c.pendingProtocol(), 0.3e18, "protocol share is not 30 bps");
            if (kind == Sinks.BURN) {
                // Spent on the curve: inside the raise, destroyed as tokens, nothing held.
                assertEq(c.pendingFees(), 0, "a BURN market held quote for its sink");
                assertEq(c.quoteRaised(), 99.7e18, "the routed share did not reach the curve");
                assertGt(c.burnedByTax(), 0, "nothing was burned");
                assertEq(t.totalSupply(), t.TOTAL_SUPPLY() - c.burnedByTax(), "supply did not fall");
            } else {
                assertEq(c.pendingFees(), 0.7e18, "routed share is not 70 bps");
                assertEq(c.quoteRaised(), 99e18, "the routed share leaked into the raise");
                assertEq(c.burnedByTax(), 0, "a quote-paid sink burned supply");
            }
            _identity(c);
        }
    }

    function test_thirtySeventyOnEverySell() public {
        for (uint8 kind; kind <= Sinks.CREATOR; ++kind) {
            (BondingCurve c, DokuToken t) = _market(kind, 0);
            _skipWindow(c);
            vm.startPrank(ALICE);
            uint256 got = c.buy{value: 100e18}(0, block.timestamp);
            uint256 protocolBefore = c.pendingProtocol();
            uint256 feesBefore = c.pendingFees();
            uint256 burnedBefore = c.burnedByTax();
            t.approve(address(c), got);
            uint256 received = c.sell(got, 0, block.timestamp);
            vm.stopPrank();

            // received = gross - 1%, so gross = received / 0.99, and the two shares are 30 and 70
            // bps of it. Asserted as a ratio so flooring is not confused with a wrong rate.
            uint256 protocolCut = c.pendingProtocol() - protocolBefore;
            assertApproxEqRel(protocolCut * 9_900, received * 30, 1e12, "sell protocol share is not 30 bps");
            if (kind == Sinks.BURN) {
                assertEq(c.pendingFees(), 0, "a BURN market held quote on a sell");
                assertGt(c.burnedByTax(), burnedBefore, "the sell leg burned nothing");
            } else {
                uint256 routedCut = c.pendingFees() - feesBefore;
                assertApproxEqRel(routedCut * 9_900, received * 70, 1e12, "sell routed share is not 70 bps");
                assertEq(c.burnedByTax(), burnedBefore, "a quote-paid sink burned on a sell");
            }
            _identity(c);
        }
    }

    /// A BURN market's sell-side share is bought back at the POST-SALE price and destroyed — never
    /// held. `quoteRaised` therefore falls by the gross and rises by the routed share.
    function test_aBurnMarketSpendsItsSellShareOnTheCurve() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN, 0);
        _skipWindow(c);
        vm.startPrank(ALICE);
        uint256 got = c.buy{value: 100e18}(0, block.timestamp);
        uint256 raisedBefore = c.quoteRaised();
        t.approve(address(c), got);
        (uint256 quoted, uint256 fee,) = c.quoteSell(got);
        c.sell(got, 0, block.timestamp);
        vm.stopPrank();
        uint256 gross = quoted + fee;
        uint256 routed = fee - (gross * 30) / 10_000;
        assertEq(c.quoteRaised(), raisedBefore - gross + routed, "the routed share was not re-spent on the curve");
        _identity(c);
    }

    function test_collectProtocolFeesPaysTheTreasury() public {
        (BondingCurve c,) = _market(Sinks.CREATOR, 0);
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        uint256 before = TREASURY.balance;
        c.collectProtocolFees();
        assertEq(TREASURY.balance - before, 0.3e18);
        assertEq(c.pendingProtocol(), 0);
        assertEq(c.pendingFees(), 0.7e18, "the protocol sweep took the routed share");
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.collectProtocolFees();
    }

    // ------------------------------------------------------------------------------- the fill

    /// The raise lands on the target EXACTLY on every sink, at every creator tax rate the launch
    /// form allows, taxed or not. The fixed graduation seed depends on it, and each combination
    /// reaches the target through a different set of ceilings.
    function testFuzz_theRaiseLandsExactlyOnTargetEverySinkEveryTax(
        uint8 kind,
        uint16 taxBps,
        bool taxed,
        uint96 pre
    ) public {
        kind = uint8(bound(kind, 0, 2));
        taxBps = uint16(bound(taxBps, 0, 100) * 10);
        pre = uint96(bound(pre, 1, 900e18));
        (BondingCurve c,) = _market(kind, taxBps);
        if (!taxed) _skipWindow(c);
        vm.startPrank(ALICE);
        c.buy{value: pre}(0, block.timestamp);
        _identity(c);
        if (!c.readyToGraduate()) c.buy{value: 9_000e18}(0, block.timestamp);
        vm.stopPrank();
        assertEq(c.quoteRaised(), TARGET, "overshot or undershot");
        assertTrue(c.readyToGraduate());
        _identity(c);
        assertGe(c.seedBase(), DOKU_SEED_BASE, "seed short");
        assertLe(c.seedBase() - DOKU_SEED_BASE, 1e6, "seed dust out of range");
    }

    /// The quote IS the fill, for every levy, on every sink, at every creator tax rate.
    function testFuzz_quoteBuyAndQuoteSellMatchTheFill(
        uint8 kind,
        uint16 taxBps,
        bool taxed,
        uint96 amt
    ) public {
        kind = uint8(bound(kind, 0, 2));
        taxBps = uint16(bound(taxBps, 0, 100) * 10);
        amt = uint96(bound(amt, 1, 5_000e18));
        (BondingCurve c, DokuToken t) = _market(kind, taxBps);
        if (!taxed) _skipWindow(c);
        (uint256 q, uint256 fee, uint256 antiSniper, uint256 tax, uint256 refund) = c.quoteBuy(amt);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        uint256 got = c.buy{value: amt}(0, block.timestamp);
        assertEq(got, q, "quoteBuy disagreed with the fill");
        assertEq(before - ALICE.balance, uint256(amt) - refund, "quoted refund wrong");
        assertEq(c.pendingProtocol() + (kind == Sinks.BURN ? fee - c.pendingProtocol() : c.pendingFees()), fee, "quoted fee wrong");
        assertEq(c.taxEscrow(), antiSniper, "quoted anti-sniper tax wrong");
        assertEq(c.pendingTax(), tax, "quoted creator tax wrong");
        _identity(c);
        if (got == 0 || c.readyToGraduate()) return;
        (uint256 so,,) = c.quoteSell(got);
        vm.startPrank(ALICE);
        t.approve(address(c), got);
        // A round trip on a dust buy can price back to nothing, and R20 refuses that sale rather
        // than booking it for free. The quote is the same arithmetic, so it says so too — asserted
        // here rather than skipped, because "the quote IS the fill" has to hold at zero as well.
        if (so == 0) {
            vm.expectRevert(BondingCurve.ZeroOutput.selector);
            c.sell(got, 0, block.timestamp);
            vm.stopPrank();
            _identity(c);
            return;
        }
        uint256 out = c.sell(got, 0, block.timestamp);
        vm.stopPrank();
        assertEq(out, so, "quoteSell disagreed with the fill");
        assertLe(out, amt, "a round trip extracted value");
        _identity(c);
    }

    /// The same target costs MORE to fill on a quote-paid sink than on BURN, by the routed share
    /// grossed up by the protocol's 30 bps — because on BURN the share is inside the raise.
    function test_theSameTargetFillsAtDifferentTotalsOnTheTwoCurrencies() public {
        (BondingCurve b,) = _market(Sinks.BURN, 0);
        (BondingCurve r,) = _market(Sinks.REWARDS, 0);
        _skipWindow(b);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        b.buy{value: 5_000e18}(0, block.timestamp);
        uint256 burnOutlay = before - ALICE.balance;
        before = ALICE.balance;
        vm.prank(ALICE);
        r.buy{value: 5_000e18}(0, block.timestamp);
        uint256 rewardsOutlay = before - ALICE.balance;
        assertEq(b.quoteRaised(), r.quoteRaised());
        assertGt(rewardsOutlay, burnOutlay);
        uint256 gap = rewardsOutlay - burnOutlay;
        assertApproxEqAbs((gap * (10_000 - 30)) / 10_000, r.pendingFees(), 2, "the gap is not the routed share grossed up");
    }

    /// The MON needed to fill a curve does not depend on the anti-sniper rate: the tax is SPENT
    /// on the curve, not skimmed off the raise, so `quoteRaised` counts it.
    function test_theBuyerOutlayToFillIsIndependentOfTheTaxRate() public {
        (BondingCurve taxed,) = _market(Sinks.BURN, 0);
        uint256 before = ALICE.balance;
        vm.prank(ALICE);
        taxed.buy{value: 5_000e18}(0, block.timestamp);
        uint256 taxedOutlay = before - ALICE.balance;
        (BondingCurve clean,) = _market(Sinks.BURN, 0);
        _skipWindow(clean);
        before = ALICE.balance;
        vm.prank(ALICE);
        clean.buy{value: 5_000e18}(0, block.timestamp);
        assertEq(taxedOutlay, before - ALICE.balance, "the tax rate changed what filling the curve costs");
        assertGt(taxed.burnedByTax(), clean.burnedByTax());
    }

    /// A filled curve always retains the seed, even under the maximum burn: fill INSIDE the window
    /// on every sink, where every leg that can eat the residue does.
    function test_aFilledCurveAlwaysCoversTheSeedEvenAtMaximumBurn() public {
        for (uint8 kind; kind <= Sinks.CREATOR; ++kind) {
            (BondingCurve c, DokuToken t) = _market(kind, 1000);
            vm.prank(ALICE);
            c.buy{value: 9_000e18}(0, block.timestamp);
            assertTrue(c.readyToGraduate(), "did not fill");
            assertGe(t.balanceOf(address(c)), DOKU_SEED_BASE, "residue is short of the seed");
            assertGe(c.seedBase(), DOKU_SEED_BASE, "latched seed is short");
        }
    }

    /// Every bucket survives `release` — each is owed to someone who is not the pool.
    function test_releaseLeavesEveryPendingBucketBehind() public {
        MockGraduator g = new MockGraduator();
        (BondingCurve c,) = _market(Sinks.REWARDS, 100, CREATOR_WALLET, TAX_WALLET, address(g));
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 5_000e18}(0, block.timestamp);
        uint256 fees = c.pendingFees();
        uint256 prot = c.pendingProtocol();
        uint256 tax = c.pendingTax();
        assertTrue(fees > 0 && prot > 0 && tax > 0, "nothing accrued, so this proves nothing");
        g.release(c);
        assertEq(c.quoteRaised(), 0);
        assertEq(c.pendingFees(), fees);
        assertEq(c.pendingProtocol(), prot);
        assertEq(c.pendingTax(), tax, "release took the creator tax");
        assertEq(address(c).balance, fees + prot + tax, "what is left is not exactly the three buckets");
    }

    // ------------------------------------------------------------ what the interface reads

    /// `feeRecipient()` is compared to the connected wallet to decide whether to show "claim".
    /// A CREATOR market answers its wallet; the other two answer the sink — which does not exist
    /// before graduation, so zero — and both read as "not yours", which is the intent.
    function test_feeRecipientPerSink() public {
        MockGraduator g = new MockGraduator();
        (BondingCurve creator,) = _market(Sinks.CREATOR, 0, CREATOR_WALLET, TAX_WALLET, address(g));
        (BondingCurve rewards,) = _market(Sinks.REWARDS, 0, CREATOR_WALLET, TAX_WALLET, address(g));
        (BondingCurve burn,) = _market(Sinks.BURN, 0, CREATOR_WALLET, TAX_WALLET, address(g));
        assertEq(creator.feeRecipient(), CREATOR_WALLET);
        assertEq(rewards.feeRecipient(), address(0), "no sink exists before graduation");
        assertEq(burn.feeRecipient(), address(0));

        _skipWindow(rewards);
        vm.prank(ALICE);
        rewards.buy{value: 5_000e18}(0, block.timestamp);
        g.release(rewards);
        g.setSink(address(0x5111C));
        assertEq(rewards.feeRecipient(), address(0x5111C), "after graduation the sink is the recipient");
        assertEq(creator.feeRecipient(), CREATOR_WALLET, "a CREATOR market never changes its answer");
    }

    /// A graduator that cannot answer `sinkOf` (this test contract) must not make the view revert.
    function test_feeRecipientToleratesAGraduatorWithoutSinkOf() public {
        (BondingCurve c,) = _market(Sinks.REWARDS, 0);
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 5_000e18}(0, block.timestamp);
        c.release();
        assertEq(c.feeRecipient(), address(0));
    }

    // ----------------------------------------------------------------------------- collection

    function test_collectFeesPushesToTheRoutedRecipient() public {
        (BondingCurve c,) = _market(Sinks.CREATOR, 0);
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        uint256 before = CREATOR_WALLET.balance;
        vm.prank(address(0xA11));
        c.collectFees();
        assertEq(CREATOR_WALLET.balance - before, 0.7e18, "the routed share did not reach the wallet");
        assertEq(c.pendingFees(), 0);
        assertEq(sink.credits(), 0, "a successful push was also deferred");
        _identity(c);
    }

    /// A REWARDS market's share is escrowed until there is a vault to pay, then credited to the
    /// hook's ledger THROUGH the graduator — never pushed into the vault.
    function test_aRewardsMarketEscrowsUntilGraduationThenCreditsTheGraduator() public {
        MockGraduator g = new MockGraduator();
        (BondingCurve c,) = _market(Sinks.REWARDS, 0, CREATOR_WALLET, TAX_WALLET, address(g));
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        assertEq(c.pendingFees(), 0.7e18);
        vm.expectRevert(BondingCurve.NotGraduated.selector);
        c.collectFees();

        vm.prank(ALICE);
        c.buy{value: 5_000e18}(0, block.timestamp);
        uint256 escrow = c.pendingFees();
        g.release(c);
        assertEq(c.pendingFees(), escrow, "release took the holders' share");
        c.collectFees();
        assertEq(g.lastCurve(), address(c));
        assertEq(g.lastAmount(), escrow);
        assertEq(g.received(), escrow, "the escrow did not travel with the credit");
        assertEq(c.pendingFees(), 0);
        assertEq(address(c).balance, c.pendingProtocol(), "something other than the protocol's share is left");
    }

    function test_aBurnMarketHasNothingToCollect() public {
        (BondingCurve c,) = _market(Sinks.BURN, 0);
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.collectFees();
    }

    /// A wallet that cannot receive blocks nobody: the money is credited to the shared sink for
    /// the recipient to pull, and the caller's transaction succeeds.
    function test_collectFeesDefersToTheSinkWhenThePushFails() public {
        Rejecter rj = new Rejecter();
        (BondingCurve c,) = _market(Sinks.CREATOR, 100, address(rj), address(rj), address(this));
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);

        c.collectFees();
        assertEq(sink.lastWho(), address(rj));
        assertEq(sink.lastQuote(), address(0));
        assertEq(sink.lastAmount(), 0.7e18);
        assertEq(sink.received(), 0.7e18, "the deferred value did not travel with the credit");
        assertEq(c.pendingFees(), 0);

        c.collectTax();
        assertEq(sink.lastAmount(), 1e18, "the tax was not deferred");
        assertEq(sink.received(), 1.7e18);
        assertEq(c.pendingTax(), 0);
        _identity(c);
    }

    /// Without a sink there is nowhere to defer to, so the collection reverts — and trading does
    /// not, which is the property the pull shape exists for.
    function test_withoutASinkAFailedPushRevertsTheCollectionOnly() public {
        Rejecter rj = new Rejecter();
        BondingCurve c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), TARGET, Sinks.CREATOR, address(rj), 0, address(0), TREASURY, address(this), address(0));
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        vm.expectRevert(BondingCurve.TransferFailed.selector);
        c.collectFees();
        vm.prank(ALICE);
        c.buy{value: 10e18}(0, block.timestamp);
        assertEq(c.pendingFees(), 0.77e18, "the failed collection lost the accrual");
    }

    // ---------------------------------------------------------------------------- creator tax

    function test_creatorTaxOnBuyAndSell() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.CREATOR, 500); // 5%
        _skipWindow(c);
        vm.startPrank(ALICE);
        uint256 got = c.buy{value: 100e18}(0, block.timestamp);
        assertEq(c.pendingTax(), 5e18, "buy tax is not 5% of MON in");
        assertEq(c.pendingProtocol(), 0.3e18);
        assertEq(c.pendingFees(), 0.7e18);
        assertEq(c.quoteRaised(), 94e18, "the tax was counted toward the raise");

        t.approve(address(c), got);
        (uint256 quoted, uint256 fee, uint256 tax) = c.quoteSell(got);
        uint256 received = c.sell(got, 0, block.timestamp);
        vm.stopPrank();
        assertEq(received, quoted);
        assertEq(tax, ((quoted + fee + tax) * 500) / 10_000, "sell tax is not 5% of the gross");
        assertEq(c.pendingTax(), 5e18 + tax, "sell tax not accrued");
        _identity(c);
    }

    function test_theTaxIsChargedOnEverySink() public {
        for (uint8 kind; kind <= Sinks.CREATOR; ++kind) {
            (BondingCurve c,) = _market(kind, 1000);
            _skipWindow(c);
            vm.prank(ALICE);
            c.buy{value: 100e18}(0, block.timestamp);
            assertEq(c.pendingTax(), 10e18, "10% tax not charged");
            assertEq(c.taxRecipient(), TAX_WALLET);
            _identity(c);
        }
    }

    function test_collectTaxPaysTheTaxRecipient() public {
        (BondingCurve c,) = _market(Sinks.BURN, 250);
        _skipWindow(c);
        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        uint256 before = TAX_WALLET.balance;
        c.collectTax();
        assertEq(TAX_WALLET.balance - before, 2.5e18);
        assertEq(c.pendingTax(), 0);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        c.collectTax();
    }

    // ------------------------------------------------------------------------------- buyFor

    function test_buyForIsTheFactorysAlone() public {
        (BondingCurve c,) = _market(Sinks.CREATOR, 100);
        vm.deal(address(0xBAD), 10e18);
        vm.prank(address(0xBAD));
        vm.expectRevert(BondingCurve.NotFactory.selector);
        c.buyFor{value: 1e18}(address(0xBAD), 1e18, 0, block.timestamp);
    }

    /// The launch buy is exempt from the anti-sniper rate ONLY. It pays the fee and the creator
    /// tax like any other buy, and the creator's next buy is taxed like anyone's.
    function test_buyForSkipsTheAntiSniperRateButNothingElse() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.CREATOR, 100);
        assertEq(c.taxRate(), c.TAX_START_BPS(), "premise: the window is open");
        // This test contract initialised the curve, so it is the factory.
        uint256 got = c.buyFor{value: 100e18}(ALICE, 100e18, 0, block.timestamp);
        assertEq(t.balanceOf(ALICE), got, "tokens did not go to the recipient");
        assertEq(c.taxEscrow(), 0, "the launch buy was anti-sniped");
        assertEq(c.burnedByTax(), 0);
        assertEq(c.pendingProtocol(), 0.3e18);
        assertEq(c.pendingFees(), 0.7e18);
        assertEq(c.pendingTax(), 1e18);
        _identity(c);

        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        assertGt(c.taxEscrow(), 0, "the creator's second buy was not taxed");
    }

    function test_buyForRequiresTheExactValueAndRefundsTheRecipient() public {
        (BondingCurve c,) = _market(Sinks.BURN, 0);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.ValueMismatch.selector, 1e18, 2e18));
        c.buyFor{value: 1e18}(ALICE, 2e18, 0, block.timestamp);
        _skipWindow(c);
        uint256 before = ALICE.balance;
        c.buyFor{value: 5_000e18}(ALICE, 5_000e18, 0, block.timestamp);
        assertTrue(c.readyToGraduate());
        assertGt(ALICE.balance, before, "the overshoot was not refunded to the recipient");
    }

    // -------------------------------------------------------------------------------- events

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

    /// The indexer's `fee_events` rows come from these two logs alone.
    function test_boughtAndSoldCarryEveryLevy() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.CREATOR, 500);
        _skipWindow(c);
        vm.recordLogs();
        vm.prank(ALICE);
        uint256 got = c.buy{value: 100e18}(0, block.timestamp);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Bought.selector) continue;
            (uint256 quoteIn, uint256 baseOut, uint256 fee, uint256 sniper, uint256 tax, uint256 raised,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256));
            assertEq(quoteIn, 94e18, "quoteIn is not the buyer's own leg");
            assertEq(baseOut, got);
            assertEq(fee, 1e18);
            assertEq(sniper, 0);
            assertEq(tax, 5e18);
            assertEq(raised, 94e18);
            found = true;
        }
        assertTrue(found, "no Bought");

        vm.startPrank(ALICE);
        t.approve(address(c), got);
        vm.recordLogs();
        c.sell(got, 0, block.timestamp);
        vm.stopPrank();
        logs = vm.getRecordedLogs();
        found = false;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != Sold.selector) continue;
            (uint256 baseIn,, uint256 fee, uint256 tax, uint256 raised,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256));
            assertEq(baseIn, got);
            assertGt(fee, 0);
            assertGt(tax, 0);
            assertEq(raised, c.quoteRaised());
            found = true;
        }
        assertTrue(found, "no Sold");
    }
}
