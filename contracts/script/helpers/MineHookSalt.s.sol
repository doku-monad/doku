// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {DokuHook, DOKU_HOOK_FLAGS} from "../../src/v4/DokuHook.sol";
import {NetworkConfig} from "../config/NetworkConfig.sol";

/// @notice Mines the CREATE2 salt that puts `DokuHook` at an address encoding its permission bits.
///
/// @dev ## There are FOUR salts, not one, and none of them transfers
///
///      `HookMiner.find` folds the deployer into
///      `keccak256(0xFF ++ deployer ++ salt ++ keccak256(creationCode ++ ctorArgs))`, so a salt is
///      valid only for one (deployer, creation code, ctor args) triple. In practice that means:
///      mainnet-via-proxy, testnet-via-proxy, and the two `address(this)` salts the tests mine
///      themselves in `setUp`. Never copy one into another context.
///
///      And every gen-2 salt also depends on the CreatorSink's address, so it cannot be mined
///      before that contract is deployed — `DeployDoku` mines inside the broadcast for that
///      reason; this script is for re-deriving a recorded salt.
///
///      The two mining contexts genuinely differ and the difference is invisible. Inside
///      `vm.startBroadcast()` Foundry rewrites `new Hook{salt: s}(...)` into a raw CREATE2 call to
///      the deterministic deployer proxy `0x4e59b448…`; inside a plain test it does not. Mine
///      against the proxy and then deploy from a test contract and you get a different address and
///      a `HookAddressNotValid` revert out of `BaseHook`'s constructor.
///
///      ## Why this does not just call `HookMiner.find`
///
///      `HookMiner` hard-codes `MAX_LOOP = 160_444` and scans salts `0,1,2,…` in order. At a
///      1-in-16,384 hit rate that exhausts about once in 17,908 attempts — and because the scan is
///      deterministic, re-running the identical script reproduces the identical failure forever
///      rather than eventually succeeding. This loop takes a caller-supplied `start` so a stuck
///      mine can be moved rather than retried.
///
///      It also drops `HookMiner`'s `hookAddress.code.length == 0` filter. That check reads local
///      state, which offline is empty, so it silently makes a script's answer depend on which
///      chain the RPC happened to point at.
///
///      ## The record is atomic
///
///      Salt, predicted address, creation-code hash, solc version and the v4-periphery commit are
///      ONE record. Change any of them and the rest are void: the creation code hash covers the
///      whole import closure, and a hook deployed at a stale prediction reverts in its own
///      constructor. Copy the printed block into `docs/doku/deployments.md` verbatim.
///
///      Usage:
///        forge script script/helpers/MineHookSalt.s.sol \
///          --sig "run(address,address,address,address,uint256)" \
///          <poolManager> <hookOwner> <treasury> <creatorSink> <startSalt>
contract MineHookSalt is Script {
    uint160 internal constant FLAG_MASK = 0x3FFF;

    /// @dev Bounded so a wedged mine fails visibly rather than burning an unbounded budget. Move
    ///      `start` and run again instead of raising this.
    uint256 internal constant SCAN = 400_000;

    error NoSaltFound(uint256 start, uint256 scanned);

    function run(address poolManager, address hookOwner, address treasury, address creatorSink, uint256 start)
        external
        pure
    {
        bytes memory initCode = abi.encodePacked(
            type(DokuHook).creationCode, abi.encode(IPoolManager(poolManager), hookOwner, treasury, creatorSink)
        );
        bytes32 initCodeHash = keccak256(initCode);
        uint160 want = DOKU_HOOK_FLAGS;

        for (uint256 salt = start; salt < start + SCAN; ++salt) {
            address candidate = address(
                uint160(
                    uint256(
                        keccak256(
                            abi.encodePacked(bytes1(0xFF), NetworkConfig.CREATE2_DEPLOYER, bytes32(salt), initCodeHash)
                        )
                    )
                )
            );
            if (uint160(candidate) & FLAG_MASK == want) {
                console2.log("--- copy this whole block into docs/doku/deployments.md ---");
                console2.log("poolManager       ", poolManager);
                console2.log("hookOwner         ", hookOwner);
                console2.log("treasury          ", treasury);
                console2.log("creatorSink       ", creatorSink);
                console2.log("salt              ", salt);
                console2.log("predictedAddress  ", candidate);
                console2.log("hookFlags         ", uint256(want));
                console2.log("creationCodeHash  ", vm.toString(keccak256(type(DokuHook).creationCode)));
                console2.log("initCodeHash      ", vm.toString(initCodeHash));
                console2.log("deployer          ", NetworkConfig.CREATE2_DEPLOYER);
                console2.log("solc               0.8.26");
                console2.log("v4-periphery       see contracts/dependencies.toml [v4-periphery].rev");
                console2.log("--- all of the above are one record; changing any voids the rest ---");
                return;
            }
        }
        revert NoSaltFound(start, SCAN);
    }
}
