import { beforeEach, describe, expect, it } from "vitest";

import { createApi } from "../src/app/index.js";
import type { Db } from "../src/db/legacy.js";
import { memoryDatabase, seedMarket } from "./helpers.js";

const DEAD = "0x000000000000000000000000000000000000dead";

describe("holders share and label", () => {
  let api: ReturnType<typeof createApi>;
  let db: Db;

  beforeEach(async () => {
    const database = await memoryDatabase();
    db = database.legacy;
    api = createApi(database);
    await seedMarket(db, "0xm", "0xt");
    await db.query("UPDATE markets SET creator = '0xcreator', total_supply = 1000 WHERE market_address = '0xm'");
    await db.query(`INSERT INTO graduations (market_address, pool_address, pool_id, hooks, sink, token_id, quote_amount, base_amount, liquidity, block_number, block_hash, log_index, tx_hash, ts)
                    VALUES ('0xm', '0xpool', '0xpid', '0xhook', '0xsink', 0, 0, 0, 0, 1, '0xb', 0, '0xg', NOW())`);
    for (const [holder, bal] of [
      ["0xm", 400],
      ["0xpool", 100],
      [DEAD, 100],
      ["0xcreator", 200],
      ["0xsink", 50],
      ["0xhook", 10],
      ["0xalice", 140],
    ] as const) {
      await db.query("INSERT INTO token_balances (token_address, holder, balance) VALUES ('0xt', $1, $2)", [holder, bal]);
    }
  });

  const list = async () =>
    (await (await api.request("http://x/markets/0xm/holders")).json()) as {
      items: { holder: string; balance: string; share: string; label: string | null }[];
    };

  it("lists what the count counts: no curve, pool, hook, sink or dead address", async () => {
    const body = await list();
    expect(body.items.map((i) => i.holder)).toEqual(["0xcreator", "0xalice"]);
  });

  it("reports each holder's share of supply, and labels the creator", async () => {
    const body = await list();
    // supply = 1000, nothing burned: the pool's and the curve's holdings are still supply.
    expect(body.items).toEqual([
      { holder: "0xcreator", balance: "200", share: "0.200000", label: "creator" },
      { holder: "0xalice", balance: "140", share: "0.140000", label: null },
    ]);
  });

  it("nets burned tokens out of the supply", async () => {
    await db.query(
      "INSERT INTO market_rewards (market_address, burned_tokens) VALUES ('0xm', 200) ON CONFLICT (market_address) DO UPDATE SET burned_tokens = 200",
    );
    const body = await list();
    // supply = 1000 - 200 burned = 800
    expect(body.items.map((i) => i.share)).toEqual(["0.250000", "0.175000"]);
  });

  it("reports share 0 when there is no supply", async () => {
    await db.query("UPDATE markets SET total_supply = 0 WHERE market_address = '0xm'");
    const body = await list();
    expect(body.items.every((i) => i.share === "0.000000")).toBe(true);
  });
});
