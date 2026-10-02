#!/usr/bin/env bash
#
# The ZapRouter, for one named network. Periphery, deployed SECOND, against a DOKU deployment that
# already exists.
#
#   ./script/deploy-zap.sh local
#   ./script/deploy-zap.sh testnet --simulate
#   ./script/deploy-zap.sh mainnet              PRODUCTION, real money
#
# Same contract as `deploy.sh`: the network is a required argument, the node is asked what chain it
# actually is, and a disagreement aborts. No address is written here — the factory comes from
# `DOKU_FACTORY` and the PoolManager from `script/config/NetworkConfig.sol`, keyed on the chain id.
#
# The router is not the protocol. Nothing in `src/` knows it exists and no market depends on it, so
# a bad one is replaced rather than repaired — but both of its addresses are immutable, which is why
# the script refuses far more than it needs to before broadcasting.
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
usage: script/deploy-zap.sh <local|testnet|mainnet> [--simulate]

The network is required and is never inferred. `mainnet` is production.

Required in the environment (or .env):
  DOKU_FACTORY            the live factory this router will buy on
  DOKU_MAX_ZAP_VALUE_WEI  the ceiling on a single zap, in wei of MON
USAGE
    exit 2 ;;
esac

if [ -f ./.env ]; then set -a && . ./.env && set +a; fi

ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
case "$NETWORK" in
  local)
    RPC="${LOCAL_RPC_URL:-http://127.0.0.1:8545}"
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

: "${DOKU_FACTORY:?DOKU_FACTORY is not set — the live factory this router buys on}"
: "${DOKU_MAX_ZAP_VALUE_WEI:?DOKU_MAX_ZAP_VALUE_WEI is not set — the per-zap ceiling in wei of MON}"

GOT_CHAIN=$(cast chain-id --rpc-url "$RPC")
if [ "$GOT_CHAIN" != "$WANT_CHAIN" ]; then
  echo "REFUSING: asked for '$NETWORK' (chain $WANT_CHAIN) but $RPC answers chain $GOT_CHAIN." >&2
  exit 1
fi

DEPLOYER=$(cast wallet address --private-key "$KEY")
BAL=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
echo "network  $NETWORK (chain $GOT_CHAIN)"
echo "deployer $DEPLOYER"
echo "balance  $(python3 -c "print($BAL/1e18)")"
echo "factory  $DOKU_FACTORY"
echo "ceiling  $(python3 -c "print($DOKU_MAX_ZAP_VALUE_WEI/1e18)") MON per zap"

# Monad keeps a 10 MON reserve: a transaction that would end a balance below it reverts unless it
# is an "emptying transaction". A deploy key sitting just above the line looks funded and cannot
# broadcast, which is a confusing failure to hit halfway through.
# https://docs.monad.xyz/developer-essentials/reserve-balance
if [ "$NETWORK" != "local" ]; then
  FLOOR=11000000000000000000
  if [ "$SIMULATE" -eq 0 ] && [ "$(python3 -c "print(1 if $BAL < $FLOOR else 0)")" = "1" ]; then
    echo "NOT ENOUGH. Monad reserves 10 MON; a deploy needs headroom above it." >&2
    exit 1
  fi
fi

FORGE_FLAGS=(--rpc-url "$RPC" --private-key "$KEY" --non-interactive --slow)
FORGE_FLAGS+=(--disable-code-size-limit)
# Monad charges gas at the LIMIT rather than at usage, so a generous estimate costs exactly what
# the transaction needed and a tight one reverts. See the same note in deploy.sh.
FORGE_FLAGS+=(--gas-estimate-multiplier 200)
if [ "$SIMULATE" -eq 0 ]; then FORGE_FLAGS+=(--broadcast); fi

LOGFILE=$(mktemp)
trap 'rm -f "$LOGFILE"' EXIT
forge script script/DeployZapRouter.s.sol:DeployZapRouter "${FORGE_FLAGS[@]}" | tee "$LOGFILE"

if [ "$SIMULATE" -eq 1 ]; then
  echo
  echo "simulated only — deployments/$NETWORK.json not written"
  exit 0
fi

python3 - "$NETWORK" "$GOT_CHAIN" "deployments/$NETWORK.json" "$LOGFILE" <<'PY'
import json, os, re, sys

network, chain_id, path, logfile = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
log = open(logfile).read()

def find(label, pattern):
    m = re.search(label + r"\s+(" + pattern + ")", log)
    return m.group(1) if m else None

router = find("DOKU_ZAP_ROUTER", r"0x[0-9a-fA-F]{40}")
if not router:
    sys.exit("no router address in the deployment log; deployments/%s.json not touched" % network)

# Merged, never replaced. The protocol's own addresses, the quote set, the services and the notes
# are not in this log and a periphery deployment must not drop them.
record = json.load(open(path)) if os.path.exists(path) else {}
record["network"] = network
record["chainId"] = chain_id
record.setdefault("contracts", {})
record["zapRouter"] = {
    "address": router,
    "maxZapValueWei": find("ZAP_MAX_VALUE_WEI", r"\d+"),
    "owner": find("ZAP_OWNER", r"0x[0-9a-fA-F]{40}"),
    "factory": find("ZAP_FACTORY", r"0x[0-9a-fA-F]{40}"),
    "deployedAtBlock": int(find("START_BLOCK", r"\d+") or 0),
}

with open(path, "w") as handle:
    json.dump(record, handle, indent=2, ensure_ascii=False)
    handle.write("\n")
print("recorded " + path)
PY

cat <<AFTER

NOT FINISHED. The router is on chain and nothing uses it yet:
  1. Set NEXT_PUBLIC_ZAP_ROUTER on the web service and redeploy it. Until then the
     pay-with-MON control does not render at all.
  2. Buy something small with MON on a non-MON market and watch it land.
AFTER
