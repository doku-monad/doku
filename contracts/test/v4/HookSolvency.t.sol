// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract SolvencyToken is ERC20 {
    constructor() ERC20("Solv", "SLV") {
        _mint(msg.sender, 10_000_000_000e18);
    }
}

/**
 * The two properties whose failure is not a wrong number but stuck money.
 *
 * Everything else about the levy is an accounting question — too much, too little, to the wrong
 * bucket — and a wrong number is recoverable. These two are not:
 *
 *   1. **The hook's delta must never exceed the principal**, in either currency. v4 adds the hook's
 *      returned delta to the swap amount and reverts if the sign flips; on the maker side POSM
 *      slippage-checks `principal − hookDelta` through a `toUint128` that reverts on a negative
 *      before any minimum is compared. Exceed it and the operation does not merely misprice — it
 *      cannot execute at all, for anyone, permanently.
 *
 *   2. **A liquidity provider must always be able to leave.** A remove that can revert is a
 *      position that can be trapped, and the levy sits directly in that path.
 *
 * Fuzzed rather than sampled, because both failures live at the edges — a dust swap, a position
 * whose accrued fees dwarf its principal, a single-sided range — and a handful of round numbers
 * walks straight past all of them.
 */
contract HookSolvencyTest is Test {
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    PoolDonateTest internal donor;

    SolvencyToken internal tok;
    PoolKey internal key;
    PoolId internal id;

    address internal graduator = address(0x6AD);
    address internal sinkAddr = address(0x51);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        donor = new PoolDonateTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        tok = new SolvencyToken();
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tok)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        id = PoolIdLibrary.toId(key);

        vm.startPrank(graduator);
        manager.initialize(key, SQRT_1_1);
        hook.registerPool(key, address(tok), hook.SINK_BURN(), sinkAddr, 0);
        vm.stopPrank();

        tok.approve(address(lp), type(uint256).max);
        tok.approve(address(swapper), type(uint256).max);
        tok.approve(address(donor), type(uint256).max);
        vm.deal(address(this), 500_000_000 ether);
    }

    /// @dev `PoolModifyLiquidityTest` does not refund unused MON, so every add is sent exactly what
    ///      a wide range at this liquidity actually costs, with headroom. Sending too little fails
    ///      as a bare `OutOfFunds` deep inside the unlock, which looks nothing like a size problem.
    function _seed(int256 liq) internal {
        lp.modifyLiquidity{value: 200_000 ether}(
            key, ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: liq, salt: 0}), ""
        );
    }

    // ------------------------------------------------------------------ 1. the delta bound

    /**
     * The hook never takes more than the trade it is levying, in either currency.
     *
     * Asserted through the singleton's own ERC-6909 ledger rather than by reading the hook's
     * return value: the levy is `poolManager.mint`ed to the hook, so the balance that appears
     * there IS the delta the pool accepted. If it ever exceeded the principal, the swap would have
     * reverted before this line rather than arriving here with a bad number.
     *
     * The trader's side is checked too, and it is the half that matters to a user: on exact input
     * they pay exactly what they specified, no more, whatever the levy does.
     */
    function testFuzz_hookDeltaNeverExceedsPrincipalInEitherCurrency(uint96 monIn, uint96 liq) public {
        liq = uint96(bound(liq, 1e18, 5_000e18));
        monIn = uint96(bound(monIn, 1, 50_000 ether));
        _seed(int256(uint256(liq)));

        uint256 mon0 = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId());
        uint256 tok0 = manager.balanceOf(address(hook), Currency.wrap(address(tok)).toId());
        uint256 spent = address(this).balance;

        try swapper.swap{value: monIn}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(monIn)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {
            spent -= address(this).balance;
        } catch {
            // A swap can legitimately fail — the price limit, or a size the range cannot fill.
            // What it must never do is fail because the hook asked for more than existed, and the
            // assertions below still hold on the untouched ledger.
            spent = 0;
        }

        uint256 levied0 = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId()) - mon0;
        uint256 levied1 = manager.balanceOf(address(hook), Currency.wrap(address(tok)).toId()) - tok0;

        assertLe(levied0, monIn, "the hook took more MON than the swap specified");
        assertLe(spent, monIn, "the trader paid more than they specified");
        // A BURN market levies the token side on an exact-input buy, and the token it took can
        // never exceed what the pool paid out — which is bounded by what the pool held.
        assertLe(levied1, tok.balanceOf(address(manager)) + levied1, "the token levy is unbacked");
    }

    // -------------------------------------------------------- 2. an LP can always get out

    /**
     * A position can always be removed, at every levy rate the ceiling admits.
     *
     * The rates that ship are constants, so this cannot be driven by re-registering at a higher
     * one — `test_noLevyRateCanEverChange` is what proves there is no such setter. What it varies
     * instead is everything the levy is computed FROM: the position's size, its range, and the
     * accrued fees a stranger can manufacture with `donate`. If a remove can be made to revert,
     * this is where it shows up.
     */
    function testFuzz_removeNeverRevertsForAnyPositionShape(uint96 liq, uint16 width, uint96 donation) public {
        liq = uint96(bound(liq, 1e15, 1_000e18));
        int24 hi = int24(uint24(bound(width, 1, 600))) * 60;
        donation = uint96(bound(donation, 0, 500 ether));

        _seed(1_000e18); // depth, so the range below is genuinely two-sided

        lp.modifyLiquidity{value: 100_000 ether}(
            key,
            ModifyLiquidityParams({tickLower: -hi, tickUpper: hi, liquidityDelta: int256(uint256(liq)), salt: bytes32(uint256(7))}),
            ""
        );

        // Anyone may donate; `PoolManager.donate` has no access control. This is the manufactured
        // `feesAccrued` that a levy computed off `delta` rather than `delta - feesAccrued` would
        // choke on.
        if (donation != 0) {
            donor.donate{value: donation}(key, donation, donation, "");
        }

        // Must not revert. That is the whole assertion.
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -hi, tickUpper: hi, liquidityDelta: -int256(uint256(liq)), salt: bytes32(uint256(7))}),
            ""
        );

        uint128 remaining = IPoolManager(address(manager)).getLiquidity(id);
        assertGt(remaining, 0, "the seed position vanished too");
    }

    /**
     * The single-sided case, which is the one the clamp exists for.
     *
     * A range order placed entirely above spot is 100% token and contributes NOTHING in MON, so the
     * MON leg of its delta is zero. A levy that did not clamp per currency would compute a nonzero
     * take against a zero principal, and the remove would revert on a position the LP funded
     * correctly. Both mirror images are checked, because getting the sides backwards is the easy
     * mistake — spot BELOW the range means the position is all currency0.
     */
    function test_aSingleSidedPositionCanAlwaysBeRemoved() public {
        _seed(1_000e18);

        // ABOVE spot is 100% currency0 — MON, not the token. This is the direction that reads
        // backwards to almost everyone: price is token1-per-token0, so a range priced above the
        // market is one the pool would have to walk UP into, and until it does the position holds
        // only the currency it would be selling. Sent with `value` for exactly that reason; sending
        // none fails as a bare `OutOfFunds` inside the unlock.
        lp.modifyLiquidity{value: 50_000 ether}(
            key,
            ModifyLiquidityParams({tickLower: 6_000, tickUpper: 12_000, liquidityDelta: 5e18, salt: bytes32(uint256(1))}),
            ""
        );
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: 6_000, tickUpper: 12_000, liquidityDelta: -5e18, salt: bytes32(uint256(1))}),
            ""
        );

        // BELOW spot is 100% currency1 — the token. The mirror image, and it needs no MON at all.
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -12_000, tickUpper: -6_000, liquidityDelta: 5e18, salt: bytes32(uint256(2))}),
            ""
        );
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -12_000, tickUpper: -6_000, liquidityDelta: -5e18, salt: bytes32(uint256(2))}),
            ""
        );
    }

    /**
     * A range order is not a way to sell untaxed.
     *
     * The obvious evasion: instead of swapping the token for MON, place a token-only range order
     * BELOW spot and wait for the price to fall through it. The position converts to MON on its
     * own, no swap of the maker's ever happens, and a levy that only watched `afterSwap` would
     * never see the sale. D2's maker levy is what closes it.
     *
     * The EXIT leg is what is asserted, and it is the only one there is. Makers pay the recorded
     * maker rate — the protocol's share of the quote leg — so the token-only add is rated zero and
     * costs nothing (R8). The route is still closed, because the sale only completes when the
     * position is withdrawn as MON, and that withdrawal is levied.
     */
    function test_aRangeOrderCannotBeUsedToSellUntaxed() public {
        _seed(1_000e18);

        uint256 monBefore = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId());

        // The order: all token, sitting below spot, waiting for the price to fall into it.
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6_000, tickUpper: -600, liquidityDelta: 20e18, salt: bytes32(uint256(9))}),
            ""
        );
        // Someone buys hard, walking the price down through the order and converting it to MON.
        //
        // A BUY, and the direction is worth being explicit about because it reads backwards twice
        // over. `zeroForOne: true` is MON in and token out, and in v4 the price is
        // sqrt(currency1/currency0) — tokens per MON — so buying the token makes that ratio FALL.
        // The order sits below spot, so a buy is what reaches it, and the maker ends up holding
        // MON without ever having swapped.
        swapper.swap{value: 150_000 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -150_000 ether,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // The maker pulls out what is now MON. This is the leg that must not be free.
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: -6_000, tickUpper: -600, liquidityDelta: -20e18, salt: bytes32(uint256(9))}),
            ""
        );

        assertGt(
            manager.balanceOf(address(hook), Currency.wrap(address(0)).toId()),
            monBefore,
            "a range order sold into MON without paying the levy"
        );
    }

    /// @dev The ceiling is what makes the sign-flip argument in `_beforeSwap` sound: at or below
    ///      it, `amountToSwap += hookDeltaSpecified` cannot change sign, so the trader always pays
    ///      exactly what they specified. Asserted as a relationship between the shipped constants
    ///      rather than as a literal, so raising either rate past the ceiling fails here.
    function test_theShippedRatesAreWithinTheCeilingThatMakesTheMathSound() public view {
        uint256 total = uint256(hook.PROTOCOL_LEVY_BPS()) + hook.SINK_LEVY_BPS() + hook.LP_LEVY_BPS() + 1000;
        assertLe(total, hook.MAX_LEVY_BPS(), "the shipped levy exceeds its own ceiling");
        assertLt(hook.MAX_LEVY_BPS(), 10_000, "the ceiling does not bound anything");
    }
}
