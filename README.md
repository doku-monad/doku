# DOKU

A token launchpad on [Monad](https://monad.xyz). Live at **[doku.family](https://doku.family)**.

Name the coin, choose what it trades against, sign once. The market is live on Monad in a single
transaction — and it stays there for good.

A coin can be priced in anything an admin has registered: native MON, stablecoins, wrapped bitcoin
or ether, or tokenised gold. Every market starts on a bonding curve and, once the curve fills,
graduates into a Uniswap v4 pool in the same transaction, with its liquidity locked forever. One
percent of every swap is charged as a fee: 30 basis points to the protocol, and 70 routed wherever
the creator chose at launch — buying the coin back and burning it, paying holders, or paying the
creator.

## What is here

| Directory | What it is |
|---|---|
| `contracts/` | Solidity: the factory, the bonding curve, the quote registry, graduation, and the Uniswap v4 hook that charges the fee |
| `indexer/` | TypeScript service turning Monad logs into markets, trades, candles and holders; serves a REST API and a live feed |
| `src/typescript/frontend/` | The Next.js app |
| `src/typescript/sdk/` | Types and vocabulary shared by the app and the tooling |
| `docs/doku/` | Architecture decisions, the deployment runbook, and the deployed addresses |

**Deploying the contracts is documented in [`contracts/README.md`](contracts/README.md).** Start
there; everything Foundry runs from inside `contracts/`, which is a nested project and not the
repository root.

## Running the services locally

```bash
# anvil with the contracts deployed and one market driven through its whole life
cd indexer && node ../scripts/local-stack.mjs

# the indexer, against that chain. No database needed locally: without DATABASE_URL it runs
# Postgres in-process. A deployment supplies one, or its data does not survive a restart.
cd indexer && MONAD_RPC_URL=http://127.0.0.1:8545 PORT=3010 \
  FACTORY_ADDRESS=<printed> GRADUATION_ADDRESS=<printed> npx tsx src/index.ts

# the app
cd src/typescript/frontend && pnpm build && pnpm start
```

The frontend reads its configuration from `.env.local`; `src/typescript/example.local.env` lists
what it needs. The indexer's is `indexer/example.env`.

## Tests

```bash
cd contracts && forge test --no-match-path 'test/Fork.t.sol'          # 425
MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-path test/Fork.t.sol   # 7, 1 skipped
cd indexer && MONAD_RPC_URL=https://rpc.monad.xyz npx vitest run      # 485
cd src/typescript/frontend && npx jest tests/unit                     # 681
cd src/typescript/frontend && npx jest tests/integration              # 16, needs anvil and forge
```

The fork suites are the ones that matter: they put a native, a stablecoin and a **gold** market
through their whole life against the real Uniswap singletons on a fork of Monad mainnet. The
frontend's integration tests trade through the app's own write path against contracts deployed on a
local chain, including a market quoted in a six-decimal ERC-20.

## Secrets

No `.env` file is ever committed. Every package ignores its own, and the repository root ignores
`**/.env*` with named exceptions for the example templates. Private keys, RPC credentials and API
tokens come from the environment; `contracts/.env.example` is the template and contains
placeholders only.

## Licence

Apache 2.0. See `LICENSE.md`.
