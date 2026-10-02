// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve, DOKU_SEED_BASE} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockGraduator} from "./mocks/MockGraduator.sol";
import {MockCreatorSink} from "./mocks/MockCreatorSink.sol";

/// @notice The 1,000,000,000 supply, its 7:5:2 curve shape, and what a 6-decimal quote does to it.
///
/// @dev Every number here was MEASURED against the contract and then pinned, because the 6-decimal
///      paths are the ones the 18-decimal fuzz never reaches: a token is worth 2 raw USDC, the
///      protocol's 30 bps of that is zero, and every sell's one-raw-unit rounding is worth
///      `base / quoteCeiling` of `k` — about 1e17 base wei on an 8,000 USDC market — which lands
///      in the graduation seed as dust that an absolute wei tolerance cannot cover.
contract Supply1BTest is Test {
    address constant ALICE = address(0xA11CE);
    address constant TREASURY = address(0x7EA);
    uint256 constant MON_TARGET = 1_000e18;
    uint256 constant USDC_TARGET = 8_000e6;

    address curveImpl;
    address tokenImpl;
    MockUSDC usdc;

    receive() external payable {}

    function setUp() public {
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        usdc = new MockUSDC();
        usdc.mint(ALICE, 10_000_000e6);
        vm.deal(ALICE, 1_000_000e18);
    }

    function _market(address quote, uint256 target) internal returns (BondingCurve c, DokuToken t) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), quote, target, Sinks.BURN, address(0), 0, address(0), TREASURY, address(this), address(0));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
    }

    // ----------------------------------------------------------------------------- the shape

    function test_theConstantsKeepTheSevenFiveTwoShape() public {
        (BondingCurve c, DokuToken t) = _market(address(0), MON_TARGET);
        assertEq(t.TOTAL_SUPPLY(), 1_000_000_000e18, "supply is not one billion");
        assertEq(c.CURVE_SUPPLY(), 777_777_778e18, "curve supply moved");
        assertEq(c.BASE_VIRTUAL_CEILING() - c.BASE_VIRTUAL_FLOOR(), c.CURVE_SUPPLY(), "span != curve supply");
        assertEq(uint256(c.BASE_VIRTUAL_CEILING()) * 5, c.CURVE_SUPPLY() * 7, "ceiling is not 7/5 of the curve");
        assertEq(uint256(c.BASE_VIRTUAL_FLOOR()) * 5, c.CURVE_SUPPLY() * 2, "floor is not 2/5 of the curve");
        // The seed is what is left, and it is 2/7 of the curve — the graduation constant is
        // DERIVED from these two, never restated.
        assertEq(DOKU_SEED_BASE, t.TOTAL_SUPPLY() - c.CURVE_SUPPLY(), "seed is not the remainder");
        // 2/7 to whole-token rounding: 777,777,778 x 2/7 = 222,222,222.29, and the seed is a
        // whole number of tokens.
        assertApproxEqAbs(DOKU_SEED_BASE * 7, c.CURVE_SUPPLY() * 2, 2e18, "seed is not 2/7 of the curve");
    }

    /// One untaxed buy fills the curve with at most one wei of rounding residue (the retained
    /// reserve rounds up once), so the latched seed is the constant to within a wei — in the pool's
    /// favour.
    function test_theSeedAtAnExactFillIsTwoSeventhsOfTheCurve() public {
        (BondingCurve c, DokuToken t) = _market(address(0), MON_TARGET);
        vm.prank(ALICE);
        c.buy{value: 5_000e18}(0, block.timestamp);
        assertTrue(c.readyToGraduate());
        assertGe(c.seedBase(), DOKU_SEED_BASE, "the seed is short");
        assertLe(c.seedBase() - DOKU_SEED_BASE, 1, "one clean fill should latch the seed to within a wei");
        assertEq(t.balanceOf(address(c)), c.seedBase(), "the residue is not the latched seed");
        assertEq(c.quoteRaised(), MON_TARGET);
    }

    // ------------------------------------------------------------------ a six-decimal quote

    /// Amounts are raw units, so an 8,000 USDC market opens with a virtual quote of 3.2e9 and a
    /// whole token is worth two raw units. The interface scales by `decimals`; the curve does not.
    function test_aSixDecimalMarketPricesInRawUnits() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), USDC_TARGET);
        (, uint128 q) = c.reserves();
        assertEq(q, 3_200_000_000, "virtual quote floor is not 0.4 x target in raw units");

        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        uint256 got = c.buyWithToken(1e6, 0, block.timestamp);
        assertEq(got / 1e18, 336_769, "one USDC does not buy the measured 336,769 tokens");
        (uint256 oneToken,,) = c.quoteSell(1e18);
        assertEq(oneToken, 2, "one token is not the measured 2 raw units");
        t.approve(address(c), type(uint256).max);
        vm.stopPrank();
    }

    /// A sell whose proceeds round to nothing is refused OUTRIGHT, whatever the floor. It used to
    /// run at `minQuoteOut = 0` and keep the tokens on the curve, which is pool-favouring but is
    /// still the seller paying tokens for nothing — and zero satisfies any floor, so `minQuoteOut`
    /// can never be the guard against it.
    function test_minQuoteOutAtDust() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), USDC_TARGET);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        c.buyWithToken(1e6, 0, block.timestamp);
        t.approve(address(c), type(uint256).max);
        (uint256 out,,) = c.quoteSell(1e17);
        assertEq(out, 0, "a tenth of a token should be worth nothing here");
        uint256 before = usdc.balanceOf(ALICE);
        uint256 heldBefore = t.balanceOf(ALICE);
        vm.expectRevert(BondingCurve.ZeroOutput.selector);
        c.sell(1e17, 1, block.timestamp);
        vm.expectRevert(BondingCurve.ZeroOutput.selector);
        c.sell(1e17, 0, block.timestamp);
        assertEq(usdc.balanceOf(ALICE), before, "a zero-proceeds sell paid something");
        assertEq(t.balanceOf(ALICE), heldBefore, "the curve kept tokens it paid nothing for");
        vm.stopPrank();
    }

    function test_theWrongEntryPointIsRefusedByName() public {
        (BondingCurve c,) = _market(address(usdc), USDC_TARGET);
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.QuoteIsNotNative.selector);
        c.buy{value: 1e18}(0, block.timestamp);
        (BondingCurve n,) = _market(address(0), MON_TARGET);
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.QuoteIsNative.selector);
        n.buyWithToken(1e6, 0, block.timestamp);
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.QuoteIsNative.selector);
        n.buyWithPermit(1e6, 0, block.timestamp, 0, 0, 0);
    }

    /// The permit and the buy are one transaction; a stale or front-run permit is swallowed and
    /// the existing allowance carries the buy, so the griefer gains nothing.
    function test_buyWithPermitSignsAndBuys() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), USDC_TARGET);
        uint256 pk = 0xA11CE;
        address signer = vm.addr(pk);
        usdc.mint(signer, 10e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                signer, address(c), 5e6, usdc.nonces(signer), deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        // Front-run: someone else lands the same permit first. The buy must still go through.
        usdc.permit(signer, address(c), 5e6, deadline, v, r, s);
        vm.prank(signer);
        uint256 got = c.buyWithPermit(5e6, 0, deadline, v, r, s);
        assertGt(got, 0);
        assertEq(t.balanceOf(signer), got);
        assertEq(usdc.balanceOf(address(c)), 5e6, "the quote did not land on the curve");
        assertEq(
            usdc.balanceOf(address(c)),
            c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax(),
            "balance identity"
        );
    }

    /// The refund on an overshoot and the payout on a sell go out in the quote, never in MON.
    function test_refundsAndPayoutsAreInTheQuote() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), USDC_TARGET);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        uint256 before = usdc.balanceOf(ALICE);
        c.buyWithToken(50_000e6, 0, block.timestamp);
        assertTrue(c.readyToGraduate());
        assertEq(c.quoteRaised(), USDC_TARGET, "fill missed the target");
        assertLt(before - usdc.balanceOf(ALICE), 50_000e6, "the overshoot was not refunded in USDC");
        assertEq(address(c).balance, 0, "a USDC market holds MON");
        vm.stopPrank();
        (uint256 q, uint256 b) = c.release();
        assertEq(q, USDC_TARGET);
        assertEq(usdc.balanceOf(address(this)), USDC_TARGET, "release did not pay the graduator in USDC");
        assertEq(t.balanceOf(address(this)), b);
    }

    /// The protocol's 30 bps is `gross * 30 / 10_000`, which is zero for any gross under 334 raw
    /// — and the whole 1% is zero under 100. Harmless, and asserted rather than discovered.
    function test_theProtocolShareRoundsToZeroBelow334RawAndNowhereElse() public {
        for (uint256 g = 1; g < 1_000; ++g) {
            assertEq((g * 30) / 10_000 == 0, g < 334, "30 bps rounds to zero on the wrong side of 334");
            assertEq((g * 100) / 10_000 == 0, g < 100, "1% rounds to zero on the wrong side of 100");
        }

        (BondingCurve c, DokuToken t) = _market(address(usdc), USDC_TARGET);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        c.buyWithToken(1e6, 0, block.timestamp);
        t.approve(address(c), type(uint256).max);

        uint256 protocolBefore = c.pendingProtocol();
        c.sell(1e18, 0, block.timestamp); // 2 raw gross: no fee, no protocol share, seller gets 2
        assertEq(c.pendingProtocol(), protocolBefore, "a 2-raw sell booked a protocol share");

        (uint256 gross,,) = c.quoteSell(200e18);
        assertEq(gross, 583, "200 tokens are not the measured 583 raw");
        c.sell(200e18, 0, block.timestamp); // 583 raw gross: fee 5, protocol 1, routed 4
        assertEq(c.pendingProtocol(), protocolBefore + 1, "583 raw did not book exactly 1 raw for the protocol");
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(c)), c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax());
    }

    /**
     * Seed dust on a 6-decimal market is bounded by the TRADE COUNT, not by a wei constant.
     *
     * `CurveMath` rounds the retained reserve up. On a buy that is one base wei; on a sell it is
     * one RAW QUOTE UNIT, and at a base/quote ratio of ~1e17 that one unit is worth ~1e17 base
     * wei of `k`. So the residue at fill exceeds the seed by up to
     * `trades * BASE_VIRTUAL_CEILING / (1.4 * quoteTarget)` — 0.1 token after two sells here, and
     * ~100 tokens after a thousand. Economically nothing (5e-10 of the seed); but
     * `DokuGraduation.SEED_DUST_TOLERANCE` is 1e6 wei and reverts `SeedOutOfRange` above it,
     * which under D3 freezes the market with the raise inside. The graduation side must adopt a
     * relative bound before a 6-decimal market can graduate; this test pins the bound it needs.
     */
    function test_seedDustOnASixDecimalMarketIsBoundedByTheTradeCount() public {
        (BondingCurve c, DokuToken t) = _market(address(usdc), USDC_TARGET);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        t.approve(address(c), type(uint256).max);
        c.buyWithToken(1e6, 0, block.timestamp);
        c.sell(1e18, 0, block.timestamp);
        c.buyWithToken(500e6, 0, block.timestamp);
        c.sell(200e18, 0, block.timestamp);
        c.buyWithToken(50_000e6, 0, block.timestamp);
        uint256 trades = 5;
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "did not fill");
        assertEq(c.quoteRaised(), USDC_TARGET, "fill missed the target");
        uint256 excess = c.seedBase() - DOKU_SEED_BASE;
        emit log_named_uint("seed dust (base wei) after 2 sells", excess);
        assertGt(excess, 1e6, "the dust is inside the absolute tolerance, so this test proves nothing");
        uint256 bound = (trades * uint256(c.BASE_VIRTUAL_CEILING())) / ((USDC_TARGET * 14) / 10) + trades;
        assertLe(excess, bound, "dust exceeded the derived per-trade bound");
        assertLe(excess * 1e9, DOKU_SEED_BASE, "dust is more than a billionth of the seed");
        assertEq(usdc.balanceOf(address(c)), c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax());
    }

    /// On an ERC-20 market the escrow reaches the graduator by allowance: approve, then the
    /// two-argument credit. No value travels.
    function test_anERC20RewardsEscrowIsApprovedNotSent() public {
        MockGraduator g = new MockGraduator();
        BondingCurve c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", address(c), true, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(usdc), USDC_TARGET, Sinks.REWARDS, address(0), 0, address(0), TREASURY, address(g), address(0));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        c.buyWithToken(50_000e6, 0, block.timestamp);
        vm.stopPrank();
        g.release(c);
        uint256 escrow = c.pendingFees();
        c.collectFees();
        assertEq(g.lastAmount(), escrow);
        assertEq(g.received(), 0, "value was sent on an ERC-20 market");
        assertEq(usdc.allowance(address(c), address(g)), escrow, "the graduator was not approved for the escrow");
    }

    /// The ERC-20 shape of a wallet that cannot receive is a token that refuses the recipient.
    /// The push returns false, the sink is approved and credited, nothing is stranded.
    function test_anERC20PushThatFailsIsDeferredByAllowance() public {
        MockCreatorSink sink = new MockCreatorSink();
        BondingCurve c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(usdc), USDC_TARGET, Sinks.CREATOR, address(0xC0DE), 0, address(0), TREASURY, address(this), address(sink));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.startPrank(ALICE);
        usdc.approve(address(c), type(uint256).max);
        c.buyWithToken(1_000e6, 0, block.timestamp);
        vm.stopPrank();
        usdc.setBlocked(address(0xC0DE), true);
        c.collectFees();
        assertEq(sink.lastWho(), address(0xC0DE));
        assertEq(sink.lastQuote(), address(usdc));
        assertEq(sink.lastAmount(), 7e6);
        assertEq(usdc.balanceOf(address(sink)), 7e6, "the sink did not pull the credit");
        assertEq(c.pendingFees(), 0);
        assertEq(usdc.balanceOf(address(c)), c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax());
    }
}
