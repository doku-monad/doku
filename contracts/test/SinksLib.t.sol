// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Sinks} from "../src/lib/Sinks.sol";

/// @notice The sink discriminants are an ABI: the factory writes one, three contracts read it, and
///         an indexer maps it to the UI's routing labels. Pinned so nobody renumbers them.
contract SinksLibTest is Test {
    function test_discriminantsArePinned() public pure {
        assertEq(Sinks.BURN, 0, "buyback moved");
        assertEq(Sinks.REWARDS, 1, "holders moved");
        assertEq(Sinks.CREATOR, 2, "creator moved");
    }

    function test_isValidAcceptsExactlyTheThree() public pure {
        assertTrue(Sinks.isValid(Sinks.BURN));
        assertTrue(Sinks.isValid(Sinks.REWARDS));
        assertTrue(Sinks.isValid(Sinks.CREATOR));
        assertFalse(Sinks.isValid(3), "an unknown sink was accepted");
        assertFalse(Sinks.isValid(type(uint8).max));
    }
}
