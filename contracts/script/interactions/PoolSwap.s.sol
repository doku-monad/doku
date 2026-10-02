// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/// @notice One buy and one sell on a graduated market's v4 pool, through the UniversalRouter —
///         the same two calls the site makes (`lib/chain/pool.ts`). Proves the hook's levy on
///         mainnet without a browser.
///
///   TOKEN        the market's token (currency1 when quoted in MON)
///   HOOK         the DokuHook of the token's generation
///   BUY_MON      MON to spend (wei), default 0.5 MON
///   SELL_PCT     percent of the tokens BOUGHT to sell back, default 50
contract PoolSwap is Script {
    uint8 constant V4_SWAP = 0x10;
    address constant UNIVERSAL_ROUTER = 0x0D97Dc33264bfC1c226207428A79b26757fb9dc3;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        address token = vm.envAddress("TOKEN");
        address hook = vm.envAddress("HOOK");
        uint256 buyMon = vm.envOr("BUY_MON", uint256(0.5 ether));
        uint256 sellPct = vm.envOr("SELL_PCT", uint256(50));

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(hook)
        });

        vm.startBroadcast(pk);
        uint256 before = IERC20(token).balanceOf(me);
        _swap(key, true, buyMon, address(0), token, buyMon);
        uint256 got = IERC20(token).balanceOf(me) - before;
        console2.log("POOL_BUY tokens out", got);

        uint256 sellIn = got * sellPct / 100;
        if (sellIn != 0) {
            IERC20(token).approve(PERMIT2, type(uint256).max);
            IPermit2(PERMIT2).approve(token, UNIVERSAL_ROUTER, uint160(sellIn), uint48(block.timestamp + 1 hours));
            uint256 monBefore = me.balance;
            _swap(key, false, sellIn, token, address(0), 0);
            console2.log("POOL_SELL tokens in", sellIn);
            console2.log("POOL_SELL mon delta (before gas)", me.balance > monBefore ? me.balance - monBefore : 0);
        }
        vm.stopBroadcast();
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn, address cIn, address cOut, uint256 value)
        private
    {
        bytes memory actions = abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
        bytes[] memory params = new bytes[](3);
        // The LIVE router's layout (five fields), which is what the site sends — not the pinned
        // periphery's patched struct, which carries a sixth field the deployed router does not read.
        params[0] = abi.encode(key, zeroForOne, uint128(amountIn), uint128(0), bytes(""));
        params[1] = abi.encode(cIn, amountIn);
        params[2] = abi.encode(cOut, uint256(0));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        IUniversalRouter(UNIVERSAL_ROUTER).execute{value: value}(
            abi.encodePacked(V4_SWAP), inputs, block.timestamp + 1 hours
        );
    }
}
