const FEATURE_FLAGS = {
  /**
   * Cult is off by default. Set `NEXT_PUBLIC_CULT_ENABLED=true` to bring the page and its nav entry
   * back — the route still exists, so this is a switch rather than a deletion.
   */
  Cult: process.env.NEXT_PUBLIC_CULT_ENABLED === "true",
  /**
   * Third-party liquidity provision, on Uniswap v4. Off unless a deployment asks for it.
   *
   * The mechanical objection is gone: everything under `/pools` used to call V3's
   * `NonfungiblePositionManager` — `mint`, `decreaseLiquidity`, `collect`, `burn`, `unwrapWETH9`,
   * `refundETH` — and none of those exists in v4, so every button reverted. It is built on
   * `modifyLiquidities` with encoded actions, Permit2 approvals, and pool reads through StateView
   * by pool id. See `liquidity-calls.ts`.
   *
   * The economic objection never left, and generation 4 made it explicit rather than incidental.
   * The canonical pool's LP fee is ZERO and must stay zero — the levy is skimmed from the swap's own
   * flash accounting, which a non-zero fee makes unimplementable — and `DokuHook.LP_LEVY_BPS`, the
   * would-be offsetting income, is credited straight to the market's sink ledger rather than donated
   * to in-range positions (see `LP_LEVY_BPS`'s docblock). A provider earns nothing from any source,
   * and still pays a maker levy on both legs entering and leaving — see `maker-levy.ts`. This is not
   * a reason to delete the feature: holding both sides of a market through a Uniswap position is a
   * real thing to want, just not a yield, and the panel says so (`position-fees.ts`,
   * `LiquidityPanel.tsx`).
   *
   * It is still a flag, and still off by default, for reasons that are current rather than
   * historical. Providing liquidity is now expected to lose money to the maker levy and impermanent
   * loss with nothing offsetting it, which is not a default a launchpad should opt people into
   * quietly. Markets graduated under an earlier hook keep that hook forever (a hook address is part
   * of a `PoolKey`; there is no migration) — some of those still pay their providers a real donation,
   * but the panel does not distinguish per market, so it is deliberately conservative rather than
   * partially right. And the panel's arithmetic is not multi-quote: it scales both sides by eighteen
   * decimals and labels every figure MON, so it is correct only for a MON-quoted pool — which the
   * panel now checks rather than assumes.
   */
  Liquidity: process.env.NEXT_PUBLIC_LIQUIDITY_ENABLED === "true",
  /**
   * Protocol-wide numbers, at `/stats`.
   *
   * Off by default, and the route is *locked* rather than removed: it answers with a coming-soon
   * screen and the `More` menu marks it, so the entry is honest in both places at once. The page
   * itself is finished — it sums volume, raised, trades, holders and graduations over every market
   * the indexer returns — which is exactly why it is a flag and not a deletion: the numbers are
   * real, and a launchpad publishing protocol-wide totals before there is a protocol's worth of
   * activity behind them is publishing a claim about itself.
   *
   * Set `NEXT_PUBLIC_STATS_ENABLED=true` to open it.
   */
  Stats: process.env.NEXT_PUBLIC_STATS_ENABLED === "true",
} as const;

export default FEATURE_FLAGS;
