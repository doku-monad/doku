// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {DokuGraduation} from "../../src/DokuGraduation.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {CreatorSink} from "../../src/sinks/CreatorSink.sol";

/// @notice The 2026-09-11 review's two findings, measured against the MAINNET DEPLOYMENT rather
///         than against the source they were read from.
///
/// @dev Both findings are about a slot whose contents cannot be inferred from the code: the curve's
///      `graduator` is whatever the factory's mutable storage held at the instant it launched, and
///      the wiring H-02 is about lives across four contracts none of which the source pins. So the
///      only honest way to size either of them is to read the chain.
///
///      The market list is EXHAUSTIVE, not a sample: every `MarketLaunched` log the generation-3
///      factory has ever emitted, scanned from its deploy block 103,427,913 to head in the
///      100-block windows Monad's `eth_getLogs` allows. Fourteen. If a fifteenth exists this file is
///      wrong, so `test_theMarketListIsComplete` re-derives the count from the factory's own
///      per-creator nonces rather than trusting the scan that produced the list.
///
///      Everything here skips rather than fails without an RPC, so the suite stays runnable offline.
contract LiveWiringForkTest is Test {
    uint256 constant MONAD_MAINNET = 143;

    address constant FACTORY = 0x944361ad97083AB1EaaCC106034D88c7D5593493;
    address constant GRADUATION = 0x98fC11774910c62b2Dd15Be11758C6740ac9940E;
    address constant HOOK = 0xb1A67a7c8000a86e0b1E5C019EBf859ce71C6Fcf;
    address constant CREATOR_SINK = 0x22aD9078001b42fc91E4AF876bbD51c878CA513a;
    address constant SEED_LOCKER = 0xC34Cff32B056F2eEb2f1edD35A336f4fEeD29Abc;
    address constant OWNER_EOA = 0x176F7D61FAf64031C6917bd1091e69eEcC93316a;

    address constant POOL_MANAGER = 0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e;
    address constant POSITION_MANAGER = 0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address constant USDC = 0x754704Bc059F8C67012fEd69BC8A327a5aafb603;
    /// @dev `FiatTokenV2_2` packs the blacklist flag into the top bit of the balance word, which is
    ///      why `deal` cannot find it and slot 9 is written by hand. Inherited from `Fork.t.sol`.
    uint256 constant USDC_BALANCE_SLOT = 9;
    address constant WBTC = 0x0555E30da8f98308EdB960aa94C0Db47230d2B9c;

    address constant BUYER = address(0xB0B);

    DokuFactory internal factory;
    DokuGraduation internal graduation;

    function _fork() internal returns (bool) {
        string memory url = vm.envOr("MONAD_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        uint256 pinned = vm.envOr("MONAD_FORK_BLOCK", uint256(0));
        if (pinned == 0) vm.createSelectFork(url);
        else vm.createSelectFork(url, pinned);
        assertEq(block.chainid, MONAD_MAINNET, "RPC is not Monad mainnet");
        factory = DokuFactory(FACTORY);
        graduation = DokuGraduation(payable(GRADUATION));
        return true;
    }

    /// @dev Every generation-3 market, in launch order. `quote` is the market's quote asset.
    function _markets() internal pure returns (address[14] memory curves, address[14] memory quotes) {
        curves = [
            0x75D3bd4e9D6e63b8dC425555C1C71C1C7c8a7357,
            0xF748E337CE0966AEfa98557D4132b65fdAd53b3e,
            0x407Fde04c1E391e5110e7071D9F09D56ed5A9d51,
            0xF6c5f348Df4eBAc4EB0302f5094A083301728046,
            0x9a08df72dD89bF35634032764e82B070197F17e8,
            0xb57170f907D18a24f44f02c39690C66F74bDE17E,
            0xAdb93e7DdB73aB2C3BdE975360db7B9Fe3fE5f71,
            0xA981C08046A689AF61925fF19D5817c51A1A5a72,
            0x33f2c81fE2E955d5Df4795Cbd9DCAFFBd156A221,
            0x423b9914885AeC616b63D479BF8B4dbE752F49cd,
            0x3E9D93bad0DE8664863C97C3d86Bf2Ea869a5404,
            0xc1e98c18DD977f6bb923f2Bd95F1033E2DFe1242,
            0xB190F80240bf80B411722134Ee6422F5E7E6e386,
            0xAeb9c97189B67C6AB1fa31b7B998814e4C53F7F5
        ];
        quotes = [
            address(0),
            address(0),
            address(0),
            address(0),
            address(0),
            address(0),
            address(0),
            WBTC,
            address(0),
            USDC,
            address(0),
            WBTC,
            WBTC,
            USDC
        ];
    }

    // ------------------------------------------------------------------------------- H-01, live

    /// @dev The finding's premise is that this slot can hold an EOA. It can. The measurement is
    ///      what it holds.
    function test_theLiveGraduatorIsAContractWiredToThisFactory() public {
        if (!_fork()) return;
        address g = factory.graduator();
        assertEq(g, GRADUATION, "the factory's graduator is not the deployed graduation contract");
        assertGt(g.code.length, 0, "the factory's graduator is an EOA");
        assertEq(address(DokuGraduation(payable(g)).factory()), FACTORY, "the graduator answers for another factory");
        // An EOA, or an EOA carrying an EIP-7702 delegation designator (0xef0100 ++ address, 23
        // bytes) — the deploy key acquired one on 2026-09-13. Either way it is a key, not a contract
        // of its own, which is what the H-01 story turns on.
        bytes memory ownerCode = OWNER_EOA.code;
        bool plainEoa = ownerCode.length == 0;
        bool delegatedEoa = ownerCode.length == 23 && ownerCode[0] == 0xef && ownerCode[1] == 0x01 && ownerCode[2] == 0x00;
        assertTrue(plainEoa || delegatedEoa, "the owner is a contract, which changes the H-01 story");
    }

    /// @dev The slot the finding is actually about. A curve's `graduator` is written once, at
    ///      `initialize`, from whatever the factory held at that instant — so the factory reading
    ///      correctly today says nothing about what any given market pinned. Fourteen reads.
    function test_everyLiveMarketPinsTheRealGraduator() public {
        if (!_fork()) return;
        (address[14] memory curves,) = _markets();
        for (uint256 i; i < curves.length; ++i) {
            assertTrue(factory.isMarket(curves[i]), "the market list contains something the factory did not launch");
            address g = BondingCurve(payable(curves[i])).graduator();
            assertEq(g, GRADUATION, "a live market pinned something other than the graduation contract");
            assertTrue(g != OWNER_EOA, "a live market pinned the owner EOA");
        }
    }

    /// @dev The scan that produced the list above could have missed a window. The factory's own
    ///      per-creator nonce is the independent count: every launch increments exactly one.
    function test_theMarketListIsComplete() public {
        if (!_fork()) return;
        (address[14] memory curves,) = _markets();
        address[] memory creators = new address[](curves.length);
        uint256 distinct;
        for (uint256 i; i < curves.length; ++i) {
            address c = factory.creatorOf(curves[i]);
            bool seen;
            for (uint256 j; j < distinct; ++j) {
                if (creators[j] == c) seen = true;
            }
            if (!seen) creators[distinct++] = c;
        }
        uint256 total;
        for (uint256 j; j < distinct; ++j) {
            total += factory.nonces(creators[j]);
        }
        assertEq(total, curves.length, "the factory has launched markets this list does not contain");
    }

    // ------------------------------------------------------------------------------- H-02, live

    /// @dev Every wire the finding says `launch` does not check, read off the chain. All four
    ///      contracts, and the three that are one-shot and therefore unrecoverable if wrong.
    function test_theLiveDependencyGraphIsWhole() public {
        if (!_fork()) return;
        DokuHook hook = DokuHook(payable(HOOK));
        CreatorSink sink = CreatorSink(payable(CREATOR_SINK));

        assertTrue(hook.isGraduator(GRADUATION), "the hook does not allowlist the graduator");
        assertEq(hook.creatorSink(), CREATOR_SINK, "the hook routes registration to another sink");

        assertEq(sink.graduator(), GRADUATION, "the sink's one-shot graduator is wrong and cannot be fixed");
        assertEq(sink.factory(), FACTORY, "the sink's one-shot factory is wrong and cannot be fixed");
        assertEq(sink.hook(), HOOK, "the sink learned another hook");

        assertEq(address(graduation.hook()), HOOK, "the graduator holds another hook");
        assertEq(address(graduation.poolManager()), POOL_MANAGER, "the graduator holds another PoolManager");
        assertEq(address(graduation.positionManager()), POSITION_MANAGER, "the graduator holds another POSM");
        assertEq(address(graduation.permit2()), PERMIT2, "the graduator holds another Permit2");
        assertEq(address(graduation.locker()), SEED_LOCKER, "the graduator holds another SeedLocker");

        assertGt(POOL_MANAGER.code.length, 0, "no PoolManager on this chain");
        assertGt(POSITION_MANAGER.code.length, 0, "no PositionManager on this chain");
        assertGt(PERMIT2.code.length, 0, "no Permit2 on this chain");
    }

    /// @dev The claim under test is "a market can launch and fill and then never graduate". So fill
    ///      one of each quote asset, on the real deployment, with the real hook and the real
    ///      Uniswap v4, and see whether it graduates. A simulation is the only thing that answers
    ///      this: every read above could be right and the graduation could still revert somewhere
    ///      the reads do not reach.
    function test_everyLiveMarketStillGraduates() public {
        if (!_fork()) return;
        (address[14] memory curves, address[14] memory quotes) = _markets();
        uint256 graduatedCount;
        for (uint256 i; i < curves.length; ++i) {
            BondingCurve c = BondingCurve(payable(curves[i]));
            if (c.released()) continue; // nothing to prove about a market already through
            _fill(c, quotes[i]);
            assertTrue(c.readyToGraduate(), "the curve did not latch as filled");
            assertTrue(c.released(), "the curve filled and was not released: the raise is stuck");
            assertTrue(graduation.graduated(curves[i]), "graduation did not record this market");
            assertTrue(PoolId.unwrap(graduation.poolIdOf(curves[i])) != bytes32(0), "no pool was created");
            graduatedCount++;
        }
        assertEq(graduatedCount, curves.length, "not every market was exercised");
    }

    /// @dev What the raise actually is, in raw quote units, so the exposure figure in the report is
    ///      a measurement rather than an estimate. Logged rather than asserted: it moves with every
    ///      trade, and a hard number here would be a test that fails for the wrong reason.
    function test_reportTheRaiseSittingInEveryUngraduatedCurve() public {
        if (!_fork()) return;
        (address[14] memory curves, address[14] memory quotes) = _markets();
        uint256 mon;
        uint256 usdc;
        uint256 wbtc;
        for (uint256 i; i < curves.length; ++i) {
            BondingCurve c = BondingCurve(payable(curves[i]));
            if (c.released()) continue;
            uint256 raised = c.quoteRaised();
            if (quotes[i] == address(0)) mon += raised;
            else if (quotes[i] == USDC) usdc += raised;
            else wbtc += raised;
            emit log_named_decimal_uint(vm.toString(curves[i]), raised, quotes[i] == address(0) ? 18 : (quotes[i] == USDC ? 6 : 8));
        }
        emit log_named_decimal_uint("TOTAL MON at risk", mon, 18);
        emit log_named_decimal_uint("TOTAL USDC at risk", usdc, 6);
        emit log_named_decimal_uint("TOTAL WBTC at risk", wbtc, 8);
    }

    // --------------------------------------------------------------------------- forward risk

    /// @dev H-01's teeth are prospective. The owner can put itself back in the graduator slot on the
    ///      DEPLOYED factory today — the exemption is in the bytecode and cannot be patched — and
    ///      this proves what that does and does not reach.
    function test_theOwnerCanStillPinItselfIntoEveryFutureMarket() public {
        if (!_fork()) return;
        (address[14] memory curves,) = _markets();

        vm.prank(OWNER_EOA);
        factory.setGraduator(OWNER_EOA);
        assertEq(factory.graduator(), OWNER_EOA, "the deployed setGraduator refused its own owner");

        // Existing markets are untouched: `graduator` is written once, at `initialize`.
        for (uint256 i; i < curves.length; ++i) {
            assertEq(
                BondingCurve(payable(curves[i])).graduator(),
                GRADUATION,
                "an existing market's graduator moved, which the curve has no setter for"
            );
        }
    }

    /// @dev And the non-owner half of the question: nobody else can.
    function test_nobodyButTheOwnerCanMoveTheGraduator() public {
        if (!_fork()) return;
        vm.prank(address(0xBAD));
        vm.expectRevert();
        factory.setGraduator(address(0xBAD));
        assertEq(factory.graduator(), GRADUATION, "a stranger moved the graduator");
    }

    /// @dev The whole of H-01 in one transaction, against the live bytecode: the owner takes the
    ///      graduator slot, a market launches under it, fills, reports nothing wrong, and the owner
    ///      walks off with the raise. This is what the deployed contracts permit; it is not what
    ///      they are currently doing.
    function test_anEoaGraduatorTakesTheWholeRaiseOfAFutureMarket() public {
        if (!_fork()) return;
        // The generation-3 factory was PAUSED at the generation-4 cutover (2026-09-12, block
        // 103969321) — the one control the H-01/H-02 record names. This test is about what the
        // owner key could do with a factory that can still launch, so it lifts the pause on the
        // fork with that same key; the property it proves is unchanged, and the pause staying in
        // place on chain is exactly what stops it from being live.
        if (factory.paused()) {
            vm.prank(OWNER_EOA);
            factory.unpause();
        }
        vm.prank(OWNER_EOA);
        factory.setGraduator(OWNER_EOA);

        address creator = address(0xC0FFEE);
        vm.deal(creator, 2_000_000 ether);
        DokuFactory.LaunchParams memory p;
        p.meta.name = "Canary";
        p.meta.ticker = "CNRY";
        p.quoteAsset = address(0);
        p.sink = 0; // BURN
        p.economicsPin = factory.economicsPin(address(0), 0, 0);
        p.deadline = vm.getBlockTimestamp() + 1 hours;
        vm.prank(creator);
        (address curve,) = factory.launch{value: factory.launchFee(creator)}(p);

        BondingCurve c = BondingCurve(payable(curve));
        assertEq(c.graduator(), OWNER_EOA, "the new market did not pin the EOA");

        _fill(c, address(0));
        // The curve is closed and thinks nothing is wrong: the auto-graduation call to an EOA
        // returns success with empty returndata, so `AutoGraduationFailed` is never even emitted.
        assertTrue(c.readyToGraduate(), "the canary did not fill");
        assertFalse(c.released(), "an EOA graduator somehow released");
        assertFalse(graduation.graduated(curve), "the real graduator recorded a market it never saw");

        uint256 before = OWNER_EOA.balance;
        uint256 seed = c.seedBase();
        vm.prank(OWNER_EOA);
        c.release();
        assertEq(OWNER_EOA.balance - before, c.quoteTarget(), "the EOA did not receive the whole raise");
        assertEq(IERC20(c.token()).balanceOf(OWNER_EOA), seed, "the EOA did not receive the seed");
    }

    // ------------------------------------------------------------------------------- plumbing

    /// @dev Fill a curve in one buy. Overshoot is refunded by the curve, so the only thing that has
    ///      to be right is that it is enough.
    function _fill(BondingCurve c, address quote) private {
        // Past the anti-sniper window, so the fill is not fighting a decaying rate. `via_ir` folds
        // `block.timestamp` across `vm.warp`, so the clock is read through the cheatcode.
        vm.warp(vm.getBlockTimestamp() + c.TAX_WINDOW() + 1);
        uint256 need = (c.quoteTarget() - c.quoteRaised()) * 3 + 1e6;
        if (quote == address(0)) {
            vm.deal(BUYER, need);
            vm.prank(BUYER);
            c.buy{value: need}(0, vm.getBlockTimestamp() + 1 hours);
        } else {
            _fund(quote, BUYER, need);
            vm.startPrank(BUYER);
            IERC20(quote).approve(address(c), type(uint256).max);
            c.buyWithToken(need, 0, vm.getBlockTimestamp() + 1 hours);
            vm.stopPrank();
        }
    }

    /// @dev `deal` finds most balance slots by probing. USDC's is packed with a blacklist flag in
    ///      the top bit and it cannot, so that one is written by hand and READ BACK — a write to the
    ///      wrong slot is otherwise indistinguishable from a token that simply has no balance.
    function _fund(address token, address to, uint256 amount) private {
        if (token == USDC) {
            vm.store(USDC, keccak256(abi.encode(to, USDC_BALANCE_SLOT)), bytes32(amount));
        } else {
            deal(token, to, amount, true);
        }
        assertGe(IERC20(token).balanceOf(to), amount, "funding the buyer did not take");
    }
}
