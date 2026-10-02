// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * ROUND 3 — properties a stranger would want proved before trusting the curve and the factory with
 * money, derived from the entry-point map rather than from the diff.
 *
 * Each of these was a candidate finding first. They are here because the candidate DIED, and a
 * killed candidate with no test is a suspicion the next round has to re-derive from scratch.
 */

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

import {BondingCurve, DOKU_MAX_QUOTE_TARGET} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Wiring} from "../helpers/Wiring.sol";
import {Launches} from "../helpers/Launches.sol";

contract P3Quote is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 dec) ERC20("P3", "P3") {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/// @dev Cannot take native MON, so `_tryPay` must answer false and `_payOrCredit` must defer.
contract P3Refuser {
    receive() external payable {
        revert("no");
    }
}

/// @dev The shared sink, reduced to the one call the curve makes into it.
contract P3Sink {
    mapping(address => mapping(address => uint256)) public owed;

    function credit(address who, address quote, uint256 amount) external payable {
        if (quote == address(0)) require(msg.value == amount, "value");
        else IERC20(quote).transferFrom(msg.sender, address(this), amount);
        owed[who][quote] += amount;
    }
}

contract P3Graduator {
    address public immutable factory;

    constructor(address f) {
        factory = f;
    }

    function sinkOf(address) external view returns (address) {
        return address(this);
    }

    function creditCurveTax(address) external payable {}

    function creditCurveTax(address, uint256) external {}

    receive() external payable {}
}

/// @dev Re-enters `launch` from the native first-buy refund, which is the one execution window a
///      third party gets inside `DokuFactory.launch`.
contract NestingLauncher {
    DokuFactory public immutable f;
    bool public armed;
    address public inner;

    constructor(DokuFactory f_) {
        f = f_;
    }

    function go(DokuFactory.LaunchParams memory p, uint256 value) external payable returns (address) {
        (address c,) = f.launch{value: value}(p);
        return c;
    }

    function arm(bool on) external {
        armed = on;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        DokuFactory.LaunchParams memory p = Launches.native(f, Sinks.BURN);
        p.meta.ticker = "NEST";
        p.firstBuyQuote = 0;
        (inner,) = f.launch{value: f.launchFee(address(this))}(p);
    }
}

contract Round3PropertiesTest is Test {
    address internal constant OWNER = address(0xD0);
    address internal constant PAUSER = address(0xD1);
    address internal constant FEEREC = address(0xD2);
    address internal constant TREASURY = address(0xA2);
    address internal constant TAXREC = address(0xA3);
    address internal constant ROUTED = address(0xA4);
    address internal constant ALICE = address(0xB1);
    address internal constant MALLORY = address(0xB9);

    address internal curveImpl;
    address internal tokenImpl;
    P3Graduator internal grad;
    P3Quote internal quote;

    DokuFactory internal factory;
    QuoteRegistry internal registry;

    uint256 internal constant TARGET6 = 8_000e6;
    uint256 internal constant NATIVE_TARGET = 1_000e18;
    uint256 internal _n;

    function setUp() public {
        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
        quote = new P3Quote(6);

        registry = new QuoteRegistry(OWNER);
        vm.startPrank(OWNER);
        registry.register(address(0), NATIVE_TARGET);
        registry.register(address(quote), TARGET6);
        vm.stopPrank();

        factory = new DokuFactory(OWNER, PAUSER, FEEREC, address(registry), address(0xBEEF), 1 ether);
        grad = new P3Graduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        Wiring.activate(factory, OWNER, address(grad));
    }

    function _market(address quoteAsset, uint8 sink, uint16 taxBps, uint256 target)
        internal
        returns (BondingCurve c, DokuToken t)
    {
        bytes32 salt = keccak256(abi.encode("p3", ++_n));
        address ca = Clones.cloneDeterministic(curveImpl, salt);
        address ta = Clones.cloneDeterministic(tokenImpl, salt);
        DokuToken(ta).initialize("P3", "P3", ca, sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        BondingCurve(payable(ca)).initialize(
            ta,
            quoteAsset,
            target,
            sink,
            sink == Sinks.CREATOR ? ROUTED : address(0),
            taxBps,
            TAXREC,
            TREASURY,
            address(grad),
            address(0)
        );
        return (BondingCurve(payable(ca)), DokuToken(ta));
    }

    // =========================================================================================
    // 1. NOBODY CAN SPEND A THIRD PARTY'S ALLOWANCE
    // =========================================================================================

    /**
     * Every inbound ERC-20 leg in the protocol pulls from `msg.sender` and from nowhere else:
     * `BondingCurve._pullAndBuy` (both `buyWithToken` and `buyWithPermit`) and
     * `DokuFactory._firstBuy`. `buyFor` — the one entry that names a recipient — pulls NOTHING; the
     * factory has already moved the quote.
     *
     * The candidate this kills: `buyWithPermit` swallows a failed permit, so an attacker can
     * front-run a victim's signature and set the victim's allowance on the curve themselves. That
     * is real and documented — but an allowance to the curve is only ever spendable by a call whose
     * `msg.sender` is the approver, so the attacker has handed the victim a working approval and
     * nothing else.
     */
    function test_aVictimsAllowanceToTheCurveIsUnspendableByAnyoneElse() public {
        (BondingCurve c,) = _market(address(quote), Sinks.BURN, 0, TARGET6);

        quote.mint(ALICE, 10_000e6);
        vm.prank(ALICE);
        quote.approve(address(c), type(uint256).max); // the front-run permit's effect

        uint256 aliceBefore = quote.balanceOf(ALICE);

        // Mallory holds nothing and is approved for nothing.
        vm.prank(MALLORY);
        vm.expectRevert();
        c.buyWithToken(1_000e6, 0, type(uint256).max);

        // Even with a permit call in front of it, the pull is still from Mallory.
        vm.prank(MALLORY);
        vm.expectRevert();
        c.buyWithPermit(1_000e6, 0, type(uint256).max, 0, bytes32(0), bytes32(0));

        assertEq(quote.balanceOf(ALICE), aliceBefore, "Alice's approval was spent by someone else");
        assertEq(quote.balanceOf(address(c)), 0, "the curve took quote from a non-caller");
    }

    /// @notice The same for the factory: `_firstBuy` pulls from the launcher, so an approval to the
    ///         factory cannot be spent by another account's launch.
    function test_aVictimsAllowanceToTheFactoryIsUnspendableByAnotherLaunch() public {
        quote.mint(ALICE, 10_000e6);
        vm.prank(ALICE);
        quote.approve(address(factory), type(uint256).max);

        DokuFactory.LaunchParams memory p = Launches.params(factory, address(quote), Sinks.BURN, 0);
        p.firstBuyQuote = 1_000e6;

        vm.deal(MALLORY, 10 ether);
        vm.prank(MALLORY);
        vm.expectRevert();
        factory.launch{value: 1 ether}(p);

        assertEq(quote.balanceOf(ALICE), 10_000e6, "Alice's approval to the factory was spent");
    }

    // =========================================================================================
    // 2. THE FILL IS EXACT, AT EVERY SINK AND EVERY TAX
    // =========================================================================================

    /**
     * `DokuGraduation` seeds the pool with `quoteRaised` against a fixed `DOKU_SEED_BASE`, so the
     * opening price of every market is a function of the raise landing on the target EXACTLY.
     * `_levy`'s clamp recomputes forward from `grossNeeded` and then clamps again, and each of the
     * four levies floors independently — so "it lands on the target" is an arithmetic claim about
     * two ceilings and four floors interacting, not an obvious one.
     */
    function testFuzz_theFillLandsExactlyOnTheTarget(uint8 sinkRaw, uint16 taxRaw, uint256 overshoot, uint256 warmup)
        public
    {
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 tax = uint16(bound(taxRaw, 0, 100)) * 10;
        (BondingCurve c,) = _market(address(quote), sink, tax, TARGET6);

        quote.mint(ALICE, 10_000_000e6);
        vm.startPrank(ALICE);
        quote.approve(address(c), type(uint256).max);

        uint256 pre = bound(warmup, 0, TARGET6 - 1);
        if (pre > 0) c.buyWithToken(pre, 0, type(uint256).max);
        if (c.readyToGraduate()) {
            vm.stopPrank();
            return;
        }

        // `remaining()` is the CURVE leg still needed, not the GROSS a buyer must send — the
        // levies come off the top first, so a send of exactly `remaining()` under-fills by the fee
        // and the tax. (Checked: that is the accessor's documented meaning, and the interface uses
        // it only to decide the gas tier. Noted here so the next round does not mistake it for a
        // defect the way this test first did.) Twice the remainder always clears the 11% ceiling.
        uint256 amt = c.remaining() * 2 + bound(overshoot, 0, 5_000_000e6) + 1;
        uint256 spentBefore = quote.balanceOf(ALICE);
        c.buyWithToken(amt, 0, type(uint256).max);
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "a buy covering the remainder did not fill the curve");
        assertEq(c.quoteRaised(), c.quoteTarget(), "the raise did not land exactly on the target");

        // And the buyer paid only for what was consumed: the refund is real, not absorbed.
        uint256 spent = spentBefore - quote.balanceOf(ALICE);
        assertLe(spent, amt, "the buyer was charged more than they sent");
        assertEq(
            c.quoteBooked(), quote.balanceOf(address(c)), "the filling buy left the curve off its balance"
        );
    }

    /// @notice The same on a native market, where the refund is a bare `call` back to the buyer
    ///         from inside the curve's own reentrancy guard.
    function testFuzz_theFillLandsExactlyOnTheTarget_native(uint8 sinkRaw, uint16 taxRaw, uint256 overshoot)
        public
    {
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 tax = uint16(bound(taxRaw, 0, 100)) * 10;
        (BondingCurve c,) = _market(address(0), sink, tax, NATIVE_TARGET);

        vm.deal(ALICE, 1_000_000 ether);
        uint256 amt = c.remaining() * 2 + bound(overshoot, 0, 100_000 ether) + 1;
        vm.prank(ALICE);
        c.buy{value: amt}(0, type(uint256).max);

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        assertEq(c.quoteRaised(), c.quoteTarget(), "the raise did not land exactly on the target");
        assertEq(c.quoteBooked(), address(c).balance, "the filling buy left the curve off its balance");
    }

    // =========================================================================================
    // 3. A BUY NEVER TAKES QUOTE AND RETURNS NOTHING — AND WHERE THAT STOPS BEING TRUE
    // =========================================================================================

    /**
     * `sell` reverts `ZeroOutput` on a trade priced down to nothing, with a measurement showing it
     * is reachable on a coarse quote at an ordinary size. `_buy` has NO such guard — it only checks
     * `out < minBaseOut`, which a buyer who left slippage at zero does not benefit from.
     *
     * CANDIDATE KILLED, with the boundary measured rather than argued. `baseOut == 0` needs
     * `baseReserve * quoteIn < quoteReserve + quoteIn`, i.e. roughly `quoteIn < quoteReserve /
     * baseReserve`. The base reserve opens at 1.089e27 and never falls below 3.11e26, so the ratio
     * only reaches one wei once the quote reserve passes the base reserve — a `quoteTarget` above
     * ~2.2e26 RAW units. Both registered targets are ~13 and ~17 orders of magnitude below that.
     */
    function testFuzz_aBuyAlwaysReturnsTokensAtRegisteredTargets(
        uint256 amount,
        uint8 sinkRaw,
        uint16 taxRaw,
        uint256 elapsed
    ) public {
        uint8 sink = uint8(bound(sinkRaw, 0, 2));
        uint16 tax = uint16(bound(taxRaw, 0, 100)) * 10;
        (BondingCurve c, DokuToken t) = _market(address(quote), sink, tax, TARGET6);

        // The whole anti-sniper window, including its two edges. The rate is what decides how much
        // of `curveAmount` is spent on the burn instead of on the buyer's own leg, so a rate that
        // could ever consume the whole of it would show up here as a buy that returns nothing.
        // (`vm.getBlockTimestamp()` — `via_ir` folds the bare global across `vm.warp`.)
        vm.warp(vm.getBlockTimestamp() + bound(elapsed, 0, 400));

        // Sized to span an ordinary buy, the clamp region, and a gross far above the whole target.
        uint256 amt = bound(amount, 1, TARGET6 * 3);
        quote.mint(ALICE, 10_000_000e6);
        vm.startPrank(ALICE);
        quote.approve(address(c), type(uint256).max);
        c.buyWithToken(amt, 0, type(uint256).max);
        vm.stopPrank();

        assertGt(t.balanceOf(ALICE), 0, "a buy took quote and returned no tokens");
        assertEq(c.quoteBooked(), quote.balanceOf(address(c)), "the buy left the curve off its balance");
    }

    /// @notice The boundary itself, so the claim above is a measurement. At `MAX_QUOTE_TARGET` the
    ///         virtual quote reserve is 4e29 against a 1.089e27 base reserve, and a buy under ~367
    ///         raw units prices to zero tokens. It is the buyer's own dust and it still counts
    ///         toward the raise, so nobody else is worse off — but it is the asymmetry with
    ///         `sell`'s `ZeroOutput` guard, recorded here rather than re-derived next round.
    function test_theZeroOutputBuyBoundaryIsFarAboveEveryRegisteredTarget() public {
        (BondingCurve big, DokuToken bt) = _market(address(0), Sinks.BURN, 0, DOKU_MAX_QUOTE_TARGET);
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        big.buy{value: 100}(0, type(uint256).max);
        assertEq(bt.balanceOf(ALICE), 0, "the boundary moved: 100 wei now buys something at 1e30");
        assertEq(big.quoteRaised(), 100, "the dust was not counted toward the raise");

        // The registered MON target: the same 100 wei buys a real position.
        (BondingCurve real, DokuToken rt) = _market(address(0), Sinks.BURN, 0, NATIVE_TARGET);
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        real.buy{value: 100}(0, type(uint256).max);
        assertGt(rt.balanceOf(ALICE), 0, "100 wei bought nothing at the registered MON target");
    }

    /**
     * The other side of the same coin, on a LIVE registered configuration. XAUt0 is registered on
     * Monad mainnet at `quoteTarget = 1,809,590` raw units (6 decimals, ~1.81 troy oz), read from
     * `QuoteRegistry 0xeE4CB618…` at chain 143. Against a base reserve of ~1.09e27 that makes the
     * quote side ~10^21 times coarser than the base side, so an ordinary-looking sell of a few
     * hundred whole tokens prices to ZERO raw units out.
     *
     * `sell`'s `ZeroOutput` guard is therefore load-bearing on an asset that is enabled today, not
     * a theoretical nicety — and `minQuoteOut` cannot substitute for it, because zero satisfies any
     * bound. Pinned so a future "simplification" that drops the guard has something to break.
     */
    function test_theZeroOutputSellGuardIsLoadBearingOnALiveAsset() public {
        uint256 xauTarget = 1_809_590; // read on chain, see the docblock
        (BondingCurve c, DokuToken t) = _market(address(quote), Sinks.BURN, 0, xauTarget);

        quote.mint(ALICE, 1_000_000e6);
        vm.startPrank(ALICE);
        quote.approve(address(c), type(uint256).max);
        c.buyWithToken(xauTarget / 2, 0, type(uint256).max);

        uint256 held = t.balanceOf(ALICE);
        assertGt(held, 1_000e18, "the fixture did not produce a real position");

        // A hundred whole tokens: a visible position, priced to nothing.
        t.approve(address(c), 100e18);
        (uint256 out,,) = c.quoteSell(100e18);
        assertEq(out, 0, "the boundary moved; re-derive the size below");
        vm.expectRevert(BondingCurve.ZeroOutput.selector);
        c.sell(100e18, 0, type(uint256).max);
        vm.stopPrank();

        assertEq(t.balanceOf(ALICE), held, "the seller lost tokens to a zero-value sale");
    }

    // =========================================================================================
    // 4. THE FACTORY NEVER OWES MORE NATIVE THAN IT HOLDS
    // =========================================================================================

    /**
     * `collectLaunchFees` is permissionless and pays `pendingLaunchFees` in full. If the factory can
     * ever be made to owe more than it holds, that call bricks and the protocol's own fees are
     * stranded — and if it can be made to hold less than it owes at the instant of a re-entrant
     * collect, somebody else's money leaves.
     *
     * The window is the native first-buy refund, which hands a contract creator execution INSIDE
     * `launch`. Asserted across a nested launch, which is a supported outcome rather than an
     * accident.
     */
    function test_theFactoryHoldsAtLeastWhatItOwesAcrossANestedLaunch() public {
        NestingLauncher nl = new NestingLauncher(factory);
        vm.deal(address(nl), 10_000 ether);

        DokuFactory.LaunchParams memory p = Launches.native(factory, Sinks.BURN);
        p.meta.ticker = "OUTER";
        // Overshoot the whole target so the refund — and therefore the callback — is guaranteed.
        p.firstBuyQuote = NATIVE_TARGET * 2;

        nl.arm(true);
        nl.go{value: 0}(p, 1 ether + NATIVE_TARGET * 2);

        assertTrue(nl.inner() != address(0), "the nested launch did not happen");
        assertGe(
            address(factory).balance,
            factory.pendingLaunchFees(),
            "the factory owes more native than it holds"
        );
        assertEq(factory.pendingLaunchFees(), 2 ether, "both launch fees were not booked");

        factory.collectLaunchFees();
        assertEq(FEEREC.balance, 2 ether, "the fee recipient was short-paid");
        assertEq(factory.pendingLaunchFees(), 0, "the ledger did not clear");
    }

    // =========================================================================================
    // 4b. THE ONE SILENT NARROWING CAST ON A USER-SUPPLIED NUMBER
    // =========================================================================================

    /**
     * `sell` takes `baseIn` as a `uint256` and writes `r.base += uint128(baseIn)` — an EXPLICIT
     * narrowing cast, which in Solidity truncates silently rather than reverting. A `baseIn` of
     * `2**128 + n` would move the reserve by `n` while `gross` was priced off the full number, and
     * that is a curve paying out against a reserve it never took.
     *
     * CANDIDATE KILLED, twice over, and both bounds are asserted rather than reasoned about:
     *
     *   1. The arithmetic closes it first. To keep `gross <= quoteRaised` the post-trade quote
     *      reserve must stay at or above the virtual floor `0.4 * target`, and the ceiling is
     *      `1.4 * target`, so `baseIn <= 2.5 * baseReserve <= 2.72e27` — eleven orders of magnitude
     *      below `2**128`. Anything larger reverts on `quoteRaised -= gross` before the cast can
     *      matter.
     *   2. The token closes it again: the seller must actually deliver `baseIn`, and the entire
     *      supply is 1e27.
     */
    function test_anOversizedSellRevertsRatherThanTruncatingTheReserveCast() public {
        (BondingCurve c, DokuToken t) = _market(address(quote), Sinks.BURN, 0, TARGET6);

        quote.mint(ALICE, 1_000_000e6);
        vm.startPrank(ALICE);
        quote.approve(address(c), type(uint256).max);
        c.buyWithToken(4_000e6, 0, type(uint256).max);

        (uint128 baseBefore,) = c.reserves();
        uint256 raisedBefore = c.quoteRaised();

        // 2**128 + 7: the cast would add SEVEN to the reserve while pricing off 3.4e38.
        t.approve(address(c), type(uint256).max);
        vm.expectRevert();
        c.sell(uint256(type(uint128).max) + 8, 0, type(uint256).max);
        vm.stopPrank();

        (uint128 baseAfter,) = c.reserves();
        assertEq(baseAfter, baseBefore, "the reserve moved on a reverted sell");
        assertEq(c.quoteRaised(), raisedBefore, "the raise moved on a reverted sell");
        assertEq(c.quoteBooked(), quote.balanceOf(address(c)), "the curve is off its balance");
    }

    // =========================================================================================
    // 4c. THE DEFERRED-CREDIT ARM ACTUALLY RUNS
    // =========================================================================================

    /**
     * `collectFees` and `collectTax` are permissionless, and the whole reason they can be is
     * `_payOrCredit`: a recipient that cannot receive must not be able to brick the call for the
     * stranger who made it. That promise lives entirely in an arm that only executes on a NATIVE
     * market with a recipient that reverts — on an ERC-20 quote a plain `transfer` to a hostile
     * contract succeeds, because ERC-20 has no callback.
     *
     * `Round1Solvency`'s walk passes `address(0)` as the curve's `creatorSink`, so that arm reverts
     * there and is swallowed by its own `try`/`catch`: 10,000 runs of coverage that could not have
     * caught a bug in it. This is the direct test.
     */
    function test_aRecipientThatCannotReceiveIsDeferredIntoTheSinkAndBlocksNobody() public {
        P3Sink s = new P3Sink();
        P3Refuser r = new P3Refuser();

        bytes32 salt = keccak256("p3-defer");
        address ca = Clones.cloneDeterministic(curveImpl, salt);
        address ta = Clones.cloneDeterministic(tokenImpl, salt);
        DokuToken(ta).initialize("Defer", "DEF", ca, false, "https://cdn.doku.family/metadata/test.json");
        BondingCurve c = BondingCurve(payable(ca));
        c.initialize(
            ta, address(0), NATIVE_TARGET, Sinks.CREATOR, address(r), 500, address(r), TREASURY, address(grad), address(s)
        );

        vm.deal(ALICE, 10_000 ether);
        vm.prank(ALICE);
        c.buy{value: 100 ether}(0, type(uint256).max);

        uint256 fees = c.pendingFees();
        uint256 tax = c.pendingTax();
        assertGt(fees, 0, "no routed share accrued");
        assertGt(tax, 0, "no creator tax accrued");

        // A stranger triggers both. Neither reverts, and both land in the sink.
        vm.prank(MALLORY);
        c.collectFees();
        vm.prank(MALLORY);
        c.collectTax();

        assertEq(s.owed(address(r), address(0)), fees + tax, "the deferred credit did not reach the sink");
        assertEq(address(r).balance, 0, "the refuser was somehow paid directly");
        assertEq(c.pendingFees(), 0, "the fee bucket did not clear");
        assertEq(c.pendingTax(), 0, "the tax bucket did not clear");
        assertEq(c.quoteBooked(), address(c).balance, "the curve is off its balance after deferring");
    }

    // =========================================================================================
    // 5. THE CHECKPOINTS THE REWARD VAULT WEIGHS HOLDERS BY
    // =========================================================================================

    /**
     * `getPastBalance` / `getPastTotalSupply` are documented as "as of the END of `blockNumber`".
     * `RewardVault` divides one holder's answer by the other, so a boundary that is off by one
     * block in either direction mis-splits a dividend between two holder sets.
     */
    function test_pastBalanceIsTheEndOfBlockValue() public {
        (BondingCurve c, DokuToken t) = _market(address(0), Sinks.REWARDS, 0, NATIVE_TARGET);
        assertTrue(t.trackHistory(), "a REWARDS market is not checkpointing");

        vm.deal(ALICE, 10_000 ether);
        vm.prank(ALICE);
        c.buy{value: 10 ether}(0, type(uint256).max);
        uint256 buyBlock = vm.getBlockNumber();
        uint256 held = t.balanceOf(ALICE);
        // The buy's own anti-sniper burn happens in this block, so the supply checkpoint for
        // `buyBlock` must already be net of it — the end-of-block rule, not the start-of-block one.
        uint256 supplyAtBuy = t.totalSupply();
        assertLt(supplyAtBuy, t.TOTAL_SUPPLY(), "the anti-sniper burn did not happen");

        // Several moves INSIDE one later block must collapse to the last one.
        vm.roll(buyBlock + 1);
        uint256 moveBlock = vm.getBlockNumber();
        vm.startPrank(ALICE);
        t.transfer(MALLORY, held / 4);
        t.transfer(MALLORY, held / 4);
        t.burn(1);
        vm.stopPrank();

        vm.roll(moveBlock + 1);

        assertEq(t.getPastBalance(ALICE, buyBlock), held, "the buy block did not close on the bought balance");
        assertEq(t.getPastBalance(MALLORY, buyBlock), 0, "a later transfer leaked into an earlier block");
        assertEq(
            t.getPastBalance(ALICE, moveBlock),
            t.balanceOf(ALICE),
            "the move block did not close on the final balance"
        );
        assertEq(
            t.getPastBalance(MALLORY, moveBlock),
            t.balanceOf(MALLORY),
            "both transfers in one block did not collapse onto the last"
        );
        assertEq(t.balanceOf(MALLORY), held / 4 * 2, "the two transfers did not both land");
        assertEq(
            t.getPastTotalSupply(moveBlock), t.totalSupply(), "the burn did not reach the supply checkpoint"
        );
        assertEq(
            t.getPastTotalSupply(buyBlock),
            supplyAtBuy,
            "the buy block's supply checkpoint is not its END-of-block value"
        );
    }

    /// @notice A block that has not been mined is refused, on both accessors, so a snapshot is
    ///         always already in the past when the vault reads it.
    function test_anUnminedBlockIsRefused() public {
        (, DokuToken t) = _market(address(0), Sinks.REWARDS, 0, NATIVE_TARGET);
        uint256 now_ = vm.getBlockNumber();
        vm.expectRevert(abi.encodeWithSelector(DokuToken.BlockNotYetMined.selector, now_, now_));
        t.getPastBalance(ALICE, now_);
        vm.expectRevert(abi.encodeWithSelector(DokuToken.BlockNotYetMined.selector, now_ + 1, now_));
        t.getPastTotalSupply(now_ + 1);
    }

    /// @notice A BURN market does not checkpoint, and therefore answers zero. That is by design —
    ///         only a REWARDS market has a vault — and it is pinned so a future sink that starts
    ///         asking cannot inherit a silent zero.
    function test_aNonRewardsMarketReportsNoHistory() public {
        (, DokuToken t) = _market(address(0), Sinks.BURN, 0, NATIVE_TARGET);
        assertFalse(t.trackHistory(), "a BURN market is paying for history it never reads");
        vm.roll(vm.getBlockNumber() + 2);
        assertEq(t.getPastTotalSupply(vm.getBlockNumber() - 1), 0, "a non-tracking token answered a supply");
    }
}
