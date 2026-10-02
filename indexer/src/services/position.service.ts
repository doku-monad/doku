import type { PositionRepository } from "../repositories/position.repository.js";
import type { PositionRow } from "../types/api.js";
import { clampLimit, normalizeAddress } from "./pagination.js";

/** Liquidity positions, for the pools page and the portfolio. */
export class PositionService {
  constructor(private readonly positions: PositionRepository) {}

  async listForAccount(address: string, limit?: string): Promise<{ items: PositionRow[] }> {
    const items = await this.positions.listForAccount(
      normalizeAddress(address),
      clampLimit(limit, 50, 200),
    );
    return { items };
  }

  async listForMarket(market: string, limit?: string): Promise<{ items: PositionRow[] }> {
    const items = await this.positions.listForMarket(
      normalizeAddress(market),
      clampLimit(limit, 50, 200),
    );
    return { items };
  }
}
