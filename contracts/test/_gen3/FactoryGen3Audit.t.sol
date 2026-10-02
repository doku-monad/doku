// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {BondingCurve, DOKU_SEED_BASE} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Wiring} from "../helpers/Wiring.sol";

/// @dev A graduator wired to the factory under test: passes `setGraduator`'s check and actually
///      calls `release`, so a seed that exceeds the curve's balance shows up as a REVERT rather
///      than as a swallowed non-graduation.
contract GradStub {
    address public immutable factory;
    mapping(address => bool) public graduated;
    uint256 public lastQuote;
    uint256 public lastBase;
    bool public lastOk;
    bytes public lastErr;

    constructor(address f) {
        factory = f;
    }

    function graduate(address curve) external returns (bytes32, uint256) {
        graduated[curve] = true;
        (lastQuote, lastBase) = BondingCurve(payable(curve)).release();
        return (bytes32(0), 0);
    }

    /// @dev Same thing but never reverts, so a test can read WHY release failed.
    function tryGraduate(address curve) external {
        try BondingCurve(payable(curve)).release() returns (uint256 q, uint256 b) {
            lastOk = true;
            lastQuote = q;
            lastBase = b;
        } catch (bytes memory err) {
            lastOk = false;
            lastErr = err;
        }
    }

    function sinkOf(address) external view returns (address) {
        return address(this);
    }

    function creditCurveTax(address) external payable {}

    function creditCurveTax(address, uint256) external {}

    receive() external payable {}
}

contract Sink6 is ERC20 {
    constructor() ERC20("Q6", "Q6") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev A quote asset that keeps a cut on every transfer. Must never be registered — the point is
///      that the launch path stays solvent even if one ever is.
contract FeeOnTransfer is ERC20 {
    uint256 public bps;

    constructor(uint256 bps_) ERC20("FOT", "FOT") {
        bps = bps_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || bps == 0) {
            super._update(from, to, value);
            return;
        }
        uint256 cut = (value * bps) / 10_000;
        super._update(from, address(0xFEE), cut);
        super._update(from, to, value - cut);
    }
}

/// @dev A quote asset that calls back into the protocol between the factory's two balance reads.
contract ReentrantQuote is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public fired;
    bool public innerOk;
    bytes public innerErr;

    constructor() ERC20("RQ", "RQ") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function arm(address t, bytes calldata p) external {
        target = t;
        payload = p;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && !fired && from != address(0)) {
            fired = true;
            (bool ok, bytes memory err) = target.call(payload);
            innerOk = ok;
            innerErr = err;
        }
    }
}

contract FactoryGen3AuditTest is Test {
    DokuFactory internal factory;
    QuoteRegistry internal registry;
    GradStub internal grad;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant CREATOR = address(0xC0);
    address internal constant ALICE = address(0xA11CE);
    address internal constant SINKADDR = address(0x5111);

    uint256 internal constant FEE = 0.01 ether;
    uint256 internal constant NATIVE_TARGET = 1_000e18;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), SINKADDR, FEE);
        grad = new GradStub(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        // The factory ships paused with no graduator; activation is what opens it. See
        // `test/helpers/Wiring.sol`.
        Wiring.activate(factory, OWNER, address(grad));
        vm.prank(OWNER);
        registry.register(address(0), NATIVE_TARGET);
        vm.deal(CREATOR, 1_000_000 ether);
        vm.deal(ALICE, 10_000_000 ether);
    }

    function _p(address quote, uint8 sink, uint16 tax)
        internal
        view
        returns (DokuFactory.LaunchParams memory p)
    {
        p.meta.name = "Market";
        p.meta.ticker = "MKT";
        p.quoteAsset = quote;
        p.sink = sink;
        p.creatorTaxBps = tax;
        p.economicsPin = factory.economicsPin(quote, sink, tax);
        p.deadline = block.timestamp + 1 days;
        if (sink == Sinks.CREATOR) p.routedRecipient = CREATOR;
    }

    // ------------------------------------------------------------- the release-solvency identity

    /// @dev THE invariant the removed upper bound on the seed now rests on entirely: `release`
    ///      transfers `seedBase`, and nothing checks it against what the curve holds. If
    ///      `launchSupply + base - CEILING` can ever exceed `balanceOf(curve)` by one wei, the
    ///      filling buy's graduation reverts, every retry reverts identically, and the whole raise
    ///      is sealed in a closed curve.
    function testFuzz_seedNeverExceedsWhatTheCurveHolds(
        uint8 sinkRaw,
        uint16 taxRaw,
        uint256 target5,
        uint96 firstBuy,
        uint96[8] calldata buys,
        uint16[8] calldata sellBps,
        uint32[8] calldata warps
    ) public {
        uint8 sink = uint8(sinkRaw % 3);
        uint16 tax = uint16((taxRaw % 101) * 10);
        // A multiple of five, spanning a coarse six-decimal quote up to a large native one.
        uint256 target = (bound(target5, 1, 2_000_000) * 5) * 1e6;

        vm.prank(OWNER);
        QuoteRegistry r2 = new QuoteRegistry(OWNER);
        Sink6 q = new Sink6();
        vm.prank(OWNER);
        r2.register(address(q), target);

        DokuFactory f2 = new DokuFactory(OWNER, PAUSER, TREASURY, address(r2), SINKADDR, 0);
        GradStub g2 = new GradStub(address(f2));
        vm.prank(OWNER);
        f2.setGraduator(address(g2));

        // The factory ships paused with no graduator; activation is what opens it. See
        // `test/helpers/Wiring.sol`.
        Wiring.activate(f2, OWNER, address(g2));
        DokuFactory.LaunchParams memory p;
        p.meta.name = "Market";
        p.meta.ticker = "MKT";
        p.quoteAsset = address(q);
        p.sink = sink;
        p.creatorTaxBps = tax;
        p.economicsPin = f2.economicsPin(address(q), sink, tax);
        p.deadline = type(uint256).max;
        if (sink == Sinks.CREATOR) p.routedRecipient = CREATOR;
        p.firstBuyQuote = bound(uint256(firstBuy), 0, target / 2);

        q.mint(CREATOR, type(uint128).max);
        q.mint(ALICE, type(uint128).max);
        vm.prank(CREATOR);
        q.approve(address(f2), type(uint256).max);

        vm.prank(CREATOR);
        (address curveAddr,) = f2.launch(p);
        BondingCurve c = BondingCurve(payable(curveAddr));
        DokuToken t = DokuToken(address(c.token()));

        vm.prank(ALICE);
        q.approve(curveAddr, type(uint256).max);

        for (uint256 i; i < 8; ++i) {
            if (c.readyToGraduate()) break;
            vm.warp(block.timestamp + (warps[i] % 400));
            vm.roll(block.number + 1);
            uint256 amt = bound(uint256(buys[i]), 1, target);
            vm.prank(ALICE);
            try c.buyWithToken(amt, 0, type(uint256).max) {} catch {}
            _assertIdentity(c, t);
            if (c.readyToGraduate()) break;
            uint256 held = t.balanceOf(ALICE);
            uint256 sellAmt = (held * (sellBps[i] % 10_000)) / 10_000;
            if (sellAmt != 0) {
                vm.prank(ALICE);
                t.approve(curveAddr, sellAmt);
                vm.prank(ALICE);
                try c.sell(sellAmt, 0, type(uint256).max) {} catch {}
            }
            _assertIdentity(c, t);
        }

        // Fill it.
        if (!c.readyToGraduate()) {
            vm.warp(block.timestamp + 1000);
            vm.roll(block.number + 1);
            vm.prank(ALICE);
            c.buyWithToken(target * 3, 0, type(uint256).max);
        }

        assertTrue(c.readyToGraduate(), "did not fill");
        assertEq(c.quoteRaised(), 0, "auto-graduation did not release the raise");
        assertTrue(g2.graduated(curveAddr), "auto-graduation was swallowed");
        assertGe(g2.lastBase(), DOKU_SEED_BASE, "seed came out short of the design");
        assertEq(g2.lastQuote(), target, "the raise is not exactly the target");
    }

    /// @dev `balance == launchSupply + base - CEILING`, plus the quote-side solvency identity.
    ///
    ///      MINUS THE SEED ONCE IT IS GONE. Auto-graduation is atomic with the filling buy
    ///      (`BondingCurve._latchFill` -> `_tryAutoGraduate` -> `release`), so there is no instant
    ///      between "filled" and "released" for a caller to observe. `release` sends exactly
    ///      `seedBase` out (`BondingCurve.sol:875,881`), and `seedBase` IS
    ///      `launchSupply + base - CEILING` (`BondingCurve.sol:727`) — so after release the
    ///      remaining balance is exactly zero plus whatever was donated in. Asserting the
    ///      pre-release form unconditionally asserts `0 == seedBase`, which is a statement about
    ///      the test's own sequencing, not about the curve.
    function _assertIdentity(BondingCurve c, DokuToken t) internal view {
        (uint128 base,) = c.reserves();
        uint256 expected = c.launchSupply() + base - c.BASE_VIRTUAL_CEILING();
        if (c.released()) expected -= c.seedBase();
        assertEq(t.balanceOf(address(c)), expected, "token identity broke");
        if (c.readyToGraduate() && !c.released()) {
            assertLe(c.seedBase(), t.balanceOf(address(c)), "seed exceeds what the curve holds");
        }
        address quote = c.quoteAsset();
        uint256 held = quote == address(0) ? address(c).balance : IERC20(quote).balanceOf(address(c));
        uint256 owed = c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax();
        assertGe(held, owed, "curve is quote-insolvent");
    }

    // ------------------------------------------------------------------ the measured first buy

    /// @dev The launch path now prices the first buy on what ARRIVED. Assert the curve is solvent
    ///      against a quote that keeps a cut, and that the credited leg is the delivered one.
    function test_feeOnTransferFirstBuyLeavesTheCurveSolvent() public {
        FeeOnTransfer q = new FeeOnTransfer(500); // 5% kept
        vm.prank(OWNER);
        registry.register(address(q), 8_000e6);

        DokuFactory.LaunchParams memory p = _p(address(q), Sinks.BURN, 0);
        p.firstBuyQuote = 1_000e6;
        q.mint(CREATOR, 10_000e6);
        vm.prank(CREATOR);
        q.approve(address(factory), type(uint256).max);

        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: FEE}(p);
        BondingCurve c = BondingCurve(payable(curveAddr));
        DokuToken t = DokuToken(address(c.token()));

        uint256 arrived = 950e6; // 1000 less the 5% cut
        assertEq(q.balanceOf(curveAddr), arrived, "the curve did not receive the net");
        _assertIdentity(c, t);
        // Everything the curve books is against what arrived, never against what was asked for.
        assertEq(
            c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax(),
            arrived,
            "the curve booked more than it holds"
        );
    }

    /// @dev A donation to the PREDICTED curve address, landing before the launch, must not be
    ///      creditable as part of the first buy.
    function test_donationToThePredictedCurveIsNotCredited() public {
        Sink6 q = new Sink6();
        vm.prank(OWNER);
        registry.register(address(q), 8_000e6);
        (address predicted,) = factory.predictMarket(CREATOR);

        q.mint(ALICE, 1_000_000e6);
        vm.prank(ALICE);
        q.transfer(predicted, 500_000e6); // a donation, before the clone exists

        DokuFactory.LaunchParams memory p = _p(address(q), Sinks.BURN, 0);
        p.firstBuyQuote = 1_000e6;
        q.mint(CREATOR, 10_000e6);
        vm.prank(CREATOR);
        q.approve(address(factory), type(uint256).max);
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: FEE}(p);
        assertEq(curveAddr, predicted, "prediction moved");

        BondingCurve c = BondingCurve(payable(curveAddr));
        assertEq(
            c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax(),
            1_000e6,
            "the donation was credited to the creator's first buy"
        );
    }

    /// @dev A quote token that re-enters between the factory's two balance reads. The inner call is
    ///      recorded rather than asserted to revert, so the test reports what actually happened.
    function test_reentrantQuoteDuringTheFirstBuyDelta() public {
        ReentrantQuote q = new ReentrantQuote();
        vm.prank(OWNER);
        registry.register(address(q), 8_000e6);

        q.mint(CREATOR, 100_000e6);
        vm.prank(CREATOR);
        q.approve(address(factory), type(uint256).max);

        (address predicted,) = factory.predictMarket(CREATOR);
        // Arm the token to buy on the brand-new curve mid-transfer, crediting itself.
        q.mint(address(q), 50_000e6);
        vm.prank(address(q));
        q.approve(predicted, type(uint256).max);
        q.arm(predicted, abi.encodeWithSelector(BondingCurve.buyWithToken.selector, uint256(1_000e6), uint256(0), type(uint256).max));

        DokuFactory.LaunchParams memory p = _p(address(q), Sinks.BURN, 0);
        p.firstBuyQuote = 1_000e6;
        vm.prank(CREATOR);
        (address curveAddr,) = factory.launch{value: FEE}(p);

        BondingCurve c = BondingCurve(payable(curveAddr));
        DokuToken t = DokuToken(address(c.token()));
        emit log_named_string("inner call succeeded", q.innerOk() ? "YES" : "no");
        emit log_named_uint("curve quote balance", q.balanceOf(curveAddr));
        emit log_named_uint("booked", c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax());
        _assertIdentity(c, t);
    }

    // ----------------------------------------------------------------- the fee ledger vs balance

    function testFuzz_pendingLaunchFeesNeverExceedTheBalance(uint96 a, uint96 b, uint96 first) public {
        uint256 fb = bound(uint256(first), 0, 100 ether);
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = fb;
        vm.warp(block.timestamp + 1000);
        vm.prank(CREATOR);
        factory.launch{value: FEE + fb}(p);
        assertGe(address(factory).balance, factory.pendingLaunchFees(), "fee ledger exceeds balance");
        assertEq(address(factory).balance, factory.pendingLaunchFees(), "unaccounted MON in the factory");

        p.economicsPin = factory.economicsPin(address(0), Sinks.BURN, 0);
        uint256 fb2 = bound(uint256(a) + uint256(b), 0, 100 ether);
        p.firstBuyQuote = fb2;
        vm.prank(CREATOR);
        factory.launch{value: FEE + fb2}(p);
        assertEq(address(factory).balance, factory.pendingLaunchFees(), "unaccounted MON in the factory");

        uint256 pending = factory.pendingLaunchFees();
        factory.collectLaunchFees();
        assertEq(TREASURY.balance, pending, "fees did not reach the recipient");
        assertEq(address(factory).balance, 0, "MON left behind");
    }
}
