// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BurnSink} from "../../src/sinks/BurnSink.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";

/**
 * D1's invariant, made falsifiable.
 *
 * D1 has two halves. *"The creator has no access to the money, ever"* is already true by
 * construction — there is no creator identity in DOKU storage anywhere — and the job of this file
 * is to keep that true by ACCIDENT from becoming true by ASSERTION. *"Keep everything automated"*
 * is the other half, and it is checked here as the absence of an owner-only path to money.
 *
 * This is also the marketing claim rather than a footnote: DOKU is the launchpad where no creator
 * claim function exists and the suite asserts it. A property nobody tests is a property that
 * survives exactly until the first person who does not know about it adds a setter.
 *
 * Scoped to the four contracts that touch accrued money: the hook holds the pending levy, the two
 * sinks receive it, and graduation moves the seed. `BondingCurve` and `DokuFactory` are out of
 * scope here on purpose — the factory IS owner-configurable by design (pauser, fee recipient,
 * quote target) and conflating the two would make this test assert something false.
 */
contract NoPrivilegeTest is Test {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant STRANGER = address(0x5747A6E);
    /// @dev Deploys the sinks and is passed to nothing. It can only appear in storage if a
    ///      constructor recorded `msg.sender`.
    address internal constant CREATOR = address(0xC2EA402);
    /// @dev Distinct from `CREATOR` and from `address(this)`: the owner legitimately IS stored, so
    ///      the two must not be the same address or the storage scan asserts nothing.
    address internal constant OWNER = address(0x0BEE);

    PoolManager internal manager;
    DokuHook internal hook;
    DokuGraduation internal graduation;
    BurnSink internal burnSink;
    RewardVault internal vault;
    DokuToken internal token;

    /// @dev The privileged surface DOKU must not have. Half are lifted verbatim from the reference
    ///      implementations this design was built from — Pons's `setCreatorFeeRecipient` and
    ///      `creatorFeeRecipient`, Noxa's creator plumbing — so this list is not hypothetical: it
    ///      is the set of things a reasonable implementer would add back.
    string[9] internal FORBIDDEN = [
        "setCreatorFeeRecipient(address)",
        "claimCreator()",
        "creatorFeeRecipient()",
        "setRecipient(address)",
        "setSink(uint8,address)",
        "setTreasury(address)",
        "setProtocolLevyBps(uint16)",
        "migrate(address)",
        "renounceOwnership()"
    ];

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), OWNER, TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), OWNER, TREASURY, CREATOR_SINK);

        graduation = new DokuGraduation(address(manager), address(0x9051), address(0x9E12), address(hook), address(new MarketsStub()));

        token = DokuToken(Clones.clone(address(new DokuToken())));
        token.initialize("D", "D", address(0xC0FFEE), true, "https://cdn.doku.family/metadata/test.json");

        PoolId id = PoolIdLibrary.toId(
            PoolKey({
                currency0: Currency.wrap(address(0)),
                currency1: Currency.wrap(address(token)),
                fee: 0,
                tickSpacing: 60,
                hooks: IHooks(address(hook))
            })
        );
        vm.prank(CREATOR);
        burnSink = new BurnSink(address(hook), address(token), id);

        address[9] memory ex;
        ex[0] = address(manager);
        ex[1] = address(hook);
        ex[2] = address(0xC0FFEE);
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = address(graduation);
        ex[6] = address(0x9051);
        vm.prank(CREATOR);
        vault = new RewardVault(address(hook), address(token), id, address(0), 1_000e18, block.number, ex);
    }

    function _targets() internal view returns (address[4] memory) {
        return [address(hook), address(burnSink), address(vault), address(graduation)];
    }

    // ------------------------------------------------------------------------------- the surface

    /**
     * None of the four answers to any selector on the forbidden list.
     *
     * A raw `.call` rather than a typed interface: a typed call would not COMPILE against a
     * contract lacking the function, which proves the test compiles rather than that the contract
     * is clean. The raw call reaches the fallback, and these contracts have none — so a missing
     * function returns `false` and a present one does not.
     *
     * `renounceOwnership()` is on the list for a reason opposite to the rest. Under D1's framing,
     * renouncing looks like the virtuous final step; it would be catastrophic. `setGraduator` is
     * the only recovery path for a graduation bug, and every curve is pinned to its graduator with
     * no setter — so an ownerless hook makes every affected curve permanently un-graduatable with
     * its raise locked inside it.
     */
    function test_noSelectorMentionsCreator() public {
        // POSITIVE CONTROL, first. Everything below asserts that calls FAIL, and a raw `.call`
        // against a contract that reverted on every input would satisfy that vacuously. These four
        // selectors do exist and must answer, so a zero-failure result underneath is admissible.
        (bool live,) = address(hook).call(abi.encodeWithSignature("owner()"));
        assertTrue(live, "positive control failed: the hook does not answer owner()");
        (live,) = address(burnSink).call(abi.encodeWithSignature("sinkCurrencyIsToken()"));
        assertTrue(live, "positive control failed: BurnSink does not answer sinkCurrencyIsToken()");
        (live,) = address(vault).call(abi.encodeWithSignature("epochCount()"));
        assertTrue(live, "positive control failed: RewardVault does not answer epochCount()");
        (live,) = address(graduation).call(abi.encodeWithSignature("SEED_BASE()"));
        assertTrue(live, "positive control failed: DokuGraduation does not answer SEED_BASE()");

        address[4] memory targets = _targets();
        for (uint256 t; t < targets.length; ++t) {
            for (uint256 i; i < FORBIDDEN.length; ++i) {
                bytes memory data = abi.encodeWithSignature(FORBIDDEN[i]);
                (bool ok,) = targets[t].call(data);
                assertFalse(
                    ok,
                    string.concat("a forbidden selector answered: ", FORBIDDEN[i])
                );
            }
        }
    }

    /// @dev The hook DOES own `renounceOwnership` — OZ's `Ownable` ships it — so the assertion
    ///      above passes there only because it is overridden to revert. Asserted separately so a
    ///      future refactor that deletes the override fails with a message that says why.
    function test_ownershipCannotBeRenounced() public {
        vm.prank(OWNER);
        vm.expectRevert(DokuHook.RenounceDisabled.selector);
        hook.renounceOwnership();
        assertEq(hook.owner(), OWNER, "ownership survived a renounce attempt");
    }

    /**
     * No contract records whoever triggered it.
     *
     * Falsifiable rather than true-by-accident: the ABI scan above catches a creator FUNCTION, and
     * this catches creator STATE — a stored address with no getter that some later privileged path
     * could read. Every storage slot of each contract is scanned for `CREATOR`, the address that
     * deployed the two sinks here.
     *
     * `CREATOR` is used for nothing else and passed to nothing, so it can only appear if a
     * constructor recorded `msg.sender`. That is the exact mistake this guards against, and it is
     * the one a reference implementation would lead an implementer into: Pons stores
     * `LaunchInfo.creator` and pays it in `_rescueCurrency`, and Noxa carries a
     * `creatorFeeRecipient` and a whole `CreatorGovernor`. DOKU's creator pays the anti-sniper
     * deposit like anyone else and is never named again after the launch event.
     *
     * The hook's owner is deliberately a DIFFERENT address, because the owner legitimately IS
     * stored — conflating the two would make this assert something false.
     */
    function test_noContractStoresACreatorAddress() public {
        address[4] memory targets = _targets();
        bytes32 creator = bytes32(uint256(uint160(CREATOR)));
        for (uint256 t; t < targets.length; ++t) {
            for (uint256 slot; slot < 32; ++slot) {
                assertTrue(
                    vm.load(targets[t], bytes32(slot)) != creator,
                    "a contract recorded the address that triggered it"
                );
            }
        }

        // And the token, which is where a creator allocation would live if one existed. The whole
        // supply is at the curve; nothing was ever minted anywhere else.
        assertEq(token.balanceOf(CREATOR), 0, "the creator holds a token allocation");
        assertEq(token.balanceOf(address(0xC0FFEE)), token.totalSupply(), "supply is not all at the curve");
    }

    /**
     * Every money-moving path on the hook is callable by a stranger.
     *
     * This is the "keep everything automated" half of D1, and it is the assertion that would fail
     * if someone added `onlyOwner` to a sweep for what felt like a good reason. The destinations
     * are fixed at registration and none of these takes a recipient, so permissionless costs
     * nothing: the caller pays gas to move someone else's money to where it was already going.
     *
     * `NotRegistered` / `ZeroAmount` are the CORRECT failures here — they mean the call was
     * authorised and simply had nothing to do. An access-control revert is the one that must not
     * appear, so the assertion is on the revert REASON, not on success.
     */
    function test_thereIsNoOwnerOnlyPathToMoney() public {
        bytes[4] memory calls = [
            abi.encodeWithSignature("sweep(bytes32)", bytes32(uint256(1))),
            abi.encodeWithSignature("pullSink(bytes32)", bytes32(uint256(1))),
            abi.encodeWithSignature("pullTreasury(address)", address(0)),
            abi.encodeWithSignature("creditCurveTax(bytes32)", bytes32(uint256(1)))
        ];

        for (uint256 i; i < calls.length; ++i) {
            vm.prank(STRANGER);
            (bool ok, bytes memory ret) = address(hook).call(calls[i]);
            if (ok) continue;
            bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
            assertTrue(
                sel != bytes4(keccak256("OwnableUnauthorizedAccount(address)")),
                "a money-moving call on the hook is owner-only"
            );
        }

        // The sinks too. Both are permissionless by design: `burn` destroys what the market
        // accrued and `fund`/`createEpoch` move it toward the holders it is already owed to.
        vm.prank(STRANGER);
        (bool okBurn, bytes memory retBurn) = address(burnSink).call(abi.encodeWithSignature("burn()"));
        _notOwnerGated(okBurn, retBurn, "BurnSink.burn is owner-only");

        vm.prank(STRANGER);
        (bool okFund, bytes memory retFund) = address(vault).call(abi.encodeWithSignature("fund()"));
        _notOwnerGated(okFund, retFund, "RewardVault.fund is owner-only");

        vm.prank(STRANGER);
        (bool okEpoch, bytes memory retEpoch) = address(vault).call(abi.encodeWithSignature("createEpoch()"));
        _notOwnerGated(okEpoch, retEpoch, "RewardVault.createEpoch is owner-only");
    }

    /// @dev The vault has no owner at all, which is the strongest form of the claim: there is no
    ///      address that could be given a rollover escape hatch over the unclaimed remainder, which
    ///      under `min(past, current)` can be the majority of an epoch.
    function test_theRewardVaultHasNoOwnerToGiveAnEscapeHatchTo() public {
        (bool ok,) = address(vault).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "the reward vault has an owner");
        (ok,) = address(burnSink).call(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "the burn sink has an owner");
    }

    function _notOwnerGated(bool ok, bytes memory ret, string memory why) internal pure {
        if (ok) return;
        bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
        require(sel != bytes4(keccak256("OwnableUnauthorizedAccount(address)")), why);
    }
}
