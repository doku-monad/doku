// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * ADVERSARIAL RE-TRIAGE of the eight findings claimed on 2026-09-10.
 *
 * Every test here is written to KILL a claim, not to preserve one. Where a claim survives, the
 * test is the evidence it survived on; where it dies, the test is the evidence it died on.
 *
 * Nothing in `src/` is touched. `vm.getBlockTimestamp()` everywhere a timestamp is read, because
 * `via_ir = true` folds `block.timestamp` past a warp.
 */

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {ZapRouter} from "../../src/ZapRouter.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Wiring} from "../helpers/Wiring.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

// =============================================================================================
//                                   F1 / F8 — the launch path
// =============================================================================================

/**
 * @dev A quote asset with an ERC-777 `tokensToSend` hook, and NOTHING ELSE hostile about it.
 *
 *      This is the load-bearing difference from `test/_gen3/FactoryGen3Audit.t.sol`'s
 *      `ReentrantQuote`, which re-enters DOKU from inside its own `_update` and therefore has to
 *      have been written by the attacker. Here the token knows nothing about DOKU: it does what
 *      ERC-777 §"tokensToSend" mandates — notify the SENDER before moving their balance — and the
 *      hostile party is the sender, who is the launch's own creator.
 *
 *      So the class of assets that arms F1 is not "a token an attacker wrote". It is every ERC-777
 *      in existence, plus anything else that calls the payer back.
 */
interface ITokensToSend {
    function tokensToSend(address from, address to, uint256 amount) external;
}

contract HookQuote is ERC20 {
    /// @dev Stands in for the ERC-1820 registry: an address opts ITSELF in, exactly as an ERC-777
    ///      sender does. The token does not choose who gets called back.
    mapping(address => bool) public senderHook;

    constructor() ERC20("Hook Quote", "HQ") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setSenderHook(bool on) external {
        senderHook[msg.sender] = on;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (senderHook[from]) ITokensToSend(from).tokensToSend(from, to, amount);
        return super.transferFrom(from, to, amount);
    }
}

/// @dev The launch creator. Hostile; the token is not.
contract FirstBuyAttacker is ITokensToSend {
    DokuFactory public immutable factory;
    HookQuote public immutable quote;
    address public curve;
    uint256 public inner;
    bool public armed;
    bool public fired;

    constructor(DokuFactory f, HookQuote q) {
        factory = f;
        quote = q;
        q.setSenderHook(true);
    }

    function launch(DokuFactory.LaunchParams memory p, uint256 fee, uint256 inner_)
        external
        payable
        returns (address, address)
    {
        (address predicted,) = factory.predictMarket(address(this));
        curve = predicted;
        inner = inner_;
        armed = true;
        quote.approve(address(factory), type(uint256).max);
        // The allowance the INNER buy will spend. Ordinary, and set before the launch because a
        // hook has no room to approve inside its own callback.
        quote.approve(predicted, type(uint256).max);
        return factory.launch{value: fee}(p);
    }

    /// @dev The whole attack: one ordinary `buyWithToken`, made from inside the notification the
    ///      token owes the sender, which lands between the factory's two balance reads.
    function tokensToSend(address, address, uint256) external override {
        // `inner == 0` is the honest launch: the hook is present and does nothing, which is what
        // the control arm of `test_F1b2` needs.
        if (!armed || fired || inner == 0) return;
        fired = true;
        BondingCurve(payable(curve)).buyWithToken(inner, 0, type(uint256).max);
    }

    /// @dev The same hook, pointed at the curve's OWN inbound leg instead of the factory's.
    function rearm(address curve_, uint256 inner_) external {
        curve = curve_;
        inner = inner_;
        armed = true;
        fired = false;
        quote.approve(curve_, type(uint256).max);
    }

    function setArmed(bool on) external {
        armed = on;
    }

    function directBuy(uint256 amount) external returns (uint256) {
        return BondingCurve(payable(curve)).buyWithToken(amount, 0, type(uint256).max);
    }

    function sellAll(address token_) external returns (uint256) {
        uint256 bal = IERC20(token_).balanceOf(address(this));
        IERC20(token_).approve(curve, bal);
        return BondingCurve(payable(curve)).sell(bal, 0, type(uint256).max);
    }

    function sell(address token_, uint256 amount) external returns (uint256) {
        IERC20(token_).approve(curve, amount);
        return BondingCurve(payable(curve)).sell(amount, 0, type(uint256).max);
    }

    receive() external payable {}
}

/// @dev A graduator wired to the factory under test that actually calls `release`, so an
///      over-booked raise surfaces as a REVERT rather than as a swallowed non-graduation.
contract TriageGraduator {
    address public immutable factory;
    bool public ok;
    bytes public err;

    constructor(address f) {
        factory = f;
    }

    function graduate(address curve) external returns (bytes32, uint256) {
        try BondingCurve(payable(curve)).release() {
            ok = true;
        } catch (bytes memory e) {
            ok = false;
            err = e;
            revert("release failed");
        }
        return (bytes32(0), 0);
    }

    function sinkOf(address) external view returns (address) {
        return address(this);
    }

    function creditCurveTax(address) external payable {}

    function creditCurveTax(address, uint256) external {}

    receive() external payable {}
}

contract F1FirstBuyDeltaTest is Test {
    DokuFactory internal factory;
    QuoteRegistry internal registry;
    TriageGraduator internal grad;
    HookQuote internal quote;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant SINKADDR = address(0x5111);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);

    uint256 internal constant FEE = 0.01 ether;
    uint256 internal constant TARGET = 8_000e6;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), SINKADDR, FEE);
        grad = new TriageGraduator(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(grad));

        // The factory ships paused with no graduator; activation is what opens it. See
        // `test/helpers/Wiring.sol`.
        Wiring.activate(factory, OWNER, address(grad));
        quote = new HookQuote();
        vm.prank(OWNER);
        registry.register(address(quote), TARGET);
        vm.prank(OWNER);
        registry.register(address(0), 1_000e18);
    }

    function _params(address creator, uint256 firstBuy)
        internal
        view
        returns (DokuFactory.LaunchParams memory p)
    {
        p.meta.name = "Triage";
        p.meta.ticker = "TRI";
        p.quoteAsset = address(quote);
        p.sink = Sinks.REWARDS;
        p.creatorTaxBps = 0;
        p.economicsPin = factory.economicsPin(address(quote), Sinks.REWARDS, 0);
        p.deadline = type(uint256).max;
        p.firstBuyQuote = firstBuy;
        creator; // silence
    }

    function _booked(BondingCurve c) internal view returns (uint256) {
        return c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax();
    }

    // ------------------------------------------------------------------------------------
    // F1.a — the double-count WAS real. It is fixed; the precondition it needed is not.
    // ------------------------------------------------------------------------------------

    /**
     * FIXED 2026-09-11. This test kept its scenario and inverted its assertion.
     *
     * WHAT IT USED TO DO, and why the finding was right. `DokuFactory._firstBuy` priced the launch
     * buy on a RAW balance delta around `safeTransferFrom`. A quote token that calls the PAYER back
     * — which is not a bespoke attacker's token but every ERC-777, because the standard mandates a
     * `tokensToSend` notification to the sender — let the payer buy on the brand-new curve from
     * inside the transfer. That inner buy raised the curve's balance AND booked itself a credit, so
     * the raw delta contained both legs and the creator was credited for the attacker's money as
     * well as their own. Measured here at the time: 1,000e6 sent, 1,000e6 re-entered, the curve
     * holding 2,000e6 and having booked 3,000e6 — short by exactly the reentrant amount, for ever.
     *
     * THE FIX. `BondingCurve.quoteBooked()` was added — `quoteRaised + pendingProtocol +
     * pendingFees + pendingTax`, the curve's whole quote liability — and `_firstBuy` now credits
     * the UNBOOKED part of the delta:
     *
     *     grew    = balanceAfter  - balanceBefore
     *     booked  = quoteBooked() - bookedBefore
     *     arrived = grew - booked        // `grew <= booked` reverts FirstBuyDeliveredNothing
     *
     * Quote that is already credited to somebody cannot also be credited to the creator, whatever
     * the callback did. The mechanism is class-complete for solvency rather than a patch for this
     * one callback shape — see `test/audit/Round1Solvency.t.sol` for the argument and the fuzz.
     *
     * WHAT THE FINDING STILL GETS RIGHT, and this is why the fixture is kept verbatim: the
     * PRECONDITION is unchanged. A registered quote asset can still run code inside its own
     * transfer, the hook below still fires, and nothing in `QuoteRegistry` detects it. What changed
     * is only that the re-entrant buy is now the re-enterer's own ordinary position.
     */
    function test_F1a_theSenderHookStillFiresAndItsBuyIsNoLongerCreditedToTheCreator() public {
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);

        uint256 first = 1_000e6;
        uint256 inner = 1_000e6;
        (address curveAddr,) = atk.launch{value: FEE}(_params(address(atk), first), FEE, inner);
        BondingCurve c = BondingCurve(payable(curveAddr));

        assertTrue(atk.fired(), "the sender hook never ran - the fixture proves nothing");
        assertEq(quote.balanceOf(curveAddr), first + inner, "the curve holds what was really sent");
        // The line that used to read `first + 2 * inner`.
        assertEq(_booked(c), first + inner, "the inner buy is still being booked twice");
        assertEq(
            _booked(c), quote.balanceOf(curveAddr), "the curve did not come out of the launch exactly solvent"
        );
        // And the accessor the fix rests on agrees with the four terms read individually, so a
        // future revision that adds a fifth liability without adding it to `quoteBooked()` fails
        // here rather than silently over-booking again.
        assertEq(c.quoteBooked(), _booked(c), "quoteBooked() is no longer the sum of the four buckets");
    }

    // ------------------------------------------------------------------------------------
    // F1.b — it WAS fund theft, not only a frozen market. The theft is closed; the sequence
    //        is kept, because the sequence is what would find it again.
    // ------------------------------------------------------------------------------------

    /**
     * FIXED 2026-09-11. Scenario preserved, assertions inverted. Read with `test_F1b2`, which is
     * its control — neither means anything alone.
     *
     * WHAT IT USED TO DO. The writeup's worst case was "`release()` tries to pay out more quote
     * than the curve holds ... and the market freezes with the raise inside it", and that is the
     * LATE symptom. The early one was that the attacker held tokens the curve believed were backed
     * by money nobody paid, and an HONEST BUYER'S money was what backed them. Measured here at the
     * time: the attacker recovered 4,506.70e6 against 2,000e6 staked, +26.3% on stake, and the
     * honest buyer who paid 3,000e6 could not exit at all — his `sell` reverted on the quote
     * token's own `ERC20InsufficientBalance`, which names nothing in this protocol.
     *
     * WHAT IT DOES NOW. The same sequence, against `_firstBuy`'s unbooked-delta credit: the curve
     * is exactly solvent at every step, and the honest buyer's exit SUCCEEDS.
     *
     * He still ends with less quote than he brought, and that is not a defect — he bought after two
     * buyers and sold after the creator exited, paying the 1% fee on both legs. That is what a
     * bonding curve is, and separating it from the bug is precisely the job of the control in
     * `test_F1b2`.
     */
    function test_F1b_theOverBookIsGoneAndTheHonestBuyerCanStillExit() public {
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);

        uint256 first = 1_000e6;
        uint256 inner = 1_000e6;
        uint256 spent = first + inner;
        uint256 before = quote.balanceOf(address(atk));

        (address curveAddr, address tokenAddr) =
            atk.launch{value: FEE}(_params(address(atk), first), FEE, inner);
        BondingCurve c = BondingCurve(payable(curveAddr));
        assertEq(before - quote.balanceOf(address(atk)), spent, "the attacker did not pay what it should");

        // Past the anti-sniper window, so the honest buyer is not paying a launch tax the attacker
        // did not. Read through the cheatcode: `via_ir` folds the global past a warp.
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(vm.getBlockNumber() + 1);

        uint256 honest = 3_000e6;
        quote.mint(BOB, honest);
        vm.startPrank(BOB);
        quote.approve(curveAddr, type(uint256).max);
        c.buyWithToken(honest, 0, type(uint256).max);
        vm.stopPrank();

        // The attacker exits first, which is the whole point of being the one who knew.
        atk.sellAll(tokenAddr);
        uint256 recovered = quote.balanceOf(address(atk)) - (before - spent);

        emit log_named_uint("attacker paid ", spent);
        emit log_named_uint("attacker got back", recovered);
        emit log_named_uint("honest buyer paid", honest);

        // The curve is still solvent with the attacker's position fully unwound, which is the
        // condition that used to fail here.
        assertEq(quote.balanceOf(curveAddr), _booked(c), "the curve is insolvent after the exit");

        // And the honest buyer is no longer holding a hole: his exit goes through. This is the
        // line that used to report "no".
        uint256 bobTokens = IERC20(tokenAddr).balanceOf(BOB);
        vm.startPrank(BOB);
        IERC20(tokenAddr).approve(curveAddr, bobTokens);
        (bool sold,) = curveAddr.call(
            abi.encodeWithSelector(BondingCurve.sell.selector, bobTokens, uint256(0), type(uint256).max)
        );
        vm.stopPrank();
        emit log_named_string("honest buyer could exit", sold ? "YES" : "no");
        emit log_named_uint("honest buyer got back", quote.balanceOf(BOB));
        assertTrue(sold, "the honest buyer still could not exit");
        assertEq(quote.balanceOf(curveAddr), _booked(c), "the curve is insolvent after the honest exit");
    }

    /**
     * THE CONTROL, and without it the test above proves nothing. Kept, and kept PAIRED: F1b says
     * what the attacked market does, this says what the same capital does honestly, and only the
     * difference between them is ever the finding.
     *
     * A creator who buys first on a bonding curve and sells into the next buyer profits ANYWAY —
     * that is what a bonding curve is. So the question was never "did the attacker make money" but
     * "did the ATTACK make money", and the only way to answer it is to run the identical sequence
     * with the same capital and no reentrancy.
     *
     * WHAT IT USED TO SHOW: attacked 4,506.70e6 against control 3,980.11e6 — `assertGt(attacked,
     * honest)`. The reentrancy was worth +13% over spending the same 2,000e6 as one honest first
     * buy, and it left the attacked market insolvent while the control market was fine.
     *
     * WHAT IT SHOWS NOW: the inequality is REVERSED, and not merely closed to a tie. Splitting the
     * 2,000e6 into a 1,000e6 launch buy plus a 1,000e6 re-entrant buy is now strictly WORSE than
     * declaring the whole 2,000e6 as the launch buy, because `buyFor` is the one call that pays
     * anti-sniper rate ZERO and the re-entrant `buyWithToken` is an ordinary buy landing in the
     * same block as the launch — at `TAX_START_BPS`, 50%. The attacker pays the full launch tax on
     * the half they smuggled in. Both markets end exactly solvent.
     */
    function test_F1b2_theControl_theReentrancyNowEarnsLessThanTheSameCapitalSpentHonestly() public {
        // --- attacked
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address ca, address ta) = atk.launch{value: FEE}(_params(address(atk), 1_000e6), FEE, 1_000e6);
        uint256 attacked = _runToExit(BondingCurve(payable(ca)), ta, atk, 3_000e6);

        // --- honest: the whole 2,000e6 declared as the first buy, no hook
        FirstBuyAttacker honestCreator = new FirstBuyAttacker(factory, quote);
        quote.mint(address(honestCreator), 100_000e6);
        vm.deal(address(honestCreator), 1 ether);
        (address ch, address th) =
            honestCreator.launch{value: FEE}(_params(address(honestCreator), 2_000e6), FEE, 0);
        assertFalse(honestCreator.fired(), "the control arm re-entered after all");
        uint256 honest = _runToExit(BondingCurve(payable(ch)), th, honestCreator, 3_000e6);

        emit log_named_uint("recovered, attacked ", attacked);
        emit log_named_uint("recovered, control  ", honest);
        assertLt(attacked, honest, "the reentrancy still earns more than the honest first buy");

        // And the two markets are now left in the SAME condition: exactly solvent. The line below
        // used to assert that they differed.
        BondingCurve control = BondingCurve(payable(ch));
        BondingCurve attackedCurve = BondingCurve(payable(ca));
        assertEq(quote.balanceOf(ch), _booked(control), "the control market came out insolvent");
        assertEq(quote.balanceOf(ca), _booked(attackedCurve), "the attacked market came out insolvent");
    }

    /// @dev Launch already done: warp past the tax, let one honest buyer in, exit everything.
    function _runToExit(BondingCurve c, address token_, FirstBuyAttacker creator, uint256 honest)
        internal
        returns (uint256 recovered)
    {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(vm.getBlockNumber() + 1);
        address buyer = address(uint160(uint256(keccak256(abi.encode(address(c))))));
        quote.mint(buyer, honest);
        vm.startPrank(buyer);
        quote.approve(address(c), type(uint256).max);
        c.buyWithToken(honest, 0, type(uint256).max);
        vm.stopPrank();

        uint256 before = quote.balanceOf(address(creator));
        creator.sellAll(token_);
        recovered = quote.balanceOf(address(creator)) - before;
    }

    /**
     * FIXED 2026-09-11. Same buy, opposite outcome.
     *
     * WHAT IT USED TO DO: the freeze, one step earlier than F1c's. With a large enough overshoot
     * the FILLING BUY itself reverted, because the curve could not pay the refund out of a balance
     * it was already short of. So an attacked market did not merely fail to graduate — past a point
     * it stopped accepting the very buys that would fill it, and the error a user saw was the quote
     * token's own `ERC20InsufficientBalance`, with nothing in it that names DOKU. That is the worst
     * shape a failure can take: unattributable.
     *
     * WHAT IT DOES NOW: the identical 20,000e6 buy against an 8,000e6 target — a 2.5x overshoot —
     * fills the curve, refunds the surplus, and graduates. The refund is payable because the curve
     * holds exactly what it booked.
     */
    function test_F1f_theFillingBuyTheAttackedMarketUsedToRefuseNowSucceeds() public {
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address curveAddr,) = atk.launch{value: FEE}(_params(address(atk), 1_000e6), FEE, 1_000e6);
        BondingCurve c = BondingCurve(payable(curveAddr));

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(vm.getBlockNumber() + 1);

        quote.mint(BOB, 50_000e6);
        uint256 bobBefore = quote.balanceOf(BOB);
        vm.startPrank(BOB);
        quote.approve(curveAddr, type(uint256).max);
        c.buyWithToken(20_000e6, 0, type(uint256).max); // used to revert ERC20InsufficientBalance
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "the buy landed but the curve did not fill");
        assertTrue(c.released(), "the filling buy did not graduate the market");
        // The overshoot came back rather than being absorbed, which is the part that used to fail.
        assertLt(bobBefore - quote.balanceOf(BOB), 20_000e6, "the whole 20,000e6 was taken");
        assertEq(quote.balanceOf(curveAddr), _booked(c), "the curve is insolvent after the fill");
    }

    // ------------------------------------------------------------------------------------
    // F1.c — the freeze the writeup describes. It was the SECOND consequence; it is now none.
    // ------------------------------------------------------------------------------------

    /**
     * FIXED 2026-09-11. Same fill, opposite outcome.
     *
     * WHAT IT USED TO DO: a market attacked at launch and then filled honestly could never
     * graduate. `release` transfers `quoteRaised`, which was larger than the balance, so the
     * transfer reverted, `_tryAutoGraduate` swallowed it, and every permissionless retry reverted
     * identically — for ever, since `graduator` is pinned at `initialize` with no setter. The raise
     * was sealed in a closed curve with no rescue by design.
     *
     * WHAT IT DOES NOW: the same two buys fill the same curve and it graduates on the filling buy.
     * `release` pays out `quoteRaised` because the curve holds `quoteRaised` — that is the whole
     * content of the solvency identity `_firstBuy` now preserves. The retry below still reverts,
     * but on `AlreadyReleased` rather than on an insufficient balance, which is the difference
     * between "it is done" and "it can never be done".
     */
    function test_F1c_anAttackedMarketNowGraduatesNormally() public {
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);

        (address curveAddr,) = atk.launch{value: FEE}(_params(address(atk), 1_000e6), FEE, 1_000e6);
        BondingCurve c = BondingCurve(payable(curveAddr));

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(vm.getBlockNumber() + 1);

        quote.mint(BOB, 50_000e6);
        vm.startPrank(BOB);
        quote.approve(curveAddr, type(uint256).max);
        // Two buys. The first stops short of the target, the second fills it with a five per cent
        // overshoot — the shape that used to be the LAST one an attacked market could still take,
        // because a larger overshoot reverted outright (see `test_F1f`, which now also passes).
        c.buyWithToken(c.remaining() / 2, 0, type(uint256).max);
        uint256 gradBefore = quote.balanceOf(address(grad));
        uint256 raise = c.quoteRaised() + c.remaining();
        c.buyWithToken((c.remaining() * 105) / 100, 0, type(uint256).max);
        vm.stopPrank();

        assertTrue(c.readyToGraduate(), "the curve did not fill");
        // The three lines that used to assert the freeze.
        assertTrue(c.released(), "auto-graduation still failed, so something is over-booked");
        assertEq(c.quoteRaised(), 0, "the raise did not leave the curve");
        assertEq(quote.balanceOf(address(grad)) - gradBefore, raise, "the graduator was not paid the raise");
        assertEq(quote.balanceOf(curveAddr), _booked(c), "the curve is insolvent after graduating");

        // The retry still reverts — on `AlreadyReleased` now, which is the correct one-shot.
        vm.expectRevert();
        grad.graduate(curveAddr);
    }

    // ------------------------------------------------------------------------------------
    // F1.d — the FIX that was taken, and an honest re-judgement of the one that was not.
    // ------------------------------------------------------------------------------------

    /**
     * WHAT THIS TEST SHOWS, unchanged and still true: `BondingCurve._pullAndBuy` measures the very
     * same delta and is NOT vulnerable, because the pull happens inside the curve's own
     * `nonReentrant`. The identical attack against `buyWithToken` bounces off the guard.
     *
     * WHAT THIS DOCSTRING USED TO CONCLUDE, and why it is now wrong: "the clamp removes this
     * instance, the guard removes the class — so the generation-4 fix is to move the pull". The fix
     * actually taken on 2026-09-11 is neither of those two. It is the third option in
     * `docs/doku/audit/2026-09-10-external/first-buy-delta-reentrancy.md`: the curve exposes
     * `quoteBooked()` and `_firstBuy` credits only the UNBOOKED part of the delta.
     *
     * RE-JUDGED, on the evidence, because the loop's rule is that a docstring arguing for a repair
     * that was not taken has to be either acted on or withdrawn:
     *
     *  1. **The unbooked-delta fix IS class-complete for solvency, and the guard is not.** Write
     *     `slack = held - booked`. Every entry point the curve has moves `held` and `booked` by the
     *     same amount, so `slack` is invariant under anything a callback can do THROUGH the curve —
     *     nested buy, nested sell, nested `collect*`, in any order, at any depth. `arrived =
     *     grew - booked` therefore books exactly the part of the delta nobody else claimed,
     *     whatever the callback was. `nonReentrant` does not cover the one case that is not a
     *     re-entry at all: a BARE DONATION to the curve mid-transfer raises `held` alone, and a
     *     guarded pull would credit it to the buyer exactly as this does. So "the guard removes the
     *     class" was overstated — the two designs handle that case identically.
     *
     *  2. **The guard's residual advantage is real but small**, and it is not solvency: it would
     *     also stop the callback from MOVING THE PRICE before the launch buy lands. It does not pay
     *     for itself. The re-entrant buy is an ordinary buy in the launch block, so it pays
     *     `TAX_START_BPS` — 50% — while `buyFor` pays zero; the round trip costs the sandwicher
     *     more than half their capital to move a price the creator already bounds with
     *     `firstBuyMinOut`. `test_F1b2` measures the sign of that: the attack now earns LESS than
     *     spending the same capital honestly.
     *
     *  3. **What moving the pull would cost is not a refactor, it is an approval.** The payer
     *     approves the FACTORY today — one allowance, to a deployed, known, inspectable contract,
     *     reusable across every launch. Moving the pull means approving the CURVE, whose address is
     *     predictable (`predictMarket`) but has no code at approval time, and which is a NEW address
     *     for every launch: one approval per launch, forever, to an address a wallet cannot show the
     *     user anything about. Signing an allowance to an empty address is a worse habit to teach
     *     than the thing it fixes.
     *
     *  4. **The residual the taken fix does carry**, stated so it is not lost: correctness depends
     *     on `quoteBooked()` remaining an EXHAUSTIVE list of the curve's quote liabilities. Add a
     *     fifth bucket in a later revision without adding it to that sum and `_firstBuy` silently
     *     over-books again. `test_F1a` above asserts the sum against the four fields read
     *     individually, and `test/audit/Round1Solvency.t.sol` fuzzes `quoteBooked() ==
     *     balanceOf(curve)` across buys, sells, refunds, clamped fills, all three sinks and both
     *     native and ERC-20 — which is the guard rail that residual needs.
     *
     * Verdict: the taken fix is the right one. Moving the pull remains available as belt-and-braces
     * if a future revision ever wants it, and its cost is the per-launch approval above.
     */
    function test_F1d_theCurvesOwnPullIsGuarded_andTheTakenFixIsTheUnbookedDelta() public {
        // A market launched with NO first buy, so nothing is attacked at launch.
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address curveAddr,) = atk.launch{value: FEE}(_params(address(atk), 0), FEE, 500e6);
        BondingCurve c = BondingCurve(payable(curveAddr));
        assertFalse(atk.fired(), "there was no first buy to hook");

        // Now the same hook, on the curve's own inbound leg. `buyWithToken` -> `transferFrom` ->
        // `tokensToSend` -> `buyWithToken` again.
        atk.rearm(curveAddr, 500e6);
        vm.expectRevert(); // ReentrancyGuardReentrantCall, raised inside the token's callback
        atk.directBuy(500e6);

        assertEq(_booked(c), 0, "a refused reentrant buy still booked something");
        assertEq(quote.balanceOf(curveAddr), 0, "a refused reentrant buy still moved money");

        // And with the hook disarmed the very same call is an ordinary, solvent buy.
        atk.rearm(curveAddr, 0);
        atk.setArmed(false);
        atk.directBuy(500e6);
        assertEq(quote.balanceOf(curveAddr), 500e6, "the honest buy did not land");
        assertEq(_booked(c), 500e6, "the honest buy booked something other than what arrived");
    }

    // ------------------------------------------------------------------------------------
    // F1.e — "immutable, so it cannot be patched" is TRUE. "so the only control is a rule" is not.
    // ------------------------------------------------------------------------------------

    /**
     * The writeup: "`QuoteRegistry.register` is `onlyOwner` and validates only `decimals()`; there
     * is no on-chain callback detection and none can be added ... So the mitigation is a rule."
     *
     * There are two ON-CHAIN kill switches, and neither is in the writeup:
     *   1. `QuoteRegistry.setEnabled(asset, false)` — `launch` reads `isEnabled` at launch time, so
     *      a registered asset can be revoked after the fact.
     *   2. `DokuFactory.pause()` — held by a separate pauser key, stops every new launch.
     *
     * Both close the door for FUTURE launches. Neither reaches a market already launched, which is
     * the half that actually matters and the half the writeup should have said.
     */
    function test_F1e_registrationIsRevocableOnChain_butNotRetroactively() public {
        FirstBuyAttacker atk = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk), 100_000e6);
        vm.deal(address(atk), 1 ether);
        (address curveAddr,) = atk.launch{value: FEE}(_params(address(atk), 1_000e6), FEE, 1_000e6);

        // 1. Revoke.
        vm.prank(OWNER);
        registry.setEnabled(address(quote), false);
        FirstBuyAttacker atk2 = new FirstBuyAttacker(factory, quote);
        quote.mint(address(atk2), 100_000e6);
        vm.deal(address(atk2), 1 ether);
        // Built BEFORE the expectation: `_params` reads `economicsPin` off the factory, and that
        // staticcall would otherwise be the "next call" the cheatcode is watching.
        DokuFactory.LaunchParams memory p2 = _params(address(atk2), 1_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(DokuFactory.QuoteNotEnabled.selector, address(quote))
        );
        atk2.launch{value: FEE}(p2, FEE, 1_000e6);

        // 2. Pause, which also stops a launch in an asset that is still enabled.
        vm.prank(PAUSER);
        factory.pause();
        assertTrue(factory.paused(), "the pauser could not pause");

        // 3. And neither undoes the market that already exists: it goes on trading, whatever the
        //    registry says afterwards. That half of the finding is unchanged and is the half that
        //    matters, because it is what a revocation cannot reach.
        //
        //    FIXED 2026-09-11: the market it cannot reach is now a SOLVENT one. This assertion used
        //    to read `assertGt(_booked(c), balanceOf(curveAddr))` — "the launched market healed
        //    itself" was the failure message, because before the fix no amount of honest trading
        //    could close the hole: a buy adds the same number to both sides of the identity and a
        //    sell removes the same number, so the shortfall was conserved for the life of the
        //    market. There is no shortfall to conserve now.
        BondingCurve c = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(vm.getBlockNumber() + 1);
        quote.mint(CAROL, 5_000e6);
        vm.startPrank(CAROL);
        quote.approve(curveAddr, type(uint256).max);
        c.buyWithToken(1_000e6, 0, type(uint256).max);
        vm.stopPrank();
        assertEq(_booked(c), quote.balanceOf(curveAddr), "the unreachable market is insolvent");
    }

    // ------------------------------------------------------------------------------------
    // F8 — the registry, on its own terms.
    // ------------------------------------------------------------------------------------

    /// @dev `register` validates `decimals()` and nothing else: a token with a sender callback is
    ///      admitted without complaint. Confirmed, and it is a true statement about the code.
    function test_F8a_aCallbackTokenPassesRegistrationUnremarked() public {
        HookQuote another = new HookQuote();
        vm.prank(OWNER);
        registry.register(address(another), TARGET);
        assertTrue(registry.isEnabled(address(another)), "a hook token was refused");
        assertEq(registry.decimalsOf(address(another)), 6, "decimals is the only thing read");
    }

    /// @dev There is no path to registration that is not the owner, and `Ownable2Step` means a
    ///      pending owner is not an owner. The claim holds.
    function test_F8b_thereIsNoNonOwnerPathToRegistration() public {
        HookQuote another = new HookQuote();

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BOB));
        registry.register(address(another), TARGET);

        // A pending owner is still not the owner until it accepts.
        vm.prank(OWNER);
        registry.transferOwnership(BOB);
        assertEq(registry.pendingOwner(), BOB, "the two-step handover did not start");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, BOB));
        registry.register(address(another), TARGET);

        vm.prank(BOB);
        registry.acceptOwnership();
        vm.prank(BOB);
        registry.register(address(another), TARGET);
        assertTrue(registry.isEnabled(address(another)), "the accepted owner could not register");
    }

    /// @dev And the factory cannot be pointed at a different registry: it is `immutable`
    ///      (`src/DokuFactory.sol:99`), so gen-3 lives with the registry it was born with.
    function test_F8c_theFactorysRegistryCannotBeMoved() public view {
        assertEq(address(factory.registry()), address(registry), "fixture wrong");
        // There is no setter. Asserted structurally: the selector does not exist on the factory.
        (bool ok,) = address(factory).staticcall(abi.encodeWithSignature("setRegistry(address)"));
        assertFalse(ok, "the factory grew a registry setter");
    }
}

// =============================================================================================
//                    F2 / F3 / F4 / F5 — the ZapRouter, against a real pool
// =============================================================================================

contract PoolQuoteT is ERC20 {
    constructor() ERC20("Pool Quote", "PQ") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev A holder with no payable `receive()` and no `fallback()`.
contract DeafHolder {
    function approveRouter(address token_, address router, uint256 amount) external {
        IERC20(token_).approve(router, amount);
    }

    function zapSell(
        ZapRouter router,
        address curve,
        PathKey[] calldata path,
        uint256 baseIn,
        uint256 deadline
    ) external returns (uint256) {
        return router.zapSellToNative(curve, path, baseIn, 0, 0, deadline);
    }

    function zapBuy(ZapRouter router, address curve, PathKey[] calldata path, uint256 value, uint256 deadline)
        external
        returns (uint256)
    {
        return router.zapBuyWithNative{value: value}(curve, path, 0, 0, deadline);
    }

    function directSell(BondingCurve c, address token_, uint256 baseIn) external returns (uint256) {
        IERC20(token_).approve(address(c), baseIn);
        return c.sell(baseIn, 0, type(uint256).max);
    }
}

contract ZapTriageTest is Test {
    PoolManager internal manager;
    PoolModifyLiquidityTest internal lp;
    PoolQuoteT internal quote;
    BondingCurve internal curve;
    DokuToken internal base;
    MarketsStub internal markets;
    ZapRouter internal router;
    PoolKey internal deepKey;
    PoolKey internal thinKey;

    address internal constant OWNER = address(0xB0B);
    address internal constant SELLER = address(0xA11CE);
    address internal constant TREASURY = address(0x7EA);
    address internal constant GRADUATOR = address(0x6AD);
    address internal constant STRANGER = address(0xBAD);

    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    uint24 internal constant FEE = 500;
    int24 internal constant SPACING = 10;
    uint24 internal constant THIN_FEE = 3000;
    int24 internal constant THIN_SPACING = 60;
    int256 internal constant LIQUIDITY = 100_000e18;
    /// @dev Full-range but shallow: a big exact-input swap is CONSUMED (so no `HopUnfilled`) at a
    ///      ruinous price. That is what separates "how much MON came out" from "how much value
    ///      went through".
    int256 internal constant THIN_LIQUIDITY = 20e18;

    uint256 internal constant QUOTE_TARGET = 1_000e18;
    uint256 internal constant FIRST_BUY = 200e18;
    uint256 internal constant NEVER = type(uint256).max;

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));

        quote = new PoolQuoteT();
        quote.mint(address(this), 100_000_000e18);
        quote.approve(address(lp), type(uint256).max);

        deepKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(deepKey, SQRT_1_1);

        thinKey = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(quote)),
            fee: THIN_FEE,
            tickSpacing: THIN_SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(thinKey, SQRT_1_1);

        vm.deal(address(this), 2_000_000 ether);
        lp.modifyLiquidity{value: 500_000 ether}(
            deepKey,
            ModifyLiquidityParams({tickLower: -60_000, tickUpper: 60_000, liquidityDelta: LIQUIDITY, salt: 0}),
            ""
        );
        lp.modifyLiquidity{value: 100_000 ether}(
            thinKey,
            ModifyLiquidityParams({
                tickLower: -887_220,
                tickUpper: 887_220,
                liquidityDelta: THIN_LIQUIDITY,
                salt: 0
            }),
            ""
        );

        curve = BondingCurve(payable(Clones.clone(address(new BondingCurve()))));
        base = DokuToken(Clones.clone(address(new DokuToken())));
        base.initialize("Zap Triage", "ZTRI", address(curve), false, "https://cdn.doku.family/metadata/test.json");
        curve.initialize(
            address(base),
            address(quote),
            QUOTE_TARGET,
            Sinks.REWARDS,
            address(0),
            0,
            address(0),
            TREASURY,
            GRADUATOR,
            address(0)
        );

        markets = new MarketsStub();
        router = new ZapRouter(IPoolManager(address(manager)), DokuFactory(payable(address(markets))), OWNER, 0);

        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);

        quote.mint(SELLER, FIRST_BUY);
        vm.startPrank(SELLER);
        quote.approve(address(curve), type(uint256).max);
        curve.buyWithToken(FIRST_BUY, 0, NEVER);
        vm.stopPrank();
        assertGt(base.balanceOf(SELLER), 0, "fixture: the seller has nothing to sell");
    }

    // ------------------------------------------------------------------ helpers

    function _toNative(uint24 fee, int24 spacing) internal pure returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(0)),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _toQuote() internal view returns (PathKey[] memory p) {
        p = new PathKey[](1);
        p[0] = PathKey({
            intermediateCurrency: Currency.wrap(address(quote)),
            fee: FEE,
            tickSpacing: SPACING,
            hooks: IHooks(address(0)),
            hookData: ""
        });
    }

    function _half() internal view returns (uint256) {
        return base.balanceOf(SELLER) / 2;
    }

    function _sell(uint256 baseIn, uint256 minNativeOut, uint24 fee, int24 spacing)
        internal
        returns (uint256)
    {
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        uint256 outp =
            router.zapSellToNative(address(curve), _toNative(fee, spacing), baseIn, 0, minNativeOut, NEVER);
        vm.stopPrank();
        return outp;
    }

    function _measure(uint256 baseIn, uint24 fee, int24 spacing) internal returns (uint256 produced) {
        uint256 snap = vm.snapshotState();
        produced = _sell(baseIn, 0, fee, spacing);
        vm.revertToState(snap);
    }

    // ==================================================================================
    // F2 — "a seller with no payable receive() can buy but never sell"
    // ==================================================================================

    /**
     * The asymmetry is real. What is NOT real is "it can strand value".
     *
     * The router is periphery and custodies nothing across transactions: the refused sell unwinds
     * whole, and `BondingCurve.sell` is a permissionless entry point the deaf holder can call
     * itself for the QUOTE asset. So the loss is one route, not one wallet's money.
     */
    function test_F2a_theDeafSellerIsInconveniencedNotStranded() public {
        DeafHolder deaf = new DeafHolder();
        uint256 baseIn = _half();
        vm.prank(SELLER);
        base.transfer(address(deaf), baseIn);

        // It can BUY: the buy leaves no native behind, so `_sweepNative` never fires.
        vm.deal(address(deaf), 10 ether);
        uint256 bought = deaf.zapBuy(router, address(curve), _toQuote(), 5 ether, NEVER);
        assertGt(bought, 0, "the deaf contract could not even buy");

        // It cannot SELL through the router.
        deaf.approveRouter(address(base), address(router), baseIn);
        vm.expectRevert(ZapRouter.NativeRefundFailed.selector);
        deaf.zapSell(router, address(curve), _toNative(FEE, SPACING), baseIn, NEVER);

        // And nothing is stranded: the curve pays it directly, in the quote asset.
        uint256 got = deaf.directSell(curve, address(base), baseIn);
        assertGt(got, 0, "the direct path could not pay the deaf holder either");
        assertEq(quote.balanceOf(address(deaf)), got, "the deaf holder did not receive the quote");
        assertEq(address(router).balance, 0, "the router kept MON across the failure");
        assertEq(base.balanceOf(address(router)), 0, "the router kept tokens across the failure");
    }

    /**
     * Can a THIRD PARTY put someone in this state? No, and the reason is `receive()`'s gate plus
     * the fact that every payout goes to `msg.sender`.
     *
     * There is no `recipient` parameter, so nobody can zap ON BEHALF of a contract; and nobody can
     * push MON at the router to make a later sweep behave differently. The state is a property of
     * the caller's own bytecode, chosen before it ever met this router.
     */
    function test_F2b_noThirdPartyCanCreateOrWorsenTheDeafState() public {
        // Nobody may push MON at the router.
        vm.deal(STRANGER, 100 ether);
        vm.prank(STRANGER);
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertFalse(ok, "a stranger funded the router");

        // And there is no way to name someone else as the payee.
        assertFalse(
            _selectorExists(address(router), "zapSellToNative(address,(address,uint24,int24,address,bytes)[],uint256,uint256,uint256,uint256,address)"),
            "a recipient overload exists after all"
        );
        assertEq(address(router).balance, 0, "the router holds MON between calls");
    }

    function _selectorExists(address target, string memory sig) internal returns (bool) {
        (bool ok, bytes memory ret) = target.call(abi.encodeWithSignature(sig));
        // A missing function on this contract reverts with NO data at all: there is no fallback.
        return ok || ret.length != 0;
    }

    // ==================================================================================
    // F3 — "the sell's spend ceiling is bypassable"
    // ==================================================================================

    /**
     * FALSE as stated. `minNativeOut = 0` walks past the cheap refusal and lands on the expensive
     * one, and the expensive one BINDS: the sale still cannot complete above the ceiling.
     *
     * Asserted at both boundaries so a router that refused every sell once a ceiling was set would
     * fail this rather than pass it.
     */
    function test_F3a_aZeroFloorDoesNotGetPastTheCeiling() public {
        uint256 baseIn = _half();
        uint256 produced = _measure(baseIn, FEE, SPACING);
        assertGt(produced, 1, "fixture: the measurement is too small to put a ceiling under");

        vm.prank(OWNER);
        router.setMaxZapValue(produced - 1);

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, produced, produced - 1));
        // minNativeOut = 0: the claimed bypass, run exactly as claimed.
        router.zapSellToNative(address(curve), _toNative(FEE, SPACING), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // Nothing was left behind by the refusal, and nothing was sold.
        assertEq(address(router).balance, 0, "MON stuck on the router after the refusal");
        assertEq(quote.balanceOf(address(router)), 0, "quote stuck on the router after the refusal");
        assertEq(base.balanceOf(address(router)), 0, "base stuck on the router after the refusal");

        // The boundary the other way.
        vm.prank(OWNER);
        router.setMaxZapValue(produced);
        assertEq(_sell(baseIn, 0, FEE, SPACING), produced, "a sale AT the ceiling was refused");
    }

    /**
     * The real gap, and it is the opposite of the claim: the ceiling measures the MON that came
     * OUT, never the value that went THROUGH.
     *
     * Same tokens, same curve, two routes. Through the deep pool the sale produces `deep` MON and
     * the ceiling refuses it. Through the shallow pool the SAME sale produces far less MON, passes
     * the ceiling, and the router still took custody of the same `baseIn` and the same quote leg on
     * the way. A bound whose whole job is "limit what a new contract can lose" is being satisfied by
     * a WORSE trade.
     */
    function test_F3b_theCeilingBoundsTheProceedsNotTheExposure() public {
        uint256 baseIn = _half();
        uint256 deep = _measure(baseIn, FEE, SPACING);
        uint256 thin = _measure(baseIn, THIN_FEE, THIN_SPACING);
        emit log_named_uint("MON out, deep route", deep);
        emit log_named_uint("MON out, thin route", thin);
        assertLt(thin, deep, "fixture: the shallow route is not actually worse");

        // A ceiling that refuses the GOOD trade.
        vm.prank(OWNER);
        router.setMaxZapValue(thin + (deep - thin) / 2);

        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert();
        router.zapSellToNative(address(curve), _toNative(FEE, SPACING), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // The same size, through a worse pool, is waved through.
        uint256 got = _sell(baseIn, 0, THIN_FEE, THIN_SPACING);
        assertEq(got, thin, "the shallow route did not produce what was measured");
        assertGt(deep, router.maxZapValue(), "fixture: the good route was not above the ceiling");
    }

    /**
     * AND THE CEILING NOW BOUNDS WHAT IS PAID OUT, not merely what was TAKEN from the pool.
     *
     * v2 checked the ceiling against the `take` while `_sweepNative` sent `address(this).balance`,
     * so any MON already on the router walked out unweighed. This test was informational when it
     * was written — nobody else's money moved — but it was the third way the sell's ceiling meant
     * less than the buy's, and the adversarial pass found a caller-controlled way to open the gap
     * on purpose. v3 weighs the sweep's own return value, and this asserts it in the two shapes
     * that reach the balance.
     *
     * FIRST: the PoolManager's push, which is what the prank stands in for. It is refused now —
     * `receive()` wants the ROUTER'S OWN unlock open, and a push arranged by anyone else runs
     * inside somebody else's or inside none at all.
     *
     * SECOND: a forced credit, which no `receive()` can refuse because `selfdestruct` and a block
     * reward never call anything. That is the case the ceiling has to catch, and does.
     */
    function test_F3c_theCeilingBoundsThePayoutAndNotJustTheTake() public {
        uint256 baseIn = _half();
        uint256 produced = _measure(baseIn, FEE, SPACING);

        vm.prank(OWNER);
        router.setMaxZapValue(produced);

        uint256 pushed = 3 ether;
        // ADD to its balance. `vm.deal` is absolute, and the PoolManager's balance IS the native
        // side of every pool in this fixture.
        vm.deal(address(manager), address(manager).balance + pushed);
        vm.prank(address(manager));
        (bool ok,) = address(router).call{value: pushed}("");
        assertFalse(ok, "the gate still takes a PoolManager push outside the router's own unlock");
        assertEq(address(router).balance, 0, "and nothing stuck to the router");

        // Forced past the gate entirely. The sale itself is legal — `produced` is exactly the
        // ceiling — and it is the PAYOUT that is over, which is the number v2 never looked at.
        vm.deal(address(router), pushed);
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, produced + pushed, produced)
        );
        router.zapSellToNative(address(curve), _toNative(FEE, SPACING), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        // The refusal unwound everything, seller included.
        assertEq(address(router).balance, pushed, "the revert did not unwind the sweep");
        assertEq(SELLER.balance, 0, "the seller was paid by a call that reverted");
    }

    // ==================================================================================
    // F4 — the base sweep added to the buy today
    // ==================================================================================

    /// @dev The fix does what it says: a market token donated to the router before a buy reaches
    ///      the buyer rather than staying there forever.
    function test_F4a_aDonatedBaseTokenIsSweptToTheBuyer() public {
        uint256 donation = 1_234e18;
        vm.prank(SELLER);
        base.transfer(address(router), donation);
        assertEq(base.balanceOf(address(router)), donation, "fixture: the donation did not land");

        uint256 before = base.balanceOf(SELLER);
        vm.deal(SELLER, 10 ether);
        vm.prank(SELLER);
        uint256 reported = router.zapBuyWithNative{value: 5 ether}(address(curve), _toQuote(), 0, 0, NEVER);

        uint256 received = base.balanceOf(SELLER) - before;
        assertEq(received, reported + donation, "the donation was not swept with the purchase");
        assertEq(base.balanceOf(address(router)), 0, "base left on the router after a buy");
        assertEq(quote.balanceOf(address(router)), 0, "quote left on the router after a buy");
        assertEq(address(router).balance, 0, "MON left on the router after a buy");
    }

    /**
     * What the fix INTRODUCED, and it is the only thing it introduced: the function's return value
     * and the amount it transfers are no longer the same number.
     *
     * `baseOut` is still the curve's delta — which is right, because `minBaseOut` must be checked
     * against what the CURVE produced and not against what a stranger left lying around. But an
     * integrating contract that reads the return value to decide how many tokens it now holds will
     * under-count. Worth a docblock line; not worth a severity.
     */
    function test_F4b_theReturnValueNoLongerEqualsWhatIsTransferred() public {
        uint256 donation = 7e18;
        vm.prank(SELLER);
        base.transfer(address(router), donation);

        uint256 before = base.balanceOf(SELLER);
        vm.deal(SELLER, 10 ether);
        vm.prank(SELLER);
        uint256 reported = router.zapBuyWithNative{value: 1 ether}(address(curve), _toQuote(), 0, 0, NEVER);
        assertEq(base.balanceOf(SELLER) - before - reported, donation, "the gap is not the donation");
    }

    /// @dev And `minBaseOut` is still measured against the curve's own delta, so a donation cannot
    ///      be used to satisfy somebody's slippage bound. This is the way the fix could have gone
    ///      wrong and did not.
    function test_F4c_aDonationCannotSatisfyMinBaseOut() public {
        vm.deal(SELLER, 10 ether);
        // What one ether actually buys, measured.
        uint256 snap = vm.snapshotState();
        vm.prank(SELLER);
        uint256 honest = router.zapBuyWithNative{value: 1 ether}(address(curve), _toQuote(), 0, 0, NEVER);
        vm.revertToState(snap);

        // Donate far more than the shortfall and ask for more than the curve will give.
        vm.prank(SELLER);
        base.transfer(address(router), honest * 10);

        vm.deal(SELLER, 10 ether);
        vm.prank(SELLER);
        vm.expectRevert();
        router.zapBuyWithNative{value: 1 ether}(address(curve), _toQuote(), 0, honest * 2, NEVER);
    }

    /// @dev The sell direction already swept all three assets; asserted here so "complete" is a
    ///      measurement rather than a reading.
    function test_F4d_theSellSweepsAllThreeAssetsToo() public {
        uint256 baseIn = _half();
        vm.prank(SELLER);
        base.transfer(address(router), 11e18);
        quote.mint(address(router), 13e18);

        uint256 monBefore = SELLER.balance;
        uint256 baseBefore = base.balanceOf(SELLER);
        uint256 quoteBefore = quote.balanceOf(SELLER);
        uint256 produced = _sell(baseIn, 0, FEE, SPACING);

        assertEq(SELLER.balance - monBefore, produced, "the MON payout moved");
        assertEq(
            baseBefore - base.balanceOf(SELLER), baseIn - 11e18, "the donated base was not returned"
        );
        assertEq(quote.balanceOf(SELLER) - quoteBefore, 13e18, "the donated quote was not returned");
        assertEq(base.balanceOf(address(router)), 0, "base left behind");
        assertEq(quote.balanceOf(address(router)), 0, "quote left behind");
        assertEq(address(router).balance, 0, "MON left behind");
    }

    // ==================================================================================
    // F5 — the split error
    // ==================================================================================

    /// @dev Two distinct selectors, each fired from its own site, each carrying its own number.
    ///      A single error would have made the declared floor indistinguishable from the produced
    ///      amount to every off-chain decoder.
    function test_F5_theFloorAndTheProceedsRevertWithDifferentErrors() public {
        uint256 baseIn = _half();
        uint256 produced = _measure(baseIn, FEE, SPACING);

        vm.prank(OWNER);
        router.setMaxZapValue(produced - 1);

        // The DECLARED floor, refused before anything external is touched.
        vm.startPrank(SELLER);
        base.approve(address(router), baseIn);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellFloorTooLarge.selector, produced, produced - 1)
        );
        router.zapSellToNative(address(curve), _toNative(FEE, SPACING), baseIn, 0, produced, NEVER);

        // The PRODUCED amount, refused after the whole flow.
        vm.expectRevert(abi.encodeWithSelector(ZapRouter.SellTooLarge.selector, produced, produced - 1));
        router.zapSellToNative(address(curve), _toNative(FEE, SPACING), baseIn, 0, 0, NEVER);
        vm.stopPrank();

        assertTrue(
            ZapRouter.SellFloorTooLarge.selector != ZapRouter.SellTooLarge.selector,
            "the two errors share a selector"
        );
    }

    /// @dev The cheap refusal really is cheap: it fires before the factory, the curve or a pool is
    ///      reached. Proven by denying the curve — a router that got as far as `isMarket` would
    ///      revert `UnknownMarket` instead.
    function test_F5b_theFloorRefusalPrecedesEveryExternalCall() public {
        markets.deny(address(curve));
        vm.prank(OWNER);
        router.setMaxZapValue(1 ether);

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(ZapRouter.SellFloorTooLarge.selector, 2 ether, 1 ether)
        );
        router.zapSellToNative(address(curve), _toNative(FEE, SPACING), 1e18, 0, 2 ether, NEVER);
    }
}
