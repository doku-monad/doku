// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {DokuFactory} from "../../src/DokuFactory.sol";

/// @notice Builders for `LaunchParams`, so a test that launches a market states only what it is
///         about. The pin is read from the factory, which is exactly what a client does.
library Launches {
    function meta(string memory name, string memory ticker)
        internal
        pure
        returns (DokuFactory.Metadata memory m)
    {
        m.name = name;
        m.ticker = ticker;
    }

    function params(DokuFactory f, address quote, uint8 sink, uint16 taxBps)
        internal
        view
        returns (DokuFactory.LaunchParams memory p)
    {
        p.meta = meta("Fire Token", "FIRE");
        p.quoteAsset = quote;
        p.sink = sink;
        p.creatorTaxBps = taxBps;
        p.economicsPin = f.economicsPin(quote, sink, taxBps);
        p.deadline = block.timestamp + 1 hours;
    }

    function native(DokuFactory f, uint8 sink) internal view returns (DokuFactory.LaunchParams memory) {
        return params(f, address(0), sink, 0);
    }
}
