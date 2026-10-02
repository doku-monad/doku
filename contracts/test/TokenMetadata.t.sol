// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {Strings} from "openzeppelin/utils/Strings.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {Launches} from "./helpers/Launches.sol";
import {Wiring} from "./helpers/Wiring.sol";

/// @notice Token metadata, generation 6: every clone carries the URI of its own metadata document,
///         the factory derives it from the clone's address, and nothing can move it afterwards.
contract TokenMetadataTest is Test {
    using Launches for DokuFactory;

    address constant OWNER = address(0x01);
    address constant TREASURY = address(0x7EA);
    address constant CREATOR = address(0xC0DE);
    address constant OTHER = address(0x0DD);
    address constant CURVE = address(0xC0FFEE);
    uint256 constant MON_TARGET = 1_000e18;
    string constant BASE = "https://cdn.doku.family/metadata/";

    DokuFactory factory;
    QuoteRegistry registry;
    CreatorSink sink;
    DokuToken impl;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        registry.register(address(0), MON_TARGET);
        sink = new CreatorSink(OWNER);
        factory = new DokuFactory(OWNER, OWNER, TREASURY, address(registry), address(sink), 0);
        Wiring.wire(factory, OWNER);
        vm.prank(OWNER);
        sink.setFactory(address(factory));
        vm.deal(CREATOR, 100_000e18);
        impl = new DokuToken();
    }

    function _launch(address who) internal returns (address curve, address token) {
        DokuFactory.LaunchParams memory p = factory.native(Sinks.BURN);
        vm.prank(who);
        (curve, token) = factory.launch(p);
    }

    // --------------------------------------------------------------------------- the clone

    function test_cloneReturnsItsOwnURI() public {
        DokuToken t = DokuToken(Clones.clone(address(impl)));
        t.initialize("Fire", "FIRE", CURVE, false, "https://cdn.doku.family/metadata/0xabc.json");
        assertEq(t.metadataURI(), "https://cdn.doku.family/metadata/0xabc.json");
    }

    /// ERC-7572 is the same document under the name explorers and marketplaces already read.
    function test_contractURIIsTheSameDocument() public {
        DokuToken t = DokuToken(Clones.clone(address(impl)));
        t.initialize("Fire", "FIRE", CURVE, false, "https://x/1.json");
        assertEq(t.contractURI(), t.metadataURI());
    }

    /// The ERC-7572 signal, so an indexer keyed on the event needs no polling.
    function test_initialiseEmitsContractURIUpdated() public {
        DokuToken t = DokuToken(Clones.clone(address(impl)));
        vm.expectEmit(true, true, true, true, address(t));
        emit DokuToken.ContractURIUpdated();
        t.initialize("Fire", "FIRE", CURVE, false, "https://x/1.json");
    }

    /// A token nobody can find metadata for is the failure this field exists to end.
    function test_emptyURIReverts() public {
        DokuToken t = DokuToken(Clones.clone(address(impl)));
        vm.expectRevert(DokuToken.EmptyMetadataURI.selector);
        t.initialize("Fire", "FIRE", CURVE, false, "");
    }

    /// Two clones of one implementation, two URIs, neither able to see the other's.
    function test_eachCloneHasItsOwnURI() public {
        DokuToken a = DokuToken(Clones.clone(address(impl)));
        DokuToken b = DokuToken(Clones.clone(address(impl)));
        a.initialize("A", "AAA", CURVE, false, "https://x/a.json");
        b.initialize("B", "BBB", CURVE, true, "https://x/b.json");
        assertEq(a.metadataURI(), "https://x/a.json");
        assertEq(b.metadataURI(), "https://x/b.json");
        // And the implementation, initialised empty in its constructor, carries none.
        assertEq(impl.metadataURI(), "");
    }

    /// The only write path is `initialize`, which runs once. There is no setter to be unauthorised
    /// on: a call to any such name lands on a contract with no fallback and reverts.
    function test_nobodyCanChangeAURIAfterLaunch() public {
        DokuToken t = DokuToken(Clones.clone(address(impl)));
        t.initialize("Fire", "FIRE", CURVE, false, "https://x/1.json");

        vm.expectRevert(DokuToken.AlreadyInitialised.selector);
        t.initialize("Fire", "FIRE", CURVE, false, "https://x/2.json");

        (bool ok,) = address(t).call(abi.encodeWithSignature("setMetadataURI(string)", "https://x/2.json"));
        assertFalse(ok, "a setter answered");
        (ok,) = address(t).call(abi.encodeWithSignature("setContractURI(string)", "https://x/2.json"));
        assertFalse(ok, "a setter answered");
        assertEq(t.metadataURI(), "https://x/1.json");
    }

    // ------------------------------------------------------------------------- the factory

    /// The factory names the document after the clone's own address, lowercase hex, `.json`.
    function test_factoryInitialisesTheURIFromTheTokenAddress() public {
        (, address token) = _launch(CREATOR);
        string memory expected = string.concat(BASE, Strings.toHexString(token), ".json");
        assertEq(DokuToken(token).metadataURI(), expected);
        assertEq(DokuToken(token).contractURI(), expected);
        assertEq(factory.metadataURIFor(token), expected);
    }

    /// `predictMarket` + `metadataURIFor` name the document before the launch lands — the interface
    /// can publish it first and the token points at it from its first block.
    function test_uriIsKnowableBeforeLaunch() public {
        (, address predicted) = factory.predictMarket(CREATOR);
        string memory ahead = factory.metadataURIFor(predicted);
        (, address token) = _launch(CREATOR);
        assertEq(token, predicted);
        assertEq(DokuToken(token).metadataURI(), ahead);
    }

    function test_twoLaunchesTwoURIs() public {
        (, address a) = _launch(CREATOR);
        (, address b) = _launch(CREATOR);
        assertTrue(a != b);
        assertTrue(keccak256(bytes(DokuToken(a).metadataURI())) != keccak256(bytes(DokuToken(b).metadataURI())));
        assertEq(DokuToken(a).metadataURI(), string.concat(BASE, Strings.toHexString(a), ".json"));
        assertEq(DokuToken(b).metadataURI(), string.concat(BASE, Strings.toHexString(b), ".json"));
    }

    /// The base moves FUTURE launches only. A token already initialised keeps its own string.
    function test_baseChangeReachesOnlyFutureLaunches() public {
        (, address before) = _launch(CREATOR);
        vm.prank(OWNER);
        vm.expectEmit(true, true, true, true, address(factory));
        emit DokuFactory.MetadataBaseURIChanged(BASE, "https://meta.doku.family/v2/");
        factory.setMetadataBaseURI("https://meta.doku.family/v2/");
        (, address later) = _launch(CREATOR);
        assertEq(DokuToken(before).metadataURI(), string.concat(BASE, Strings.toHexString(before), ".json"));
        assertEq(
            DokuToken(later).metadataURI(),
            string.concat("https://meta.doku.family/v2/", Strings.toHexString(later), ".json")
        );
    }

    function test_onlyOwnerSetsTheBase() public {
        vm.prank(OTHER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OTHER));
        factory.setMetadataBaseURI("https://evil/");
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, CREATOR));
        factory.setMetadataBaseURI("https://evil/");
        assertEq(factory.metadataBaseURI(), BASE);
    }

    function test_emptyBaseRefused() public {
        vm.prank(OWNER);
        vm.expectRevert(DokuFactory.ZeroAddress.selector);
        factory.setMetadataBaseURI("");
    }

    /// The creator's `setMetadata` rewrites the DOCUMENT's inputs (the indexer republishes the
    /// JSON) and never the URI: the token's pointer is not theirs to move.
    function test_setMetadataDoesNotTouchTheURI() public {
        (address curve, address token) = _launch(CREATOR);
        string memory uri = DokuToken(token).metadataURI();
        DokuFactory.Metadata memory m = Launches.meta("Fire Token", "FIRE");
        m.description = "renamed description";
        vm.prank(CREATOR);
        factory.setMetadata(curve, m);
        assertEq(DokuToken(token).metadataURI(), uri);
    }

    /// The supply, the curve and the history flag are exactly what they were: the new field is
    /// appended, and nothing generation 5 relied on moved.
    function test_existingInitialisationUnchanged() public {
        (address curve, address token) = _launch(CREATOR);
        DokuToken t = DokuToken(token);
        assertEq(t.curve(), curve);
        assertEq(t.totalSupply(), t.TOTAL_SUPPLY());
        assertEq(t.balanceOf(curve) + t.balanceOf(CREATOR), t.TOTAL_SUPPLY());
        assertEq(t.name(), "Fire Token");
        assertEq(t.symbol(), "FIRE");
        assertFalse(t.trackHistory());
    }
}
