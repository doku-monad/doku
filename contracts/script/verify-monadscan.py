#!/usr/bin/env python3
"""
Verify one contract on MonadScan (Etherscan's multichain API, chain 143) from forge's own
standard-JSON input.

    script/verify-monadscan.py <address> <path:Contract> [<0x-encoded constructor args>]

`forge verify-contract --verifier etherscan` refuses chain 143 ("No known Etherscan API URL"),
whatever `--verifier-url` says, so the request is made here instead — with the SAME standard
JSON forge would send (`--show-standard-json-input`: sources, remappings, optimizer, viaIR,
evmVersion, metadata.bytecodeHash), the compiler version read from the compiled artifact, and the
constructor arguments the caller took from the broadcast. Polls `checkverifystatus` until the
explorer answers. Key from ETHERSCAN_API_KEY (or MONADSCAN_API_KEY); never printed.
"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request

CHAIN = int(os.environ.get("MONAD_CHAIN_ID", "143"))
API = os.environ.get("MONADSCAN_API_URL", "https://api.etherscan.io/v2/api").rstrip("/")
KEY = os.environ.get("ETHERSCAN_API_KEY") or os.environ.get("MONADSCAN_API_KEY")
if not KEY:
    sys.exit("ETHERSCAN_API_KEY is not set")
if len(sys.argv) < 3:
    sys.exit(__doc__)
address, contract = sys.argv[1], sys.argv[2]
ctor = (sys.argv[3] if len(sys.argv) > 3 else "").removeprefix("0x")
path, name = contract.split(":")


def api(params, body=None):
    q = urllib.parse.urlencode({"chainid": CHAIN, "module": "contract", **params, "apikey": KEY})
    data = urllib.parse.urlencode(body).encode() if body is not None else None
    req = urllib.request.Request(f"{API}?{q}", data=data, method="POST" if data else "GET")
    if data:
        req.add_header("content-type", "application/x-www-form-urlencoded")
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except Exception as e:  # network / 5xx: try again, briefly
            if attempt == 4:
                raise
            print(f"    retry after: {e}")
            time.sleep(5 * (attempt + 1))


# Already there? Then this is a no-op, not a failure.
got = api({"action": "getsourcecode", "address": address})
if got.get("status") == "1" and isinstance(got.get("result"), list) and got["result"][0].get("SourceCode"):
    print(f"    already verified on MonadScan as {got['result'][0].get('ContractName')}")
    sys.exit(0)

std = subprocess.run(
    ["forge", "verify-contract", address, contract, "--chain", str(CHAIN), "--verifier", "sourcify", "--show-standard-json-input"],
    check=True, capture_output=True, text=True,
).stdout
json.loads(std)  # forge printed exactly one JSON document
artifact = json.load(open(f"out/{os.path.basename(path)}/{name}.json"))
meta = artifact.get("metadata") or json.loads(artifact["rawMetadata"])
compiler = "v" + meta["compiler"]["version"]

body = {
    "contractaddress": address,
    "sourceCode": std,
    "codeformat": "solidity-standard-json-input",
    "contractname": contract,
    "compilerversion": compiler,
    # Etherscan's historical spelling and the documented one; whichever the backend reads.
    "constructorArguements": ctor,
    "constructorArguments": ctor,
}
sub = api({"action": "verifysourcecode"}, body)
if sub.get("status") != "1":
    sys.exit(f"    MonadScan refused: {sub.get('result') or sub.get('message')}")
guid = sub["result"]
print(f"    submitted, guid {guid}, compiler {compiler}")
for _ in range(30):
    time.sleep(6)
    st = api({"action": "checkverifystatus", "guid": guid})
    text = str(st.get("result") or st.get("message"))
    if "pending" in text.lower():
        continue
    if st.get("status") == "1" or text.lower().startswith("pass"):
        print(f"    {text}")
        sys.exit(0)
    sys.exit(f"    MonadScan: {text}")
sys.exit("    still pending after 3 minutes; re-run later (it is idempotent)")
