// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract G3Tok is ERC20 {
    constructor() ERC20("G3", "G3") {
        _mint(msg.sender, 1e30);
    }
}

/// @notice Attacker router: raw access to swap / take / mint / settle inside one unlock, so the
///         int128 sign-flip can be driven without a helper that sanity-checks the deltas first.
contract SignFlipAttacker is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    receive() external payable {}

    enum Mode {
        SWAP_ONLY, // just swap, leave the deltas as they fall
        SWAP_THEN_MINT, // swap, then convert the caller's credit into 6909 claims
        SWAP_THEN_TAKE // swap, then try to physically take the credit
    }

    function run(PoolKey calldata key, int256 amountSpecified, uint160 limit, Mode mode)
        external
        payable
        returns (bytes memory)
    {
        return pm.unlock(abi.encode(key, amountSpecified, limit, mode));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (PoolKey memory key, int256 amountSpecified, uint160 limit, Mode mode) =
            abi.decode(data, (PoolKey, int256, uint160, Mode));

        BalanceDelta d = pm.swap(
            key, SwapParams({zeroForOne: true, amountSpecified: amountSpecified, sqrtPriceLimitX96: limit}), ""
        );

        int256 d0 = int256(d.amount0());
        if (mode == Mode.SWAP_THEN_MINT && d0 > 0) {
            // Turn the (hopefully huge) positive delta into ERC-6909 claims. Needs no real balance.
            pm.mint(address(this), key.currency0.toId(), uint256(d0));
        } else if (mode == Mode.SWAP_THEN_TAKE && d0 > 0) {
            pm.take(key.currency0, address(this), uint256(d0));
        }
        return abi.encode(d);
    }
}

/**
 * GENERATION-3 AUDIT — the ONLY change the audit's three fix commits made to `DokuHook.sol` is the
 * checked cast in `_beforeSwap`. These tests attack that line, and the basis it did NOT change.
 */
contract HookLevyCastGen3AuditTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    SignFlipAttacker internal atk;

    G3Tok internal tok;
    PoolKey internal K;
    PoolId internal I;
    address internal graduator = address(0x6AD);
    address internal sink = address(0x51);
    int24 internal MIN_T;
    int24 internal MAX_T;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        atk = new SignFlipAttacker(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        MIN_T = TickMath.minUsableTick(60);
        MAX_T = TickMath.maxUsableTick(60);
        vm.deal(address(this), 100_000_000 ether);

        tok = new G3Tok();
        K = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(tok)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        I = K.toId();
        vm.startPrank(graduator);
        manager.initialize(K, SQRT_1_1);
        // REWARDS market, no creator tax -> quote leg carries exactly 100 bps.
        hook.registerPool(K, address(tok), hook.SINK_REWARDS(), sink, 0);
        vm.stopPrank();
        tok.approve(address(lp), type(uint256).max);
        tok.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: 1_000_000 ether}(
            K, ModifyLiquidityParams({tickLower: MIN_T, tickUpper: MAX_T, liquidityDelta: 200_000 ether, salt: 0}), ""
        );
    }

    function _ledger() internal view returns (uint256) {
        return hook.pendingProtocol(I) + hook.pendingSink(I) + hook.owedTax(I);
    }

    // ------------------------------------------------------------------ 1. the fix itself

    /// @dev The gen-2 exploit size. `LevyOverflow` now rejects it; nothing is levied at zero.
    ///
    ///      NOTE the baseline. `_ledger()` is NOT zero at the start of a test: `setUp`'s external
    ///      LP add pays the MAKER levy (`_afterAddLiquidity` -> `_makerLevy`, 30 bps of the quote
    ///      leg on 200,000 MON = ~600 MON in `pendingProtocol`). That is correct behaviour, not
    ///      levy from a swap, so the property here is that the reverting swap moves the ledger by
    ///      ZERO — not that the ledger is zero.
    function test_gen2TruncationSizeNowReverts() public {
        uint256 lg0 = _ledger();
        int256 S = int256(10_000 * (uint256(1) << 128));
        uint160 limit = uint160(uint256(SQRT_1_1) * 99 / 100);
        vm.expectRevert();
        swapper.swap{value: 2_000_000 ether}(
            K,
            SwapParams({zeroForOne: true, amountSpecified: -S, sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(_ledger(), lg0, "nothing should have been levied at all");
    }

    /// @dev THE REMAINING WINDOW. The check only rejects `levy > uint128.max`. Between
    ///      `int128.max` and `uint128.max` the levy is ACCEPTED and `int128(levy)` is NEGATIVE —
    ///      which flips `beforeSwapDelta` from a hook credit into a hook DEBT and hands the caller
    ///      a matching positive delta of up to 2**127 of the quote. If that delta were takeable it
    ///      would drain the singleton's whole MON balance, i.e. every pool on the chain.
    ///
    ///      It is not. The hook's own `donate`+`mint` spend exactly `levy`, so the hook ends the
    ///      unlock at `int128(levy) - levy == -2**128` in that currency, and `CurrencyNotSettled`
    ///      takes the transaction down. Driven at three points in the window and in all three
    ///      exit shapes.
    function test_signFlipWindowCannotBeSettled() public {
        uint256[3] memory levies =
            [uint256(1) << 127, (uint256(1) << 127) + 1e18, uint256(type(uint128).max) - 1e18];
        uint160 limit = uint160(uint256(SQRT_1_1) * 99 / 100);

        uint256 pmMonBefore = address(manager).balance;
        // Snapshot, for the same reason as above: `setUp`'s LP add already paid the maker levy.
        uint256 lg0 = _ledger();
        for (uint256 i = 0; i < levies.length; i++) {
            // bps == 100 on the quote leg, so specified == 100 * levy reproduces that levy exactly.
            int256 specified = -int256(levies[i] * 100);
            assertEq(uint256(-specified) * 100 / 10_000, levies[i], "levy reconstruction");
            assertGt(levies[i], uint256(uint128(type(int128).max)), "must be in the sign-flip window");
            assertLe(levies[i], uint256(type(uint128).max), "must pass the LevyOverflow check");

            for (uint256 m = 0; m < 3; m++) {
                vm.expectRevert();
                atk.run(K, specified, limit, SignFlipAttacker.Mode(m));
            }
        }
        assertEq(address(manager).balance, pmMonBefore, "singleton MON moved");
        assertEq(_ledger(), lg0, "ledger moved");
    }

    // ---------------------------------------------- 2. no DoS on an ordinary-sized swap

    /// @dev The revert is reachable only by a caller who names > ~3.09e39 raw units. A swap of any
    ///      size a real asset admits is nowhere near it, so `LevyOverflow` cannot be used to stop
    ///      anybody else's trade: `amountSpecified` belongs to the swapper, and no third party can
    ///      influence it or `bps` (both are snapshotted constants per market, with no setter).
    function testFuzz_ordinarySwapsNeverHitLevyOverflow(uint128 monIn) public {
        // Up to the entire raw-unit supply of MON times a billion, and then some.
        uint256 n = bound(uint256(monIn), 1, uint256(1e36));
        uint256 levyWide = (n * 1100) / 10_000; // the worst case rate the ceiling admits
        assertLe(levyWide, uint256(type(uint128).max), "a 1e36 trade would overflow the levy");

        swapper.swap{value: 2_000_000 ether}(
            K,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(bound(n, 1, 1_000_000 ether)),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// @dev Exactly where the cliff is, in units a human can read.
    function test_whereTheCliffIs() public pure {
        uint256 atHundredBps = (uint256(type(uint128).max) * 10_000) / 100;
        uint256 atCeiling = (uint256(type(uint128).max) * 10_000) / 1100;
        console2.log("min reverting amountSpecified @  100 bps:", atHundredBps);
        console2.log("min reverting amountSpecified @ 1100 bps:", atCeiling);
        // uint128.max is 3.4028e38, so the ceiling case is 3.4028e38 * 10000/1100 = 3.0935e39 raw
        // units. On a 1e18-decimal asset that is 3.09e21 WHOLE tokens — twelve orders of magnitude
        // above MON's entire supply, and the cheaper 100 bps case is ten times higher still
        // (3.4028e40 raw / 3.40e22 whole).
        assertGt(atCeiling / 1e18, 3e21, "cliff is lower than claimed");
        assertGt(atHundredBps / 1e18, 3.4e22, "the 100 bps cliff is lower than claimed");
    }

    // ------------------------------------- 3. the basis the fix did NOT change: named, not traded

    /**
     * THE PROPERTY THAT MAKES THE NAMED-AMOUNT BASIS SAFE.
     *
     * `_beforeSwap` still levies `|amountSpecified| * bps / BPS` — the number the caller NAMED,
     * not the amount the pool consumed. The obvious worry is the mirror image of the gen-2 bug:
     * can a caller name a SMALL amount and still trade a LARGE one, paying a levy sized off the
     * small number? No — v4 sets `amountToSwap = amountSpecified + levy`, so the pool can consume
     * at most `N - levy`. The levy is therefore always at least `consumed * bps / (BPS - bps)`,
     * which is strictly more than the honest `consumed * bps / BPS`.
     *
     * Fuzzed against the ledger plus the LP donate, which together are the whole levy, and against
     * a reference model of the honest charge on the amount actually consumed.
     */
    function testFuzz_namedAmountBasisNeverUnderChargesTheRealTrade(uint96 named, uint16 limitPct) public {
        uint256 n = bound(uint256(named), 1e6, 500_000 ether);
        // A price limit that bites anywhere from "immediately" to "not at all".
        uint256 pct = bound(uint256(limitPct), 1, 99);
        uint160 limit = uint160(uint256(SQRT_1_1) * pct / 100);

        uint256 lg0 = _ledger();
        (uint256 fg0,) = IPoolManager(address(manager)).getFeeGrowthGlobals(I);
        uint128 liq = IPoolManager(address(manager)).getLiquidity(I);

        BalanceDelta d = swapper.swap{value: 2_000_000 ether}(
            K,
            SwapParams({zeroForOne: true, amountSpecified: -int256(n), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 paid = uint256(uint128(-d.amount0()));
        assertLe(paid, n, "trader paid more MON than they named");

        (uint256 fg1,) = IPoolManager(address(manager)).getFeeGrowthGlobals(I);
        // Reverse the donate out of the fee-growth delta: donate adds amount * Q128 / liquidity.
        uint256 donated = ((fg1 - fg0) * liq) >> 128;
        uint256 levied = (_ledger() - lg0) + donated;

        // `consumed` is what the pool actually took, i.e. the trader's payment minus the levy.
        uint256 consumed = paid - (_ledger() - lg0) - donated;
        uint256 honest = (consumed * 100) / 10_000;

        // Allow one wei of slack per bucket for the fee-growth round trip.
        assertGe(levied + 3, honest, "named-amount basis under-charged the real trade");
    }

    // ------------------------------------------------- 4. the levy is always backed by a payment

    /// @dev Whatever the levy is, it is money the singleton actually received. Asserted on the
    ///      singleton's own MON balance against the hook's claim balance, across a binding price
    ///      limit — the exact shape gen-2's bypass used.
    function testFuzz_everyLevyIsBackedBySingletonBalance(uint96 named, uint16 limitPct) public {
        uint256 n = bound(uint256(named), 1e6, 500_000 ether);
        uint160 limit = uint160(uint256(SQRT_1_1) * bound(uint256(limitPct), 1, 99) / 100);

        uint256 bal0 = address(manager).balance;
        uint256 claim0 = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId());

        BalanceDelta d = swapper.swap{value: 2_000_000 ether}(
            K,
            SwapParams({zeroForOne: true, amountSpecified: -int256(n), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        uint256 paid = uint256(uint128(-d.amount0()));
        assertEq(address(manager).balance - bal0, paid, "singleton did not receive what the trader paid");
        uint256 claimed = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId()) - claim0;
        assertLe(claimed, paid, "hook minted claims the trader never funded");
    }
}
