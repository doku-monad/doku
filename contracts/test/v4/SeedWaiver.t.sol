// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

contract WaiverToken is ERC20 {
    constructor() ERC20("W", "W") {
        _mint(msg.sender, 10_000_000_000e18);
    }
}

/**
 * The seed waiver, and the three independent things that stop it being a hole.
 *
 * The graduation seed cannot be levied — POSM's slippage check validates the POST-hook delta, so a
 * levied seed makes `graduate()` revert on every market on both sinks. The waiver is how the hook
 * lets exactly that one mint through.
 *
 * It is also the most dangerous flag in the contract. It lives in transient storage, which dies
 * with the TRANSACTION rather than with the call that set it, and `graduate()` is permissionless —
 * so an armed-and-unclosed flag lets whoever called `graduate()` mint levy-exempt liquidity at
 * unbounded size on the way back out, in the same transaction, with no further permission.
 *
 * Three bindings prevent that, and each is tested here for what it independently stops:
 *
 *   E1  `endSeed` is called explicitly the instant the mint returns, rather than trusting
 *       end-of-transaction decay.
 *   E2  `Market.seeded` makes it one-shot per pool, degrading a leak from "unlimited free depth on
 *       every graduation" to "a griefer burns one waiver".
 *   E3  the add must match the EXACT shape recorded at `beginSeed` — liquidity and both ticks.
 *
 * `HookGate.t.sol` covers who may arm it. This covers what an armed one is actually worth, which
 * needs a live add and so could not live there.
 */
contract SeedWaiverTest is Test {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    /// @dev The shape `beginSeed` records, and the only one the waiver honours.
    int24 internal constant SEED_LO = -60_000;
    int24 internal constant SEED_HI = 60_000;
    uint128 internal constant SEED_LIQ = 500e18;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolModifyLiquidityTest internal lp;
    WaiverToken internal tok;
    PoolKey internal key;
    PoolId internal id;

    address internal graduator = address(0x6AD);
    address internal sinkAddr = address(0x51);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);

        tok = new WaiverToken();
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
        vm.deal(address(this), 500_000_000 ether);
    }

    function _add(int24 lo, int24 hi, uint128 liq, bytes32 salt) internal {
        lp.modifyLiquidity{value: 200_000 ether}(
            key,
            ModifyLiquidityParams({tickLower: lo, tickUpper: hi, liquidityDelta: int256(uint256(liq)), salt: salt}),
            ""
        );
    }

    /// @dev What the hook has taken, in both currencies, as ERC-6909 claims on the singleton.
    function _levied() internal view returns (uint256 mon, uint256 token) {
        mon = manager.balanceOf(address(hook), Currency.wrap(address(0)).toId());
        token = manager.balanceOf(address(hook), Currency.wrap(address(tok)).toId());
    }

    function _seeded() internal view returns (bool s) {
        s = hook.markets(id).seeded;
    }

    // --------------------------------------------------------------------------- E3: the shape

    /// @dev The waiver is armed and the add is the recorded shape, so it passes untouched. This is
    ///      the only case the flag is meant to cover, and without it `graduate()` reverts on every
    ///      market on both sinks.
    function test_theSeedWaiverIsConsumedByTheFirstMatchingAdd() public {
        vm.prank(graduator);
        hook.beginSeed(id, SEED_LIQ, SEED_LO, SEED_HI);

        (uint256 mon0, uint256 tok0) = _levied();
        _add(SEED_LO, SEED_HI, SEED_LIQ, 0);
        (uint256 mon1, uint256 tok1) = _levied();

        assertEq(mon1, mon0, "the seed mint was levied in MON");
        assertEq(tok1, tok0, "the seed mint was levied in token");
        assertTrue(_seeded(), "the waiver was not consumed");

        // E2: the flag is still armed for this transaction, but the one-shot bit is now set, so a
        // second identical add pays in full. This is the difference between a leak costing one
        // waiver and a leak costing unlimited exempt depth.
        _add(SEED_LO, SEED_HI, SEED_LIQ, bytes32(uint256(1)));
        (uint256 mon2, uint256 tok2) = _levied();
        assertTrue(mon2 > mon1 || tok2 > tok1, "a second add rode the already-consumed waiver");
    }

    /**
     * An armed waiver buys nothing for an add of the wrong shape. This is E3 on its own.
     *
     * The scenario is the real one: `graduate()` is permissionless, so an attacker calls it, and
     * for the duration of that transaction the flag is set. If the flag alone were sufficient, they
     * could mint any position they liked, levy-free, at any size. Every field is checked
     * separately, because a match on two out of three is exactly what a partial check would allow.
     */
    function test_aWaiverLeakedMidTransactionBuysNothing() public {
        vm.prank(graduator);
        hook.beginSeed(id, SEED_LIQ, SEED_LO, SEED_HI);

        // Wrong liquidity, right ticks.
        (uint256 mon0, uint256 tok0) = _levied();
        _add(SEED_LO, SEED_HI, SEED_LIQ + 1, bytes32(uint256(11)));
        (uint256 mon1, uint256 tok1) = _levied();
        assertTrue(mon1 > mon0 || tok1 > tok0, "an add with the wrong size rode the waiver");
        assertFalse(_seeded(), "a non-matching add consumed the waiver");

        // Right liquidity, wrong lower tick.
        _add(SEED_LO + 60, SEED_HI, SEED_LIQ, bytes32(uint256(12)));
        (uint256 mon2, uint256 tok2) = _levied();
        assertTrue(mon2 > mon1 || tok2 > tok1, "an add with the wrong lower tick rode the waiver");

        // Right liquidity, wrong upper tick.
        _add(SEED_LO, SEED_HI - 60, SEED_LIQ, bytes32(uint256(13)));
        (uint256 mon3, uint256 tok3) = _levied();
        assertTrue(mon3 > mon2 || tok3 > tok2, "an add with the wrong upper tick rode the waiver");

        assertFalse(_seeded(), "the waiver was consumed by something that was not the seed");
    }

    // ---------------------------------------------------------------------------- E1: the close

    /// @dev `endSeed` closes the flag the instant the mint returns rather than trusting transient
    ///      storage to decay at end of transaction. The difference only shows up inside a single
    ///      transaction — which is exactly where the attacker is.
    function test_theSeedFlagDoesNotSurviveItsOwnTransaction() public {
        vm.prank(graduator);
        hook.beginSeed(id, SEED_LIQ, SEED_LO, SEED_HI);
        vm.prank(graduator);
        hook.endSeed(id);

        (uint256 mon0, uint256 tok0) = _levied();
        _add(SEED_LO, SEED_HI, SEED_LIQ, 0);
        (uint256 mon1, uint256 tok1) = _levied();

        assertTrue(mon1 > mon0 || tok1 > tok0, "an add after endSeed was still exempt");
        assertFalse(_seeded(), "a levied add consumed the one-shot bit");
    }

    /**
     * The cross-transaction case is deliberately NOT tested here, and the reason is worth stating.
     *
     * A Foundry test is one transaction, so transient storage never clears inside it — `vm.prank`
     * changes the caller, not the transaction. Any test claiming to cross that boundary would be
     * asserting an EVM guarantee (TSTORE dies at end of transaction) while actually proving
     * nothing, which is worse than the gap.
     *
     * The design does not lean on that boundary anyway. E2 is what covers it: `Market.seeded` is
     * ordinary storage, so a pool whose seed was consumed stays consumed forever regardless of what
     * transient storage does — and `test_aRogueGraduatorCannotArmTheWaiverOnALiveMarket` in
     * `HookGate.t.sol` is the assertion. A pool cannot exist unseeded across transactions in the
     * first place, because `initialize` is graduator-gated and `graduate()` is atomic.
     */

    // ------------------------------------------------------------------- the composite property

    /// @dev The three bindings are independent, and the point of having all three is that any one
    ///      of them failing still leaves the hole closed. Asserted as a table: for each way an
    ///      attacker could be positioned, the add is levied.
    function test_noCombinationShortOfTheRealSeedIsExempt() public {
        (uint256 mon0, uint256 tok0) = _levied();

        // Never armed at all — the ordinary case for any third-party LP.
        _add(SEED_LO, SEED_HI, SEED_LIQ, bytes32(uint256(21)));
        (uint256 a, uint256 b) = _levied();
        assertTrue(a > mon0 || b > tok0, "an unarmed add was exempt");

        // Armed, then closed, then the exact shape.
        vm.prank(graduator);
        hook.beginSeed(id, SEED_LIQ, SEED_LO, SEED_HI);
        vm.prank(graduator);
        hook.endSeed(id);
        _add(SEED_LO, SEED_HI, SEED_LIQ, bytes32(uint256(22)));
        (uint256 c, uint256 d) = _levied();
        assertTrue(c > a || d > b, "an add after the waiver closed was exempt");

        // Armed and never closed, but the wrong shape.
        vm.prank(graduator);
        hook.beginSeed(id, SEED_LIQ, SEED_LO, SEED_HI);
        _add(SEED_LO + 120, SEED_HI, SEED_LIQ, bytes32(uint256(23)));
        (uint256 e, uint256 f) = _levied();
        assertTrue(e > c || f > d, "an armed-but-mismatched add was exempt");

        assertFalse(_seeded(), "none of these should have consumed the waiver");
    }
}
