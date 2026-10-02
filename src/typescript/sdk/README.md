# @doku/sdk

Shared TypeScript used by the DOKU frontend: the emoji tables a market symbol
is built from, the sort vocabulary the market list speaks, and a handful of
chain-agnostic helpers.

This package used to be a full Aptos client — generated Move module bindings, a
PostgREST query layer, a websocket broker client, an event processor. DOKU runs
on Monad and talks to its contracts through `viem`, so all of that is gone. What
is left is the part that was never chain-specific.

## What is in here

| Path              | What it holds                                                                       |
| ----------------- | ----------------------------------------------------------------------------------- |
| `src/const.ts`    | Chart periods (`Period`, `PeriodDuration`), `DECIMALS`, symbol length limits        |
| `src/emoji_data/` | The symbol and chat emoji tables, plus parsing and validation over them             |
| `src/sorting/`    | `SortMarketsBy`, `DEFAULT_SORT_BY`, `toOrderBy`                                     |
| `src/types/`      | `AnyNumberString`, `Flatten`                                                        |
| `src/utils/`      | Hex handling, bigint comparison, number-input sanitising, emoji byte counting, misc |

Nothing in here reads an environment variable at import time, and nothing needs
a network. That is deliberate: an earlier version threw on import unless six
Aptos variables were set, which meant a unit test that only wanted a regex could
not load the module.

## Emoji data

The emoji tables are the authoritative answer to "is this a valid market
symbol". The same tables generate the merkle allowlist the contracts check
against, so a symbol the frontend accepts is a symbol the factory will accept.

```typescript
import { isValidMarketSymbol, toMarketEmojiData, type SymbolEmoji } from "@doku/sdk";

isValidMarketSymbol("🍟💤"); // true

const emojis: SymbolEmoji[] = ["🍟", "💤"];
const { symbolData } = toMarketEmojiData(emojis.join(""));
// symbolData.name === "french fries,ZZZ"
```

`SymbolEmoji` and `ChatEmoji` are unions of the literal emoji in the tables, so
an invalid emoji is a type error and a valid one gets autocompletion inside the
quotes.

A market symbol is capped by byte length, not by emoji count — see
`MAX_SYMBOL_LENGTH` in `src/const.ts` and `sumBytes` in
`src/utils/sum-emoji-bytes.ts`. Some single emoji are several bytes of UTF-8,
so counting characters would let through a symbol the contract rejects.

See [emoji_data/README.md](src/emoji_data/README.md) for how to regenerate the
`*-emojis.ts` tables.

## Sorting

```typescript
import { DEFAULT_SORT_BY, SortMarketsBy, toOrderBy } from "@/sdk/sorting";
```

The default is bump order rather than market cap. Every market opens at the
same price against its quote and a curve barely moves until real money arrives,
so a cap-sorted board is close to a fixed list — the same markets in the same
order, whatever is actually happening.

## Consuming it from the frontend

The frontend does not resolve this package through `node_modules`; it maps the
source directly in `src/typescript/frontend/tsconfig.json`:

```typescript
import { Period } from "@/sdk/const";
import { isValidMarketSymbol } from "@/sdk/emoji_data";
import type { AnyNumberString } from "@/sdk-types";
```

Importing a subpath rather than the package root keeps the emoji tables — which
are large — out of a bundle that only wanted a period enum.

## Scripts

```shell
pnpm check        # tsc
pnpm lint         # eslint, zero warnings
pnpm test:unit    # jest
pnpm format       # prettier, in place
```
