// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {IDokuSink} from "./IDokuSink.sol";

interface IHookCreator {
    function pendingSink(PoolId id) external view returns (uint256);
    function sweep(PoolId id) external;
    function pullSink(PoolId id) external returns (uint256);
    function pullTax(PoolId id) external;
}

interface IMarketRegistry {
    function isMarket(address market) external view returns (bool);
}

interface IGraduatorHook {
    function hook() external view returns (address);
}

interface IMarketRecipients {
    function feeRecipient() external view returns (address);
}

/// @title CreatorSink
/// @notice One shared destination for every CREATOR market's money, before and after graduation,
///         and for every taxed market's creator tax.
contract CreatorSink is IDokuSink, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Entry {
        PoolId id;
        address quote;
        address routed;
        address tax;
        bool registered;
    }

    error AlreadySet();
    error NotGraduator();
    error NotMarket();
    error NotRecipient();
    error NotRegistered();
    error AlreadyRegistered();
    error ZeroAddress();
    error ZeroAmount();
    error ValueMismatch(uint256 sent, uint256 required);
    error NothingToClaim();
    error TransferFailed();
    error InexactTransfer(uint256 asked, uint256 arrived);
    error ClaimTooLarge(uint256 asked, uint256 owed);
    error SinkIsNotARecipient();
    error OnlyHookPays();

    /// @notice The hook holding every graduated market's levy. Learned from the graduator, which
    ///         carries it as an immutable, so the two can never disagree.
    address public hook;
    /// @notice The only address that may register a market. One-shot.
    address public graduator;
    /// @notice Answers `isMarket`, which gates `credit`. One-shot.
    address public factory;

    mapping(address market => Entry) public entries;
    /// @notice What `who` may claim, per quote asset. Pull-payment only.
    /// @dev Balances are per quote asset and are never summed across assets.
    mapping(address who => mapping(address quote => uint256)) public claimable;

    event GraduatorSet(address indexed graduator);
    event FactorySet(address indexed factory);
    event Registered(address indexed market, PoolId indexed id, address quote, address routed, address tax);
    /// @param kind 0 = routed share, 1 = creator tax.
    event Credited(address indexed who, address indexed quote, uint256 amount, uint8 kind);
    event Pulled(address indexed market, uint256 routedAmount, uint256 taxAmount);
    event Claimed(address indexed who, address indexed quote, uint256 amount);
    event RecipientTransferred(address indexed market, address indexed from, address indexed to);

    constructor(address owner_) Ownable(owner_) {}

    function setGraduator(address g) external onlyOwner {
        if (graduator != address(0)) revert AlreadySet();
        if (g == address(0)) revert ZeroAddress();
        address h = IGraduatorHook(g).hook();
        if (h == address(0)) revert ZeroAddress();
        graduator = g;
        hook = h;
        emit GraduatorSet(g);
    }

    function setFactory(address f) external onlyOwner {
        if (factory != address(0)) revert AlreadySet();
        if (f == address(0)) revert ZeroAddress();
        factory = f;
        emit FactorySet(f);
    }

    /// @notice Bind a graduated market to its pool and recipients. Graduator only, once.
    function register(address market, PoolId id, address quote, address routed, address tax) external {
        if (msg.sender != graduator) revert NotGraduator();
        if (entries[market].registered) revert AlreadyRegistered();
        if (routed == address(0)) revert ZeroAddress();
        if (tax == address(0)) tax = routed;
        if (routed == address(this) || tax == address(this)) revert SinkIsNotARecipient();
        entries[market] = Entry({id: id, quote: quote, routed: routed, tax: tax, registered: true});
        emit Registered(market, id, quote, routed, tax);
    }

    /// @notice Move everything the hook holds for `market` into `claimable`. Anyone may call.
    function pull(address market) external nonReentrant {
        Entry storage e = entries[market];
        if (!e.registered) revert NotRegistered();
        _pull(market, e);
    }

    /// @dev Credits the recipients `e` names NOW. `transferRecipient` relies on that: it settles
    ///      through here before it changes `e.routed`.
    function _pull(address market, Entry storage e) private {
        IHookCreator h = IHookCreator(hook);
        if (address(h) == address(0)) revert NotGraduator();
        if (h.pendingSink(e.id) != 0) h.sweep(e.id);

        uint256 before = _balance(e.quote);
        h.pullSink(e.id);
        uint256 mid = _balance(e.quote);
        h.pullTax(e.id);
        uint256 routedAmt = mid - before;
        uint256 taxAmt = _balance(e.quote) - mid;

        if (routedAmt != 0) {
            claimable[e.routed][e.quote] += routedAmt;
            emit Credited(e.routed, e.quote, routedAmt, 0);
        }
        if (taxAmt != 0) {
            claimable[e.tax][e.quote] += taxAmt;
            emit Credited(e.tax, e.quote, taxAmt, 1);
        }
        emit Pulled(market, routedAmt, taxAmt);
    }

    /// @notice A curve's deferred payment: what it could not push to `who`, held here for a pull.
    function credit(address who, address quote, uint256 amount) external payable nonReentrant {
        address f = factory;
        if (f == address(0) || !IMarketRegistry(f).isMarket(msg.sender)) revert NotMarket();
        if (who == address(0)) revert ZeroAddress();
        if (who == address(this)) revert SinkIsNotARecipient();
        if (amount == 0) revert ZeroAmount();
        if (quote == address(0)) {
            if (msg.value != amount) revert ValueMismatch(msg.value, amount);
        } else {
            if (msg.value != 0) revert ValueMismatch(msg.value, 0);
            uint256 before = IERC20(quote).balanceOf(address(this));
            IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
            uint256 arrived = IERC20(quote).balanceOf(address(this)) - before;
            if (arrived != amount) revert InexactTransfer(amount, arrived);
        }
        claimable[who][quote] += amount;
        uint8 kind = who == IMarketRecipients(msg.sender).feeRecipient() ? 0 : 1;
        emit Credited(who, quote, amount, kind);
    }

    /// @notice Withdraw everything `msg.sender` is owed in `quote`.
    function claim(address quote) external nonReentrant {
        _claim(quote, claimable[msg.sender][quote], msg.sender);
    }

    /// @notice Withdraw `amount` of what `msg.sender` is owed in `quote`, to `to`.
    function claim(address quote, uint256 amount, address to) external nonReentrant {
        _claim(quote, amount, to);
    }

    function _claim(address quote, uint256 amount, address to) private {
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert SinkIsNotARecipient();
        if (amount == 0) revert NothingToClaim();
        uint256 owed = claimable[msg.sender][quote];
        if (amount > owed) revert ClaimTooLarge(amount, owed);
        unchecked {
            claimable[msg.sender][quote] = owed - amount;
        }
        emit Claimed(msg.sender, quote, amount);
        _pay(quote, to, amount);
    }

    /// @notice Hand FUTURE routed income for `market` to `to`. Current routed recipient only.
    /// @dev Settles first. What the hook still holds was earned under the outgoing recipient, and a
    ///      pull after the rotation would credit it to the new one. Reverts if the hook's pull does:
    ///      a rotation that cannot settle would give the backlog away.
    function transferRecipient(address market, address to) external nonReentrant {
        Entry storage e = entries[market];
        if (!e.registered || msg.sender != e.routed) revert NotRecipient();
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert SinkIsNotARecipient();
        _pull(market, e);
        emit RecipientTransferred(market, e.routed, to);
        e.routed = to;
    }

    /// @inheritdoc IDokuSink
    function sinkCurrencyIsToken() external pure returns (bool) {
        return false;
    }

    receive() external payable {
        if (msg.sender != hook) revert OnlyHookPays();
    }

    function _balance(address quote) private view returns (uint256) {
        return quote == address(0) ? address(this).balance : IERC20(quote).balanceOf(address(this));
    }

    function _pay(address quote, address to, uint256 amount) private {
        if (quote == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(quote).safeTransfer(to, amount);
        }
    }
}
