// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {console2} from "forge-std/console2.sol";

/**
 * SCREEN A CANDIDATE QUOTE ASSET.
 *
 * `QuoteRegistry.register` is `onlyOwner` and validates one thing: that the address answers
 * `decimals()`. Everything else that makes an asset safe to price a market in is, today, a human
 * remembering. This turns the remembering into a check.
 *
 * The thing being checked for is narrow and specific. `DokuFactory._firstBuy` prices the launch's
 * first buy on a measured balance delta:
 *
 *     uint256 before  = q.balanceOf(curve);
 *     q.safeTransferFrom(msg.sender, curve, p.firstBuyQuote);
 *     uint256 arrived = q.balanceOf(curve) - before;
 *     c.buyFor(msg.sender, arrived, ...);
 *
 * A quote token that CALLS THE PAYER BACK inside `transferFrom` hands the payer control between
 * those two balance reads. The payer buys on the brand-new curve from inside the callback; the
 * curve books that buy, and then `arrived` books it a second time. Measured consequence: the
 * attacker leaves +26% up on stake, the next honest buyer recovers nothing, and the market is
 * insolvent for the rest of its life.
 *
 * The token does not have to be malicious. **Every ERC-777 is armed** — the standard MANDATES a
 * `tokensToSend` notification to the sender, and the sender is the attacker. ERC-1363 and any
 * bespoke transfer hook are the same class.
 *
 * `DokuFactory` is `Ownable2Step, Pausable`, has no proxy, and holds its registry, graduator and
 * hook in immutables. **It can never be patched.** Neither `setEnabled(false)` nor `pause()` is
 * retroactive: they close the door on NEW launches and cannot reach a market that already exists.
 * So this screen is not a convenience. It is the only control there is, and it only works before
 * the fact.
 *
 * HOW IT ANSWERS. It probes rather than pattern-matches. Three throwaway contracts stand in for
 * the three parties to `_firstBuy` — a payer (the creator), a puller (the factory) and a receiver
 * (the curve) — and a real `transferFrom` is run between them on a fork of the real chain. If the
 * payer's own code runs during that call, whatever the token calls it and whatever standard it
 * claims, the finding is made. That is why the ERC-1820 lookup is the SECOND signal and not the
 * first: a token can call its payer back without registering anywhere.
 *
 *   forge script script/ScreenQuoteAsset.s.sol --sig 'run(address)' <token> --rpc-url $MONAD_RPC_URL
 *
 * or, with the network guard and the chain-id check, `script/screen-quote-asset.sh mainnet <token>`.
 * Never broadcast: every cheatcode here writes to the local fork and nothing is signed.
 */

// ------------------------------------------------------------------------------------ interfaces

interface IErc20Probeable {
    function decimals() external view returns (uint8);
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface IErc1820 {
    function getInterfaceImplementer(address addr, bytes32 iHash) external view returns (address);
}

// ------------------------------------------------------------------------------------- the probes

/**
 * @notice One party to the transfer, and a tripwire.
 *
 * @dev Every entrypoint a token could plausibly reach a counterparty through lands in `_mark`,
 *      and so does the fallback — because the point is to catch the callback WITHOUT knowing which
 *      interface it arrives as. The named handlers exist only so that a token demanding a specific
 *      return value (ERC-1363's `onTransferReceived`) gets one and completes, rather than reverting
 *      and leaving the screen unable to say what happened.
 *
 *      Nothing here reverts. A probe that reverts turns a detected callback into a failed transfer,
 *      which is a strictly worse report.
 */
contract Probe {
    bool public called;
    address public caller;
    bytes4 public selector;

    bytes32 private constant ERC1820_ACCEPT_MAGIC = keccak256(abi.encodePacked("ERC1820_ACCEPT_MAGIC"));

    function reset() external {
        called = false;
        caller = address(0);
        selector = bytes4(0);
    }

    /// @notice Raw call, so the screen can inspect the RETURN DATA and not just the success bit.
    function callToken(address token, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = token.call(data);
    }

    /// @notice Make this probe its own ERC-1820 implementer, exactly as an ERC-777 sender does.
    /// @dev The registry skips `canImplementInterfaceForAddress` when implementer == msg.sender,
    ///      but the magic below is implemented anyway so a stricter registry also accepts it.
    function register1820(address registry, bytes32 iHash) external returns (bool ok) {
        (ok,) = registry.call(
            abi.encodeWithSignature("setInterfaceImplementer(address,bytes32,address)", address(this), iHash, address(this))
        );
    }

    function canImplementInterfaceForAddress(bytes32, address) external pure returns (bytes32) {
        return ERC1820_ACCEPT_MAGIC;
    }

    // ERC-777. The sender hook is the one that arms the finding.
    function tokensToSend(address, address, address, uint256, bytes calldata, bytes calldata) external {
        _mark();
    }

    function tokensReceived(address, address, address, uint256, bytes calldata, bytes calldata) external {
        _mark();
    }

    // ERC-1363.
    function onTransferReceived(address, address, uint256, bytes calldata) external returns (bytes4) {
        _mark();
        return 0x88a7ca5c;
    }

    function onApprovalReceived(address, uint256, bytes calldata) external returns (bytes4) {
        _mark();
        return 0x7b04a2d0;
    }

    // ERC-223 / Chainlink-style.
    function tokenFallback(address, uint256, bytes calldata) external {
        _mark();
    }

    function onTokenTransfer(address, uint256, bytes calldata) external {
        _mark();
    }

    receive() external payable {
        _mark();
    }

    fallback() external payable {
        _mark();
    }

    function _mark() private {
        called = true;
        caller = msg.sender;
        selector = msg.sig;
    }
}

/**
 * @notice A stand-in for ERC-1820, etched at the canonical address when the chain has none.
 *
 * @dev Monad has no ERC-1820 registry today, and that is NOT a defence: the canonical deployment is
 *      keyless — a pre-signed transaction anyone may relay — so the registry can appear on Monad on
 *      any block, at the same address, without anyone's permission. A screen that let an ERC-777
 *      through because the registry happens to be missing this week would be screening the chain's
 *      current state rather than the asset. So the registry is synthesised and the asset is asked
 *      the question that matters: given a sender who HAS registered, do you call them?
 *
 *      Behaviourally equivalent to the real registry on the paths a token uses. The ERC-165 cache
 *      is not implemented because no token consults it during a transfer.
 */
contract MiniErc1820 {
    mapping(address => mapping(bytes32 => address)) private _impls;
    mapping(address => address) private _managers;

    bytes32 private constant ACCEPT = keccak256(abi.encodePacked("ERC1820_ACCEPT_MAGIC"));

    event InterfaceImplementerSet(address indexed addr, bytes32 indexed interfaceHash, address indexed implementer);

    function getManager(address addr) public view returns (address) {
        return _managers[addr] == address(0) ? addr : _managers[addr];
    }

    function setManager(address addr, address newManager) external {
        require(getManager(addr) == msg.sender, "Not the manager");
        _managers[addr] = newManager == addr ? address(0) : newManager;
    }

    function setInterfaceImplementer(address addr_, bytes32 iHash, address implementer) external {
        address addr = addr_ == address(0) ? msg.sender : addr_;
        require(getManager(addr) == msg.sender, "Not the manager");
        if (implementer != address(0) && implementer != msg.sender) {
            require(
                IErc1820Implementer(implementer).canImplementInterfaceForAddress(iHash, addr) == ACCEPT,
                "Does not implement the interface"
            );
        }
        _impls[addr][iHash] = implementer;
        emit InterfaceImplementerSet(addr, iHash, implementer);
    }

    function getInterfaceImplementer(address addr, bytes32 iHash) external view returns (address) {
        return _impls[addr][iHash];
    }

    function interfaceHash(string calldata name) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(name));
    }

    function implementsERC165Interface(address, bytes4) external pure returns (bool) {
        return false;
    }

    function implementsERC165InterfaceNoCache(address, bytes4) external pure returns (bool) {
        return false;
    }

    function updateERC165Cache(address, bytes4) external {}
}

interface IErc1820Implementer {
    function canImplementInterfaceForAddress(bytes32 iHash, address addr) external view returns (bytes32);
}

// -------------------------------------------------------------------------------------- the screen

/**
 * @notice The engine. Separated from the `forge script` entrypoint so the tests can drive exactly
 *         the same code against hostile fixtures — a screen whose test path differs from its
 *         production path is not evidence of anything.
 */
contract QuoteAssetScreen is Script, StdCheats {
    /// @dev The canonical ERC-1820 registry. Same address on every chain, by construction.
    address public constant ERC1820 = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
    bytes32 public constant ERC777_TOKEN = keccak256(abi.encodePacked("ERC777Token"));
    bytes32 public constant ERC777_TOKENS_SENDER = keccak256(abi.encodePacked("ERC777TokensSender"));
    bytes32 public constant ERC777_TOKENS_RECIPIENT = keccak256(abi.encodePacked("ERC777TokensRecipient"));

    /// @dev EIP-1967. Read directly rather than through a getter, because a proxy that hides its
    ///      implementation is exactly the one worth knowing about.
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    /// @dev `keccak256("org.zeppelinos.proxy.implementation")`. See `WatchQuoteAssets.s.sol` for why
    ///      omitting it made the largest registered quote asset read as non-upgradeable.
    bytes32 private constant ZOS_IMPL_SLOT = 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;

    struct Report {
        bool ok;
        address token;
        bool isNative;
        bool isContract;
        bool hasDecimals;
        uint8 decimals;
        bool isProxy;
        address implementation;
        bool erc1820Present;
        bool erc1820Synthesised;
        bool declaresErc777;
        bool senderHookRegistered;
        bool funded;
        bool pullReverted;
        bool payerCallback;
        bytes4 payerSelector;
        bool receiverCallback;
        bytes4 receiverSelector;
        uint256 asked;
        uint256 arrived;
        uint256 debited;
        bool approveNoReturn;
        bool approveReturnsFalse;
        bool approveNonZeroReverts;
        bool transferNoReturn;
        bool rebases;
    }

    string[] public refusals;
    string[] public warnings;

    function refusalCount() external view returns (uint256) {
        return refusals.length;
    }

    function warningCount() external view returns (uint256) {
        return warnings.length;
    }

    /// @dev External so the caller can `try` it: `deal` walks storage slots looking for the balance
    ///      mapping and reverts when it cannot find one. A token the screen cannot fund is a token
    ///      the screen cannot make any claim about, which is a refusal and not a pass.
    function fund(address token, address to, uint256 amount) external {
        deal(token, to, amount);
    }

    /**
     * @notice Is this asset safe to hand to `QuoteRegistry.register`?
     * @dev Not a view: it deploys probes, moves balances and warps the clock on the local fork.
     */
    function screen(address token) external returns (Report memory r) {
        delete refusals;
        delete warnings;

        r.token = token;

        // The native asset is not a token. It has no `transferFrom`, no hooks and no code to call
        // anybody back with, and the registry hard-codes its 18 decimals rather than asking.
        if (token == address(0)) {
            r.isNative = true;
            r.isContract = true;
            r.hasDecimals = true;
            r.decimals = 18;
            r.ok = true;
            return r;
        }

        r.isContract = token.code.length > 0;
        if (!r.isContract) {
            refusals.push("not a contract: nothing at this address, or an EOA");
            r.ok = false;
            return r; // Every probe below would be reading from an empty account.
        }

        _screenMetadata(token, r);
        _screenProxy(token, r);
        _screen1820(token, r);
        _screenTransfer(token, r);

        r.ok = refusals.length == 0;
    }

    // --------------------------------------------------------------- what the registry already asks

    function _screenMetadata(address token, Report memory r) private {
        try IErc20Probeable(token).decimals() returns (uint8 d) {
            r.hasDecimals = true;
            r.decimals = d;
        } catch {
            refusals.push("decimals() does not answer: QuoteRegistry.register would revert on this");
        }
        if (r.hasDecimals && r.decimals > 18) {
            warnings.push("decimals() > 18: every quote target and every UI figure is in raw units");
        }
        try IErc20Probeable(token).totalSupply() returns (uint256) {}
        catch {
            refusals.push("totalSupply() does not answer: this is not an ERC-20");
        }
    }

    function _screenProxy(address token, Report memory r) private {
        address impl = address(uint160(uint256(vm.load(token, IMPL_SLOT))));
        // The pre-1967 zeppelinOS slot, before the beacon: Circle's `FiatTokenProxy` (USDC) uses it
        // and reads as a non-proxy through the 1967 slots alone. See `WatchQuoteAssets.s.sol`.
        if (impl == address(0)) impl = address(uint160(uint256(vm.load(token, ZOS_IMPL_SLOT))));
        if (impl == address(0)) impl = address(uint160(uint256(vm.load(token, BEACON_SLOT))));
        if (impl != address(0)) {
            r.isProxy = true;
            r.implementation = impl;
            warnings.push(
                "upgradeable (EIP-1967): this screen judges the bytecode deployed TODAY, and whoever holds the upgrade key can add a transfer hook to it tomorrow"
            );
        }
    }

    // ----------------------------------------------------------------- the second, cheaper signal

    function _screen1820(address token, Report memory r) private {
        r.erc1820Present = ERC1820.code.length > 0;
        if (!r.erc1820Present) {
            // Synthesised rather than skipped. See MiniErc1820: the canonical deployment is keyless
            // and can land on this chain at any time, so its absence is a fact about the week and
            // not about the asset.
            vm.etch(ERC1820, address(new MiniErc1820()).code);
            r.erc1820Synthesised = true;
            warnings.push(
                "no ERC-1820 registry on this chain: one was synthesised for the probe, because the canonical deployment is keyless and anyone may relay it here"
            );
        }
        address impl = IErc1820(ERC1820).getInterfaceImplementer(token, ERC777_TOKEN);
        if (impl != address(0)) {
            r.declaresErc777 = true;
            refusals.push("declares ERC777Token through ERC-1820: the standard MANDATES a tokensToSend callback to the payer");
        }
    }

    // ----------------------------------------------------- the probe, which is the finding itself

    function _screenTransfer(address token, Report memory r) private {
        Probe payer = new Probe();
        Probe puller = new Probe();
        Probe receiver = new Probe();

        // The payer opts itself in exactly as an ERC-777 sender must; the receiver likewise, since
        // a compliant ERC-777 REVERTS on a contract recipient that has not.
        r.senderHookRegistered = payer.register1820(ERC1820, ERC777_TOKENS_SENDER);
        receiver.register1820(ERC1820, ERC777_TOKENS_RECIPIENT);

        uint256 amount = r.hasDecimals && r.decimals <= 30 ? 10 ** uint256(r.decimals) : 1e18;
        if (amount < 10_000) amount = 10_000; // A 1% fee on nine units rounds to nothing.
        r.asked = amount;

        try this.fund(token, address(payer), amount * 4) {
            r.funded = _balanceOf(token, address(payer)) >= amount;
        } catch {
            r.funded = false;
        }
        if (!r.funded) {
            refusals.push(
                "could not give the probe a balance: the screen could not run a transfer at all and therefore vouches for nothing"
            );
            return;
        }

        _screenApprove(token, payer, address(puller), amount, r);
        _screenPull(token, payer, puller, receiver, amount, r);
        _screenTransferReturn(token, payer, address(receiver), r);
        _screenRebase(token, address(receiver), r);
    }

    /// @dev Return-value conformance on `approve`, plus the USDT shape.
    function _screenApprove(address token, Probe payer, address spender, uint256 amount, Report memory r) private {
        (bool ok, bytes memory ret) = payer.callToken(token, abi.encodeWithSignature("approve(address,uint256)", spender, 1));
        if (ok && ret.length == 0) {
            r.approveNoReturn = true;
            refusals.push("approve() returns no value: this is not a conforming ERC-20 and not every consumer of the registry is SafeERC20");
        } else if (ok && ret.length >= 32 && abi.decode(ret, (bool)) == false) {
            r.approveReturnsFalse = true;
            refusals.push("approve() returned false rather than reverting");
        } else if (!ok) {
            refusals.push("approve() reverted for a plain contract holder");
        }

        // Non-zero to non-zero, which is where USDT reverts.
        (bool ok2,) = payer.callToken(token, abi.encodeWithSignature("approve(address,uint256)", spender, amount * 4));
        if (!ok2) {
            r.approveNonZeroReverts = true;
            warnings.push(
                "approve() reverts from a non-zero allowance to another non-zero allowance (the USDT shape): every integration must zero it first"
            );
            payer.callToken(token, abi.encodeWithSignature("approve(address,uint256)", spender, 0));
            payer.callToken(token, abi.encodeWithSignature("approve(address,uint256)", spender, amount * 4));
        }
    }

    /**
     * @dev The transfer that matters, shaped exactly like `DokuFactory._firstBuy`: a third party
     *      (`puller`, the factory) moves `amount` from `payer` (the creator) to `receiver` (the
     *      curve). Two questions are asked of it — did the payer's own code run, and did the number
     *      that arrived equal the number that was asked for.
     */
    function _screenPull(address token, Probe payer, Probe puller, Probe receiver, uint256 amount, Report memory r)
        private
    {
        payer.reset();
        receiver.reset();

        uint256 payerBefore = _balanceOf(token, address(payer));
        uint256 receiverBefore = _balanceOf(token, address(receiver));

        (bool ok,) = puller.callToken(
            token, abi.encodeWithSignature("transferFrom(address,address,uint256)", address(payer), address(receiver), amount)
        );

        r.payerCallback = payer.called();
        r.payerSelector = payer.selector();
        r.receiverCallback = receiver.called();
        r.receiverSelector = receiver.selector();

        if (r.payerCallback) {
            refusals.push(
                "THE FINDING: the payer's own code was re-entered during transferFrom. In DokuFactory._firstBuy the payer is the launch creator and the two balance reads are open around this call, so the creator can buy on the new curve mid-transfer and have that buy booked twice"
            );
        }
        if (r.receiverCallback) {
            refusals.push(
                "the recipient's code was called during transferFrom: the recipient of every buy is the BondingCurve, and a token that can call it mid-transfer is the same class of hazard"
            );
        }

        if (!ok) {
            r.pullReverted = true;
            refusals.push(
                "transferFrom reverted between two ordinary contract holders: this token refuses contract counterparties or demands a callback interface the probe does not implement, and a BondingCurve is a contract"
            );
            return;
        }

        r.arrived = _balanceOf(token, address(receiver)) - receiverBefore;
        r.debited = payerBefore - _balanceOf(token, address(payer));

        if (r.arrived != amount) {
            refusals.push(
                r.arrived < amount
                    ? "fee on transfer: less arrived than was sent"
                    : "more arrived than was sent (a reflection or rebasing token)"
            );
        }
        if (r.debited != amount) {
            refusals.push("the payer was debited an amount other than the one transferred");
        }
    }

    function _screenTransferReturn(address token, Probe payer, address to, Report memory r) private {
        (bool ok, bytes memory ret) = payer.callToken(token, abi.encodeWithSignature("transfer(address,uint256)", to, 1));
        if (ok && ret.length == 0) {
            r.transferNoReturn = true;
            refusals.push("transfer() returns no value: this is not a conforming ERC-20");
        } else if (ok && ret.length >= 32 && abi.decode(ret, (bool)) == false) {
            refusals.push("transfer() returned false rather than reverting");
        }
    }

    /**
     * @dev A balance that moves on its own. The curve's whole accounting is `quoteRaised` measured
     *      against `balanceOf(curve)`; a balance that shrinks without a transfer strands the last
     *      seller, and one that grows is somebody else's money the curve will pay out.
     *
     *      Weak by construction and deliberately so — see the runbook. It catches a token that
     *      accrues with the clock; it cannot catch one that only moves when an operator calls
     *      `rebase()`.
     */
    function _screenRebase(address token, address who, Report memory r) private {
        uint256 before = _balanceOf(token, who);
        uint256 t = vm.getBlockTimestamp();
        uint256 b = vm.getBlockNumber();
        vm.warp(t + 30 days);
        vm.roll(b + 1);
        uint256 later = _balanceOf(token, who);
        vm.warp(t);
        vm.roll(b);
        if (later != before) {
            r.rebases = true;
            refusals.push("balanceOf moved with no transfer: this token rebases, and the curve's balance identity cannot hold against it");
        }
    }

    function _balanceOf(address token, address who) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }
}

// ---------------------------------------------------------------------------------- the entrypoint

/// @notice `forge script` front end. Prints the report and REVERTS on a refusal so that the exit
///         code gates whatever ran it.
contract ScreenQuoteAsset is Script {
    error DoNotRegister(address asset, string firstReason);

    function run() external {
        run(vm.envAddress("QUOTE_ASSET"));
    }

    function run(address asset) public {
        QuoteAssetScreen s = new QuoteAssetScreen();
        QuoteAssetScreen.Report memory r = s.screen(asset);

        console2.log("");
        console2.log("=== DOKU quote-asset screen ===");
        console2.log("chain      ", block.chainid);
        console2.log("asset      ", asset);
        if (r.isNative) {
            console2.log("native     ", "yes (MON) - no transferFrom, no hooks, 18 decimals by definition");
        } else {
            console2.log("symbol     ", _symbol(asset));
            console2.log("decimals   ", r.hasDecimals ? vm.toString(uint256(r.decimals)) : "NOT ANSWERED");
            console2.log("proxy      ", r.isProxy ? vm.toString(r.implementation) : "no");
            console2.log("erc1820    ", r.erc1820Present ? "on chain" : (r.erc1820Synthesised ? "absent - synthesised for the probe" : "absent"));
            console2.log("erc777     ", r.declaresErc777 ? "DECLARED" : "not declared");
            console2.log("probe fund ", r.funded ? "ok" : "FAILED");
            console2.log("payer cb   ", r.payerCallback ? _sel(r.payerSelector) : "none");
            console2.log("receiver cb", r.receiverCallback ? _sel(r.receiverSelector) : "none");
            console2.log("asked      ", r.asked);
            console2.log("arrived    ", r.arrived);
            console2.log("debited    ", r.debited);
        }

        console2.log("");
        uint256 w = s.warningCount();
        for (uint256 i; i < w; ++i) {
            console2.log("WARNING:", s.warnings(i));
        }
        uint256 n = s.refusalCount();
        for (uint256 i; i < n; ++i) {
            console2.log("REFUSED:", s.refusals(i));
        }

        console2.log("");
        if (r.ok) {
            console2.log("VERDICT: SAFE TO REGISTER");
            console2.log("");
            console2.log("Read the warnings above before you act on that. And note what this cannot see:");
            console2.log("  a proxy can grow a transfer hook after today; a blocklist can freeze a live curve;");
            console2.log("  an operator-triggered rebase does not move on a clock. docs/doku/deployments.md");
        } else {
            console2.log("VERDICT: DO NOT REGISTER");
            console2.log("");
            console2.log("Nothing about this is retroactive. If this asset is ALREADY registered, disabling it");
            console2.log("stops the next launch and cannot reach a market that exists. Read the runbook.");
            revert DoNotRegister(asset, s.refusals(0));
        }
    }

    function _symbol(address token) private view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        if (!ok || ret.length == 0) return "(no symbol)";
        if (ret.length == 32) return string(abi.encodePacked(ret)); // bytes32 symbol, MKR-style
        return abi.decode(ret, (string));
    }

    function _sel(bytes4 s) private pure returns (string memory) {
        return string(abi.encodePacked("YES via ", _hex(s)));
    }

    function _hex(bytes4 s) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(10);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < 4; ++i) {
            out[2 + i * 2] = alphabet[uint8(s[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(s[i]) & 0x0f];
        }
        return string(out);
    }
}
