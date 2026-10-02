// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {NetworkConfig} from "../config/NetworkConfig.sol";

/// @notice Launches one market and optionally trades it, without graduating it.
///
/// @dev So a deployment has markets at more than one stage and in more than one quote. A grid where
///      every market has graduated exercises none of the curve UI, and a grid with one market
///      exercises none of the sorting — both worth looking at before calling the frontend tested.
///
///      Every economic term is read from the environment and PINNED through `economicsPin`, exactly
///      as the frontend must do it, so a target the owner changed between quoting and sending
///      reverts here rather than launching under terms nobody agreed to.
///
///        DOKU_FACTORY        required
///        TICKER              required, 2..12 [A-Za-z0-9]
///        MARKET_NAME         default "DOKU"
///        LOGO_URI            default ""
///        BANNER_URI          default ""
///        DESCRIPTION         default ""
///        WEBSITE             default ""
///        X_URL               default ""
///        TELEGRAM            default ""
///        QUOTE_ASSET         default address(0) = native MON; must be enabled in the registry
///        SINK                0 buyback, 1 holders, 2 creator (default 0) — IMMUTABLE once sent
///        CREATOR_TAX_BPS     default 0; <= 1000, multiple of 10
///        ROUTED_RECIPIENT    default zero (creator when SINK=2; must be zero otherwise)
///        TAX_RECIPIENT       default zero = the sender
///        FIRST_BUY           quote raw units bought untaxed in the launch tx (default 0)
///        BUY_AMOUNT          a later, taxed buy (default 0)
///        SELL_FRACTION       percent of the sender's tokens to sell back (default 0)
contract LaunchMarket is Script {
    function run() external {
        DokuFactory factory = DokuFactory(
            NetworkConfig.requireAddress(
                "DOKU_FACTORY", "the factory to launch through; take it from deployments/<network>.json"
            )
        );
        address quote = vm.envOr("QUOTE_ASSET", address(0));
        // Which sink the creator chose. It is IMMUTABLE from the moment this transaction lands, so
        // a script that silently defaulted would be making the one decision nobody can revisit —
        // hence it is named here rather than buried in the params builder.
        uint8 sink = uint8(vm.envOr("SINK", uint256(0)));
        uint16 tax = uint16(vm.envOr("CREATOR_TAX_BPS", uint256(0)));

        DokuFactory.LaunchParams memory p;
        p.meta = DokuFactory.Metadata({
            name: vm.envOr("MARKET_NAME", string("DOKU")),
            ticker: vm.envString("TICKER"),
            logoURI: vm.envOr("LOGO_URI", string("")),
            bannerURI: vm.envOr("BANNER_URI", string("")),
            description: vm.envOr("DESCRIPTION", string("")),
            website: vm.envOr("WEBSITE", string("")),
            x: vm.envOr("X_URL", string("")),
            telegram: vm.envOr("TELEGRAM", string(""))
        });
        p.quoteAsset = quote;
        p.sink = sink;
        p.routedRecipient = vm.envOr("ROUTED_RECIPIENT", address(0));
        p.creatorTaxBps = tax;
        p.taxRecipient = vm.envOr("TAX_RECIPIENT", address(0));
        p.economicsPin = factory.economicsPin(quote, sink, tax);
        p.firstBuyQuote = vm.envOr("FIRST_BUY", uint256(0));
        p.firstBuyMinOut = 0;
        p.deadline = block.timestamp + 1 hours;

        uint256 buyAmount = vm.envOr("BUY_AMOUNT", uint256(0));
        uint256 sellFraction = vm.envOr("SELL_FRACTION", uint256(0));
        uint256 fee = factory.launchFee(msg.sender);

        vm.startBroadcast();

        // Native pays the fee and the first buy in the same `value`; an ERC-20 quote pays only the
        // fee that way and the first buy is pulled, so it needs an approval first.
        address curveAddr;
        if (quote == address(0)) {
            (curveAddr,) = factory.launch{value: fee + p.firstBuyQuote}(p);
        } else {
            if (p.firstBuyQuote != 0) IERC20(quote).approve(address(factory), p.firstBuyQuote);
            (curveAddr,) = factory.launch{value: fee}(p);
        }
        BondingCurve curve = BondingCurve(payable(curveAddr));

        if (buyAmount > 0) {
            if (quote == address(0)) {
                curve.buy{value: buyAmount}(0, block.timestamp + 1 hours);
            } else {
                IERC20(quote).approve(curveAddr, buyAmount);
                curve.buyWithToken(buyAmount, 0, block.timestamp + 1 hours);
            }
        }

        // A sell after the buy, so some markets sit below their all-time high rather than every
        // one of them pinning at it — which is what the market cards measure against.
        if (sellFraction > 0) {
            uint256 held = curve.token().balanceOf(msg.sender);
            uint256 amount = (held * sellFraction) / 100;
            if (amount > 0) {
                curve.token().approve(curveAddr, amount);
                curve.sell(amount, 0, block.timestamp + 1 hours);
            }
        }

        vm.stopBroadcast();

        console.log("LAUNCHED", curveAddr);
        console.log("  quote ", quote);
        console.log("  raised", curve.quoteRaised());
    }
}
