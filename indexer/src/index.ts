import { serve } from "@hono/node-server";
import { createPublicClient, defineChain, http } from "viem";
import { createApi } from "./app/index.js";
import { readConfig } from "./config/index.js";
import { createDatabase, withTransaction } from "./db/index.js";
import { txDb } from "./db/tx-db.js";
import { healUndefinedTraders } from "./indexer/heal-traders.js";
import { ingestOnce } from "./indexer/ingestion/ingest.js";
import { startBurnJob } from "./indexer/processing/burn.js";
import { KeeperState, startFundingJob, startKeeperJob } from "./indexer/processing/keeper.js";
import { startPayoutJob } from "./indexer/processing/payout.js";
import { viemKeeperChain } from "./indexer/processing/keeper-chain.js";
import { configureMetadataPublisher } from "./metadata/publisher.js";
import { armContractVerifier } from "./verification/boot.js";
import { readMetadataStore } from "./metadata/token-metadata.js";
import { startStatsJob } from "./indexer/processing/stats.js";
import { startUsdJob } from "./indexer/processing/usd.js";
import { createHeadWatcher } from "./indexer/rpc/head-watcher.js";
import { IndexerState } from "./indexer/state.js";
import { ensureQuoteCatalog } from "./quotes/catalog.js";
import { ensureHiddenCreators } from "./repositories/hidden-creators.js";
import { createLiveFeed } from "./websocket/live.js";
import { createLogger } from "./utils/logger.js";

/**
 * How long to wait after a failed pass, and the ceiling it backs off to.
 *
 * A fixed one-second retry against an RPC that is down is a request every second forever, plus a
 * log line every second, which buries the one line that says what broke. Backing off means an
 * outage costs a handful of requests instead of thousands, and recovery is still within a minute.
 */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Full jitter on the backoff.
 *
 * Without it every replica retries at the same instant after a shared RPC outage and stampedes the
 * endpoint the moment it recovers — turning one outage into a second one.
 */
function backoffDelay(base: number): number {
  return Math.round(Math.random() * base);
}

async function main(): Promise<void> {
  /**
   * Everything the process needs, read and validated once.
   *
   * Chain configuration is validated here too, which it was not before: it used to be deferred so
   * preview mode could run without a factory address. Preview mode is gone, so every start follows
   * a chain, and a start that cannot is better refused now than discovered later by an operator
   * wondering why the log says zero events.
   */
  const config = readConfig(process.env);
  const log = createLogger();
  const state = new IndexerState();

  /**
   * One managed database for the process.
   *
   * `connect()` validates the connection before anything else starts, with retries — a deployment
   * routinely boots while its database is still accepting connections, and exiting on the first
   * refusal turns an ordinary startup race into a crash loop. It also applies the schema.
   */
  const database = createDatabase({
    url: config.databaseUrl,
    poolSize: config.databasePoolSize,
  });
  await database.connect();
  const db = database.legacy;
  /**
   * The presentational half of the quote registry, seeded before anything serves.
   *
   * The chain says which assets are registered and at what target; it says nothing about what they
   * are CALLED. Those columns live here, are filled only where they are still null, and are
   * therefore safe to re-apply on every boot — an operator's edit through `scripts/quote-admin.ts`
   * survives a restart, and an asset registered on chain before the catalogue knew about it keeps
   * the address it was registered with.
   */
  await ensureQuoteCatalog(db);

  // Wallets whose markets are not served. See `repositories/served.ts`, `notHidden`.
  const hidden = await ensureHiddenCreators(db, process.env.HIDDEN_CREATORS);
  if (hidden.length > 0) log.info("hidden creators", { count: hidden.length, addresses: hidden });

  log.info("database ready", {
    engine: config.databaseUrl ? "postgres" : "in-process",
    poolSize: config.databaseUrl ? config.databasePoolSize : undefined,
  });

  // The HTTP server is captured so the socket can share its port. One port is one thing to
  // configure, one thing to expose, and one origin for the browser — a second port is a second
  // way for a deployment to be half-configured.
  const server = serve({
    fetch: createApi(database, {
      chainId: config.chain.chainId,
      indexer: () => state.snapshot(),
      uploadsToken: config.uploadsToken,
    }).fetch,
    port: config.port,
    hostname: "0.0.0.0",
  });
  const live = createLiveFeed(server as unknown as import("node:http").Server, {
    log: log.child({ component: "live-feed" }),
  });
  log.info("listening", { port: config.port, live: `/live` });

  /**
   * The two clocks beside the ingest loop.
   *
   * Neither is on the transaction path, and that is the point. `market_stats` is a rollup of what
   * ingestion already committed, and a 24-hour window DECAYS as trades age out of it — nothing
   * fires when time merely passes, so a figure that is only rewritten on a trade is wrong for every
   * quiet market. USD prices come from outside the chain entirely; no log will ever announce them.
   *
   * Both report failures into the same state the ingest loop reports into, so `/status` shows a
   * dead price source or a failing rollup rather than serving numbers that quietly stopped moving.
   */
  const statsJob = startStatsJob(db, (e) => {
    state.recordError("database", e);
    log.warn("stats rollup failed", { error: e });
  });
  const usdJob = startUsdJob(db, config.priceSourceUrl, (e) => {
    state.recordError("rpc", e);
    log.warn("usd refresh failed", { error: e });
  });

  /**
   * Shutdown, on the signal the platform actually sends.
   *
   * Without this the process is killed mid-pass. Re-ingesting a range is a no-op, so nothing is
   * corrupted — but the socket stays open until the platform's grace period expires, which turns
   * every deploy into a visible stall for anyone connected.
   */
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    state.stopping();
    log.info("shutting down", { signal });
    headWatcher?.stop();
    statsJob.stop();
    usdJob.stop();
    keeperJob?.stop();
    fundingJob?.stop();
    payoutJob?.stop();
    burnJob?.stop();
    server.close(() => {
      // The pool is drained after the server stops accepting, so in-flight requests finish against
      // a live connection rather than one closed underneath them.
      void database.disconnect().finally(() => process.exit(0));
    });
    // A hard floor, so a socket that will not close cannot hold the deploy open indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  /*
   * A promise nobody awaited must not take the process down. Every job's tick is caught, but a
   * socket callback or a fire-and-forget elsewhere is not, and on Node 22 one stray rejection is
   * a restart: the ingest cursor survives it, the API and the live feed do not. Logged and
   * counted as an RPC-class error (that is what they are in practice), and the process carries
   * on. A thrown exception is a different animal — state may be torn — so that one still exits,
   * after saying why.
   */
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection; continuing", { error: reason });
    state.recordError("rpc", reason);
  });
  process.on("uncaughtException", (error) => {
    log.error("uncaught exception; exiting", { error });
    setTimeout(() => process.exit(1), 100).unref();
  });

  const cfg = config.chain;
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 10143 ? "Monad Testnet" : "Monad",
    nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    // Multicall3 at its canonical address, deployed on Monad mainnet and testnet alike (7.6 KB of
    // code at it on mainnet). Without it viem's `multicall` has nowhere to send a batch.
    contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  });
  log.info("following chain", {
    chainId: cfg.chainId,
    startBlock: cfg.startBlock,
    factory: cfg.factory,
    // Named individually rather than as a boolean, because "gen 2 is on" is not the question an
    // operator has when the pairs board is empty — "which factory is it following" is.
    factory2: cfg.factory2 ?? "gen-2 off",
    graduation2: cfg.graduation2 ?? "gen-2 off",
    hook2: cfg.hook2 ?? "gen-2 off",
    creatorSink: cfg.creatorSink ?? "gen-2 off",
    quoteRegistry: cfg.quoteRegistry ?? "gen-2 off",
    priceSource: config.priceSourceUrl ?? "disabled",
    batchSize: cfg.batchSize,
    websocket: cfg.wsUrl ?? "disabled",
  });

  /*
   * Token metadata documents: `DokuToken.metadataURI()` resolves to `<cdn>/metadata/<token>.json`,
   * and this process is what writes that document — on every MetadataSet it ingests. Off without
   * the bucket variables, in which case launches still index and only the document is missing.
   */
  const metadataStore = readMetadataStore(process.env);
  configureMetadataPublisher(metadataStore, process.env.METADATA_SITE_URL || undefined);
  log.info(metadataStore ? "token metadata publisher armed" : "token metadata publisher off (no R2_* variables)", {
    bucket: metadataStore?.bucket ?? null,
    cdn: metadataStore?.publicBaseUrl ?? null,
  });

  // `cacheTime: 0` because the ingest loop runs faster than viem's default block-number cache
  // expires, and a stale head means a pass that finds nothing to do.
  const client = createPublicClient({ chain, transport: http(cfg.rpcUrl), cacheTime: 0 });

  /*
   * Explorer verification of the two clones every launch deploys (docs/doku/11-contract-verification.md).
   * The implementations are read off the factory once here; without a MonadScan key the queue
   * is off and launches are unaffected either way.
   */
  if (cfg.factory2) {
    await armContractVerifier({ db, client, factory: cfg.factory2, chainId: cfg.chainId, env: process.env });
  }

  /**
   * The graduation keeper, if this deployment has a key for it.
   *
   * It needs the generation-2 graduator: that is the contract whose `graduate()` it sends, and a
   * deployment without one has no swallowed auto-graduation to repair. Started after the client
   * and before the ingest loop, so a market stranded across a restart is picked up on the first
   * tick rather than after the loop's own first pass.
   */
  let keeperJob: ReturnType<typeof startKeeperJob> | undefined;
  let fundingJob: ReturnType<typeof startFundingJob> | undefined;
  let payoutJob: ReturnType<typeof startPayoutJob> | undefined;
  let burnJob: ReturnType<typeof startBurnJob> | undefined;
  if (config.keeperPrivateKey && cfg.graduation2) {
    const keeperChain = viemKeeperChain({
      chain,
      rpcUrl: cfg.rpcUrl,
      privateKey: config.keeperPrivateKey,
      graduation: cfg.graduation2,
      hook: cfg.hook2,
    });
    const keeperState = new KeeperState(keeperChain.address);
    state.attachKeeper(() => keeperState.snapshot());
    const balance = await keeperChain.balance().catch(() => null);
    log.info("graduation keeper armed", {
      keeper: keeperChain.address,
      graduation: cfg.graduation2,
      balanceWei: balance?.toString() ?? "unreadable",
    });
    keeperJob = startKeeperJob(db, keeperChain, keeperState, (e) => {
      state.recordError("rpc", e);
      log.warn("keeper pass failed", { error: e });
    });

    /*
     * The second job, on the same key and the same state.
     *
     * It needs the hook as well as the graduator, because `fund()` pulls the hook's ledger and
     * the pass has to read that ledger before it decides to send anything. A deployment with a
     * graduator and no `DOKU_HOOK2` keeps its graduations and funds nothing, which is the same
     * per-variable rollback the rest of generation 2 has.
     */
    if (cfg.hook2) {
      fundingJob = startFundingJob(db, keeperChain, keeperState, (e) => {
        state.recordError("rpc", e);
        log.warn("funding pass failed", { error: e });
      });
      log.info("reward-vault funding armed", { keeper: keeperChain.address, hook: cfg.hook2 });
      /*
       * The third job: claiming holders' dividends for them. Same key, same state, and the one
       * function it signs pays the named holder whoever sends it. Off by `KEEPER_PAYOUT=off`.
       */
      if (config.payout) {
        payoutJob = startPayoutJob(db, keeperChain, keeperState, { minUsd: config.payoutMinUsd }, (e) => {
          state.recordError("rpc", e);
          log.warn("payout pass failed", { error: e });
        });
        log.info("dividend payout armed", { keeper: keeperChain.address, minUsd: config.payoutMinUsd });
      } else {
        log.info("dividend payout off (KEEPER_PAYOUT=off); holders claim by hand");
      }
      /*
       * The fourth job: finishing the buyback on graduated BURN markets. The hook takes their levy
       * in the token and holds it until somebody sends `sweep` and then `BurnSink.burn()`; nobody
       * did. Same key, same state; the keeper chooses only when. Off by `KEEPER_BURN=off`.
       */
      if (config.burn) {
        burnJob = startBurnJob(db, keeperChain, keeperState, { minUsd: config.burnMinUsd }, (e) => {
          state.recordError("rpc", e);
          log.warn("burn pass failed", { error: e });
        });
        log.info("buyback burn armed", { keeper: keeperChain.address, hook: cfg.hook2, minUsd: config.burnMinUsd });
      } else {
        log.info("buyback burn off (KEEPER_BURN=off); accrued levy waits in the hook");
      }
    } else {
      log.warn("DOKU_HOOK2 is not set; reward vaults will not be funded and buyback markets not burned by this keeper");
    }
  } else if (config.keeperPrivateKey) {
    log.warn("KEEPER_PRIVATE_KEY is set but DOKU_GRADUATION2 is not; keeper not started");
  } else {
    log.info("graduation keeper off (no KEEPER_PRIVATE_KEY); stranded markets wait for the button");
  }

  /**
   * The chain's WebSocket, if one is configured.
   *
   * It does exactly one thing: cut the sleep short when the node announces a block. It never
   * decodes a log, never moves the checkpoint, and never reports what the head is — the pass asks
   * HTTP for that. So a socket that fails to connect, stops delivering, or dies silently costs
   * latency and nothing else, and the loop below indexes every block either way.
   */
  // One-off repair of rows written before the trader was read from the transaction. Failing this
  // must not stop the indexer starting: it is a correction to history, not a precondition for
  // indexing the present.
  try {
    await healUndefinedTraders(client, db, log);
  } catch (error) {
    log.warn("trader repair pass failed; continuing", { error });
  }

  let wake: (() => void) | undefined;
  const headWatcher = cfg.wsUrl
    ? createHeadWatcher({
        url: cfg.wsUrl,
        log: log.child({ component: "head-watcher" }),
        onHead: () => wake?.(),
      })
    : undefined;
  headWatcher?.start();

  // Sequential rather than on a timer: overlapping runs would race on the status row and could
  // advance it past a range that had not finished ingesting.
  let backoff = RETRY_MIN_MS;
  while (!stopping) {
    try {
      const { from, to, logs, head } = await ingestOnce(client, db, {
        ...cfg,
        maxRange: cfg.batchSize,
        live,
        // Every write in a pass, and the checkpoint that says the pass happened, commit together.
        transaction: (work) => withTransaction(database.prisma, (tx) => work(txDb(tx))),
      });
      state.passSucceeded(to, head);
      if (logs > 0) log.info("indexed", { from, to, logs, phase: state.snapshot().phase });
      backoff = RETRY_MIN_MS;
    } catch (err) {
      state.passFailed(err);
      const snapshot = state.snapshot();
      // Warn while it is still plausibly transient; error once it clearly is not. A log that
      // reports the fifth consecutive failure at the same level as the first gives an operator
      // nothing to alert on.
      const fields = {
        error: err,
        consecutiveFailures: snapshot.consecutiveFailures,
        retryInMs: backoff,
      };
      if (snapshot.consecutiveFailures >= 3) log.error("ingest pass failed", fields);
      else log.warn("ingest pass failed", fields);
      backoff = Math.min(backoff * 2, RETRY_MAX_MS);
    }
    /**
     * Sleep until the backoff expires, or until the socket says a block landed.
     *
     * The wake-up is a hint, not a trigger: whichever fires first, the next pass re-reads the head
     * over HTTP and does the same work it would have done anyway. Without a socket this is exactly
     * the old timed sleep.
     */
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        wake = undefined;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, backoffDelay(backoff));
      wake = finish;
    });
  }

  headWatcher?.stop();
}

main().catch((err: unknown) => {
  // The one place a bare write is right: this is a failure to *start*, so there may be no
  // configured logger to route it through, and the message has to reach the platform's log
  // whatever else is broken.
  createLogger().error("failed to start", { error: err });
  process.exit(1);
});
