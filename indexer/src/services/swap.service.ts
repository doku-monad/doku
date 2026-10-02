import type { SwapRepository } from "../repositories/index.js";
import type { AccountSwapRow, Page, SwapRow } from "../types/api.js";
import { clampLimit, normalizeAddress } from "./pagination.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export class SwapService {
  constructor(private readonly swaps: SwapRepository) {}

  async listForMarket(
    market: string,
    rawLimit?: string,
    cursor?: string,
    trader?: string,
  ): Promise<Page<SwapRow>> {
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
    const items = await this.swaps.listForMarket(
      normalizeAddress(market),
      limit,
      cursor ?? null,
      trader ? normalizeAddress(trader) : null,
    );
    return { items, nextCursor: items.at(-1)?.id ?? null };
  }

  async listForAccount(
    account: string,
    rawLimit?: string,
    cursor?: string,
  ): Promise<Page<AccountSwapRow>> {
    const limit = clampLimit(rawLimit, DEFAULT_LIMIT, MAX_LIMIT);
    const items = await this.swaps.listForAccount(normalizeAddress(account), limit, cursor ?? null);
    return { items, nextCursor: items.at(-1)?.id ?? null };
  }
}
