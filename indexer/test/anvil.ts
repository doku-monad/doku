import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type Abi,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS = join(here, "../../contracts");

/** Anvil's first prefunded account. Public, well-known, and worthless outside a local node. */
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const account = privateKeyToAccount(DEPLOYER_KEY);

/**
 * Uniswap's canonical Permit2.
 *
 * PositionManager stores it immutably and DOKU's graduation funds POSM through it, so a local
 * chain has to have real Permit2 code at the real address. It is planted rather than deployed:
 * Permit2 needs `via_ir` to compile from source, which this project cannot turn on without moving
 * the hook's creation code and voiding its mined salt. The bytecode is read out of the vendored
 * `DeployPermit2.sol` so there is exactly one copy of it in the repository.
 */
export const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;

/** `PUSH1 1; MSTORE; RETURN 32` — code that exists and does nothing harmful. */
const STUB_CODE = "0x600160005260206000f3" as const;

/**
 * Two addresses PositionManager requires code at and graduation never calls: the descriptor only
 * serves `tokenURI`, and the wrapper only serves the WRAP/UNWRAP actions, which a pool whose
 * `currency0` is native MON never uses. Kept in sync with `LocalScenario.s.sol`, which holds them
 * as constants because a script cannot plant code itself.
 */
const DESCRIPTOR = "0x00000000000000000000000000000000000de5c1" as const;
const STUB_WETH = "0x00000000000000000000000000000000000de5c2" as const;

/** Pulled from the vendored helper rather than duplicated — 10KB of hex drifts silently. */
function permit2Bytecode(): `0x${string}` {
  const src = readFileSync(
    join(CONTRACTS, "lib/v4-periphery/lib/permit2/test/utils/DeployPermit2.sol"),
    "utf8",
  );
  const m = src.match(/hex"([0-9a-fA-F]+)"/);
  if (!m) throw new Error("no Permit2 bytecode found in DeployPermit2.sol");
  return `0x${m[1]!}`;
}

/**
 * A market the scenario launched, identified by the pair of addresses everything else keys on.
 *
 * Generation 2 launches more than one, because a market's *routing* — where the 70bps routed share
 * of its 1% fee goes — is fixed at launch and cannot be changed afterwards. One market therefore
 * exercises exactly one of the three routings, and the other two are simply never seen.
 */
export interface ScenarioMarket {
  curve: `0x${string}`;
  token: `0x${string}`;
}

export interface ScenarioOptions {
  /**
   * Launch the market and stop before any trade.
   *
   * The reorg suite drives its own buys so it can roll the chain back between them, and needs a
   * launched-but-empty curve to start from.
   */
  launchOnly?: boolean;
  /**
   * Also launch the two markets the first one cannot stand in for: a USDC-quoted market routing to
   * the creator with a 5% creator tax, and a native market routing to holder dividends.
   *
   * Off by default because it costs two more transactions in every suite that does not read them,
   * and because it is the only part of the scenario that needs a quote asset other than native MON.
   */
  extraMarkets?: boolean;
}

export interface Scenario {
  rpcUrl: string;
  client: PublicClient;
  wallet: WalletClient;
  factory: `0x${string}`;
  graduation: `0x${string}`;
  hook: `0x${string}`;
  /**
   * The registry of quote assets a market may be launched against, and the per-asset fill target.
   *
   * New in generation 2: generation 1 had one hardcoded quote (native MON) and one target, so
   * there was nothing to register. `quoteTarget` lives here rather than on the factory, which is
   * why a market's target is read from its `MarketLaunched` log and not from a constant.
   */
  quoteRegistry: `0x${string}`;
  /**
   * The one shared sink that holds creator-routed fees and creator taxes for every market.
   *
   * Shared, not per market: a creator with ten markets claims once per quote asset rather than ten
   * times, so balances are keyed `(who, quote)` and not by market.
   */
  creatorSink: `0x${string}`;
  /**
   * A six-decimal ERC-20, minted by the scenario, standing in for the USDC a local node has none of.
   *
   * Its decimals are the point. Every generation-1 amount on this chain was 18-decimal, so a
   * six-decimal quote is the case where a scale assumption baked in anywhere shows up.
   */
  usdc: `0x${string}`;
  /** The market the whole scenario drives: native MON quote, routing BURN (the UI's "buyback"). */
  curve: `0x${string}`;
  token: `0x${string}`;
  /**
   * USDC quote, routing CREATOR, with a 5% creator tax. Present only with `extraMarkets`.
   *
   * The only market whose fees land in the shared `CreatorSink`, and the only one carrying a
   * creator tax — so a suite that reads either reads this one.
   */
  usdcMarket?: ScenarioMarket;
  /**
   * Native MON quote, routing REWARDS (the UI's "holders"). Present only with `extraMarkets`.
   *
   * Its routed share escrows on the curve until graduation deploys the vault, which is a third
   * behaviour neither of the others shows.
   */
  holdersMarket?: ScenarioMarket;
  /**
   * The v4 PoolManager singleton — every graduated market's pool lives inside this one contract,
   * so unlike V3's per-pool address it is the same value for every market and identifies none of
   * them. `poolId` is what does that.
   */
  poolManager: `0x${string}`;
  /**
   * v4's PositionManager. Positions are discovered from the PoolManager's `ModifyLiquidity` logs,
   * because the manager is not ERC-721Enumerable and cannot be asked what an owner holds.
   */
  positionManager: `0x${string}`;
  poolId: `0x${string}`;
  swapRouter: `0x${string}`;
  /** v4 exposes pool state through `extsload`, so reading a price from outside needs this lens. */
  stateView: `0x${string}`;
  /**
   * The quoter the frontend simulates against. Not a `view` function — it performs the swap and
   * reverts with the result — so having a local one is what lets that path be tested at all.
   */
  quoter: `0x${string}`;
  stop: () => void;
}

async function waitForNode(url: string): Promise<PublicClient> {
  // cacheTime 0 because the tests mine blocks far faster than viem's default 4s block-number
  // cache expires. With the default, `getBlockNumber` reports a head from before the last mine and
  // the ingester concludes there is nothing to do.
  const client = createPublicClient({
    chain: foundry,
    transport: http(url),
    cacheTime: 0,
  }) as PublicClient;
  for (let i = 0; i < 100; i++) {
    try {
      await client.getBlockNumber();
      return client;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`anvil did not come up at ${url}`);
}

/**
 * Brings up a local chain holding the real protocol, driven through a full market lifecycle.
 *
 * The contracts are the ones that ship — compiled from source, not re-encoded by hand. That is the
 * entire point: a hand-written log fixture drifts from the contracts silently and keeps passing
 * while the indexer decodes the wrong thing in production.
 */
export async function startScenario(port = 8546, opts: ScenarioOptions = {}): Promise<Scenario> {
  const { launchOnly = false, extraMarkets = false } = opts;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(
    "anvil",
    [
      "--port", String(port),
      "--silent",
      "--block-base-fee-per-gas", "0",
      // Monad raised the contract size limit to 128KB; anvil defaults to EIP-170's 24KB, and
      // v4's PoolManager and PositionManager do not fit under that. Without this the local chain
      // is stricter than the chain we ship to, and the scenario fails for a reason production
      // does not have.
      "--disable-code-size-limit",
    ],
    { stdio: "ignore" },
  );
  const stop = () => proc.kill("SIGKILL");

  try {
    const client = await waitForNode(rpcUrl);
    const wallet = createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

    // Real Permit2 at the real address; see `permit2Bytecode`.
    await client.request({
      method: "anvil_setCode",
      params: [PERMIT2, permit2Bytecode()],
    } as never);

    // The two addresses PositionManager requires code at and never calls.
    await client.request({ method: "anvil_setCode", params: [DESCRIPTOR, STUB_CODE] } as never);
    await client.request({ method: "anvil_setCode", params: [STUB_WETH, STUB_CODE] } as never);

    const { stdout } = await run(
      "forge",
      [
        "script", "script/local/LocalScenario.s.sol:LocalScenario",
        "--rpc-url", rpcUrl,
        "--private-key", DEPLOYER_KEY,
        "--broadcast",
        "--non-interactive",
        // One transaction per block. Batched, forge packs several into a block, which would leave
        // the range-scanning and reorg tests exercising far fewer block boundaries than the name
        // suggests.
        "--slow",
        // Same reason as the anvil flag: PoolManager and PositionManager are ~24KB each and the
        // scenario script itself is larger still, all over EIP-170 but well under Monad's 128KB.
        // Note this must NOT be combined with `--skip-simulation`; skipping makes forge check the
        // artifacts against the default limit regardless.
        "--disable-code-size-limit",
      ],
      {
        cwd: CONTRACTS,
        env: {
          ...process.env,
          DOKU_LAUNCH_ONLY: launchOnly ? "true" : "false",
          // Opt-in, and read by the script as `vm.envOr(..., false)`, so an unset value is the
          // one-market scenario rather than a failure.
          DOKU_SCENARIO_USDC: extraMarkets ? "true" : "false",
        },
        maxBuffer: 64e6,
      },
    );

    /**
     * Anchored on the whitespace after the label, which is load-bearing.
     *
     * The generation-2 script prints `DOKU_CURVE`, `DOKU_CURVE_USDC` and `DOKU_CURVE_HOLDERS`, and
     * the same three for `DOKU_TOKEN`. Requiring whitespace immediately after the label is what
     * stops `DOKU_CURVE` from matching the first of the longer names and silently returning the
     * wrong market's address.
     */
    const find = (label: string): `0x${string}` | undefined => {
      const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`));
      return m ? (m[1]!.toLowerCase() as `0x${string}`) : undefined;
    };

    const pick = (label: string): `0x${string}` => {
      const found = find(label);
      if (!found) throw new Error(`${label} missing from scenario output:\n${stdout.slice(-4000)}`);
      return found;
    };

    /**
     * A market the script only launches under `DOKU_SCENARIO_USDC`.
     *
     * Both halves are demanded together: a curve printed without its token means the script
     * changed shape, and returning a half-built market would fail later somewhere unrelated.
     */
    const optionalMarket = (curveLabel: string, tokenLabel: string): ScenarioMarket | undefined => {
      const curve = find(curveLabel);
      const token = find(tokenLabel);
      if (!curve && !token) return undefined;
      if (!curve || !token) {
        throw new Error(`${curveLabel}/${tokenLabel} half-printed:\n${stdout.slice(-4000)}`);
      }
      return { curve, token };
    };

    // Past the confirmation lag, so the ingester considers the scenario's blocks safe.
    for (let i = 0; i < 8; i++) {
      await client.request({ method: "anvil_mine", params: [] } as never);
    }

    const pickWord = (label: string): `0x${string}` => {
      const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{64})`));
      if (!m) throw new Error(`${label} missing from scenario output:\n${stdout.slice(-4000)}`);
      return m[1]!.toLowerCase() as `0x${string}`;
    };

    return {
      rpcUrl,
      client,
      wallet,
      factory: pick("DOKU_FACTORY"),
      graduation: pick("DOKU_GRADUATION"),
      hook: pick("DOKU_HOOK"),
      quoteRegistry: pick("DOKU_QUOTE_REGISTRY"),
      creatorSink: pick("DOKU_CREATOR_SINK"),
      usdc: pick("DOKU_USDC"),
      curve: pick("DOKU_CURVE"),
      token: pick("DOKU_TOKEN"),
      usdcMarket: optionalMarket("DOKU_CURVE_USDC", "DOKU_TOKEN_USDC"),
      holdersMarket: optionalMarket("DOKU_CURVE_HOLDERS", "DOKU_TOKEN_HOLDERS"),
      poolManager: pick("DOKU_POOL_MANAGER"),
      positionManager: pick("DOKU_POSITION_MANAGER"),
      // Known before the market graduates — it is a hash of the PoolKey, not an address the chain
      // assigns — so the launch-only scenario reports it too.
      poolId: pickWord("DOKU_POOL_ID"),
      swapRouter: pick("DOKU_SWAP_ROUTER"),
      stateView: pick("DOKU_STATE_VIEW"),
      quoter: pick("DOKU_V4_QUOTER"),
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}

// ------------------------------------------------------------------ Monad mainnet, forked

/**
 * Monad mainnet. Asserted rather than assumed once the fork is up: a URL that answers and is not
 * this chain gives a scenario that deploys, runs, and proves nothing about the chain we ship to.
 */
export const MONAD_MAINNET_CHAIN_ID = 143;

/**
 * Canonical Uniswap v4 on Monad mainnet — the protocol's deployment, not ours, and the reason a
 * fork is worth running at all. `LocalScenario.s.sol` stands these up from source on a bare anvil;
 * here they are already there, with whatever state and whatever code the chain actually has.
 */
export const MONAD_POOL_MANAGER = "0x188d586Ddcf52439676Ca21A244753fA19F9Ea8e" as const;
export const MONAD_POSITION_MANAGER = "0x5b7eC4a94fF9beDb700fb82aB09d5846972F4016" as const;

/**
 * Circle's USDC on Monad. Six decimals.
 *
 * `FiatTokenV2_2` keeps balances in `balanceAndBlacklistStates` at slot 9 with the blacklist flag
 * in the top bit, which is why no balance heuristic finds it and the slot is written by hand.
 * Kept in step with `contracts/test/Fork.t.sol`, which measured it.
 */
export const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603" as const;
export const MONAD_USDC_BALANCE_SLOT = 9n;

/**
 * XAUt0, Tether Gold bridged to Monad. SIX decimals, and one whole token is one troy ounce.
 *
 * So a raw unit is worth ~3,300x a raw unit of USDC — the coarsest quote on the chain, and the one
 * that exposed both of the contracts' market-bricking bugs. It is an EIP-1967 proxy whose balances
 * live in slot 51 of the PROXY.
 */
export const MONAD_GOLD = "0x01bFF41798a0BcF287b996046Ca68b395DbC1071" as const;
export const MONAD_GOLD_BALANCE_SLOT = 51n;

/**
 * The fill targets, in each asset's own raw units, and every one of them DIVISIBLE BY FIVE.
 *
 * A target that is not truncates the curve's virtual quote floor (`target * 2 / 5`), which puts
 * the graduation seed below what `DokuGraduation` demands — so a market that filled could never
 * graduate and its whole raise would be stranded. `QuoteRegistry.register` refuses such a target,
 * which is why a wrong one here is a scenario that fails to start rather than a silent brick.
 *
 * Gold's is the figure `Fork.t.sol` uses: ~$8,000 at 2026 prices, and 2_424_242 would not do.
 */
export const MON_TARGET = 10n ** 18n;
export const USDC_TARGET = 8_000_000_000n;
export const GOLD_TARGET = 2_424_240n;

/**
 * The RPC a fork run needs, or undefined.
 *
 * Undefined is not a failure: the offline suite has to keep running on a machine with no archive
 * access, so the fork suite gates itself on this rather than on a try/catch around a connection.
 */
export function forkRpcUrl(): string | undefined {
  const url = process.env.MONAD_RPC_URL?.trim();
  return url ? url : undefined;
}

export interface ForkScenario {
  rpcUrl: string;
  client: PublicClient;
  wallet: WalletClient;
  /** The account every transaction in the fork suite is signed by, and the one holding the tokens. */
  account: `0x${string}`;
  /** Monad's head at the moment anvil forked it — the block the indexer must start from. */
  forkBlock: bigint;
  factory: `0x${string}`;
  graduation: `0x${string}`;
  seedLocker: `0x${string}`;
  hook: `0x${string}`;
  quoteRegistry: `0x${string}`;
  creatorSink: `0x${string}`;
  poolManager: `0x${string}`;
  positionManager: `0x${string}`;
  /** v4-core's `PoolSwapTest`, deployed here because a fork has no router this suite can encode for. */
  swapRouter: `0x${string}`;
  usdc: `0x${string}`;
  gold: `0x${string}`;
  stop: () => void;
}

/**
 * `keccak256(abi.encode(holder, slot))` — where a plain `mapping(address => uint256)` keeps one
 * balance.
 */
function balanceSlot(holder: `0x${string}`, slot: bigint): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [holder, slot],
    ),
  );
}

const decimalsAbi = parseAbi(["function decimals() view returns (uint8)"]);
const balanceOfAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/**
 * The DOKU protocol on a fork of Monad mainnet, deployed by the script that ships.
 *
 * Different in kind from `startScenario`, which spawns a bare anvil and builds the whole world —
 * Uniswap v4 included — out of this repository's own source. Everything that chain knows about
 * Monad is what this repository told it. Here the chain is Monad: real v4 singletons, real Permit2,
 * real CREATE2 proxy, and real six-decimal tokens whose balance mappings no heuristic can find.
 *
 * `latest`, never a pinned block. The public RPC keeps roughly 33–66 hours of state, so a pin rots
 * within days and the suite would start failing for a reason that has nothing to do with the code.
 *
 * `DeployDoku.s.sol` is called rather than reimplemented, and no quote asset is registered from
 * here: a harness that wired its own registry would prove the indexer follows a topology nothing
 * ships.
 */
export async function startForkScenario(port = 8570): Promise<ForkScenario> {
  const forkUrl = forkRpcUrl();
  if (!forkUrl) throw new Error("startForkScenario needs MONAD_RPC_URL");

  const rpcUrl = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(
    "anvil",
    [
      "--port", String(port),
      "--silent",
      "--fork-url", forkUrl,
      // Monad raised the contract size limit to 128KB and anvil defaults to EIP-170's 24KB. The
      // forked chain already holds contracts over that line, so without this the local node is
      // stricter than the chain it is a copy of.
      "--disable-code-size-limit",
      "--block-base-fee-per-gas", "0",
      // A public RPC answering a fork's storage reads is the slow part of this suite, and being
      // throttled by anvil's own governor on top of that turns a two-minute run into a timeout.
      "--no-rate-limit",
      "--timeout", "30000",
      "--retries", "5",
    ],
    { stdio: "ignore" },
  );
  const stop = () => proc.kill("SIGKILL");

  try {
    const client = await waitForNode(rpcUrl);

    /**
     * The premise, checked before anything is deployed onto it.
     *
     * A URL that answers and is not Monad mainnet gives a run that deploys, trades and graduates
     * against contracts this chain does not have — and reports green.
     */
    const chainId = await client.getChainId();
    if (chainId !== MONAD_MAINNET_CHAIN_ID) {
      throw new Error(`MONAD_RPC_URL is chain ${chainId}, not Monad mainnet ${MONAD_MAINNET_CHAIN_ID}`);
    }
    const chain = defineChain({
      id: MONAD_MAINNET_CHAIN_ID,
      name: "Monad (forked)",
      nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
    const forkBlock = await client.getBlockNumber();

    for (const singleton of [MONAD_POOL_MANAGER, MONAD_POSITION_MANAGER, PERMIT2] as const) {
      const code = await client.getCode({ address: singleton });
      if (!code || code === "0x") {
        throw new Error(`${singleton} has no code on the fork: this is not the chain DOKU graduates into`);
      }
    }

    // The deployment costs a few MON at the fork's own gas price, and the filling buys move real
    // quantities of gold. Both wallets are anvil's, so this is a local number, not a claim.
    await client.request({
      method: "anvil_setBalance",
      params: [account.address, toHex(10_000n * 10n ** 18n)],
    } as never);

    /**
     * Funding, by writing the balance slot and READING IT BACK.
     *
     * `deal()` — and anything else that guesses — cannot find either token's balance: USDC packs a
     * blacklist flag into the top bit of the same word, and gold keeps its mapping at a slot of the
     * PROXY that no heuristic reaches. A silent miss here would leave every wallet at zero, and
     * every assertion about money arriving would then be trivially true against nothing.
     */
    for (const [token, slot] of [
      [MONAD_USDC, MONAD_USDC_BALANCE_SLOT],
      [MONAD_GOLD, MONAD_GOLD_BALANCE_SLOT],
    ] as const) {
      const amount = 1_000_000_000_000n; // 1e12 raw units: a million dollars, or a million ounces
      await client.request({
        method: "anvil_setStorageAt",
        params: [token, balanceSlot(account.address, slot), pad(toHex(amount), { size: 32 })],
      } as never);
      const held = await client.readContract({
        address: token,
        abi: balanceOfAbi,
        functionName: "balanceOf",
        args: [account.address],
      });
      if (held !== amount) {
        throw new Error(`${token} moved its balance slot: wrote ${amount} at slot ${slot}, read ${held}`);
      }
      const decimals = await client.readContract({
        address: token,
        abi: decimalsAbi,
        functionName: "decimals",
      });
      if (Number(decimals) !== 6) {
        throw new Error(`${token} reports ${decimals} decimals on this chain, not the six it had`);
      }
    }

    /**
     * The SHIPPED deployment script, against the real singletons.
     *
     * `--slow` puts one transaction per block, which is what gives the ingester real block
     * boundaries to scan rather than one fat block holding the whole protocol.
     */
    const { stdout } = await run(
      "forge",
      [
        "script", "script/DeployDoku.s.sol:DeployDoku",
        "--rpc-url", rpcUrl,
        "--private-key", DEPLOYER_KEY,
        "--broadcast",
        "--non-interactive",
        "--slow",
        "--disable-code-size-limit",
      ],
      {
        cwd: CONTRACTS,
        env: {
          ...process.env,
          V4_POOL_MANAGER: MONAD_POOL_MANAGER,
          V4_POSITION_MANAGER: MONAD_POSITION_MANAGER,
          PERMIT2,
          /**
           * Pinned to the test account, not inherited.
           *
           * `DeployDoku` defaults all four of these to `msg.sender`, which is this account — but
           * the defaults only apply when the variables are UNSET, and forge loads `contracts/.env`
           * by itself on top of the `process.env` spread above. The moment that file gained a real
           * mainnet treasury for the mainnet deploy, this fixture started deploying a stack whose
           * protocol fees go to an address the test does not hold, and "the gold arrived" measured
           * a balance delta of zero against a collection that had worked perfectly.
           *
           * The fixture must not read the developer's deployment secrets. Naming every address it
           * depends on is what keeps a local `.env` out of the assertions.
           */
          DOKU_OWNER: account.address,
          DOKU_PAUSER: account.address,
          DOKU_TREASURY: account.address,
          DOKU_FEE_RECIPIENT: account.address,
          DOKU_QUOTE_TARGET: MON_TARGET.toString(),
          // Registered BY THE SCRIPT, from the same two lists a mainnet deployment sets. The
          // registry is never touched from here.
          DOKU_QUOTE_ASSETS: `${MONAD_USDC},${MONAD_GOLD}`,
          DOKU_QUOTE_TARGETS: `${USDC_TARGET},${GOLD_TARGET}`,
          DOKU_LAUNCH_FEE_WEI: "0",
        },
        maxBuffer: 64e6,
      },
    );

    const pick = (label: string): `0x${string}` => {
      const m = stdout.match(new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`));
      if (!m) throw new Error(`${label} missing from deployment output:\n${stdout.slice(-4000)}`);
      return m[1]!.toLowerCase() as `0x${string}`;
    };

    /**
     * v4-core's `PoolSwapTest`, deployed here rather than by the script.
     *
     * The chain has UniversalRouter, which is what a wallet uses, and this repository neither
     * vendors nor can encode for it. What the indexer reads is the PoolManager's own `Swap` log,
     * which is identical whoever unlocked the manager — so the router is the one part of the fork
     * that is allowed to be a test double, and it is v4-core's own.
     */
    /*
     * Deployed from its ARTIFACT rather than through `forge create`.
     *
     * `forge create` takes a `<path>:<name>` identifier and resolves it to the plain, unsuffixed
     * artifact. `foundry.toml` declares a second compiler profile, and with one present forge
     * writes per-profile files: a contract in our own `src` keeps its unsuffixed artifact, while
     * one compiled out of `lib` gets `PoolSwapTest.default.json` and no plain file at all. So the
     * identifier stopped resolving — "could not find artifact: PoolSwapTest" — the moment `lib`
     * became real submodules and forge regrouped its compilation units.
     *
     * Reading the artifact sidesteps the naming entirely, and it is the same bytecode either way.
     * Both names are tried because which one exists is a property of forge's grouping, not of this
     * test, and it has already changed once.
     */
    const artifactDir = join(CONTRACTS, "out", "PoolSwapTest.sol");
    const artifactFile = ["PoolSwapTest.json", "PoolSwapTest.default.json"]
      .map((n) => join(artifactDir, n))
      .find((f) => existsSync(f));
    if (!artifactFile) {
      throw new Error(
        `No PoolSwapTest artifact in ${artifactDir}. Run \`forge build\` in contracts/.`,
      );
    }
    const artifact = JSON.parse(readFileSync(artifactFile, "utf8")) as {
      abi: Abi;
      bytecode: { object: `0x${string}` };
    };

    const swapRouterHash = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [MONAD_POOL_MANAGER],
      chain,
      account,
    });
    const swapRouterReceipt = await client.waitForTransactionReceipt({
      hash: swapRouterHash,
    });
    if (swapRouterReceipt.status !== "success" || !swapRouterReceipt.contractAddress) {
      throw new Error(`PoolSwapTest did not deploy: ${swapRouterReceipt.status}`);
    }
    const swapRouterMatch = [null, swapRouterReceipt.contractAddress] as const;

    // Past the confirmation lag, so the ingester considers the deployment's blocks safe.
    for (let i = 0; i < 8; i++) {
      await client.request({ method: "anvil_mine", params: [] } as never);
    }

    return {
      rpcUrl,
      client,
      wallet,
      account: account.address,
      forkBlock,
      factory: pick("DOKU_FACTORY"),
      graduation: pick("DOKU_GRADUATION"),
      seedLocker: pick("DOKU_SEED_LOCKER"),
      hook: pick("DOKU_HOOK"),
      quoteRegistry: pick("DOKU_QUOTE_REGISTRY"),
      creatorSink: pick("DOKU_CREATOR_SINK"),
      poolManager: MONAD_POOL_MANAGER.toLowerCase() as `0x${string}`,
      positionManager: MONAD_POSITION_MANAGER.toLowerCase() as `0x${string}`,
      swapRouter: swapRouterMatch[1].toLowerCase() as `0x${string}`,
      usdc: MONAD_USDC.toLowerCase() as `0x${string}`,
      gold: MONAD_GOLD.toLowerCase() as `0x${string}`,
      stop,
    };
  } catch (e) {
    stop();
    throw e;
  }
}
