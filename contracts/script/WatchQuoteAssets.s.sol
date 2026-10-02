// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/**
 * WATCH THE ASSETS THAT ARE ALREADY REGISTERED.
 *
 * `script/ScreenQuoteAsset.s.sol` answers one question — is this asset safe to register — and it
 * answers it about a block. That is the whole of its honesty and the whole of its limit. Four of
 * the seven assets registered on generation 3 are EIP-1967 proxies, and the keys behind them were
 * read off Monad mainnet rather than assumed (block 103,694,467):
 *
 *     USDT0  0xe7cd86e1…C82D   impl 0x779Ded0c…3736   admin 0xB8cE59fC…5EBB  -> Safe 3-of-5
 *     XAUt0  0x01bFF417…1071   impl 0x779Ded0c…3736   admin 0xB8cE59fC…5EBB  -> the SAME Safe
 *     cbBTC  0xd18B7EC5…414b   impl 0xd1611e6E…E6F9   admin 0x035b83FD…51a4 -> TimelockController,
 *                                                        minDelay 10800s (3 hours)
 *     WETH   0xEE8c0E9f…1242   impl 0x7e0AF7c9…C51D   admin 0, and the implementation exposes no
 *                                                        upgrade entrypoint at all
 *
 * One `upgradeTo` from any of those keys to an implementation with a transfer hook, and
 * `DokuFactory._firstBuy`'s double-book becomes live on every market launched in that asset from
 * that block on. The factory is immutable and there is no on-chain event DOKU can see: the upgrade
 * is an event on the TOKEN, in a contract nobody here indexes.
 *
 * The three shapes above are three different amounts of warning, and that is the reason this file
 * probes the key as well as the code:
 *
 *   cbBTC's timelock cannot execute an upgrade it has not scheduled, and the schedule is a public
 *   log three hours ahead. That is a response window.
 *
 *   USDT0 and XAUt0 — two live assets behind ONE 3-of-5 — collect their signatures off chain. No
 *   queue, no delay, no proposal event; the first thing on chain is the transaction that has
 *   already done it. For those two this file reports after the fact, and no design could do better
 *   from chain state alone.
 *
 *   WETH cannot be upgraded at all today, which is only worth knowing because the alarm is if that
 *   ever stops being true.
 *
 * So this is the other half of the control. The screen is the door; this is the window that gets
 * looked at afterwards, on a schedule. It records, per asset:
 *
 *   - the runtime codehash of the asset itself — a contract that GAINS a proxy is also a change,
 *     which is why a non-proxy's zeroes are recorded rather than skipped;
 *   - the EIP-1967 implementation, beacon and admin slots, read raw. Read raw rather than through
 *     `implementation()` because a proxy that hides its getter is exactly the one worth knowing
 *     about, and because the admin slot moving means the UPGRADE KEY moved, which is a change of
 *     who can arm the finding tomorrow;
 *   - the runtime codehash of that implementation — the thing that actually executes;
 *   - what `QuoteRegistry` currently says about the asset, so a registration that never went
 *     through the screen is caught by the same run;
 *   - WHO CAN PERFORM THAT UPGRADE, walked two hops from the admin or beacon slot and classified by
 *     what the terminal address answers. That is a strictly earlier signal than the upgrade: a key
 *     changing hands, a signer being swapped, or a timelock delay being shortened all happen before
 *     the upgrade somebody is preparing to make, and none of them move a single field of the code
 *     observation above. `test_theKeyChangingHandsMovesNothingElseAndIsTheEarlierSignal` is that
 *     claim.
 *
 * The engine is separated from the entrypoint for the same reason `QuoteAssetScreen` is: the tests
 * drive exactly this contract, so the tested path and the scheduled path are one path.
 *
 *   forge script script/WatchQuoteAssets.s.sol --sig 'run(address,address[])' <registry> '[0xA,0xB]'
 *
 * or, with the chain-id guard, the baseline diff and the re-screen,
 * `script/watch-quote-assets.sh mainnet`. Nothing is broadcast and no key is read.
 */

interface IQuoteRegistryView {
    function assets(address) external view returns (bool enabled, uint8 decimals, uint256 quoteTarget);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
}

/// @notice The engine. Pure observation: every function here is `view` and nothing is written.
contract QuoteAssetWatch is Script {
    /// @dev EIP-1967. `keccak256("eip1967.proxy.<x>") - 1`, asserted against that derivation in
    ///      test/audit/WatchQuoteAssets.t.sol rather than trusted as a pasted literal.
    bytes32 public constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 public constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    bytes32 public constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    /**
     * The PRE-1967 zeppelinOS slots, and they are not optional trivia.
     *
     * `keccak256("org.zeppelinos.proxy.implementation")` and `…admin`. OpenZeppelin used these
     * before EIP-1967 standardised the `-1`-offset scheme above, and Circle's `FiatTokenProxy` —
     * which is what USDC is, on Monad as everywhere else — was deployed against them and still uses
     * them.
     *
     * Reading only the 1967 slots made USDC look like a PLAIN ERC-20 with no upgrade path at all,
     * and that is how it was recorded in `deployments/mainnet.quote-assets.json`. It is a proxy,
     * its admin is a single externally owned key, and there is no timelock and no multisig between
     * that key and a new implementation. The largest quote asset on the protocol was therefore the
     * one asset this monitor could not see an upgrade coming for — while reporting
     * `warning: no-upgrade-path`, which is worse than reporting nothing.
     *
     * A false negative from a monitor is the failure mode worth spending code on, because it is
     * indistinguishable from safety right up until it is not.
     */
    bytes32 public constant ZOS_IMPL_SLOT = 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3;
    bytes32 public constant ZOS_ADMIN_SLOT = 0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b;

    /// @dev The 1967 slot if the asset uses it, else the zeppelinOS one. Checked in that order
    ///      because 1967 is what anything deployed since 2019 uses; the fallback is for the assets
    ///      that predate it and never migrated.
    function _implSlotAddress(address asset) internal view returns (address a) {
        a = _slotAddress(asset, IMPL_SLOT);
        if (a == address(0)) a = _slotAddress(asset, ZOS_IMPL_SLOT);
    }

    function _adminSlotAddress(address asset) internal view returns (address a) {
        a = _slotAddress(asset, ADMIN_SLOT);
        if (a == address(0)) a = _slotAddress(asset, ZOS_ADMIN_SLOT);
    }

    struct Observation {
        address asset;
        bool isContract;
        /// @dev `bytes32(0)` when there is no code, NOT `keccak256("")`. EXTCODEHASH answers one or
        ///      the other depending on whether the account exists at all, which is a distinction
        ///      about gas accounting and not about behaviour — and a monitor that alarmed on it
        ///      would be alarming on somebody sending dust to the native address.
        bytes32 codehash;
        address implementation;
        address beacon;
        address admin;
        bool implIsContract;
        bytes32 implCodehash;
        bool registered;
        bool enabled;
        uint8 decimals;
        uint256 quoteTarget;
    }

    function observe(address registry, address asset) public view returns (Observation memory o) {
        o.asset = asset;
        o.isContract = asset.code.length > 0;
        o.codehash = o.isContract ? asset.codehash : bytes32(0);

        // Raw slot reads. An address with no code has no storage, so these come back zero for the
        // native asset and for an EOA — which is the answer that gets recorded, because the
        // baseline has to be able to say "this was not a proxy" and notice when that stops holding.
        o.implementation = _implSlotAddress(asset);
        o.beacon = _slotAddress(asset, BEACON_SLOT);
        o.admin = _adminSlotAddress(asset);

        // A beacon proxy's code is behind the beacon's `implementation()`, one hop further than a
        // slot read reaches. The beacon ADDRESS is what is baselined for that shape, and a beacon
        // that repoints is caught by the beacon's own codehash only if it is the beacon that
        // changed — so a beacon proxy also gets its beacon's codehash recorded here, under
        // `implCodehash`, and the re-screen is what settles what the change means.
        address behind = o.implementation != address(0) ? o.implementation : o.beacon;
        o.implIsContract = behind != address(0) && behind.code.length > 0;
        o.implCodehash = o.implIsContract ? behind.codehash : bytes32(0);

        (bool enabled_, uint8 decimals_, uint256 target_) = IQuoteRegistryView(registry).assets(asset);
        o.registered = target_ != 0; // `quoteTarget == 0` is the registry's own "never registered".
        o.enabled = enabled_;
        o.decimals = decimals_;
        o.quoteTarget = target_;
    }

    function _slotAddress(address who, bytes32 slot) private view returns (address) {
        return address(uint160(uint256(vm.load(who, slot))));
    }

    /**
     * ------------------------------------------------------------------------------- the key
     *
     * WHO CAN UPGRADE THIS ASSET, read off the chain rather than asserted in a comment.
     *
     * `observe` records WHAT the proxy points at. This records WHO can move it, because the two
     * facts have very different half-lives. The implementation moves at the last possible moment —
     * by the time it has moved, every market launched in that asset from that block on is already
     * exposed. The key moves rarely, and when it moves it moves FIRST. It is the only thing that
     * reliably happens before an upgrade which a monitor can see for free.
     *
     * The walk is two hops, because that is the shape the four live proxies actually have:
     *
     *     proxy --(EIP-1967 admin slot)--> ProxyAdmin --(owner())--> Safe or TimelockController
     *
     * and it starts from the beacon slot instead when the admin slot is empty and a beacon is set,
     * because a beacon proxy's upgrade key is the beacon's owner. Each hop is a `staticcall` that
     * is allowed to fail: an address that does not answer `owner()` is not a failure of the probe,
     * it is the answer, and it is recorded as such.
     *
     * The terminal address is then classified by what it ANSWERS, not by what it is called:
     *
     *   timelock  `getMinDelay()` answers  -> an upgrade must be SCHEDULED on chain before it can
     *                                         execute, and `minDelay` is literally how long the
     *                                         response window is. The only shape that warns.
     *   safe      `getThreshold()` answers -> m-of-n. Signatures are collected OFF chain and the
     *                                         first on-chain trace is the transaction that has
     *                                         already done it. No warning; say so rather than
     *                                         imply a cover that is not there.
     *   eoa       no code                  -> one key, no quorum, no delay, no warning.
     *   ownable   `owner()` answers        -> a hop that was not followed. Recorded, so the gap is
     *                                         visible rather than silently classified as terminal.
     *   contract  code, none of the above  -> unclassified. Also recorded rather than called an EOA.
     *
     * `implUpgradeable` is the answer for the shape WETH has: an EIP-1967 proxy whose admin slot is
     * zero. The key there is not missing — it is either inside the implementation (UUPS) or it does
     * not exist at all, and those are opposite facts. Which one holds is decided by looking for
     * `upgradeTo(address)`, `upgradeToAndCall(address,bytes)` and `proxiableUUID()` in the
     * implementation's runtime code. A byte scan rather than a call, because a UUPS `proxiableUUID`
     * carries `notDelegated` and REVERTS through the proxy — so calling it cannot tell "there is no
     * upgrade path" apart from "the upgrade path is there and declining to identify itself".
     */
    struct Authority {
        address asset;
        /// @dev Where the walk started, and from which slot. `none` when the asset is not a proxy.
        address root;
        string rootSlot;
        bytes32 rootCodehash;
        string rootKind;
        /// @dev `root.owner()`, when it answers. Zero otherwise, which is itself the answer.
        address key;
        bytes32 keyCodehash;
        string keyKind;
        /// @dev Of whichever hop turned out to be terminal. Zero when that hop is not that shape.
        uint256 minDelay;
        uint256 threshold;
        uint256 signers;
        /// @dev The signer SET as one field, so swapping a signer out is one comparison and not n.
        bytes32 signersHash;
        bool implUpgradeable;
        /// @dev What advance warning this asset can give. `timelock`, `none`, `no-upgrade-path`,
        ///      or `unknown` — never silence.
        string warning;
    }

    /// @dev `upgradeTo(address)`, `upgradeToAndCall(address,bytes)`, `proxiableUUID()`.
    bytes4 public constant UPGRADE_TO = 0x3659cfe6;
    bytes4 public constant UPGRADE_TO_AND_CALL = 0x4f1ef286;
    bytes4 public constant PROXIABLE_UUID = 0x52d1902d;

    function authority(address asset) public view returns (Authority memory a) {
        a.asset = asset;

        address admin_ = _adminSlotAddress(asset);
        address beacon_ = _slotAddress(asset, BEACON_SLOT);
        if (admin_ != address(0)) {
            a.root = admin_;
            a.rootSlot = "admin";
        } else if (beacon_ != address(0)) {
            // A beacon proxy has no admin slot; the key is whoever owns the beacon, so the same two
            // hops applied from the beacon land on the same kind of answer.
            a.root = beacon_;
            a.rootSlot = "beacon";
        } else {
            a.rootSlot = "none";
        }

        // Only meaningful when there is no admin, but recorded always: an implementation that GAINS
        // an upgrade entrypoint is a change of what this asset can become.
        address impl_ = _implSlotAddress(asset);
        address behind = impl_ != address(0) ? impl_ : beacon_;
        a.implUpgradeable = behind != address(0) && _exposesAnUpgrade(behind);

        uint256 minDelay_;
        uint256 threshold_;
        uint256 signers_;
        bytes32 signersHash_;

        if (a.root == address(0)) {
            a.rootKind = "none";
            a.keyKind = "none";
            a.warning = a.implUpgradeable ? "unknown" : "no-upgrade-path";
            return a;
        }

        a.rootCodehash = a.root.code.length > 0 ? a.root.codehash : bytes32(0);
        (a.rootKind, minDelay_, threshold_, signers_, signersHash_) = _classify(a.root);

        if (keccak256(bytes(a.rootKind)) == keccak256("ownable")) {
            (bool ok, address owner_) = _callAddress(a.root, abi.encodeWithSignature("owner()"));
            if (ok && owner_ != address(0)) {
                a.key = owner_;
                a.keyCodehash = owner_.code.length > 0 ? owner_.codehash : bytes32(0);
                (a.keyKind, minDelay_, threshold_, signers_, signersHash_) = _classify(owner_);
            } else {
                a.keyKind = "none";
            }
        } else {
            a.keyKind = "none";
        }

        a.minDelay = minDelay_;
        a.threshold = threshold_;
        a.signers = signers_;
        a.signersHash = signersHash_;

        string memory terminal = a.key == address(0) ? a.rootKind : a.keyKind;
        a.warning = keccak256(bytes(terminal)) == keccak256("timelock") ? "timelock" : "none";
    }

    function _classify(address who)
        private
        view
        returns (string memory kind, uint256 minDelay, uint256 threshold, uint256 signers, bytes32 signersHash)
    {
        if (who == address(0)) return ("none", 0, 0, 0, bytes32(0));
        if (who.code.length == 0) return ("eoa", 0, 0, 0, bytes32(0));

        (bool isTimelock, uint256 delay) = _callUint(who, abi.encodeWithSignature("getMinDelay()"));
        if (isTimelock) return ("timelock", delay, 0, 0, bytes32(0));

        (bool isSafe, uint256 quorum) = _callUint(who, abi.encodeWithSignature("getThreshold()"));
        if (isSafe) {
            (bool gotOwners, address[] memory owners) = _callAddresses(who, abi.encodeWithSignature("getOwners()"));
            return ("safe", 0, quorum, gotOwners ? owners.length : 0, gotOwners ? keccak256(abi.encode(owners)) : bytes32(0));
        }

        (bool isOwnable,) = _callAddress(who, abi.encodeWithSignature("owner()"));
        if (isOwnable) return ("ownable", 0, 0, 0, bytes32(0));

        return ("contract", 0, 0, 0, bytes32(0));
    }

    /// @dev A word of return data or nothing. An empty successful return — which is what a proxy
    ///      with a permissive fallback answers to a selector it has never heard of — is NOT taken
    ///      as an answer, because taking it as one would classify every such proxy as a timelock
    ///      with a zero delay: a monitor claiming warning it does not have.
    function _callUint(address who, bytes memory data) private view returns (bool, uint256) {
        (bool ok, bytes memory out) = who.staticcall(data);
        if (!ok || out.length < 32) return (false, 0);
        return (true, abi.decode(out, (uint256)));
    }

    function _callAddress(address who, bytes memory data) private view returns (bool, address) {
        (bool ok, uint256 word) = _callUint(who, data);
        if (!ok || word > type(uint160).max) return (false, address(0));
        return (true, address(uint160(word)));
    }

    function _callAddresses(address who, bytes memory data) private view returns (bool, address[] memory) {
        (bool ok, bytes memory out) = who.staticcall(data);
        if (!ok || out.length < 64) return (false, new address[](0));
        // A malformed answer must not revert the whole observation; it is one asset's field.
        try this.decodeAddresses(out) returns (address[] memory owners) {
            return (true, owners);
        } catch {
            return (false, new address[](0));
        }
    }

    /// @dev `external` only so the decode above can be wrapped in `try`. Never called otherwise.
    function decodeAddresses(bytes memory out) external pure returns (address[] memory) {
        return abi.decode(out, (address[]));
    }

    function _exposesAnUpgrade(address who) private view returns (bool) {
        bytes memory code = who.code;
        return _hasSelector(code, UPGRADE_TO) || _hasSelector(code, UPGRADE_TO_AND_CALL)
            || _hasSelector(code, PROXIABLE_UUID);
    }

    /// @dev The selector as a literal in the dispatcher. A false POSITIVE here is a four-byte
    ///      coincidence inside some other constant, which costs a look; a false NEGATIVE would be
    ///      the monitor stating that an upgradeable token cannot be upgraded. The asymmetry is the
    ///      reason this errs towards finding one.
    function _hasSelector(bytes memory code, bytes4 selector) private pure returns (bool) {
        if (code.length < 4) return false;
        for (uint256 i; i + 4 <= code.length; ++i) {
            bytes4 window;
            assembly {
                window := and(mload(add(add(code, 0x20), i)), 0xffffffff00000000000000000000000000000000000000000000000000000000)
            }
            if (window == selector) return true;
        }
        return false;
    }
}

/// @notice `forge script` front end. Prints one `WATCH` line per asset for the wrapper to diff, and
///         a terminating `WATCH end` line — because a report that stops halfway must not be
///         mistaken for a report that found nothing.
contract WatchQuoteAssets is Script {
    function run(address registry, address[] memory watched) public {
        QuoteAssetWatch w = new QuoteAssetWatch();

        // Reverts if the address is not a QuoteRegistry, which is the correct outcome: a monitor
        // pointed at the wrong contract must fail, not report.
        address owner_ = IQuoteRegistryView(registry).owner();
        address pending_ = IQuoteRegistryView(registry).pendingOwner();

        console2.log(
            string.concat(
                "WATCH head chain=",
                vm.toString(block.chainid),
                " block=",
                vm.toString(block.number),
                " registry=",
                _checksum(registry),
                " owner=",
                _checksum(owner_),
                " pendingOwner=",
                _checksum(pending_)
            )
        );

        for (uint256 i; i < watched.length; ++i) {
            QuoteAssetWatch.Observation memory o = w.observe(registry, watched[i]);
            console2.log(
                string.concat(
                    "WATCH asset=",
                    _checksum(o.asset),
                    " contract=",
                    o.isContract ? "1" : "0",
                    " codehash=",
                    vm.toString(o.codehash),
                    " impl=",
                    _checksum(o.implementation),
                    " beacon=",
                    _checksum(o.beacon),
                    " admin=",
                    _checksum(o.admin),
                    _tail(o)
                )
            );
            _logAuthority(w.authority(watched[i]));
        }

        console2.log(string.concat("WATCH end assets=", vm.toString(watched.length)));
    }

    /// @dev One line per asset saying who can upgrade it and whether that shape gives any warning
    ///      before it does. Printed alongside the observation rather than in a separate pass, so a
    ///      run can never report the code of an asset without reporting who owns that code.
    function _logAuthority(QuoteAssetWatch.Authority memory a) private pure {
        console2.log(
            string.concat(
                "WATCH auth=",
                _checksum(a.asset),
                " root=",
                _checksum(a.root),
                " rootSlot=",
                a.rootSlot,
                " rootCodehash=",
                vm.toString(a.rootCodehash),
                " rootKind=",
                a.rootKind,
                _authTail(a)
            )
        );
    }

    /// @dev Split for the same reason `_tail` is: `string.concat` of this many operands blows the
    ///      stack.
    function _authTail(QuoteAssetWatch.Authority memory a) private pure returns (string memory) {
        return string.concat(
            " key=",
            _checksum(a.key),
            " keyCodehash=",
            vm.toString(a.keyCodehash),
            " keyKind=",
            a.keyKind,
            " minDelay=",
            vm.toString(a.minDelay),
            " threshold=",
            vm.toString(a.threshold),
            " signers=",
            vm.toString(a.signers),
            " signersHash=",
            vm.toString(a.signersHash),
            " implUpgradeable=",
            a.implUpgradeable ? "1" : "0",
            " warning=",
            a.warning
        );
    }


    /**
     * @dev EIP-55, computed rather than borrowed. `vm.toString(address)` does not produce a
     *      conforming checksum, and these strings are copied straight into a committed baseline
     *      that a human will paste into an explorer — an address that does not round-trip there
     *      wastes the first five minutes of an incident.
     */
    function _checksum(address who) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory lower = new bytes(40);
        uint160 value = uint160(who);
        for (uint256 i; i < 20; ++i) {
            uint8 b = uint8(value >> (8 * (19 - i)));
            lower[i * 2] = alphabet[b >> 4];
            lower[i * 2 + 1] = alphabet[b & 0x0f];
        }
        bytes32 hashed = keccak256(lower);
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i; i < 40; ++i) {
            uint8 nibble = uint8(hashed[i / 2]);
            nibble = i % 2 == 0 ? nibble >> 4 : nibble & 0x0f;
            bytes1 c = lower[i];
            out[i + 2] = (c >= "a" && nibble >= 8) ? bytes1(uint8(c) - 32) : c;
        }
        return string(out);
    }

    /// @dev Split out only because `string.concat` of this many operands blows the stack.
    function _tail(QuoteAssetWatch.Observation memory o) private pure returns (string memory) {
        return string.concat(
            " implCodehash=",
            vm.toString(o.implCodehash),
            " registered=",
            o.registered ? "1" : "0",
            " enabled=",
            o.enabled ? "1" : "0",
            " decimals=",
            vm.toString(uint256(o.decimals)),
            " quoteTarget=",
            vm.toString(o.quoteTarget)
        );
    }
}
