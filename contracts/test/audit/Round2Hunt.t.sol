// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {DeployDoku} from "../../script/DeployDoku.s.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Launches} from "../helpers/Launches.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

// Compiled only so `vm.getCode` can find them; see DeployDoku.t.sol.
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/**
 * ROUND 2 — auditing round 1's fixes and nothing else.
 *
 * The harness is the real deployment script against a real v4, because "does this market graduate"
 * is only a question about the protocol when nothing in the path is a stub.
 */
contract Round2Hunt is PosmTestSetup {
    using Launches for DokuFactory;

    address internal constant OWNER = address(0x0BEE);
    address internal constant PAUSER = address(0xBA5E);
    address internal constant FEE_RECIPIENT = address(0xFEE);
    address internal constant TREASURY = address(0x7EA);
    address internal constant CREATOR = address(0xC12A);
    address internal constant BUYER = address(0xB0B);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 internal constant TARGET = 1_000e18;
    uint256 internal constant USDC_TARGET = 10_000e6;

    DeployDoku internal script;
    DeployDoku.Deployment internal d;
    MockUSDC internal usdc;
    PoolSwapTest internal swapper;

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        script = new DeployDoku();
        d = script.runWith(_config());
        swapper = new PoolSwapTest(manager);
        vm.deal(CREATOR, 500_000e18);
        vm.deal(BUYER, 5_000_000e18);
        vm.deal(address(this), 500_000e18);
    }

    function _config() internal returns (DeployDoku.Config memory cfg) {
        if (address(usdc) == address(0)) usdc = new MockUSDC();
        cfg.poolManager = address(manager);
        cfg.positionManager = address(lpm);
        cfg.permit2 = address(permit2);
        cfg.owner = OWNER;
        cfg.pauser = PAUSER;
        cfg.feeRecipient = FEE_RECIPIENT;
        cfg.treasury = TREASURY;
        cfg.quoteTarget = TARGET;
        cfg.quoteAssets = new address[](1);
        cfg.quoteAssets[0] = address(usdc);
        cfg.quoteTargets = new uint256[](1);
        cfg.quoteTargets[0] = USDC_TARGET;
        cfg.launchFeeWei = 0.01 ether;
    }

    // -------------------------------------------------------------------------------- machinery

    function _launch(uint8 sink, address routed, address tax) internal returns (address curveAddr, address token) {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        DokuFactory.LaunchParams memory p = factory.params(address(0), sink, 100);
        p.routedRecipient = routed;
        p.taxRecipient = tax;
        uint256 fee = factory.launchFee(CREATOR);
        vm.prank(CREATOR);
        (curveAddr, token) = factory.launch{value: fee}(p);
    }

    function _fill(address curveAddr) internal {
        BondingCurve curve = BondingCurve(payable(curveAddr));
        vm.warp(vm.getBlockTimestamp() + curve.TAX_WINDOW() + 1);
        vm.prank(BUYER);
        curve.buy{value: 5 * TARGET}(0, vm.getBlockTimestamp() + 1 hours);
    }

    function _graduated(address curveAddr) internal view returns (bool) {
        return DokuGraduation(payable(d.graduation)).graduated(curveAddr);
    }

    // ============================================================ ITEM 1: is the refusal complete?
    //
    // Round 1 moved the self-recipient refusal from `CreatorSink.register` — which reverts inside
    // `graduate()` behind `_tryAutoGraduate`'s swallowing call, sealing the entire raise — up to
    // `DokuFactory._recipients`. The guard names exactly ONE address. The cost of having missed a
    // second one is identical to the cost of the bug it fixed, so it has to be enumerated rather
    // than argued.

    /// @notice Every address in the protocol's own graph, named as the CREATOR TAX recipient of a
    ///         BURN market — the leg `DokuGraduation._register` forwards to the sink verbatim.
    function test_item1_noOtherProtocolAddressBricksGraduationAsTaxRecipient() public {
        address[9] memory candidates = [
            d.hook,
            d.graduation,
            d.dokuFactory,
            d.seedLocker,
            d.quoteRegistry,
            address(manager),
            address(lpm),
            address(permit2),
            DEAD
        ];
        for (uint256 i; i < candidates.length; ++i) {
            (address curveAddr,) = _launch(Sinks.BURN, address(0), candidates[i]);
            _fill(curveAddr);
            assertTrue(
                BondingCurve(payable(curveAddr)).readyToGraduate(),
                string.concat("curve did not fill for ", vm.toString(candidates[i]))
            );
            assertTrue(
                _graduated(curveAddr),
                string.concat("GRADUATION BRICKED by tax recipient ", vm.toString(candidates[i]))
            );
        }
    }

    /// @notice The same list on the ROUTED leg of a CREATOR market, the other address `_register`
    ///         forwards.
    function test_item1_noOtherProtocolAddressBricksGraduationAsRoutedRecipient() public {
        address[8] memory candidates = [
            d.hook,
            d.graduation,
            d.dokuFactory,
            d.seedLocker,
            d.quoteRegistry,
            address(manager),
            address(lpm),
            DEAD
        ];
        for (uint256 i; i < candidates.length; ++i) {
            (address curveAddr,) = _launch(Sinks.CREATOR, candidates[i], candidates[i]);
            _fill(curveAddr);
            assertTrue(
                _graduated(curveAddr),
                string.concat("GRADUATION BRICKED by routed recipient ", vm.toString(candidates[i]))
            );
        }
    }

    /// @notice The creator's OWN curve and its OWN token — both computable before the launch that
    ///         creates them, so both are plausible pastes.
    function test_item1_aMarketNamingItsOwnCurveAsRecipientStillGraduates() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        (address predicted, address predictedToken) = factory.predictMarket(CREATOR);
        (address curveAddr,) = _launch(Sinks.BURN, address(0), predicted);
        assertEq(curveAddr, predicted, "prediction moved");
        _fill(curveAddr);
        assertTrue(_graduated(curveAddr), "GRADUATION BRICKED by a self-referential tax recipient");

        (address predicted2, address token2) = factory.predictMarket(CREATOR);
        predicted2;
        (address curveB,) = _launch(Sinks.BURN, address(0), token2);
        _fill(curveB);
        assertTrue(_graduated(curveB), "GRADUATION BRICKED by the market's own token as recipient");
        predictedToken;
    }

    /// @notice And the one address that IS refused — refused at the door, on the input nobody has
    ///         spent anything on yet.
    function test_item1_theSinkIsStillRefusedOnBothLegs() public {
        DokuFactory factory = DokuFactory(d.dokuFactory);
        address sink = factory.creatorSink();
        uint256 fee = factory.launchFee(CREATOR);

        DokuFactory.LaunchParams memory p = factory.params(address(0), Sinks.BURN, 100);
        p.taxRecipient = sink;
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.RecipientNotAllowed.selector);
        factory.launch{value: fee}(p);

        DokuFactory.LaunchParams memory q = factory.params(address(0), Sinks.CREATOR, 0);
        q.routedRecipient = sink;
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.RecipientNotAllowed.selector);
        factory.launch{value: fee}(q);
    }

    /// @notice Can a recipient BECOME the sink after launch? The curve pins both recipients at
    ///         `initialize` and has no setter; `CreatorSink.transferRecipient` is the only writer of
    ///         a recipient anywhere in the protocol, and round 1 closed it against the sink.
    function test_item1_thereIsNoPostLaunchPathThatMakesARecipientTheSink() public {
        (address curveAddr,) = _launch(Sinks.CREATOR, address(0xA11CE), address(0xA11CE));
        _fill(curveAddr);
        assertTrue(_graduated(curveAddr), "setup: market did not graduate");

        CreatorSink sink = CreatorSink(payable(d.creatorSink));
        vm.prank(address(0xA11CE));
        vm.expectRevert(CreatorSink.SinkIsNotARecipient.selector);
        sink.transferRecipient(curveAddr, address(sink));

        assertEq(BondingCurve(payable(curveAddr)).routedRecipient(), address(0xA11CE), "routed moved");
        assertEq(BondingCurve(payable(curveAddr)).taxRecipient(), address(0xA11CE), "tax moved");
    }

    // ======================================== ITEM 4: the BURN quote leg the locker now strands
    //
    // KILL TEST. `SeedLocker.collect` never forwards a BURN market's quote leg, so round 1's delta
    // turned "swept by the next market" into "stranded for ever". That is only a real loss if the
    // PROTOCOL puts quote on a BURN market's seed position. It does not: `DokuHook._lpQuoteBps`
    // returns 0 for `SINK_BURN`, so the 70 bps LP donation is taken on the TOKEN leg — which
    // `collect` DOES forward, to the burn sink. The only quote that can land there is a voluntary
    // third-party `poolManager.donate` or a misdirected send.

    function test_item4_aBurnMarketsSeedPositionEarnsNoQuoteFromTheProtocol() public {
        (address curveAddr, address token) = _launch(Sinks.BURN, address(0), address(0xDEFA17));
        _fill(curveAddr);
        assertTrue(_graduated(curveAddr), "did not graduate");

        uint256 tokenId = _tokenIdOf(curveAddr);
        PoolKey memory key = _keyOf(token);

        for (uint256 i; i < 6; ++i) {
            _swap(key, true, 50 ether);
            _swap(key, false, IERC20(token).balanceOf(address(this)) / 2);
        }

        uint256 before = d.seedLocker.balance;
        SeedLocker(payable(d.seedLocker)).collect(tokenId);
        uint256 strandedQuote = d.seedLocker.balance - before;

        emit log_named_uint("wei of MON stranded in the locker by a BURN collect", strandedQuote);
        assertEq(
            strandedQuote,
            0,
            "the protocol DOES donate quote to a BURN market's LPs - the permanent strand is real"
        );
    }

    /// @dev The control, re-based on the generation-4 money path. It used to prove that a REWARDS
    ///      market's seed position EARNED the quote and `collect` forwarded it — so the BURN zero
    ///      above was a property of the levy split rather than of a dead test. Since the M-04
    ///      decision (2026-09-11) the seed position earns nothing: the 70 bps LP share is booked
    ///      straight to `pendingSink` in `_settleLeg` and `poolManager.donate` is gone from `src/`.
    ///      The control therefore asserts the NEW route end to end — swaps leave `collect` with
    ///      nothing to forward, the same value sits in `pendingSink`, and a permissionless `sweep`
    ///      moves it to `owedSink` — which still makes the BURN zero above non-vacuous, because it
    ///      shows the quote-paying sink's share is real and reaches the ledger by the live path.
    function test_item4_aRewardsMarketsSeedPositionEarnsNothingAndTheSinkShareArrivesByTheLedger() public {
        (address curveAddr, address token) = _launch(Sinks.REWARDS, address(0), address(0xDEFA17));
        _fill(curveAddr);
        assertTrue(_graduated(curveAddr), "did not graduate");

        uint256 tokenId = _tokenIdOf(curveAddr);
        PoolKey memory key = _keyOf(token);
        PoolId id = PoolIdLibrary.toId(key);

        for (uint256 i; i < 6; ++i) {
            _swap(key, true, 50 ether);
            _swap(key, false, IERC20(token).balanceOf(address(this)) / 2);
        }

        DokuHook hook = DokuHook(payable(d.hook));
        uint256 pendingAfterSwaps = hook.pendingSink(id);
        assertGt(pendingAfterSwaps, 0, "the swaps booked nothing to the sink share");

        // The seed position has nothing to forward: no pool fee (POOL_LP_FEE == 0) and no donation.
        uint256 owedBefore = hook.owedSink(id);
        uint256 lockerBefore = d.seedLocker.balance;
        SeedLocker(payable(d.seedLocker)).collect(tokenId);
        assertEq(hook.owedSink(id), owedBefore, "collect forwarded quote a seed position no longer earns");
        assertEq(d.seedLocker.balance, lockerBefore, "the locker kept some of it");

        // The live route: anyone sweeps, and exactly the booked share becomes owed.
        hook.sweep(id);
        uint256 credited = hook.owedSink(id) - owedBefore;
        emit log_named_uint("sink share booked by swaps and swept to the ledger (wei)", credited);
        assertEq(credited, pendingAfterSwaps, "sweep moved something other than the booked share");
        assertEq(hook.pendingSink(id), 0, "sweep left part of the share behind");
    }

    function _tokenIdOf(address curveAddr) internal view returns (uint256) {
        address want = DokuGraduation(payable(d.graduation)).sinkOf(curveAddr);
        for (uint256 id = 1; id < 40; ++id) {
            (, address sink,,) = SeedLocker(payable(d.seedLocker)).positionOf(id);
            if (sink == want) return id;
        }
        revert("no position");
    }

    function _keyOf(address token) internal view returns (PoolKey memory key) {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: DokuGraduation(payable(d.graduation)).LP_FEE(),
            tickSpacing: DokuGraduation(payable(d.graduation)).TICK_SPACING(),
            hooks: IHooks(d.hook)
        });
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal {
        if (amountIn == 0) return;
        if (!zeroForOne) {
            address token = Currency.unwrap(key.currency1);
            IERC20(token).approve(address(swapper), amountIn);
        }
        swapper.swap{value: zeroForOne ? amountIn : 0}(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }
}
