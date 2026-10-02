// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Strings} from "openzeppelin/utils/Strings.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin/token/ERC20/utils/SafeERC20.sol";
import {Ownable2Step, Ownable} from "openzeppelin/access/Ownable2Step.sol";
import {Pausable} from "openzeppelin/utils/Pausable.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {DokuToken} from "./DokuToken.sol";
import {QuoteRegistry} from "./QuoteRegistry.sol";
import {Sinks} from "./lib/Sinks.sol";
import {TaxMath} from "./lib/TaxMath.sol";

/// @title DokuFactory
/// @notice Validates a launch, deploys the market for it, and settles the launch fee and the
///         creator's first buy in the same transaction.
/// @dev The only mutable contract in the system; token and curve are immutable clones. A future
///      factory may reuse the registry but not the sink or hook (one-shot / immutable wires).
/// @dev The graduation contract as the factory checks it. Every member is an immutable on
///      `DokuGraduation`, so checking them once at `activate` suffices.
interface IDokuGraduator {
    function factory() external view returns (address);
    function hook() external view returns (address);
    function poolManager() external view returns (address);
    function positionManager() external view returns (address);
    function permit2() external view returns (address);
}

/// @dev The hook as the factory checks it. `isGraduator` is the only mutable wire, so `launch` re-reads it.
interface IDokuHookWiring {
    function isGraduator(address graduator) external view returns (bool);
    function creatorSink() external view returns (address);
}

/// @dev The shared sink's three one-shot wires; checked before any launch because they can never be changed.
interface ICreatorSinkWiring {
    function graduator() external view returns (address);
    function factory() external view returns (address);
    function hook() external view returns (address);
}

contract DokuFactory is Ownable2Step, Pausable {
    using SafeERC20 for IERC20;

    struct Metadata {
        string name; // 2..42 bytes
        string ticker; // 2..12 bytes, [A-Za-z0-9]; becomes the ERC-20 symbol
        string logoURI; // <= 128 bytes
        string bannerURI; // <= 128
        string description; // <= 240
        string website; // <= 128
        string x; // <= 128
        string telegram; // <= 128
    }

    struct LaunchParams {
        Metadata meta;
        address quoteAsset; // enabled in the registry; address(0) = native
        uint8 sink; // Sinks.BURN / REWARDS / CREATOR
        address routedRecipient; // CREATOR only; zero = msg.sender. MUST be zero otherwise
        uint16 creatorTaxBps; // 0..1000, multiple of 10
        address taxRecipient; // zero = msg.sender; ignored when creatorTaxBps == 0
        bytes32 economicsPin; // economicsPin(quoteAsset, sink, creatorTaxBps) at quote time
        uint256 firstBuyQuote; // 0 = no first buy
        uint256 firstBuyMinOut;
        uint256 deadline; // for the first buy
    }

    /// @notice The dependency graph as the owner declares it at activation. Verified against the
    ///         live graph and stored so `validateDeployment()` can re-run the comparison.
    struct Dependencies {
        address graduator; // 6 in `DependencyMismatch`, since it is not a member of the struct's own indices
        address hook; // 1
        address creatorSink; // 2
        address poolManager; // 3
        address positionManager; // 4
        address permit2; // 5
    }

    /// @dev Everything `launch` derives, carried as one memory pointer to stay under the stack limit.
    struct Launched {
        address curve;
        address token;
        address routed;
        address tax;
        uint256 target;
    }

    error ZeroAddress();
    /// @dev Start rate above the curve's `TAX_START_BPS`, window above its `MAX_TAX_WINDOW`, or an unknown mode.
    error TaxTermsOutOfRange();
    error InvalidSink();
    error QuoteNotEnabled(address asset);
    /// @dev The launch's first buy transferred in and nothing arrived. See `_firstBuy`.
    error FirstBuyDeliveredNothing();
    /// @dev The graduator does not name this factory; markets launched under it could never graduate.
    error GraduatorNotWiredHere(address graduator);
    /// @dev An EOA graduator makes `_tryAutoGraduate`'s raw call succeed silently and could take the raise.
    error GraduatorHasNoCode(address graduator);
    /// @dev `launch` before `activate`. The factory ships paused until the dependency graph is verified.
    error NotActivated();
    /// @dev A dependency the activation snapshot verified no longer reads the same way.
    error DependenciesChanged();
    /// @param what index into `Dependencies`, in declaration order; 6 = the graduator itself
    error DependencyMismatch(uint8 what, address expected, address actual);
    /// @dev A declared dependency is the zero address or has no code.
    error DependencyNotAContract(uint8 what, address addr);
    error RecipientNotAllowed();
    error InvalidCreatorTax();
    /// @dev The terms the creator quoted are not the terms this launch would settle on — a target,
    ///      fee or rate moved between the quote and the send.
    error EconomicsChanged();
    error ValueMismatch(uint256 sent, uint256 required);
    error NothingToCollect();
    error TransferFailed();
    error NotCreator();
    /// @dev `name` and `ticker` are the market's identity and never change after launch.
    error IdentityLocked();
    error InvalidName();
    error InvalidTicker();
    /// @param field index into `Metadata`, in declaration order
    error FieldTooLong(uint8 field);

    uint256 public constant MIN_NAME_BYTES = 2;
    uint256 public constant MAX_NAME_BYTES = 42;
    uint256 public constant MIN_TICKER_BYTES = 2;
    uint256 public constant MAX_TICKER_BYTES = 12;
    uint256 public constant MAX_URI_BYTES = 128;
    uint256 public constant MAX_DESCRIPTION_BYTES = 240;

    QuoteRegistry public immutable registry;
    /// @notice The shared sink every new curve falls back to when a recipient cannot receive.
    address public immutable creatorSink;
    address public immutable tokenImplementation;
    address public immutable curveImplementation;

    /// @notice Where new markets send their protocol fees.
    address public feeRecipient;
    /// @notice The contract permitted to move a filled curve's holdings into a pool. Owner-set for
    ///         future markets; live curves keep the graduator they launched with.
    /// @dev Starts as zero with the factory paused, so no launch can pin a placeholder.
    address public graduator;
    /// @notice The dependency graph `activate` verified, kept so it can be re-verified later.
    Dependencies public dependencies;
    /// @notice `keccak256(abi.encode(dependencies))` — zero until activation. Part of `economicsPin`.
    bytes32 public dependencyHash;
    /// @notice Whether `activate` has run. `launch` requires it; `setGraduator` clears it.
    bool public activated;
    /// @notice What a launch costs, in wei of MON, on top of gas. Part of `economicsPin`.
    /// @dev Owner-tunable; affects future launches only.
    uint256 public launchFeeWei;
    /// @notice Accrued launch fees, awaiting collection.
    /// @dev Pulled, never pushed: a reverting recipient must not brick launches.
    uint256 public pendingLaunchFees;
    /// @notice Addresses that launch for free.
    mapping(address => bool) public feeExempt;
    /// @notice May pause launches. Held separately from the owner so a compromised pauser cannot
    ///         change economics and a compromised owner is not the only way to stop the bleeding.
    address public pauser;

    /// @notice Launches per creator. The salt of the next market is `keccak256(creator, nonce)`.
    mapping(address => uint256) public nonces;
    /// @notice Every curve this factory deployed. What gates `CreatorSink.credit`.
    mapping(address => bool) public isMarket;
    mapping(address => address) public creatorOf;
    /// @notice `keccak256(abi.encode(name, ticker))` — the two fields `setMetadata` may never move.
    mapping(address => bytes32) public identityOf;
    /// @notice Prefix of every FUTURE token's `metadataURI()`: `<base><token>.json`, lowercase hex.
    ///         Owner-set; a token already initialised keeps its own URI.
    string public metadataBaseURI;

    /// @notice The anti-sniper terms every FUTURE launch is given: start rate (bps), decay window
    ///         (seconds) and `TaxMath.Mode`. Owner-set; a curve keeps the terms it launched under.
    struct TaxTerms {
        uint16 startBps;
        uint32 window;
        uint8 mode;
    }

    /// @notice See `TaxTerms`. Defaults to the curve implementation's constants; in the economics pin.
    TaxTerms public taxTerms;

    /// @dev One log carries everything an indexer needs for the market row; metadata rides `MetadataSet`.
    event MarketLaunched(
        address indexed curve,
        address indexed token,
        address indexed creator,
        address quoteAsset,
        uint256 quoteTarget,
        uint8 sink,
        address routedRecipient,
        uint16 creatorTaxBps,
        address taxRecipient
    );
    event MetadataSet(
        address indexed curve,
        string name,
        string ticker,
        string logoURI,
        string bannerURI,
        string description,
        string website,
        string x,
        string telegram
    );
    event FeeRecipientChanged(address previous, address current);
    event PauserChanged(address previous, address current);
    event LaunchFeeChanged(uint256 previous, uint256 current);
    event FeeExemptSet(address indexed account, bool exempt);
    event LaunchFeesCollected(address indexed recipient, uint256 amount);
    event GraduatorChanged(address previous, address current);
    event MetadataBaseURIChanged(string previous, string current);
    event TaxTermsChanged(uint16 startBps, uint32 window, uint8 mode);
    /// @notice The protocol is open for launches, against exactly this dependency graph.
    /// @dev `dependencyHash` moves if and only if the custody arrangement moved.
    event Activated(bytes32 indexed dependencyHash, address graduator, address hook, address creatorSink);
    /// @notice Activation withdrawn — the factory is paused and cannot launch until re-activated.
    event Deactivated(bytes32 indexed previousDependencyHash, string reason);

    constructor(
        address owner_,
        address pauser_,
        address feeRecipient_,
        address registry_,
        address creatorSink_,
        uint256 launchFeeWei_
    ) Ownable(owner_) {
        if (
            owner_ == address(0) || pauser_ == address(0) || feeRecipient_ == address(0) || registry_ == address(0)
                || creatorSink_ == address(0)
        ) revert ZeroAddress();
        pauser = pauser_;
        feeRecipient = feeRecipient_;
        // Paused and without a graduator until `activate` verifies the dependency graph.
        _pause();
        registry = QuoteRegistry(registry_);
        creatorSink = creatorSink_;
        launchFeeWei = launchFeeWei_;
        // Default CDN; overridable with `setMetadataBaseURI`.
        metadataBaseURI = "https://cdn.doku.family/metadata/";
        tokenImplementation = address(new DokuToken());
        curveImplementation = address(new BondingCurve());
        // The curve's constants, until the owner sets otherwise.
        BondingCurve impl = BondingCurve(payable(curveImplementation));
        taxTerms = TaxTerms({startBps: impl.TAX_START_BPS(), window: impl.TAX_WINDOW(), mode: uint8(TaxMath.Mode.CLOCK)});
    }

    // -------------------------------------------------------------------------------- launch

    /// @notice Launch a market. Native quote: `msg.value == launch fee + firstBuyQuote`. ERC-20
    ///         quote: `msg.value == launch fee` and `firstBuyQuote` is pulled, so approve first.
    /// @dev Deliberately not `nonReentrant`: at the refund callback the factory holds exactly
    ///      `pendingLaunchFees`, and a nested launch stays fully accounted (asserted by tests).
    function launch(LaunchParams calldata p)
        external
        payable
        whenNotPaused
        returns (address curve, address token)
    {
        if (!activated) revert NotActivated();
        // The hook's graduator allowlist is the one mutable wire; re-read so a revoked graduator stops new markets.
        if (!IDokuHookWiring(dependencies.hook).isGraduator(graduator)) revert DependenciesChanged();
        if (!Sinks.isValid(p.sink)) revert InvalidSink();
        if (!registry.isEnabled(p.quoteAsset)) revert QuoteNotEnabled(p.quoteAsset);
        _validate(p.meta);
        Launched memory l;
        (l.routed, l.tax) = _recipients(p);
        // A target, fee or rate that moved between quote and send reverts rather than settling.
        if (p.economicsPin != economicsPin(p.quoteAsset, p.sink, p.creatorTaxBps)) revert EconomicsChanged();

        // Exact, so the first buy's size is unambiguous on a native market.
        uint256 required = launchFee(msg.sender);
        uint256 expected = p.quoteAsset == address(0) ? required + p.firstBuyQuote : required;
        if (msg.value != expected) revert ValueMismatch(msg.value, expected);
        pendingLaunchFees += required;

        _deploy(p, l);
        _firstBuy(p, l.curve);
        return (l.curve, l.token);
    }

    /// @notice What `who` pays to launch: the fee, or nothing if exempt.
    function launchFee(address who) public view returns (uint256) {
        return feeExempt[who] ? 0 : launchFeeWei;
    }

    /// @notice The terms a launch will settle on, hashed. Quoted by the interface and sent back as
    ///         `economicsPin`.
    /// @dev `abi.encode(address, bytes32, address, uint256, uint256, uint16, uint16, uint16, uint32,
    ///      uint8, uint16)` in this order. Leads with the graduator and the dependency hash so a
    ///      custody change invalidates every pending quote.
    function economicsPin(address quoteAsset, uint8 sink, uint16 creatorTaxBps) public view returns (bytes32) {
        BondingCurve impl = BondingCurve(payable(curveImplementation));
        return keccak256(
            abi.encode(
                graduator,
                dependencyHash,
                quoteAsset,
                registry.quoteTarget(quoteAsset),
                launchFeeWei,
                impl.PROTOCOL_BPS(),
                impl.ROUTED_BPS(),
                taxTerms.startBps,
                taxTerms.window,
                taxTerms.mode,
                sink,
                creatorTaxBps
            )
        );
    }

    /// @notice Where `creator`'s NEXT market will live.
    /// @dev Curve and token share a salt; `cloneDeterministic` also hashes the proxy bytecode, so they never collide.
    function predictMarket(address creator) external view returns (address curve, address token) {
        bytes32 salt = _salt(creator, nonces[creator]);
        curve = Clones.predictDeterministicAddress(curveImplementation, salt, address(this));
        token = Clones.predictDeterministicAddress(tokenImplementation, salt, address(this));
    }

    /// @notice The `metadataURI()` a token launched NOW would carry: `<metadataBaseURI><token>.json`.
    /// @dev Lowercase `0x` hex as `Strings.toHexString` renders it; the CDN key is spelled the same way.
    function metadataURIFor(address token) public view returns (string memory) {
        return string.concat(metadataBaseURI, Strings.toHexString(token), ".json");
    }

    /// @notice Update a market's metadata. Creator only; `name` and `ticker` are locked.
    function setMetadata(address curve, Metadata calldata meta) external {
        if (creatorOf[curve] != msg.sender) revert NotCreator();
        if (keccak256(abi.encode(meta.name, meta.ticker)) != identityOf[curve]) revert IdentityLocked();
        _validate(meta);
        _emitMetadata(curve, meta);
    }

    function _recipients(LaunchParams calldata p) private view returns (address routed, address tax) {
        routed = p.routedRecipient;
        if (p.sink == Sinks.CREATOR) {
            if (routed == address(0)) routed = msg.sender;
        } else if (routed != address(0)) {
            revert RecipientNotAllowed();
        }
        if (p.creatorTaxBps > 1000 || p.creatorTaxBps % 10 != 0) revert InvalidCreatorTax();
        tax = p.taxRecipient == address(0) ? msg.sender : p.taxRecipient;

        // Neither recipient may be the shared sink. Refused here: a refusal at graduation would
        // seal the raise in the curve for ever.
        if (routed == creatorSink || tax == creatorSink) revert RecipientNotAllowed();
    }

    function _deploy(LaunchParams calldata p, Launched memory l) private {
        // Deterministic, salted by (creator, nonce) — see `predictMarket`.
        bytes32 salt = _salt(msg.sender, nonces[msg.sender]++);
        l.curve = Clones.cloneDeterministic(curveImplementation, salt);
        l.token = Clones.cloneDeterministic(tokenImplementation, salt);
        l.target = registry.quoteTarget(p.quoteAsset);

        // Only a REWARDS market pays for balance history. The metadata URI derives from the clone's address.
        DokuToken(l.token).initialize(
            p.meta.name, p.meta.ticker, l.curve, p.sink == Sinks.REWARDS, metadataURIFor(l.token)
        );
        BondingCurve(payable(l.curve)).initialize(
            l.token,
            p.quoteAsset,
            l.target,
            p.sink,
            l.routed,
            p.creatorTaxBps,
            l.tax,
            feeRecipient,
            graduator,
            creatorSink,
            taxTerms.startBps,
            taxTerms.window,
            taxTerms.mode
        );

        isMarket[l.curve] = true;
        creatorOf[l.curve] = msg.sender;
        identityOf[l.curve] = keccak256(abi.encode(p.meta.name, p.meta.ticker));

        emit MarketLaunched(
            l.curve, l.token, msg.sender, p.quoteAsset, l.target, p.sink, l.routed, p.creatorTaxBps, l.tax
        );
        _emitMetadata(l.curve, p.meta);
    }

    /// @dev The creator's own buy, inside the launch transaction. See `BondingCurve.buyFor` for
    ///      why it alone is exempt from the anti-sniper rate.
    function _firstBuy(LaunchParams calldata p, address curve) private {
        if (p.firstBuyQuote == 0) return;
        BondingCurve c = BondingCurve(payable(curve));
        if (p.quoteAsset == address(0)) {
            c.buyFor{value: p.firstBuyQuote}(msg.sender, p.firstBuyQuote, p.firstBuyMinOut, p.deadline);
        } else {
            // Priced on what ARRIVED, not on what was asked for (fee-on-transfer or rebasing quotes).
            IERC20 q = IERC20(p.quoteAsset);
            uint256 before = q.balanceOf(curve);
            uint256 bookedBefore = c.quoteBooked();
            q.safeTransferFrom(msg.sender, curve, p.firstBuyQuote);
            // Minus whatever the curve booked meanwhile: a quote token that calls back can buy on
            // this curve during the transfer, and that leg must not be credited to the creator.
            uint256 grew = q.balanceOf(curve) - before;
            uint256 booked = c.quoteBooked() - bookedBefore;
            if (grew <= booked) revert FirstBuyDeliveredNothing();
            uint256 arrived;
            unchecked {
                arrived = grew - booked;
            }
            c.buyFor(msg.sender, arrived, p.firstBuyMinOut, p.deadline);
        }
    }

    /// @dev Memory, not calldata, to stay under the stack limit.
    function _emitMetadata(address curve, Metadata memory m) private {
        emit MetadataSet(curve, m.name, m.ticker, m.logoURI, m.bannerURI, m.description, m.website, m.x, m.telegram);
    }

    /// @dev Byte-level caps. The ticker becomes `symbol()` for ever, so it is held to `[A-Za-z0-9]`.
    function _validate(Metadata calldata m) private pure {
        uint256 n = bytes(m.name).length;
        if (n < MIN_NAME_BYTES || n > MAX_NAME_BYTES) revert InvalidName();
        bytes calldata t = bytes(m.ticker);
        if (t.length < MIN_TICKER_BYTES || t.length > MAX_TICKER_BYTES) revert InvalidTicker();
        for (uint256 i; i < t.length; ++i) {
            bytes1 c = t[i];
            bool ok = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A);
            if (!ok) revert InvalidTicker();
        }
        if (bytes(m.logoURI).length > MAX_URI_BYTES) revert FieldTooLong(2);
        if (bytes(m.bannerURI).length > MAX_URI_BYTES) revert FieldTooLong(3);
        if (bytes(m.description).length > MAX_DESCRIPTION_BYTES) revert FieldTooLong(4);
        if (bytes(m.website).length > MAX_URI_BYTES) revert FieldTooLong(5);
        if (bytes(m.x).length > MAX_URI_BYTES) revert FieldTooLong(6);
        if (bytes(m.telegram).length > MAX_URI_BYTES) revert FieldTooLong(7);
    }

    function _salt(address creator, uint256 nonce) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, nonce));
    }

    // ------------------------------------------------------------------------------ admin

    /// @dev Pausing stops *new launches only*. It can never reach an existing curve's buy or sell
    ///      path: a pause that traps user funds is a larger risk than the bug it guards against.
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert OwnableUnauthorizedAccount(msg.sender);
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Set the anti-sniper terms FUTURE launches are given; a market already launched keeps
    ///         its own. Bounds: start ≤ 50%, window ≤ an hour, mode 0..2.
    function setTaxTerms(uint16 startBps, uint32 window, uint8 mode) external onlyOwner {
        BondingCurve impl = BondingCurve(payable(curveImplementation));
        if (startBps > impl.TAX_START_BPS() || window > impl.MAX_TAX_WINDOW() || mode > uint8(TaxMath.Mode.MAX)) {
            revert TaxTermsOutOfRange();
        }
        taxTerms = TaxTerms({startBps: startBps, window: window, mode: mode});
        emit TaxTermsChanged(startBps, window, mode);
    }

    /// @notice Point FUTURE launches' metadata at a different base; tokens already launched keep their URI.
    function setMetadataBaseURI(string calldata base) external onlyOwner {
        if (bytes(base).length == 0) revert ZeroAddress();
        emit MetadataBaseURIChanged(metadataBaseURI, base);
        metadataBaseURI = base;
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        emit FeeRecipientChanged(feeRecipient, recipient);
        feeRecipient = recipient;
    }

    /// @notice Point future launches at a graduation contract. Deactivates the factory: the new
    ///         graduator brings a whole dependency graph with it, and none of it has been read yet.
    function setGraduator(address graduator_) external onlyOwner {
        // A graduator must have code and name this factory: the curve pins it at `initialize` with
        // no setter, so a wrong one is unrecoverable for every market launched meanwhile.
        if (graduator_ == address(0)) revert ZeroAddress();
        if (graduator_.code.length == 0) revert GraduatorHasNoCode(graduator_);
        if (IDokuGraduator(graduator_).factory() != address(this)) revert GraduatorNotWiredHere(graduator_);
        emit GraduatorChanged(graduator, graduator_);
        graduator = graduator_;
        // The previous activation asserted a different graph; closed until it is re-read.
        _deactivate("graduator changed");
    }

    // -------------------------------------------------------------------------- activation

    /// @notice Verify the whole dependency graph and open the protocol for launches.
    /// @dev `d` is the owner's declaration, compared against the live graph (immutables and
    ///      one-shots) and stored so `validateDeployment()` can re-run the comparison. Idempotent.
    function activate(Dependencies calldata d) external onlyOwner {
        _validateDeployment(d);
        dependencies = d;
        bytes32 h = keccak256(abi.encode(d));
        dependencyHash = h;
        // Only the transition into an activated state unpauses, so a re-run cannot reopen a factory the pauser shut.
        bool opening = !activated;
        activated = true;
        emit Activated(h, d.graduator, d.hook, d.creatorSink);
        if (opening && paused()) _unpause();
    }

    /// @notice Re-run the activation checks against the stored declaration. Reverts with the exact
    ///         mismatch; returns quietly when the graph is intact.
    /// @dev Argument-free so a monitor can call it on a timer.
    function validateDeployment() public view {
        if (!activated) revert NotActivated();
        _validateDeployment(dependencies);
    }

    /// @notice The same check as a boolean, for a caller that would rather branch than catch.
    function isDeploymentValid() external view returns (bool) {
        if (!activated) return false;
        try this.validateDeployment() {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice What `activate` will store for `d`, so a client can pin a quote to a declaration it
    ///         has read rather than to whatever is live when its transaction lands.
    function dependencyHashOf(Dependencies calldata d) external pure returns (bytes32) {
        return keccak256(abi.encode(d));
    }

    /// @dev Ordered so the cheapest and most likely mistakes fail first.
    function _validateDeployment(Dependencies memory d) private view {
        // 0. Nothing in the graph may be an EOA.
        _mustBeContract(6, d.graduator);
        _mustBeContract(1, d.hook);
        _mustBeContract(2, d.creatorSink);
        _mustBeContract(3, d.poolManager);
        _mustBeContract(4, d.positionManager);
        _mustBeContract(5, d.permit2);

        // 1. The declaration must name the graduator this factory pins and the sink it was built against.
        if (d.graduator != graduator) revert DependencyMismatch(6, graduator, d.graduator);
        if (d.creatorSink != creatorSink) revert DependencyMismatch(2, creatorSink, d.creatorSink);

        // 2. The graduator's own immutables.
        IDokuGraduator g = IDokuGraduator(d.graduator);
        if (g.factory() != address(this)) revert GraduatorNotWiredHere(d.graduator);
        if (g.hook() != d.hook) revert DependencyMismatch(1, d.hook, g.hook());
        if (g.poolManager() != d.poolManager) revert DependencyMismatch(3, d.poolManager, g.poolManager());
        if (g.positionManager() != d.positionManager) {
            revert DependencyMismatch(4, d.positionManager, g.positionManager());
        }
        if (g.permit2() != d.permit2) revert DependencyMismatch(5, d.permit2, g.permit2());

        // 3. The hook: its allowlist (the one mutable wire) and the sink graduation routes through.
        IDokuHookWiring h = IDokuHookWiring(d.hook);
        if (!h.isGraduator(d.graduator)) revert DependencyMismatch(6, d.graduator, address(0));
        if (h.creatorSink() != d.creatorSink) revert DependencyMismatch(2, d.creatorSink, h.creatorSink());

        // 4. The shared sink's three one-shots.
        ICreatorSinkWiring cs = ICreatorSinkWiring(d.creatorSink);
        if (cs.graduator() != d.graduator) revert DependencyMismatch(6, d.graduator, cs.graduator());
        if (cs.factory() != address(this)) revert DependencyMismatch(2, address(this), cs.factory());
        if (cs.hook() != d.hook) revert DependencyMismatch(1, d.hook, cs.hook());
    }

    function _mustBeContract(uint8 what, address a) private view {
        if (a == address(0) || a.code.length == 0) revert DependencyNotAContract(what, a);
    }

    /// @dev Pauses too, so the state is visible to every client that reads `paused()`.
    function _deactivate(string memory reason) private {
        emit Deactivated(dependencyHash, reason);
        activated = false;
        dependencyHash = bytes32(0);
        delete dependencies;
        if (!paused()) _pause();
    }

    /// @notice Set the launch fee. Future launches only; a pending launch's pin catches the move.
    function setLaunchFee(uint256 feeWei) external onlyOwner {
        emit LaunchFeeChanged(launchFeeWei, feeWei);
        launchFeeWei = feeWei;
    }

    function setFeeExempt(address account, bool exempt) external onlyOwner {
        feeExempt[account] = exempt;
        emit FeeExemptSet(account, exempt);
    }

    /// @notice Send accrued launch fees to the fee recipient. Permissionless — anyone may trigger
    ///         it, but the money can only ever go to `feeRecipient`.
    function collectLaunchFees() external {
        uint256 amount = pendingLaunchFees;
        if (amount == 0) revert NothingToCollect();
        pendingLaunchFees = 0;
        emit LaunchFeesCollected(feeRecipient, amount);
        (bool ok,) = feeRecipient.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function setPauser(address pauser_) external onlyOwner {
        if (pauser_ == address(0)) revert ZeroAddress();
        emit PauserChanged(pauser, pauser_);
        pauser = pauser_;
    }
}
