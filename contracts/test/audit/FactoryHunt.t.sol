// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "openzeppelin/token/ERC20/IERC20.sol";
import {ERC20} from "openzeppelin/token/ERC20/ERC20.sol";
import {Ownable} from "openzeppelin/access/Ownable.sol";
import {Pausable} from "openzeppelin/utils/Pausable.sol";
import {Clones} from "openzeppelin/proxy/Clones.sol";
import {DokuFactory} from "../../src/DokuFactory.sol";
import {BondingCurve, DOKU_SEED_BASE, DOKU_MIN_QUOTE_TARGET} from "../../src/BondingCurve.sol";
import {DokuToken} from "../../src/DokuToken.sol";
import {QuoteRegistry} from "../../src/QuoteRegistry.sol";
import {Sinks} from "../../src/lib/Sinks.sol";
import {Wiring} from "../helpers/Wiring.sol";

/*//////////////////////////////////////////////////////////////////////////////////////////////
                                        FIXTURE PIECES
//////////////////////////////////////////////////////////////////////////////////////////////*/

/// @dev A graduator that passes `setGraduator`'s wiring check and actually calls `release`, so a
///      short or over-large seed shows up here rather than as a swallowed non-graduation.
contract Grad {
    address public immutable factory;
    mapping(address => bool) public graduated;
    uint256 public lastQuote;
    uint256 public lastBase;

    constructor(address f) {
        factory = f;
    }

    function graduate(address curve) external returns (bytes32, uint256) {
        graduated[curve] = true;
        (lastQuote, lastBase) = BondingCurve(payable(curve)).release();
        return (bytes32(0), 0);
    }

    function sinkOf(address) external view returns (address) {
        return address(this);
    }

    function creditCurveTax(address) external payable {}

    function creditCurveTax(address, uint256) external {}

    receive() external payable {}
}

/// @dev A contract that says everything a market says about itself, to prove that saying it is
///      not enough.
contract Counterfeit {
    address public token;
    address public quoteAsset;
    uint256 public quoteTarget;
    uint8 public sink;
    bool public readyToGraduate = true;
    uint64 public readyAtBlock;

    constructor(address t, address q, uint256 target) {
        token = t;
        quoteAsset = q;
        quoteTarget = target;
    }

    function release() external pure returns (uint256, uint256) {
        return (0, 0);
    }
}

/// @dev A stand-in with a supply the curve will accept, for initialising a curve by hand.
contract Supply1e27 is ERC20 {
    constructor() ERC20("S", "S") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

contract Q6 is ERC20 {
    constructor() ERC20("Q6", "Q6") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }
}

/*//////////////////////////////////////////////////////////////////////////////////////////////

    THE NATIVE FIRST BUY'S REFUND WINDOW

    `DokuFactory._firstBuy` (DokuFactory.sol:317-345) is known to be re-enterable through a
    CALLBACK QUOTE TOKEN — recorded, do not re-raise, see
    docs/doku/audit/2026-09-10-external/first-buy-delta-reentrancy.md.

    The NATIVE branch of the same function needs no such token. `buyFor` -> `_buy` ends with
    `if (v.refund != 0) _payQuote(buyer, v.refund)` (BondingCurve.sol:607), and `_payQuote`'s
    native leg is `to.call{value: amount}("")` (BondingCurve.sol:984). `buyer` is the LAUNCHER.
    So any launch whose first buy overshoots the target hands the launcher control back INSIDE
    `launch()`, with:

        * `nonces[launcher]` already bumped        (DokuFactory.sol:284)
        * `isMarket[curve]` already true           (DokuFactory.sol:305)
        * `pendingLaunchFees` already credited     (DokuFactory.sol:216)
        * the market already filled, released and graduated (`_tryAutoGraduate` runs BEFORE the
          refund, BondingCurve.sol:606-607)
        * the FACTORY holding no reentrancy guard of any kind

    These launchers are the probes for that window.

//////////////////////////////////////////////////////////////////////////////////////////////*/

contract RefundProbe {
    DokuFactory public immutable f;

    /// 0 = observe only, 1 = re-enter collectLaunchFees, 2 = re-enter launch, 3 = re-enter setMetadata
    uint8 public mode;
    bool public entered;

    // What the factory looked like from inside its own launch.
    uint256 public factoryBalanceAtCallback;
    uint256 public pendingFeesAtCallback;
    uint256 public nonceAtCallback;
    bool public isMarketAtCallback;
    bool public releasedAtCallback;
    uint256 public refundSeen;

    bool public innerOk;
    bytes public innerErr;
    address public nestedCurve;

    DokuFactory.LaunchParams internal nested;
    uint256 public nestedValue;
    address public observedCurve;

    constructor(DokuFactory f_) {
        f = f_;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function setNested(DokuFactory.LaunchParams calldata p, uint256 value) external {
        nested = p;
        nestedValue = value;
    }

    function go(DokuFactory.LaunchParams calldata p, uint256 value)
        external
        returns (address curve, address token)
    {
        (curve, token) = f.launch{value: value}(p);
        observedCurve = curve;
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        refundSeen = msg.value;
        factoryBalanceAtCallback = address(f).balance;
        pendingFeesAtCallback = f.pendingLaunchFees();
        nonceAtCallback = f.nonces(address(this));
        (address predicted,) = f.predictMarket(address(this));
        // The curve for THIS launch is the one at nonce-1; predictMarket now points past it.
        address mine = Clones.predictDeterministicAddress(
            f.curveImplementation(), keccak256(abi.encode(address(this), nonceAtCallback - 1)), address(f)
        );
        predicted; // silence
        isMarketAtCallback = f.isMarket(mine);
        releasedAtCallback = BondingCurve(payable(mine)).released();

        if (mode == 1) {
            (innerOk, innerErr) = address(f).call(abi.encodeWithSelector(f.collectLaunchFees.selector));
        } else if (mode == 2) {
            try f.launch{value: nestedValue}(nested) returns (address c, address) {
                innerOk = true;
                nestedCurve = c;
            } catch (bytes memory e) {
                innerOk = false;
                innerErr = e;
            }
        } else if (mode == 3) {
            DokuFactory.Metadata memory m;
            m.name = "Probe";
            m.ticker = "PRB";
            m.logoURI = "https://changed.example";
            (innerOk, innerErr) =
                address(f).call(abi.encodeWithSelector(f.setMetadata.selector, mine, m));
        }
    }
}

/// @dev A launcher with no `receive`, to prove the refund is a real outbound call and not a book
///      entry: a launch that overshoots simply cannot be made from such an address.
contract DeafLauncher {
    DokuFactory public immutable f;

    constructor(DokuFactory f_) {
        f = f_;
    }

    function go(DokuFactory.LaunchParams calldata p, uint256 value) external returns (address, address) {
        return f.launch{value: value}(p);
    }
}

/*//////////////////////////////////////////////////////////////////////////////////////////////
                                            TESTS
//////////////////////////////////////////////////////////////////////////////////////////////*/

contract FactoryHuntTest is Test {
    DokuFactory internal factory;
    QuoteRegistry internal registry;
    Grad internal grad;

    address internal constant OWNER = address(0xA0);
    address internal constant PAUSER = address(0xA1);
    address internal constant TREASURY = address(0xA2);
    address internal constant CREATOR = address(0xC0);
    address internal constant ALICE = address(0xA11CE);
    address internal constant MALLORY = address(0x1DEAD);
    address internal constant SINKADDR = address(0x5111);

    uint256 internal constant FEE = 10 ether; // the live mainnet fee
    uint256 internal constant NATIVE_TARGET = 1_000e18;

    function setUp() public {
        registry = new QuoteRegistry(OWNER);
        factory = new DokuFactory(OWNER, PAUSER, TREASURY, address(registry), SINKADDR, FEE);
        grad = new Grad(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(grad));
        // The factory ships paused with no graduator; activation is what opens it. See
        // `test/helpers/Wiring.sol`.
        Wiring.activate(factory, OWNER, address(grad));
        vm.prank(OWNER);
        registry.register(address(0), NATIVE_TARGET);
        vm.deal(CREATOR, 1_000_000 ether);
        vm.deal(ALICE, 1_000_000 ether);
        vm.deal(MALLORY, 1_000_000 ether);
    }

    function _p(address quote, uint8 sink, uint16 tax)
        internal
        view
        returns (DokuFactory.LaunchParams memory p)
    {
        p.meta.name = "Market";
        p.meta.ticker = "MKT";
        p.quoteAsset = quote;
        p.sink = sink;
        p.creatorTaxBps = tax;
        p.economicsPin = factory.economicsPin(quote, sink, tax);
        p.deadline = vm.getBlockTimestamp() + 1 days;
        if (sink == Sinks.CREATOR) p.routedRecipient = CREATOR;
    }

    // ====================================================================================
    // 1. THE NATIVE REFUND WINDOW — it exists, and here is exactly what it can reach
    // ====================================================================================

    /// @dev H-A. The window is real: a launcher that overshoots its own first buy is called back
    ///      while `launch()` is still on the stack, after the market has been deployed, filled,
    ///      released and graduated. No callback quote token is needed — this is plain MON.
    function test_theNativeFirstBuyRefundReentersLaunchWithNoCallbackToken() public {
        RefundProbe probe = new RefundProbe(factory);
        vm.deal(address(probe), 1_000_000 ether);

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 3 * NATIVE_TARGET; // guarantees an overshoot, hence a refund

        (address curve,) = probe.go(p, FEE + p.firstBuyQuote);

        assertTrue(probe.entered(), "the launcher was never called back");
        assertGt(probe.refundSeen(), 0, "no refund was paid");
        assertTrue(probe.isMarketAtCallback(), "isMarket was not yet set at the callback");
        assertEq(probe.nonceAtCallback(), 1, "the nonce was not yet consumed at the callback");
        assertTrue(probe.releasedAtCallback(), "the market had not yet graduated at the callback");
        assertTrue(grad.graduated(curve), "market did not graduate");
    }

    /// @dev The one thing that makes the window uninteresting: the factory's MON ledger is exact.
    ///      At the instant of the callback the whole first-buy leg has already been forwarded to
    ///      the curve, so `address(factory).balance == pendingLaunchFees` — a re-entrant
    ///      `collectLaunchFees()` can take the fee bucket and not one wei more, and it can only
    ///      ever send it to `feeRecipient`.
    function test_reentrantCollectLaunchFeesFromTheRefundWindowCannotOverdraw() public {
        // Pre-accrue two other launches' fees so the bucket is not trivially the one in flight.
        for (uint256 i; i < 2; ++i) {
            DokuFactory.LaunchParams memory q = _p(address(0), Sinks.BURN, 0);
            vm.prank(CREATOR);
            factory.launch{value: FEE}(q);
        }
        assertEq(factory.pendingLaunchFees(), 2 * FEE);

        RefundProbe probe = new RefundProbe(factory);
        probe.setMode(1);
        vm.deal(address(probe), 1_000_000 ether);

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 3 * NATIVE_TARGET;
        probe.go(p, FEE + p.firstBuyQuote);

        assertTrue(probe.innerOk(), "the re-entrant collect reverted");
        assertEq(
            probe.factoryBalanceAtCallback(),
            probe.pendingFeesAtCallback(),
            "the factory held more MON than it had booked"
        );
        assertEq(probe.pendingFeesAtCallback(), 3 * FEE, "the in-flight fee was not yet booked");
        assertEq(TREASURY.balance, 3 * FEE, "fees did not land on the fee recipient");
        assertEq(address(factory).balance, 0, "MON was left behind");
        assertEq(factory.pendingLaunchFees(), 0);
    }

    /// @dev A nested `launch()` from inside the window is a normal launch: its own nonce, its own
    ///      clone pair, its own exact `msg.value`. Nothing is borrowed from the outer one.
    function test_aNestedLaunchFromTheRefundWindowIsFullyAccountedFor() public {
        RefundProbe probe = new RefundProbe(factory);
        probe.setMode(2);
        vm.deal(address(probe), 1_000_000 ether);

        DokuFactory.LaunchParams memory inner = _p(address(0), Sinks.BURN, 0);
        probe.setNested(inner, FEE);

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 3 * NATIVE_TARGET;
        (address outer,) = probe.go(p, FEE + p.firstBuyQuote);

        assertTrue(probe.innerOk(), "the nested launch reverted");
        assertTrue(probe.nestedCurve() != outer, "the nested launch collided with the outer one");
        assertTrue(factory.isMarket(probe.nestedCurve()));
        assertEq(factory.nonces(address(probe)), 2, "both launches must consume a nonce");
        assertEq(factory.pendingLaunchFees(), 2 * FEE, "both fees must be booked");
        assertEq(address(factory).balance, 2 * FEE, "the ledger and the balance disagree");
    }

    /// @dev The ledger identity under an arbitrary interleaving of launches, overshooting native
    ///      first buys (hence refund callbacks) and collections. `pendingLaunchFees` may never
    ///      exceed what the factory holds — if it could, the last collector eats the shortfall.
    function testFuzz_theFeeLedgerNeverExceedsTheBalanceThroughTheRefundWindow(
        uint96[6] calldata firstBuys,
        uint8 collectMask
    ) public {
        RefundProbe probe = new RefundProbe(factory);
        vm.deal(address(probe), 10_000_000 ether);

        for (uint256 i; i < 6; ++i) {
            DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
            p.firstBuyQuote = bound(uint256(firstBuys[i]), 0, 4 * NATIVE_TARGET);
            try probe.go(p, FEE + p.firstBuyQuote) {} catch {}
            assertLe(
                factory.pendingLaunchFees(), address(factory).balance, "fee ledger outran the balance"
            );
            if (collectMask & (1 << i) != 0 && factory.pendingLaunchFees() != 0) {
                factory.collectLaunchFees();
                assertLe(factory.pendingLaunchFees(), address(factory).balance);
            }
        }
    }

    /// @dev The refund is a real outbound call, so a launcher that cannot receive MON cannot
    ///      overshoot at all. It fails safe: no market, no nonce consumed, no fee booked.
    function test_aLauncherThatCannotReceiveMonCannotOvershootItsOwnFirstBuy() public {
        DeafLauncher deaf = new DeafLauncher(factory);
        vm.deal(address(deaf), 1_000_000 ether);

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 3 * NATIVE_TARGET;
        vm.expectRevert(BondingCurve.TransferFailed.selector);
        deaf.go(p, FEE + p.firstBuyQuote);

        assertEq(factory.nonces(address(deaf)), 0);
        assertEq(factory.pendingLaunchFees(), 0);
    }

    /// @dev `firstBuyQuote` is UNBOUNDED and `buyFor` charges anti-sniper rate ZERO
    ///      (BondingCurve.sol:542, `_buy(..., 0)`), so the entire curve is buyable inside the
    ///      launch transaction at a rate every other buyer — the creator included, one block later
    ///      — pays 50% of. Measured here rather than argued: the same MON, three ways.
    function test_theWholeCurveIsBuyableInsideTheLaunchAtAntiSniperRateZero() public {
        uint256 spend = 400e18;

        // (a) inside the launch
        DokuFactory.LaunchParams memory a = _p(address(0), Sinks.BURN, 0);
        a.firstBuyQuote = spend;
        vm.prank(CREATOR);
        (, address tokenA) = factory.launch{value: FEE + spend}(a);
        uint256 insideLaunch = DokuToken(tokenA).balanceOf(CREATOR);

        // (b) the very next call, same block, same market shape
        DokuFactory.LaunchParams memory b = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curveB, address tokenB) = factory.launch{value: FEE}(b);
        vm.prank(ALICE);
        BondingCurve(payable(curveB)).buy{value: spend}(0, vm.getBlockTimestamp() + 1);
        uint256 sameBlock = DokuToken(tokenB).balanceOf(ALICE);

        // (c) after the anti-sniper window has fully decayed
        DokuFactory.LaunchParams memory c = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curveC, address tokenC) = factory.launch{value: FEE}(c);
        vm.warp(vm.getBlockTimestamp() + 301);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(ALICE);
        BondingCurve(payable(curveC)).buy{value: spend}(0, vm.getBlockTimestamp() + 1);
        uint256 afterWindow = DokuToken(tokenC).balanceOf(ALICE);

        emit log_named_uint("inside the launch (rate 0)", insideLaunch);
        emit log_named_uint("same block, public   (rate 5000)", sameBlock);
        emit log_named_uint("after the window     (rate 0)", afterWindow);
        emit log_named_uint("launch-buy premium, bps", (insideLaunch * 10_000) / sameBlock - 10_000);

        assertGt(insideLaunch, sameBlock, "the launch buy is not exempt after all");
        // The exemption is worth more than the window it is supposed to protect.
        assertApproxEqRel(insideLaunch, afterWindow, 0.02e18, "the launch buy pays no anti-sniper rate");
        // 40% of a 1,000 MON target inside the launch, untaxed, is a majority of the float.
        assertGt(insideLaunch, 300_000_000e18, "not a meaningful share of supply");
    }

    // ====================================================================================
    // 2. THE PREDICTED ADDRESS
    // ====================================================================================

    /// @dev `predictMarket` and `launch` agree, including across a nested launch made from inside
    ///      the refund window — the one place where a creator's nonce moves twice in one call.
    function test_predictMarketAgreesWithLaunchEvenAcrossANestedLaunch() public {
        RefundProbe probe = new RefundProbe(factory);
        probe.setMode(2);
        vm.deal(address(probe), 1_000_000 ether);

        (address predictedCurve, address predictedToken) = factory.predictMarket(address(probe));

        DokuFactory.LaunchParams memory inner = _p(address(0), Sinks.BURN, 0);
        probe.setNested(inner, FEE);
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 3 * NATIVE_TARGET;
        (address curve,) = probe.go(p, FEE + p.firstBuyQuote);

        assertEq(curve, predictedCurve, "the outer launch did not land where it was predicted");
        assertEq(address(BondingCurve(payable(curve)).token()), predictedToken);
        // The nested launch took the NEXT slot, not the one the client had read.
        assertTrue(probe.nestedCurve() != predictedCurve);
        assertEq(
            probe.nestedCurve(),
            Clones.predictDeterministicAddress(
                factory.curveImplementation(),
                keccak256(abi.encode(address(probe), uint256(1))),
                address(factory)
            )
        );
    }

    /// @dev The curve and the token share a salt and can never collide, across creators and
    ///      nonces, because the clone address commits to the implementation as well.
    function testFuzz_theCurveAndTokenSlotsNeverCollide(address creator, uint256 nonce) public view {
        bytes32 salt = keccak256(abi.encode(creator, nonce));
        address c = Clones.predictDeterministicAddress(factory.curveImplementation(), salt, address(factory));
        address t = Clones.predictDeterministicAddress(factory.tokenImplementation(), salt, address(factory));
        assertTrue(c != t, "curve and token collided");
    }

    /// @dev Pre-funding the PREDICTED curve with native MON does not block the launch and is not
    ///      creditable — but it is also UNRECOVERABLE. After deployment the curve's `receive()`
    ///      reverts (BondingCurve.sol:993), so the pre-deployment window is the only way MON can
    ///      get into a curve unaccounted, and nothing sweeps it. Donor's loss, permanently.
    function test_monSentToAPredictedCurveBeforeLaunchIsPermanentlyUnrecoverable() public {
        (address predicted,) = factory.predictMarket(address(CREATOR));
        vm.prank(MALLORY);
        (bool ok,) = predicted.call{value: 7 ether}("");
        assertTrue(ok, "a codeless address must accept MON");

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve,) = factory.launch{value: FEE}(p);
        assertEq(curve, predicted, "CREATE2 refused a pre-funded address");
        assertEq(curve.balance, 7 ether);

        // Fill and graduate. The raise that comes out is the target, never the balance.
        vm.prank(ALICE);
        BondingCurve(payable(curve)).buy{value: 2 * NATIVE_TARGET}(0, vm.getBlockTimestamp() + 1);
        assertTrue(grad.graduated(curve), "market did not graduate");
        assertEq(grad.lastQuote(), NATIVE_TARGET, "the donation leaked into the raise");

        // And it is stuck. Drain every accounted bucket the curve still owes and the donation is
        // exactly what is left over, with no path to it: `receive()` reverts and there is no sweep.
        BondingCurve c = BondingCurve(payable(curve));
        if (c.pendingProtocol() != 0) c.collectProtocolFees();
        if (c.pendingFees() != 0) c.collectFees();
        if (c.pendingTax() != 0) c.collectTax();
        assertEq(c.pendingProtocol() + c.pendingFees() + c.pendingTax(), 0, "buckets not drained");
        assertEq(curve.balance, 7 ether, "the donation is not what is left");
        vm.prank(MALLORY);
        (bool ok2,) = curve.call{value: 1 wei}("");
        assertFalse(ok2, "the curve accepts bare MON after deployment");
    }

    // ====================================================================================
    // 3. CLONE / IMPLEMENTATION HYGIENE
    // ====================================================================================

    /// @dev A hypothesis of mine that turned out to be wrong, kept because the wrong version is
    ///      the interesting one: `DokuToken`'s constructor seals the implementation
    ///      (DokuToken.sol:62-64) and I expected `BondingCurve` — reached by `economicsPin` as a
    ///      LIVE ADDRESS, not just as a clone template — to have no such line. It does
    ///      (BondingCurve.sol:313-315). Both implementations are unclaimable, and the four values
    ///      the pin reads off the curve implementation are `constant`, so even a claimed one could
    ///      not move a launcher's quoted terms.
    function test_bothImplementationsAreSealedAtConstructionAndThePinReadsOnlyConstants() public {
        address impl = factory.curveImplementation();
        address tokenImpl = factory.tokenImplementation();
        bytes32 pinBefore = factory.economicsPin(address(0), Sinks.BURN, 0);

        Supply1e27 decoy = new Supply1e27();
        vm.prank(MALLORY);
        vm.expectRevert(BondingCurve.AlreadyInitialised.selector);
        BondingCurve(payable(impl)).initialize(
            address(decoy), address(0), NATIVE_TARGET, Sinks.BURN, address(0), 0, address(0), MALLORY, MALLORY, MALLORY
        );

        vm.prank(MALLORY);
        vm.expectRevert(DokuToken.AlreadyInitialised.selector);
        DokuToken(tokenImpl).initialize("Stolen", "STL", MALLORY, false, "https://cdn.doku.family/metadata/test.json");

        assertEq(factory.economicsPin(address(0), Sinks.BURN, 0), pinBefore, "the pin moved");
        assertFalse(factory.isMarket(impl));
        assertFalse(factory.isMarket(tokenImpl));

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve,) = factory.launch{value: FEE}(p);
        assertEq(BondingCurve(payable(curve)).factory(), address(factory));
        assertEq(BondingCurve(payable(curve)).graduator(), address(grad));
    }

    /// @dev The live market's token clone is initialised inside `_deploy` and cannot be re-claimed,
    ///      and there is no second path to `_mint`.
    function test_aLiveMarketTokenCannotBeReinitialisedOrMintedAgain() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch{value: FEE}(p);

        vm.prank(MALLORY);
        vm.expectRevert(DokuToken.AlreadyInitialised.selector);
        DokuToken(token).initialize("Stolen", "STL", MALLORY, false, "https://cdn.doku.family/metadata/test.json");

        assertEq(DokuToken(token).totalSupply(), 1_000_000_000e18);
        assertEq(DokuToken(token).balanceOf(curve), 1_000_000_000e18);
        assertEq(DokuToken(token).curve(), curve);
    }

    /// @dev An outside burn cannot move the seed. `launchSupply` is latched at `initialize`
    ///      (BondingCurve.sol:348), which is what closed the generation-2 freeze.
    function test_anOutsideBurnDoesNotMoveTheSeed() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 100e18;
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch{value: FEE + 100e18}(p);
        uint256 latched = BondingCurve(payable(curve)).launchSupply();

        vm.prank(CREATOR);
        DokuToken(token).transfer(MALLORY, 1_000_001);
        vm.prank(MALLORY);
        DokuToken(token).burn(1_000_001);
        assertEq(BondingCurve(payable(curve)).launchSupply(), latched, "launchSupply moved");

        vm.prank(ALICE);
        BondingCurve(payable(curve)).buy{value: 2 * NATIVE_TARGET}(0, vm.getBlockTimestamp() + 1);
        assertTrue(grad.graduated(curve), "the burn froze the market");
        assertGe(grad.lastBase(), DOKU_SEED_BASE);
        assertEq(grad.lastQuote(), NATIVE_TARGET);
    }

    /// @dev `factory.isMarket` is the protocol's single answer to "is this a market": it is what
    ///      `DokuGraduation.graduate` authenticates against (DokuGraduation.sol:190) and what
    ///      `CreatorSink.credit` gates on (CreatorSink.sol:181). Only `_deploy` writes it
    ///      (DokuFactory.sol:305), and it writes only the address `Clones.cloneDeterministic`
    ///      returned — so every `isMarket` address is a minimal proxy to the IMMUTABLE curve
    ///      implementation, and the generation-2 counterfeit-curve freeze cannot be re-entered.
    function test_isMarketCanOnlyEverNameAGenuineCloneOfTheCurveImplementation() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch{value: FEE}(p);

        // EIP-1167: 45 bytes, with the implementation address at offset 10.
        bytes memory code = curve.code;
        assertEq(code.length, 45, "a market is not a minimal proxy");
        address embedded;
        assembly {
            embedded := shr(96, mload(add(code, 42)))
        }
        assertEq(embedded, factory.curveImplementation(), "a market points at another implementation");

        Counterfeit fake = new Counterfeit(token, address(0), NATIVE_TARGET);
        assertFalse(factory.isMarket(address(fake)), "a counterfeit was accepted as a market");
        assertTrue(factory.isMarket(curve));
        assertEq(factory.creatorOf(curve), CREATOR);
        assertEq(factory.creatorOf(address(fake)), address(0));
    }

    // ====================================================================================
    // 4. QUOTE REGISTRY — is the freeze guard complete at its own boundary?
    // ====================================================================================

    /// @dev The registry's two rules (`>= 5`, `% 5 == 0`) exist so a filled market can always
    ///      graduate. `test/_gen3/FactoryGen3Audit.t.sol::testFuzz_seedNeverExceedsWhatTheCurveHolds`
    ///      already fuzzes that above 5e6 on a six-decimal quote. This one is the part it never
    ///      reaches: targets at the ARITHMETIC MINIMUM (5 wei) up to 5e6, on the NATIVE quote,
    ///      with an adversary burning and donating the market's own token between every trade.
    struct Edge {
        DokuFactory f;
        Grad g;
        BondingCurve c;
        DokuToken t;
        uint256 target;
    }

    function _edgeMarket(uint256 target, uint8 sink, uint16 tax) internal returns (Edge memory e) {
        e.target = target;
        QuoteRegistry r2 = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        r2.register(address(0), target);
        e.f = new DokuFactory(OWNER, PAUSER, TREASURY, address(r2), SINKADDR, 0);
        e.g = new Grad(address(e.f));
        vm.prank(OWNER);
        e.f.setGraduator(address(e.g));
        Wiring.activate(e.f, OWNER, address(e.g));

        DokuFactory.LaunchParams memory p;
        p.meta.name = "Edge";
        p.meta.ticker = "EDGE";
        p.sink = sink;
        p.creatorTaxBps = tax;
        p.economicsPin = e.f.economicsPin(address(0), sink, tax);
        p.deadline = type(uint256).max;
        if (sink == Sinks.CREATOR) p.routedRecipient = CREATOR;
        vm.prank(CREATOR);
        (address curveAddr,) = e.f.launch(p);
        e.c = BondingCurve(payable(curveAddr));
        e.t = DokuToken(address(e.c.token()));
    }

    /// @dev One round of: buy, adversarial burn, adversarial donation to the curve, sell.
    function _edgeRound(Edge memory e, uint256 buyAmt, uint256 donateSeed, uint256 sellBps) internal {
        vm.warp(vm.getBlockTimestamp() + 60);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(ALICE);
        try e.c.buy{value: buyAmt}(0, type(uint256).max) {} catch {}
        if (e.c.readyToGraduate()) return;

        uint256 held = e.t.balanceOf(ALICE);
        uint256 d = held == 0 ? 0 : donateSeed % (held / 4 + 1);
        if (d != 0) {
            vm.prank(ALICE);
            e.t.transfer(MALLORY, d);
            vm.prank(MALLORY);
            e.t.burn(d / 2);
            vm.prank(MALLORY);
            e.t.transfer(address(e.c), d - d / 2);
        }

        held = e.t.balanceOf(ALICE);
        uint256 sellAmt = (held * sellBps) / 10_000;
        if (sellAmt == 0) return;
        vm.prank(ALICE);
        e.t.approve(address(e.c), sellAmt);
        vm.prank(ALICE);
        try e.c.sell(sellAmt, 0, type(uint256).max) {} catch {}
    }

    /// @dev The registry's two rules (`>= 5`, `% 5 == 0`) exist so a filled market can always
    ///      graduate. `test/_gen3/FactoryGen3Audit.t.sol::testFuzz_seedNeverExceedsWhatTheCurveHolds`
    ///      already fuzzes that above 5e6 on a six-decimal ERC-20 quote. This one is the part it
    ///      never reaches: targets from the ARITHMETIC MINIMUM (5 wei) up to 5e6 — the band the
    ///      live WBTC (1.017e7), cbBTC (1.017e7) and XAUt0 (1.80959e6) targets sit in or next to —
    ///      on the NATIVE quote, with an adversary burning the market's own token and donating it
    ///      to the curve between every trade.
    function testFuzz_theRegistryMinimumIsEnoughForAMarketToGraduate(
        uint256 targetSeed,
        uint8 sinkRaw,
        uint16 taxRaw,
        uint64[4] calldata buys,
        uint16[4] calldata sellBps,
        uint64[4] calldata donations
    ) public {
        Edge memory e =
            _edgeMarket(bound(targetSeed, 1, 1_000_000) * 5, uint8(sinkRaw % 3), uint16((taxRaw % 101) * 10));

        for (uint256 i; i < 4; ++i) {
            if (e.c.readyToGraduate()) break;
            _edgeRound(e, bound(uint256(buys[i]), 1, e.target * 2), uint256(donations[i]), sellBps[i] % 10_000);
        }

        if (!e.c.readyToGraduate()) {
            vm.warp(vm.getBlockTimestamp() + 1000);
            vm.roll(vm.getBlockNumber() + 1);
            vm.prank(ALICE);
            e.c.buy{value: e.target * 4}(0, type(uint256).max);
        }

        assertTrue(e.c.readyToGraduate(), "did not fill");
        assertTrue(e.g.graduated(address(e.c)), "auto-graduation was swallowed: the raise is frozen");
        assertEq(e.g.lastQuote(), e.target, "the raise is not exactly the target");
        assertGe(e.g.lastBase(), DOKU_SEED_BASE, "the seed came out short: DokuGraduation would revert");
    }

    /// @dev The exactness the divisibility rule buys, stated directly: for every registry-legal
    ///      target the virtual quote floor is exact and the reserve at fill is exactly 1.4x target.
    function testFuzz_theVirtualQuoteFloorIsExactForEveryLegalTarget(uint256 targetSeed) public {
        uint256 target = bound(targetSeed, 1, 2e29 / 5) * 5;
        QuoteRegistry r2 = new QuoteRegistry(OWNER);
        vm.prank(OWNER);
        r2.register(address(0), target);
        assertEq(r2.quoteTarget(address(0)) * 2 % 5, 0, "the floor truncates");

        DokuFactory f2 = new DokuFactory(OWNER, PAUSER, TREASURY, address(r2), SINKADDR, 0);
        Grad g2 = new Grad(address(f2));
        vm.prank(OWNER);
        f2.setGraduator(address(g2));

        // The factory ships paused with no graduator; activation is what opens it. See
        // `test/helpers/Wiring.sol`.
        Wiring.activate(f2, OWNER, address(g2));
        DokuFactory.LaunchParams memory p;
        p.meta.name = "Floor";
        p.meta.ticker = "FLR";
        p.economicsPin = f2.economicsPin(address(0), Sinks.BURN, 0);
        p.deadline = type(uint256).max;
        vm.prank(CREATOR);
        (address curveAddr,) = f2.launch(p);
        (, uint128 q) = BondingCurve(payable(curveAddr)).reserves();
        assertEq(uint256(q) * 5, target * 2, "the virtual quote floor is not exact");
    }

    /// @dev L-04 (external review 2026-09-10), FIXED. Kept as the regression, flipped rather than
    ///      deleted: reverting the fix turns this red again.
    ///
    ///      The registry enforced the minimum but not `MAX_QUOTE_TARGET`, so an asset could sit
    ///      registered and enabled while every launch against it reverted during curve
    ///      initialisation. The bound is now a shared file-level constant — the same pattern
    ///      `DOKU_MIN_QUOTE_TARGET` already used — enforced in BOTH places, so the refusal happens
    ///      at `register`, where the owner is standing there to read it, rather than at every
    ///      creator's launch.
    ///
    ///      The severity is Informational rather than Low, and the reason is the `onlyOwner` on
    ///      `register`: this was a footgun only the owner could arm, and only the owner could
    ///      disarm. No creator funds were ever reachable — the launch reverted before a market
    ///      existed.
    function test_theRegistryRefusesATargetTheCurveWouldReject() public {
        uint256 tooBig = 1e30 + 5;
        QuoteRegistry r2 = new QuoteRegistry(OWNER);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(QuoteRegistry.TargetTooLarge.selector, tooBig, 1e30));
        r2.register(address(0), tooBig);

        assertEq(r2.quoteTarget(address(0)), 0, "a refused target was still recorded");

        // The boundary itself, which is the assertion that would actually catch a drift: the
        // largest target the curve accepts must be a target the registry accepts. Comparing the two
        // constants would prove nothing — one is assigned from the other — so this exercises both
        // code paths at the exact value instead.
        vm.prank(OWNER);
        r2.register(address(0), 1e30);
        assertEq(r2.quoteTarget(address(0)), 1e30, "the registry refused the curve's own maximum");
    }

    /// @dev A target change cannot be seen differently by the pin check (DokuFactory.sol:208) and
    ///      the deploy (DokuFactory.sol:287): there is no external call between them, and a change
    ///      that lands before the transaction is refused by the pin rather than silently applied.
    function test_theTargetThePinCommitsToIsTheTargetTheMarketGets() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(OWNER);
        registry.setQuoteTarget(address(0), 2_000e18);

        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.EconomicsChanged.selector);
        factory.launch{value: FEE}(p);

        DokuFactory.LaunchParams memory p2 = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve,) = factory.launch{value: FEE}(p2);
        assertEq(BondingCurve(payable(curve)).quoteTarget(), 2_000e18);
        assertEq(BondingCurve(payable(curve)).quoteTarget(), registry.quoteTarget(address(0)));
    }

    // ====================================================================================
    // 5. IDENTITY
    // ====================================================================================

    /// @dev The ticker is held to 2..12 alphanumeric bytes and becomes `symbol()` forever. The
    ///      NAME is not validated at all beyond its byte length — arbitrary bytes, control
    ///      characters and bidi overrides included — and no uniqueness is enforced on either. Two
    ///      markets can therefore be byte-identical to a wallet that renders name and symbol.
    function test_theNameIsUnvalidatedBytesAndTwoMarketsMayShareAnIdentity() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        // Built at runtime: solc refuses an unbalanced bidi override in a source literal. The
        // factory accepts the same bytes without a word.
        string memory spoof = string(abi.encodePacked("USDC", bytes3(0xE280AE), "gnitekram"));
        p.meta.name = spoof;
        p.meta.ticker = "USDC";
        vm.prank(CREATOR);
        (, address t1) = factory.launch{value: FEE}(p);

        DokuFactory.LaunchParams memory q = _p(address(0), Sinks.BURN, 0);
        q.meta.name = spoof;
        q.meta.ticker = "USDC";
        vm.prank(MALLORY);
        (, address t2) = factory.launch{value: FEE}(q);

        assertEq(DokuToken(t1).name(), DokuToken(t2).name(), "identity is not duplicable");
        assertEq(DokuToken(t1).symbol(), DokuToken(t2).symbol());
        assertTrue(t1 != t2);
    }

    /// @dev The name/ticker lock is real: `setMetadata` compares the hash of both before it will
    ///      re-emit, and the ERC-20's own `symbol()` has no setter at all.
    function test_theIdentityLockHoldsForBothFieldsIndependently() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch{value: FEE}(p);

        DokuFactory.Metadata memory m;
        m.name = "Market";
        m.ticker = "MKT2";
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.IdentityLocked.selector);
        factory.setMetadata(curve, m);

        m.name = "Market2";
        m.ticker = "MKT";
        vm.prank(CREATOR);
        vm.expectRevert(DokuFactory.IdentityLocked.selector);
        factory.setMetadata(curve, m);

        m.name = "Market";
        m.ticker = "MKT";
        m.website = unicode"javascript:drain()";
        vm.prank(CREATOR);
        factory.setMetadata(curve, m); // links are capped in LENGTH and nothing else

        vm.prank(MALLORY);
        vm.expectRevert(DokuFactory.NotCreator.selector);
        factory.setMetadata(curve, m);

        assertEq(DokuToken(token).symbol(), "MKT");
    }

    // ====================================================================================
    // 6. ROLES — what each can actually reach
    // ====================================================================================

    /// @dev The pauser's whole surface is `pause()`. Every other write is `onlyOwner`, and the
    ///      pause itself cannot reach a live market's money.
    function test_thePauserCanReachNothingButPauseAndPauseCannotReachAMarket() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        p.firstBuyQuote = 10e18;
        vm.prank(CREATOR);
        (address curve, address token) = factory.launch{value: FEE + 10e18}(p);

        vm.startPrank(PAUSER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.unpause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.setFeeRecipient(PAUSER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.setGraduator(PAUSER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.setLaunchFee(0);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.setFeeExempt(PAUSER, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.setPauser(PAUSER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, PAUSER));
        factory.transferOwnership(PAUSER);
        factory.pause();
        vm.stopPrank();

        // Paused: launches stop, and nothing else does.
        DokuFactory.LaunchParams memory q = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.launch{value: FEE}(q);

        vm.prank(ALICE);
        BondingCurve(payable(curve)).buy{value: 5e18}(0, vm.getBlockTimestamp() + 1);
        uint256 bal = DokuToken(token).balanceOf(ALICE);
        vm.prank(ALICE);
        DokuToken(token).approve(curve, bal);
        vm.prank(ALICE);
        BondingCurve(payable(curve)).sell(bal, 0, vm.getBlockTimestamp() + 1);
        factory.collectLaunchFees();
        BondingCurve(payable(curve)).collectProtocolFees();
        vm.prank(ALICE);
        BondingCurve(payable(curve)).buy{value: 3 * NATIVE_TARGET}(0, vm.getBlockTimestamp() + 1);
        assertTrue(grad.graduated(curve), "a paused factory blocked a graduation");
    }

    /// @dev The owner's reach over a market's money is bounded by WHEN it acts. `setGraduator`
    ///      is future-markets-only because the curve pins its graduator at `initialize` and has no
    ///      setter — so the H-01 exposure (external review 2026-09-10, recorded; re-reported
    ///      2026-09-11) was markets launched AFTER a hostile `setGraduator`, never markets already
    ///      trading.
    ///
    ///      THIS TEST USED TO ASSERT THE EXPOSURE. It read: the owner calls `setGraduator(OWNER)`,
    ///      which the check exempted; the next market pins that EOA; the market fills; the owner
    ///      calls `release()` and receives `NATIVE_TARGET`. Every line of that passed. What it
    ///      records now is the fix — the setter refuses an address with no code, with no exemption
    ///      for the owner — and the half of the old behaviour that was never a bug: a market already
    ///      trading cannot be reached by anything the owner does afterwards.
    function test_setGraduatorCannotReachAMarketThatAlreadyExists() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address curve,) = factory.launch{value: FEE}(p);

        // The exemption is gone: the owner is an EOA, and an EOA in the graduator slot is custody
        // of every market launched under it.
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.GraduatorHasNoCode.selector, OWNER));
        factory.setGraduator(OWNER);
        assertEq(factory.graduator(), address(grad), "the graduator moved anyway");

        // The live market still answers to the graduator it launched with, and always would have.
        assertEq(BondingCurve(payable(curve)).graduator(), address(grad));
        vm.prank(ALICE);
        BondingCurve(payable(curve)).buy{value: 3 * NATIVE_TARGET}(0, vm.getBlockTimestamp() + 1);
        assertTrue(grad.graduated(curve), "an existing market followed a new graduator");

        // And the remaining owner power, stated plainly rather than pretended away: the owner may
        // still point FUTURE launches at a different CONTRACT, and that contract may do as it likes
        // with the raise. What the fix buys is that doing so costs a deployment rather than a
        // one-word setter call naming an address that was already in the slot — and that
        // `economicsPin` now carries the graduator, so no pending launch settles into it silently.
        Grad replacement = new Grad(address(factory));
        vm.prank(OWNER);
        factory.setGraduator(address(replacement));
        Wiring.activate(factory, OWNER, address(replacement));
        DokuFactory.LaunchParams memory q = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        (address later,) = factory.launch{value: FEE}(q);
        assertEq(BondingCurve(payable(later)).graduator(), address(replacement));
        assertEq(BondingCurve(payable(curve)).graduator(), address(grad), "an existing market moved");
    }

    /// @dev `renounceOwnership` is single-step and inherited from `Ownable`. Renouncing while
    ///      paused leaves `launch` permanently unreachable: `unpause` is `onlyOwner`.
    function test_renouncingOwnershipWhilePausedStopsLaunchesForever() public {
        vm.prank(PAUSER);
        factory.pause();
        vm.prank(OWNER);
        factory.renounceOwnership();
        assertEq(factory.owner(), address(0));

        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);
        vm.prank(CREATOR);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        factory.launch{value: FEE}(p);

        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, OWNER));
        factory.unpause();
    }

    // ====================================================================================
    // 7. THE LAUNCH FEE
    // ====================================================================================

    /// @dev The fee cannot be underpaid, overpaid, or diverted; and a fee exemption granted or
    ///      revoked between the quote and the send fails the launch SAFE rather than changing what
    ///      is charged, because `msg.value` must match exactly.
    function test_theLaunchFeeCannotBeAvoidedOverpaidOrDiverted() public {
        DokuFactory.LaunchParams memory p = _p(address(0), Sinks.BURN, 0);

        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, FEE - 1, FEE));
        factory.launch{value: FEE - 1}(p);

        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, FEE + 1, FEE));
        factory.launch{value: FEE + 1}(p);

        // An exemption landing mid-flight makes the pending transaction fail, not overcharge.
        vm.prank(OWNER);
        factory.setFeeExempt(CREATOR, true);
        vm.prank(CREATOR);
        vm.expectRevert(abi.encodeWithSelector(DokuFactory.ValueMismatch.selector, FEE, 0));
        factory.launch{value: FEE}(p);

        vm.prank(CREATOR);
        factory.launch{value: 0}(p);
        assertEq(factory.pendingLaunchFees(), 0, "an exempt launch booked a fee");

        vm.prank(OWNER);
        factory.setFeeExempt(CREATOR, false);
        vm.prank(CREATOR);
        factory.launch{value: FEE}(p);

        // Collection is permissionless and can only ever reach `feeRecipient`.
        vm.prank(MALLORY);
        factory.collectLaunchFees();
        assertEq(TREASURY.balance, FEE);
        assertEq(MALLORY.balance, 1_000_000 ether);
        vm.expectRevert(DokuFactory.NothingToCollect.selector);
        factory.collectLaunchFees();
    }

    /// @dev Only the caller's OWN allowance is ever spent on the ERC-20 first-buy leg. The factory
    ///      holds a standing allowance from every launcher (the client approves the FACTORY), so
    ///      the absence of a `payer` parameter anywhere in `DokuFactory` is load-bearing.
    function test_theFactoryCanOnlySpendTheCallersOwnAllowance() public {
        Q6 q = new Q6();
        vm.prank(OWNER);
        registry.register(address(q), 8_000e6);
        q.mint(ALICE, 1_000_000e6);
        vm.prank(ALICE);
        q.approve(address(factory), type(uint256).max); // the victim's standing approval

        q.mint(MALLORY, 10e6);
        vm.prank(MALLORY);
        q.approve(address(factory), type(uint256).max);
        vm.deal(MALLORY, 1_000 ether);

        DokuFactory.LaunchParams memory p = _p(address(q), Sinks.CREATOR, 0);
        p.routedRecipient = MALLORY;
        p.firstBuyQuote = 500e6; // more than Mallory has, less than Alice has

        vm.prank(MALLORY);
        vm.expectRevert();
        factory.launch{value: FEE}(p);
        assertEq(q.balanceOf(ALICE), 1_000_000e6, "the victim's balance moved");
    }
}
