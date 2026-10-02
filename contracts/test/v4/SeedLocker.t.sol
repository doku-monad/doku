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

// Imported ONLY so forge compiles their artifacts: v4-periphery's test `Deploy` library builds
// them through `vm.getCode(...)`, which resolves against the build output rather than the source
// tree, so a contract nothing here imports is never compiled and `setUp` fails on "no matching
// artifact found". Same note as `GraduationV4.t.sol`.
// solhint-disable-next-line no-unused-import
import {PositionManager} from "@uniswap/v4-periphery/src/PositionManager.sol";
import {PositionDescriptor} from "@uniswap/v4-periphery/src/PositionDescriptor.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

contract LockerToken is ERC20 {
    constructor() ERC20("Lock", "LCK") {
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice The locker forwards a position's QUOTE fees into the hook's ledger for every sink that
///         pays in the quote, whichever side of the key the quote sits on and whichever asset it is.
///
/// @dev The hook is `dokuHook` rather than `hook` because `PosmTestSetup` already declares a `hook`
///      of its own, and Solidity refuses a shadowing state variable. `GraduationV4.t.sol` names it
///      the same way for the same reason.
contract SeedLockerTest is PosmTestSetup {
    uint160 internal constant FLAGS = 0x2FCF;
    address internal constant TREASURY = address(0xBEEF);
    address internal constant CREATOR_SINK = address(0xC5);
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint160 internal constant SQRT_1_1 = 79228162514264337593543950336;
    uint128 internal constant SEED_LIQUIDITY = 100e18;
    int24 internal constant SEED_LOWER = -6000;
    int24 internal constant SEED_UPPER = 6000;

    DokuHook internal dokuHook;
    SeedLocker internal locker;
    PoolDonateTest internal donor;
    address internal sinkAddr = address(0x51);

    // No `receive()` here: `Deployers` already declares a non-virtual one, and native fees land at
    // the locker, never at this contract.

    function setUp() public {
        deployFreshManagerAndRouters();
        deployPosm(manager);
        donor = new PoolDonateTest(IPoolManager(address(manager)));
        bytes memory args = abi.encode(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(DokuHook).creationCode, args);
        dokuHook = new DokuHook{salt: salt}(IPoolManager(address(manager)), address(this), TREASURY, CREATOR_SINK);
        dokuHook.setGraduator(address(this), true);
        locker = new SeedLocker(IPositionManager(address(lpm)), address(dokuHook), address(manager)); // graduation = this test
        vm.deal(address(this), 1_000_000 ether);
    }

    /// @dev Built the way `DokuGraduation` builds one: register, arm the seed waiver, mint the seed
    ///      to the locker, disarm. The waiver is not decoration here — a levied add on a native
    ///      market owes more quote than the mint was funded with, which is exactly why production
    ///      arms it too.
    function _market(address quote, address token, uint8 sink)
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
        // Permit2 has nothing to approve for native MON; POSM is paid in `msg.value` instead.
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

    function test_nativeQuoteFeesAreCreditedToTheHooksLedger() public {
        LockerToken t = new LockerToken();
        (PoolKey memory k, PoolId id, uint256 tokenId) = _market(address(0), address(t), Sinks.REWARDS);
        _donateQuote(k, true, 1 ether);
        locker.collect(tokenId);
        assertGt(dokuHook.owedSink(id), 0.99 ether, "the MON fees did not reach the ledger");
        assertEq(address(locker).balance, 0, "the locker kept MON");
    }

    /**
     * @dev Deploys tokens until one sorts ABOVE the quote and one BELOW it, then runs both markets.
     *
     * The previous version of this test deployed a single token and computed `quoteIs0` from
     * whichever side it happened to land on — a property of the deployment nonces in `setUp`, not
     * of the test. It named both orderings and exercised exactly one, and which one was decided by
     * an address; reordering a deployment anywhere above could have put it and
     * `test_nativeQuoteFeesAreCreditedToTheHooksLedger` (where native is always currency0) on the
     * same side, leaving the currency1 path untested with nothing failing to say so.
     */
    function _tokenSorting(address quote, bool tokenAbove) internal returns (LockerToken t) {
        for (uint256 i; i < 64; ++i) {
            t = new LockerToken();
            if ((address(t) > quote) == tokenAbove) return t;
        }
        revert("no deployment nonce puts a token on the requested side of the quote");
    }

    function test_erc20QuoteFeesAreCreditedOnEitherOrdering() public {
        MockUSDC usdc = new MockUSDC();
        // Enough raw units to stand on the other side of a 1:1 pool against an 18-decimal token.
        usdc.mint(address(this), 1e24);

        // quote == currency0, then quote == currency1. Asserted rather than assumed, so the loop
        // above cannot quietly hand back the same side twice.
        for (uint256 pass; pass < 2; ++pass) {
            bool quoteIs0 = pass == 0;
            LockerToken t = _tokenSorting(address(usdc), quoteIs0);
            assertEq(address(usdc) < address(t), quoteIs0, "the fixture did not produce the ordering it claims");
            (PoolKey memory k, PoolId id, uint256 tokenId) = _market(address(usdc), address(t), Sinks.CREATOR);
            assertEq(
                Currency.unwrap(quoteIs0 ? k.currency0 : k.currency1),
                address(usdc),
                "the pool key does not carry the quote where this pass expects it"
            );
            _donateQuote(k, quoteIs0, 100e6);
            locker.collect(tokenId);
            assertGt(dokuHook.owedSink(id), 99e6, "the USDC fees did not reach the ledger");
            assertEq(usdc.balanceOf(address(locker)), 0, "the locker kept USDC");
            assertEq(t.balanceOf(address(locker)), 0, "the locker kept token");
        }
    }

    function test_aBurnMarketsTokenFeesGoToItsSinkAndNothingIsCredited() public {
        LockerToken t = new LockerToken();
        (PoolKey memory k, PoolId id, uint256 tokenId) = _market(address(0), address(t), Sinks.BURN);
        donor.donate(k, 0, 1_000e18, "");
        locker.collect(tokenId);
        assertGt(t.balanceOf(sinkAddr), 999e18, "the token fees did not reach the burn sink");
        assertEq(dokuHook.owedSink(id), 0, "a BURN market was credited quote");
    }

    function test_tokenDustOnAQuotePayingMarketIsBurnedNotHandedToTheSink() public {
        LockerToken t = new LockerToken();
        (PoolKey memory k,, uint256 tokenId) = _market(address(0), address(t), Sinks.REWARDS);
        donor.donate(k, 0, 1_000e18, ""); // a stranger donates token to a REWARDS pool
        uint256 dead = t.balanceOf(DEAD);
        locker.collect(tokenId);
        assertGt(t.balanceOf(DEAD) - dead, 0, "token on a quote-paying market was not burned");
        assertEq(t.balanceOf(sinkAddr), 0, "a quote-paying sink was handed the token");
    }
}
