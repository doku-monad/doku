-- DOKU indexer schema.
--
-- Every event-derived table carries the block that produced it and a UNIQUE (tx_hash, log_index).
-- That pair is the idempotency guarantee: re-ingesting a range is a no-op, which is what makes
-- reorg recovery "delete above the fork and replay" rather than a bespoke unwind for each table.
--
-- Deliberately not the Aptos schema the mock served. Columns like `transaction_version` holding a
-- block number would be a lie every future reader has to decode.

CREATE TABLE IF NOT EXISTS markets (
    market_address   TEXT PRIMARY KEY,
    token_address    TEXT NOT NULL,
    symbol           TEXT NOT NULL,
    name             TEXT NOT NULL,
    symbol_key       TEXT NOT NULL UNIQUE,
    creator          TEXT NOT NULL,
    quote_target     NUMERIC(78, 0) NOT NULL,
    -- Accumulated from mint transfers rather than assumed or fetched. The token mints its whole
    -- supply to the curve at launch, so the indexer already watches the authoritative number go
    -- by; a constant here would be a second copy of a contract value, wrong the day it changes.
    total_supply     NUMERIC(78, 0) NOT NULL DEFAULT 0,
    -- --------------------------------------------------------------- generation 2 (pairs)
    -- Which contracts this market runs on. 1 = the live emoji launchpad, 2 = the pairs launchpad.
    generation       SMALLINT NOT NULL DEFAULT 1,
    -- The asset the market is priced in. address(0) is native MON, which is every gen-1 market.
    quote_asset      TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
    quote_decimals   SMALLINT NOT NULL DEFAULT 18,
    -- Sinks.sol kind: 0 BURN (UI "buyback"), 1 REWARDS ("holders"), 2 CREATOR ("creator").
    -- NULL on a gen-1 market until scripts/backfill-gen1.ts reads it from the launch log.
    routing          SMALLINT,
    routed_recipient TEXT,
    creator_tax_bps  SMALLINT NOT NULL DEFAULT 0,
    tax_recipient    TEXT,
    -- On-chain metadata from MetadataSet. `name` above is reused; gen 1 keeps name = symbol.
    ticker           TEXT,
    logo_uri         TEXT,
    banner_uri       TEXT,
    description      TEXT,
    website          TEXT,
    x                TEXT,
    telegram         TEXT,
    -- keccak256(abi.encode(meta)) as the factory stores it; lets a reader verify a MetadataSet.
    metadata_hash    TEXT,
    block_number     BIGINT NOT NULL,
    block_hash       TEXT NOT NULL,
    log_index        INTEGER NOT NULL,
    tx_hash          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

-- Current state per market. Rebuilt from the latest swap rather than accumulated, so it can be
-- recomputed after a reorg without replaying history.
CREATE TABLE IF NOT EXISTS market_state (
    market_address     TEXT PRIMARY KEY REFERENCES markets(market_address) ON DELETE CASCADE,
    quote_raised       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    -- `tax_escrow` was here and is deliberately gone. It asserted a design that no longer exists:
    -- the anti-sniper tax used to be HELD aside for the launch liquidity, and it is now spent as it
    -- accrues, buying the token back to burn. Nothing ever wrote the column, so a name that
    -- described a stale mechanism was the only thing it carried. This file is CREATE TABLE IF NOT
    -- EXISTS, so existing databases keep their column and nothing has to migrate.
    -- Scale 0, not 18. The value is *already* 18-decimal fixed point, so a scale of 18 would let
    -- Postgres append eighteen more decimal places to a number that is an integer by construction
    -- -- and it comes back as "…754.000000000000000000", which BigInt() refuses outright.
    last_price         NUMERIC(78, 0) NOT NULL DEFAULT 0,
    volume_quote       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    trade_count        BIGINT NOT NULL DEFAULT 0,
    holders            INTEGER NOT NULL DEFAULT 0,
    ready_to_graduate  BOOLEAN NOT NULL DEFAULT FALSE,
    -- The PoolManager once the market has graduated, and the same value on every graduated row —
    -- v4 has no pool contract. Kept because a non-null value is still the cheapest "has it
    -- graduated" test a list query can make.
    pool_address       TEXT,
    -- What actually identifies the market's pool, denormalised from `graduations` because it is
    -- what a client needs to route a swap and a list view should not have to join for it.
    pool_id            TEXT,
    -- The block that emitted ReadyToGraduate. Stored so a reorg can tell whether the flag itself
    -- was orphaned; a bare boolean cannot be un-set correctly, because nothing records when it
    -- became true.
    ready_block        BIGINT,
    block_number       BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS swaps (
    id             BIGSERIAL PRIMARY KEY,
    market_address TEXT NOT NULL REFERENCES markets(market_address) ON DELETE CASCADE,
    trader         TEXT NOT NULL,
    is_buy         BOOLEAN NOT NULL,
    -- Which venue filled it. A graduated market keeps trading, on the pool, and a feed that mixed
    -- the two without saying so would make the fee and tax columns meaningless on half its rows.
    venue          TEXT NOT NULL DEFAULT 'curve',
    quote_amount   NUMERIC(78, 0) NOT NULL,
    base_amount    NUMERIC(78, 0) NOT NULL,
    fee            NUMERIC(78, 0) NOT NULL,
    tax            NUMERIC(78, 0) NOT NULL DEFAULT 0,
    -- Gen 2: the creator's own tax on this trade, in quote raw units. `tax` stays the anti-sniper.
    creator_tax    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    quote_raised   NUMERIC(78, 0) NOT NULL,
    price          NUMERIC(78, 0) NOT NULL,  -- 18-decimal fixed point; see market_state.last_price
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS swaps_market_ts ON swaps (market_address, ts DESC);
CREATE INDEX IF NOT EXISTS swaps_block ON swaps (block_number);

CREATE TABLE IF NOT EXISTS graduations (
    market_address TEXT PRIMARY KEY REFERENCES markets(market_address) ON DELETE CASCADE,
    -- Under v4 this is the PoolManager, and it is therefore the SAME value on every row. Kept
    -- because that is exactly what the holder exclusion needs — the singleton really does hold
    -- every market's tokens — and useless for routing, which is what `pool_id` below is for.
    pool_address   TEXT NOT NULL,
    -- Uniswap v4 has no pool CONTRACT. A pool is state inside one PoolManager singleton, addressed
    -- by `PoolId = keccak256(PoolKey)`, and that id is what the `Swap` event carries as `topics[1]`.
    --
    -- This column is therefore doing the job `pool_address` used to. Under V3 a swap log's ADDRESS
    -- told us which market it belonged to, and a log from an unknown address was simply another
    -- protocol's pool. Under v4 every swap on every v4 pool on the chain — memecoins, stablecoin
    -- pairs, someone's test pool — arrives from the same address, so the address is no longer
    -- evidence of anything and this id is the only thing that scopes a log to a market.
    pool_id        TEXT NOT NULL DEFAULT '',
    -- The full PoolKey, stored rather than reconstructed. A key rebuilt from a fee-tier constant is
    -- one refactor away from hashing to a PoolId no pool is at, and the failure is silent: the
    -- filter matches nothing and the market simply looks untraded.
    currency0      TEXT NOT NULL DEFAULT '',
    currency1      TEXT NOT NULL DEFAULT '',
    fee            INTEGER NOT NULL DEFAULT 0,
    tick_spacing   INTEGER NOT NULL DEFAULT 0,
    hooks          TEXT NOT NULL DEFAULT '',
    -- Which sink the market's share of the levy goes to. 0 = BURN, 1 = REWARDS. A client cannot
    -- tell the two apart from anything else, and they behave differently forever.
    sink           TEXT NOT NULL DEFAULT '',
    sink_kind      SMALLINT NOT NULL DEFAULT 0,
    -- Gen 2: the pool's quote currency, so a swap's legs can be named without re-reading the market.
    quote_asset    TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000',
    token_id       NUMERIC(78, 0) NOT NULL,
    quote_amount   NUMERIC(78, 0) NOT NULL,
    base_amount    NUMERIC(78, 0) NOT NULL,
    liquidity      NUMERIC(78, 0) NOT NULL,
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);

-- Written on ingest rather than computed on read: a chart query should not aggregate the whole
-- trade history every time someone opens a market page.
-- Liquidity positions in graduated pools.
--
-- This table exists because there is NO on-chain way to ask which positions an address owns.
-- Uniswap v4's PositionManager is ERC-721 but not ERC-721Enumerable, so the only chain-side route
-- is to walk every token id and check its owner — and on Monad that manager is the CANONICAL one,
-- shared by every v4 protocol, with over six hundred thousand positions minted in it. Walking it
-- is not slow, it is impossible.
--
-- `ModifyPosition(PoolId indexed id, address indexed sender, ...)` is the way in. It is emitted by
-- the PositionManager for every liquidity change, both of its useful fields are INDEXED, and its
-- `salt` is the token id — the manager passes `bytes32(tokenId)` as the position's salt so each
-- position gets its own storage in the pool manager. Filtering that event by our pool ids turns
-- "search six hundred thousand NFTs" into "read the handful of logs that touched our pools".
CREATE TABLE IF NOT EXISTS positions (
    token_id       NUMERIC(78, 0) PRIMARY KEY,
    pool_id        TEXT NOT NULL,
    market_address TEXT NOT NULL REFERENCES markets(market_address) ON DELETE CASCADE,
    -- The `sender` of the event: the account that unlocked the manager, which the periphery
    -- documents as the end user rather than the position manager. It is a DISCOVERY hint, not the
    -- authority — a position minted to a different owner, or transferred as an NFT afterwards,
    -- leaves this stale. Callers confirm with `ownerOf`, which is cheap over a handful of ids and
    -- impossible over all of them.
    owner          TEXT NOT NULL,
    tick_lower     INTEGER NOT NULL,
    tick_upper     INTEGER NOT NULL,
    -- Accumulated from `liquidityDelta`, which is signed: a withdrawal is a negative delta and a
    -- fully closed position settles at exactly zero rather than disappearing.
    liquidity      NUMERIC(78, 0) NOT NULL DEFAULT 0,
    block_number   BIGINT NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS positions_owner ON positions (owner);
CREATE INDEX IF NOT EXISTS positions_market ON positions (market_address);

-- ------------------------------------------------------------------------------------------
-- Generation 2 (pairs). Every table below is additive; gen-1 markets never write to them.
-- ------------------------------------------------------------------------------------------

-- The quote-asset registry, plus what the UI shows about each asset.
--
-- `id` rather than `address` as the key because the catalogue lists assets that are NOT on chain
-- yet ("soon" rows have no address). Registry events find rows by `address`; the catalogue seeds
-- rows by `id`. Status is derived: registered+enabled = live, registered+disabled = listed,
-- unregistered = soon.
CREATE TABLE IF NOT EXISTS quote_assets (
    id            TEXT PRIMARY KEY,
    address       TEXT UNIQUE,
    symbol        TEXT,
    name          TEXT,
    decimals      SMALLINT,
    quote_target  NUMERIC(78, 0),
    registered    BOOLEAN NOT NULL DEFAULT FALSE,
    enabled       BOOLEAN NOT NULL DEFAULT FALSE,
    kind          TEXT,
    blurb         TEXT,
    underlying    TEXT,
    icon_domain   TEXT,
    sort_order    INTEGER NOT NULL DEFAULT 1000,
    -- Refreshed by the USD job. Stablecoins are pinned to 1 by that job, never by the schema.
    usd_price     NUMERIC(38, 12),
    usd_price_at  TIMESTAMPTZ,
    block_number  BIGINT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Rollup, rebuilt every 15 s by processing/stats.ts. A read never aggregates swaps for a list.
CREATE TABLE IF NOT EXISTS market_stats (
    market_address    TEXT PRIMARY KEY REFERENCES markets(market_address) ON DELETE CASCADE,
    market_cap_quote  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    market_cap_usd    NUMERIC(38, 8),
    volume_24h_quote  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    volume_24h_usd    NUMERIC(38, 8),
    -- Percent. NULL when there is no trade at least 24 h old to compare against — never 0.
    change_24h        DOUBLE PRECISION,
    trades_24h        INTEGER NOT NULL DEFAULT 0,
    last_trade_at     TIMESTAMPTZ,
    ath_quote         NUMERIC(78, 0) NOT NULL DEFAULT 0,
    ath_at            TIMESTAMPTZ,
    holders           INTEGER NOT NULL DEFAULT 0,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every fee component, one row each, in the market's quote raw units (burns in TOKEN units).
-- Because of that last clause, any aggregate over this table must exclude kind = 'burn':
-- `SUM(amount) GROUP BY quote_asset` across it silently mixes a token amount into a quote total.
-- kind: protocol | routed | tax | protocol_collected | routed_collected | tax_collected |
--       dividend_funded | dividend | burn
-- One log can produce several rows (a Bought yields protocol+routed+tax), hence kind in the key.
CREATE TABLE IF NOT EXISTS fee_events (
    id             BIGSERIAL PRIMARY KEY,
    market_address TEXT NOT NULL REFERENCES markets(market_address) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    recipient      TEXT,
    quote_asset    TEXT NOT NULL,
    amount         NUMERIC(78, 0) NOT NULL,
    venue          TEXT NOT NULL DEFAULT 'curve',
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index, kind)
);
CREATE INDEX IF NOT EXISTS fee_events_market ON fee_events (market_address, kind);
CREATE INDEX IF NOT EXISTS fee_events_recipient ON fee_events (recipient);
CREATE INDEX IF NOT EXISTS fee_events_block ON fee_events (block_number);

-- Projection of fee_events per market (processing/fees.ts). pending = generated - collected.
CREATE TABLE IF NOT EXISTS market_rewards (
    market_address      TEXT PRIMARY KEY REFERENCES markets(market_address) ON DELETE CASCADE,
    protocol_generated  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    protocol_collected  NUMERIC(78, 0) NOT NULL DEFAULT 0,
    routed_generated    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    routed_collected    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    tax_generated       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    tax_collected       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    dividends_funded    NUMERIC(78, 0) NOT NULL DEFAULT 0,
    dividends_paid      NUMERIC(78, 0) NOT NULL DEFAULT 0,
    -- Token units: TOTAL_SUPPLY - totalSupply, i.e. the sum of Transfer(…, 0x0) on the token.
    burned_tokens       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CreatorSink movements, one row per log, signed. Projected into creator_balances.
-- kind: credited | pulled_routed | pulled_tax | claimed | pushed (a FeesCollected/TaxCollected
-- push that paid the recipient directly — earned, never claimable).
CREATE TABLE IF NOT EXISTS creator_ledger (
    id             BIGSERIAL PRIMARY KEY,
    who            TEXT NOT NULL,
    quote_asset    TEXT NOT NULL,
    market_address TEXT,
    kind           TEXT NOT NULL,
    claimable_delta NUMERIC(78, 0) NOT NULL,
    earned_delta    NUMERIC(78, 0) NOT NULL,
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index, kind)
);
CREATE INDEX IF NOT EXISTS creator_ledger_who ON creator_ledger (who, quote_asset);
CREATE INDEX IF NOT EXISTS creator_ledger_block ON creator_ledger (block_number);

CREATE TABLE IF NOT EXISTS creator_balances (
    who             TEXT NOT NULL,
    quote_asset     TEXT NOT NULL,
    claimable       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    earned_lifetime NUMERIC(78, 0) NOT NULL DEFAULT 0,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (who, quote_asset)
);

-- Every MetadataSet, so a market's history of edits is readable and a reorg can restore the
-- previous one.
CREATE TABLE IF NOT EXISTS metadata_updates (
    id             BIGSERIAL PRIMARY KEY,
    market_address TEXT NOT NULL REFERENCES markets(market_address) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    ticker         TEXT NOT NULL,
    logo_uri       TEXT,
    banner_uri     TEXT,
    description    TEXT,
    website        TEXT,
    x              TEXT,
    telegram       TEXT,
    metadata_hash  TEXT,
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS metadata_updates_market ON metadata_updates (market_address, block_number);

-- Every change of a market's PAYEE, one row per log, so a rewind can put the columns back.
--
-- `markets.routed_recipient` and `markets.tax_recipient` are a cache of the newest row here, the
-- same relationship `markets`' metadata columns have with `metadata_updates`. Without this table
-- they were the only two columns in the schema mutated in place with no event behind them, and a
-- reorg that orphaned a `RecipientTransferred` therefore left every FUTURE routed collection
-- credited to the address the orphaned transfer named -- a plausible address, attached to real
-- money, that nothing downstream would question.
--
-- Each row is a SNAPSHOT of both columns as of that log, not just the leg the event moved:
-- `Registered` names a routed recipient this indexer deliberately does not store for a non-CREATOR
-- market (it is the market's own vault, not a person), so a row holding the raw event argument
-- would restore a contract into a column that must hold a person or nothing.
CREATE TABLE IF NOT EXISTS recipient_updates (
    id               BIGSERIAL PRIMARY KEY,
    market_address   TEXT NOT NULL REFERENCES markets(market_address) ON DELETE CASCADE,
    routed_recipient TEXT,
    tax_recipient    TEXT,
    block_number     BIGINT NOT NULL,
    block_hash       TEXT NOT NULL,
    log_index        INTEGER NOT NULL,
    tx_hash          TEXT NOT NULL,
    ts               TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS recipient_updates_market ON recipient_updates (market_address, block_number);

-- Image uploads. WRITTEN by the frontend's upload route through POST /uploads and DELETE
-- /uploads/:cid; `referenced_by` is set by the indexer when a MetadataSet points at the cid.
-- The upload route's GC reads GET /uploads/:cid and unpins what is unreferenced after 24 h.
CREATE TABLE IF NOT EXISTS uploads (
    cid           TEXT PRIMARY KEY,
    sha256        TEXT NOT NULL,
    bytes         INTEGER NOT NULL,
    mime          TEXT NOT NULL,
    width         INTEGER,
    height        INTEGER,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    referenced_by TEXT,
    referenced_at TIMESTAMPTZ,
    pinned        BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS uploads_unreferenced ON uploads (uploaded_at) WHERE referenced_by IS NULL;

CREATE TABLE IF NOT EXISTS candlesticks (
    market_address TEXT NOT NULL REFERENCES markets(market_address) ON DELETE CASCADE,
    period_secs    INTEGER NOT NULL,
    bucket_start   TIMESTAMPTZ NOT NULL,
    open           NUMERIC(78, 0) NOT NULL,
    high           NUMERIC(78, 0) NOT NULL,
    low            NUMERIC(78, 0) NOT NULL,
    close          NUMERIC(78, 0) NOT NULL,
    volume_quote   NUMERIC(78, 0) NOT NULL,
    trade_count    INTEGER NOT NULL,
    PRIMARY KEY (market_address, period_secs, bucket_start)
);

-- Every token transfer, kept so balances can be rebuilt.
--
-- Balances are running deltas, and a delta cannot be reversed without knowing what it was. Without
-- this table a reorg would leave every holder balance permanently wrong, and — because a wrong
-- balance still looks like a number — nothing would ever say so.
CREATE TABLE IF NOT EXISTS transfers (
    id             BIGSERIAL PRIMARY KEY,
    token_address  TEXT NOT NULL,
    from_address   TEXT NOT NULL,
    to_address     TEXT NOT NULL,
    value          NUMERIC(78, 0) NOT NULL,
    block_number   BIGINT NOT NULL,
    block_hash     TEXT NOT NULL,
    log_index      INTEGER NOT NULL,
    tx_hash        TEXT NOT NULL,
    ts             TIMESTAMPTZ NOT NULL,
    UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_token_block_idx ON transfers (token_address, block_number);

-- Per-address balances rather than a running holder count. A count cannot be corrected after a
-- reorg without replaying every transfer; balances are rebuilt from the transfers above.
CREATE TABLE IF NOT EXISTS token_balances (
    token_address TEXT NOT NULL,
    holder        TEXT NOT NULL,
    balance       NUMERIC(78, 0) NOT NULL DEFAULT 0,
    PRIMARY KEY (token_address, holder)
);

CREATE INDEX IF NOT EXISTS token_balances_nonzero
    ON token_balances (token_address) WHERE balance > 0;

-- One row. Tracks how far behind head we are, so staleness is observable rather than guessed at.
-- Explorer verification of the clones the factory deploys (generation 6+). One row per clone
-- address; `status` is submitted (guid outstanding at the explorer), verified, or failed with the
-- explorer's reason in `last_error`. Written by src/verification/, finished by
-- scripts/verify-clones.ts. Nothing the API serves reads it.
CREATE TABLE IF NOT EXISTS contract_verifications (
    address        TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    implementation TEXT NOT NULL,
    explorer       TEXT NOT NULL,
    status         TEXT NOT NULL,
    guid           TEXT,
    attempts       INT  NOT NULL DEFAULT 0,
    last_error     TEXT,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS indexer_status (
    id                 INTEGER PRIMARY KEY DEFAULT 1,
    last_block         BIGINT NOT NULL DEFAULT 0,
    last_block_hash    TEXT,
    -- The head the node reported on the last pass. Without it, lag can only be expressed as "how
    -- long since we wrote a row", which reads as healthy on a chain that is simply quiet and as
    -- broken on one that is busy.
    chain_head         BIGINT NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);


-- Every block the indexer has processed, whether or not it produced an event.
--
-- Reorg detection used to reconstruct candidate hashes by UNION-ing block_hash out of the four
-- event tables, which meant only blocks that *emitted something* carried a hash to compare. On a
-- quiet chain the walk-back had almost nothing to work with, and the first matching hash it found
-- could be far below the real fork point — leaving orphaned rows above it and a reader convinced
-- the reorg had been handled.
--
-- `parent_hash` is what makes the record a chain rather than a set of independent samples: two
-- consecutive rows whose parent link does not join have a reorg between them, even if both hashes
-- individually still match.
CREATE TABLE IF NOT EXISTS indexed_blocks (
    block_number BIGINT PRIMARY KEY,
    block_hash   TEXT NOT NULL,
    parent_hash  TEXT NOT NULL,
    indexed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS indexed_blocks_hash ON indexed_blocks (block_hash);

-- The log-level idempotency ledger.
--
-- The event tables each carry UNIQUE (tx_hash, log_index) and that is what makes a replayed range
-- a no-op. This records the same fact in one place, for logs that produce no row of their own —
-- a Transfer for a token we have since stopped tracking, an event decoded and then skipped — so
-- "have we already processed this log" is answerable without knowing which table it would have
-- landed in.
CREATE TABLE IF NOT EXISTS indexed_events (
    block_number BIGINT NOT NULL,
    tx_hash      TEXT NOT NULL,
    log_index    INTEGER NOT NULL,
    event_name   TEXT NOT NULL,
    PRIMARY KEY (tx_hash, log_index)
);

CREATE INDEX IF NOT EXISTS indexed_events_block ON indexed_events (block_number);

-- ---------------------------------------------------------------------------------------------
-- Columns added after the first deployment.
--
-- `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so a column added to a
-- CREATE above reaches a fresh database and never reaches a running one. The service then boots
-- cleanly and fails every query that names the column — the worst shape of failure, because the
-- deploy reports success. Every addition needs a line here as well as up there.
--
-- This block is at the BOTTOM on purpose. It used to sit near the top, which worked only for the
-- one table declared above it; an `ALTER` for any later table would have run before its `CREATE`.
-- Down here every table exists, so there is no ordering to get right.
--
-- The `graduations` additions are the v4 migration. Under V3 a pool was a contract and its address
-- was its identity; under v4 a pool is state inside one singleton, addressed by a `PoolId`. Every
-- one of these columns carries a DEFAULT, so rows written before the migration stay readable —
-- they simply have no PoolKey, which the ingester reads as "native MON is currency0".
-- ---------------------------------------------------------------------------------------------
ALTER TABLE markets      ADD COLUMN IF NOT EXISTS total_supply  NUMERIC(78, 0) NOT NULL DEFAULT 0;
ALTER TABLE market_state ADD COLUMN IF NOT EXISTS pool_id       TEXT;
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS pool_id       TEXT NOT NULL DEFAULT '';
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS currency0     TEXT NOT NULL DEFAULT '';
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS currency1     TEXT NOT NULL DEFAULT '';
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS fee           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS tick_spacing  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS hooks         TEXT NOT NULL DEFAULT '';
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS sink          TEXT NOT NULL DEFAULT '';
ALTER TABLE graduations  ADD COLUMN IF NOT EXISTS sink_kind     SMALLINT NOT NULL DEFAULT 0;

-- Generation 2 columns.
ALTER TABLE markets ADD COLUMN IF NOT EXISTS generation       SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS quote_asset      TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000';
ALTER TABLE markets ADD COLUMN IF NOT EXISTS quote_decimals   SMALLINT NOT NULL DEFAULT 18;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS routing          SMALLINT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS routed_recipient TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS creator_tax_bps  SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS tax_recipient    TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS ticker           TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS logo_uri         TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS banner_uri       TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS description      TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS website          TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS x                TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS telegram         TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS metadata_hash    TEXT;
ALTER TABLE swaps       ADD COLUMN IF NOT EXISTS creator_tax  NUMERIC(78, 0) NOT NULL DEFAULT 0;
ALTER TABLE graduations ADD COLUMN IF NOT EXISTS quote_asset  TEXT NOT NULL DEFAULT '0x0000000000000000000000000000000000000000';

-- The PoolId is the only thing that scopes a v4 swap log to a market, so it is looked up on every
-- swap the PoolManager emits.
CREATE INDEX IF NOT EXISTS graduations_pool_id ON graduations (pool_id);

CREATE INDEX IF NOT EXISTS markets_quote_asset ON markets (quote_asset);
CREATE INDEX IF NOT EXISTS markets_routing     ON markets (routing);
CREATE INDEX IF NOT EXISTS markets_creator     ON markets (creator);
-- `/markets/:address` answers to the token address as well as the curve's (the primary key).
CREATE INDEX IF NOT EXISTS markets_token_address ON markets (token_address);
CREATE INDEX IF NOT EXISTS market_stats_cap    ON market_stats (market_cap_quote DESC);
CREATE INDEX IF NOT EXISTS market_stats_vol24  ON market_stats (volume_24h_quote DESC);
CREATE INDEX IF NOT EXISTS market_stats_last   ON market_stats (last_trade_at DESC);

-- pg_trgm is an accelerator for the ILIKE searches in market.repository.ts, never a requirement:
-- a database without the extension answers the same queries by scanning. Wrapped so a host that
-- refuses CREATE EXTENSION still boots.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE INDEX IF NOT EXISTS markets_name_trgm   ON markets USING GIN (name gin_trgm_ops);
    CREATE INDEX IF NOT EXISTS markets_ticker_trgm ON markets USING GIN (ticker gin_trgm_ops);
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_trgm unavailable (%), search falls back to sequential ILIKE', SQLERRM;
  END;
END $$;

-- Gen-1 backfill: every market written before these columns existed is gen 1, native MON, 18
-- decimals (the column defaults say so). name = symbol already holds. `routing` cannot be
-- derived in SQL for markets that have not graduated — scripts/backfill-gen1.ts reads it from
-- the launch log; graduated ones get it from the graduation row here.
UPDATE markets m SET routing = g.sink_kind
  FROM graduations g
 WHERE g.market_address = m.market_address AND m.generation = 1 AND m.routing IS NULL;

-- Creators whose markets are not served. Their rows stay and ingestion still follows them (the
-- same reversibility argument as a retired generation, see repositories/served.ts); every read
-- selects from `servedMarkets()`, which leaves these out. Seeded additively from HIDDEN_CREATORS
-- at boot; a row an operator inserts by hand is never removed by a deploy.
CREATE TABLE IF NOT EXISTS hidden_creators (
    address    TEXT PRIMARY KEY,
    reason     TEXT,
    hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO indexer_status (id, last_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;
