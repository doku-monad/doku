/**
 * @jest-environment node
 *
 * Node, not jsdom: the client is isomorphic and the test builds real `Response` objects, which the
 * project's jsdom environment does not provide. Testing against a hand-rolled response stub would
 * mean asserting the client agrees with my idea of the Fetch API rather than with the Fetch API.
 */
import { ApiError, createApiClient } from "../../src/lib/api/client";

/**
 * The read path to the indexer.
 *
 * The failure worth designing against is not a network error — it is a *quiet* one. A fetch helper
 * that swallows failures turns a broken indexer into an empty market list, which reads as "no
 * markets yet" and gets diagnosed as a product problem for a week before anyone checks a log.
 */
describe("api client", () => {
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("returns the parsed body on success", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ items: [1, 2] }));
    const api = createApiClient("https://indexer.example", fetchImpl);
    await expect(api.get("/markets")).resolves.toEqual({ items: [1, 2] });
  });

  it("throws on a non-2xx instead of resolving to nothing", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const api = createApiClient("https://indexer.example", fetchImpl);
    await expect(api.get("/markets")).rejects.toBeInstanceOf(ApiError);
  });

  it("carries the status and path on the error, so a log says which call failed", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}, 404));
    const api = createApiClient("https://indexer.example", fetchImpl);
    await expect(api.get("/markets/0xabc")).rejects.toMatchObject({
      status: 404,
      path: "/markets/0xabc",
    });
  });

  it("throws rather than returning a string when the body is not JSON", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    );
    const api = createApiClient("https://indexer.example", fetchImpl);
    await expect(api.get("/status")).rejects.toBeInstanceOf(ApiError);
  });

  it("builds query strings without dropping falsy-but-real values", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));
    const api = createApiClient("https://indexer.example", fetchImpl);
    // `limit: 0` and `cursor: undefined` are different intentions and must not collapse together.
    await api.get("/markets", { limit: 0, cursor: undefined, period: 60 });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://indexer.example/markets?limit=0&period=60");
  });

  it("does not double the slash between base and path", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));
    const api = createApiClient("https://indexer.example/", fetchImpl);
    await api.get("/status");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://indexer.example/status");
  });
});

describe("api client under a slow or absent indexer", () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  it("gives up on a call that never answers, instead of hanging the render", async () => {
    const fetchImpl = jest.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    });
    const api = createApiClient("https://indexer.example", fetchImpl as unknown as typeof fetch, {
      timeoutMs: 30,
      retries: 0,
    });
    await expect(api.get("/markets")).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("tries once more when the request never got an answer, and not when it got an error", async () => {
    const flaky = jest
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = createApiClient("https://indexer.example", flaky as unknown as typeof fetch, { timeoutMs: 1000 });
    await expect(api.get("/markets")).resolves.toEqual({ ok: true });
    expect(flaky).toHaveBeenCalledTimes(2);

    const errored = jest.fn().mockResolvedValue(jsonResponse({}).clone());
    errored.mockResolvedValue(new Response("{}", { status: 500, headers: { "content-type": "application/json" } }));
    const api2 = createApiClient("https://indexer.example", errored as unknown as typeof fetch, { timeoutMs: 1000 });
    await expect(api2.get("/markets")).rejects.toBeInstanceOf(ApiError);
    expect(errored).toHaveBeenCalledTimes(1);
  });

  it("passes an abort signal so the indexer call is bounded", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse({}));
    const api = createApiClient("https://indexer.example", fetchImpl);
    await api.get("/markets");
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
