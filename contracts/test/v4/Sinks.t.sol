// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {BurnSink} from "../../src/sinks/BurnSink.sol";
import {RewardVault} from "../../src/sinks/RewardVault.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";

/// @notice The two sinks. Both are swap-free, which is what removes every keeper and MEV surface.
contract SinksTest is Test {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    /// @dev Stands in for `SeedLocker` in the exclusion set; this fixture mints the seed nowhere.
    address internal constant LOCKER_STAND_IN = address(0x10C4E2);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;

    /// @dev The quote targets the registry ships with, and therefore the only figures the vault's
    ///      epoch floor is ever derived from. Same numbers as `QuoteRegistry.t.sol`.
    uint256 internal constant MON_TARGET = 1_000e18;
    uint256 internal constant USDC_TARGET = 8_000e6;

    PoolManager internal manager;
    DokuHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;

    /// @dev DokuToken initialises ITSELF in its constructor so the implementation can never
    ///      be claimed. It only works as an EIP-1167 clone, which is how the factory uses it.
    address internal tokenImpl;

    address internal graduator = address(0x6AD);
    address internal curveAddr = address(0xC0FFEE);

    receive() external payable {}

    function setUp() public {
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(IPoolManager(address(manager)));
        lp = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        hook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        hook.setGraduator(graduator, true);
        tokenImpl = address(new DokuToken());
        vm.deal(address(this), 500_000 ether);
    }

    /// @dev Built in three steps rather than one, so the sink can be deployed BEFORE the market is
    ///      registered. `registerPool` freezes `sinkAddr` for the life of the market, and predicting
    ///      the sink's address instead is brittle — every clone and every helper deployment moves
    ///      the nonce.
    function _mkToken(bool track) internal returns (DokuToken t) {
        t = DokuToken(Clones.clone(tokenImpl));
        t.initialize("D", "D", curveAddr, track, "https://cdn.doku.family/metadata/test.json");
    }

    function _mkKey(DokuToken t) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(t)),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /// @dev The token is passed rather than read off `currency1`. A quote asset sorts to whichever
    ///      side its address falls on, so "currency1 is the launch token" is only true while the
    ///      quote is native MON — and where it is false, `registerPool` would record the launch
    ///      token AS the quote and every levy afterwards would be denominated in the wrong asset.
    function _register(PoolKey memory k, address token, uint8 kind, address sinkAddr) internal {
        vm.startPrank(graduator);
        manager.initialize(k, SQRT_1_1);
        hook.registerPool(k, token, kind, sinkAddr, 0);
        vm.stopPrank();
    }

    function _seed(PoolKey memory k, DokuToken t) internal {
        vm.prank(curveAddr);
        t.transfer(address(this), 40_000_000e18);
        t.approve(address(lp), type(uint256).max);
        t.approve(address(swapper), type(uint256).max);
        lp.modifyLiquidity{value: 5_000 ether}(
            k, ModifyLiquidityParams({tickLower: -6000, tickUpper: 6000, liquidityDelta: 500 ether, salt: 0}), ""
        );
    }

    function _burnMarket() internal returns (DokuToken token, PoolKey memory key, PoolId id, BurnSink sink) {
        token = _mkToken(false);
        key = _mkKey(token);
        id = PoolIdLibrary.toId(key);
        sink = new BurnSink(address(hook), address(token), id);
        _register(key, address(token), Sinks.BURN, address(sink));
        _seed(key, token);
    }

    function _rewardsMarket(uint256 genesis)
        internal
        returns (DokuToken token, PoolKey memory key, PoolId id, RewardVault v)
    {
        return _rewardsMarketWith(genesis, true);
    }

    /// @dev `track` is a parameter only so the gas test can hold everything else equal. In
    ///      production a REWARDS market always tracks and a BURN market never does — the two are
    ///      decided together, which is precisely why they cannot be compared across sink kinds.
    function _rewardsMarketWith(uint256 genesis, bool track)
        internal
        returns (DokuToken token, PoolKey memory key, PoolId id, RewardVault v)
    {
        token = _mkToken(track);
        key = _mkKey(token);
        id = PoolIdLibrary.toId(key);
        address[9] memory ex;
        ex[0] = address(manager);
        ex[1] = address(hook);
        ex[2] = curveAddr;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = address(lp);
        ex[6] = address(swapper);
        ex[7] = LOCKER_STAND_IN; // the SeedLocker's slot; this fixture has no real locker
        v = new RewardVault(address(hook), address(token), id, address(0), MON_TARGET, genesis, ex);
        _register(key, address(token), Sinks.REWARDS, address(v));
        _seed(key, token);
    }

    function _sell(PoolKey memory k, uint256 tokenIn) internal {
        swapper.swap(
            k,
            SwapParams({
                zeroForOne: false,
                amountSpecified: -int256(tokenIn),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function _buy(PoolKey memory k, uint256 monIn) internal {
        swapper.swap{value: monIn}(
            k,
            SwapParams({zeroForOne: true, amountSpecified: -int256(monIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    // ------------------------------------------------------------------------------- BurnSink

    /// @dev No swap anywhere in this path. The sink is handed exactly what it destroys — which is
    ///      what removes the keeper, the price bound and the sandwich the converting design needed.
    ///
    ///      The token arrives as a plain transfer, and that is the production shape rather than a
    ///      convenience: from generation 2 the hook donates a BURN market's whole token leg to the
    ///      pool's LPs and funds no sink at all (`test_theHookFundsNoBurnSink`). The sink's income
    ///      is the SEED position's own liquidity fees, which `SeedLocker.collect` sends straight to
    ///      the sink recorded at graduation with `TAKE_PAIR` — a transfer, from the singleton,
    ///      never routed through the hook's ledger. The trade and the sweep are kept below to show
    ///      that neither contributes anything to it.
    function test_burnSinkDestroysSupplyAndIsPermissionless() public {
        (DokuToken token, PoolKey memory key, PoolId id, BurnSink sink) = _burnMarket();

        _buy(key, 100 ether);
        hook.sweep(id);
        assertEq(token.balanceOf(address(sink)), 0, "the hook funded a BURN sink");
        _collect(token, sink, 100_000e18);

        uint256 supplyBefore = token.totalSupply();
        vm.prank(address(0xA11CE)); // a stranger
        uint256 burned = sink.burn();

        assertGt(burned, 0, "nothing was burned");
        assertEq(token.totalSupply(), supplyBefore - burned, "supply did not fall by the burn");
        assertEq(token.balanceOf(address(sink)), 0, "sink still holds token");
    }

    function test_burnSinkRevertsWhenThereIsNothingToBurn() public {
        (DokuToken token,,, BurnSink sink) = _burnMarket();
        // Funded the only way a BURN sink is funded now — see the note above.
        _collect(token, sink, 1_000e18);
        sink.burn();
        vm.expectRevert(BurnSink.NothingToBurn.selector);
        sink.burn();
    }

    /// @dev Stands in for `SeedLocker.collect`: the locked seed position's accrued token fees are
    ///      taken out of the singleton with `TAKE_PAIR` and delivered to the sink recorded at
    ///      graduation. Sent from the curve, which every exclusion list already holds, so nothing
    ///      about eligible supply moves as a side effect of funding a sink.
    function _collect(DokuToken t, BurnSink sink, uint256 amount) internal {
        vm.prank(curveAddr);
        t.transfer(address(sink), amount);
    }

    // ----------------------------------------------------------------------------- RewardVault

    /// @dev MON in, MON out. The vault is never handed a token it would have to sell.
    function test_rewardVaultPaysMonProRataAndOnlyOnce() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key, PoolId id, RewardVault v) = _rewardsMarket(genesis);

        // A holder who will still be holding at claim time.
        address holder = address(0x4011DE2);
        token.transfer(holder, 1_000_000e18);

        _buy(key, 500 ether);
        hook.sweep(id);
        // The swap's sink share is DONATED to the pool now, so a sweep no longer materialises it.
        // In production the seed position earns it and `SeedLocker.collect` forwards it through
        // this exact call; these harness markets have no locker, so they make it directly.
        hook.creditCurveTax{value: 1 ether}(id);
        v.fund();
        assertGt(v.unallocated(), 0, "vault was not funded");

        // Creation waits for interval 0 to CLOSE, which is grid line 1 — the same block maturity
        // waited for, so the two gates are now one block and the dividend is claimable as soon as
        // the epoch exists.
        vm.roll(v.snapshotBlockFor(1) + 1);
        uint256 k = v.createEpoch();
        assertEq(k, 0);

        uint256 before = holder.balance;
        v.claim(holder, 0, 0);
        assertGt(holder.balance, before, "holder was paid nothing");

        vm.expectRevert(RewardVault.NothingToClaim.selector);
        v.claim(holder, 0, 0);
    }

    /**
     * An address the DENOMINATOR leaves out is owed nothing by the NUMERATOR either.
     *
     * `eligibleSupplyAt` subtracts every excluded balance; `weightOf` used to hand those same
     * addresses a full weight. The PoolManager holds the graduation seed — about 22% of the supply
     * — and is excluded for exactly that reason, so `claim(poolManager, ...)` paid out a share of
     * an epoch the pot was never sized for. `claim` is permissionless, so any stranger could
     * trigger it, and the quote landed in the PoolManager as an unaccounted balance that v4 lets
     * anyone take. Repeated per epoch, the vault emptied into whoever was watching.
     */
    function test_anExcludedAddressCannotClaim() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key, PoolId id, RewardVault v) = _rewardsMarketWith(genesis, true);
        _buy(key, 10 ether);
        hook.sweep(id);
        hook.creditCurveTax{value: 1 ether}(id);
        v.fund();
        vm.roll(v.snapshotBlockFor(1) + 1);
        v.createEpoch();

        address[9] memory ex = v.excluded();
        for (uint256 i; i < ex.length; ++i) {
            if (ex[i] == address(0)) continue;
            assertTrue(v.isExcluded(ex[i]), "the set and the check disagree");
            assertEq(v.weightOf(ex[i], 0), 0, "an excluded address carries weight");
            vm.expectRevert(abi.encodeWithSelector(RewardVault.HolderExcluded.selector, ex[i]));
            v.claim(ex[i], 0, 0);
        }
        token;
    }

    /**
     * A dividend is not collectable on a one-block hold.
     *
     * The grid is public — `snapshotBlockFor` is pure arithmetic over the genesis block — and
     * `createEpoch` is permissionless the moment its line passes. So the sequence was: buy in the
     * block before a snapshot computed years in advance, let it pass, create the epoch yourself in
     * the next block, claim in the same transaction, sell. `min(past, current)` was the only thing
     * asking for a holding period and one block satisfied it. An epoch now matures at the NEXT grid
     * line, and since the weight is still capped by the balance held AT CLAIM TIME, collecting it
     * means having carried the position across a whole epoch.
     */
    function test_anEpochIsNeitherCreatableNorClaimableUntilTheNextGridLine() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key, PoolId id, RewardVault v) = _rewardsMarketWith(genesis, true);
        address holder = address(0x4011DE2);
        token.transfer(holder, 1_000_000e18);
        _buy(key, 10 ether);
        hook.sweep(id);
        hook.creditCurveTax{value: 1 ether}(id);
        v.fund();
        // ONE BLOCK AFTER THE OPENING SNAPSHOT: the flip window, and it is shut — but it is now
        // shut one layer earlier than it used to be. `NotMatured` guarded the gap between an epoch
        // opening at grid line k and maturing at grid line k+1; since epochs are funded from their
        // own interval's bucket, that interval is not CLOSED until grid line k+1 and creation
        // waits for the same block maturity does. The gap is gone, so the refusal a flipper meets
        // is `TooEarly` on the epoch that does not exist yet. `NotMatured` stays in `claim` as
        // defence in depth against a future change to when creation is allowed.
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, v.snapshotBlockFor(1) + 1));
        v.createEpoch();

        // Still shut one block short of the next line.
        vm.roll(v.snapshotBlockFor(1));
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, v.snapshotBlockFor(1) + 1));
        v.createEpoch();

        // And open the moment it passes, for a holder who is still a holder.
        vm.roll(v.snapshotBlockFor(1) + 1);
        v.createEpoch();
        uint256 before = holder.balance;
        v.claim(holder, 0, 0);
        assertGt(holder.balance, before, "a matured epoch paid nothing");
        token;
    }

    /// @dev Epoch 0 anchors at the block the curve became ready, so no epoch key can land inside
    ///      the curve phase and no epoch straddles a curve-phase burn.
    function test_epochCreationHasNoChoosableInstant() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key, PoolId id, RewardVault v) = _rewardsMarket(genesis);

        _buy(key, 500 ether);
        hook.sweep(id);
        // The swap's sink share is DONATED to the pool now, so a sweep no longer materialises it.
        // In production the seed position earns it and `SeedLocker.collect` forwards it through
        // this exact call; these harness markets have no locker, so they make it directly.
        hook.creditCurveTax{value: 1 ether}(id);
        v.fund();

        // The grid blocks are fixed at construction; before epoch 0's interval has closed at grid
        // line 1, creation is simply refused. Neither block is anybody's to choose.
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, v.snapshotBlockFor(1) + 1));
        v.createEpoch();

        vm.roll(v.snapshotBlockFor(1) + 1);
        v.createEpoch();
        (uint256 snap,,,) = v.epochs(0);
        assertEq(snap, genesis + v.EPOCH_BLOCKS(), "snapshot was not on the grid");
    }

    /// @dev Without the `min(past, current)` cap the play is buy, snapshot, claim, dump.
    function test_aHolderWhoExitedBeforeClaimingGetsNothing() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key, PoolId id, RewardVault v) = _rewardsMarket(genesis);

        address flipper = address(0xF11B);
        token.transfer(flipper, 1_000_000e18);

        _buy(key, 500 ether);
        hook.sweep(id);
        // The swap's sink share is DONATED to the pool now, so a sweep no longer materialises it.
        // In production the seed position earns it and `SeedLocker.collect` forwards it through
        // this exact call; these harness markets have no locker, so they make it directly.
        hook.creditCurveTax{value: 1 ether}(id);
        v.fund();
        vm.roll(v.snapshotBlockFor(0) + 1);

        /*
          They held at the OPENING snapshot and sold before the CLOSING one, so they held for part
          of the epoch and are owed nothing for it.

          Both checkpoints are historical — see `weightOf`. That is deliberate, and it cuts two
          ways: a holder who carries the position across both lines keeps the dividend even if they
          sell afterwards, because they earned it by holding the epoch, and nobody can take it away
          from them by calling `claim` on their behalf at a badly chosen moment.
        */
        vm.prank(flipper);
        token.transfer(address(this), 1_000_000e18);
        vm.roll(v.snapshotBlockFor(1) + 1);
        v.createEpoch();

        vm.expectRevert(RewardVault.NothingToClaim.selector);
        v.claim(flipper, 0, 0);
    }

    /// @dev The other half of that rule: held across both lines, sold after, still paid — and a
    ///      stranger calling `claim` at the worst possible instant cannot change the number.
    function test_aHolderWhoHeldTheWholeEpochKeepsItAfterSelling() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key, PoolId id, RewardVault v) = _rewardsMarket(genesis);

        address patient = address(0xBEA71E);
        token.transfer(patient, 1_000_000e18);

        _buy(key, 500 ether);
        hook.sweep(id);
        hook.creditCurveTax{value: 1 ether}(id);
        v.fund();
        vm.roll(v.snapshotBlockFor(1) + 1);
        v.createEpoch();

        // Sold AFTER both checkpoints, and claimed by a stranger rather than by themselves.
        vm.prank(patient);
        token.transfer(address(this), 1_000_000e18);

        uint256 before = patient.balance;
        v.claim(patient, 0, 0);
        assertGt(patient.balance, before, "a holder who held the whole epoch was paid nothing");
    }

    /// @dev Miss an exclusion and the unclaimable fraction grows with volume instead of staying
    ///      fixed. The PoolManager is the counterparty of every swap; the hook holds pending levy.
    function test_eligibleSupplyExcludesThePoolManagerAndTheHook() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key,, RewardVault v) = _rewardsMarket(genesis);

        _buy(key, 500 ether);
        vm.roll(vm.getBlockNumber() + 1);

        uint256 at = vm.getBlockNumber() - 1;
        uint256 es = v.eligibleSupplyAt(at);
        uint256 supply = token.getPastTotalSupply(at);
        uint256 inPool = token.getPastBalance(address(manager), at);
        assertGt(inPool, 0, "the PoolManager should be holding this market's token");
        assertLe(es, supply - inPool, "eligible supply did not exclude the PoolManager");
    }

    /// @dev The previous test proves two members are excluded. This proves EVERY member is, by
    ///      giving each one a balance and asserting eligible supply does not move — which is the
    ///      form that fails when a slot is added to the array and left unread, or when an address
    ///      is passed in the wrong position.
    function test_everyExcludedAddressIsActuallyExcluded() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token,,, RewardVault v) = _rewardsMarket(genesis);

        vm.roll(vm.getBlockNumber() + 1);
        uint256 baseline = v.eligibleSupplyAt(block.number - 1);
        assertGt(baseline, 0, "no eligible supply to speak of, so this proves nothing");

        address[9] memory ex = v.excluded();
        for (uint256 i; i < ex.length; ++i) {
            assertTrue(ex[i] != address(0), "an exclusion slot is empty");
            // Sent from the curve, which is itself excluded, so total supply is untouched and the
            // ONLY thing that could move eligible supply is the recipient's membership.
            vm.prank(curveAddr);
            token.transfer(ex[i], 1_000e18);
            vm.roll(vm.getBlockNumber() + 1);
            assertEq(
                v.eligibleSupplyAt(block.number - 1),
                baseline,
                "a balance parked at an excluded address changed eligible supply"
            );
        }
    }

    /**
     * The hook's holdings are never eligible, in EITHER of the two states they exist in.
     *
     * A levied token lives in two places over its life: first as ERC-6909 claims held *inside the
     * PoolManager* — which is why the singleton's ERC-20 balance covers it — and then, after a
     * `sweep`, as a real ERC-20 balance at the hook. Both are excluded, and both have to be: these
     * balances grow with volume, so missing either state makes the unclaimable fraction of eligible
     * supply rise with volume instead of staying fixed. That is `07-§9.1`'s ratchet argument
     * applied to an address v4 introduced.
     *
     * The exclusion is asserted UNCONDITIONALLY, not only for balances the levy itself creates.
     * From generation 2 a BURN market's token leg is donated whole to the pool's LPs, so the hook
     * no longer accrues this market's token by any route — and that is exactly why state two is
     * driven by a transfer rather than by a sweep. An exclusion that only held for the one path
     * that happens to fill the balance today would stop holding the moment another one does.
     *
     * The vault here is a MEASURING INSTRUMENT, not a production pairing — a BURN market has no
     * vault, and would not want one. It is constructed over the BURN market's token purely so
     * `eligibleSupplyAt` can be asked the question at each of the two states.
     */
    function test_theHooksPendingLevyIsNeverEligible() public {
        (DokuToken token, PoolKey memory key, PoolId id,) = _burnMarket();

        address[9] memory ex;
        ex[0] = address(manager);
        ex[1] = address(hook);
        ex[2] = curveAddr;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = address(lp);
        ex[6] = address(swapper);
        ex[7] = LOCKER_STAND_IN; // the SeedLocker's slot; this fixture has no real locker
        RewardVault probe = new RewardVault(address(hook), address(token), id, address(0), MON_TARGET, block.number, ex);

        vm.roll(vm.getBlockNumber() + 1);
        uint256 baseline = probe.eligibleSupplyAt(block.number - 1);

        // State one: traded hard, the levy pending as 6909 claims inside the singleton.
        _buy(key, 50 ether);
        _buy(key, 50 ether);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 pending = hook.pendingSink(id) + hook.pendingProtocol(id);
        assertGt(pending, 0, "no levy accrued, so this proves nothing");
        assertEq(token.balanceOf(address(hook)), 0, "the pending levy is not held as claims");
        assertEq(
            probe.eligibleSupplyAt(block.number - 1),
            baseline,
            "the levy pending as 6909 claims entered eligible supply"
        );

        // State two: a real ERC-20 balance at the hook, however it got there.
        vm.prank(curveAddr);
        token.transfer(address(hook), 1_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        assertGt(token.balanceOf(address(hook)), 0, "the hook holds no token, so this proves nothing");
        assertEq(
            probe.eligibleSupplyAt(block.number - 1),
            baseline,
            "a token balance sitting at the hook entered eligible supply"
        );
    }

    /// @dev The vault cannot be told its own address — it does not exist until its `new` returns —
    ///      so it fills the reserved slot itself. Without this, tokens sent here would dilute every
    ///      holder AND their share would be paid back into this contract's `receive()`, where it is
    ///      not added to `unallocated` and is stranded for good.
    function test_theVaultExcludesItselfAndRefusesToBeToldOtherwise() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token,,, RewardVault v) = _rewardsMarket(genesis);
        assertEq(v.excluded()[8], address(v), "the vault did not exclude itself");

        vm.roll(vm.getBlockNumber() + 1);
        uint256 before = v.eligibleSupplyAt(block.number - 1);
        vm.prank(curveAddr);
        token.transfer(address(v), 5_000e18);
        vm.roll(vm.getBlockNumber() + 1);
        assertEq(v.eligibleSupplyAt(block.number - 1), before, "tokens parked at the vault diluted holders");

        address[9] memory taken;
        taken[8] = address(0xBAD);
        vm.expectRevert(RewardVault.LastSlotIsReserved.selector);
        new RewardVault(address(hook), address(token), PoolIdLibrary.toId(_mkKey(token)), address(0), MON_TARGET, genesis, taken);
    }

    /**
     * Parking tokens in the PoolManager to shrink the denominator is self-defeating.
     *
     * The algebra, executed rather than asserted in a comment: a holder with `H + P` who parks `P`
     * gets weight `H` over `S − P` instead of `H + P` over `S`, and
     * `(H+P)/S > H/(S−P) ⟺ P(S − H − P) > 0`, which holds for every `H + P < S`.
     *
     * `S` is READ from `eligibleSupplyAt`, never hard-coded. It used to be written as the literal
     * 35M; under D4b the protocol burns on every market, so `S` is whatever eligible supply is at
     * the key — as low as a measured 18,336,371 on a hot launch. The conclusion is scale-invariant,
     * the bound is not, and a test pinned to 35M would stop testing the claim.
     */
    function test_parkingTokensInThePoolManagerIsSelfDefeating() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token,,, RewardVault v) = _rewardsMarket(genesis);

        address alice = address(0xA11CE);
        uint256 held = 2_000_000e18;
        uint256 parked = 500_000e18;
        vm.prank(curveAddr);
        token.transfer(alice, held);
        vm.roll(vm.getBlockNumber() + 1);

        uint256 k1 = vm.getBlockNumber() - 1;
        uint256 s1 = v.eligibleSupplyAt(k1);
        uint256 w1 = token.getPastBalance(alice, k1);
        assertEq(w1, held, "alice does not hold what the test thinks");
        assertLt(w1, s1, "the premise H + P < S does not hold, so the claim is untested");

        vm.prank(alice);
        token.transfer(address(manager), parked);
        vm.roll(vm.getBlockNumber() + 1);

        uint256 k2 = vm.getBlockNumber() - 1;
        uint256 s2 = v.eligibleSupplyAt(k2);
        uint256 w2 = token.getPastBalance(alice, k2);
        assertEq(w2, held - parked, "the park did not land");
        assertEq(s2, s1 - parked, "eligible supply did not fall by exactly what was parked");

        // w1/s1 > w2/s2, cross-multiplied so nothing is lost to integer division.
        assertGt(w1 * s2, w2 * s1, "parking was not strictly worse, so the solvency argument fails");
    }

    /// @dev Burning from inside the exclusion set moves BOTH terms of `pastTotalSupply − Σ excluded`
    ///      by the same amount, so eligible supply is unchanged at the key. This is what makes D4b's
    ///      burn-on-every-market safe to run across an epoch boundary: it was verified rather than
    ///      assumed, because the alternative is silently over-paying every claimant.
    function test_eligibleSupplyIsUnchangedByABurnAtTheEpochKey() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token,,, RewardVault v) = _rewardsMarket(genesis);

        vm.roll(vm.getBlockNumber() + 1);
        uint256 before = v.eligibleSupplyAt(block.number - 1);

        uint256 supplyBefore = token.totalSupply();
        vm.prank(curveAddr);
        token.burn(1_000_000e18);
        vm.roll(vm.getBlockNumber() + 1);

        uint256 at = vm.getBlockNumber() - 1;
        assertEq(token.getPastTotalSupply(at), supplyBefore - 1_000_000e18, "supply did not fall");
        assertEq(v.eligibleSupplyAt(at), before, "a burn inside the exclusion set moved eligible supply");
    }

    /// @dev At epoch 0's anchor the PoolManager holds none of this token and the hook, vault and
    ///      sink do not yet exist, so every new v4 exclusion-set member contributes zero and the
    ///      identity is exact. Asserted here because it is what lets the anchor stay where `07-`
    ///      put it rather than being re-derived for v4.
    function test_epochZeroAnchorIsUnchangedUnderV4() public {
        uint256 genesis = vm.getBlockNumber();
        DokuToken token = _mkToken(true);
        PoolKey memory key = _mkKey(token);
        PoolId id = PoolIdLibrary.toId(key);

        // The vault is constructed at the anchor block, exactly as graduation does it.
        address[9] memory ex;
        ex[0] = address(manager);
        ex[1] = address(hook);
        ex[2] = curveAddr;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = address(lp);
        ex[6] = address(swapper);
        ex[7] = LOCKER_STAND_IN; // the SeedLocker's slot; this fixture has no real locker
        RewardVault v = new RewardVault(address(hook), address(token), id, address(0), MON_TARGET, genesis, ex);

        vm.roll(vm.getBlockNumber() + 1);
        uint256 at = genesis;
        assertEq(
            v.eligibleSupplyAt(at),
            token.getPastTotalSupply(at) - token.getPastBalance(curveAddr, at),
            "eligible supply at the anchor is not pastTotalSupply minus the curve"
        );
        assertEq(token.getPastBalance(address(manager), at), 0, "the PoolManager held tokens at the anchor");
    }

    /// @dev THE BLOCK GRID IS WHAT BOUNDS SPAMMING, and after the 2026-09-11 fix it is the only
    ///      thing that does. `minEpochAmount` used to be the second bound: an interval that earned
    ///      too little was refused outright. That refusal is what stalled the index, and a stalled
    ///      index is what let the NEXT interval's money be paid to THIS interval's grid line — so
    ///      an interval which earned nothing now opens as an empty epoch and the grid moves on.
    ///      The floor kept its job, which was never really spam: it stops an epoch worth less than
    ///      its own claim gas from being PAID OUT. Such takings carry to the next interval instead.
    ///
    ///      One epoch per grid line, and never two, is therefore the whole of the bound — and it is
    ///      enough, because an epoch is 216,000 blocks and an empty push buys the caller nothing.
    function test_spammingCreateEpochIsBoundedByBlocks() public {
        uint256 genesis = vm.getBlockNumber();
        (, PoolKey memory key,, RewardVault v) = _rewardsMarket(genesis);

        // Interval 0 is not CLOSED until grid line 1: a fee arriving anywhere inside it belongs to
        // epoch 0, so opening at grid line 0 would lock out everything after the call.
        vm.roll(genesis + v.EPOCH_BLOCKS() + 1);
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, v.snapshotBlockFor(1) + 1));
        v.createEpoch();

        // Traded, swept and funded — the only route MON reaches a `pending` bucket by. Sized well
        // inside the fixture's tick range so the second buy below still has room; the levy on this
        // clears `minEpochAmount` by an order of magnitude either way.
        _buy(key, 50 ether);
        hook.sweep(PoolIdLibrary.toId(key));
        hook.creditCurveTax{value: 1 ether}(PoolIdLibrary.toId(key));
        v.fund();
        assertGe(v.unallocated(), v.minEpochAmount(), "the trade did not accrue enough to distribute");
        // GENERATION 5. The levy lands in interval 0's bucket AND in the buckets after it: `fund`
        // spreads a pull forward over one bucket per `minEpochAmount` it contains, capped at
        // `MAX_SPREAD_INTERVALS`, so what this asserts is that the sum is intact and that the
        // funder's own interval is the FIRST bucket rather than the only one. Nothing lands behind
        // interval 0, which is the half that matters — see `RewardVault.MAX_SPREAD_INTERVALS`.
        uint256 width = v.spreadWidth(v.unallocated());
        uint256 spread;
        for (uint256 j; j < width; ++j) spread += v.pending(j);
        assertEq(spread, v.unallocated(), "the levy did not land in interval 0's bucket and the ones after it");
        assertGt(v.pending(0), 0, "the funder's own interval got nothing");

        vm.roll(v.snapshotBlockFor(1) + 1);
        v.createEpoch();
        assertEq(v.pending(0), 0, "interval 0's bucket was not spent");

        // The next epoch is refused on BLOCKS, not on money — however much is available.
        _buy(key, 50 ether);
        hook.sweep(PoolIdLibrary.toId(key));
        hook.creditCurveTax{value: 1 ether}(PoolIdLibrary.toId(key));
        v.fund();
        vm.expectRevert(abi.encodeWithSelector(RewardVault.TooEarly.selector, v.snapshotBlockFor(2) + 1));
        v.createEpoch();
    }

    /// @dev MON sent straight to the vault is NOT distributable: `fund` measures what `pullSink`
    ///      delivered, so a direct transfer never reaches `unallocated` and no epoch can ever
    ///      allocate it. Asserted rather than left as a surprise — it is the same fact that makes
    ///      the vault exclude itself, since a claim paid to the vault lands here too.
    /// @dev It used to be accepted and then stranded — not distributable, and not retrievable
    ///      either, since every exit from the vault is a debit of an epoch. The vault now refuses
    ///      it outright, which is the only outcome that tells the sender anything.
    function test_monSentDirectlyToTheVaultIsRefused() public {
        uint256 genesis = vm.getBlockNumber();
        (,,, RewardVault v) = _rewardsMarket(genesis);

        (bool ok,) = address(v).call{value: 5 ether}("");
        assertFalse(ok, "the vault still accepts a bare send");
        assertEq(address(v).balance, 0, "MON landed in the vault anyway");
        v.fund();
        assertEq(v.unallocated(), 0, "nothing was sent, so nothing can be distributable");
    }

    // ------------------------------------------------------------- the per-sink currency rule

    /**
     * A burn sink is never handed MON, and a reward vault is never handed the token.
     *
     * This is THE property the whole design rests on. Because the levy currency follows the sink,
     * neither sink is ever holding something it cannot use — so neither ever has to sell. That one
     * choice is what deletes the keeper, the price bound, the slippage parameter and the entire
     * sandwich surface that a converting design needs. Measured on the shape it replaced, a
     * one-transaction `buy → burn → sell` captured 77.2% of the escrow while delivering 29% of the
     * intended burn.
     *
     * Asserted after real trading in both directions on both sinks, rather than by reading
     * `sinkCurrencyIsToken()` — that getter states the intent, and this checks the outcome.
     */
    function test_neitherSinkIsEverHandedTheCurrencyItCannotUse() public {
        (DokuToken bt, PoolKey memory bk, PoolId bid, BurnSink bs) = _burnMarket();
        _buy(bk, 50 ether);
        _sell(bk, 100_000e18);
        hook.sweep(bid);
        bs.burn();

        assertEq(address(bs).balance, 0, "a BURN sink was handed MON it cannot use");
        assertEq(bt.balanceOf(address(bs)), 0, "a BURN sink kept token instead of destroying it");

        (DokuToken rt, PoolKey memory rk, PoolId rid, RewardVault rv) = _rewardsMarket(block.number);
        _buy(rk, 50 ether);
        _sell(rk, 100_000e18);
        hook.sweep(rid);
        hook.creditCurveTax{value: 1 ether}(rid);
        rv.fund();

        assertEq(rt.balanceOf(address(rv)), 0, "a REWARDS vault was handed the token it cannot pay out");
        assertGt(rv.unallocated(), 0, "a REWARDS vault accrued no MON from real trading");
    }

    /// @dev And the hook itself holds neither currency once a market has been swept — it is a
    ///      conduit, not a treasury. A residue that grew with volume would be value nobody could
    ///      route anywhere, and it would drag on `eligibleSupply` for every REWARDS market.
    function test_theHookRetainsNothingAfterASweepAndAPull() public {
        (DokuToken t, PoolKey memory k, PoolId id, BurnSink s_) = _burnMarket();
        _buy(k, 50 ether);
        _sell(k, 100_000e18);

        hook.sweep(id);
        s_.burn();
        hook.pullTreasury(Currency.wrap(address(0)));
        hook.pullTreasury(Currency.wrap(address(t)));

        assertEq(manager.balanceOf(address(hook), Currency.wrap(address(0)).toId()), 0, "MON claims left at the hook");
        assertEq(
            manager.balanceOf(address(hook), Currency.wrap(address(t)).toId()), 0, "token claims left at the hook"
        );
        assertEq(t.balanceOf(address(hook)), 0, "the hook kept ERC-20 token");
    }

    // ------------------------------------------------------------------------ the checkpointed token

    /// @dev `07-§10.6`'s `…InARealV3Pool`, retargeted. The point is that balance history is written
    ///      by an ordinary ERC-20 transfer and therefore by a real pool swap — no hook, no special
    ///      path — so what the vault reads at a snapshot is what the pool actually did.
    function test_checkpointedTokenTradesInARealV4Pool() public {
        uint256 genesis = vm.getBlockNumber();
        (DokuToken token, PoolKey memory key,, RewardVault v) = _rewardsMarket(genesis);
        v;

        uint256 keyBlock = vm.getBlockNumber();
        vm.roll(vm.getBlockNumber() + 1);
        uint256 poolBefore = token.getPastBalance(address(manager), keyBlock);
        assertGt(poolBefore, 0, "the pool holds nothing, so a swap would prove nothing");

        _buy(key, 100 ether);
        vm.roll(vm.getBlockNumber() + 1);

        // A buy takes tokens OUT of the pool, so the singleton's checkpointed balance falls. The
        // direction is the assertion: reading it backwards is how a snapshot ends up crediting the
        // pool for supply it just paid away.
        assertLt(
            token.getPastBalance(address(manager), block.number - 1),
            poolBefore,
            "a real v4 swap did not move the checkpointed balance"
        );
    }

    /**
     * The cost of history, measured on a real v4 swap rather than projected.
     *
     * `07-§10.2` quoted +42,661 for a V3 buy on a checkpointed token and a steady state of +47,161
     * "because it is always two pushes". Neither figure transfers: under v4 with `poolManager.mint`
     * the levy never enters the ERC-20 layer at all, so a taxed buy moves the token exactly twice.
     * A reviewer's projected +72,000 assumed `take`, and `take` is not what ships.
     *
     * MEASURED on a fresh block key: a buy costs 81,912 without history and 126,614 with, a delta
     * of **+44,702**; a sell costs 408,438 and 455,640, a delta of **+47,202**. The buy figure sits
     * between `07-`'s two V3 numbers and is 38% below the projected +72,000, which is the evidence
     * that `mint` keeps the levy out of the ERC-20 layer. The direction-dependence §9.3 predicted
     * is real and small — +2,500, about 5.6%.
     *
     * The assertions are on the shape rather than the number — that history costs something, and
     * that the something is about two checkpoint pushes — because an absolute figure pinned here
     * would fail on every solc bump and teach nobody anything. The number is logged for `§10.2`.
     */
    function test_gas_historyCostsBoundedExtraOnARealSwap() public {
        // BOTH are REWARDS markets. Comparing a REWARDS market against a BURN one would measure the
        // levy currency, not the history: a BURN market's levy is taken in the token and minted as
        // ERC-6909 claims, a REWARDS market's is taken in MON, and those are different code paths
        // that differ by more than the checkpoints do.
        (, PoolKey memory tracked,,) = _rewardsMarketWith(block.number, true);
        (, PoolKey memory plain,,) = _rewardsMarketWith(block.number, false);

        // A FRESH BLOCK for each. `Checkpoints.Trace208.push` appends a new entry when the block
        // key moves and updates in place when it does not, and those differ by roughly an SSTORE
        // per address touched. Measuring both buys in the same block as the seed measured the
        // in-place case and reported +170 gas — a real number for a case that does not happen,
        // since a swap and the seed that preceded it are never in the same block in production.
        vm.roll(vm.getBlockNumber() + 1);
        uint256 g0 = gasleft();
        _buy(plain, 10 ether);
        uint256 without = g0 - gasleft();

        vm.roll(vm.getBlockNumber() + 1);
        g0 = gasleft();
        _buy(tracked, 10 ether);
        uint256 with_ = g0 - gasleft();

        // The sell leg, because §Task 9.3 flags the delta may be direction-dependent under v4 and
        // an untested guess about that is worth nothing. A sell settles the token INTO the
        // singleton rather than out of it, so the set of addresses whose checkpoints move differs.
        vm.roll(vm.getBlockNumber() + 1);
        g0 = gasleft();
        _sell(plain, 50_000e18);
        uint256 sellWithout = g0 - gasleft();

        vm.roll(vm.getBlockNumber() + 1);
        g0 = gasleft();
        _sell(tracked, 50_000e18);
        uint256 sellWith = g0 - gasleft();

        emit log_named_uint("taxed v4 buy,  no history  ", without);
        emit log_named_uint("taxed v4 buy,  with history", with_);
        emit log_named_int("buy delta                  ", int256(with_) - int256(without));
        emit log_named_uint("taxed v4 sell, no history  ", sellWithout);
        emit log_named_uint("taxed v4 sell, with history", sellWith);
        emit log_named_int("sell delta                 ", int256(sellWith) - int256(sellWithout));

        assertGt(with_, without, "history was free on a buy, which means it is not being written");
        assertGt(sellWith, sellWithout, "history was free on a sell");
        // Two pushes plus the supply trace. A regression past this means the levy started moving
        // through the ERC-20 layer, which is exactly what `mint`-not-`take` exists to prevent.
        assertGt(with_ - without, 20_000, "the buy delta is too small to be a fresh checkpoint append");
        assertLt(with_ - without, 72_000, "history cost more than the `take`-based projection it beat");
        assertLt(sellWith - sellWithout, 72_000, "the sell leg cost more than the projection");
    }

    // ------------------------------------------------------------------- quote-generic vault

    /// @dev Dividends are paid in the market's quote, and a six-decimal quote must not inherit an
    ///      18-decimal floor: `0.01 ether` of USDC would be ten billion dollars per epoch. The
    ///      floor is one ten-thousandth of the market's own quote TARGET rather than a fraction of
    ///      one whole token, which is what keeps it sane on bitcoin and gold too.
    function test_aUsdcVaultPaysUsdcProRataWithASixDecimalFloor() public {
        MockUSDC usdc = new MockUSDC();
        DokuToken token = _mkToken(true);
        (address c0, address c1) = address(usdc) < address(token) ? (address(usdc), address(token)) : (address(token), address(usdc));
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        PoolId id = PoolIdLibrary.toId(key);
        address[9] memory ex;
        ex[0] = address(manager);
        ex[1] = address(hook);
        ex[2] = curveAddr;
        ex[3] = address(token);
        ex[4] = DEAD;
        ex[5] = address(lp);
        ex[6] = address(swapper);
        ex[7] = LOCKER_STAND_IN; // the SeedLocker's slot; this fixture has no real locker
        RewardVault v = new RewardVault(address(hook), address(token), id, address(usdc), USDC_TARGET, block.number, ex);
        assertEq(v.quote(), address(usdc));
        assertEq(v.minEpochAmount(), USDC_TARGET / 10_000, "0.8 USDC, not 0.01 ether");
        assertLt(v.minEpochAmount(), 1e6, "the floor is a fraction of one USDC, not an 18-decimal one");
        // Four arguments: B1 Step 9 gave `_register` an explicit `token`. Deriving it from
        // `currency1` is what silently registers this market backwards when the token sorts low.
        _register(key, address(token), Sinks.REWARDS, address(v));

        // A holder with weight: the curve hands ALICE some supply.
        address alice = address(0xA11CE);
        vm.prank(curveAddr);
        token.transfer(alice, 10_000_000e18);

        // The curve phase's routed share, credited in USDC.
        usdc.mint(address(this), 100e6);
        usdc.approve(address(hook), 100e6);
        hook.creditCurveTax(id, 100e6);

        assertEq(v.fund(), 100e6, "fund() did not measure the USDC it pulled");
        // An epoch opens once its own interval has CLOSED, which is grid line 1 for epoch 0.
        vm.roll(v.snapshotBlockFor(1) + 1);
        uint256 epoch = v.createEpoch();
        // Maturity — the NEXT grid line, so a dividend is not claimable on a one-block hold — is
        // now the same block creation waited for. See `RewardVault.claim`.
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = v.claim(alice, epoch, epoch);
        assertGt(paid, 0);
        assertEq(usdc.balanceOf(alice) - before, paid, "the dividend did not arrive in USDC");
        assertEq(address(v).balance, 0, "a USDC vault holds MON");
    }
}
