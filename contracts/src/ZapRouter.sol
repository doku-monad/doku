// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "@uniswap/v4-core/src/libraries/TransientStateLibrary.sol";
import {PathKey} from "@uniswap/v4-periphery/src/libraries/PathKey.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "openzeppelin/access/Ownable2Step.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {DokuFactory} from "./DokuFactory.sol";

/// @title ZapRouter
/// @notice Buy or sell a DOKU market priced in an ERC-20 with native MON in one transaction: a v4 swap
///         leg and a curve leg. Periphery only; nothing in the protocol depends on it.
contract ZapRouter is IUnlockCallback, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    using TransientStateLibrary for IPoolManager;

    Currency internal constant NATIVE = Currency.wrap(address(0));

    /// @notice The most hops one zap may take.
    uint256 public constant MAX_HOPS = 4;

    IPoolManager public immutable poolManager;

    /// @notice The DOKU factory whose markets this router will buy on, and no other.
    DokuFactory public immutable factory;

    /// @notice The spend ceiling moved. Announced because it governs what other people may spend.
    event MaxZapValueSet(uint256 previous, uint256 current);

    event Zapped(
        address indexed curve,
        address indexed buyer,
        uint256 nativeIn,
        uint256 quoteOut,
        uint256 baseOut,
        uint256 quoteRefunded,
        uint256 nativeRefunded
    );

    event Unzapped(
        address indexed curve,
        address indexed seller,
        uint256 baseIn,
        uint256 quoteOut,
        uint256 nativeOut,
        uint256 quoteRefunded,
        uint256 baseRefunded
    );

    error Expired();
    error ZeroValue();
    error UnknownMarket(address curve);
    error NativeQuoteNeedsNoZap();
    error EmptyPath();
    error PathTooLong(uint256 hops, uint256 maximum);
    error NativeIntermediate(uint256 hop);
    error PathDoesNotEndAtQuote(address expected, address actual);
    error PathDoesNotEndAtNative(address actual);
    error InsufficientNativeOut(uint256 minimum, uint256 actual);
    error SellTooLarge(uint256 paid, uint256 maximum);
    error SellFloorTooLarge(uint256 minNativeOut, uint256 maximum);
    error UnexpectedNativeDebit();
    error ZeroAmount();
    error InsufficientQuoteOut(uint256 minimum, uint256 actual);
    error InsufficientBaseOut(uint256 minimum, uint256 actual);
    error HopUnfilled(uint256 hop, uint256 offered, uint256 consumed);
    error HopProducedNothing(uint256 hop);
    error NotPoolManager();
    error UnexpectedUnlock();
    error UnexpectedNativeCredit();
    error NativeRefundFailed();
    error OnlyPoolManagerPays();
    error OnlyOwnUnlockPays();
    error ZapTooLarge(uint256 offered, uint256 maximum);

    bytes32 internal constant _UNLOCK_EXPECTED_SLOT = keccak256("doku.zaprouter.unlock.expected");

    /// @notice The most MON one zap may spend, or ZERO for no ceiling.
    uint256 public maxZapValue;

    constructor(
        IPoolManager poolManager_,
        DokuFactory factory_,
        address owner_,
        uint256 maxZapValue_
    ) Ownable(owner_) {
        poolManager = poolManager_;
        factory = factory_;
        maxZapValue = maxZapValue_;
        emit MaxZapValueSet(0, maxZapValue_);
    }

    /// @notice Raise, lower or remove the spend ceiling. Zero removes it.
    function setMaxZapValue(uint256 maximum) external onlyOwner {
        emit MaxZapValueSet(maxZapValue, maximum);
        maxZapValue = maximum;
    }

    /// @notice Swap `msg.value` MON along `path` into the market's quote asset, buy on the curve
    ///         with the whole proceeds, and send the market tokens to the caller.
    /// @param curve      The DOKU `BondingCurve` to buy on. Refused unless the factory knows it.
    /// @param path       The v4 route as `PathKey`s; the first hop's input is native MON, the last
    ///        hop must end at the market's quote asset.
    /// @param minQuoteOut Least quote the SWAP leg may produce. Bounds the route.
    /// @param minBaseOut  Least market token the BUY leg may produce. Bounds the curve.
    /// @param deadline    Rejected once passed, here and again inside the curve.
    /// @return baseOut    Market tokens the BUY LEG produced (the transfer that follows can be larger).
    function zapBuyWithNative(
        address curve,
        PathKey[] calldata path,
        uint256 minQuoteOut,
        uint256 minBaseOut,
        uint256 deadline
    ) external payable nonReentrant returns (uint256 baseOut) {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroValue();

        uint256 ceiling = maxZapValue;
        if (ceiling != 0 && msg.value > ceiling) revert ZapTooLarge(msg.value, ceiling);

        if (!factory.isMarket(curve)) revert UnknownMarket(curve);

        BondingCurve c = BondingCurve(payable(curve));
        address quote = c.quoteAsset();

        if (quote == address(0)) revert NativeQuoteNeedsNoZap();

        _checkPath(path, quote);

        uint256 quoteOut = _swap(path, quote, msg.value);
        if (quoteOut < minQuoteOut) revert InsufficientQuoteOut(minQuoteOut, quoteOut);

        baseOut = _buy(c, quote, quoteOut, minBaseOut, deadline);

        _sweepToken(address(c.token()));
        (uint256 quoteRefund, uint256 nativeRefund) = _sweep(quote);
        emit Zapped(curve, msg.sender, msg.value, quoteOut, baseOut, quoteRefund, nativeRefund);
    }

    /// @notice Sell a market's token on its bonding curve and receive native MON, on a market priced
    ///         in something else: sell for the quote asset, then swap that into MON.
    /// @param curve        The DOKU `BondingCurve` to sell on. Refused unless the factory knows it.
    /// @param path         The v4 route as `PathKey`s; the first hop's input is the quote asset, the
    ///        last hop must end at native MON.
    /// @param baseIn       Market tokens to sell; approved to THIS contract, not to the curve.
    /// @param minQuoteOut  Least quote the CURVE leg may produce. Bounds the curve.
    /// @param minNativeOut Least MON the SWAP leg may produce.
    /// @param deadline     Rejected once passed, here and again inside the curve.
    /// @return nativeOut   MON the SWAP LEG produced, checked against `minNativeOut`.
    function zapSellToNative(
        address curve,
        PathKey[] calldata path,
        uint256 baseIn,
        uint256 minQuoteOut,
        uint256 minNativeOut,
        uint256 deadline
    ) external nonReentrant returns (uint256 nativeOut) {
        if (block.timestamp > deadline) revert Expired();
        if (baseIn == 0) revert ZeroAmount();

        uint256 ceiling = maxZapValue;
        if (ceiling != 0 && minNativeOut > ceiling) revert SellFloorTooLarge(minNativeOut, ceiling);

        if (!factory.isMarket(curve)) revert UnknownMarket(curve);

        BondingCurve c = BondingCurve(payable(curve));
        address quote = c.quoteAsset();

        if (quote == address(0)) revert NativeQuoteNeedsNoZap();

        _checkSellPath(path);

        uint256 quoteOut = _sell(c, quote, baseIn, minQuoteOut, deadline);
        nativeOut = _swapToNative(path, quote, quoteOut);
        if (nativeOut < minNativeOut) revert InsufficientNativeOut(minNativeOut, nativeOut);

        uint256 quoteRefund = _sweepToken(quote);
        uint256 baseRefund = _sweepToken(address(c.token()));
        uint256 paid = _sweepNative();

        if (ceiling != 0 && paid > ceiling) revert SellTooLarge(paid, ceiling);

        emit Unzapped(curve, msg.sender, baseIn, quoteOut, nativeOut, quoteRefund, baseRefund);
    }

    function _checkPath(PathKey[] calldata path, address quote) private pure {
        uint256 hops = path.length;
        if (hops == 0) revert EmptyPath();
        if (hops > MAX_HOPS) revert PathTooLong(hops, MAX_HOPS);

        address last = Currency.unwrap(path[hops - 1].intermediateCurrency);
        if (last != quote) revert PathDoesNotEndAtQuote(quote, last);

        for (uint256 i; i < hops; ++i) {
            if (path[i].intermediateCurrency.isAddressZero()) revert NativeIntermediate(i);
        }
    }

    function _checkSellPath(PathKey[] calldata path) internal pure {
        uint256 hops = path.length;
        if (hops == 0) revert EmptyPath();
        if (hops > MAX_HOPS) revert PathTooLong(hops, MAX_HOPS);

        address last = Currency.unwrap(path[hops - 1].intermediateCurrency);
        if (last != address(0)) revert PathDoesNotEndAtNative(last);

        for (uint256 i; i + 1 < hops; ++i) {
            if (path[i].intermediateCurrency.isAddressZero()) revert NativeIntermediate(i);
        }
    }

    function _swap(PathKey[] calldata path, address quote, uint256 amountIn) private returns (uint256) {
        return _unlock(abi.encode(false, path, quote, amountIn));
    }

    function _swapToNative(PathKey[] calldata path, address quote, uint256 amountIn)
        private
        returns (uint256)
    {
        return _unlock(abi.encode(true, path, quote, amountIn));
    }

    function _unlock(bytes memory payload) private returns (uint256) {
        bytes32 slot = _UNLOCK_EXPECTED_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        bytes memory out = poolManager.unlock(payload);
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
        return abi.decode(out, (uint256));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        bytes32 slot = _UNLOCK_EXPECTED_SLOT;
        uint256 expected;
        assembly ("memory-safe") {
            expected := tload(slot)
        }
        if (expected == 0) revert UnexpectedUnlock();

        (bool sellingToNative, PathKey[] memory path, address quote, uint256 amountIn) =
            abi.decode(data, (bool, PathKey[], address, uint256));

        Currency currencyIn = sellingToNative ? Currency.wrap(quote) : NATIVE;
        uint256 amount = amountIn;
        for (uint256 i; i < path.length; ++i) {
            (PoolKey memory key, bool zeroForOne) = _poolFor(path[i], currencyIn);
            BalanceDelta delta = poolManager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amount),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                path[i].hookData
            );

            int128 spent = zeroForOne ? delta.amount0() : delta.amount1();
            int128 got = zeroForOne ? delta.amount1() : delta.amount0();

            if (spent != -int256(amount)) revert HopUnfilled(i, amount, uint256(int256(-spent)));
            if (got <= 0) revert HopProducedNothing(i);

            amount = uint256(int256(got));
            currencyIn = path[i].intermediateCurrency;
        }

        Currency quoteCurrency = Currency.wrap(quote);

        if (sellingToNative) {
            int256 quoteDelta = poolManager.currencyDelta(address(this), quoteCurrency);
            if (quoteDelta < 0) {
                poolManager.sync(quoteCurrency);
                IERC20(quote).safeTransfer(address(poolManager), uint256(-quoteDelta));
                poolManager.settle();
            } else if (quoteDelta > 0) {
                poolManager.take(quoteCurrency, address(this), uint256(quoteDelta));
            }

            int256 nativeCredit = poolManager.currencyDelta(address(this), NATIVE);
            if (nativeCredit < 0) revert UnexpectedNativeDebit();
            uint256 takenNative = uint256(nativeCredit);
            if (takenNative != 0) poolManager.take(NATIVE, address(this), takenNative);
            return abi.encode(takenNative);
        }

        int256 owedNative = poolManager.currencyDelta(address(this), NATIVE);
        if (owedNative > 0) revert UnexpectedNativeCredit();
        if (owedNative < 0) {
            poolManager.sync(NATIVE);
            poolManager.settle{value: uint256(-owedNative)}();
        }

        int256 credit = poolManager.currencyDelta(address(this), quoteCurrency);
        uint256 taken = credit > 0 ? uint256(credit) : 0;
        if (taken != 0) poolManager.take(quoteCurrency, address(this), taken);
        return abi.encode(taken);
    }

    function _poolFor(PathKey memory hop, Currency currencyIn)
        private
        pure
        returns (PoolKey memory key, bool zeroForOne)
    {
        Currency currencyOut = hop.intermediateCurrency;
        (Currency currency0, Currency currency1) =
            currencyIn < currencyOut ? (currencyIn, currencyOut) : (currencyOut, currencyIn);
        zeroForOne = currencyIn == currency0;
        key = PoolKey(currency0, currency1, hop.fee, hop.tickSpacing, hop.hooks);
    }

    function _buy(BondingCurve c, address quote, uint256 quoteIn, uint256 minBaseOut, uint256 deadline)
        private
        returns (uint256 baseOut)
    {
        IERC20 q = IERC20(quote);
        q.forceApprove(address(c), quoteIn);

        IERC20 base = c.token();
        uint256 held = base.balanceOf(address(this));
        c.buyWithToken(quoteIn, minBaseOut, deadline);
        baseOut = base.balanceOf(address(this)) - held;

        if (baseOut < minBaseOut) revert InsufficientBaseOut(minBaseOut, baseOut);

        q.forceApprove(address(c), 0);
    }

    function _sell(
        BondingCurve c,
        address quote,
        uint256 baseIn,
        uint256 minQuoteOut,
        uint256 deadline
    ) private returns (uint256 quoteOut) {
        IERC20 base = c.token();
        base.safeTransferFrom(msg.sender, address(this), baseIn);
        base.forceApprove(address(c), baseIn);

        IERC20 q = IERC20(quote);
        uint256 held = q.balanceOf(address(this));
        c.sell(baseIn, minQuoteOut, deadline);
        quoteOut = q.balanceOf(address(this)) - held;

        if (quoteOut < minQuoteOut) revert InsufficientQuoteOut(minQuoteOut, quoteOut);

        base.forceApprove(address(c), 0);
    }

    function _sweep(address quote) private returns (uint256 quoteRefund, uint256 nativeRefund) {
        quoteRefund = _sweepToken(quote);
        nativeRefund = _sweepNative();
    }

    function _sweepToken(address token_) private returns (uint256 amount) {
        amount = IERC20(token_).balanceOf(address(this));
        if (amount != 0) IERC20(token_).safeTransfer(msg.sender, amount);
    }

    function _sweepNative() private returns (uint256 amount) {
        amount = address(this).balance;
        if (amount != 0) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert NativeRefundFailed();
        }
    }

    receive() external payable {
        if (msg.sender != address(poolManager)) revert OnlyPoolManagerPays();
        bytes32 slot = _UNLOCK_EXPECTED_SLOT;
        uint256 expected;
        assembly ("memory-safe") {
            expected := tload(slot)
        }
        if (expected == 0) revert OnlyOwnUnlockPays();
    }
}
