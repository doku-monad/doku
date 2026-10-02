// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DOKU_HOOK_CREATION_CODE_HASH} from "../../src/v4/HookCreationCode.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";

/// @notice The hook's address IS its permission set, so these are correctness tests, not hygiene.
/// @dev `Hooks.validateHookPermissions` compares all fourteen flags with `!=`, and `BaseHook`'s
///      constructor runs it. A mask that disagrees with `getHookPermissions()` cannot be deployed
///      at all — which is the good failure. The bad failure is a toolchain drift that silently
///      changes the creation code and invalidates a salt recorded in `deployments.md`, and
///      `test_creationCodeMatchesThePinnedHash` is what turns that into a CI failure instead of a
///      deploy-time revert.
contract HookAddressTest is Test {
    /// @dev Deliberately a literal rather than `DokuHook.HOOK_FLAGS`. The contract derives its
    ///      `Permissions` struct from that constant, so reusing it here would let a wrong constant
    ///      agree with itself. This is the independent side of the check.
    uint160 internal constant EXPECTED_FLAGS = 0x2FCF;

    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);

    /// @dev The hook's creation code, pinned. A toolchain drift must fail in CI, not at deploy:
    ///      the mined salt in `docs/doku/deployments.md` is derived from this hash, and a hook
    ///      deployed at a stale prediction reverts `HookAddressNotValid` in its own constructor.
    ///
    ///      Update this DELIBERATELY, and re-mine every recorded salt in the same commit. Salt,
    ///      predicted address, this hash, the solc version and the v4-periphery pin are ONE record;
    ///      changing any of them voids the rest. Regenerate with:
    ///        cast keccak $(jq -r '.bytecode.object' out/DokuHook.sol/DokuHook.json)
    bytes32 internal constant CREATION_CODE_HASH = DOKU_HOOK_CREATION_CODE_HASH;

    PoolManager internal manager;
    DokuHook internal hook;
    bytes32 internal salt;

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (address predicted, bytes32 s) =
            HookMiner.find(address(this), EXPECTED_FLAGS, type(DokuHook).creationCode, args);
        salt = s;
        hook = new DokuHook{salt: s}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        // Mining and deployment must agree, or the salt recorded anywhere is worthless.
        assertEq(address(hook), predicted, "mined address != deployed address");
    }

    function test_creationCodeMatchesThePinnedHash() public pure {
        assertEq(
            keccak256(type(DokuHook).creationCode),
            CREATION_CODE_HASH,
            "DokuHook creation code moved: re-mine every salt in deployments.md in this commit"
        );
    }

    function test_hookAddressEncodesExactlyOurPermissions() public view {
        assertEq(uint160(address(hook)) & 0x3FFF, EXPECTED_FLAGS, "mined flags != getHookPermissions()");
    }

    /// @dev The equality constraint's other half. Under `0x2FCF` exactly three flags must be clear;
    ///      an earlier mask left eight clear, so this list is short on purpose and is the thing to
    ///      update if the mask ever changes.
    function test_everyOtherFlagIsZero() public view {
        uint160 a = uint160(address(hook));
        assertEq(a & 0x1000, 0, "afterInitialize must be clear");
        assertEq(a & 0x0020, 0, "beforeDonate must be clear");
        assertEq(a & 0x0010, 0, "afterDonate must be clear");
    }

    /// @dev `HOOK_FLAGS` is the single source of truth the contract derives its struct from; this
    ///      walks the struct back to a mask independently and asserts the round trip.
    function test_permissionsStructRoundTripsToTheMask() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        uint160 m = 0;
        if (p.beforeInitialize) m |= 0x2000;
        if (p.afterInitialize) m |= 0x1000;
        if (p.beforeAddLiquidity) m |= 0x0800;
        if (p.afterAddLiquidity) m |= 0x0400;
        if (p.beforeRemoveLiquidity) m |= 0x0200;
        if (p.afterRemoveLiquidity) m |= 0x0100;
        if (p.beforeSwap) m |= 0x0080;
        if (p.afterSwap) m |= 0x0040;
        if (p.beforeDonate) m |= 0x0020;
        if (p.afterDonate) m |= 0x0010;
        if (p.beforeSwapReturnDelta) m |= 0x0008;
        if (p.afterSwapReturnDelta) m |= 0x0004;
        if (p.afterAddLiquidityReturnDelta) m |= 0x0002;
        if (p.afterRemoveLiquidityReturnDelta) m |= 0x0001;
        assertEq(m, EXPECTED_FLAGS, "getHookPermissions() does not decompose to the mask");
        assertEq(hook.HOOK_FLAGS(), EXPECTED_FLAGS, "HOOK_FLAGS constant drifted");
    }

    /// @dev Each return-delta flag requires its base flag or `isValidHookAddress` rejects the
    ///      address and every `initialize` on a key bearing this hook reverts. The mask carries
    ///      four such pairings; a future editor deleting a base flag "to save gas" breaks one.
    function test_everyReturnDeltaFlagHasItsBaseFlag() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(!p.beforeSwapReturnDelta || p.beforeSwap, "beforeSwapReturnDelta without beforeSwap");
        assertTrue(!p.afterSwapReturnDelta || p.afterSwap, "afterSwapReturnDelta without afterSwap");
        assertTrue(
            !p.afterAddLiquidityReturnDelta || p.afterAddLiquidity, "afterAddLiquidityReturnDelta without base"
        );
        assertTrue(
            !p.afterRemoveLiquidityReturnDelta || p.afterRemoveLiquidity,
            "afterRemoveLiquidityReturnDelta without base"
        );
    }

    /// @dev A valid DokuHook address ends in 2fcf, 6fcf, afcf or efcf and nothing else — the low
    ///      three nibbles are pinned and the fourth-from-last satisfies `n & 3 == 2`. Cheap enough
    ///      to eyeball in a block explorer before signing a deploy.
    function test_theEyeballRuleHolds() public view {
        uint160 nibble = (uint160(address(hook)) >> 12) & 0xF;
        assertEq(nibble & 3, 2, "fourth-from-last nibble must satisfy n & 3 == 2");
        assertEq(uint160(address(hook)) & 0xFFF, 0xFCF, "address must end in fcf");
    }

    /// @notice Renouncing would strand the only recovery path a broken deployment has.
    function test_renounceOwnershipIsDisabled() public {
        vm.expectRevert(DokuHook.RenounceDisabled.selector);
        hook.renounceOwnership();
    }
}
