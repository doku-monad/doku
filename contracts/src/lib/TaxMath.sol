// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/// @title TaxMath
/// @notice Decay curve for the anti-sniper buy tax. Mode, start rate and window are launch
///         parameters held by `DokuFactory.taxTerms` and snapshotted into each curve.
/// @dev `CLOCK` decays on a timer, `PROGRESS` with the raise, `MAX` takes the larger of the two.
///      See docs/doku/01-architecture-decisions.md §8.4 for the trade-off.
library TaxMath {
    enum Mode {
        CLOCK,
        PROGRESS,
        MAX
    }

    /// @param mode     which axis the tax decays along
    /// @param startBps tax at launch in basis points, e.g. 5000 = 50%
    /// @param window   seconds over which CLOCK decays to zero
    /// @param elapsed  seconds since launch
    /// @param progress fraction of the quote target raised, scaled to 1e18
    /// @return the tax rate in basis points, never above `startBps`
    function rate(Mode mode, uint16 startBps, uint32 window, uint256 elapsed, uint256 progress)
        internal
        pure
        returns (uint16)
    {
        if (mode == Mode.CLOCK) return _clock(startBps, window, elapsed);
        if (mode == Mode.PROGRESS) return _progress(startBps, progress);
        uint16 c = _clock(startBps, window, elapsed);
        uint16 p = _progress(startBps, progress);
        return c > p ? c : p;
    }

    /// @dev A zero window switches the CLOCK term off rather than dividing by zero. It does not switch
    ///      the tax off: `PROGRESS` never reads the window, and `MAX` with a zero window is `PROGRESS`.
    function _clock(uint16 startBps, uint32 window, uint256 elapsed) private pure returns (uint16) {
        if (window == 0 || elapsed >= window) return 0;
        // `elapsed < window`, so the result is bounded by `startBps` and the cast cannot truncate.
        return uint16(uint256(startBps) * (window - elapsed) / window);
    }

    function _progress(uint16 startBps, uint256 progress) private pure returns (uint16) {
        if (progress >= 1e18) return 0;
        // Same bound as `_clock`.
        return uint16(uint256(startBps) * (1e18 - progress) / 1e18);
    }
}
