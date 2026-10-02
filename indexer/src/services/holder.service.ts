import type { HolderRepository } from "../repositories/index.js";
import type { BalanceRow, HolderRow, Page } from "../types/api.js";
import { clampLimit, normalizeAddress } from "./pagination.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class HolderService {
  constructor(private readonly holders: HolderRepository) {}

  async listForMarket(market: string, rawLimit?: string, cursor?: string): Promise<Page<HolderRow>> {
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
    const items = await this.holders.listForMarket(normalizeAddress(market), limit, cursor ?? null);
    const last = items.at(-1);
    // Composite cursor: balances tie often, and balance alone cannot break the tie.
    return { items, nextCursor: last ? `${last.balance}:${last.holder}` : null };
  }

  /** Not paginated by cursor: a portfolio is small and the client renders all of it. */
  async listForAccount(account: string, rawLimit?: string): Promise<{ items: BalanceRow[] }> {
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
    return { items: await this.holders.listForAccount(normalizeAddress(account), limit) };
  }
}
