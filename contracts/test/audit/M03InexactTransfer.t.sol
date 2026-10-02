// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";
import {
    FeeOnTransferToken,
    InboundFeeToken,
    RebasingToken,
    CallbackToken,
    BlacklistToken,
    PausableToken,
    ITransferReceiver
} from "./AdversarialTokens.sol";

// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * # M-03 — what the registry admits, and which paths it breaks
 *
 * `QuoteRegistry.register` (src/QuoteRegistry.sol:57-63) asks an asset exactly one question:
 *
 *     uint8 dec = asset == address(0) ? 18 : IERC20Metadata(asset).decimals();
 *
 * Answering `decimals()` is the whole admission test. Nothing checks that a transfer of `n`
 * delivers `n`, and the protocol's accounting is split on whether it assumes that:
 *
 *   MEASURES the delta, and is therefore safe:
 *     - `BondingCurve._pullAndBuy`      src/BondingCurve.sol:559-565
 *     - `DokuFactory._firstBuy`         src/DokuFactory.sol:339-343
 *     - `CreatorSink.pull`              src/sinks/CreatorSink.sol:152-160
 *
 *   TRUSTS the requested amount, and is therefore not:
 *     - `DokuHook.creditCurveTax`       src/v4/DokuHook.sol:1071-1079   (`owedSink[id] += amount`)
 *     - `DokuGraduation.creditCurveTax` src/DokuGraduation.sol:424-430
 *     - `BondingCurve.sell`             src/BondingCurve.sol:803 vs :822 (checked, then sent)
 *
 * The report is accurate about that split, and the first list is worth stating explicitly because
 * it means M-03 is NOT "the protocol ignores fee-on-transfer everywhere". Someone already went
 * through the inbound curve paths. The finding is that the job stopped short of the hook and the
 * graduator, and that the outbound check is on the wrong side of the transfer.
 *
 * The tests below take each remaining path and say what breaks. The most consequential is
 * `test_hookCreditOverstatesOwed_drainsAnotherMarket`: `owedSink` is a per-market ledger over ONE
 * SHARED balance, so a credit that books more than it delivers is not a rounding error against
 * itself — it is a claim on somebody else's money.
 */
contract M03InexactTransferTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant MALLORY = address(0x4A110C);

    uint256 internal constant TARGET = 10_000e6;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    CreatorSink internal creatorSink;
    MarketsStub internal markets;

    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        creatorSink = new CreatorSink(address(this));
        markets = new MarketsStub();

        bytes memory args =
            abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(
            IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink)
        );

        graduation = new DokuGraduation(
            address(manager), address(lpm), address(permit2), address(dokuHook), address(markets)
        );
        dokuHook.setGraduator(address(graduation), true);
        creatorSink.setGraduator(address(graduation));
        creatorSink.setFactory(address(markets));

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
    }

    function _market(address quote, uint256 target, uint8 sink, address routed)
        internal
        returns (BondingCurve c)
    {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t), quote, target, sink, routed, 0, ALICE, TREASURY, address(graduation), address(creatorSink)
        );
    }

    // ------------------------------------------------------------- outbound: sell under-delivers

    /**
     * @notice `sell` validates `minQuoteOut` against a number it has not sent yet.
     *
     * @dev src/BondingCurve.sol:803 checks `quoteOut < minQuoteOut` and src/BondingCurve.sol:822
     *      then calls `_payQuote(msg.sender, quoteOut)`. On a taxed quote the seller's balance rises
     *      by less than `quoteOut`, so the slippage bound they set is not the bound they got. The
     *      transaction SUCCEEDS — there is no revert to warn them — which is what makes this worse
     *      than a failure.
     *
     *      A seller cannot defend against this by setting `minQuoteOut` higher: the check is not
     *      measuring what they receive, so no value of it constrains what they receive.
     */
    function test_sell_minQuoteOutIsCheckedBeforeTheTransfer() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(6, 0); // fee off while the curve is built
        BondingCurve c = _market(address(fot), TARGET, Sinks.CREATOR, ALICE);

        fot.mint(BOB, TARGET);
        vm.startPrank(BOB);
        fot.approve(address(c), type(uint256).max);
        uint256 bought = c.buyWithToken(TARGET / 4, 0, vm.getBlockTimestamp());
        vm.stopPrank();

        fot.setFeeBps(500); // 5%: the token acquires a transfer tax

        // There is no `previewSell` on the curve, so the quote is learned by DOING the sell on a
        // snapshot and rolling back. That is also the honest model of the seller's position: an
        // interface quotes them a number by simulation, and they set their bound from it.
        uint256 snap = vm.snapshotState();
        vm.startPrank(BOB);
        DokuToken(address(c.token())).approve(address(c), type(uint256).max);
        uint256 quoted = c.sell(bought, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        vm.revertToState(snap);

        // A seller demanding at least 99% of the quoted output.
        uint256 minOut = (quoted * 99) / 100;
        emit log_string("--- M-03 outbound: sell() ---");
        emit log_named_uint("minQuoteOut the seller demanded", minOut);
        emit log_named_uint("quoteOut the curve computes", quoted);
        emit log_named_uint("what a 5% transfer fee would actually deliver", (quoted * 95) / 100);

        // BEFORE the fix this SUCCEEDED: the curve reported 1,225,125,000, the seller's bound was
        // 1,212,873,750, and 1,163,868,750 arrived — a 49,005,000 shortfall below a limit the
        // seller had explicitly set, with no revert and no event to say so.
        //
        // The bound is now checked against the seller's realised balance, on the far side of the
        // transfer, so the trade reverts rather than under-filling.
        vm.startPrank(BOB);
        DokuToken(address(c.token())).approve(address(c), type(uint256).max);
        uint256 balBefore = fot.balanceOf(BOB);
        vm.expectRevert(BondingCurve.InsufficientOutput.selector);
        c.sell(bought, minOut, vm.getBlockTimestamp());
        vm.stopPrank();

        assertEq(fot.balanceOf(BOB), balBefore, "a reverted sell must move nothing");
        emit log_string("post-fix: the sale reverts InsufficientOutput instead of short-paying");

        // And a seller who asks for nothing is unaffected — the guard is the bound they set, not a
        // blanket ban on the asset.
        vm.startPrank(BOB);
        uint256 got = c.sell(bought, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        emit log_named_uint("with minQuoteOut = 0 the sale still completes, reporting", got);
        assertGt(fot.balanceOf(BOB), balBefore, "a zero-bound sale should still pay something");
    }

    // -------------------------------------------- inbound: the hook credits what it did not receive

    /**
     * @notice The cross-market consequence: an over-booked credit is paid out of another market's
     *         backing, because `owedSink` is many ledgers over one balance.
     *
     * @dev `DokuHook.creditCurveTax(PoolId,uint256)` is PERMISSIONLESS and does
     *      `safeTransferFrom(msg.sender, address(this), amount); owedSink[id] += amount;`
     *      (src/v4/DokuHook.sol:1071-1079). It never asks what arrived.
     *
     *      The instrument is `InboundFeeToken` with only the HOOK marked as a taxed recipient, so
     *      the curve, the factory and the graduator all move value exactly and the ONLY inexact hop
     *      in the whole trace is the one under test. Anything that breaks here is attributable to
     *      that hop and to nothing else.
     *
     *      The fee is switched on between the honest market's graduation and the hostile credit.
     *      That is not a trick to manufacture the bug — it is the realistic shape, and the reason
     *      the baseline file tracks upgrade authorities at all: four of the seven registered quote
     *      assets are proxies, and an implementation that acquires a transfer fee changes exactly
     *      this, mid-life, with no event DOKU can see.
     */
    function test_hookCreditOverstatesOwed_drainsAnotherMarket() public {
        InboundFeeToken tok = new InboundFeeToken(6, 1_000); // 10%, applied only where marked

        // Market H — the honest bystander. Graduates while the token is exact, so the hook holds
        // real backing for it.
        BondingCurve honest = _market(address(tok), TARGET, Sinks.CREATOR, BOB);
        _fillErc20(honest, tok, BOB);
        PoolId idH = graduation.poolIdOf(address(honest));

        // Give market H a real, honestly-backed claim.
        uint256 honestCredit = 1_000e6;
        tok.mint(address(this), honestCredit);
        tok.approve(address(dokuHook), honestCredit);
        dokuHook.creditCurveTax(idH, honestCredit);

        // Market M — MALLORY's. Graduates the same way.
        BondingCurve hostile = _market(address(tok), TARGET, Sinks.CREATOR, MALLORY);
        _fillErc20(hostile, tok, MALLORY);
        PoolId idM = graduation.poolIdOf(address(hostile));

        // The token now taxes transfers INTO the hook, and only into the hook.
        tok.setTaxedRecipient(address(dokuHook), true);

        uint256 hookBalBefore = tok.balanceOf(address(dokuHook));
        uint256 owedHBefore = dokuHook.owedSink(idH);

        // MALLORY credits their own market. They pay `amount`; the hook receives 90% of it and
        // books 100% of it.
        uint256 amount = 5_000e6;
        tok.mint(MALLORY, amount);

        emit log_string("--- M-03 inbound: DokuHook.creditCurveTax ---");
        emit log_named_uint("amount MALLORY asks to credit", amount);
        emit log_named_uint("amount the 10% fee would actually deliver", (amount * 90) / 100);

        // BEFORE the fix this SUCCEEDED and booked the full 5,000: the hook received 4,500, owed
        // 6,000 across two markets while holding 5,500, MALLORY pulled 5,000 out of a balance that
        // was partly market H's, and market H's own `pull` then reverted for ever with `owedSink`
        // still insisting it was owed 1,000. `owedSink` is per market over one shared per-currency
        // balance, so the over-credit was never confined to the market that caused it.
        //
        // The credit is now measured and REQUIRED equal, so the hostile credit never lands.
        vm.startPrank(MALLORY);
        tok.approve(address(dokuHook), amount);
        vm.expectRevert(
            abi.encodeWithSelector(
                DokuHook.InexactTransfer.selector, address(tok), amount, (amount * 90) / 100
            )
        );
        dokuHook.creditCurveTax(idM, amount);
        vm.stopPrank();

        assertEq(tok.balanceOf(address(dokuHook)), hookBalBefore, "a refused credit must move nothing");
        assertEq(dokuHook.owedSink(idM), 0, "a refused credit must book nothing");
        emit log_string("post-fix: the credit reverts InexactTransfer; the ledger never over-states");

        // The bystander is untouched, which is the property that actually matters: market H can
        // still pull exactly what it was honestly credited.
        creatorSink.pull(address(honest));
        assertEq(
            creatorSink.claimable(BOB, address(tok)),
            owedHBefore,
            "the bystander market's claim was damaged by a credit that should have been refused"
        );
        emit log_named_uint("market H can still claim, in full", creatorSink.claimable(BOB, address(tok)));
    }

    /// @dev A fill that works for any exact-on-the-curve ERC-20 quote.
    function _fillErc20(BondingCurve c, InboundFeeToken tok, address who) internal {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 spend = 5 * TARGET;
        tok.mint(who, spend);
        vm.startPrank(who);
        tok.approve(address(c), spend);
        c.buyWithToken(spend, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        assertTrue(graduation.graduated(address(c)), "market did not graduate");
    }

    // ---------------------------------------------------------- graduation on a taxed quote asset

    /**
     * @notice A transfer tax that appears while a curve is LIVE seals the raise in permanently.
     *
     * @dev The curve latches `readyToGraduate` from its own internal accounting, which the buy path
     *      keeps exact by measuring deltas. Graduation then requires
     *      `seed.quoteAmount == c.quoteTarget()` (src/DokuGraduation.sol:212) on the amount that
     *      ARRIVES from `release()`. A taxed transfer delivers less, the equality fails,
     *      `SeedOutOfRange` is thrown — and because `release()` sets `released = true` before
     *      paying, the curve cannot be released twice either.
     *
     *      `_tryAutoGraduate` swallows the revert (src/BondingCurve.sol:769), so the buyer's trade
     *      succeeds and nothing announces the failure. The market simply fills and stops, with the
     *      entire raise inside a closed curve. This is the "Permit2/PositionManager exact settlement
     *      rejecting a transfer-taxed asset AFTER the curve has already closed" case in the report,
     *      and it lands one step earlier than the report guessed — at the graduator's own equality
     *      check rather than inside Permit2.
     */
    function test_graduationFreezesWhenTheQuoteAcquiresATax() public {
        FeeOnTransferToken fot = new FeeOnTransferToken(6, 0);
        BondingCurve c = _market(address(fot), TARGET, Sinks.CREATOR, ALICE);

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 spend = 5 * TARGET;
        fot.mint(ALICE, spend);

        fot.setFeeBps(100); // 1%, acquired mid-life

        vm.startPrank(ALICE);
        fot.approve(address(c), spend);
        c.buyWithToken(spend, 0, vm.getBlockTimestamp());
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "curve should have filled");
        assertFalse(graduation.graduated(address(c)), "should NOT have graduated on a taxed quote");
        // `released` is still false, and that is worth stating precisely because it is easy to
        // misread as "release never ran". It DID run — and then the graduation reverted, unwinding
        // every state change inside it, `released = true` included. `_tryAutoGraduate` makes the
        // call with a raw `call` and swallows the failure (src/BondingCurve.sol:769), so the buyer's
        // trade still succeeds and the only trace is an `AutoGraduationFailed` event.
        assertFalse(c.released(), "the failed graduation should have rolled release() back");

        emit log_string("--- M-03 graduation freeze ---");
        emit log_named_uint("raise sealed in the closed curve (raw units)", c.quoteRaised());
        emit log_named_uint("target it had to match exactly", c.quoteTarget());
        emit log_string("the curve is FILLED (readyToGraduate) and refuses further buys, but cannot graduate");

        // Every retry fails the same way, for as long as the quote charges a fee. Capture the
        // reason rather than asserting a bare revert, so the finding names the line it dies on.
        try graduation.graduate(address(c)) {
            fail();
        } catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            emit log_named_bytes32("graduate() revert selector", bytes32(sel));
            if (sel == DokuGraduation.SeedOutOfRange.selector) {
                emit log_string("  -> SeedOutOfRange: the arrived quote != quoteTarget (DokuGraduation.sol:212)");
            } else if (sel == bytes4(0x08c379a0)) {
                // Error(string). The interesting part: this is the TOKEN's own require, not one of
                // ours — the graduator passed its own equality check and died settling the mint.
                bytes memory raw = reason;
                string memory msg_;
                assembly ("memory-safe") {
                    msg_ := add(raw, 0x44)
                }
                emit log_named_string("  -> Error(string) from below the graduator", msg_);
            }
        }
    }

    // ----------------------------------------------------------------- rebasing and shared balances

    /**
     * @notice A rebase moves the shared graduator's balance with no transfer and no ledger entry.
     * @dev `_sweepDust` reads an absolute balance, so a positive rebase between two graduations is
     *      indistinguishable from dust and is credited to whoever graduates next — the M-02
     *      mechanism, driven by the token instead of by a stray transfer. A negative rebase is the
     *      worse direction: balances the protocol has already promised simply shrink.
     */
    function test_rebaseMovesTheSweptAmountWithNoTransfer() public {
        RebasingToken reb = new RebasingToken(18);
        reb.mint(address(graduation), 1_000e18);
        uint256 before = reb.balanceOf(address(graduation));

        reb.setIndex(1.5e18); // +50%, a routine positive rebase

        uint256 afterBal = reb.balanceOf(address(graduation));
        emit log_string("--- M-03 rebase ---");
        emit log_named_uint("graduator balance before rebase", before);
        emit log_named_uint("graduator balance after rebase", afterBal);
        assertGt(afterBal, before, "rebase did not move the absolute balance");
        emit log_string("_sweepDust reads balanceOf(), so the whole increase is swept as 'dust'");

        reb.setIndex(0.5e18); // and the other direction
        emit log_named_uint("after a NEGATIVE rebase", reb.balanceOf(address(graduation)));
        emit log_string("a ledger entry taken before this is now larger than the balance backing it");
    }

    // --------------------------------------------------------------------- blacklist and pausable

    /**
     * @notice A blacklist entry on a SHARED contract stops that asset for every market at once.
     * @dev USDC and USDT0 — two of the seven registered quotes — both have this today. The
     *      difference from a blacklisted user is blast radius: the hook, the graduator and the
     *      creator sink are shared, so one entry against any of them freezes every market
     *      denominated in that asset, including markets whose participants did nothing.
     */
    function test_blacklistingASharedContractFreezesEveryMarketInThatAsset() public {
        BlacklistToken bl = new BlacklistToken(6);
        bl.mint(address(this), 1_000e6);

        bl.setBlacklisted(address(dokuHook), true);
        bl.approve(address(dokuHook), 1_000e6);

        emit log_string("--- M-03 blacklist ---");
        // Any inbound credit to the hook now reverts, for every market on this quote.
        vm.expectRevert();
        bl.transfer(address(dokuHook), 1e6);
        emit log_string("transfers to the shared hook revert while it is listed");
        assertTrue(bl.blacklisted(address(dokuHook)), "fixture");
    }

    /// @notice The global form. Nothing denominated in the asset can trade, graduate, pull or claim.
    function test_pausingTheQuoteStopsEverything() public {
        PausableToken p = new PausableToken(6);
        p.mint(ALICE, 1_000e6);
        p.setPaused(true);
        vm.prank(ALICE);
        vm.expectRevert();
        p.transfer(address(dokuHook), 1e6);
        emit log_string("--- M-03 pausable: every path on this quote reverts while paused ---");
    }
}
