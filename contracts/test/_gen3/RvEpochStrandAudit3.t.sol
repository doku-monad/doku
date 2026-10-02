// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {RewardVaultGen3 as RewardVault} from "../audit/RewardVaultGen3.sol";

/// @dev Stands in for DokuHook's `owedSink` ledger: holds native quote and hands it to the
///      market's sink when the sink asks. Shape-identical to what `RewardVault.fund` needs.
contract LedgerMock {
    uint256 public owed;

    function credit() external payable {
        owed += msg.value;
    }

    function pullSink(PoolId) external returns (uint256 amount) {
        amount = owed;
        owed = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "pull");
    }

    receive() external payable {}
}

/// @dev REPOINTED, 2026-09-11, and the target moved rather than the assertions. This file is the
///      record of what GENERATION 3 does — the immutable contracts that are on Monad mainnet right
///      now — so it goes on testing generation 3's bytecode, which lives in
///      `test/audit/RewardVaultGen3.sol` since `src/` was fixed. Rewriting these five to pass
///      against the fix would have destroyed the only executable description of the deployed
///      behaviour, which is the thing anyone triaging a live vault needs. The fix has its own
///      suite in `test/audit/RewardVaultFix.t.sol`.
contract RvEpochStrandAudit3 is Test {
    uint256 internal constant SUPPLY = 1_000_000_000e18;
    uint256 internal constant SEED = 222_222_222e18; // the PoolManager's locked seed
    uint256 internal constant FLOAT = SUPPLY - SEED; // 777,777,778e18

    address internal constant PM = address(0x9001); // "PoolManager"   (excluded)
    address internal constant CURVE = address(0xC0FFEE); // (excluded)
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address internal constant POSM = address(0x9002);
    address internal constant GRAD = address(0x9003);

    address internal A = address(0xA1);
    address internal B = address(0xB2);
    address internal C = address(0xC3);

    LedgerMock internal hook;
    DokuToken internal token;
    RewardVault internal vault;
    uint256 internal genesis;

    receive() external payable {}

    function setUp() public {
        vm.roll(1_000_000);
        hook = new LedgerMock();

        address impl = address(new DokuToken());
        token = DokuToken(Clones.clone(impl));
        // REWARDS markets track history; the whole supply is minted to the curve.
        token.initialize("Doku", "DOKU", CURVE, true, "https://cdn.doku.family/metadata/test.json");
        assertEq(token.balanceOf(CURVE), SUPPLY);

        genesis = block.number; // == BondingCurve.readyAtBlock

        address[8] memory ex;
        ex[0] = PM;
        ex[1] = address(hook);
        ex[2] = CURVE;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = GRAD;
        ex[6] = POSM;
        // quoteTarget 1000 MON -> minEpochAmount 0.1 MON, exactly as graduation wires it.
        vault = new RewardVault(address(hook), address(token), PoolId.wrap(bytes32(uint256(7))), address(0), 1000 ether, genesis, ex);

        // Graduation: the seed goes to the pool, the float is in holders' hands.
        vm.startPrank(CURVE);
        token.transfer(PM, SEED);
        token.transfer(A, 300_000_000e18);
        token.transfer(B, 300_000_000e18);
        token.transfer(C, FLOAT - 600_000_000e18);
        vm.stopPrank();
        assertEq(token.balanceOf(CURVE), 0);

        vm.roll(block.number + 1);
    }

    function _fund(uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        hook.credit{value: amount}();
        vault.fund();
    }

    function _tryClaim(address who, uint256 k) internal returns (uint256) {
        try vault.claim(who, k, k) returns (uint256 got) {
            return got;
        } catch {
            return 0;
        }
    }

    // ------------------------------------------------------------------------------
    // 1. An epoch's unclaimed remainder is PERMANENTLY unreachable. Not dust: with
    //    both weight checkpoints historical, every token that changes hands inside
    //    the epoch scores zero on BOTH sides, so the stranded fraction is the
    //    epoch's turnover.
    // ------------------------------------------------------------------------------
    function test_1_midEpochTurnoverIsBurnedNotRolledOver() public {
        _fund(10 ether);
        assertEq(vault.unallocated(), 10 ether);

        vm.roll(vault.snapshotBlockFor(0) + 1);
        uint256 k = vault.createEpoch();
        (, uint256 amount, uint256 es,) = vault.epochs(k);
        console2.log("epoch amount        ", amount);
        console2.log("eligibleSupply      ", es);

        // B sells its whole position to C INSIDE the epoch -- ordinary trading.
        vm.prank(B);
        token.transfer(C, 300_000_000e18);

        vm.roll(vault.snapshotBlockFor(1) + 1);

        uint256 paid = _tryClaim(A, k) + _tryClaim(B, k) + _tryClaim(C, k);
        (,,, uint256 claimed) = vault.epochs(k);
        console2.log("total paid to holders", paid);
        console2.log("epoch.claimed        ", claimed);

        uint256 stuck = address(vault).balance;
        console2.log("left in the vault    ", stuck);
        console2.log("stranded pct         ", (stuck * 100) / amount);

        assertEq(vault.unallocated(), 0, "residue was credited back");
        assertGt(stuck, amount / 4, "expected a large stranded fraction");

        // And there is NO path back. `fund` only counts the hook delta; `createEpoch`
        // only ever spends `unallocated`, which is zero.
        vault.fund();
        assertEq(vault.unallocated(), 0, "fund() recovered the residue");
        vm.roll(vault.snapshotBlockFor(1) + 2);
        vm.expectRevert(abi.encodeWithSelector(RewardVault.NotEnoughToDistribute.selector, 0, vault.minEpochAmount()));
        vault.createEpoch();

        // Still stuck, with the vault visibly holding 38% of an epoch it cannot spend.
        assertEq(address(vault).balance, stuck, "residue moved");
    }

    // ------------------------------------------------------------------------------
    // 2. Epoch INDEX is tied to the grid, but epoch AMOUNT is "everything unallocated
    //    at creation". Nothing on chain or off chain creates epochs (no keeper in
    //    src/, indexer/ or the frontend), so index k routinely opens long after its
    //    grid line -- and pays a window from the distant past the whole backlog.
    // ------------------------------------------------------------------------------
    function test_2_exitedHolderCapturesTwentyEpochsOfLaterFees() public {
        // A holds across grid lines 0 and 1 only.
        vm.roll(vault.snapshotBlockFor(1) + 1);
        vm.prank(A);
        token.transfer(C, 300_000_000e18); // A exits completely
        assertEq(token.balanceOf(A), 0);

        // Twenty epochs of trading happen. All of the levy is earned while A holds nothing.
        for (uint256 i = 2; i <= 21; ++i) {
            vm.roll(vault.snapshotBlockFor(i) + 1);
            _fund(1 ether);
        }

        // The first epoch anyone bothers to open is still index 0.
        uint256 k = vault.createEpoch();
        assertEq(k, 0);
        (uint256 snap, uint256 amount, uint256 es,) = vault.epochs(0);
        assertEq(snap, vault.snapshotBlockFor(0));
        assertEq(amount, 20 ether, "the whole backlog landed in epoch 0");

        uint256 got = vault.claim(A, 0, 0);
        console2.log("A's token balance now ", token.balanceOf(A));
        console2.log("A was paid            ", got);
        console2.log("out of                ", amount);
        assertEq(token.balanceOf(A), 0, "A still holds");
        assertGt(got, 7 ether, "A captured less than its historical share");
        es;

        // C, who bought A's bag and held it for all twenty epochs, is paid only on its
        // balance at the two ANCIENT grid lines -- nothing for the twenty it carried.
        uint256 cGot = _tryClaim(C, 0);
        console2.log("C holds               ", token.balanceOf(C));
        console2.log("C was paid            ", cGot);
        assertLt(cGot, got, "the exited whale out-earned the holder who stayed");
    }

    // ------------------------------------------------------------------------------
    // 3. DISPROOF attempt: can the sum of weights exceed eligibleSupply (the new
    //    EpochOverspent assertion, and therefore a permanent claim DoS)?
    // ------------------------------------------------------------------------------
    function testFuzz_3_weightsNeverExceedEligibleSupply(uint96 mv1, uint96 mv2, uint96 mv3) public {
        _fund(10 ether);
        vm.roll(vault.snapshotBlockFor(0) + 1);
        uint256 k = vault.createEpoch();
        (, uint256 amount, uint256 es,) = vault.epochs(k);

        // Arbitrary churn inside the epoch, including into and out of excluded addresses.
        uint256 m1 = uint256(mv1) % (300_000_000e18);
        uint256 m2 = uint256(mv2) % (300_000_000e18);
        uint256 m3 = uint256(mv3) % (100_000_000e18);
        vm.prank(A);
        token.transfer(C, m1);
        vm.prank(B);
        token.transfer(PM, m2); // into an excluded address
        vm.prank(C);
        token.transfer(DEAD, m3); // into another excluded address
        vm.roll(vault.snapshotBlockFor(1) + 1);

        uint256 sumW = vault.weightOf(A, k) + vault.weightOf(B, k) + vault.weightOf(C, k);
        assertLe(sumW, es, "sum of weights exceeded the denominator");

        uint256 paid = _tryClaim(A, k) + _tryClaim(B, k) + _tryClaim(C, k);
        (,,, uint256 claimed) = vault.epochs(k);
        assertLe(claimed, amount, "epoch overspent");
        assertEq(paid, claimed, "paid != claimed");
    }

    // ------------------------------------------------------------------------------
    // 4. DISPROOF attempt: double payment across the maturity boundary.
    // ------------------------------------------------------------------------------
    function test_4_noDoublePayAcrossMaturity() public {
        _fund(10 ether);
        vm.roll(vault.snapshotBlockFor(0) + 1);
        vault.createEpoch();
        vm.roll(vault.snapshotBlockFor(1) + 1);
        uint256 first = vault.claim(A, 0, 0);
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(A, 0, 0);
        // and much later, after more grid lines have passed
        vm.roll(vault.snapshotBlockFor(9) + 1);
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(A, 0, 0);
        assertGt(first, 0);
    }

    // ------------------------------------------------------------------------------
    // 5. The loss is NOT a keeper problem. Run an IDEAL keeper -- one createEpoch the
    //    block after every grid line, every claimant claiming the moment an epoch
    //    matures -- with ordinary 20%-per-epoch turnover. The vault still accumulates
    //    dead quote it can never spend, epoch after epoch.
    // ------------------------------------------------------------------------------
    function test_5_idealKeeperStillBurnsTheTurnoverEveryEpoch() public {
        uint256 funded;
        for (uint256 k; k < 6; ++k) {
            vm.roll(vault.snapshotBlockFor(k) + 1);
            _fund(10 ether);
            funded += 10 ether;
            vault.createEpoch();
            // Ordinary churn INSIDE the epoch: A rotates 40M (5.1% of the float) to B.
            vm.prank(A);
            token.transfer(B, 40_000_000e18);
            // The keeper claims every matured epoch for every holder, immediately.
            for (uint256 j; j < k; ++j) {
                _tryClaim(A, j);
                _tryClaim(B, j);
                _tryClaim(C, j);
            }
        }
        vm.roll(vault.snapshotBlockFor(7) + 1);
        for (uint256 j; j < 6; ++j) {
            _tryClaim(A, j);
            _tryClaim(B, j);
            _tryClaim(C, j);
        }

        uint256 dead = address(vault).balance - vault.unallocated();
        console2.log("funded in total     ", funded);
        console2.log("unallocated         ", vault.unallocated());
        console2.log("unspendable residue ", dead);
        console2.log("residue pct of spend", (dead * 100) / funded);
        assertEq(vault.unallocated(), 0, "keeper left something unallocated");
        assertGt(dead, 0, "no residue");
    }
}
