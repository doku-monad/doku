// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

/**
 * THE MONITOR, PROVED AGAINST THE THING IT EXISTS FOR.
 *
 * `screen-quote-asset.sh` answers a question about a block. `watch-quote-assets.sh` exists because
 * four of the seven registered quote assets are EIP-1967 proxies and a block is not a promise: one
 * `upgradeTo` turns a passing asset into a token that calls its payer back inside `transferFrom`,
 * which is what `DokuFactory._firstBuy` double-books. The factory is immutable. There is no event
 * on any DOKU contract when that upgrade happens.
 *
 * So the claim under test is not "the script reads a storage slot". It is the whole chain:
 *
 *   a clean proxy passes the screen and is recorded in a baseline
 *     -> its owner upgrades it to an implementation with a payer callback
 *       -> the fields the baseline compares MOVE, so the monitor fires
 *         -> and the re-screen the monitor then runs REFUSES it,
 *            so the answer is "it changed AND it now calls the payer back".
 *
 * `test_theWholeChain_cleanProxyPasses_thenAnUpgradeMovesItAndTheScreenRefuses` is that claim end
 * to end. Everything above it exists so that a failure says which link broke.
 *
 * Nothing in `src/` is touched. The engines under test are `QuoteAssetWatch` and `QuoteAssetScreen`
 * — the same contracts the two scripts run against a fork, driven here through the same external
 * calls, because a monitor whose test path differs from its scheduled path is not evidence about
 * the scheduled path.
 */

import {Test} from "forge-std/Test.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";

import {QuoteAssetWatch} from "../../script/WatchQuoteAssets.s.sol";
import {QuoteAssetScreen} from "../../script/ScreenQuoteAsset.s.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";

// ==================================================================================== the fixtures

/// @dev A conforming ERC-20, written to sit behind a proxy: no constructor state, so the proxy's
///      storage is the only storage. The control, and what the four live proxies look like today.
contract CleanImpl {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function symbol() external pure returns (string memory) {
        return "CLEAN";
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal virtual {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

interface IPayerHook {
    function onTokenTransfer(address, uint256, bytes calldata) external;
}

/**
 * @dev The same token after an upgrade, with one line added: notify the payer before moving their
 *      balance. Storage layout identical, so this is a drop-in `upgradeTo` and every holder's
 *      balance survives it — which is exactly why it is the realistic shape of this risk and not a
 *      contrived one.
 */
contract HookedImpl is CleanImpl {
    function _move(address from, address to, uint256 value) internal override {
        if (from.code.length > 0) IPayerHook(from).onTokenTransfer(to, value, "");
        super._move(from, to, value);
    }
}

/// @dev A minimal EIP-1967 proxy. The slots are written raw rather than through a library, because
///      raw slots are what the monitor reads and a library that agreed with itself would prove
///      nothing.
contract Erc1967Mock {
    bytes32 private constant IMPL = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant ADMIN = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address implementation_, address admin_) {
        assembly {
            sstore(IMPL, implementation_)
            sstore(ADMIN, admin_)
        }
    }

    /// @notice The one call this whole monitor exists because of.
    function upgradeTo(address implementation_) external {
        _onlyAdmin();
        assembly {
            sstore(IMPL, implementation_)
        }
    }

    function changeAdmin(address admin_) external {
        _onlyAdmin();
        assembly {
            sstore(ADMIN, admin_)
        }
    }

    function _onlyAdmin() private view {
        address admin_;
        assembly {
            admin_ := sload(ADMIN)
        }
        require(msg.sender == admin_, "not admin");
    }

    /// @dev Not payable: these fixtures never hold ether, and a payable fallback with no receive
    ///      warns on every build.
    fallback() external {
        address implementation_;
        assembly {
            implementation_ := sload(IMPL)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation_, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

contract BeaconMock {
    address public implementation;

    constructor(address implementation_) {
        implementation = implementation_;
    }
}

/// @dev Only the beacon slot is set; the monitor must report the asset through it rather than
///      calling it a plain contract.
contract BeaconProxyMock {
    bytes32 private constant BEACON = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;

    constructor(address beacon_) {
        assembly {
            sstore(BEACON, beacon_)
        }
    }

    fallback() external {
        address beacon_;
        assembly {
            beacon_ := sload(BEACON)
        }
        address implementation_ = BeaconMock(beacon_).implementation();
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), implementation_, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}

// -------------------------------------------------------------------------------- the key holders
//
// The four shapes that hold an upgrade key on generation 3, as fixtures. They are deliberately
// minimal: what the probe classifies on is what a contract ANSWERS, so a fixture that answers the
// same things is the same thing as far as the monitor is concerned, and a fixture that inherited a
// real ProxyAdmin would be testing OpenZeppelin rather than the probe.

/// @dev An OZ `ProxyAdmin`: the contract in the EIP-1967 admin slot, owned by somebody else. Both
///      live ProxyAdmins on generation 3 have exactly this surface.
contract OwnableAdminMock {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function transferOwnership(address to) external {
        owner = to;
    }
}

/// @dev The only shape that gives warning. `getMinDelay()` is what identifies it, and the number it
///      returns is the response window.
contract TimelockMock {
    uint256 public delay;

    constructor(uint256 delay_) {
        delay = delay_;
    }

    function getMinDelay() external view returns (uint256) {
        return delay;
    }

    function updateDelay(uint256 delay_) external {
        delay = delay_;
    }
}

/// @dev An m-of-n multisig. It has no queue and emits nothing before it acts; that is the fact the
///      monitor has to record rather than paper over.
contract SafeMock {
    address[] internal signers;
    uint256 internal threshold;

    constructor(address[] memory signers_, uint256 threshold_) {
        signers = signers_;
        threshold = threshold_;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory) {
        return signers;
    }

    function swapSigner(uint256 index, address who) external {
        signers[index] = who;
    }

    function changeThreshold(uint256 threshold_) external {
        threshold = threshold_;
    }
}

/// @dev Answers EVERY selector with a successful empty return — the shape a proxy with a permissive
///      fallback has. If the probe took that as an answer it would read `getMinDelay()` as zero and
///      file this as a timelock with no delay: a monitor claiming a response window that does not
///      exist. The most dangerous possible false positive, so it gets a fixture.
contract PermissiveFallbackMock {
    fallback() external {}
}

/// @dev The UUPS shape: no admin slot, the upgrade lives in the implementation. `proxiableUUID`
///      carries `notDelegated` and reverts through the proxy, which is why the probe scans bytecode
///      instead of calling.
contract UupsImpl is CleanImpl {
    function upgradeTo(address) external {}

    function proxiableUUID() external view returns (bytes32) {
        require(msg.sender == address(0), "notDelegated");
        return bytes32(0);
    }
}

/// @dev A plain, boring, non-proxy ERC-20 — the shape USDC and WBTC actually have on chain.
contract PlainQuoteToken is ERC20 {
    constructor() ERC20("Plain", "PLAIN") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

// ======================================================================================= the tests

contract WatchQuoteAssetsTest is Test {
    QuoteAssetWatch internal watch;
    QuoteRegistry internal registry;

    address internal constant OWNER = address(0xD0C0);
    address internal constant PROXY_ADMIN = address(0xADD1);
    uint256 internal constant TARGET = 8_000_000_000;

    function setUp() public {
        watch = new QuoteAssetWatch();
        registry = new QuoteRegistry(OWNER);
    }

    function _register(address asset) internal {
        vm.prank(OWNER);
        registry.register(asset, TARGET);
    }

    // ------------------------------------------------------------------ the constants themselves

    /// @dev A pasted slot literal that is one hex digit wrong reads zero forever, and zero is
    ///      exactly what a non-proxy answers — so the monitor would report "not upgradeable" about
    ///      every proxy on the chain and never fire. Derived here rather than trusted.
    function test_theEip1967SlotsAreTheOnesTheStandardDerives() public view {
        assertEq(
            watch.IMPL_SLOT(),
            bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1),
            "implementation slot"
        );
        assertEq(watch.BEACON_SLOT(), bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1), "beacon slot");
        assertEq(watch.ADMIN_SLOT(), bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1), "admin slot");
    }

    // -------------------------------------------------------------------------- shapes, recorded

    function test_aPlainErc20IsRecordedAsANonProxyRatherThanSkipped() public {
        PlainQuoteToken token = new PlainQuoteToken();
        _register(address(token));

        QuoteAssetWatch.Observation memory o = watch.observe(address(registry), address(token));

        assertTrue(o.isContract, "has code");
        assertEq(o.codehash, address(token).codehash, "its own codehash is the baselined value");
        assertEq(o.implementation, address(0), "no implementation");
        assertEq(o.beacon, address(0), "no beacon");
        assertEq(o.admin, address(0), "no admin");
        // The zeroes are the point. A baseline that omitted them could not notice the day this
        // address stops answering zero.
        assertEq(o.implCodehash, bytes32(0), "no implementation codehash");
    }

    function test_theNativeAssetIsRecordedRatherThanSkipped() public {
        _register(address(0));

        QuoteAssetWatch.Observation memory o = watch.observe(address(registry), address(0));

        assertFalse(o.isContract, "no code");
        assertEq(o.codehash, bytes32(0), "codehash is zero, not keccak of the empty string");
        assertTrue(o.registered, "registered");
        assertEq(o.decimals, 18, "18 by definition");
    }

    function test_anEip1967ProxyIsReportedThroughItsSlotsAndTheCodeBehindThem() public {
        CleanImpl implementation = new CleanImpl();
        Erc1967Mock proxy = new Erc1967Mock(address(implementation), PROXY_ADMIN);
        _register(address(proxy));

        QuoteAssetWatch.Observation memory o = watch.observe(address(registry), address(proxy));

        assertEq(o.implementation, address(implementation), "implementation slot");
        assertEq(o.admin, PROXY_ADMIN, "admin slot");
        assertTrue(o.implIsContract, "the implementation has code");
        assertEq(o.implCodehash, address(implementation).codehash, "the code that actually executes");
        assertEq(o.codehash, address(proxy).codehash, "and the proxy's own code, separately");
    }

    function test_aBeaconProxyIsReportedThroughItsBeaconSlot() public {
        CleanImpl implementation = new CleanImpl();
        BeaconMock beacon = new BeaconMock(address(implementation));
        BeaconProxyMock proxy = new BeaconProxyMock(address(beacon));
        _register(address(proxy));

        QuoteAssetWatch.Observation memory o = watch.observe(address(registry), address(proxy));

        assertEq(o.implementation, address(0), "no implementation slot on this shape");
        assertEq(o.beacon, address(beacon), "beacon slot");
        assertEq(o.implCodehash, address(beacon).codehash, "the beacon's code stands in for the hop it hides");
    }

    // ------------------------------------------------------------------------- what must be seen

    function test_anUpgradeMovesBothFieldsTheBaselineCompares() public {
        CleanImpl clean = new CleanImpl();
        Erc1967Mock proxy = new Erc1967Mock(address(clean), PROXY_ADMIN);
        _register(address(proxy));

        QuoteAssetWatch.Observation memory before = watch.observe(address(registry), address(proxy));

        HookedImpl hooked = new HookedImpl();
        vm.prank(PROXY_ADMIN);
        proxy.upgradeTo(address(hooked));

        QuoteAssetWatch.Observation memory afterUpgrade = watch.observe(address(registry), address(proxy));

        assertTrue(before.implementation != afterUpgrade.implementation, "implementation moved");
        assertTrue(before.implCodehash != afterUpgrade.implCodehash, "the code behind it moved");
        // And the thing a naive monitor would have watched did NOT move: the token's own address
        // and its own bytecode are identical either side of the upgrade. Watching `codehash` alone
        // would have reported all clear.
        assertEq(before.codehash, afterUpgrade.codehash, "the proxy's own code is unchanged by an upgrade");
        assertEq(afterUpgrade.enabled, true, "and the registry still says it is open for launches");
    }

    function test_theUpgradeKeyChangingHandsIsVisible() public {
        CleanImpl clean = new CleanImpl();
        Erc1967Mock proxy = new Erc1967Mock(address(clean), PROXY_ADMIN);
        _register(address(proxy));

        assertEq(watch.observe(address(registry), address(proxy)).admin, PROXY_ADMIN, "before");

        vm.prank(PROXY_ADMIN);
        proxy.changeAdmin(address(0xBEEF));

        // Nothing about the token's behaviour changed today. Who can change it tomorrow did, and
        // that is a fact about this asset worth waking somebody for.
        assertEq(watch.observe(address(registry), address(proxy)).admin, address(0xBEEF), "after");
    }

    function test_anAddressThatGainsCodeIsAChangeTheBaselineCanSee() public {
        address later = address(0xC0DE);
        _register(address(0)); // native, so the registry is not empty
        QuoteAssetWatch.Observation memory before = watch.observe(address(registry), later);
        assertFalse(before.isContract, "nothing there yet");
        assertEq(before.codehash, bytes32(0), "and nothing recorded");

        vm.etch(later, address(new CleanImpl()).code);

        QuoteAssetWatch.Observation memory afterEtch = watch.observe(address(registry), later);
        assertTrue(afterEtch.isContract, "code appeared");
        assertTrue(afterEtch.codehash != before.codehash, "and the baselined field moved");
    }

    // ------------------------------------------------------------------------- the registry door

    function test_theRegistryStateIsCarriedSoAnUnregisteredAssetIsVisible() public {
        PlainQuoteToken token = new PlainQuoteToken();

        QuoteAssetWatch.Observation memory before = watch.observe(address(registry), address(token));
        assertFalse(before.registered, "quoteTarget == 0 is the registry's own 'never registered'");
        assertEq(before.quoteTarget, 0, "no target");

        _register(address(token));

        QuoteAssetWatch.Observation memory afterRegister = watch.observe(address(registry), address(token));
        assertTrue(afterRegister.registered, "registered");
        assertTrue(afterRegister.enabled, "and enabled immediately, which is what register does");
        assertEq(afterRegister.quoteTarget, TARGET, "target carried");
        assertEq(afterRegister.decimals, 6, "decimals as the registry snapshotted them");
    }

    /// @dev `setEnabled(false)` is the RESPONSE to an alarm, not an alarm. The engine reports it;
    ///      the tier it lands in is `NOTICE_FIELDS` in script/watch-quote-assets.py, and this test
    ///      exists so the field it reads from cannot silently stop being reported.
    function test_disablingAnAssetIsObservedButIsNotACodeChange() public {
        PlainQuoteToken token = new PlainQuoteToken();
        _register(address(token));
        QuoteAssetWatch.Observation memory before = watch.observe(address(registry), address(token));

        vm.prank(OWNER);
        registry.setEnabled(address(token), false);

        QuoteAssetWatch.Observation memory afterDisable = watch.observe(address(registry), address(token));
        assertFalse(afterDisable.enabled, "closed to new launches");
        assertTrue(afterDisable.registered, "still registered - disabling is not deregistering");
        assertEq(afterDisable.codehash, before.codehash, "and nothing about the code moved");
    }

    /// @dev Pointed at something that is not a QuoteRegistry, the engine must fail rather than
    ///      report. A monitor reading zeroes off the wrong address is a monitor that is always
    ///      green.
    function test_observingThroughAnAddressThatIsNotARegistryReverts() public {
        PlainQuoteToken token = new PlainQuoteToken();
        vm.expectRevert();
        watch.observe(address(0xDEAD), address(token));
    }

    // ------------------------------------------------------------------------------- the whole chain

    /**
     * The claim the monitor is for, end to end. Same two engines the two scripts run.
     *
     * Note what the middle of this test proves about the FIRST half of the defence: the screen
     * passed this asset, honestly and correctly, and the pass was worth nothing eleven lines later.
     * That is not a defect in the screen. It is why there has to be something watching afterwards.
     */
    function test_theWholeChain_cleanProxyPasses_thenAnUpgradeMovesItAndTheScreenRefuses() public {
        QuoteAssetScreen screen = new QuoteAssetScreen();

        CleanImpl clean = new CleanImpl();
        Erc1967Mock proxy = new Erc1967Mock(address(clean), PROXY_ADMIN);
        _register(address(proxy));

        // 1. It passes the screen, and is upgradeable — which the screen says out loud and cannot
        //    do anything about.
        QuoteAssetScreen.Report memory first = screen.screen(address(proxy));
        assertTrue(first.ok, "a clean proxy is safe to register today");
        assertFalse(first.payerCallback, "no callback today");
        assertTrue(first.isProxy, "and the screen already knows what it cannot promise");
        assertEq(first.implementation, address(clean), "pointing here");

        // 2. That is what goes into the baseline.
        QuoteAssetWatch.Observation memory baseline = watch.observe(address(registry), address(proxy));

        // 3. One call from the key holder. No DOKU contract emits anything.
        HookedImpl hooked = new HookedImpl();
        vm.prank(PROXY_ADMIN);
        proxy.upgradeTo(address(hooked));

        // 4. The monitor fires: the fields it compares moved.
        QuoteAssetWatch.Observation memory now_ = watch.observe(address(registry), address(proxy));
        assertTrue(baseline.implementation != now_.implementation, "the monitor has something to fire on");
        assertTrue(baseline.implCodehash != now_.implCodehash, "and a second, independent one");

        // 5. And the re-screen says WHAT it became, which is the whole reason the monitor re-screens
        //    rather than only diffing.
        QuoteAssetScreen.Report memory second = screen.screen(address(proxy));
        assertFalse(second.ok, "the same address is now unsafe");
        assertTrue(second.payerCallback, "THE FINDING: the payer's own code runs inside transferFrom");
        assertEq(second.payerSelector, IPayerHook.onTokenTransfer.selector, "through the hook it grew");
    }

    // ================================================================== who can upgrade it, and when
    //
    // Everything above answers "did it change", which is a question that can only be answered after
    // it changed. These answer "who can change it, and will we hear about it first" — the only two
    // questions with any time left in them.

    address[] internal signerFixture;

    function _signers(uint256 n) internal returns (address[] memory) {
        delete signerFixture;
        for (uint256 i; i < n; ++i) signerFixture.push(address(uint160(0x5160 + i)));
        return signerFixture;
    }

    /// @dev Same reasoning as the EIP-1967 slot test. A selector literal that is one nibble wrong is
    ///      never found in any bytecode, so `implUpgradeable` would read false for every UUPS token
    ///      on the chain and the monitor would report "no upgrade path" about assets that have one.
    function test_theUpgradeSelectorsAreTheOnesTheStandardsDerive() public view {
        assertEq(watch.UPGRADE_TO(), bytes4(keccak256("upgradeTo(address)")), "upgradeTo");
        assertEq(watch.UPGRADE_TO_AND_CALL(), bytes4(keccak256("upgradeToAndCall(address,bytes)")), "upgradeToAndCall");
        assertEq(watch.PROXIABLE_UUID(), bytes4(keccak256("proxiableUUID()")), "proxiableUUID");
    }

    function test_theKeyIsFollowedThroughTheProxyAdminToWhoeverOwnsIt() public {
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(0xEEEE));
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(proxyAdmin));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.root, address(proxyAdmin), "the admin slot is where the walk starts");
        assertEq(a.rootSlot, "admin", "and which slot it came from is recorded");
        assertEq(a.rootKind, "ownable", "a ProxyAdmin is not the key, it is the thing the key holds");
        assertEq(a.key, address(0xEEEE), "the key is its owner");
        assertEq(a.keyKind, "eoa", "which here has no code at all");
        assertEq(a.warning, "none", "one key, no quorum, no delay, nothing to see beforehand");
    }

    /// THE MOST VALUABLE FACT IN THE WHOLE MONITOR. A timelock cannot execute an upgrade it has not
    /// scheduled, the schedule is a public log, and `minDelay` is exactly how long there is between
    /// the two. Recording that number is what turns "we found out" into "we found out in time".
    function test_aTimelockKeyIsTheOnlyShapeThatCanWarnAndItsDelayIsRecorded() public {
        TimelockMock timelock = new TimelockMock(3 hours);
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(timelock));
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(proxyAdmin));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.keyKind, "timelock", "classified by what it answers, not by what it is called");
        assertEq(a.minDelay, 10_800, "the response window, in seconds");
        assertEq(a.warning, "timelock", "and the report says so out loud");
    }

    /// @dev The delay being SHORTENED is the quietest possible way to lose the response window: no
    ///      code moves, no key moves, and the monitor would still say all clear tomorrow. It is a
    ///      compared field for that reason.
    function test_shorteningTheTimelockDelayIsItselfAChangeTheBaselineSees() public {
        TimelockMock timelock = new TimelockMock(3 hours);
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(timelock));
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(proxyAdmin));

        QuoteAssetWatch.Authority memory before = watch.authority(address(proxy));
        timelock.updateDelay(1);
        QuoteAssetWatch.Authority memory afterChange = watch.authority(address(proxy));

        assertEq(before.minDelay, 10_800, "three hours");
        assertEq(afterChange.minDelay, 1, "one second");
        assertEq(afterChange.keyKind, before.keyKind, "still a timelock, which is the trap");
        assertEq(afterChange.key, before.key, "and still the same key");
    }

    function test_aMultisigKeyIsRecordedAsGivingNoAdvanceWarningAtAll() public {
        SafeMock safe = new SafeMock(_signers(5), 3);
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(safe));
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(proxyAdmin));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.keyKind, "safe", "m-of-n");
        assertEq(a.threshold, 3, "m");
        assertEq(a.signers, 5, "n");
        // The honest answer, and the one this whole exercise exists to establish. A multisig
        // collects its signatures off chain; the first thing that reaches the chain is the
        // transaction that has already performed the upgrade. There is nothing earlier to watch.
        assertEq(a.warning, "none", "no queue, no delay, no proposal event");
    }

    /// @dev The signer set is hashed into one field so that a swap is one comparison rather than n,
    ///      and so that a swap which keeps the COUNT the same still moves something.
    function test_swappingASignerMovesTheSetEvenThoughTheCountDoesNot() public {
        SafeMock safe = new SafeMock(_signers(5), 3);
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(safe));
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(proxyAdmin));

        QuoteAssetWatch.Authority memory before = watch.authority(address(proxy));
        safe.swapSigner(2, address(0xBADBAD));
        QuoteAssetWatch.Authority memory afterSwap = watch.authority(address(proxy));

        assertEq(afterSwap.signers, before.signers, "still five");
        assertEq(afterSwap.threshold, before.threshold, "still three of them needed");
        assertTrue(afterSwap.signersHash != before.signersHash, "but not the same five");
    }

    /// @dev WETH's shape. An empty admin slot is not a missing answer — it is either "the key is in
    ///      the implementation" or "there is no key", and those are opposite facts about how much
    ///      danger this asset is in. The probe decides which by reading the implementation's code.
    function test_anEmptyAdminSlotOverAnImplementationWithNoUpgradeEntrypointMeansNoUpgradePath() public {
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(0));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.rootSlot, "none", "nothing in the admin slot and no beacon");
        assertFalse(a.implUpgradeable, "and nothing in the code behind it that could move it");
        assertEq(a.warning, "no-upgrade-path", "so there is nothing to warn about, which is an answer");
    }

    function test_anImplementationThatCarriesTheUpgradeItselfIsNotReportedAsSafe() public {
        Erc1967Mock proxy = new Erc1967Mock(address(new UupsImpl()), address(0));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.rootSlot, "none", "the admin slot is empty here too");
        assertTrue(a.implUpgradeable, "but the implementation carries upgradeTo");
        // The difference between this and the test above is the whole point of scanning the code.
        // Both have an empty admin slot; only one of them can be upgraded, and calling that one
        // 'no upgrade path' would be the monitor stating the opposite of the truth.
        assertEq(a.warning, "unknown", "the key is inside the implementation and this probe cannot see it");
    }

    /// @dev The failure mode that would be worst to have: a contract that answers everything
    ///      successfully with nothing, read as a timelock whose delay happens to be zero. The probe
    ///      would then print a response window for an asset that has none.
    function test_aPermissiveFallbackIsNotMistakenForATimelockWithNoDelay() public {
        PermissiveFallbackMock permissive = new PermissiveFallbackMock();
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(permissive));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.rootKind, "contract", "an empty successful return is not an answer");
        assertEq(a.minDelay, 0, "and no delay was invented from it");
        assertEq(a.warning, "none", "so it promises nothing");
    }

    function test_aBeaconProxysKeyIsFollowedFromTheBeaconSlotInstead() public {
        // A beacon proxy has no admin slot at all; whoever owns the beacon can repoint every proxy
        // behind it at once. Starting the walk at the beacon is what makes that visible.
        BeaconMock beacon = new BeaconMock(address(new CleanImpl()));
        BeaconProxyMock proxy = new BeaconProxyMock(address(beacon));

        QuoteAssetWatch.Authority memory a = watch.authority(address(proxy));

        assertEq(a.root, address(beacon), "the walk starts at the beacon");
        assertEq(a.rootSlot, "beacon", "and says so, because it is a different kind of key");
    }

    function test_anAssetWithNoCodeAtAllHasNoKeyAndSaysSo() public view {
        QuoteAssetWatch.Authority memory a = watch.authority(address(0));

        assertEq(a.rootSlot, "none", "the native asset is nobody's proxy");
        assertEq(a.rootKind, "none", "and there is no contract to classify");
        assertEq(a.warning, "no-upgrade-path", "nothing can upgrade it because there is nothing there");
    }

    /**
     * THE CLAIM THIS WHOLE ADDITION IS FOR.
     *
     * `test_theWholeChain_...` above proves the monitor sees the upgrade. It sees it at the last
     * possible moment: by then every market launched in that asset carries the hole, and closing
     * the asset is not retroactive. This is the earlier signal.
     *
     * Handing the key from a timelock to an EOA changes NOTHING about the token today. The
     * implementation is the same, the implementation's code is the same, the proxy's code is the
     * same, the registry still says enabled, and the screen still passes. Every field the original
     * monitor compared is identical either side of this transaction. What changed is that the three
     * hours of warning are gone — and that is the last moment at which anybody could have acted
     * before the upgrade rather than after it.
     */
    function test_theKeyChangingHandsMovesNothingElseAndIsTheEarlierSignal() public {
        TimelockMock timelock = new TimelockMock(3 hours);
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(timelock));
        CleanImpl implementation = new CleanImpl();
        Erc1967Mock proxy = new Erc1967Mock(address(implementation), address(proxyAdmin));
        _register(address(proxy));

        QuoteAssetWatch.Observation memory codeBefore = watch.observe(address(registry), address(proxy));
        QuoteAssetWatch.Authority memory keyBefore = watch.authority(address(proxy));
        assertEq(keyBefore.warning, "timelock", "three hours of warning, before");

        proxyAdmin.transferOwnership(address(0xC0FFEE));

        QuoteAssetWatch.Observation memory codeAfter = watch.observe(address(registry), address(proxy));
        QuoteAssetWatch.Authority memory keyAfter = watch.authority(address(proxy));

        // Not one field the code-level monitor compares has moved.
        assertEq(codeAfter.codehash, codeBefore.codehash, "the proxy's code");
        assertEq(codeAfter.implementation, codeBefore.implementation, "what it points at");
        assertEq(codeAfter.implCodehash, codeBefore.implCodehash, "the code that executes");
        assertEq(codeAfter.admin, codeBefore.admin, "even the EIP-1967 admin slot is unchanged");
        assertTrue(codeAfter.enabled, "and the asset is still open for launches");
        assertTrue(new QuoteAssetScreen().screen(address(proxy)).ok, "and it still passes the screen");

        // And the thing that matters did.
        assertEq(keyAfter.key, address(0xC0FFEE), "the key is held by somebody else now");
        assertEq(keyAfter.keyKind, "eoa", "who is a single private key");
        assertEq(keyAfter.minDelay, 0, "with no delay");
        assertEq(keyAfter.warning, "none", "THE FINDING: the warning is gone before the upgrade is made");
    }

    /// @dev The other half, so this is not a probe that reports a change on everything: a token
    ///      being used does not move any field of its authority record.
    function test_theAuthorityProbeIsNotSimplyFiringOnEverythingEither() public {
        SafeMock safe = new SafeMock(_signers(5), 3);
        OwnableAdminMock proxyAdmin = new OwnableAdminMock(address(safe));
        Erc1967Mock proxy = new Erc1967Mock(address(new CleanImpl()), address(proxyAdmin));
        _register(address(proxy));

        QuoteAssetWatch.Authority memory before = watch.authority(address(proxy));

        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 100_000);
        deal(address(proxy), address(0xF00D), 12_345);
        vm.prank(OWNER);
        registry.setEnabled(address(proxy), false); // the RESPONSE to an alarm is not an alarm

        QuoteAssetWatch.Authority memory afterTime = watch.authority(address(proxy));

        assertEq(afterTime.root, before.root, "root");
        assertEq(afterTime.rootCodehash, before.rootCodehash, "root code");
        assertEq(afterTime.key, before.key, "key");
        assertEq(afterTime.keyCodehash, before.keyCodehash, "key code");
        assertEq(afterTime.keyKind, before.keyKind, "kind");
        assertEq(afterTime.threshold, before.threshold, "threshold");
        assertEq(afterTime.signersHash, before.signersHash, "signer set");
        assertEq(afterTime.warning, before.warning, "and the same promise");
    }

    /// @dev The other half of the same evidence: this pair of engines is not simply refusing and
    ///      alarming about everything. An asset that does not move produces no difference in any
    ///      compared field, and still passes.
    function test_theMonitorIsNotSimplyFiringOnEverything() public {
        CleanImpl clean = new CleanImpl();
        Erc1967Mock proxy = new Erc1967Mock(address(clean), PROXY_ADMIN);
        _register(address(proxy));

        QuoteAssetWatch.Observation memory before = watch.observe(address(registry), address(proxy));

        // Time passes, blocks are mined, balances move — none of which is a change this monitor is
        // allowed to have an opinion about.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 100_000);
        deal(address(proxy), address(0xF00D), 12_345);

        QuoteAssetWatch.Observation memory afterTime = watch.observe(address(registry), address(proxy));

        assertEq(afterTime.codehash, before.codehash, "codehash");
        assertEq(afterTime.implementation, before.implementation, "implementation");
        assertEq(afterTime.beacon, before.beacon, "beacon");
        assertEq(afterTime.admin, before.admin, "admin");
        assertEq(afterTime.implCodehash, before.implCodehash, "implementation codehash");
        assertEq(afterTime.quoteTarget, before.quoteTarget, "quote target");
        assertEq(afterTime.enabled, before.enabled, "enabled");

        assertTrue(new QuoteAssetScreen().screen(address(proxy)).ok, "and it still passes the screen");
    }
}
