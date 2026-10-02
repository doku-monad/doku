import { Hono } from "hono";

import {
  accountRoutes,
  creatorRoutes,
  healthRoutes,
  marketRoutes,
  quoteRoutes,
  searchRoutes,
  uploadRoutes,
} from "../controllers/index.js";
import type { Database } from "../db/index.js";
import type { IndexerSnapshot } from "../indexer/state.js";
import {
  CandlestickRepository,
  CreatorRepository,
  HolderRepository,
  PositionRepository,
  MarketRepository,
  QuoteRepository,
  StatusRepository,
  SwapRepository,
  UploadRepository,
} from "../repositories/index.js";
import {
  CandlestickService,
  CreatorService,
  HolderService,
  PositionService,
  MarketService,
  QuoteService,
  StatusService,
  SwapService,
  UploadService,
} from "../services/index.js";

/**
 * The HTTP application.
 *
 * Wiring only: repositories over the managed client, services over repositories, controllers over
 * services. Everything is constructed once here and closed over, which is what keeps a
 * `PrismaClient` from being created per request.
 *
 *     controller → service → repository → Prisma → Postgres
 *
 * Routes are mounted twice on purpose. The unprefixed paths are what the frontend already calls
 * and must keep working; `/api/v1` is the versioned surface new callers should use. Same handlers,
 * so the two cannot answer differently.
 */
export interface ApiContext {
  chainId?: number;
  /** A snapshot of what the ingest loop is doing. Absent in tests that do not run one. */
  indexer?: () => IndexerSnapshot;
  /**
   * The bearer token the frontend's upload route presents to write the reference ledger.
   *
   * Absent means every write answers 403. That is the safe default rather than an inconvenience: a
   * deployment that has not configured a token cannot have anyone unpin a launch's imagery.
   */
  uploadsToken?: string;
}

export function createApi(database: Database, context: ApiContext = {}): Hono {
  const prisma = database.prisma;

  const repositories = {
    markets: new MarketRepository(prisma),
    swaps: new SwapRepository(prisma),
    holders: new HolderRepository(prisma),
    positions: new PositionRepository(prisma),
    candlesticks: new CandlestickRepository(prisma),
    creators: new CreatorRepository(prisma),
    quotes: new QuoteRepository(prisma),
    uploads: new UploadRepository(prisma),
    status: new StatusRepository(prisma),
  };

  const services = {
    markets: new MarketService(repositories.markets),
    swaps: new SwapService(repositories.swaps),
    holders: new HolderService(repositories.holders),
    positions: new PositionService(repositories.positions),
    candlesticks: new CandlestickService(repositories.candlesticks),
    creators: new CreatorService(repositories.creators),
    quotes: new QuoteService(repositories.quotes),
    uploads: new UploadService(repositories.uploads),
    status: new StatusService(repositories.status, context),
  };

  const app = new Hono();

  const mount = (base: string): void => {
    app.route(`${base}/markets`, marketRoutes(services));
    app.route(`${base}/accounts`, accountRoutes(services));
    app.route(`${base}/creators`, creatorRoutes(services));
    app.route(`${base}/quotes`, quoteRoutes(services));
    app.route(`${base}/uploads`, uploadRoutes(services.uploads, context.uploadsToken));
    // Whole-site reads, mounted at the root beside the probes rather than under `/markets`:
    // neither is about one market, and nesting them would collide with `/markets/:address`.
    app.route(base === "" ? "/" : base, searchRoutes(services));
    app.route(base === "" ? "/" : base, healthRoutes(services.status, database));
  };

  mount("");
  mount("/api/v1");

  return app;
}
