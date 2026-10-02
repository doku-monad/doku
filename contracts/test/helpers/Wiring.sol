// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";

/// @notice A graduator that answers `factory()` and nothing else — the minimum `setGraduator`
///         accepts, and deliberately the minimum, so a test proving activation is what closes the
///         remaining holes is not quietly relying on a stub that closes them itself.
contract StubGraduator {
    address public factory;

    constructor(address factory_) {
        factory = factory_;
    }
}

/// @notice Brings a unit-test factory from "constructed" to "activated" without making every test
///         in the suite stand up a real hook, a real Uniswap v4 and a real shared sink.
///
/// @dev The factory now ships PAUSED with no graduator, because a factory that can launch before
///      its dependency graph has been read is a factory that pins unverified custody into every
///      market it makes. That is the right default and it is also a tax on every unit test that
///      only ever wanted to check a byte length or a fee — so this library pays the tax once.
///
///      It works by MOCKING rather than by deploying: `vm.etch` gives each declared dependency a
///      byte of code so `_mustBeContract` is satisfied, and `vm.mockCall` supplies the accessor each
///      identity check reads. That keeps it usable with whatever graduator a test already has,
///      including one that records calls or refuses them, instead of forcing every test onto a
///      single stub. The one thing it does not do is pretend: every address it declares is a real
///      address the factory will store, and `validateDeployment()` genuinely passes against them.
library Wiring {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Declare and verify a dependency graph for `f`, and open it for launches.
    /// @param graduator the graduator ALREADY set on `f` via `setGraduator`
    function activate(DokuFactory f, address owner, address graduator)
        internal
        returns (DokuFactory.Dependencies memory d)
    {
        d = declare(f, graduator);
        vm.prank(owner);
        f.activate(d);
    }

    /// @notice Build the declaration and install the mocks, without activating. For a test that
    ///         wants to break exactly one wire and watch `activate` refuse it.
    function declare(DokuFactory f, address graduator) internal returns (DokuFactory.Dependencies memory d) {
        address sink = f.creatorSink();
        d = DokuFactory.Dependencies({
            graduator: graduator,
            hook: _addr(f, "hook"),
            creatorSink: sink,
            poolManager: _addr(f, "poolManager"),
            positionManager: _addr(f, "positionManager"),
            permit2: _addr(f, "permit2")
        });

        // Code, so the EOA refusal is satisfied by something that is genuinely not an EOA.
        _code(d.hook);
        _code(d.poolManager);
        _code(d.positionManager);
        _code(d.permit2);
        _code(d.creatorSink);
        _code(d.graduator);

        // The graduator's immutables. `factory()` is left alone: the real one already answers it,
        // and it is the one wire `setGraduator` checks for itself.
        vm.mockCall(graduator, abi.encodeWithSignature("hook()"), abi.encode(d.hook));
        vm.mockCall(graduator, abi.encodeWithSignature("poolManager()"), abi.encode(d.poolManager));
        vm.mockCall(graduator, abi.encodeWithSignature("positionManager()"), abi.encode(d.positionManager));
        vm.mockCall(graduator, abi.encodeWithSignature("permit2()"), abi.encode(d.permit2));

        // The hook.
        vm.mockCall(d.hook, abi.encodeWithSignature("isGraduator(address)"), abi.encode(true));
        vm.mockCall(d.hook, abi.encodeWithSignature("creatorSink()"), abi.encode(d.creatorSink));

        // The shared sink's three one-shots.
        vm.mockCall(d.creatorSink, abi.encodeWithSignature("graduator()"), abi.encode(d.graduator));
        vm.mockCall(d.creatorSink, abi.encodeWithSignature("factory()"), abi.encode(address(f)));
        vm.mockCall(d.creatorSink, abi.encodeWithSignature("hook()"), abi.encode(d.hook));
    }

    /// @notice Deploy the minimum graduator, point the factory at it, and activate. The one-liner
    ///         a test that does not care about graduation at all wants in `setUp`.
    function wire(DokuFactory f, address owner) internal returns (address graduator) {
        graduator = address(new StubGraduator(address(f)));
        vm.prank(owner);
        f.setGraduator(graduator);
        activate(f, owner, graduator);
    }

    /// @dev Revoke the hook's allowlist, the only wire that can rot after activation.
    function revokeHookAllowlist(DokuFactory f) internal {
        (, address hook,,,,) = f.dependencies();
        vm.mockCall(hook, abi.encodeWithSignature("isGraduator(address)"), abi.encode(false));
    }

    function _addr(DokuFactory f, string memory what) private pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(address(f), what)))));
    }

    function _code(address a) private {
        if (a.code.length == 0) vm.etch(a, hex"fe");
    }
}
