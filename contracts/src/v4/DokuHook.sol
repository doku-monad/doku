// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Ownable2Step, Ownable} from "openzeppelin/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {BalanceDelta, BalanceDeltaLibrary, toBalanceDelta} from
    "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from
    "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BaseHook} from "./BaseHook.sol";
import {Sinks} from "../lib/Sinks.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";

/// @dev `DokuHook`'s permission bits, and therefore the low 14 bits of its address. File-level so
///      the salt miner can import it without a deployed instance; `HOOK_FLAGS` re-exports it.
uint160 constant DOKU_HOOK_FLAGS = 0x2FCF;

/// @title DokuHook
/// @notice The levy on every graduated DOKU market, taken from the PoolManager's flash-accounting
///         ledger inside each swap and liquidity change, never from LP fee accrual.
/// @dev `PoolKey.fee` must stay 0 (an LP fee is capturable by a JIT LP). The address is the
///      permission set: v4 compares all fourteen flag bits, so undeclared flags must be zero too.
contract DokuHook is BaseHook, Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;

    // --------------------------------------------------------------------------- permissions

    /// @notice The hook's permission bits, and therefore the low 14 bits of its own address.
    /// @dev 0x2FCF = beforeInitialize, before/after add and remove liquidity, before/after swap, and
    ///      the four return-delta bits. Never shrink it: the set is the address and a flag omitted at
    ///      mining time can never be added. Each return-delta flag requires its base flag.
    uint160 public constant HOOK_FLAGS = DOKU_HOOK_FLAGS;

    // ----------------------------------------------------------------------------- constants

    /// @notice `PoolKey.fee` for every DOKU market. Must be 0; enforced by `registerPool`.
    uint24 public constant POOL_LP_FEE = 0;

    /// @notice `PoolKey.tickSpacing` for every DOKU market.
    int24 public constant POOL_TICK_SPACING = 60;

    /// @notice Protocol share, levied on the quote leg of every swap, to the treasury.
    uint16 public constant PROTOCOL_LEVY_BPS = 30;

    /// @notice A second, rated sink share on the quote leg. Zero.
    /// @dev Not the sink's swap income (that is `LP_LEVY_BPS`, booked by `_settleLeg`). This is the
    ///      term `_accrue` splits the remainder by and `registerPool` adds to the maker rate; raising it
    ///      would pay the sink twice and change the maker levy.
    uint16 public constant SINK_LEVY_BPS = 0;

    /// @notice The sink's share of the swap levy: 70 bps of every swap, in the sink's own currency,
    ///         booked straight to `pendingSink`. Name is ABI-frozen.
    /// @dev Booked, not donated: a donate is capturable by a narrow band at the post-swap tick. An
    ///      external LP earns nothing here; a graduated pool is seed-only by construction.
    uint16 public constant LP_LEVY_BPS = 70;

    /// @notice Hard ceiling on `PROTOCOL_LEVY_BPS + SINK_LEVY_BPS + LP_LEVY_BPS + creatorTaxBps`.
    /// @dev Re-checked at `registerPool`. Keeps `_beforeSwap`'s positive-delta argument sound.
    uint16 public constant MAX_LEVY_BPS = 1100;

    uint16 internal constant BPS = 10_000;

    /// @notice Sink discriminants. BURN takes the token; REWARDS and CREATOR take the quote, so no sink
    ///         ever swaps. Every currency decision asks `== SINK_BURN`, never `== SINK_REWARDS`.
    uint8 public constant SINK_BURN = Sinks.BURN;
    uint8 public constant SINK_REWARDS = Sinks.REWARDS;
    uint8 public constant SINK_CREATOR = Sinks.CREATOR;

    // --------------------------------------------------------------------------------- state

    /// @notice Where the protocol's share goes. Immutable; no setter.
    address public immutable treasury;

    /// @notice The shared `CreatorSink`, the only caller `pullTax` answers. Immutable, and a
    ///         constructor argument folded into the mined address. Compared against, never called.
    address public immutable creatorSink;

    /// @notice Addresses permitted to initialise and register a DOKU pool, and whether each has ever
    ///         done so. Revocation is refused once a graduator has registered a market; see `setGraduator`.
    /// @dev `allowed` occupies byte 0 of the slot the former `mapping(address => bool)` used.
    struct GraduatorStatus {
        /// @dev May pass `_beforeInitialize`, `registerPool`, `beginSeed` and `endSeed`.
        bool allowed;
        /// @dev Set by `registerPool`, never cleared by anything.
        bool everRegistered;
    }

    mapping(address => GraduatorStatus) internal _graduators;

    /// @notice Whether `graduator` may initialise and register a DOKU pool.
    /// @dev Hand-written getter; selector and return bytes match the automatic one it replaced.
    function isGraduator(address graduator) external view returns (bool) {
        return _graduators[graduator].allowed;
    }

    /// @notice Whether `graduator` has ever registered a market, i.e. whether it can no longer be revoked.
    function graduatorEverRegistered(address graduator) external view returns (bool) {
        return _graduators[graduator].everRegistered;
    }

    /// @notice Per-market terms, frozen at registration. Slot 0 is read on every swap; slot 1 by the
    ///         maker levy and the seed waiver. Field order is packing order; do not reorder.
    /// @dev Every rate is snapshotted here and read from nowhere else: nobody, including the owner,
    ///      can change a live market's levy.
    struct Market {
        // slot 0 — one SLOAD per swap
        bool registered;
        uint8 sink;
        uint16 protocolBps;
        uint16 sinkBps;
        bool seeded;
        /// @dev Which side of the key is the quote. Every levy is keyed on quote/token leg through this bit.
        bool quoteIsCurrency0;
        /// @dev Levied on the quote leg of every swap, to `owedTax`. Never on the maker path.
        uint16 creatorTaxBps;
        address sinkAddr;
        // slot 1 — maker levy and seed waiver only
        uint16 makerBps0;
        uint16 makerBps1;
        uint128 seedLiquidity;
        int24 seedTickLower;
        int24 seedTickUpper;
    }

    mapping(PoolId => Market) internal _markets;

    /// @notice Per-market terms, frozen at registration.
    /// @dev Returns the struct as one value: the automatic thirteen-member getter is a stack-too-deep
    ///      for every Solidity caller. Selector and return bytes are identical.
    function markets(PoolId id) external view returns (Market memory) {
        return _markets[id];
    }

    /// @notice The launch token of a market.
    mapping(PoolId => address) public tokenOf;

    /// @notice The quote currency of a market: native as `Currency.wrap(address(0))`, or the ERC-20.
    mapping(PoolId => Currency) public quoteOf;

    /// @notice Levy accrued for the treasury, in the market's quote. Pull, never push.
    mapping(PoolId => uint256) public pendingProtocol;

    /// @notice Levy accrued for the market's sink, in the sink's own currency: token for BURN, quote
    ///         otherwise. Fed by `_settleLeg` (the 70 bps) and `_accrue`'s remainder split.
    mapping(PoolId => uint256) public pendingSink;

    /// @notice The treasury's share of the maker levy taken on the token leg, in the token.
    /// @dev Its own bucket: `pendingProtocol` and `pendingSink` are spent as quote on a REWARDS or
    ///      CREATOR market, so a token amount added to either would be swept as quote the hook never
    ///      received. Swept into `owedTreasury[token]`.
    mapping(PoolId => uint256) public pendingProtocolToken;

    /// @notice Swept treasury balance, held as real tokens, per currency across markets.
    mapping(Currency => uint256) public owedTreasury;

    /// @notice Swept sink balance, held as real tokens, per market.
    mapping(PoolId => uint256) public owedSink;

    /// @notice Creator tax accrued for a market, in its quote, held as ERC-6909 claims until `pullTax`
    ///         materialises them. Its own ledger: paid on every sink, so it cannot share the sink's currency.
    mapping(PoolId => uint256) public owedTax;

    error NotGraduator();
    error UnknownPool();
    /// @dev The levy on a swap's named amount would not fit the signed 128 bits a hook delta is
    ///      carried in. Bound is `type(int128).max`: above it the delta's sign inverts into a hook
    ///      debt. Unreachable by any real trade.
    error LevyOverflow(uint256 specified, uint256 bps);
    /// @dev `type(int256).min` cannot be negated; named rather than left as `Panic(0x11)`.
    error AmountSpecifiedNotNegatable();
    error AlreadyRegistered();
    error AlreadySeeded();
    error InvalidPoolKey();
    error InvalidBps();
    error ZeroAddress();
    error RenounceDisabled();
    /// @dev A revocation refused because `graduator` has already registered a market and is pinned
    ///      into every curve launched against it. Only `setGraduator(g, false)` throws it.
    error GraduatorInUse(address graduator);

    event GraduatorSet(address indexed graduator, bool allowed);
    event PoolRegistered(
        PoolId indexed id,
        address token,
        uint8 sink,
        address sinkAddr,
        uint16 protocolBps,
        uint16 lpBps,
        uint16 creatorTaxBps
    );

    // -------------------------------------------------------------------------------- the levy

    /// @dev True when `isCurrency0` names this market's quote leg. Rates are keyed on the answer,
    ///      never on the currency index.
    function _isQuote(Market storage m, bool isCurrency0) private view returns (bool) {
        return isCurrency0 == m.quoteIsCurrency0;
    }

    /// @dev Levy rate on the quote leg before the creator tax: BURN takes only the protocol's cut,
    ///      every other sink takes the whole 100 bps in the quote it pays out in.
    function _quoteBps(Market storage m) private view returns (uint256) {
        return m.sink == SINK_BURN ? m.protocolBps : uint256(m.protocolBps) + LP_LEVY_BPS;
    }

    /// @dev Levy rate on the token leg: the sink's 70 bps on a BURN market (all of it, booked to
    ///      `pendingSink`), nothing on any other sink.
    function _tokenBps(Market storage m) private view returns (uint256) {
        return m.sink == SINK_BURN ? LP_LEVY_BPS : 0;
    }

    /// @dev The sink's share of the quote leg; zero for BURN, whose sink cannot spend the quote.
    function _lpQuoteBps(Market storage m) private view returns (uint256) {
        return m.sink == SINK_BURN ? 0 : LP_LEVY_BPS;
    }

    /// @dev The sink's share of the token leg; non-zero only for BURN. With `_lpQuoteBps` this is why
    ///      `_settleLeg` may book its cut to `pendingSink` without checking a currency.
    function _lpTokenBps(Market storage m) private view returns (uint256) {
        return m.sink == SINK_BURN ? LP_LEVY_BPS : 0;
    }

    /// @dev Total levy rate on one currency of a swap. The quote leg carries the creator tax; the
    ///      token leg and the maker path never do.
    function _swapBps(Market storage m, bool isCurrency0) private view returns (uint256) {
        return _isQuote(m, isCurrency0) ? _quoteBps(m) + m.creatorTaxBps : _tokenBps(m);
    }

    /// @dev The sink's share of one currency's swap levy, always in `sinkCurrency(id)`.
    function _lpBps(Market storage m, bool isCurrency0) private view returns (uint256) {
        return _isQuote(m, isCurrency0) ? _lpQuoteBps(m) : _lpTokenBps(m);
    }

    /// @dev Every amount returned to v4 as a hook delta passes through here. v4 reads the sign of an
    ///      `int128` delta as the direction of the debt, so an amount above `int128.max` would
    ///      invert. Clamps rather than reverts: `_afterSwap` and `_makerLevy` must not revert.
    function _toInt128Bound(uint256 x) private pure returns (uint128) {
        uint256 cap = uint256(uint128(type(int128).max));
        return uint128(x > cap ? cap : x);
    }

    /// @dev Transient hand-off from `_beforeSwap` to `_afterSwap` for the specified leg's levy.
    function _pendingSlot(PoolId id) private pure returns (bytes32 slot) {
        slot = keccak256(abi.encode("DokuHook.pendingSpecified", id));
    }

    /// @notice Levies the specified leg.
    /// @dev Both callbacks are taken so each leg is levied in its own currency and no sink ever swaps.
    ///      A positive specified delta is correct in both directions: `Hooks` adds it to the swap
    ///      amount and reverts only if the sign flips, which `MAX_LEVY_BPS` (11%) rules out.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = PoolIdLibrary.toId(key);
        Market storage m = _markets[id];
        // Fail closed: an unregistered hooked pool must not trade untaxed. The remove-liquidity path
        // deliberately does not fail closed, because that would trap principal.
        if (!m.registered) revert UnknownPool();

        bool specifiedIsCurrency0 = (params.amountSpecified < 0) == params.zeroForOne;
        uint256 bps = _swapBps(m, specifiedIsCurrency0);
        if (bps == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        // Negating `type(int256).min` is a panic, not a number.
        if (params.amountSpecified == type(int256).min) revert AmountSpecifiedNotNegatable();
        uint256 specified =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        // CHECKED. `amountSpecified` is the caller's number, not the pool's; an unchecked cast let a
        // levy that is an exact multiple of 2**128 truncate to zero, bypassing the levy entirely.
        uint256 levyWide = (specified * bps) / BPS;
        // Signed bound: the value is returned as an `int128`. See `LevyOverflow`.
        if (levyWide > uint256(uint128(type(int128).max))) revert LevyOverflow(specified, bps);
        uint128 levy = uint128(levyWide);
        if (levy == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        bytes32 slot = _pendingSlot(id);
        assembly ("memory-safe") {
            tstore(slot, levy)
        }
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(int128(levy), 0), 0);
    }

    /// @notice Levies the unspecified leg and settles both.
    /// @dev `mint`, never `take`: the hook runs before its delta credit lands, and a `take` on an
    ///      exact-output swap would draw on the singleton's shared balance. The returned `int128` is
    ///      positive in both directions because `Hooks` computes `swapDelta - hookDelta`.
    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        PoolId id = PoolIdLibrary.toId(key);
        Market storage m = _markets[id];
        if (!m.registered) revert UnknownPool();

        bool spec0 = (params.amountSpecified < 0) == params.zeroForOne;

        // Settle the leg `_beforeSwap` parked. Scoped so its locals leave the stack.
        {
            bytes32 slot = _pendingSlot(id);
            uint128 specLevy;
            assembly ("memory-safe") {
                specLevy := tload(slot)
            }
            if (specLevy != 0) {
                assembly ("memory-safe") {
                    tstore(slot, 0)
                }
                _settleLeg(key, id, m, spec0, specLevy);
            }
        }

        uint128 unspecLevy;
        {
            // On exact-output the unspecified leg is the trader's input and negative. `|raw|` is taken
            // through `uint128` because negating `int128.min` would panic inside someone else's swap.
            int128 raw = spec0 ? delta.amount1() : delta.amount0();
            uint128 mag = raw < 0 ? uint128(uint256(-int256(raw))) : uint128(raw);
            uint256 bps = _swapBps(m, !spec0);
            uint256 wide = (uint256(mag) * bps) / BPS;
            // Bounded rather than trusted; the return below is an `int128`.
            unspecLevy = _toInt128Bound(wide);
        }
        if (unspecLevy != 0) {
            _settleLeg(key, id, m, !spec0, unspecLevy);
        }
        return (IHooks.afterSwap.selector, int128(unspecLevy));
    }

    /// @notice Settles one leg's levy: the sink's share to `pendingSink`, the creator's to `owedTax`,
    ///         the rest to the treasury. One `mint`, three ledger entries, no transfer, no call out.
    /// @dev `lpCut` is always in `sinkCurrency(id)`: the sink rate is non-zero only on the leg the sink
    ///      takes. The full `amount` is minted, so per currency `balanceOf(hook, C) == Σ buckets in C`.
    function _settleLeg(PoolKey calldata key, PoolId id, Market storage m, bool isCurrency0, uint128 amount)
        private
    {
        uint256 total = _swapBps(m, isCurrency0);
        uint256 lpBps = _lpBps(m, isCurrency0);
        uint128 taxCut;
        if (_isQuote(m, isCurrency0) && m.creatorTaxBps != 0) {
            taxCut = uint128((uint256(amount) * m.creatorTaxBps) / total);
        }

        // The sink's share, booked rather than donated. See the docblock.
        uint128 lpCut;
        if (lpBps != 0 && total != 0) {
            lpCut = uint128((uint256(amount) * lpBps) / total);
        }

        if (amount != 0) {
            poolManager.mint(address(this), (isCurrency0 ? key.currency0 : key.currency1).toId(), amount);
            if (taxCut != 0) {
                owedTax[id] += taxCut;
                emit TaxLevied(id, taxCut);
            }
            if (lpCut != 0) pendingSink[id] += lpCut;
            _accrue(id, m, isCurrency0, amount - taxCut - lpCut);
        }
    }

    /// @dev Maker accrual: quote leg to `pendingProtocol`, token leg to `pendingProtocolToken`. Not
    ///      `_accrue`, whose token-leg branch assumes a BURN sink. `_accrue` below splits a swap leg's
    ///      remainder: token leg to the sink (BURN only); quote leg to the treasury on BURN, otherwise
    ///      by `protocolBps : sinkBps` (a no-op split while `SINK_LEVY_BPS == 0`).
    function _accrueMaker(PoolId id, Market storage m, bool isCurrency0, uint128 amount) private {
        if (_isQuote(m, isCurrency0)) {
            pendingProtocol[id] += amount;
        } else {
            pendingProtocolToken[id] += amount;
        }
    }

    function _accrue(PoolId id, Market storage m, bool isCurrency0, uint128 amount) private {
        if (!_isQuote(m, isCurrency0)) {
            pendingSink[id] += amount;
            return;
        }
        if (m.sink == SINK_BURN) {
            pendingProtocol[id] += amount;
            return;
        }
        uint256 protocolCut = (uint256(amount) * m.protocolBps) / (uint256(m.protocolBps) + m.sinkBps);
        pendingProtocol[id] += protocolCut;
        pendingSink[id] += amount - protocolCut;
    }

    /// @notice Deliberately empty. A native `take` is a full-gas call inside a stranger's unlock.
    receive() external payable {}

    // ------------------------------------------------------------------------ the gate

    /// @dev v4 forwards the raw `msg.sender` of `initialize`, so this is the whole gate; graduation
    ///      must call `IPoolManager.initialize` directly (through POSM the revert is swallowed). The
    ///      gate is skipped when the hook itself calls, so this contract must never gain a path that
    ///      calls `poolManager.initialize`, nor any arbitrary-call surface.
    function _beforeInitialize(address sender, PoolKey calldata, uint160) internal view override returns (bytes4) {
        if (!_graduators[sender].allowed) revert NotGraduator();
        return IHooks.beforeInitialize.selector;
    }

    // -------------------------------------------------------------------------- registration

    /// @notice Freeze a market's terms. Called by the graduator, once, before the seed mint.
    /// @dev Maker rates are derived here and recorded as exactly what `_makerLevy` charges. The key's
    ///      currencies are the token and the quote in address order; which side is which is recorded
    ///      as `quoteIsCurrency0`. The seed shape arrives with `beginSeed`, in the same transaction.
    function registerPool(PoolKey calldata key, address token, uint8 sink, address sinkAddr, uint16 creatorTaxBps)
        external
    {
        GraduatorStatus storage g = _graduators[msg.sender];
        if (!g.allowed) revert NotGraduator();
        if (sinkAddr == address(0) || token == address(0)) revert ZeroAddress();
        if (!Sinks.isValid(sink)) revert InvalidBps();

        // The key must be the one this hook expects: one side the token, the other the quote.
        bool quoteIsCurrency0 = Currency.unwrap(key.currency1) == token;
        if (
            address(key.hooks) != address(this) || key.fee != POOL_LP_FEE || key.tickSpacing != POOL_TICK_SPACING
                || !(key.currency0 < key.currency1) || (!quoteIsCurrency0 && Currency.unwrap(key.currency0) != token)
        ) revert InvalidPoolKey();

        PoolId id = PoolIdLibrary.toId(key);
        if (_markets[id].registered) revert AlreadyRegistered();

        // The ceiling keeps `_beforeSwap`'s sign argument sound; the creator tax counts against it here.
        if (
            uint256(PROTOCOL_LEVY_BPS) + uint256(SINK_LEVY_BPS) + uint256(LP_LEVY_BPS) + creatorTaxBps
                > MAX_LEVY_BPS
        ) revert InvalidBps();

        // Maker rates: `PROTOCOL_LEVY_BPS` on each leg, symmetrically — a toll on using the venue, without
        // the sink's trading share and without the creator tax. `makerQuote` reads `+ SINK_LEVY_BPS` so a
        // future rated sink share would flow to the maker rate too.
        uint16 makerQuote = sink == SINK_BURN ? PROTOCOL_LEVY_BPS : PROTOCOL_LEVY_BPS + SINK_LEVY_BPS;
        uint16 makerToken = PROTOCOL_LEVY_BPS;

        _markets[id] = Market({
            registered: true,
            sink: sink,
            protocolBps: PROTOCOL_LEVY_BPS,
            sinkBps: SINK_LEVY_BPS,
            seeded: false,
            quoteIsCurrency0: quoteIsCurrency0,
            creatorTaxBps: creatorTaxBps,
            sinkAddr: sinkAddr,
            makerBps0: quoteIsCurrency0 ? makerQuote : makerToken,
            makerBps1: quoteIsCurrency0 ? makerToken : makerQuote,
            seedLiquidity: 0,
            seedTickLower: 0,
            seedTickUpper: 0
        });
        tokenOf[id] = token;
        quoteOf[id] = quoteIsCurrency0 ? key.currency0 : key.currency1;

        // The sticky bit, set only once a market really exists (after every check above). Never cleared.
        g.everRegistered = true;

        emit PoolRegistered(id, token, sink, sinkAddr, PROTOCOL_LEVY_BPS, LP_LEVY_BPS, creatorTaxBps);
    }

    /// @notice Allow a graduator, or revoke one that has never graduated anything. Owner only.
    /// @dev Every curve pins its graduator with no setter, so revoking one with live markets would
    ///      freeze every ungraduated raise; once it has registered a market, revocation reverts.
    ///      Stopping future launches is the factory's job. A market launched before its graduator's
    ///      first registration is still freezable: graduate a canary before activating the factory.
    function setGraduator(address graduator, bool allowed) external onlyOwner {
        if (graduator == address(0)) revert ZeroAddress();
        GraduatorStatus storage g = _graduators[graduator];
        if (!allowed && g.everRegistered) revert GraduatorInUse(graduator);
        g.allowed = allowed;
        emit GraduatorSet(graduator, allowed);
    }

    // ------------------------------------------------------------------------- the seed waiver

    /// @dev Transient, by hand: 0.8.26 has no `transient` mappings. Domain-separated by PoolId.
    function _seedSlot(PoolId id) private pure returns (bytes32 slot) {
        slot = keccak256(abi.encode("DokuHook.seeding", id));
    }

    function _setSeeding(PoolId id, bool on) private {
        bytes32 slot = _seedSlot(id);
        assembly ("memory-safe") {
            tstore(slot, on)
        }
    }

    function _isSeeding(PoolId id) private view returns (bool on) {
        bytes32 slot = _seedSlot(id);
        assembly ("memory-safe") {
            on := tload(slot)
        }
    }

    /// @notice Arm the one levy waiver a market's graduation seed is allowed, and record its shape.
    /// @dev The seed mint sits inside POSM's slippage check on the post-hook delta, so levying it would
    ///      revert every graduation. The hook cannot identify the seed otherwise (`msg.sender` is the
    ///      PositionManager for every POSM mint), so the graduator records the exact shape here in the
    ///      same transaction and `_afterAddLiquidity` honours it once.
    function beginSeed(PoolId id, uint128 seedLiquidity, int24 seedTickLower, int24 seedTickUpper) external {
        if (!_graduators[msg.sender].allowed) revert NotGraduator();
        Market storage m = _markets[id];
        if (!m.registered) revert UnknownPool();
        if (m.seeded) revert AlreadySeeded();
        m.seedLiquidity = seedLiquidity;
        m.seedTickLower = seedTickLower;
        m.seedTickUpper = seedTickUpper;
        _setSeeding(id, true);
    }

    /// @notice Disarm the waiver the instant the mint returns.
    /// @dev Transient storage lives to the end of the transaction and `graduate()` is permissionless,
    ///      so an armed flag would let its caller mint levy-exempt liquidity on the way out.
    function endSeed(PoolId id) external {
        if (!_graduators[msg.sender].allowed) revert NotGraduator();
        _setSeeding(id, false);
    }



    /// @param manager_     the canonical v4 PoolManager singleton for this chain
    /// @param owner_       may allow graduators and revoke unused ones; nothing else
    /// @param treasury_    where the protocol's share goes; no setter
    /// @param creatorSink_ the shared CreatorSink, the only address `pullTax` answers; no setter
    /// @dev The owner cannot change a rate, redirect a sink, move the treasury or renounce.
    constructor(IPoolManager manager_, address owner_, address treasury_, address creatorSink_)
        BaseHook(manager_)
        Ownable(owner_)
    {
        if (treasury_ == address(0) || creatorSink_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        creatorSink = creatorSink_;
    }

    /// @notice Derived from `HOOK_FLAGS` bit by bit, so the mask and the struct cannot drift.
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: DOKU_HOOK_FLAGS & 0x2000 != 0,
            afterInitialize: DOKU_HOOK_FLAGS & 0x1000 != 0,
            beforeAddLiquidity: DOKU_HOOK_FLAGS & 0x0800 != 0,
            afterAddLiquidity: DOKU_HOOK_FLAGS & 0x0400 != 0,
            beforeRemoveLiquidity: DOKU_HOOK_FLAGS & 0x0200 != 0,
            afterRemoveLiquidity: DOKU_HOOK_FLAGS & 0x0100 != 0,
            beforeSwap: DOKU_HOOK_FLAGS & 0x0080 != 0,
            afterSwap: DOKU_HOOK_FLAGS & 0x0040 != 0,
            beforeDonate: DOKU_HOOK_FLAGS & 0x0020 != 0,
            afterDonate: DOKU_HOOK_FLAGS & 0x0010 != 0,
            beforeSwapReturnDelta: DOKU_HOOK_FLAGS & 0x0008 != 0,
            afterSwapReturnDelta: DOKU_HOOK_FLAGS & 0x0004 != 0,
            afterAddLiquidityReturnDelta: DOKU_HOOK_FLAGS & 0x0002 != 0,
            afterRemoveLiquidityReturnDelta: DOKU_HOOK_FLAGS & 0x0001 != 0
        });
    }

    // ------------------------------------------------------------------- liquidity callbacks

    /// @dev Declared by the mask, so `BaseHook`'s reverting defaults must be overridden or every
    ///      `modifyLiquidity` on a DOKU pool reverts, starting with the graduation seed. With the
    ///      return-delta bits set the `after*` callbacks must return 64 bytes. This one is reserved and
    ///      inert; a policy here needs a recorded decision in `docs/doku/01-architecture-decisions.md`.
    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeAddLiquidity.selector;
    }

    /// @dev Reserved by the mask, intentionally inert. See `_beforeAddLiquidity`.
    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal
        pure
        override
        returns (bytes4)
    {
        return IHooks.beforeRemoveLiquidity.selector;
    }

    /// @dev The maker levy's entry point and the graduation-seed waiver. The waiver is bound three
    ///      ways: `endSeed` closes it explicitly, `m.seeded` makes it one-shot per pool, and the add must
    ///      match the exact shape recorded at `beginSeed`.
    function _afterAddLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta delta,
        BalanceDelta feesAccrued,
        bytes calldata
    ) internal virtual override returns (bytes4, BalanceDelta) {
        PoolId id = PoolIdLibrary.toId(key);
        Market storage m = _markets[id];

        if (
            _isSeeding(id) && !m.seeded && params.liquidityDelta == int256(uint256(m.seedLiquidity))
                && params.tickLower == m.seedTickLower && params.tickUpper == m.seedTickUpper
        ) {
            m.seeded = true;
            return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
        }

        return (IHooks.afterAddLiquidity.selector, _makerLevy(id, m, key, delta, feesAccrued));
    }

    /// @notice The maker levy on exit. THIS CALLBACK MUST NEVER REVERT.
    /// @dev A revert here traps an LP's principal forever (a fixed hook is a different pool). So: no
    ///      `UnknownPool` check, no ceiling re-check, no unchecked arithmetic, no external call but the
    ///      `mint` that zeroes our delta; an unregistered market levies nothing. `liquidityDelta == 0`
    ///      is v4's fee-collect call and returns early.
    function _afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata params,
        BalanceDelta delta,
        BalanceDelta feesAccrued,
        bytes calldata
    ) internal virtual override returns (bytes4, BalanceDelta) {
        if (params.liquidityDelta == 0) {
            return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
        }
        PoolId id = PoolIdLibrary.toId(key);
        return (IHooks.afterRemoveLiquidity.selector, _makerLevy(id, _markets[id], key, delta, feesAccrued));
    }

    /// @dev The maker levy at the recorded rates (`PROTOCOL_LEVY_BPS` per leg; no sink share, no tax).
    ///      Two invariants that brick positions if broken: the base is `delta - feesAccrued` (POSM
    ///      reverts on a negative `principal - hookDelta`, and `donate` is permissionless), and the levy
    ///      is clamped to `|base|` per currency (range orders are single-sided). Positive delta both ways.
    function _makerLevy(PoolId id, Market storage m, PoolKey calldata key, BalanceDelta delta, BalanceDelta feesAccrued)
        private
        returns (BalanceDelta)
    {
        BalanceDelta base = delta - feesAccrued;
        uint128 h0;
        uint128 h1;
        {
            // `-b0` would be a checked negation and `int128.min` would panic on a callback that must not revert.
            int128 b0 = base.amount0();
            uint128 a0 = b0 < 0 ? uint128(uint256(-int256(b0))) : uint128(b0);
            uint256 lv0 = (uint256(a0) * m.makerBps0) / BPS;
            h0 = _toInt128Bound(lv0 > a0 ? a0 : lv0);
        }
        {
            int128 b1 = base.amount1();
            uint128 a1 = b1 < 0 ? uint128(uint256(-int256(b1))) : uint128(b1);
            uint256 lv1 = (uint256(a1) * m.makerBps1) / BPS;
            h1 = _toInt128Bound(lv1 > a1 ? a1 : lv1);
        }
        if (h0 == 0 && h1 == 0) return BalanceDeltaLibrary.ZERO_DELTA;

        // `mint`, never `take`: on ADD the LP's principal has not settled yet, so a take would draw on the
        // singleton's shared balance. The mint also zeroes our own delta.
        if (h0 != 0) {
            poolManager.mint(address(this), key.currency0.toId(), h0);
            _accrueMaker(id, m, true, h0);
        }
        if (h1 != 0) {
            poolManager.mint(address(this), key.currency1.toId(), h1);
            _accrueMaker(id, m, false, h1);
        }
        return toBalanceDelta(int128(h0), int128(h1));
    }

    // ---------------------------------------------------------------------------------- sweep

    // The pool callbacks perform exactly one `poolManager.mint` per levied currency and never push:
    // a push that reverts inside `afterSwap` bricks every swap. All movement happens below, pull-only.
    // `pendingProtocol` (the quote) and `pendingSink` (what the sink takes) are apportioned at accrual,
    // so no two pulls ever claim the same balance.

    /// @dev Transient. A callback that arrives without us having asked is rejected even from the real
    ///      PoolManager.
    bytes32 private constant _UNLOCK_EXPECTED_SLOT = keccak256("DokuHook.unlockExpected");

    // `NotPoolManager` is inherited from v4-periphery's ImmutableState.
    error UnexpectedUnlock();
    error NotSink();
    error NothingToSweep();
    error WrongSinkCurrency();
    /// @dev A quote asset delivered something other than the amount asked for. A registered token can
    ///      acquire a transfer fee by upgrade, so it is caught at the credit, where the ledger would go wrong.
    error InexactTransfer(address asset, uint256 requested, uint256 arrived);

    event Swept(PoolId indexed id, uint256 protocolAmount, uint256 sinkAmount);
    /// @dev Separate from `Swept` because that event's amounts are in the quote and this one is in the token.
    event SweptToken(PoolId indexed id, uint256 protocolTokenAmount);
    event SinkPulled(PoolId indexed id, address indexed sink, uint256 amount);
    event TaxPulled(PoolId indexed id, uint256 amount);
    event TreasuryPulled(Currency indexed currency, uint256 amount);
    event CurveTaxCredited(PoolId indexed id, uint256 amount);
    event TaxLevied(PoolId indexed id, uint256 amount);

    /// @notice The currency a market's sink is paid in: the token for BURN, the quote otherwise.
    function sinkCurrency(PoolId id) public view returns (Currency) {
        return _markets[id].sink == SINK_BURN ? Currency.wrap(tokenOf[id]) : quoteOf[id];
    }

    /// @notice Turn this market's accrued claims into real balances. Permissionless.
    /// @dev Calls no sink, so no sink can brick it; no swap happens, so nothing to sandwich. The creator
    ///      tax is materialised by `pullTax`, not here.
    function sweep(PoolId id) external nonReentrant {
        uint256 prot = pendingProtocol[id];
        uint256 sink = pendingSink[id];
        uint256 protTok = pendingProtocolToken[id];
        if (prot == 0 && sink == 0 && protTok == 0) revert NothingToSweep();
        pendingProtocol[id] = 0;
        pendingSink[id] = 0;
        pendingProtocolToken[id] = 0;

        _materialise(id, prot, sink, 0, protTok);

        owedTreasury[quoteOf[id]] += prot;
        owedSink[id] += sink;
        // Keyed by currency, so the token side reuses `pullTreasury`.
        if (protTok != 0) owedTreasury[Currency.wrap(tokenOf[id])] += protTok;
        emit Swept(id, prot, sink);
        if (protTok != 0) emit SweptToken(id, protTok);
    }

    /// @dev One unlock per materialisation, bracketed by the expected-unlock flag.
    function _materialise(PoolId id, uint256 prot, uint256 sink, uint256 tax, uint256 protTok) private {
        bytes32 slot = _UNLOCK_EXPECTED_SLOT;
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        poolManager.unlock(abi.encode(id, prot, sink, tax, protTok));
        assembly ("memory-safe") {
            tstore(slot, 0)
        }
    }

    /// @dev `burn` credits the hook a positive delta and `take` converts it, netting to zero inside one
    ///      unlock; the hook never calls `settle` and never touches `sync`. Treasury and creator amounts
    ///      are in the quote; the sink's is in whatever the sink takes.
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        bytes32 slot = _UNLOCK_EXPECTED_SLOT;
        uint256 expected;
        assembly ("memory-safe") {
            expected := tload(slot)
        }
        if (expected == 0) revert UnexpectedUnlock();

        (PoolId id, uint256 prot, uint256 sink, uint256 tax, uint256 protTok) =
            abi.decode(data, (PoolId, uint256, uint256, uint256, uint256));
        Currency quote = quoteOf[id];
        if (prot + tax != 0) {
            poolManager.burn(address(this), quote.toId(), prot + tax);
            poolManager.take(quote, address(this), prot + tax);
        }
        if (sink != 0) {
            Currency sc = sinkCurrency(id);
            poolManager.burn(address(this), sc.toId(), sink);
            poolManager.take(sc, address(this), sink);
        }
        // The token-leg maker levy. On a BURN market this and the branch above name the same currency and
        // both can run in one sweep; keep them as two burns — folding them is only equal on BURN, and on
        // every other sink it would destroy quote claims for a token-denominated book.
        if (protTok != 0) {
            Currency tc = Currency.wrap(tokenOf[id]);
            poolManager.burn(address(this), tc.toId(), protTok);
            poolManager.take(tc, address(this), protTok);
        }
        return "";
    }

    /// @notice Pulled by the market's own sink, and by nothing else.
    /// @dev The shared `CreatorSink` asks every market for the routed share and the tax in one pull;
    ///      where the routed share belongs to a vault or burn sink it is answered zero, not a revert.
    function pullSink(PoolId id) external nonReentrant returns (uint256 amount) {
        Market storage m = _markets[id];
        if (msg.sender != m.sinkAddr) {
            if (msg.sender == creatorSink) return 0;
            revert NotSink();
        }
        amount = owedSink[id];
        if (amount == 0) return 0;
        owedSink[id] = 0;
        sinkCurrency(id).transfer(msg.sender, amount);
        emit SinkPulled(id, msg.sender, amount);
    }

    /// @notice The creator tax, pulled by the shared `CreatorSink` and by nothing else. Materialises its
    ///         own claims; there is no separate sweep step for it.
    function pullTax(PoolId id) external nonReentrant returns (uint256 amount) {
        if (msg.sender != creatorSink) revert NotSink();
        if (!_markets[id].registered) revert UnknownPool();
        amount = owedTax[id];
        if (amount == 0) return 0;
        owedTax[id] = 0;
        _materialise(id, 0, 0, amount, 0);
        quoteOf[id].transfer(msg.sender, amount);
        emit TaxPulled(id, amount);
    }

    /// @notice Pulled by anyone; pays the immutable treasury and nowhere else.
    /// @dev Pull-shaped so a recipient that reverts on receive cannot brick a trade.
    function pullTreasury(Currency currency) external nonReentrant returns (uint256 amount) {
        amount = owedTreasury[currency];
        if (amount == 0) return 0;
        owedTreasury[currency] = 0;
        currency.transfer(treasury, amount);
        emit TreasuryPulled(currency, amount);
    }

    /// @notice Credit a market's curve-phase routed share, or its seed position's forwarded fees, into
    ///         this ledger so one pull path serves both phases. Permissionless. Native quote only.
    /// @dev Only sinks paid in the quote can be credited; a BURN market's share is spent on the curve.
    function creditCurveTax(PoolId id) external payable {
        _requireQuotePayingSink(id);
        if (!quoteOf[id].isAddressZero()) revert WrongSinkCurrency();
        owedSink[id] += msg.value;
        emit CurveTaxCredited(id, msg.value);
    }

    /// @notice The ERC-20 form of `creditCurveTax`: the caller approves this hook and the quote is pulled.
    function creditCurveTax(PoolId id, uint256 amount) external {
        _requireQuotePayingSink(id);
        Currency quote = quoteOf[id];
        if (quote.isAddressZero()) revert WrongSinkCurrency();
        // Booked on what ARRIVED, and enforced equal. `owedSink` is a per-market ledger over one shared
        // balance, and this entry point is permissionless, so a fee-on-transfer quote would mint a claim
        // on another market's money. `QuoteRegistry` cannot catch a fee acquired by upgrade; this can.
        IERC20 token = IERC20(Currency.unwrap(quote));
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 arrived = token.balanceOf(address(this)) - before;
        if (arrived != amount) revert InexactTransfer(Currency.unwrap(quote), amount, arrived);
        owedSink[id] += amount;
        emit CurveTaxCredited(id, amount);
    }

    function _requireQuotePayingSink(PoolId id) private view {
        if (!_markets[id].registered) revert UnknownPool();
        if (_markets[id].sink == SINK_BURN) revert WrongSinkCurrency();
    }

    // ------------------------------------------------------------------------------- ownership

    /// @notice Disabled. The owner is the only recovery path for a broken deployment (allowlisting the
    ///         next graduator); hand off with the two-step `transferOwnership` instead.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }
}
