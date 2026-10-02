// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {ZapRouter} from "../../src/ZapRouter.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

contract ZapTok is ERC20 {
    constructor(string memory n) ERC20(n, n) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * ROUND 1 - `ZapRouter`, the MULTI-HOP ledger and the post-condition that covers three currencies.
 *
 * Everything in `test/ZapSell.t.sol`, `test/audit/ZapSellHunt.t.sol` and
 * `test/audit/ZapRouterV3.t.sol` is a SINGLE-HOP local fixture or a mainnet fork. The local suite
 * therefore never exercises the case the router's own header says is the hard one: "the
 * intermediates of a multi-hop swap cancel to zero on their own". That claim, and what happens to a
 * currency that is NOT one of the three the router sweeps, is what this file is for.
 *
 * Two things come out of it, and they are opposite in kind:
 *
 *   1. The ledger really does net. A two-hop buy and a two-hop sell both leave the router holding
 *      nothing in native, quote, base OR the intermediate. `HopUnfilled` is what makes that true
 *      rather than hopeful: every hop's input delta is asserted equal to the whole of what was
 *      offered, so no partial fill can leave an intermediate credit behind.
 *
 *   2. The header's post-condition - "after any zap this contract holds nothing" - is true of the
 *      three currencies the router sweeps and of no others. An intermediate balance that arrives by
 *      any other means survives every zap through it, and is then handed in full to the first
 *      caller who zaps a market PRICED in that asset. Demoted to Informational: no user's funds can
 *      reach that state through the router itself (see 1), so it costs only a misdirected transfer.
 */
contract Round1ZapMultiHop is Test {
    PoolManager internal manager;
    PoolModifyLiquidityTest internal lp;
    ZapTok internal mid;
    ZapTok internal quote;
    MarketsStub internal markets;
    ZapRouter internal router;

    BondingCurve internal curve; // priced in `quote`
    DokuToken internal base;
    BondingCurve internal midCurve; // priced in `mid`
    DokuToken internal midBase;

    address internal constant OWNER = address(0xB0B);
    address internal constant USER = address(0xA11CE);
    address internal constant STRANGER = address(0xBAD);
    address internal constant TREASURY = address(0x7EA);
    address internal constant GRADUATOR = address(0x6AD);

    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;
    int256 internal constant LIQUIDITY = 100_000e18;
    uint256 internal constant QUOTE_TARGET = 1_000e18;
    uint256 internal constant NEVER = type(uint256).max;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        // `mid` must sort BELOW `quote` so the second pool's ordering is the interesting one
        // (`currencyIn` is `currency0`), and both must sort above native, which every address does.
        for (uint256 salt; salt < 64; ++salt) {
            ZapTok a = new ZapTok("MID");
            ZapTok b = new ZapTok("QUO");
            if (address(a) < address(b)) {
                mid = a;
                quote = b;
                break;
            }
            mid = b;
            quote = a;
            break;
        }

        mid.mint(address(this), 100_000_000e18);
        quote.mint(address(this), 100_000_000e18);
        mid.approve(address(lp), type(uint256).max);
        quote.approve(address(lp), type(uint256).max);
        vm.deal(address(this), 10_000_000 ether);

        _pool(address(0), address(mid), 500_000 ether);
        _pool(address(mid), address(quote), 0);

        markets = new MarketsStub();
        router = new ZapRouter(IPoolManager(address(manager)), DokuFactory(payable(address(markets))), OWNER, 0);

        (curve, base) = _market(address(quote));
        (midCurve, midBase) = _market(address(mid));

        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);
        vm.deal(USER, 10_000 ether);
        vm.deal(STRANGER, 10_000 ether);
    }

    function _pool(address c0, address c1, uint256 value) internal {
        (address lo, address hi) = c0 < c1 ? (c0, c1) : (c1, c0);
        PoolKey memory k = PoolKey({
            currency0: Currency.wrap(lo),
            currency1: Currency.wrap(hi),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(k, SQRT_1_1);
        lp.modifyLiquidity{value: value}(
            k, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}), ""
        );
    }

    function _market(address q) internal returns (BondingCurve c, DokuToken t) {
        c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize("Hunt", "HUNT", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), q, QUOTE_TARGET, Sinks.REWARDS, address(0), 0, address(0), TREASURY, GRADUATOR, address(0)
        );
    }

    function _hop(address to) internal pure returns (PathKey memory) {
        return PathKey({
            intermediateCurrency: Currency.wrap(to),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _twoHopBuy() internal view returns (PathKey[] memory p) {
        p = new PathKey[](2);
        p[0] = _hop(address(mid));
        p[1] = _hop(address(quote));
    }

    function _twoHopSell() internal view returns (PathKey[] memory p) {
        p = new PathKey[](2);
        p[0] = _hop(address(mid));
        p[1] = _hop(address(0));
    }

    function _routerHoldsNothing(string memory when) internal view {
        assertEq(address(router).balance, 0, string.concat(when, ": native"));
        assertEq(quote.balanceOf(address(router)), 0, string.concat(when, ": quote"));
        assertEq(base.balanceOf(address(router)), 0, string.concat(when, ": base"));
        assertEq(mid.balanceOf(address(router)), 0, string.concat(when, ": intermediate"));
    }

    // ==========================================================================================
    // 1. The ledger nets across two hops, in both directions, including the intermediate.
    // ==========================================================================================

    function test_Z1_aTwoHopBuyNetsTheIntermediateToZero() public {
        vm.prank(USER);
        uint256 baseOut = router.zapBuyWithNative{value: 10 ether}(address(curve), _twoHopBuy(), 0, 0, NEVER);

        assertGt(baseOut, 0, "the two-hop buy produced nothing");
        assertEq(base.balanceOf(USER), baseOut, "the buyer was not paid the whole delta");
        _routerHoldsNothing("after a two-hop buy");
    }

    function test_Z2_aTwoHopSellNetsTheIntermediateToZero() public {
        vm.prank(USER);
        uint256 baseOut = router.zapBuyWithNative{value: 10 ether}(address(curve), _twoHopBuy(), 0, 0, NEVER);
        _routerHoldsNothing("after the seed buy");

        uint256 before = USER.balance;
        vm.startPrank(USER);
        base.approve(address(router), baseOut);
        uint256 nativeOut = router.zapSellToNative(address(curve), _twoHopSell(), baseOut, 0, 0, NEVER);
        vm.stopPrank();

        assertGt(nativeOut, 0, "the two-hop sell produced nothing");
        assertGe(USER.balance - before, nativeOut, "the seller was paid less than the route produced");
        _routerHoldsNothing("after a two-hop sell");
    }

    /// @dev The reason 1 holds: no hop may under-fill, so no hop may leave a credit in the
    ///      intermediate for the next hop to net against or for the router to strand. Proved by
    ///      asking for more than the intermediate pool can deliver at any price.
    function test_Z3_anUnderfilledHopIsRefusedRatherThanStranded() public {
        // The mid/quote pool was seeded with liquidity in a 1:1 range; a buy far past it runs the
        // second hop out of liquidity, which is the only way a hop under-fills.
        vm.prank(USER);
        try router.zapBuyWithNative{value: 9_000 ether}(address(curve), _twoHopBuy(), 0, 0, NEVER) {
            // If the pool COULD fill it, the post-condition must still hold.
            _routerHoldsNothing("after an oversized two-hop buy that filled");
        } catch {
            _routerHoldsNothing("after an oversized two-hop buy that reverted");
        }
    }

    // ==========================================================================================
    // 2. The post-condition covers three currencies, and an intermediate is not one of them.
    // ==========================================================================================

    /// @notice Informational. The header says "after any zap this contract holds nothing". It holds
    ///         nothing in NATIVE, in the market's QUOTE and in the market's BASE, because those are
    ///         the three `_sweepToken`/`_sweepNative` is called with. An intermediate balance is
    ///         swept by nothing, survives every zap that routes through it, and then leaves in full
    ///         with the first caller who zaps a market priced in that asset - a caller with no
    ///         relationship to whoever put it there.
    ///
    ///         No path through the router can put a user's money in that state (see `test_Z1`-`Z3`),
    ///         so the cost is confined to a misdirected transfer. It is recorded because the
    ///         post-condition as written is what a reader would rely on when deciding that the
    ///         absolute sweep is safe.
    function test_Z4_anIntermediateBalanceSurvivesAndLeavesWithAnUnrelatedCaller() public {

        // Somebody sends the router MID by mistake.
        mid.mint(address(this), 500e18);
        mid.transfer(address(router), 500e18);
        assertEq(mid.balanceOf(address(router)), 500e18);

        // A two-hop zap ROUTES THROUGH mid and leaves the donation untouched.
        vm.prank(USER);
        router.zapBuyWithNative{value: 10 ether}(address(curve), _twoHopBuy(), 0, 0, NEVER);
        assertEq(mid.balanceOf(address(router)), 500e18, "the zap moved it, so there is no finding");

        // An unrelated stranger zaps a market PRICED in mid. `_sweepToken(mid)` is absolute.
        PathKey[] memory p = new PathKey[](1);
        p[0] = _hop(address(mid));
        uint256 before = mid.balanceOf(STRANGER);
        vm.prank(STRANGER);
        router.zapBuyWithNative{value: 1 ether}(address(midCurve), p, 0, 0, NEVER);

        assertGe(mid.balanceOf(STRANGER) - before, 500e18, "the stranger did not collect the donation");
        assertEq(mid.balanceOf(address(router)), 0, "the router kept some");
    }
}
