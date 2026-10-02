import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { defineDokuChain } from "../../src/lib/chain/config";

const run = promisify(execFile);
const CONTRACTS = join(__dirname, "../../../../../contracts");

/** Anvil's first prefunded account — public, well-known, worthless outside a local node. */
const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/**
 * Uniswap's canonical Permit2, planted rather than deployed.
 *
 * PositionManager holds it immutably and graduation funds POSM through it, so the local chain must
 * have real code at the real address. It cannot be compiled from source here: Permit2 needs
 * `via_ir`, which the contracts project cannot enable without moving the v4 hook's creation code
 * and voiding its mined salt. The bytecode is read out of the vendored `DeployPermit2.sol` so there
 * is one copy of it in the repository.
 */
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** Two addresses PositionManager requires code at and graduation never calls. */
const DESCRIPTOR = "0x00000000000000000000000000000000000de5c1" as const;
const STUB_WETH = "0x00000000000000000000000000000000000de5c2" as const;
const STUB = "0x600160005260206000f3" as const;

function permit2Bytecode(): `0x${string}` {
  const src = readFileSync(
    join(CONTRACTS, "lib/v4-periphery/lib/permit2/test/utils/DeployPermit2.sol"),
    "utf8",
  );
  const m = src.match(/hex"([0-9a-fA-F]+)"/);
  if (!m) throw new Error("no Permit2 bytecode found in DeployPermit2.sol");
  return `0x${m[1]!}`;
}

export interface LocalChain {
  rpcUrl: string;
  publicClient: PublicClient;
  wallet: WalletClient;
  factory: `0x${string}`;
  curve: `0x${string}`;
  token: `0x${string}`;
  hook: `0x${string}`;
  /**
   * The v4 PoolManager singleton. Every graduated market's pool is state INSIDE this one contract,
   * so unlike V3's per-pool address it is the same value for every market and identifies none of
   * them — `poolId` is what does that.
   */
  poolManager: `0x${string}`;
  poolId: `0x${string}`;
  /** v4-core's `PoolSwapTest`. A production frontend routes through UniversalRouter; the pool sees
   *  the same swap either way. */
  swapRouter: `0x${string}`;
  /** v4 exposes pool state through `extsload`, so reading a price from outside needs this lens. */
  stateView: `0x${string}`;
  /** `V4Quoter`. Not a view function — it swaps and reverts with the answer — so it is simulated. */
  quoter: `0x${string}`;
  /**
   * A market quoted in an ERC-20 rather than in native MON, present only with `erc20Quote`.
   *
   * The write path forks on this: a native buy carries `value` and needs no approval, while an
   * ERC-20 buy has to be approved first and calls `buyWithToken`. Those are different functions
   * with different failure modes, and only the native one was covered — on a launchpad whose
   * point is that a coin can be priced in anything.
   */
  usdc?: {
    quote: `0x${string}`;
    curve: `0x${string}`;
    token: `0x${string}`;
  };
  stop: () => void;
}

/**
 * A local chain running the real contracts, with one market launched and untouched.
 *
 * The write path is where a mistake costs money, so it is tested against the contracts that ship
 * rather than against a mock of them. A mocked `simulateContract` would confirm the app calls a
 * function with the arguments the app chose — which is the assumption under test, not evidence.
 */
export interface LocalChainOptions {
  /** `false` runs the scenario through graduation, so there is a pool to trade. */
  launchOnly?: boolean;
  /**
   * Fork Monad mainnet instead of starting empty.
   *
   * The only way to exercise the app's real post-graduation path: UniversalRouter is not vendored
   * here and cannot be deployed, so a swap through it can only be tested where it already exists.
   * `LocalScenario` then deploys DOKU against the canonical singletons rather than its own.
   */
  fork?: boolean;
  /**
   * Also launch a market quoted in the scenario's mock USDC, exposed as `chain.usdc`.
   *
   * Off by default because it costs two more launches and most tests do not need it.
   */
  erc20Quote?: boolean;
}

export async function startLocalChain(
  port = 8560,
  launchOnlyOrOptions: boolean | LocalChainOptions = true,
): Promise<LocalChain> {
  const opts: LocalChainOptions =
    typeof launchOnlyOrOptions === "boolean"
      ? { launchOnly: launchOnlyOrOptions }
      : launchOnlyOrOptions;
  const launchOnly = opts.launchOnly ?? true;
  const rpcUrl = `http://127.0.0.1:${port}`;
  // 143, matching the `--chain-id` anvil is spawned with below. The app's clients are configured
  // for Monad and a signer on a different chain id is rejected outright, which is the same
  // protection the wrong-chain wallet state gives, arriving here first.
  const chain = defineDokuChain(rpcUrl, 143);
  const account = privateKeyToAccount(KEY);

  const forkUrl = process.env.MONAD_RPC_URL ?? "";
  if (opts.fork && !forkUrl) {
    throw new Error("MONAD_RPC_URL must be set to run a forked scenario");
  }

  const proc = spawn(
    "anvil",
    [
      ...(opts.fork ? ["--fork-url", forkUrl] : []),
      "--port", String(port),
      "--silent",
      // Monad's chain id, not anvil's default 31337. The app's clients are configured for Monad,
      // and a signer on a different chain id is rejected outright — which is the same protection
      // the wrong-chain wallet state provides, arriving here first.
      "--chain-id", "143",
      "--block-base-fee-per-gas", "0",
      // v4's PoolManager and PositionManager are ~24KB each: fine under Monad's 128KB limit, over
      // EIP-170's 24KB.
      "--disable-code-size-limit",
    ],
    { stdio: "ignore" },
  );
  const stop = () => proc.kill("SIGKILL");

  try {
    // cacheTime 0: the tests move the chain faster than viem's default 4s block-number cache.
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
      cacheTime: 0,
    }) as PublicClient;

    for (let i = 0; i < 100; i++) {
      try {
        await publicClient.getBlockNumber();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

    // On a fork the real Permit2 is already there. Planting over it would replace working code
    // with identical code — a write the fork simply does not need.
    if (!opts.fork) {
      await publicClient.request({
        method: "anvil_setCode",
        params: [PERMIT2, permit2Bytecode()],
      } as never);
    }
    await publicClient.request({ method: "anvil_setCode", params: [DESCRIPTOR, STUB] } as never);
    await publicClient.request({ method: "anvil_setCode", params: [STUB_WETH, STUB] } as never);

    const { stdout } = await run(
      "forge",
      [
        "script", "script/local/LocalScenario.s.sol:LocalScenario",
        "--rpc-url", rpcUrl,
        "--private-key", KEY,
        "--broadcast",
        "--non-interactive",
        "--slow",
        "--disable-code-size-limit",
      ],
      {
        cwd: CONTRACTS,
        env: {
          ...process.env,
          DOKU_LAUNCH_ONLY: launchOnly ? "true" : "false",
          DOKU_SCENARIO_USDC: opts.erc20Quote ? "true" : "false",
          // Set only when forking. Their presence is what tells the scenario to integrate with
          // canonical v4 rather than deploy its own.
          ...(opts.fork
            ? {
                DOKU_USE_EXISTING_V4: "true",
                V4_POOL_MANAGER: "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e",
                V4_POSITION_MANAGER: "0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016",
                V4_QUOTER: "0xa222dd357a9076d1091ed6aa2e16c9742dd26891",
              }
            : {}),
        },
        maxBuffer: 64e6,
      },
    );

    const pick = (label: string): `0x${string}` => {
      const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`));
      if (!m) throw new Error(`${label} missing from scenario output`);
      return m[1]!.toLowerCase() as `0x${string}`;
    };

    const pickWord = (label: string): `0x${string}` => {
      const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{64})`));
      if (!m) throw new Error(`${label} missing from scenario output`);
      return m[1]!.toLowerCase() as `0x${string}`;
    };

    return {
      rpcUrl,
      publicClient,
      wallet,
      factory: pick("DOKU_FACTORY"),
      curve: pick("DOKU_CURVE"),
      token: pick("DOKU_TOKEN"),
      hook: pick("DOKU_HOOK"),
      poolManager: pick("DOKU_POOL_MANAGER"),
      // A hash of the PoolKey rather than an address the chain assigns, so it is known before the
      // market graduates and the launch-only scenario reports it too.
      poolId: pickWord("DOKU_POOL_ID"),
      swapRouter: pick("DOKU_SWAP_ROUTER"),
      stateView: pick("DOKU_STATE_VIEW"),
      quoter: pick("DOKU_V4_QUOTER"),
      usdc: opts.erc20Quote
        ? {
            quote: pick("DOKU_USDC"),
            curve: pick("DOKU_CURVE_USDC"),
            token: pick("DOKU_TOKEN_USDC"),
          }
        : undefined,
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}
