#!/usr/bin/env bash
# Assert DokuToken's storage layout is EXACTLY the committed one, and that the generation-6 field
# is the LAST slot — i.e. everything generation 5 laid out is untouched and the new string is
# appended after it.
#
# Clones share no storage with their implementation, so this is discipline rather than an upgrade
# safety requirement: it makes an accidental reordering (a field inserted mid-struct, a type
# widened) fail loudly in CI instead of being discovered by whoever next reads a slot by hand.
# Same shape as check-abi.sh, for the same reasons.
#
# Usage:  script/check-token-layout.sh            verify
#         script/check-token-layout.sh --update   rewrite the baseline after a DELIBERATE change
set -uo pipefail
cd "$(dirname "$0")/.."

TARGET="src/DokuToken.sol:DokuToken"
BASELINE="data/token-storage-layout.json"

layout() {
  forge inspect "$TARGET" storage-layout --json 2>/dev/null \
    | python3 -c '
import json,sys
d=json.load(sys.stdin)
rows=[{"label":s["label"],"slot":int(s["slot"]),"offset":s["offset"],"type":d["types"][s["type"]]["label"]} for s in d["storage"]]
print(json.dumps(rows,indent=2))'
}

if [[ "${1:-}" == "--update" ]]; then
  layout > "$BASELINE"
  echo "baseline written: $BASELINE"
  exit 0
fi

current="$(layout)"
if [[ -z "$current" ]]; then echo "could not read the layout (build first)"; exit 2; fi
if ! diff <(echo "$current") "$BASELINE" >/dev/null; then
  echo "DokuToken storage layout differs from $BASELINE:"
  diff <(echo "$current") "$BASELINE"
  exit 1
fi
last="$(echo "$current" | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1]["label"])')"
if [[ "$last" != "_metadataURI" ]]; then
  echo "the generation-6 field must be the last slot, found: $last"
  exit 1
fi
echo "DokuToken storage layout unchanged; _metadataURI is the last slot"
