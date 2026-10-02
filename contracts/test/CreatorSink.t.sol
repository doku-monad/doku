// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// The four hook calls the sink makes, with a per-pool quote and settable balances. Pays
/// `msg.sender` the way `DokuHook.pullSink` does, so the sink's delta accounting is what is tested.
contract MockHook {
    mapping(PoolId => address) public quoteOf;
    mapping(PoolId => uint256) public pendingSink;
    mapping(PoolId => uint256) public owedSink;
    mapping(PoolId => uint256) public owedTax;
    /// @dev A market whose sink is not the CreatorSink: `pullSink` hands the CreatorSink nothing,
    ///      as the real hook does for a caller that is not the market's `sinkAddr`.
    mapping(PoolId => bool) public routedIsForeign;
    uint256 public sweeps;

    function setRoutedIsForeign(PoolId id, bool on) external {
        routedIsForeign[id] = on;
    }

    receive() external payable {}

    function set(PoolId id, address quote, uint256 pending, uint256 owed, uint256 tax) external {
        quoteOf[id] = quote;
        pendingSink[id] = pending;
        owedSink[id] = owed;
        owedTax[id] = tax;
    }

    function sweep(PoolId id) external {
        sweeps += 1;
        owedSink[id] += pendingSink[id];
        pendingSink[id] = 0;
    }

    function pullSink(PoolId id) external returns (uint256 amount) {
        if (routedIsForeign[id]) return 0;
        amount = owedSink[id];
        owedSink[id] = 0;
        _pay(quoteOf[id], amount);
    }

    function pullTax(PoolId id) external {
        uint256 amount = owedTax[id];
        owedTax[id] = 0;
        _pay(quoteOf[id], amount);
    }

    function _pay(address quote, uint256 amount) private {
        if (amount == 0) return;
        if (quote == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok, "pay");
        } else {
            IERC20(quote).transfer(msg.sender, amount);
        }
    }
}

contract MockGraduator {
    address public hook;

    constructor(address h) {
        hook = h;
    }
}

contract MockFactory {
    mapping(address => bool) public isMarket;

    function set(address m, bool on) external {
        isMarket[m] = on;
    }
}

/// A curve, as the sink sees it: it answers `feeRecipient()` and forwards a credit.
contract MockMarket {
    address public feeRecipient;
    CreatorSink immutable sink;

    constructor(CreatorSink s, address routed) {
        sink = s;
        feeRecipient = routed;
    }

    receive() external payable {}

    function creditNative(address who, uint256 amount) external {
        sink.credit{value: amount}(who, address(0), amount);
    }

    function creditToken(address who, address quote, uint256 amount) external {
        IERC20(quote).approve(address(sink), amount);
        sink.credit(who, quote, amount);
    }
}

contract Rejecter {
    receive() external payable {
        revert("no");
    }
}

/// @notice The shared creator sink: registered once by the graduator, pulled by anyone, claimed by
///         the owed address alone. Nothing here can block anyone else's money.
contract CreatorSinkTest is Test {
    address constant OWNER = address(0x01);
    address constant VAULT = address(0x7A17);
    address constant MARKET = address(0xCAFE);
    address constant ROUTED = address(0xC0DE);
    address constant TAX = address(0x7A0);
    PoolId constant ID = PoolId.wrap(bytes32(uint256(1)));

    CreatorSink sink;
    MockHook hook;
    MockFactory factory;
    MockUSDC usdc;
    address GRADUATOR;

    function setUp() public {
        hook = new MockHook();
        factory = new MockFactory();
        usdc = new MockUSDC();
        GRADUATOR = address(new MockGraduator(address(hook)));
        sink = new CreatorSink(OWNER);
        vm.startPrank(OWNER);
        sink.setGraduator(GRADUATOR);
        sink.setFactory(address(factory));
        vm.stopPrank();
        vm.deal(address(hook), 100 ether);
        usdc.mint(address(hook), 1_000_000e6);
    }

    function _register() internal {
        vm.prank(GRADUATOR);
        sink.register(MARKET, ID, address(0), ROUTED, TAX);
    }

    // --------------------------------------------------------------------------------- wiring

    function test_theTwoWiresAreOneShotAndOwnerOnly() public {
        CreatorSink fresh = new CreatorSink(OWNER);
        assertEq(fresh.hook(), address(0), "no hook before a graduator");
        vm.prank(address(0xBAD));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD)));
        fresh.setGraduator(GRADUATOR);
        vm.startPrank(OWNER);
        vm.expectRevert(CreatorSink.ZeroAddress.selector);
        fresh.setGraduator(address(0));
        fresh.setGraduator(GRADUATOR);
        vm.expectRevert(CreatorSink.AlreadySet.selector);
        fresh.setGraduator(address(0xBEEF));
        fresh.setFactory(address(factory));
        vm.expectRevert(CreatorSink.AlreadySet.selector);
        fresh.setFactory(address(0xBEEF));
        vm.stopPrank();
        assertEq(fresh.graduator(), GRADUATOR);
        assertEq(fresh.hook(), address(hook), "the hook was not learned from the graduator");
        assertEq(fresh.factory(), address(factory));
        // A graduator without a hook is a wiring mistake, refused rather than stored.
        CreatorSink blank = new CreatorSink(OWNER);
        address noHook = address(new MockGraduator(address(0)));
        vm.prank(OWNER);
        vm.expectRevert(CreatorSink.ZeroAddress.selector);
        blank.setGraduator(noHook);
    }

    /// A market that routes to holders or to a burn but carries a creator tax is registered with
    /// its own sink as `routed`. The hook hands this contract nothing for that leg, so only the tax
    /// lands — and it lands on the tax recipient, never on the vault.
    function test_aTaxedMarketRoutedElsewhereCreditsOnlyItsTax() public {
        vm.prank(GRADUATOR);
        sink.register(MARKET, ID, address(0), VAULT, TAX);
        hook.set(ID, address(0), 5 ether, 0, 1 ether); // pending/owed sink is the vault's, not ours
        hook.setRoutedIsForeign(ID, true);
        sink.pull(MARKET);
        assertEq(sink.claimable(VAULT, address(0)), 0, "the vault's leg was credited here");
        assertEq(sink.claimable(TAX, address(0)), 1 ether, "the tax leg did not land");
        vm.prank(TAX);
        sink.claim(address(0));
        assertEq(TAX.balance, 1 ether);
    }

    function test_registerIsTheGraduatorsAloneAndOnce() public {
        vm.expectRevert(CreatorSink.NotGraduator.selector);
        sink.register(MARKET, ID, address(0), ROUTED, TAX);
        _register();
        (PoolId id, address quote, address routed, address tax, bool registered) = sink.entries(MARKET);
        assertEq(PoolId.unwrap(id), PoolId.unwrap(ID));
        assertEq(quote, address(0));
        assertEq(routed, ROUTED);
        assertEq(tax, TAX);
        assertTrue(registered);
        vm.prank(GRADUATOR);
        vm.expectRevert(CreatorSink.AlreadyRegistered.selector);
        sink.register(MARKET, ID, address(0), ROUTED, TAX);
    }

    /// A market without a creator tax has no tax recipient; its (always zero) tax leg falls to
    /// the routed recipient rather than to `address(0)`.
    function test_aMissingTaxRecipientFallsToTheRoutedOne() public {
        vm.prank(GRADUATOR);
        sink.register(MARKET, ID, address(0), ROUTED, address(0));
        (,,, address tax,) = sink.entries(MARKET);
        assertEq(tax, ROUTED);
        vm.prank(GRADUATOR);
        vm.expectRevert(CreatorSink.ZeroAddress.selector);
        sink.register(address(0xD00D), ID, address(0), address(0), TAX);
    }

    // ------------------------------------------------------------------------------- pulling

    function test_anyonePullsBothLegsIntoClaimable() public {
        _register();
        hook.set(ID, address(0), 0, 3 ether, 1 ether);
        vm.prank(address(0xA11));
        sink.pull(MARKET);
        assertEq(sink.claimable(ROUTED, address(0)), 3 ether, "routed leg not credited");
        assertEq(sink.claimable(TAX, address(0)), 1 ether, "tax leg not credited");
        assertEq(address(sink).balance, 4 ether, "the sink does not hold what it credited");
        assertEq(hook.sweeps(), 0, "swept with nothing pending");
    }

    function test_pullSweepsFirstWhenTheHookHasPendingLevy() public {
        _register();
        hook.set(ID, address(0), 2 ether, 1 ether, 0);
        sink.pull(MARKET);
        assertEq(hook.sweeps(), 1, "did not sweep");
        assertEq(sink.claimable(ROUTED, address(0)), 3 ether, "the swept amount was not pulled");
    }

    function test_pullOnAnUnregisteredMarketReverts() public {
        vm.expectRevert(CreatorSink.NotRegistered.selector);
        sink.pull(MARKET);
    }

    function test_pullWorksInAnERC20Quote() public {
        vm.prank(GRADUATOR);
        sink.register(MARKET, ID, address(usdc), ROUTED, TAX);
        hook.set(ID, address(usdc), 0, 700e6, 300e6);
        sink.pull(MARKET);
        assertEq(sink.claimable(ROUTED, address(usdc)), 700e6);
        assertEq(sink.claimable(TAX, address(usdc)), 300e6);
        assertEq(sink.claimable(ROUTED, address(0)), 0, "credited in the wrong currency");
        vm.prank(ROUTED);
        sink.claim(address(usdc));
        assertEq(usdc.balanceOf(ROUTED), 700e6);
    }

    // ------------------------------------------------------------------------------- claiming

    /// `claim` pays `msg.sender` and nobody else. There is no `claimFor`, and there never will be:
    /// a push to a third party is exactly the shape that lets one recipient block another.
    function test_claimPaysOnlyTheCaller() public {
        _register();
        hook.set(ID, address(0), 0, 3 ether, 1 ether);
        sink.pull(MARKET);
        vm.prank(address(0xA11));
        vm.expectRevert(CreatorSink.NothingToClaim.selector);
        sink.claim(address(0));
        vm.prank(ROUTED);
        sink.claim(address(0));
        assertEq(ROUTED.balance, 3 ether);
        assertEq(sink.claimable(ROUTED, address(0)), 0);
        vm.prank(ROUTED);
        vm.expectRevert(CreatorSink.NothingToClaim.selector);
        sink.claim(address(0));
    }

    /// A recipient that reverts on receive fails its OWN claim and nothing else: the pull still
    /// runs, and the other recipient still claims.
    function test_aRevertingRecipientBlocksNobody() public {
        Rejecter rj = new Rejecter();
        vm.prank(GRADUATOR);
        sink.register(MARKET, ID, address(0), address(rj), TAX);
        hook.set(ID, address(0), 0, 3 ether, 1 ether);
        sink.pull(MARKET);
        vm.prank(address(rj));
        vm.expectRevert(CreatorSink.TransferFailed.selector);
        sink.claim(address(0));
        assertEq(sink.claimable(address(rj), address(0)), 3 ether, "a failed claim lost the balance");
        vm.prank(TAX);
        sink.claim(address(0));
        assertEq(TAX.balance, 1 ether);
    }

    // ------------------------------------------------------------------------------- credit

    function test_creditIsGatedByTheFactory() public {
        MockMarket m = new MockMarket(sink, ROUTED);
        vm.deal(address(m), 10 ether);
        vm.expectRevert(CreatorSink.NotMarket.selector);
        m.creditNative(ROUTED, 1 ether);
        factory.set(address(m), true);
        m.creditNative(ROUTED, 1 ether);
        assertEq(sink.claimable(ROUTED, address(0)), 1 ether);
    }

    function test_creditNativeValueMustMatch() public {
        MockMarket m = new MockMarket(sink, ROUTED);
        factory.set(address(m), true);
        vm.deal(address(m), 1 ether);
        vm.prank(address(m));
        vm.expectRevert(abi.encodeWithSelector(CreatorSink.ValueMismatch.selector, 1, 2));
        sink.credit{value: 1}(ROUTED, address(0), 2);
        vm.prank(address(m));
        vm.expectRevert(abi.encodeWithSelector(CreatorSink.ValueMismatch.selector, 1, 0));
        sink.credit{value: 1}(ROUTED, address(usdc), 1);
    }

    function test_creditPullsAnERC20() public {
        MockMarket m = new MockMarket(sink, ROUTED);
        factory.set(address(m), true);
        usdc.mint(address(m), 5e6);
        m.creditToken(TAX, address(usdc), 5e6);
        assertEq(sink.claimable(TAX, address(usdc)), 5e6);
        assertEq(usdc.balanceOf(address(sink)), 5e6);
    }

    event Credited(address indexed who, address indexed quote, uint256 amount, uint8 kind);

    /// `credit` cannot be told which leg it is, so it asks the market: a credit to the market's
    /// routed recipient is kind 0, anything else kind 1.
    function test_creditInfersTheKindFromTheMarketsRecipient() public {
        MockMarket m = new MockMarket(sink, ROUTED);
        factory.set(address(m), true);
        vm.deal(address(m), 10 ether);
        vm.expectEmit(true, true, false, true);
        emit Credited(ROUTED, address(0), 1 ether, 0);
        m.creditNative(ROUTED, 1 ether);
        vm.expectEmit(true, true, false, true);
        emit Credited(TAX, address(0), 1 ether, 1);
        m.creditNative(TAX, 1 ether);
    }

    // ------------------------------------------------------------------------ recipients

    /// The routed recipient may hand off FUTURE income; balances already credited stay put, and
    /// the tax recipient has no setter at all.
    function test_transferRecipientMovesFutureRoutedIncomeOnly() public {
        _register();
        hook.set(ID, address(0), 0, 3 ether, 1 ether);
        sink.pull(MARKET);
        vm.prank(address(0xBAD));
        vm.expectRevert(CreatorSink.NotRecipient.selector);
        sink.transferRecipient(MARKET, address(0xBAD));
        vm.prank(ROUTED);
        vm.expectRevert(CreatorSink.ZeroAddress.selector);
        sink.transferRecipient(MARKET, address(0));
        vm.prank(ROUTED);
        sink.transferRecipient(MARKET, address(0xD00D));
        (,, address routed, address tax,) = sink.entries(MARKET);
        assertEq(routed, address(0xD00D));
        assertEq(tax, TAX, "the tax recipient moved");
        assertEq(sink.claimable(ROUTED, address(0)), 3 ether, "already-credited balance moved");
        hook.set(ID, address(0), 0, 2 ether, 0);
        sink.pull(MARKET);
        assertEq(sink.claimable(address(0xD00D), address(0)), 2 ether, "future income did not follow");
        // The old recipient cannot hand it back — they are no longer the recipient.
        vm.prank(ROUTED);
        vm.expectRevert(CreatorSink.NotRecipient.selector);
        sink.transferRecipient(MARKET, ROUTED);
    }

    /// V12 H2 (2026-09-20). "Hand FUTURE routed income" has to be true of money still in the HOOK.
    /// Nothing pulls a creator's fees for them, so on a market nobody has pressed Pull for, what the
    /// hook holds is everything earned since graduation — and it was credited to whoever was
    /// `e.routed` when somebody eventually pulled. A creator who handed the income on and pulled
    /// afterwards gave away the whole backlog with it: 100 accrued, rotate, pull, and the new
    /// recipient had 100. The rotation settles first, so the backlog is booked to the recipient it
    /// was earned under, whichever ledger of the hook it sits in.
    function test_transferRecipientSettlesTheBacklogToTheOutgoingRecipient() public {
        _register();
        vm.deal(address(hook), 112 ether);
        hook.set(ID, address(0), 60 ether, 40 ether, 5 ether); // 60 not yet swept, 40 swept, 5 of tax
        vm.prank(ROUTED);
        sink.transferRecipient(MARKET, address(0xD00D));

        assertEq(sink.claimable(ROUTED, address(0)), 100 ether, "the outgoing recipient lost the backlog");
        assertEq(sink.claimable(address(0xD00D), address(0)), 0, "the new recipient was paid for the past");
        assertEq(sink.claimable(TAX, address(0)), 5 ether, "the tax was not settled with it");
        assertEq(hook.pendingSink(ID) + hook.owedSink(ID) + hook.owedTax(ID), 0, "something was left in the hook");

        // A pull afterwards finds nothing of the old recipient's to give away.
        sink.pull(MARKET);
        assertEq(sink.claimable(address(0xD00D), address(0)), 0);
        // And from here the income is the new recipient's.
        hook.set(ID, address(0), 7 ether, 0, 0);
        sink.pull(MARKET);
        assertEq(sink.claimable(address(0xD00D), address(0)), 7 ether, "future income did not follow");
        assertEq(sink.claimable(ROUTED, address(0)), 100 ether);
    }

    /// The same, in an ERC-20 quote: the sink measures what arrives, so the settlement is exact.
    function test_transferRecipientSettlesAnErc20Backlog() public {
        vm.prank(GRADUATOR);
        sink.register(MARKET, ID, address(usdc), ROUTED, TAX);
        usdc.mint(address(hook), 1_000e6);
        hook.set(ID, address(usdc), 300e6, 200e6, 0);
        vm.prank(ROUTED);
        sink.transferRecipient(MARKET, address(0xD00D));
        assertEq(sink.claimable(ROUTED, address(usdc)), 500e6);
        assertEq(sink.claimable(address(0xD00D), address(usdc)), 0);
    }

    /// Settling must not make a rotation depend on there being something to settle: the hook's
    /// `sweep` reverts on an empty ledger, and a recipient with nothing accrued can still hand on.
    function test_transferRecipientWithNothingAccruedStillRotates() public {
        _register();
        vm.prank(ROUTED);
        sink.transferRecipient(MARKET, address(0xD00D));
        (,, address routed,,) = sink.entries(MARKET);
        assertEq(routed, address(0xD00D));
        assertEq(sink.claimable(ROUTED, address(0)), 0);
    }

    function test_sinkCurrencyIsTheQuote() public view {
        assertFalse(sink.sinkCurrencyIsToken());
    }
}
