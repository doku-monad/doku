/**
 * JSON with `bigint` and `Date` round-tripped, on its own leaf module.
 *
 * ## Why this is not in `utils/index.ts` any more
 *
 * That barrel's first line is `import { CHAT_EMOJI_DATA, SYMBOL_EMOJI_DATA } from "@/sdk/emoji_data"`,
 * which evaluates ~3,500 emoji rows and builds six lookup `Map`s at module scope. Neither this
 * package nor the SDK declares `sideEffects: false`, so webpack cannot drop that work for an
 * importer that only wanted `parseJSON`.
 *
 * And one importer that only wanted `parseJSON` was `configs/local-storage-keys.ts` — which
 * `UserSettingsProvider` pulls in, which `context/providers.tsx` mounts on **every route**. So the
 * emoji tables (~50 kB gzipped, and a few milliseconds of map building on a phone) were on the
 * critical path of every page in the product, to serialise a settings object.
 *
 * Splitting the two functions out is the whole fix: the barrel still re-exports them, so nothing
 * else has to change, and the modules that want JSON without emoji import this file directly.
 */

export const BigIntTrailingNRegex = /^-?(([1-9]\d*)|0)n$/;

// This matches the below pattern: 1234-12-31T23:59:59.666Z
export const DateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const stringifyJSON = <T>(data: T) =>
  JSON.stringify(data, (_, value) => (typeof value === "bigint" ? `${value}n` : value));

export const parseJSON = <T>(json: string): T =>
  JSON.parse(json, (_, value) => {
    if (typeof value === "string" && BigIntTrailingNRegex.test(value)) {
      return BigInt(value.slice(0, -1));
    }
    if (typeof value === "string" && DateRegex.test(value)) {
      return new Date(value);
    }
    return value;
  }) as T;
