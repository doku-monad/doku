// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {IPositionDescriptor} from "@uniswap/v4-periphery/src/interfaces/IPositionDescriptor.sol";
import {Deploy} from "@uniswap/v4-periphery/test/shared/Deploy.sol";
import {NetworkConfig} from "./config/NetworkConfig.sol";

// Compiled only so `Deploy`'s `vm.getCode` can find them — it resolves against build OUTPUT, so a
// contract nothing imports is never compiled and the lookup fails with "no matching artifact".
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {V4Quoter} from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import {StateView} from "@uniswap/v4-periphery/src/lens/StateView.sol";

/// @notice A stand-in for the network's wrapped native token.
/// @dev PositionManager stores one immutably and DOKU never uses it: the wrapper only serves the
///      WRAP/UNWRAP actions, and a pool whose `currency0` is native MON has nothing to wrap. It
///      needs to be a contract rather than an address, so this is the smallest one that is.
contract StubWrapper {
    fallback() external payable {}
}

/**
 * Uniswap v4, deployed by us, for a network that does not have it.
 *
 * @dev **This is not something to run on mainnet.** Monad mainnet already has canonical v4 and DOKU
 *      integrates with it; deploying a second PoolManager there would create a parallel universe of
 *      pools that no wallet, router or aggregator knows about.
 *
 *      It exists for **Monad testnet**, which has Permit2 and the CREATE2 proxy but no v4 at all —
 *      verified on chain and confirmed by Uniswap's own SDK, which carries no PoolManager key for
 *      10143. Without this a DOKU market on testnet can launch, take buys and fill, and then has
 *      nowhere to graduate into, which leaves exactly half the protocol untestable.
 *
 *      ## The licence, since this copies a BUSL work rather than calling one
 *
 *      v4-core is BUSL-1.1 until 2027-06-15. The licence grants the right to copy, modify and
 *      redistribute for **non-production use** outright, and reserves production use to an
 *      Additional Use Grant. A testnet deployment made to exercise a protocol before it ships is
 *      non-production by any reading. Mainnet is the opposite, and is also the case where this is
 *      unnecessary — see the warning above. v4-periphery is MIT and carries no such condition.
 */
contract DeployV4 is Script {
    // Permit2 is canonical and already present on Monad testnet, so it is checked rather than
    // deployed. Its address lives in `NetworkConfig`, which is the only copy of it in script/.

    /// @dev PositionManager's `unsubscribeGasLimit`. Uniswap's own deployments use this value.
    uint256 constant UNSUBSCRIBE_GAS_LIMIT = 100_000;

    struct V4 {
        address poolManager;
        address positionManager;
        address quoter;
        address stateView;
        address swapRouter;
    }

    function run() external returns (V4 memory v4) {
        require(
            block.chainid != NetworkConfig.MONAD_MAINNET,
            "refusing to deploy a second v4 to Monad mainnet: it already has Uniswap's"
        );
        address permit2 = NetworkConfig.permit2();
        require(permit2.code.length > 0, "PERMIT2 is not deployed on this chain");

        address owner = vm.envOr("V4_OWNER", msg.sender);

        vm.startBroadcast();

        PoolManager pm = new PoolManager(owner);
        v4.poolManager = address(pm);

        // The descriptor only serves `tokenURI`, and the wrapper only serves WRAP/UNWRAP. Neither
        // is on any path DOKU takes — but PositionManager stores both immutably and will not
        // deploy without them.
        address wrapper = address(new StubWrapper());
        //
        // Uniswap puts the descriptor behind a TransparentUpgradeableProxy so it can be swapped
        // later. Not here: nothing on this deployment ever calls `tokenURI`, the proxy's own
        // constructor is the one step of this script that fails under `--broadcast`, and an
        // upgrade path for a cosmetic contract on a testnet buys nothing. PositionManager stores
        // whatever address it is given.
        IPositionDescriptor descriptor = Deploy.positionDescriptor(address(pm), wrapper, bytes32("MON"), hex"01");

        IPositionManager posm =
            Deploy.positionManager(address(pm), permit2, UNSUBSCRIBE_GAS_LIMIT, address(descriptor), wrapper, hex"03");
        v4.positionManager = address(posm);

        v4.quoter = address(Deploy.v4Quoter(address(pm), hex"04"));
        v4.stateView = address(Deploy.stateView(address(pm), hex"05"));

        /**
         * A router, because otherwise nothing can trade the pools this creates.
         *
         * `PoolSwapTest` rather than UniversalRouter, and the difference is worth stating plainly:
         * UniversalRouter is not vendored in this repository and pulling it in would add a
         * dependency the protocol never deploys. So this is enough to trade a graduated market by
         * hand or from a script, and it is NOT the path the frontend takes — the app encodes
         * UniversalRouter commands, which only exist where UniversalRouter does. That path stays
         * covered by `pool.anvil.test.ts`, which forks mainnet to reach the real router.
         */
        v4.swapRouter = address(new PoolSwapTest(IPoolManager(address(pm))));

        vm.stopBroadcast();

        console.log("DOKU_NETWORK        ", NetworkConfig.networkName());
        console.log("V4_POOL_MANAGER     ", v4.poolManager);
        console.log("V4_POSITION_MANAGER ", v4.positionManager);
        console.log("V4_QUOTER           ", v4.quoter);
        console.log("V4_STATE_VIEW       ", v4.stateView);
        console.log("V4_SWAP_ROUTER      ", v4.swapRouter);
        console.log("PERMIT2             ", permit2);
    }
}
