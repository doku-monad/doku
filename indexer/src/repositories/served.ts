import { Prisma } from "@prisma/client";

/**
 * Markets from a RETIRED generation are still in this database, and must not be served as if they
 * were tradeable.
 *
 * Generation 2 was retired on 2026-09-10 after an audit found four ways for anyone to permanently
 * freeze a market's entire raise. Its contracts are immutable and its 41 markets are still there,
 * still quoting, still accepting buys — and anyone who buys into one can have it frozen under them.
 * The rows cannot simply be deleted: this is one database across a repointing, and a delete is
 * irreversible if the cutover has to be undone.
 *
 * So the cut is by LAUNCH BLOCK against the deployment this service is configured for. `START_BLOCK`
 * already names the generation being served — it is what the scan begins from — and a market
 * launched before it belongs to a factory this deployment no longer speaks to.
 *
 * The cut is a READ cut and only a read cut. Ingestion still follows the retired markets' tokens
 * and pools (`MarketRepository.knownAddresses`), because that is what makes the cutover reversible:
 * flipping `START_BLOCK` back serves a complete picture again, where an ingester that had stopped
 * watching would leave a hole only a re-scan could fill. Rows nobody serves are cheap; a gap in the
 * history is not.
 *
 * This module is the whole of it, because a predicate that has to be REMEMBERED is a predicate that
 * gets forgotten — there were nine `FROM markets` reads at the time of writing, spread over six
 * repositories, and the tenth would have been written by someone who never heard of generation 2.
 * So the table is not named directly in the read layer at all: `servedMarkets()` is what a query
 * selects from, and it carries the cut with it. `test/retired-generation.test.ts` holds both ends
 * of that — a source guard that fails on a bare `FROM markets`, and a sweep that calls every
 * repository method and fails if a new one appears uncovered.
 */

/*
 * Read from the environment directly rather than threaded through `ServiceConfig`, which is built
 * in `src/index.ts` and never reaches a repository. `readConfig` already validates `START_BLOCK` at
 * boot — it is `required()` there and refuses a non-number — so this cannot be the first place a
 * bad value is noticed. Zero, the default, serves everything, which is the correct behaviour for a
 * deployment that has never been repointed.
 *
 * Per query rather than captured once at import, and that is the difference between a cut that can
 * be exercised and one that cannot: a module-level constant is fixed by whichever import happened
 * first, so proving "a pre-cutover market is absent from every surface" would mean re-importing the
 * entire read layer — PGlite's WebAssembly engine included — for each value. The cost is one
 * `BigInt` parse per query, against a database round trip.
 */
export function servedFrom(): bigint {
  return BigInt(process.env.START_BLOCK ?? "0");
}

/**
 * The `markets` table with the retired generations already gone. Every read that names markets
 * selects from THIS.
 *
 * A derived table rather than an exported predicate for one reason: a predicate lands in the
 * `WHERE`, and a `WHERE` is somewhere a query can be written without. A `FROM` is not — the next
 * person copies the line that names the table, and the cut comes with it. It also survives the
 * shapes a predicate does not: `listPaged` builds its own `WHERE` from the filter object,
 * `recentlyGraduated` has no `WHERE` at all, and `holders` reaches markets from inside a CTE.
 *
 * `SELECT *` here is the exception to the rule in `columns.ts`, and stays inside it: nothing from
 * this reaches the wire, because every caller then selects an explicit column list off the alias.
 * Naming the columns would mean a market column added to the schema being invisible to the API
 * until someone remembered this file.
 *
 * Callers supply the alias (`${servedMarkets()} m`), because that is what the column fragments in
 * `columns.ts` are written against. Postgres refuses a derived table without one, so a missing
 * alias is a loud error rather than a wrong answer.
 */
export function servedMarkets(): Prisma.Sql {
  return Prisma.sql`(SELECT * FROM markets
                      WHERE block_number >= ${servedFrom()}
                        AND creator NOT IN (SELECT address FROM hidden_creators))`;
}

/**
 * The second cut, by CREATOR: a wallet in `hidden_creators` has none of its markets served.
 *
 * It exists for launch spam — one wallet launched nineteen empty markets in ten minutes on
 * 2026-09-22 and the board was two-thirds noise. Same shape as the generation cut: the rows stay,
 * ingestion follows them, only the reads leave them out; a hidden market's page answers 404 like
 * a market that never existed, because "this launchpad hides you" is not a fact worth serving.
 *
 * @param alias the markets alias a query already carries, for the two by-address lookups that
 *        read `EVERY_MARKET` to tell "retired" from "never existed".
 */
export function notHidden(alias: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(alias)}.creator NOT IN (SELECT address FROM hidden_creators)`;
}

/**
 * The same cut for a table that is keyed by market but does not join markets: swaps read by market
 * address, candlesticks read by market address.
 *
 * Those queries have no `m` to filter, and giving them one would mean a join whose only purpose is
 * a predicate — this says what it means instead, and the planner turns it into a semi-join on the
 * primary key either way.
 *
 * @param column the qualified market-address column, e.g. `"swaps.market_address"`. Spliced, so it
 *        can only ever be a literal this codebase wrote; it is never caller text.
 */
export function servedMarket(column: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM markets sm
     WHERE sm.market_address = ${Prisma.raw(column)} AND sm.block_number >= ${servedFrom()}
       AND sm.creator NOT IN (SELECT address FROM hidden_creators)
  )`;
}

/**
 * The table itself, retired rows and all.
 *
 * Two reads want it, and they are the two that are not serving a market as tradeable. A lookup by
 * address has to be able to tell "retired" from "never existed" — see `retiredFlag` — and the
 * ingester's address filter is not a read of the API's at all.
 *
 * Written as a fragment rather than as the bare table name so that the source guard in
 * `test/retired-generation.test.ts` can hold the simplest possible rule: `FROM markets` does not
 * appear in the read layer. An exception that has to be spelled is an exception someone decided to
 * make.
 */
export const EVERY_MARKET = Prisma.raw("markets");

/**
 * Whether the row a lookup found belongs to a retired generation.
 *
 * Selected rather than filtered, because a 404 for a market that exists, holds a raise and is still
 * quoting on chain is not a true answer — it reads as "you typed the address wrong", and the reader
 * goes looking for the market somewhere that will happily sell them one. The flag rides back to the
 * service, which answers 410 Gone and says which generation it was.
 *
 * @param alias the markets alias, so a query can carry the flag beside its own columns.
 */
export function retiredFlag(alias: string): Prisma.Sql {
  return Prisma.sql`(${Prisma.raw(alias)}.block_number < ${servedFrom()}) AS retired`;
}
