import { defineChain, formatUnits, isAddress } from "viem";

/**
 * Monad, and the addresses the app talks to.
 *
 * Everything here is validated at module load rather than at first use. A misconfigured deployment
 * should fail to start, loudly, instead of rendering a working-looking app that sends transactions
 * to the zero address — which is a real address, accepts MON, and never gives it back.
 */

/**
 * Monad's chain ids, for reference and for error messages.
 *
 * Not defaults. Both are read from configuration, because the two networks are indistinguishable
 * from inside the app: an app built for one and pointed at the other renders perfectly, and the
 * only symptom is that every address resolves to nothing.
 */
export const MONAD_MAINNET_CHAIN_ID = 143;
export const MONAD_TESTNET_CHAIN_ID = 10143;

/**
 * The LP fee on every graduated DOKU pool: ZERO, and not as a tuning choice.
 *
 * The market tax is skimmed from the swap's own flash accounting inside the hook, and that is only
 * possible while the pool takes no fee of its own — a non-zero `PoolKey.fee` makes the levy
 * unimplementable. So this is a structural property of the design, which is also why a third-party
 * LP in one of these pools earns nothing, ever. `test_theCanonicalPoolPaysItsLpsNothing` asserts it
 * against a real pool.
 *
 * It was 10,000 — V3's 1% tier — and stayed that way through the v4 migration while `poolKeyFor`
 * separately hardcoded 0. Nothing broke loudly: the two were never compared. What it did break is
 * `matchRecordsToMarkets`, which discards any position whose fee is not this constant, so every v4
 * position an address owned was filtered out as belonging to some other protocol's pool.
 */
export const POOL_FEE_TIER = 0;

/**
 * The tick spacing on every graduated DOKU pool.
 *
 * Part of the `PoolKey`, so it is part of the pool's identity — `poolIdFrom` hashes it, and
 * `pool-id.test.ts` pins the result against the live 🐋 pool, which is what proves this value is 60
 * rather than merely asserts it.
 *
 * It was 200 in `range.ts` — Uniswap V3's spacing for the 1% fee tier, carried over with the rest
 * of the V3 liquidity UI. Every range the panel produced was therefore snapped to a multiple of
 * 200, and 200 is not a multiple of 60: `887200 % 60 == 40`. v4 reverts on a tick that is not a
 * multiple of the pool's spacing, so EVERY add-liquidity failed, on every preset, not only Full.
 */
export const POOL_TICK_SPACING = 60;

/**
 * The sink's share of every swap's levy on the CURRENT hook source — generation 4. NOT what a
 * liquidity provider earns; nothing is, on a market that graduates under this hook.
 *
 * The name is history and stays for ABI stability; see `DokuHook.LP_LEVY_BPS`'s own docblock for
 * the full argument. Generation 3 — live on mainnet at the time of writing, `docs/doku/deployments.md`
 * — donates this same-named share to the pool's in-range positions through `poolManager.donate`,
 * and a narrow band at a trade's end tick could collect a disproportionate cut of the whole swap
 * for absorbing only its last step — 23 of 48 configurations profitable, best ROI 8,111 bps
 * (`test/audit/Round3Jit.t.sol`). Generation 4 removes the donation: `_settleLeg` books this share
 * straight to the market's `pendingSink` ledger instead, so it is income for the sink, never for a
 * position. With `POOL_LP_FEE` also zero, a third-party LP in a market graduated under generation 4
 * earns nothing from any source.
 *
 * It was 75 here, which was wrong even against the constant this name has always carried on every
 * hook shipped so far — generation 3's deployed value is 75 too (`docs/doku/deployments.md`,
 * "Levy, read from the deployed hook"). What changes at generation 4 is the constant's VALUE (70)
 * AND, separately, its MEANING (sink income rather than a donation) — two changes bundled in one
 * number because they shipped in the same hook. Mirrors `DokuHook.LP_LEVY_BPS` in
 * `contracts/src/v4/DokuHook.sol`, the source for whatever hook a market graduates into next.
 *
 * This constant does not describe every market on the app at once: a market's actual hook is
 * pinned at graduation and never changes (see `useMakerLevy`), so a market that graduated under
 * generation 2 or 3 keeps that hook's real rate forever. Nothing in this file is generation-aware —
 * see `maker-levy.ts` for where that distinction is load-bearing and this constant is deliberately
 * NOT reused for it.
 */
export const LP_LEVY_BPS = 70;

/**
 * Decimals for MON and for every launched token.
 *
 * One constant, because five components each defining their own is five places for it to drift —
 * and a wrong decimal count is invisible: the number still renders, just a billion times off.
 */
export const TOKEN_DECIMALS = 18;

/**
 * A base-unit amount as a display number.
 *
 * Goes through the decimal string rather than through arithmetic. The obvious shortcut — divide by
 * 1e12 as a bigint, then by 1e6 as a float, so the value reaching floating point stays inside
 * float64's exact range — is right for balances and destroys prices: every value below 1e-6 floors
 * to exactly zero on the first division. A launchpad's prices live there. Two of the four trades on
 * the first testnet market rendered as "0.000000000" in the trade feed, and on a market with a
 * smaller target every one of them would have.
 *
 * `formatUnits` places the decimal point by moving digits in a string, so nothing is lost on the
 * way in, and `Number` then keeps the ~15 significant digits it can hold. That is the same ceiling
 * any function returning a `number` has.
 *
 * Note there is no `**` anywhere in this file. The bundler downlevels it to `Math.pow`, which
 * throws "Cannot convert a BigInt value to a number" — and only in the browser, so it type-checks,
 * passes every node-run test, and crashes the page.
 */
export const toNominal = (value: bigint): number => Number(formatUnits(value, TOKEN_DECIMALS));

export function defineDokuChain(rpcUrl: string, chainId: number) {
  const testnet = chainId === MONAD_TESTNET_CHAIN_ID;
  return defineChain({
    id: chainId,
    name: testnet ? "Monad Testnet" : "Monad",
    testnet,
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    /**
     * Multicall3 at its canonical address, mainnet only (7,619 bytes of code there, read
     * 2026-09-12). Declaring it lets wagmi fold every `useReadContract` that fires in the same
     * tick into ONE `eth_call` — a market page was making three separate ~1.3 s round trips for
     * `totalSupply`, the curve's readiness and its graduation flag. Testnet is left undeclared on
     * purpose: viem would route reads through a contract nobody has verified is there, and a
     * missing multicall does not degrade, it fails every read.
     */
    contracts: testnet
      ? undefined
      : { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
    /**
     * MonadScan, because it is the explorer that shows a market's contracts as verified.
     *
     * Every token and curve is an EIP-1167 minimal proxy of a verified implementation. MonadScan
     * resolves the proxy and shows the implementation's source on the clone's own page; MonadVision
     * (BlockVision's Sourcify) has no proxy resolution at all, so every market it linked to read as
     * unverified for ever, whatever we submitted. The nine core contracts are verified on both.
     *
     * The `/token/`, `/address/` and `/tx/` segments `explorer-link.ts` appends are the
     * Etherscan-family paths MonadScan serves; all three were fetched before the switch. Its
     * `/token/` pages sit behind a Cloudflare browser check that refuses non-browser requests, as
     * MonadVision's whole site does.
     */
    blockExplorers: {
      default: {
        name: "MonadScan",
        url: testnet ? "https://testnet.monadscan.com" : "https://monadscan.com",
      },
    },
  });
}

/**
 * Reads a chain id from configuration, or refuses to start.
 *
 * There is deliberately no default. Falling back to mainnet would mean a deployment that forgot
 * the variable points at the one network where being wrong costs money, and it would do so
 * silently — the app renders either way. `Number("mainnet")` is `NaN` and `Number("")` is `0`,
 * both of which would sail through a looser check and become a chain id no wallet will match.
 */
export function requireChainId(value: string | undefined, name: string): number {
  if (!value) throw new Error(`${name} is not set`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${name} is not a chain id: ${value}`);
  }
  return id;
}

/**
 * Reads a contract address from configuration, or refuses to start.
 *
 * The failure this prevents: an unset environment variable is `undefined`, which becomes
 * `0x0000…0000` by the time it reaches a contract call. That address exists, transfers to it
 * succeed, and the funds are gone. A thrown error at boot is the cheapest possible version of
 * finding that out.
 */
export function requireAddress(value: string | undefined, name: string): `0x${string}` {
  if (!value) throw new Error(`${name} is not set`);
  // `strict: false` checks the shape, not the EIP-55 checksum. Strict validation would reject an
  // all-lowercase address, which is exactly what an operator pastes out of a block explorer or a
  // deploy log — a checksum failure at boot would look like a broken deployment rather than a
  // formatting preference. The value is lowercased below, so the checksum carries no information
  // we keep.
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${name} is not an address: ${value}`);
  }
  return value.toLowerCase() as `0x${string}`;
}

/**
 * Reads an address that a deployment is allowed not to have.
 *
 * The counterpart to `requireAddress`, for a contract that is genuinely optional — one whose
 * absence removes a feature rather than breaking the app. `null` is the answer callers must handle,
 * and handling it means offering nothing at all: a control that is present and disabled invites
 * somebody to work out how to enable it, and there is nothing behind it.
 *
 * A value that IS set and is malformed still throws. Absent and mistyped are opposite mistakes —
 * the first is a deployment that has not turned the feature on, the second is one that thinks it
 * has. Silently treating a truncated address as "off" would hide the only evidence of the second.
 */
export function optionalAddress(value: string | undefined, name: string): `0x${string}` | null {
  if (!value || value.trim() === "") return null;
  return requireAddress(value, name);
}
