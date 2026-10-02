// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {BondingCurve, DOKU_SEED_BASE} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Sinks} from "../../src/lib/Sinks.sol";

/// @dev Accepts release() and records what it got, like DokuGraduation does.
contract Grad {
    function release(BondingCurve c) external returns (uint256 q, uint256 b) {
        (q, b) = c.release();
    }
    function sinkOf(address) external pure returns (address) { return address(0); }
    function creditCurveTax(address) external payable {}
    function creditCurveTax(address, uint256) external {}
    receive() external payable {}
}

/// @dev A quote token with N decimals, to reach the coarse-quote rounding regime.
contract Coarse is ERC20 {
    uint8 private immutable d;
    constructor(uint8 d_) ERC20("Coarse", "CRS") { d = d_; }
    function decimals() public view override returns (uint8) { return d; }
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @dev A token whose supply the deployer can move AFTER the curve latched launchSupply.
contract MutableSupply is ERC20 {
    constructor(address to, uint256 amt) ERC20("Mut", "MUT") { _mint(to, amt); }
    function mintMore(address to, uint256 amt) external { _mint(to, amt); }
    function burnFromAnyone(address who, uint256 amt) external { _burn(who, amt); }
}

contract BcCustodyAudit3 is Test {
    uint256 constant CEIL = 1_088_888_889_200_000_000_000_000_000;
    uint256 constant FLOOR = 311_111_111_200_000_000_000_000_000;
    uint256 constant CURVE_SUPPLY = 777_777_778e18;

    address constant TREASURY = address(0x7EA);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);

    BondingCurve curveImpl;
    DokuToken tokenImpl;
    Grad grad;

    function setUp() public {
        curveImpl = new BondingCurve();
        tokenImpl = new DokuToken();
        grad = new Grad();
    }

    // ---------------------------------------------------------------- harness

    function _native(uint256 target, uint8 sink) internal returns (BondingCurve c, DokuToken t) {
        c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        t = DokuToken(Clones.clone(address(tokenImpl)));
        t.initialize("T", "T", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), target, sink, address(0), 0, address(0), TREASURY, address(grad), address(0));
    }

    function _erc20(uint256 target, uint8 sink, uint8 dec) internal returns (BondingCurve c, DokuToken t, Coarse q) {
        q = new Coarse(dec);
        c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        t = DokuToken(Clones.clone(address(tokenImpl)));
        t.initialize("T", "T", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(q), target, sink, address(0), 0, address(0), TREASURY, address(grad), address(0));
    }

    /// The identity `_latchFill` relies on: curve token balance == launchSupply + base - ceiling.
    function _assertIdentity(BondingCurve c, DokuToken t) internal view {
        (uint128 b,) = c.reserves();
        assertEq(t.balanceOf(address(c)), c.launchSupply() + uint256(b) - CEIL, "token balance identity");
    }

    function _assertSolvent(BondingCurve c) internal view {
        uint256 liabilities =
            c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax();
        assertLe(liabilities, address(c).balance, "quote solvency");
    }

    // ================================================================ FIX 1: external burn

    /// The gen-2 freeze: a stranger burns one wei, the reconstructed supply comes out short,
    /// `graduate` reverts SeedOutOfRange forever. Under gen-3 the seed is latched supply.
    function test_externalBurnBeforeFillCannotShortTheSeed() public {
        (BondingCurve c, DokuToken t) = _native(1_000e18, Sinks.BURN);
        vm.deal(ALICE, 2_000e18);
        vm.warp(block.timestamp + 400); // past the anti-sniper window

        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);

        // A stranger burns their own tokens. In no protocol ledger.
        // The balance is read into a local FIRST: an argument-position `balanceOf` is a call, and
        // it consumes the `vm.prank` before `burn` ever runs — which burned from the test contract
        // (balance zero) instead of from ALICE.
        vm.prank(ALICE);
        t.burn(1);
        uint256 half = t.balanceOf(ALICE) / 2;
        vm.prank(ALICE);
        t.burn(half);

        vm.prank(ALICE);
        c.buy{value: 1_500e18}(0, block.timestamp);

        assertTrue(c.readyToGraduate(), "filled");
        _assertIdentity(c, t);
        assertGe(c.seedBase(), DOKU_SEED_BASE, "seed not short");
        assertLe(c.seedBase(), t.balanceOf(address(c)), "seed within balance");

        uint256 bal = t.balanceOf(address(c));
        (uint256 q, uint256 b) = grad.release(c);
        assertEq(b, bal, "released exactly the balance");
        assertEq(q, c.quoteTarget(), "raise exact");
    }

    /// A token donation before the fill used to be absorbed into the seed and bricked the market.
    function test_tokenDonationBeforeFillIsStrandedNotFatal() public {
        (BondingCurve c, DokuToken t) = _native(1_000e18, Sinks.REWARDS);
        vm.deal(ALICE, 2_000e18);
        vm.warp(block.timestamp + 400);

        vm.prank(ALICE);
        c.buy{value: 100e18}(0, block.timestamp);
        uint256 donation = 1_000_001;
        vm.prank(ALICE);
        t.transfer(address(c), donation);

        vm.prank(ALICE);
        c.buy{value: 1_500e18}(0, block.timestamp);

        assertTrue(c.readyToGraduate());
        assertEq(t.balanceOf(address(c)), c.seedBase() + donation, "donation stranded, not absorbed");
        (, uint256 b) = grad.release(c);
        assertEq(b, c.seedBase());
        assertEq(t.balanceOf(address(c)), donation, "donation still stranded after release");
    }

    // ================================================================ FIX 3: removed upper bound

    /// Thousands of dust sells on a 6-decimal quote. Under gen-2 this pushed the seed past
    /// `seedDustTolerance` and froze the raise. Measure how far the seed actually drifts, and
    /// prove `release` can still pay it.
    function test_dustSellResidueCannotOutrunTheBalance() public {
        uint256 target = 8_000_000_000; // 8,000 units of a 6-decimal quote
        (BondingCurve c, DokuToken t, Coarse q) = _erc20(target, Sinks.REWARDS, 6);
        q.mint(ALICE, target * 10);
        vm.warp(block.timestamp + 400);

        vm.startPrank(ALICE);
        q.approve(address(c), type(uint256).max);
        t.approve(address(c), type(uint256).max);
        c.buyWithToken(target / 2, 0, block.timestamp);

        uint256 chunk = t.balanceOf(ALICE) / 20000;
        for (uint256 i; i < 4000; ++i) {
            c.sell(chunk, 0, block.timestamp);
            c.buyWithToken(q.balanceOf(ALICE) / 100000 + 1, 0, block.timestamp);
        }
        _assertIdentity(c, t);

        // fill it
        c.buyWithToken(q.balanceOf(ALICE), 0, block.timestamp);
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "filled");
        (uint128 b,) = c.reserves();
        console2.log("base reserve at fill  ", uint256(b));
        console2.log("BASE_VIRTUAL_FLOOR    ", FLOOR);
        console2.log("residue above floor   ", uint256(b) - FLOOR);
        console2.log("seedBase              ", c.seedBase());
        console2.log("DOKU_SEED_BASE        ", DOKU_SEED_BASE);
        console2.log("seed above nominal    ", c.seedBase() - DOKU_SEED_BASE);

        assertGe(c.seedBase(), DOKU_SEED_BASE, "seed never short");
        assertEq(c.seedBase(), t.balanceOf(address(c)), "seed == balance");
        (uint256 rq, uint256 rb) = grad.release(c);
        assertEq(rq, target, "raise exact");
        assertEq(rb, c.seedBase());
        assertEq(t.balanceOf(address(c)), 0, "curve drained of token");
    }

    // ================================================================ the identity, fuzzed

    /// Random interleaved buys and sells on every sink, then the fill. The seed must equal the
    /// balance at the latch and `release` must never ask for more than the curve holds.
    function test_identityAndSolvencyHold_fuzz(uint256 seed_, uint8 sinkRaw, uint16 taxBps) public {
        uint8 sink = uint8(sinkRaw % 3);
        taxBps = uint16((taxBps % 101) * 10);
        uint256 target = 1_000e18;

        BondingCurve c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        DokuToken t = DokuToken(Clones.clone(address(tokenImpl)));
        t.initialize("T", "T", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), address(0), target, sink,
            sink == Sinks.CREATOR ? BOB : address(0),
            taxBps, taxBps == 0 ? address(0) : BOB,
            TREASURY, address(grad), address(0)
        );

        vm.deal(ALICE, 1_000_000e18);
        uint256 s = seed_;
        for (uint256 i; i < 40; ++i) {
            s = uint256(keccak256(abi.encode(s, i)));
            if (c.readyToGraduate()) break;
            if (s % 3 == 0) vm.warp(block.timestamp + (s % 120));
            if (s % 2 == 0 || t.balanceOf(ALICE) == 0) {
                uint256 amt = 1 + (s % 60e18);
                vm.prank(ALICE);
                try c.buy{value: amt}(0, block.timestamp) {} catch {}
            } else {
                uint256 amt = 1 + (s % t.balanceOf(ALICE));
                vm.startPrank(ALICE);
                t.approve(address(c), type(uint256).max);
                try c.sell(amt, 0, block.timestamp) {} catch {}
                vm.stopPrank();
            }
            _assertIdentity(c, t);
            _assertSolvent(c);
        }

        if (!c.readyToGraduate()) {
            vm.warp(block.timestamp + 400);
            vm.prank(ALICE);
            c.buy{value: target * 2}(0, block.timestamp);
        }
        assertTrue(c.readyToGraduate());
        assertEq(c.quoteRaised(), target, "raise lands exactly on target");
        assertGe(c.seedBase(), DOKU_SEED_BASE, "seed never short");
        assertEq(c.seedBase(), t.balanceOf(address(c)), "seed == balance at release");
        _assertSolvent(c);
        (uint256 rq, uint256 rb) = grad.release(c);
        assertEq(rb, c.seedBase());
        assertEq(rq, target);
    }

    // ================================================================ launchSupply bound

    /// `initialize` only refuses `launchSupply <= CURVE_SUPPLY`. A supply anywhere in
    /// (CURVE_SUPPLY, CURVE_SUPPLY + DOKU_SEED_BASE) initialises fine, fills fine, and then
    /// `DokuGraduation` refuses it forever: the seed is below SEED_BASE with no tolerance.
    /// Not reachable through DokuToken (TOTAL_SUPPLY is a constant) — measured to bound the gap.
    function test_launchSupplyBelowSeedBasePlusCurveSupplyIsAcceptedThenUngraduatable() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        uint256 supply = CURVE_SUPPLY + 1e18; // passes SupplyTooSmall, far under the seed
        MutableSupply m = new MutableSupply(address(c), supply);
        c.initialize(address(m), address(0), 1_000e18, Sinks.REWARDS, address(0), 0, address(0), TREASURY, address(grad), address(0));
        assertEq(c.launchSupply(), supply);

        vm.deal(ALICE, 3_000e18);
        vm.warp(block.timestamp + 400);
        vm.prank(ALICE);
        c.buy{value: 2_000e18}(0, block.timestamp);
        assertTrue(c.readyToGraduate());
        assertLt(c.seedBase(), DOKU_SEED_BASE, "seed below the graduator's floor");
        console2.log("seedBase with a 777,777,779e18 supply", c.seedBase());
    }

    /// A token that mints MORE after the curve latched: the seed stays the latched number, so the
    /// extra supply is simply not in the handover. No over-transfer.
    function test_postInitialiseMintDoesNotInflateTheSeed() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        MutableSupply m = new MutableSupply(address(c), 1_000_000_000e18);
        c.initialize(address(m), address(0), 1_000e18, Sinks.REWARDS, address(0), 0, address(0), TREASURY, address(grad), address(0));

        m.mintMore(address(c), 500_000_000e18); // curve now holds 1.5e27, launchSupply says 1e27

        vm.deal(ALICE, 3_000e18);
        vm.warp(block.timestamp + 400);
        vm.prank(ALICE);
        c.buy{value: 2_000e18}(0, block.timestamp);
        assertTrue(c.readyToGraduate());
        assertEq(c.seedBase(), 222_222_222e18, "seed unmoved by the extra mint");
        assertLt(c.seedBase(), m.balanceOf(address(c)), "extra supply stranded, not released");
        (, uint256 rb) = grad.release(c);
        assertEq(rb, 222_222_222e18);
    }

    /// A token burned out from under the curve (a hostile token with a public _burn on any holder)
    /// is the one way to push seedBase above the curve's actual balance — measured so the boundary
    /// of the "release can only move what the curve holds" claim is on the record.
    function test_hostileTokenBurningTheCurveBreaksReleaseButIsNotReachable() public {
        BondingCurve c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        MutableSupply m = new MutableSupply(address(c), 1_000_000_000e18);
        c.initialize(address(m), address(0), 1_000e18, Sinks.REWARDS, address(0), 0, address(0), TREASURY, address(grad), address(0));

        vm.deal(ALICE, 3_000e18);
        vm.warp(block.timestamp + 400);
        vm.prank(ALICE);
        c.buy{value: 2_000e18}(0, block.timestamp);
        assertTrue(c.readyToGraduate());

        m.burnFromAnyone(address(c), 1e18); // only possible on a token that is not DokuToken
        assertGt(c.seedBase(), m.balanceOf(address(c)));
        vm.expectRevert();
        grad.release(c);
    }
}
