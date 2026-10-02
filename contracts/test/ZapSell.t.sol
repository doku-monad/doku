// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {IERC20Errors} from "openzeppelin/interfaces/draft-IERC6093.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {MarketsStub} from "./mocks/MarketsStub.sol";

/**
 * Selling a market's token for native MON, and the two properties that make it safe to.
 *
 * The buy side of this router was built around a claim it stated plainly: it has no `receive()`,
 * so "the only native movement is the settle it owes, never a take it would have to accept". A
 * sell cannot honour that — `PoolManager.take` on the zero currency pays with a raw call, and a
 * contract that cannot be paid cannot collect what it just sold for.
 *
 * What survives, and what these tests pin, is the half that was actually load-bearing: nobody may
 * PUSH MON at this contract. The sweep is absolute, so an accepted donation would be handed to
 * whoever zapped next — nobody loses money in that story, but "this contract holds nothing" stops
 * being a property of the code and becomes a statement about timing.
 *
 * THAT HALF NEEDED TWO CONDITIONS, NOT ONE, and v2 shipped with one. `msg.sender == poolManager`
 * does not stop a push: `take` on the zero currency is a raw call FROM the PoolManager to a
 * recipient the CALLER names, so a stranger who opens their own unlock and names this router
 * arrives with exactly the `msg.sender` the check admits. v3 also requires the router's own
 * transient expected-unlock flag, and these three tests are the corners of that: a stranger, the
 * PoolManager inside the router's own window, and the PoolManager outside it.
 *
 * No fork needed here: no test reaches a pool.
 */
contract ZapSellReceiveTest is Test {
    ZapRouterHarness internal router;
    PayingManagerStub internal manager;

    address internal constant OWNER = address(0xB0B);
    address internal constant STRANGER = address(0xBAD);

    function setUp() public {
        manager = new PayingManagerStub();
        vm.deal(address(manager), 100 ether);
        router = new ZapRouterHarness(
            IPoolManager(address(manager)), DokuFactory(payable(address(0xFAC))), OWNER, 0
        );
    }

    function test_nobodyButThePoolManagerMayPayTheRouter() public {
        vm.deal(STRANGER, 1 ether);
        vm.prank(STRANGER);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "a stranger must not be able to fund the router");
        assertEq(address(router).balance, 0, "and nothing may stick to it");
    }

    /**
     * The twin, and it is not redundant.
     *
     * With no `receive()` at all the test above passes for entirely the wrong reason — every
     * value-bearing call reverts, including the one a sell depends on. This is the test that fails
     * in that world, and it is the reason the pair is written together.
     *
     * Driven through the harness because the window is TRANSIENT: it is opened and closed inside
     * `_unlock`, so a test that raised it in one external call and paid in the next would be
     * asserting something about the test runner's transient-storage lifetime rather than about the
     * router. One call, both halves.
     */
    function test_thePoolManagerMayPayTheRouterInsideItsOwnUnlock() public {
        assertTrue(router.payMeAsPoolManager(1 ether, true), "a native take must be able to land");
        assertEq(address(router).balance, 1 ether);
    }

    /**
     * And the third corner, which is the finding: the PoolManager paying OUTSIDE the router's own
     * unlock is a stranger's `take` naming this router, and it is refused.
     */
    function test_thePoolManagerMayNotPayTheRouterOutsideItsOwnUnlock() public {
        assertFalse(router.payMeAsPoolManager(1 ether, false), "a push through the PoolManager landed");
        assertEq(address(router).balance, 0, "and nothing may stick to it");
    }
}

/**
 * @dev `PoolManager.take` on the zero currency, reduced to the only part `receive()` can see: a
 *      raw value-bearing call from the PoolManager's address to a recipient somebody named. No
 *      ledger, no unlock — the gate under test does not look at either.
 */
contract PayingManagerStub {
    function pay(address to, uint256 amount) external returns (bool ok) {
        (ok,) = to.call{value: amount}("");
    }

    receive() external payable {}
}

/**
 * @dev The only way to reach `internal` members from a test. It adds no behaviour to the router
 *      and is never deployed anywhere but here.
 */
contract ZapRouterHarness is ZapRouter {
    constructor(IPoolManager pm, DokuFactory f, address owner_, uint256 cap)
        ZapRouter(pm, f, owner_, cap)
    {}

    function checkSellPath(PathKey[] calldata path) external pure {
        _checkSellPath(path);
    }

    /**
     * @dev Reproduces what `_unlock` does around `poolManager.unlock` — raise the expected-unlock
     *      flag, do the thing, lower it — so that `receive()` can be reached in BOTH states from a
     *      single external call. The flag is transient and the router's own window is the second
     *      half of the gate, so any test that set it in one call and paid in the next would be
     *      measuring the runner rather than the contract.
     *
     *      `amount` comes out of the stub PoolManager's own balance, exactly as a `take` does.
     */
    function payMeAsPoolManager(uint256 amount, bool insideOwnUnlock) external returns (bool ok) {
        bytes32 slot = _UNLOCK_EXPECTED_SLOT;
        if (insideOwnUnlock) {
            assembly ("memory-safe") {
                tstore(slot, 1)
            }
        }
        ok = PayingManagerStub(payable(address(poolManager))).pay(address(this), amount);
        if (insideOwnUnlock) {
            assembly ("memory-safe") {
                tstore(slot, 0)
            }
        }
    }
}

/**
 * The sell direction of a path, which is the mirror of the buy's and not a copy of it.
 *
 * A buy route ends at the market's quote asset and may never touch MON. A sell route ends at MON
 * and no earlier hop may be it. Getting that backwards is not a revert — it is a router holding a
 * token the seller never asked for, with no MON to pay them and a sweep that hands them the wrong
 * asset.
 */
contract ZapSellPathTest is Test {
    ZapRouterHarness internal harness;

    address internal constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    address internal constant WETH = 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242;
    address internal constant NATIVE = address(0);

    function setUp() public {
        harness = new ZapRouterHarness(
            IPoolManager(address(0xF00D)), DokuFactory(payable(address(0xFAC))), address(0xB0B), 0
        );
    }

    function _hop(address to) internal pure returns (PathKey memory) {
        return PathKey({
            intermediateCurrency: Currency.wrap(to),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _one(address a) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = _hop(a);
    }

    function _two(address a, address b) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](2);
        p[0] = _hop(a);
        p[1] = _hop(b);
    }

    /// A sell path must ARRIVE at native MON.
    function test_aSellPathMustEndAtNative() public {
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.PathDoesNotEndAtNative.selector, WETH));
        harness.checkSellPath(_two(USDC, WETH));
    }

    /// And no hop before the last may be it — reaching MON and leaving again pays a second pool
    /// fee to arrive where the route was already going.
    function test_noHopBeforeTheLastMayBeNative() public {
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.NativeIntermediate.selector, uint256(0)));
        harness.checkSellPath(_two(NATIVE, NATIVE));
    }

    /// The one-hop case: a market quoted in something with a direct MON pool.
    function test_aOneHopSellPathStraightToMonIsFine() public view {
        harness.checkSellPath(_one(NATIVE));
    }

    /// And the two-hop case, which is how gold and the bitcoins are reached.
    function test_aTwoHopSellPathIsFine() public view {
        harness.checkSellPath(_two(USDC, NATIVE));
    }

    function test_anEmptyPathIsRefused() public {
        vm.expectRevert(ZapRouter.EmptyPath.selector);
        harness.checkSellPath(new PathKey[](0));
    }

    /// The length is checked BEFORE the destination, so this reverts for the reason it names
    /// rather than for ending at USDC.
    function test_aPathLongerThanMaxHopsIsRefused() public {
        PathKey[] memory long = new PathKey[](5);
        for (uint256 i; i < 4; ++i) long[i] = _hop(USDC);
        long[4] = _hop(NATIVE);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.PathTooLong.selector, uint256(5), uint256(4))
        );
        harness.checkSellPath(long);
    }
}

// ---------------------------------------------------------------------------------------------
//                                    the fixtures the table needs
// ---------------------------------------------------------------------------------------------

/**
 * @dev A market token that is only an ERC-20. The real `DokuToken` adds checkpointing and nothing
 *      else that the router can see, and the guard suite below never reaches a real curve.
 */
contract SellBaseToken is ERC20 {
    constructor() ERC20("Sell Base", "SBASE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @dev A quote asset that can SKIM on transfer, because that is the only shape in which the
 *      router's own `InsufficientQuoteOut` is reachable at all.
 *
 *      A well-behaved curve refuses a breached floor itself, so the router's re-check is dead code
 *      against one. It exists for the case the router's docblock names: a quote asset that charges
 *      on transfer, where the curve's `minQuoteOut` passes on a number the router never received
 *      and therefore cannot swap. With `skimBps` at zero this is an ordinary token.
 */
contract SkimmingQuote is ERC20 {
    uint256 public skimBps;

    constructor() ERC20("Skim", "SKIM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setSkimBps(uint256 bps) external {
        skimBps = bps;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && skimBps != 0) {
            uint256 fee = (value * skimBps) / 10_000;
            // Straight to `ERC20._update`, so neither leg re-enters this override.
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/**
 * @dev A curve that mirrors the REAL `BondingCurve.sell` in the two respects the router depends
 *      on: it pulls the base with `transferFrom(msg.sender, ...)` — so the router, not the seller,
 *      is the address that must have the allowance — and it pays the quote to `msg.sender`.
 *
 *      `pullBps` is the one deliberate infidelity, and it earns its place in exactly one test. The
 *      real curve takes exactly `baseIn`, which consumes the router's allowance to the last wei and
 *      makes `allowance == 0` afterwards true whether or not the router resets it. A curve that
 *      under-pulls is what makes that reset OBSERVABLE.
 */
contract SellCurveStub {
    using SafeERC20 for IERC20;

    IERC20 public token;
    address public quoteAsset;
    uint256 public payout;
    uint256 public pullBps = 10_000;

    error InsufficientOutput();
    error Expired();
    error ZeroAmount();

    constructor(address base_, address quote_) {
        token = IERC20(base_);
        quoteAsset = quote_;
    }

    function setPayout(uint256 amount) external {
        payout = amount;
    }

    function setPullBps(uint256 bps) external {
        pullBps = bps;
    }

    function sell(uint256 baseIn, uint256 minQuoteOut, uint256 deadline)
        external
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (baseIn == 0) revert ZeroAmount();
        quoteOut = payout;
        // The real curve's own floor, checked against what it BOOKS — which is the number the
        // router's re-check exists to distrust.
        if (quoteOut < minQuoteOut) revert InsufficientOutput();
        token.safeTransferFrom(msg.sender, address(this), (baseIn * pullBps) / 10_000);
        IERC20(quoteAsset).safeTransfer(msg.sender, quoteOut);
    }
}

/// @dev `isMarket` and nothing else, and `view` for the reason `ZapCap.t.sol`'s stub spells out:
///      the router reaches it by STATICCALL, so a stub that wrote to storage would revert and
///      every test would then pass on "it reverted" rather than on which error it reverted with.
contract SellFactoryStub {
    mapping(address => bool) private _known;

    function add(address curve) external {
        _known[curve] = true;
    }

    function isMarket(address curve) external view returns (bool) {
        return _known[curve];
    }
}

/**
 * Everything a sell is refused for BEFORE the router touches a pool.
 *
 * Every case here is a wrong call that must cost the seller a revert and nothing else. The
 * PoolManager is `address(0xF00D)` — no code — which is not laziness but the proof: if any of
 * these reached the swap leg the revert would arrive with no data at all, and the named-error
 * assertions below would fail. "It reverted" is not "it reverted for the reason I claimed", and
 * a codeless PoolManager is what keeps the two distinguishable.
 */
contract ZapSellGuardTest is Test {
    ZapRouter internal router;
    SellFactoryStub internal factory;
    SellCurveStub internal curve;
    SellCurveStub internal monCurve;
    SellBaseToken internal base;
    SkimmingQuote internal quote;

    address internal constant OWNER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    /// Never registered with the factory. The stand-in for an impostor curve.
    address internal constant IMPOSTOR = address(0xDEAD);

    uint256 internal constant BASE_IN = 1_000e18;
    uint256 internal constant PAYOUT = 100e18;
    uint256 internal constant CEILING = 5 ether;

    function setUp() public {
        base = new SellBaseToken();
        quote = new SkimmingQuote();
        curve = new SellCurveStub(address(base), address(quote));
        monCurve = new SellCurveStub(address(base), address(0));

        factory = new SellFactoryStub();
        factory.add(address(curve));
        factory.add(address(monCurve));

        router = new ZapRouter(
            IPoolManager(address(0xF00D)), DokuFactory(payable(address(factory))), OWNER, CEILING
        );

        base.mint(SELLER, 1_000_000e18);
        quote.mint(address(curve), 1_000_000e18);
        curve.setPayout(PAYOUT);
    }

    // ------------------------------------------------------------------ helpers

    function _hop(address to) internal pure returns (PathKey memory) {
        return PathKey({
            intermediateCurrency: Currency.wrap(to),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _to(address dest) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = _hop(dest);
    }

    function _toNative() internal pure returns (PathKey[] memory) {
        return _to(address(0));
    }

    /// @dev The error OpenZeppelin raises when the ROUTER has no allowance. Spelled out with its
    ///      arguments because the spender is the whole point: `address(router)`, never the curve.
    function _noAllowance(uint256 amount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            IERC20Errors.ERC20InsufficientAllowance.selector, address(router), 0, amount
        );
    }

    // ------------------------------------------------------------------ the guards

    /**
     * A sell of nothing is a mistake, not a no-op.
     *
     * Without this the router would pull zero tokens, approve zero to the curve and hand the curve
     * a call it refuses — a revert either way, but from somebody else's contract and under
     * somebody else's error. The second half is the control: one wei behaves differently, so this
     * test is measuring the zero check rather than the fact that the call fails at all.
     */
    function test_aZeroAmountIsRefused() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;

        vm.prank(SELLER);
        vm.expectRevert(ZapRouter.ZeroAmount.selector);
        router.zapSellToNative(address(curve), _toNative(), 0, 0, 0, deadline);

        // One wei is not refused for being zero: it gets all the way to the pull.
        vm.prank(SELLER);
        vm.expectRevert(_noAllowance(1));
        router.zapSellToNative(address(curve), _toNative(), 1, 0, 0, deadline);
    }

    /**
     * The deadline, which is the leg where sitting in the mempool actually costs money.
     *
     * WRITTEN WITH `vm.getBlockTimestamp()` THROUGHOUT, AND THAT IS LOAD-BEARING. `via_ir` is on
     * for this tree and solc folds `block.timestamp` across a `vm.warp` — a local cached from the
     * global before the warp is re-materialised as the POST-warp value, so a before/after
     * comparison silently compares a number to itself. This project has lost two sessions to that
     * exact shape. The cheatcode reads the VM and cannot be folded.
     *
     * Three points, because a boundary is where an off-by-one lives: a deadline in the future is
     * alive, a deadline equal to now is still alive (`>` not `>=`), and the same deadline is dead
     * once the clock has moved past it.
     */
    function test_anExpiredDeadlineIsRefused() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;

        // Alive: refused for the ALLOWANCE, which is three checks further along than the clock.
        vm.prank(SELLER);
        vm.expectRevert(_noAllowance(BASE_IN));
        router.zapSellToNative(address(curve), _toNative(), BASE_IN, 0, 0, deadline);

        // The boundary. A deadline of exactly now is not yet past.
        vm.warp(deadline);
        assertEq(vm.getBlockTimestamp(), deadline, "the warp did not land where it was told to");
        vm.prank(SELLER);
        vm.expectRevert(_noAllowance(BASE_IN));
        router.zapSellToNative(address(curve), _toNative(), BASE_IN, 0, 0, vm.getBlockTimestamp());

        // One second later the same transaction is dead.
        vm.warp(vm.getBlockTimestamp() + 1);
        assertGt(vm.getBlockTimestamp(), deadline, "the clock did not move");
        vm.prank(SELLER);
        vm.expectRevert(ZapRouter.Expired.selector);
        router.zapSellToNative(address(curve), _toNative(), BASE_IN, 0, 0, deadline);
    }

    /**
     * The ceiling's FIRST check, on the bound the caller declared, refused before any external
     * call.
     *
     * A sell cannot know its own size in advance, so the cheap refusal `zapBuyWithNative` gets for
     * free is only available here against the caller's own `minNativeOut`. That it happens before
     * the factory is asked is proven the way `ZapCap.t.sol` proves its twin: this router is pointed
     * at a factory address holding NO CODE. If the ceiling were checked after the market lookup
     * the revert would arrive with no data, and the assertion below would fail.
     */
    function test_theCeilingRefusesADeclaredFloorAboveIt() public {
        ZapRouter bare = new ZapRouter(
            IPoolManager(address(0xF00D)), DokuFactory(payable(address(0xFAC))), OWNER, CEILING
        );

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellFloorTooLarge.selector, CEILING + 1, CEILING)
        );
        bare.zapSellToNative(address(curve), _toNative(), BASE_IN, 0, CEILING + 1, vm.getBlockTimestamp() + 1);

        // And exactly at the ceiling it is let through — reaching the market lookup, which is the
        // next thing that can refuse it. Without this the test above would pass on a router that
        // refused everything.
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, IMPOSTOR));
        router.zapSellToNative(IMPOSTOR, _toNative(), BASE_IN, 0, CEILING, vm.getBlockTimestamp() + 1);
    }

    /**
     * A router that will call any address handed to it is a router that can be pointed at a
     * contract which takes the tokens and returns nothing. The factory is IMMUTABLE on this
     * contract precisely so that this answer comes from the real registry rather than from
     * something the caller also supplied.
     */
    function test_anUnknownCurveIsRefused() public {
        vm.prank(SELLER);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.UnknownMarket.selector, IMPOSTOR));
        router.zapSellToNative(IMPOSTOR, _toNative(), BASE_IN, 0, 0, vm.getBlockTimestamp() + 1);
    }

    /**
     * A MON-quoted market already pays MON, and this REFUSES rather than passes through.
     *
     * Passing through would mean silently ignoring `path` and `minNativeOut`, so a seller who
     * computed a slippage bound from a quote of the route would be handed a bound that means
     * nothing. The shape of that mistake is a wallet that sends every market through the router and
     * never notices that on a third of them one of its two protections is decoration.
     */
    function test_aMonQuotedMarketIsRefused() public {
        vm.prank(SELLER);
        vm.expectRevert(ZapRouter.NativeQuoteNeedsNoZap.selector);
        router.zapSellToNative(address(monCurve), _toNative(), BASE_IN, 0, 0, vm.getBlockTimestamp() + 1);
    }

    /**
     * The path guard, reached through the REAL FUNCTION rather than through the harness.
     *
     * `ZapSellPathTest` above exercises `_checkSellPath` directly, which proves the arithmetic and
     * proves nothing about the wiring: a `zapSellToNative` that forgot to call it, or called
     * `_checkPath` instead, would leave every one of those tests green. This is the test that
     * fails in that world. Getting it wrong is not a revert but a silent wrong trade — a sell path
     * ending at an ERC-20 leaves the router holding a token the seller never asked for, with no MON
     * to pay them and a sweep that hands them the wrong asset.
     */
    function test_aSellPathMustEndAtNativeThroughTheEntryPoint() public {
        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.PathDoesNotEndAtNative.selector, address(quote))
        );
        router.zapSellToNative(
            address(curve), _to(address(quote)), BASE_IN, 0, 0, vm.getBlockTimestamp() + 1
        );
    }

    /**
     * THE ROUTER IS THE PULLER, NOT THE CURVE — and this is the mistake every seller who has ever
     * traded directly will make.
     *
     * The direct path's spender is the curve, so a wallet that reuses its existing approval, or a
     * user who copies the direct flow, approves the wrong address. `BondingCurve.sell` pulls from
     * `msg.sender`, and on this path `msg.sender` is the ROUTER: an allowance granted to the curve
     * is an allowance nothing on this path uses.
     *
     * The error is asserted with its arguments because the spender is the entire content of the
     * failure. A bare `vm.expectRevert()` here would pass on any allowance failure, including one
     * naming the curve — which is precisely the world this test exists to rule out.
     *
     * The second half is the control. With the allowance granted to the router the same call gets
     * PAST the pull and is refused by the curve's own floor, so the first half is measuring the
     * spender rather than the fact that sells fail.
     */
    function test_theSellerApprovesTheRouterNotTheCurve() public {
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;

        vm.prank(SELLER);
        base.approve(address(curve), type(uint256).max);

        vm.prank(SELLER);
        vm.expectRevert(_noAllowance(BASE_IN));
        router.zapSellToNative(address(curve), _toNative(), BASE_IN, 0, 0, deadline);
        assertEq(base.balanceOf(address(curve)), 0, "the curve took tokens on an allowance it held");

        // The control: the allowance moved to the router, and now the pull succeeds and the CURVE
        // is what refuses — on the floor the seller declared, one wei above what it pays.
        vm.prank(SELLER);
        base.approve(address(router), BASE_IN);
        vm.prank(SELLER);
        vm.expectRevert(SellCurveStub.InsufficientOutput.selector);
        router.zapSellToNative(address(curve), _toNative(), BASE_IN, PAYOUT + 1, 0, deadline);
    }

    /**
     * The router's own quote floor, which is not the curve's and is not redundant with it.
     *
     * The curve checks `minQuoteOut` against the number it BOOKS. The router re-checks it against
     * the number that ARRIVED. On an honest quote asset those are the same and this check is dead
     * code; on a quote asset that charges on transfer they are not, and the difference is a bound
     * that passes on money the router never received and therefore cannot swap.
     *
     * So the quote here skims 1%: the curve books 100e18, honours a floor of 100e18, and 99e18
     * lands. The router must refuse with both numbers — and it must do so BEFORE the swap, which
     * this fixture proves by having no PoolManager to swap through. A router that checked after
     * the swap would fail here with no revert data at all.
     */
    function test_aBreachedQuoteFloorRevertsBeforeTheSwap() public {
        quote.setSkimBps(100); // 1%
        uint256 arrives = PAYOUT - (PAYOUT / 100);

        vm.prank(SELLER);
        base.approve(address(router), BASE_IN);
        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.InsufficientQuoteOut.selector, PAYOUT, arrives)
        );
        router.zapSellToNative(
            address(curve), _toNative(), BASE_IN, PAYOUT, 0, vm.getBlockTimestamp() + 1 hours
        );

        // The control: a floor at what actually arrives is not breached, so the call proceeds to
        // the swap leg and dies on the codeless PoolManager instead. Different failure, same call.
        vm.prank(SELLER);
        vm.expectRevert(bytes(""));
        router.zapSellToNative(
            address(curve), _toNative(), BASE_IN, arrives, 0, vm.getBlockTimestamp() + 1 hours
        );
    }
}

/// @dev The market's quote asset for the swap suite: an ordinary 18-decimal ERC-20 with a mint,
///      so the v4 pool below can be seeded at 1:1 and every number in these tests stays readable.
contract PoolQuote is ERC20 {
    constructor() ERC20("Pool Quote", "PQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * A sell that actually swaps, on a LOCAL Uniswap v4 `PoolManager` with a real initialised
 * quote/MON pool and real liquidity in it.
 *
 * Everything in `ZapSellGuardTest` above is a refusal, and a refusal proves nothing about the leg
 * that moves money. These are the tests that run the whole path — pull the base, sell it on a REAL
 * `BondingCurve` for the quote, swap the quote through a real pool for MON, and pay the seller —
 * and every assertion here is on a MEASURED BALANCE DELTA rather than on the router's return
 * value. The return value is what the router believes; the balance is what the seller got, and
 * the entire point of the router is the second one.
 *
 * Local, not forked, deliberately: `ZapFork.t.sol` owns the mainnet route table, and a suite that
 * skips without an RPC cannot be the guard on the money path.
 */
contract ZapSellSwapTest is Test {
    PoolManager internal manager;
    PoolModifyLiquidityTest internal lp;
    PoolQuote internal quote;
    BondingCurve internal curve;
    DokuToken internal base;
    MarketsStub internal markets;
    ZapRouter internal router;
    PoolKey internal key;

    address internal constant OWNER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    address internal constant TREASURY = address(0x7EA);
    address internal constant GRADUATOR = address(0x6AD);

    /// @dev 1:1. The quote is 18 decimals for exactly this reason — the pool's price and the
    ///      curve's arithmetic stay legible, and nothing in this suite is about decimal scaling.
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;

    /// @dev Wide and deep, so the swap leg's price impact is not what any assertion below is
    ///      measuring. A thin pool would make `nativeOut` a function of the liquidity seed.
    int256 internal constant LIQUIDITY = 100_000e18;

    uint256 internal constant QUOTE_TARGET = 1_000e18;
    uint256 internal constant FIRST_BUY = 200e18;

    /// @dev Far future. The deadline has its own three-point test in `ZapSellGuardTest`; here it
    ///      must never be the reason anything fails, including after a `revertToState`.
    uint256 internal constant NEVER = type(uint256).max;

    /// @dev `PoolModifyLiquidityTest` returns unused MON with a raw send.
    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        quote = new PoolQuote();
        quote.mint(address(this), 10_000_000e18);
        quote.approve(address(lp), type(uint256).max);

        // Native is the zero currency and sorts below every token, so it is always `currency0`.
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(key, SQRT_1_1);

        vm.deal(address(this), 1_000_000 ether);
        lp.modifyLiquidity{value: 500_000 ether}(
            key,
            ModifyLiquidityParams({
                tickLower: -60_000,
                tickUpper: 60_000,
                liquidityDelta: LIQUIDITY,
                salt: 0
            }),
            ""
        );

        // The real curve, cloned and initialised the way the factory does it.
        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        base = DokuToken(Clones.clone(address(new DokuToken())));
        base.initialize("Zap Sell", "ZSELL", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(
            address(base),
            address(quote),
            QUOTE_TARGET,
            Sinks.REWARDS,
            address(0),
            0,
            address(0),
            TREASURY,
            GRADUATOR,
            address(0)
        );

        markets = new MarketsStub();
        router = new ZapRouter(
            IPoolManager(address(manager)), DokuFactory(payable(address(markets))), OWNER, 0
        );

        // Past the anti-sniper window before the seller buys, so nothing below is confounded by a
        // 50% launch tax. Read through the cheatcode, never the folded global — see
        // `test_anExpiredDeadlineIsRefused`.
        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);

        quote.mint(SELLER, FIRST_BUY);
        vm.startPrank(SELLER);
        quote.approve(address(curve), type(uint256).max);
        curve.buyWithToken(FIRST_BUY, 0, NEVER);
        vm.stopPrank();
        assertGt(base.balanceOf(SELLER), 0, "the fixture's seller never got any tokens to sell");
    }

    // ------------------------------------------------------------------ helpers

    function _toNative() internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(0)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _sell(address c, uint256 baseIn, uint256 minQuoteOut, uint256 minNativeOut)
        internal
        returns (uint256 nativeOut)
    {
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        nativeOut = router.zapSellToNative(c, _toNative(), baseIn, minQuoteOut, minNativeOut, NEVER);
        vm.stopPrank();
    }

    /// @dev What the route ACTUALLY pays for `baseIn`, measured against the same state the
    ///      assertion will run against and then rolled back. Every bound in this suite is derived
    ///      from a measurement rather than from a magic number that would rot on the next change to
    ///      the curve's arithmetic or the pool's seed.
    function _measure(uint256 baseIn) internal returns (uint256 produced) {
        uint256 snap = vm.snapshotState();
        produced = _sell(address(curve), baseIn, 0, 0);
        vm.revertToState(snap);
    }

    function _half() internal view returns (uint256) {
        return base.balanceOf(SELLER) / 2;
    }

    // ------------------------------------------------------------------ the money path

    /**
     * The whole point of the contract: tokens in one end, native MON out the other.
     *
     * Asserted on the seller's MEASURED MON delta, not on the returned `nativeOut`. The two agree
     * today; if they ever stopped agreeing, the delta is the only one that describes what the
     * seller can spend — a router that returned a number and paid a different one would leave
     * every return-value assertion in this file green.
     *
     * The curve's side is asserted too, because "the seller's balance went up" is also what a
     * router that paid out of its own float and never sold anything would look like.
     */
    function test_aSellDeliversNativeToTheSeller() public {
        uint256 baseIn = _half();
        uint256 monBefore = SELLER.balance;
        uint256 baseBefore = base.balanceOf(SELLER);
        uint256 curveBefore = base.balanceOf(address(curve));

        uint256 nativeOut = _sell(address(curve), baseIn, 0, 0);

        assertGt(nativeOut, 0, "the sell produced no MON at all");
        assertEq(
            SELLER.balance - monBefore, nativeOut, "the seller's MON did not rise by what was returned"
        );
        assertEq(
            baseBefore - base.balanceOf(SELLER), baseIn, "the seller was not debited what they sold"
        );
        assertEq(
            base.balanceOf(address(curve)) - curveBefore, baseIn, "the curve did not take the tokens"
        );
    }

    /**
     * The bound that is the only figure the seller actually receives.
     *
     * `minQuoteOut` bounds the curve and `minNativeOut` bounds the route, and it is the second one
     * a seller cares about — the quote is an intermediate they never hold. The floor is set ONE WEI
     * above what the route was measured to return, so this cannot pass by being far away from the
     * boundary, and both of the error's arguments are asserted: a bare selector would be satisfied
     * by a router that reverted with the wrong numbers.
     */
    function test_aBreachedNativeFloorReverts() public {
        uint256 baseIn = _half();
        uint256 produced = _measure(baseIn);
        assertGt(produced, 0, "nothing was produced, so the floor below would be meaningless");

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.InsufficientNativeOut.selector, produced + 1, produced)
        );
        router.zapSellToNative(address(curve), _toNative(), baseIn, 0, produced + 1, NEVER);
        vm.stopPrank();

        // The boundary: exactly what the route returns is not a breach. Without this the test
        // above would pass on a router that refused every sell.
        assertEq(
            _sell(address(curve), baseIn, 0, produced), produced, "the exact floor was refused"
        );
    }

    /**
     * THE INVARIANT. After any zap, in either direction, this contract holds nothing.
     *
     * A router with a balance is a router the next caller sweeps, and both sweeps here are
     * ABSOLUTE rather than deltas precisely so that the post-condition is a property of the code
     * and not a claim about who happened to send what.
     *
     * DUST IS DONATED FIRST, AND THAT IS WHAT MAKES THIS A TEST. On a clean route the quote and
     * base sweeps have nothing to move, so all three assertions would pass on a router whose token
     * sweeps had been deleted outright. Seeding a wei of each before the sell is what forces those
     * two lines to run — and the seller's base balance is checked afterwards, so the dust has to
     * arrive somewhere rather than merely leave.
     *
     * The MON assertion needs no help: on a sell the native sweep is the PAYOUT, so deleting it
     * strands the entire proceeds here.
     */
    function test_theRouterHoldsNothingAfterASell() public {
        uint256 dust = 7;
        uint256 baseBefore = base.balanceOf(SELLER);
        uint256 baseIn = baseBefore / 2;

        vm.prank(SELLER);
        base.transfer(address(router), dust);
        quote.mint(address(router), dust);
        uint256 quoteBefore = quote.balanceOf(SELLER);
        uint256 monBefore = SELLER.balance;

        uint256 nativeOut = _sell(address(curve), baseIn, 0, 0);

        assertEq(address(router).balance, 0, "MON stuck in the router");
        assertEq(quote.balanceOf(address(router)), 0, "quote stuck in the router");
        assertEq(base.balanceOf(address(router)), 0, "base stuck in the router");

        // And it went to the seller rather than nowhere.
        assertEq(SELLER.balance - monBefore, nativeOut, "the payout did not reach the seller");
        assertEq(
            quote.balanceOf(SELLER) - quoteBefore, dust, "the stranded quote was not swept out"
        );
        assertEq(
            base.balanceOf(SELLER), baseBefore - baseIn, "the stranded base did not come back"
        );
    }

    /**
     * No allowance may survive the call that granted it.
     *
     * A dangling allowance on a contract that will hold somebody else's dust tomorrow is the same
     * bug the sweep closes, wearing a different hat.
     *
     * AGAINST THE REAL CURVE THIS ASSERTION IS WEAK, AND SAYING SO IS PART OF THE TEST.
     * `BondingCurve.sell` pulls exactly `baseIn`, which consumes the router's allowance to the
     * last wei, so `allowance == 0` afterwards is true whether or not the router resets it. Kept
     * anyway, because it is the case that ships and it fails the day the curve stops pulling the
     * whole amount. The companion below is the one that actually exercises the reset.
     */
    function test_theCurveAllowanceIsBackToZeroAfterASell() public {
        uint256 baseIn = _half();
        _sell(address(curve), baseIn, 0, 0);
        assertEq(
            base.allowance(address(router), address(curve)),
            0,
            "a live allowance to the curve survived the sell"
        );
    }

    /**
     * The companion, and the one that can actually fail.
     *
     * A curve that pulls only HALF of what it was approved leaves slack behind, and slack is the
     * only state in which `forceApprove(curve, 0)` is observable at all. Delete that line and this
     * test reports `baseIn / 2` where it wants zero.
     *
     * The rest of the path is real: this stub sells for the same quote asset, and the router swaps
     * the proceeds through the same live pool, so the sweep of the un-pulled half is exercised
     * alongside — the seller ends up down only what the curve actually took.
     */
    function test_theCurveAllowanceIsZeroEvenWhenTheCurveUnderPulls() public {
        SellCurveStub stub = new SellCurveStub(address(base), address(quote));
        stub.setPullBps(5_000);
        stub.setPayout(50e18);
        quote.mint(address(stub), 50e18);

        uint256 baseIn = _half();
        uint256 baseBefore = base.balanceOf(SELLER);

        uint256 nativeOut = _sell(address(stub), baseIn, 0, 0);

        assertGt(nativeOut, 0, "the under-pulling sell produced no MON");
        assertEq(
            base.allowance(address(router), address(stub)),
            0,
            "the router left a live allowance behind on the half the curve did not take"
        );
        assertEq(
            baseBefore - base.balanceOf(SELLER),
            baseIn / 2,
            "the un-pulled half was not swept back to the seller"
        );
        assertEq(base.balanceOf(address(router)), 0, "base stuck in the router");
    }

    /**
     * The ceiling's SECOND check — on what the sale actually produced, not on what the caller
     * declared.
     *
     * The first check reads `minNativeOut`, which catches every honest caller because an interface
     * computes it from its own quote of the same route. It catches nobody else: a caller who
     * declares a floor of zero walks straight past it, and a sell cannot know its own size until
     * the curve and the pools have both answered. This is the check that binds, and it is the
     * difference between a bound and a suggestion.
     *
     * Written so that ONLY the second check can fire: `minNativeOut` is zero, which is under any
     * ceiling, and the ceiling is set one wei below the measured proceeds. Both of the error's
     * arguments are asserted, so a router that reverted here on the declared floor instead would
     * report `0` and fail.
     */
    function test_theCeilingRefusesASaleThatProducedMoreThanIt() public {
        uint256 baseIn = _half();
        uint256 produced = _measure(baseIn);
        assertGt(produced, 1, "the measurement is too small for a ceiling below it");

        vm.prank(OWNER);
        router.setMaxZapValue(produced - 1);

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, produced, produced - 1)
        );
        router.zapSellToNative(address(curve), _toNative(), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // The boundary: a ceiling exactly at the proceeds lets the same sale through. Without it
        // this test would pass on a router that refused every sell once a ceiling was set.
        vm.prank(OWNER);
        router.setMaxZapValue(produced);
        assertEq(_sell(address(curve), baseIn, 0, 0), produced, "the sale at the ceiling was refused");
    }

    /**
     * A seller that cannot be paid in MON, which the buy direction never had to think about.
     *
     * `_sweepNative` is the PAYOUT on a sell, not a refund, and it reverts `NativeRefundFailed` if
     * the raw `call` fails. So a contract that holds market tokens and has no payable `receive()`
     * can BUY through this router and can never SELL through it — an asymmetry the sell direction
     * introduced and the one failure mode on the money path that nothing covered.
     *
     * This is a documented limitation rather than a bug, and the test exists to make it a decision
     * somebody made rather than a surprise somebody hits. The payout is a raw `call` forwarding all
     * gas — the 2300-stipend trap that breaks smart-contract wallets is already avoided — so every
     * real smart account is fine. What is not fine is a contract with no way to accept the chain's
     * own currency, and there is nothing a router can do for it: there is no other asset to pay in.
     *
     * If this ever needs solving, the fix is a `recipient` parameter, not a change here.
     */
    function test_aSellerThatCannotAcceptMonIsRefusedRatherThanStranded() public {
        DeafSeller deaf = new DeafSeller();
        uint256 baseIn = _half();
        // `base` here is a real `DokuToken`, minted once at launch — so the deaf holder is funded
        // the way any holder is, by someone sending them tokens.
        vm.prank(SELLER);
        base.transfer(address(deaf), baseIn);

        // It reverts — and the whole transaction unwinds, so the tokens are still the seller's.
        // The alternative, which this asserts is NOT what happens, is a sale that books and leaves
        // the MON on the router for the next caller to sweep.
        vm.expectRevert(ZapRouter.NativeRefundFailed.selector);
        deaf.sell(router, address(curve), address(base), _toNative(), baseIn, NEVER);

        assertEq(base.balanceOf(address(deaf)), baseIn, "the refused sale kept the tokens");
        assertEq(address(router).balance, 0, "and left no MON on the router");
        assertEq(base.balanceOf(address(router)), 0, "and no tokens on it either");
    }

}

/**
 * @dev A holder with no payable `receive()` and no `fallback()`. It can be sent ERC-20s and cannot
 *      be sent the chain's own currency, which is the whole point of it.
 */
contract DeafSeller {
    function sell(
        ZapRouter router,
        address curve,
        address base,
        PathKey[] calldata path,
        uint256 baseIn,
        uint256 deadline
    ) external returns (uint256) {
        IERC20(base).approve(address(router), baseIn);
        return router.zapSellToNative(curve, path, baseIn, 0, 0, deadline);
    }
}
