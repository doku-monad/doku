// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

// ---------------------------------------------------------------------------------------------
// FROZEN. A byte-for-byte copy of `src/sinks/CreatorSink.sol` as it stood at commit 84a7ea4b —
// the generation-3 shape, and the code actually deployed at 0x22aD9078001b42fc91E4AF876bbD51c878CA513a
// — before the 2026-09-11 review's findings were fixed. Two mechanical edits and no others: the
// contract is renamed with a `Gen3` suffix so both versions can be linked into one test binary,
// and the import paths are rewritten for this directory's depth.
//
// It is here so `SinksHunt.t.sol` can go on DEMONSTRATING A1 (credit books what it is told), B1
// (a frozen recipient is stranded), B2 (a capped transfer blocks the whole claim) and B3 (bare
// native and a self-named recipient are dead ends) after `src/` stops exhibiting them. A proof of
// a bug that is deleted the moment the bug is fixed leaves nothing behind that can tell a future
// reader why the fix is shaped the way it is, and nothing that fails if somebody reverts it.
//
// The pair lives in `CreatorSinkGen4.t.sol`: same sequences, patched contract, money reachable.
//
// Nothing in `src/` imports this. Do not fix it.
// ---------------------------------------------------------------------------------------------

pragma solidity 0.8.26;

import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin/access/Ownable2Step.sol";
import {ReentrancyGuard} from "openzeppelin/utils/ReentrancyGuard.sol";
import {IDokuSink} from "../../src/sinks/IDokuSink.sol";

/// @dev The four hook calls a pull makes. `pullTax` has no return value in the hook's interface, so
///      both pulls are measured by balance delta rather than trusted.
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
///
/// @dev ## Pull never blocks anyone
///
///      A creator wallet that reverts on receive, a quote token that blacklists the recipient, a
///      contract wallet with a broken fallback — none of these may freeze a market's trading, its
///      graduation, or another recipient's claim. So nothing here is ever PUSHED: `pull` moves the
///      hook's ledger into `claimable`, `credit` takes what a curve could not deliver, and `claim`
///      pays only `msg.sender`, who chose to be paid. The two references that shipped creator fees
///      converged on the same shape (an escrow, and a "payout deferred" event).
///
///      ## One contract, not one per market
///
///      A BURN market needs a contract that holds its token; a REWARDS market needs an epoch
///      ledger. A CREATOR market needs a mapping. Deploying one per market would spend a creator's
///      launch gas on a contract whose entire state is two addresses, so this is shared and keyed by
///      market. `entries` is written once, by the graduator, at graduation; before that the curve
///      pays the routed recipient directly and falls back to `credit` here.
///
///      ## Who may change what
///
///      The TAX recipient is immutable, as the launch form promises. The ROUTED recipient may hand
///      future income to another address — a creator selling a project, or rotating a compromised
///      key — and only the current one may do so. Owner powers are two one-shot wires and nothing
///      else: no rescue, no redirect.
contract CreatorSinkGen3 is IDokuSink, Ownable2Step, ReentrancyGuard {
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

    /// @notice The hook holding every graduated market's levy. Learned from the graduator, which
    ///         carries it as an immutable, so the two can never disagree.
    address public hook;
    /// @notice The only address that may register a market. One-shot.
    address public graduator;
    /// @notice Answers `isMarket`, which gates `credit`. One-shot.
    address public factory;

    mapping(address market => Entry) public entries;
    /// @notice What `who` may claim, per quote asset. Pull-payment only.
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

    // --------------------------------------------------------------------------------- wiring

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
    /// @dev A market with no creator tax has no meaningful tax recipient. Its tax leg is always
    ///      zero, but if it were ever credited it must not land on `address(0)` — so it falls to the
    ///      routed recipient rather than to nowhere.
    function register(address market, PoolId id, address quote, address routed, address tax) external {
        if (msg.sender != graduator) revert NotGraduator();
        if (entries[market].registered) revert AlreadyRegistered();
        if (routed == address(0)) revert ZeroAddress();
        if (tax == address(0)) tax = routed;
        entries[market] = Entry({id: id, quote: quote, routed: routed, tax: tax, registered: true});
        emit Registered(market, id, quote, routed, tax);
    }

    // ------------------------------------------------------------------------------- the money

    /// @notice Move everything the hook holds for `market` into `claimable`. Anyone may call.
    /// @dev Measured by balance delta, deliberately. `pullTax` returns nothing, and a ledger that
    ///      trusted a reported number over what actually arrived would be one hook bug away from
    ///      paying out money it does not hold.
    ///
    ///      A market that routes to a vault or a burn sink but carries a creator tax is registered
    ///      here too, with `routed` set to that sink: its routed leg is never ours — the hook hands
    ///      this contract nothing for it — and only the tax leg lands. The delta form makes that a
    ///      zero rather than a special case.
    function pull(address market) external nonReentrant {
        Entry storage e = entries[market];
        if (!e.registered) revert NotRegistered();
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
    /// @dev Only a market this protocol launched may credit, or anyone could mint themselves a
    ///      claim by sending a token and naming a recipient. `kind` is inferred: a credit to the
    ///      market's routed recipient is its routed share, anything else is its creator tax. When
    ///      the two recipients are one address the curve's own `FeesCollected` / `TaxCollected`
    ///      event in the same transaction is the authoritative label.
    function credit(address who, address quote, uint256 amount) external payable nonReentrant {
        address f = factory;
        if (f == address(0) || !IMarketRegistry(f).isMarket(msg.sender)) revert NotMarket();
        if (who == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (quote == address(0)) {
            if (msg.value != amount) revert ValueMismatch(msg.value, amount);
        } else {
            if (msg.value != 0) revert ValueMismatch(msg.value, 0);
            IERC20(quote).safeTransferFrom(msg.sender, address(this), amount);
        }
        claimable[who][quote] += amount;
        uint8 kind = who == IMarketRecipients(msg.sender).feeRecipient() ? 0 : 1;
        emit Credited(who, quote, amount, kind);
    }

    /// @notice Withdraw everything `msg.sender` is owed in `quote`.
    function claim(address quote) external nonReentrant {
        uint256 amount = claimable[msg.sender][quote];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender][quote] = 0;
        emit Claimed(msg.sender, quote, amount);
        _pay(quote, msg.sender, amount);
    }

    /// @notice Hand FUTURE routed income for `market` to `to`. Current routed recipient only.
    /// @dev Already-credited balances stay with whoever earned them; the tax recipient cannot be
    ///      moved by anyone.
    function transferRecipient(address market, address to) external {
        Entry storage e = entries[market];
        if (!e.registered || msg.sender != e.routed) revert NotRecipient();
        if (to == address(0)) revert ZeroAddress();
        emit RecipientTransferred(market, e.routed, to);
        e.routed = to;
    }

    /// @inheritdoc IDokuSink
    function sinkCurrencyIsToken() external pure returns (bool) {
        return false;
    }

    /// @dev The hook pays native currency here on `pullSink`/`pullTax`.
    receive() external payable {}

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
