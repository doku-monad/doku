import { pickableQuoteAssets, type QuoteAsset } from "@/lib/assets/quote-assets";

import AssetRegistry from "./AssetRegistry";

/**
 * The quote-asset registry.
 *
 * One job: answer "what can I pair a coin with, and can I do it today".
 *
 * ## The shape
 *
 *   - A **masthead** built from the product's own tray/rim/bezel construction, with the registry's
 *     figures in a seamed band rather than four floating tiles.
 *   - The **registry** itself — a field, a kind tray and three status keys over one filtered result
 *     set, split into what you can launch against today and what is on the way. See
 *     `AssetRegistry`.
 *
 * ## Why the blurb is two lines
 *
 * It was a fifty-word paragraph explaining what a quote asset is, that the choice is permanent,
 * that it sets the denomination, the chart and the fee stream, and that the launch form reads this
 * registry. Every clause was true and none of it was read: somebody arriving here is holding a coin
 * idea, not a question about market microstructure, and the page's own controls are twenty pixels
 * below the last line of it.
 *
 * So the masthead states the stake in one sentence and the rest moved to where it is actionable —
 * the two section notes in `AssetRegistry` say what "enabled on chain" means at the moment somebody
 * is looking at the assets it applies to.
 *
 * @param assets the registry as `/quotes` answers it — fetched by the route, not imported. It was a
 *   constant in `lib/assets/quote-assets`, with every address null and gold at the wrong decimals.
 * @param marketCount how many markets exist in total, across every quote.
 */

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "brand" }) => (
  <div className="doku-token-cell flex min-w-0 flex-col gap-2 px-4 py-3.5 sm:px-5">
    <span className="font-numeric text-[12px] uppercase leading-none tracking-[0.08em] text-ash">
      {label}
    </span>
    <span
      className={`min-w-0 truncate font-numeric text-[22px] font-semibold leading-none tracking-[-0.015em] tabular-nums ${
        tone === "brand" ? "text-doku-ink" : "text-ink"
      }`}
    >
      {value}
    </span>
  </div>
);

const AssetsPage = ({
  assets,
  marketCount,
}: {
  assets: readonly QuoteAsset[];
  marketCount: number;
}) => {
  /* The same narrowing the launch picker and the board's chips apply: this page is a menu of what
     somebody can pair against, so it must not advertise an asset they cannot choose. */
  const offered = pickableQuoteAssets(assets);
  const live = offered.filter((a) => a.status === "live");

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-7 sm:gap-8">
      {/* ================================================================================
          The masthead.

          The same four layers as the market page's — a tray the panel is pressed into, a rim
          floating proud of it, a bezel holding the content and an edge drawn over the top.
         ================================================================================ */}
      <section className="doku-token-tray relative rounded-[19px] p-[3px]">
        <span
          aria-hidden
          className="doku-token-rim pointer-events-none absolute -inset-[3px] rounded-[22px]"
        />

        <div className="doku-token-face relative overflow-hidden rounded-[16px]">
          {/* The hero's dot lattice, so this panel and the board's hero are the same material. */}
          <div className="doku-hero-ground pointer-events-none absolute inset-0" aria-hidden />

          <div className="relative flex flex-col gap-3 px-4 pb-5 pt-5 sm:px-6 sm:pb-6 sm:pt-6">
            <p className="font-numeric text-[11.5px] uppercase leading-none tracking-[0.1em] text-doku-ink">
              Quote assets
            </p>
            <h1 className="max-w-[18ch] font-pixel font-medium text-[30px] uppercase leading-[1.05] tracking-[0.02em] text-ink sm:text-[40px]">
              What you can pair against
            </h1>
            <p className="max-w-[52ch] font-ui text-[15px] leading-relaxed text-ash">
              Pick what your coin trades against, then launch it. Whatever you pick is locked in for
              good, so choose the one you want.
            </p>
          </div>

          {/*
            The figures, as a seamed band inside the panel.

            The four add up, and that is the point of the set: the registry holds ten, two of them
            are usable and eight are not.
          */}
          <div className="doku-token-vitals relative overflow-hidden">
            <div className="-ml-px -mt-px grid grid-cols-2 sm:grid-cols-4">
              <Stat label="In the registry" value={String(offered.length)} />
              <Stat label="Launchable now" value={String(live.length)} tone="brand" />
              <Stat label="On the way" value={String(offered.length - live.length)} />
              <Stat label="Coins launched" value={marketCount.toLocaleString()} />
            </div>
          </div>
        </div>

        <span
          aria-hidden
          className="doku-token-edge pointer-events-none absolute inset-[3px] rounded-[16px]"
        />
      </section>

      {/* The registry. Client-side, because it searches and filters — see `AssetRegistry`. */}
      <AssetRegistry assets={offered} />
    </div>
  );
};

export default AssetsPage;
