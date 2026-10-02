// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

// This suite documents what the DEPLOYED generation-3 sink does, so it runs against the frozen
// copy rather than against `src/`, which has since been fixed. See CreatorSinkGen3.sol, and
// CreatorSinkGen4.t.sol for the same sequences against the patch.
import {CreatorSinkGen3 as CreatorSink} from "./CreatorSinkGen3.sol";
import {BurnSink} from "../../src/sinks/BurnSink.sol";
// REPOINTED, 2026-09-11. Section E below is the record of what the DEPLOYED generation-3 vault
// does, so it exercises the frozen copy of that bytecode rather than `src/`, which has since been
// fixed. E1 in particular — a zero denominator at grid line 0 bricking the vault for ever — is one
// of the things the fix removes; the regression that proves it is
// `RewardVaultFix.t.sol::test_zeroEligibleSupplyCarriesForwardInsteadOfBricking`.
import {RewardVaultGen3 as RewardVault} from "./RewardVaultGen3.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

// ---------------------------------------------------------------------------------------- mocks

/// @dev The four hook calls `CreatorSink.pull` makes and the one `RewardVault.fund` / `BurnSink.burn`
///      make. Pays `msg.sender` exactly the way `DokuHook` does, so what is under test is the
///      sink's own accounting, not the hook's.
contract HookStub {
    mapping(PoolId => address) public quoteOf;
    mapping(PoolId => uint256) public pendingSink;
    mapping(PoolId => uint256) public owedSink;
    mapping(PoolId => uint256) public owedTax;
    /// @dev A market whose `sinkAddr` is NOT the CreatorSink: the real hook answers zero rather
    ///      than reverting (`DokuHook.pullSink`, src/v4/DokuHook.sol:1016-1027).
    mapping(PoolId => bool) public foreignSink;
    /// @dev BURN markets are paid in the token; everyone else in the quote.
    mapping(PoolId => address) public sinkCurrency;

    receive() external payable {}

    function set(PoolId id, address quote, uint256 pending, uint256 owed, uint256 tax) external {
        quoteOf[id] = quote;
        if (sinkCurrency[id] == address(0)) sinkCurrency[id] = quote;
        pendingSink[id] = pending;
        owedSink[id] = owed;
        owedTax[id] = tax;
    }

    function setForeign(PoolId id, bool on) external {
        foreignSink[id] = on;
    }

    function setSinkCurrency(PoolId id, address c) external {
        sinkCurrency[id] = c;
    }

    function sweep(PoolId id) external {
        require(pendingSink[id] != 0, "NothingToSweep");
        owedSink[id] += pendingSink[id];
        pendingSink[id] = 0;
    }

    function pullSink(PoolId id) external returns (uint256 amount) {
        if (foreignSink[id]) return 0;
        amount = owedSink[id];
        if (amount == 0) return 0;
        owedSink[id] = 0;
        _pay(sinkCurrency[id], amount);
    }

    function pullTax(PoolId id) external returns (uint256 amount) {
        amount = owedTax[id];
        if (amount == 0) return 0;
        owedTax[id] = 0;
        _pay(quoteOf[id], amount);
    }

    function _pay(address quote, uint256 amount) private {
        if (quote == address(0)) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok, "pay");
        } else {
            require(IERC20(quote).transfer(msg.sender, amount), "pay20");
        }
    }
}

contract GraduatorStub {
    address public hook;

    constructor(address h) {
        hook = h;
    }
}

contract FactoryStub {
    mapping(address => bool) public isMarket;

    function set(address m, bool on) external {
        isMarket[m] = on;
    }
}

/// @dev A `BondingCurve`, as `CreatorSink` sees it. `payOrCredit` is a byte-for-byte copy of
///      `BondingCurve._payOrCredit` (src/BondingCurve.sol:933-944) so the deferred path under test
///      is the production one.
contract CurveStub {
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

/// @notice A quote asset that delivers less than it is asked to move. This is what an upgradeable
///         proxy quote becomes after one `upgradeTo`, and what a share-based token does after a
///         negative rebase — both listed as residuals the registration screen cannot see
///         (docs/doku/deployments.md, "Screening a quote asset before you register it").
contract FeeOnTransferQuote is ERC20 {
    uint256 public feeBps;

    constructor(uint256 bps) ERC20("Skim", "SKIM") {
        feeBps = bps;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || feeBps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = (value * feeBps) / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0xFEE), fee);
    }
}

/// @notice A quote asset with a per-transfer maximum. The Pons escrow shape.
contract CappedQuote is ERC20 {
    uint256 public cap = type(uint256).max;

    constructor() ERC20("Capped", "CAP") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setCap(uint256 c) external {
        cap = c;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) require(value <= cap, "over cap");
        super._update(from, to, value);
    }
}

/// @notice A quote asset whose operator can shrink a holder's balance. A share-based token after a
///         negative rebase, in its simplest form.
contract RebasingQuote is ERC20 {
    constructor() ERC20("Rebase", "RBS") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function rebaseDown(address who, uint256 bps) external {
        _burn(who, (balanceOf(who) * bps) / 10_000);
    }
}

/// @notice A quote asset that calls back into the sink on every move.
contract ReentrantQuote is ERC20 {
    CreatorSink public sink;
    address public market;
    bool public armed;

    constructor() ERC20("Hostile", "HOS") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(CreatorSink s, address m) external {
        sink = s;
        market = m;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed || address(sink) == address(0)) return;
        // Try every state-changing entry point on the sink from inside a transfer.
        try sink.pull(market) {} catch {}
        try sink.claim(address(this)) {} catch {}
    }
}

/// @dev A recipient that refuses a push, forcing `_payOrCredit` down the deferred branch.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

/// @dev A native holder that re-enters `RewardVault.claim` from inside its payout.
contract ReenteringHolder {
    RewardVault public vault;
    uint256 public hits;

    function set(RewardVault v) external {
        vault = v;
    }

    receive() external payable {
        hits += 1;
        try vault.claim(address(this), 0, 0) {} catch {}
    }
}

// ------------------------------------------------------------------------------------- the hunt

contract SinksHunt is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18;

    address internal constant OWNER = address(0x01);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Two markets on the SAME shared sink and the SAME quote. This is the contamination surface.
    address internal MARKET_A;
    address internal MARKET_B;
    address internal constant ROUTED_A = address(0xA0);
    address internal constant TAX_A = address(0xA1);
    address internal constant ROUTED_B = address(0xB0);
    address internal constant TAX_B = address(0xB1);
    PoolId internal constant ID_A = PoolId.wrap(bytes32(uint256(0xA)));
    PoolId internal constant ID_B = PoolId.wrap(bytes32(uint256(0xB)));

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

    function _registerNative() internal {
        MARKET_A = address(new CurveStub(sink, ROUTED_A, address(0)));
        MARKET_B = address(new CurveStub(sink, ROUTED_B, address(0)));
        factory.set(MARKET_A, true);
        factory.set(MARKET_B, true);
        vm.startPrank(GRADUATOR);
        sink.register(MARKET_A, ID_A, address(0), ROUTED_A, TAX_A);
        sink.register(MARKET_B, ID_B, address(0), ROUTED_B, TAX_B);
        vm.stopPrank();
    }

    // =====================================================================================
    // A. CreatorSink — one shared balance for every market. Can market A's claim reach
    //    market B's money?
    // =====================================================================================

    /// FINDING A1. `credit` books the amount it is TOLD, `pull` books the amount that ARRIVED.
    ///
    /// `pull` measures a balance delta (src/sinks/CreatorSink.sol:141-158) precisely so a hook bug
    /// cannot make the ledger promise money the sink does not hold. `credit`
    /// (src/sinks/CreatorSink.sol:167-181) does the opposite: it trusts `amount` and does not
    /// re-read the balance around the `safeTransferFrom`. This is the SAME defect the 2026-09-09
    /// audit found and fixed one contract over — finding #8, "the launch's ERC-20 first buy
    /// credited the amount ASKED FOR rather than the amount that arrived" — and the fix did not
    /// travel to this sibling.
    ///
    /// Because `claimable` is a single pool per (who, quote) with no per-market reserve, the
    /// shortfall is not borne by the market that caused it. It is borne by whoever claims LAST, in
    /// ANY market quoted in the same asset.
    function test_A1_creditOverBooksOnASkimmingQuoteAndAnotherMarketsRecipientEatsIt() public {
        FeeOnTransferQuote q = new FeeOnTransferQuote(500); // 5%
        CurveStub a = new CurveStub(sink, ROUTED_A, address(q));
        CurveStub b = new CurveStub(sink, ROUTED_B, address(q));
        factory.set(address(a), true);
        factory.set(address(b), true);

        // Market B behaves: it pulls its share out of the hook, so the sink really holds it.
        vm.prank(GRADUATOR);
        sink.register(address(b), ID_B, address(q), ROUTED_B, TAX_B);
        q.mint(address(hook), 100e18);
        hook.set(ID_B, address(q), 0, 100e18, 0);
        // A skimming quote makes the hook deliver 95; the delta form books exactly 95.
        sink.pull(address(b));
        assertEq(sink.claimable(ROUTED_B, address(q)), 95e18, "pull booked the delta");

        // Market A takes the deferred branch — what `BondingCurve._payOrCredit` does whenever a
        // push to the recipient fails, which on a live quote is exactly the blacklist case.
        q.mint(address(a), 100e18);
        vm.prank(address(a));
        q.approve(address(sink), 100e18);
        vm.prank(address(a));
        sink.credit(ROUTED_A, address(q), 100e18);

        uint256 booked = sink.claimable(ROUTED_A, address(q)) + sink.claimable(ROUTED_B, address(q));
        uint256 held = q.balanceOf(address(sink));
        console2.log("sum(claimable)", booked);
        console2.log("balance held  ", held);
        assertGt(booked, held, "SOLVENCY BROKEN: the ledger promises more than the sink holds");

        // Market A's recipient claims first and takes the whole pot, including market B's money.
        vm.prank(ROUTED_A);
        sink.claim(address(q));

        // Market B's recipient — who never touched the skimming path — is now short.
        vm.prank(ROUTED_B);
        vm.expectRevert();
        sink.claim(address(q));
        console2.log("ROUTED_B is owed but cannot claim:", sink.claimable(ROUTED_B, address(q)));
    }

    /// FINDING A6. The same contamination with ONE precondition instead of two. Every credit here
    /// is exact — both markets pulled honestly, delta-measured — and the sink is still made
    /// insolvent by a shortfall it never caused, because it keeps one undifferentiated balance per
    /// quote for every market it serves and settles claims first-come-first-served. A quote that
    /// can shrink a holder's balance (a share-based token after a negative `rebase()`, a partial
    /// freeze, a proxy upgrade) makes market A's recipient whole out of market B's money. The
    /// registration screen explicitly cannot see an operator-triggered rebase
    /// (docs/doku/deployments.md, "Screening a quote asset before you register it").
    function test_A6_aShortfallInOneQuoteIsSocialisedAcrossEveryMarketFirstComeFirstServed() public {
        RebasingQuote q = new RebasingQuote();
        CurveStub a = new CurveStub(sink, ROUTED_A, address(q));
        CurveStub b = new CurveStub(sink, ROUTED_B, address(q));
        factory.set(address(a), true);
        factory.set(address(b), true);
        vm.startPrank(GRADUATOR);
        sink.register(address(a), ID_A, address(q), ROUTED_A, TAX_A);
        sink.register(address(b), ID_B, address(q), ROUTED_B, TAX_B);
        vm.stopPrank();

        q.mint(address(hook), 200e18);
        hook.set(ID_A, address(q), 0, 100e18, 0);
        sink.pull(address(a));
        hook.set(ID_B, address(q), 0, 100e18, 0);
        sink.pull(address(b));
        assertEq(sink.claimable(ROUTED_A, address(q)), 100e18);
        assertEq(sink.claimable(ROUTED_B, address(q)), 100e18);

        q.rebaseDown(address(sink), 1000); // -10%, one operator call

        vm.prank(ROUTED_A);
        sink.claim(address(q));
        assertEq(q.balanceOf(ROUTED_A), 100e18, "A took its full book");

        vm.prank(ROUTED_B);
        vm.expectRevert(); // B is short by the entire shortfall
        sink.claim(address(q));
        console2.log("B still booked:", sink.claimable(ROUTED_B, address(q)));
        console2.log("sink holds    :", q.balanceOf(address(sink)));
    }

    /// DISPROOF A2. With a well-behaved quote, `sum(claimable) <= balance` holds across markets
    /// under arbitrary interleavings of pull and credit. (The 2026-09-09 audit asserted this for
    /// generation 2; it is re-asserted here against the deployed generation-3 source.)
    function testFuzz_A2_solvencyHoldsForAWellBehavedQuote(uint96[8] calldata amounts, uint8 order) public {
        MockUSDC q = new MockUSDC();
        CurveStub a = new CurveStub(sink, ROUTED_A, address(q));
        CurveStub b = new CurveStub(sink, ROUTED_B, address(q));
        factory.set(address(a), true);
        factory.set(address(b), true);
        vm.startPrank(GRADUATOR);
        sink.register(address(a), ID_A, address(q), ROUTED_A, TAX_A);
        sink.register(address(b), ID_B, address(q), ROUTED_B, TAX_B);
        vm.stopPrank();

        for (uint256 i; i < 8; ++i) {
            uint256 amt = uint256(amounts[i]) % 1e12 + 1;
            if ((order >> (i % 8)) & 1 == 1) {
                q.mint(address(hook), amt * 2);
                PoolId id = i % 2 == 0 ? ID_A : ID_B;
                hook.set(id, address(q), 0, amt, amt);
                sink.pull(i % 2 == 0 ? address(a) : address(b));
            } else {
                CurveStub m = i % 2 == 0 ? a : b;
                q.mint(address(m), amt);
                vm.prank(address(m));
                q.approve(address(sink), amt);
                vm.prank(address(m));
                sink.credit(i % 2 == 0 ? ROUTED_A : ROUTED_B, address(q), amt);
            }
        }

        uint256 booked = sink.claimable(ROUTED_A, address(q)) + sink.claimable(TAX_A, address(q))
            + sink.claimable(ROUTED_B, address(q)) + sink.claimable(TAX_B, address(q));
        assertLe(booked, q.balanceOf(address(sink)), "solvency broken");
    }

    /// DISPROOF A3. A pull of market A can never move market B's ledger, even when both markets
    /// have money waiting and share a quote and a routed recipient address.
    function test_A3_aPullOfOneMarketNeverTouchesAnothersLedger() public {
        _registerNative();
        hook.set(ID_A, address(0), 1 ether, 2 ether, 3 ether);
        hook.set(ID_B, address(0), 4 ether, 5 ether, 6 ether);

        sink.pull(MARKET_A);
        assertEq(sink.claimable(ROUTED_A, address(0)), 3 ether, "A routed = pending+owed");
        assertEq(sink.claimable(TAX_A, address(0)), 3 ether, "A tax");
        assertEq(sink.claimable(ROUTED_B, address(0)), 0, "B routed moved");
        assertEq(sink.claimable(TAX_B, address(0)), 0, "B tax moved");
        // And a second pull of the same market takes nothing more.
        sink.pull(MARKET_A);
        assertEq(sink.claimable(ROUTED_A, address(0)), 3 ether, "double pull");
    }

    /// DISPROOF A4. A quote token that calls back into the sink on every transfer cannot
    /// double-book a pull or a credit: one `ReentrancyGuard` covers `pull`, `credit` and `claim`.
    function test_A4_aReentrantQuoteCannotDoubleBookAnything() public {
        ReentrantQuote q = new ReentrantQuote();
        CurveStub a = new CurveStub(sink, ROUTED_A, address(q));
        factory.set(address(a), true);
        vm.prank(GRADUATOR);
        sink.register(address(a), ID_A, address(q), ROUTED_A, TAX_A);
        q.mint(address(hook), 100e18);
        hook.set(ID_A, address(q), 0, 40e18, 10e18);
        q.arm(sink, address(a));

        sink.pull(address(a));
        assertEq(sink.claimable(ROUTED_A, address(q)), 40e18, "routed double-booked");
        assertEq(sink.claimable(TAX_A, address(q)), 10e18, "tax double-booked");
        assertLe(
            sink.claimable(ROUTED_A, address(q)) + sink.claimable(TAX_A, address(q)),
            q.balanceOf(address(sink)),
            "solvency broken under reentrancy"
        );
    }

    /// DISPROOF A5. `credit` cannot be reached by anything the factory does not know as a market,
    /// and a market cannot mint a claim it did not fund: the native leg is `msg.value`-checked and
    /// the ERC-20 leg is pulled from the caller.
    function test_A5_creditCannotMintAClaimOutOfNothing() public {
        _registerNative();
        vm.deal(address(this), 1 ether);
        vm.expectRevert(CreatorSink.NotMarket.selector);
        sink.credit{value: 1 ether}(address(this), address(0), 1 ether);

        vm.deal(MARKET_A, 1 ether);
        vm.prank(MARKET_A);
        vm.expectRevert(abi.encodeWithSelector(CreatorSink.ValueMismatch.selector, 0, 1 ether));
        sink.credit(address(this), address(0), 1 ether);
    }

    // =====================================================================================
    // B. CreatorSink — value that can never leave again.
    // =====================================================================================

    /// FINDING B1. `claim` is all-or-nothing and there is no rescue, no partial claim and no way
    /// to reassign a balance that has already been credited. On a live quote with a blocklist —
    /// USDC and USDT0 are both registered on mainnet, see docs/doku/deployments.md "Registered
    /// quote assets" — a recipient that gets frozen loses everything already credited to it,
    /// permanently, and `transferRecipient` cannot move it.
    function test_B1_aFrozenRecipientsCreditedBalanceIsPermanentlyUnreachable() public {
        MockUSDC q = new MockUSDC();
        CurveStub a = new CurveStub(sink, ROUTED_A, address(q));
        factory.set(address(a), true);
        vm.prank(GRADUATOR);
        sink.register(address(a), ID_A, address(q), ROUTED_A, TAX_A);

        q.mint(address(hook), 10_000e6);
        hook.set(ID_A, address(q), 0, 8_000e6, 0);
        sink.pull(address(a)); // permissionless — anyone can crystallise the credit
        assertEq(sink.claimable(ROUTED_A, address(q)), 8_000e6);

        q.setBlocked(ROUTED_A, true); // the issuer freezes the creator's wallet

        vm.prank(ROUTED_A);
        vm.expectRevert(); // "blocked"
        sink.claim(address(q));

        // Rotating the recipient does NOT rescue it — only future income moves.
        vm.prank(ROUTED_A);
        sink.transferRecipient(address(a), address(0xFEED));
        assertEq(sink.claimable(address(0xFEED), address(q)), 0, "balance followed the rotation");
        assertEq(sink.claimable(ROUTED_A, address(q)), 8_000e6, "still stuck on the frozen address");

        // And there is no owner path out: the sink has no rescue function at all.
        vm.prank(OWNER);
        (bool ok,) = address(sink).call(abi.encodeWithSignature("rescue(address,uint256)", address(q), 1));
        assertFalse(ok, "a rescue function exists");
        console2.log("permanently stranded USDC:", sink.claimable(ROUTED_A, address(q)));
    }

    /// FINDING B2. The Pons-escrow shape, applied. `claim(quote)` takes no amount, so a quote with
    /// a per-transfer maximum makes a large balance permanently unclaimable — the recipient cannot
    /// take it in pieces. None of the seven live quotes caps transfers today; four of them are
    /// upgradeable proxies (docs/doku/deployments.md), so the precondition is one `upgradeTo`.
    function test_B2_aCappedTransferQuoteBlocksTheWholeClaimForever() public {
        CappedQuote q = new CappedQuote();
        CurveStub a = new CurveStub(sink, ROUTED_A, address(q));
        factory.set(address(a), true);
        vm.prank(GRADUATOR);
        sink.register(address(a), ID_A, address(q), ROUTED_A, TAX_A);

        q.mint(address(hook), 1_000e18);
        hook.set(ID_A, address(q), 0, 1_000e18, 0);
        sink.pull(address(a));

        q.setCap(100e18); // the upgrade lands

        vm.prank(ROUTED_A);
        vm.expectRevert(); // "over cap" — and there is no claim(quote, amount)
        sink.claim(address(q));
        assertEq(sink.claimable(ROUTED_A, address(q)), 1_000e18, "still owed, still unreachable");
    }

    /// FINDING B3. Anything that arrives through `receive()` is credited to nobody and can never
    /// leave: the only exit is `claim`, which pays from a per-address ledger that a bare send does
    /// not touch. A creator who names the sink itself as a recipient reaches the same dead end.
    function test_B3_bareNativeAndASelfNamedRecipientAreBothDeadEnds() public {
        _registerNative();
        vm.deal(address(this), 5 ether);
        (bool ok,) = address(sink).call{value: 5 ether}("");
        assertTrue(ok, "receive() refused");
        assertEq(address(sink).balance, 5 ether);
        assertEq(sink.claimable(address(this), address(0)), 0, "a bare send credits nobody");

        // Naming the sink as your own recipient: `credit` accepts it and `claim` can never be
        // called by the sink, so the money is gone.
        vm.deal(MARKET_A, 1 ether);
        vm.prank(MARKET_A);
        sink.credit{value: 1 ether}(address(sink), address(0), 1 ether);
        assertEq(sink.claimable(address(sink), address(0)), 1 ether, "credited to the sink itself");
    }

    // =====================================================================================
    // C. transferRecipient — what actually changes hands.
    // =====================================================================================

    /// FINDING C1. The docstring promises "FUTURE routed income" and says already-credited
    /// balances stay behind. Both are true of `claimable`. What it does not say is that everything
    /// the HOOK has accrued and nobody has pulled yet also moves — and that is unbounded, because
    /// nothing forces a pull on any schedule. Selling a market therefore hands the buyer every
    /// basis point earned since the last `pull`, and a seller who does not pull atomically before
    /// transferring is giving it away.
    function test_C1_transferRecipientAlsoHandsOverEveryUnpulledAccruedShare() public {
        _registerNative();
        // A year of trading accrues in the hook's ledger. Nobody pulls — nothing makes them.
        hook.set(ID_A, address(0), 30 ether, 70 ether, 0);

        // The creator sells the market and rotates the recipient to the buyer.
        vm.prank(ROUTED_A);
        sink.transferRecipient(MARKET_A, address(0xB0FFED));

        // Anyone may now pull. All 100 MON of PAST income lands on the buyer.
        sink.pull(MARKET_A);
        assertEq(sink.claimable(address(0xB0FFED), address(0)), 100 ether, "past income did not move");
        assertEq(sink.claimable(ROUTED_A, address(0)), 0, "seller kept nothing");
        console2.log("past income handed to the new recipient:", uint256(100 ether));
    }

    /// DISPROOF C2. Nobody can move a tax recipient, and nobody but the current routed recipient
    /// can move the routed one — including the owner and the graduator.
    function test_C2_nobodyElseCanMoveARecipient() public {
        _registerNative();
        vm.prank(OWNER);
        vm.expectRevert(CreatorSink.NotRecipient.selector);
        sink.transferRecipient(MARKET_A, address(0xBAD));
        vm.prank(GRADUATOR);
        vm.expectRevert(CreatorSink.NotRecipient.selector);
        sink.transferRecipient(MARKET_A, address(0xBAD));
        vm.prank(TAX_A);
        vm.expectRevert(CreatorSink.NotRecipient.selector);
        sink.transferRecipient(MARKET_A, address(0xBAD));
        // And a second registration of the same market is refused.
        vm.prank(GRADUATOR);
        vm.expectRevert(CreatorSink.AlreadyRegistered.selector);
        sink.register(MARKET_A, ID_A, address(0), address(0xBAD), address(0xBAD));
    }

    // =====================================================================================
    // D. Push-then-defer. `BondingCurve._payOrCredit` pushes, and on failure credits here.
    // =====================================================================================

    /// DISPROOF D1. Forcing the deferred branch is free but worthless: the recipient ends up with
    /// exactly the same number either way, and the sink's balance moves by exactly the amount.
    function test_D1_forcingTheCreditPathMovesNoValueEitherWay() public {
        _registerNative();
        Refuser r = new Refuser();
        CurveStub a = new CurveStub(sink, address(r), address(0));
        factory.set(address(a), true);
        vm.deal(address(a), 10 ether);

        uint256 sinkBefore = address(sink).balance;
        a.payOrCredit(address(r), 10 ether); // the push reverts -> deferred
        assertEq(address(sink).balance - sinkBefore, 10 ether, "the sink took a different amount");
        assertEq(sink.claimable(address(r), address(0)), 10 ether, "credited a different amount");

        // The pushed branch, same market shape, same number.
        CurveStub b = new CurveStub(sink, ROUTED_B, address(0));
        factory.set(address(b), true);
        vm.deal(address(b), 10 ether);
        b.payOrCredit(ROUTED_B, 10 ether);
        assertEq(ROUTED_B.balance, 10 ether, "pushed amount differs from the deferred one");
        assertEq(sink.claimable(ROUTED_B, address(0)), 0, "pushed AND credited");
    }

    /// DISPROOF D2. A recipient that seizes control during its own native push cannot reach
    /// anybody else's ledger: `claim` pays `msg.sender` and nothing else, and `pull` can only ever
    /// credit the addresses the graduator registered.
    function test_D2_aHostileRecipientCannotReachAnotherRecipientsBalance() public {
        _registerNative();
        hook.set(ID_B, address(0), 0, 9 ether, 0);
        sink.pull(MARKET_B);
        assertEq(sink.claimable(ROUTED_B, address(0)), 9 ether);

        // ROUTED_A tries to claim B's money.
        vm.prank(ROUTED_A);
        vm.expectRevert(CreatorSink.NothingToClaim.selector);
        sink.claim(address(0));
        assertEq(sink.claimable(ROUTED_B, address(0)), 9 ether, "B's balance moved");
    }

    // =====================================================================================
    // E. RewardVault. Already recorded by test/_gen3/RvEpochStrandAudit3.t.sol and NOT repeated
    //    here: the mid-epoch turnover residue is permanently stranded, and a lagged `createEpoch`
    //    pays a stale snapshot the whole backlog. What follows is what those did not cover.
    // =====================================================================================

    struct Vaulted {
        DokuToken token;
        RewardVault vault;
        HookStub h;
        uint256 genesis;
    }

    address internal constant PM = address(0x9001);
    address internal constant CURVE = address(0xC0FFEE);
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);

    function _vault(bool distribute) internal returns (Vaulted memory v) {
        vm.roll(1_000_000);
        v.h = new HookStub();
        v.token = DokuToken(Clones.clone(address(new DokuToken())));
        v.token.initialize("Doku", "DOKU", CURVE, true, "https://cdn.doku.family/metadata/test.json");
        v.genesis = vm.getBlockNumber();
        address[8] memory ex;
        ex[0] = PM;
        ex[1] = address(v.h);
        ex[2] = CURVE;
        ex[3] = address(v.token);
        ex[4] = DEAD;
        ex[5] = GRAD;
        ex[6] = POSM;
        v.vault = new RewardVault(
            address(v.h), address(v.token), ID_A, address(0), 1000 ether, v.genesis, ex
        );
        v.h.setSinkCurrency(ID_A, address(0));
        vm.startPrank(CURVE);
        v.token.transfer(PM, SEED);
        if (distribute) {
            v.token.transfer(address(0xA1), 300_000_000e18);
            v.token.transfer(address(0xB2), 300_000_000e18);
            v.token.transfer(address(0xC3), SUPPLY - SEED - 600_000_000e18);
        } else {
            // Every remaining token parked in addresses the denominator excludes.
            v.token.transfer(DEAD, SUPPLY - SEED);
        }
        vm.stopPrank();
        vm.roll(vm.getBlockNumber() + 1);
    }

    function _fundVault(Vaulted memory v, uint256 amount) internal {
        vm.deal(address(v.h), address(v.h).balance + amount);
        v.h.set(ID_A, address(0), 0, amount, 0);
        v.vault.fund();
    }

    /// FINDING E1. `createEpoch` derives its snapshot from `epochs.length`, so a refused epoch
    /// never advances the index — and the refusal is a function of ONE fixed block in the past.
    /// If `eligibleSupplyAt(snapshotBlockFor(0))` is ever zero, index 0 can never be created, and
    /// therefore neither can any later index. Every levy the vault will ever collect accumulates
    /// in `unallocated` and is unreachable forever: there is no owner, no rescue, no re-anchor.
    ///
    /// Cost to trigger: the entire non-excluded float must sit in excluded addresses at that one
    /// block. Prohibitive on a healthy market, and the cheapest excluded parking spot recoverable
    /// is the PositionManager (its SWEEP action) — see the false positives. Ranked as permanent
    /// stranding with a prohibitive trigger, not as theft, but it is PERMANENT rather than a stall.
    function test_E1_aZeroEligibleSupplyAtGridLineZeroBricksTheVaultForever() public {
        Vaulted memory v = _vault(false);
        _fundVault(v, 10 ether);
        assertEq(v.vault.unallocated(), 10 ether);

        vm.roll(v.vault.snapshotBlockFor(0) + 1);
        assertEq(v.vault.eligibleSupplyAt(v.vault.snapshotBlockFor(0)), 0, "expected a zero denominator");
        vm.expectRevert(RewardVault.NoEligibleSupply.selector);
        v.vault.createEpoch();

        // The float comes back into holders' hands — the market recovers completely.
        vm.prank(DEAD);
        v.token.transfer(address(0xA1), SUPPLY - SEED);
        vm.roll(vm.getBlockNumber() + 1);

        // The vault does not. Index 0 still reads the SAME past block, which is still zero.
        vm.expectRevert(RewardVault.NoEligibleSupply.selector);
        v.vault.createEpoch();

        // ...and it is still zero twenty grid lines later, with twenty epochs of levy inside.
        for (uint256 k = 1; k <= 20; ++k) {
            vm.roll(v.vault.snapshotBlockFor(k) + 1);
            _fundVault(v, 1 ether);
        }
        vm.expectRevert(RewardVault.NoEligibleSupply.selector);
        v.vault.createEpoch();
        console2.log("unreachable forever (wei):", v.vault.unallocated());
        assertEq(v.vault.unallocated(), 30 ether);
        assertEq(v.vault.epochCount(), 0, "an epoch was created after all");
    }

    /// DISPROOF E2. Rounding is floor everywhere, so an epoch can never overspend itself and no
    /// claimant can be paid a wei more than their weight buys — under arbitrary churn, including
    /// into and out of excluded addresses, and including claims in any order.
    function testFuzz_E2_everyEpochPaysOutStrictlyLessThanItHolds(uint96 m1, uint96 m2, uint96 fundAmt) public {
        Vaulted memory v = _vault(true);
        uint256 amount = uint256(fundAmt) % 500 ether + 1 ether;
        _fundVault(v, amount);
        vm.roll(v.vault.snapshotBlockFor(0) + 1);
        uint256 k = v.vault.createEpoch();
        (,, uint256 es,) = v.vault.epochs(k);

        vm.prank(address(0xA1));
        v.token.transfer(address(0xC3), uint256(m1) % 300_000_000e18);
        vm.prank(address(0xB2));
        v.token.transfer(PM, uint256(m2) % 300_000_000e18);
        vm.roll(v.vault.snapshotBlockFor(1) + 1);

        uint256 paid;
        address[3] memory hs = [address(0xA1), address(0xB2), address(0xC3)];
        for (uint256 i; i < 3; ++i) {
            try v.vault.claim(hs[i], k, k) returns (uint256 got) {
                paid += got;
            } catch {}
        }
        (, uint256 amt,, uint256 claimed) = v.vault.epochs(k);
        assertEq(paid, claimed, "paid != claimed");
        assertLe(claimed, amt, "epoch overspent");
        assertLe(v.vault.weightOf(hs[0], k) + v.vault.weightOf(hs[1], k) + v.vault.weightOf(hs[2], k), es, "weights");
        assertGe(address(v.vault).balance, 0);
    }

    /// DISPROOF E3. A holder that seizes control inside its own native payout cannot be paid
    /// twice: `hasClaimed` is written before `_pay`, and one guard covers claim, fund and
    /// createEpoch.
    function test_E3_claimCannotBeReenteredBeforeTheBitmapIsWritten() public {
        Vaulted memory v = _vault(true);
        ReenteringHolder h = new ReenteringHolder();
        h.set(v.vault);
        vm.prank(address(0xA1));
        v.token.transfer(address(h), 300_000_000e18);
        vm.roll(vm.getBlockNumber() + 1);

        _fundVault(v, 100 ether);
        vm.roll(v.vault.snapshotBlockFor(0) + 1);
        uint256 k = v.vault.createEpoch();
        vm.roll(v.vault.snapshotBlockFor(1) + 1);

        uint256 got = v.vault.claim(address(h), k, k);
        assertEq(address(h).balance, got, "paid more than once");
        assertGt(h.hits(), 0, "the callback never fired");
        (, uint256 amt,, uint256 claimed) = v.vault.epochs(k);
        assertLe(claimed, amt);
    }

    /// DISPROOF E4. `claim` always pays the holder it is given, never the caller, and an excluded
    /// address is refused loudly on both sides of the fraction.
    function test_E4_aStrangerCannotDivertOrRepeatAClaim() public {
        Vaulted memory v = _vault(true);
        _fundVault(v, 100 ether);
        vm.roll(v.vault.snapshotBlockFor(0) + 1);
        uint256 k = v.vault.createEpoch();
        vm.roll(v.vault.snapshotBlockFor(1) + 1);

        uint256 thiefBefore = address(this).balance;
        uint256 got = v.vault.claim(address(0xA1), k, k);
        assertEq(address(this).balance, thiefBefore, "the caller was paid");
        assertEq(address(0xA1).balance, got, "the holder was not paid");

        vm.expectRevert(RewardVault.NothingToClaim.selector);
        v.vault.claim(address(0xA1), k, k);

        vm.expectRevert(abi.encodeWithSelector(RewardVault.HolderExcluded.selector, PM));
        v.vault.claim(PM, k, k);
        assertEq(v.vault.weightOf(PM, k), 0, "an excluded address still carries weight");
    }

    /// FOOTNOTE E5. `claim` REVERTS on an immature epoch rather than skipping it, so anyone who
    /// opens a fresh epoch the block a grid line passes makes every "claim my whole range" call
    /// revert until it matures. No value moves; the claimant must pass a shorter `to`.
    function test_E5_oneImmatureEpochRevertsAWholeRangeClaim() public {
        Vaulted memory v = _vault(true);
        _fundVault(v, 100 ether);
        vm.roll(v.vault.snapshotBlockFor(0) + 1);
        v.vault.createEpoch();
        vm.roll(v.vault.snapshotBlockFor(1) + 1);
        _fundVault(v, 100 ether);
        v.vault.createEpoch(); // index 1, immature until grid line 2

        vm.expectRevert(abi.encodeWithSelector(RewardVault.NotMatured.selector, 1, v.vault.snapshotBlockFor(2) + 1));
        v.vault.claim(address(0xA1), 0, 1);
        assertGt(v.vault.claim(address(0xA1), 0, 0), 0, "the matured epoch is still reachable alone");
    }

    // =====================================================================================
    // F. BurnSink.
    // =====================================================================================

    /// DISPROOF F1. The burn really reduces the checkpointed supply, it is permissionless, and the
    /// sink cannot be handed native quote at all: it has no `receive` and no `fallback`.
    function test_F1_theBurnIsRealAndTheSinkCannotHoldQuote() public {
        vm.roll(1_000_000);
        HookStub h = new HookStub();
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("Doku", "DOKU", CURVE, true, "https://cdn.doku.family/metadata/test.json");
        BurnSink bs = new BurnSink(address(h), address(t), ID_A);
        h.setSinkCurrency(ID_A, address(t));
        vm.prank(CURVE);
        t.transfer(address(h), 100e18);
        h.set(ID_A, address(t), 0, 100e18, 0);
        h.setSinkCurrency(ID_A, address(t));

        uint256 supplyBefore = t.totalSupply();
        vm.prank(address(0xDEADBEEF)); // anyone
        uint256 burned = bs.burn();
        assertEq(burned, 100e18);
        assertEq(t.totalSupply(), supplyBefore - 100e18, "supply did not shrink");
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(t.getPastTotalSupply(vm.getBlockNumber() - 1), supplyBefore - 100e18, "checkpoint stale");
        assertEq(t.balanceOf(address(bs)), 0, "the sink kept some");

        vm.deal(address(this), 1 ether);
        (bool ok,) = address(bs).call{value: 1 ether}("");
        assertFalse(ok, "the burn sink accepted native");
    }

    /// FOOTNOTE F2. A foreign ERC-20 sent to a BurnSink is permanently stranded: the sink burns
    /// only its own immutable `token` and has no other outbound path.
    function test_F2_aForeignTokenSentToABurnSinkIsStranded() public {
        HookStub h = new HookStub();
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("Doku", "DOKU", CURVE, false, "https://cdn.doku.family/metadata/test.json");
        BurnSink bs = new BurnSink(address(h), address(t), ID_A);
        MockUSDC q = new MockUSDC();
        q.mint(address(bs), 1_000e6);
        h.setSinkCurrency(ID_A, address(t));
        vm.prank(CURVE);
        t.transfer(address(h), 1e18);
        h.set(ID_A, address(t), 0, 1e18, 0);
        bs.burn();
        assertEq(q.balanceOf(address(bs)), 1_000e6, "the USDC left somehow");
    }
}
