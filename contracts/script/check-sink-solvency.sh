#!/usr/bin/env bash
#
# Is `CreatorSink` solvent, per quote asset? Run it on a schedule.
#
# WHY THIS EXISTS. `CreatorSink` is SHARED by every market and keeps ONE undifferentiated balance
# per quote asset — `claimable` is keyed `(who, quote)` with no per-market segregation, and `claim`
# pays out of the whole balance. So a shortfall in one quote is borne by whoever claims LAST, in any
# market priced in that asset, not by the market that caused it. The ledger is first-come-first-
# served and there is no fair-settlement path, no rescue, and no owner who could add one: the
# contract is immutable.
#
# Two ways a shortfall opens (docs/doku/audit/2026-09-11-full/creator-sink-shared-solvency.md):
#
#   `credit` books what it is TOLD while `pull` books what ARRIVED — the same defect as internal
#   finding #8, fixed in `BondingCurve._pullAndBuy` and never carried across to here; and
#
#   a quote whose balance SHRINKS after the fact. That one needs no over-credit at all and only one
#   precondition, and `deployments.md` already records an operator-triggered rebase as something the
#   registration screen cannot detect.
#
# So this is the detection half. There is no prevention half, which is the point.
#
# WHAT TO DO IF IT FIRES. Not a switch — speed. Tell every affected recipient to `claim`
# immediately, because the ledger is FCFS and the last claimant eats the shortfall. Then work out
# which quote shrank and stop new markets being launched in it: `QuoteRegistry.setEnabled(asset,
# false)`. Neither is retroactive for money already booked.
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="${1:-}"
case "$NETWORK" in
  mainnet) WANT_CHAIN=143 ;;
  testnet) WANT_CHAIN=10143 ;;
  *) echo "usage: script/check-sink-solvency.sh <mainnet|testnet>" >&2; exit 2 ;;
esac
[ -f ./.env ] && { set -a; . ./.env; set +a; }
RPC="${MONAD_RPC_URL:?MONAD_RPC_URL is not set}"

GOT=$(cast chain-id --rpc-url "$RPC")
if [ "$GOT" != "$WANT_CHAIN" ]; then
  echo "REFUSING: asked for '$NETWORK' (chain $WANT_CHAIN) but the node answers $GOT." >&2; exit 3
fi

SINK=$(python3 -c "import json;print(json.load(open('deployments/$NETWORK.json'))['contracts']['CreatorSink'])")
FROM=$(python3 -c "import json;print(json.load(open('deployments/$NETWORK.json'))['startBlock'])")
HEAD=$(cast block-number --rpc-url "$RPC")
echo "CreatorSink $SINK   blocks $FROM..$HEAD   chain $GOT"
echo

CREDITED=$(cast sig-event "Credited(address,address,uint256,uint8)")
CLAIMED=$(cast sig-event "Claimed(address,address,uint256)")

# Monad caps eth_getLogs at 100 blocks, so the whole history is ~3,000 chunks PER TOPIC and the
# count grows with the chain. How that scan is made is the difference between a monitor that runs
# nightly and one that exists only in this file:
#
#   one `cast` per chunk, serially       ~30 min
#   one `cast` per chunk, 8 in parallel   22 min   1,195 s of CPU
#   pooled HTTP, 8 in flight              14 min      73 s of CPU
#
# All three measured on the same history, at ~6,100 chunks. Spawning six thousand `cast` processes
# — each re-reading its config, re-resolving DNS and opening a fresh TLS session — was costing
# sixteen times the CPU, and moving the scan into the python that was already here to add the
# numbers up removed all of it.
#
# It bought less wall time than that suggests, and the reason is worth writing down rather than
# rediscovering: at 8 in flight the run sits at 9% CPU, so what is left is almost entirely waiting
# on the node — about 7 requests a second against a round trip near a second. Concurrency, not
# efficiency, is the remaining lever. `WORKERS` below is the knob; it is set against the provider's
# rate limit, and raising it past that trades a faster scan for retries, which is a bad trade for
# something whose whole job is to be believed.
#
# A chunk is retried before it is believed, and a chunk that never answers makes the whole run
# fail. It used to `exit 3` from inside a process substitution, which read as correct and was not:
# the exit killed that subshell, the parent carried on to python, and python saw an empty stream and
# printed "SOLVENT (empty ledger)". A monitor that answers SOLVENT because it could not look is
# worse than no monitor — it is the same words as the good news.

# The script goes in a FILE, not a heredoc. `python3 - <<'PY' < <(...)` looks like it feeds the
# heredoc to python and the process substitution to the script's stdin; it does not. Both redirect
# fd 0, the later one wins, and python ends up executing the LOG DATA as its own source — which is
# exactly what it did, reporting `SyntaxError: ---SPLIT---` and exiting 0 so nothing noticed.
PYF=$(mktemp -t doku-sink-solvency)
cat >"$PYF" <<'PY'
import collections, json, subprocess, sys, threading, time, urllib.request

sink, rpc = sys.argv[1], sys.argv[2]
FROM, HEAD = int(sys.argv[3]), int(sys.argv[4])
CREDITED, CLAIMED = sys.argv[5], sys.argv[6]

STEP = 100          # Monad's eth_getLogs ceiling. Not a tuning knob.
WORKERS = 8         # against the provider's ~50 req/s, leaving room for the retries below
TRIES = 5

_local = threading.local()

def _opener():
    """One HTTPS connection per worker, reused for every chunk that worker takes."""
    o = getattr(_local, "opener", None)
    if o is None:
        o = urllib.request.build_opener()
        _local.opener = o
    return o

def get_logs(topic, frm, to):
    body = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
        "params": [{"address": sink, "topics": [topic],
                    "fromBlock": hex(frm), "toBlock": hex(to)}],
    }).encode()
    last = ""
    for attempt in range(TRIES):
        try:
            req = urllib.request.Request(rpc, data=body, headers={"content-type": "application/json"})
            with _opener().open(req, timeout=30) as r:
                payload = json.load(r)
            if "error" in payload:
                last = str(payload["error"])
            else:
                return payload.get("result", [])
        except Exception as e:  # noqa: BLE001 — every failure here is retried the same way
            last = repr(e)
        time.sleep(attempt + 1)
    raise RuntimeError(f"eth_getLogs {frm}..{to} failed after {TRIES} tries: {last}")

def scan(topic):
    """Every chunk, or an exception. A partial scan must never reach the arithmetic below."""
    ranges = [(b, min(b + STEP - 1, HEAD)) for b in range(FROM, HEAD + 1, STEP)]
    out, err, lock = [None] * len(ranges), [], threading.Lock()
    nxt = iter(range(len(ranges)))

    def worker():
        while True:
            with lock:
                i = next(nxt, None)
            if i is None:
                return
            try:
                out[i] = get_logs(topic, *ranges[i])
            except Exception as e:  # noqa: BLE001
                with lock:
                    err.append(str(e))
                return

    ts = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
    for t in ts: t.start()
    for t in ts: t.join()
    if err:
        print("COULD NOT LOOK:", err[0], file=sys.stderr)
        print("No verdict.", file=sys.stderr)
        sys.exit(3)
    return [row for chunk in out for row in chunk]

def totals(rows):
    t = collections.Counter()
    for r in rows:
        quote = "0x" + r["topics"][2][-40:]
        # `amount` is the first word of data for both events.
        t[quote.lower()] += int(r["data"][2:66], 16)
    return t

print(f"scanning {(HEAD - FROM) // STEP + 1} chunks x 2 topics, {WORKERS} in flight...")
credited, claimed = totals(scan(CREDITED)), totals(scan(CLAIMED))
quotes = sorted(set(credited) | set(claimed))
if not quotes:
    print("no Credited/Claimed events yet — nothing is booked, so nothing can be short.")
    print("\nVERDICT: SOLVENT (empty ledger)")
    sys.exit(0)

bad = 0
print(f"{'quote':<44} {'booked':>26} {'held':>26}")
for q in quotes:
    booked = credited[q] - claimed[q]
    # Native MON is booked under address(0), which has no `balanceOf`. Ask the node for the
    # balance instead. And a `cast` that prints nothing must NOT read as a zero balance — zero is
    # the most alarming answer this script can give, so it has to be a fact, not a failure.
    if int(q, 16) == 0:
        cmd = ["cast","balance",sink,"--rpc-url",rpc]
    else:
        cmd = ["cast","call",q,"balanceOf(address)(uint256)",sink,"--rpc-url",rpc]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.split():
        print(f"COULD NOT READ the held balance of {q}: {r.stderr.strip() or 'empty reply'}", file=sys.stderr)
        sys.exit(3)
    held = int(r.stdout.split()[0])
    flag = "" if held >= booked else "   ** SHORT **"
    if held < booked: bad += 1
    print(f"{q:<44} {booked:>26} {held:>26}{flag}")

print()
if bad:
    print(f"VERDICT: INSOLVENT in {bad} quote(s).")
    print("  The ledger is first-come-first-served and the LAST claimant eats the shortfall.")
    print("  Tell every affected recipient to claim NOW. Then disable that quote for new launches.")
    sys.exit(1)
print("VERDICT: SOLVENT")
PY

python3 "$PYF" "$SINK" "$RPC" "$FROM" "$HEAD" "$CREDITED" "$CLAIMED"
