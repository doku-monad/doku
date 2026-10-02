#!/usr/bin/env python3
"""
The diff engine behind `script/watch-quote-assets.sh`. Not meant to be run by hand — the wrapper
owns the network argument, the chain-id guard and the exit codes, exactly as `deploy-zap.sh` does.

Four jobs, none of which belong in Solidity:

  scan    `QuoteRegistry` has NO enumeration — no `assetCount`, no array, nothing. The registered
          set exists only as `QuoteAssetRegistered` logs, so an asset registered without going
          through the screen can only be found by reading them. Monad's RPC caps `eth_getLogs` at a
          100-block range, so this fans the range out across a thread pool and refuses to report a
          result if ANY chunk failed. A gap in the scan is indistinguishable from a clean scan, and
          reporting one as the other is the failure mode this monitor exists to avoid.

          The same pass reads every event on every address that holds an upgrade key, because the
          cost here is the number of 100-block requests and not the number of addresses or topics
          in each one. That is what makes the ONE piece of advance warning that exists — an upgrade
          QUEUED on a timelock — free to watch rather than a second monitor nobody runs. For each
          queued operation it then asks the timelock's own `getTimestamp` whether it is still
          pending and when it becomes executable, because a log says an operation was scheduled and
          only the contract says whether it is still coming.

  keys    Prints the upgrade keys the baseline records, for the scan to watch. Silent when the
          baseline records none, so that a stale baseline shows up as a stated gap in the report
          rather than as a scan line that looks complete.

  diff    Compares an observation from `script/WatchQuoteAssets.s.sol` against the committed
          baseline and decides what kind of change it is. Two tiers, deliberately:

            ALARM   anything that changes how the asset behaves inside `DokuFactory._firstBuy`, or
                    changes who can change that: the asset's codehash, its EIP-1967 implementation,
                    beacon or admin slot, the implementation's codehash, its decimals, whether it is
                    registered at all — plus a registration this baseline has never seen, a move of
                    the registry's own owner, ANY move of the upgrade key (the admin, its owner, a
                    multisig's signer set or threshold, a timelock's delay), and an operation queued
                    on a timelock that is aimed at something DOKU depends on.
            NOTICE  the two owner knobs that cannot arm anything: `enabled` and `quoteTarget`.
                    `setEnabled(false)` is the RESPONSE to an alarm; a monitor that alarmed on its
                    own response would train its reader to ignore it. Also a Safe `ApproveHash`,
                    which is real and is the only thing a Safe shows before it acts, but names a
                    hash rather than a payload and so cannot be attributed without a human.

          Every run prints, per asset, what advance warning that asset can give — before the fact,
          or only after it. Three of the four live proxies can only be reported after the fact, and
          a report that did not say which was which would invite the reader to assume otherwise.

          A balance is not read at all. Neither is a total supply, an allowance or a price.

  commit  Writes the baseline. `--init` creates it; `--accept` re-baselines after a human has looked
          at a change; a clean run advances only the two cursors, and says so.

Exit codes are the wrapper's: 0 clear, 1 a change, 3 could not look.
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date

# `QuoteAssetRegistered(address indexed asset, uint8 decimals, uint256 quoteTarget)`.
REGISTERED_TOPIC = "0x3bf5794fe2e2aa0e77e0b6df34ba68fb25f10c62d426815ea6fcd901385b284f"

# ------------------------------------------------------------------------------ the earlier doors
#
# THE POINT OF THESE. The proxy diff above catches an upgrade AFTER it has landed, which is the last
# possible moment: every market launched in that asset from that block on already carries the hole.
# Two things can be seen EARLIER, and only two, and which of them exists is a property of the key:
#
#   1. A TIMELOCK has to `schedule()` before it can `execute()`, and that `CallScheduled` is a
#      public log emitted `minDelay` seconds ahead of the upgrade. That is a response window, not a
#      notification — it is the single most valuable fact in this file.
#   2. WHO HOLDS THE KEY changing — an admin transfer, an ownership handover, a signer added to the
#      multisig, a role granted on the timelock, the delay itself being shortened. That is not the
#      upgrade, but it is always upstream of the upgrade somebody is preparing to make, and it is
#      free to watch.
#
# Everything here is read from the same log pass as the registry scan: one fan-out, several doors,
# so watching the keys costs no extra requests.
#
# `CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value,
#                bytes data, bytes32 predecessor, uint256 delay)`
CALL_SCHEDULED = "0x4cf4410cc57040e44862ef0f45f3dd5a5e02db8eb8add648d4b0e236f1d07dca"
CALL_EXECUTED = "0xc2617efa69bab66782fa219543714338489c4e9e178271560a91b82c3f612b58"
CALL_CANCELLED = "0xbaa1eb22f2a492ba1a5fea61b8df4d27c6c8b5f3971e63bb58fa14ff72eedb70"
APPROVE_HASH = "0xf2a0eb156472d1440255b0d7c1e19cc07115d1051fe605b0dce69acfec884d9c"

# topic0 -> (name, tier, what it means). `alarm` wakes somebody; `notice` is printed and counted.
# The tiering is the same discipline as NOTICE_FIELDS: `enabled` and `quoteTarget` are the owner's
# own switches and alarming on them would train the reader to ignore this tool, so they are notices.
# An `ApproveHash` is a notice for the opposite reason — it is real, but it names a hash and not a
# payload, so it cannot be attributed to an upgrade without a human looking.
EVENT_TOPICS = {
    "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b": (
        "Upgraded", "alarm", "the proxy's implementation was replaced"),
    "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f": (
        "AdminChanged", "alarm", "the EIP-1967 admin — the key that can upgrade this asset — was replaced"),
    "0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e": (
        "BeaconUpgraded", "alarm", "the beacon this proxy reads its implementation from was replaced"),
    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0": (
        "OwnershipTransferred", "alarm", "the upgrade contract changed owner"),
    CALL_SCHEDULED: ("CallScheduled", "alarm", "an operation was QUEUED on the timelock that holds this key"),
    CALL_EXECUTED: ("CallExecuted", "notice", "a queued timelock operation ran"),
    CALL_CANCELLED: ("Cancelled", "notice", "a queued timelock operation was cancelled"),
    "0x11c24f4ead16507c69ac467fbd5e4eed5fb5c699626d2cc6d66421df253886d5": (
        "MinDelayChange", "alarm", "the timelock delay — the whole response window — was changed"),
    "0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d": (
        "RoleGranted", "alarm", "somebody new can propose, execute or cancel on this timelock"),
    "0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b": (
        "RoleRevoked", "alarm", "a proposer, executor or canceller was removed from this timelock"),
    "0x9465fa0c962cc76958e6373a993326400c1c94f8be2fe3a952adfa7f60b2ea26": (
        "AddedOwner", "alarm", "a signer was added to the multisig that can upgrade this asset"),
    "0xf8d49fc529812e9a7c5c50e69c20f0dccc0db8fa95c98bc58cc9a4f1c1299eaf": (
        "RemovedOwner", "alarm", "a signer was removed from the multisig that can upgrade this asset"),
    "0x610f7ff2b304ae8903c3de74c60c6ab1f7d6226b3f52c5161905bb5ad4039c93": (
        "ChangedThreshold", "alarm", "how many signatures an upgrade needs changed"),
    "0xecdf3a3effea5783a3c4c2140e677577666428d44ed9d474a0b3a4c9943f8440": (
        "EnabledModule", "alarm", "a module was enabled that can move this multisig without its signers"),
    "0x1151116914515bc0891ff9047a6cb32cf902546f83066499bcf8ba33d2353fa2": (
        "ChangedGuard", "alarm", "the multisig's transaction guard was replaced"),
    "0x5ac6c46c93c8d0e53714ba3b53db3e7c046da994313d7ed0d192028bc7c228b0": (
        "ChangedFallbackHandler", "alarm", "the multisig's fallback handler was replaced"),
    "0x75e41bc35ff1bf14d81d1d2f649c0084a0f974f9289c803ec9898eeec4c8d0b8": (
        "ChangedMasterCopy", "alarm", "the multisig's singleton implementation was replaced"),
    APPROVE_HASH: (
        "ApproveHash", "notice",
        "a signer pre-approved a transaction hash ON CHAIN. This is the only thing a Safe ever "
        "shows before it acts, and it names a hash, not a payload"),
}

# What an upgrade actually looks like once it is inside timelock calldata, so the report can say
# WHICH kind of queued operation it found rather than printing four opaque bytes.
UPGRADE_SELECTORS = {
    "0x3659cfe6": "upgradeTo(address)",
    "0x4f1ef286": "upgradeToAndCall(address,bytes)",
    "0x99a88ec4": "upgrade(address,address)  [ProxyAdmin]",
    "0x9623609d": "upgradeAndCall(address,address,bytes)  [ProxyAdmin]",
    "0x7eff275e": "changeProxyAdmin(address,address)  [ProxyAdmin]",
    "0x8f283970": "changeAdmin(address)",
    "0xf2fde38b": "transferOwnership(address)",
    "0x715018a6": "renounceOwnership()",
    "0x2f2ff15d": "grantRole(bytes32,address)",
    "0x64d62353": "updateDelay(uint256)",
}

# `TimelockController.getTimestamp(bytes32)`. 0 = never scheduled or cancelled, 1 = already done,
# anything else is the unix second at which it BECOMES EXECUTABLE. The whole warning is that number.
GET_TIMESTAMP_SELECTOR = "0xd45c4435"
DONE_TIMESTAMP = 1
# The public Monad RPC answers `eth_getLogs is limited to a 100 range` above this. Not negotiable
# from here, and the reason the scan is a fan-out rather than one call.
LOG_RANGE = 100
# Re-read this much of what was already proven. Cheap, and it means a reorg at the tip cannot drop a
# registration into the gap between two runs.
REORG_OVERLAP = 200

BLANK = "0x" + "0" * 40
ZERO32 = "0x" + "0" * 64

# What a change of this field means, and therefore how loudly to say it. Anything not listed here is
# not compared at all.
ALARM_FIELDS = [
    ("codehash", "runtime codehash", "the code at this address was replaced"),
    ("implementation", "EIP-1967 implementation", "the proxy now delegates somewhere else"),
    ("beacon", "EIP-1967 beacon", "the beacon this proxy reads its implementation from moved"),
    ("admin", "EIP-1967 admin", "the key that can upgrade this asset changed hands"),
    ("implCodehash", "implementation codehash", "the code behind the proxy was replaced"),
    ("decimals", "registry decimals", "the registry's snapshot of this asset's decimals moved"),
    ("registered", "registered", "this asset's registration itself changed"),
    ("isContract", "has code", "this address gained or lost code"),
]
NOTICE_FIELDS = [
    ("enabled", "enabled", "new launches in this asset were opened or closed"),
    ("quoteTarget", "quote target", "what FUTURE markets in this asset raise was retuned"),
]

# WHO CAN UPGRADE THIS ASSET, compared field by field. Every one of these is an ALARM and none of
# them is an upgrade: they are the things that happen BEFORE one. A key changing hands is strictly
# earlier information than the code changing, and unlike the code it does not need a re-screen to
# interpret — an asset whose upgrade key moved to an address nobody recognises is an incident on the
# day it moves, whatever the bytecode still says.
AUTHORITY_ALARM_FIELDS = [
    ("root", "upgrade-key root", "the address the EIP-1967 admin (or beacon) slot points at moved"),
    ("rootSlot", "which slot holds the key", "the asset changed proxy shape"),
    ("rootCodehash", "upgrade-key root code", "the code of the contract that can upgrade this asset was replaced"),
    ("rootKind", "upgrade-key root kind", "what the upgrade contract IS changed"),
    ("key", "upgrade key", "who owns the upgrade contract changed hands"),
    ("keyCodehash", "upgrade key code", "the code of the key holder was replaced"),
    ("keyKind", "upgrade key kind", "the key holder stopped being the shape it was — a timelock "
                                    "becoming anything else is the loss of the response window"),
    ("minDelay", "timelock delay", "the gap between a scheduled upgrade and its execution changed. "
                                   "This number IS the response window"),
    ("threshold", "multisig threshold", "how many signatures an upgrade needs changed"),
    ("signers", "multisig signer count", "how many keys can sign an upgrade changed"),
    ("signersHash", "multisig signer set", "the set of keys that can sign an upgrade changed"),
    ("implUpgradeable", "impl upgrade entrypoint",
     "the implementation gained or lost upgradeTo/upgradeToAndCall/proxiableUUID. Gaining one turns "
     "an asset with no upgrade path into an asset with one"),
]

# How the report says, out loud, what it can and cannot promise per asset.
WARNING_MEANING = {
    "timelock": "an upgrade must be scheduled on chain first",
    "none": "the first on-chain trace is the upgrade itself",
    "no-upgrade-path": "no upgrade entrypoint exists to warn about",
    "unknown": "admin slot is empty and the implementation exposes an upgrade entrypoint - "
               "the key is inside the implementation and this probe cannot see it",
}


def die(message):
    """Exit 3. Every path that could not look ends here, and none of them return a verdict."""
    print("COULD NOT LOOK: " + message, file=sys.stderr)
    sys.exit(3)


# ------------------------------------------------------------------------------------------ rpc


class Rpc:
    """
    A JSON-RPC client with exactly two behaviours: retry a transport failure a bounded number of
    times, and then give up loudly.

    The retry is not optimism. A public RPC under a fan-out resets connections and rate-limits, and
    a monitor that paged a human every time one packet was dropped would be turned off inside a
    week. What it must never do is turn a persistent failure into a short answer — so the retries
    are counted, the backoff is bounded, and the end of them is `die`, never a `return None`.
    """

    ATTEMPTS = 4
    BACKOFF = 0.75

    def __init__(self, url, rate=None):
        self.url = url
        # The public Monad endpoint is fronted by a provider that answers
        # `50/second request limit reached` with HTTP 429. A fan-out over 2,500 chunks trips that
        # instantly, so the whole client is paced rather than the pool being made small — a small
        # pool would still burst, and a burst is what the limiter counts.
        self.interval = (1.0 / rate) if rate else 0.0
        self._lock = threading.Lock()
        self._next = 0.0

    def _pace(self):
        if self.interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            wait = self._next - now
            self._next = max(now, self._next) + self.interval
        if wait > 0:
            time.sleep(wait)

    def call(self, method, params):
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
        last = None
        for attempt in range(self.ATTEMPTS):
            self._pace()
            request = urllib.request.Request(
                self.url, data=body, headers={"content-type": "application/json"}
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    payload = json.load(response)
            except urllib.error.HTTPError as exc:
                detail = exc.read()[:200].decode("utf-8", "replace")
                # A range that is too wide, a malformed filter: asking again cannot help.
                if exc.code not in (408, 429, 500, 502, 503, 504):
                    die("%s -> HTTP %s %s" % (method, exc.code, detail))
                last = "HTTP %s %s" % (exc.code, detail)
            except Exception as exc:  # noqa: BLE001 - a monitor may not swallow anything
                last = str(exc)
            else:
                if "error" in payload:
                    die("%s -> %s" % (method, payload["error"]))
                if "result" not in payload:
                    die("%s -> no result in %s" % (method, payload))
                return payload["result"]
            time.sleep(self.BACKOFF * (2 ** attempt))
        die("%s -> failed %d times, last: %s" % (method, self.ATTEMPTS, last))


# ----------------------------------------------------------------------------------------- scan


def cmd_scan(args):
    rpc = Rpc(args.rpc, rate=args.rate)
    head = int(rpc.call("eth_blockNumber", []), 16)
    start = max(0, args.from_block)
    if start > head:
        start = head

    # One fan-out, several doors. The registry's own registrations and every event on every address
    # that holds an upgrade key are pulled in the SAME pass, because the expensive thing here is the
    # number of 100-block requests and not the number of topics in each one. Watching the keys is
    # therefore free, and a monitor that costs nothing extra is a monitor that stays switched on.
    watched = [args.registry] + _addresses(args.addresses)
    topics = [REGISTERED_TOPIC] + sorted(EVENT_TOPICS)
    ranges = list(range(start, head + 1, LOG_RANGE))

    def chunk(low):
        high = min(low + LOG_RANGE - 1, head)
        return rpc.call(
            "eth_getLogs",
            [{"fromBlock": hex(low), "toBlock": hex(high), "address": watched, "topics": [topics]}],
        )

    logs = []
    # `die` is `sys.exit`, which inside a worker surfaces as the exception the pool re-raises on
    # `map`; either way the process ends non-zero rather than returning a short list.
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for result in pool.map(chunk, ranges):
            logs.extend(result)

    registry = key(args.registry)
    registrations = []
    events = []
    scheduled = []
    for log in sorted(logs, key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16))):
        topic0 = log["topics"][0].lower()
        where = {"block": int(log["blockNumber"], 16), "tx": log["transactionHash"], "address": log["address"]}
        if topic0 == REGISTERED_TOPIC and key(log["address"]) == registry:
            data = log["data"][2:]
            registrations.append(
                dict(where, asset="0x" + log["topics"][1][-40:], decimals=int(data[0:64], 16),
                     quoteTarget=str(int(data[64:128], 16)))
            )
            continue
        if topic0 not in EVENT_TOPICS:
            continue
        name, tier, meaning = EVENT_TOPICS[topic0]
        events.append(dict(where, name=name, tier=tier, meaning=meaning, topics=log["topics"], data=log["data"]))
        if topic0 == CALL_SCHEDULED:
            scheduled.append(dict(where, id=log["topics"][1], **_decode_call_scheduled(log["data"])))

    # Which of those queued operations can still fire. The log says one was scheduled; only the
    # timelock's own `getTimestamp` says whether it is still pending, was executed, or was
    # cancelled — and an operation scheduled a month ago with a long delay is EXACTLY the case a
    # log window would get wrong.
    now = int(rpc.call("eth_getBlockByNumber", [hex(head), False])["timestamp"], 16)
    pending = []
    for op in scheduled:
        eta = int(rpc.call(
            "eth_call",
            [{"to": op["address"], "data": GET_TIMESTAMP_SELECTOR + op["id"][2:]}, hex(head)],
        ), 16)
        state = "pending" if eta > DONE_TIMESTAMP else ("executed" if eta == DONE_TIMESTAMP else "gone")
        pending.append(dict(op, eta=eta, state=state, secondsLeft=max(0, eta - now) if state == "pending" else 0))

    json.dump(
        {
            "head": head,
            "fromBlock": start,
            "chunks": len(ranges),
            "now": now,
            "watched": watched,
            "registrations": registrations,
            "events": events,
            "queued": pending,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


def _addresses(raw):
    return [a for a in (raw or "").split(",") if a.strip()]


def _decode_call_scheduled(data):
    """
    `CallScheduled` carries `(address target, uint256 value, bytes data, bytes32 predecessor,
    uint256 delay)` unindexed. Only `target`, the first four bytes of `data` and `delay` are read:
    the target says whether this operation is aimed at anything DOKU depends on, the selector says
    what kind of operation it is, and the delay is the warning.
    """
    body = data[2:]

    def word(i):
        return body[i * 64:(i + 1) * 64]

    target = "0x" + word(0)[-40:]
    delay = int(word(4), 16) if len(body) >= 5 * 64 else 0
    selector = ""
    try:
        offset = int(word(2), 16) // 32  # `bytes data`, offset in words from the start of the tuple
        length = int(word(offset), 16)
        if length >= 4:
            selector = "0x" + word(offset + 1)[:8]
    except (ValueError, IndexError):
        selector = ""
    return {"target": target, "delay": delay, "selector": selector,
            "what": UPGRADE_SELECTORS.get(selector, selector or "(no calldata)")}


# ---------------------------------------------------------------------------------- the reading


def load_json(path, what):
    if not os.path.exists(path):
        die("%s is missing: %s" % (what, path))
    try:
        with open(path) as handle:
            return json.load(handle)
    except ValueError as exc:
        die("%s is not valid JSON: %s (%s)" % (what, path, exc))


def parse_observation(path):
    """`WATCH` lines from script/WatchQuoteAssets.s.sol, and nothing else in the forge output."""
    if not os.path.exists(path):
        die("no observation was written: %s" % path)
    head = None
    assets = []
    authorities = {}
    end = None
    for raw in open(path):
        line = raw.strip()
        if not line.startswith("WATCH "):
            continue
        fields = dict(part.split("=", 1) for part in line.split() if "=" in part)
        if line.startswith("WATCH head"):
            head = fields
        elif line.startswith("WATCH auth="):
            authorities[key(fields["auth"])] = {
                "root": fields["root"],
                "rootSlot": fields["rootSlot"],
                "rootCodehash": fields["rootCodehash"],
                "rootKind": fields["rootKind"],
                "key": fields["key"],
                "keyCodehash": fields["keyCodehash"],
                "keyKind": fields["keyKind"],
                "minDelay": int(fields["minDelay"]),
                "threshold": int(fields["threshold"]),
                "signers": int(fields["signers"]),
                "signersHash": fields["signersHash"],
                "implUpgradeable": fields["implUpgradeable"] == "1",
                "warning": fields["warning"],
            }
        elif line.startswith("WATCH asset="):
            assets.append(
                {
                    "address": fields["asset"],
                    "isContract": fields["contract"] == "1",
                    "codehash": fields["codehash"],
                    "implementation": fields["impl"],
                    "beacon": fields["beacon"],
                    "admin": fields["admin"],
                    "implCodehash": fields["implCodehash"],
                    "registered": fields["registered"] == "1",
                    "enabled": fields["enabled"] == "1",
                    "decimals": int(fields["decimals"]),
                    "quoteTarget": fields["quoteTarget"],
                }
            )
        elif line.startswith("WATCH end"):
            end = int(fields["assets"])
    if head is None or end is None:
        die("the observation stopped before it finished (no 'WATCH end' line in %s). Nothing is "
            "being reported from a partial read." % path)
    if end != len(assets):
        die("the observation claims %d assets and carries %d" % (end, len(assets)))
    # An asset observed without its key is a half-read, and a half-read that reports ALL CLEAR is
    # the failure this monitor exists to avoid. Every asset gets both lines or the run says nothing.
    missing = [a["address"] for a in assets if key(a["address"]) not in authorities]
    if missing:
        die("the observation carries %d asset(s) with no authority line: %s. Who can upgrade an "
            "asset is not an optional field." % (len(missing), ", ".join(missing)))
    return head, assets, authorities


def key(address):
    return address.lower()


def short(address):
    return address[:8] + "…" + address[-4:]


# ----------------------------------------------------------------------------------------- plan


def watchlist(args):
    """Who to observe: everything the baseline knows, plus everything the chain has registered."""
    seen = []
    order = {}

    def add(address):
        if key(address) not in order:
            order[key(address)] = True
            seen.append(address)

    if args.init:
        for asset in load_json(args.deployments, "the deployment record").get("quoteAssets", []):
            add(asset["address"])
    else:
        for asset in load_json(args.baseline, "the baseline").get("assets", []):
            add(asset["address"])
    if args.scan:
        for registration in load_json(args.scan, "the registry scan").get("registrations", []):
            add(registration["asset"])
    return seen


def cmd_plan(args):
    print(",".join(watchlist(args)))


def cmd_keys(args):
    """
    The upgrade keys the baseline knows about, for the log pass to watch alongside the registry.

    Deliberately silent when the baseline has none: a baseline written before `authority` existed
    names no keys, the scan then watches only the registry, and `_triage_keys` is what says so in
    the report. Inventing addresses here instead would hide a stale baseline behind a full-looking
    scan line.
    """
    if not os.path.exists(args.baseline):
        return
    print(",".join(_authority_addresses(load_json(args.baseline, "the baseline"))))


# ----------------------------------------------------------------------------------------- diff


def cmd_diff(args):
    scan = load_json(args.scan, "the registry scan") if args.scan else None
    observed_head, observed, authorities = parse_observation(args.obs)
    by_address = {key(a["address"]): a for a in observed}

    print("")
    print("=== DOKU quote-asset watch ===")
    print("network    %s (chain %s)" % (args.network, observed_head["chain"]))
    print("block      %s" % observed_head["block"])
    print("registry   %s  owner %s" % (observed_head["registry"], observed_head["owner"]))
    if args.factory:
        print("factory    %s  paused=%s" % (args.factory, args.factory_paused))

    alarms = []
    notices = []
    rescreen = []

    if args.init:
        print("baseline   %s  (CREATING)" % args.baseline)
        _print_scan_line(scan, None)
        print("")
        for asset in observed:
            symbol = args.symbols.get(key(asset["address"]), "?")
            if not asset["registered"]:
                alarms.append(
                    "%s %s is in deployments/%s.json and the registry has never registered it"
                    % (symbol, asset["address"], args.network)
                )
            print("  %-6s %s  %s" % (symbol, short(asset["address"]), _shape(asset)))
            rescreen.append(asset["address"])
        _print_coverage(observed, authorities, args.symbols)
        _emit(args, rescreen, alarms, notices, initial=True)
        return

    baseline = load_json(args.baseline, "the baseline")
    if int(baseline.get("chainId", -1)) != int(observed_head["chain"]):
        die(
            "the baseline is for chain %s and the node answers chain %s"
            % (baseline.get("chainId"), observed_head["chain"])
        )
    print("baseline   %s  (captured %s at block %s)"
          % (args.baseline, baseline.get("capturedAt"), baseline.get("capturedAtBlock")))
    _print_scan_line(scan, baseline)

    registry_baseline = baseline.get("registry", {})
    for field, label in (("owner", "owner"), ("pendingOwner", "pendingOwner")):
        was = registry_baseline.get(field, BLANK)
        now = observed_head[field]
        if key(was) != key(now):
            alarms.append(
                "the registry's %s moved %s -> %s. Whoever holds it can register a callback asset "
                "at will." % (label, was, now)
            )

    print("")
    known = {key(a["address"]) for a in baseline.get("assets", [])}
    baseline_by_address = {key(a["address"]): a for a in baseline.get("assets", [])}
    symbols = dict(args.symbols)
    for asset in baseline.get("assets", []):
        symbols.setdefault(key(asset["address"]), asset.get("symbol", "?"))

    # A registration this baseline has never seen. Same hole, different door: it never went through
    # `screen-quote-asset.sh`, because the baseline is what the screen wrote.
    for registration in (scan or {}).get("registrations", []):
        if key(registration["asset"]) not in known:
            # Prefer the observation's checksummed spelling; a log topic is raw lowercase and this
            # string is the one somebody pastes into an explorer at three in the morning.
            observed_asset = by_address.get(key(registration["asset"]))
            printed = observed_asset["address"] if observed_asset else registration["asset"]
            alarms.append(
                "UNSCREENED REGISTRATION: %s was registered in block %d (tx %s) and is not in the "
                "baseline. It never went through script/screen-quote-asset.sh."
                % (printed, registration["block"], registration["tx"])
            )
            if observed_asset:
                rescreen.append(observed_asset["address"])

    for asset in observed:
        address = key(asset["address"])
        symbol = symbols.get(address, "?")
        was = baseline_by_address.get(address)
        if was is None:
            print("  %-6s %s  ** NOT IN THE BASELINE **  %s" % (symbol, short(asset["address"]), _shape(asset)))
            continue

        moved = []
        for field, label, meaning in ALARM_FIELDS:
            before, after = was.get(field), asset[field]
            if isinstance(after, str) and isinstance(before, str):
                same = key(before) == key(after)
            else:
                same = before == after
            if not same:
                moved.append((label, before, after, meaning))

        # And who can change all of the above. A baseline written before this field existed has no
        # `authority` block; that is a stale baseline rather than a change, and it is reported as
        # one — silently treating "not recorded" as "not moved" is how a monitor goes quiet.
        was_auth = was.get("authority")
        now_auth = authorities[address]
        if was_auth is None:
            notices.append(
                "%s %s: the baseline predates upgrade-key watching and records no authority. Today "
                "it is %s. Re-baseline with --accept to start comparing it."
                % (symbol, asset["address"], _key_phrase(now_auth))
            )
        else:
            for field, label, meaning in AUTHORITY_ALARM_FIELDS:
                before, after = was_auth.get(field), now_auth[field]
                if isinstance(after, str) and isinstance(before, str):
                    same = key(before) == key(after)
                else:
                    same = before == after
                if not same:
                    moved.append((label, before, after, meaning))

        soft = []
        for field, label, meaning in NOTICE_FIELDS:
            before, after = was.get(field), asset[field]
            if str(before) != str(after):
                soft.append((label, before, after, meaning))

        if moved:
            print("  %-6s %s  ** MOVED **" % (symbol, short(asset["address"])))
            for label, before, after, meaning in moved:
                print("        %-24s %s" % (label, meaning))
                print("        %-24s was  %s" % ("", before))
                print("        %-24s now  %s" % ("", after))
            alarms.append(
                "%s %s: %s changed since %s"
                % (symbol, asset["address"], ", ".join(m[0] for m in moved), baseline.get("capturedAt"))
            )
            rescreen.append(asset["address"])
        elif soft:
            print("  %-6s %s  notice" % (symbol, short(asset["address"])))
            for label, before, after, meaning in soft:
                print("        %-24s %s -> %s   (%s)" % (label, before, after, meaning))
            notices.append("%s %s: %s" % (symbol, asset["address"], ", ".join(s[0] for s in soft)))
        else:
            print("  %-6s %s  unchanged  %s" % (symbol, short(asset["address"]), _shape(asset)))

    _print_coverage(observed, authorities, symbols)
    _triage_keys(scan, baseline, observed, authorities, alarms, notices)

    _emit(args, rescreen, alarms, notices, initial=False)


# ------------------------------------------------------------------------------ the earlier doors


def _authority_addresses(baseline):
    """Every address that can upgrade something, from the baseline. What the log pass watches."""
    out = []
    for asset in baseline.get("assets", []):
        auth = asset.get("authority") or {}
        for field in ("root", "key"):
            candidate = auth.get(field, BLANK)
            if candidate and key(candidate) != key(BLANK) and key(candidate) not in {key(a) for a in out}:
                out.append(candidate)
    return out


def _print_coverage(observed, authorities, symbols):
    """
    WHAT THIS MONITOR CAN AND CANNOT PROMISE, printed on every run whether or not anything moved.

    This is the part that is not allowed to be implicit. Three of the four proxies on generation 3
    give no advance warning of any kind, and a report that lists them next to the one that does,
    without saying which is which, invites the reader to assume the coverage is uniform. It is not.
    """
    print("")
    print("advance warning — what is visible BEFORE an upgrade lands, not after:")
    for asset in observed:
        address = key(asset["address"])
        auth = authorities[address]
        symbol = symbols.get(address, "?")
        warning = auth["warning"]
        if warning == "timelock":
            head = "%s AHEAD" % _duration(auth["minDelay"])
        elif warning == "no-upgrade-path":
            head = "n/a"
        elif warning == "unknown":
            head = "UNKNOWN"
        else:
            head = "NONE"
        print("  %-6s %s  %-10s %s" % (symbol, short(asset["address"]), head, _key_phrase(auth)))
        # The second line only where there is something to promise or to withhold. Printing it for
        # an asset that cannot be upgraded at all would bury the two that can.
        if warning != "no-upgrade-path":
            print("  %-6s %-15s %-10s %s" % ("", "", "", WARNING_MEANING.get(warning, warning)))


def _key_phrase(auth):
    """One line naming the key, in the terms of what it can do rather than what it is called."""
    if auth["rootSlot"] == "none" and not auth["implUpgradeable"]:
        return "no proxy admin, no beacon, no upgrade entrypoint in the code behind it"
    if auth["rootSlot"] == "none":
        return "no admin slot, but the implementation exposes an upgrade entrypoint (UUPS-shaped)"
    terminal, kind = (auth["key"], auth["keyKind"]) if key(auth["key"]) != key(BLANK) else (auth["root"], auth["rootKind"])
    if kind == "timelock":
        detail = "timelock, minDelay %ss" % auth["minDelay"]
    elif kind == "safe":
        detail = "multisig %d-of-%d" % (auth["threshold"], auth["signers"])
    elif kind == "eoa":
        detail = "EOA — one key, no quorum, no delay"
    else:
        detail = kind
    via = "" if key(auth["key"]) == key(BLANK) else " via %s" % short(auth["root"])
    return "key %s (%s)%s" % (short(terminal), detail, via)


def _duration(seconds):
    seconds = int(seconds)
    if seconds <= 0:
        return "0s"
    hours, rest = divmod(seconds, 3600)
    minutes = rest // 60
    if hours and minutes:
        return "%dh%dm" % (hours, minutes)
    if hours:
        return "%dh" % hours
    if minutes:
        return "%dm" % minutes
    return "%ds" % seconds


def _triage_keys(scan, baseline, observed, authorities, alarms, notices):
    """
    The log pass, read. Two things come out of it that the slot diff structurally cannot give:

      - an operation QUEUED on a timelock and not yet executed. That is warning ahead of the fact,
        and `secondsLeft` is exactly how long there is to respond;
      - a key that moved and moved back between two runs. The slot diff compares two points in time
        and would see nothing; the log saw both edges.
    """
    if scan is None:
        return
    watched_keys = {key(a) for a in _authority_addresses(baseline)}
    if not watched_keys:
        notices.append(
            "the upgrade keys were NOT watched this run: the baseline names none. Re-baseline with "
            "--accept so that watch-quote-assets.sh records who can upgrade each asset."
        )
        return
    watched_assets = {key(a["address"]) for a in observed}
    # The registry too. Its owner moving is already compared field-to-field, but the log saw both
    # edges of an owner who was handed the registry and handed it back between two runs, and the
    # field comparison structurally cannot.
    registry = baseline.get("registry", {}).get("address")
    interesting = watched_keys | watched_assets | ({key(registry)} if registry else set())

    for op in scan.get("queued", []):
        if op["state"] != "pending":
            continue
        target = key(op["target"])
        if target not in interesting:
            notices.append(
                "a timelock operation is pending on %s but targets %s, which DOKU does not depend "
                "on (%s, executable in %s)"
                % (short(op["address"]), short(op["target"]), op["what"], _duration(op["secondsLeft"]))
            )
            continue
        alarms.append(
            "QUEUED, NOT YET EXECUTED: %s on %s targets %s and becomes executable in %s (scheduled "
            "in block %d, tx %s, id %s). THIS IS THE WARNING — the response window is open now and "
            "closes when that timer does."
            % (op["what"], short(op["address"]), op["target"], _duration(op["secondsLeft"]),
               op["block"], op["tx"], op["id"])
        )

    # HISTORY IS NOT CHANGE. The first scan after the keys are recorded backfills the whole range
    # since the deploy block, and everything in it happened BEFORE the baseline was captured — the
    # baseline already records the state those events produced. Alarming on them would mean the
    # monitor's own first run fires on the registry being handed to its owner at deployment, which
    # is the fastest way to teach somebody that this tool cries wolf. The cut is the block the
    # baseline attests to, and an event after it keeps firing until a human runs --accept.
    since = int(baseline.get("capturedAtBlock", 0))
    seen = {}
    order = []
    historical = 0
    for event in scan.get("events", []):
        where = key(event["address"])
        if where not in interesting:
            continue
        if event["name"] == "CallScheduled":
            continue  # already handled above, with its execution state resolved against the chain
        if event["block"] <= since:
            historical += 1
            continue
        # A batch operation emits one event per call in it. Four identical lines say nothing four
        # times; one line with a count says the same thing and can be read.
        signature = (event["name"], where, event["block"], event["tx"])
        if signature not in seen:
            seen[signature] = 0
            order.append((signature, event))
        seen[signature] += 1

    for signature, event in order:
        count = seen[signature]
        line = "%s%s on %s in block %d (tx %s): %s" % (
            event["name"],
            "" if count == 1 else " x%d" % count,
            short(event["address"]),
            event["block"],
            event["tx"],
            _meaning(event, registry),
        )
        (alarms if event["tier"] == "alarm" else notices).append(line)

    if historical:
        notices.append(
            "%d key event%s in this scan happened at or before the baselined block %d. They are how "
            "the recorded state was REACHED, not a change since it, and are not alarmed on."
            % (historical, "" if historical == 1 else "s", since)
        )


def _meaning(event, registry):
    """
    The same topic means different things on different contracts, and a monitor that reads out a
    generic sentence about the wrong contract wastes the first minutes of an incident.
    """
    if registry and key(event["address"]) == key(registry) and event["name"] == "OwnershipTransferred":
        return ("the QuoteRegistry itself changed owner. Whoever holds it can register a callback "
                "asset at will")
    return event["meaning"]


def _shape(asset):
    if not asset["isContract"]:
        return "native / no code"
    if asset["implementation"] != BLANK:
        return "proxy -> %s" % short(asset["implementation"])
    if asset["beacon"] != BLANK:
        return "beacon proxy -> %s" % short(asset["beacon"])
    return "plain contract"


def _print_scan_line(scan, baseline):
    if scan is None:
        print("scan       SKIPPED (--no-registry-scan): a newly registered asset would not be seen,")
        print("           and neither would an upgrade queued on a timelock that holds one of the keys")
        return
    proven = (baseline or {}).get("registry", {}).get("provenThroughBlock")
    print(
        "scan       blocks %s..%s over %d address%s (%d requests, %d registration%s, %d key event%s)%s"
        % (
            scan["fromBlock"],
            scan["head"],
            len(scan.get("watched", [])),
            "" if len(scan.get("watched", [])) == 1 else "es",
            scan["chunks"],
            len(scan["registrations"]),
            "" if len(scan["registrations"]) == 1 else "s",
            len(scan.get("events", [])),
            "" if len(scan.get("events", [])) == 1 else "s",
            "" if proven is None else "; baseline was proven through %s" % proven,
        )
    )
    # The one thing a log window cannot do. An operation scheduled BEFORE `fromBlock` with a delay
    # long enough to still be pending would not be in these logs at all — and the run would be
    # silent about it rather than wrong, which is worse. So the window is printed, every time.
    queued = scan.get("queued", [])
    print(
        "           timelock queue read from block %s; anything scheduled before that is not in "
        "this window (%d queued op%s resolved)"
        % (scan["fromBlock"], len(queued), "" if len(queued) == 1 else "s")
    )


def _emit(args, rescreen, alarms, notices, initial):
    ordered = []
    for address in rescreen:
        if key(address) not in {key(a) for a in ordered}:
            ordered.append(address)
    with open(args.out_rescreen, "w") as handle:
        handle.write("\n".join(ordered) + ("\n" if ordered else ""))

    print("")
    for notice in notices:
        print("NOTICE:  %s" % notice)
    for alarm in alarms:
        print("ALARM:   %s" % alarm)
    print("")

    if initial:
        print("BASELINE BEING CREATED. Every asset above is about to be screened and recorded.")
        sys.exit(1 if alarms else 0)
    if alarms:
        print("VERDICT: SOMETHING MOVED. %d alarm%s." % (len(alarms), "" if len(alarms) == 1 else "s"))
        sys.exit(1)
    print("VERDICT: ALL CLEAR%s" % (" (with %d notice%s)" % (len(notices), "" if len(notices) == 1 else "s") if notices else ""))
    sys.exit(0)


# --------------------------------------------------------------------------------------- commit


def cmd_commit(args):
    observed_head, observed, authorities = parse_observation(args.obs)
    scan = load_json(args.scan, "the registry scan") if args.scan else None
    verdicts = {}
    if args.screens and os.path.exists(args.screens):
        for line in open(args.screens):
            parts = line.split()
            if len(parts) == 2:
                verdicts[key(parts[0])] = parts[1]

    existing = load_json(args.baseline, "the baseline") if os.path.exists(args.baseline) else {}
    previous = {key(a["address"]): a for a in existing.get("assets", [])}
    symbols = dict(args.symbols)
    for address, asset in previous.items():
        symbols.setdefault(address, asset.get("symbol", "?"))

    if args.cursor_only:
        # The narrow write: a clean run has proven the registered set a little further along and
        # nothing else about the file may move.
        if scan is None or not existing:
            return
        registry = existing.setdefault("registry", {})
        was = registry.get("provenThroughBlock")
        was_keys = registry.get("keysProvenThroughBlock")
        keys_watched = len(scan.get("watched", [])) > 1
        # Two cursors, because they prove different things and one run can advance one without the
        # other. A run that watched no key addresses has proven nothing about the keys, and writing
        # its head into the key cursor would skip that range forever.
        if was == scan["head"] and (was_keys == scan["head"] or not keys_watched):
            return
        registry["provenThroughBlock"] = scan["head"]
        if keys_watched:
            registry["keysProvenThroughBlock"] = scan["head"]
        _write(args.baseline, existing)
        print("advanced registry.provenThroughBlock %s -> %s%s in %s"
              % (was, scan["head"],
                 "" if not keys_watched else " and keysProvenThroughBlock %s -> %s" % (was_keys, scan["head"]),
                 args.baseline))
        return

    refused = [a for a in observed if verdicts.get(key(a["address"])) == "REFUSED"]
    if refused and not args.force:
        print("")
        print("REFUSING TO BASELINE: the screen refused %d of these assets. A baseline is an" % len(refused))
        print("attestation that the code recorded in it passed the screen; writing one over a refusal")
        print("would launder the refusal into a clean run tomorrow. Assets:")
        for asset in refused:
            print("  %s %s" % (symbols.get(key(asset["address"]), "?"), asset["address"]))
        sys.exit(1)

    today = date.today().isoformat()
    record = {
        "kind": "doku-quote-asset-baseline",
        # 2 added `assets[].authority`: who can upgrade each asset, so that a change of upgrade
        # AUTHORITY is an alarm in its own right and strictly earlier than the upgrade it precedes.
        "version": 2,
        "network": args.network,
        "chainId": int(observed_head["chain"]),
        "capturedAt": today,
        "capturedAtBlock": int(observed_head["block"]),
        "why": [
            "What every registered quote asset looked like at capturedAtBlock, so that "
            "script/watch-quote-assets.sh can say what moved since.",
            "DokuFactory._firstBuy is reentrant through a quote asset that calls its payer back "
            "inside transferFrom, and DokuFactory is immutable, so it can never be patched. Four of "
            "these assets are EIP-1967 proxies: one upgradeTo is all it takes to arm it, and that "
            "upgrade emits no event DOKU can see.",
            "screen is what script/screen-quote-asset.sh said about the code recorded here, on the "
            "date recorded here. It is a fact about a block, not a guarantee about a token.",
            "authority is WHO can perform that upgradeTo, read off the chain: the EIP-1967 admin "
            "or beacon, whoever owns it, and what that owner IS. A change in this block is an "
            "alarm on its own — it is upstream of the upgrade and therefore earlier than it.",
            "warning says what advance notice each asset can give. 'timelock' means an upgrade has "
            "to be scheduled on chain minDelay seconds before it can execute, and that scheduling "
            "is watched. 'none' means the first thing on chain IS the upgrade: for those assets "
            "this monitor reports after the fact and cannot do otherwise.",
        ],
        "registry": {
            "address": observed_head["registry"],
            "owner": observed_head["owner"],
            "pendingOwner": observed_head["pendingOwner"],
            "deployBlock": args.deploy_block,
            # Preserved rather than blanked when --no-registry-scan skipped the log scan: the
            # cursor records how far the registered set was once proven, and a run that chose not
            # to look must not un-prove it.
            "provenThroughBlock": scan["head"] if scan else existing.get("registry", {}).get("provenThroughBlock"),
            # A SEPARATE cursor, and it starts at the deploy block rather than at the head. A run
            # that watched no key addresses — which is every run made from a baseline that did not
            # yet record any — has proven nothing about the keys, and claiming its head here would
            # skip that whole range of CallScheduled logs permanently.
            "keysProvenThroughBlock": (
                scan["head"] if (scan and len(scan.get("watched", [])) > 1)
                else existing.get("registry", {}).get("keysProvenThroughBlock", args.deploy_block)
            ),
            "note": "QuoteRegistry has no enumeration. provenThroughBlock is how far the "
                    "QuoteAssetRegistered log scan has confirmed that the registered set is exactly "
                    "the assets listed below. keysProvenThroughBlock is how far the same log pass "
                    "has watched the upgrade keys in assets[].authority for a queued upgrade or a "
                    "change of who holds them.",
        },
        "assets": [],
    }

    registered_at = {key(r["asset"]): r for r in (scan or {}).get("registrations", [])}
    for asset in observed:
        address = key(asset["address"])
        was = previous.get(address, {})
        verdict = verdicts.get(address)
        entry = {
            "symbol": symbols.get(address, "?"),
            "address": asset["address"],
            "registered": asset["registered"],
            "enabled": asset["enabled"],
            "decimals": asset["decimals"],
            "quoteTarget": asset["quoteTarget"],
            "isContract": asset["isContract"],
            "codehash": asset["codehash"],
            "implementation": asset["implementation"],
            "beacon": asset["beacon"],
            "admin": asset["admin"],
            "implCodehash": asset["implCodehash"],
            "authority": authorities[address],
        }
        if address in registered_at:
            entry["registeredInBlock"] = registered_at[address]["block"]
            entry["registeredInTx"] = registered_at[address]["tx"]
        elif "registeredInBlock" in was:
            entry["registeredInBlock"] = was["registeredInBlock"]
            entry["registeredInTx"] = was.get("registeredInTx")
        if verdict:
            entry["screen"] = {"verdict": verdict, "at": today, "atBlock": int(observed_head["block"])}
        elif "screen" in was and key(was.get("codehash", "")) == key(asset["codehash"]) \
                and key(was.get("implCodehash", ZERO32)) == key(asset["implCodehash"]):
            entry["screen"] = was["screen"]  # Same code, so the old verdict still describes it.
        record["assets"].append(entry)

    _write(args.baseline, record)
    print("wrote %s (%d assets, block %s)" % (args.baseline, len(record["assets"]), observed_head["block"]))


def _write(path, record):
    with open(path, "w") as handle:
        json.dump(record, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


# ------------------------------------------------------------------------------------------ cli


def symbol_map(path):
    """Symbols are cosmetic and come from the deployment record; the addresses come from the chain."""
    if not path or not os.path.exists(path):
        return {}
    record = json.load(open(path))
    return {key(a["address"]): a.get("symbol", "?") for a in record.get("quoteAssets", [])}


def main():
    parser = argparse.ArgumentParser(add_help=True)
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan")
    scan.add_argument("--rpc", required=True)
    scan.add_argument("--registry", required=True)
    scan.add_argument("--from-block", type=int, required=True)
    scan.add_argument("--addresses", default="",
                      help="comma-separated upgrade-key addresses to watch in the same log pass")
    scan.add_argument("--workers", type=int, default=8)
    scan.add_argument("--rate", type=float, default=25.0, help="requests per second, paced across the pool")
    scan.set_defaults(func=cmd_scan)

    keys = sub.add_parser("keys")
    keys.add_argument("--baseline", required=True)
    keys.set_defaults(func=cmd_keys)

    plan = sub.add_parser("plan")
    plan.add_argument("--baseline", required=True)
    plan.add_argument("--deployments", required=True)
    plan.add_argument("--scan")
    plan.add_argument("--init", action="store_true")
    plan.set_defaults(func=cmd_plan)

    diff = sub.add_parser("diff")
    diff.add_argument("--network", required=True)
    diff.add_argument("--baseline", required=True)
    diff.add_argument("--deployments", required=True)
    diff.add_argument("--scan")
    diff.add_argument("--obs", required=True)
    diff.add_argument("--out-rescreen", required=True)
    diff.add_argument("--factory", default="")
    diff.add_argument("--factory-paused", default="?")
    diff.add_argument("--init", action="store_true")
    diff.set_defaults(func=cmd_diff)

    commit = sub.add_parser("commit")
    commit.add_argument("--network", required=True)
    commit.add_argument("--baseline", required=True)
    commit.add_argument("--deployments", required=True)
    commit.add_argument("--scan")
    commit.add_argument("--obs", required=True)
    commit.add_argument("--screens")
    commit.add_argument("--deploy-block", type=int, default=0)
    commit.add_argument("--cursor-only", action="store_true")
    commit.add_argument("--force", action="store_true")
    commit.set_defaults(func=cmd_commit)

    args = parser.parse_args()
    if hasattr(args, "deployments"):
        args.symbols = symbol_map(args.deployments)
    if getattr(args, "scan", None) == "":
        args.scan = None
    args.func(args)


if __name__ == "__main__":
    main()
