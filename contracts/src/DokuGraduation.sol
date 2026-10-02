// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";
import {BondingCurve, DOKU_SEED_BASE} from "./BondingCurve.sol";
import {DokuHook} from "./v4/DokuHook.sol";
import {BurnSink} from "./sinks/BurnSink.sol";
import {RewardVault} from "./sinks/RewardVault.sol";
import {Sinks} from "./lib/Sinks.sol";
import {SeedLocker} from "./SeedLocker.sol";

interface IDokuMarkets {
    function isMarket(address market) external view returns (bool);
}

interface ICreatorSinkRegistry {
    function register(address market, PoolId id, address quote, address routed, address tax) external;
}

/// @title DokuGraduation
/// @notice Moves a filled bonding curve into a permanent Uniswap v4 pool, in one transaction.
contract DokuGraduation is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// @notice Holds every graduated market's seed position, and forwards only its fees.
    SeedLocker public immutable locker;

    /// @notice The factory whose markets this contract will graduate, and no other.
    IDokuMarkets public immutable factory;

    /// @notice The token side of every seed: `DokuToken.TOTAL_SUPPLY - BondingCurve.CURVE_SUPPLY`.
    uint256 public constant SEED_BASE = DOKU_SEED_BASE;
    /// @notice Full-range seed at this spacing.
    int24 public constant TICK_SPACING = 60;
    /// @notice No LP fee: the pool's 1% is the hook's levy, not an LP fee.
    uint24 public constant LP_FEE = 0;

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    IAllowanceTransfer public immutable permit2;
    DokuHook public immutable hook;

    /// @notice The pool a curve graduated into. Written BEFORE any external call.
    mapping(address => PoolId) public poolIdOf;
    mapping(address => bool) public graduated;
    mapping(address => address) public sinkOf;

    error AlreadyGraduated();
    error NotReady();
    error NotAMarket(address curve);
    error DependenciesNotWired();
    error SeedOutOfRange(uint256 quoteAmount, uint256 baseAmount);
    error NoLiquidityMinted();
    error ZeroAddress();
    error NotGraduated();
    error InexactTransfer(address asset, uint256 requested, uint256 arrived);

    struct Seed {
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 quoteAmount;
        uint256 baseAmount;
        uint160 sqrtPriceX96;
        bool quoteIsCurrency0;
        address quote;
        address token;
    }

    /// @param id The only thing that scopes a v4 swap log to a market.
    event Graduated(
        address indexed curve,
        PoolId indexed id,
        address token,
        address quoteAsset,
        uint256 quoteAmount,
        uint256 baseAmount,
        uint256 tokenId
    );

    constructor(
        address poolManager_,
        address positionManager_,
        address permit2_,
        address hook_,
        address factory_
    ) {
        if (
            poolManager_ == address(0) || positionManager_ == address(0) || permit2_ == address(0)
                || hook_ == address(0) || factory_ == address(0)
        ) {
            revert ZeroAddress();
        }
        factory = IDokuMarkets(factory_);
        poolManager = IPoolManager(poolManager_);
        positionManager = IPositionManager(positionManager_);
        permit2 = IAllowanceTransfer(permit2_);
        hook = DokuHook(payable(hook_));
        locker = new SeedLocker(IPositionManager(positionManager_), hook_, poolManager_);
    }

    /// @notice Graduate a filled curve. Permissionless, and normally called by the curve itself.
    /// @dev Pulls the raise and `SEED_BASE` via `release()`, initialises the pool at the curve's closing
    ///      price, mints the full-range seed to the locker, then registers the pool and sink.
    function graduate(address curve) external nonReentrant returns (PoolId id, uint256 tokenId) {
        if (graduated[curve]) revert AlreadyGraduated();
        graduated[curve] = true;

        if (!factory.isMarket(curve)) revert NotAMarket(curve);

        BondingCurve c = BondingCurve(payable(curve));
        if (!c.readyToGraduate()) revert NotReady();
        if (!hook.isGraduator(address(this))) revert DependenciesNotWired();

        Seed memory seed;
        seed.token = address(c.token());
        seed.quote = c.quoteAsset();
        uint8 sinkKind = c.sink();

        uint256 quoteHeldBefore =
            seed.quote == address(0) ? address(this).balance : IERC20(seed.quote).balanceOf(address(this));

        (seed.quoteAmount, seed.baseAmount) = c.release();

        if (seed.quoteAmount != c.quoteTarget() || seed.baseAmount < SEED_BASE) {
            revert SeedOutOfRange(seed.quoteAmount, seed.baseAmount);
        }

        seed.quoteIsCurrency0 = seed.quote < seed.token;
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(seed.quoteIsCurrency0 ? seed.quote : seed.token),
            currency1: Currency.wrap(seed.quoteIsCurrency0 ? seed.token : seed.quote),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        id = key.toId();
        poolIdOf[curve] = id;

        (uint256 amount0, uint256 amount1) = _sorted(seed);
        seed.sqrtPriceX96 = _sqrtPriceX96(amount0, amount1);

        poolManager.initialize(key, seed.sqrtPriceX96);

        address sink = _deploySink(sinkKind, seed, id, c.readyAtBlock(), curve);
        sinkOf[curve] = sink;

        seed.tickLower = TickMath.minUsableTick(TICK_SPACING);
        seed.tickUpper = TickMath.maxUsableTick(TICK_SPACING);
        seed.liquidity = LiquidityAmounts.getLiquidityForAmounts(
            seed.sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(seed.tickLower),
            TickMath.getSqrtPriceAtTick(seed.tickUpper),
            amount0,
            amount1
        );
        if (seed.liquidity == 0) revert NoLiquidityMinted();

        _register(key, c, seed, sinkKind, sink, id);

        tokenId = positionManager.nextTokenId();
        _mintSeed(key, seed, id);

        locker.lock(tokenId, key, sink, sinkKind, seed.quoteIsCurrency0);

        emit Graduated(curve, id, seed.token, seed.quote, seed.quoteAmount, seed.baseAmount, tokenId);

        _sweepDust(seed, sinkKind, sink, id, quoteHeldBefore);
    }

    function _sorted(Seed memory seed) private pure returns (uint256 amount0, uint256 amount1) {
        return seed.quoteIsCurrency0 ? (seed.quoteAmount, seed.baseAmount) : (seed.baseAmount, seed.quoteAmount);
    }

    function _register(PoolKey memory key, BondingCurve c, Seed memory seed, uint8 sinkKind, address sink, PoolId id)
        private
    {
        uint16 tax = c.creatorTaxBps();
        hook.registerPool(key, seed.token, sinkKind, sink, tax);
        if (sinkKind == Sinks.CREATOR || tax != 0) {
            ICreatorSinkRegistry(hook.creatorSink()).register(
                address(c), id, seed.quote, sinkKind == Sinks.CREATOR ? c.feeRecipient() : sink, c.taxRecipient()
            );
        }
    }

    function _mintSeed(PoolKey memory key, Seed memory seed, PoolId id) private {
        IERC20(seed.token).forceApprove(address(permit2), seed.baseAmount);
        permit2.approve(seed.token, address(positionManager), uint160(seed.baseAmount), uint48(block.timestamp + 300));
        bool nativeQuote = seed.quote == address(0);
        if (!nativeQuote) {
            IERC20(seed.quote).forceApprove(address(permit2), seed.quoteAmount);
            permit2.approve(
                seed.quote, address(positionManager), uint160(seed.quoteAmount), uint48(block.timestamp + 300)
            );
        }

        (uint256 amount0, uint256 amount1) = _sorted(seed);
        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            key, seed.tickLower, seed.tickUpper, seed.liquidity, amount0, amount1, address(locker), bytes("")
        );
        params[1] = abi.encode(key.currency0, key.currency1);

        hook.beginSeed(id, seed.liquidity, seed.tickLower, seed.tickUpper);
        positionManager.modifyLiquidities{value: nativeQuote ? seed.quoteAmount : 0}(
            abi.encode(actions, params), block.timestamp
        );
        hook.endSeed(id);
    }

    function _deploySink(uint8 kind, Seed memory seed, PoolId id, uint64 readyAtBlock, address curve)
        private
        returns (address)
    {
        if (kind == Sinks.BURN) {
            return address(new BurnSink(address(hook), seed.token, id));
        }
        if (kind == Sinks.CREATOR) {
            return hook.creatorSink();
        }
        address[9] memory ex;
        ex[0] = address(poolManager);
        ex[1] = address(hook);
        ex[2] = curve;
        ex[3] = seed.token;
        ex[4] = DEAD;
        ex[5] = address(this);
        ex[6] = address(positionManager);
        ex[7] = address(locker);
        return address(
            new RewardVault(
                address(hook),
                seed.token,
                id,
                seed.quote,
                BondingCurve(payable(curve)).quoteTarget(),
                readyAtBlock,
                ex
            )
        );
    }

    function _sweepDust(Seed memory seed, uint8 sinkKind, address sink, PoolId id, uint256 quoteHeldBefore)
        private
    {
        uint256 tokenDust = IERC20(seed.token).balanceOf(address(this));
        if (tokenDust != 0) IERC20(seed.token).safeTransfer(sinkKind == Sinks.BURN ? sink : DEAD, tokenDust);

        uint256 held =
            seed.quote == address(0) ? address(this).balance : IERC20(seed.quote).balanceOf(address(this));

        if (held <= quoteHeldBefore) return;
        uint256 dust;
        unchecked {
            dust = held - quoteHeldBefore;
        }
        if (dust == 0) return;

        if (dust > seed.quoteAmount) dust = seed.quoteAmount;

        if (sinkKind == Sinks.BURN) {
            _tryPayOut(seed.quote, hook.treasury(), dust);
            return;
        }

        if (seed.quote == address(0)) {
            // solhint-disable-next-line no-empty-blocks
            try hook.creditCurveTax{value: dust}(id) {} catch {}
        } else {
            IERC20(seed.quote).forceApprove(address(hook), dust);
            // solhint-disable-next-line no-empty-blocks
            try hook.creditCurveTax(id, dust) {} catch {}
        }
    }

    function _tryPayOut(address quote, address to, uint256 amount) private returns (bool) {
        if (to == address(0)) return false;
        if (quote == address(0)) {
            (bool sent,) = to.call{value: amount}("");
            return sent;
        }
        (bool ok, bytes memory ret) = quote.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok) return false;
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        return abi.decode(ret, (uint256)) == 1;
    }

    /// @notice A graduated curve's routed share, forwarded into the hook's ledger. Keyed by curve
    ///         so the curve never has to know its own PoolId. Native quote.
    function creditCurveTax(address curve) external payable {
        if (!graduated[curve]) revert NotGraduated();
        hook.creditCurveTax{value: msg.value}(poolIdOf[curve]);
    }

    /// @notice The ERC-20 form: the curve approves this contract and the quote is pulled through.
    function creditCurveTax(address curve, uint256 amount) external {
        if (!graduated[curve]) revert NotGraduated();
        IERC20 quote = IERC20(BondingCurve(payable(curve)).quoteAsset());
        uint256 before = quote.balanceOf(address(this));
        quote.safeTransferFrom(msg.sender, address(this), amount);
        uint256 arrived = quote.balanceOf(address(this)) - before;
        if (arrived != amount) revert InexactTransfer(address(quote), amount, arrived);
        quote.forceApprove(address(hook), amount);
        hook.creditCurveTax(poolIdOf[curve], amount);
    }

    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        if (amount1 < (1 << 64) * amount0) {
            uint256 ratioX192 = FixedPointMathLib.fullMulDiv(amount1, 1 << 192, amount0);
            return uint160(FixedPointMathLib.sqrt(ratioX192));
        }
        uint256 ratioX96 = FixedPointMathLib.fullMulDiv(amount1, 1 << 96, amount0);
        return uint160(FixedPointMathLib.sqrt(ratioX96) << 48);
    }

    receive() external payable {}
}
