"use client";

import { useQuery } from "@tanstack/react-query";

export interface Position {
  tokenAddress: string;
  marketAddress: string;
  symbol: string;
  balance: bigint;
  /**
   * Whole units of `quoteSymbol` per whole token, or `null` where that market could not be read.
   *
   * It was typed `number` while the route could already answer `null`, which is a lie the compiler
   * was helping to keep: every consumer did arithmetic on it and got `NaN` on the one row with no
   * price. The route resolves each row against its own market's generation now — see
   * `getPortfolio` — so `null` means "that market was unreachable", not "this feed does not know
   * what its prices mean".
   */
  lastPrice: number | null;
  /**
   * Balance times price, in whole units of `quoteSymbol`.
   *
   * **Not addable to another position's** unless they share a quote asset. See `quote-groups`.
   */
  valueMon: number | null;
  /** What this position's figures are denominated in. */
  quoteAsset: string;
  quoteSymbol: string | null;
  quoteDecimals: number;
  graduated: boolean;
}

/**
 * An account's holdings.
 *
 * One request. The symbol and price arrive joined to each balance, because resolving them
 * per-token in the browser turns a twenty-position portfolio into twenty-one round trips and
 * renders a column of raw addresses while they land.
 */
export function usePortfolio(address: string) {
  return useQuery({
    queryKey: ["portfolio", address],
    queryFn: async (): Promise<Position[]> => {
      const res = await fetch(`/api/accounts/${address}/balances?limit=200`);
      if (!res.ok) throw new Error(`portfolio: ${res.status}`);
      const body = (await res.json()) as {
        items: (Omit<Position, "balance"> & { balance: string })[];
      };
      return body.items.map((p) => ({ ...p, balance: BigInt(p.balance) }));
    },
  });
}
