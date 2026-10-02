import { beforeEach, describe, expect, it } from "vitest";
import { memoryDatabase } from "./helpers.js";
import type { Db } from "../src/db/legacy.js";
import {
  checkProxyVerification,
  InvalidKeyError,
  readVerifierConfig,
  redactedUrl,
  sourcifyStatus,
  submitProxyVerification,
  type VerifierConfig,
  verifyProxy,
} from "../src/verification/explorer.js";
import {
  configureContractVerifier,
  contractVerifierCounts,
  contractVerifierEnabled,
  contractVerifierIdle,
  queueCloneVerification,
} from "../src/verification/verifier.js";

/**
 * Explorer verification of launched clones: the request shape MonadScan expects, the key never
 * leaking, every explorer answer classified, retries on the answers that deserve them, and the
 * queue persisting outcomes without ever throwing into ingestion.
 */

const KEY = "sekrit-key-1234567890";
const cfg: VerifierConfig = {
  chainId: 143,
  apiUrl: "https://api.etherscan.io/v2/api",
  apiKey: KEY,
  sourcifyUrl: "https://sourcify-api-monad.blockvision.org",
};
const TOKEN = "0xda9946830cAcE586F10bE9f7E03D86962570B58d";
const IMPL = "0xaFfe72B720e4A786b7F0b06caF71c6f9e74E310C";
const noSleep = async () => {};
const fast = { initialDelayMs: 0, submitAttempts: 3, submitBackoffMs: [1, 2], pollAttempts: 3, pollIntervalMs: 1 };

/** A scripted explorer: answers in order, records what it was asked. */
function explorer(replies: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : null });
    const next = replies.shift();
    if (!next) throw new Error("explorer: no scripted reply left");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const ok = (result: string) => ({ body: { status: "1", message: "OK", result } });
const notOk = (result: string) => ({ body: { status: "0", message: "NOTOK", result } });
const SUCCESS = `The proxy's (${TOKEN}) implementation contract is found at ${IMPL} and is successfully updated.`;
/** `getsourcecode` before the explorer has linked the clone. */
const UNRESOLVED = { body: { status: "1", message: "OK", result: [{ ContractName: "", Proxy: "0", Implementation: "", SourceCode: "" }] } };
/** `getsourcecode` once it has: what MonadScan answered for the GEN6 canary on 2026-09-13. */
const RESOLVED = { body: { status: "1", message: "OK", result: [{ ContractName: "DokuToken", Proxy: "2", Implementation: IMPL.toLowerCase(), SourceCode: "{{…}}" }] } };

describe("configuration", () => {
  it("is off without a key, and reads the defaults with one", () => {
    expect(readVerifierConfig({}, 143)).toBeNull();
    expect(readVerifierConfig({ MONADSCAN_API_KEY: "  " }, 143)).toBeNull();
    expect(readVerifierConfig({ MONADSCAN_API_KEY: KEY }, 143)).toEqual(cfg);
    expect(readVerifierConfig({ MONADSCAN_API_KEY: KEY, MONADSCAN_API_URL: "https://x/api/" }, 143)?.apiUrl).toBe("https://x/api");
  });

  it("never puts the key in the URL it logs, and always puts it in the URL it calls", async () => {
    const logged = redactedUrl(cfg, { module: "contract", action: "verifyproxycontract" });
    expect(logged).not.toContain(KEY);
    expect(logged).toContain("chainid=143");
    const e = explorer([ok("guid-1")]);
    await submitProxyVerification(cfg, { address: TOKEN.toLowerCase(), expectedImplementation: IMPL.toLowerCase() }, { fetchImpl: e.fetchImpl });
    expect(e.calls[0]!.url).toContain(`apikey=${KEY}`);
    expect(e.calls[0]!.url).toContain("action=verifyproxycontract");
    expect(e.calls[0]!.method).toBe("POST");
    expect(e.calls[0]!.body).toBe(`address=${TOKEN}&expectedimplementation=${IMPL}`);
  });
});

describe("the explorer's answers", () => {
  it("submits, polls through pending, and reports verified", async () => {
    const e = explorer([UNRESOLVED, ok("guid-1"), ok("Pending in queue"), ok(SUCCESS)]);
    const out = await verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: noSleep }, fast);
    expect(out).toEqual({ state: "verified", guid: "guid-1", message: SUCCESS, attempts: 4 });
    expect(e.calls[0]!.url).toContain("action=getsourcecode");
    expect(e.calls[2]!.url).toContain("action=checkproxyverification");
    expect(e.calls[2]!.url).toContain("guid=guid-1");
  });

  it("submits nothing for a clone the explorer has already resolved on its own", async () => {
    const e = explorer([RESOLVED]);
    const out = await verifyProxy(cfg, { address: TOKEN.toLowerCase(), expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: noSleep }, fast);
    expect(out).toMatchObject({ state: "verified", guid: null, attempts: 1 });
    expect(out.message).toMatch(/resolved as DokuToken/);
    expect(e.calls).toHaveLength(1);
    // Checksummed on the wire, whatever case it arrived in.
    expect(e.calls[0]!.url).toContain(`address=${TOKEN}`);
  });

  it("retries a rate limit and a network failure on submission, with the backoff it was given", async () => {
    const slept: number[] = [];
    const e = explorer([UNRESOLVED, notOk("Max rate limit reached"), new Error("ECONNRESET"), ok("guid-2"), ok(SUCCESS)]);
    const out = await verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: async (ms) => { slept.push(ms); } }, fast);
    expect(out.state).toBe("verified");
    expect(slept.slice(0, 2)).toEqual([1, 2]);
  });

  it("gives up on submission after the policy's attempts", async () => {
    const e = explorer([UNRESOLVED, { status: 503, body: {} }, { status: 503, body: {} }, { status: 503, body: {} }]);
    await expect(
      verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: noSleep }, fast),
    ).rejects.toThrow(/http 503/);
  });

  it("reports a refusal as failed, in the explorer's words, without throwing", async () => {
    const refusal = "A corresponding implementation contract was unfortunately not found for the proxy address.";
    const e = explorer([UNRESOLVED, ok("guid-3"), ok(refusal), UNRESOLVED]);
    const out = await verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: noSleep }, fast);
    expect(out).toMatchObject({ state: "failed", guid: "guid-3", message: refusal });
  });

  it("waits before the first read, and treats a refusal followed by a resolved read as verified", async () => {
    // The GEN7 canary: nudged two seconds after creation, refused, resolved by the explorer twenty
    // seconds later on its own.
    const slept: number[] = [];
    const refusal = "A corresponding implementation contract was unfortunately not detected for the proxy address.";
    const e = explorer([UNRESOLVED, ok("guid-7"), ok(refusal), RESOLVED]);
    const out = await verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: async (ms) => { slept.push(ms); } }, { ...fast, initialDelayMs: 20_000 });
    expect(slept[0]).toBe(20_000);
    expect(out).toMatchObject({ state: "verified", guid: "guid-7" });
    expect(out.message).toMatch(/resolved as DokuToken/);
    const rejected = explorer([UNRESOLVED, notOk("Please enter a valid contract address")]);
    const out2 = await verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: rejected.fetchImpl, sleep: noSleep }, fast);
    expect(out2).toMatchObject({ state: "failed", guid: null, attempts: 2 });
  });

  it("hands back pending with the guid when the poll budget runs out", async () => {
    const e = explorer([UNRESOLVED, ok("guid-4"), ok("Pending in queue"), ok("Pending in queue"), ok("Pending in queue")]);
    const out = await verifyProxy(cfg, { address: TOKEN, expectedImplementation: IMPL }, { fetchImpl: e.fetchImpl, sleep: noSleep }, fast);
    expect(out).toMatchObject({ state: "pending", guid: "guid-4" });
  });

  it("classifies a bad key as InvalidKeyError so the caller can disarm", async () => {
    const e = explorer([notOk("Missing/Invalid API Key")]);
    await expect(checkProxyVerification(cfg, "g", { fetchImpl: e.fetchImpl })).rejects.toBeInstanceOf(InvalidKeyError);
  });

  it("reads Sourcify's match states and never throws", async () => {
    const say = (match: string | null, status = 200) =>
      (async () => new Response(JSON.stringify({ match }), { status })) as typeof fetch;
    expect(await sourcifyStatus(cfg.sourcifyUrl, 143, IMPL, say("exact_match"))).toBe("exact_match");
    expect(await sourcifyStatus(cfg.sourcifyUrl, 143, IMPL, say("match"))).toBe("match");
    expect(await sourcifyStatus(cfg.sourcifyUrl, 143, IMPL, say(null))).toBe("unverified");
    expect(await sourcifyStatus(cfg.sourcifyUrl, 143, IMPL, say(null, 404))).toBe("unverified");
    expect(await sourcifyStatus(cfg.sourcifyUrl, 143, IMPL, (async () => { throw new Error("down"); }))).toBe("unknown");
  });
});

describe("the queue", () => {
  let db: Db;
  beforeEach(async () => {
    db = (await memoryDatabase()).legacy;
  });
  const row = async (address: string) =>
    (await db.query<{ status: string; guid: string | null; kind: string; implementation: string; attempts: number; last_error: string | null }>(
      "SELECT status, guid, kind, implementation, attempts, last_error FROM contract_verifications WHERE address = $1",
      [address.toLowerCase()],
    )).rows[0];

  it("is a counted no-op without a key, and never touches the network", async () => {
    configureContractVerifier({ db, config: null });
    expect(contractVerifierEnabled()).toBe(false);
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL });
    await contractVerifierIdle();
    expect(await row(TOKEN)).toBeUndefined();
  });

  it("verifies a launch's clones one after another and persists each outcome", async () => {
    const e = explorer([UNRESOLVED, ok("g-t"), ok(SUCCESS), UNRESOLVED, ok("g-c"), ok("Pending in queue"), ok("Pending in queue"), ok("Pending in queue")]);
    configureContractVerifier({ db, config: cfg, io: { fetchImpl: e.fetchImpl, sleep: noSleep }, policy: fast });
    const before = contractVerifierCounts();
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL });
    queueCloneVerification({ address: "0xCDA36Db426b2753eFeE4d2D01006d27EDbAC5fEC", kind: "curve", implementation: "0x8A66d3542d7C16EC318F42ad0b7f1b1E5537d9aF" });
    await contractVerifierIdle();
    expect(await row(TOKEN)).toMatchObject({ status: "verified", guid: "g-t", kind: "token", implementation: IMPL.toLowerCase(), last_error: null });
    expect(await row("0xCDA36Db426b2753eFeE4d2D01006d27EDbAC5fEC")).toMatchObject({ status: "submitted", guid: "g-c", kind: "curve" });
    const after = contractVerifierCounts();
    expect(after.verified - before.verified).toBe(1);
    expect(after.pending - before.pending).toBe(1);
    // The token's submission went out before the curve's: serialised, not raced.
    expect(e.calls.map((c) => c.url.includes("verifyproxycontract"))).toEqual([false, true, false, false, true, false, false, false]);
  });

  it("does not resubmit a clone the table already says is verified", async () => {
    const e = explorer([RESOLVED]);
    configureContractVerifier({ db, config: cfg, io: { fetchImpl: e.fetchImpl, sleep: noSleep }, policy: fast });
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL });
    await contractVerifierIdle();
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL });
    await contractVerifierIdle();
    expect(e.calls).toHaveLength(1);
  });

  it("records a refusal, keeps going, and never throws into the caller", async () => {
    const e = explorer([UNRESOLVED, ok("g-1"), ok("A corresponding implementation contract was unfortunately not found for the proxy address."), UNRESOLVED]);
    configureContractVerifier({ db, config: cfg, io: { fetchImpl: e.fetchImpl, sleep: noSleep }, policy: fast });
    expect(() => queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL })).not.toThrow();
    await contractVerifierIdle();
    expect(await row(TOKEN)).toMatchObject({ status: "failed", attempts: 3 });
    expect((await row(TOKEN))!.last_error).toMatch(/unfortunately not found/);
  });

  it("disarms itself on a rejected key instead of failing every launch after", async () => {
    const e = explorer([notOk("Missing/Invalid API Key")]);
    configureContractVerifier({ db, config: cfg, io: { fetchImpl: e.fetchImpl, sleep: noSleep }, policy: fast });
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL });
    await contractVerifierIdle();
    expect(contractVerifierEnabled()).toBe(false);
    expect(contractVerifierCounts().disarmed).toMatch(/Invalid API Key/);
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: IMPL });
    await contractVerifierIdle();
    expect(e.calls).toHaveLength(1);
  });

  it("skips a clone whose implementation is not known yet", async () => {
    const e = explorer([]);
    configureContractVerifier({ db, config: cfg, io: { fetchImpl: e.fetchImpl, sleep: noSleep }, policy: fast });
    queueCloneVerification({ address: TOKEN, kind: "token", implementation: "" });
    await contractVerifierIdle();
    expect(e.calls).toHaveLength(0);
  });
});
