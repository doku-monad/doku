// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * ROUND 3 — a FRESH, BROAD pass over `BondingCurve` / `CurveMath` / `TaxMath` / `Sinks`.
 *
 * Deliberately NOT a re-run of `Round1Solvency.t.sol`. That harness has a shape, and a shape is a
 * blind spot: one trader, one recipient set of code-less EOAs, `creatorSink == address(0)` (so the
 * deferred-credit arm of `_payOrCredit` can never run), two fixed targets, one quote decimal per
 * leg, no donations, no third-party burns, and no `release` inside the randomised walk.
 *
 * This harness varies every one of those and asserts FOUR independent identities after every step,
 * not one:
 *
 *   I1  quote solvency     quoteBooked() == held - donatedQuote
 *   I2  reserve/raise      _reserves.quote == quoteTarget*2/5 + quoteRaised      (pre-release)
 *   I3  base conservation  token.balanceOf(curve) == launchSupply + base - CEILING + donatedBase
 *   I4  seedability        seedBase <= token.balanceOf(curve)   once latched     (pre-release)
 *
 * I2/I3/I4 are the ones `Round1Solvency` does not make. I3 is what `_latchFill` computes the
 * graduation seed from, so a break in it is a bricked market with the raise inside; I4 is that
 * consequence stated directly.
 *
 * `vm.getBlockTimestamp()` / `vm.getBlockNumber()`: `via_ir = true` folds the bare globals across
 * `vm.warp`/`vm.roll`.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {CurveMath} from "../../src/lib/CurveMath.sol";
import {TaxMath} from "../../src/lib/TaxMath.sol";

// ------------------------------------------------------------------------------- fixtures

/// @dev An exact-transfer ERC-20 with a configurable decimal count. Nothing hostile; the hostile
///      shapes already have their own suites and this harness is about the arithmetic.
contract R3Quote is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 dec) ERC20("R3", "R3") {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev A graduator that does nothing unless the harness asks it to `release`. Separate from the
///      curve's auto-graduation so the walk can decide WHEN the raise leaves.
contract R3Graduator {
    address public immutable factory;
    bool public armed;
    uint256 public tookQuote;
    uint256 public tookBase;

    constructor(address f) {
        factory = f;
    }

    function arm(bool on) external {
        armed = on;
    }

    function graduate(address curve) external returns (bytes32, uint256) {
        if (!armed) revert("not armed");
        (uint256 q, uint256 b) = BondingCurve(payable(curve)).release();
        tookQuote += q;
        tookBase += b;
        return (bytes32(0), 0);
    }

    function sinkOf(address) external view returns (address) {
        return address(this);
    }

    function creditCurveTax(address) external payable {}

    function creditCurveTax(address, uint256 amount) external {
        address q = BondingCurve(payable(msg.sender)).quoteAsset();
        IERC20(q).transferFrom(msg.sender, address(this), amount);
    }

    receive() external payable {}
}

/// @dev The shared sink, reduced to the one behaviour the curve depends on: it accepts a credit,
///      taking native by value and ERC-20 by the allowance the curve just set. Present so the
///      DEFERRED arm of `_payOrCredit` actually executes in this walk — `Round1Solvency` passes
///      `address(0)` there, so that arm reverts and is swallowed by its own try/catch.
contract R3Sink {
    mapping(address => mapping(address => uint256)) public owed;

    function credit(address who, address quote, uint256 amount) external payable {
        if (quote == address(0)) {
            require(msg.value == amount, "value");
        } else {
            IERC20(quote).transferFrom(msg.sender, address(this), amount);
        }
        owed[who][quote] += amount;
    }
}

/// @dev A recipient that cannot take native MON. Forces `_tryPay` to answer false on a native
///      market and `_payOrCredit` to fall through to the sink.
contract R3Refuser {
    receive() external payable {
        revert("no");
    }
}

// ------------------------------------------------------------------------------- the harness

contract Round3CurveSolvencyTest is Test {
    address internal constant TREASURY = address(0xC0FFEE);

    address internal curveImpl;
    address internal tokenImpl;
    R3Graduator internal grad;
    R3Sink internal sink;
    R3Refuser internal refuser;

    address[4] internal traders;

    // Per-market bookkeeping the harness owns, so the identities can be stated exactly.
    uint256 internal donatedQuote;
    uint256 internal donatedBase;
    uint256 internal releasedBase;

    function setUp() public {
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        grad = new R3Graduator(address(this));
        sink = new R3Sink();
        refuser = new R3Refuser();
        traders = [address(0xB1), address(0xB2), address(0xB3), address(0xB4)];
    }

    struct Cfg {
        address quote;
        uint8 sink;
        uint16 tax;
        uint256 target;
        bool refusingRecipients;
    }

    function _market(Cfg memory cfg, uint256 nonce) internal returns (BondingCurve c, DokuToken t) {
        bytes32 salt = keccak256(abi.encode("round3", nonce, cfg.quote, cfg.sink, cfg.tax, cfg.target));
        address ca = Clones.cloneDeterministic(curveImpl, salt);
        address ta = Clones.cloneDeterministic(tokenImpl, salt);
        DokuToken(ta).initialize("Round3", "R3", ca, cfg.sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");

        address routed = address(0);
        address taxTo = cfg.refusingRecipients ? address(refuser) : address(0xA3);
        if (cfg.sink == Sinks.CREATOR) routed = cfg.refusingRecipients ? address(refuser) : address(0xA4);

        BondingCurve(payable(ca)).initialize(
            ta, cfg.quote, cfg.target, cfg.sink, routed, cfg.tax, taxTo, TREASURY, address(grad), address(sink)
        );
        donatedQuote = 0;
        donatedBase = 0;
        releasedBase = 0;
        return (BondingCurve(payable(ca)), DokuToken(ta));
    }

    function _held(BondingCurve c) internal view returns (uint256) {
        address q = c.quoteAsset();
        return q == address(0) ? address(c).balance : IERC20(q).balanceOf(address(c));
    }

    // ------------------------------------------------------------------------ the identities

    function _check(BondingCurve c, DokuToken t, string memory where) internal view {
        // I1 — quote solvency, with the harness's own donation term so it is an EQUALITY.
        assertEq(c.quoteBooked() + donatedQuote, _held(c), string.concat("I1 quote solvency @ ", where));

        (uint128 base, uint128 quoteRes) = c.reserves();

        // I2 — the virtual quote reserve is the floor plus the raise, exactly. Only meaningful
        //      before `release` zeroes `quoteRaised` without touching the reserves.
        if (!c.released()) {
            assertEq(
                uint256(quoteRes),
                (c.quoteTarget() * 2) / 5 + c.quoteRaised(),
                string.concat("I2 reserve/raise @ ", where)
            );
        }

        // I3 — base conservation. This is the identity `_latchFill` computes `seedBase` from.
        assertEq(
            t.balanceOf(address(c)) + releasedBase,
            c.launchSupply() + uint256(base) - c.BASE_VIRTUAL_CEILING() + donatedBase,
            string.concat("I3 base conservation @ ", where)
        );

        // I4 — a latched market can actually pay its seed.
        if (c.readyToGraduate() && !c.released()) {
            assertGe(t.balanceOf(address(c)), c.seedBase(), string.concat("I4 seedability @ ", where));
        }
    }

    /// @dev `_check` as an external entry point, so a test can assert it REVERTS.
    function checkExternal(address c, address t, uint256 dq, uint256 db, uint256 rb) external view {
        // The harness's own counters, supplied by the caller, so this is usable under a corruption.
        Round3CurveSolvencyTest self = Round3CurveSolvencyTest(payable(address(this)));
        self; // silence
        _checkWith(BondingCurve(payable(c)), DokuToken(t), dq, db, rb);
    }

    function _checkWith(BondingCurve c, DokuToken t, uint256 dq, uint256 db, uint256 rb) internal view {
        assertEq(c.quoteBooked() + dq, _held(c), "I1");
        (uint128 base, uint128 quoteRes) = c.reserves();
        if (!c.released()) {
            assertEq(uint256(quoteRes), (c.quoteTarget() * 2) / 5 + c.quoteRaised(), "I2");
        }
        assertEq(
            t.balanceOf(address(c)) + rb,
            c.launchSupply() + uint256(base) - c.BASE_VIRTUAL_CEILING() + db,
            "I3"
        );
        if (c.readyToGraduate() && !c.released()) {
            assertGe(t.balanceOf(address(c)), c.seedBase(), "I4");
        }
    }

    function _mustFail(address c, address t, string memory which) internal {
        (bool ok,) = address(this).staticcall(
            abi.encodeCall(this.checkExternal, (c, t, donatedQuote, donatedBase, releasedBase))
        );
        assertFalse(ok, string.concat("the harness did NOT notice a corrupted ", which));
    }

    /**
     * A PASSING FUZZ THAT CANNOT FAIL IS WORSE THAN NO FUZZ (the loop's rule 4).
     *
     * Each of the four identities above is corrupted in turn — one storage word, one wei — and the
     * check must go red for each. Without this, `testFuzz_round3Walk`'s 10,001 clean runs would
     * only prove that the assertions ran.
     */
    function test_theFourIdentitiesAreLoadBearing() public {
        Cfg memory cfg;
        cfg.quote = address(new R3Quote(6));
        cfg.target = 8_000e6;
        cfg.sink = Sinks.CREATOR;
        cfg.tax = 500;
        (BondingCurve c, DokuToken t) = _market(cfg, 99);

        address w = traders[0];
        R3Quote(cfg.quote).mint(w, 1_000_000e6);
        vm.startPrank(w);
        IERC20(cfg.quote).approve(address(c), type(uint256).max);
        c.buyWithToken(3_000e6, 0, type(uint256).max);
        vm.stopPrank();
        _check(c, t, "control");

        // I1 / I2 — one wei of phantom raise.
        bytes32 raised = vm.load(address(c), bytes32(uint256(3)));
        vm.store(address(c), bytes32(uint256(3)), bytes32(uint256(raised) + 1));
        _mustFail(address(c), address(t), "quoteRaised (I1/I2)");
        vm.store(address(c), bytes32(uint256(3)), raised);

        // I1 — one wei of phantom protocol fee.
        bytes32 prot = vm.load(address(c), bytes32(uint256(6)));
        vm.store(address(c), bytes32(uint256(6)), bytes32(uint256(prot) + 1));
        _mustFail(address(c), address(t), "pendingProtocol (I1)");
        vm.store(address(c), bytes32(uint256(6)), prot);

        // I3 — one wei of token appears in the curve with no reserve movement behind it.
        uint256 tb = t.balanceOf(address(c));
        deal(address(t), address(c), tb + 1);
        _mustFail(address(c), address(t), "token balance (I3)");
        deal(address(t), address(c), tb);

        // I4 — a latched seed the curve cannot pay.
        vm.startPrank(w);
        c.buyWithToken(20_000e6, 0, type(uint256).max);
        vm.stopPrank();
        assertTrue(c.readyToGraduate(), "the curve did not latch");
        _check(c, t, "latched control");
        bytes32 seedSlot = vm.load(address(c), bytes32(uint256(11)));
        vm.store(address(c), bytes32(uint256(11)), bytes32(t.balanceOf(address(c)) + 1));
        _mustFail(address(c), address(t), "seedBase (I4)");
        vm.store(address(c), bytes32(uint256(11)), seedSlot);
        _check(c, t, "restored");
    }

    // ------------------------------------------------------------------------ the random walk

    /// @notice Sixteen randomised steps over one market drawn from the whole configuration space.
    function testFuzz_round3Walk(uint256 seed, uint8 sinkRaw, uint16 taxRaw, uint8 shape) public {
        Cfg memory cfg;
        cfg.sink = uint8(bound(sinkRaw, 0, 2));
        cfg.tax = uint16(bound(taxRaw, 0, 100)) * 10; // the factory's "multiple of ten" rule
        cfg.refusingRecipients = (shape & 1) != 0;

        uint256 pick = shape % 6;
        if (pick == 0) {
            cfg.quote = address(0);
            cfg.target = 1_000e18;
        } else if (pick == 1) {
            cfg.quote = address(0);
            cfg.target = 5; // MIN_QUOTE_TARGET itself
        } else if (pick == 2) {
            cfg.quote = address(new R3Quote(6));
            cfg.target = 8_000e6;
        } else if (pick == 3) {
            cfg.quote = address(new R3Quote(0));
            cfg.target = 8_000; // a whole-unit token, e.g. a 0-decimal stable
        } else if (pick == 4) {
            cfg.quote = address(new R3Quote(2));
            cfg.target = 800_000;
        } else {
            cfg.quote = address(new R3Quote(18));
            cfg.target = 10; // two wei above the floor, divisible by five
        }

        (BondingCurve c, DokuToken t) = _market(cfg, seed);
        _check(c, t, "init");

        for (uint256 i = 0; i < 4; i++) {
            vm.deal(traders[i], 1_000_000 ether);
            if (cfg.quote != address(0)) {
                R3Quote(cfg.quote).mint(traders[i], 1_000_000e18);
                vm.prank(traders[i]);
                IERC20(cfg.quote).approve(address(c), type(uint256).max);
            }
        }

        for (uint256 i = 0; i < 16; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _step(c, t, seed);
            _check(c, t, vm.toString(i));
        }
    }

    function _step(BondingCurve c, DokuToken t, uint256 seed) internal {
        address who = traders[seed % 4];
        uint256 what = (seed >> 3) % 11;
        bool native = c.quoteAsset() == address(0);

        // Time and blocks move irregularly, including zero, so `TAX_WINDOW` edges land on-step.
        vm.warp(vm.getBlockTimestamp() + ((seed >> 8) % 400));
        vm.roll(vm.getBlockNumber() + ((seed >> 20) % 3));

        uint256 amt = ((seed >> 32) % (c.quoteTarget() * 2 + 7)) + 1;

        if (what <= 3) {
            // A buy. One in four is sized to overshoot, so the `_levy` clamp is routine.
            if ((seed >> 60) % 4 == 0) amt = c.remaining() + ((seed >> 64) % (c.quoteTarget() + 3)) + 1;
            vm.prank(who);
            if (native) {
                try c.buy{value: amt}(0, type(uint256).max) {} catch {}
            } else {
                try c.buyWithToken(amt, 0, type(uint256).max) {} catch {}
            }
        } else if (what <= 5) {
            uint256 bal = t.balanceOf(who);
            if (bal == 0) return;
            uint256 baseIn = ((seed >> 32) % bal) + 1;
            vm.startPrank(who);
            t.approve(address(c), baseIn);
            try c.sell(baseIn, 0, type(uint256).max) {} catch {}
            vm.stopPrank();
        } else if (what == 6) {
            try c.collectProtocolFees() {} catch {}
        } else if (what == 7) {
            try c.collectTax() {} catch {}
        } else if (what == 8) {
            try c.collectFees() {} catch {}
        } else if (what == 9) {
            // A third party moves value AT the curve, both legs. Native donation is refused by
            // `receive()`; an ERC-20 one lands and must show up as a surplus and never as credit.
            if (!native) {
                // Hoisted: `IERC20(c.quoteAsset())` is an external call in the RECEIVER position
                // and would consume the `vm.prank` armed for the transfer.
                IERC20 qa = IERC20(c.quoteAsset());
                uint256 d = ((seed >> 32) % 1_000) + 1;
                vm.prank(who);
                qa.transfer(address(c), d);
                donatedQuote += d;
            }
            uint256 bal = t.balanceOf(who);
            if (bal > 1) {
                uint256 d2 = ((seed >> 40) % (bal / 2)) + 1;
                vm.prank(who);
                t.transfer(address(c), d2);
                donatedBase += d2;
                // A third party burning their OWN tokens is the input that used to brick the seed.
                uint256 rest = t.balanceOf(who);
                if (rest > 1) {
                    vm.prank(who);
                    t.burn(1);
                }
            }
        } else {
            // Graduate, when the curve is ready. Releases the raise and the seed.
            if (c.readyToGraduate() && !c.released()) {
                grad.arm(true);
                uint256 seedB = c.seedBase();
                try grad.graduate(address(c)) {
                    releasedBase += seedB;
                } catch {}
                grad.arm(false);
            }
        }
    }

    // ------------------------------------------------------- no wei ever rounds to the trader

    /**
     * A buy immediately followed by a sell of everything it produced must return STRICTLY LESS
     * quote than it consumed — the pool-favouring `fullMulDivUp` in `CurveMath` plus a 1% fee.
     *
     * The interesting arm is the one with NO fee: at a gross under 100 raw units every levy floors
     * to zero, so the fee cannot be what protects the curve and only the rounding is left. If
     * `CurveMath` ever rounded the user's leg up, this is where it would pay.
     */
    function testFuzz_noRoundTripProfit(uint256 warmup, uint256 amount, uint8 sinkRaw, uint16 taxRaw) public {
        Cfg memory cfg;
        cfg.quote = address(new R3Quote(6));
        cfg.sink = uint8(bound(sinkRaw, 0, 2));
        cfg.tax = uint16(bound(taxRaw, 0, 100)) * 10;
        cfg.target = 8_000e6;
        (BondingCurve c, DokuToken t) = _market(cfg, amount);

        address w = traders[0];
        R3Quote(cfg.quote).mint(w, 1_000_000e6);
        vm.startPrank(w);
        IERC20(cfg.quote).approve(address(c), type(uint256).max);

        // Move the curve somewhere arbitrary first, so the round trip is not always at the open.
        uint256 pre = bound(warmup, 0, 6_000e6);
        if (pre > 0) c.buyWithToken(pre, 0, type(uint256).max);
        if (c.readyToGraduate()) {
            vm.stopPrank();
            return;
        }

        uint256 amt = bound(amount, 1, 100_000e6);
        uint256 quoteBefore = IERC20(cfg.quote).balanceOf(w);
        uint256 baseBefore = t.balanceOf(w);
        try c.buyWithToken(amt, 0, type(uint256).max) {} catch {
            vm.stopPrank();
            return;
        }
        uint256 got = t.balanceOf(w) - baseBefore;
        if (got == 0 || c.readyToGraduate()) {
            vm.stopPrank();
            return;
        }
        t.approve(address(c), got);
        try c.sell(got, 0, type(uint256).max) {} catch {}
        vm.stopPrank();

        assertLe(
            IERC20(cfg.quote).balanceOf(w), quoteBefore, "a buy-then-sell round trip returned more than it cost"
        );
        _check(c, t, "round trip");
    }

    /// @notice The same, on the curve's own arithmetic with no fee layer at all: `baseOut` then
    ///         `quoteOut` on the resulting reserves can never give back more than went in.
    function testFuzz_curveMathHasNoFreeWei(uint128 baseR, uint128 quoteR, uint256 qin) public pure {
        uint256 b = bound(uint256(baseR), 1e18, 1_100_000_000e18);
        uint256 q = bound(uint256(quoteR), 1, 1.4e30);
        uint256 amount = bound(qin, 1, 1e30);

        uint256 out = CurveMath.baseOut(b, q, amount);
        if (out == 0) return;
        uint256 back = CurveMath.quoteOut(b - out, q + amount, out);
        assertLe(back, amount, "CurveMath returned more quote than it took");
    }

    /**
     * The same, restricted to the reserves DOKU ACTUALLY REACHES — base in
     * `[BASE_VIRTUAL_FLOOR, BASE_VIRTUAL_CEILING]`, quote in `[0.4T, 1.4T]` for the two live
     * targets (MON 305,868.39e18 and USDC/XAUt0 at 6 decimals).
     *
     * Added after a mutation test: reverting `baseOut`'s `fullMulDivUp` to `fullMulDiv` — the exact
     * "round the user's leg up" bug the library's docblock says drains the curve — was caught by
     * the unbounded fuzz above only at reserves where the quote side is eleven orders of magnitude
     * ABOVE the base side, which no DOKU market can be in. A fuzz that only fails outside the
     * reachable domain is the rule-4 failure mode, so the reachable domain gets its own.
     */
    function testFuzz_curveMathHasNoFreeWei_atDokuReserves(uint256 b_, uint256 q_, uint256 qin, bool sixDec)
        public
        pure
    {
        uint256 b = bound(b_, 311_111_111_200_000_000_000_000_000, 1_088_888_889_200_000_000_000_000_000);
        uint256 target = sixDec ? 8_000e6 : 305_868_390_948_742_537_150_460;
        uint256 q = bound(q_, (target * 2) / 5, (target * 14) / 10);
        uint256 amount = bound(qin, 1, target * 4);

        uint256 out = CurveMath.baseOut(b, q, amount);
        if (out == 0) return;
        uint256 back = CurveMath.quoteOut(b - out, q + amount, out);
        assertLe(back, amount, "a DOKU-reachable buy-then-sell on CurveMath alone made a wei");
    }

    // ------------------------------------------ the rounding DIRECTION, proved without the library

    /// @dev 512-bit `x * y`, so the invariant below can be checked WITHOUT calling the same
    ///      `FixedPointMathLib` routine the implementation uses. A test that re-derives the
    ///      expected value with the function under test proves only that the function equals
    ///      itself.
    function _mul512(uint256 x, uint256 y) private pure returns (uint256 hi, uint256 lo) {
        unchecked {
            uint256 mm = mulmod(x, y, type(uint256).max);
            lo = x * y;
            hi = mm - lo;
            if (mm < lo) hi -= 1;
        }
    }

    function _ge512(uint256 aHi, uint256 aLo, uint256 bHi, uint256 bLo) private pure returns (bool) {
        if (aHi != bHi) return aHi > bHi;
        return aLo >= bLo;
    }

    /**
     * THE PROPERTY THE WHOLE CURVE RESTS ON: `k` never falls.
     *
     * Both legs of `CurveMath` keep the reserve the pool retains with `fullMulDivUp`, so the
     * product of the post-trade reserves is at least the product of the pre-trade ones. One wei
     * rounded the other way is a wei the trader takes, every trade, on a 400ms chain.
     *
     * This is asserted with an independent 512-bit multiply rather than by recomputing the expected
     * value with `fullMulDivUp` — and the reason is a measurement, not fastidiousness. Reverting
     * either leg's `fullMulDivUp` to `fullMulDiv` is INVISIBLE to a buy-then-sell round trip at
     * DOKU's reachable reserves (10,000 runs each, both legs, both live targets): the base side is
     * ~10^3 coarser than the quote side, so the wei gained on one leg rounds away on the other.
     * The round-trip test therefore could not have caught the exact bug the library's own docblock
     * says drains the curve. This one does, and it is the reason it exists.
     *
     * Tightness is asserted too — one unit below the retained reserve must FAIL the invariant — so
     * the pool is proved not to be over-charging by more than the wei that rounding requires.
     */
    function testFuzz_kNeverFallsOnEitherLeg(uint256 b_, uint256 q_, uint256 in_, bool sixDec, bool buying)
        public
        pure
    {
        uint256 b = bound(b_, 311_111_111_200_000_000_000_000_000, 1_088_888_889_200_000_000_000_000_000);
        uint256 target = sixDec ? 8_000e6 : 305_868_390_948_742_537_150_460;
        uint256 q = bound(q_, (target * 2) / 5, (target * 14) / 10);

        (uint256 kHi, uint256 kLo) = _mul512(b, q);

        if (buying) {
            uint256 x = bound(in_, 1, target * 4);
            uint256 out = CurveMath.baseOut(b, q, x);
            uint256 newBase = b - out;
            (uint256 hi, uint256 lo) = _mul512(newBase, q + x);
            assertTrue(_ge512(hi, lo, kHi, kLo), "a buy let k fall: the buyer took a wei of the pool");
            if (newBase > 0) {
                (uint256 hi2, uint256 lo2) = _mul512(newBase - 1, q + x);
                assertFalse(_ge512(hi2, lo2, kHi, kLo), "a buy kept a whole unit more than rounding needs");
            }
        } else {
            uint256 x = bound(in_, 1, 1_000_000_000e18);
            uint256 out = CurveMath.quoteOut(b, q, x);
            uint256 newQuote = q - out;
            (uint256 hi, uint256 lo) = _mul512(b + x, newQuote);
            assertTrue(_ge512(hi, lo, kHi, kLo), "a sell let k fall: the seller took a wei of the pool");
            if (newQuote > 0) {
                (uint256 hi2, uint256 lo2) = _mul512(b + x, newQuote - 1);
                assertFalse(_ge512(hi2, lo2, kHi, kLo), "a sell kept a whole unit more than rounding needs");
            }
        }
    }

    // ------------------------------------------------------------------- TaxMath, at the edges

    /// @notice The rate is bounded by `startBps` on every mode and every input, so the `uint16`
    ///         narrowing casts in `_clock`/`_progress` can never truncate.
    function testFuzz_taxRateNeverExceedsStart(uint8 modeRaw, uint16 startBps, uint32 window, uint256 elapsed, uint256 prog)
        public
        pure
    {
        TaxMath.Mode mode = TaxMath.Mode(uint8(bound(modeRaw, 0, 2)));
        uint16 r = TaxMath.rate(mode, startBps, window, elapsed, prog);
        assertLe(r, startBps, "rate above startBps");
    }

    /// @notice The CLOCK boundary, block by block. `window - 1` is the last taxed second and the
    ///         rate reaches zero AT `window`, not one second late.
    function test_clockWindowEdges() public {
        Cfg memory cfg;
        cfg.quote = address(0);
        cfg.target = 1_000e18;
        cfg.sink = Sinks.BURN;
        (BondingCurve c,) = _market(cfg, 1);

        uint64 t0 = c.launchedAt();
        uint32 win = c.TAX_WINDOW();
        uint16 start = c.TAX_START_BPS();

        vm.warp(t0);
        assertEq(c.taxRate(), start, "the rate at launch is not the start rate");

        vm.warp(t0 + win - 1);
        assertEq(c.taxRate(), uint16(uint256(start) * 1 / win), "the last taxed second is wrong");
        assertGt(c.taxRate(), 0, "the rate hit zero before the window closed");

        vm.warp(t0 + win);
        assertEq(c.taxRate(), 0, "the rate did not reach zero at the window");

        vm.warp(t0 + win + 10_000);
        assertEq(c.taxRate(), 0, "the rate came back after the window");
    }

    /// @notice `taxRate()` answers zero the instant the curve closes, on every mode, so the tax is
    ///         a property of the curve phase and cannot be charged after it.
    function test_rateIsZeroOnceClosed() public {
        Cfg memory cfg;
        cfg.quote = address(0);
        cfg.target = 1_000e18;
        cfg.sink = Sinks.BURN;
        (BondingCurve c,) = _market(cfg, 2);

        vm.deal(traders[0], 10_000 ether);
        vm.prank(traders[0]);
        c.buy{value: 5_000 ether}(0, type(uint256).max);
        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertEq(c.taxRate(), 0, "a closed curve still quotes a tax");
    }
}
