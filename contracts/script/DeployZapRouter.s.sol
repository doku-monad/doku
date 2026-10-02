// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {DokuFactory} from "../src/DokuFactory.sol";
import {ZapRouter} from "../src/ZapRouter.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";

/**
 * @notice Deploys the ZapRouter against a DOKU deployment that already exists.
 *
 * @dev SEPARATE FROM `DeployDoku` ON PURPOSE. The router is periphery: it holds no protocol
 *      power, nothing in `src/` knows it exists, and it can be redeployed or abandoned without
 *      touching a single market. Folding it into the protocol deployment would tie a contract that
 *      may well be replaced to one that must never be.
 *
 *      It takes the factory as an argument rather than deploying one, so this script only ever
 *      runs SECOND. The factory address is pinned into the router as an immutable — that is what
 *      makes `isMarket` an answer from the real registry rather than from whatever contract a
 *      caller passed in — so a router pointed at the wrong factory is not repairable, only
 *      replaceable. Hence the checks below, all of which run before anything is broadcast.
 *
 *      Required environment:
 *
 *        DOKU_FACTORY            the live factory this router will buy on. On mainnet it is the
 *                                address in `deployments/mainnet.json`.
 *        DOKU_MAX_ZAP_VALUE_WEI  the ceiling on a single zap, in wei of MON. No default, and zero
 *                                is refused here: the owner can lift the ceiling later with one
 *                                transaction, but a deployment that shipped unbounded by accident
 *                                cannot be un-shipped.
 *
 *      Optional: `ZAP_OWNER`, which holds `setMaxZapValue` and nothing else. Defaults to
 *      `DOKU_OWNER`, then to the deployer.
 */
contract DeployZapRouter is Script {
    struct Config {
        address poolManager;
        address factory;
        address owner;
        uint256 maxZapValue;
    }

    function run() external returns (ZapRouter router) {
        return runWith(_config());
    }

    /// @dev Split from `run` for the same reason `DeployDoku` splits its own: the environment is
    ///      process-global, so a test that writes it to exercise a bad value leaks that value into
    ///      whatever runs next.
    function runWith(Config memory cfg) public returns (ZapRouter router) {
        _validate(cfg);

        vm.startBroadcast();
        router = new ZapRouter(IPoolManager(cfg.poolManager), DokuFactory(cfg.factory), cfg.owner, cfg.maxZapValue);
        vm.stopBroadcast();

        _check(router, cfg);

        console.log("DOKU_NETWORK       ", NetworkConfig.networkName());
        console.log("DOKU_CHAIN_ID      ", block.chainid);
        console.log("DOKU_ZAP_ROUTER    ", address(router));
        console.log("ZAP_MAX_VALUE_WEI  ", cfg.maxZapValue);
        console.log("ZAP_OWNER          ", cfg.owner);
        console.log("ZAP_FACTORY        ", cfg.factory);
        console.log("START_BLOCK        ", block.number);
        console.log("");
        console.log("The frontend reads this address from NEXT_PUBLIC_ZAP_ROUTER. Until it is set");
        console.log("and the web service redeployed, the pay-with-MON control does not exist.");
    }

    function _config() internal view returns (Config memory cfg) {
        cfg.poolManager = NetworkConfig.poolManager();
        cfg.factory = NetworkConfig.requireAddress(
            "DOKU_FACTORY",
            "the live DokuFactory this router buys on. It is pinned as an immutable, so a router deployed against the wrong one can only be replaced"
        );
        cfg.owner = vm.envOr("ZAP_OWNER", vm.envOr("DOKU_OWNER", msg.sender));
        cfg.maxZapValue = NetworkConfig.requireUint(
            "DOKU_MAX_ZAP_VALUE_WEI",
            "the ceiling on a single zap, in wei of MON. Lifting it later is one owner call; shipping unbounded by accident cannot be undone"
        );
    }

    /// @dev Before the broadcast. Each of these deploys a router that looks fine and is wrong in a
    ///      way no later transaction can fix, because both addresses are immutable.
    function _validate(Config memory cfg) internal view {
        require(cfg.poolManager.code.length > 0, "V4_POOL_MANAGER has no code");
        require(cfg.factory.code.length > 0, "DOKU_FACTORY has no code");
        require(cfg.owner != address(0), "ZAP_OWNER is the zero address: setMaxZapValue would be unreachable");
        // Proves the address is a DokuFactory rather than any other contract with code. A router
        // pinned to a contract that cannot answer `isMarket` refuses every market on the chain.
        require(address(DokuFactory(cfg.factory).registry()) != address(0), "DOKU_FACTORY does not answer registry()");
    }

    /// @dev Read back off the deployed contract rather than assumed. The two immutables are the
    ///      whole risk surface of this deployment.
    function _check(ZapRouter router, Config memory cfg) internal view {
        require(address(router.poolManager()) == cfg.poolManager, "router carries the wrong PoolManager");
        require(address(router.factory()) == cfg.factory, "router carries the wrong factory");
        require(router.owner() == cfg.owner, "router owner is not the configured owner");
        require(router.maxZapValue() == cfg.maxZapValue, "router ceiling is not the configured ceiling");
    }
}
