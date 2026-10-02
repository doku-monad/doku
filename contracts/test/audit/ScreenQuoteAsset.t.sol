// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * THE SCREEN, PROVED AGAINST HOSTILE ASSETS.
 *
 * A screen that passes everything is worthless, so every fixture here is built to get through it
 * and the test is the evidence it did not. The one benign fixture exists so that "refuses
 * everything" is not the way this file goes green.
 *
 * Nothing in `src/` is touched. The engine under test is `QuoteAssetScreen` — the same contract
 * `script/ScreenQuoteAsset.s.sol`'s entrypoint runs against a fork, driven here through the same
 * external `screen()` call, because a screen whose test path differs from its production path is
 * not evidence about the production path.
 */

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";

import {QuoteAssetScreen, MiniErc1820} from "../../script/ScreenQuoteAsset.s.sol";

// ==================================================================================== the fixtures

/// @dev The control. A plain, boring, conforming ERC-20 — the shape every asset in
///      `deployments/mainnet.json` actually has.
contract PlainQuote is ERC20 {
    constructor() ERC20("Plain", "PLAIN") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface ITokensToSend {
    function tokensToSend(address, address, address, uint256, bytes calldata, bytes calldata) external;
}

interface IErc1820Lookup {
    function getInterfaceImplementer(address addr, bytes32 iHash) external view returns (address);
    function setInterfaceImplementer(address addr, bytes32 iHash, address implementer) external;
}

/**
 * @dev ERC-777 shaped, and NOTHING about it is malicious.
 *
 *      It does what the standard mandates and nothing more: before moving a holder's balance, ask
 *      the ERC-1820 registry whether that holder registered an `ERC777TokensSender`, and if so,
 *      notify it. The token has never heard of DOKU. The hostile party is the SENDER, who in
 *      `DokuFactory._firstBuy` is the launch's own creator — and the factory's two balance reads
 *      are open around exactly this call.
 *
 *      Note what it does NOT do: it does not call back an unregistered sender. A screen that
 *      probed with a payer that had not registered itself would see nothing here and pass it.
 */
contract Erc777Quote is ERC20 {
    address constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
    bytes32 constant TOKENS_SENDER = keccak256(abi.encodePacked("ERC777TokensSender"));

    constructor() ERC20("Seven Seven Seven", "S777") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            address impl = IErc1820Lookup(ERC1820).getInterfaceImplementer(from, TOKENS_SENDER);
            if (impl != address(0)) {
                ITokensToSend(impl).tokensToSend(msg.sender, from, to, value, "", "");
            }
        }
        super._update(from, to, value);
    }
}

/// @dev Declares itself ERC-777 through the registry and then never calls anybody. The interface
///      lookup is the only thing that can catch this one, which is why the screen keeps it as a
///      second signal rather than dropping it for the probe.
contract DeclaredErc777Quote is ERC20 {
    address constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;

    constructor() ERC20("Declared", "DECL") {
        IErc1820Lookup(ERC1820).setInterfaceImplementer(
            address(this), keccak256(abi.encodePacked("ERC777Token")), address(this)
        );
    }

    function canImplementInterfaceForAddress(bytes32, address) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("ERC1820_ACCEPT_MAGIC"));
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

interface INotify {
    function onTokenTransfer(address, uint256, bytes calldata) external;
}

/// @dev The reason the ERC-1820 lookup cannot be the whole screen: a bespoke hook, registered
///      nowhere, declaring nothing, calling the payer back anyway. Plenty of live tokens do this.
contract BespokeHookQuote is ERC20 {
    constructor() ERC20("Bespoke", "BESP") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && from.code.length > 0) {
            INotify(from).onTokenTransfer(to, value, "");
        }
        super._update(from, to, value);
    }
}

interface IReceiveHook {
    function onTransferReceived(address, address, uint256, bytes calldata) external returns (bytes4);
}

/// @dev ERC-1363 shaped: the RECIPIENT is called. The recipient of every DOKU buy is a
///      `BondingCurve`, so this is the same hazard pointed at the other party.
contract Erc1363Quote is ERC20 {
    constructor() ERC20("Thirteen Sixty Three", "T1363") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to != address(0) && to.code.length > 0) {
            IReceiveHook(to).onTransferReceived(msg.sender, from, value, "");
        }
    }
}

/// @dev One percent, to the deployer. `_firstBuy` and `_pullAndBuy` both price on the delta and so
///      survive it — but the curve's `sell` and `release` legs pay out with a plain `safeTransfer`,
///      so the shortfall lands on whoever is last.
contract FeeQuote is ERC20 {
    address public immutable COLLECTOR;

    constructor() ERC20("Fee", "FEE") {
        COLLECTOR = msg.sender;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0) || to == COLLECTOR) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value / 100;
        super._update(from, COLLECTOR, fee);
        super._update(from, to, value - fee);
    }
}

/// @dev The USDT shape, in full: no return value on `transfer`, `transferFrom` or `approve`, and
///      `approve` refuses to go from one non-zero allowance to another.
contract NoReturnQuote {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function symbol() external pure returns (string memory) {
        return "NORET";
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external {
        require(amount == 0 || allowance[msg.sender][spender] == 0, "unsafe approve");
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev A balance that grows on the clock with nobody transferring anything. The curve's solvency
///      is `quoteRaised` measured against `balanceOf(curve)`; a balance that drifts either way
///      breaks that identity in a direction nobody chose.
contract RebasingQuote {
    mapping(address => uint256) private _shares;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    uint256 public immutable STARTED_AT;

    constructor() {
        STARTED_AT = block.timestamp;
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function symbol() external pure returns (string memory) {
        return "REBASE";
    }

    /// @dev Zero accrual at construction, so a balance written into `_shares` reads back exactly —
    ///      which is what lets the screen fund a probe here at all, and is also how a rebasing token
    ///      looks to anyone who does not wait.
    function balanceOf(address who) public view returns (uint256) {
        uint256 elapsed = block.timestamp - STARTED_AT;
        return _shares[who] + (_shares[who] * elapsed) / (3650 days);
    }

    function mint(address to, uint256 amount) external {
        _shares[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _shares[msg.sender] -= amount;
        _shares[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _shares[from] -= amount;
        _shares[to] += amount;
        return true;
    }
}

/// @dev The one thing `QuoteRegistry.register` already refuses, so that the screen is provably a
///      superset of it rather than a different check that happens to run first.
contract NoDecimalsQuote is ERC20 {
    constructor() ERC20("No Decimals", "NODEC") {}

    function decimals() public pure override returns (uint8) {
        revert("no decimals here");
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// ======================================================================================= the tests

contract ScreenQuoteAssetTest is Test {
    address constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;

    QuoteAssetScreen internal s;

    function setUp() public {
        s = new QuoteAssetScreen();
    }

    // --------------------------------------------------------------------------- it accepts a good one

    function test_acceptsAPlainErc20() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new PlainQuote()));
        assertTrue(r.ok, "a conforming ERC-20 was refused");
        assertEq(s.refusalCount(), 0, "a conforming ERC-20 collected a refusal");
        assertTrue(r.funded, "the probe could not be funded");
        assertFalse(r.payerCallback, "phantom payer callback");
        assertFalse(r.receiverCallback, "phantom receiver callback");
        assertEq(r.arrived, r.asked, "delta moved on a plain token");
        assertEq(r.debited, r.asked, "debit moved on a plain token");
        assertEq(r.decimals, 6, "decimals misread");
    }

    /// @dev The native asset has no code to call anybody back with, and the registry hard-codes its
    ///      18 decimals rather than asking. It must not be refused for failing token checks.
    function test_acceptsTheNativeAsset() public {
        QuoteAssetScreen.Report memory r = s.screen(address(0));
        assertTrue(r.ok, "MON was refused");
        assertTrue(r.isNative, "MON not recognised as native");
        assertEq(r.decimals, 18, "MON is 18 decimals by definition");
    }

    // ------------------------------------------------------------------------------- THE finding

    /**
     * The class the whole screen exists for. Not a token an attacker wrote — a token that follows
     * ERC-777 exactly, whose payer is the launch creator.
     */
    function test_refusesAnErc777ThatNotifiesTheSender() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new Erc777Quote()));

        assertFalse(r.ok, "an ERC-777 passed the screen");
        assertTrue(r.senderHookRegistered, "the probe never registered itself as an ERC777TokensSender");
        assertTrue(r.payerCallback, "the payer callback was not detected");
        assertEq(
            r.payerSelector,
            ITokensToSend.tokensToSend.selector,
            "the callback arrived as something other than tokensToSend"
        );
    }

    /**
     * The reason the ERC-1820 lookup is the second signal and not the first. This token registers
     * nothing, declares nothing, and calls its payer back anyway.
     */
    function test_refusesABespokeHookThatIsRegisteredNowhere() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new BespokeHookQuote()));

        assertFalse(r.ok, "a bespoke transfer hook passed the screen");
        assertFalse(r.declaresErc777, "fixture is not supposed to declare anything");
        assertTrue(r.payerCallback, "a lookup-only screen would have missed this and so did this one");
        assertEq(r.payerSelector, INotify.onTokenTransfer.selector, "wrong entrypoint recorded");
    }

    /// @dev And the converse: a token that declares ERC-777 and never fires is caught by the lookup
    ///      the probe alone would have cleared.
    function test_refusesATokenThatMerelyDeclaresErc777() public {
        // A chain that HAS the registry, so the fixture can register in its constructor.
        vm.etch(ERC1820, address(new MiniErc1820()).code);

        QuoteAssetScreen.Report memory r = s.screen(address(new DeclaredErc777Quote()));

        assertFalse(r.ok, "a declared ERC-777 passed the screen");
        assertTrue(r.erc1820Present, "the registry was etched and should have been found on chain");
        assertFalse(r.erc1820Synthesised, "the screen synthesised a registry over a real one");
        assertTrue(r.declaresErc777, "the interface lookup missed a registered ERC777Token");
        assertFalse(r.payerCallback, "fixture never actually calls back; the probe should say so");
    }

    /// @dev The recipient of every buy is a `BondingCurve`. Same hazard, other party.
    function test_refusesAnErc1363StyleRecipientHook() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new Erc1363Quote()));

        assertFalse(r.ok, "a recipient-callback token passed the screen");
        assertTrue(r.receiverCallback, "the recipient callback was not detected");
        assertEq(r.receiverSelector, IReceiveHook.onTransferReceived.selector, "wrong entrypoint recorded");
    }

    // ------------------------------------------------------------------- the accounting fixtures

    function test_refusesFeeOnTransfer() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new FeeQuote()));

        assertFalse(r.ok, "a fee-on-transfer token passed the screen");
        assertLt(r.arrived, r.asked, "the fee was not measured");
        assertEq(r.arrived, r.asked - r.asked / 100, "the measured shortfall is not the fee charged");
    }

    function test_refusesANoReturnToken() public {
        NoReturnQuote t = new NoReturnQuote();
        QuoteAssetScreen.Report memory r = s.screen(address(t));

        assertFalse(r.ok, "a non-conforming token passed the screen");
        assertTrue(r.approveNoReturn, "the missing approve() return value was not seen");
        assertTrue(r.transferNoReturn, "the missing transfer() return value was not seen");
        assertTrue(r.approveNonZeroReverts, "the USDT allowance shape was not seen");
        // Still fully functional otherwise, which is the trap: it moves money correctly and every
        // eyeball test of it passes.
        assertEq(r.arrived, r.asked, "fixture is meant to deliver in full");
    }

    function test_refusesARebasingToken() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new RebasingQuote()));

        assertFalse(r.ok, "a rebasing token passed the screen");
        assertTrue(r.rebases, "the drift was not measured");
        // The transfer itself is clean, so nothing else in the screen would have caught it.
        assertFalse(r.payerCallback, "no callback expected here");
        assertEq(r.arrived, r.asked, "fixture delivers in full at t0");
    }

    // ------------------------------------------------------- a superset of what the registry asks

    function test_refusesATokenWithNoDecimals() public {
        QuoteAssetScreen.Report memory r = s.screen(address(new NoDecimalsQuote()));

        assertFalse(r.ok, "a token with no decimals() passed the screen");
        assertFalse(r.hasDecimals, "the missing decimals() was not seen");
    }

    function test_refusesAnAddressWithNoCodeAtAll() public {
        QuoteAssetScreen.Report memory r = s.screen(address(0xBEEF));

        assertFalse(r.ok, "an EOA passed the screen");
        assertFalse(r.isContract, "an empty account was reported as a contract");
    }

    /// @dev A screen that cannot get a balance has run no transfer and has therefore observed
    ///      nothing. It must fail closed, not report a clean transfer it never made.
    function test_refusesWhenTheProbeCannotBeFunded() public {
        UnfundableQuote t = new UnfundableQuote();
        QuoteAssetScreen.Report memory r = s.screen(address(t));

        assertFalse(r.ok, "a token the screen could not exercise was passed anyway");
        assertFalse(r.funded, "the funding failure was not recorded");
        assertEq(r.arrived, 0, "nothing was transferred and nothing should be claimed");
    }

    // ------------------------------------------------------------------------------ the negative

    /// @dev The other half of "a screen that passes everything is worthless": a screen that refuses
    ///      everything is worthless too, and this is the assertion that keeps the file honest.
    function test_theScreenIsNotSimplyRefusingEverything() public {
        assertTrue(s.screen(address(new PlainQuote())).ok, "control fixture refused");
        assertTrue(s.screen(address(0)).ok, "native refused");
        assertFalse(s.screen(address(new Erc777Quote())).ok, "hostile fixture accepted");
    }
}

/// @dev `balanceOf` is a constant, so `deal`'s slot search can never make it read back what it
///      wrote. Stands in for every token whose balance the screen cannot reach — a wrapper over
///      an external ledger, an exotic storage layout, a rebasing share model.
contract UnfundableQuote {
    function decimals() external pure returns (uint8) {
        return 6;
    }

    function totalSupply() external pure returns (uint256) {
        return 1e18;
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function approve(address, uint256) external pure returns (bool) {
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        return true;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return true;
    }
}
