#!/usr/bin/env bash
#
# Verify one network's DOKU deployment on the explorers, from the record it wrote.
#
#   ./script/verify.sh mainnet                 Sourcify (MonadVision) and, with a key, MonadScan
#   ./script/verify.sh mainnet --sourcify      MonadVision only (no key needed)
#   ./script/verify.sh mainnet --monadscan     MonadScan only (needs ETHERSCAN_API_KEY in .env)
#
# WHAT IS VERIFIED, AND WHY THIS IS NOT A PER-LAUNCH JOB.
#
# Every launch deploys two EIP-1167 clones (token + curve), 45 bytes each, delegating to the
# implementations the factory created in its constructor. A clone has no source to submit; what
# makes its explorer page readable is the IMPLEMENTATION being verified — once per generation,
# here — plus, on MonadScan, the clone being marked as a proxy of it, which the indexer does per
# launch (indexer/src/verification/). MonadVision resolves EIP-1167 clones from bytecode by itself.
#
# Source, compiler and optimiser settings come from foundry.toml exactly as the deploy compiled
# them (forge reads the same profile). Constructor arguments come from the broadcast record of the
# deploy, never retyped; contracts created inside another constructor (the two implementations,
# the SeedLocker) get theirs from the chain.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"; if [ "$#" -gt 0 ]; then shift; fi
DO_SOURCIFY=1; DO_MONADSCAN=1
for arg in "$@"; do
  case "$arg" in
    --sourcify) DO_MONADSCAN=0 ;;
    --monadscan) DO_SOURCIFY=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
case "$NETWORK" in
  mainnet) CHAIN=143 ;;
  testnet) CHAIN=10143 ;;
  *) echo "usage: script/verify.sh <mainnet|testnet> [--sourcify|--monadscan]" >&2; exit 2 ;;
esac
if [ -f ./.env ]; then set -a && . ./.env && set +a; fi
RPC="${MONAD_RPC_URL:?MONAD_RPC_URL is not set}"
RECORD="deployments/$NETWORK.json"
SOURCIFY_URL="${SOURCIFY_API_URL:-https://sourcify-api-monad.blockvision.org/}"
MONADSCAN_URL="${MONADSCAN_API_URL:-https://api.etherscan.io/v2/api}"

j() { python3 -c "import json,sys; d=json.load(open('$RECORD')); print(eval(sys.argv[1]))" "$1"; }
FACTORY=$(j "d['contracts']['DokuFactory']")
GRADUATION=$(j "d['contracts']['DokuGraduation']")
HOOK=$(j "d['contracts']['DokuHook']")
REGISTRY=$(j "d['contracts']['QuoteRegistry']")
SINK=$(j "d['contracts']['CreatorSink']")
LOCKER=$(j "d['contracts']['SeedLocker']")
ZAP=$(j "d['contracts'].get('ZapRouter','')")
POOL_MANAGER=$(j "d['uniswapV4']['poolManager']")
POSITION_MANAGER=$(j "d['uniswapV4']['positionManager']")
PERMIT2=$(j "d['uniswapV4']['permit2']")
TOKEN_IMPL=$(cast call "$FACTORY" 'tokenImplementation()(address)' --rpc-url "$RPC")
CURVE_IMPL=$(cast call "$FACTORY" 'curveImplementation()(address)' --rpc-url "$RPC")

# Constructor arguments, from the broadcast that deployed each contract: the exact values the
# chain saw, ABI-encoded for the explorer.
args_of() { # <broadcast file> <contractName>
  python3 - "$1" "$2" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
for t in r['transactions']:
    if t.get('contractName')==sys.argv[2] and t.get('transactionType') in ('CREATE','CREATE2'):
        print(' '.join(t.get('arguments') or [])); break
PY
}
enc() { # <signature> <args...>
  local sig="$1"; shift
  if [ "$#" -eq 0 ]; then echo ""; else cast abi-encode "$sig" "$@"; fi
}
DEPLOY_BC="broadcast/DeployDoku.s.sol/$CHAIN/run-latest.json"
ZAP_BC="broadcast/DeployZapRouter.s.sol/$CHAIN/run-latest.json"
# shellcheck disable=SC2046
ARGS_FACTORY=$(enc 'constructor(address,address,address,address,address,uint256)' $(args_of "$DEPLOY_BC" DokuFactory))
# shellcheck disable=SC2046
ARGS_GRADUATION=$(enc 'constructor(address,address,address,address,address)' $(args_of "$DEPLOY_BC" DokuGraduation))
# shellcheck disable=SC2046
ARGS_HOOK=$(enc 'constructor(address,address,address,address)' $(args_of "$DEPLOY_BC" DokuHook))
# shellcheck disable=SC2046
ARGS_REGISTRY=$(enc 'constructor(address)' $(args_of "$DEPLOY_BC" QuoteRegistry))
# shellcheck disable=SC2046
ARGS_SINK=$(enc 'constructor(address)' $(args_of "$DEPLOY_BC" CreatorSink))
ARGS_LOCKER=$(enc 'constructor(address,address,address)' "$POSITION_MANAGER" "$HOOK" "$POOL_MANAGER")
ARGS_ZAP=""
if [ -n "$ZAP" ] && [ -f "$ZAP_BC" ]; then
  # shellcheck disable=SC2046
  ARGS_ZAP=$(enc 'constructor(address,address,address,uint256)' $(args_of "$ZAP_BC" ZapRouter))
fi

# name|address|path:Contract|encoded ctor args
TARGETS=(
  "DokuToken (implementation)|$TOKEN_IMPL|src/DokuToken.sol:DokuToken|"
  "BondingCurve (implementation)|$CURVE_IMPL|src/BondingCurve.sol:BondingCurve|"
  "DokuFactory|$FACTORY|src/DokuFactory.sol:DokuFactory|$ARGS_FACTORY"
  "DokuGraduation|$GRADUATION|src/DokuGraduation.sol:DokuGraduation|$ARGS_GRADUATION"
  "DokuHook|$HOOK|src/v4/DokuHook.sol:DokuHook|$ARGS_HOOK"
  "QuoteRegistry|$REGISTRY|src/QuoteRegistry.sol:QuoteRegistry|$ARGS_REGISTRY"
  "CreatorSink|$SINK|src/sinks/CreatorSink.sol:CreatorSink|$ARGS_SINK"
  "SeedLocker|$LOCKER|src/SeedLocker.sol:SeedLocker|$ARGS_LOCKER"
)
if [ -n "$ZAP" ]; then TARGETS+=("ZapRouter|$ZAP|src/ZapRouter.sol:ZapRouter|$ARGS_ZAP"); fi

echo "network  $NETWORK (chain $CHAIN)"
echo "record   $RECORD"
FAILED=0
verify() { # <verifier> <name> <address> <contract> <args> [extra flags...]
  local verifier="$1" name="$2" address="$3" contract="$4" args="$5"; shift 5
  local flags=(--chain "$CHAIN" --verifier "$verifier" --watch --retries 5 --delay 10 "$@")
  if [ -n "$args" ]; then flags+=(--constructor-args "$args"); fi
  echo "--- $verifier: $name @ $address"
  if forge verify-contract "$address" "$contract" "${flags[@]}"; then
    echo "    ok"
  else
    echo "    FAILED: $name on $verifier" >&2; FAILED=1
  fi
}
for t in "${TARGETS[@]}"; do
  IFS='|' read -r name address contract args <<< "$t"
  if [ "$DO_SOURCIFY" -eq 1 ]; then
    verify sourcify "$name" "$address" "$contract" "$args" --verifier-url "$SOURCIFY_URL"
  fi
  if [ "$DO_MONADSCAN" -eq 1 ]; then
    if [ -z "${ETHERSCAN_API_KEY:-}" ]; then
      echo "--- monadscan: skipped, ETHERSCAN_API_KEY is not set"; DO_MONADSCAN=0
    else
      # forge's etherscan verifier has no URL for chain 143 and ignores --verifier-url for it, so
      # the submission is made by script/verify-monadscan.py from forge's own standard JSON.
      echo "--- monadscan: $name @ $address"
      if MONADSCAN_API_URL="$MONADSCAN_URL" python3 script/verify-monadscan.py "$address" "$contract" "$args"; then
        echo "    ok"
      else
        echo "    FAILED: $name on monadscan" >&2; FAILED=1
      fi
    fi
  fi
done
if [ "$FAILED" -ne 0 ]; then echo "some contracts did not verify" >&2; exit 1; fi
echo "done"
