# DOKU contracts

The Solidity half of [DOKU](../README.md), a token launchpad on Monad. This is a **nested Foundry
project**: the repository root is not the Foundry root, so every command below runs from
`contracts/`.

`foundry.toml` explains every pinned setting. The hook's address is MINED from its creation code,
so `via_ir = false`, `bytecode_hash = "none"`, the exact compiler version and the exact dependency
tree are all load-bearing. Do not move any of them without re-mining the salt and redeploying;
`test/v4/HookAddress.t.sol` fails if you do, which is why it exists.

## Development & deployment

### Prerequisites

- **Foundry.** `curl -L https://foundry.paradigm.xyz | bash && foundryup`. Built and tested against
  forge 1.5.1.
- **git**, for the dependency submodules.
- **A funded key** for testnet or mainnet. Local needs nothing.

### Initial setup

```bash
git clone <repo> && cd <repo>
git submodule update --init --recursive     # from the REPO ROOT — the deps are submodules
cd contracts
cp .env.example .env                        # then fill it in; see the comments in that file
forge build
```

`git clone --recurse-submodules <repo>` collapses the first two lines into one. `forge install` is
not needed: the dependencies are pinned as submodules and `.gitmodules` records the exact commit of
each. Verify with `git submodule status` and `script/check-deps.sh`, which fingerprints every tree
and is what catches a dirty or locally patched dependency that a commit pin alone would not.

### Tests

```bash
forge test --no-match-path 'test/Fork.t.sol'                                  # 425
MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-path test/Fork.t.sol   # 7, 1 skipped
./script/check-abi.sh && ./script/check-deps.sh
```

The default profile is the gate: 10,000 fuzz runs, invariants 512x64. `FOUNDRY_PROFILE=fast` is the
inner loop. The **fork suite is the one that matters** — it puts a native, a stablecoin and a gold
market through their whole life against the real Uniswap singletons.

### Where configuration lives

Nothing network-specific is written in a script. `script/config/NetworkConfig.sol` holds the facts
about each chain — Uniswap's v4 singletons, Permit2, the CREATE2 proxy, the verified quote assets —
keyed on `block.chainid`, so the table is selected by the node the script is actually connected to
rather than by a flag and a habit. Everything that is a secret, a role, or a number somebody has to
choose comes from `.env`; `.env.example` is the template.

Resolution order is **environment variable, then the current chain's known value, then abort naming
the variable**. There is deliberately no fallback to mainnet: a script that quietly reaches for a
production address when a variable is unset is the failure this arrangement exists to prevent.

### Scripts

| Path | What it is |
|---|---|
| `script/deploy.sh` | The deployment, for one named network. The only entry point you need. |
| `script/DeployDoku.s.sol` | What it runs: deploys the seven contracts and asserts every wire. |
| `script/DeployV4.s.sol` | A local Uniswap v4 stack, for chains that have none. |
| `script/config/NetworkConfig.sol` | Every network's addresses, in one place. |
| `script/helpers/MineHookSalt.s.sol` | Re-derives a hook salt. |
| `script/interactions/LaunchMarket.s.sol` | Launches a market against a deployment. |
| `script/local/LocalScenario.s.sol` | The local fixture the indexer and frontend integration suites drive. |
| `script/check-abi.sh`, `script/check-deps.sh` | Gates: the ABI allowlist, and dependency drift. |

### Local deployment

```bash
cd contracts
anvil &                        # 1. a bare local node on 127.0.0.1:8545
cp .env.example .env           # 2. a local run needs nothing filled in
forge build                    # 3.
./script/deploy.sh local       # 4. plants Permit2, deploys Uniswap v4, then DOKU
```

`local` signs with anvil's own prefunded account unless `LOCAL_DEPLOYER_PRIVATE_KEY` says
otherwise, so a production key sitting in `.env` is never used against localhost. The addresses are
written to `deployments/local.json`, which is gitignored because it is rewritten on every run
against a throwaway chain. Nothing needs editing in Solidity.

Then interact with it:

```bash
DOKU_FACTORY=$(jq -r .factory deployments/local.json) TICKER=TEST \
  forge script script/interactions/LaunchMarket.s.sol:LaunchMarket \
  --rpc-url http://127.0.0.1:8545 --private-key <anvil key> --broadcast
```

### Testnet deployment

Monad testnet is chain 10143 and has no Uniswap v4, so the deployment brings its own.

```bash
cd contracts
# .env needs: MONAD_TESTNET_RPC_URL, DEPLOYER_PRIVATE_KEY, DOKU_QUOTE_TARGET
./script/deploy.sh testnet --simulate     # everything except the broadcast
./script/deploy.sh testnet
```

Addresses land in `deployments/testnet.json`, which is tracked, because three services have to
agree on them and a file outside the repository cannot be that agreement.

### Mainnet deployment

> **Production. Monad chain 143, real money, and none of it is reversible.**

Run the gates first, in this order, and do not proceed past a failure:

```bash
cd contracts
forge test --no-match-path 'test/Fork.t.sol'
MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-path test/Fork.t.sol
./script/check-abi.sh && ./script/check-deps.sh
./script/deploy.sh mainnet --simulate     # a dry run against the real chain state
./script/deploy.sh mainnet                # BROADCASTS
```

`.env` must carry `MONAD_RPC_URL`, `DEPLOYER_PRIVATE_KEY` (at least 6 MON, measured at 202 gwei),
the four role addresses, `DOKU_LAUNCH_FEE_WEI`, `DOKU_QUOTE_TARGET`, and the quote set as
`DOKU_QUOTE_ASSETS` / `DOKU_QUOTE_TARGETS`. On mainnet the script refuses any quote address that is
not one of the verified assets, and refuses the two counterfeit "xStock" contracts on every chain.

**Three things that are irreversible**, all documented at length in
[`../docs/doku/09-deployment-runbook.md`](../docs/doku/09-deployment-runbook.md) — read it before
you broadcast:

1. **A quote target must be divisible by five.** Otherwise the curve's virtual floor truncates, the
   seed lands under what graduation demands, and a market that fills can never graduate. The whole
   raise is locked with no rescue.
2. **The treasury cannot be changed** on a deployed curve.
3. **Ownership is offered, not transferred.** The deployment ends with the deploy key still in
   control until the new owner calls `acceptOwnership()` on all four owned contracts. Do that next.

Afterwards, record the addresses. `deploy.sh` writes `deployments/mainnet.json` — merging, so
curated fields survive a redeployment — and `docs/doku/deployments.md` carries the human account.
Read every wire back off the chain rather than trusting the deploy log; the runbook lists exactly
which calls.

## Contracts

| Contract | Path | Role | Mutable by |
|---|---|---|---|
| `Sinks` | `src/lib/Sinks.sol` | The routing discriminant: BURN 0, REWARDS 1, CREATOR 2. Fixes the levy currency. | nobody |
| `CurveMath`, `TaxMath` | `src/lib/` | Constant-product pricing over virtual reserves (pool-favouring rounding); the anti-sniper decay. | nobody |
| `QuoteRegistry` | `src/QuoteRegistry.sol` | Which assets a market may be priced in and the raw-unit target each raises. Markets snapshot the target at launch. | owner (Ownable2Step) |
| `DokuFactory` | `src/DokuFactory.sol` | Validates a launch, deploys the token and curve clones salted by `(creator, nonce)`, settles the launch fee and the first buy, holds `isMarket`/`creatorOf` and the metadata identity hash. | owner, pauser |
| `DokuToken` | `src/DokuToken.sol` | The market's ERC-20: 1,000,000,000 supply minted once to the curve, `symbol()` is the ticker, optional balance checkpoints for REWARDS markets. No hooks, no fees, no owner. | nobody |
| `BondingCurve` | `src/BondingCurve.sol` | The pre-graduation venue in any registered quote: one 1% fee split 30 bps protocol / 70 bps routed, creator tax 0–10%, anti-sniper 50%→0 over 5 min, auto-graduation on the filling buy, `buyFor` for the launch transaction's own dev buy. | nobody |
| `DokuGraduation` | `src/DokuGraduation.sol` | Moves a filled curve into a Uniswap v4 pool, deploys or registers the market's sink, locks the seed position in `SeedLocker`. | nobody (per market) |
| `DokuHook` | `src/v4/DokuHook.sol` | Levies the swap fee inside the pool: 30 bps protocol, 70 bps donated to in-range LPs (`LP_LEVY_BPS`); ledgers, never pushes. | owner (graduator set) |
| `SeedLocker` | `src/SeedLocker.sol` | Holds every seed position; forwards fees, cannot withdraw. | nobody |
| `BurnSink` | `src/sinks/BurnSink.sol` | Per BURN market: pulls the token and destroys it. | nobody |
| `RewardVault` | `src/sinks/RewardVault.sol` | Per REWARDS market: pays the quote to holders by epoch, pull-only. | nobody |
| `CreatorSink` | `src/sinks/CreatorSink.sol` | Shared: routed share and creator tax for every CREATOR or taxed market, `pull`/`claim`, deferred credits from curves. | owner (two one-shot wires) |
| `ZapRouter` | `src/ZapRouter.sol` | Pays for a market in native MON when it is priced in something else: swaps through Uniswap v4, buys on the curve, forwards the tokens. Holds nothing. Periphery: no market depends on it. | owner (the spend ceiling, and nothing else) |

## The zap router

`ZapRouter` lets someone buy a market with native MON when the market is priced in something else.
It swaps MON along a path the caller supplies, buys on the curve, forwards the tokens and refunds
every dust balance.

Live on Monad mainnet at `0x8e1630b85080dAdF25D78E30F25403f47E2Db142` — the GENERATION-3 router —
with a ceiling of 20,000 MON per zap. The generation-2 router at
`0x4B5aEC469dBd37d44E3D6B5FD6E3628A1D389BB1` is retired: its `factory` is immutable and points at
the paused generation-2 factory, so it reverts `UnknownMarket` on every current market. This line
named that address as the live one until 2026-09-10. Deploy one with `script/deploy-zap.sh <network>`, which needs
`DOKU_FACTORY` and `DOKU_MAX_ZAP_VALUE_WEI` and refuses a zero ceiling. Both of its addresses are
immutable, so a router pointed at the wrong factory is replaced rather than repaired.

It also sells: `zapSellToNative` pulls the seller's token, sells it on the curve for the quote
asset, swaps that into MON and pays the seller. **The seller approves the ROUTER, not the curve** —
a direct curve sell approves the curve because the curve pulls, and approving it for a zapped sell
is an allowance nothing uses and a sell that still reverts.

The frontend reads it from `NEXT_PUBLIC_ZAP_ROUTER`, at BUILD time — Next inlines it, and the
Dockerfile has to name it as an `ARG` as well. Unset, the pay-with-MON control does not render at
all, which is the right behaviour on a deployment with no router and an invisible outage on one
that has a router and forgot the build arg.

It carries no route table. It validates that the path starts at native MON and ends at the curve's
own quote asset, and nothing else about the route — which pools to cross is decided off chain, by
quoting every candidate at the size actually being traded. That is what keeps it correct as
liquidity moves, and liquidity moves: the direct MON/cbBTC pool prices one MON perfectly and costs
40% on ten.

**The buy happens outside the swap's unlock, and that is not a style choice.** A buy that fills the
curve graduates the market in the same transaction, graduation mints the seed through Uniswap's
PositionManager, and that calls `PoolManager.unlock` — which reverts `AlreadyUnlocked` when nested.
`BondingCurve._tryAutoGraduate` swallows every failure by design, so a router that bought inside its
own unlock would fill markets and silently fail to graduate them, with nothing reverting and nothing
to tell the buyer. `test_aFillingZapStillGraduatesOnMainnetFork` is the guard.

**It ships with a spend ceiling.** `maxZapValue` caps the MON one zap may spend, is set at
deployment, and the owner can raise or remove it in a single transaction — zero means no ceiling.
The point is to bound what a new, unaudited contract can lose while the only question worth
answering gets answered: whether people buy a coin priced in bitcoin once paying for it is easy.
It is denominated in MON going in rather than in dollars, because a dollar ceiling needs a price
feed, and a price feed is one more thing that can be stale or wrong in the path of funds. The check
runs before anything external is called, so an oversized zap cannot reach a pool, a curve or even
the factory on its way to being refused.

### The venue survey, and what it actually says

Surveyed on 2026-09-09 against the chains' own contracts, not against announcements.

Uniswap holds about **$24M** on Monad across the seven registered quote assets: **$22.6M in v4**
and **$1.37M in V3**. Where it sits is what decides the routes:

| Asset | held in v4 |
|---|---|
| USDC | $13,759,992 |
| MON (native) | $4,906,517 |
| WBTC | $1,306,180 |
| cbBTC | $1,288,940 |
| WETH | $1,275,347 |
| USDT0 | $58,679 |
| XAUt0 | $13,920 |

That table is the whole routing story. The five deep assets are all reachable through USDC, which
is why every route goes that way. The two thin ones, USDT0 and gold, are the two that run out —
and they run out at roughly the size their balances predict.

**Uniswap v4 is the on-ramp.** For MON into USDC, the leg every route depends on, it beats Uniswap
V3 by about 0.3% at every size that matters, on the fee tier alone — 0.05% against 0.3%. The two
converge only around $51,000, far beyond any trade this launchpad sees.

| MON in | v4 (native, 0.05%) | V3 (WMON, 0.3%) |
|---|---|---|
| 4,000 | 103.05 USDC | 102.72 |
| 400,000 | 10,274.73 USDC | 10,249.11 |

**But V3 holds a pool v4 does not have at all.** `USDC/USDT0` at the 0.01% tier, about $32,000 of
it. There is no USDC/USDT0 pool in v4, so without V3 the only way into USDT0 is v4's direct
MON/USDT0 pool, which exhausts around $400. Routing through V3's stablecoin pool instead:

| Trade | v4 only | with the V3 hop | gain |
|---|---|---|---|
| $103 | 100.3 USDT0 | 103.0 | +2.7% |
| $513 | 391.9 USDT0 | 514.9 | **+31%** |
| $1,026 | 392.0 USDT0 | 1,029.7 | **+163%** |

Gold gains 2.4% at $103 from the same hop and is then capped by its own final pool, `USDT0/XAUt0`,
which is the binding constraint above about $100.

**The lesson, recorded because the first survey got it wrong.** That survey ranked venues by total
liquidity, found Uniswap v4 holding a hundred times more than anything else, and concluded there
was nothing to aggregate. Depth is only half of what a venue is worth; the other half is COVERAGE.
V3 is not deeper than v4 anywhere — it is simply the only place a needed pair exists.

It also mis-stated that V3 was not deployed on Monad. It is, at
`0x204faca1764b154221e35c0d20abb3c525710498`, holding about $1.37M. The mistake was checking
Uniswap's canonical mainnet addresses, which on Monad hold a different contract entirely: the
factory, SwapRouter02 and QuoterV2 addresses all carry the SAME 2,109-byte bytecode and none
answers `owner()`. Something squats the well-known addresses here, so an integration that assumes
V3 lives where V3 always lives would be talking to an unknown contract. Take deployment addresses
from Uniswap's own documentation, per chain.

**Curve is deployed and empty**: zero pools and zero dollars across every registry — main, crypto,
factory, stable-ng, twocrypto and tricrypto. Trader Joe holds $822 and an Algebra fork $2,029, both
on WMON/USDC, both far behind v4. Ambient holds $94,650 and is the only other venue worth
re-checking later.

Tests are in `test/ZapFork.t.sol`, a sibling of `Fork.t.sol` rather than an extension of it — that
file is already split to stay under the stack limit, and the fix for that (`via_ir`) moves the
hook's mined address. The cap has its own suite, `test/ZapCap.t.sol`, which needs no fork. Run the fork ones with:

```bash
MONAD_RPC_URL=https://rpc.monad.xyz forge test --match-path 'test/*Fork*.t.sol'
```

Note that `forge` loads `.env` by itself, so once `MONAD_RPC_URL` is set there the fork tests run
rather than skip and the plain `forge test --no-match-path 'test/Fork.t.sol'` reports 440 rather
than 425. Exclude both fork files to see the 425 on its own.

## Deploy order

`DokuHook` at a mined address → `DokuGraduation` (takes the hook as an immutable) →
`hook.setGraduator(graduation, true)` → `QuoteRegistry` (registers the native asset) →
`CreatorSink` → `DokuFactory` → `creatorSink.setGraduator`, `creatorSink.setFactory`,
`factory.setGraduator` → ownership of factory, hook, registry and sink offered to the configured
owner (two-step; the deploy key stays in control until each is accepted). `script/DeployDoku.s.sol`
does this and asserts every wire.
