// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice The generation-5 canary, against the DEPLOYED contracts on a Monad-mainnet fork.
///
///         `Gen4Canary.t.sol` proves launch → fill → graduate on a stack the test itself builds.
///         This proves it on the bytecode that is actually at these addresses, with the real
///         PoolManager, PositionManager and Permit2, one block after deployment. A MON market's
///         target is 305,868 MON, so the fill is done here rather than on mainnet; the launch half
///         is repeated on mainnet by hand.
contract Gen5LiveCanaryForkTest is Test {
    DokuFactory internal constant FACTORY = DokuFactory(0x094da64277FbeD1e9f762694ABb7e34390ad8d78);
    DokuGraduation internal constant GRADUATION = DokuGraduation(payable(0x5F2328985a06E37E5363c9A64187461da66BA5d3));
    address internal constant CREATOR = address(0xCA11);
    address internal constant BUYER = address(0xB0B1);

    function setUp() public {
        vm.createSelectFork(vm.envString("MONAD_RPC_URL"));
        vm.deal(CREATOR, 100 ether);
        vm.deal(BUYER, 2_000_000 ether);
    }

    function test_theDeployedGeneration5GraduatesAMonMarketEndToEnd() public {
        assertTrue(FACTORY.activated(), "the live factory is not activated");
        assertFalse(FACTORY.paused(), "the live factory is paused");
        FACTORY.validateDeployment();

        DokuFactory.LaunchParams memory p;
        p.meta.name = "Gen4 Canary";
        p.meta.ticker = "CANARY";
        p.quoteAsset = address(0);
        p.sink = Sinks.REWARDS;
        p.creatorTaxBps = 100;
        p.economicsPin = FACTORY.economicsPin(address(0), Sinks.REWARDS, 100);
        p.deadline = vm.getBlockTimestamp() + 1 hours;
        p.firstBuyQuote = 1 ether;

        uint256 fee = FACTORY.launchFee(CREATOR);
        vm.prank(CREATOR);
        (address curveAddr,) = FACTORY.launch{value: fee + 1 ether}(p);
        BondingCurve c = BondingCurve(payable(curveAddr));
        assertEq(c.graduator(), address(GRADUATION), "the curve pinned the wrong graduator");
        assertGt(BondingCurve(payable(curveAddr)).token().balanceOf(CREATOR), 0, "the first buy delivered nothing");

        // Past the anti-sniper window, then one buy that overshoots the target: the curve clamps,
        // refunds the excess, latches, and graduates inside this same transaction.
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        // Hoisted, all of it. `c.buy{value: 2 * c.quoteTarget()}(0, vm.getBlockTimestamp() + 1 hours)`
        // evaluates the inner calls FIRST and `c.quoteTarget()` consumes the prank — so the buy went
        // out from this test contract, which has no `receive()`, and the refund's `TransferFailed`
        // looked like a graduation failure on the live contracts. It was not: the trace shows
        // `graduate()` returning `(poolId, 627623)` before the refund even started.
        uint256 target = c.quoteTarget();
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        c.buy{value: 2 * target}(0, deadline);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(GRADUATION.graduated(curveAddr), "the fill did not graduate");
        assertTrue(PoolId.unwrap(GRADUATION.poolIdOf(curveAddr)) != bytes32(0), "no pool id recorded");
        assertTrue(GRADUATION.sinkOf(curveAddr) != address(0), "no RewardVault deployed");
        assertEq(c.quoteRaised(), 0, "release did not move the raise");
        // The buyer pays the curve amount that fills the target PLUS the 1% fee and the 1% creator
        // tax on the gross — about 2.04% over — and gets the rest of the 2x overshoot back. Bounded
        // rather than exact, because the first buy already covered a slice of the target.
        uint256 paid = before - BUYER.balance;
        assertGt(paid, target, "the buyer paid less than the target");
        assertLt(paid, (target * 103) / 100, "the buyer paid more than target + fee + tax: no refund");
    }
}
