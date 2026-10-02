import { createLogger } from "../utils/logger.js";
import {
  type MetadataStore,
  publishTokenMetadata,
  type TokenMetadataInput,
} from "./token-metadata.js";

/**
 * The process-wide publisher the ingester hands metadata to.
 *
 * A singleton rather than a parameter threaded through `handleMetadataSet`, because that handler
 * sits four calls deep inside the ingest loop behind a signature every generation shares, and the
 * publisher is a side effect the loop must never wait on or fail for. `configure` runs once at
 * boot; `publish` is fire-and-forget with its own log line; unconfigured, it is a no-op.
 *
 * Errors are counted so `/status` could carry them later; they never propagate. A stale document
 * is repaired by the next `setMetadata` or by `scripts/publish-metadata.ts`.
 */

const log = createLogger().child({ component: "token-metadata" });

let store: MetadataStore | null = null;
let siteUrl: string | undefined;
let inFlight: Promise<void> = Promise.resolve();
let published = 0;
let failed = 0;

export function configureMetadataPublisher(s: MetadataStore | null, site?: string): void {
  store = s;
  siteUrl = site;
}

export function metadataPublisherEnabled(): boolean {
  return store !== null;
}

export function metadataPublisherCounts(): { published: number; failed: number } {
  return { published, failed };
}

/**
 * Queue one document. Serialised behind the previous one so two edits to the same token in one
 * block cannot race each other to the bucket and land out of order.
 */
export function publishMetadata(m: TokenMetadataInput): void {
  if (!store) return;
  const s = store;
  inFlight = inFlight
    .then(() => publishTokenMetadata(s, m, { siteUrl }))
    .then((r) => {
      published += 1;
      log.info("published token metadata", { token: m.tokenAddress, key: r.key, url: r.url });
    })
    .catch((error: unknown) => {
      failed += 1;
      log.warn("token metadata publish failed; the document stays stale until the next edit", {
        token: m.tokenAddress,
        error,
      });
    });
}

/** For tests and the backfill script: wait for everything queued so far. */
export function metadataPublisherIdle(): Promise<void> {
  return inFlight;
}
