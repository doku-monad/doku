// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract SweepToken is ERC20 {
    constructor() ERC20("Sweep", "SWP") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice A sink that refuses everything, used to prove it can brick nothing.
contract HostileSink {
    fallback() external payable {
        revert("no");
    }
}

/// @notice The sweep, the two pull paths, and the cross-market ledger invariant.
contract HookSweepTest is Test {
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;

    address internal graduator = address(0x6AD);
    HostileSink internal hostile;

    SweepToken internal tokA;
    SweepToken internal tokB;
    SweepToken internal tokC;
    PoolKey internal keyA; // REWARDS, hostile sink
    PoolKey internal keyB; // BURN
    PoolKey internal keyC; // REWARDS, a sink that behaves
    PoolId internal idA;
    PoolId internal idB;
    PoolId internal idC;

    /// @dev The sink of the REWARDS market in this file.
    /// @dev The note that used to live here said a BURN market's sink is funded by
    ///      `SeedLocker.collect` and not by the hook, because the swap's token leg was donated
    ///      whole to the pool's LPs. Round 4 removed the donate, so `keyB`'s sink IS funded by the
    ///      hook now — 70 bps of every token leg, straight into `pendingSink`. `keyC` stays: a
    ///      REWARDS market with a benign sink, credited the way the locker credits one in
    ///      production, is still the only place `creditCurveTax` -> `sweep` -> `pullSink` is driven
    ///      end to end on a QUOTE-paying market. `keyB` stays BURN because three tests here depend
    ///      on it being one.
    address internal benignSink = address(0x51);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        hostile = new HostileSink();

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        vm.deal(address(this), 200_000 ether);
        tokA = new SweepToken();
        tokB = new SweepToken();
        keyA = _open(tokA, hook.SINK_REWARDS(), address(hostile));
        keyB = _open(tokB, hook.SINK_BURN(), benignSink);
        tokC = new SweepToken();
        keyC = _open(tokC, hook.SINK_REWARDS(), benignSink);
        idA = PoolIdLibrary.toId(keyA);
        idB = PoolIdLibrary.toId(keyB);
        idC = PoolIdLibrary.toId(keyC);
    }

    function _open(SweepToken t, uint8 sink, address sinkAddr) internal returns (PoolKey memory k) {
        k = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, address(t), sink, sinkAddr, 0);
        vm.stopPrank();

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: 5_000 ether}(
            k, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}), ""
        );
    }

    function _buy(PoolKey memory k, uint256 monIn) internal {
        swapper.swap{value: monIn}(
            k,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(monIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ------------------------------------------------------------------------- cannot be bricked

    /// @dev The stronger of the two. A sink that reverts on everything must not be able to stop
    ///      trading — which is why the callbacks only ever `mint` and push to nobody.
    function test_aRevertingSinkCannotBrickASwap() public {
        _buy(keyA, 10 ether);
        _buy(keyA, 10 ether);
        _buy(keyA, 10 ether);
        // The swaps above already accrue the sink's share since round 4; this adds the OTHER
        // funding route — the same call `SeedLocker.collect` makes in production — so the test
        // covers a ledger filled from both, which is the state a real market is in.
        hook.creditCurveTax{value: 1 ether}(idA);
        assertGt(hook.pendingSink(idA) + hook.owedSink(idA), 0, "hostile-sink market accrued nothing");
    }

    function test_aRevertingSinkCannotBrickTheSweep() public {
        _buy(keyA, 10 ether);
        hook.creditCurveTax{value: 1 ether}(idA);
        hook.sweep(idA); // must not revert even though the sink reverts on everything
        assertGt(hook.owedSink(idA), 0, "sweep materialised nothing");
    }

    /// @dev And the pull is the sink's own problem: it reverts for the sink alone and leaves the
    ///      treasury's money reachable.
    function test_aRevertingSinkOnlyHurtsItself() public {
        _buy(keyA, 10 ether);
        hook.creditCurveTax{value: 1 ether}(idA);
        hook.sweep(idA);
        vm.prank(address(hostile));
        vm.expectRevert();
        hook.pullSink(idA);

        uint256 before = TREASURY.balance;
        hook.pullTreasury(Currency.wrap(address(0)));
        assertGt(TREASURY.balance, before, "treasury could not be paid");
    }

    // ----------------------------------------------------------------------------- the ledger

    /// @dev The blocker the plan flags: a REWARDS market levies BOTH buckets in MON, so a ledger
    ///      keyed only by (poolId, currency) would let whichever pull ran first drain the other.
    ///      Here they are separate mappings by construction, and the order must not matter.
    function test_aRewardsMarketsProtocolAndSinkMonDoNotShareABucket() public {
        uint256 prot0 = hook.pendingProtocol(idA);
        uint256 sink0 = hook.pendingSink(idA);
        _buy(keyA, 100 ether);
        uint256 protFromSwap = hook.pendingProtocol(idA) - prot0;
        uint256 sinkFromSwap = hook.pendingSink(idA) - sink0;

        // 30 / 70 OF THE SAME MON LEVY, AND NOW BOTH SIDES COME FROM THE SWAP ITSELF. This used to
        // read `hook.creditCurveTax{value: (prot * 70) / 30}(idA)` followed by an
        // `assertApproxEqRel` — the sink's half had to be simulated with the locker's own credit
        // call, because `_settleLeg` donated the swap's sink share to the pool instead of accruing
        // it, and the tolerance existed only because the simulated number was reconstructed by
        // division. Round 4 made the split real, so the relation is an EQUALITY on two numbers the
        // same swap produced.
        assertGt(protFromSwap, 0, "the treasury accrued nothing");
        assertEq(sinkFromSwap * 30, protFromSwap * 70, "the swap's split is not 70/30");

        // The credit route stays in the test, on top, because the property under test is that the
        // two buckets never mix however each is filled — and `creditCurveTax` is the one entry
        // point that adds to the sink's side without touching the treasury's.
        hook.creditCurveTax{value: 5 ether}(idA);
        uint256 credited = hook.owedSink(idA);
        assertEq(credited, 5 ether, "the curve-tax credit did not land whole");

        hook.sweep(idA);
        assertEq(hook.owedSink(idA), credited + sinkFromSwap, "the sink did not get exactly its own two sources");
        assertEq(
            hook.owedTreasury(Currency.wrap(address(0))),
            prot0 + protFromSwap,
            "the treasury got something other than its own accrual"
        );
    }

    /// @dev All markets share one hook and one native balance. Per-market conservation is the
    ///      invariant that keeps market A's MON out of market B's ledger.
    function test_marketACannotDrainMarketBsNativeLedger() public {
        _buy(keyA, 50 ether);
        _buy(keyB, 50 ether);
        uint256 sinkA = hook.pendingSink(idA);

        hook.sweep(idB); // sweeping B must not touch A
        assertEq(hook.pendingSink(idA), sinkA, "sweeping B moved A's accrual");

        hook.sweep(idA);
        assertEq(hook.owedSink(idA), sinkA, "A's swept balance is wrong");
    }

    // -------------------------------------------------------------------------------- access

    function test_sweepIsPermissionless() public {
        _buy(keyC, 10 ether);
        hook.creditCurveTax{value: 1 ether}(idC);
        vm.prank(address(0xDEADBEEF));
        hook.sweep(idC);
        assertGt(hook.owedSink(idC), 0);
    }

    function test_onlyTheSnapshottedSinkCanPull() public {
        _buy(keyC, 10 ether);
        hook.creditCurveTax{value: 1 ether}(idC);
        hook.sweep(idC);
        vm.prank(address(0xBAD));
        vm.expectRevert(DokuHook.NotSink.selector);
        hook.pullSink(idC);

        vm.prank(benignSink);
        uint256 got = hook.pullSink(idC);
        assertGt(got, 0, "the real sink got nothing");
    }

    /// @dev A callback that arrives without us having asked for it is rejected even when it comes
    ///      from the genuine PoolManager, so the hook does not depend on an external contract's
    ///      calling convention.
    function test_unlockCallbackRejectsAnUnexpectedUnlock() public {
        vm.prank(address(manager));
        vm.expectRevert(DokuHook.UnexpectedUnlock.selector);
        hook.unlockCallback(abi.encode(idB, uint256(1), uint256(1)));
    }

    function test_unlockCallbackRejectsAStranger() public {
        vm.expectRevert();
        hook.unlockCallback(abi.encode(idB, uint256(1), uint256(1)));
    }

    /// @dev Note the first sweep succeeds: `setUp`'s liquidity add already paid the MAKER levy, so
    ///      a freshly opened market has an accrual before its first swap. Drain it, then assert.
    function test_sweepWithNothingAccruedReverts() public {
        hook.sweep(idB);
        vm.expectRevert(DokuHook.NothingToSweep.selector);
        hook.sweep(idB);
    }

    /// @dev A BURN market's sink takes the token, so crediting it MON would strand the money or
    ///      force the swap this design exists to avoid.
    function test_creditCurveTaxRefusesAMarketWhoseSinkDoesNotTakeMon() public {
        vm.expectRevert(DokuHook.WrongSinkCurrency.selector);
        hook.creditCurveTax{value: 1 ether}(idB);

        hook.creditCurveTax{value: 1 ether}(idA);
        assertEq(hook.owedSink(idA), 1 ether, "curve tax was not credited");
    }

    /// @dev This is where the money is, so the absence assertion is restated here.
    function test_thereIsNoOwnerOnlyPathToMoney() public view {
        string[6] memory forbidden = [
            "rescue(address,address,uint256)",
            "rescueToken(address,address,uint256)",
            "setTreasury(address)",
            "setSink(bytes32,address)",
            "sweepTo(bytes32,address)",
            "withdraw(address,uint256)"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            (bool ok,) = address(hook).staticcall(abi.encodePacked(bytes4(keccak256(bytes(forbidden[i])))));
            assertFalse(ok, forbidden[i]);
        }
    }
}
