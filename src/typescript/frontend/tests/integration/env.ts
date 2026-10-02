/**
 * The chain configuration the integration suite runs against.
 *
 * `src/lib/chain/addresses.ts` reads its variables at MODULE LOAD and throws when one is missing,
 * which is deliberate — a deployment misconfigured that way should fail to boot rather than render
 * a working-looking app whose buttons do nothing. The cost is that any test importing that module,
 * however indirectly, needs the same variables present before the import runs, and
 * `pool.anvil.test.ts` imports it directly. Without this the whole suite failed to load with
 * "NEXT_PUBLIC_MONAD_CHAIN_ID is not set", which reads as a broken test rather than a missing
 * fixture.
 *
 * Every value is a placeholder for a local chain. Nothing here is a mainnet address, and nothing
 * here is asserted on: the tests that care about an address read it off the chain they started.
 *
 * Existing values win, so a developer pointing the suite at something real by exporting these
 * first is not overridden.
 */
const DEFAULTS: Record<string, string> = {
  NEXT_PUBLIC_MONAD_CHAIN_ID: "31337",
  NEXT_PUBLIC_MONAD_RPC_URL: "http://127.0.0.1:8545",
  NEXT_PUBLIC_DOKU_FACTORY: "0x0000000000000000000000000000000000000f01",
  NEXT_PUBLIC_DOKU_GRADUATION: "0x0000000000000000000000000000000000000f02",
  NEXT_PUBLIC_DOKU_REGISTRY: "0x0000000000000000000000000000000000000f03",
  NEXT_PUBLIC_DOKU_HOOK: "0x0000000000000000000000000000000000000f04",
  NEXT_PUBLIC_V4_POOL_MANAGER: "0x0000000000000000000000000000000000000f05",
  NEXT_PUBLIC_V4_QUOTER: "0x0000000000000000000000000000000000000f06",
  NEXT_PUBLIC_UNIVERSAL_ROUTER: "0x0000000000000000000000000000000000000f07",
  NEXT_PUBLIC_PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  NEXT_PUBLIC_V4_STATE_VIEW: "0x0000000000000000000000000000000000000f08",
  NEXT_PUBLIC_V4_POSITION_MANAGER: "0x0000000000000000000000000000000000000f09",
};

for (const [name, value] of Object.entries(DEFAULTS)) {
  if (!process.env[name]) process.env[name] = value;
}
