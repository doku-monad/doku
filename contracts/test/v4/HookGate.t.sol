// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

/// @notice The gate is the whole security boundary: a pool bearing this hook cannot come into
///         existence except through a graduator, and its terms are frozen the moment it does.
contract HookGateTest is Test {
    uint160 internal constant FLAGS = 0x2FCF;
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);

    PoolManager internal manager;
    DokuHook internal hook;

    // Cached in setUp. Reading these as external calls inside an armed `expectRevert` would make
    // the getter, not the call under test, the thing being asserted on — and would consume the
    // prank as well.
    uint8 internal BURN;
    uint8 internal REWARDS;
    uint16 internal PROT;
    uint16 internal SINKB;
    uint24 internal LP_FEE;
    int24 internal SPACING;
    uint256 internal marketsSlot;

    address internal graduator = address(0x6AD);
    address internal stranger = address(0x5747);
    address internal token = address(0x70CE);
    address internal sinkAddr = address(0x51);

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);
        BURN = hook.SINK_BURN();
        REWARDS = hook.SINK_REWARDS();
        PROT = hook.PROTOCOL_LEVY_BPS();
        SINKB = hook.SINK_LEVY_BPS();
        LP_FEE = hook.POOL_LP_FEE();
        SPACING = hook.POOL_TICK_SPACING();
        marketsSlot = _findMarketsSlot();
    }

    /// @dev Found rather than hard-coded. The base slot depends on the linearised inheritance
    ///      layout (Ownable, Ownable2Step, ReentrancyGuard, then ours), so a hard-coded number
    ///      turns a future base-class change into a test that pokes a neighbouring field and still
    ///      passes. Register a throwaway market and see which base slot lights up.
    function _findMarketsSlot() internal returns (uint256) {
        PoolKey memory probe = _key(address(0xFEED));
        vm.prank(graduator);
        hook.registerPool(probe, address(0xFEED), BURN, sinkAddr, 0);
        PoolId id = PoolIdLibrary.toId(probe);
        for (uint256 base; base < 12; ++base) {
            if (vm.load(address(hook), keccak256(abi.encode(id, base))) != bytes32(0)) return base;
        }
        revert("markets slot not found");
    }

    function _key(address token_) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token_),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /// @dev Safe to read the token off `currency1` only because every key this file builds is
    ///      native-quoted, so MON's `address(0)` always sorts to currency0.
    function _register(PoolKey memory k, uint8 sink) internal {
        vm.prank(graduator);
        hook.registerPool(k, Currency.unwrap(k.currency1), sink, sinkAddr, 0);
    }

    // ------------------------------------------------------------------------------- the gate

    function test_onlyTheGraduatorCanInitializeAPoolBearingOurHook() public {
        PoolKey memory k = _key(token);
        vm.prank(stranger);
        vm.expectRevert();
        manager.initialize(k, SQRT_1_1);

        vm.prank(graduator);
        manager.initialize(k, SQRT_1_1); // does not revert
    }

    /// @dev GENERATION 5 CHANGED THE SUBJECT OF THIS TEST, and the change is deliberate. The
    ///      property — a revoked graduator cannot open a pool — is unchanged. What moved is WHICH
    ///      graduator may be revoked: `setGraduator(g, false)` now reverts `GraduatorInUse(g)` once
    ///      `g` has registered a market, because the curves already pinned to `g` would otherwise
    ///      be frozen by that one owner call (see `DokuHook.setGraduator`). `setUp`'s
    ///      `_findMarketsSlot` registers a probe under `graduator`, so `graduator` is pinned from
    ///      the first line of every test in this file and is no longer a legal subject here.
    ///
    ///      A never-used graduator is, and it is the only one this property was ever about: the
    ///      gate is closed for an address the owner allowlisted and then thought better of.
    function test_revokingAGraduatorClosesTheGate() public {
        address spare = address(0x5A5A);
        hook.setGraduator(spare, true);
        vm.prank(spare);
        manager.initialize(_key(address(0xFA11)), SQRT_1_1); // allowed, so it opens

        hook.setGraduator(spare, false);
        vm.prank(spare);
        vm.expectRevert();
        manager.initialize(_key(token), SQRT_1_1);
    }

    /// @dev The other half, stated here because this is the file about the gate: the owner may no
    ///      longer close it against a graduator that markets depend on. Proven in full, end to end
    ///      and against a real filled curve, in `test/audit/Gen5StickyGraduator.t.sol`.
    function test_aGraduatorThatHasRegisteredAMarketCannotBeRevoked() public {
        // `graduator` registered the probe market in `setUp`.
        (bool ok, bytes memory ret) =
            address(hook).call(abi.encodeWithSignature("setGraduator(address,bool)", graduator, false));
        assertFalse(ok, "a graduator with a live market was revoked");
        bytes4 sel;
        assembly ("memory-safe") {
            sel := mload(add(ret, 32))
        }
        assertEq(sel, bytes4(keccak256("GraduatorInUse(address)")), "wrong revert");
        assertTrue(hook.isGraduator(graduator), "the refused call still moved the allowlist");
    }

    // -------------------------------------------------------------------------- registration

    function test_aStrangerCannotRegisterOrReRegisterAPool() public {
        PoolKey memory k = _key(token);
        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotGraduator.selector);
        hook.registerPool(k, token, BURN, sinkAddr, 0);

        _register(k, BURN);

        vm.prank(graduator);
        vm.expectRevert(DokuHook.AlreadyRegistered.selector);
        hook.registerPool(k, token, BURN, sinkAddr, 0);
    }

    function test_registerRejectsAMismatchedPoolKey() public {
        // Wrong LP fee — a non-zero fee re-arms the JIT recapture the hook exists to escape.
        PoolKey memory bad = _key(token);
        bad.fee = 3000;
        vm.prank(graduator);
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, token, BURN, sinkAddr, 0);

        // Wrong tick spacing.
        bad = _key(token);
        bad.tickSpacing = 10;
        vm.prank(graduator);
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, token, BURN, sinkAddr, 0);

        // The key must be sorted. Generation 2 no longer requires currency0 to be native MON —
        // the quote lands on whichever side its address does — so the shape rule that survives is
        // Uniswap's own ordering, and a hand-built key that breaks it is a pool we never agreed to.
        bad = _key(token);
        (bad.currency0, bad.currency1) = (bad.currency1, bad.currency0);
        vm.prank(graduator);
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(bad, token, BURN, sinkAddr, 0);

        // The declared token must be currency1.
        PoolKey memory k = _key(token);
        vm.prank(graduator);
        vm.expectRevert(DokuHook.InvalidPoolKey.selector);
        hook.registerPool(k, address(0xDEAD), BURN, sinkAddr, 0);
    }

    function test_registerRejectsAZeroSink() public {
        vm.prank(graduator);
        vm.expectRevert(DokuHook.ZeroAddress.selector);
        hook.registerPool(_key(token), token, BURN, address(0), 0);
    }

    /// @dev Renamed from "the owner cannot raise a live market's levy": there is no setter for it
    ///      to attack. The rates are constants and every market snapshots them at registration.
    function test_noLevyRateCanEverChange() public {
        _register(_key(token), BURN);
        PoolId id = PoolIdLibrary.toId(_key(token));
        DokuHook.Market memory m = hook.markets(id);
        assertEq(m.protocolBps, PROT);
        assertEq(m.sinkBps, SINKB);
        assertLe(m.protocolBps + m.sinkBps, hook.MAX_LEVY_BPS());
    }

    // -------------------------------------------------------------------------- the seed waiver

    function test_aStrangerCannotClaimTheSeedWaiver() public {
        PoolKey memory k = _key(token);
        _register(k, BURN);
        PoolId id = PoolIdLibrary.toId(k);

        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotGraduator.selector);
        hook.beginSeed(id, 1e18, -60, 60);

        vm.prank(stranger);
        vm.expectRevert(DokuHook.NotGraduator.selector);
        hook.endSeed(id);
    }

    function test_beginSeedRequiresARegisteredPool() public {
        vm.prank(graduator);
        vm.expectRevert(DokuHook.UnknownPool.selector);
        hook.beginSeed(PoolIdLibrary.toId(_key(token)), 1e18, -60, 60);
    }

    /// @dev The one-shot bit is what degrades a leaked flag from "unlimited free exempt depth on
    ///      every graduation" to "a griefer burns DOKU's own single waiver".
    function test_theSeedWaiverIsOneShotPerPool() public {
        PoolKey memory k = _key(token);
        _register(k, BURN);
        PoolId id = PoolIdLibrary.toId(k);

        vm.prank(graduator);
        hook.beginSeed(id, 1e18, -60, 60);

        // Consume it by hand — the real consumer is the seed mint in Task 6.
        _consumeSeeded(id);

        vm.prank(graduator);
        vm.expectRevert(DokuHook.AlreadySeeded.selector);
        hook.beginSeed(id, 1e18, -60, 60);
    }

    /// @dev Sets `Market.seeded` directly. The struct's slot 0 packs
    ///      registered|sink|protocolBps|sinkBps|seeded|quoteIsCurrency0|creatorTaxBps|sinkAddr, so
    ///      `seeded` is byte 6. Reading it back through the getter is the assertion that this poked the right
    ///      bit rather than a neighbouring field.
    function _consumeSeeded(PoolId id) internal {
        bytes32 slot = keccak256(abi.encode(id, marketsSlot));
        bytes32 cur = vm.load(address(hook), slot);
        vm.store(address(hook), slot, cur | bytes32(uint256(1) << 48));
        DokuHook.Market memory m = hook.markets(id);
        assertTrue(m.registered, "poked the wrong slot: registered was clobbered");
        assertTrue(m.seeded, "poked the wrong bit: seeded did not set");
    }

    /// @dev A rogue allowlisted graduator still cannot re-arm the waiver on a market whose seed was
    ///      already consumed, which is the property `!m.seeded` buys over `!m.registered`.
    function test_aRogueGraduatorCannotArmTheWaiverOnALiveMarket() public {
        PoolKey memory k = _key(token);
        _register(k, BURN);
        PoolId id = PoolIdLibrary.toId(k);
        _consumeSeeded(id);

        address rogue = address(0x0B0);
        hook.setGraduator(rogue, true);
        vm.prank(rogue);
        vm.expectRevert(DokuHook.AlreadySeeded.selector);
        hook.beginSeed(id, 1e18, -60, 60);
    }

    // ---------------------------------------------------------------------------- the ABI rule

    /// @dev `Hooks.beforeInitialize` carries `noSelfCall`, which skips the gate whenever the hook
    ///      itself is the caller. So the gate holds only while this contract has no way to call
    ///      `poolManager.initialize` and no arbitrary-call surface. Any of `execute`, `multicall`,
    ///      `delegatecall`, an upgrade path or a `rescue` silently converts graduator-only into
    ///      anyone-can-register-any-pool. This asserts the absence.
    function test_thereIsNoArbitraryCallOrRescueSurface() public view {
        string[9] memory forbidden = [
            "rescue(address,address,uint256)",
            "rescueToken(address,address,uint256)",
            "execute(address,bytes)",
            "multicall(bytes[])",
            "upgradeTo(address)",
            "upgradeToAndCall(address,bytes)",
            "setImplementation(address)",
            "isValidSignature(bytes32,bytes)",
            "initialize(address,uint160)"
        ];
        for (uint256 i; i < forbidden.length; ++i) {
            bytes4 sel = bytes4(keccak256(bytes(forbidden[i])));
            (bool ok,) = address(hook).staticcall(abi.encodePacked(sel));
            assertFalse(ok, forbidden[i]);
        }
    }

    /// @dev The hook MUST accept bare MON — a native `take` is a full-gas `call` into it, not a
    ///      2300-gas stipend — so the property worth asserting is not that it refuses, but that its
    ///      `receive()` is empty and credits nobody. That call arrives inside a stranger's
    ///      half-finished swap, so any logic there is logic running in someone else's unlock.
    function test_theHooksReceiveIsEmptyAndCreditsNobody() public {
        PoolKey memory k = _key(token);
        _register(k, BURN);
        PoolId id = PoolIdLibrary.toId(k);

        vm.deal(address(this), 1 ether);
        uint256 g = gasleft();
        (bool ok,) = address(hook).call{value: 1 ether}("");
        uint256 used = g - gasleft();

        assertTrue(ok, "a native take into the hook would revert");
        assertEq(address(hook).balance, 1 ether, "MON did not land");
        assertEq(hook.pendingProtocol(id), 0, "a bare transfer credited the treasury");
        assertEq(hook.pendingSink(id), 0, "a bare transfer credited a sink");
        // An empty receive() is a few thousand gas including the 9000-gas call stipend accounting;
        // anything doing real work would be far above this.
        assertLt(used, 30_000, "receive() is doing work it should not");
    }
}
