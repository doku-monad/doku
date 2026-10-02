// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";

import {BondingCurve, DOKU_SEED_BASE} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {CurveMath} from "../../src/lib/CurveMath.sol";
import {TaxMath} from "../../src/lib/TaxMath.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockGraduator} from "../mocks/MockGraduator.sol";
import {MockCreatorSink} from "../mocks/MockCreatorSink.sol";

/*//////////////////////////////////////////////////////////////////////////////
                                   FIXTURES
//////////////////////////////////////////////////////////////////////////////*/

interface IReenterHook {
    function onQuoteMove(address counterparty) external;
}

/// @dev The one shape the protocol's quote policy forbids: a token that runs somebody's code
///      inside its own transfer. Registered assets are all plain ERC-20s, so this exists only to
///      prove the CURVE's guards hold on every entry point — the half that
///      `docs/doku/audit/2026-09-10-external/first-buy-delta-reentrancy.md` asserts about
///      `_pullAndBuy` but never demonstrates for `sell`, `collectFees` or the refund leg.
contract CallbackQuote is ERC20 {
    uint8 private immutable _dec;
    address public hook;
    bool public armed;

    constructor(uint8 dec_) ERC20("Callback Quote", "CBQ") {
        _dec = dec_;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address hook_) external {
        hook = hook_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed || hook == address(0)) return;
        armed = false;
        IReenterHook(hook).onQuoteMove(from == address(0) ? to : from);
        armed = true;
    }
}

/// @dev `transfer` returns a word that is neither 0 nor 1. External review L-03.
contract MalformedQuote is ERC20 {
    constructor() ERC20("Malformed", "MAL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        assembly ("memory-safe") {
            mstore(0, 2)
            return(0, 32)
        }
    }
}

/// @dev A wallet that refuses native MON, so the deferred credit path is reachable.
contract Refuser {
    receive() external payable {
        revert("no");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
                                    BENCH
//////////////////////////////////////////////////////////////////////////////*/

/// @notice The curve as the factory builds it: this contract is `msg.sender` of `initialize`, so
///         it IS `factory` and may call `buyFor`. Nothing else is stubbed — the curve, the token
///         and both libraries are the deployed source.
abstract contract Bench is Test {
    uint256 internal constant C = 1_088_888_889_200_000_000_000_000_000; // BASE_VIRTUAL_CEILING
    uint256 internal constant F = 311_111_111_200_000_000_000_000_000; // BASE_VIRTUAL_FLOOR
    address internal constant TREASURY = address(0xBEEF);

    address internal curveImpl;
    address internal tokenImpl;
    uint256 internal _nonce;

    struct Market {
        BondingCurve curve;
        DokuToken token;
        MockGraduator grad;
        MockCreatorSink csink;
        address quote;
        uint256 target;
        uint8 sink;
    }

    function _bench() internal {
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
    }

    function _launch(address quote, uint8 sink, address routed, uint16 taxBps, address taxTo, uint256 target)
        internal
        returns (Market memory m)
    {
        bytes32 salt = keccak256(abi.encode(address(this), _nonce++));
        m.curve = BondingCurve(payable(Clones.cloneDeterministic(curveImpl, salt)));
        m.token = DokuToken(Clones.cloneDeterministic(tokenImpl, salt));
        m.grad = new MockGraduator();
        m.csink = new MockCreatorSink();
        m.quote = quote;
        m.target = target;
        m.sink = sink;
        m.token.initialize("Hunt", "HUNT", address(m.curve), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        m.curve.initialize(
            address(m.token), quote, target, sink, routed, taxBps, taxTo, TREASURY, address(m.grad), address(m.csink)
        );
    }

    function _simple(address quote, uint8 sink, uint256 target) internal returns (Market memory) {
        return _launch(quote, sink, sink == Sinks.CREATOR ? address(0xC0FFEE) : address(0), 0, address(0), target);
    }

    // -------------------------------------------------------------------- balances & identities

    /// @dev `bound` with a hi that may be under lo; keeps a fuzz body from dying on its own setup.
    function _amt(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi < lo) hi = lo;
        return bound(x, lo, hi);
    }

    function _quoteBal(Market memory m, address who) internal view returns (uint256) {
        return m.quote == address(0) ? who.balance : IERC20(m.quote).balanceOf(who);
    }

    /// @dev The identity the whole design rests on. Returns balance minus every booked liability;
    ///      zero is solvent-and-exact, negative is a hole, positive is stranded value.
    function _slack(Market memory m) internal view returns (int256) {
        BondingCurve c = m.curve;
        uint256 liab = c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax();
        return int256(_quoteBal(m, address(c))) - int256(liab);
    }

    /// @dev `balance == launchSupply + base - CEILING`, the identity `_latchFill` derives `seedBase`
    ///      from. Any drift makes the seed a lie.
    function _baseSlack(Market memory m) internal view returns (int256) {
        (uint128 b,) = m.curve.reserves();
        return int256(m.token.balanceOf(address(m.curve))) - (int256(m.curve.launchSupply()) + int256(uint256(b)) - int256(C));
    }

    function _k(Market memory m) internal view returns (uint256) {
        (uint128 b, uint128 q) = m.curve.reserves();
        return uint256(b) * uint256(q);
    }

    // -------------------------------------------------------------------------------- trading

    function _fund(Market memory m, address who, uint256 amount) internal {
        if (m.quote == address(0)) {
            vm.deal(who, who.balance + amount);
        } else {
            MockUSDC(m.quote).mint(who, amount);
            vm.prank(who);
            IERC20(m.quote).approve(address(m.curve), type(uint256).max);
        }
    }

    function _buy(Market memory m, address who, uint256 amount) internal returns (uint256 out) {
        vm.prank(who);
        if (m.quote == address(0)) {
            out = m.curve.buy{value: amount}(0, type(uint256).max);
        } else {
            out = m.curve.buyWithToken(amount, 0, type(uint256).max);
        }
    }

    function _sell(Market memory m, address who, uint256 baseIn) internal returns (uint256 out) {
        vm.startPrank(who);
        m.token.approve(address(m.curve), type(uint256).max);
        out = m.curve.sell(baseIn, 0, type(uint256).max);
        vm.stopPrank();
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        1. THE ACCOUNTING IDENTITY — can `quoteRaised` and the balance diverge?
//////////////////////////////////////////////////////////////////////////////*/

contract CurveSolvencyTest is Bench {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _bench();
    }

    /// @dev Every levy of a buy, plus the refund, must add back up to the gross — exactly, on both
    ///      levy currencies and at every anti-sniper rate. This is the invariant the F1 factory bug
    ///      breaks from OUTSIDE the curve; here it is checked from inside.
    function testFuzz_buySolvencyIsExactNotMerelySufficient(
        uint96 target5,
        uint96 spend,
        uint8 sinkRaw,
        uint16 taxRaw,
        uint32 warp,
        bool erc20
    ) public {
        uint256 target = (uint256(bound(target5, 1, 2 ** 40)) * 5);
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 taxBps = uint16(bound(taxRaw, 0, 1000));
        address quote = erc20 ? address(new MockUSDC()) : address(0);

        Market memory m = _launch(
            quote,
            sink,
            sink == Sinks.CREATOR ? address(0xC0FFEE) : address(0),
            taxBps,
            taxBps == 0 ? address(0) : address(0xDECAF),
            target
        );
        vm.warp(vm.getBlockTimestamp() + bound(warp, 0, 600));

        uint256 amount = bound(spend, 1, target * 3 + 10);
        _fund(m, alice, amount);
        uint256 before = _quoteBal(m, alice);
        _buy(m, alice, amount);

        assertEq(_slack(m), int256(0), "curve balance != quoteRaised + pending buckets");
        assertEq(_baseSlack(m), int256(0), "token balance != launchSupply + base - ceiling");
        // The buyer's spend equals gross minus refund, and the refund came home.
        assertLe(before - _quoteBal(m, alice), amount, "spent more than sent");
    }

    /// @dev A sequence of buys and sells, interleaved, with the clock moving. Nothing may open a
    ///      hole and nothing may strand value.
    function testFuzz_solvencyHoldsAcrossAnInterleavedSequence(
        uint96 target5,
        uint8 sinkRaw,
        uint16 taxRaw,
        uint96[8] memory amounts,
        bool[8] memory isSell,
        bool erc20
    ) public {
        uint256 target = uint256(bound(target5, 1_000, 2 ** 36)) * 5;
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 taxBps = uint16(bound(taxRaw, 0, 1000));
        Market memory m = _launch(
            erc20 ? address(new MockUSDC()) : address(0),
            sink,
            sink == Sinks.CREATOR ? address(0xC0FFEE) : address(0),
            taxBps,
            taxBps == 0 ? address(0) : address(0xDECAF),
            target
        );

        uint256 k = _k(m);
        for (uint256 i = 0; i < 8; i++) {
            if (m.curve.readyToGraduate()) break;
            vm.warp(vm.getBlockTimestamp() + 37);
            if (isSell[i]) {
                uint256 held = m.token.balanceOf(alice);
                if (held == 0) continue;
                uint256 baseIn = bound(uint256(amounts[i]), 1, held);
                (uint256 q,,) = m.curve.quoteSell(baseIn);
                if (q == 0) continue; // ZeroOutput, documented
                _sell(m, alice, baseIn);
            } else {
                uint256 amount = bound(uint256(amounts[i]), 1, target / 3 + 1);
                _fund(m, alice, amount);
                _buy(m, alice, amount);
            }
            assertEq(_slack(m), int256(0), "quote identity broke");
            assertEq(_baseSlack(m), int256(0), "base identity broke");
            uint256 k2 = _k(m);
            assertGe(k2, k, "k decreased - the pool paid the trader a rounding wei");
            k = k2;
        }
    }

    /// @dev The pending buckets are the only claim on the curve besides the raise. Draining all
    ///      three must never eat into `quoteRaised`.
    function testFuzz_collectingEveryBucketNeverTouchesTheRaise(uint96 target5, uint96 spend, uint16 taxRaw) public {
        uint256 target = uint256(bound(target5, 1e9, 2 ** 36)) * 5;
        uint16 taxBps = uint16(bound(taxRaw, 1, 1000));
        Market memory m = _launch(address(0), Sinks.CREATOR, address(0xC0FFEE), taxBps, address(0xDECAF), target);

        uint256 amount = _amt(spend, 1e12, target / 2 + 1);
        _fund(m, alice, amount);
        _buy(m, alice, amount);

        if (m.curve.pendingProtocol() != 0) m.curve.collectProtocolFees();
        if (m.curve.pendingFees() != 0) m.curve.collectFees();
        if (m.curve.pendingTax() != 0) m.curve.collectTax();

        assertEq(_slack(m), int256(0), "collection opened a hole");
        assertGe(address(m.curve).balance, m.curve.quoteRaised(), "the raise is short");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        2. THE CURVE ARITHMETIC — does rounding ever favour the trader?
//////////////////////////////////////////////////////////////////////////////*/

contract CurveMathDirectionTest is Bench {
    address internal alice = address(0xA11CE);

    function setUp() public {
        _bench();
    }

    /// @dev `k` after a priced leg is never below `k` before it, at any magnitude, on either side.
    function testFuzz_libraryRoundsToThePoolOnBothSides(uint128 b, uint128 q, uint128 dIn, bool buying) public pure {
        uint256 base = bound(uint256(b), 1e6, C);
        uint256 quote = bound(uint256(q), 1, 2 ** 120);
        uint256 amountIn = bound(uint256(dIn), 0, 2 ** 120);
        if (buying) {
            uint256 out = CurveMath.baseOut(base, quote, amountIn);
            assertLe(out, base, "sold more base than the reserve holds");
            assertGe((base - out) * (quote + amountIn), base * quote, "k fell on a buy");
        } else {
            uint256 out = CurveMath.quoteOut(base, quote, amountIn);
            assertLe(out, quote, "paid more quote than the reserve holds");
            assertGe((base + amountIn) * (quote - out), base * quote, "k fell on a sell");
        }
    }

    /// @dev Buy then sell the whole position back in the next call. Ignoring fees entirely, the
    ///      curve must never hand back more quote than it took.
    function testFuzz_roundTripNeverReturnsMoreThanItCost(uint96 target5, uint96 spend, uint32 warp) public {
        uint256 target = uint256(bound(target5, 1e9, 2 ** 36)) * 5;
        // Zero fee is impossible on this contract, so the strongest available statement is against
        // a market with no creator tax on the largest sink share — any profit here is pure math.
        Market memory m = _simple(address(0), Sinks.REWARDS, target);
        vm.warp(vm.getBlockTimestamp() + bound(warp, 300, 900)); // past the anti-sniper window

        uint256 amount = _amt(spend, 1e9, target / 2 + 1);
        _fund(m, alice, amount);
        uint256 got = _buy(m, alice, amount);
        if (got == 0) return;
        (uint256 q,,) = m.curve.quoteSell(got);
        if (q == 0) return;
        uint256 back = _sell(m, alice, got);
        assertLt(back, amount, "a round trip returned at least what it cost");
    }

    /**
     * @dev Splitting a buy DOES beat one buy, and this pins the size of it.
     *
     *      The CURVE arithmetic is not the source — `CurveMath` rounds to the pool on every leg
     *      and the test above proves `k` never falls. The source is the LEVY: `_split` computes
     *      `fee`, `protocol` and `creatorTax` with integer division, so each piece floors its own
     *      levy and `n` pieces keep up to `n` extra raw units of quote out of the fee buckets and
     *      inside `curveAmount`.
     *
     *      So the escape is bounded by ONE RAW QUOTE UNIT PER EXTRA TRANSACTION, asserted here as
     *      an exact bound on `quoteRaised`. On the coarsest registered quote that is 1e-6 of a
     *      unit; on MON it is one wei. Both are orders of magnitude below the gas of the extra
     *      call, which is why this is a footnote and not a finding.
     */
    function testFuzz_splittingABuyGainsAtMostOneRawUnitPerExtraCall(uint96 target5, uint96 spend, uint8 pieces)
        public
    {
        uint256 target = uint256(bound(target5, 1e9, 2 ** 34)) * 5;
        uint256 n = bound(pieces, 2, 12);
        uint256 amount = _amt(spend, n * 1e6, target / 4 + n);

        Market memory whole = _simple(address(0), Sinks.REWARDS, target);
        Market memory split = _simple(address(0), Sinks.REWARDS, target);
        vm.warp(vm.getBlockTimestamp() + 1_000);

        _fund(whole, alice, amount);
        _buy(whole, alice, amount);

        _buyInPieces(split, amount, n);

        uint256 one = whole.curve.quoteRaised();
        uint256 many = split.curve.quoteRaised();
        if (many > one) {
            assertLe(many - one, n, "split kept back more than one raw quote unit per piece");
        }
        // And the money is still all there on both sides.
        assertEq(_slack(whole), int256(0), "whole market identity broke");
        assertEq(_slack(split), int256(0), "split market identity broke");
    }

    function _buyInPieces(Market memory m, uint256 amount, uint256 n) internal {
        uint256 spent;
        for (uint256 i = 0; i < n; i++) {
            uint256 piece = i == n - 1 ? amount - spent : amount / n;
            spent += piece;
            _fund(m, alice, piece);
            _buy(m, alice, piece);
        }
    }

    /// @dev The anti-sniper tax floors, so splitting shaves wei off it. Bound the shave: it must
    ///      stay under one raw unit per piece, which is far below the extra curve slippage paid.
    function testFuzz_splittingCannotEscapeTheAntiSniperTax(uint96 spend, uint8 pieces) public {
        uint256 target = 400_000e18;
        uint256 n = bound(pieces, 2, 16);
        uint256 amount = _amt(spend, n * 1e15, target / 4);

        Market memory whole = _simple(address(0), Sinks.REWARDS, target);
        Market memory split = _simple(address(0), Sinks.REWARDS, target);
        // Both markets launched in the same block, so both see the same rate.
        _fund(whole, alice, amount);
        _buy(whole, alice, amount);

        _buyInPieces(split, amount, n);
        uint256 a = whole.curve.taxEscrow();
        uint256 b = split.curve.taxEscrow();
        if (b < a) assertLe(a - b, n, "the anti-sniper tax shrank by more than one wei per piece");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        3. THE FILL — does the seed the graduator demands always exist?
//////////////////////////////////////////////////////////////////////////////*/

contract CurveFillTest is Bench {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _bench();
    }

    /// @dev `DokuGraduation` refuses a raise that is not EXACTLY the target and a seed below
    ///      `DOKU_SEED_BASE` (`src/DokuGraduation.sol:228`). Both must hold however the curve was
    ///      traded, or the raise is sealed in.
    function testFuzz_theFillAlwaysSatisfiesTheGraduatorsTwoChecks(
        uint96 target5,
        uint8 sinkRaw,
        uint16 taxRaw,
        uint96[6] memory amounts,
        bool[6] memory isSell,
        bool erc20
    ) public {
        uint256 target = uint256(bound(target5, 1_000, 2 ** 34)) * 5;
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 taxBps = uint16(bound(taxRaw, 0, 1000));
        Market memory m = _launch(
            erc20 ? address(new MockUSDC()) : address(0),
            sink,
            sink == Sinks.CREATOR ? address(0xC0FFEE) : address(0),
            taxBps,
            taxBps == 0 ? address(0) : address(0xDECAF),
            target
        );

        for (uint256 i = 0; i < 6 && !m.curve.readyToGraduate(); i++) {
            vm.warp(vm.getBlockTimestamp() + 51);
            if (isSell[i]) {
                uint256 held = m.token.balanceOf(alice);
                if (held == 0) continue;
                uint256 baseIn = bound(uint256(amounts[i]), 1, held);
                (uint256 q,,) = m.curve.quoteSell(baseIn);
                if (q == 0) continue;
                _sell(m, alice, baseIn);
            } else {
                uint256 amount = bound(uint256(amounts[i]), 1, target / 2 + 1);
                _fund(m, alice, amount);
                _buy(m, alice, amount);
            }
        }
        // Fill it, unless the loop already did.
        if (!m.curve.readyToGraduate()) {
            _fund(m, bob, target * 2);
            _buy(m, bob, target * 2);
        }

        assertTrue(m.curve.readyToGraduate(), "did not latch");
        assertEq(m.curve.quoteRaised(), target, "raise is not exactly the target");
        assertGe(m.curve.seedBase(), DOKU_SEED_BASE, "seed is below the graduator's floor");
        assertGe(m.token.balanceOf(address(m.curve)), m.curve.seedBase(), "curve cannot pay the seed it latched");
        assertEq(_slack(m), int256(0), "quote identity broke at the fill");
    }

    /// @dev And the release actually clears. This is the shape a permanent freeze would take.
    function testFuzz_releasePaysTheSeedAndTheRaiseAndLeavesTheBucketsAlone(uint96 target5, uint16 taxRaw, bool erc20)
        public
    {
        uint256 target = uint256(bound(target5, 1_000, 2 ** 34)) * 5;
        uint16 taxBps = uint16(bound(taxRaw, 0, 1000));
        Market memory m = _launch(
            erc20 ? address(new MockUSDC()) : address(0),
            Sinks.CREATOR,
            address(0xC0FFEE),
            taxBps,
            taxBps == 0 ? address(0) : address(0xDECAF),
            target
        );
        _fund(m, alice, target * 2);
        _buy(m, alice, target * 2);
        assertTrue(m.curve.readyToGraduate(), "did not latch");

        uint256 pp = m.curve.pendingProtocol();
        uint256 pf = m.curve.pendingFees();
        uint256 pt = m.curve.pendingTax();

        m.grad.release(m.curve);

        assertTrue(m.curve.released(), "release did not run");
        assertEq(_quoteBal(m, address(m.grad)), target, "graduator did not receive the raise");
        assertEq(m.token.balanceOf(address(m.grad)), m.curve.seedBase(), "graduator did not receive the seed");
        assertEq(m.curve.pendingProtocol(), pp, "release moved the protocol bucket");
        assertEq(m.curve.pendingFees(), pf, "release moved the sink bucket");
        assertEq(m.curve.pendingTax(), pt, "release moved the tax bucket");
        assertEq(_slack(m), int256(0), "release opened a hole");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        4. ADVERSARIAL PROBES
//////////////////////////////////////////////////////////////////////////////*/

contract CurveReentrancyProbe is Bench, IReenterHook {
    CallbackQuote internal q;
    Market internal m;
    uint256 public attempts;
    uint256 public successes;
    string public lastError;
    uint8 public mode; // 0 buy, 1 sell, 2 collectFees, 3 collectTax, 4 collectProtocolFees

    function setUp() public {
        _bench();
        q = new CallbackQuote(6);
        m = _launch(address(q), Sinks.CREATOR, address(this), 500, address(this), 5_000_000e6);
        q.mint(address(this), 1e18);
        q.approve(address(m.curve), type(uint256).max);
        m.token.approve(address(m.curve), type(uint256).max);
    }

    function onQuoteMove(address) external override {
        attempts++;
        try this.reenter() {
            successes++;
        } catch Error(string memory r) {
            lastError = r;
        } catch (bytes memory r) {
            lastError = _sel(r);
        }
    }

    function reenter() external {
        require(msg.sender == address(this), "self");
        if (mode == 0) m.curve.buyWithToken(1e6, 0, type(uint256).max);
        else if (mode == 1) m.curve.sell(1e18, 0, type(uint256).max);
        else if (mode == 2) m.curve.collectFees();
        else if (mode == 3) m.curve.collectTax();
        else m.curve.collectProtocolFees();
    }

    function _sel(bytes memory r) private pure returns (string memory) {
        if (r.length < 4) return "empty";
        return string(abi.encodePacked(vm.toString(bytes4(r))));
    }

    /// @dev Every inbound and outbound quote leg of the curve, entered from inside the quote
    ///      token's own transfer, with a live callback. The curve's own guard must close all of
    ///      them — which is the property `_pullAndBuy` claims and `sell`, `collectFees` and the
    ///      refund leg have never been asserted to have.
    function test_noCurveEntryPointIsReEnterableThroughTheQuoteToken() public {
        // Seed the buckets so the collect paths have something to pay.
        q.mint(address(this), 2_000_000e6);
        m.curve.buyWithToken(1_000_000e6, 0, type(uint256).max);
        m.token.approve(address(m.curve), type(uint256).max);

        for (uint8 i = 0; i < 5; i++) {
            mode = i;
            uint256 a0 = attempts;
            uint256 s0 = successes;
            q.arm(address(this));
            if (i == 1) {
                m.curve.sell(m.token.balanceOf(address(this)) / 8, 0, type(uint256).max);
            } else if (i == 2) {
                m.curve.collectFees();
            } else if (i == 3) {
                m.curve.collectTax();
            } else if (i == 4) {
                m.curve.collectProtocolFees();
            } else {
                m.curve.buyWithToken(100_000e6, 0, type(uint256).max);
            }
            assertGt(attempts, a0, string.concat("mode ", vm.toString(i), ": the callback never fired"));
            assertEq(successes, s0, string.concat("mode ", vm.toString(i), ": REENTERED THE CURVE"));
            assertEq(_slack(m), int256(0), string.concat("mode ", vm.toString(i), ": identity broke"));
        }
    }

    receive() external payable {}
}

contract CurveDustAndCoarseQuoteTest is Bench {
    address internal alice = address(0xA11CE);

    function setUp() public {
        _bench();
    }

    /// @dev The whole levy floors, so a small enough buy pays none of it. Quantify the escape and
    ///      the arithmetic that would be needed to make it worth anything.
    function test_dustBuysEscapeTheEntireLevy() public {
        MockUSDC usdc = new MockUSDC();
        Market memory m = _launch(address(usdc), Sinks.CREATOR, address(0xC0FFEE), 1000, address(0xDECAF), 8_000e6);
        vm.warp(vm.getBlockTimestamp() + 1_000);

        uint256 free;
        for (uint256 g = 1; g < 200; g++) {
            (, uint256 fee,, uint256 ctax,) = m.curve.quoteBuy(g);
            if (fee == 0 && ctax == 0) free = g;
        }
        console2.log("largest gross paying ZERO levy (6-dec quote, 10% creator tax):", free);
        assertGt(free, 0, "expected a dust window");

        // What it would take to move a meaningful sum through it.
        uint256 oneDollar = 1e6;
        console2.log("dust buys needed to move $1 fee-free:", oneDollar / free);
        // And the levy really is zero on the fill, not merely in the quote.
        _fund(m, alice, free);
        _buy(m, alice, free);
        assertEq(m.curve.pendingProtocol(), 0, "protocol took something");
        assertEq(m.curve.pendingFees(), 0, "sink took something");
        assertEq(m.curve.pendingTax(), 0, "creator took something");
        assertEq(_slack(m), int256(0), "identity broke");
    }

    /// @dev `ZeroOutput` on a coarse quote, exactly as the source documents it. Reachable with
    ///      ordinary amounts; the guard is the revert, not `minQuoteOut`.
    function test_zeroOutputSellIsReachableWithOrdinaryAmountsOnGold() public {
        MockUSDC gold = new MockUSDC(); // 6 decimals, as XAUt0
        Market memory m = _simple(address(gold), Sinks.REWARDS, 2_400_000); // ~$8,000 of gold
        _fund(m, alice, 1_200_000);
        _buy(m, alice, 1_200_000);

        // Find the largest holding that still sells for nothing.
        uint256 lo = 1;
        uint256 hi = m.token.balanceOf(alice);
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            (uint256 out,,) = m.curve.quoteSell(mid);
            if (out == 0) lo = mid;
            else hi = mid - 1;
        }
        console2.log("largest holding that sells for ZERO quote (whole tokens):", lo / 1e18);
        assertGt(lo, 1e18, "expected whole tokens to be unsellable");

        vm.startPrank(alice);
        m.token.approve(address(m.curve), type(uint256).max);
        vm.expectRevert(BondingCurve.ZeroOutput.selector);
        m.curve.sell(lo, 0, type(uint256).max);
        vm.stopPrank();
    }

    /// @dev The mirror question: is `ZeroOutput` reachable on a BUY, where there is no such guard?
    ///      A zero-output buy would raise `quoteRaised` without moving base and inflate the seed.
    function test_aBuyOfOneRawUnitAlwaysReturnsTokens() public {
        MockUSDC gold = new MockUSDC();
        Market memory m = _simple(address(gold), Sinks.REWARDS, 2_400_000);
        (uint256 out,,,,) = m.curve.quoteBuy(1);
        console2.log("base out for 1 raw unit of a 6-dec quote at launch:", out);
        assertGt(out, 0, "a buy CAN return zero - the seed can be inflated for free");

        // And near the fill, where the base reserve is at its smallest.
        _fund(m, alice, 2_399_999);
        _buy(m, alice, 2_399_999);
        (uint256 out2,,,,) = m.curve.quoteBuy(1);
        console2.log("base out for 1 raw unit just below the fill:", out2);
        assertGt(out2, 0, "a buy CAN return zero near the fill");
    }
}

contract CurveDeferredPaymentTest is Bench {
    address internal alice = address(0xA11CE);

    function setUp() public {
        _bench();
    }

    /// @dev L-03 in the external review, FIXED. Kept as the regression, and flipped rather than
    ///      deleted: reverting the fix turns this red again.
    ///
    ///      What it used to do. A `transfer` returning a word that is neither 0 nor 1 made
    ///      `_tryPay`'s `abi.decode` revert INSIDE the collection, so the deferral never ran and the
    ///      bucket was stuck. `_tryPay` now classifies every shape that is not "empty, or a clean
    ///      32-byte true" as a failure and hands it to the CreatorSink.
    ///
    ///      Note this is stricter than the review's own recommendation, which only bounded the
    ///      LENGTH (`ret.length >= 32 && decodedTrue`). `abi.decode(..., (bool))` validates the
    ///      VALUE as well, so a 32-byte word of `2` still reverted under that rule. The matrix in
    ///      `test/audit/L03PayFallback.t.sol` walks all six shapes.
    function test_malformedTransferReturnDefersToTheSinkInsteadOfRevertingCollection() public {
        MalformedQuote bad = new MalformedQuote();
        Market memory m = _launch(address(bad), Sinks.CREATOR, address(0xC0FFEE), 1000, address(0xDECAF), 5_000_000e18);
        bad.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        bad.approve(address(m.curve), type(uint256).max);
        // The pull itself is a `transferFrom`, which this token leaves alone.
        m.curve.buyWithToken(1_000_000e18, 0, type(uint256).max);
        vm.stopPrank();

        uint256 tax = m.curve.pendingTax();
        assertGt(tax, 0, "no tax to collect");

        m.curve.collectTax();

        assertEq(m.curve.pendingTax(), 0, "the bucket is still stuck");
        assertEq(m.csink.credits(), 1, "the deferral never reached the sink");
        assertEq(m.csink.lastWho(), address(0xDECAF), "credited the wrong recipient");
        assertEq(m.csink.lastAmount(), tax, "credited the wrong amount");
    }

    /// @dev The designed path: a recipient that refuses native MON does not block the collection,
    ///      it defers to the CreatorSink. Asserted so the L-03 finding above is clearly the
    ///      malformed-returndata case and not the refusing-wallet case.
    function test_aRefusingWalletDefersRatherThanBlocking() public {
        address refuser = address(new Refuser());
        Market memory m = _launch(address(0), Sinks.CREATOR, refuser, 1000, refuser, 5_000e18);
        _fund(m, alice, 1_000e18);
        _buy(m, alice, 1_000e18);

        uint256 fees = m.curve.pendingFees();
        uint256 tax = m.curve.pendingTax();
        m.curve.collectFees();
        m.curve.collectTax();
        assertEq(address(m.csink).balance, fees + tax, "the sink did not take the deferred payment");
        assertEq(_slack(m), int256(0), "deferral opened a hole");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        5. THE RESIDUE — how far can a dust seller push the seed, and who pays?
//////////////////////////////////////////////////////////////////////////////*/

contract CurveSeedResidueTest is Bench {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        _bench();
    }

    /// @dev Internal audit finding #3 was that this residue is unbounded and, against generation
    ///      2's upper tolerance, froze the market. Generation 3 removed the tolerance
    ///      (`src/DokuGraduation.sol:212`). Measure what the residue still DOES: it is the gap
    ///      between the pool's opening price and the curve's closing spot.
    function test_dustSellsInflateTheSeedAndOpenThePoolBelowTheCurvesClose() public {
        MockUSDC gold = new MockUSDC();
        uint256 target = 2_400_000; // ~$8,000 of six-decimal gold

        Market memory clean = _simple(address(gold), Sinks.REWARDS, target);
        Market memory dirty = _simple(address(gold), Sinks.REWARDS, target);

        _fund(clean, alice, target * 2);
        _fund(dirty, alice, target * 2);

        // Dirty: buy in, then 400 dust sells, then fill.
        _buy(dirty, alice, target / 2);
        vm.startPrank(alice);
        dirty.token.approve(address(dirty.curve), type(uint256).max);
        uint256 done;
        for (uint256 i = 0; i < 400; i++) {
            uint256 baseIn = 1e18;
            (uint256 out,,) = dirty.curve.quoteSell(baseIn);
            if (out == 0) {
                // Find the smallest sell that pays anything, so the loop keeps making progress.
                baseIn = 400e18;
                (out,,) = dirty.curve.quoteSell(baseIn);
                if (out == 0) break;
            }
            dirty.curve.sell(baseIn, 0, type(uint256).max);
            done++;
        }
        vm.stopPrank();

        _fund(clean, bob, target * 2);
        _fund(dirty, bob, target * 2);
        _buy(clean, bob, target * 2);
        _buy(dirty, bob, target * 2);

        uint256 sClean = clean.curve.seedBase();
        uint256 sDirty = dirty.curve.seedBase();
        console2.log("dust sells performed:", done);
        console2.log("clean seed - DOKU_SEED_BASE:", sClean - DOKU_SEED_BASE);
        console2.log("dirty seed - DOKU_SEED_BASE:", sDirty - DOKU_SEED_BASE);
        console2.log("residue per dust sell (base wei):", done == 0 ? 0 : (sDirty - sClean) / done);

        assertGe(sDirty, sClean, "dust sells did not inflate the seed");
        // Both still clear the graduator's only remaining bound.
        assertGe(sClean, DOKU_SEED_BASE, "clean seed below floor");
        assertGe(sDirty, DOKU_SEED_BASE, "dirty seed below floor");
        assertEq(clean.curve.quoteRaised(), target, "clean raise inexact");
        assertEq(dirty.curve.quoteRaised(), target, "dirty raise inexact");
        // And both curves can pay what they latched.
        assertGe(dirty.token.balanceOf(address(dirty.curve)), sDirty, "curve cannot pay the seed");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        6. DONATIONS AND OUTSIDE BURNS — the generation-2 freeze class, re-run
//////////////////////////////////////////////////////////////////////////////*/

contract Boom {
    constructor() payable {}

    function bomb(address payable to) external {
        selfdestruct(to);
    }
}

contract CurveDonationTest is Bench {
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal mallory = address(0x4A11040);

    function setUp() public {
        _bench();
    }

    /// @dev Internal finding #1: one wei burned by anybody made `_latchFill` compute a short seed
    ///      and sealed the raise. `launchSupply` is latched at `initialize` now. Confirm dead.
    function test_anOutsideBurnBeforeTheFillNoLongerShortensTheSeed() public {
        Market memory clean = _simple(address(0), Sinks.REWARDS, 5_000e18);
        Market memory burnt = _simple(address(0), Sinks.REWARDS, 5_000e18);

        // Mallory buys a dust position on the second market and burns it.
        _fund(burnt, mallory, 1e18);
        _buy(burnt, mallory, 1e18);
        uint256 dust = burnt.token.balanceOf(mallory);
        vm.prank(mallory);
        burnt.token.burn(dust);
        assertLt(burnt.token.totalSupply(), burnt.curve.launchSupply(), "the burn did not land");

        _fund(clean, bob, 10_000e18);
        _fund(burnt, bob, 10_000e18);
        _buy(clean, bob, 10_000e18);
        _buy(burnt, bob, 10_000e18);

        assertGe(burnt.curve.seedBase(), DOKU_SEED_BASE, "outside burn shortened the seed");
        assertGe(burnt.token.balanceOf(address(burnt.curve)), burnt.curve.seedBase(), "curve cannot pay it");
        assertEq(burnt.curve.quoteRaised(), 5_000e18, "raise inexact");
        burnt.grad.release(burnt.curve);
        assertTrue(burnt.curve.released(), "release blocked by an outside burn");
        clean.grad.release(clean.curve);
        assertTrue(clean.curve.released(), "control failed");
    }

    /// @dev Internal finding #3's sibling: a token donation before the fill used to be absorbed
    ///      into `seedBase`. It is now stranded, which is the donor's loss and nobody else's.
    function test_aTokenDonationBeforeTheFillIsStrandedNotAbsorbed() public {
        Market memory clean = _simple(address(0), Sinks.REWARDS, 5_000e18);
        Market memory fat = _simple(address(0), Sinks.REWARDS, 5_000e18);

        _fund(fat, mallory, 1e18);
        _buy(fat, mallory, 1e18);
        uint256 gift = fat.token.balanceOf(mallory);
        vm.prank(mallory);
        fat.token.transfer(address(fat.curve), gift);

        _fund(clean, bob, 10_000e18);
        _fund(fat, bob, 10_000e18);
        _buy(clean, bob, 10_000e18);
        _buy(fat, bob, 10_000e18);

        // The seed the graduator is handed ignores the gift entirely.
        assertLt(
            fat.curve.seedBase(), DOKU_SEED_BASE + gift, "the donation was absorbed into the seed"
        );
        fat.grad.release(fat.curve);
        assertTrue(fat.curve.released(), "release blocked by a donation");
        assertGe(fat.token.balanceOf(address(fat.curve)), gift - 1e18, "the gift is not stranded here");
    }

    /// @dev `receive()` reverts, but `selfdestruct` still forces MON in. It must be stranded — a
    ///      positive slack, never a payable one — and no path may draw on it.
    function test_forcedNativeIsStrandedAndUnreachable() public {
        Market memory m = _launch(address(0), Sinks.CREATOR, address(0xC0FFEE), 1000, address(0xDECAF), 5_000e18);
        _fund(m, alice, 1_000e18);
        _buy(m, alice, 1_000e18);
        assertEq(_slack(m), int256(0), "started dirty");

        // The bare send is refused ...
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        (bool ok,) = address(m.curve).call{value: 1 ether}("");
        assertFalse(ok, "receive() accepted a bare send");

        // ... and the forced one is stranded.
        Boom b = new Boom{value: 1 ether}();
        b.bomb(payable(address(m.curve)));
        assertEq(_slack(m), int256(1 ether), "forced MON was booked as a liability");

        // Nothing pays it out: every collector pays its own bucket and stops.
        _collectAllAndCheck(m);

        // Not even the fill and the release reach it.
        _fund(m, bob, 20_000e18);
        _buy(m, bob, 20_000e18);
        m.grad.release(m.curve);
        assertEq(address(m.grad).balance, 5_000e18, "the graduator took more than the target");
        assertEq(_slack(m), int256(1 ether), "stranded MON left the curve");
    }

    function _collectAllAndCheck(Market memory m) internal {
        uint256 pp = m.curve.pendingProtocol();
        uint256 pf = m.curve.pendingFees();
        uint256 pt = m.curve.pendingTax();
        m.curve.collectProtocolFees();
        m.curve.collectFees();
        m.curve.collectTax();
        assertEq(TREASURY.balance, pp, "protocol drew on the stranded MON");
        assertEq(address(0xC0FFEE).balance, pf, "sink drew on the stranded MON");
        assertEq(address(0xDECAF).balance, pt, "tax recipient drew on the stranded MON");
    }

    /// @dev `buyFor` is the one rate-exempt entry point. Only the factory may reach it, and only
    ///      with the value the market's quote demands.
    function test_buyForIsClosedToEveryoneButTheFactory() public {
        Market memory m = _simple(address(0), Sinks.REWARDS, 5_000e18);
        vm.deal(mallory, 10e18);
        vm.prank(mallory);
        vm.expectRevert(BondingCurve.NotFactory.selector);
        m.curve.buyFor{value: 1e18}(mallory, 1e18, 0, type(uint256).max);

        // The factory itself cannot mismatch the value.
        vm.deal(address(this), 10e18);
        vm.expectRevert(abi.encodeWithSelector(BondingCurve.ValueMismatch.selector, 1e18, 2e18));
        m.curve.buyFor{value: 1e18}(alice, 2e18, 0, type(uint256).max);

        // And it books exactly what it was sent.
        m.curve.buyFor{value: 1e18}(alice, 1e18, 0, type(uint256).max);
        assertEq(_slack(m), int256(0), "buyFor opened a hole");
        assertEq(m.curve.taxEscrow(), 0, "buyFor charged the anti-sniper tax");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        7. THE QUOTE ISSUER — the one outside party that can seal a filled curve
//////////////////////////////////////////////////////////////////////////////*/

contract CurveIssuerFreezeTest is Bench {
    address internal alice = address(0xA11CE);

    function setUp() public {
        _bench();
    }

    /**
     * @dev Four of the seven registered quotes (USDC, USDT0, cbBTC, WBTC) carry an issuer freeze.
     *      `release` is the ONLY way the raise leaves the curve and `graduate` is its only caller,
     *      so a freeze on either the curve or the graduator seals a filled market's entire raise
     *      for as long as it stands. Nothing in the protocol can route around it — there is no
     *      rescue by design, and `release` cannot pay a different address.
     *
     *      It is RECOVERABLE — `released` is written before the transfers, so a reverting
     *      `_payQuote` unwinds the whole call and a later `graduate` still works once the freeze
     *      lifts. That is what separates this from the generation-2 freezes, which were permanent.
     */
    function test_anIssuerFreezeOnTheGraduatorSealsAFilledCurveUntilItLifts() public {
        MockUSDC usdc = new MockUSDC();
        Market memory m = _simple(address(usdc), Sinks.REWARDS, 5_000_000e6);
        _fund(m, alice, 10_000_000e6);
        _buy(m, alice, 10_000_000e6);
        assertTrue(m.curve.readyToGraduate(), "did not fill");

        usdc.setBlocked(address(m.grad), true);
        vm.expectRevert();
        m.grad.release(m.curve);
        assertFalse(m.curve.released(), "released latched on a failed transfer");
        assertEq(m.curve.quoteRaised(), 5_000_000e6, "the raise was zeroed by a failed release");

        // It lifts, and the market graduates as if nothing happened.
        usdc.setBlocked(address(m.grad), false);
        m.grad.release(m.curve);
        assertTrue(m.curve.released(), "not recoverable");
        assertEq(usdc.balanceOf(address(m.grad)), 5_000_000e6, "raise did not arrive");
    }

    /// @dev And the same freeze on the CURVE stops trading entirely, in both directions, with the
    ///      raise inside. Again attacker-unreachable and again recoverable.
    function test_anIssuerFreezeOnTheCurveStopsBothLegs() public {
        MockUSDC usdc = new MockUSDC();
        Market memory m = _simple(address(usdc), Sinks.REWARDS, 5_000_000e6);
        _fund(m, alice, 4_000_000e6);
        _buy(m, alice, 1_000_000e6);

        usdc.setBlocked(address(m.curve), true);
        vm.prank(alice);
        vm.expectRevert();
        m.curve.buyWithToken(1_000e6, 0, type(uint256).max);

        usdc.setBlocked(address(m.curve), false);
        usdc.setBlocked(alice, true);
        uint256 held = m.token.balanceOf(alice);
        vm.startPrank(alice);
        m.token.approve(address(m.curve), type(uint256).max);
        vm.expectRevert();
        m.curve.sell(held / 4, 0, type(uint256).max);
        vm.stopPrank();

        usdc.setBlocked(alice, false);
        assertGt(_sell(m, alice, held / 4), 0, "not recoverable");
        assertEq(_slack(m), int256(0), "the freeze left a hole behind");
    }
}

/*//////////////////////////////////////////////////////////////////////////////
        8. `release()` HAS NO GUARD — is the stated reasoning the load-bearing one?
//////////////////////////////////////////////////////////////////////////////*/

/// @dev The graduator, as `DokuGraduation` is: it calls `release` from OUTSIDE any curve frame, so
///      the curve's own `nonReentrant` is NOT on the stack for the duration.
contract ManualGraduator {
    function release(BondingCurve c) external returns (uint256 q, uint256 b) {
        return c.release();
    }

    function sinkOf(address) external pure returns (address) {
        return address(0);
    }

    function creditCurveTax(address) external payable {}
    function creditCurveTax(address, uint256) external {}

    receive() external payable {}
}

contract CurveReleaseGuardTest is Bench, IReenterHook {
    CallbackQuote internal q;
    Market internal m;
    ManualGraduator internal g;
    bool internal live;
    uint256 public feesTaken;
    uint256 public taxTaken;
    bool public reenteredSuccessfully;

    address internal alice = address(0xA11CE);

    function setUp() public {
        _bench();
        q = new CallbackQuote(6);
        g = new ManualGraduator();
        // Built by hand so the graduator is the one that calls `release` from outside a curve frame.
        bytes32 salt = keccak256(abi.encode(address(this), uint256(0xBEEF)));
        m.curve = BondingCurve(payable(Clones.cloneDeterministic(curveImpl, salt)));
        m.token = DokuToken(Clones.cloneDeterministic(tokenImpl, salt));
        m.csink = new MockCreatorSink();
        m.quote = address(q);
        m.target = 5_000_000e6;
        m.sink = Sinks.CREATOR;
        m.token.initialize("Hunt", "HUNT", address(m.curve), false, "https://cdn.doku.family/metadata/test.json");
        m.curve.initialize(
            address(m.token), address(q), m.target, Sinks.CREATOR, address(this), 1000, address(this), TREASURY, address(g), address(m.csink)
        );
    }

    function onQuoteMove(address) external override {
        if (!live) return;
        live = false;
        // The curve's guard is not on the stack: this is `graduate -> release -> transfer -> here`.
        try m.curve.collectFees() {
            reenteredSuccessfully = true;
            feesTaken = 1;
        } catch {}
        try m.curve.collectTax() {
            taxTaken = 1;
        } catch {}
    }

    /**
     * @dev `release` drops the reentrancy guard deliberately (D3), and the source's stated reason
     *      is that "`DokuToken` has no transfer hook, so there is no path back in".
     *
     *      That reason covers the TOKEN leg only. The QUOTE leg — `_payQuote` — is the last
     *      statement of `release`, and on a callback-bearing quote it hands control to arbitrary
     *      code with the curve's guard OFF, because a manual `graduate` never puts a curve
     *      function on the stack. This proves the re-entry actually happens and that the outcome
     *      is nonetheless solvent.
     *
     *      What saves it is the OTHER two clauses of the same comment, not the token one:
     *      `released` is written before any transfer and the pending buckets are disjoint from
     *      `quoteRaised`, so the re-entrant collection spends only money that was already the
     *      collector's. Worth writing down for generation 4: the guarantee is "state is final and
     *      the buckets do not overlap", not "the token cannot call back".
     */
    function test_releaseIsReEnterableThroughTheQuoteAndStillSolvent() public {
        q.mint(alice, 20_000_000e6);
        vm.startPrank(alice);
        q.approve(address(m.curve), type(uint256).max);
        m.curve.buyWithToken(10_000_000e6, 0, type(uint256).max);
        vm.stopPrank();
        assertTrue(m.curve.readyToGraduate(), "did not fill");
        assertGt(m.curve.pendingFees(), 0, "no sink bucket to race");
        assertGt(m.curve.pendingTax(), 0, "no tax bucket to race");

        uint256 owedFees = m.curve.pendingFees();
        uint256 owedTax = m.curve.pendingTax();

        live = true;
        q.arm(address(this));
        g.release(m.curve);

        assertTrue(reenteredSuccessfully, "the quote could NOT re-enter release - guard reasoning is stronger than claimed");
        // Solvent anyway: the raise went to the graduator, the buckets went to their owners, and
        // nothing was paid twice.
        assertEq(q.balanceOf(address(g)), m.target, "the graduator did not get the whole raise");
        assertEq(m.curve.pendingFees(), 0, "sink bucket not cleared");
        assertEq(m.curve.pendingTax(), 0, "tax bucket not cleared");
        assertEq(q.balanceOf(address(this)), owedFees + owedTax, "the re-entrant collector took more than it was owed");
        assertEq(_slack(m), int256(0), "re-entering release opened a hole");
    }

    receive() external payable {}
}

/*//////////////////////////////////////////////////////////////////////////////
        9. THE NEAR MISS: a REWARDS escrow collected DURING release
//////////////////////////////////////////////////////////////////////////////*/

/// @dev `DokuGraduation.graduate` writes `graduated[curve] = true` at step 0
///      (`src/DokuGraduation.sol:171`) but only writes `poolIdOf[curve]` at step 3, AFTER
///      `c.release()` (`src/DokuGraduation.sol:201,241`). So a re-entrant
///      `BondingCurve.collectFees` landing inside release's payout passes
///      `creditCurveTax`'s `graduated[curve]` gate (`:419`,`:425`) with `poolIdOf[curve]` still
///      `PoolId(0)`. This models what the hook then does with that id:
///      `_requireQuotePayingSink` reads `_markets[0].registered == false` and reverts
///      `UnknownPool` (`src/v4/DokuHook.sol:1083`).
contract GateModellingGraduator {
    error UnknownPool();

    mapping(address => bytes32) public poolIdOf;
    mapping(address => bool) public graduated;

    function sinkOf(address) external pure returns (address) {
        return address(0);
    }

    function creditCurveTax(address curve) external payable {
        if (poolIdOf[curve] == bytes32(0)) revert UnknownPool();
    }

    function creditCurveTax(address curve, uint256 amount) external {
        if (poolIdOf[curve] == bytes32(0)) revert UnknownPool();
        IERC20(BondingCurve(payable(curve)).quoteAsset()).transferFrom(msg.sender, address(this), amount);
    }

    /// @notice Closed during the filling buy so `_tryAutoGraduate` swallows a failure and the
    ///         market has to be graduated by hand — which is the only shape where the curve's own
    ///         reentrancy guard is NOT on the stack during `release`.
    bool public open;

    function setOpen(bool v) external {
        open = v;
    }

    /// @dev The real `graduate`'s ordering, reduced to the two writes that matter.
    function graduate(address curve) external {
        require(open, "closed");
        graduated[curve] = true; // step 0
        BondingCurve(payable(curve)).release(); // step 2
        poolIdOf[curve] = keccak256(abi.encode(curve)); // step 3
    }

    receive() external payable {}
}

contract CurveRewardsEscrowRaceTest is Bench, IReenterHook {
    CallbackQuote internal q;
    Market internal m;
    GateModellingGraduator internal g;
    bool internal live;
    bool public collectAttempted;
    bool public collectSucceeded;

    address internal alice = address(0xA11CE);

    function setUp() public {
        _bench();
        q = new CallbackQuote(6);
        g = new GateModellingGraduator();
        bytes32 salt = keccak256(abi.encode(address(this), uint256(0xFEED)));
        m.curve = BondingCurve(payable(Clones.cloneDeterministic(curveImpl, salt)));
        m.token = DokuToken(Clones.cloneDeterministic(tokenImpl, salt));
        m.csink = new MockCreatorSink();
        m.quote = address(q);
        m.target = 5_000_000e6;
        m.sink = Sinks.REWARDS;
        m.token.initialize("Hunt", "HUNT", address(m.curve), true, "https://cdn.doku.family/metadata/test.json");
        m.curve.initialize(
            address(m.token), address(q), m.target, Sinks.REWARDS, address(0), 0, address(0), TREASURY, address(g), address(m.csink)
        );
    }

    function onQuoteMove(address) external override {
        if (!live) return;
        live = false;
        collectAttempted = true;
        try m.curve.collectFees() {
            collectSucceeded = true;
        } catch {}
    }

    /**
     * @dev The escrow of a REWARDS market is 70 bps of every buy up to the fill. If it could be
     *      collected inside release's payout window it would be credited against `PoolId(0)` and
     *      leave the market for good.
     *
     *      It cannot, and the check that stops it is in the HOOK, two contracts away
     *      (`src/v4/DokuHook.sol:1083`) — not in the curve and not in the graduator. The curve's
     *      own gate, `if (!released) revert NotGraduated()`, is already satisfied at that instant:
     *      `release` writes `released = true` before it pays. So this is a live example of a
     *      curve-side guard that is load-bearing only because a downstream contract happens to
     *      re-check.
     */
    function test_theRewardsEscrowCannotBeCollectedIntoPoolZeroDuringRelease() public {
        q.mint(alice, 20_000_000e6);
        vm.startPrank(alice);
        q.approve(address(m.curve), type(uint256).max);
        m.curve.buyWithToken(10_000_000e6, 0, type(uint256).max);
        vm.stopPrank();
        assertTrue(m.curve.readyToGraduate(), "did not fill");

        uint256 escrow = m.curve.pendingFees();
        assertGt(escrow, 0, "no escrow to race for");

        live = true;
        q.arm(address(this));
        g.setOpen(true);
        g.graduate(address(m.curve));

        assertTrue(collectAttempted, "the callback never fired - the race was not exercised");
        assertFalse(collectSucceeded, "THE ESCROW WAS COLLECTED INTO POOL ZERO");
        assertEq(m.curve.pendingFees(), escrow, "the escrow moved");
        assertEq(_slack(m), int256(0), "identity broke");

        // And once the pool id exists it collects normally, to the market's own ledger.
        m.curve.collectFees();
        assertEq(q.balanceOf(address(g)), m.target + escrow, "the escrow did not reach the graduator");
        assertEq(m.curve.pendingFees(), 0, "escrow not cleared");
    }

    receive() external payable {}
}
