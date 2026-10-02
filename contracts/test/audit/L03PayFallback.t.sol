// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
import {MockGraduator} from "../mocks/MockGraduator.sol";
import {ReturnShapeToken} from "./AdversarialTokens.sol";

/**
 * # L-03 — what `_tryPay`'s success rule actually does to a malformed ERC-20 return
 *
 * `BondingCurve._payOrCredit` (src/BondingCurve.sol:931-942) is a two-stage payment: push to the
 * recipient, and if the push fails, CREDIT the amount into the shared `CreatorSink` so the money is
 * still claimable and the collection still completes. The whole design intent is that no recipient,
 * and no token's opinion about a recipient, can brick `collectFees`/`collectTax`.
 *
 * The stage-one predicate is `_tryPay` (src/BondingCurve.sol:946-954):
 *
 *     (bool ok, bytes memory ret) = quoteAsset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
 *     return ok && (ret.length == 0 || abi.decode(ret, (bool)));
 *
 * The report's claim is that `abi.decode(ret, (bool))` REVERTS for return payloads that are not a
 * clean 32-byte bool, and that because the revert happens inside the predicate rather than being
 * reported as `false`, the fallback never runs and the entire collection unwinds.
 *
 * That is a claim about the ABI decoder, and the decoder has two separate checks worth separating,
 * because a fix that only handles one of them is not a fix:
 *
 *   1. LENGTH. `abi.decode` reverts if the payload is shorter than the type needs. Covers 1 and 31.
 *   2. VALIDITY. Since 0.8, decoding to `bool` also reverts if the word is neither 0 nor 1 — the
 *      decoder validates the value, not just the size. Covers the 32-byte word of 2.
 *
 * A rule written only as `ret.length >= 32 && decodedTrue` fixes (1) and still reverts on (2), so
 * this file pins both, and pins the two shapes that must NOT change behaviour (0 bytes must stay
 * success, a 32-byte zero must stay a clean `false` that reaches the fallback).
 *
 * It also settles a question the report does not raise: what a DIRTY word should mean. Decoding the
 * word as a `uint256` removes the revert either way, but `!= 0` and `== 1` disagree about a returned
 * `2`. `!= 0` calls it success — and a token that answers `2` without moving anything then has its
 * word taken for it, the bucket is cleared, and the payment is gone. `== 1` calls it a refusal and
 * the money is deferred into the sink, where the recipient can still claim it. The repaired rule
 * uses `== 1`: an ambiguous answer should cost a `claim`, never the payment.
 *
 * `_tryPay` is `private`, so every case below goes through the real `collectTax()` on a real curve.
 * A harness that re-implemented the expression would be testing a copy of the code rather than the
 * code, and the thing under test is precisely whether the deployed shape reverts.
 */
contract L03PayFallbackTest is Test {
    address internal constant ALICE = address(0xA11CE);
    address internal constant CREATOR = address(0xC12A);
    address internal constant TREASURY = address(0xBEEF);

    /// @dev Six decimals with a coarse-but-not-degenerate target: the same shape as the registered
    ///      stablecoin quotes, so the fee and tax splits produce nonzero buckets.
    uint256 internal constant TARGET = 10_000e6;
    uint16 internal constant TAX_BPS = 500;

    ReturnShapeToken internal quote;
    CreatorSink internal sink;
    MarketsStub internal markets;
    MockGraduator internal graduator;
    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        quote = new ReturnShapeToken(6);
        markets = new MarketsStub();
        sink = new CreatorSink(address(this));
        sink.setFactory(address(markets));
        graduator = new MockGraduator();
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
    }

    /// @dev A CREATOR market carrying a creator tax, so `pendingTax` is nonzero and `collectTax`
    ///      has something to push. Everything about it is ordinary except its quote asset.
    function _market() internal returns (BondingCurve c) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), false, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            address(quote),
            TARGET,
            Sinks.CREATOR,
            CREATOR,
            TAX_BPS,
            CREATOR,
            TREASURY,
            address(graduator),
            address(sink)
        );

        // A partial fill: enough to accrue a tax bucket, nowhere near the target, so nothing
        // graduates and the only thing under test is the payment path.
        quote.mint(ALICE, TARGET);
        vm.startPrank(ALICE);
        quote.approve(address(c), type(uint256).max);
        // via_ir folds block.timestamp across cheatcodes, so the deadline is read through the
        // cheatcode accessor rather than the global. See CLAUDE.md / the suite's standing rule.
        c.buyWithToken(TARGET / 10, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        assertGt(c.pendingTax(), 0, "no tax accrued; the fixture proves nothing");
    }

    /**
     * @notice The full return-shape matrix, in one place, with the outcome of each printed.
     *
     * @dev Deliberately does NOT assert the current behaviour case by case. This test is the
     *      measurement that decides what the fix has to cover; asserting today's answers here would
     *      mean editing the evidence at the same time as the code. It asserts only the two
     *      invariants that must hold before AND after any fix — the money is never lost, and a
     *      recipient that a token simply refuses is never able to brick the collection — and prints
     *      the rest.
     */
    function test_returnShapeMatrix() public {
        uint256[6] memory lens = [uint256(0), 1, 31, 32, 32, 64];
        bytes32[6] memory words = [
            bytes32(0),
            bytes32(uint256(1) << 248), // top byte = 0x01, the honest 1-byte return
            bytes32(uint256(1) << 248),
            bytes32(0), // 32 bytes of zero: an explicit `false`
            bytes32(uint256(2)), // 32 bytes of 2: a dirty bool
            bytes32(uint256(1)) // 64 bytes, first word true
        ];
        string[6] memory labels = [
            "len 0   (USDT-shaped, no return)",
            "len 1   (top byte 0x01)",
            "len 31  (truncated word)",
            "len 32  word 0 (explicit false)",
            "len 32  word 2 (dirty bool)",
            "len 64  word 1 (over-long)"
        ];
        // Whether the token actually MOVES the value, paired with what its return value CLAIMS.
        //
        // A token that reports failure does not move value; a token that reports success does. That
        // pairing is what makes the conservation assertion below meaningful, and it is set per shape
        // rather than globally because the classification is the thing under test: shapes 0, 3 and 5
        // are successes under the repaired rule and the rest are failures.
        //
        // The other pairing — moves value AND reports failure — is a LYING token rather than a
        // refusing one, and it double-pays. That is real, it is not closed by this fix, and it has
        // its own test below rather than being buried in this loop.
        bool[6] memory applies = [true, false, false, false, false, true];

        emit log_string("--- BondingCurve._tryPay: collectTax() outcome by ERC-20 return shape ---");
        for (uint256 i = 0; i < 6; i++) {
            BondingCurve c = _market();
            quote.setApplyState(applies[i]);
            quote.setReturn(lens[i], words[i]);

            uint256 owed = c.pendingTax();
            uint256 creatorBefore = quote.balanceOf(CREATOR);
            uint256 sinkBefore = quote.balanceOf(address(sink));
            // `claimable` is cumulative across the loop — one shared `CreatorSink` serves all six
            // fixtures — so the per-shape figure has to be a delta too.
            uint256 claimableBefore = sink.claimable(CREATOR, address(quote));

            try c.collectTax() {
                uint256 paid = quote.balanceOf(CREATOR) - creatorBefore;
                uint256 credited = quote.balanceOf(address(sink)) - sinkBefore;
                if (paid != 0) {
                    emit log_named_string(labels[i], "OK  - pushed directly to recipient");
                } else if (credited != 0) {
                    emit log_named_string(labels[i], "OK  - push refused, CREDITED to CreatorSink");
                    assertEq(
                        sink.claimable(CREATOR, address(quote)) - claimableBefore,
                        credited,
                        "credited but not claimable: money would be stranded in the sink"
                    );
                } else {
                    emit log_named_string(labels[i], "LOST- collection succeeded and paid nobody");
                    fail();
                }
                assertEq(c.pendingTax(), 0, "bucket not cleared after a successful collection");
                assertEq(paid + credited, owed, "amount delivered != amount owed");
            } catch {
                // The L-03 shape: the predicate itself reverted, so `_payOrCredit` never reached
                // its fallback and the whole collection unwound. The money is not lost — it is
                // still in `pendingTax` — but it is unreachable for as long as the token answers
                // this way, on every retry, for every market using this quote.
                emit log_named_string(labels[i], "REVERT- collectTax() unwound; fallback unreachable");
                assertEq(c.pendingTax(), owed, "reverted but the bucket moved");
            }

            quote.setApplyState(true);
            quote.setReturn(32, bytes32(uint256(1))); // restore, so the next fixture can be built
        }
    }

    /// @notice The control: with a standards-compliant return, the push lands and nothing defers.
    function test_control_standardReturnPushesDirectly() public {
        BondingCurve c = _market();
        quote.setReturn(32, bytes32(uint256(1)));
        uint256 owed = c.pendingTax();
        c.collectTax();
        assertEq(quote.balanceOf(CREATOR), owed, "standard token did not pay the recipient");
        assertEq(sink.claimable(CREATOR, address(quote)), 0, "standard token should not defer");
    }

    /**
     * @notice The property L-03 is really about: a REFUSING token must still complete the
     *         collection, by deferring into the sink.
     * @dev This is the behaviour `_payOrCredit` was written to provide. A 32-byte `false` is the
     *      only refusal shape the current predicate reports as `false` rather than reverting on, so
     *      it is the only shape for which the design's promise currently holds. Every other refusal
     *      shape is the finding.
     */
    function test_explicitFalseReachesTheDeferredCreditPath() public {
        BondingCurve c = _market();
        uint256 owed = c.pendingTax();
        // State is left unapplied as well as the return being false, so the token is refusing
        // rather than lying — the honest version of "this recipient cannot be paid".
        quote.setApplyState(false);
        quote.setReturn(32, bytes32(0));

        c.collectTax();

        assertEq(c.pendingTax(), 0, "bucket not cleared");
        assertEq(sink.claimable(CREATOR, address(quote)), owed, "refused push was not deferred to the sink");
    }

    /**
     * @notice The limitation the repaired rule does NOT remove: a token that moves value and then
     *         reports failure is paid twice, out of the curve's own balance.
     *
     * @dev `_payOrCredit` is push-then-defer. It has no way to ask whether the push it was told
     *      failed actually failed — `_tryPay` only sees a return value — so if a token transfers the
     *      value and *then* says `false`, the fallback runs on top of a transfer that already
     *      happened and `CreatorSink.credit` pulls a second `amount` out of the curve.
     *
     *      This is not introduced by the L-03 repair; it is the same for a plain 32-byte `false`,
     *      which the original rule already treated as a clean failure. What the repair changes is
     *      how MANY return shapes reach the deferred path, so it widens the set of tokens for which
     *      a lying transfer is expressible. That is the right trade — the alternative is a permanent
     *      freeze of fee collection for every token with a non-standard return — but it should be
     *      written down rather than discovered.
     *
     *      The real defence is the registry, and this is one more thing the quote-asset policy has
     *      to mean: a token whose `transfer` moves value and returns false is not ERC-20 and must
     *      never be registered. See docs/doku/quote-asset-policy.md.
     */
    function test_aTokenThatMovesValueAndReportsFailureIsPaidTwice() public {
        BondingCurve c = _market();
        uint256 owed = c.pendingTax();

        // Moves the value, then says it did not.
        quote.setApplyState(true);
        quote.setReturn(32, bytes32(0));

        uint256 curveBefore = quote.balanceOf(address(c));
        c.collectTax();

        uint256 paid = quote.balanceOf(CREATOR);
        uint256 credited = quote.balanceOf(address(sink));
        uint256 leftTheCurve = curveBefore - quote.balanceOf(address(c));

        emit log_string("--- L-03 limitation: a lying token is paid twice ---");
        emit log_named_uint("tax owed", owed);
        emit log_named_uint("pushed straight to the recipient by the token", paid);
        emit log_named_uint("credited to the sink by the fallback", credited);
        emit log_named_uint("total that left the curve", leftTheCurve);

        assertEq(paid, owed, "the lying transfer did move the value");
        assertEq(credited, owed, "and the fallback moved it again");
        assertEq(leftTheCurve, 2 * owed, "the curve paid twice for one obligation");
    }
}
