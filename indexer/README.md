# DOKU indexer

Follows the DOKU contracts on Monad, keeps Postgres in step with them, and serves the read API and
live feed the frontend uses.

```
Monad RPC ──HTTP──> ingest loop ──> Postgres ──> repositories ──> services ──> controllers ──> HTTP
          └─WS────> head watcher                                                     └──> client WebSocket
```

## Layout

```
src/
├── app/            Hono wiring: repositories → services → controllers, mounted at / and /api/v1
├── config/         every environment variable, read and validated once at boot
├── controllers/    read the request, call a service, choose a status code. Nothing else
├── services/       page-size clamping, address normalisation, cursors, period validation
├── repositories/   the SQL. Each takes a Queryable, so any of them can run in a transaction
├── db/             the managed Prisma client, pooling, retries, transactions, numeric conversion
├── indexer/
│   ├── ingestion/  one pass: fetch logs, decode, dispatch, write
│   │   └── gen2/   one file per generation-2 contract: launch, trades, collections,
│   │               graduation, hook, creator-sink, sinks, registry
│   ├── processing/ candlesticks, holder balances, pricing, pool keys
│   │   ├── fees.ts   the fee ledger and the projections rebuilt from it
│   │   ├── stats.ts  the 15 s market_stats rollup
│   │   └── usd.ts    the 60 s quote-asset USD refresh
│   ├── sync/       reorg rollback and derived-state rebuild
│   ├── rpc/        the chain WebSocket (an accelerator, never a source of truth)
│   ├── jobs.ts     a fixed-interval job that never overlaps itself and never dies
│   ├── blocks.ts   the block ledger reorg detection walks
│   ├── generations.ts  what differs between generation 1 and 2, including the price scale
│   └── state.ts    what the loop is doing, and what has gone wrong
├── quotes/         the presentational quote-asset catalogue, seeded on every boot
├── websocket/      the client-facing live feed
├── types/          the shapes that go on the wire
└── utils/          structured logging
```

## Two generations, one process

The live emoji launchpad (generation 1) and DOKU Pairs (generation 2,
`docs/superpowers/specs/2026-09-06-doku-pairs-design.md`) are followed together. Which generation a
log belongs to is decided by the address that emitted it — the factory for launches, the market's
`generation` column for trades, the graduator for graduations, `DOKU_HOOK2` for levies — never by
the event's name, because most names exist in both. Set the five `DOKU_*` addresses to follow
generation 2; unset them and the process is exactly the gen-1 indexer.

Fee accounting is event-first: `fee_events` and `creator_ledger` hold one row per component per log,
and `market_rewards` / `creator_balances` are recomputed projections. `market_stats` is rebuilt
every 15 s; quote-asset USD prices every 60 s from `PRICE_SOURCE_URL` (stablecoins pinned to 1).

**The graduation keeper** (`indexer/processing/keeper.ts`, on when `KEEPER_PRIVATE_KEY` is set)
runs every 10 s and calls `graduate()` on any served market that is `ready_to_graduate` with no
`pool_address` — the state a filling buy leaves behind when it was sent with too little gas for the
graduation it also had to pay for. It reads `graduated()` and `readyToGraduate()` on chain before
every attempt (the database lags the chain by the confirmation window), simulates before sending,
refuses to sign anything that would take its balance under Monad's 10 MON reserve, backs off per
market on failure and gives up after six. `/status` → `indexer.keeper` carries the counters; `null`
there means the keeper is off.

**The burn pass** (`indexer/processing/burn.ts`, on with the keeper and `DOKU_HOOK2` unless
`KEEPER_BURN=off`) runs every 30 min and finishes the buyback on graduated BURN markets: the hook
takes their levy in the token and holds it until somebody sends `DokuHook.sweep(id)` and
`BurnSink.burn()`. It burns a market at most once a day — the clock is the newest ingested `Burned`,
so a redeploy is not a burn — and only when what it would destroy is worth `KEEPER_BURN_MIN_USD`
(default 100). It burns only at the sink `DokuHook.markets(id)` names, refuses any single
transaction that would cost more than 0.25 MON, records an attempt before sending it (a billed
failure is still the day's attempt), does nothing while the database is behind the chain, does not
run at boot, and stands down under a 30 MON keeper balance. Every keeper write, in all four jobs,
is signed at the fee its reserve guard was priced at. Same reserve guard, simulation, backoff and `/status` block as the other jobs
(`burns`, `lastBurnTx`).

**A stored price carries its generation's scale.** Generation 1's curve returns
`quote * 1e18 / base`; generation 2's returns `quote * 1e36 / base`, a further 1e18, so that a
six-decimal quote against a 1e27 base reserve does not truncate. `priceScaleSql` in
`indexer/generations.ts` is the one expression that divides it back out, and it belongs anywhere a
price meets a supply. A flat `/1e18` made every generation-2 market cap a quintillion times too
large without anything crashing.

The scale is also an **input** to the one price the service derives rather than reads.
`poolSpotPrice` turns a `sqrtPriceX96` — a ratio of raw amounts, carrying no generation with it —
into a stored price, and it takes the scale as an argument because it *divides*: a factor applied
to what it returns is applied to a number that has already truncated. On an 18-decimal quote that
is a rounding difference. On gold, where a whole token is worth ~0.02 raw units of the quote, the
generation-1 intermediate is below one and truncates to zero, so every gold market's price, candles
and market cap fell to nothing the moment it graduated. `gen2-fork.test.ts` is where that was
measured; nothing offline reaches it.

## Two rules worth knowing before changing anything

**Every `NUMERIC` and `BIGINT` that leaves the database is cast in SQL.** Prisma returns an un-cast
`NUMERIC` as a `Decimal`, which serialises to JSON in exponential form above 1e21 — and every token
amount on this chain is 18-decimal fixed point, so essentially all of them are past that. It returns
an un-cast `BIGINT` as a `bigint`, which `JSON.stringify` refuses outright. Both failures are
invisible on small test fixtures. `repositories/columns.ts` holds the rule; `db/numeric.ts` is the
only place a `Decimal` becomes a `bigint`, and it uses `toFixed(0)` rather than `toString()` for
the same reason.

**An ingest pass is one transaction, and nothing is announced until it commits.** Events, derived
aggregates and the checkpoint move together or not at all. RPC calls happen before the transaction
opens, so a slow node cannot hold a connection open across the network.

## Running it

```sh
npm install          # also runs prisma generate
npm run dev          # tsx watch, in-process Postgres if DATABASE_URL is unset
npm test             # 465 tests, no external database needed; 7 more with MONAD_RPC_URL
npm run typecheck
npm run lint
npm run build
```

Tests run against PGlite — real Postgres compiled to wasm, through the same Prisma client the
deployment uses. That is why they exercise the actual `NUMERIC(78,0)` arithmetic and `ON CONFLICT`
behaviour rather than a mock's idea of them.

### The chain the tests run against, and the one they do not

Most chain-backed suites (`ingest`, `shape`, `pool-swaps`, `reorg`, `gen2-lifecycle`) spawn a bare
anvil and build the whole world from `../contracts` — Uniswap v4 included — through
`LocalScenario.s.sol`. That is a real chain running the real contracts, and it is **not a fork**:
everything it knows about Monad is what this repository told it, and its only non-native quote is a
six-decimal `MockUSDC` this repository mints.

`gen2-fork.test.ts` is the fork. Set `MONAD_RPC_URL` and it starts anvil with `--fork-url` against
Monad mainnet (chain 143), deploys through the shipped `DeployDoku.s.sol` onto the v4 singletons
already there, and drives a market in **real XAUt0** — gold, six decimals, one whole token a troy
ounce — from launch through a taxed buy, a sell, the fill, graduation and a pool swap.

```sh
MONAD_RPC_URL=https://rpc.monad.xyz npx vitest run test/gen2-fork.test.ts   # ~35s
```

Unset, the suite skips and the offline run is unaffected. It is the same variable the service reads
(`example.env`), so if yours points at a local node the harness stops with the chain id it found
rather than running: a fork of the wrong chain deploys, trades, graduates and reports green while
proving nothing. It forks `latest` and must keep doing so:
the public RPC keeps roughly 33–66 hours of state, so a pinned block rots within days. Neither real
token's balance can be found by `deal()` or any other heuristic — USDC packs a blacklist flag into
the top bit of the balance word, gold keeps its mapping at slot 51 of a proxy — so the harness
writes the slot and reads it back, and refuses to run if the read disagrees.

Gold is the point of it. A raw unit is worth ~3,300x a raw unit of USDC, which makes it the coarsest
quote on the chain and the only one on which a scale or decimals assumption is loud enough to see.
It found one: a graduated gold market's price was being stored as **zero** (see below).

## Configuration

See `example.env`. Everything is validated at boot; a missing or malformed value stops the process
with a message naming all of them at once.

`MONAD_WS_URL` is optional. It shortens the gap between a block being produced and the indexer
looking for it, and does nothing else — unset it, or let it fail, and the HTTP poll still indexes
every block.

### `PRICE_SOURCE_URL` must cover every registered quote

This is not a cosmetic setting. The board orders markets by USD market cap, and a quote asset with
no USD price has no dollar figure to order by — so those markets fall back to whole units of their
own quote. That removes the twelve-orders-of-magnitude decimals error, and nothing else: it still
compares one ounce of gold against one dollar as though they were the same size. Measured on the
seeded board, a gold market holding roughly $10M ranked **third**, behind a $2M one; a half-bitcoin
market ranked below a $2.50 one.

`/status` reports `unpriced_quotes` for exactly this reason. **A non-zero value there means the
board is currently mis-ordered — not merely missing a column.** The source has to carry a price for
every quote a market can be launched in:

| Quote | Why its absence hurts |
|---|---|
| `MON` (native, `address(0)`) | the default quote; most markets |
| `USDC` | pinned to 1 by the job, but must still be registered |
| `USDT0` | pinned to 1 by the job |
| `WETH` | ~1,000× MON's unit price |
| `WBTC` / `cbBTC` | ~110,000× a dollar per whole unit |
| `XAUt0` (gold) | ~2,600× a dollar, at six decimals |
| the tokenised equities (`NVDAX`, `AAPLX`, `TSLAX`, `GOOGLX`, `SPYX`, `TBILLX`) | each a different unit price |

Stablecoins are pinned to 1 by the job whether or not the document mentions them; everything else
comes from the document, and what the document omits is what `unpriced_quotes` counts.

### The two jobs beside the ingest loop

`startStatsJob` (15 s) and `startUsdJob` (60 s) run on a clock rather than on an event, and both
have to. A 24-hour volume figure DECAYS as trades age out of the window, and nothing fires when
time merely passes — so a figure only rewritten on a trade is wrong for every market that has gone
quiet. USD prices come from outside the chain entirely; no log will ever announce one. Both report
failures into the same `/status` counters the ingest loop uses, so a dead price source is visible
rather than being a number that quietly stopped moving.

## Endpoints

`/status` is a dashboard and always answers 200. `/health` answers 503 when the ingest loop has
gone quiet, which is this service's actual failure mode: the API keeps serving while the data ages.
`/ready` answers 503 until the database responds, so a platform can stop routing to a process
without restarting one that is merely a little behind.

| Route | Answers |
|---|---|
| `GET /markets` | the board. `sort` (`marketCap`, `volume`, `change`, `new`, `graduating`), `pair`, `routing`, `status`, `q`, `page`/`limit`, or the legacy `cursor` path. Carries `pairCounts` and `total` |
| `GET /markets/:address` | one market, both generations, with its quote asset, routing and metadata |
| `GET /markets/:address/rewards` | the fee ledger's projection: generated, collected and pending per component, plus dividends and burned supply |
| `GET /markets/:address/holders` | holders with each one's share of circulating supply, and a label on the contracts |
| `GET /accounts/:address/launches` | what one address launched, from the index rather than a walk over every market |
| `GET /creators/:address` | claimable and lifetime per quote asset, and the markets that name the address as a recipient |
| `GET /quotes` | the quote-asset registry: presentational columns from the catalogue, on-chain state from the registry, `status` derived from `registered`/`enabled` |
| `GET /leaderboard?window=` | top movers and top volume over `24h`, `7d` or `all` |
| `GET /search?q=` | markets by ticker, name or address |
| `GET /uploads/:cid` | the upload reference ledger: sizes, whether a launch references it, and whether it is an orphan. Public |
| `GET /uploads?orphaned=true&limit=` | the orphan set, oldest first. Requires `Authorization: Bearer $UPLOADS_TOKEN` |
| `POST /uploads` | register a pinned cid; idempotent. Bearer |
| `DELETE /uploads/:cid` | delete an unreferenced row; 409 on a referenced one. Bearer |

Without `UPLOADS_TOKEN` set, every bearer-guarded route above answers 403 rather than defaulting
open.

The WebSocket at `/live` is an invalidation channel: a frame says which market changed, never what
it changed to. Frames are `swap`, `market`, `graduation`, `metadata` (the market's on-chain identity
moved) and `fees` (a ledger row landed for a market and a `recipient`, so a portfolio page can
compare the recipient to its own wallet). Subscriptions filter on `market`.

All routes are served both unprefixed and under `/api/v1`, from the same handlers.
