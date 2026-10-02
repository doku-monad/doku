// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {Sinks} from "../../src/lib/Sinks.sol";

import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @dev Reverts on every call. The plainest failure a graduator can have.
contract RevertingGraduator {
    function graduate(address) external pure returns (address, uint256) {
        revert("no");
    }
}

/// @dev Returns megabytes. Under a `try`/`catch` the buyer pays for copying it; the raw call in
///      `_tryAutoGraduate` copies zero bytes, so it costs them nothing.
contract ReturndataBomb {
    function graduate(address) external pure returns (bytes memory) {
        return new bytes(400_000);
    }
}

/// @dev Consumes everything it is given, then reverts. EIP-150 hands it 63/64 of the gas.
contract GasBurner {
    function graduate(address) external view returns (address, uint256) {
        uint256 x;
        while (gasleft() > 5_000) x = uint256(keccak256(abi.encode(x)));
        revert("burned");
    }
}

/// @dev Burns gas in `receive`. The refund is the only value the curve pushes to a buyer, and this
///      is what a hostile one would do with it.
contract GreedyBuyer {
    uint256 public sink;

    function fill(BondingCurve c, uint256 value, uint256 gasLimit) external {
        c.buy{value: value, gas: gasLimit}(0, block.timestamp + 1 hours);
    }

    receive() external payable {
        while (gasleft() > 20_000) sink = uint256(keccak256(abi.encode(sink)));
    }
}

/**
 * D3's blast radius, bounded.
 *
 * The trade that fills a curve also graduates it, which means an ordinary buyer is made responsible
 * for a multi-contract operation they did not ask to perform. `_tryAutoGraduate` swallows every
 * failure for exactly that reason: the last slice of every curve would otherwise be unbuyable
 * whenever anything downstream was wrong.
 *
 * Swallowing is only safe if two things hold, and neither is obvious from reading the call:
 *
 *   1. **Nothing a hostile or broken graduator does can reach the buyer.** Not a revert, not a
 *      returndata bomb, not burning every drop of gas it is handed.
 *   2. **A swallowed failure leaves the market graduatable.** `readyToGraduate` latched, both legs
 *      shut, nothing half-written — so anyone can retry, because `graduate` stays permissionless.
 *
 * The `try`/`catch` this replaced satisfied neither. It decodes return values on the SUCCESS path,
 * outside the catch, so a graduator with no code — or, as a real test found, a low address that
 * lands on a precompile — returned empty data and the decode reverted into the buyer's transaction.
 */
contract AutoGraduationTest is PosmTestSetup {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    address internal constant ALICE = address(0xA11CE);
    address internal constant STRANGER = address(0x5747A6E);
    uint256 internal constant TARGET = 1_000e18;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        graduation =
            new DokuGraduation(address(manager), address(lpm), address(permit2), address(dokuHook), address(new MarketsStub()));
        dokuHook.setGraduator(address(graduation), true);

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        vm.deal(ALICE, 1_000_000e18);
    }

    /// @dev `graduator` is pinned at `initialize` and has no setter, so a market's graduator is
    ///      chosen here once and for all — which is why a hostile one is worth testing rather than
    ///      assuming away.
    function _market(address graduator) internal returns (BondingCurve c, DokuToken t) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), TARGET, Sinks.BURN, address(0), 0, address(0), TREASURY, graduator, address(0));
    }

    function _fillFrom(BondingCurve c, address who) internal {
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.prank(who);
        c.buy{value: 5_000e18}(0, block.timestamp);
    }

    /// @dev What a swallowed failure must leave behind: filled, latched, both legs shut, and no
    ///      pool. Asserted in one place so every hostile-graduator case checks the same thing.
    function _assertClosedButUngraduated(BondingCurve c, DokuToken t) internal {
        assertTrue(c.readyToGraduate(), "the curve did not latch");
        assertEq(c.quoteRaised(), TARGET, "the raise is not exactly the target");
        assertGt(c.seedBase(), 0, "the seed was never latched");
        assertFalse(c.released(), "the curve released without a graduation");

        vm.expectRevert(BondingCurve.CurveClosed.selector);
        vm.prank(ALICE);
        c.buy{value: 1e18}(0, block.timestamp);

        vm.expectRevert(BondingCurve.CurveClosed.selector);
        vm.prank(ALICE);
        c.sell(1e18, 0, block.timestamp);
        t;
    }

    // ------------------------------------------------------- nothing reaches the buyer

    function test_aFailingGraduationNeverRevertsTheFillingBuy() public {
        (BondingCurve c, DokuToken t) = _market(address(new RevertingGraduator()));
        _fillFrom(c, ALICE);
        assertGt(t.balanceOf(ALICE), 0, "the filling buyer got no tokens");
        _assertClosedButUngraduated(c, t);
    }

    /// @dev A raw `call` to an address with NO CODE succeeds. So a codeless graduator is not
    ///      reported as a failure and no `AutoGraduationFailed` event fires — the market simply
    ///      does not graduate. That is the honest outcome and it is asserted rather than glossed:
    ///      the curve is left intact and retryable, and nothing about the buy is affected.
    function test_aCodelessOrSilentGraduatorIsNotMistakenForSuccess() public {
        (BondingCurve c, DokuToken t) = _market(address(0xDEAD01));
        _fillFrom(c, ALICE);
        assertGt(t.balanceOf(ALICE), 0, "the filling buyer got no tokens");
        _assertClosedButUngraduated(c, t);

        // The precompile case, which is the one that actually bit: a low address returns empty
        // data, and the `try`/`catch` this replaced decoded that OUTSIDE the catch.
        (BondingCurve c2, DokuToken t2) = _market(address(0x1)); // ecrecover
        _fillFrom(c2, ALICE);
        assertGt(t2.balanceOf(ALICE), 0, "the precompile graduator reverted the buy");
        _assertClosedButUngraduated(c2, t2);
    }

    function test_aReturndataBombCannotRevertTheFillingBuy() public {
        (BondingCurve c, DokuToken t) = _market(address(new ReturndataBomb()));
        _fillFrom(c, ALICE);
        assertGt(t.balanceOf(ALICE), 0, "a returndata bomb reached the buyer");
        _assertClosedButUngraduated(c, t);
    }

    /// @dev EIP-150 hands the inner call 63/64 of the gas, so a graduator that burns all of it
    ///      leaves the outer frame with 1/64 — which must still be enough to finish the buy. The
    ///      buy is sent a generous limit precisely so there is a real 1/64 to survive on.
    function test_aGasBurningGraduatorCannotStarveTheRestOfTheBuy() public {
        (BondingCurve c, DokuToken t) = _market(address(new GasBurner()));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.prank(ALICE);
        c.buy{value: 5_000e18, gas: 30_000_000}(0, block.timestamp);
        assertGt(t.balanceOf(ALICE), 0, "a gas-burning graduator starved the buy");
        _assertClosedButUngraduated(c, t);
    }

    /**
     * A hostile buyer cannot starve the graduation tail, because there is no tail after it.
     *
     * The refund is the only value `buy` pushes, and it is sent AFTER `_tryAutoGraduate` — so a
     * buyer whose `receive` burns every drop of gas is burning it on the way out, with graduation
     * already done. Ordering, not a gas stipend, is what makes this safe, and reordering those two
     * lines would silently reintroduce it.
     */
    function test_aGasBurningRefundRecipientCannotStarveTheGraduation() public {
        (BondingCurve c,) = _market(address(graduation));
        GreedyBuyer greedy = new GreedyBuyer();
        vm.deal(address(greedy), 6_000e18);

        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        // Deliberately far past the target, so there is a large refund for `receive` to chew on.
        // Bounded, or `receive` chews through a billion gas and the suite crawls. The bound is
        // generous enough that graduation runs in full and the refund still has plenty to burn.
        greedy.fill(c, 5_000e18, 20_000_000);

        assertTrue(graduation.graduated(address(c)), "the greedy refund starved the graduation");
    }

    // ---------------------------------------------------- a failure stays retryable

    /**
     * Starve the auto-graduation, then let anyone finish it.
     *
     * This is the case the `AutoGraduationFailed(gasleft())` event exists to distinguish: the
     * graduator is perfectly good and simply was not given room to run. The curve must be left
     * exactly as the buy found it — latched, closed, nothing half-written — and a later call must
     * succeed with no special privilege and no repair step.
     */
    function test_anyoneCanGraduateAfterAStarvedAttempt() public {
        (BondingCurve c, DokuToken t) = _market(address(graduation));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);

        // Enough to finish the buy, far short of `AUTO_GRADUATION_GAS`.
        vm.prank(ALICE);
        c.buy{value: 5_000e18, gas: 900_000}(0, block.timestamp);

        assertFalse(graduation.graduated(address(c)), "the starved attempt somehow graduated");
        _assertClosedButUngraduated(c, t);

        // No privilege, no repair, no argument the buyer had to supply.
        vm.prank(STRANGER);
        graduation.graduate(address(c));

        assertTrue(graduation.graduated(address(c)), "a stranger could not finish the graduation");
        PoolId id = PoolIdLibrary.toId(
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(t)),
                fee: 0,
                tickSpacing: 60,
                hooks: IHooks(address(dokuHook))
            })
        );
        (uint160 sqrtPriceX96,,,) = manager.getSlot0(id);
        assertGt(sqrtPriceX96, 0, "the retried graduation produced no pool");
        assertGt(manager.getLiquidity(id), 0, "the retried graduation seeded nothing");
    }

    /// @dev And the gas hint is what a wallet needs to avoid the starved case in the first place.
    ///      `eth_estimateGas` cannot find it on its own: graduation runs inside a swallowed call,
    ///      so the transaction succeeds at every limit above the buy body's own cost.
    function test_theGasHintIsEnoughToActuallyGraduate() public {
        (BondingCurve c,) = _market(address(graduation));
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.prank(ALICE);
        c.buy{value: 5_000e18, gas: c.autoGraduationGasHint()}(0, block.timestamp);
        assertTrue(graduation.graduated(address(c)), "the published gas hint was not enough");
    }

    /// @dev The tail is idempotent by the only thing that matters: `graduate` refuses a second run,
    ///      and the refusal is swallowed like any other failure. A market cannot be graduated twice
    ///      even if something contrives to call the filling path again.
    function test_theTailCannotGraduateAnAlreadyGraduatedMarket() public {
        (BondingCurve c,) = _market(address(graduation));
        _fillFrom(c, ALICE);
        assertTrue(graduation.graduated(address(c)), "the fill did not graduate");

        vm.expectRevert(DokuGraduation.AlreadyGraduated.selector);
        vm.prank(STRANGER);
        graduation.graduate(address(c));
    }
}
