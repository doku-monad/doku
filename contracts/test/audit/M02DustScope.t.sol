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
import {MockUSDC} from "../mocks/MockUSDC.sol";

// Imported ONLY so forge compiles their artifacts; v4-periphery's helpers reach them through
// `vm.getCode`, which resolves against the build output rather than the source tree.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * # M-02 — the shared graduator's absolute-balance sweep, measured
 *
 * `DokuGraduation` is ONE contract for every market ever launched. `_sweepDust`
 * (src/DokuGraduation.sol:398-414) ends a graduation by reading
 *
 *     IERC20(seed.quote).balanceOf(address(this))
 *
 * — an ABSOLUTE balance, not the delta this graduation created — and crediting all of it to the
 * market currently graduating. The BURN branch returns one line earlier, deliberately, leaving its
 * own quote dust behind because a BURN sink takes the token and has nothing to do with quote.
 *
 * The source says so in as many words, at src/DokuGraduation.sol:394-397: BURN quote dust "is
 * picked up by the next quote-paying market's sweep of the same asset, as it was in gen-1". So the
 * cross-market flow is a DOCUMENTED DESIGN DECISION, not an oversight. What was never written down
 * is the number — and a design decision about dust is only as good as the bound on the dust.
 *
 * This file measures three things the prose does not settle:
 *
 *   1. How much quote a real BURN graduation actually abandons. (The per-event increment.)
 *   2. Whether a later market's graduation moves it to a recipient of the LAUNCHER'S choosing, and
 *      whether that recipient can then actually withdraw it. (Reachability, end to end.)
 *   3. Whether the amount is structurally capped. The report claims it "is not structurally
 *      capped"; the mint residue plainly is bounded, so the question is whether any OTHER inflow
 *      reaches the same shared balance — because `_sweepDust` cannot tell the two apart.
 *
 * The distinction in (3) is the whole severity argument. A few raw units per BURN graduation is a
 * rounding curiosity. An unbounded balance that anyone can top up and the next launcher collects is
 * a different finding, and the sweep reads them with the same `balanceOf`.
 */
contract M02DustScopeTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    /// @dev The later launcher. Not privileged in any way: they launch an ordinary CREATOR market
    ///      and name themselves its routed recipient, which is what the launch form is FOR.
    address internal constant MALLORY = address(0x4A110C);

    uint256 internal constant TARGET_USDC = 10_000e6;

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    CreatorSink internal creatorSink;
    MarketsStub internal markets;
    MockUSDC internal usdc;

    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        // Built before the hook: the sink's address is folded into the hook's mined one.
        creatorSink = new CreatorSink(address(this));
        markets = new MarketsStub();
        usdc = new MockUSDC();

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
        vm.deal(ALICE, 1_000_000e18);
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

    /// @dev One buy that fills the curve; graduation happens inside it. Past the anti-sniper
    ///      window, so the seed is the clean case.
    function _fill(BondingCurve c, address buyer) internal {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 spend = 5 * TARGET_USDC;
        usdc.mint(buyer, spend);
        vm.startPrank(buyer);
        usdc.approve(address(c), spend);
        c.buyWithToken(spend, 0, vm.getBlockTimestamp());
        vm.stopPrank();
        assertTrue(graduation.graduated(address(c)), "market did not auto-graduate");
    }

    // ------------------------------------------------------------------ 1. the per-event residue

    /**
     * @notice What a real BURN graduation abandons, and whether it accumulates.
     * @dev The number this prints is the honest ceiling on the "organic" version of M-02. If it is
     *      a handful of raw units, the organic finding is an accounting blemish and nothing more.
     */
    function test_measure_burnGraduationResidue() public {
        assertEq(usdc.balanceOf(address(graduation)), 0, "graduator started dirty");

        uint256[] memory after_ = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            BondingCurve c = _market(address(usdc), TARGET_USDC, Sinks.BURN, address(0));
            _fill(c, ALICE);
            after_[i] = usdc.balanceOf(address(graduation));
        }

        emit log_string("--- BURN/USDC: raw USDC units left in the SHARED graduator ---");
        emit log_named_uint("after 1 BURN graduation", after_[0]);
        emit log_named_uint("after 2 BURN graduations", after_[1]);
        emit log_named_uint("after 3 BURN graduations", after_[2]);
        emit log_named_uint("target per market (raw)", TARGET_USDC);
        if (after_[2] != 0) {
            emit log_named_uint(
                "residue as a fraction of one target, in parts per billion", (after_[2] * 1e9) / TARGET_USDC
            );
        }
    }

    /**
     * @notice The same measurement on the native quote, which is where the residue actually is.
     * @dev MON is the largest registered quote and the only 18-decimal one whose seed leg is the
     *      COARSE side of the ratio, so its mint leaves a genuine remainder where a six-decimal
     *      quote leaves none. This is the honest per-event number for the organic form of M-02.
     */
    function test_measure_burnGraduationResidueNative() public {
        uint256 target = 1_000e18;
        assertEq(address(graduation).balance, 0, "graduator started dirty");

        uint256[] memory after_ = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            BondingCurve c = _market(address(0), target, Sinks.BURN, address(0));
            vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
            vm.deal(ALICE, 10 * target);
            vm.prank(ALICE);
            c.buy{value: 5 * target}(0, vm.getBlockTimestamp());
            assertTrue(graduation.graduated(address(c)), "native BURN market did not graduate");
            after_[i] = address(graduation).balance;
        }

        emit log_string("--- BURN/MON: wei left in the SHARED graduator ---");
        emit log_named_uint("after 1 BURN graduation (wei)", after_[0]);
        emit log_named_uint("after 2 BURN graduations (wei)", after_[1]);
        emit log_named_uint("after 3 BURN graduations (wei)", after_[2]);
        emit log_named_uint("treasury received (wei)", TREASURY.balance);
        emit log_named_uint("forfeited into the PositionManager (wei)", address(lpm).balance);
        emit log_named_decimal_uint("one market's target, as MON", target, 18);
        emit log_named_uint(
            "residue per graduation as a fraction of one target, in parts per QUINTILLION",
            (address(lpm).balance / 3) * 1e18 / target
        );

        /*
         * THE HISTORY OF THIS NUMBER, IN THREE GENERATIONS.
         *
         * Pre-fix this read 25,622 / 51,244 / 76,866 wei — a linear accumulation left in the shared
         * graduator for the next quote-paying market to collect. That was M-02.
         *
         * Generation 4 kept the residue and changed its destination: it came home through
         * `Actions.SWEEP` and went to the treasury, explicitly, in the transaction that created it.
         * The graduator ended every graduation holding nothing.
         *
         * Generation 5 removes the sweep, so on a NATIVE quote the residue never comes home at all
         * — it stays in the PositionManager, where `Actions.SWEEP` makes it collectable by any v4
         * caller. The protocol forfeits its own dust so that no graduation ever moves a stranger's
         * MON. Same 25,622 wei per graduation; it is now in POSM's balance instead of the
         * treasury's, and the accumulation is legible there instead.
         *
         * The invariant that survives all three: THE SHARED GRADUATOR ENDS EVERY GRADUATION EMPTY.
         */
        assertEq(after_[2], 0, "a BURN graduation still abandons quote in the shared graduator");
        assertEq(TREASURY.balance, 0, "a native BURN residue reached the treasury: the sweep is back");
        assertGt(address(lpm).balance, 0, "the residue went nowhere: it should be forfeited into POSM");
        // Linear in the number of graduations, and still wei: three graduations, three residues.
        assertLt(address(lpm).balance, 1 gwei, "the forfeited residue stopped being dust");
    }

    // ------------------------------------------------------- 2. reachability, market A to market B

    /**
     * @notice The claimed flow, end to end: a BURN market's abandoned quote leaves the shared
     *         graduator inside an unrelated CREATOR market's graduation and is withdrawn by that
     *         market's recipient.
     *
     * @dev The counterfeit-curve shortcut the 2026-09-09 evidence used
     *      (`evidence/audit-2026-09-09/GradSweepDustScope.t.sol`) is CLOSED — `graduate` now
     *      authenticates its subject against the factory at src/DokuGraduation.sol:187. So this
     *      does it the way that still works, and the way the report describes: MALLORY launches a
     *      REAL CREATOR market in the same quote asset and pays its real raise. Nothing here is
     *      privileged and nothing here is counterfeit.
     *
     *      That also states the cost side honestly, which decides the severity: MALLORY's raise is
     *      spent on a permanently locked seed position. The dust is a windfall attached to a launch,
     *      not a profit on one — unless the balance is large, which is what test (3) is about.
     */
    function test_burnDustLandsInAnUnrelatedMarketsSink() public {
        // Native MON, because that is where an organic residue actually exists. The six-decimal
        // ERC-20 case leaves exactly zero — see `test_measure_burnGraduationResidue` — so running
        // this on USDC would prove the route with money the protocol never actually stranded.
        uint256 target = 1_000e18;

        // Market A: a BURN market. Its quote dust is abandoned in the shared graduator.
        BondingCurve marketA = _market(address(0), target, Sinks.BURN, address(0));
        vm.warp(vm.getBlockTimestamp() + marketA.TAX_WINDOW() + 1);
        vm.deal(ALICE, 10 * target);
        vm.prank(ALICE);
        marketA.buy{value: 5 * target}(0, vm.getBlockTimestamp());
        assertTrue(graduation.graduated(address(marketA)), "market A did not graduate");

        uint256 strandedByA = address(graduation).balance;
        uint256 forfeitedByA = address(lpm).balance;
        emit log_string("--- M-02: market A's residue, market B's sink ---");
        emit log_named_uint("A) BURN market abandoned in the shared graduator (wei)", strandedByA);
        emit log_named_uint("A) forfeited into the PositionManager instead (wei)", forfeitedByA);
        // Pre-fix this was 25,622 wei abandoned in the graduator. Generation 4 sent it to the
        // treasury; generation 5 leaves it in POSM, because `_mintSeed` no longer sweeps. What has
        // not changed across either is that the shared graduator ends empty — which is the half of
        // the mechanism that made the cross-market flow possible in the first place.
        assertEq(strandedByA, 0, "market A still abandons quote in the shared graduator");
        assertGt(forfeitedByA, 0, "market A's residue reached neither the graduator nor POSM");

        // Market B: MALLORY's own CREATOR market, same quote, MALLORY as routed recipient.
        BondingCurve marketB = _market(address(0), target, Sinks.CREATOR, MALLORY);
        assertTrue(
            PoolId.unwrap(graduation.poolIdOf(address(marketB))) == bytes32(0),
            "market B graduated before it was filled"
        );

        vm.deal(MALLORY, 10 * target);
        vm.prank(MALLORY);
        marketB.buy{value: 5 * target}(0, vm.getBlockTimestamp());
        assertTrue(graduation.graduated(address(marketB)), "market B did not graduate");
        PoolId idB = graduation.poolIdOf(address(marketB));

        // The sweep has run. Nothing is left behind, which is the other half of the mechanism:
        // market A's money is now inside market B's ledger entry and cannot be told apart from it.
        uint256 owedToB = dokuHook.owedSink(idB);
        emit log_named_uint("B) credited to market B's hook ledger (wei)", owedToB);

        creatorSink.pull(address(marketB));
        // `claimable` rather than `claim`, because under generation 5 there is nothing to claim at
        // all on a native market and `claim` correctly reverts `NothingToClaim`. That revert IS the
        // post-fix behaviour, so the test reads the balance instead of asserting on a revert it
        // would have to expect either way.
        uint256 received = creatorSink.claimable(MALLORY, address(0));

        emit log_string("--- M-02 result ---");
        emit log_named_uint("MALLORY can withdraw (wei)", received);
        emit log_named_uint("both markets' residue, now POSM's (wei)", address(lpm).balance);

        // The property, stated as an inequality rather than as an absence: whatever market B's own
        // graduation produced, it cannot have included market A's. Pre-fix MALLORY withdrew 51,244
        // wei — B's own 25,622 plus A's 25,622. Post-fix the two are separated; under generation 5
        // they are separated by never entering this contract, so B's recipient gets nothing at all
        // and the inequality is satisfied with room to spare.
        assertLt(received, forfeitedByA * 2, "market B's recipient still absorbed market A's residue");
        // Both residues are accounted for, in the one place they were forfeited to.
        assertGt(address(lpm).balance, forfeitedByA, "market B's residue went somewhere else");
    }

    // ------------------------------------------------------------------- 3. is the residue capped?

    /**
     * @notice The severity question: the sweep reads a balance, and a balance is not only made of
     *         mint residue.
     *
     * @dev `DokuGraduation` has a payable `receive()` (src/DokuGraduation.sol:468) and, being an
     *      ordinary address, can hold any ERC-20 anyone sends it. `_sweepDust` reads `balanceOf`
     *      and cannot distinguish "residue this graduation created" from "whatever else is here".
     *
     *      So the honest statement of the bound is: the residue the PROTOCOL generates is small and
     *      bounded per graduation, and the amount the sweep MOVES is bounded by nothing at all. The
     *      realistic way that balance becomes large is not an attacker funding it — that is
     *      self-defeating, they would be donating more than they collect — but a MISDIRECTED
     *      TRANSFER: a user, an integrator, or a script paying the graduation contract instead of a
     *      market. Today that money is not recoverable by its owner and not held for anyone; it is
     *      assigned to whoever launches next in that asset.
     *
     *      That is the finding restated as what it actually is: not a profitable attack, but an
     *      uncapped misallocation with no owner and no recovery path.
     */
    function test_anyStrandedBalanceIsSweptRegardlessOfSize() public {
        // A "fat finger": one whole target's worth of USDC sent to the graduator by mistake.
        uint256 misdirected = TARGET_USDC;
        usdc.mint(address(this), misdirected);
        usdc.transfer(address(graduation), misdirected);
        assertEq(usdc.balanceOf(address(graduation)), misdirected, "stage failed");

        BondingCurve marketB = _market(address(usdc), TARGET_USDC, Sinks.CREATOR, MALLORY);
        _fill(marketB, MALLORY);
        PoolId idB = graduation.poolIdOf(address(marketB));

        creatorSink.pull(address(marketB));
        // Nothing is claimable at all now, which is itself the result: on a six-decimal quote this
        // graduation produces no residue of its own, so with the misdirected balance out of scope
        // there is simply nothing for the recipient to take. `claim` reverting `NothingToClaim` is
        // the correct post-fix behaviour, not a failure.
        uint256 received = creatorSink.claimable(MALLORY, address(usdc));

        emit log_string("--- M-02 (3): a pre-existing balance is no longer in scope ---");
        emit log_named_uint("misdirected into the shared graduator (raw USDC)", misdirected);
        emit log_named_uint("credited to the next market's ledger", dokuHook.owedSink(idB));
        emit log_named_uint("withdrawn by that market's recipient", received);
        emit log_named_uint("still held by the graduator, unclaimed by anyone", usdc.balanceOf(address(graduation)));

        // Pre-fix the recipient withdrew the whole 10,000 USDC. The money is still not recoverable
        // by whoever misdirected it — that would need a rescue path this contract does not have —
        // but it is no longer handed to a stranger, which is the part that made this a finding.
        // Pre-fix the recipient withdrew the whole 10,000 USDC. It is still not recoverable by
        // whoever misdirected it — that would need a rescue path this contract does not have and
        // cannot be given one — but it is no longer handed to a stranger, which is the part that
        // made this a finding.
        //
        // And it must stay HERE rather than being forwarded to the PositionManager. Money
        // misdirected to this address never passed through POSM, so "returning" it there would
        // move a stranger's mistake into a different stranger's free-for-all: the same
        // misallocation with an extra hop.
        //
        // This assertion is older than the code it now guards. It was written against generation
        // 4's return leg, whose first version pushed back `quoteHeldBefore + posmHeld` when only
        // `posmHeld` had ever come from POSM — and it caught that. Generation 5 deletes the return
        // leg entirely (`_mintSeed` no longer sweeps, so nothing arrives to be returned), which
        // makes the property structural rather than conditional. The assertion is kept anyway: it
        // costs nothing and it is what goes red if a push to POSM is ever reintroduced.
        assertLt(received, misdirected, "the misdirected balance was still swept to a market");
        assertGe(usdc.balanceOf(address(graduation)), misdirected, "the misdirected balance should still be here");
        assertEq(usdc.balanceOf(address(lpm)), 0, "a balance that never came from POSM was sent to POSM");
    }

    /**
     * @notice The amplifier that M-02 actually rested on, and the generation-5 answer to it: the
     *         seed mint no longer reads the PositionManager's balance at all.
     *
     * @dev The finding, restated: the seed mint's `Actions.SWEEP` emptied the PositionManager, not
     *      the graduator's own remainder — so the "dust" a graduation swept was drawn from a
     *      contract the whole chain shares.
     *
     *      `_mintSeed` USED TO end its action list with
     *      `params[2] = abi.encode(Currency.wrap(seed.quote), address(this))`, and v4-periphery
     *      implements that as
     *
     *          function _sweep(Currency currency, address to) internal virtual {
     *              uint256 balance = currency.balanceOfSelf();
     *              if (balance > 0) currency.transfer(to, balance);
     *          }
     *
     *      — `balanceOfSelf`, the PositionManager's ENTIRE balance of that currency
     *      (lib/v4-periphery/src/PositionManager.sol:499-502). The intent was to recover the
     *      graduator's own unspent quote, which for a native seed rides in as `msg.value`. What it
     *      actually recovers is everyone's.
     *
     *      The canonical PositionManager is shared infrastructure: any v4 user's stranded quote
     *      sits there, and it is swept into `DokuGraduation` by the next DOKU graduation in that
     *      asset, where `_sweepDust` credits it to that market's sink. This is why M-02's magnitude
     *      is genuinely unbounded rather than bounded by mint residue — and it is why measuring the
     *      graduator's balance delta is NOT on its own a sufficient fix: the money arrived DURING
     *      the operation, so it was inside the delta.
     *
     *      Generation 4 answered it by measuring POSM's balance before the mint and pushing it
     *      back. Generation 5 answers it by not taking it: the action list is `MINT_POSITION,
     *      SETTLE_PAIR` and stops. On an ERC-20 quote that costs the protocol NOTHING, which is why
     *      the drop is symmetric rather than native-only — POSM funds an ERC-20 leg by pulling the
     *      exact debt out of the graduator through Permit2 at settle time, so it never holds our
     *      quote and the sweep never recovered a unit of our own money on this path. All it ever
     *      moved was other people's.
     *
     *      The assertions below are unchanged from the generation-4 version. They pass for a
     *      different reason now — POSM keeps its balance because nothing was taken, rather than
     *      because something was given back — and that is exactly why they were worth keeping: they
     *      state the OUTCOME the third party cares about, not the mechanism that delivers it.
     */
    function test_theSeedMintLeavesThePositionManagersBalanceAlone() public {
        // Somebody else's USDC, parked on the shared PositionManager. Nothing to do with DOKU.
        uint256 parked = 50_000e6;
        usdc.mint(address(lpm), parked);
        assertEq(usdc.balanceOf(address(lpm)), parked, "stage failed");

        BondingCurve marketB = _market(address(usdc), TARGET_USDC, Sinks.CREATOR, MALLORY);
        _fill(marketB, MALLORY);
        PoolId idB = graduation.poolIdOf(address(marketB));

        emit log_string("--- M-02 amplifier, generation 5: nothing is drawn from POSM at all ---");
        emit log_named_uint("third-party USDC parked on PositionManager", parked);
        emit log_named_uint("PositionManager balance after our graduation", usdc.balanceOf(address(lpm)));
        emit log_named_uint("credited to this market's hook ledger", dokuHook.owedSink(idB));

        creatorSink.pull(address(marketB));
        // Post-fix there is nothing claimable at all: this graduation's own six-decimal residue is
        // zero and POSM's balance is out of scope, so `claim` would revert `NothingToClaim`.
        uint256 received = creatorSink.claimable(MALLORY, address(usdc));
        emit log_named_uint("claimable by this market's recipient", received);

        emit log_named_uint("still held by the graduator, credited to nobody", usdc.balanceOf(address(graduation)));

        // Pre-fix the market's recipient withdrew all 50,000.
        //
        // Generation 4 let `Actions.SWEEP` drag POSM's balance in — that is v4-periphery's
        // behaviour, and a contract that uses the action does not get to change it — and then
        // pushed the money straight back out, which worked on an ERC-20 and never on MON.
        // Generation 5 does not use the action, so the third party ends the transaction exactly
        // where they started it on every quote, with no push that has to succeed.
        //
        // (An earlier note here said stopping the drag "moves the hook's mined address", so it
        // belonged to a later generation. That was wrong on its own terms: `DokuGraduation` is not
        // the hook, and editing it never moved the hook's address. Recorded because it is the kind
        // of reason that defers a fix indefinitely if nobody checks it.)
        assertEq(received, 0, "third-party POSM balance still reached a market recipient");
        assertEq(usdc.balanceOf(address(graduation)), 0, "the graduator kept a stranger's money");
        assertEq(usdc.balanceOf(address(lpm)), parked, "POSM was not made whole");
    }

    /**
     * @notice The native-MON form of the same thing, since MON is the largest registered quote.
     * @dev Same mechanism, different branch: `_sweepDust` reads `address(this).balance` for a native
     *      quote (src/DokuGraduation.sol:406-408).
     */
    function test_nativeQuoteFormOfTheSameSweep() public {
        uint256 target = 1_000e18;
        uint256 misdirected = 5e18;
        vm.deal(address(graduation), misdirected);

        BondingCurve marketB = _market(address(0), target, Sinks.CREATOR, MALLORY);
        vm.warp(vm.getBlockTimestamp() + marketB.TAX_WINDOW() + 1);
        vm.deal(MALLORY, 10 * target);
        vm.prank(MALLORY);
        marketB.buy{value: 5 * target}(0, vm.getBlockTimestamp());
        assertTrue(graduation.graduated(address(marketB)), "native market did not graduate");

        creatorSink.pull(address(marketB));
        // See the note in `test_burnDustLandsInAnUnrelatedMarketsSink`: under generation 5 a native
        // market credits nothing, so `claim` reverts `NothingToClaim` and the readable quantity is
        // `claimable`.
        uint256 received = creatorSink.claimable(MALLORY, address(0));

        emit log_string("--- M-02 (native MON) ---");
        emit log_named_decimal_uint("misdirected MON", misdirected, 18);
        emit log_named_decimal_uint("withdrawn by the next launcher", received, 18);
        emit log_named_decimal_uint("still held by the graduator", address(graduation).balance, 18);
        // Pre-fix: 5.000000000000025622 MON — the misdirected 5 plus this market's own residue.
        assertLt(received, misdirected, "misdirected MON still swept to the next launcher");
        assertGe(address(graduation).balance, misdirected, "misdirected MON should still be here");
    }
}
