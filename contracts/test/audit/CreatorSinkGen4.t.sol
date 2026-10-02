// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {HookStub, GraduatorStub, FactoryStub, FeeOnTransferQuote, CappedQuote} from "./SinksHunt.t.sol";

/// @dev `SinksHunt`'s `CurveStub` is typed to the FROZEN generation-3 sink, so it cannot be reused
///      here. Same shape, pointed at the patched contract: `payOrCredit` is still a byte-for-byte
///      copy of `BondingCurve._payOrCredit`, so the deferred path under test stays the production
///      one on both sides of the pair.
contract Gen4CurveStub {
    address public feeRecipient;
    address public quoteAsset;
    CreatorSink public sink;

    constructor(CreatorSink s, address routed, address quote) {
        sink = s;
        feeRecipient = routed;
        quoteAsset = quote;
    }

    receive() external payable {}

    function payOrCredit(address to, uint256 amount) external {
        if (_tryPay(to, amount)) return;
        if (quoteAsset == address(0)) {
            sink.credit{value: amount}(to, address(0), amount);
        } else {
            IERC20(quoteAsset).approve(address(sink), 0);
            IERC20(quoteAsset).approve(address(sink), amount);
            sink.credit(to, quoteAsset, amount);
        }
    }

    function _tryPay(address to, uint256 amount) private returns (bool) {
        if (quoteAsset == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            return sent;
        }
        (bool ok, bytes memory ret) = quoteAsset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || abi.decode(ret, (bool)));
    }
}

/// @notice The other half of `SinksHunt.t.sol`.
///
///         `SinksHunt` proves the losses exist in the generation-3 `CreatorSink`. Every test here
///         is the mirror of one of those, run against the patched contract, and asserts that the
///         same sequence now ends with the money reachable. They are paired deliberately: if a
///         later refactor undoes a fix, the hunt test goes green and the proof here goes red.
///         Either one on its own would be ambiguous.
///
///         | Finding | Loss in generation 3 | What answers it now |
///         |---|---|---|
///         | A1 / internal #8 | `credit` booked what it was TOLD | `InexactTransfer` |
///         | B1 | a frozen recipient's balance, unreachable for ever | `claim(quote, amount, to)` |
///         | B2 | a per-transfer cap blocked the whole claim for ever | `claim(quote, amount, to)` |
///         | B3 | bare native, and a self-named recipient, both dead ends | `receive` gate + `SinkIsNotARecipient` |
contract CreatorSinkGen4Test is Test {
    address internal constant OWNER = address(0x01);
    address internal constant ROUTED_A = address(0xA0);
    address internal constant TAX_A = address(0xA1);
    PoolId internal constant ID_A = PoolId.wrap(bytes32(uint256(0xA)));

    CreatorSink internal sink;
    HookStub internal hook;
    FactoryStub internal factory;
    address internal GRADUATOR;

    receive() external payable {}

    function setUp() public {
        hook = new HookStub();
        factory = new FactoryStub();
        GRADUATOR = address(new GraduatorStub(address(hook)));
        sink = new CreatorSink(OWNER);
        vm.startPrank(OWNER);
        sink.setGraduator(GRADUATOR);
        sink.setFactory(address(factory));
        vm.stopPrank();
        vm.deal(address(hook), 1_000 ether);
    }

    /// @dev A registered CREATOR market paying in `quote`, credited with `owed` through the hook.
    function _market(address quote, uint256 owed) internal returns (address market) {
        market = address(new Gen4CurveStub(sink, ROUTED_A, quote));
        factory.set(market, true);
        vm.prank(GRADUATOR);
        sink.register(market, ID_A, quote, ROUTED_A, TAX_A);
        hook.set(ID_A, quote, 0, owed, 0);
        sink.pull(market);
    }

    // =====================================================================================
    // B1 — a freeze is now an inconvenience, not a loss.
    // =====================================================================================

    /// The generation-3 sequence exactly: 8,000 USDC credited, then the issuer freezes the
    /// creator's wallet. There, `claim` reverted for ever and `transferRecipient` moved only
    /// future income. Here the creator names a destination they still control and walks out with
    /// all of it.
    function test_B1_aFrozenRecipientCanStillReachTheirMoney() public {
        MockUSDC q = new MockUSDC();
        q.mint(address(hook), 10_000e6);
        _market(address(q), 8_000e6);
        assertEq(sink.claimable(ROUTED_A, address(q)), 8_000e6);

        q.setBlocked(ROUTED_A, true); // the issuer freezes the creator's wallet

        // The old call still fails, and must — it pays the frozen address by definition.
        vm.prank(ROUTED_A);
        vm.expectRevert();
        sink.claim(address(q));

        // The new one does not. Same ledger entry, a destination that is not frozen.
        address fresh = address(0xFEED);
        vm.prank(ROUTED_A);
        sink.claim(address(q), 8_000e6, fresh);

        assertEq(q.balanceOf(fresh), 8_000e6, "the money did not arrive");
        assertEq(sink.claimable(ROUTED_A, address(q)), 0, "the ledger entry did not clear");
    }

    /// Naming a destination spends only your OWN entry. It is a withdrawal instruction, not a
    /// redirect — the property the pull-payment design rests on, asserted rather than assumed.
    function test_B1b_namingADestinationCannotTouchAnyoneElsesBalance() public {
        MockUSDC q = new MockUSDC();
        q.mint(address(hook), 10_000e6);
        _market(address(q), 8_000e6);

        // `ClaimTooLarge(asked, 0)` rather than `NothingToClaim`: the ledger is read before the
        // emptiness is, and reporting the owed figure as zero says more than "nothing" does.
        address stranger = address(0xBAD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CreatorSink.ClaimTooLarge.selector, 8_000e6, 0));
        sink.claim(address(q), 8_000e6, stranger);

        assertEq(sink.claimable(ROUTED_A, address(q)), 8_000e6, "a stranger moved it");
    }

    // =====================================================================================
    // B2 — a per-transfer cap is now paid out in pieces.
    // =====================================================================================

    /// 1,000e18 owed, a 100e18 cap lands. Generation 3 had no `amount`, so the balance was
    /// unclaimable for ever. Ten claims empty it.
    function test_B2_aCappedQuoteIsClaimedInPieces() public {
        CappedQuote q = new CappedQuote();
        q.mint(address(hook), 1_000e18);
        _market(address(q), 1_000e18);

        q.setCap(100e18); // the upgrade lands

        vm.prank(ROUTED_A);
        vm.expectRevert(); // the full-balance claim still cannot fit under the cap
        sink.claim(address(q));

        for (uint256 i = 0; i < 10; i++) {
            vm.prank(ROUTED_A);
            sink.claim(address(q), 100e18, ROUTED_A);
        }

        assertEq(q.balanceOf(ROUTED_A), 1_000e18, "not all of it came out");
        assertEq(sink.claimable(ROUTED_A, address(q)), 0, "ledger not cleared");
    }

    /// A partial claim may never exceed what is owed, and the remainder must survive it.
    function test_B2b_aPartialClaimIsBoundedByTheLedger() public {
        MockUSDC q = new MockUSDC();
        q.mint(address(hook), 10_000e6);
        _market(address(q), 8_000e6);

        vm.prank(ROUTED_A);
        vm.expectRevert(abi.encodeWithSelector(CreatorSink.ClaimTooLarge.selector, 8_000e6 + 1, 8_000e6));
        sink.claim(address(q), 8_000e6 + 1, ROUTED_A);

        vm.prank(ROUTED_A);
        sink.claim(address(q), 3_000e6, ROUTED_A);
        assertEq(sink.claimable(ROUTED_A, address(q)), 5_000e6, "remainder wrong");
    }

    // =====================================================================================
    // B3 — the two dead ends are now closed doors.
    // =====================================================================================

    /// Bare native used to be accepted, credited to nobody, and unable to leave. It now bounces,
    /// which is the only outcome that tells the sender anything.
    function test_B3_bareNativeBouncesAndTheSinkIsNobodysRecipient() public {
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(sink).call{value: 5 ether}("");
        assertFalse(ok, "receive() still accepts a bare send");
        assertEq(address(sink).balance, 0, "native stuck in the sink");

        // The hook is still able to pay, which is the entire reason `receive` exists.
        vm.prank(address(hook));
        (bool hookOk,) = address(sink).call{value: 1 ether}("");
        assertTrue(hookOk, "the hook can no longer pay the sink");

        // And the sink can no longer be named as a recipient, from either door.
        address market = address(new Gen4CurveStub(sink, address(sink), address(0)));
        factory.set(market, true);
        vm.prank(GRADUATOR);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.register(market, ID_A, address(0), address(sink), TAX_A);

        address good = address(new Gen4CurveStub(sink, ROUTED_A, address(0)));
        factory.set(good, true);
        vm.deal(good, 1 ether);
        vm.prank(good);
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.credit{value: 1 ether}(address(sink), address(0), 1 ether);
    }

    // =====================================================================================
    // A1 / internal #8 — `credit` books what ARRIVED.
    // =====================================================================================

    /// A quote that takes a cut in transit used to leave the shared balance short by that cut,
    /// and the shortfall was borne by whoever claimed LAST in that asset — in any market. The
    /// credit is now refused at the door instead.
    function test_A1_anUnderDeliveringQuoteCannotOverCreditTheSharedLedger() public {
        FeeOnTransferQuote q = new FeeOnTransferQuote(100); // 1% skimmed in transit
        address market = address(new Gen4CurveStub(sink, ROUTED_A, address(q)));
        factory.set(market, true);
        q.mint(market, 1_000e18);

        vm.prank(market);
        IERC20(address(q)).approve(address(sink), 1_000e18);
        vm.prank(market);
        vm.expectRevert(abi.encodeWithSelector(CreatorSink.InexactTransfer.selector, 1_000e18, 990e18));
        sink.credit(ROUTED_A, address(q), 1_000e18);

        assertEq(sink.claimable(ROUTED_A, address(q)), 0, "an over-credit was booked");
    }

    /// The invariant the whole contract rests on, asserted directly: what the ledger promises in
    /// a quote is never more than what the contract holds in it.
    function test_A1b_theSharedLedgerNeverExceedsTheHeldBalance() public {
        MockUSDC q = new MockUSDC();
        q.mint(address(hook), 10_000e6);
        _market(address(q), 8_000e6);

        assertLe(
            sink.claimable(ROUTED_A, address(q)) + sink.claimable(TAX_A, address(q)),
            q.balanceOf(address(sink)),
            "the sink promises more than it holds"
        );
    }
}
