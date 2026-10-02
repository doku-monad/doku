// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuToken} from "../src/DokuToken.sol";

contract DokuTokenTest is Test {
    DokuToken impl;
    DokuToken token;
    address constant CURVE = address(0xC0FFEE);
    address constant ALICE = address(0xA11CE);

    function setUp() public {
        impl = new DokuToken();
        token = DokuToken(Clones.clone(address(impl)));
        token.initialize("Fire Token", "FIRE", CURVE, false, "https://cdn.doku.family/metadata/test.json");
    }

    /// The symbol is the creator's ticker, verbatim. No emoji, no normalisation, no uniqueness —
    /// the factory validates the charset and the board shows the address.
    function test_metadata() public view {
        assertEq(token.name(), "Fire Token");
        assertEq(token.symbol(), "FIRE");
        assertEq(token.decimals(), 18);
    }

    function test_wholeSupplyMintedToCurve() public view {
        assertEq(token.totalSupply(), 1_000_000_000e18);
        assertEq(token.balanceOf(CURVE), 1_000_000_000e18, "curve does not hold the supply");
    }

    function test_cannotReinitialise() public {
        vm.expectRevert(DokuToken.AlreadyInitialised.selector);
        token.initialize("x", "x", CURVE, false, "https://cdn.doku.family/metadata/test.json");
    }

    /// The implementation itself must not be initialisable, or someone can claim it and confuse
    /// explorers and indexers that resolve clones back to their template.
    function test_implementationCannotBeInitialised() public {
        vm.expectRevert(DokuToken.AlreadyInitialised.selector);
        impl.initialize("x", "x", CURVE, false, "https://cdn.doku.family/metadata/test.json");
    }

    function test_zeroCurveReverts() public {
        DokuToken t = DokuToken(Clones.clone(address(impl)));
        vm.expectRevert(DokuToken.ZeroCurve.selector);
        t.initialize("x", "x", address(0), false, "https://cdn.doku.family/metadata/test.json");
    }

    /// The entire reason the tax lives on the curve rather than in the token: a fee-on-transfer
    /// ERC20 cannot trade in a Uniswap V3 pool, because V3 settles on exact balance deltas and
    /// reverts when less arrives than it asked for. What is sent must be what arrives, always.
    /// See docs/doku/01-architecture-decisions.md §3.1.
    function testFuzz_transferIsLossless(uint128 amount) public {
        amount = uint128(bound(amount, 1, 1_000_000_000e18));
        vm.prank(CURVE);
        token.transfer(ALICE, amount);
        assertEq(token.balanceOf(ALICE), amount, "token skimmed a fee on transfer");
    }

    function testFuzz_transferFromIsLossless(uint128 amount) public {
        amount = uint128(bound(amount, 1, 1_000_000_000e18));
        vm.prank(CURVE);
        token.approve(address(this), amount);
        token.transferFrom(CURVE, ALICE, amount);
        assertEq(token.balanceOf(ALICE), amount, "token skimmed a fee on transferFrom");
    }

    /// No mint path may exist after initialisation — supply is fixed forever.
    function test_supplyIsFixed() public {
        vm.prank(CURVE);
        token.transfer(ALICE, 1e18);
        assertEq(token.totalSupply(), 1_000_000_000e18, "supply moved");
    }
}
