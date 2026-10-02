// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {BondingCurve, DOKU_MIN_QUOTE_TARGET, DOKU_MAX_QUOTE_TARGET} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockGraduator} from "../mocks/MockGraduator.sol";

/**
 * # L-04 — the registry enforced three of the four bounds on a quote target
 *
 * `QuoteRegistry._checkTarget` refused zero, refused anything below `DOKU_MIN_QUOTE_TARGET`, and
 * required divisibility by five. It never looked at the ceiling. `BondingCurve.initialize` does
 * (`src/BondingCurve.sol:333`, `TargetTooLarge` above `MAX_QUOTE_TARGET = 1e30`), so the two ends
 * disagreed: an owner could register an asset, watch `isEnabled` answer true, and have every launch
 * in it revert during curve initialisation with nothing in the registry to explain why.
 *
 * The severity is Low and the reason is worth stating plainly rather than being generous about it:
 * `register` and `setQuoteTarget` are `onlyOwner`. Nobody but the owner can put the system into
 * this state, and the owner can leave it with one more owner-only call. It is a footgun, not an
 * attack — the same shape as `TargetTooSmall`, which is already refused HERE precisely because the
 * registry is where the number is chosen.
 *
 * The fix follows the pattern already in the file: `DOKU_MIN_QUOTE_TARGET` is a FILE-LEVEL constant
 * in `BondingCurve.sol` that `QuoteRegistry` imports, because Solidity cannot read another
 * contract's constant without a call and a duplicated literal is how two ends drift apart. There is
 * now a `DOKU_MAX_QUOTE_TARGET` beside it, and `BondingCurve.MAX_QUOTE_TARGET` is defined AS it, so
 * the curve and the registry cannot disagree even in principle.
 */
contract L04TargetBoundTest is Test {
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);

    QuoteRegistry internal registry;
    MockUSDC internal usdc;

    function setUp() public {
        registry = new QuoteRegistry(address(this));
        usdc = new MockUSDC();
    }

    /// @notice The two constants are one constant.
    /// @dev Read off a real `BondingCurve` rather than through the type: both bounds are `public
    ///      constant`, so what the outside world can see is the GETTER, and the getter is what a
    ///      client, a script and the registry's own reasoning actually depend on.
    function test_theCurveAndTheRegistryReadTheSameCeiling() public {
        BondingCurve impl = new BondingCurve();
        assertEq(impl.MAX_QUOTE_TARGET(), DOKU_MAX_QUOTE_TARGET, "the ceiling is duplicated, not shared");
        assertEq(impl.MIN_QUOTE_TARGET(), DOKU_MIN_QUOTE_TARGET, "the floor is duplicated, not shared");
        assertEq(DOKU_MAX_QUOTE_TARGET, 1e30, "the ceiling moved; every launch bound moved with it");
    }

    /// @notice A target above the curve's ceiling is now refused where it is CHOSEN.
    function test_registerRefusesATargetEveryLaunchWouldReject() public {
        uint256 tooBig = DOKU_MAX_QUOTE_TARGET + 5; // divisible by five, so only the ceiling can refuse it
        vm.expectRevert(
            abi.encodeWithSelector(QuoteRegistry.TargetTooLarge.selector, tooBig, DOKU_MAX_QUOTE_TARGET)
        );
        registry.register(address(usdc), tooBig);
    }

    /// @notice And on the setter too, which is the path a live asset would actually be broken by.
    function test_setQuoteTargetRefusesTheSame() public {
        registry.register(address(usdc), 8_000e6);
        uint256 tooBig = DOKU_MAX_QUOTE_TARGET + 5;
        vm.expectRevert(
            abi.encodeWithSelector(QuoteRegistry.TargetTooLarge.selector, tooBig, DOKU_MAX_QUOTE_TARGET)
        );
        registry.setQuoteTarget(address(usdc), tooBig);
    }

    /// @notice The boundary itself is legal, on both sides of the wall.
    function test_exactlyTheMaximumIsAccepted() public {
        registry.register(address(usdc), DOKU_MAX_QUOTE_TARGET);
        assertEq(registry.quoteTarget(address(usdc)), DOKU_MAX_QUOTE_TARGET, "the maximum should register");

        // And the curve agrees, which is the whole point of sharing the constant.
        BondingCurve c = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        DokuToken t = DokuToken(Clones.clone(address(new DokuToken())));
        t.initialize(unicode"D", unicode"D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            address(usdc),
            DOKU_MAX_QUOTE_TARGET,
            Sinks.BURN,
            address(0),
            0,
            ALICE,
            TREASURY,
            address(new MockGraduator()),
            address(0xDEAD)
        );
        assertEq(c.quoteTarget(), DOKU_MAX_QUOTE_TARGET, "the curve refused a target the registry accepted");
    }

    /**
     * @notice The property, as an equivalence rather than as two examples: the registry accepts a
     *         target if and only if a curve would.
     * @dev This is what L-04 was really about. Any target either door accepts, the other must, or
     *      the launch queue breaks for the whole asset. Fuzzed rather than sampled, because the
     *      original defect lived in exactly the region no fixture visited.
     */
    function testFuzz_registryAndCurveAgreeOnEveryTarget(uint256 target) public {
        bool registryAccepts = true;
        try registry.register(address(usdc), target) {}
        catch {
            registryAccepts = false;
        }

        // The curve's own bounds, as `initialize` applies them. Divisibility by five is a registry
        // rule and not a curve rule, so it is excluded from the comparison — it is the one place
        // the two are intentionally different, and the registry is deliberately the stricter side.
        bool curveAccepts = target != 0 && target >= DOKU_MIN_QUOTE_TARGET && target <= DOKU_MAX_QUOTE_TARGET;

        if (target % 5 == 0) {
            assertEq(registryAccepts, curveAccepts, "registry and curve disagree on a divisible target");
        } else if (registryAccepts) {
            fail();
        }
    }
}
