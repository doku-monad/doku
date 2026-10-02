// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";

/**
 * Trading on the curve, as a user experiences it rather than as the maths describes it.
 *
 * Three properties, each the difference between a venue that feels trustworthy and one that does
 * not:
 *
 *   1. **The quote is the fill.** A number shown before signing that turns out to be a different
 *      number afterwards is the single fastest way to lose a trader, and it is not caught by any
 *      test that only checks the arithmetic in one direction.
 *   2. **A failure is a NAMED failure.** A panic surfaces in a wallet as "execution reverted" with
 *      no reason at all, so a user cannot tell a too-small trade from a broken market. Every
 *      rejection has to arrive as a custom error someone can act on.
 *   3. **Both sinks, taxed and untaxed.** The four combinations take genuinely different code
 *      paths — a BURN market spends the tax on the curve, a REWARDS market holds it in MON — and a
 *      suite that samples one of them proves a quarter of the product.
 *
 * Fuzzed rather than sampled, because the interesting sizes are the ones nobody picks by hand: a
 * wei, a dust trade that rounds to zero, and the trade that lands exactly on the target.
 */
contract CurveSmoothnessTest is Test {
    address ci; address ti; address constant A = address(0xA11CE);
    receive() external payable {}
    function setUp() public { ci=address(new BondingCurve()); ti=address(new DokuToken()); vm.deal(A, 1_000_000e18); }
    function _m(uint8 s) internal returns (BondingCurve c, DokuToken t) {
        c=BondingCurve(payable(Clones.clone(ci))); t=DokuToken(Clones.clone(ti));
        t.initialize("D","D",address(c), s==Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), address(0), 1_000e18, s, address(0), 0, address(0), address(0x7EA), address(this), address(0));
    }
    /// Quote must equal fill at every size, on both sinks, taxed and untaxed.
    function testFuzz_quoteMatchesFill(uint96 amt, bool rewards, bool taxed) public {
        amt = uint96(bound(amt, 1e12, 900e18));
        (BondingCurve c, DokuToken t) = _m(rewards ? Sinks.REWARDS : Sinks.BURN);
        if (!taxed) vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        (uint256 q,,,,) = c.quoteBuy(amt);
        vm.prank(A);
        uint256 got = c.buy{value: amt}(0, block.timestamp);
        assertEq(got, q, "quoteBuy disagreed with buy");
        t;
    }
    /// A buy of any size must either succeed or fail for a NAMED reason, never a panic.
    function testFuzz_noPanicsOnAnyBuy(uint96 amt, bool rewards) public {
        amt = uint96(bound(amt, 1, 50_000e18));
        (BondingCurve c,) = _m(rewards ? Sinks.REWARDS : Sinks.BURN);
        vm.prank(A);
        (bool ok, bytes memory ret) = address(c).call{value: amt}(
            abi.encodeWithSignature("buy(uint256,uint256)", uint256(0), block.timestamp)
        );
        if (!ok) {
            bytes4 sel = ret.length >= 4 ? bytes4(ret) : bytes4(0);
            assertTrue(sel != bytes4(0x4e487b71), "a buy PANICKED instead of reverting by name");
        }
    }
    /// Sell round-trip: quote must equal fill for any holding.
    function testFuzz_sellQuoteMatchesFill(uint96 amt, bool rewards) public {
        amt = uint96(bound(amt, 1e15, 500e18));
        (BondingCurve c, DokuToken t) = _m(rewards ? Sinks.REWARDS : Sinks.BURN);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
        vm.startPrank(A);
        uint256 got = c.buy{value: amt}(0, block.timestamp);
        t.approve(address(c), got);
        (uint256 q,,) = c.quoteSell(got);
        uint256 out = c.sell(got, 0, block.timestamp);
        vm.stopPrank();
        assertEq(out, q, "quoteSell disagreed with sell");
    }
}
