// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

// Imported ONLY so forge compiles their artifacts. v4-periphery's test `Deploy` library builds
// these through `vm.getCode("PositionManager.sol:PositionManager")`, which resolves against the
// build output rather than the source tree — so running this file with `--match-path` in a clean
// `out/` fails at setUp with "no matching artifact found" without them.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @dev Stands in for the shared `CreatorSink`. Every market this file builds is a BURN market, so
///      graduation never calls `register` here; it exists because the hook folds the sink's address
///      into its mined one and therefore needs an address that is a contract.
contract StubCreatorSink {
    receive() external payable {}
}

/**
 * @title Gen5StickyGraduatorTest
 *
 * @notice ITEM H-02 of the 2026-09-11 external re-review, answered in source for GENERATION 5.
 *
 * @dev ## What this file is about
 *
 *      `DokuHook.setGraduator(address, bool)` was an unrestricted owner setter. Every curve pins
 *      its graduator at launch and has no setter for it, and `DokuGraduation.graduate` opens with
 *      `if (!hook.isGraduator(address(this))) revert DependenciesNotWired()`. So one owner call
 *      reached every market already launched against that graduator and not yet graduated — the
 *      filled ones included, whose `readyToGraduate` is latched, whose both curve legs are shut,
 *      and whose raise is reachable only through a `release` that only graduation performs.
 *
 *      Owner-only and one call to undo, so it is grief and not theft. That is exactly why our own
 *      rounds under-weighted it, and it is also not a good enough answer: the liveness of every
 *      ungraduated market in the protocol should not rest on one key declining to call a function
 *      it is permitted to call.
 *
 *      ## What generation 5 changes, and what it deliberately does not
 *
 *      An allowlisted graduator becomes STICKY the instant it registers its first market, and
 *      `setGraduator(g, false)` then reverts `GraduatorInUse(g)` forever. Adding stays
 *      unrestricted. Removing a graduator that has never graduated anything stays possible, because
 *      that is the "wired the wrong address at deployment" recovery path and nothing depends on the
 *      entry yet.
 *
 *      The GAP is proven here too rather than glossed: between a market's LAUNCH and its
 *      graduator's first graduation, the graduator is still revocable and that market can still be
 *      frozen. The hook cannot close that from inside itself — it never sees a launch — and
 *      `test_theGapThisFixDoesNotClose_aLaunchBeforeTheFirstGraduation` is the standing proof of
 *      the residue. `test_aCanaryGraduatedFirstLeavesNoWindowToLaunchInto` is the operational
 *      answer the protocol already performs.
 *
 *      ## Why the assertions on the new revert are low-level
 *
 *      `DokuHook.GraduatorInUse` does not exist in generation 4, and the point of a paired proof is
 *      that the same file goes RED against the unfixed source rather than failing to compile
 *      against it. Every assertion about the new behaviour therefore goes through
 *      `address(hook).call(...)` and a hand-decoded selector, so this file compiles unchanged
 *      against both generations and reports the difference as a failing assertion. Confirmed by
 *      reverting the source change in a scratch tree.
 */
contract Gen5StickyGraduatorTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant STRANGER = address(0x5747);
    address internal constant OUTSIDER_GRADUATOR = address(0x6AD);
    uint256 internal constant TARGET = 1_000e18;

    /// @dev `bytes4(keccak256("GraduatorInUse(address)"))`, computed rather than read off the type,
    ///      for the reason in the contract docblock.
    bytes4 internal constant GRADUATOR_IN_USE = bytes4(keccak256("GraduatorInUse(address)"));

    DokuHook internal dokuHook;
    /// @dev The graduator that will be made sticky by graduating something.
    DokuGraduation internal gradMain;
    /// @dev Allowlisted at setUp and never used. The deployment-typo recovery case.
    DokuGraduation internal gradSpare;
    MarketsStub internal markets;
    StubCreatorSink internal creatorSink;

    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        // Before the hook: the sink's address is folded into the hook's mined one.
        creatorSink = new StubCreatorSink();
        markets = new MarketsStub();

        bytes memory args =
            abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(
            IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink)
        );

        gradMain = new DokuGraduation(
            address(manager), address(lpm), address(permit2), address(dokuHook), address(markets)
        );
        gradSpare = new DokuGraduation(
            address(manager), address(lpm), address(permit2), address(dokuHook), address(markets)
        );
        dokuHook.setGraduator(address(gradMain), true);
        dokuHook.setGraduator(address(gradSpare), true);

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        vm.deal(ALICE, 1_000_000e18);
    }

    // ------------------------------------------------------------------------------- fixtures

    /// @dev A native-quoted BURN market pinned to `graduator_`, built by hand exactly the way
    ///      `test/v4/GraduationV4.t.sol` builds one. BURN so graduation deploys its own sink and
    ///      never touches the creator sink, which keeps this file about the allowlist.
    function _market(address graduator_) internal returns (BondingCurve c, DokuToken t) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            address(0),
            TARGET,
            Sinks.BURN,
            address(0),
            0,
            ALICE,
            TREASURY,
            graduator_,
            address(creatorSink)
        );
    }

    /// @dev One buy that overfills. The filling buy auto-graduates, unless the hook refuses the
    ///      graduator — in which case `_tryAutoGraduate` swallows the failure by design and the
    ///      market is left filled, shut and ungraduated, which is the state this file is about.
    function _fill(BondingCurve c) internal {
        // `vm.getBlockTimestamp()`, not `block.timestamp`: under `via_ir = true` the optimiser folds
        // block globals across cheatcode calls, so a warp read back through `block.timestamp` can
        // return the pre-warp value.
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 value = 5 * TARGET;
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(ALICE);
        c.buy{value: value}(0, deadline);
    }

    /// @dev A partial raise: real money inside a market that has NOT graduated yet. This is what a
    ///      revocation would strand.
    function _partiallyFill(BondingCurve c, uint256 value) internal {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(ALICE);
        c.buy{value: value}(0, deadline);
    }

    function _graduateCanary(DokuGraduation g) internal {
        (BondingCurve c,) = _market(address(g));
        _fill(c);
        assertTrue(g.graduated(address(c)), "the canary did not graduate");
    }

    /// @dev `graduatorEverRegistered` does not exist in generation 4 either, so this reads it the
    ///      way an off-chain monitor would have to: a raw staticcall, with "the function is not
    ///      there" folded into `false`.
    function _everRegistered(address g) internal view returns (bool) {
        (bool ok, bytes memory ret) =
            address(dokuHook).staticcall(abi.encodeWithSignature("graduatorEverRegistered(address)", g));
        if (!ok || ret.length != 32) return false;
        return abi.decode(ret, (bool));
    }

    function _tryRevoke(address g) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(dokuHook).call(abi.encodeWithSignature("setGraduator(address,bool)", g, false));
    }

    function _selectorOf(bytes memory ret) internal pure returns (bytes4 s) {
        assembly ("memory-safe") {
            s := mload(add(ret, 32))
        }
    }

    function _addressArgOf(bytes memory ret) internal pure returns (address) {
        require(ret.length >= 36, "revert data carries no address argument");
        bytes32 w;
        assembly ("memory-safe") {
            w := mload(add(ret, 36))
        }
        return address(uint160(uint256(w)));
    }

    // ------------------------------------------------------- 1. the harm, in full, end to end

    /**
     * THE FREEZE, PERFORMED. This is what item H-02 describes, run against real Uniswap v4, a real
     * `DokuGraduation` and a real filled curve.
     *
     * It runs against `gradSpare`, which has never graduated anything — so the revocation succeeds
     * in BOTH generations, and this test is green in both. That is deliberate and it is the honest
     * statement of item 3: the sticky bit cannot protect a market whose graduator has not yet
     * graduated anything, because the hook does not learn about a launch. See
     * `test_aCanaryGraduatedFirstLeavesNoWindowToLaunchInto` for the operational answer, and
     * `DokuHook.setGraduator`'s docblock for what a complete fix would cost in the factory.
     */
    function test_theGapThisFixDoesNotClose_aLaunchBeforeTheFirstGraduation() public {
        (BondingCurve c,) = _market(address(gradSpare));

        // The window: the market is pinned to `gradSpare`, and `gradSpare` is still revocable
        // because no market has ever been registered under it.
        assertFalse(_everRegistered(address(gradSpare)), "gradSpare should not be sticky yet");
        dokuHook.setGraduator(address(gradSpare), false);
        assertFalse(dokuHook.isGraduator(address(gradSpare)), "the revocation did not land");

        // The market fills. The filling buy's auto-graduation fails and is swallowed by design.
        _fill(c);
        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertFalse(gradSpare.graduated(address(c)), "it graduated with the graduator revoked");

        // Both legs are shut, so the raise cannot be walked back out through the curve.
        uint256 value = 1e18;
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(ALICE);
        vm.expectRevert(BondingCurve.CurveClosed.selector);
        c.buy{value: value}(0, deadline);

        // And the only door out is the one the owner just locked.
        vm.expectRevert(DokuGraduation.DependenciesNotWired.selector);
        gradSpare.graduate(address(c));

        // Grief, not theft: the owner can undo it, and nothing was lost while it was frozen.
        dokuHook.setGraduator(address(gradSpare), true);
        gradSpare.graduate(address(c));
        assertTrue(gradSpare.graduated(address(c)), "the market did not recover");
    }

    // --------------------------------------------------------------------------- 2. the fix

    /**
     * THE FIX. Once a graduator has graduated ANY market, the owner cannot revoke it — so the
     * freeze above cannot be aimed at any market launched after that point.
     *
     * RED against generation 4: there the revocation succeeds, `ok` is true, and the first
     * assertion fails.
     */
    function test_theOwnerCannotRevokeAGraduatorThatHasGraduatedAMarket() public {
        _graduateCanary(gradMain);

        // A second market, launched against the same graduator, with a real raise inside it and no
        // graduation yet. This is precisely what a revocation would strand.
        (BondingCurve c,) = _market(address(gradMain));
        _partiallyFill(c, TARGET / 2);
        assertFalse(c.readyToGraduate(), "the fixture was meant to leave this market ungraduated");
        assertGt(address(c).balance, 0, "the fixture was meant to leave a raise inside the curve");

        (bool ok, bytes memory ret) = _tryRevoke(address(gradMain));
        assertFalse(ok, "the owner revoked a graduator that live markets are pinned to");
        assertEq(_selectorOf(ret), GRADUATOR_IN_USE, "wrong revert: expected GraduatorInUse");
        assertTrue(_everRegistered(address(gradMain)), "registering a market did not pin the graduator");
        assertEq(_addressArgOf(ret), address(gradMain), "GraduatorInUse named the wrong graduator");

        // The allowlist entry is untouched, so the market is still graduatable.
        assertTrue(dokuHook.isGraduator(address(gradMain)), "the refused call still moved the allowlist");
        _fill(c);
        assertTrue(gradMain.graduated(address(c)), "the market did not graduate after the refusal");
    }

    /// @dev The sticky bit is permanent in the only sense that matters: there is no second call, no
    ///      re-grant-then-revoke dance, and no ordering that gets the revocation through.
    function test_theRefusalCannotBeWalkedAroundByReGrantingFirst() public {
        _graduateCanary(gradMain);

        // Re-granting an already-allowed, already-sticky graduator is legal and is a no-op.
        dokuHook.setGraduator(address(gradMain), true);
        assertTrue(dokuHook.isGraduator(address(gradMain)), "re-granting dropped the entry");

        (bool ok, bytes memory ret) = _tryRevoke(address(gradMain));
        assertFalse(ok, "re-granting first let the revocation through");
        assertEq(_selectorOf(ret), GRADUATOR_IN_USE, "wrong revert after a re-grant");

        // Not even twice in the same transaction.
        (ok,) = _tryRevoke(address(gradMain));
        assertFalse(ok, "a second attempt succeeded");
    }

    // --------------------------------------------- 3. what must keep working, proven separately

    /**
     * (a) THE RECOVERY PATH. A graduator that has never graduated anything is pinned into nobody's
     *     curve, so removing it cannot freeze anything — and refusing it would turn one wrong
     *     address at deployment into a permanent, unrevokable capability on the hook.
     */
    function test_aGraduatorThatNeverGraduatedAnythingCanStillBeRemoved() public {
        assertTrue(dokuHook.isGraduator(address(gradSpare)), "fixture: gradSpare should start allowed");
        assertFalse(_everRegistered(address(gradSpare)), "fixture: gradSpare should start unused");

        dokuHook.setGraduator(address(gradSpare), false);
        assertFalse(dokuHook.isGraduator(address(gradSpare)), "an unused graduator could not be removed");

        // And the removal is not itself sticky: the owner may put it back.
        dokuHook.setGraduator(address(gradSpare), true);
        assertTrue(dokuHook.isGraduator(address(gradSpare)), "the entry could not be restored");
    }

    /// @dev And a registration that REVERTS does not pin anything. The bit is written after every
    ///      validation in `registerPool` has passed and after the market has been stored, so a
    ///      failed attempt leaves the graduator as removable as it was.
    function test_aFailedRegistrationDoesNotPinTheGraduator() public {
        dokuHook.setGraduator(OUTSIDER_GRADUATOR, true);

        // `beginSeed` on a pool that does not exist: a graduator-authenticated call that reverts.
        vm.prank(OUTSIDER_GRADUATOR);
        vm.expectRevert(DokuHook.UnknownPool.selector);
        dokuHook.beginSeed(PoolId.wrap(bytes32(uint256(1))), 1, -60, 60);

        assertFalse(_everRegistered(OUTSIDER_GRADUATOR), "a reverting call pinned the graduator");
        dokuHook.setGraduator(OUTSIDER_GRADUATOR, false);
        assertFalse(dokuHook.isGraduator(OUTSIDER_GRADUATOR), "it could not be removed afterwards");
    }

    /// @dev (b) Adding is unchanged: unrestricted, owner-only, and it does not care whether the
    ///      address has ever been used, is a contract, or is anything at all beyond non-zero.
    function test_addingAGraduatorIsStillUnrestricted() public {
        assertFalse(dokuHook.isGraduator(OUTSIDER_GRADUATOR), "fixture");
        dokuHook.setGraduator(OUTSIDER_GRADUATOR, true);
        assertTrue(dokuHook.isGraduator(OUTSIDER_GRADUATOR), "adding a fresh graduator was refused");

        // Rotation stays additive, which is the whole point: the outgoing graduator staying
        // allowlisted is what keeps its markets graduatable.
        _graduateCanary(gradMain);
        DokuGraduation next = new DokuGraduation(
            address(manager), address(lpm), address(permit2), address(dokuHook), address(markets)
        );
        dokuHook.setGraduator(address(next), true);
        assertTrue(dokuHook.isGraduator(address(next)), "the incoming graduator was refused");
        assertTrue(dokuHook.isGraduator(address(gradMain)), "the outgoing graduator was dropped");

        // Zero is still refused, and for the old reason.
        vm.expectRevert(DokuHook.ZeroAddress.selector);
        dokuHook.setGraduator(address(0), true);
    }

    /// @dev (c) A stranger can do neither — and is refused AS A STRANGER in both directions, which
    ///      is the ordering check: `onlyOwner` runs before the sticky bit, so a stranger aiming at a
    ///      pinned graduator learns nothing about the allowlist's contents from the revert.
    function test_aStrangerCanNeitherAddNorRemove() public {
        _graduateCanary(gradMain);
        bytes memory denied = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, STRANGER);

        vm.prank(STRANGER);
        vm.expectRevert(denied);
        dokuHook.setGraduator(OUTSIDER_GRADUATOR, true);

        vm.prank(STRANGER);
        vm.expectRevert(denied);
        dokuHook.setGraduator(address(gradSpare), false);

        vm.prank(STRANGER);
        vm.expectRevert(denied);
        dokuHook.setGraduator(address(gradMain), false);

        assertTrue(dokuHook.isGraduator(address(gradMain)), "a stranger moved the allowlist");
        assertTrue(dokuHook.isGraduator(address(gradSpare)), "a stranger moved the allowlist");
        assertFalse(dokuHook.isGraduator(OUTSIDER_GRADUATOR), "a stranger moved the allowlist");
    }

    // --------------------------------------------------------- 4. closing the residual window

    /**
     * THE OPERATIONAL ANSWER to the gap, and it is one the protocol already performs: graduate a
     * canary market through a freshly allowlisted graduator BEFORE any real market can launch
     * against it, and the window in which that graduator is revocable is zero seconds long.
     *
     * RED against generation 4 on the second half: there the revocation succeeds even after the
     * canary, and every later market stays freezable for as long as the owner wants.
     */
    function test_aCanaryGraduatedFirstLeavesNoWindowToLaunchInto() public {
        // Deployment order: allowlist, then canary, THEN open for launches.
        _graduateCanary(gradSpare);
        assertTrue(_everRegistered(address(gradSpare)), "the canary did not pin the graduator");

        // Every market that can exist from here on is launched against a graduator that is already
        // permanent.
        (BondingCurve c,) = _market(address(gradSpare));
        _partiallyFill(c, TARGET / 2);

        (bool ok, bytes memory ret) = _tryRevoke(address(gradSpare));
        assertFalse(ok, "the canary left a window open");
        assertEq(_selectorOf(ret), GRADUATOR_IN_USE, "wrong revert after the canary");

        _fill(c);
        assertTrue(gradSpare.graduated(address(c)), "the market could not graduate");
    }

    // ------------------------------------------------------------ 5. nothing else was widened

    /// @dev The other half of the liveness argument, unchanged and re-asserted here because the
    ///      sticky bit leans on it: the owner is still the only way to allowlist the NEXT
    ///      graduator, so an owner that can walk away is still a freeze of a different shape.
    function test_renounceOwnershipIsStillDisabled() public {
        vm.expectRevert(DokuHook.RenounceDisabled.selector);
        dokuHook.renounceOwnership();
        assertEq(dokuHook.owner(), address(this), "ownership moved");
    }

    /// @dev `isGraduator` is still the exact question `DokuFactory` and `DokuGraduation` ask, with
    ///      the same selector and the same return bytes, despite the mapping behind it becoming a
    ///      struct. A silent ABI change here would break the factory's per-launch guard.
    function test_theIsGraduatorGetterIsUnchangedOnTheWire() public view {
        (bool ok, bytes memory ret) =
            address(dokuHook).staticcall(abi.encodeWithSignature("isGraduator(address)", address(gradMain)));
        assertTrue(ok, "isGraduator(address) is no longer callable");
        assertEq(ret.length, 32, "isGraduator no longer returns one word");
        assertTrue(abi.decode(ret, (bool)), "isGraduator disagrees with the allowlist");

        (ok, ret) = address(dokuHook).staticcall(abi.encodeWithSignature("isGraduator(address)", STRANGER));
        assertTrue(ok, "isGraduator(address) is no longer callable");
        assertFalse(abi.decode(ret, (bool)), "isGraduator allowlists a stranger");
    }
}
