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
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract R3Tok is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 1e33);
    }
}

/**
 * # Round 3 — the hook's ledger partition, from a fixture built independently of round 1's
 *
 * Round 1's `Gen4HookLedgerHunt` established the partition over three markets sharing ONE ERC-20
 * quote. This fixture is deliberately a different shape, because the brief for this round is a
 * broad pass rather than a re-run:
 *
 *   M0  NATIVE  quote, REWARDS, creator tax fuzzed        quoteIsCurrency0 == true  (always)
 *   M1  ERC-20  quote, CREATOR, creator tax fuzzed        quoteIsCurrency0 == true  (token sorts ABOVE)
 *   M2  ERC-20  quote, BURN,    creator tax fuzzed        quoteIsCurrency0 == false (token sorts BELOW)
 *   M3  ERC-20  quote, REWARDS, creator tax fuzzed        quoteIsCurrency0 == false (token sorts BELOW)
 *
 * so the ERC-20 quote is shared by three markets spanning both orientations AND all three sinks,
 * the CREATOR sink is exercised (round 1's fixture has none), a native market runs alongside, and
 * the creator tax is a fuzz parameter over its whole legal range 0..1000 bps rather than two fixed
 * values.
 *
 * The invariant is stated over EVERY currency the fixture touches, as an equality, and it includes
 * both the claim-side books and the materialised ones:
 *
 *   claims(C) == SUM over markets of
 *                  pendingProtocol[m]      where quoteOf[m]      == C
 *                + owedTax[m]              where quoteOf[m]      == C
 *                + pendingSink[m]          where sinkCurrency(m) == C
 *                + pendingProtocolToken[m] where tokenOf[m]      == C
 *
 *   real(C)   == owedTreasury[C] + SUM of owedSink[m] where sinkCurrency(m) == C
 *
 * `owedTax` is in the first line on purpose: it is minted as a claim by `_settleLeg` and is only
 * burned by `pullTax`, so a partition that omitted it would be satisfied by a hook that minted tax
 * claims it could never burn — and by one that burned claims it never minted.
 *
 * The action set adds three entry points round 1's fuzz does not drive: both forms of
 * `creditCurveTax` (permissionless, and the only way a REAL balance enters the hook without a
 * matching claim burn) and `pullTax`.
 */
abstract contract Round3LedgerBase is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using CurrencyLibrary for Currency;

    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    PoolDonateTest internal donor;

    address internal graduator = address(0x6AD);
    address internal creatorSinkAddr = address(0xC5EE);

    R3Tok internal quote;

    struct Mkt {
        PoolKey key;
        PoolId id;
        address token;
        address sinkAddr;
        uint8 sinkKind;
        Currency quoteC;
    }

    Mkt[4] internal mkts;
    Currency internal Q;
    Currency internal NATIVE = Currency.wrap(address(0));

    receive() external payable {}

    bool internal deployed;

    /// @dev The expensive half — `HookMiner.find` brute-forces up to 16,384 salts in Solidity — is
    ///      done ONCE, in `setUp`. A fuzz test that re-mined the hook on every run would spend all
    ///      its budget on the miner.
    function _deploy() internal {
        if (deployed) return;
        deployed = true;
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        donor = new PoolDonateTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        quote = new R3Tok("Q");
        Q = Currency.wrap(address(quote));
        quote.approve(address(lp), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        quote.approve(address(donor), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);

        // Launch tokens: one for the native market, two that sort BELOW the ERC-20 quote and one
        // that sorts ABOVE it, so both `quoteIsCurrency0` orientations are covered.
        R3Tok above;
        R3Tok[2] memory below;
        uint256 nBelow;
        R3Tok nativeTok;
        for (uint256 i; i < 256 && (address(above) == address(0) || nBelow < 2); ++i) {
            R3Tok t = new R3Tok("T");
            if (address(t) > address(quote)) {
                if (address(above) == address(0)) above = t;
            } else if (nBelow < 2) {
                below[nBelow++] = t;
            }
        }
        require(address(above) != address(0) && nBelow == 2, "orientation search failed");
        nativeTok = new R3Tok("N");

        vm.deal(address(this), 1_000_000 ether);

        tokAbove = above;
        tokBelow0 = below[0];
        tokBelow1 = below[1];
        tokNative = nativeTok;
        // Hoisted: `f(g())` evaluates `g()` first and would consume an armed prank.
        SINK_REWARDS = hook.SINK_REWARDS();
        SINK_CREATOR = hook.SINK_CREATOR();
        SINK_BURN = hook.SINK_BURN();
    }

    R3Tok internal tokAbove;
    R3Tok internal tokBelow0;
    R3Tok internal tokBelow1;
    R3Tok internal tokNative;
    uint8 internal SINK_REWARDS;
    uint8 internal SINK_CREATOR;
    uint8 internal SINK_BURN;

    function _setUpMarkets(uint16[4] memory taxes) internal {
        _deploy();
        mkts[0] = _open(tokNative, address(0), SINK_REWARDS, address(0x5100), taxes[0]);
        mkts[1] = _open(tokAbove, address(quote), SINK_CREATOR, creatorSinkAddr, taxes[1]);
        mkts[2] = _open(tokBelow0, address(quote), SINK_BURN, address(0x5102), taxes[2]);
        mkts[3] = _open(tokBelow1, address(quote), SINK_REWARDS, address(0x5103), taxes[3]);
    }

    function _open(R3Tok t, address quoteAddr, uint8 sinkKind, address sinkAddr, uint16 tax)
        internal
        returns (Mkt memory m)
    {
        bool quoteIsC0 = quoteAddr < address(t);
        m.key = PoolKey({
            currency0: Currency.wrap(quoteIsC0 ? quoteAddr : address(t)),
            currency1: Currency.wrap(quoteIsC0 ? address(t) : quoteAddr),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        m.id = m.key.toId();
        m.token = address(t);
        m.sinkAddr = sinkAddr;
        m.sinkKind = sinkKind;
        m.quoteC = Currency.wrap(quoteAddr);

        vm.startPrank(graduator);
        manager.initialize(m.key, SQRT_1_1);
        hook.registerPool(m.key, address(t), sinkKind, sinkAddr, tax);
        vm.stopPrank();

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        t.approve(address(donor), type(uint256).max);

        lp.modifyLiquidity{value: quoteAddr == address(0) ? 5_000 ether : 0}(
            m.key,
            ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}),
            ""
        );
    }

    // ------------------------------------------------------------------------- the invariant

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    function _real(Currency c) internal view returns (uint256) {
        return c.isAddressZero() ? address(hook).balance : ERC20(Currency.unwrap(c)).balanceOf(address(hook));
    }

    function _sinkCurrency(uint256 i) internal view returns (Currency) {
        return mkts[i].sinkKind == SINK_BURN ? Currency.wrap(mkts[i].token) : mkts[i].quoteC;
    }

    /// @dev The claim-side books denominated in `c`, summed over every market in the fixture.
    function _claimBooks(Currency c) internal view returns (uint256 s) {
        for (uint256 i; i < mkts.length; ++i) {
            PoolId id = mkts[i].id;
            if (Currency.unwrap(mkts[i].quoteC) == Currency.unwrap(c)) {
                s += hook.pendingProtocol(id) + hook.owedTax(id);
            }
            if (Currency.unwrap(_sinkCurrency(i)) == Currency.unwrap(c)) {
                s += hook.pendingSink(id);
            }
            if (mkts[i].token == Currency.unwrap(c)) {
                s += hook.pendingProtocolToken(id);
            }
        }
    }

    function _realBooks(Currency c) internal view returns (uint256 s) {
        s = hook.owedTreasury(c);
        for (uint256 i; i < mkts.length; ++i) {
            if (Currency.unwrap(_sinkCurrency(i)) == Currency.unwrap(c)) s += hook.owedSink(mkts[i].id);
        }
    }

    function _invariant(string memory where) internal view {
        Currency[6] memory cs =
            [NATIVE, Q, Currency.wrap(mkts[0].token), Currency.wrap(mkts[1].token), Currency.wrap(mkts[2].token), Currency.wrap(mkts[3].token)];
        for (uint256 i; i < cs.length; ++i) {
            assertEq(_claims(cs[i]), _claimBooks(cs[i]), string.concat("claims != books @ ", where));
            assertEq(_real(cs[i]), _realBooks(cs[i]), string.concat("real != owed @ ", where));
        }
    }

    // ------------------------------------------------------------------------------- actions

    function _swap(uint256 i, bool zeroForOne, int256 amountSpecified) internal {
        Mkt storage m = mkts[i];
        uint256 val = Currency.unwrap(m.key.currency0) == address(0) && zeroForOne ? 500 ether : 0;
        swapper.swap{value: val}(
            m.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _trySwap(uint256 i, bool zeroForOne, int256 amountSpecified) internal {
        try this.extSwap(i, zeroForOne, amountSpecified) {} catch {}
    }

    function extSwap(uint256 i, bool zeroForOne, int256 amountSpecified) external {
        require(msg.sender == address(this));
        _swap(i, zeroForOne, amountSpecified);
    }

    function _tryLiq(uint256 i, int24 lo, int24 hi, int256 delta) internal {
        try this.extLiq(i, lo, hi, delta) {} catch {}
    }

    function extLiq(uint256 i, int24 lo, int24 hi, int256 delta) external {
        require(msg.sender == address(this));
        Mkt storage m = mkts[i];
        lp.modifyLiquidity{value: Currency.unwrap(m.key.currency0) == address(0) && delta > 0 ? 500 ether : 0}(
            m.key, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: delta, salt: 0}), ""
        );
    }
}

contract Round3LedgerTest is Round3LedgerBase {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    function setUp() public {
        _setUpMarkets([uint16(0), 1000, 300, 777]);
    }

    /// @notice The straight-line pass: every entry point, in order, partition asserted after each.
    function test_everyEntryPointKeepsThePartition() public {
        _invariant("start");

        for (uint256 i; i < 4; ++i) {
            _swap(i, true, -50 ether);
            _invariant("exactIn 0->1");
            _swap(i, false, -50 ether);
            _invariant("exactIn 1->0");
            _swap(i, true, 1 ether);
            _invariant("exactOut 0->1");
            _swap(i, false, 1 ether);
            _invariant("exactOut 1->0");

            _tryLiq(i, -6000, 6000, 100 ether);
            _invariant("maker add");
            _tryLiq(i, -6000, 6000, -100 ether);
            _invariant("maker remove");
            _tryLiq(i, -6000, 6000, 0);
            _invariant("maker collect");

            hook.sweep(mkts[i].id);
            _invariant("sweep");
        }

        // The two permissionless credit forms, on the two markets that admit them.
        hook.creditCurveTax{value: 3 ether}(mkts[0].id);
        _invariant("creditCurveTax native");
        hook.creditCurveTax(mkts[1].id, 7 ether);
        _invariant("creditCurveTax erc20 (CREATOR)");
        hook.creditCurveTax(mkts[3].id, 11 ether);
        _invariant("creditCurveTax erc20 (REWARDS)");

        hook.pullTreasury(Q);
        hook.pullTreasury(NATIVE);
        for (uint256 i; i < 4; ++i) hook.pullTreasury(Currency.wrap(mkts[i].token));
        _invariant("pullTreasury");

        for (uint256 i; i < 4; ++i) {
            vm.prank(mkts[i].sinkAddr);
            hook.pullSink(mkts[i].id);
            _invariant("pullSink");
        }
        for (uint256 i; i < 4; ++i) {
            vm.prank(creatorSinkAddr);
            hook.pullTax(mkts[i].id);
            _invariant("pullTax");
        }
    }

    /// @notice 10,000 randomised sequences across four markets, three sinks, both orientations,
    ///         a native market and a shared ERC-20 quote.
    function testFuzz_partitionHoldsOverRandomSequences(uint8[14] memory acts, uint64[14] memory sizes) public {
        for (uint256 i; i < acts.length; ++i) {
            uint256 mi = uint256(acts[i]) % 4;
            uint256 n = bound(uint256(sizes[i]), 1, 200 ether);
            uint8 a = uint8(uint256(keccak256(abi.encode(acts[i], i))) % 12);

            if (a == 0) {
                _trySwap(mi, true, -int256(n));
            } else if (a == 1) {
                _trySwap(mi, false, -int256(n));
            } else if (a == 2) {
                _trySwap(mi, true, int256(n / 1000 + 1));
            } else if (a == 3) {
                _trySwap(mi, false, int256(n / 1000 + 1));
            } else if (a == 4) {
                _tryLiq(mi, -6000, 6000, int256(n / 1000 + 1));
            } else if (a == 5) {
                _tryLiq(mi, -6000, 6000, -int256(n / 1000 + 1));
            } else if (a == 6) {
                _tryLiq(mi, 6000, 12000, int256(n / 1000 + 1));
            } else if (a == 7) {
                try hook.sweep(mkts[mi].id) {} catch {}
            } else if (a == 8) {
                try hook.pullTreasury(mkts[mi].quoteC) {} catch {}
                try hook.pullTreasury(Currency.wrap(mkts[mi].token)) {} catch {}
            } else if (a == 9) {
                vm.prank(mkts[mi].sinkAddr);
                try hook.pullSink(mkts[mi].id) {} catch {}
            } else if (a == 10) {
                vm.prank(creatorSinkAddr);
                try hook.pullTax(mkts[mi].id) {} catch {}
            } else {
                if (Currency.unwrap(mkts[mi].quoteC) == address(0)) {
                    try hook.creditCurveTax{value: n}(mkts[mi].id) {} catch {}
                } else {
                    try hook.creditCurveTax(mkts[mi].id, n) {} catch {}
                }
            }
            _invariant("fuzz");
        }
    }
}

/// @dev The same fixture with the creator tax as a fuzz parameter over its whole legal range.
contract Round3LedgerTaxFuzzTest is Round3LedgerBase {
    using CurrencyLibrary for Currency;

    function setUp() public {
        _deploy();
    }

    function testFuzz_partitionHoldsAtEveryCreatorTax(uint16 t0, uint16 t1, uint16 t2, uint16 t3, uint64 size)
        public
    {
        _setUpMarkets(
            [
                uint16(bound(uint256(t0), 0, 1000)),
                uint16(bound(uint256(t1), 0, 1000)),
                uint16(bound(uint256(t2), 0, 1000)),
                uint16(bound(uint256(t3), 0, 1000))
            ]
        );
        uint256 n = bound(uint256(size), 1e12, 200 ether);

        for (uint256 i; i < 4; ++i) {
            _trySwap(i, true, -int256(n));
            _invariant("tax fuzz in");
            _trySwap(i, false, int256(n / 1000 + 1));
            _invariant("tax fuzz out");
            _tryLiq(i, -6000, 6000, int256(n));
            _invariant("tax fuzz add");
            _tryLiq(i, -6000, 6000, -int256(n));
            _invariant("tax fuzz remove");
            try hook.sweep(mkts[i].id) {} catch {}
            _invariant("tax fuzz sweep");
            vm.prank(creatorSinkAddr);
            try hook.pullTax(mkts[i].id) {} catch {}
            _invariant("tax fuzz pullTax");
            vm.prank(mkts[i].sinkAddr);
            try hook.pullSink(mkts[i].id) {} catch {}
            _invariant("tax fuzz pullSink");
            try hook.pullTreasury(mkts[i].quoteC) {} catch {}
            try hook.pullTreasury(Currency.wrap(mkts[i].token)) {} catch {}
            _invariant("tax fuzz pullTreasury");
        }
    }
}
