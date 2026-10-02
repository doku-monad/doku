// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/**
 * Every address a deployment script needs, in one place, keyed on the chain it is running against.
 *
 * ## Why a library keyed on `block.chainid` rather than JSON or `[rpc_endpoints]`
 *
 * The three candidates were a `NetworkConfig` library, `[rpc_endpoints]` plus environment, and a
 * JSON file read with `vm.readFile`. This is the library, for three reasons:
 *
 *   1. **The chain answers for itself.** A script reads `block.chainid` from the node it is
 *      actually connected to, so the configuration cannot disagree with the chain. `--rpc-url` and
 *      a `--network` flag can, and a mainnet deployment made under a testnet flag is the failure
 *      this whole file exists to prevent.
 *   2. **JSON needs `fs_permissions`.** Granting a script read access to a config file is cheap;
 *      the reason to avoid it is that `foundry.toml`'s permission list was deliberately narrowed to
 *      `./data` once, after stale artifacts under `./out` hid a completely broken DEX for a whole
 *      deployment. Keeping the permission surface at exactly one directory is worth more than the
 *      convenience of editing addresses without recompiling — these addresses change roughly never.
 *   3. **`solc` checks it.** A mistyped address in a JSON file is a runtime surprise; a mistyped
 *      address literal here fails its checksum at compile time.
 *
 * `[rpc_endpoints]` stays in `foundry.toml` and does the job it is good at — naming RPC URLs
 * without putting them in the repository. It is not a place to put addresses.
 *
 * ## The rule this file enforces
 *
 * **A value is never defaulted to another network's address.** The table below is keyed on the
 * chain id of the node the script is talking to, so chain 143 gets mainnet's Uniswap singletons and
 * chain 31337 gets nothing at all and is told which variable to set. An unset variable on a chain
 * with no entry aborts by name. There is deliberately no "if in doubt, use mainnet" branch: that is
 * how a local run quietly becomes a production one.
 *
 * The exceptions are the two addresses that are the SAME on every chain because they are
 * deterministic deployments rather than per-network facts — the CREATE2 proxy and Permit2. Those
 * are protocol constants, and they are constants here.
 *
 * ## What is deliberately NOT here
 *
 * StateView, V4Quoter and UniversalRouter. No script in this directory deploys or calls them; only
 * the frontend does. They live in `deployments/mainnet.json` with everything else a service needs,
 * and a constant nothing reads is a constant nobody maintains.
 */
library NetworkConfig {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // ---------------------------------------------------------------- chains

    uint256 internal constant MONAD_MAINNET = 143;
    uint256 internal constant MONAD_TESTNET = 10143;
    uint256 internal constant ANVIL = 31337;

    // ------------------------------------------------- chain-wide constants

    /**
     * The deterministic CREATE2 proxy, at the same address on every EVM chain.
     *
     * Foundry rewrites a salted `new` into a call to this contract inside `vm.startBroadcast()` and
     * does not outside one, which is why a hook salt mined against it is valid for a broadcast and
     * for nothing else. It is a protocol constant rather than network configuration: there is no
     * chain on which a different value would be correct, so making it configurable would only
     * create a way to get it wrong.
     */
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    /**
     * Uniswap's Permit2, likewise deterministic and likewise the same everywhere.
     *
     * Present on Monad mainnet and testnet already, and planted at this exact address on a local
     * node by the integration harnesses — it needs `via_ir` to compile from source, which this
     * project cannot turn on without moving the hook's creation code. Overridable by `PERMIT2` for
     * a chain that somehow has it elsewhere; every caller asserts there is code at whatever comes
     * back, so a chain without it fails before the first transaction rather than during graduation.
     */
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    // ------------------------------------------- Monad mainnet (143), verified on chain

    /// @dev Uniswap's, not ours. DOKU integrates with the canonical singletons and deploys none.
    ///      Recorded in `docs/doku/deployments.md` under "Canonical Uniswap v4, verified on-chain".
    address internal constant MAINNET_POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address internal constant MAINNET_POSITION_MANAGER = 0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016;

    /**
     * The quote assets a mainnet market may be priced in, verified on Monad mainnet 2026-09-07.
     *
     * Addresses only. The per-asset TARGET is not here and must not be: it is a dollar amount
     * expressed in raw units, so it moves with the price of the asset and is a decision taken at
     * deploy time rather than a fact about the chain. Targets come from `DOKU_QUOTE_TARGETS`.
     */
    address internal constant MAINNET_USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603; // 6 dec
    address internal constant MAINNET_USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D; // 6 dec
    address internal constant MAINNET_WETH = 0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242; // 18 dec
    address internal constant MAINNET_WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c; // 8 dec
    address internal constant MAINNET_CBBTC = 0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b; // 8 dec
    address internal constant MAINNET_XAUT0 = 0x01bFF41798a0BcF287b996046Ca68b395DbC1071; // 6 dec, gold

    /**
     * The two addresses that must NEVER be registered, on any chain.
     *
     * They impersonate tokenised equities ("NVDAX", "AAPLX") and carry a hundred-billion supply. No
     * legitimate tokenised equity exists on Monad. Registering one is an owner call that cannot be
     * taken back for markets already launched against it, which is why the check is here rather
     * than in a comment in a shell script.
     */
    address internal constant COUNTERFEIT_NVDAX = 0xCE4Aa2BE730ccbeD578f37634A008Ea784113508;
    address internal constant COUNTERFEIT_AAPLX = 0x5A64F0b214f0279CCF448Ae613A2A99B4E4b23Dd;

    // ---------------------------------------------------------------- lookups

    /// @notice A short name for the chain the script is connected to. `deploy.sh` cross-checks the
    ///         network it was asked for against this, so a mainnet RPC under a testnet argument
    ///         aborts instead of deploying.
    function networkName() internal view returns (string memory) {
        if (block.chainid == MONAD_MAINNET) return "mainnet";
        if (block.chainid == MONAD_TESTNET) return "testnet";
        if (block.chainid == ANVIL) return "local";
        return string.concat("chain-", vm.toString(block.chainid));
    }

    /// @notice Uniswap v4's PoolManager on this chain. Mainnet has one; nothing else does.
    function poolManager() internal view returns (address) {
        return _resolve("V4_POOL_MANAGER", block.chainid == MONAD_MAINNET ? MAINNET_POOL_MANAGER : address(0), _NO_V4);
    }

    /// @notice Uniswap v4's PositionManager on this chain.
    function positionManager() internal view returns (address) {
        return
            _resolve(
                "V4_POSITION_MANAGER", block.chainid == MONAD_MAINNET ? MAINNET_POSITION_MANAGER : address(0), _NO_V4
            );
    }

    /// @notice Permit2. Deterministic, so the constant is the answer unless overridden.
    function permit2() internal view returns (address) {
        return _resolve("PERMIT2", PERMIT2, "and Permit2 is not deployed at its canonical address here");
    }

    /**
     * @notice Refuses a quote asset the deployment must not register.
     *
     * Two rules, and they exist for different failures. The counterfeits are refused on every
     * chain, because registering one is unrecoverable for markets already launched against it. On
     * mainnet the set is additionally CLOSED to the six verified assets: a mistyped or
     * wrong-network address there deploys a registry pointing at a contract nobody can trade,
     * which looks exactly like a working deployment until someone tries to launch against it.
     *
     * Adding a genuinely new mainnet asset later is a single owner call on `QuoteRegistry`, not a
     * redeployment — so this closed set costs nothing operationally. If one is ever added to the
     * launch SET, add it here in the same commit as the address is verified.
     */
    function assertRegistrableQuote(address asset) internal view {
        require(
            asset != COUNTERFEIT_NVDAX && asset != COUNTERFEIT_AAPLX,
            "DOKU_QUOTE_ASSETS names a counterfeit equity token; see docs/doku/09-deployment-runbook.md STOP 3"
        );
        if (block.chainid != MONAD_MAINNET) return;
        require(
            asset == MAINNET_USDC || asset == MAINNET_USDT0 || asset == MAINNET_WETH || asset == MAINNET_WBTC
                || asset == MAINNET_CBBTC || asset == MAINNET_XAUT0,
            "DOKU_QUOTE_ASSETS names an address that is not one of the six verified Monad mainnet quote assets"
        );
    }

    // ------------------------------------------------------- required environment

    /// @notice An address from the environment, or a loud abort naming the variable.
    function requireAddress(string memory name, string memory why) internal view returns (address value) {
        value = vm.envOr(name, address(0));
        require(value != address(0), string.concat(name, " is not set: ", why));
    }

    /// @notice A uint from the environment, or a loud abort. Zero counts as absent: no value this
    ///         is used for has a meaningful zero, and a variable set to nothing parses as one.
    function requireUint(string memory name, string memory why) internal view returns (uint256 value) {
        value = vm.envOr(name, uint256(0));
        require(value != 0, string.concat(name, " is not set: ", why));
    }

    function _resolve(string memory name, address chainValue, string memory why)
        private
        view
        returns (address resolved)
    {
        resolved = vm.envOr(name, chainValue);
        require(
            resolved != address(0), string.concat(name, " is not set, and chain ", vm.toString(block.chainid), " ", why)
        );
    }

    string private constant _NO_V4 =
        "has no canonical Uniswap v4. Mainnet (143) is the only chain that does; on testnet deploy one with script/DeployV4.s.sol and pass the addresses it prints.";
}
