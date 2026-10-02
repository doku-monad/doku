import { encodeAbiParameters, keccak256 } from "viem";
import type { Db } from "../../../db/legacy.js";
import type { LiveEvent } from "../../../websocket/live.js";
import { gen2OpeningPrice, NATIVE_QUOTE } from "../../generations.js";
import { publishMetadata } from "../../../metadata/publisher.js";
import { queueCloneVerification } from "../../../verification/verifier.js";

/** The per-log fields every handler writes; built once in `handle` and passed down. */
/**
 * The implementations every clone delegates to, read off the factory once at boot
 * (`setCloneImplementations`). Empty strings until then, which the verifier treats as "not armed".
 */
export const IMPLEMENTATIONS: { token: string; curve: string } = { token: "", curve: "" };

export function setCloneImplementations(impl: { token: string; curve: string }): void {
  IMPLEMENTATIONS.token = impl.token.toLowerCase();
  IMPLEMENTATIONS.curve = impl.curve.toLowerCase();
}

export interface LogBase {
  block: string;
  hash: string;
  idx: number;
  tx: string;
}

const addr = (v: unknown): string => String(v).toLowerCase();
/** A decoded `string` field. Anything else is a field the event did not carry. */
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** The same, but an empty string is stored as NULL: "not set" is not "set to nothing". */
const orNull = (v: unknown): string | null => {
  const s = str(v);
  return s.length === 0 ? null : s;
};

/**
 * A gen-2 launch.
 *
 * Everything economic is on the event and immutable, so nothing is read from the chain. The
 * market's quote decimals come from the registry row the QuoteRegistry handler wrote — or 18 for
 * native MON, which has no row on chain either. A quote asset that is registered but unknown to
 * this database (the registry event was missed) falls back to 18 and is logged by the caller's
 * pass summary; the USD job cannot price it until the registry event is replayed.
 *
 * `symbol`, `name` and `symbol_key` are NOT NULL from gen 1 and gen 2 has no emoji symbol. They
 * are filled by the `MetadataSet` emitted in the same transaction (name/ticker), and the address
 * stands in as the unique `symbol_key`, which gen 1 used for the emoji registry key.
 */
export async function handleMarketLaunched2(
  db: Db,
  a: Record<string, unknown>,
  ts: Date,
  base: LogBase,
  announce: (event: LiveEvent) => void,
): Promise<void> {
  const curve = addr(a.curve);
  const quoteAsset = addr(a.quoteAsset);
  const sink = Number(a.sink);
  const routedRecipient = addr(a.routedRecipient);
  const taxRecipient = addr(a.taxRecipient);

  let decimals = 18;
  if (quoteAsset !== NATIVE_QUOTE) {
    const { rows } = await db.query<{ decimals: number | null }>(
      "SELECT decimals FROM quote_assets WHERE address = $1",
      [quoteAsset],
    );
    if (rows[0]?.decimals != null) decimals = Number(rows[0].decimals);
  }

  const inserted = await db.query(
    `INSERT INTO markets (market_address, token_address, symbol, name, symbol_key, creator,
                          quote_target, generation, quote_asset, quote_decimals, routing,
                          routed_recipient, creator_tax_bps, tax_recipient,
                          block_number, block_hash, log_index, tx_hash, created_at)
     VALUES ($1,$2,'','',$1,$3,$4,2,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING market_address`,
    [
      curve,
      addr(a.token),
      addr(a.creator),
      String(a.quoteTarget),
      quoteAsset,
      decimals,
      sink,
      // Zero means "nobody" for every sink but CREATOR, where the factory already substituted the
      // creator before emitting. Stored as null so a reader never compares against address(0).
      routedRecipient === NATIVE_QUOTE ? null : routedRecipient,
      Number(a.creatorTaxBps),
      taxRecipient === NATIVE_QUOTE ? null : taxRecipient,
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  if (inserted.rowCount === 0) return;

  // The launch is the first event that names this market's payees, so it is the first row in the
  // payee history -- the one a rewind falls back to when every later `Registered` or
  // `RecipientTransferred` turns out to be above the fork. Without it those two columns would be
  // the only ones in the schema a rewind could not reconstruct.
  await db.query(
    `INSERT INTO recipient_updates (market_address, routed_recipient, tax_recipient,
                                    block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      curve,
      routedRecipient === NATIVE_QUOTE ? null : routedRecipient,
      taxRecipient === NATIVE_QUOTE ? null : taxRecipient,
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  /**
   * The curve's opening price, recorded now rather than left at zero until the first trade.
   *
   * A market launched without a first buy otherwise carries `last_price = 0`, and the board renders
   * that as a $0.00 market cap beside a real coin — worthless rather than untraded. It is most
   * markets on a pairs launchpad, because a creator quoting in gold or in USDC seldom holds the
   * quote asset at the moment they launch.
   */
  await db.query(
    `INSERT INTO market_state (market_address, last_price) VALUES ($1,$2)
     ON CONFLICT DO NOTHING`,
    [curve, String(gen2OpeningPrice(BigInt(String(a.quoteTarget))))],
  );
  await db.query("INSERT INTO market_rewards (market_address) VALUES ($1) ON CONFLICT DO NOTHING", [
    curve,
  ]);
  announce({ type: "market", market: curve });
  /*
   * Explorer verification of the two clones this launch deployed. Fire-and-forget: it is
   * serialised and persisted by `verification/verifier.ts`, and a refusal or an outage costs an
   * unverified page, never a row. Off (a counted skip) when no explorer key is configured.
   */
  queueCloneVerification({ address: addr(a.token), kind: "token", implementation: IMPLEMENTATIONS.token });
  queueCloneVerification({ address: curve, kind: "curve", implementation: IMPLEMENTATIONS.curve });
}

/** `keccak256(abi.encode(meta))`, the hash the factory stores. */
export function metadataHash(m: {
  name: string;
  ticker: string;
  logoURI: string;
  bannerURI: string;
  description: string;
  website: string;
  x: string;
  telegram: string;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "string", name: "name" },
            { type: "string", name: "ticker" },
            { type: "string", name: "logoURI" },
            { type: "string", name: "bannerURI" },
            { type: "string", name: "description" },
            { type: "string", name: "website" },
            { type: "string", name: "x" },
            { type: "string", name: "telegram" },
          ],
        },
      ],
      [m],
    ),
  );
}

/** `ipfs://<cid>` or `ipfs://<cid>/…` → the cid; anything else → null. */
export function cidOf(uri: string | null): string | null {
  if (!uri) return null;
  const m = /^ipfs:\/\/([A-Za-z0-9]+)/.exec(uri);
  return m ? m[1]! : null;
}

/**
 * On-chain metadata, from the launch transaction and from every later `setMetadata`.
 *
 * The columns on `markets` hold the CURRENT metadata; `metadata_updates` holds every version so a
 * rewind can restore the previous one (see sync/rewind.ts). The ticker becomes the market's
 * `symbol`, because the gen-2 token's `symbol()` IS the ticker (interface.md, DokuToken).
 */
export async function handleMetadataSet(
  db: Db,
  a: Record<string, unknown>,
  ts: Date,
  base: LogBase,
  announce: (event: LiveEvent) => void,
): Promise<void> {
  const curve = addr(a.curve);
  const { rows: known } = await db.query("SELECT 1 FROM markets WHERE market_address = $1", [curve]);
  if (known.length === 0) return;

  const meta = {
    name: str(a.name),
    ticker: str(a.ticker),
    logoURI: str(a.logoURI),
    bannerURI: str(a.bannerURI),
    description: str(a.description),
    website: str(a.website),
    x: str(a.x),
    telegram: str(a.telegram),
  };
  const hash = metadataHash(meta);

  const inserted = await db.query(
    `INSERT INTO metadata_updates (market_address, name, ticker, logo_uri, banner_uri, description,
                                   website, x, telegram, metadata_hash,
                                   block_number, block_hash, log_index, tx_hash, ts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`,
    [
      curve,
      meta.name,
      meta.ticker,
      orNull(meta.logoURI),
      orNull(meta.bannerURI),
      orNull(meta.description),
      orNull(meta.website),
      orNull(meta.x),
      orNull(meta.telegram),
      hash,
      base.block,
      base.hash,
      base.idx,
      base.tx,
      ts,
    ],
  );
  if (inserted.rowCount === 0) return;

  await db.query(
    `UPDATE markets SET symbol = $2, name = $3, ticker = $2, logo_uri = $4, banner_uri = $5,
                        description = $6, website = $7, x = $8, telegram = $9, metadata_hash = $10
      WHERE market_address = $1`,
    [
      curve,
      meta.ticker,
      meta.name,
      orNull(meta.logoURI),
      orNull(meta.bannerURI),
      orNull(meta.description),
      orNull(meta.website),
      orNull(meta.x),
      orNull(meta.telegram),
      hash,
    ],
  );

  // The uploads this metadata points at are now paid for with gas, so the GC must keep them.
  for (const cid of [cidOf(meta.logoURI), cidOf(meta.bannerURI)]) {
    if (!cid) continue;
    await db.query(
      `UPDATE uploads SET referenced_by = $2, referenced_at = COALESCE(referenced_at, $3)
        WHERE cid = $1`,
      [cid, curve, ts],
    );
  }
  announce({ type: "metadata", market: curve });

  /*
   * The document `DokuToken.metadataURI()` points at, republished from what the chain just said.
   * Best-effort and never awaited: see `metadata/publisher.ts`.
   */
  const { rows: tok } = await db.query<{ token_address: string }>(
    "SELECT token_address FROM markets WHERE market_address = $1",
    [curve],
  );
  const tokenAddress = tok[0]?.token_address;
  if (tokenAddress) {
    publishMetadata({
      tokenAddress,
      name: meta.name,
      ticker: meta.ticker,
      description: orNull(meta.description),
      logoUri: orNull(meta.logoURI),
      bannerUri: orNull(meta.bannerURI),
      website: orNull(meta.website),
      x: orNull(meta.x),
      telegram: orNull(meta.telegram),
    });
  }
}
