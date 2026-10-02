import { PREVIEW_MODE } from "@/lib/chain/wagmi";

/**
 * Says so, when the markets are generated.
 *
 * A preview deployment is indistinguishable from a real one by design — that is what makes it
 * useful for showing the product, and what makes it dangerous without a label. The data behaves
 * correctly in every respect except being true, so nothing in the interface itself can give it
 * away.
 *
 * Renders nothing when the flag is unset, so a real deployment carries no trace of it.
 */
export const PreviewBanner = () => {
  if (!PREVIEW_MODE) return null;

  return (
    <div
      role="status"
      className="w-full border-b border-line bg-[rgb(255_135_9_/_0.16)] px-4 py-2 text-center"
    >
      <span className="font-numeric text-[11px] uppercase tracking-[0.09em] text-ink">
        Preview — these markets are generated, not on chain. Trading is disabled.
      </span>
    </div>
  );
};

export default PreviewBanner;
