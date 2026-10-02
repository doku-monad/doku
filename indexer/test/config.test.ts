import { describe, expect, it } from "vitest";

import { readChainConfig } from "../src/config/index.js";

/**
 * Boot-time configuration.
 *
 * Every value here has the same failure shape: wrong or missing, the service starts anyway and
 * looks healthy. An unset factory address became the string `"0x"`, which matches no logs, so the
 * indexer reported zero events forever and a chain with no activity looks identical. A start
 * block of zero on a chain 55 million blocks deep is not an error either — it is a scan that
 * never reaches the present.
 *
 * So this refuses to return a partial configuration. A process that will not start is the
 * cheapest way to find out, and the only one that happens before anybody trusts the data.
 */
describe("chain config", () => {
  const complete = {
    MONAD_RPC_URL: "https://rpc.example",
    MONAD_CHAIN_ID: "10143",
    FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
    GRADUATION_ADDRESS: "0x2222222222222222222222222222222222222222",
    // Required, and the `refuses to start without X` loop below covers it automatically: every key
    // in this object is asserted to be mandatory, so adding it here is what makes that a test.
    POOL_MANAGER_ADDRESS: "0x4444444444444444444444444444444444444444",
    START_BLOCK: "12345",
  };

  /**
   * More than one graduator can be live at once.
   *
   * A market pins its graduator when it launches and never re-reads it, so the markets still
   * bonding when a new one is deployed graduate through the OLD one. Accepting `Graduated` from
   * only the newest address drops those silently — the market graduates on chain and, to anything
   * reading the indexer, simply never does. So the setting is a list.
   */
  it("accepts a list of graduators, newest first", () => {
    const cfg = readChainConfig({
      ...complete,
      GRADUATION_ADDRESS:
        "0x60B880aE6D3e71D92e671879E0c5EefFbf80bB6b,0x0f2cBA4FfAd6F698fde6674ef08cbF138Bc89adF",
    });
    expect(cfg.graduators).toEqual([
      "0x60b880ae6d3e71d92e671879e0c5eeffbf80bb6b",
      "0x0f2cba4ffad6f698fde6674ef08cbf138bc89adf",
    ]);
    // The first is the primary: it is what the rewind and the start-block resolution use.
    expect(cfg.graduation).toBe("0x60b880ae6d3e71d92e671879e0c5eeffbf80bb6b");
  });

  it("still takes a single graduator", () => {
    const cfg = readChainConfig(complete);
    expect(cfg.graduators).toEqual(["0x2222222222222222222222222222222222222222"]);
  });

  it("refuses a malformed address inside the list", () => {
    expect(() =>
      readChainConfig({ ...complete, GRADUATION_ADDRESS: `${complete.GRADUATION_ADDRESS},0xnope` }),
    ).toThrow(/GRADUATION_ADDRESS/);
  });

  it("reads a complete configuration", () => {
    const cfg = readChainConfig(complete);
    expect(cfg.chainId).toBe(10143);
    expect(cfg.startBlock).toBe(12345n);
    expect(cfg.factory).toBe("0x1111111111111111111111111111111111111111");
    expect(cfg.rpcUrl).toBe("https://rpc.example");
  });

  it("lowercases addresses, whatever case they were pasted in", () => {
    const cfg = readChainConfig({
      ...complete,
      FACTORY_ADDRESS: complete.FACTORY_ADDRESS.toUpperCase().replace("0X", "0x"),
    });
    expect(cfg.factory).toBe(complete.FACTORY_ADDRESS);
  });

  for (const key of Object.keys(complete)) {
    it(`refuses to start without ${key}`, () => {
      const partial = { ...complete } as Record<string, string | undefined>;
      delete partial[key];
      expect(() => readChainConfig(partial)).toThrow(new RegExp(key));
    });
  }

  /// `"0x"` is what an unset address used to become: a well-formed-looking value that matches no
  /// log the chain will ever emit.
  it("rejects an address that is only a prefix", () => {
    expect(() => readChainConfig({ ...complete, FACTORY_ADDRESS: "0x" })).toThrow(/FACTORY_ADDRESS/);
  });

  it("rejects a start block that is not a number", () => {
    expect(() => readChainConfig({ ...complete, START_BLOCK: "genesis" })).toThrow(/START_BLOCK/);
  });

  /**
   * Zero is the value that hurts: it is what the old default was, it parses, and it produces a
   * scan from genesis that on a live chain never catches up. A deployment that means it can say
   * so — but it has to say so.
   */
  it("accepts an explicit start block of zero", () => {
    expect(readChainConfig({ ...complete, START_BLOCK: "0" }).startBlock).toBe(0n);
  });

  it("rejects a chain id that is not a positive integer", () => {
    expect(() => readChainConfig({ ...complete, MONAD_CHAIN_ID: "0" })).toThrow(/MONAD_CHAIN_ID/);
    expect(() => readChainConfig({ ...complete, MONAD_CHAIN_ID: "monad" })).toThrow(/MONAD_CHAIN_ID/);
  });

  /**
   * Named together, because the report an operator wants is "these four are missing", not four
   * consecutive restarts each revealing one more.
   */
  it("names every missing variable at once", () => {
    expect(() => readChainConfig({})).toThrow(/MONAD_RPC_URL[\s\S]*FACTORY_ADDRESS/);
  });
});
