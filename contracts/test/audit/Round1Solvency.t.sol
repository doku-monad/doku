// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * ROUND 1 of the generation-4 adversarial loop — `BondingCurve`, `DokuFactory`, `QuoteRegistry`,
 * `DokuToken`, `CurveMath`, `TaxMath`, `Sinks`.
 *
 * The brief for this round was the DIFF: `quoteBooked()`, `DokuFactory._firstBuy`'s unbooked-delta
 * credit, `_tryPay`'s rewritten success rule, `activate`/`_validateDeployment`/`economicsPin`, and
 * the shared `DOKU_MAX_QUOTE_TARGET`. Every test here either kills a candidate finding or pins a
 * property one of those fixes claims.
 *
 * `vm.getBlockTimestamp()` / `vm.getBlockNumber()` everywhere a clock is read: `via_ir = true`
 * folds `block.timestamp` and `block.number` across `vm.warp`/`vm.roll`, so the bare globals lie.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

import {BondingCurve, DOKU_MAX_QUOTE_TARGET, DOKU_MIN_QUOTE_TARGET} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {CurveMath} from "../../src/lib/CurveMath.sol";
import {Wiring} from "../helpers/Wiring.sol";

// ---------------------------------------------------------------------------------- fixtures

/// @dev The plainest possible quote: exact transfer, 32-byte `true`, no callbacks.
contract PlainQuote is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 dec) ERC20("Plain", "PLN") {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Answers `transfer` with a gigantic blob of returndata whose first word is an honest `1`,
///      and nothing else hostile. The target is `_tryPay`, which is the one place in the curve
///      that copies UNBOUNDED returndata into memory; `SafeERC20` in OZ 5.x copies a single word
///      in assembly and cannot be billed this way.
contract BombQuote is ERC20 {
    uint256 public bombWords;

    constructor() ERC20("Bomb", "BMB") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBomb(uint256 words) external {
        bombWords = words;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        super.transfer(to, amount);
        uint256 n = bombWords;
        if (n == 0) return true;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 1) // a standards-compliant `true` in the first word
            mstore(add(p, mul(n, 0x20)), 0) // expand, so the caller pays to copy `n` words
            return(p, mul(n, 0x20))
        }
    }
}

/// @dev Hands control to an arbitrary target, with arbitrary calldata, from inside `transferFrom`.
///      `runAfter` decides whether the callback lands before or after the balances move; `swallow`
///      makes the transfer deliver nothing at all while still reporting success. Together those
///      are the whole space `DokuFactory._firstBuy`'s two balance reads are exposed to.
contract ProgrammableQuote is ERC20 {
    address public target;
    bytes public payload;
    bool public fired;
    bool public armed;
    bool public runAfter;
    bool public swallow;

    constructor() ERC20("Prog", "PRG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address t, bytes calldata data, bool after_) external {
        target = t;
        payload = data;
        armed = true;
        fired = false;
        runAfter = after_;
    }

    function setSwallow(bool on) external {
        swallow = on;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        bool run = armed && !fired;
        if (run && !runAfter) _fire();
        if (swallow) {
            _spendAllowance(from, _msgSender(), amount);
        } else {
            super.transferFrom(from, to, amount);
        }
        if (run && runAfter) _fire();
        return true;
    }

    function _fire() private {
        fired = true;
        (bool ok, bytes memory e) = target.call(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(e, 0x20), mload(e))
            }
        }
    }
}

/// @dev The launch creator, so a callback can be pointed anywhere from a hostile sender.
contract Creator {
    DokuFactory public immutable factory;

    constructor(DokuFactory f) {
        factory = f;
    }

    function launch(DokuFactory.LaunchParams calldata p, uint256 fee)
        external
        payable
        returns (address, address)
    {
        return factory.launch{value: fee}(p);
    }

    function approve(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    receive() external payable {}
}

/// @dev A graduator the factory accepts (`factory()` answers) and that does nothing else, so
///      `_tryAutoGraduate`'s raw call fails and is swallowed. A filled curve then keeps its raise,
///      which is what the solvency identity is measured against.
contract InertGraduator {
    address public immutable factory;

    constructor(address f) {
        factory = f;
    }
}

/// @dev Actually calls `release`, for the one test that needs the post-graduation balance.
contract ReleasingGraduator {
    address public immutable factory;

    constructor(address f) {
        factory = f;
    }

    function graduate(address curve) external returns (bytes32, uint256) {
        BondingCurve(payable(curve)).release();
        return (bytes32(0), 0);
    }

    function sinkOf(address) external view returns (address) {
        return address(this);
    }

    function creditCurveTax(address) external payable {}

    function creditCurveTax(address, uint256) external {}

    receive() external payable {}
}

// ------------------------------------------------------------------------------- callback actors

contract RoundTripper {
    /// @dev Buys and immediately sells the whole position back, from inside the quote's callback.
    ///      The `require` is the load-bearing half: it asserts that at this instant the curve holds
    ///      the ENTIRE token supply, which is why nobody can sell into it without buying first.
    function run(address curve, address token, uint256 amount) external {
        require(
            IERC20(token).balanceOf(curve) == DokuToken(token).TOTAL_SUPPLY(),
            "somebody already held the token"
        );
        if (amount == 0) return;
        BondingCurve c = BondingCurve(payable(curve));
        IERC20(BondingCurve(payable(curve)).quoteAsset()).approve(curve, type(uint256).max);
        uint256 got = c.buyWithToken(amount, 0, type(uint256).max);
        IERC20(token).approve(curve, got);
        c.sell(got, 0, type(uint256).max);
    }
}

contract Donor {
    function give(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }
}

contract Relauncher {
    DokuFactory public immutable factory;
    address public immutable quoteAsset;
    address public inner;

    constructor(DokuFactory f, address q) {
        factory = f;
        quoteAsset = q;
    }

    function go(uint256 fee) external {
        DokuFactory.LaunchParams memory p;
        p.meta.name = "Inner";
        p.meta.ticker = "IN";
        p.quoteAsset = quoteAsset;
        p.sink = Sinks.BURN;
        p.economicsPin = factory.economicsPin(quoteAsset, Sinks.BURN, 0);
        p.deadline = type(uint256).max;
        (inner,) = factory.launch{value: fee}(p);
    }

    receive() external payable {}
}

contract NativeRelauncher {
    DokuFactory public immutable factory;
    address public inner;
    bool public reentered;
    bool private _arm;

    constructor(DokuFactory f) {
        factory = f;
    }

    function go(DokuFactory.LaunchParams calldata p) external payable returns (address curve, address token) {
        _arm = true;
        (curve, token) = factory.launch{value: msg.value}(p);
        _arm = false;
    }

    /// @dev The refund from the over-sized first buy lands here, mid-`launch`.
    receive() external payable {
        if (!_arm || reentered) return;
        reentered = true;
        DokuFactory.LaunchParams memory q;
        q.meta.name = "Inner";
        q.meta.ticker = "IN2";
        q.quoteAsset = address(0);
        q.sink = Sinks.BURN;
        q.economicsPin = factory.economicsPin(address(0), Sinks.BURN, 0);
        q.deadline = type(uint256).max;
        q.firstBuyQuote = 1 ether;
        (inner,) = factory.launch{value: factory.launchFeeWei() + 1 ether}(q);
    }
}

// =============================================================================================
//                    THE CURVE'S SOLVENCY IDENTITY, RE-ESTABLISHED ON THIS SOURCE
// =============================================================================================

/**
 * `quoteBooked() == balanceOf(curve)` — with `==`, not `>=`, at EVERY reachable state.
 *
 * The 2026-09-11 audit established this at 10,000 runs against the pre-gen-4 source. Today's diff
 * added `quoteBooked()` itself and rewrote `_tryPay`, and `DokuFactory._firstBuy` now DEPENDS on
 * the identity: it credits `grew - booked`, which is only the launcher's own money if booked quote
 * and held quote move together. So the identity is no longer a nice property — it is a
 * precondition of the launch path, and it is re-derived here rather than inherited.
 */
contract Round1SolvencyTest is Test {
    address internal constant TREASURY = address(0xA2);
    address internal constant TAXREC = address(0xA3);
    address internal constant ROUTED = address(0xA4);
    address internal constant TRADER = address(0xB1);

    address internal curveImpl;
    address internal tokenImpl;
    InertGraduator internal grad;
    PlainQuote internal quote;
    uint256 internal _n;

    uint256 internal constant TARGET6 = 8_000e6;
    uint256 internal constant TARGET18 = 1_000e18;

    function setUp() public {
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        grad = new InertGraduator(address(this));
        quote = new PlainQuote(6);
    }

    function _market(address quoteAsset, uint8 sink, uint16 taxBps, uint256 target)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        bytes32 salt = keccak256(abi.encode(++_n));
        address ca = Clones.cloneDeterministic(curveImpl, salt);
        address ta = Clones.cloneDeterministic(tokenImpl, salt);
        DokuToken(ta).initialize("Round1", "R1", ca, sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        BondingCurve(payable(ca)).initialize(
            ta,
            quoteAsset,
            target,
            sink,
            sink == Sinks.CREATOR ? ROUTED : address(0),
            taxBps,
            TAXREC,
            TREASURY,
            address(grad),
            address(0)
        );
        return (BondingCurve(payable(ca)), DokuToken(ta));
    }

    function _held(BondingCurve c) internal view returns (uint256) {
        address q = c.quoteAsset();
        return q == address(0) ? address(c).balance : IERC20(q).balanceOf(address(c));
    }

    function _assertSolvent(BondingCurve c, string memory where) internal {
        assertEq(c.quoteBooked(), _held(c), where);
    }

    // ------------------------------------------------------------------------- the ERC-20 fuzz

    /**
     * Twelve randomised steps over one market: ordinary buys, oversized buys that hit the clamp
     * and take a refund, sells, and all three collections, with the clock moving so the whole
     * anti-sniper decay is exercised. The identity is asserted after every single step, so a step
     * that breaks it is named by its index rather than found by bisection.
     */
    function testFuzz_bookedEqualsHeld_erc20(uint256 seed, uint8 sinkRaw, uint16 taxRaw) public {
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 tax = uint16(bound(taxRaw, 0, 1000));
        (BondingCurve c, DokuToken t) = _market(address(quote), sink, tax, TARGET6);
        _assertSolvent(c, "insolvent at initialisation");

        quote.mint(TRADER, 1_000_000e6);
        vm.prank(TRADER);
        quote.approve(address(c), type(uint256).max);

        for (uint256 i = 0; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _step(c, t, seed);
            _assertSolvent(c, string.concat("insolvent after step ", vm.toString(i)));
        }
    }

    /// @notice The same identity against `address(this).balance` on a native market.
    function testFuzz_bookedEqualsHeld_native(uint256 seed, uint8 sinkRaw, uint16 taxRaw) public {
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 tax = uint16(bound(taxRaw, 0, 1000));
        (BondingCurve c, DokuToken t) = _market(address(0), sink, tax, TARGET18);
        _assertSolvent(c, "insolvent at initialisation");

        vm.deal(TRADER, 1_000_000 ether);

        for (uint256 i = 0; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            _step(c, t, seed);
            _assertSolvent(c, string.concat("insolvent after step ", vm.toString(i)));
        }
    }

    function _step(BondingCurve c, DokuToken t, uint256 seed) internal {
        bool native = c.quoteAsset() == address(0);
        uint256 unit = native ? 1e18 : 1e6;
        uint256 what = seed % 6;

        vm.warp(vm.getBlockTimestamp() + ((seed >> 8) % 120));
        vm.roll(vm.getBlockNumber() + 1);

        if (what <= 2) {
            if (c.readyToGraduate()) return;
            // Sized to span "a normal buy" and "far more than the curve can still take", so the
            // clamp-and-refund arm of `_levy` is hit regularly rather than by luck.
            uint256 amount = ((seed >> 16) % (2_000 * unit)) + 1;
            if (what == 2) amount = c.remaining() + ((seed >> 48) % (500 * unit)) + 1;
            vm.prank(TRADER);
            if (native) {
                try c.buy{value: amount}(0, type(uint256).max) {} catch {}
            } else {
                try c.buyWithToken(amount, 0, type(uint256).max) {} catch {}
            }
        } else if (what == 3) {
            if (c.readyToGraduate()) return;
            uint256 bal = t.balanceOf(TRADER);
            if (bal == 0) return;
            uint256 amount = ((seed >> 16) % bal) + 1;
            vm.startPrank(TRADER);
            t.approve(address(c), amount);
            try c.sell(amount, 0, type(uint256).max) {} catch {}
            vm.stopPrank();
        } else if (what == 4) {
            try c.collectProtocolFees() {} catch {}
        } else {
            try c.collectTax() {} catch {}
            try c.collectFees() {} catch {}
        }
    }

    // --------------------------------------------------------------- the identity through release

    /// @notice After `release`, the curve holds EXACTLY the three pending buckets and nothing else.
    ///         `quoteRaised` is zeroed and `quoteBooked()` follows it down, so the identity is not
    ///         merely preserved by graduation — it is what makes the pending buckets still payable.
    function test_bookedEqualsHeld_acrossRelease() public {
        ReleasingGraduator rg = new ReleasingGraduator(address(this));
        bytes32 salt = keccak256("release-fixture");
        address ca = Clones.cloneDeterministic(curveImpl, salt);
        address ta = Clones.cloneDeterministic(tokenImpl, salt);
        DokuToken(ta).initialize("Rel", "REL", ca, false, "https://cdn.doku.family/metadata/test.json");
        BondingCurve c = BondingCurve(payable(ca));
        c.initialize(
            ta, address(quote), TARGET6, Sinks.CREATOR, ROUTED, 500, TAXREC, TREASURY, address(rg), address(0)
        );

        quote.mint(TRADER, 1_000_000e6);
        vm.startPrank(TRADER);
        quote.approve(ca, type(uint256).max);
        c.buyWithToken(TARGET6 * 2, 0, type(uint256).max); // fills, overshoots, refunds, graduates
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(c.released(), "the curve did not graduate");
        assertEq(c.quoteRaised(), 0, "the raise did not leave");
        _assertSolvent(c, "insolvent after release");
        assertEq(
            quote.balanceOf(ca),
            c.pendingProtocol() + c.pendingFees() + c.pendingTax(),
            "what is left is not exactly the three pending buckets"
        );

        c.collectProtocolFees();
        c.collectFees();
        c.collectTax();
        assertEq(quote.balanceOf(ca), 0, "a bucket was unpayable after graduation");
        _assertSolvent(c, "insolvent after the buckets were drained");
    }

    // ------------------------------------------------------------------- CurveMath, both legs

    /// @notice `k` is monotone NON-DECREASING on every leg: the pool's kept reserve is the rounded
    ///         quantity and the user's output is the remainder, so a fractional wei can never
    ///         leave. Re-derived on today's source rather than inherited from the last round.
    function testFuzz_curveMath_kNeverDecreases(uint128 baseR, uint128 quoteR, uint128 amount) public {
        uint256 b = bound(uint256(baseR), 1e18, 1.09e27);
        uint256 q = bound(uint256(quoteR), 1e6, 1.4e30);
        uint256 a = bound(uint256(amount), 1, 1e27);

        uint256 out = CurveMath.baseOut(b, q, a);
        assertLe(out, b, "baseOut exceeds the reserve");
        assertTrue(_mulGe(b - out, q + a, b, q), "k fell on the buy leg");

        uint256 qOut = CurveMath.quoteOut(b, q, a);
        assertLe(qOut, q, "quoteOut exceeds the reserve");
        assertTrue(_mulGe(b + a, q - qOut, b, q), "k fell on the sell leg");
    }

    /// @dev `b1*q1 >= b0*q0` in 512 bits, so a 1e27 x 1e30 product does not have to fit uint256.
    function _mulGe(uint256 b1, uint256 q1, uint256 b0, uint256 q0) private pure returns (bool) {
        (uint256 h1, uint256 l1) = _mul512(b1, q1);
        (uint256 h0, uint256 l0) = _mul512(b0, q0);
        if (h1 != h0) return h1 > h0;
        return l1 >= l0;
    }

    function _mul512(uint256 a, uint256 b) private pure returns (uint256 hi, uint256 lo) {
        assembly ("memory-safe") {
            let mm := mulmod(a, b, not(0))
            lo := mul(a, b)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
    }

    /// @notice Buy then immediately sell the whole position back: the trader can never come out
    ///         ahead, at any size, at any point on the curve. This is the loop that drains a curve
    ///         if a single rounding decision faces the wrong way.
    function testFuzz_buyThenSellNeverProfits(uint96 amountRaw) public {
        uint256 amount = bound(uint256(amountRaw), 1e6, 5_000e6);
        (BondingCurve c, DokuToken t) = _market(address(quote), Sinks.CREATOR, 0, TARGET6);
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(vm.getBlockNumber() + 1);

        quote.mint(TRADER, 1_000_000e6);
        vm.startPrank(TRADER);
        quote.approve(address(c), type(uint256).max);
        uint256 before = quote.balanceOf(TRADER);
        uint256 got = c.buyWithToken(amount, 0, type(uint256).max);
        uint256 spent = before - quote.balanceOf(TRADER);
        t.approve(address(c), got);
        uint256 back = c.sell(got, 0, type(uint256).max);
        vm.stopPrank();

        assertLe(back, spent, "a buy-then-sell round trip returned more than it cost");
        _assertSolvent(c, "the round trip left the curve insolvent");
    }

    // --------------------------------------------------------- `_tryPay`, the returndata bomb

    /**
     * DEMOTED TO GRIEFING, and recorded because the asymmetry is worth knowing.
     *
     * `_tryPay` is the only place in the curve that copies UNBOUNDED returndata: the compiler's
     * `(bool ok, bytes memory ret) = addr.call(...)` copies `returndatasize()` bytes into memory,
     * and memory expansion is quadratic. `SafeERC20._callOptionalReturn` in OZ 5.x copies one word
     * in assembly and cannot be billed this way — so a quote asset can make `collectTax()` and
     * `collectFees()` arbitrarily expensive while `sell()` and `release()`, which pay through
     * `_payQuote`/`safeTransfer`, stay cheap.
     *
     * Nobody loses money: the bucket is untouched on a revert and the call is retryable with more
     * gas. It needs an owner-registered quote asset that chose to answer this way, which is the
     * `docs/doku/quote-asset-policy.md` screen rather than a code defect. Pinned so a future
     * reviewer does not have to re-derive it.
     */
    function test_DEMOTED_returndataBombOnlyMakesCollectionExpensive() public {
        BombQuote bomb = new BombQuote();
        bytes32 salt = keccak256("bomb-fixture");
        address ca = Clones.cloneDeterministic(curveImpl, salt);
        address ta = Clones.cloneDeterministic(tokenImpl, salt);
        DokuToken(ta).initialize("Bomb", "BMB", ca, false, "https://cdn.doku.family/metadata/test.json");
        BondingCurve c = BondingCurve(payable(ca));
        c.initialize(
            ta, address(bomb), TARGET6, Sinks.CREATOR, ROUTED, 500, TAXREC, TREASURY, address(grad), address(0)
        );

        bomb.mint(TRADER, 100_000e6);
        vm.startPrank(TRADER);
        bomb.approve(ca, type(uint256).max);
        c.buyWithToken(1_000e6, 0, type(uint256).max);
        vm.stopPrank();
        assertGt(c.pendingTax(), 0, "nothing accrued");

        bomb.setBomb(0);
        uint256 g0 = gasleft();
        c.collectTax();
        uint256 cheap = g0 - gasleft();

        vm.startPrank(TRADER);
        c.buyWithToken(1_000e6, 0, type(uint256).max);
        vm.stopPrank();
        bomb.setBomb(30_000); // ~960 KB of returndata
        g0 = gasleft();
        c.collectTax();
        uint256 dear = g0 - gasleft();

        emit log_named_uint("collectTax gas, no bomb", cheap);
        emit log_named_uint("collectTax gas, 960KB  ", dear);
        assertGt(dear, cheap * 10, "the bomb was free, so the asymmetry does not exist");
        assertEq(c.pendingTax(), 0, "the bucket did not clear");
        _assertSolvent(c, "the bomb left the curve insolvent");
    }

    /// @notice `abi.decode(ret, (uint256))` on an over-long payload reads the FIRST word and does
    ///         not revert — the generated decoder checks a MINIMUM length, not an exact one. The
    ///         whole `_tryPay` rewrite rests on that decode being total, so it is asserted here
    ///         rather than assumed from the docblock.
    function test_abiDecodeUint256IsTotalOverAnyPayloadOfAtLeastThirtyTwoBytes() public {
        assertEq(abi.decode(abi.encode(uint256(1), uint256(0xdead)), (uint256)), 1, "64 bytes");
        assertEq(abi.decode(abi.encode(uint256(2)), (uint256)), 2, "a dirty word did not decode");
        bytes memory huge = new bytes(4096);
        huge[31] = 0x01;
        assertEq(abi.decode(huge, (uint256)), 1, "a 4KB payload did not decode");
    }
}

// =============================================================================================
//                        `DokuFactory._firstBuy` — the unbooked-delta credit
// =============================================================================================

/**
 * The fix under test: `arrived = (balanceAfter - balanceBefore) - (quoteBooked() - bookedBefore)`.
 *
 * The claim is that it is CLASS-complete for solvency rather than a patch for one callback shape.
 * The argument, restated so the tests below read as checks on it rather than as a list:
 *
 *   Let `slack = held - booked`. The curve's identity says `slack` is unchanged by every entry
 *   point it has (re-derived above, with `==`, fuzzed). Whatever a callback does inside the
 *   transfer it does THROUGH those entry points, so it moves `held` and `booked` together and
 *   leaves `slack` where it found it. A bare donation raises `held` alone. So after the transfer
 *   `slack' = slack + grew - booked`, and `buyFor(grew - booked)` books exactly that back down.
 *
 *   The fix is therefore correct for any callback that reaches the curve through `buy`, `sell`,
 *   `collect*`, or a plain transfer. What it does NOT cover is quote arriving from OUTSIDE the
 *   launcher — a donation mid-transfer is credited to the creator — argued below to be a
 *   non-finding because the donor is the only party who loses and the alternative strands the
 *   same money permanently.
 */
contract Round1FirstBuyTest is Test {
    DokuFactory internal factory;
    QuoteRegistry internal registry;
    InertGraduator internal grad;
    ProgrammableQuote internal quote;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant SINKADDR = address(0x5111);

    uint256 internal constant FEE = 0.01 ether;
    uint256 internal constant TARGET = 8_000e6;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), SINKADDR, FEE);
        grad = new InertGraduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        Wiring.activate(factory, OWNER, address(grad));
        quote = new ProgrammableQuote();
        vm.prank(OWNER);
        registry.register(address(quote), TARGET);
    }

    function _params(uint256 firstBuy) internal view returns (DokuFactory.LaunchParams memory p) {
        p.meta.name = "Round1";
        p.meta.ticker = "R1";
        p.quoteAsset = address(quote);
        p.sink = Sinks.REWARDS;
        p.economicsPin = factory.economicsPin(address(quote), Sinks.REWARDS, 0);
        p.deadline = type(uint256).max;
        p.firstBuyQuote = firstBuy;
    }

    function _assertSolvent(address curve, string memory where) internal {
        assertEq(BondingCurve(payable(curve)).quoteBooked(), quote.balanceOf(curve), where);
    }

    // ------------------------------------------------------------------ 1. the nested BUY, again

    /// @notice The F1 shape, from outside the F1 fixture: a callback that buys on the brand-new
    ///         curve mid-transfer no longer has its money credited to the creator's first buy. The
    ///         curve comes out of the launch EXACTLY solvent.
    function test_nestedBuyMidTransferLeavesTheCurveExactlySolvent() public {
        Creator atk = new Creator(factory);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address predicted,) = factory.predictMarket(address(atk));

        Buyer b = new Buyer();
        quote.mint(address(b), 100_000e6);
        atk.approve(address(quote), address(factory), type(uint256).max);
        quote.arm(address(b), abi.encodeCall(Buyer.buy, (address(quote), predicted, 1_000e6)), false);

        (address curve,) = atk.launch{value: FEE}(_params(1_000e6), FEE);
        assertTrue(quote.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(curve, predicted, "the prediction moved");
        assertEq(quote.balanceOf(curve), 2_000e6, "the curve does not hold both legs");
        _assertSolvent(curve, "the curve is insolvent after the launch");
    }

    // ---------------------------------------------------- 2. a nested SELL, the underflow question

    /**
     * CAN `q.balanceOf(curve) - before` UNDERFLOW AND REVERT A LEGITIMATE LAUNCH?
     *
     * No, and the reason is stronger than "nobody holds the token yet".
     *
     * At the instant the callback runs, the curve has just been initialised and holds the ENTIRE
     * token supply — `DokuToken.initialize` mints to the curve and there is no other mint, ever.
     * So a seller can only hold something it bought from this same curve inside this same
     * callback, and a buy-then-sell round trip returns strictly LESS quote than it took in: the
     * 1% fee and the pool-favouring rounding both point that way (fuzzed above). `held` therefore
     * ends the callback at or above where it started and `grew` cannot go negative.
     *
     * Proved rather than argued: the callback buys and sells everything back, and the `require`
     * inside `RoundTripper` pins the supply claim the argument rests on.
     */
    function test_nestedBuyThenSellCannotUnderflowTheDelta() public {
        Creator atk = new Creator(factory);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address predicted, address predictedToken) = factory.predictMarket(address(atk));

        RoundTripper rt = new RoundTripper();
        quote.mint(address(rt), 100_000e6);
        atk.approve(address(quote), address(factory), type(uint256).max);
        quote.arm(address(rt), abi.encodeCall(RoundTripper.run, (predicted, predictedToken, 1_000e6)), false);

        (address curve,) = atk.launch{value: FEE}(_params(1_000e6), FEE);
        assertTrue(quote.fired(), "the round trip never ran");
        _assertSolvent(curve, "the curve is insolvent after a round-trip callback");

        // The creator was credited for their own 1,000e6 and not for the round-tripper's residue.
        // The residue is the fees the round trip paid, which stay booked to the curve's buckets.
        BondingCurve c = BondingCurve(payable(curve));
        assertGt(c.quoteRaised(), 0, "the first buy did not land");
        assertEq(
            quote.balanceOf(curve),
            c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax(),
            "held != booked"
        );
    }

    // ------------------------------------ 3. the bare donation, and why it is not a finding

    /**
     * A callback that TRANSFERS quote to the curve without buying raises `held` and not `booked`,
     * so the fix credits the donation to the creator's first buy.
     *
     * DEMOTED, deliberately, and here is the argument against my own candidate. For this to be a
     * loss somebody has to move quote to a brand-new curve's address, in the same transaction as
     * its launch, without buying — which is a gift, and the gift is the donor's own doing. There
     * is no victim whose money is being routed: the alternative behaviour, leaving the donation
     * unbooked, makes the curve permanently over-collateralised and strands the same money, which
     * is strictly worse for everybody including the donor. And the donation is bounded by what the
     * donor sends, so it cannot mint a position out of a third party's deposit — a third party's
     * deposit reaches the curve only through `buy`, which books it.
     */
    function test_DEMOTED_aBareDonationIsCreditedToTheCreatorAndLeavesTheCurveSolvent() public {
        Creator atk = new Creator(factory);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address predicted,) = factory.predictMarket(address(atk));

        Donor d = new Donor();
        quote.mint(address(d), 500e6);
        atk.approve(address(quote), address(factory), type(uint256).max);
        quote.arm(address(d), abi.encodeCall(Donor.give, (address(quote), predicted, 500e6)), false);

        (address curve,) = atk.launch{value: FEE}(_params(1_000e6), FEE);
        assertTrue(quote.fired(), "the donation never happened");
        assertEq(quote.balanceOf(curve), 1_500e6, "the donation did not land");
        _assertSolvent(curve, "the donation left the curve insolvent");
        assertEq(BondingCurve(payable(curve)).quoteBooked(), 1_500e6, "the donation was not booked");
    }

    // ------------------------------------------------------------------- 4. re-entering `launch`

    /// @notice A callback that launches ANOTHER market mid-transfer. The outer `_firstBuy` holds a
    ///         `curve` address across the callback and the nonce advances underneath it, so a
    ///         collision there would be one market's `buyFor` pointed at another's money. It is
    ///         not: the two markets are distinct and both come out solvent.
    function test_reentrantLaunchDuringTheFirstBuyTransfer() public {
        Creator atk = new Creator(factory);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 10 ether);
        (address predicted,) = factory.predictMarket(address(atk));

        Relauncher r = new Relauncher(factory, address(quote));
        vm.deal(address(r), 10 ether);
        quote.arm(address(r), abi.encodeCall(Relauncher.go, (FEE)), false);
        atk.approve(address(quote), address(factory), type(uint256).max);

        (address curve,) = atk.launch{value: FEE}(_params(1_000e6), FEE);
        assertTrue(quote.fired(), "the nested launch never ran");
        assertEq(curve, predicted, "the outer launch took a different address than predicted");
        assertTrue(r.inner() != curve, "the inner launch collided with the outer market");
        _assertSolvent(curve, "the outer market is insolvent");
        _assertSolvent(r.inner(), "the inner market is insolvent");
    }

    // --------------------------------------------------------------- 5. the griefing arm (DEMOTED)

    /**
     * DENIAL OF SERVICE, NOT THEFT — labelled as such, as the loop's ranking rule requires.
     *
     * `grew <= booked` reverts `FirstBuyDeliveredNothing`. A quote asset that swallows the transfer
     * while reporting success trips it and the launch reverts. It costs the launcher their gas and
     * nothing else: no market exists, no money moved, and the next block is a retry. The griefer
     * has to BE the registered quote asset — an owner-screened contract — so this is the registry's
     * screen rather than a code defect, and refusing the launch is strictly better than the
     * behaviour it replaces, which was minting the creator a position out of someone else's
     * deposit.
     */
    function test_DEMOTED_griefing_aSwallowingQuoteRevertsTheLaunchAndCostsOnlyGas() public {
        Creator atk = new Creator(factory);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        atk.approve(address(quote), address(factory), type(uint256).max);
        quote.setSwallow(true);

        DokuFactory.LaunchParams memory p = _params(1_000e6);
        vm.expectRevert(DokuFactory.FirstBuyDeliveredNothing.selector);
        atk.launch{value: FEE}(p, FEE);

        // Nothing was created and nothing moved.
        assertEq(factory.nonces(address(atk)), 0, "a market survived the revert");
        assertEq(quote.balanceOf(address(atk)), 100_000e6, "the launcher's balance moved");
    }

    // ------------------------------------------------- 6. the native branch needs no measurement

    /**
     * DOES THE NATIVE BRANCH NEED THE SAME TREATMENT? No, and it is structural rather than
     * empirical.
     *
     * `c.buyFor{value: q}` moves native value as part of the CALL itself — there is no token
     * contract in the path, so nothing can run between "the factory holds it" and "the curve holds
     * it". The curve prices on `msg.value`, which the EVM guarantees is what arrived, and `buyFor`
     * refuses any other shape (`ValueMismatch`). The only re-entrancy window on this leg is the
     * REFUND, which fires after the buy is fully booked and is paid to the creator's own address.
     *
     * Proved by taking that window: a creator that re-enters `launch` from inside its own refund
     * gets a second, independent market, both are exactly solvent, and the factory's native balance
     * never drops below the fees it has accrued — so no launch is ever subsidised by another's fee.
     */
    function test_nativeFirstBuyNeedsNoDeltaAndItsRefundWindowIsHarmless() public {
        vm.prank(OWNER);
        registry.register(address(0), 1_000e18);

        NativeRelauncher nr = new NativeRelauncher(factory);
        vm.deal(address(nr), 10_000 ether);

        DokuFactory.LaunchParams memory p;
        p.meta.name = "Native";
        p.meta.ticker = "NAT";
        p.quoteAsset = address(0);
        p.sink = Sinks.BURN;
        p.economicsPin = factory.economicsPin(address(0), Sinks.BURN, 0);
        p.deadline = type(uint256).max;
        p.firstBuyQuote = 2_000 ether; // more than the curve can take, so the refund fires

        (address curve,) = nr.go{value: FEE + 2_000 ether}(p);
        assertTrue(nr.reentered(), "the refund window never opened");
        assertTrue(nr.inner() != curve, "the inner launch collided with the outer market");
        assertEq(BondingCurve(payable(curve)).quoteBooked(), curve.balance, "the outer market is insolvent");
        assertEq(
            BondingCurve(payable(nr.inner())).quoteBooked(), nr.inner().balance, "the inner market is insolvent"
        );
        assertEq(address(factory).balance, factory.pendingLaunchFees(), "the factory's native balance drifted");
    }
}

contract Buyer {
    function buy(address token, address curve, uint256 amount) external {
        IERC20(token).approve(curve, amount);
        BondingCurve(payable(curve)).buyWithToken(amount, 0, type(uint256).max);
    }
}

// =============================================================================================
//                     `activate` / `_deactivate` / `economicsPin` — the new front door
// =============================================================================================

contract Round1ActivationTest is Test {
    DokuFactory internal factory;
    QuoteRegistry internal registry;
    InertGraduator internal grad;
    PlainQuote internal quote;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant SINKADDR = address(0x5111);
    uint256 internal constant FEE = 0.01 ether;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), SINKADDR, FEE);
        grad = new InertGraduator(address(factory));
        quote = new PlainQuote(6);
        vm.prank(OWNER);
        registry.register(address(quote), 8_000e6);
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        Wiring.activate(factory, OWNER, address(grad));
    }

    /// @notice `_deactivate` really does clear the storage struct, field by field. A `delete` on a
    ///         struct of six addresses is easy to believe and easy to get wrong, and a stale
    ///         `dependencies.hook` is what `launch` staticcalls — so a half-cleared struct would
    ///         leave the per-launch re-read pointed at the previous graduator's hook.
    function test_deactivateClearsEveryDependencyField() public {
        (address g0, address h0, address s0,,,) = factory.dependencies();
        assertTrue(g0 != address(0) && h0 != address(0) && s0 != address(0), "nothing was stored");

        InertGraduator g2 = new InertGraduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(g2));

        (address g, address h, address s, address pm, address posm, address p2) = factory.dependencies();
        assertEq(g, address(0), "graduator survived");
        assertEq(h, address(0), "hook survived");
        assertEq(s, address(0), "creatorSink survived");
        assertEq(pm, address(0), "poolManager survived");
        assertEq(posm, address(0), "positionManager survived");
        assertEq(p2, address(0), "permit2 survived");
        assertEq(factory.dependencyHash(), bytes32(0), "the hash survived");
        assertFalse(factory.activated(), "still activated");
        assertTrue(factory.paused(), "not paused");
    }

    /**
     * A DOCUMENTATION DEFECT, NOT A SECURITY ONE — labelled, and reported as informational.
     *
     * `activate` ends with `if (paused()) _unpause();` under a comment that says "a factory paused
     * by the pauser after activation stays shut until `unpause`". It does not: re-running
     * `activate` — which the same docblock calls "idempotent by design ... a legitimate way to
     * confirm the graph is whole again" — REOPENS a factory the pauser shut.
     *
     * It is not a privilege escalation: `activate` is `onlyOwner` and the owner already holds
     * `unpause()`, so nothing is reachable here that was not reachable before. It is a comment
     * that will be read as a guarantee by whoever holds the pauser key during an incident, which
     * is exactly the moment it matters. Pinned as a behaviour so the comment and the code cannot
     * drift apart silently again.
     */
    /// @dev FIXED. `activate` used to unpause unconditionally, so re-running it — which its own
    ///      docblock calls a legitimate way to confirm the graph after a hook allowlist repair —
    ///      also REOPENED a factory the pauser had shut during an incident. Not a privilege
    ///      escalation (the owner already holds `unpause`), but the comment promising the pauser
    ///      independence would have been read as a guarantee by whoever held that key at the worst
    ///      possible moment. Only the transition INTO an activated state opens the door now.
    function test_activateDoesNotReopenAFactoryThePauserShut() public {
        DokuFactory.Dependencies memory d = Wiring.declare(factory, address(grad));

        vm.prank(PAUSER);
        factory.pause();
        assertTrue(factory.paused(), "the pauser could not pause");

        vm.prank(OWNER);
        factory.activate(d);
        assertTrue(factory.paused(), "a confirmation re-run reopened the factory");
        assertTrue(factory.activated(), "the graph check itself did not run");

        // The ordinary re-wire flow still ends launchable: `setGraduator` deactivates, so the next
        // `activate` IS a first activation and does open the door.
        InertGraduator g2 = new InertGraduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(g2));
        assertFalse(factory.activated(), "setGraduator did not deactivate");

        // Hoisted: an inner call inside the argument list is evaluated FIRST and would consume
        // the prank, so the activate would run unpranked and revert Ownable.
        DokuFactory.Dependencies memory d2 = Wiring.declare(factory, address(g2));
        vm.prank(OWNER);
        factory.activate(d2);
        assertFalse(factory.paused(), "the re-wire flow left the factory shut");
    }

    /// @notice `economicsPin` moves when CUSTODY moves, which is the half of the pin that was
    ///         missing before today: a quote taken before a graduator change cannot settle after it.
    function test_economicsPinMovesWithTheGraduatorAndTheDependencyHash() public {
        bytes32 before = factory.economicsPin(address(quote), Sinks.BURN, 0);

        InertGraduator g2 = new InertGraduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(g2));
        assertTrue(
            factory.economicsPin(address(quote), Sinks.BURN, 0) != before, "the pin ignored the graduator"
        );

        Wiring.activate(factory, OWNER, address(g2));
        assertTrue(
            factory.economicsPin(address(quote), Sinks.BURN, 0) != before,
            "the pin returned to its old value after re-activation onto a different graph"
        );
    }

    /// @notice L-04's fix, asserted as an identity rather than as two literals that happen to
    ///         match: the registry and the curve read the SAME constant at both ends of the bound.
    function test_theTargetCeilingIsOneNumberAtBothDoors() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                QuoteRegistry.TargetTooLarge.selector, DOKU_MAX_QUOTE_TARGET + 5, DOKU_MAX_QUOTE_TARGET
            )
        );
        registry.register(address(0x1234), DOKU_MAX_QUOTE_TARGET + 5);

        BondingCurve impl = BondingCurve(payable(factory.curveImplementation()));
        assertEq(impl.MAX_QUOTE_TARGET(), DOKU_MAX_QUOTE_TARGET, "the curve's ceiling is not the constant");
        assertEq(impl.MIN_QUOTE_TARGET(), DOKU_MIN_QUOTE_TARGET, "the curve's floor is not the constant");
    }
}
