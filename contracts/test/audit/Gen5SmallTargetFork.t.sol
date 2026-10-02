// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {Sinks} from "../../src/lib/Sinks.sol";

/**
 * @notice The "manual test mode" the operator asked for on 2026-09-12: launch fee 1 MON, MON
 *         quote target 10 MON — set on the DEPLOYED generation-5 registry and factory by their
 *         owner, then a market launched, filled and graduated under those numbers on a mainnet
 *         fork. Proves the two owner calls are enough and that a 10 MON raise survives every
 *         rounding path (seed liquidity, hook levy, reward-vault floor of target / 10,000) before
 *         the same two calls are sent for real.
 */
contract Gen5SmallTargetForkTest is Test {
    DokuFactory internal constant FACTORY = DokuFactory(0x094da64277FbeD1e9f762694ABb7e34390ad8d78);
    DokuGraduation internal constant GRADUATION = DokuGraduation(payable(0x5F2328985a06E37E5363c9A64187461da66BA5d3));
    QuoteRegistry internal constant REGISTRY = QuoteRegistry(0x623cAEa453609A1bbA7b0E0B133dEe894a5E5C9B);
    address internal constant OWNER = 0x176F7D61FAf64031C6917bd1091e69eEcC93316a;
    address internal constant CREATOR = address(0xCA11);
    address internal constant BUYER = address(0xB0B1);

    function setUp() public {
        vm.createSelectFork(vm.envString("MONAD_RPC_URL"));
        vm.deal(CREATOR, 100 ether);
        vm.deal(BUYER, 100 ether);
    }

    function test_oneMonFeeAndATenMonTargetGraduateOnTheLiveStack() public {
        // The two owner calls, exactly as they will be sent.
        vm.startPrank(OWNER);
        FACTORY.setLaunchFee(1 ether);
        REGISTRY.setQuoteTarget(address(0), 10 ether);
        vm.stopPrank();
        assertEq(FACTORY.launchFee(CREATOR), 1 ether, "launch fee did not take");
        assertEq(REGISTRY.quoteTarget(address(0)), 10 ether, "MON target did not take");

        DokuFactory.LaunchParams memory p;
        p.meta.name = "Ten MON test";
        p.meta.ticker = "TEN";
        p.quoteAsset = address(0);
        p.sink = Sinks.REWARDS;
        p.creatorTaxBps = 100;
        p.economicsPin = FACTORY.economicsPin(address(0), Sinks.REWARDS, 100);
        p.deadline = vm.getBlockTimestamp() + 1 hours;
        p.firstBuyQuote = 0.5 ether;
        uint256 fee = FACTORY.launchFee(CREATOR);
        uint256 creatorBefore = CREATOR.balance;
        vm.prank(CREATOR);
        (address curveAddr,) = FACTORY.launch{value: fee + 0.5 ether}(p);
        assertEq(creatorBefore - CREATOR.balance, 1.5 ether, "creator paid something other than 1 MON fee + 0.5 MON buy");

        BondingCurve c = BondingCurve(payable(curveAddr));
        assertEq(c.quoteTarget(), 10 ether, "the curve did not snapshot the 10 MON target");
        assertGt(c.token().balanceOf(CREATOR), 0, "the first buy delivered nothing");

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        uint256 before = BUYER.balance;
        vm.prank(BUYER);
        c.buy{value: 20 ether}(0, deadline);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertTrue(GRADUATION.graduated(curveAddr), "the fill did not graduate");
        assertTrue(PoolId.unwrap(GRADUATION.poolIdOf(curveAddr)) != bytes32(0), "no pool id recorded");
        address vault = GRADUATION.sinkOf(curveAddr);
        assertTrue(vault != address(0), "no RewardVault deployed");
        assertGt(RewardVault(payable(vault)).minEpochAmount(), 0, "vault floor collapsed to zero");
        assertEq(c.quoteRaised(), 0, "release did not move the raise");
        uint256 paid = before - BUYER.balance;
        assertGt(paid, 9 ether, "the buyer paid far less than the remaining target");
        assertLt(paid, 10.5 ether, "the buyer paid more than target + fee + tax: no refund");
    }
}
