#!/usr/bin/env bash
#
# Screen a candidate quote asset before `QuoteRegistry.register` ever sees it.
#
#   ./script/screen-quote-asset.sh mainnet 0xToken
#   ./script/screen-quote-asset.sh mainnet 0xA 0xB 0xC     every one of them, one verdict each
#   ./script/screen-quote-asset.sh testnet 0xToken
#
# Same contract as `deploy.sh` and `deploy-zap.sh`: the network is a required argument, the node is
# asked what chain it actually is, and a disagreement aborts. A screen run against the wrong chain
# reads the wrong bytecode and its verdict means nothing, which is the one failure mode worth
# refusing outright.
#
# NOTHING IS BROADCAST and no key is read. The script forks the named chain into memory, deploys
# throwaway probes there, and runs a real `transferFrom` between them to find out whether the token
# calls its payer back. See script/ScreenQuoteAsset.s.sol for why that one question is the one that
# matters.
#
# Exit code is the gate: 0 means every asset passed, 1 means at least one was refused.
#
# THIS IS THE ONLY CONTROL. DokuFactory is immutable, and neither `setEnabled(false)` nor `pause()`
# is retroactive — a market already launched in a bad quote asset keeps trading and keeps its hole
# for the rest of its life. Run this BEFORE, or do not run it at all.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
if [ "$#" -gt 0 ]; then shift; fi

case "$NETWORK" in
  local)   WANT_CHAIN=31337 ;;
  testnet) WANT_CHAIN=10143 ;;
  mainnet) WANT_CHAIN=143 ;;
  *)
    cat >&2 <<'USAGE'
usage: script/screen-quote-asset.sh <local|testnet|mainnet> <asset> [asset...]

The network is required and is never inferred, because the answer depends on the bytecode actually
deployed on that chain. `0x0000000000000000000000000000000000000000` is the native asset (MON).

Required in the environment (or .env):
  MONAD_RPC_URL           for mainnet
  MONAD_TESTNET_RPC_URL   for testnet
  LOCAL_RPC_URL           for local (defaults to http://127.0.0.1:8545)

Nothing is broadcast and no private key is used.
USAGE
    exit 2 ;;
esac

if [ "$#" -lt 1 ]; then
  echo "REFUSING: no asset given. usage: script/screen-quote-asset.sh $NETWORK <asset> [asset...]" >&2
  exit 2
fi

if [ -f ./.env ]; then set -a && . ./.env && set +a; fi

case "$NETWORK" in
  local)   RPC="${LOCAL_RPC_URL:-http://127.0.0.1:8545}" ;;
  testnet) RPC="${MONAD_TESTNET_RPC_URL:?MONAD_TESTNET_RPC_URL is not set}" ;;
  mainnet) RPC="${MONAD_RPC_URL:?MONAD_RPC_URL is not set}" ;;
esac

GOT_CHAIN=$(cast chain-id --rpc-url "$RPC")
if [ "$GOT_CHAIN" != "$WANT_CHAIN" ]; then
  echo "REFUSING: asked for '$NETWORK' (chain $WANT_CHAIN) but $RPC answers chain $GOT_CHAIN." >&2
  exit 1
fi

echo "network  $NETWORK (chain $GOT_CHAIN)"
echo "assets   $#"
echo

# A string, not an array: bash 3.2 (which is what /bin/bash is on macOS) treats an empty array as
# unset, and `set -u` then kills the script on the success path.
FAILED=""
FAILED_N=0
for ASSET in "$@"; do
  # `forge script` reverts on a refusal, so the exit code carries the verdict. The logs are printed
  # either way — which is the point of reading the report rather than the exit code alone, because
  # a WARNING does not fail and can still be the thing that matters.
  if forge script script/ScreenQuoteAsset.s.sol:ScreenQuoteAsset \
      --sig 'run(address)' "$ASSET" \
      --rpc-url "$RPC" \
      --non-interactive 2>&1 | sed -n '/=== DOKU quote-asset screen ===/,$p' | sed 's/^  //'; then
    :
  else
    FAILED="$FAILED $ASSET"
    FAILED_N=$((FAILED_N + 1))
  fi
  echo
done

if [ "$FAILED_N" -gt 0 ]; then
  echo "REFUSED $FAILED_N of $#:"
  for a in $FAILED; do echo "  $a"; done
  echo
  echo "Do not register these. And if one of them is ALREADY registered: disabling it stops the next"
  echo "launch and reaches no market that exists — every market launched in it before you noticed is"
  echo "unrecoverable. See docs/doku/deployments.md, 'Screening a quote asset'."
  exit 1
fi

echo "all $# passed. Read the WARNING lines anyway — they are the things the screen can see but"
echo "cannot decide for you, chiefly whether an upgradeable token's key holder is someone you trust"
echo "with every market ever priced in it."
