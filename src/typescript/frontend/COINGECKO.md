<!-- markdownlint-disable line-length -->

# CoinGecko

DOKU does not publish a CoinGecko-compatible ticker API. It only consumes
CoinGecko, in one place, to price the quote assets.

`GET /api/quote-prices` returns the flat `{ key: usd }` document the indexer
reads through its `PRICE_SOURCE_URL`. It calls
`api.coingecko.com/api/v3/simple/price` once per minute and caches the answer;
`QUOTE_PRICE_SOURCE_URL` overrides the upstream if the feed has to be swapped.

The vendor's response shape is deliberately confined to
[`src/lib/prices/quote-prices.ts`](./src/lib/prices/quote-prices.ts) — the
indexer never sees it, so changing feeds is a change to that one file.

Every quote asset registered on chain must appear in `PRICED_QUOTES` there. An
asset the document does not price is not ranked at zero; the indexer falls back
to ranking it on whole quote units, which prints a plausible board with the
wrong order and reports no error. `/status.unpriced_quotes` names any asset in
that state.
