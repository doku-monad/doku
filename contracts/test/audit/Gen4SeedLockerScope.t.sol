// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {PosmTestSetup} from "@uniswap/v4-periphery/test/shared/PosmTestSetup.sol";
import {PositionConfig} from "@uniswap/v4-periphery/test/shared/PositionConfig.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolDonateTest} from "@uniswap/v4-core/src/test/PoolDonateTest.sol";
import {HookMiner} from "@uniswap/v4-periphery/test/shared/HookMiner.sol";
import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {DokuHook} from "../../src/v4/DokuHook.sol";
import {SeedLocker} from "../../src/SeedLocker.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract ScopeToken is ERC20 {
    constructor() ERC20("Lock", "LCK") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/**
 * # M-02's shape, in the file M-02 never named: `SeedLocker.collect`
 *
 * The 2026-09-10 review's M-02 is "an absolute balance on a SHARED contract is not this
 * operation's money". Round 0 fixed it in `DokuGraduation._sweepDust` — both legs now measure a
 * delta and the third party's balance is subtracted back out.
 *
 * `SeedLocker` was not touched, and it has the identical shape with a harder edge. One locker owns
 * the seed position of EVERY graduated market, and `collect(tokenId)` decides how much to forward
 * by reading
 *
 *     address(this).balance                        (native quote)
 *     IERC20(quote).balanceOf(address(this))       (ERC-20 quote)
 *
 * AFTER `modifyLiquidities` has run — an absolute balance, not the delta that call produced. So
 * whatever else is sitting in the locker denominated in that currency is forwarded along with this
 * position's fees, into THIS market's ledger, and out to THIS market's recipients.
 *
 * The locker is not a contract that should ever hold a resting balance, and the source says so:
 * "Fees land here for the length of one `collect` before being forwarded. Nothing else ever sends
 * MON here, and nothing can withdraw it." Both halves of that sentence are false, and the second
 * one is false *in the same function*:
 *
 *   - `receive()` is open and unconditional, so anyone can send native MON here.
 *   - `collect` itself deliberately LEAVES a balance behind on a BURN market: the credit is gated
 *     `q != 0 && position.sinkKind != BURN`, and the comment two lines above `receive()` says a
 *     BURN market's quote "stays here for the same reason: there is no path out for it". There is
 *     a path out for it. It is the next non-BURN market's `collect`, three lines below.
 *
 * Both are proved below, end to end, with the money leaving the hook's ledger at the far side.
 */
contract Gen4SeedLockerScopeTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    uint128 internal constant SEED_LIQUIDITY = 100e18;
    int24 internal constant SEED_LOWER = -6000;
    int24 internal constant SEED_UPPER = 6000;

    DokuHook internal dokuHook;
    SeedLocker internal locker;
    PoolDonateTest internal donor;
    address internal sinkA = address(0x51);
    address internal sinkB = address(0x52);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        donor = new PoolDonateTest(IPoolManager(address(manager)));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        dokuHook.setGraduator(address(this), true);
        locker = new SeedLocker(IPositionManager(address(lpm)), address(dokuHook), address(manager));
        vm.deal(address(this), 1_000_000 ether);
    }

    function _market(address quote, address token, uint8 sink, address sinkAddr)
        internal
        returns (PoolKey memory k, PoolId id, uint256 tokenId)
    {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        k = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(dokuHook))
        });
        id = PoolIdLibrary.toId(k);
        manager.initialize(k, SQRT_1_1);
        dokuHook.registerPool(k, token, sink, sinkAddr, 0);
        if (Currency.unwrap(k.currency0) != address(0)) approvePosmCurrency(k.currency0);
        approvePosmCurrency(k.currency1);
        ERC20(token).approve(address(donor), type(uint256).max);
        if (quote != address(0)) ERC20(quote).approve(address(donor), type(uint256).max);

        PositionConfig memory cfg = PositionConfig({poolKey: k, tickLower: SEED_LOWER, tickUpper: SEED_UPPER});
        tokenId = lpm.nextTokenId();
        dokuHook.beginSeed(id, SEED_LIQUIDITY, SEED_LOWER, SEED_UPPER);
        if (quote == address(0)) {
            mintWithNative(SQRT_1_1, cfg, SEED_LIQUIDITY, address(locker), "");
        } else {
            mint(cfg, SEED_LIQUIDITY, address(locker), "");
        }
        dokuHook.endSeed(id);
        locker.lock(tokenId, k, sinkAddr, sink, quote < token);
    }

    function _donateQuote(PoolKey memory k, bool quoteIs0, uint256 amount) internal {
        uint256 val = Currency.unwrap(k.currency0) == address(0) ? amount : 0;
        donor.donate{value: val}(k, quoteIs0 ? amount : 0, quoteIs0 ? 0 : amount, "");
    }

    // --------------------------------------------------------------------- 1. misdirected MON

    /**
     * @notice $-LOSS: 10 MON sent to the locker by mistake is credited, in full, to whichever
     *         market's `collect` lands next — and `collect` is permissionless, so "next" means
     *         "whoever is watching the mempool".
     *
     * @dev The victim is the sender. The beneficiary is the recipient set of one market, chosen by
     *      an attacker who simply calls `collect` on the market they own the most of. On a market
     *      with a CREATOR sink that recipient is a single address the launcher named.
     */
    function test_M02_misdirectedMonIsCreditedToWhicheverMarketCollectsNext() public {
        ScopeToken tA = new ScopeToken();
        (PoolKey memory kA, PoolId idA, uint256 tokA) = _market(address(0), address(tA), Sinks.REWARDS, sinkA);

        // The mistake no longer lands at all: `receive()` is now gated to the PoolManager, which
        // round 2 measured to be the only address that ever pays this contract. The earlier note
        // here said the gate was impossible because `TAKE_PAIR` is a native call from the
        // PoolManager — true of the HOOK, and false of the sender.
        uint256 misdirected = 10 ether;
        (bool ok,) = address(locker).call{value: misdirected}("");
        assertFalse(ok, "the locker still swallows a bare send");
        assertEq(address(locker).balance, 0, "MON landed anyway");

        // Force a resting balance the only way that is still possible, so the DELTA measurement —
        // the actual subject of this test — is still exercised. `collect` leaves a BURN market's
        // quote leg behind by design, so a shared locker holding somebody else's money remains a
        // thing that happens; the gate removes one door to it, not the property.
        vm.deal(address(locker), misdirected);
        assertEq(address(locker).balance, misdirected, "stage failed");

        // This market earns a genuine 1 MON of fees.
        _donateQuote(kA, true, 1 ether);

        uint256 before = dokuHook.owedSink(idA);
        locker.collect(tokA);
        uint256 credited = dokuHook.owedSink(idA) - before;

        emit log_string("--- SeedLocker: absolute balance, not delta ---");
        emit log_named_decimal_uint("this position's genuine fees (MON)", 1 ether, 18);
        emit log_named_decimal_uint("misdirected MON sitting in the locker", misdirected, 18);
        emit log_named_decimal_uint("credited to THIS market's sink", credited, 18);

        // The market's sink can then withdraw it: `owedSink` is what `pullSink` pays.
        vm.prank(sinkA);
        uint256 paid = dokuHook.pullSink(idA);
        emit log_named_decimal_uint("withdrawn by this market's sink", paid, 18);

        // BEFORE the fix this read 10.999999999999999999 MON — the resting 10 plus the position's
        // own 1 — and `pullSink` paid all of it out. After it, the credit is this position's fees
        // and the resting balance is untouched. Two independent guards now: the delta measurement
        // asserted here, and the `receive` gate asserted above.
        assertLt(
            credited,
            misdirected,
            "a stranger's misdirected MON was credited to one market's sink (absolute-balance read)"
        );
        assertApproxEqAbs(credited, 1 ether, 1e12, "the position's own fees did not reach the ledger");
        assertEq(address(locker).balance, misdirected, "the misdirected MON should be untouched");
    }

    // ------------------------------------------------- 2. a BURN market's deliberately-left quote

    /**
     * @notice $-LOSS: the quote `collect` deliberately strands on a BURN market is taken by the
     *         next non-BURN market that shares the quote asset.
     *
     * @dev This is the sharper half, because nobody has to make a mistake. `collect` is
     *      permissionless and its BURN branch is documented as leaving the quote behind on the
     *      grounds that "there is no path out for it". The path out is the very next line of the
     *      same function, run against a different tokenId.
     */
    function test_M02_aBurnMarketsStrandedQuoteIsTakenByAnUnrelatedMarket() public {
        ScopeToken tB = new ScopeToken();
        (PoolKey memory kB,, uint256 tokB) = _market(address(0), address(tB), Sinks.BURN, sinkB);
        ScopeToken tA = new ScopeToken();
        (PoolKey memory kA, PoolId idA, uint256 tokA) = _market(address(0), address(tA), Sinks.REWARDS, sinkA);

        // Quote reaches the BURN market's position. A `poolManager.donate` has no access control,
        // so anyone may put it there; so may a future levy change, and so does any third party who
        // donates to a DOKU pool for any reason.
        _donateQuote(kB, true, 5 ether);

        locker.collect(tokB);
        uint256 stranded = address(locker).balance;
        assertGt(stranded, 0, "the BURN branch did not strand quote; finding moot");

        // Now an unrelated market collects. It takes the lot.
        _donateQuote(kA, true, 1 ether);
        uint256 before = dokuHook.owedSink(idA);
        locker.collect(tokA);
        uint256 credited = dokuHook.owedSink(idA) - before;

        emit log_string("--- SeedLocker: a BURN market's stranded quote crosses markets ---");
        emit log_named_decimal_uint("stranded by the BURN market's collect (MON)", stranded, 18);
        emit log_named_decimal_uint("market A's own fees (MON)", 1 ether, 18);
        emit log_named_decimal_uint("credited to market A", credited, 18);

        // BEFORE the fix: 5.999999999999999998 MON — market A's own 1 plus the BURN market's 5.
        assertLt(credited, stranded, "a BURN market's stranded quote was credited to another market");
        assertApproxEqAbs(credited, 1 ether, 1e12, "market A's own fees did not reach the ledger");
        assertEq(address(locker).balance, stranded, "the stranded MON should still be stranded");
    }

    // ----------------------------------------------------------------- 3. the ERC-20 form, shared

    /// @notice The same across two markets that share one ERC-20 quote — the case that actually
    ///         matters, because USDC and USDT0 are live quotes for many markets at once.
    function test_M02_erc20FormCrossesMarketsSharingAQuote() public {
        MockUSDC usdc = new MockUSDC();
        usdc.mint(address(this), 1e24);

        ScopeToken tB = new ScopeToken();
        (PoolKey memory kB,, uint256 tokB) = _market(address(usdc), address(tB), Sinks.BURN, sinkB);
        ScopeToken tA = new ScopeToken();
        (PoolKey memory kA, PoolId idA, uint256 tokA) = _market(address(usdc), address(tA), Sinks.REWARDS, sinkA);

        _donateQuote(kB, address(usdc) < address(tB), 5_000e6);
        locker.collect(tokB);
        uint256 stranded = usdc.balanceOf(address(locker));
        assertGt(stranded, 0, "the BURN branch did not strand USDC; finding moot");

        _donateQuote(kA, address(usdc) < address(tA), 100e6);
        uint256 before = dokuHook.owedSink(idA);
        locker.collect(tokA);
        uint256 credited = dokuHook.owedSink(idA) - before;

        emit log_named_uint("USDC stranded by the BURN market", stranded);
        emit log_named_uint("USDC credited to the REWARDS market", credited);

        // BEFORE the fix: 5,099.999998 USDC — market A's own 100 plus the BURN market's 5,000.
        assertLt(credited, stranded, "a BURN market's stranded USDC was credited to another market");
        assertApproxEqAbs(credited, 100e6, 1e3, "market A's own USDC fees did not reach the ledger");
        assertEq(usdc.balanceOf(address(locker)), stranded, "the stranded USDC should still be stranded");
    }
}
