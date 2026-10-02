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

contract GTok is ERC20 {
    constructor(string memory n) ERC20(n, n) {
        _mint(msg.sender, 1e33);
    }
}

/**
 * # Generation 4, round 1 — the hook's ledger partition, re-established over the NEW bucket
 *
 * Generation 4 added `pendingProtocolToken` and made `makerToken` non-zero, so for the first time
 * the hook accrues a TOKEN-denominated amount on a market whose sink is paid in the QUOTE. The
 * 2026-09-11 pass proved the partition over `test/audit/HookHunt.t.sol`'s fixture, which is
 * three markets that all quote in NATIVE MON.
 *
 * That fixture cannot see half of the new code. A native quote is `address(0)`, so it sorts to
 * `currency0` ALWAYS — every market in it has `quoteIsCurrency0 == true`, and `_accrueMaker`'s two
 * branches are therefore permanently wired to (currency0 -> quote ledger, currency1 -> token
 * ledger). An ERC-20 quote sorts wherever its address falls, so on roughly half of all real ERC-20
 * markets the wiring is the OTHER way round, and a `_isQuote` that had been written backwards
 * would be invisible to every existing test.
 *
 * This fixture is therefore three markets sharing ONE ERC-20 quote, deliberately spanning both
 * orientations:
 *
 *   M1  REWARDS, token sorts BELOW the quote   -> quoteIsCurrency0 = true
 *   M2  REWARDS, token sorts ABOVE the quote   -> quoteIsCurrency0 = false
 *   M3  BURN,    token sorts ABOVE the quote   -> quoteIsCurrency0 = false
 *
 * and the invariant is asserted as an EQUALITY per currency, not a bound:
 *
 *   claims(C)  == sum of every unmaterialised ledger denominated in C
 *   real(C)    == owedTreasury[C] + sum of owedSink[m] for markets whose sink currency is C
 *
 * A token-denominated amount reaching a quote-denominated ledger breaks the first line on two
 * currencies at once; a wrong-currency payout breaks the second.
 */
abstract contract Gen4LedgerBase is Test {
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
    address internal creatorSinkAddr = address(0xC5);
    address internal sink1 = address(0x51);
    address internal sink2 = address(0x52);
    address internal sink3 = address(0x53);

    GTok internal quote;
    GTok internal tok1; // below quote
    GTok internal tok2; // above quote
    GTok internal tok3; // above quote

    PoolKey internal k1;
    PoolKey internal k2;
    PoolKey internal k3;
    PoolId internal id1;
    PoolId internal id2;
    PoolId internal id3;

    Currency internal Q;

    receive() external payable {}

    function setUp() public virtual {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        donor = new PoolDonateTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, creatorSinkAddr);
        hook.setGraduator(graduator, true);

        quote = new GTok("Q");
        Q = Currency.wrap(address(quote));

        // Deploy launch tokens until both orientations exist. Nonce-deterministic, so the loop
        // terminates in a handful of deployments.
        GTok below;
        GTok[2] memory above;
        uint256 nAbove;
        for (uint256 i; i < 64 && (address(below) == address(0) || nAbove < 2); ++i) {
            GTok t = new GTok("T");
            if (address(t) < address(quote)) {
                if (address(below) == address(0)) below = t;
            } else if (nAbove < 2) {
                above[nAbove++] = t;
            }
        }
        require(address(below) != address(0) && nAbove == 2, "orientation search failed");
        tok1 = below;
        tok2 = above[0];
        tok3 = above[1];

        k1 = _open(tok1, hook.SINK_REWARDS(), sink1, 0);
        k2 = _open(tok2, hook.SINK_REWARDS(), sink2, 500);
        k3 = _open(tok3, hook.SINK_BURN(), sink3, 300);
        id1 = k1.toId();
        id2 = k2.toId();
        id3 = k3.toId();

        quote.approve(address(lp), type(uint256).max);
        quote.approve(address(swapper), type(uint256).max);
        quote.approve(address(donor), type(uint256).max);
        quote.approve(address(hook), type(uint256).max);
    }

    function _open(GTok t, uint8 sinkKind, address sinkAddr, uint16 tax) internal returns (PoolKey memory k) {
        bool tokenIsC0 = address(t) < address(quote);
        k = PoolKey({
            currency0: Currency.wrap(tokenIsC0 ? address(t) : address(quote)),
            currency1: Currency.wrap(tokenIsC0 ? address(quote) : address(t)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, address(t), sinkKind, sinkAddr, tax);
        vm.stopPrank();

        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        t.approve(address(donor), type(uint256).max);
        quote.approve(address(lp), type(uint256).max);

        lp.modifyLiquidity(
            k,
            ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 2_000 ether, salt: 0}),
            ""
        );
        return k;
    }

    function _claims(Currency c) internal view returns (uint256) {
        return manager.balanceOf(address(hook), c.toId());
    }

    function _real(Currency c) internal view returns (uint256) {
        return c.isAddressZero() ? address(hook).balance : ERC20(Currency.unwrap(c)).balanceOf(address(hook));
    }

    /// @dev The partition, as an equality per currency.
    function _invariant() internal view {
        // The shared ERC-20 quote. Every market's `pendingProtocol` and `owedTax` is denominated in
        // it; so is `pendingSink` for the two REWARDS markets. M3 is BURN, so its `pendingSink` is
        // its own token and does NOT belong here.
        uint256 quoteBooks = hook.pendingProtocol(id1) + hook.pendingProtocol(id2) + hook.pendingProtocol(id3)
            + hook.owedTax(id1) + hook.owedTax(id2) + hook.owedTax(id3) + hook.pendingSink(id1)
            + hook.pendingSink(id2);
        assertEq(_claims(Q), quoteBooks, "shared quote: claims != books");

        assertEq(
            _claims(Currency.wrap(address(tok1))), hook.pendingProtocolToken(id1), "tok1 claims != book"
        );
        assertEq(
            _claims(Currency.wrap(address(tok2))), hook.pendingProtocolToken(id2), "tok2 claims != book"
        );
        // The BURN market is the one place two token-denominated books coexist.
        assertEq(
            _claims(Currency.wrap(address(tok3))),
            hook.pendingSink(id3) + hook.pendingProtocolToken(id3),
            "tok3 claims != books"
        );

        // Materialised balances back every owed line, exactly.
        assertEq(
            _real(Q),
            hook.owedTreasury(Q) + hook.owedSink(id1) + hook.owedSink(id2),
            "shared quote: real != owed"
        );
        assertEq(
            _real(Currency.wrap(address(tok3))),
            hook.owedTreasury(Currency.wrap(address(tok3))) + hook.owedSink(id3),
            "tok3: real != owed"
        );
        assertEq(
            _real(Currency.wrap(address(tok1))),
            hook.owedTreasury(Currency.wrap(address(tok1))),
            "tok1: real != owed"
        );
        assertEq(
            _real(Currency.wrap(address(tok2))),
            hook.owedTreasury(Currency.wrap(address(tok2))),
            "tok2: real != owed"
        );
    }

    function _key(uint256 i) internal view returns (PoolKey memory) {
        if (i == 0) return k1;
        if (i == 1) return k2;
        return k3;
    }

    function _id(uint256 i) internal view returns (PoolId) {
        if (i == 0) return id1;
        if (i == 1) return id2;
        return id3;
    }

    function _sinkAddr(uint256 i) internal view returns (address) {
        if (i == 0) return sink1;
        if (i == 1) return sink2;
        return sink3;
    }
}

contract Gen4HookLedgerHunt is Gen4LedgerBase {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;

    /// @notice The straight-line version, so a break is readable before the fuzzer finds it.
    function test_theNewBucketDoesNotBreakThePartition() public {
        _invariant();

        for (uint256 i; i < 3; ++i) {
            PoolKey memory k = _key(i);
            _swapExactIn(k, true, 50 ether);
            _invariant();
            _swapExactIn(k, false, 50 ether);
            _invariant();
            _swapExactOut(k, true, 1 ether);
            _invariant();
            _swapExactOut(k, false, 1 ether);
            _invariant();

            // The maker levy, both legs, both directions. This is the generation-4 change.
            lp.modifyLiquidity(
                k,
                ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 100 ether, salt: 0}),
                ""
            );
            _invariant();
            lp.modifyLiquidity(
                k,
                ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: -100 ether, salt: 0}),
                ""
            );
            _invariant();

            hook.sweep(_id(i));
            _invariant();
        }

        hook.pullTreasury(Q);
        _invariant();
        hook.pullTreasury(Currency.wrap(address(tok1)));
        _invariant();
        hook.pullTreasury(Currency.wrap(address(tok2)));
        _invariant();
        hook.pullTreasury(Currency.wrap(address(tok3)));
        _invariant();

        for (uint256 i; i < 3; ++i) {
            vm.prank(_sinkAddr(i));
            hook.pullSink(_id(i));
            _invariant();
        }
        for (uint256 i; i < 3; ++i) {
            vm.prank(creatorSinkAddr);
            hook.pullTax(_id(i));
            _invariant();
        }
    }

    /// @notice The token-side maker levy actually books to the TOKEN ledger on BOTH orientations.
    /// @dev The point of the fixture. M1's token is currency0 and M2's is currency1; a `_isQuote`
    ///      written on the index rather than on `quoteIsCurrency0` books one of them backwards, and
    ///      a native-quote fixture can never tell.
    function test_makerTokenLevyLandsInTheTokenBucketOnBothOrientations() public {
        lp.modifyLiquidity(
            k1, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}), ""
        );
        lp.modifyLiquidity(
            k2, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}), ""
        );

        assertGt(hook.pendingProtocolToken(id1), 0, "M1 token-leg maker levy not booked");
        assertGt(hook.pendingProtocolToken(id2), 0, "M2 token-leg maker levy not booked");
        assertGt(hook.pendingProtocol(id1), 0, "M1 quote-leg maker levy not booked");
        assertGt(hook.pendingProtocol(id2), 0, "M2 quote-leg maker levy not booked");

        // And the token books are backed by token claims, not quote claims.
        assertEq(_claims(Currency.wrap(address(tok1))), hook.pendingProtocolToken(id1));
        assertEq(_claims(Currency.wrap(address(tok2))), hook.pendingProtocolToken(id2));
        _invariant();
    }

    /// @notice `unlockCallback`'s comment claims the sink burn and the protocol-token burn "never
    ///         both run on one market". On a BURN market they demonstrably can.
    /// @dev Not a loss — the two burns name the same currency and sum to exactly what was minted,
    ///      which this proves by re-asserting the partition after the sweep. It is recorded because
    ///      the comment states an invariant the code does not have, and a future edit that trusts it
    ///      (one summed burn keyed off `sinkCurrency`, say) would be wrong on a non-BURN market.
    function test_aBurnMarketCanHoldBothTokenBooksAtOnce() public {
        // Push the price outside the seeded range so the token-leg swap levy has nobody to donate
        // to and falls through to `pendingSink`.
        _swapExactIn(k3, address(tok3) < address(quote), 50 ether);
        _pushOutOfRange(k3);
        _swapExactIn(k3, address(tok3) < address(quote), 5 ether);

        // And a maker levy, which books the token leg to `pendingProtocolToken`.
        lp.modifyLiquidity(
            k3, ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 10 ether, salt: 0}), ""
        );

        console2.log("BURN pendingSink (token)         :", hook.pendingSink(id3));
        console2.log("BURN pendingProtocolToken (token):", hook.pendingProtocolToken(id3));

        if (hook.pendingSink(id3) != 0 && hook.pendingProtocolToken(id3) != 0) {
            emit log_string("both token books non-zero on one BURN market: the comment is wrong");
        }
        _invariant();
        hook.sweep(id3);
        _invariant();
    }

    /// @notice A sweep whose ONLY non-zero book is the new one.
    /// @dev `HookHunt`'s fuzz gates its sweep on `pendingProtocol != 0 || pendingSink != 0`, so the
    ///      protTok-only shape — which is exactly what a single-sided token-only add produces —
    ///      is never swept there.
    function test_sweepWithOnlyTheTokenBookSet() public {
        // Clear the books the fixture's own two-sided seed add created, so what is left afterwards
        // is exactly what the single-sided add below produced.
        hook.sweep(id1);
        assertEq(hook.pendingProtocol(id1), 0, "sweep left a quote book");
        assertEq(hook.pendingProtocolToken(id1), 0, "sweep left a token book");

        // A single-sided position in the token alone: its quote base is zero, so only the token leg
        // is levied.
        bool tokenIsC0 = address(tok1) < address(quote);
        (int24 lo, int24 hi) = tokenIsC0 ? (int24(6000), int24(12000)) : (int24(-12000), int24(-6000));
        lp.modifyLiquidity(
            k1, ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: 100 ether, salt: 0}), ""
        );

        assertEq(hook.pendingProtocol(id1), 0, "quote book should be empty for a token-only add");
        assertGt(hook.pendingProtocolToken(id1), 0, "token book should be set");
        _invariant();

        uint256 expect = hook.pendingProtocolToken(id1);
        uint256 quoteTreasuryBefore = hook.owedTreasury(Q);
        uint256 tokTreasuryBefore = hook.owedTreasury(Currency.wrap(address(tok1)));
        hook.sweep(id1);
        assertEq(
            hook.owedTreasury(Currency.wrap(address(tok1))) - tokTreasuryBefore,
            expect,
            "token sweep wrong currency/amount"
        );
        assertEq(hook.owedTreasury(Q), quoteTreasuryBefore, "token units reached the quote treasury book");
        _invariant();

        uint256 treasuryTokBefore = tok1.balanceOf(TREASURY);
        hook.pullTreasury(Currency.wrap(address(tok1)));
        assertEq(
            tok1.balanceOf(TREASURY) - treasuryTokBefore,
            expect + tokTreasuryBefore,
            "treasury paid in the wrong currency"
        );
        _invariant();
    }

    /// @notice 10,000 randomised sequences over three markets sharing one ERC-20 quote.
    function testFuzz_noSequenceBreaksThePartition(uint8[12] memory acts, uint64[12] memory sizes) public {
        for (uint256 i; i < acts.length; ++i) {
            uint256 mi = i % 3;
            PoolKey memory k = _key(mi);
            PoolId pid = _id(mi);
            uint256 n = bound(uint256(sizes[i]), 1, 200 ether);
            uint8 a = acts[i] % 9;

            if (a == 0) {
                _try(k, true, -int256(n));
            } else if (a == 1) {
                _try(k, false, -int256(n));
            } else if (a == 2) {
                _try(k, false, int256(n / 1000 + 1));
            } else if (a == 3) {
                _try(k, true, int256(n / 1000 + 1));
            } else if (a == 4) {
                try lp.modifyLiquidity(
                    k,
                    ModifyLiquidityParams({
                        tickLower: -6000,
                        tickUpper: 6000,
                        liquidityDelta: int256(n / 1000 + 1),
                        salt: 0
                    }),
                    ""
                ) {} catch {}
            } else if (a == 5) {
                // The v4 fee-collect shape, which lands on the REMOVE branch with delta 0.
                try lp.modifyLiquidity(
                    k, ModifyLiquidityParams({tickLower: -60000, tickUpper: 60000, liquidityDelta: 0, salt: 0}), ""
                ) {} catch {}
            } else if (a == 6) {
                // Unconditional: a protTok-only sweep is a shape worth reaching.
                try hook.sweep(pid) {} catch {}
            } else if (a == 7) {
                hook.pullTreasury(Q);
                hook.pullTreasury(Currency.wrap(address(tok1)));
                hook.pullTreasury(Currency.wrap(address(tok2)));
                hook.pullTreasury(Currency.wrap(address(tok3)));
                vm.prank(_sinkAddr(mi));
                hook.pullSink(pid);
            } else {
                // The permissionless ERC-20 curve-tax credit, on a quote-paying market.
                if (mi != 2) {
                    try hook.creditCurveTax(pid, n / 1000 + 1) {} catch {}
                }
                vm.prank(creatorSinkAddr);
                try hook.pullTax(pid) {} catch {}
            }
            _invariant();
        }
    }

    // ------------------------------------------------------------------------------- helpers

    function _try(PoolKey memory k, bool zeroForOne, int256 amount) internal {
        try swapper.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: amount,
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        ) {} catch {}
    }

    function _swapExactIn(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        _try(k, zeroForOne, -int256(amount));
    }

    function _swapExactOut(PoolKey memory k, bool zeroForOne, uint256 amount) internal {
        _try(k, zeroForOne, int256(amount));
    }

    function _pushOutOfRange(PoolKey memory k) internal {
        _try(k, true, -int256(50_000 ether));
    }
}
