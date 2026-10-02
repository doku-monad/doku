// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice The registry decides what a market may be priced in and how much it must raise. Both
///         are read once, at launch, so nothing here can reach a live curve — see Launch.t.sol for
///         that half of the property.
contract QuoteRegistryTest is Test {
    address constant OWNER = address(0x01);
    uint256 constant MON_TARGET = 1_000e18;
    uint256 constant USDC_TARGET = 8_000e6;

    QuoteRegistry reg;
    MockUSDC usdc;

    event QuoteAssetRegistered(address indexed asset, uint8 decimals, uint256 quoteTarget);
    event QuoteTargetChanged(address indexed asset, uint256 previous, uint256 current);
    event QuoteAssetEnabled(address indexed asset, bool enabled);

    function setUp() public {
        reg = new QuoteRegistry(OWNER);
        usdc = new MockUSDC();
    }

    function test_nativeIsEighteenDecimalsByDefinition() public {
        vm.expectEmit(true, false, false, true);
        emit QuoteAssetRegistered(address(0), 18, MON_TARGET);
        vm.prank(OWNER);
        reg.register(address(0), MON_TARGET);
        assertEq(reg.decimalsOf(address(0)), 18);
        assertEq(reg.quoteTarget(address(0)), MON_TARGET);
        assertTrue(reg.isEnabled(address(0)), "not enabled on registration");
    }

    /// Decimals come from the token, never from the caller: a target in raw units is only
    /// meaningful next to the number of decimals it is denominated in.
    function test_tokenDecimalsAreReadNotSupplied() public {
        vm.prank(OWNER);
        reg.register(address(usdc), USDC_TARGET);
        assertEq(reg.decimalsOf(address(usdc)), 6, "decimals not read from the token");
        (bool enabled, uint8 dec, uint256 target) = reg.assets(address(usdc));
        assertTrue(enabled);
        assertEq(dec, 6);
        assertEq(target, USDC_TARGET);
    }

    /// An address with no code cannot answer `decimals()`, so a mistyped asset is refused here
    /// rather than discovered by the first launch that tries to use it.
    function test_anAddressWithoutCodeCannotBeRegistered() public {
        vm.prank(OWNER);
        vm.expectRevert();
        reg.register(address(0xBEEF), 1e18);
    }

    function test_registerIsOneShot() public {
        vm.startPrank(OWNER);
        reg.register(address(0), MON_TARGET);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.AlreadyRegistered.selector, address(0)));
        reg.register(address(0), MON_TARGET);
        vm.stopPrank();
    }

    function test_targetBounds() public {
        vm.startPrank(OWNER);
        vm.expectRevert(QuoteRegistry.ZeroTarget.selector);
        reg.register(address(0), 0);
        // Same floor as the curve: below 5 there is no target whose virtual quote reserve is both
        // non-zero and exact, so every market launched in this asset would be born broken.
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.TargetTooSmall.selector, 4, 5));
        reg.register(address(0), 4);
        reg.register(address(0), 5);
        vm.expectRevert(QuoteRegistry.ZeroTarget.selector);
        reg.setQuoteTarget(address(0), 0);
        vm.stopPrank();
    }

    /**
     * A target that is not a multiple of five is refused at BOTH doors of this contract.
     *
     * `BondingCurve.initialize` seeds the virtual quote reserve at `(target * 2) / 5`. When that
     * division truncates the curve's final base reserve sits above `BASE_VIRTUAL_FLOOR`, so the
     * graduation seed comes out BELOW `DOKU_SEED_BASE` — which `DokuGraduation` refuses outright,
     * with no tolerance below. `release` is only reachable through `graduate`, so a market that
     * filled successfully holds its entire raise forever.
     *
     * The blast radius is why the rule is enforced here and not only at the curve: a target is one
     * admin-chosen number per quote asset, shared by every market ever launched in it. Refusing it
     * at configuration time is the difference between one failed transaction and a launch queue
     * that bricks every market it produces.
     */
    function test_aTargetNotDivisibleByFiveIsRefusedAtBothDoors() public {
        vm.startPrank(OWNER);
        // 2,424,242 raw of a six-decimal gold token — the natural conversion of this project's own
        // spec figure, and one of the values that bricked.
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.TargetNotDivisibleByFive.selector, uint256(2_424_242)));
        reg.register(address(usdc), 2_424_242);

        reg.register(address(usdc), USDC_TARGET);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.TargetNotDivisibleByFive.selector, uint256(10_000e6 + 1)));
        reg.setQuoteTarget(address(usdc), 10_000e6 + 1);
        // The multiple either side of it is fine, so the rule is divisibility and not magnitude.
        reg.setQuoteTarget(address(usdc), 10_000e6);
        vm.stopPrank();
        assertEq(reg.quoteTarget(address(usdc)), 10_000e6, "a legal target was refused");
    }

    function test_setQuoteTargetChangesFutureLaunchesOnly() public {
        vm.startPrank(OWNER);
        reg.register(address(0), MON_TARGET);
        vm.expectEmit(true, false, false, true);
        emit QuoteTargetChanged(address(0), MON_TARGET, 5_000e18);
        reg.setQuoteTarget(address(0), 5_000e18);
        vm.stopPrank();
        assertEq(reg.quoteTarget(address(0)), 5_000e18);
    }

    function test_unknownAssetCannotBeTunedOrToggled() public {
        vm.startPrank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.NotRegistered.selector, address(usdc)));
        reg.setQuoteTarget(address(usdc), 1);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.NotRegistered.selector, address(usdc)));
        reg.setEnabled(address(usdc), true);
        vm.stopPrank();
    }

    function test_setEnabledTogglesWithoutForgetting() public {
        vm.startPrank(OWNER);
        reg.register(address(usdc), USDC_TARGET);
        vm.expectEmit(true, false, false, true);
        emit QuoteAssetEnabled(address(usdc), false);
        reg.setEnabled(address(usdc), false);
        assertFalse(reg.isEnabled(address(usdc)));
        // Disabling is a gate on NEW launches, not an erasure: the target and decimals survive.
        assertEq(reg.quoteTarget(address(usdc)), USDC_TARGET, "disabling forgot the target");
        reg.setEnabled(address(usdc), true);
        assertTrue(reg.isEnabled(address(usdc)));
        vm.stopPrank();
    }

    function test_everyWriteIsOwnerOnly() public {
        vm.prank(OWNER);
        reg.register(address(0), MON_TARGET);
        vm.startPrank(address(0xBAD));
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(0xBAD));
        vm.expectRevert(err);
        reg.register(address(usdc), USDC_TARGET);
        vm.expectRevert(err);
        reg.setQuoteTarget(address(0), 1e18);
        vm.expectRevert(err);
        reg.setEnabled(address(0), false);
        vm.stopPrank();
    }

    function test_ownershipTransferIsTwoStep() public {
        vm.prank(OWNER);
        reg.transferOwnership(address(0xDECAF));
        assertEq(reg.owner(), OWNER, "ownership moved without acceptance");
        vm.prank(address(0xDECAF));
        reg.acceptOwnership();
        assertEq(reg.owner(), address(0xDECAF));
    }
}
