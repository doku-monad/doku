/**
 * Boot-time configuration, validated before anything starts.
 *
 * Every value read here shares one failure shape: wrong or absent, the service starts anyway and
 * looks healthy. An unset `FACTORY_ADDRESS` used to become the string `"0x"`, which matches no log
 * the chain will ever emit — so the indexer reported zero events forever, which is exactly what a
 * quiet chain looks like. `START_BLOCK` defaulted to zero, which on a chain fifty million blocks
 * deep is not an error but a scan that never reaches the present.
 *
 * Neither of those is detectable from the outside. A process that refuses to start is, and it
 * fails before anybody has begun trusting the data.
 */

/**
 * Everything the process needs from its environment, in one validated shape.
 *
 * `ChainConfig` is what follows a chain; `ServiceConfig` is what runs the process. They are read
 * together and validated together — the alternative, which this replaced, was five more
 * `process.env` reads scattered through `index.ts`, none of them checked, each with its own
 * silent default.
 */
export interface ServiceConfig {
  /** Serves both the REST API and the client feed at `/live`. */
  port: number;
  /** Absent means the in-process engine, which is development only — it does not survive restart. */
  databaseUrl: string | undefined;
  /** How many pooled connections the managed client may open. */
  databasePoolSize: number;
  /** Where USD quotes come from. Absent means the USD columns stay null. */
  priceSourceUrl: string | undefined;
  /** Bearer token the frontend's upload route presents to POST/DELETE /uploads. Absent = writes refused. */
  uploadsToken: string | undefined;
  /**
   * The graduation keeper's signing key. Absent means no keeper: a stranded market waits for a
   * person to press the button. This is the rollback — unset it and nothing else changes.
   *
   * A DEDICATED key holding gas and nothing else. It signs one function, `graduate(curve)`, which
   * is permissionless and can only do the one correct thing, so the worst a leaked keeper key can
   * lose is its own balance. The deploy key must never be put here: it owns the factory.
   */
  keeperPrivateKey: `0x${string}` | undefined;
  /**
   * The dividend payout pass: the keeper claims holders' dividends for them once an epoch
   * matures, for every holder owed at least `payoutMinUsd`. `KEEPER_PAYOUT=off` turns it off and
   * nothing else changes; holders keep the button. `KEEPER_PAYOUT_MIN_USD` sets the floor,
   * default 5.
   */
  payout: boolean;
  payoutMinUsd: number;
  /**
   * The burn pass: the keeper sweeps and burns every graduated buyback market's accrued levy, at
   * most once a day per market and only when the burn destroys at least `burnMinUsd` of tokens.
   * `KEEPER_BURN=off` turns it off and nothing else changes; the tokens keep accruing in the hook,
   * out of circulation, and `sweep` + `burn()` stay permissionless. `KEEPER_BURN_MIN_USD` sets the
   * floor, default 100; zero burns any amount.
   */
  burn: boolean;
  burnMinUsd: number;
  chain: ChainConfig;
}

export interface ChainConfig {
  rpcUrl: string;
  chainId: number;
  factory: `0x${string}`;
  graduation: `0x${string}`;
  poolManager: `0x${string}`;
  /** Every accepted `Graduated` emitter. `graduation` is the first of these. */
  graduators: string[];
  positionManager?: `0x${string}`;
  /** Generation 2 (the pairs launchpad). All optional: absent means gen 2 is not followed. */
  factory2?: `0x${string}`;
  quoteRegistry?: `0x${string}`;
  creatorSink?: `0x${string}`;
  hook2?: `0x${string}`;
  graduation2?: `0x${string}`;
  /** The network's wrapped native token, for deciding a pool's token order. */
  /**
   * The chain's WebSocket endpoint, used to hear about new heads without waiting for the poll.
   *
   * Optional, and deliberately so: it is an accelerator, never the source of truth. Unset — or
   * disconnected — and the HTTP path below still indexes every block, just no sooner than the
   * next pass.
   */
  wsUrl: string | undefined;
  /** The block the protocol was deployed at. Scanning from before it is wasted work. */
  startBlock: bigint;
  /**
   * How many blocks one `eth_getLogs` may cover.
   *
   * Configuration rather than a constant because it is a property of the node, not of this
   * service: Monad's public RPC rejects a request for more than 100 outright, and a dedicated
   * node allows far more.
   */
  batchSize: bigint;
}

type Env = Record<string, string | undefined>;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * Reads the chain configuration, or throws naming everything that is wrong.
 *
 * Errors accumulate rather than throwing on the first one. An operator restarting four times to
 * discover four missing variables learns the same thing four times as slowly, and each restart
 * looks like a new failure.
 */
/**
 * Reads the whole configuration. Throws once, naming everything that is wrong.
 */
export function readConfig(env: Env): ServiceConfig {
  const problems: string[] = [];

  const positiveInt = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      problems.push(`${name} is not a positive integer: ${raw}`);
      return fallback;
    }
    return value;
  };

  const port = positiveInt("PORT", 3000);
  const databasePoolSize = positiveInt("DATABASE_POOL_SIZE", 10);

  // Empty string is treated as unset. A deployment that sets `DATABASE_URL=` almost always means
  // "I have not configured this yet", and starting on the in-process engine is a better failure
  // than connecting to nothing.
  const databaseUrl = env.DATABASE_URL === "" ? undefined : env.DATABASE_URL;

  // Optional, and shape-checked only when present. Absent, the USD columns stay null and the UI
  // shows quote-denominated figures — which it already knows how to do. A malformed one is a typo
  // that would otherwise present as "USD never refreshes", indistinguishable from a dead upstream.
  const priceSourceUrl = env.PRICE_SOURCE_URL === "" ? undefined : env.PRICE_SOURCE_URL;
  if (priceSourceUrl !== undefined && !/^https?:\/\//.test(priceSourceUrl)) {
    problems.push(`PRICE_SOURCE_URL is not an http(s) url: ${priceSourceUrl}`);
  }
  // Absent means POST/DELETE /uploads answer 403 and only GET /uploads/:cid is served.
  const uploadsToken = env.UPLOADS_TOKEN === "" ? undefined : env.UPLOADS_TOKEN;

  // Optional, shape-checked when present. A malformed key would otherwise surface as a crash in
  // `privateKeyToAccount` after the database and the server are already up — or, worse, as a
  // keeper that silently never started.
  const keeperRaw = env.KEEPER_PRIVATE_KEY === "" ? undefined : env.KEEPER_PRIVATE_KEY;
  if (keeperRaw !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(keeperRaw)) {
    problems.push("KEEPER_PRIVATE_KEY is not a 32-byte hex private key");
  }
  const keeperPrivateKey = keeperRaw as `0x${string}` | undefined;

  // The payout pass is on whenever there is a keeper, unless switched off by name. A floor that
  // does not parse is a typo that would otherwise pay gas for dust or for nobody.
  const payout = (env.KEEPER_PAYOUT ?? "").toLowerCase() !== "off";
  // Trimmed: `Number(" ")` is 0, and a floor of zero pays gas for every holder's dust.
  const minRaw = (env.KEEPER_PAYOUT_MIN_USD ?? "").trim() === "" ? "5" : (env.KEEPER_PAYOUT_MIN_USD ?? "").trim();
  const payoutMinUsd = Number(minRaw);
  if (!Number.isFinite(payoutMinUsd) || payoutMinUsd < 0) {
    problems.push(`KEEPER_PAYOUT_MIN_USD is not a non-negative number: ${minRaw}`);
  }

  // The burn pass. Both values are trimmed, because `Number(" ")` is 0 and zero means NO FLOOR: a
  // stray space would otherwise remove the guard against paying gas for dust. The floor must be
  // plain decimal digits — not "1e3", not "0x10", not "-0" — so that what an operator reads is what
  // runs. The switch takes the spellings people actually type in a hurry, in both directions, and
  // refuses anything else rather than guess: a kill switch that reads as off and is not is the
  // worst thing this variable could be.
  const burnSwitch = (env.KEEPER_BURN ?? "").trim().toLowerCase();
  const burnOff = ["off", "false", "0", "no"].includes(burnSwitch);
  if (!burnOff && !["", "on", "true", "1", "yes"].includes(burnSwitch)) {
    problems.push(`KEEPER_BURN is neither on nor off: ${env.KEEPER_BURN}`);
  }
  const burn = !burnOff;
  const burnMinRaw = (env.KEEPER_BURN_MIN_USD ?? "").trim() === "" ? "100" : (env.KEEPER_BURN_MIN_USD ?? "").trim();
  const burnMinUsd = /^\d+(\.\d+)?$/.test(burnMinRaw) ? Number(burnMinRaw) : Number.NaN;
  if (!Number.isFinite(burnMinUsd)) {
    problems.push(`KEEPER_BURN_MIN_USD is not a non-negative number: ${burnMinRaw}`);
  }

  if (problems.length > 0) {
    throw new Error(`indexer configuration is incomplete:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    port,
    databaseUrl,
    databasePoolSize,
    priceSourceUrl,
    uploadsToken,
    keeperPrivateKey,
    payout,
    payoutMinUsd,
    burn,
    burnMinUsd,
    chain: readChainConfig(env),
  };
}

export function readChainConfig(env: Env): ChainConfig {
  const problems: string[] = [];

  const required = (name: string): string => {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    return value ?? "";
  };

  const address = (name: string): `0x${string}` => {
    const value = required(name);
    if (value && !ADDRESS.test(value)) {
      problems.push(`${name} is not an address: ${value}`);
      return "0x";
    }
    return value.toLowerCase() as `0x${string}`;
  };

  /**
   * Shape-checked but not required.
   *
   * An address that is absent is a deliberate configuration — the feature it enables is simply off
   * — while one that is present and malformed is a typo, and worth naming rather than silently
   * producing a filter that matches nothing.
   */
  const optionalAddress = (name: string): `0x${string}` | undefined => {
    const value = env[name];
    if (!value) return undefined;
    if (!ADDRESS.test(String(value))) {
      problems.push(`${name} is not an address: ${String(value)}`);
      return undefined;
    }
    return String(value).toLowerCase() as `0x${string}`;
  };

  const rpcUrl = required("MONAD_RPC_URL");

  // Optional. Validated only for shape, because an unreachable socket is survivable and a
  // malformed one is a typo worth naming.
  const wsUrl = env.MONAD_WS_URL === "" ? undefined : env.MONAD_WS_URL;
  if (wsUrl !== undefined && !/^wss?:\/\//.test(wsUrl)) {
    problems.push(`MONAD_WS_URL is not a ws:// or wss:// url: ${wsUrl}`);
  }

  const chainIdRaw = required("MONAD_CHAIN_ID");
  const chainId = Number(chainIdRaw);
  if (chainIdRaw && (!Number.isSafeInteger(chainId) || chainId <= 0)) {
    problems.push(`MONAD_CHAIN_ID is not a chain id: ${chainIdRaw}`);
  }

  const factory = address("FACTORY_ADDRESS");
  /**
   * Every graduator whose `Graduated` logs count, newest first.
   *
   * A LIST, because more than one is live. Markets pin their graduator at launch and never re-read
   * it, so the markets bonding when a new graduator is deployed will still graduate through the old
   * one — and a `Graduated` accepted from only the newest address would silently drop them. The
   * symptom is not an error: it is a market that graduates on chain and, to everyone reading the
   * indexer, simply never does.
   */
  const graduators = required("GRADUATION_ADDRESS")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  for (const g of graduators) {
    if (!ADDRESS.test(g)) problems.push(`GRADUATION_ADDRESS is not an address: ${g}`);
  }
  const graduation = (graduators[0] ?? "0x") as `0x${string}`;
  /**
   * The Uniswap v4 PoolManager. REQUIRED, and it is the one whose absence is silent.
   *
   * Every graduated market's swaps come from this singleton and from nowhere else, so without it
   * the ingester issues no swap query at all — and the symptom is not an error. Charts and trade
   * feeds simply stop at the moment each curve closed, which looks exactly like a market nobody is
   * trading rather than like a service that is missing a configuration value.
   *
   * `IngestConfig` types it optional on purpose, because a curve-only deployment and a test that
   * never graduates genuinely do not need one. A production deployment always does, so it is
   * demanded here rather than defaulted.
   */
  const poolManager = address("POOL_MANAGER_ADDRESS");
  // Optional: without it the indexer simply records no liquidity positions, which is the correct
  // behaviour for a deployment with no pools page rather than a silent gap in one that has it.
  const positionManager = optionalAddress("POSITION_MANAGER_ADDRESS");

  /**
   * Generation 2. Every one of these is optional, and absence is the documented rollback: with
   * none of them set the process follows exactly what it follows today. `DOKU_GRADUATION2` joins
   * the graduator list because a gen-2 market pins that graduator at launch and its `Graduated`
   * has to be accepted by the same gate as the gen-1 ones.
   */
  const factory2 = optionalAddress("DOKU_FACTORY2_ADDRESS");
  const quoteRegistry = optionalAddress("DOKU_QUOTE_REGISTRY");
  const creatorSink = optionalAddress("DOKU_CREATOR_SINK");
  const hook2 = optionalAddress("DOKU_HOOK2");
  const graduation2 = optionalAddress("DOKU_GRADUATION2");
  if (graduation2 && !graduators.includes(graduation2)) graduators.push(graduation2);

  // Parsed with `BigInt`, not `Number`, because a block height outranges float64's exact integers
  // eventually and `BigInt("")` throws where `Number("")` quietly yields zero — the one value that
  // must never be reached by accident.
  const startBlockRaw = required("START_BLOCK");
  let startBlock = 0n;
  if (startBlockRaw) {
    try {
      startBlock = BigInt(startBlockRaw);
      if (startBlock < 0n) problems.push(`START_BLOCK is negative: ${startBlockRaw}`);
    } catch {
      problems.push(`START_BLOCK is not a block number: ${startBlockRaw}`);
    }
  }

  // Defaults to Monad's public limit. Anything larger is rejected by that node outright, which
  // presents as an indexer that never advances while reporting zero lag.
  let batchSize = 100n;
  const batchRaw = env.INDEXER_BATCH_SIZE;
  if (batchRaw !== undefined && batchRaw !== "") {
    try {
      batchSize = BigInt(batchRaw);
      if (batchSize <= 0n) problems.push(`INDEXER_BATCH_SIZE must be positive: ${batchRaw}`);
    } catch {
      problems.push(`INDEXER_BATCH_SIZE is not a number: ${batchRaw}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`indexer configuration is incomplete:\n  - ${problems.join("\n  - ")}`);
  }

  return {
    rpcUrl,
    wsUrl,
    chainId,
    factory,
    graduation,
    graduators,
    poolManager,
    positionManager,
    factory2,
    quoteRegistry,
    creatorSink,
    hook2,
    graduation2,
    startBlock,
    batchSize,
  };
}
