// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IERC20Metadata} from "openzeppelin/token/ERC20/extensions/IERC20Metadata.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {QuoteRegistry} from "../src/QuoteRegistry.sol";
import {CreatorSink} from "../src/sinks/CreatorSink.sol";
import {DOKU_MIN_QUOTE_TARGET} from "../src/BondingCurve.sol";
import {DokuGraduation} from "../src/DokuGraduation.sol";
import {DokuHook, DOKU_HOOK_FLAGS} from "../src/v4/DokuHook.sol";
import {DOKU_HOOK_CREATION_CODE_HASH} from "../src/v4/HookCreationCode.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";

/// @notice Deploys the DOKU protocol onto a network whose DEX is already deployed.
///
/// @dev This is the deployment path for a real chain. `LocalScenario.s.sol` is not — it plants
///      code at a hardcoded wrapper address and drives trades, both of which only a local node
///      allows.
///
///      There is no DEX to deploy any more. DOKU graduates into canonical Uniswap v4, which is
///      already on Monad mainnet, so this script is the whole deployment: the registry, the shared
///      sink, the mined hook, the graduator, the factory, the wiring and the quote set.
///
///      ORDERING IS FORCED, and each step is forced by something different:
///
///        1. `QuoteRegistry`, so the factory has something to read.
///        2. `CreatorSink`, BEFORE the hook: the hook carries its address as an immutable, which
///           makes it a CREATE2 constructor argument and therefore part of the mined salt.
///        3. The HOOK, at a MINED address. v4 packs its permission set into the low fourteen bits
///           of the address, so it cannot be deployed anywhere else — `BaseHook`'s constructor
///           checks and reverts. The salt is mined here, inside the broadcast, because it is a
///           function of the constructor arguments and the sink's address is only known now.
///        4. `DokuGraduation`, which takes the hook's address as an immutable and constructs the
///           `SeedLocker`.
///        5. `hook.setGraduator(graduation)`, without which every `initialize` a graduation
///           attempts reverts `NotGraduator` — and `PoolInitializer_v4` would swallow that.
///        6. The factory, then `factory.setGraduator`, then the sink's two one-shots IN THIS
///           ORDER: `creatorSink.setGraduator(graduation)` — which also learns the hook through
///           `graduation.hook()` — and `creatorSink.setFactory(factory)`, without which every
///           deferred `credit()` from a curve reverts because the sink cannot ask `isMarket`.
///        7. `registry.register(...)` for the whole launch set, so launches are possible at all:
///           native MON `address(0)` at `DOKU_QUOTE_TARGET`, then every asset named in
///           `DOKU_QUOTE_ASSETS` at its own `DOKU_QUOTE_TARGETS` entry. On Monad mainnet that set
///           is USDC, USDT0, WETH, WBTC, cbBTC and XAUt0 (gold) — the addresses are in
///           `docs/doku/deployments.md`. Targets are per asset and sized to the same USD amount,
///           so they differ by orders of magnitude in raw units. Equities are deliberately absent:
///           none exists on Monad, and the two "xStock" tokens that do are counterfeits with a
///           hundred-billion supply. Registering an asset later is an owner call, not a redeploy.
///        8. Ownership OFFERED on every Ownable2Step contract, last.
contract DeployDoku is Script {
    struct Deployment {
        address hook;
        bytes32 hookSalt;
        address dokuFactory;
        address graduation;
        address seedLocker;
        address quoteRegistry;
        address creatorSink;
        uint256 startBlock;
    }

    /// @dev Read in one pass and carried as a struct. Held as locals alongside the deployment
    ///      addresses, this exceeds the EVM's stack depth — and `via_ir`, which would fix that, is
    ///      load-bearing for the hook's mined address and cannot be turned on. See foundry.toml.
    struct Config {
        address poolManager;
        address positionManager;
        address permit2;
        address owner;
        address pauser;
        address feeRecipient;
        address treasury;
        /// @dev Native MON, in wei. Registered unconditionally.
        uint256 quoteTarget;
        /// @dev Every quote BESIDES native, and its target in that asset's raw units. Same length,
        ///      checked before anything is broadcast. Empty opens a MON-only registry, which is a
        ///      legitimate configuration — the registry is additive and every later asset is an
        ///      owner call — but it is not the mainnet launch set.
        address[] quoteAssets;
        uint256[] quoteTargets;
        uint256 launchFeeWei;
        string metadataBaseURI;
        // Anti-sniper terms for every launch (generation 8). `taxTermsSet` says the environment
        // named them; unset keeps the curve's constants (50% over 300 s, clock decay).
        bool taxTermsSet;
        uint16 taxStartBps;
        uint32 taxWindow;
        uint8 taxMode;
    }

    function run() external returns (Deployment memory d) {
        return runWith(_config());
    }

    /**
     * The deployment, given a configuration rather than an environment.
     *
     * Split out because the environment is process-global and a test that writes it to exercise a
     * bad value leaks that value into whatever runs next — a failure that reports the wrong
     * message in the wrong test and moves when the order changes. Taking the configuration as an
     * argument makes every one of those cases a plain function call.
     */
    function runWith(Config memory cfg) public returns (Deployment memory d) {
        _validate(cfg);
        d = _deploy(cfg);
        _check(d, cfg);

        // Named first, because every address below is only meaningful on the chain that produced
        // it and a log pasted into the wrong record is how two services end up disagreeing.
        console.log("DOKU_NETWORK       ", NetworkConfig.networkName());
        console.log("DOKU_CHAIN_ID      ", block.chainid);
        console.log("DOKU_QUOTE_REGISTRY", d.quoteRegistry);
        console.log("DOKU_CREATOR_SINK  ", d.creatorSink);
        console.log("DOKU_HOOK          ", d.hook);
        console.log("DOKU_HOOK_SALT     ", vm.toString(d.hookSalt));
        console.log("DOKU_GRADUATION    ", d.graduation);
        console.log("DOKU_SEED_LOCKER   ", d.seedLocker);
        console.log("DOKU_FACTORY       ", d.dokuFactory);
        {
            (uint16 sBps, uint32 win, uint8 mode) = DokuFactory(d.dokuFactory).taxTerms();
            console.log("TAX_TERMS          ", sBps, win, mode);
        }
        console.log("START_BLOCK        ", d.startBlock);

        /**
         * The step this script cannot take.
         *
         * Two-step ownership is why: until the configured owner accepts, the key that ran this
         * deployment is still the protocol's owner. Printed rather than assumed, because a
         * deployment that reports success while a hot key retains control is the failure mode
         * worth being loud about.
         */
        address pending = DokuFactory(d.dokuFactory).pendingOwner();
        if (pending != address(0)) {
            console.log("");
            console.log("NOT FINISHED: ownership is offered, not transferred.");
            console.log("  the deployer still owns the protocol until this address accepts:");
            console.log("  ", pending);
            console.log("  it must call acceptOwnership() on ALL FOUR:");
            console.log("    factory      ", d.dokuFactory);
            console.log("    hook         ", d.hook);
            console.log("    quoteRegistry", d.quoteRegistry);
            console.log("    creatorSink  ", d.creatorSink);
        }
    }

    /**
     * The configuration, read from the environment and from the chain the RPC is pointed at.
     *
     * Addresses come from `NetworkConfig`, which resolves environment first and the CURRENT chain's
     * known values second, and aborts naming the variable when it has neither. It never substitutes
     * another network's address — a deployment that silently used mainnet's PoolManager because a
     * variable was unset is the failure that rule exists for.
     */
    function _config() internal view returns (Config memory cfg) {
        cfg.poolManager = NetworkConfig.poolManager();
        cfg.positionManager = NetworkConfig.positionManager();
        cfg.permit2 = NetworkConfig.permit2();

        /**
         * Who holds the keys.
         *
         * Defaulted to the deployer so a testnet run is one command, and named separately so a
         * mainnet run can split them without editing this file. They are genuinely different
         * powers: the owner changes protocol parameters, the pauser can only stop launches, and
         * the fee recipient only receives. Collapsing them onto one key is a testnet convenience,
         * not a design.
         */
        cfg.owner = vm.envOr("DOKU_OWNER", msg.sender);
        cfg.pauser = vm.envOr("DOKU_PAUSER", cfg.owner);
        cfg.feeRecipient = vm.envOr("DOKU_FEE_RECIPIENT", cfg.owner);
        cfg.treasury = vm.envOr("DOKU_TREASURY", cfg.owner);

        /**
         * What a curve must raise before it graduates.
         *
         * No default. It decides how much MON is committed before liquidity becomes permanent, so
         * a value inherited by accident is a value nobody chose — and on mainnet it is the single
         * number that determines what a launch costs its buyers.
         */
        cfg.quoteTarget = NetworkConfig.requireUint(
            "DOKU_QUOTE_TARGET",
            "the native MON target in wei, divisible by five. It decides how much is committed before a market's liquidity becomes permanent, so there is no default"
        );

        /**
         * The rest of the launch set, as two parallel comma-separated lists.
         *
         * Optional, because the registry is additive and every asset is an owner call away — but
         * `deploy-mainnet.sh` requires both, because a mainnet deployment that opened MON-only
         * would be a protocol nobody can launch a USDC market on until a second transaction lands.
         * Read as lists rather than as `DOKU_USDC`-shaped named pairs so adding gold, or dropping
         * one of the bridged assets, is an environment change and not a code change.
         */
        cfg.quoteAssets = vm.envOr("DOKU_QUOTE_ASSETS", ",", new address[](0));
        cfg.quoteTargets = vm.envOr("DOKU_QUOTE_TARGETS", ",", new uint256[](0));

        /**
         * Two rules that only apply to a configuration read from the environment.
         *
         * They live here rather than in `_validate` on purpose: `_validate` also guards the tests
         * and `LocalScenario`, which legitimately register a mock six-decimal token on a node
         * whose chain id is Monad's. What is being checked here is an OPERATOR's typing, and the
         * operator only ever types into the environment.
         */
        require(
            block.chainid != NetworkConfig.MONAD_MAINNET || cfg.quoteAssets.length > 0,
            "DOKU_QUOTE_ASSETS is not set: a mainnet deployment that opened MON-only is a protocol nobody can launch a USDC market on until a second owner transaction lands"
        );
        for (uint256 i; i < cfg.quoteAssets.length; ++i) {
            NetworkConfig.assertRegistrableQuote(cfg.quoteAssets[i]);
        }

        // What a launch costs on top of gas, in wei. Zero is a deliberate choice, not a default.
        cfg.launchFeeWei = vm.envOr("DOKU_LAUNCH_FEE_WEI", uint256(0));
        // Where every launched token's `metadataURI()` points: `<base><token>.json`. The factory
        // defaults to the production CDN; set this for a staging bucket or a domain move. Empty
        // keeps the default.
        cfg.metadataBaseURI = vm.envOr("DOKU_METADATA_BASE_URI", string(""));
        // The anti-sniper terms, all three or none: start rate in bps (<= 5000), window in seconds
        // (<= 3600; 0 switches the tax off) and mode (0 clock, 1 progress, 2 max). Generation 8
        // ships 5000 / 3 / 0: a sniper in the launch block still pays half, a buyer ten seconds
        // later pays nothing.
        cfg.taxTermsSet = vm.envExists("DOKU_TAX_WINDOW");
        if (cfg.taxTermsSet) {
            cfg.taxStartBps = uint16(vm.envUint("DOKU_TAX_START_BPS"));
            cfg.taxWindow = uint32(vm.envUint("DOKU_TAX_WINDOW"));
            cfg.taxMode = uint8(vm.envUint("DOKU_TAX_MODE"));
        }
    }

    /// @dev Checked before anything is broadcast. Each of these is a value that deploys a
    ///      working-looking protocol and is unrecoverable afterwards, or one that reverts halfway
    ///      through the broadcast and wastes a mainnet deployment.
    function _validate(Config memory cfg) internal view {
        _checkTarget(cfg.quoteTarget, "DOKU_QUOTE_TARGET");
        require(cfg.poolManager.code.length > 0, "V4_POOL_MANAGER has no code");
        require(cfg.positionManager.code.length > 0, "V4_POSITION_MANAGER has no code");
        require(cfg.permit2.code.length > 0, "PERMIT2 has no code");
        require(
            cfg.quoteAssets.length == cfg.quoteTargets.length,
            "DOKU_QUOTE_ASSETS and DOKU_QUOTE_TARGETS are different lengths"
        );
        for (uint256 i; i < cfg.quoteAssets.length; ++i) {
            address asset = cfg.quoteAssets[i];
            // Native is registered unconditionally from `DOKU_QUOTE_TARGET`; listing it again
            // would revert `AlreadyRegistered` in the middle of the broadcast.
            require(asset != address(0), "DOKU_QUOTE_ASSETS lists the native asset; it is DOKU_QUOTE_TARGET");
            require(asset.code.length > 0, "a DOKU_QUOTE_ASSETS entry has no code");
            for (uint256 j; j < i; ++j) {
                require(cfg.quoteAssets[j] != asset, "DOKU_QUOTE_ASSETS lists the same asset twice");
            }
            // `register` reads this and stores it; an address that cannot answer is a mistyped or
            // wrong-network constant, and finding out here costs nothing.
            uint8 dec = IERC20Metadata(asset).decimals();
            require(dec > 0 && dec <= 18, "a DOKU_QUOTE_ASSETS entry reports implausible decimals");
            _checkTarget(cfg.quoteTargets[i], "a DOKU_QUOTE_TARGETS entry");
        }
    }

    /**
     * The two ways a target bricks every market launched against it.
     *
     * Below `DOKU_MIN_QUOTE_TARGET` the curve's virtual quote reserve truncates to zero and every
     * buy panics forever. Not divisible by five, the virtual quote FLOOR (`target * 2 / 5`)
     * truncates instead: the graduation seed comes out under what `DokuGraduation` demands, so a
     * market that FILLED can never graduate and its whole raise is stranded.
     *
     * `QuoteRegistry.register` refuses both — but it refuses them from inside the broadcast, after
     * seven contracts are already on chain. This is the same rule, applied before the first
     * transaction, with a message that names the variable the operator actually set.
     */
    function _checkTarget(uint256 target, string memory name) private pure {
        require(target >= DOKU_MIN_QUOTE_TARGET, string.concat(name, " is below the minimum a working curve needs"));
        require(target % 5 == 0, string.concat(name, " is not divisible by five: the curve's quote floor truncates"));
    }

    /// @dev Mines the salt that puts the hook at an address encoding its permission bits.
    ///
    ///      Bounded, and it fails loudly rather than looping: at a 1-in-16,384 hit rate a scan this
    ///      long missing is a signal that something about the creation code or the deployer is not
    ///      what this script thinks it is, and grinding forever would hide that.
    ///
    ///      `deployer` is the CREATE2 proxy rather than `tx.origin`, because that is what actually
    ///      performs the create inside a broadcast. Mining against the wrong one produces an
    ///      address that looks plausible and reverts in `BaseHook`'s constructor.
    ///
    ///      `creatorSink` is an argument rather than a config field because it is not knowable
    ///      until the sink is deployed, which is why this is called from INSIDE the broadcast. The
    ///      caller must pass the sink it then constructs the hook with: mine against one address
    ///      and deploy against another and the hook lands somewhere its own constructor rejects.
    function _mineHook(Config memory cfg, address deployer, address creatorSink)
        internal
        pure
        returns (address, bytes32)
    {
        /*
         * The binary this is about to mine against is the binary the suite tested. Asserted, not
         * assumed — see `HookCreationCode.sol`. Two compiler profiles are live in this project and
         * a deploy script resolves `type(DokuHook).creationCode` through its own compilation, so
         * "the tests passed" and "this is what will be deployed" are two different statements and
         * were, for the whole of generation 2, two different binaries.
         */
        require(
            keccak256(type(DokuHook).creationCode) == DOKU_HOOK_CREATION_CODE_HASH,
            "hook creation code is not the one the test suite pinned: this deployment would ship untested bytecode"
        );
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(DokuHook).creationCode,
                abi.encode(IPoolManager(cfg.poolManager), deployer, cfg.treasury, creatorSink)
            )
        );
        for (uint256 salt; salt < 400_000; ++salt) {
            address candidate = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xFF), NetworkConfig.CREATE2_DEPLOYER, bytes32(salt), initCodeHash)
                        )
                    )
                )
            );
            if (uint160(candidate) & 0x3FFF == DOKU_HOOK_FLAGS) return (candidate, bytes32(salt));
        }
        revert("no hook salt found in 400,000 attempts");
    }

    function _deploy(Config memory cfg) internal returns (Deployment memory d) {
        address deployer = tx.origin;
        vm.startBroadcast();

        // 1 and 2. Both owned by the DEPLOYER for the same reason the hook is: each has an
        // `onlyOwner` setup call below, and ownership is offered at the end.
        QuoteRegistry registry = new QuoteRegistry(deployer);
        CreatorSink creatorSink = new CreatorSink(deployer);

        // 3. Mined INSIDE the broadcast, because the sink's address is one of the inputs. Pure
        // computation — nothing is sent. Inside a broadcast Foundry rewrites a salted `new` into a
        // CREATE2 call to the deterministic deployer proxy, which is what `_mineHook` mined
        // against; in a plain test it does not, which is why a salt is never shared between the
        // two contexts.
        (address predicted, bytes32 salt) = _mineHook(cfg, deployer, address(creatorSink));
        DokuHook hook =
            new DokuHook{salt: salt}(IPoolManager(cfg.poolManager), deployer, cfg.treasury, address(creatorSink));
        require(address(hook) == predicted, "mined address and deployed address disagree");

        /*
         * 4. THE FACTORY, BEFORE THE GRADUATION CONTRACT — and the order is load-bearing.
         *
         * Graduation now takes the factory as an IMMUTABLE, because `graduate` is permissionless and
         * has to authenticate its subject: the factory's `isMarket` is the only register of what
         * this protocol actually launched. A setter would have been easier and is not safe — even a
         * one-shot one is front-runnable into a hostile register before the deployer's own call
         * lands, and that register decides which contracts may be graduated at all.
         *
         * The factory can be built first because it needs no graduator at construction: it starts
         * with its owner in that slot so launches work, and `setGraduator` below points it at the
         * real one.
         */
        DokuFactory factory = new DokuFactory(
            deployer, cfg.pauser, cfg.feeRecipient, address(registry), address(creatorSink), cfg.launchFeeWei
        );
        if (bytes(cfg.metadataBaseURI).length != 0) factory.setMetadataBaseURI(cfg.metadataBaseURI);
        if (cfg.taxTermsSet) factory.setTaxTerms(cfg.taxStartBps, cfg.taxWindow, cfg.taxMode);

        // 5. Without `setGraduator` every pool a graduation tries to create reverts `NotGraduator` —
        // and `PoolInitializer_v4` catches that and returns a sentinel rather than bubbling, so the
        // symptom would be a graduation that mints into a pool that does not exist. Unconditional,
        // and asserted in `_check`.
        DokuGraduation graduation =
            new DokuGraduation(cfg.poolManager, cfg.positionManager, cfg.permit2, address(hook), address(factory));
        hook.setGraduator(address(graduation), true);

        // 6. The sink's two setters are one-shot. Graduator FIRST: it is how the sink learns the
        // hook.
        factory.setGraduator(address(graduation));
        creatorSink.setGraduator(address(graduation));
        creatorSink.setFactory(address(factory));

        /*
         * 6b. ACTIVATION. The factory was born paused and refuses `launch` until this lands.
         *
         * Everything above is a wire that used to be checked either nowhere or at graduation time —
         * which is to say, after a curve had filled, closed both legs and pinned its graduator with
         * no setter. `activate` reads all of it now: the graduator's four immutables, the hook's
         * allowlist and its sink, and the sink's three one-shots, against a declaration made here.
         *
         * The v4 singletons come from the network config rather than from `graduation`, on purpose.
         * Reading them off the graduator would prove only that the graduator agrees with itself; the
         * point of a declaration is that the two sources are independent and have to match.
         */
        factory.activate(
            DokuFactory.Dependencies({
                graduator: address(graduation),
                hook: address(hook),
                creatorSink: address(creatorSink),
                poolManager: cfg.poolManager,
                positionManager: cfg.positionManager,
                permit2: cfg.permit2
            })
        );

        // 7. Native MON first, then the rest of the launch set.
        registry.register(address(0), cfg.quoteTarget);
        for (uint256 i; i < cfg.quoteAssets.length; ++i) {
            registry.register(cfg.quoteAssets[i], cfg.quoteTargets[i]);
        }

        /**
         * 8. Last, because everything above needs the deployer to still be owner.
         *
         * Every one of these is `Ownable2Step`, so this *offers* ownership rather than transferring
         * it: the deployment ends with the deployer still in control and `cfg.owner` pending, until
         * that address calls `acceptOwnership()` on each. That is the safe shape — a mistyped owner
         * is recoverable rather than permanent — but it means the deployment is not finished when
         * this script exits, and a protocol left half-transferred is one whose hot deploy key still
         * controls it. The console output above says so.
         */
        if (cfg.owner != deployer) {
            factory.transferOwnership(cfg.owner);
            hook.transferOwnership(cfg.owner);
            registry.transferOwnership(cfg.owner);
            creatorSink.transferOwnership(cfg.owner);
        }

        vm.stopBroadcast();

        d.hook = address(hook);
        d.hookSalt = salt;
        d.dokuFactory = address(factory);
        d.graduation = address(graduation);
        d.seedLocker = address(graduation.locker());
        d.quoteRegistry = address(registry);
        d.creatorSink = address(creatorSink);
        // The indexer scans from here. Scanning from genesis on a live chain is a backfill that
        // never reaches the present, so the deployment reports the only block that matters.
        d.startBlock = block.number;
    }

    /// @dev Asserted after broadcasting rather than trusted. Every one of these is a wiring
    ///      mistake that leaves a protocol which deploys cleanly, launches markets, and then
    ///      cannot graduate any of them — discovered by the first curve to fill, in public.
    function _check(Deployment memory d, Config memory cfg) internal view {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuHook hook = DokuHook(payable(d.hook));
        QuoteRegistry registry = QuoteRegistry(d.quoteRegistry);

        require(factory.graduator() == d.graduation, "graduator not wired to Graduation");
        // The wire whose absence is silent. `PoolInitializer_v4` swallows the `NotGraduator`
        // revert, so a deployment missing this one looks healthy until the first curve fills.
        require(hook.isGraduator(d.graduation), "graduator not allowed on the hook");
        require(address(DokuGraduation(payable(d.graduation)).hook()) == d.hook, "graduation points at the wrong hook");
        // The register `graduate` authenticates against. Wrong here and every real market is
        // refused while every impostor is too — a protocol that cannot graduate anything.
        require(
            address(DokuGraduation(payable(d.graduation)).factory()) == d.dokuFactory,
            "graduation points at the wrong factory"
        );

        // The hook's sink is an IMMUTABLE folded into the mined address. If these two disagree the
        // hook was mined against a sink it was not deployed with, and every creator tax on the
        // chain is unreachable: `pullTax` answers `creatorSink` and nothing else.
        require(hook.creatorSink() == d.creatorSink, "hook does not carry the CreatorSink");
        require(factory.creatorSink() == d.creatorSink, "factory does not carry the CreatorSink");

        // The sink's three wires. Each absence is silent until the first pull or deferred credit.
        CreatorSink sink = CreatorSink(payable(d.creatorSink));
        require(sink.graduator() == d.graduation, "CreatorSink graduator not set");
        require(sink.factory() == d.dokuFactory, "CreatorSink factory not set: every deferred credit would revert");
        require(sink.hook() == d.hook, "CreatorSink did not learn the hook from the graduator");

        require(address(factory.registry()) == d.quoteRegistry, "factory reads a different registry");
        require(
            registry.isEnabled(address(0)) && registry.quoteTarget(address(0)) == cfg.quoteTarget, "MON not registered"
        );
        for (uint256 i; i < cfg.quoteAssets.length; ++i) {
            require(registry.isEnabled(cfg.quoteAssets[i]), "a configured quote asset is not enabled");
            require(
                registry.quoteTarget(cfg.quoteAssets[i]) == cfg.quoteTargets[i],
                "a configured quote target did not take"
            );
            require(
                registry.decimalsOf(cfg.quoteAssets[i]) == IERC20Metadata(cfg.quoteAssets[i]).decimals(),
                "a quote asset's decimals were recorded wrong"
            );
        }

        require(uint160(d.hook) & 0x3FFF == DOKU_HOOK_FLAGS, "hook address does not encode its permissions");
        require(d.hook.code.length > 0, "hook has no code");
        require(factory.activated(), "factory was never activated: it cannot launch anything");
        require(!factory.paused(), "factory is still paused after activation");
        require(factory.dependencyHash() != bytes32(0), "activation left no dependency hash");
        // Re-read the whole graph from the deployed factory rather than trusting the call above.
        // This is the assertion that would have caught a sink wired to the wrong graduator, which is
        // unrecoverable: `CreatorSink.setGraduator` reverts `AlreadySet` on a second call.
        factory.validateDeployment();
        require(factory.pauser() == cfg.pauser, "pauser is not the configured pauser");
        require(factory.feeRecipient() == cfg.feeRecipient, "fee recipient did not take");
        require(factory.launchFeeWei() == cfg.launchFeeWei, "launch fee did not take");
        // The treasury is folded into the hook's mined init-code hash, so a mine/deploy disagreement
        // would already have failed `require(address(hook) == predicted)`. This asserts the CONFIGURED
        // value took, the same way pauser, fee recipient and launch fee are asserted — a mistyped
        // `DOKU_TREASURY` is permanently unrecoverable and deserves its own line.
        require(hook.treasury() == cfg.treasury, "treasury did not take");

        // Either already the owner, or offered it. Two-step ownership means the script cannot
        // complete the handover on its own — see `_deploy`.
        require(
            factory.owner() == cfg.owner || factory.pendingOwner() == cfg.owner,
            "factory owner neither owner nor pending"
        );
        require(hook.owner() == cfg.owner || hook.pendingOwner() == cfg.owner, "hook owner neither owner nor pending");
        require(
            registry.owner() == cfg.owner || registry.pendingOwner() == cfg.owner,
            "registry owner neither owner nor pending"
        );
        require(sink.owner() == cfg.owner || sink.pendingOwner() == cfg.owner, "sink owner neither owner nor pending");
        require(d.seedLocker.code.length > 0, "no locker was constructed");
    }
}
