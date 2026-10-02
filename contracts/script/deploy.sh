#!/usr/bin/env bash
#
# The DOKU deployment, for one named network.
#
#   ./script/deploy.sh local                a bare anvil on 127.0.0.1:8545; deploys Uniswap v4 too
#   ./script/deploy.sh testnet              Monad testnet (10143); deploys v4 too, it has none
#   ./script/deploy.sh testnet --simulate   everything except the broadcast
#   ./script/deploy.sh mainnet              Monad mainnet (143) — PRODUCTION, real money
#
# The network is a REQUIRED argument with no default, and the first thing this script does is ask
# the node what chain it is and refuse to continue if the answer disagrees. That pairing is the
# point of the file: an `--rpc-url` and a habit are not a network, and a mainnet deployment made
# under a testnet assumption is not recoverable.
#
# No address is written here. Everything network-specific comes from `script/config/NetworkConfig.sol`,
# keyed on the chain id the node reports, and the result is written to `deployments/<network>.json`.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
SIMULATE=0
for arg in "$@"; do
  case "$arg" in
    --simulate) SIMULATE=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

case "$NETWORK" in
  local)   WANT_CHAIN=31337 ;;
  testnet) WANT_CHAIN=10143 ;;
  mainnet) WANT_CHAIN=143 ;;
  *)
    cat >&2 <<'USAGE'
usage: script/deploy.sh <local|testnet|mainnet> [--simulate]

The network is required and is never inferred. `mainnet` is production.
USAGE
    exit 2 ;;
esac

# `.env` is not committed and holds the RPC URLs and the deploy key. forge loads it too; the process
# environment wins over it, which is what makes the per-network overrides below take effect.
if [ -f ./.env ]; then set -a && . ./.env && set +a; fi

# ---------------------------------------------------------- the node, and who it says it is

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  # anvil's first account
case "$NETWORK" in
  local)
    RPC="${LOCAL_RPC_URL:-http://127.0.0.1:8545}"
    # Deliberately NOT `DEPLOYER_PRIVATE_KEY`. That variable is the production deploy key and it
    # lives in the same `.env` this script sources, so honouring it here would sign a local run
    # with a mainnet key that holds nothing on a local node — which is how the first run of this
    # script failed. Anvil's own prefunded account is the correct default; name
    # `LOCAL_DEPLOYER_PRIVATE_KEY` to use something else.
    KEY="${LOCAL_DEPLOYER_PRIVATE_KEY:-$ANVIL_KEY}"
    ;;
  testnet)
    RPC="${MONAD_TESTNET_RPC_URL:?MONAD_TESTNET_RPC_URL is not set}"
    KEY="${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set}"
    ;;
  mainnet)
    RPC="${MONAD_RPC_URL:?MONAD_RPC_URL is not set}"
    KEY="${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY is not set}"
    ;;
esac

GOT_CHAIN=$(cast chain-id --rpc-url "$RPC")
if [ "$GOT_CHAIN" != "$WANT_CHAIN" ]; then
  echo "REFUSING: asked for '$NETWORK' (chain $WANT_CHAIN) but $RPC answers chain $GOT_CHAIN." >&2
  exit 1
fi

DEPLOYER=$(cast wallet address --private-key "$KEY")
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "network  $NETWORK (chain $GOT_CHAIN)"
echo "rpc      $RPC"
echo "deployer $DEPLOYER"
echo "balance  $(python3 -c "print($BAL/1e18)")"
if [ "$BAL" = "0" ]; then
  echo "REFUSING: $DEPLOYER holds nothing on chain $GOT_CHAIN." >&2
  exit 1
fi

# ---------------------------------------------------------- flags

FORGE_FLAGS=(--rpc-url "$RPC" --private-key "$KEY" --non-interactive --slow)
# Not optional. The hook and the graduation contract sit close enough to EIP-170's 24KB that a
# local simulation stricter than Monad's 128KB limit is a failure production does not have.
FORGE_FLAGS+=(--disable-code-size-limit)
# `--gas-estimate-multiplier 200`, and it is not paranoia.
#
# The first mainnet run failed on `setGraduator` with `gas = 42,373` and `gasUsed = 42,373` — the
# signature of running out, not of reverting. The true cost was 43,038, so forge's estimate was
# short by 665 gas, about 1.5%. Everything before it had already deployed, which left the protocol
# live with the factory still pointing its graduator at the deploy key: every launch would have
# worked and no market could ever have graduated.
#
# On Monad the usual objection does not apply either way, because gas is charged at the LIMIT
# rather than at usage — so a tight estimate buys nothing and a generous one costs the same as
# whatever the transaction actually needed to succeed.
FORGE_FLAGS+=(--gas-estimate-multiplier 200)
if [ "$SIMULATE" -eq 0 ]; then FORGE_FLAGS+=(--broadcast); fi

# ---------------------------------------------------------- per-network preparation

if [ "$NETWORK" = "mainnet" ]; then
  : "${DOKU_QUOTE_TARGET:?DOKU_QUOTE_TARGET is not set — the native MON target in wei, divisible by five}"
  # Required rather than defaulted: a mainnet deployment that opened MON-only is a protocol nobody
  # can launch a USDC market on until a second owner transaction lands. The six verified addresses
  # are in script/config/NetworkConfig.sol and in .env.example, and DeployDoku refuses any address
  # that is not one of them.
  : "${DOKU_QUOTE_ASSETS:?DOKU_QUOTE_ASSETS is not set}"
  : "${DOKU_QUOTE_TARGETS:?DOKU_QUOTE_TARGETS is not set}"
  : "${DOKU_LAUNCH_FEE_WEI:?DOKU_LAUNCH_FEE_WEI is not set (0 is a valid value; say so explicitly)}"
  NEED=6000000000000000000   # 6 MON: seven contracts and seven wiring calls, measured at 202 gwei
  if [ "$SIMULATE" -eq 0 ] && [ "$(python3 -c "print(1 if $BAL < $NEED else 0)")" = "1" ]; then
    echo "NOT ENOUGH. Need ~$(python3 -c "print($NEED/1e18)") MON at the gas price this run measured." >&2
    exit 1
  fi
fi

PERMIT2_ADDR=0x000000000022D473030F116dDEE9F6B43aC78BA3

if [ "$NETWORK" = "local" ]; then
  # Permit2, planted rather than deployed. It needs `via_ir` to compile from source and this project
  # cannot turn that on without moving the hook's creation code and voiding its mined salt, so the
  # bytecode vendored with v4-periphery is written straight to the canonical address — exactly what
  # the indexer's and the frontend's harnesses do.
  if [ "$(cast code "$PERMIT2_ADDR" --rpc-url "$RPC")" = "0x" ]; then
    P2=$(python3 -c "import re;print('0x'+re.search(r'hex\"([0-9a-fA-F]+)\"',open('lib/v4-periphery/lib/permit2/test/utils/DeployPermit2.sol').read()).group(1))")
    cast rpc anvil_setCode "$PERMIT2_ADDR" "$P2" --rpc-url "$RPC" >/dev/null
    echo "planted  Permit2 at $PERMIT2_ADDR"
  fi
fi

if [ "$NETWORK" = "local" ] || [ "$NETWORK" = "testnet" ]; then
  # Uniswap v4, because neither chain has it and a market with nowhere to graduate leaves exactly
  # half the protocol untestable. Skipped when the caller already names a live PoolManager, which is
  # how a second deployment reuses the first one's singletons.
  if [ -z "${V4_POOL_MANAGER:-}" ] || [ "$(cast code "${V4_POOL_MANAGER:-$PERMIT2_ADDR}" --rpc-url "$RPC")" = "0x" ]; then
    echo "deploying Uniswap v4 (this chain has none)"
    V4LOG=$(forge script script/DeployV4.s.sol:DeployV4 "${FORGE_FLAGS[@]}")
    pick_v4() { echo "$V4LOG" | sed -n "s/.*$1  *\(0x[0-9a-fA-F]\{40\}\).*/\1/p" | tail -1; }
    export V4_POOL_MANAGER="$(pick_v4 V4_POOL_MANAGER)"
    export V4_POSITION_MANAGER="$(pick_v4 V4_POSITION_MANAGER)"
    export V4_QUOTER="$(pick_v4 V4_QUOTER)"
    export V4_STATE_VIEW="$(pick_v4 V4_STATE_VIEW)"
    export V4_SWAP_ROUTER="$(pick_v4 V4_SWAP_ROUTER)"
    echo "         poolManager $V4_POOL_MANAGER"
  fi
fi

if [ "$NETWORK" = "local" ]; then
  # The overrides that keep a mainnet `.env` out of a local run.
  #
  # `.env` legitimately carries mainnet's quote set, its MON target and a real treasury, and forge
  # loads that file on its own. Left alone, a local deployment would try to register six addresses
  # that have no code here, raise a target no anvil account can fill, and route its protocol fees to
  # an address nobody running it holds. Every one of these is overridable for a local run that wants
  # something else; none of them silently inherits production.
  export DOKU_QUOTE_ASSETS="${LOCAL_QUOTE_ASSETS-}"
  export DOKU_QUOTE_TARGETS="${LOCAL_QUOTE_TARGETS-}"
  export DOKU_QUOTE_TARGET="${LOCAL_QUOTE_TARGET:-1000000000000000000000}"   # 1,000 MON
  export DOKU_LAUNCH_FEE_WEI="${LOCAL_LAUNCH_FEE_WEI:-0}"
  export DOKU_OWNER="$DEPLOYER" DOKU_PAUSER="$DEPLOYER"
  export DOKU_TREASURY="$DEPLOYER" DOKU_FEE_RECIPIENT="$DEPLOYER"
fi

# ---------------------------------------------------------- deploy

LOGFILE=$(mktemp)
trap 'rm -f "$LOGFILE"' EXIT
forge script script/DeployDoku.s.sol:DeployDoku "${FORGE_FLAGS[@]}" | tee "$LOGFILE"

# ---------------------------------------------------------- record

if [ "$SIMULATE" -eq 1 ]; then
  echo
  echo "simulated only — deployments/$NETWORK.json not written"
  exit 0
fi

python3 - "$NETWORK" "$GOT_CHAIN" "deployments/$NETWORK.json" "$LOGFILE" <<'PY'
import json, os, re, sys

network, chain_id, path, logfile = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
log = open(logfile).read()

def addr(label):
    m = re.search(label + r"\s+(0x[0-9a-fA-F]{40})", log)
    return m.group(1) if m else None

# Merged rather than replaced: the curated parts of the file — the quote set, the services, the
# notes — are not in this log and must survive a redeployment that only moves the contracts.
record = json.load(open(path)) if os.path.exists(path) else {}
record["network"] = network
record["chainId"] = chain_id
record["contracts"] = {
    name: value
    for name, value in (
        ("DokuFactory", addr("DOKU_FACTORY")),
        ("DokuGraduation", addr("DOKU_GRADUATION")),
        ("DokuHook", addr("DOKU_HOOK")),
        ("QuoteRegistry", addr("DOKU_QUOTE_REGISTRY")),
        ("CreatorSink", addr("DOKU_CREATOR_SINK")),
        ("SeedLocker", addr("DOKU_SEED_LOCKER")),
    )
    if value
}

salt = re.search(r"DOKU_HOOK_SALT\s+(0x[0-9a-fA-F]+)", log)
if salt:
    record["hookSalt"] = salt.group(1)

# The indexer scans from here. Scanning from genesis on a live chain is a backfill that never
# reaches the present, so this is the one number a service cannot be started without.
start = re.search(r"START_BLOCK\s+(\d+)", log)
if start:
    record["startBlock"] = int(start.group(1))

v4 = record.get("uniswapV4", {})
for key, env in (
    ("poolManager", "V4_POOL_MANAGER"),
    ("positionManager", "V4_POSITION_MANAGER"),
    ("stateView", "V4_STATE_VIEW"),
    ("quoter", "V4_QUOTER"),
    ("swapRouter", "V4_SWAP_ROUTER"),
):
    if os.environ.get(env):
        v4[key] = os.environ[env]
v4.setdefault("permit2", "0x000000000022D473030F116dDEE9F6B43aC78BA3")
record["uniswapV4"] = v4

with open(path, "w") as handle:
    json.dump(record, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
print("recorded " + path)
PY

if [ "$NETWORK" = "mainnet" ]; then
  cat <<'AFTER'

NOT FINISHED. Before announcing anything:
  1. Read the wiring back OFF THE CHAIN rather than out of this log — docs/doku/09-deployment-runbook.md.
  2. acceptOwnership() from the owner on the factory, hook, registry and CreatorSink.
  3. Fill in the quoteAssets and services sections of deployments/mainnet.json, and copy the
     addresses into docs/doku/deployments.md in the same commit.
AFTER
fi
