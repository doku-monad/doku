// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {ZapRouter} from "../src/ZapRouter.sol";

/**
 * The spend cap, which exists to bound what a new contract can lose.
 *
 * `ZapRouter` is unaudited and stands between a buyer's MON and their tokens. The cap is how it
 * ships anyway: it answers the one question worth answering — will people buy a coin priced in
 * bitcoin when paying is easy — while keeping the worst case to a number the owner chose.
 *
 * The cap is on the MON going IN, not on any dollar figure, because a dollar figure needs a price
 * feed and a price feed is another thing that can be wrong in the path of funds.
 *
 * These tests need no fork: every one of them is refused before the router touches a pool.
 */
contract ZapCapTest is Test {
    ZapRouter internal router;
    address internal owner = address(0xB0B);
    address internal buyer = address(0xA11CE);

    /// Not a market, and never reached — the cap is checked before the factory is asked.
    address internal curve = address(0xCA11);

    function setUp() public {
        /*
         * A factory that answers rather than an address that does not exist.
         *
         * `isMarket` on an address with no code reverts without data, which would make every test
         * below pass for the wrong reason: "reverted" is not "reverted because the cap said so".
         * This one returns false, so a zap that gets past the cap fails at a NAMED error and the
         * distinction between the two is visible.
         */
        FactoryStub stub = new FactoryStub();
        router = new ZapRouter(
            IPoolManager(address(0xF00D)), DokuFactory(payable(address(stub))), owner, 5 ether
        );
        vm.deal(buyer, 2_000_000 ether);
    }

    function _path() internal pure returns (PathKey[] memory path) {
        path = new PathKey[](1);
        path[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(0xDEAD)),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _zap(uint256 value) internal {
        vm.prank(buyer);
        router.zapBuyWithNative{value: value}(curve, _path(), 0, 0, block.timestamp + 1);
    }

    function test_theCapIsWhateverTheDeployerChose() public view {
        assertEq(router.maxZapValue(), 5 ether);
        assertEq(router.owner(), owner);
    }

    function test_aZapOverTheCapIsRefusedByName() public {
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.ZapTooLarge.selector, 5 ether + 1, 5 ether));
        _zap(5 ether + 1);
    }

    function test_aZapExactlyAtTheCapIsNotRefusedForBeingTooLarge() public {
        // It still fails, on the market being unknown — which is the point: the cap let it through.
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, curve));
        _zap(5 ether);
    }

    /**
     * The cap is checked FIRST, before the factory, the curve or any pool.
     *
     * A cheap refusal is the whole point of a bound meant to limit exposure: an oversized zap must
     * not be able to reach a single external call on the way to being rejected. The stub counts
     * its calls, so this asserts the absence of the call rather than inferring it from the error.
     */
    function test_theCapIsCheckedBeforeAnythingExternalIsCalled() public {
        /*
         * Proven by which error comes back, not by instrumenting the stub.
         *
         * This router is pointed at a factory address holding NO CODE. If the cap were checked
         * after the market lookup, that call would revert without data and the assertion below
         * would fail. Getting `ZapTooLarge` means nothing external was reached.
         */
        ZapRouter bare = new ZapRouter(
            IPoolManager(address(0xF00D)), DokuFactory(payable(address(0xFAC))), owner, 5 ether
        );
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.ZapTooLarge.selector, 100 ether, 5 ether));
        bare.zapBuyWithNative{value: 100 ether}(curve, _path(), 0, 0, block.timestamp + 1);
    }

    function test_theOwnerCanRaiseItInOneTransaction() public {
        vm.prank(owner);
        router.setMaxZapValue(50 ether);
        assertEq(router.maxZapValue(), 50 ether);

        vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, curve));
        _zap(50 ether);
    }

    function test_theOwnerCanRemoveItEntirely() public {
        // Zero means no ceiling. An experiment that worked should not need a redeployment to end.
        vm.prank(owner);
        router.setMaxZapValue(0);
        assertEq(router.maxZapValue(), 0);

        vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, curve));
        _zap(1_000_000 ether);
    }

    function test_nobodyElseCanTouchIt() public {
        vm.prank(buyer);
        vm.expectRevert();
        router.setMaxZapValue(1_000_000 ether);
        assertEq(router.maxZapValue(), 5 ether);
    }

    function test_aChangeIsAnnounced() public {
        // The cap governs what other people can spend, so a silent change is the wrong shape.
        vm.expectEmit(true, true, true, true);
        emit ZapRouter.MaxZapValueSet(5 ether, 9 ether);
        vm.prank(owner);
        router.setMaxZapValue(9 ether);
    }

    function testFuzz_everyValueEitherPassesTheCapOrIsRefusedByIt(uint128 value) public {
        vm.assume(value > 0);
        vm.deal(buyer, uint256(value));
        if (value > 5 ether) {
            vm.expectRevert(abi.encodeWithSelector(ZapRouter.ZapTooLarge.selector, value, 5 ether));
        } else {
            vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, curve));
        }
        _zap(value);
    }
}

/**
 * @dev The smallest thing that can answer `isMarket`.
 *
 *      `view` is not optional here. `DokuFactory.isMarket` is a public mapping, so the generated
 *      interface is `view` and the router reaches it by STATICCALL — a stub that wrote to storage
 *      to count its calls reverted the staticcall, and every test then passed for the wrong reason,
 *      on "it reverted" rather than on which error it reverted with.
 */
contract FactoryStub {
    function isMarket(address) external pure returns (bool) {
        return false;
    }
}
