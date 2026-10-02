// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {Strings} from "openzeppelin/utils/Strings.sol";
import {DokuToken} from "../src/DokuToken.sol";

/// @dev Stands in for `DokuFactory._deploy`: clone, then initialise with the URI derived from the
///      clone's ACTUAL address — the same order the factory uses, in one call, from one contract.
contract DemoLauncher {
    string public constant BASE = "https://cdn.doku.family/metadata/";

    function launch(address impl, address supplyTo) external returns (address token) {
        token = Clones.clone(impl);
        DokuToken(token).initialize(
            "Gen6 Metadata Demo", "G6DEMO", supplyTo, false, string.concat(BASE, Strings.toHexString(token), ".json")
        );
    }
}

/// @notice A live demonstration of generation 6's metadata surface. Touches no protocol contract.
contract DemoTokenMetadata is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);
        DokuToken impl = new DokuToken();
        DemoLauncher launcher = new DemoLauncher();
        address token = launcher.launch(address(impl), deployer);
        vm.stopBroadcast();
        console2.log("implementation", address(impl));
        console2.log("launcher", address(launcher));
        console2.log("token", token);
        console2.log("metadataURI", DokuToken(token).metadataURI());
    }
}
