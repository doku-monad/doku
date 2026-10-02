import { describe, expect, it } from "vitest";
import { readChainConfig, readConfig } from "../src/config/index.js";

const base = {
  MONAD_RPC_URL: "https://rpc.example",
  MONAD_CHAIN_ID: "143",
  FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111",
  GRADUATION_ADDRESS: "0x2222222222222222222222222222222222222222",
  POOL_MANAGER_ADDRESS: "0x4444444444444444444444444444444444444444",
  START_BLOCK: "1",
};
const gen2 = {
  DOKU_FACTORY2_ADDRESS: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  DOKU_QUOTE_REGISTRY: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  DOKU_CREATOR_SINK: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  DOKU_HOOK2: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  DOKU_GRADUATION2: "0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
};

/**
 * Generation 2 is opt-in by configuration and OFF by absence. Unsetting the five addresses is the
 * rollback the spec promises (§6), so "absent" has to mean "not followed", never "0x".
 */
describe("gen-2 chain config", () => {
  it("is entirely optional", () => {
    const cfg = readChainConfig(base);
    expect(cfg.factory2).toBeUndefined();
    expect(cfg.quoteRegistry).toBeUndefined();
    expect(cfg.creatorSink).toBeUndefined();
    expect(cfg.hook2).toBeUndefined();
    expect(cfg.graduators).toEqual([base.GRADUATION_ADDRESS]);
  });

  it("reads and lowercases every gen-2 address", () => {
    const cfg = readChainConfig({ ...base, ...gen2 });
    expect(cfg.factory2).toBe(gen2.DOKU_FACTORY2_ADDRESS.toLowerCase());
    expect(cfg.quoteRegistry).toBe(gen2.DOKU_QUOTE_REGISTRY.toLowerCase());
    expect(cfg.creatorSink).toBe(gen2.DOKU_CREATOR_SINK.toLowerCase());
    expect(cfg.hook2).toBe(gen2.DOKU_HOOK2.toLowerCase());
  });

  /// A gen-2 market pins DokuGraduation2, so its Graduated must be accepted like any other.
  it("appends the gen-2 graduator to the accepted list", () => {
    const cfg = readChainConfig({ ...base, ...gen2 });
    expect(cfg.graduators).toEqual([base.GRADUATION_ADDRESS, gen2.DOKU_GRADUATION2.toLowerCase()]);
    expect(cfg.graduation2).toBe(gen2.DOKU_GRADUATION2.toLowerCase());
    // The primary graduator is unchanged: rewind and holder exclusion keep using it.
    expect(cfg.graduation).toBe(base.GRADUATION_ADDRESS);
  });

  for (const key of Object.keys(gen2)) {
    it(`refuses a malformed ${key}`, () => {
      expect(() => readChainConfig({ ...base, ...gen2, [key]: "0xnope" })).toThrow(new RegExp(key));
    });
  }

  it("reads PRICE_SOURCE_URL and UPLOADS_TOKEN into the service config", () => {
    const cfg = readConfig({ ...base, PRICE_SOURCE_URL: "https://price.example/mon", UPLOADS_TOKEN: "s3cret" });
    expect(cfg.priceSourceUrl).toBe("https://price.example/mon");
    expect(cfg.uploadsToken).toBe("s3cret");
    expect(readConfig(base).priceSourceUrl).toBeUndefined();
    expect(readConfig(base).uploadsToken).toBeUndefined();
  });

  /**
   * The keeper is opt-in by key and OFF by absence — unsetting it is the rollback. A key that is
   * present and malformed is refused at boot, because the alternative is a crash after the server
   * is already up, or a keeper that silently never started.
   */
  it("leaves the keeper off when no key is set", () => {
    expect(readConfig(base).keeperPrivateKey).toBeUndefined();
    expect(readConfig({ ...base, KEEPER_PRIVATE_KEY: "" }).keeperPrivateKey).toBeUndefined();
  });

  it("reads a well-formed KEEPER_PRIVATE_KEY", () => {
    const key = `0x${"ab".repeat(32)}`;
    expect(readConfig({ ...base, KEEPER_PRIVATE_KEY: key }).keeperPrivateKey).toBe(key);
  });

  for (const bad of ["0xabc", "ab".repeat(32), `0x${"zz".repeat(32)}`]) {
    it(`refuses a malformed KEEPER_PRIVATE_KEY (${bad.slice(0, 8)}…)`, () => {
      expect(() => readConfig({ ...base, KEEPER_PRIVATE_KEY: bad })).toThrow(/KEEPER_PRIVATE_KEY/);
    });
  }

  it("burns buyback markets by default, above a hundred dollar floor", () => {
    const c = readConfig(base);
    expect(c.burn).toBe(true);
    expect(c.burnMinUsd).toBe(100);
  });

  it("turns the burn pass off by name, and only by name", () => {
    expect(readConfig({ ...base, KEEPER_BURN: "off" }).burn).toBe(false);
    expect(readConfig({ ...base, KEEPER_BURN: "OFF" }).burn).toBe(false);
    expect(readConfig({ ...base, KEEPER_BURN: "" }).burn).toBe(true);
    // Switching dividends off says nothing about burns.
    expect(readConfig({ ...base, KEEPER_PAYOUT: "off" }).burn).toBe(true);
  });

  it("reads KEEPER_BURN_MIN_USD, zero included: no floor is a choice, not a typo", () => {
    expect(readConfig({ ...base, KEEPER_BURN_MIN_USD: "0.25" }).burnMinUsd).toBe(0.25);
    expect(readConfig({ ...base, KEEPER_BURN_MIN_USD: "0" }).burnMinUsd).toBe(0);
    expect(readConfig({ ...base, KEEPER_BURN_MIN_USD: "" }).burnMinUsd).toBe(100);
  });

  it("reads blank and padded values as what was meant, never as zero: whitespace is not 'no floor'", () => {
    expect(readConfig({ ...base, KEEPER_BURN_MIN_USD: " " }).burnMinUsd).toBe(100);
    expect(readConfig({ ...base, KEEPER_BURN_MIN_USD: " 250 " }).burnMinUsd).toBe(250);
    expect(readConfig({ ...base, KEEPER_BURN: " off " }).burn).toBe(false);
    expect(readConfig({ ...base, KEEPER_BURN: "on" }).burn).toBe(true);
    expect(readConfig({ ...base, KEEPER_PAYOUT_MIN_USD: " " }).payoutMinUsd).toBe(5);
  });

  for (const off of ["false", "no", "0", "FALSE", " No "]) {
    it(`reads KEEPER_BURN=${off} as off: a kill switch set in a hurry must take`, () => {
      expect(readConfig({ ...base, KEEPER_BURN: off }).burn).toBe(false);
    });
  }

  for (const on of ["on", "true", "1", "yes"]) {
    it(`reads KEEPER_BURN=${on} as on`, () => {
      expect(readConfig({ ...base, KEEPER_BURN: on }).burn).toBe(true);
    });
  }

  for (const bad of ["offf", "disable it", "0ff"]) {
    it(`refuses KEEPER_BURN=${bad} rather than guess which way a typo was meant`, () => {
      expect(() => readConfig({ ...base, KEEPER_BURN: bad })).toThrow(/KEEPER_BURN/);
    });
  }

  for (const bad of ["one", "-1", "-0", "NaN", "Infinity", "100usd", "0x10", "1e3", "1_000"]) {
    it(`refuses a KEEPER_BURN_MIN_USD that is not a non-negative number (${bad})`, () => {
      expect(() => readConfig({ ...base, KEEPER_BURN_MIN_USD: bad })).toThrow(/KEEPER_BURN_MIN_USD/);
    });
  }

  it("rejects a PRICE_SOURCE_URL that is not http(s)", () => {
    expect(() => readConfig({ ...base, PRICE_SOURCE_URL: "ftp://x" })).toThrow(/PRICE_SOURCE_URL/);
  });
});
