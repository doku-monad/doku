#!/usr/bin/env bash
#
# Watch the quote assets that are ALREADY registered. Run this on a schedule.
#
#   ./script/watch-quote-assets.sh mainnet                 the scheduled run
#   ./script/watch-quote-assets.sh mainnet --init          create the baseline (once)
#   ./script/watch-quote-assets.sh mainnet --accept         re-baseline, after a human looked
#   ./script/watch-quote-assets.sh testnet
#
# Same contract as `deploy.sh`, `deploy-zap.sh` and `screen-quote-asset.sh`: the network is a
# required argument, the node is asked what chain it actually is, and a disagreement aborts.
# NOTHING IS BROADCAST and no key is read.
#
# WHY THIS EXISTS. `screen-quote-asset.sh` proves an asset has no transfer callback at REGISTRATION
# TIME, and that is the only defence there is — `DokuFactory._firstBuy` double-books the launch's
# first buy for any quote asset that calls the payer back inside `transferFrom`, the factory is
# immutable, and neither `setEnabled(false)` nor `pause()` is retroactive. But four of the seven
# registered assets are EIP-1967 proxies. **One `upgradeTo` and yesterday's pass is worthless**, and
# that upgrade is an event on the token, in a contract nobody here indexes. A pre-registration
# screen structurally cannot cover it. This can.
#
# It looks at three doors, because the risk arrives through any of them:
#   1. an asset that is registered changing its code — the proxy's implementation, beacon or admin
#      slot, or the codehash of anything in that chain;
#   2. an asset being registered that never went through the screen at all. `QuoteRegistry` has no
#      enumeration, so that one is found by scanning `QuoteAssetRegistered` logs;
#   3. THE UPGRADE KEY ITSELF — who can perform that `upgradeTo`, and whether they have started.
# Anything that moves is then RE-SCREENED, so the answer is "it changed AND it now calls the payer
# back" rather than only "it changed".
#
# DOOR 3 IS THE ONLY ONE THAT CAN SPEAK BEFORE THE FACT, and only for some assets. Doors 1 and 2
# both report an upgrade that has already landed, which is the last possible moment: every market
# launched in that asset from that block on already carries the hole. What can be seen earlier is a
# property of the key, and it is read off the chain per asset rather than assumed:
#
#   a TIMELOCK must `schedule()` before it can `execute()`. That is a public log emitted minDelay
#   seconds ahead of the upgrade, and the run reports the operation, its target and how long is
#   left. On generation 3 exactly ONE asset (cbBTC) has this shape.
#
#   a SAFE collects its signatures OFF chain. There is no queue, no delay and no proposal event;
#   the first thing on chain is the transaction that has already done it. USDT0 and XAUt0 — TWO
#   live assets behind ONE 3-of-5 — have this shape, and for them this monitor reports after the
#   fact and no monitor of any design could do better from chain state alone.
#
#   NO UPGRADE PATH AT ALL is also an answer, and WETH's: an empty admin slot over an
#   implementation that exposes no upgrade entrypoint. Nothing to warn about, and the alarm is if
#   that ever stops being true.
#
# Every run prints that classification per asset, whether or not anything moved, so nobody reads a
# green run as uniform coverage. And a change of the key — an admin transfer, an ownership
# handover, a signer added, the timelock delay shortened — is an alarm in its own right, because it
# is strictly upstream of the upgrade somebody is preparing to make.
#
# EXIT CODES, which are the whole interface for a scheduler:
#   0  all clear — every asset matches the baseline and the registered set is the baselined set
#   1  SOMETHING MOVED, or an asset the re-screen refuses. Read the report; act on the runbook.
#   2  usage
#   3  COULD NOT LOOK — an RPC call failed, the chain answered wrong, the baseline is missing, the
#      observation stopped halfway. Never confused with 0. A monitor that reports "all clear"
#      because it could not see is worse than no monitor.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi
INIT=0
ACCEPT=0
SCAN=1
SCREEN=1
FROM_OVERRIDE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --init)   INIT=1 ;;
    --accept) ACCEPT=1 ;;
    --no-registry-scan) SCAN=0 ;;
    --no-screen) SCREEN=0 ;;
    --from-block) shift; FROM_OVERRIDE="${1:-}" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$NETWORK" in
  local)   WANT_CHAIN=31337 ;;
  testnet) WANT_CHAIN=10143 ;;
  mainnet) WANT_CHAIN=143 ;;
  *)
    cat >&2 <<'USAGE'
usage: script/watch-quote-assets.sh <local|testnet|mainnet> [options]

  --init                create deployments/<network>.quote-assets.json from the chain, screening
                        every registered asset on the way. Do this once; commit the file.
  --accept              rewrite the baseline to what the chain says NOW. For after a change has
                        been investigated — it REFUSES to write over an asset the screen just
                        refused, because that would launder a refusal into tomorrow's clean run.
  --no-registry-scan    skip the QuoteAssetRegistered log scan. Faster, and it means a newly
                        registered asset will not be seen. Says so in the report.
  --no-screen           do not re-screen what moved. Reports the change and nothing about it.
  --from-block N        scan the registry from N rather than from where the baseline left off.

The network is required and is never inferred: the answer is about the bytecode deployed on that
chain at this block.

Required in the environment (or .env):
  MONAD_RPC_URL           for mainnet
  MONAD_TESTNET_RPC_URL   for testnet
  LOCAL_RPC_URL           for local (defaults to http://127.0.0.1:8545)

Nothing is broadcast and no private key is used.
USAGE
    exit 2 ;;
esac

if [ "$INIT" -eq 1 ] && [ "$ACCEPT" -eq 1 ]; then
  echo "REFUSING: --init and --accept mean different things and cannot be combined." >&2
  exit 2
fi

if [ -f ./.env ]; then set -a && . ./.env && set +a; fi

case "$NETWORK" in
  local)   RPC="${LOCAL_RPC_URL:-http://127.0.0.1:8545}" ;;
  testnet) RPC="${MONAD_TESTNET_RPC_URL:?MONAD_TESTNET_RPC_URL is not set}" ;;
  mainnet) RPC="${MONAD_RPC_URL:?MONAD_RPC_URL is not set}" ;;
esac

if ! GOT_CHAIN=$(cast chain-id --rpc-url "$RPC" 2>&1); then
  echo "COULD NOT LOOK: the node at $RPC did not answer cast chain-id: $GOT_CHAIN" >&2
  exit 3
fi
if [ "$GOT_CHAIN" != "$WANT_CHAIN" ]; then
  echo "REFUSING: asked for '$NETWORK' (chain $WANT_CHAIN) but $RPC answers chain $GOT_CHAIN." >&2
  exit 3
fi

DEPLOY_JSON="deployments/$NETWORK.json"
BASELINE="deployments/$NETWORK.quote-assets.json"
ENGINE="script/watch-quote-assets.py"

if [ ! -f "$DEPLOY_JSON" ]; then
  echo "COULD NOT LOOK: $DEPLOY_JSON does not exist, so there is no registry address to watch." >&2
  exit 3
fi
if [ ! -f "$BASELINE" ] && [ "$INIT" -eq 0 ]; then
  cat >&2 <<EOF
COULD NOT LOOK: $BASELINE does not exist.

There is nothing to compare against, and this script will NOT quietly invent a baseline out of
whatever the chain says today — that is how a monitor comes back green over a change it never saw.
Create it deliberately, look at what it wrote, and commit it:

  ./script/watch-quote-assets.sh $NETWORK --init
EOF
  exit 3
fi

# The addresses come from the deployment record and the chain, never from a script constant.
REGISTRY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contracts"]["QuoteRegistry"])' "$DEPLOY_JSON")
FACTORY=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["contracts"]["DokuFactory"])' "$DEPLOY_JSON")
DEPLOY_BLOCK=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("startBlock",0)))' "$DEPLOY_JSON")

# Where the log scan starts. From the deploy block on a fresh baseline; otherwise from where the
# last clean run left off, minus an overlap so a reorg at the tip cannot drop a registration into
# the gap between two runs.
#
# TWO cursors are consulted and the EARLIER one wins. `provenThroughBlock` is how far the registered
# set has been proven; `keysProvenThroughBlock` is how far the upgrade keys have been watched for a
# queued upgrade. They come apart exactly once, and it matters: `--init` records who the keys are
# but cannot have watched them, so the first scheduled run after it backfills the key range in one
# pass. Taking the max, or one cursor for both, would step over that range and never look at it.
if [ -n "$FROM_OVERRIDE" ]; then
  FROM_BLOCK="$FROM_OVERRIDE"
elif [ "$INIT" -eq 1 ]; then
  FROM_BLOCK="$DEPLOY_BLOCK"
else
  FROM_BLOCK=$(python3 -c '
import json, sys
baseline, floor = json.load(open(sys.argv[1])), int(sys.argv[2])
registry = baseline.get("registry", {})
cursors = [registry.get("provenThroughBlock"), registry.get("keysProvenThroughBlock", floor)]
if any(c is None for c in cursors):
    print(floor)
else:
    print(max(floor, min(int(c) for c in cursors) - 200))
' "$BASELINE" "$DEPLOY_BLOCK")
fi

# The addresses that can upgrade a registered asset, as the baseline recorded them. Empty on
# --init, and empty for a baseline written before upgrade keys were watched at all; the report says
# so in both cases rather than printing a scan line that looks complete.
AUTH_ADDRS=""
if [ -f "$BASELINE" ]; then
  AUTH_ADDRS=$(python3 "$ENGINE" keys --baseline "$BASELINE")
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

SCAN_ARGS=""
if [ "$SCAN" -eq 1 ]; then
  # `QuoteRegistry` has no enumeration: the registered set exists only as logs, and Monad's RPC caps
  # eth_getLogs at a 100-block range. The engine fans it out and refuses to return a partial answer.
  #
  # The same pass also reads every event on every upgrade key, because the cost here is the number
  # of 100-block requests and not the number of addresses or topics inside each one. That is what
  # makes an upgrade QUEUED on a timelock — the only advance warning any of these assets can give —
  # free to watch rather than a second monitor nobody runs.
  if ! python3 "$ENGINE" scan --rpc "$RPC" --registry "$REGISTRY" --from-block "$FROM_BLOCK" \
      --addresses "$AUTH_ADDRS" > "$WORK/scan.json"; then
    echo "COULD NOT LOOK: the QuoteAssetRegistered scan failed. No verdict is being reported." >&2
    exit 3
  fi
  SCAN_ARGS="--scan $WORK/scan.json"
fi

INIT_ARG=""
if [ "$INIT" -eq 1 ]; then INIT_ARG="--init"; fi

# shellcheck disable=SC2086
WATCHLIST=$(python3 "$ENGINE" plan --baseline "$BASELINE" --deployments "$DEPLOY_JSON" $SCAN_ARGS $INIT_ARG)
if [ -z "$WATCHLIST" ]; then
  echo "COULD NOT LOOK: no assets to watch. Neither the baseline nor the chain names any." >&2
  exit 3
fi

if ! forge script script/WatchQuoteAssets.s.sol:WatchQuoteAssets \
    --sig 'run(address,address[])' "$REGISTRY" "[$WATCHLIST]" \
    --rpc-url "$RPC" --non-interactive > "$WORK/forge.log" 2>&1; then
  echo "COULD NOT LOOK: the on-chain observation failed. forge said:" >&2
  tail -30 "$WORK/forge.log" >&2
  exit 3
fi
sed -n 's/^ *\(WATCH .*\)$/\1/p' "$WORK/forge.log" > "$WORK/obs.txt"

# Context for the triage, not part of the verdict — but read off the chain rather than assumed,
# because "is the factory still open" is the first question anyone asks when this fires.
if ! PAUSED=$(cast call "$FACTORY" "paused()(bool)" --rpc-url "$RPC" 2>&1); then
  echo "COULD NOT LOOK: DokuFactory at $FACTORY did not answer paused(): $PAUSED" >&2
  exit 3
fi

set +e
# shellcheck disable=SC2086
python3 "$ENGINE" diff --network "$NETWORK" --baseline "$BASELINE" --deployments "$DEPLOY_JSON" \
  --obs "$WORK/obs.txt" --out-rescreen "$WORK/rescreen.txt" \
  --factory "$FACTORY" --factory-paused "$PAUSED" $SCAN_ARGS $INIT_ARG
DIFF_RC=$?
set -e
if [ "$DIFF_RC" -eq 3 ]; then exit 3; fi

# ---------------------------------------------------------------------------- the re-screen

SCREEN_RC=0
: > "$WORK/screens.txt"
if [ "$SCREEN" -eq 1 ] && [ -s "$WORK/rescreen.txt" ]; then
  echo
  echo "--- re-screening $(wc -l < "$WORK/rescreen.txt" | tr -d ' ') asset(s): the question is not whether it changed but"
  echo "--- whether it now calls the payer back. Same engine as script/screen-quote-asset.sh."
  while read -r ASSET; do
    [ -n "$ASSET" ] || continue
    if ./script/screen-quote-asset.sh "$NETWORK" "$ASSET"; then
      echo "$ASSET PASS" >> "$WORK/screens.txt"
    else
      echo "$ASSET REFUSED" >> "$WORK/screens.txt"
      SCREEN_RC=1
    fi
  done < "$WORK/rescreen.txt"
elif [ "$SCREEN" -eq 0 ] && [ -s "$WORK/rescreen.txt" ]; then
  echo
  echo "NOT RE-SCREENED (--no-screen). The report above says what moved and nothing about what it does now."
fi

# ---------------------------------------------------------------------------------- the write

if [ "$INIT" -eq 1 ] || [ "$ACCEPT" -eq 1 ]; then
  set +e
  # shellcheck disable=SC2086
  python3 "$ENGINE" commit --network "$NETWORK" --baseline "$BASELINE" --deployments "$DEPLOY_JSON" \
    --obs "$WORK/obs.txt" --screens "$WORK/screens.txt" --deploy-block "$DEPLOY_BLOCK" $SCAN_ARGS
  COMMIT_RC=$?
  set -e
  if [ "$COMMIT_RC" -ne 0 ]; then exit 1; fi
elif [ "$DIFF_RC" -eq 0 ] && [ "$SCREEN_RC" -eq 0 ]; then
  # shellcheck disable=SC2086
  python3 "$ENGINE" commit --network "$NETWORK" --baseline "$BASELINE" --deployments "$DEPLOY_JSON" \
    --obs "$WORK/obs.txt" --deploy-block "$DEPLOY_BLOCK" --cursor-only $SCAN_ARGS
fi

if [ "$DIFF_RC" -ne 0 ] || [ "$SCREEN_RC" -ne 0 ]; then
  cat <<'AFTER'

WHAT TO DO NOW, in this order. Nothing below is retroactive; read docs/doku/deployments.md,
"Watching the quote assets after you have registered them".

  0. If the alarm says QUEUED, NOT YET EXECUTED, nothing has happened yet and there is a clock.
     That is the good case and the only one with room in it. setEnabled(asset,false) NOW costs
     nothing if the queued operation turns out to be routine — it closes new launches in that asset
     and is reversible — and it is the whole value of the warning if it does not. Read the target,
     the selector and the id in the alarm; decode the operation; decide before the timer expires.
  1. If the re-screen REFUSED the asset, the finding is LIVE. QuoteRegistry.setEnabled(asset,false)
     stops the NEXT launch in it. DokuFactory.pause() stops every launch. Neither reaches a market
     that already exists.
  2. Then triage the markets already launched in that asset. They keep trading and they keep the
     hole; that is the actual incident, and the switches above are not it.
  3. If the alarm is a change of the KEY rather than of the code — an admin transfer, an ownership
     handover, a signer added, a role granted, the timelock delay shortened — no market is exposed
     yet. Find out who holds it now. A key that moved to an address nobody can identify, or a
     timelock delay that just got shorter, is a reason to close new launches in that asset before
     finding out what it is for.
  4. If the change is benign, re-baseline deliberately:
       ./script/watch-quote-assets.sh <network> --accept
AFTER
  exit 1
fi
