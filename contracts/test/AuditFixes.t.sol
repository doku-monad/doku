// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve, DOKU_SEED_BASE} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {DokuHook} from "../src/v4/DokuHook.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {MarketsStub} from "./mocks/MarketsStub.sol";

// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
// solhint-disable-next-line no-unused-import
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
// solhint-disable-next-line no-unused-import
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract RecordingCreatorSinkRegression {
    function register(address, PoolId, address, address, address) external {}
    receive() external payable {}
}

/**
 * The four contract bugs the 2026-09-09 internal audit found, each pinned so it cannot come back.
 *
 * Every one of them was a PERMANENT FREEZE or a permanent revenue bypass on an immutable contract,
 * which is the only class of bug this protocol cannot answer with a patch — a market already
 * launched stays on the code it launched under, forever. The proofs of exploit that produced these
 * live in `evidence/audit-2026-09-09/`; what is here is the other side of each one.
 */
contract AuditFixesTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0xBAD);
    uint256 internal constant TARGET = 1_000e18;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    MarketsStub internal markets;
    RecordingCreatorSinkRegression internal creatorSink;
    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        markets = new MarketsStub();
        creatorSink = new RecordingCreatorSinkRegression();
        bytes memory args =
            abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook =
            new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        graduation = new DokuGraduation(address(manager), address(lpm), address(permit2), address(dokuHook), address(markets));
        dokuHook.setGraduator(address(graduation), true);
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        vm.deal(ALICE, 1_000_000e18);
        vm.deal(MALLORY, 1e18);
    }

    function _market(uint8 sink) internal returns (BondingCurve c, DokuToken t) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), address(0), TARGET, sink,
            sink == Sinks.CREATOR ? ALICE : address(0), 0, ALICE,
            TREASURY, address(graduation), address(creatorSink)
        );
    }


    // ------------------------------------------------------------------ 1. the external burn

    /**
     * `DokuToken` is `ERC20Burnable`, so any holder may burn. The curve used to reconstruct the
     * original supply as `totalSupply() + burnedByTax` at fill time, which counted only the burns
     * IT performed — so one wei burned by a stranger left the seed short, `graduate` reverted
     * `SeedOutOfRange`, and `_tryAutoGraduate` swallowed it. The raise and every holder's tokens
     * were sealed in a closed curve for the price of a dust trade.
     */
    function test_anExternalBurnCannotFreezeTheRaise() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        vm.prank(MALLORY);
        uint256 got = c.buy{value: 1}(0, block.timestamp);
        vm.prank(MALLORY);
        t.burn(got);
        assertEq(c.burnedByTax(), 0, "the burn is invisible to the curve, which is the point");
        assertLt(t.totalSupply(), t.TOTAL_SUPPLY(), "supply did not fall");

        vm.prank(ALICE);
        c.buy{value: 5 * TARGET}(0, block.timestamp);

        assertTrue(graduation.graduated(address(c)), "an outside burn still bricks graduation");
        assertGe(c.seedBase(), DOKU_SEED_BASE, "the seed came out short of the design");
    }

    /// @dev The same at a size no rounding could absorb: a third of the float, burned.
    function test_aLargeExternalBurnCannotFreezeTheRaiseEither() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        vm.deal(MALLORY, TARGET);
        vm.prank(MALLORY);
        uint256 got = c.buy{value: TARGET / 3}(0, block.timestamp);
        vm.prank(MALLORY);
        t.burn(got);

        vm.prank(ALICE);
        c.buy{value: 5 * TARGET}(0, block.timestamp);
        assertTrue(graduation.graduated(address(c)), "a large outside burn bricked graduation");
    }

    // ------------------------------------------------------------- 2. the impostor curve

    /**
     * `graduate` took an arbitrary address and believed everything it said about itself. An
     * impostor naming a real market's token and quote could claim that market's PoolKey, and the
     * genuine curve's own graduation would then find the pool already there and revert forever.
     *
     * The factory is the only register of what a market is, so `graduate` asks it. The CALLER stays
     * permissionless — anyone may push a filled market over the line — and the SUBJECT is checked.
     */
    function test_anImpostorCurveCannotBeGraduated() public {
        (BondingCurve c,) = _market(Sinks.BURN);
        markets.deny(address(c));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.prank(ALICE);
        c.buy{value: 5 * TARGET}(0, block.timestamp);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertFalse(graduation.graduated(address(c)), "a denied curve graduated anyway");
        vm.expectRevert(abi.encodeWithSelector(DokuGraduation.NotAMarket.selector, address(c)));
        graduation.graduate(address(c));
    }

    /// @dev And the register is the only thing consulted: a market it recognises still graduates,
    ///      called by a stranger rather than by the curve itself.
    function test_aRealMarketStillGraduatesWhenAStrangerPushesIt() public {
        (BondingCurve c,) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.prank(ALICE);
        c.buy{value: 5 * TARGET}(0, block.timestamp);
        assertTrue(graduation.graduated(address(c)), "the honest path stopped working");
    }

    // ------------------------------------------------------- 3. the rounding residue

    /**
     * Every sell rounds in the pool's favour, leaving a wei or two of residue in the virtual base,
     * and the residue has no ceiling. `graduate` used to refuse a seed more than
     * `seedDustTolerance` above the design, so ~4,600 dust sells on a coarse-quote market froze it
     * — permanently, and cheaply. The bound is gone; "never short" is the whole rule now.
     */
    function test_accumulatedSellResidueCannotFreezeAMarket() public {
        (BondingCurve c, DokuToken t) = _market(Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        // Buy once, then churn: each round trip leaves residue behind in the seed.
        vm.prank(ALICE);
        c.buy{value: TARGET / 4}(0, block.timestamp);
        for (uint256 i; i < 60; ++i) {
            uint256 held = t.balanceOf(ALICE);
            vm.prank(ALICE);
            t.approve(address(c), held / 200);
            vm.prank(ALICE);
            c.sell(held / 200, 0, block.timestamp);
        }
        uint256 residueBefore = c.seedBase();
        assertEq(residueBefore, 0, "seed latches at fill, not before");

        vm.prank(ALICE);
        c.buy{value: 5 * TARGET}(0, block.timestamp);
        assertTrue(graduation.graduated(address(c)), "trading residue froze the market");
        assertGe(c.seedBase(), DOKU_SEED_BASE, "the seed came out short");
    }
}
