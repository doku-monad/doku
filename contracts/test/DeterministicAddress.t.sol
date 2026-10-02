// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {Launches} from "./helpers/Launches.sol";
import {Wiring} from "./helpers/Wiring.sol";

/// @notice A market's address must be knowable before it exists.
///
/// @dev Not a convenience. Without it the interface cannot show a market page until the indexer
///      has ingested the launch — so the creator, at the one moment they are most likely to be
///      watching, gets a 404. The salt is `(creator, nonce)`: a creator's NEXT market is predictable,
///      and nobody else's launch can move it.
contract DeterministicAddressTest is Test {
    using Launches for DokuFactory;

    address constant OWNER = address(0x01);
    address constant CREATOR = address(0xC0DE);
    address constant OTHER = address(0x07E4);
    uint256 constant TARGET = 1_000e18;

    DokuFactory factory;

    function setUp() public {
        QuoteRegistry registry = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        registry.register(address(0), TARGET);
        factory = new DokuFactory(OWNER, OWNER, OWNER, address(registry), address(new CreatorSink(OWNER)), 0);
        // The factory ships paused with no graduator now; `wire` is the unit-test shortcut to a
        // verified dependency graph. See `test/helpers/Wiring.sol`.
        Wiring.wire(factory, OWNER);
    }

    function test_predictedAddressMatchesTheLaunchedMarket() public {
        (address predictedCurve, address predictedToken) = factory.predictMarket(CREATOR);
        vm.startPrank(CREATOR);
        (address curve, address token) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertEq(curve, predictedCurve, "curve address not predictable");
        assertEq(token, predictedToken, "token address not predictable");
    }

    /// Another creator's launch must not move the prediction; the creator's own does, by design.
    function test_predictionIsStableAcrossOtherCreatorsLaunches() public {
        (address predictedBefore,) = factory.predictMarket(CREATOR);
        vm.startPrank(OTHER);
        factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        (address predictedAfter,) = factory.predictMarket(CREATOR);
        assertEq(predictedBefore, predictedAfter, "another creator's launch moved the prediction");

        vm.startPrank(CREATOR);
        (address curve1,) = factory.launch(factory.native(Sinks.BURN));
        vm.stopPrank();
        assertEq(curve1, predictedBefore, "prediction did not survive");
        assertEq(factory.nonces(CREATOR), 1);
        (address next,) = factory.predictMarket(CREATOR);
        assertTrue(next != curve1, "the nonce did not advance");
        vm.startPrank(CREATOR);
        (address curve2,) = factory.launch(factory.native(Sinks.REWARDS));
        vm.stopPrank();
        assertEq(curve2, next, "second prediction wrong");
    }

    function test_differentCreatorsGetDifferentAddresses() public view {
        (address a,) = factory.predictMarket(CREATOR);
        (address b,) = factory.predictMarket(OTHER);
        assertTrue(a != b, "two creators collided");
    }

    /// The curve and the token must never be the same address, even sharing a salt.
    function test_curveAndTokenDoNotCollide() public view {
        (address curve, address token) = factory.predictMarket(CREATOR);
        assertTrue(curve != token, "curve and token collided");
    }
}
