/**
 * Explorer contract verification for the clones the factory deploys.
 *
 * ## What "verifying a DokuToken" means
 *
 * Every launch deploys two EIP-1167 minimal proxies — the token and the curve — each 45 bytes of
 * runtime code that delegates to an implementation the factory created once
 * (`DokuFactory.tokenImplementation()` / `curveImplementation()`). A clone has no source of its own
 * to submit: what an explorer needs is (1) the implementation verified, once per generation, from
 * the exact source and compiler settings (`contracts/script/verify.sh`), and (2) the clone marked as
 * a proxy OF that implementation so its page reads and writes through the implementation's ABI.
 *
 * Both explorers resolve EIP-1167 clones from their bytecode once (1) has happened — measured on
 * MonadScan 2026-09-13: minutes after the implementation verified, every clone answered
 * `getsourcecode` with `Proxy: 2`, the implementation and the source, with no call made for it.
 * So per launch this module CHECKS (`getsourcecode`) and records; only a clone the explorer has
 * not resolved gets the nudge — `verifyproxycontract` + `checkproxyverification` — and the poll.
 * MonadVision (BlockVision's Sourcify) has no per-clone endpoint at all; its implementation status
 * is checked at boot and shouted about when (1) is missing.
 *
 * Addresses are sent EIP-55 checksummed: the API answers "Please enter a valid contract address"
 * to a lowercase one.
 *
 * ## Shape
 *
 * Pure functions over an injected `fetch`/`sleep`, so every branch — pending, success, the
 * implementation-not-verified failure, a rate limit, a bad key — is exercised in a test without
 * an explorer. The queue that serialises calls and persists outcomes is `verifier.ts`.
 *
 * ## The key
 *
 * Etherscan-family APIs take the key as a query parameter. It is read from the environment once,
 * carried in `VerifierConfig`, appended to the URL at the moment of the request, and never
 * appears in a log line: every log carries `redactedUrl`, built without it.
 */

import { getAddress } from "viem";

export interface VerifierConfig {
  chainId: number;
  /** Etherscan v2 multichain endpoint. */
  apiUrl: string;
  /** Secret. Never logged. */
  apiKey: string;
  /** Sourcify (MonadVision) — status reads only. */
  sourcifyUrl: string;
}

export const DEFAULT_MONADSCAN_API_URL = "https://api.etherscan.io/v2/api";
export const DEFAULT_SOURCIFY_URL = "https://sourcify-api-monad.blockvision.org";

/** `null` when no key is configured: verification is off and launches are unaffected. */
export function readVerifierConfig(
  env: Record<string, string | undefined>,
  chainId: number,
): VerifierConfig | null {
  const apiKey = env.MONADSCAN_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    chainId,
    apiUrl: (env.MONADSCAN_API_URL?.trim() || DEFAULT_MONADSCAN_API_URL).replace(/\/+$/, ""),
    apiKey,
    sourcifyUrl: (env.SOURCIFY_API_URL?.trim() || DEFAULT_SOURCIFY_URL).replace(/\/+$/, ""),
  };
}

export interface ProxyRequest {
  address: string;
  expectedImplementation: string;
}

export type ProxyState = "pending" | "verified" | "failed";

export interface ProxyOutcome {
  state: ProxyState;
  guid: string | null;
  /** The explorer's own words, for the record and the log. */
  message: string;
  attempts: number;
}

export interface ExplorerIo {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface EtherscanReply {
  status: string;
  message: string;
  result: string;
}

/** The URL as it is safe to log: same query, no key. */
export function redactedUrl(cfg: VerifierConfig, params: Record<string, string>): string {
  const u = new URL(cfg.apiUrl);
  u.searchParams.set("chainid", String(cfg.chainId));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function keyedUrl(cfg: VerifierConfig, params: Record<string, string>): string {
  const u = new URL(redactedUrl(cfg, params));
  u.searchParams.set("apikey", cfg.apiKey);
  return u.toString();
}

/** Errors that are the explorer's or the network's, not ours: worth another attempt. */
export class RetryableError extends Error {}
/** The key is wrong: every later call would fail the same way. The queue disarms itself. */
export class InvalidKeyError extends Error {}

const isRateLimited = (s: string) => /rate limit|too many requests/i.test(s);
const isInvalidKey = (s: string) => /invalid api key|missing\/invalid api key/i.test(s);

async function call(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<EtherscanReply> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (e) {
    throw new RetryableError(`network: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (response.status === 429 || response.status >= 500) {
    throw new RetryableError(`http ${response.status}`);
  }
  let body: EtherscanReply;
  try {
    body = (await response.json()) as EtherscanReply;
  } catch {
    throw new RetryableError(`http ${response.status}: not json`);
  }
  const result = typeof body.result === "string" ? body.result : JSON.stringify(body.result);
  if (body.status !== "1") {
    if (isInvalidKey(result) || isInvalidKey(body.message ?? "")) throw new InvalidKeyError(result);
    if (isRateLimited(result)) throw new RetryableError(result);
  }
  return { status: body.status, message: body.message, result };
}

/** `verifyproxycontract`: hands back the guid the explorer tracks the request by. */
export async function submitProxyVerification(
  cfg: VerifierConfig,
  req: ProxyRequest,
  io: ExplorerIo = {},
): Promise<{ guid: string } | { rejected: string }> {
  const f = io.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    address: getAddress(req.address),
    expectedimplementation: getAddress(req.expectedImplementation),
  });
  const reply = await call(
    keyedUrl(cfg, { module: "contract", action: "verifyproxycontract" }),
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body },
    f,
  );
  if (reply.status === "1" && reply.result) return { guid: reply.result };
  return { rejected: reply.result || reply.message };
}

/** `checkproxyverification`: pending, done, or a reason. */
export async function checkProxyVerification(
  cfg: VerifierConfig,
  guid: string,
  io: ExplorerIo = {},
): Promise<{ state: ProxyState; message: string }> {
  const f = io.fetchImpl ?? fetch;
  const reply = await call(
    keyedUrl(cfg, { module: "contract", action: "checkproxyverification", guid }),
    { method: "GET" },
    f,
  );
  const text = reply.result || reply.message;
  if (/pending/i.test(text)) return { state: "pending", message: text };
  if (reply.status === "1" && /successfully/i.test(text)) return { state: "verified", message: text };
  return { state: "failed", message: text };
}

/**
 * Whether the explorer already shows this clone as a proxy of the expected implementation, with
 * source. `getsourcecode` returns `Proxy` = "1"/"2" and `Implementation` once it has resolved the
 * EIP-1167 bytecode against a verified implementation.
 */
export async function cloneStatus(
  cfg: VerifierConfig,
  req: ProxyRequest,
  io: ExplorerIo = {},
): Promise<{ resolved: boolean; message: string }> {
  const f = io.fetchImpl ?? fetch;
  const reply = await call(
    keyedUrl(cfg, { module: "contract", action: "getsourcecode", address: getAddress(req.address) }),
    { method: "GET" },
    f,
  );
  let row: { ContractName?: string; Proxy?: string; Implementation?: string; SourceCode?: string } | undefined;
  try {
    const parsed = JSON.parse(reply.result) as unknown;
    row = Array.isArray(parsed) ? (parsed[0] as typeof row) : undefined;
  } catch {
    row = undefined;
  }
  if (!row) return { resolved: false, message: reply.result || reply.message };
  const impl = (row.Implementation ?? "").toLowerCase();
  const resolved =
    (row.Proxy === "1" || row.Proxy === "2") &&
    impl === req.expectedImplementation.toLowerCase() &&
    Boolean(row.SourceCode);
  return {
    resolved,
    message: resolved
      ? `resolved as ${row.ContractName ?? "?"} → ${impl}`
      : `not resolved (proxy=${row.Proxy ?? "?"}, implementation=${impl || "none"}, source=${row.SourceCode ? "yes" : "no"})`,
  };
}

export interface RetryPolicy {
  /**
   * How long to wait before the first status read. An explorer indexes a fresh clone a little
   * after the block lands — measured ~20 s on MonadScan for the GEN7 canary — and a read before
   * that says "not resolved", which then turns a needless nudge into a refusal.
   */
  initialDelayMs: number;
  /** Submission attempts on retryable errors. */
  submitAttempts: number;
  /** Backoff between submission attempts, in ms, one per retry; the last repeats. */
  submitBackoffMs: number[];
  /** How many times to poll a pending guid before handing it to the backfill. */
  pollAttempts: number;
  pollIntervalMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  initialDelayMs: 20_000,
  submitAttempts: 5,
  submitBackoffMs: [2_000, 10_000, 30_000, 60_000],
  pollAttempts: 12,
  pollIntervalMs: 5_000,
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Submit, then poll. Never throws for anything the explorer said; throws `InvalidKeyError` so
 * the caller can disarm, and `RetryableError` only after the policy is exhausted.
 */
export async function verifyProxy(
  cfg: VerifierConfig,
  req: ProxyRequest,
  io: ExplorerIo = {},
  policy: RetryPolicy = DEFAULT_RETRY,
): Promise<ProxyOutcome> {
  const sleep = io.sleep ?? defaultSleep;
  let attempts = 0;
  let guid: string | null = null;
  // The explorer usually has the clone resolved on its own; then there is nothing to submit.
  if (policy.initialDelayMs > 0) await sleep(policy.initialDelayMs);
  try {
    attempts += 1;
    const status = await cloneStatus(cfg, req, io);
    if (status.resolved) return { state: "verified", guid: null, message: status.message, attempts };
  } catch (e) {
    if (e instanceof InvalidKeyError) throw e;
    // A failed read is not a reason to skip the nudge.
  }
  // Submission attempts are counted on their own: the status read above is not one of them.
  for (let submits = 1; ; submits += 1) {
    attempts += 1;
    try {
      const r = await submitProxyVerification(cfg, req, io);
      if ("guid" in r) {
        guid = r.guid;
        break;
      }
      return { state: "failed", guid: null, message: r.rejected, attempts };
    } catch (e) {
      if (e instanceof InvalidKeyError) throw e;
      if (!(e instanceof RetryableError) || submits >= policy.submitAttempts) throw e;
      const backoff = policy.submitBackoffMs[Math.min(submits - 1, policy.submitBackoffMs.length - 1)] ?? 0;
      await sleep(backoff);
    }
  }
  const outcome = await pollProxy(cfg, guid, io, policy, attempts);
  if (outcome.state !== "failed") return outcome;
  // A refused nudge is usually the explorer not having indexed the clone yet; by now it may have.
  try {
    await sleep(policy.pollIntervalMs);
    const again = await cloneStatus(cfg, req, io);
    if (again.resolved) {
      return { state: "verified", guid, message: again.message, attempts: outcome.attempts + 1 };
    }
  } catch (e) {
    if (e instanceof InvalidKeyError) throw e;
  }
  return outcome;
}

/** Resume a guid the process could not wait out (the backfill's path). */
export async function pollProxy(
  cfg: VerifierConfig,
  guid: string,
  io: ExplorerIo = {},
  policy: RetryPolicy = DEFAULT_RETRY,
  attempts = 0,
): Promise<ProxyOutcome> {
  const sleep = io.sleep ?? defaultSleep;
  let message = "Pending in queue";
  for (let i = 0; i < policy.pollAttempts; i += 1) {
    await sleep(policy.pollIntervalMs);
    attempts += 1;
    try {
      const c = await checkProxyVerification(cfg, guid, io);
      message = c.message;
      if (c.state !== "pending") return { state: c.state, guid, message, attempts };
    } catch (e) {
      if (e instanceof InvalidKeyError) throw e;
      if (!(e instanceof RetryableError)) throw e;
      message = e.message;
    }
  }
  return { state: "pending", guid, message, attempts };
}

export type SourcifyStatus = "exact_match" | "match" | "unverified" | "unknown";

/**
 * Whether Sourcify (MonadVision) holds a match for an address. Read-only; a network failure is
 * `unknown`, never a throw — this is a boot-time warning, not a gate.
 */
export async function sourcifyStatus(
  sourcifyUrl: string,
  chainId: number,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SourcifyStatus> {
  try {
    const r = await fetchImpl(`${sourcifyUrl.replace(/\/+$/, "")}/v2/contract/${chainId}/${address}`);
    if (!r.ok) return r.status === 404 ? "unverified" : "unknown";
    const j = (await r.json()) as { match?: string | null };
    if (j.match === "exact_match") return "exact_match";
    if (j.match) return "match";
    return "unverified";
  } catch {
    return "unknown";
  }
}
