// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MarketsStub} from "./mocks/MarketsStub.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {BondingCurve, DOKU_SEED_BASE} from "../src/BondingCurve.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {DokuToken} from "../src/DokuToken.sol";
import {Sinks} from "../src/lib/Sinks.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Drives the curve with random buys, sells, donations, collections and time jumps, in
///         whichever quote the market was launched in.
/// @dev Bounded rather than raw so the fuzzer spends its runs on reachable states instead of
///      reverting on absurd inputs. Reverts are tolerated (`fail_on_revert = false`); what matters
///      is that the invariants hold across every sequence that does land.
///
///      Every outward call is wrapped, so the handler itself never reverts. That is not tidiness:
///      with `fail_on_revert = false` a handler that reverts on most calls still reports a green
///      run, and the invariants are then asserted over a state machine that barely moved. The
///      reverts counter foundry prints for this suite must stay at zero for the runs to mean
///      anything, and a bounded-then-guarded handler is what keeps it there.
contract Handler is Test {
    BondingCurve public curve;
    DokuToken public token;
    /// @dev `address(0)` is native MON; anything else is a `MockUSDC`.
    address public quote;
    uint256 public maxTrade;

    address[3] public actors = [address(0xA1), address(0xA2), address(0xA3)];
    uint256 public totalPaidIn;
    uint256 public totalPaidOut;
    uint256 public totalDrained;
    uint256 public donated;

    /// @dev The two addresses a collection can pay. Read from the curve rather than passed in, so
    ///      a market wired differently cannot make `totalDrained` silently under-count.
    address internal immutable PROTOCOL_RECIPIENT;
    address internal immutable TAX_RECIPIENT;

    constructor(BondingCurve c, DokuToken t, address q, uint256 target) {
        curve = c;
        token = t;
        quote = q;
        maxTrade = 2 * target;
        PROTOCOL_RECIPIENT = c.protocolRecipient();
        TAX_RECIPIENT = c.taxRecipient();
        for (uint256 i; i < actors.length; ++i) {
            _fund(actors[i], 100 * target);
        }
    }

    function _fund(address a, uint256 amount) internal {
        if (quote == address(0)) vm.deal(a, amount);
        else MockUSDC(quote).mint(a, amount);
    }

    /// @dev What an address holds in the market's OWN quote. Measuring `a.balance` on a USDC market
    ///      would silently record every sell as paying nothing, and
    ///      `invariant_tradersNeverProfitInAggregate` would then pass vacuously.
    function _balance(address a) internal view returns (uint256) {
        return quote == address(0) ? a.balance : IERC20(quote).balanceOf(a);
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function buy(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        uint256 amt = bound(uint256(amount), 1, maxTrade);
        uint256 before = _balance(a);
        if (before < amt) return;
        vm.startPrank(a);
        if (quote == address(0)) {
            try curve.buy{value: amt}(0, block.timestamp) {
                totalPaidIn += before - _balance(a);
            } catch {}
        } else {
            IERC20(quote).approve(address(curve), amt);
            try curve.buyWithToken(amt, 0, block.timestamp) {
                totalPaidIn += before - _balance(a);
            } catch {}
        }
        vm.stopPrank();
    }

    function sell(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = bound(uint256(amount), 1, bal);
        uint256 before = _balance(a);
        vm.startPrank(a);
        token.approve(address(curve), amt);
        try curve.sell(amt, 0, block.timestamp) {
            totalPaidOut += _balance(a) - before;
        } catch {}
        vm.stopPrank();
    }

    /**
     * Send tokens to the curve without selling them.
     *
     * Anyone can do this — `DokuToken` is a plain ERC-20 with no transfer hooks — and it used to be
     * enough to lock a market's entire raise: the graduation seed was latched from `balanceOf`, so
     * a donation inflated it past `seedDustTolerance` and `graduate()` reverted forever. The seed
     * is derived from the curve's own accounting now, and this action is what keeps the fuzz
     * exercising that rather than trusting two regression tests to have picked the right sizes.
     */
    function donate(uint256 seed, uint96 amount) external {
        address a = _actor(seed);
        uint256 bal = token.balanceOf(a);
        if (bal == 0) return;
        uint256 amt = bound(uint256(amount), 1, bal);
        vm.prank(a);
        token.transfer(address(curve), amt);
        donated += amt;
    }

    /// Every drain, so a bucket that cannot be emptied shows up as a stuck balance.
    ///
    /// @dev All three, every time, and each one's revert swallowed: a drain that is unreachable on
    ///      this market (`collectFees` on BURN, `collectTax` at zero bps) must be indistinguishable
    ///      here from one that is merely empty, or the handler would encode which buckets it
    ///      expects to be live and stop being able to discover that one is not.
    function collect() external {
        uint256 before = _balance(PROTOCOL_RECIPIENT) + _balance(TAX_RECIPIENT);
        try curve.collectFees() {} catch {}
        try curve.collectTax() {} catch {}
        try curve.collectProtocolFees() {} catch {}
        totalDrained += _balance(PROTOCOL_RECIPIENT) + _balance(TAX_RECIPIENT) - before;
    }

    /// Time moves so the tax decay is actually exercised rather than pinned at launch.
    function warp(uint32 seconds_) external {
        vm.warp(block.timestamp + bound(seconds_, 1, 120));
    }
}

/**
 * @notice The invariants, written once and instantiated three times: an 18-decimal native quote, a
 *         6-decimal stablecoin one, and a 6-decimal GOLD-shaped one where a single raw unit is a
 *         millionth of a troy ounce.
 *
 * @dev Every assertion is in raw units, so a rounding path that only opens at six decimals fails
 *      the six-decimal contract and nothing else.
 *
 *      The third instantiation is not redundant with the second, and the reason is the whole point
 *      of parameterising this suite. Coarseness is not a property of the DECIMALS, it is a property
 *      of raw units per dollar: a stablecoin at 6 decimals is 1e6 raw to the dollar, gold at 6
 *      decimals is ~3e2, and the ~3,300x between them is exactly the gap that gave a fixed dust
 *      bound a stablecoin market 2,285 sells of headroom and a gold market 0.69 — one sell from
 *      bricking. Same mock token, same decimals, much smaller target: the variable under test is
 *      the target, so a second mock would have confounded it.
 *
 *      The market is a BURN market with a live creator tax, chosen so that every bucket the curve
 *      tracks is either exercised or provably dead: BURN puts the most arithmetic on the token side
 *      (its routed share is spent on the curve and burned as it accrues, on buys AND sells), the
 *      creator tax keeps `pendingTax` live and drainable, `pendingProtocol` is live on every sink,
 *      and `pendingFees` is asserted dead by `invariant_aBurnMarketHoldsNothingForItsSink`.
 */
abstract contract InvariantBase is Test {
    BondingCurve internal curve;
    DokuToken internal token;
    Handler internal handler;
    /// @dev Deployed only to read `seedDustTolerance`, which is `pure`. The bound is RELATIVE to
    ///      the market's own quote target (R21), so restating it as a constant here would be wrong
    ///      by three orders of magnitude on the gold market — which is the market that needs it.
    ///      Its constructor arguments are placeholders: nothing on this path is ever called.
    DokuGraduation internal graduation;

    address internal constant TREASURY = address(0x7EA);
    address internal constant CREATOR_SINK = address(0xC5);
    address internal constant ALICE = address(0xA11CE);
    /// @dev Non-zero so `pendingTax` is a bucket with money in it rather than a bucket that is
    ///      trivially balanced at zero. 1% of the quote leg of every buy and sell.
    uint16 internal constant CREATOR_TAX_BPS = 100;

    address internal quote;
    uint256 internal target;
    /// @dev `base × quote` at launch. Pool-favouring rounding means it can only grow.
    uint256 internal k0;

    function _quote() internal virtual returns (address);
    function _target() internal pure virtual returns (uint256);

    function setUp() public {
        quote = _quote();
        target = _target();
        graduation = new DokuGraduation(address(0xB1), address(0xB2), address(0xB3), address(0xB4), address(new MarketsStub()));
        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        token = DokuToken(Clones.clone(address(new DokuToken())));
        token.initialize("Doku", "DOKU", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(
            address(token),
            quote,
            target,
            Sinks.BURN,
            address(0),
            CREATOR_TAX_BPS,
            ALICE,
            TREASURY,
            address(this),
            CREATOR_SINK
        );
        (uint128 b, uint128 q) = curve.reserves();
        k0 = uint256(b) * uint256(q);

        handler = new Handler(curve, token, quote, target);
        targetContract(address(handler));
    }

    /// @dev The curve's holding in its own quote. Every balance invariant reads this, so the same
    ///      assertions bind on a native market and on an ERC-20 one.
    function _held() internal view returns (uint256) {
        return quote == address(0) ? address(curve).balance : IERC20(quote).balanceOf(address(curve));
    }

    /// @dev Graduation's own bound for THIS market, never a restated constant.

    /// Every raw unit the curve holds belongs to exactly one of four buckets. If this drifts, either
    /// someone can withdraw money that is not theirs or money is stranded.
    ///
    /// @dev This is also the guard against a bucket being drained TWICE. A second drain of the same
    ///      bucket pays out against a counter that is already zero, so the balance falls below the
    ///      sum of the counters and this equality is what reports it.
    function invariant_quoteIsFullyAccounted() public view {
        assertEq(
            _held(),
            curve.quoteRaised() + curve.pendingFees() + curve.pendingTax() + curve.pendingProtocol(),
            "curve balance does not match its own accounting"
        );
    }

    /// The curve must never take more than it set out to raise.
    function invariant_neverExceedsTarget() public view {
        assertLe(curve.quoteRaised(), target, "raised past the target");
    }

    /// The constant product never falls: every rounding is in the pool's favour.
    ///
    /// @dev The one invariant that makes the buy-then-sell loop unprofitable at the raw-unit floor,
    ///      and the one a coarse quote threatens most: at six decimals a single raw unit is 1e12
    ///      times larger, so a rounding that went the trader's way would be worth 1e12 times more
    ///      per round trip. A BURN market runs TWO curve trades per buy and two per sell, and each
    ///      of the four has to round the same way.
    function invariant_kNeverFalls() public view {
        (uint128 b, uint128 q) = curve.reserves();
        assertGe(uint256(b) * uint256(q), k0, "k fell: a rounding favoured the trader");
    }

    /// Base reserve, tokens out of the curve, and tokens BURNED must always sum back to the ceiling.
    ///
    /// @dev Written against the token's original supply rather than a burn counter, so the identity
    ///      holds whichever counter the curve keeps: every unit that leaves the reserve leaves the
    ///      curve's balance (sold, or burned), and a donation raises the balance without touching
    ///      the reserve, so it is added back.
    function invariant_baseIsConserved() public view {
        (uint128 base,) = curve.reserves();
        assertEq(
            uint256(base) + token.TOTAL_SUPPLY() - token.balanceOf(address(curve)) + handler.donated(),
            curve.BASE_VIRTUAL_CEILING(),
            "base reserve, circulating supply and burns disagree"
        );
    }

    /// The virtual quote reserve is the floor plus whatever has genuinely been raised.
    ///
    /// @dev On a BURN market the routed share is spent on the curve as it accrues rather than held
    ///      aside (R10), so it enters BOTH sides of this identity — the reserve through a second
    ///      curve trade and `quoteRaised` through `curveAmount`. A market that spent it on one side
    ///      only would still satisfy `invariant_quoteIsFullyAccounted`, and fail here.
    function invariant_quoteReserveTracksRaised() public view {
        (, uint128 q) = curve.reserves();
        assertEq(uint256(q), (target * 2) / 5 + curve.quoteRaised(), "quote reserve drifted");
    }

    /// Traders can never have been paid more in aggregate than they put in.
    function invariant_tradersNeverProfitInAggregate() public view {
        assertLe(handler.totalPaidOut(), handler.totalPaidIn(), "traders extracted value");
    }

    /**
     * Every raw unit that ever entered the curve is still there, or was paid to someone with a name.
     *
     * @dev The end-to-end form of `invariant_quoteIsFullyAccounted`, and strictly stronger in one
     *      direction: that one compares the curve's balance against the curve's OWN counters, so a
     *      levy booked to nobody and a levy paid to the wrong address both satisfy it. This one is
     *      measured entirely outside the curve — what wallets sent in, what wallets got back, what
     *      the two named recipients were paid — so the only way to satisfy it is for every unit to
     *      have gone somewhere the protocol names.
     *
     *      Exact rather than approximate, and it can be: `totalPaidIn` is a balance delta, so a
     *      refunded overshoot is already netted out of it, and burns and donations move the token
     *      side only.
     */
    function invariant_everyRawUnitIsEitherHeldOrPaidToSomeone() public view {
        assertEq(
            handler.totalPaidIn(),
            _held() + handler.totalPaidOut() + handler.totalDrained(),
            "quote went somewhere nobody named"
        );
    }

    /// Every bucket the contract tracks has a drain, and the handler pulls all three every time.
    ///
    /// @dev This is what replaced `invariant_escrowIsNeverSpent` at D5. That invariant asserted the
    ///      anti-sniper tax was HELD aside and destined for the launch liquidity; D5 reverses
    ///      exactly that — the tax is spent as it accrues, buying the token off this curve and
    ///      burning it, because seeding the pool with it opened every hot launch above its own
    ///      closing price (3,824 bps on the measured fixture, +20.63% to a fill-graduate-dump
    ///      attacker). What is worth asserting instead is that no bucket can strand: `quoteRaised`
    ///      leaves through `release`, `pendingProtocol` through `collectProtocolFees`, `pendingTax`
    ///      through `collectTax`, and the anti-sniper tax leaves immediately as a burn.
    function invariant_everyLiveBucketHasADrain() public view {
        assertEq(
            _held(),
            curve.quoteRaised() + curve.pendingFees() + curve.pendingTax() + curve.pendingProtocol(),
            "a bucket exists that no drain accounts for"
        );
        if (curve.taxEscrow() != 0) {
            assertGt(curve.burnedByTax(), 0, "tax accrued but nothing was ever burned");
        }
    }

    /// A BURN market never holds quote for its sink: that share was spent on the curve as it accrued.
    ///
    /// @dev The dead bucket, asserted dead. `pendingFees` has no reachable drain on this sink —
    ///      `collectFees` reverts `ZeroAmount` every time the handler calls it — so if anything ever
    ///      books into it, that money is stranded forever and every other invariant here still
    ///      passes.
    function invariant_aBurnMarketHoldsNothingForItsSink() public view {
        assertEq(curve.pendingFees(), 0, "a BURN market booked quote for a sink that cannot pull it");
    }

    /**
     * The burn counter and the token's own supply never disagree.
     *
     * `burnedByTax` is not bookkeeping for its own sake — two consumers read it and both are wrong
     * in silence if it drifts. The indexer derives `total_supply` from burns, and every market cap
     * and every sort in the explore grid is computed from that; the reward vault derives eligible
     * supply from `getPastTotalSupply`, so a divergence over-pays or under-pays every claimant.
     *
     * Distinct from `invariant_baseIsConserved`, which relates the ERC-20 to the RESERVE. This
     * relates the counter to the ERC-20, and a burn that decremented one but not the other would
     * satisfy that invariant and fail this one.
     */
    function invariant_burnedCounterAgreesWithSupply() public view {
        assertEq(
            token.totalSupply() + curve.burnedByTax(), token.TOTAL_SUPPLY(), "the burn counter and the token's supply disagree"
        );
    }

    /// @dev The seed is a pure function of the reserve, so no amount of donated token can move it.
    ///      This is the fuzzed form of the bug that locked a raise: the handler donates freely, and
    ///      the latched seed still has to be the accounting figure.
    function invariant_theSeedIsUnmovedByDonations() public view {
        if (!curve.readyToGraduate()) return;
        (uint128 base,) = curve.reserves();
        uint256 expected = token.totalSupply() + curve.burnedByTax() + uint256(base) - curve.BASE_VIRTUAL_CEILING();
        assertEq(curve.seedBase(), expected, "the seed drifted from the curve's own accounting");
    }

    /**
     * At exact fill the seed is 2/7 of what the curve sold: `TOTAL_SUPPLY − CURVE_SUPPLY`, plus the
     * rounding dust graduation tolerates — and never less.
     *
     * @dev The tolerance is read from `DokuGraduation` rather than restated, and that is
     *      load-bearing on the gold contract below: the bound is `4096 × ceiling / (1.4 × target)`
     *      floored at one millionth of the seed (R21), so a gold market's is ~6,000x the floor an
     *      18-decimal market sits on. A constant here would assert the floor against a market whose
     *      real bound is a thousand times wider and report a passing market as broken — or, sized
     *      the other way, wave through the seed that bricks it.
     */
    function invariant_seedIsTwoSeventhsOfTheCurveAtFill() public view {
        if (!curve.readyToGraduate()) return;
        uint256 exact = token.TOTAL_SUPPLY() - curve.CURVE_SUPPLY();
        assertEq(exact, DOKU_SEED_BASE, "the seed constant moved");
        assertGe(curve.seedBase(), exact, "the latched seed is short of two sevenths");
        /*
          There is deliberately no upper bound here any more.

          `graduate` used to refuse a seed more than `seedDustTolerance` above the design, and that
          bound was a permanent freeze waiting to happen: every sell leaves a wei or two of residue
          in the virtual base, the residue has no ceiling, and ~4,600 dust sells on a coarse-quote
          market pushed a market past it and sealed the raise in a closed curve forever. The seed is
          now computed from the market's own latched supply and its own reserves, and `release` can
          only move what the curve holds — so "not short" is the whole invariant.
        */
        assertEq(curve.quoteRaised(), target, "a filled curve did not raise exactly the target");
    }

    /**
     * The curve always retains enough token to seed the pool.
     *
     * `DokuGraduation` REVERTS `SeedOutOfRange` if the curve hands it less than `DOKU_SEED_BASE`.
     * So a residue that can fall below the seed is not a rounding nuisance — it is a filled curve
     * holding the whole raise that can never graduate, and no amount of retrying helps because the
     * shortfall is permanent.
     *
     * The burn is what makes this worth asserting under fuzz rather than reasoning about: a BURN
     * market spends both its routed share and the anti-sniper tax buying token off this same curve
     * and destroying it, so burns and sales draw down the same balance. This is the invariant that
     * would catch a burn sized off the wrong base.
     */
    function invariant_residueNeverFallsBelowTheSeed() public view {
        if (!curve.readyToGraduate()) return;
        assertGe(token.balanceOf(address(curve)), DOKU_SEED_BASE, "a filled curve cannot cover the graduation seed");
        assertGe(curve.seedBase(), DOKU_SEED_BASE, "the latched seed is short of the minimum");
    }

    // ------------------------------------------------------------------------------ fuzz tests

    /// `minQuoteOut` is honoured to the raw unit at dust size: one more than the quote reverts, the
    /// quote itself pays exactly the quote.
    ///
    /// @dev A zero quote is tolerated rather than asserted away, and R20 is why: on a coarse market
    ///      a small sell genuinely rounds to nothing, and the curve refuses it by name
    ///      (`ZeroOutput`) instead of booking a sale that pays the seller nothing. Either way the
    ///      first leg here must revert, because `out + 1` is unpayable in both worlds.
    function testFuzz_minQuoteOutAtDust(uint32 dust) public {
        dust = uint32(bound(dust, 1, 1_000_000));
        vm.warp(block.timestamp + curve.TAX_WINDOW() + 1);
        _buyAs(ALICE, target / 10);
        (uint256 out,,) = curve.quoteSell(dust);
        vm.startPrank(ALICE);
        token.approve(address(curve), dust);
        vm.expectRevert();
        curve.sell(dust, out + 1, block.timestamp);
        if (out != 0) {
            uint256 before = quote == address(0) ? ALICE.balance : IERC20(quote).balanceOf(ALICE);
            curve.sell(dust, out, block.timestamp);
            uint256 got = (quote == address(0) ? ALICE.balance : IERC20(quote).balanceOf(ALICE)) - before;
            assertEq(got, out, "the quoted sell paid something other than the quote");
        }
        vm.stopPrank();
    }

    function _buyAs(address who, uint256 amount) internal {
        if (quote == address(0)) {
            vm.deal(who, who.balance + amount);
            vm.prank(who);
            curve.buy{value: amount}(0, block.timestamp);
        } else {
            MockUSDC(quote).mint(who, amount);
            vm.startPrank(who);
            IERC20(quote).approve(address(curve), amount);
            curve.buyWithToken(amount, 0, block.timestamp);
            vm.stopPrank();
        }
    }
}

/// Native MON: 18 decimals, ~5e19 raw units to the dollar at a plausible price.
contract InvariantMonTest is InvariantBase {
    function _quote() internal pure override returns (address) {
        return address(0);
    }

    function _target() internal pure override returns (uint256) {
        return 1_000e18;
    }
}

/// A stablecoin: 6 decimals, 1e6 raw units to the dollar.
contract InvariantUsdcTest is InvariantBase {
    function _quote() internal override returns (address) {
        return address(new MockUSDC());
    }

    function _target() internal pure override returns (uint256) {
        return 10_000e6;
    }
}

/**
 * Gold: the SAME 6-decimal mock, registered with a target ~3,300x smaller in raw units, because one
 * raw unit of XAUt0 is a millionth of a troy ounce rather than a millionth of a dollar. An ~$8,000
 * raise is ~2.42e6 raw units, and every rounding step the curve takes is that much coarser — which
 * is the scale at which a fixed dust bound left a market less than one sell of headroom (R21).
 *
 * @dev THE LAST DIGIT IS NOT ARBITRARY. The natural conversion is 2,424,242, and that is no longer
 * a legal target: `BondingCurve.initialize` and `QuoteRegistry` both require a multiple of five, so
 * that the virtual quote floor `target * 2 / 5` is exact and a filled market's seed covers
 * `DOKU_SEED_BASE`. Rounding down costs nothing worth naming — five raw units of XAUt0 is about
 * 1.6 thousandths of a cent — and it is what an operator would actually register.
 *
 * This is where the truncation was found, and it was found by these invariants rather than by
 * review: at 2,424,242 the first filling buy latched a seed of 222,222,038.666591316635719333e18
 * against a `DOKU_SEED_BASE` of 222,222,222e18, short by 183,333,408,683,364,280,666 base wei,
 * which `DokuGraduation` rejects outright (`seed.baseAmount < SEED_BASE` → `SeedOutOfRange`) — a
 * filled gold market holding its entire raise with no path to a pool and no rescue. Nothing here is
 * loosened to accommodate that: the same assertions, the same coarseness, one digit of target.
 */
contract InvariantGoldTest is InvariantBase {
    function _quote() internal override returns (address) {
        return address(new MockUSDC());
    }

    function _target() internal pure override returns (uint256) {
        return 2_424_240;
    }
}

/// @notice The fee arithmetic at the raw-unit floor, on a REWARDS market so every bucket is held
///         rather than spent. Per gross `G` (the quote in after the anti-sniper tax, which is zero
///         here): `fee = G·100/1e4`, `protocol = G·30/1e4`, `routed = fee − protocol`,
///         `creatorTax = G·bps/1e4`, and the curve keeps `G − protocol − creatorTax − routed`
///         (BURN keeps the routed share and spends it buying back at the post-trade price). Only
///         the first three are asserted; the tax is zero on these curves and the curve's retained
///         amount is covered by `invariant_quoteIsFullyAccounted`.
/// @dev The protocol share is the only component that truncates below 334 raw: it is the first
///      component to truncate to zero (Q·30 < 10 000 ⇔ Q ≤ 333), and from 334 upward every
///      component — fee, protocol, routed — is non-zero. Six decimals make 334 raw a third of a
///      cent, so this is a floor a real trade can hit. Nothing here depends on the token side —
///      on the 1e27-supply curve 1 USDC buys ≈ 336,769 tokens and a one-token sell returns 2 raw,
///      which is why `testFuzz_minQuoteOutAtDust` tolerates a zero quote at dust size.
contract FeeRoundingTest is Test {
    address internal constant TREASURY = address(0x7EA);
    address internal constant CREATOR_SINK = address(0xC5);
    address internal constant ALICE = address(0xA11CE);

    /// @dev Deployed once and cloned per run. The implementations are immutable and the clones get
    ///      fresh storage, so each fuzz run still gets a virgin curve — but a 10,000-run fuzz that
    ///      redeployed both implementations every time would spend its budget on `CREATE`.
    BondingCurve internal curveImpl;
    DokuToken internal tokenImpl;
    /// @dev One mock for the whole suite: `mint` is open and the curve is fresh each run, so a
    ///      per-run token would only add another deployment.
    MockUSDC internal usdc;

    function setUp() public {
        curveImpl = new BondingCurve();
        tokenImpl = new DokuToken();
        usdc = new MockUSDC();
    }

    function _curve(address quote, uint256 target) internal returns (BondingCurve c) {
        c = BondingCurve(payable(Clones.clone(address(curveImpl))));
        DokuToken t = DokuToken(Clones.clone(address(tokenImpl)));
        t.initialize("Doku", "DOKU", address(c), true, "https://cdn.doku.family/metadata/test.json");
        c.initialize(address(t), quote, target, Sinks.REWARDS, address(0), 0, ALICE, TREASURY, address(this), CREATOR_SINK);
        vm.warp(block.timestamp + c.TAX_WINDOW() + 1);
    }

    function _buy(BondingCurve c, address quote, uint256 q) internal {
        if (quote == address(0)) {
            vm.deal(ALICE, q);
            vm.prank(ALICE);
            c.buy{value: q}(0, block.timestamp);
        } else {
            usdc.mint(ALICE, q);
            vm.startPrank(ALICE);
            IERC20(quote).approve(address(c), q);
            c.buyWithToken(q, 0, block.timestamp);
            vm.stopPrank();
        }
    }

    /// @dev Named for the protocol SHARE, which is the component that truncates: the 1% fee
    ///      itself vanishes below 100 raw, the 30 bps share below 334.
    function testFuzz_theProtocolShareIsTheOnlyComponentThatTruncatesBelow334Raw(uint16 raw, bool sixDecimals) public {
        uint256 q = bound(uint256(raw), 1, 10_000);
        address quote = sixDecimals ? address(usdc) : address(0);
        BondingCurve c = _curve(quote, sixDecimals ? 10_000e6 : 1_000e18);

        (, uint256 fee,,,) = c.quoteBuy(q);
        assertEq(fee, (q * 100) / 10_000, "fee is not Q/100");

        uint256 p0 = c.pendingProtocol();
        uint256 r0 = c.pendingFees();
        _buy(c, quote, q);
        uint256 protocol = c.pendingProtocol() - p0;
        uint256 routed = c.pendingFees() - r0;

        assertEq(protocol, (q * 30) / 10_000, "protocol share is not Q*30/10000");
        assertEq(routed, fee - protocol, "routed share is not fee - protocol");
        if (q < 334) {
            assertEq(protocol, 0, "the protocol share should truncate to zero below 334 raw");
        } else {
            assertGt(protocol, 0, "protocol share truncated at or above 334 raw");
            assertGt(routed, 0, "routed share truncated at or above 334 raw");
            assertGt(fee, 0, "fee truncated at or above 334 raw");
        }
    }

    function test_theBoundaryIsExactlyThreeHundredAndThirtyFour() public {
        BondingCurve c = _curve(address(0), 1_000e18);
        uint256 p0 = c.pendingProtocol();
        _buy(c, address(0), 333);
        assertEq(c.pendingProtocol() - p0, 0, "333 raw should pay no protocol share");
        p0 = c.pendingProtocol();
        _buy(c, address(0), 334);
        assertEq(c.pendingProtocol() - p0, 1, "334 raw should pay exactly one raw unit");
    }
}
