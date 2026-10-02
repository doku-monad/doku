// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MarketsStub} from "../mocks/MarketsStub.sol";

// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * # The M-02 return leg does not exist on the native path — WHAT THE FINDING WAS, AND WHAT WAS DONE
 *
 * ## The finding (G4-05), kept verbatim because generation 4 is on the chain
 *
 * Generation 4's `DokuGraduation._sweepDust` ended by giving the PositionManager back the balance
 * `Actions.SWEEP` dragged out of it, and the source stated the outcome as fact: "returning it
 * restores exactly the position the third party was in before a DOKU market happened to graduate".
 *
 * That was true for an ERC-20 quote. It was FALSE for MON, and MON is the protocol's flagship
 * quote — every one of the 14 generation-3 markets and every live generation-4 one is denominated
 * in it.
 *
 * The reason is one line of v4-periphery, `src/base/NativeWrapper.sol`:
 *
 *     receive() external payable {
 *         if (msg.sender != address(WETH9) && msg.sender != address(poolManager)) revert InvalidEthSender();
 *     }
 *
 * `_tryPayOut`'s native branch is `to.call{value: amount}("")` with empty calldata, which lands on
 * exactly that `receive()`. The graduator is neither WETH9 nor the PoolManager, so the call always
 * reverted, `_tryPayOut` always returned false, and the fallback the comment described as "the
 * previous behaviour, as the fallback rather than the design" was in fact the ONLY behaviour.
 *
 * The money was not stolen — `notOurs` kept it out of the graduating market's sink, which is what
 * M-02 was about. It was STRANDED, permanently, in a contract with no owner, no rescue and no
 * upgrade. That is a strictly worse outcome for the third party than the ERC-20 path they were told
 * they got, and the code said otherwise.
 *
 * ## THE STATUS OF GENERATION 4: unchanged, and unchangeable
 *
 * `DokuGraduation` at `0xe095018ddeBFe600d456cd8171EDa32823C2b3aA` is immutable. Everything above
 * is still true of it and always will be. It is documented — here, in
 * `docs/doku/audit/2026-09-11-external-gen4/response.md`, and in the source — rather than fixed,
 * because there is nothing to fix it with. A stranger's MON that reaches that contract stays there.
 * It is a strand, not a theft, and the distinction is load-bearing: `notOurs` still keeps it out of
 * every market's credit, so nobody receives it.
 *
 * ## THE GENERATION-5 REPAIR, WHICH IS WHAT THIS FILE NOW ASSERTS
 *
 * The repair is not a better return leg. Returning MON would have meant opening `poolManager.unlock`
 * on the graduator so a `take` could reach POSM wearing the PoolManager's address — a new callback
 * surface on the one code path that holds a market's entire raise and must never revert. That was
 * declined in round 3, and declining it again is the premise of the fix rather than an obstacle to
 * it.
 *
 * Instead, `_mintSeed` no longer sweeps. Its action list is `MINT_POSITION, SETTLE_PAIR`, full
 * stop. A stranger's MON is never dragged out of POSM, so there is nothing to give back, nothing to
 * strand, and no `posmHeld` machinery left in `_sweepDust`. The cost is that the graduator's OWN
 * unspent native stays in POSM too — wei-scale mint-rounding residue, bounded and measured in
 * `test/audit/Gen5NoNativeSweep.t.sol` against the real mainnet PositionManager.
 *
 * The assertions below were written the other way round and have been INVERTED IN PLACE rather than
 * deleted. Each one still fails the day the mechanism moves; it is the direction that changed.
 */
contract Gen4PosmReturnNativeTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0x4A110C);

    DokuHook internal dokuHook;
    DokuGraduation internal graduation;
    CreatorSink internal creatorSink;
    MarketsStub internal markets;

    address internal curveImpl;
    address internal tokenImpl;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);

        creatorSink = new CreatorSink(address(this));
        markets = new MarketsStub();

        bytes memory args =
            abi.encode(IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink));
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(
            IPoolManager(address(manager)), address(this), TREASURY, address(creatorSink)
        );

        graduation = new DokuGraduation(
            address(manager), address(lpm), address(permit2), address(dokuHook), address(markets)
        );
        dokuHook.setGraduator(address(graduation), true);
        creatorSink.setGraduator(address(graduation));
        creatorSink.setFactory(address(markets));

        curveImpl = address(new BondingCurve());
        tokenImpl = address(new DokuToken());
    }

    function _market(uint256 target, uint8 sink, address routed) internal returns (BondingCurve c) {
        c = BondingCurve(payable(Clones.clone(curveImpl)));
        DokuToken t = DokuToken(Clones.clone(tokenImpl));
        t.initialize(unicode"D", unicode"D", address(c), sink == Sinks.REWARDS, "https://cdn.doku.family/metadata/test.json");
        c.initialize(
            address(t),
            address(0),
            target,
            sink,
            routed,
            0,
            ALICE,
            TREASURY,
            address(graduation),
            address(creatorSink)
        );
    }

    /// @notice The mechanism, in one assertion: POSM refuses a bare native send from anyone that is
    ///         not WETH9 or the PoolManager. That is what generation 4's return leg attempted and
    ///         why it could never succeed. Generation 5 no longer attempts it — it has nothing to
    ///         return — so this is kept as the standing proof that the constraint is
    ///         v4-periphery's and still there, not as a description of what our code does.
    function test_posmRefusesABareNativeSend() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(lpm).call{value: 1 ether}("");
        assertFalse(ok, "POSM accepted a bare native send; the finding would be moot");
    }

    /**
     * @notice A third party's MON parked on the shared PositionManager is NOT dragged into the
     *         graduator any more, because the seed mint no longer sweeps.
     *
     * @dev This is the same staging as the generation-4 version of this test — 3 MON resting on
     *      POSM, one native CREATOR market graduating past it — with every assertion turned around.
     *
     *      Generation 4 read: POSM ends at ZERO and the graduator ends holding the whole 3 MON,
     *      permanently. Generation 5 reads: POSM keeps its 3 MON and the graduator ends holding
     *      nothing. The middle assertion never moved — the money must not reach a market's
     *      recipient — and it is the one that makes this a strand rather than a theft in BOTH
     *      generations.
     */
    function test_posmNativeBalanceIsNotDraggedInAtAll() public {
        uint256 target = 1_000e18;

        // Somebody else's MON, resting on the shared PositionManager. Reachable in production: POSM
        // is payable through `modifyLiquidities`, and a caller who over-sends `msg.value` without an
        // `Actions.SWEEP` leaves the remainder there. Which, as of generation 5, is also how the
        // protocol's own mint residue gets there.
        uint256 parked = 3 ether;
        vm.deal(address(lpm), parked);
        assertEq(address(lpm).balance, parked, "stage failed");

        BondingCurve marketB = _market(target, Sinks.CREATOR, MALLORY);
        vm.warp(vm.getBlockTimestamp() + marketB.TAX_WINDOW() + 1);
        vm.deal(MALLORY, 10 * target);
        vm.prank(MALLORY);
        marketB.buy{value: 5 * target}(0, vm.getBlockTimestamp());
        assertTrue(graduation.graduated(address(marketB)), "native market did not graduate");

        PoolId id = graduation.poolIdOf(address(marketB));
        creatorSink.pull(address(marketB));
        uint256 claimable = creatorSink.claimable(MALLORY, address(0));
        // Checked before the subtraction: generation 4 leaves POSM at zero, and an underflow panic
        // would say nothing about why.
        assertGe(address(lpm).balance, parked, "POSM lost native to a DOKU graduation");
        uint256 forfeited = address(lpm).balance - parked;

        emit log_string("--- generation 5: POSM's balance is left where it is ---");
        emit log_named_decimal_uint("third-party MON parked on POSM", parked, 18);
        emit log_named_decimal_uint("POSM balance after our graduation", address(lpm).balance, 18);
        emit log_named_uint("our own residue, forfeited into POSM (wei)", forfeited);
        emit log_named_decimal_uint("left in the immutable graduator", address(graduation).balance, 18);
        emit log_named_decimal_uint("credited to this market's recipient", claimable, 18);
        emit log_named_uint("hook owedSink for this market", dokuHook.owedSink(id));

        // M-02 is still closed, and now by construction rather than by subtraction: the third
        // party's MON did not reach a market's recipient because it never moved.
        assertLt(claimable, parked, "third-party MON still reached a market recipient");

        // The two halves that were the finding, inverted. Generation 4 asserted
        // `address(lpm).balance == 0` and `address(graduation).balance == parked`.
        assertGe(address(lpm).balance, parked, "POSM lost native to a DOKU graduation");
        assertEq(address(graduation).balance, 0, "the graduator is still stranding native");

        // And what DID move into POSM is only ours, and it is dust. The ceiling here is the same
        // tripwire `Gen5NoNativeSweep` uses, restated so this file fails on its own if the residue
        // ever stops being a rounding artefact.
        assertLt(forfeited, 1 gwei, "the protocol forfeited more than dust into POSM");
    }
}
