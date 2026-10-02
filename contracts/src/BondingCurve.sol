pragma solidity 0.8.26;

import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {IERC20Permit} from "openzeppelin/token/ERC20/extensions/IERC20Permit.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {CurveMath} from "./lib/CurveMath.sol";
import {TaxMath} from "./lib/TaxMath.sol";
import {Sinks} from "./lib/Sinks.sol";

/// @dev Outbound calls the curve makes. Minimal, so the curve never imports the graduation contract.
interface IGraduator {
    function graduate(address curve) external returns (bytes32 poolId, uint256 tokenId);
    /// @dev A REWARDS market's curve-phase escrow, to the hook's ledger. Native: value carries it;
    ///      ERC-20: the curve approves `amount` and the graduator pulls it.
    function creditCurveTax(address curve) external payable;
    function creditCurveTax(address curve, uint256 amount) external;
    function sinkOf(address curve) external view returns (address);
}

/// @dev Deferred-payment fallback for a CREATOR market's routed share and every creator tax.
interface ICreatorSink {
    function credit(address who, address quote, uint256 amount) external payable;
}

import {ERC20Burnable} from "openzeppelin/token/ERC20/extensions/ERC20Burnable.sol";

// Smallest working quote target: the smallest multiple of five, the only shape a target may take.
// File-level so `DokuFactory` and `QuoteRegistry` enforce the same bound without a call.
uint256 constant DOKU_MIN_QUOTE_TARGET = 5;

// Ceiling on a quote target; the registry and the curve both read it.
uint256 constant DOKU_MAX_QUOTE_TARGET = 1e30;

// Token side of every graduation seed: TOTAL_SUPPLY - CURVE_SUPPLY. `DokuGraduation` reverts
// `SeedOutOfRange` against it.
uint256 constant DOKU_SEED_BASE = 222_222_222e18;

/// @title BondingCurve
/// @notice The only venue a market trades on before it graduates: constant-product pricing over
///         virtual reserves, closing permanently once `quoteTarget` has been raised.
/// @dev Virtual reserves run from (BASE_VIRTUAL_CEILING, 0.4 * target) to (BASE_VIRTUAL_FLOOR,
///      1.4 * target), so each span equals what changes hands: CURVE_SUPPLY sold, `quoteTarget` raised.
contract BondingCurve is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // 1e18-scaled. Ceiling = 7/5 x CURVE_SUPPLY, floor = 2/5 x; open-to-graduation multiple 12.25.
    uint128 public constant BASE_VIRTUAL_CEILING = 1_088_888_889_200_000_000_000_000_000;
    uint128 public constant BASE_VIRTUAL_FLOOR = 311_111_111_200_000_000_000_000_000;
    /// @notice Tokens sold across the whole curve. The remainder seeds the pool at graduation.
    uint256 public constant CURVE_SUPPLY = 777_777_778e18;
    /// @notice The one fee every swap pays, in bps of the quote leg. Split below.
    uint16 public constant FEE_BPS = 100; // 1%
    /// @notice The protocol's share of `FEE_BPS`, to the treasury.
    uint16 public constant PROTOCOL_BPS = 30;
    /// @notice The creator's share of `FEE_BPS`, routed to the sink chosen at launch. Never optional.
    uint16 public constant ROUTED_BPS = 70;

    /// @notice Upper bound on the optional creator tax, on top of the fee.
    uint16 public constant MAX_CREATOR_TAX_BPS = 1000;

    /// @notice Gas a filling buy needs to also graduate the market. See `autoGraduationGasHint`.
    uint256 public constant AUTO_GRADUATION_GAS = 2_500_000;

    /// @notice Default, and ceiling, for a market's anti-sniper start rate in bps.
    uint16 public constant TAX_START_BPS = 5000; // 50%
    /// @notice Default anti-sniper decay window, in seconds.
    uint32 public constant TAX_WINDOW = 300; // 5 minutes
    /// @notice Longest window a launch may be given.
    uint32 public constant MAX_TAX_WINDOW = 3600;
    /// @notice Upper bound on `quoteTarget`. Reserves pack as uint128 and the quote ceiling is 1.4x the target.
    uint256 public constant MAX_QUOTE_TARGET = DOKU_MAX_QUOTE_TARGET;

    /// @notice Smallest target with a non-zero, EXACT virtual quote floor (`target * 2 / 5`).
    uint256 public constant MIN_QUOTE_TARGET = DOKU_MIN_QUOTE_TARGET;

    error AlreadyInitialised();
    error CurveClosed();
    error Expired();
    error InsufficientOutput();
    /// @dev A trade priced down to nothing; zero satisfies any `minQuoteOut`, so slippage cannot guard it.
    error ZeroOutput();
    /// @dev A REWARDS market's escrow has nowhere to go until the market has a pool and a vault.
    error NotGraduated();
    error TransferFailed();
    error ZeroAmount();
    error ZeroAddress();
    error TargetTooLarge();
    /// @dev A supply that cannot cover the curve plus the graduation seed.
    error SupplyTooSmall(uint256 supply, uint256 curveSupply);
    error TargetTooSmall(uint256 target, uint256 minimum);
    /// @dev The quote floor is `target * 2 / 5`; unless five divides the target it truncates, the seed
    ///      lands below `DOKU_SEED_BASE`, and a filled market can never graduate.
    error TargetNotDivisibleByFive(uint256 target);
    error NotReady();
    error NotGraduator();
    /// @dev `buyFor` from anyone but the factory that initialised this curve.
    error NotFactory();
    /// @dev `buyFor` value must be the whole `quoteIn` on a native market and zero on an ERC-20 one.
    error ValueMismatch(uint256 sent, uint256 required);
    error AlreadyReleased();
    error InvalidSink();

    /// @dev A routed recipient on a non-CREATOR sink, none on a CREATOR sink, or a creator tax with nobody to pay.
    error InvalidRecipient();
    error TaxTooHigh();

    /// @dev The wrong entry point for the market's quote asset.
    error QuoteIsNative();
    error QuoteIsNotNative();
    /// @dev Start rate above `TAX_START_BPS`, window above `MAX_TAX_WINDOW`, or an unknown mode.
    error TaxTermsOutOfRange();

    /// @dev Carries every levy and `quoteRaised` so an indexer needs no call. `quoteIn` is the priced leg:
    ///      gross = quoteIn + fee + antiSniperTax + creatorTax + refund (+ the routed share a BURN market
    ///      spent on the curve). `price` is the post-trade spot, see `_price`.
    event Bought(
        address indexed buyer,
        uint256 quoteIn,
        uint256 baseOut,
        uint256 fee,
        uint256 antiSniperTax,
        uint256 creatorTax,
        uint256 quoteRaised,
        uint256 price
    );
    event Sold(
        address indexed seller,
        uint256 baseIn,
        uint256 quoteOut,
        uint256 fee,
        uint256 creatorTax,
        uint256 quoteRaised,
        uint256 price
    );
    event FeesCollected(address indexed recipient, uint256 amount);
    event TaxCollected(address indexed recipient, uint256 amount);
    event ReadyToGraduate(uint256 quoteRaised);
    event TaxBurned(uint256 quoteSpent, uint256 baseBurned);
    event AutoGraduationFailed(uint256 gasLeft);
    event ProtocolFeesCollected(address indexed recipient, uint256 amount);
    event Released(address indexed to, uint256 quoteAmount, uint256 baseAmount);

    /// @dev Every number a buy needs, computed once by `_levy` for both the quote view and the fill.
    struct Levy {
        uint256 rate; // anti-sniper rate applied, in bps
        uint256 fee; // protocol + routed
        uint256 protocol;
        uint256 routed;
        uint256 creatorTax;
        uint256 curveAmount; // what reaches the curve, counted in `quoteRaised`
        uint256 antiSniper; // spent on this curve and burned, inside `curveAmount`
        uint256 burnSpend; // antiSniper, plus the routed share on a BURN market
        uint256 quoteIn; // the buyer's own priced leg
        uint256 refund;
    }

    struct Reserves {
        uint128 base;
        uint128 quote;
    }

    IERC20 public token;
    /// @notice The asset this market is priced in. `address(0)` is native MON.
    address public quoteAsset;
    /// @notice Quote needed to fill the curve, in raw units. Snapshotted at launch.
    uint256 public quoteTarget;
    /// @notice Real quote taken from traders and held for the pool.
    uint256 public quoteRaised;
    /// @notice Set once the target is hit. Trading stops here and moves to the pool.
    bool public readyToGraduate;
    /// @notice Recipient of the protocol share. Fixed at initialisation; there is no setter.
    address public protocolRecipient;
    /// @notice Routed share earned but not collected: claimable on CREATOR, escrowed until graduation
    ///         on REWARDS, always zero on BURN (spent on the curve as it accrues).
    uint256 public pendingFees;
    /// @notice The protocol's share, earned but not yet collected.
    uint256 public pendingProtocol;
    /// @notice The creator tax, earned but not yet collected.
    uint256 public pendingTax;

    /// @notice Every unit of quote booked to somebody: the raise plus the three fee buckets.
    /// @dev Solvency identity, `==` at every step: `quoteBooked() == balance` (ERC-20 or native).
    function quoteBooked() public view returns (uint256) {
        return quoteRaised + pendingProtocol + pendingFees + pendingTax;
    }
    /// @notice Cumulative anti-sniper tax, in quote. Spent on the curve as it accrued, never held.
    uint256 public taxEscrow;
    /// @notice When trading opened. The buy tax decays from here.
    uint64 public launchedAt;
    /// @notice Decay axis of the anti-sniper tax, snapshotted at `initialize` from the factory's
    ///         terms. No setter; a market keeps the terms it launched under.
    TaxMath.Mode public taxMode;
    /// @notice The only address allowed to move this curve's holdings into a pool.
    address public graduator;
    /// @notice Set once `release` has run, so a curve can only ever be drained once.
    bool public released;

    /// @notice Total supply at launch, latched once at `initialize`.
    /// @dev The seed is computed from it, so no later burn by anyone can move the seed.
    uint256 public launchSupply;

    /// @notice The token side of the graduation seed, latched when the curve filled.
    uint256 public seedBase;

    /// @notice Cumulative tokens destroyed by buys: the anti-sniper tax and, on BURN, the routed share.
    uint256 public burnedByTax;

    /// @notice The block the curve filled. The reward vault's grid anchor; no weight is read at it.
    uint64 public readyAtBlock;

    /// @notice Where this market's share of the levy goes. Chosen at launch, immutable.
    /// @dev Read by `DokuGraduation`, never passed to it: graduation is permissionless.
    uint8 public sink;

    /// @notice The wallet a CREATOR market routes to. Zero on every other sink.
    address public routedRecipient;
    /// @notice The creator tax, in bps of the quote leg of every buy and sell.
    uint16 public creatorTaxBps;
    /// @notice Who the creator tax is paid to. Fixed forever.
    address public taxRecipient;
    /// @notice The shared `CreatorSink` that holds a payment a recipient could not receive.
    address public creatorSink;
    /// @notice The address that initialised this curve; the only caller of `buyFor`.
    address public factory;
    /// @notice This market's anti-sniper start rate in bps, fixed at launch.
    uint16 public taxStartBps;
    /// @notice Seconds over which this market's anti-sniper tax decays to zero, fixed at launch.
    uint32 public taxWindow;

    Reserves internal _reserves;
    bool private _initialised;

    /// @dev The implementation initialises itself so it can never be claimed.
    constructor() {
        _initialised = true;
    }

    /// @notice Initialise with the default anti-sniper terms (`TAX_START_BPS`, `TAX_WINDOW`, clock decay).
    function initialize(
        address token_,
        address quoteAsset_,
        uint256 quoteTarget_,
        uint8 sink_,
        address routedRecipient_,
        uint16 creatorTaxBps_,
        address taxRecipient_,
        address protocolRecipient_,
        address graduator_,
        address creatorSink_
    ) external {
        _initialize(
            token_, quoteAsset_, quoteTarget_, sink_, routedRecipient_, creatorTaxBps_, taxRecipient_,
            protocolRecipient_, graduator_, creatorSink_, TAX_START_BPS, TAX_WINDOW, uint8(TaxMath.Mode.CLOCK)
        );
    }

    /// @notice Initialise with the anti-sniper terms the factory holds at launch.
    /// @param taxStartBps_ Start rate, at most `TAX_START_BPS`.
    /// @param taxWindow_ Decay window in seconds, at most `MAX_TAX_WINDOW`. Zero switches the CLOCK term
    ///        off: no tax under mode 0, and mode 2 then decays with progress alone. Mode 1 ignores it.
    /// @param taxMode_ A `TaxMath.Mode`: 0 clock, 1 progress, 2 the larger of the two.
    function initialize(
        address token_,
        address quoteAsset_,
        uint256 quoteTarget_,
        uint8 sink_,
        address routedRecipient_,
        uint16 creatorTaxBps_,
        address taxRecipient_,
        address protocolRecipient_,
        address graduator_,
        address creatorSink_,
        uint16 taxStartBps_,
        uint32 taxWindow_,
        uint8 taxMode_
    ) external {
        _initialize(
            token_, quoteAsset_, quoteTarget_, sink_, routedRecipient_, creatorTaxBps_, taxRecipient_,
            protocolRecipient_, graduator_, creatorSink_, taxStartBps_, taxWindow_, taxMode_
        );
    }

    function _initialize(
        address token_,
        address quoteAsset_,
        uint256 quoteTarget_,
        uint8 sink_,
        address routedRecipient_,
        uint16 creatorTaxBps_,
        address taxRecipient_,
        address protocolRecipient_,
        address graduator_,
        address creatorSink_,
        uint16 taxStartBps_,
        uint32 taxWindow_,
        uint8 taxMode_
    ) private {
        if (_initialised) revert AlreadyInitialised();
        if (taxStartBps_ > TAX_START_BPS || taxWindow_ > MAX_TAX_WINDOW || taxMode_ > uint8(TaxMath.Mode.MAX)) {
            revert TaxTermsOutOfRange();
        }
        if (token_ == address(0) || protocolRecipient_ == address(0) || graduator_ == address(0)) {
            revert ZeroAddress();
        }
        if (quoteTarget_ > MAX_QUOTE_TARGET) revert TargetTooLarge();
        if (!Sinks.isValid(sink_)) revert InvalidSink();
        // A routed recipient only on CREATOR: "who is paid" is a function of `sink` alone.
        if ((sink_ == Sinks.CREATOR) != (routedRecipient_ != address(0))) revert InvalidRecipient();
        if (creatorTaxBps_ > MAX_CREATOR_TAX_BPS) revert TaxTooHigh();
        if (creatorTaxBps_ != 0 && taxRecipient_ == address(0)) revert InvalidRecipient();
        _initialised = true;
        factory = msg.sender;
        sink = sink_;
        token = IERC20(token_);
        // Latched now: the seed is computed against it and no later burn can move it.
        launchSupply = IERC20(token_).totalSupply();
        if (launchSupply <= CURVE_SUPPLY) revert SupplyTooSmall(launchSupply, CURVE_SUPPLY);
        quoteAsset = quoteAsset_;
        quoteTarget = quoteTarget_;
        routedRecipient = routedRecipient_;
        creatorTaxBps = creatorTaxBps_;
        taxRecipient = taxRecipient_;
        protocolRecipient = protocolRecipient_;
        graduator = graduator_;
        creatorSink = creatorSink_;
        launchedAt = uint64(block.timestamp);
        taxMode = TaxMath.Mode(taxMode_);
        taxStartBps = taxStartBps_;
        taxWindow = taxWindow_;
        // Floor = 2/5 of the target and must be EXACT, or a filled market cannot graduate.
        if (quoteTarget_ < MIN_QUOTE_TARGET) revert TargetTooSmall(quoteTarget_, MIN_QUOTE_TARGET);
        if (quoteTarget_ % 5 != 0) revert TargetNotDivisibleByFive(quoteTarget_);
        uint128 quoteFloor = uint128((quoteTarget_ * 2) / 5);

        _reserves = Reserves({base: BASE_VIRTUAL_CEILING, quote: quoteFloor});
    }

    function reserves() external view returns (uint128 base, uint128 quote) {
        return (_reserves.base, _reserves.quote);
    }

    /// @notice Quote the curve still needs before it fills.
    function remaining() public view returns (uint256) {
        return readyToGraduate ? 0 : quoteTarget - quoteRaised;
    }

    /// @notice Gas a buy must be sent with when it is expected to fill this curve.
    /// @dev `eth_estimateGas` cannot see the inner graduation call failing (it is swallowed), so a
    ///      wallet's estimate starves it by EIP-150's 1/64. Monad bills the limit, hence a hint
    ///      for filling buys only.
    function autoGraduationGasHint() external pure returns (uint256) {
        return AUTO_GRADUATION_GAS;
    }

    /// @notice Fraction of the quote target raised so far, scaled to 1e18.
    function progress() public view returns (uint256) {
        return (quoteRaised * 1e18) / quoteTarget;
    }

    /// @notice The buy tax that applies right now, in bps. Zero once the curve is closed.
    function taxRate() public view returns (uint16) {
        if (readyToGraduate) return 0;
        return TaxMath.rate(taxMode, taxStartBps, taxWindow, block.timestamp - launchedAt, progress());
    }

    /// @notice Where the routed share is paid: a CREATOR market's wallet, otherwise the sink
    ///         contract, which is zero until graduation.
    function feeRecipient() public view returns (address) {
        if (sink == Sinks.CREATOR) return routedRecipient;
        return _sinkAddress();
    }

    /// @notice What a buy of `quoteIn` raw quote would return right now.
    /// @dev The same arithmetic as `buy` (`_levy` + `_simulate`), not a mirror of it.
    /// @return baseOut tokens the buyer would receive
    /// @return fee the 1% fee, protocol and routed shares together
    /// @return antiSniperTax quote spent buying the token back to burn
    /// @return creatorTax the creator's tax, if the market has one
    /// @return refund quote returned because the curve needed less than was sent
    function quoteBuy(uint256 quoteIn)
        external
        view
        returns (uint256 baseOut, uint256 fee, uint256 antiSniperTax, uint256 creatorTax, uint256 refund)
    {
        if (readyToGraduate || quoteIn == 0) return (0, 0, 0, 0, quoteIn);
        Levy memory v = _levy(quoteIn, taxRate());
        (,, baseOut) = _simulate(v);
        return (baseOut, v.fee, v.antiSniper, v.creatorTax, v.refund);
    }

    /// @notice What a sell of `baseIn` tokens would return right now.
    /// @return quoteOut raw quote the seller would receive, net of fee and creator tax
    /// @return fee the 1% fee taken from the gross
    /// @return creatorTax the creator's tax taken from the gross
    function quoteSell(uint256 baseIn)
        external
        view
        returns (uint256 quoteOut, uint256 fee, uint256 creatorTax)
    {
        if (readyToGraduate || baseIn == 0) return (0, 0, 0);
        Reserves memory r = _reserves;
        uint256 gross = CurveMath.quoteOut(r.base, r.quote, baseIn);
        Levy memory v;
        _split(v, gross);
        return (gross - v.fee - v.creatorTax, v.fee, v.creatorTax);
    }

    /// @notice Buy tokens with native MON. Only on a market whose quote is native.
    /// @dev Any MON beyond what the curve still needs is refunded, never absorbed.
    function buy(uint256 minBaseOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 baseOut)
    {
        if (quoteAsset != address(0)) revert QuoteIsNotNative();
        return _buy(msg.sender, msg.value, minBaseOut, deadline, taxRate());
    }

    /// @notice Buy tokens with the market's ERC-20 quote. Needs a prior `approve` to this curve.
    function buyWithToken(uint256 quoteIn, uint256 minBaseOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 baseOut)
    {
        return _pullAndBuy(quoteIn, minBaseOut, deadline);
    }

    /// @notice `buyWithToken` with an EIP-2612 permit in the same transaction.
    /// @dev The permit's failure is swallowed: a front-run permit already set the allowance, and
    ///      reverting here would turn that free grief into a denial of service.
    function buyWithPermit(
        uint256 quoteIn,
        uint256 minBaseOut,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 baseOut) {
        if (quoteAsset == address(0)) revert QuoteIsNative();
        try IERC20Permit(quoteAsset).permit(msg.sender, address(this), quoteIn, deadline, v, r, s) {}
            catch {}
        return _pullAndBuy(quoteIn, minBaseOut, deadline);
    }

    /// @notice The launch transaction's own buy, for the creator. Factory only.
    /// @dev The anti-sniper rate is forced to zero here and nowhere else: nothing can front-run the
    ///      launch transaction. Fee and creator tax apply as on any buy. For an ERC-20 quote the
    ///      factory has already moved `quoteIn` here.
    function buyFor(address recipient, uint256 quoteIn, uint256 minBaseOut, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 baseOut)
    {
        if (msg.sender != factory) revert NotFactory();
        if (recipient == address(0)) revert ZeroAddress();
        uint256 expected = quoteAsset == address(0) ? quoteIn : 0;
        if (msg.value != expected) revert ValueMismatch(msg.value, expected);
        return _buy(recipient, quoteIn, minBaseOut, deadline, 0);
    }

    /// @dev The one inbound ERC-20 leg. Priced on what ARRIVED, so a fee-on-transfer quote cannot
    ///      put the accounting ahead of the balance.
    function _pullAndBuy(uint256 quoteIn, uint256 minBaseOut, uint256 deadline)
        private
        returns (uint256)
    {
        if (quoteAsset == address(0)) revert QuoteIsNative();
        if (quoteIn == 0) revert ZeroAmount();
        IERC20 q = IERC20(quoteAsset);
        uint256 held = q.balanceOf(address(this));
        q.safeTransferFrom(msg.sender, address(this), quoteIn);
        return _buy(
            msg.sender, q.balanceOf(address(this)) - held, minBaseOut, deadline, taxRate()
        );
    }

    /// @dev The one buy path. `gross` is already held. `rate` is passed in because `buyFor` charges none.
    function _buy(address buyer, uint256 gross, uint256 minBaseOut, uint256 deadline, uint256 rate)
        private
        returns (uint256 baseOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (readyToGraduate) revert CurveClosed();
        if (gross == 0) revert ZeroAmount();

        // Four levies, each in a fixed currency so no sink ever has to sell: protocol share and creator
        // tax in quote; routed share in the sink's currency (quote on REWARDS/CREATOR, token on BURN);
        // anti-sniper tax in the token, bought here and burned.
        Levy memory v = _levy(gross, rate);
        (Reserves memory r, uint256 burned, uint256 out) = _simulate(v);
        if (out < minBaseOut) revert InsufficientOutput();
        baseOut = out;

        // Effects before interactions.
        _reserves = Reserves({base: r.base - uint128(baseOut), quote: r.quote + uint128(v.quoteIn)});
        quoteRaised += v.curveAmount;
        if (quoteRaised >= quoteTarget) _latchFill();
        _accrue(v, burned);

        emit Bought(buyer, v.quoteIn, baseOut, v.fee, v.antiSniper, v.creatorTax, quoteRaised, _price());
        if (burned != 0) {
            ERC20Burnable(address(token)).burn(burned);
            emit TaxBurned(v.burnSpend, burned);
        }
        token.safeTransfer(buyer, baseOut);
        _tryAutoGraduate();
        if (v.refund != 0) _payQuote(buyer, v.refund);
    }

    /// @dev Every number a buy of `gross` needs at anti-sniper rate `rate`. Shared by `quoteBuy` and `_buy`.
    function _levy(uint256 gross, uint256 rate) private view returns (Levy memory v) {
        v.rate = rate;
        uint256 left = quoteTarget - quoteRaised;
        _split(v, gross);

        if (v.curveAmount > left) {
            // Recompute FORWARD from the smallest gross whose curve leg covers `left`; never subtract
            // a derived quantity, so an underflow is unrepresentable.
            uint256 heldBps = _heldBps();
            uint256 grossNeeded = (left * 10_000 + (10_000 - heldBps) - 1) / (10_000 - heldBps);
            if (grossNeeded > gross) grossNeeded = gross;
            _split(v, grossNeeded);
            v.refund = gross - grossNeeded;
            // Each levy floors, so the curve leg can land a wei above `left`; the surplus is refunded.
            if (v.curveAmount > left) {
                v.refund += v.curveAmount - left;
                v.curveAmount = left;
            }
        }

        // Inside what reaches the curve: the anti-sniper tax buys and burns; on BURN the routed share too.
        v.antiSniper = (v.curveAmount * rate) / 10_000;
        v.burnSpend = v.antiSniper + (sink == Sinks.BURN ? v.routed : 0);
        v.quoteIn = v.curveAmount - v.burnSpend;
    }

    /// @dev The fee, its split, the creator tax, and what is left for the curve. A BURN market's
    ///      routed share reaches the curve (spent there) and so counts toward the raise.
    function _split(Levy memory v, uint256 gross) private view {
        v.fee = (gross * FEE_BPS) / 10_000;
        v.protocol = (gross * PROTOCOL_BPS) / 10_000;
        v.routed = v.fee - v.protocol;
        v.creatorTax = (gross * creatorTaxBps) / 10_000;
        v.curveAmount = gross - v.protocol - v.creatorTax - (sink == Sinks.BURN ? 0 : v.routed);
    }

    /// @dev The share of a gross that never reaches the curve, in bps.
    function _heldBps() private view returns (uint256) {
        return uint256(PROTOCOL_BPS) + creatorTaxBps + (sink == Sinks.BURN ? 0 : ROUTED_BPS);
    }

    /// @dev The two curve trades of a buy, against a copy of the reserves. The burn buys FIRST, at
    ///      the pre-trade price, so a sniper's own tax works against them.
    function _simulate(Levy memory v)
        private
        view
        returns (Reserves memory r, uint256 burned, uint256 baseOut)
    {
        r = _reserves;
        if (v.burnSpend != 0) {
            burned = CurveMath.baseOut(r.base, r.quote, v.burnSpend);
            r.base -= uint128(burned);
            r.quote += uint128(v.burnSpend);
        }
        baseOut = CurveMath.baseOut(r.base, r.quote, v.quoteIn);
    }

    /// @dev Books every levy. `taxEscrow` means the anti-sniper tax only; nothing is booked for a
    ///      BURN market's routed share, which was just spent.
    function _accrue(Levy memory v, uint256 burned) private {
        pendingProtocol += v.protocol;
        if (sink != Sinks.BURN) pendingFees += v.routed;
        pendingTax += v.creatorTax;
        taxEscrow += v.antiSniper;
        burnedByTax += burned;
    }

    /// @dev The seed comes from the curve's OWN accounting, never `balanceOf` (a donation would
    ///      brick graduation): balance = launchSupply + baseReserve - ceiling, burns cancel. Runs
    ///      before `_accrue`, with `_reserves` already net of this buy; must stay there.
    function _latchFill() private {
        readyToGraduate = true;
        seedBase = launchSupply + _reserves.base - BASE_VIRTUAL_CEILING;
        readyAtBlock = uint64(block.number);
        emit ReadyToGraduate(quoteRaised);
    }

    /// @dev Post-trade spot: raw quote per whole token as an 18-decimal fixed point, scaled so a
    ///      6-decimal quote against a 1e27 reserve does not truncate to nothing.
    function _price() private view returns (uint256) {
        return FixedPointMathLib.fullMulDiv(_reserves.quote, 1e36, _reserves.base);
    }

    /// @dev Graduation, attempted by whoever fills the curve; the failure is swallowed so the last
    ///      slice stays buyable, and `graduate` stays permissionless for a retry. `gasleft()` in the
    ///      event tells an under-gassed buy from a real failure.
    function _tryAutoGraduate() private {
        if (!readyToGraduate) return;
        address g = graduator;
        bytes memory data = abi.encodeWithSelector(IGraduator.graduate.selector, address(this));
        bool ok;
        assembly ("memory-safe") {
            // A raw call rather than try/catch: try decodes return data OUTSIDE the catch, so a
            // codeless or precompile graduator would revert the buyer. Zero return data copied.
            ok := call(gas(), g, 0, add(data, 0x20), mload(data), 0, 0)
        }
        if (!ok) emit AutoGraduationFailed(gasleft());
    }

    /// @notice Sell tokens back to the curve for the quote.
    /// @dev Fee and creator tax come out of the gross. A BURN market's routed share is then spent
    ///      on this curve and destroyed. No anti-sniper tax on sells.
    function sell(uint256 baseIn, uint256 minQuoteOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (readyToGraduate) revert CurveClosed();
        if (baseIn == 0) revert ZeroAmount();

        Reserves memory r = _reserves;
        uint256 gross = CurveMath.quoteOut(r.base, r.quote, baseIn);
        Levy memory v;
        _split(v, gross);
        quoteOut = gross - v.fee - v.creatorTax;
        // A sale that pays nothing must revert: zero satisfies any `minQuoteOut`.
        if (quoteOut == 0) revert ZeroOutput();
        if (quoteOut < minQuoteOut) revert InsufficientOutput();

        r.base += uint128(baseIn);
        r.quote -= uint128(gross);
        quoteRaised -= gross;
        uint256 burned;
        if (sink == Sinks.BURN && v.routed != 0) {
            burned = CurveMath.baseOut(r.base, r.quote, v.routed);
            r.base -= uint128(burned);
            r.quote += uint128(v.routed);
            quoteRaised += v.routed;
        }
        _reserves = r;
        _accrue(v, burned);

        emit Sold(msg.sender, baseIn, quoteOut, v.fee, v.creatorTax, quoteRaised, _price());
        token.safeTransferFrom(msg.sender, address(this), baseIn);
        if (burned != 0) {
            ERC20Burnable(address(token)).burn(burned);
            emit TaxBurned(v.routed, burned);
        }
        if (quoteAsset == address(0)) {
            _payQuote(msg.sender, quoteOut);
        } else {
            IERC20 q = IERC20(quoteAsset);
            uint256 before = q.balanceOf(msg.sender);
            _payQuote(msg.sender, quoteOut);
            if (q.balanceOf(msg.sender) - before < minQuoteOut) revert InsufficientOutput();
        }
    }

    /// @notice Hand everything destined for the pool to the graduation contract. Graduator only, once.
    /// @dev Sends the raise and the token seed; the anti-sniper escrow was spent on the curve, so the
    ///      pool opens at the curve's closing price. Pending fee buckets are left behind: they are
    ///      someone else's. Not `nonReentrant`: the chain is `buy -> graduate -> release` and `buy` holds the guard.
    function release()
        external
        returns (uint256 quoteAmount, uint256 baseAmount)
    {
        if (msg.sender != graduator) revert NotGraduator();
        if (!readyToGraduate) revert NotReady();
        if (released) revert AlreadyReleased();
        released = true;

        quoteAmount = quoteRaised;
        baseAmount = seedBase;
        quoteRaised = 0;

        emit Released(msg.sender, quoteAmount, baseAmount);
        token.safeTransfer(msg.sender, baseAmount);
        _payQuote(msg.sender, quoteAmount);
    }

    /// @notice Send the protocol's share to the treasury. Permissionless; pull, so a reverting
    ///         recipient cannot brick trades.
    function collectProtocolFees() external nonReentrant {
        uint256 amount = pendingProtocol;
        if (amount == 0) revert ZeroAmount();
        pendingProtocol = 0;
        emit ProtocolFeesCollected(protocolRecipient, amount);
        _payQuote(protocolRecipient, amount);
    }

    /// @notice Send the routed share where the sink says. Permissionless.
    /// @dev CREATOR: pushed, or credited to `CreatorSink` if the push fails. REWARDS: only after
    ///      graduation, credited to the hook's ledger via the graduator. BURN: never has anything here.
    function collectFees() external nonReentrant {
        uint256 amount = pendingFees;
        if (amount == 0) revert ZeroAmount();
        pendingFees = 0;
        if (sink == Sinks.CREATOR) {
            address to = routedRecipient;
            emit FeesCollected(to, amount);
            _payOrCredit(to, amount);
        } else {
            if (!released) revert NotGraduated();
            emit FeesCollected(feeRecipient(), amount);
            _creditGraduator(amount);
        }
    }

    /// @notice Send the creator tax to its recipient. Same deferred fallback as `collectFees`.
    function collectTax() external nonReentrant {
        uint256 amount = pendingTax;
        if (amount == 0) revert ZeroAmount();
        pendingTax = 0;
        address to = taxRecipient;
        emit TaxCollected(to, amount);
        _payOrCredit(to, amount);
    }

    /// @dev Push, and on failure defer to `CreatorSink`; a raw call so a refusal never unwinds the collection.
    function _payOrCredit(address to, uint256 amount) private {
        if (_tryPay(to, amount)) return;
        address s = creatorSink;
        if (s == address(0)) revert TransferFailed();
        if (quoteAsset == address(0)) {
            ICreatorSink(s).credit{value: amount}(to, address(0), amount);
        } else {
            IERC20(quoteAsset).forceApprove(s, amount);
            ICreatorSink(s).credit(to, quoteAsset, amount);
        }
    }

    /// @dev `safeTransfer`'s success rule without its revert, and it must never revert: call ok, and
    ///      either no return data or a first word of exactly 1. Anything else defers to the sink
    ///      (a `2` is a refusal, not a success). A token that moves value and reports failure is paid twice.
    function _tryPay(address to, uint256 amount) private returns (bool) {
        // Slippage re-checked on the seller's actual balance delta: a quote that takes a cut of a
        // transfer would otherwise pay less than `quoteOut` and still succeed.
        if (quoteAsset == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            return sent;
        }
        (bool ok, bytes memory ret) = quoteAsset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }

    /// @dev A REWARDS market's escrow, credited to the hook's ledger through the graduator rather
    ///      than pushed into the vault, so a reverting vault cannot brick the call.
    function _creditGraduator(uint256 amount) private {
        address g = graduator;
        if (quoteAsset == address(0)) {
            IGraduator(g).creditCurveTax{value: amount}(address(this));
        } else {
            IERC20(quoteAsset).forceApprove(g, amount);
            IGraduator(g).creditCurveTax(address(this), amount);
        }
    }

    /// @dev The sink graduation deployed; zero until then. A static call that never reverts.
    function _sinkAddress() private view returns (address) {
        if (!released) return address(0);
        (bool ok, bytes memory ret) =
            graduator.staticcall(abi.encodeCall(IGraduator.sinkOf, (address(this))));
        if (!ok || ret.length < 32) return address(0);
        return abi.decode(ret, (address));
    }

    /// @dev Every outbound quote: native by `call` (no 2300 stipend), ERC-20 by `safeTransfer`.
    function _payQuote(address to, uint256 amount) private {
        if (quoteAsset == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(quoteAsset).safeTransfer(to, amount);
        }
    }

    /// @dev Only accepts MON through `buy`; a bare send would break the balance invariant.
    receive() external payable {
        revert ZeroAmount();
    }
}
