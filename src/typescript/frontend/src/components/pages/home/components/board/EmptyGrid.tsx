"use client";

import { PixelArrow } from "components/svg";
import Link from "next/link";
import { ROUTES } from "router/routes";

import { AssetIcon } from "@/components/ui/asset-icon";
import { displaySymbolText } from "@/lib/assets/display-symbol";
import { useQuoteAssets } from "@/lib/hooks/use-quote-assets";

/**
 * What the grid shows when it has nothing to show.
 *
 * There are **three** of those and they are not the same statement.
 *
 *   - A search that matched nothing is a dead end with an obvious next move: nobody has launched
 *     that, so launch it.
 *   - No markets at all is a claim about the whole protocol.
 *   - A request that FAILED is a claim about this page, and it used to be told as the second one.
 *
 * That last case is why this component changed. `explore/page.tsx` catches an indexer failure into
 * `EMPTY_PAGE`, so a 500 arrived here indistinguishable from an empty chain and the board announced
 * "No markets yet" — the protocol-is-empty claim — on an outage. The docblock here used to concede
 * the point ("this cannot tell the difference — nothing at this layer can"), which was true only
 * because nobody passed the distinction down. It exists at the catch site; it is a prop now.
 *
 * ## The search term is TEXT
 *
 * It was rendered through `<Emoji>`, which returns only the emoji glyphs it can find in a string —
 * a leftover from when the board was searched by emoji. Search is free text now (name, ticker,
 * contract address), so searching "banana" drew an invisible mark and a button reading "Launch "
 * with nothing after it.
 */
export default function EmptyGrid({
  searched,
  failed,
  onFirstPage,
  pair,
}: {
  searched: string;
  failed?: boolean;
  /**
   * Back to the start, when this page is past the end of the board.
   *
   * Absent on page one, which is the ordinary empty state and has nowhere to go back to. Present
   * when somebody deep-linked to `?page=9`, or was on page four of a board that a new search cut
   * to one — states where the grid is empty for a reason that has nothing to do with the market,
   * and where the pager cannot help: `ButtonsBlock` refuses to draw at a single page, correctly,
   * because "page 3 of 1" is not a thing it can say.
   */
  onFirstPage?: () => void;
  /** The pair the board is filtered to, if any. Its id — resolved to a name above. */
  pair?: string;
}) {
  const isSearch = searched.length > 0;
  /* Named, not just filtered. "No markets yet" under a USDC filter is a claim about the whole board
     and is false — there are eleven. The sentence has to say WHICH pair came up empty. */
  const { assets } = useQuoteAssets();
  const pairAsset = pair ? assets.find((a) => a.id === pair) : undefined;
  const pairName = pairAsset ? displaySymbolText(pairAsset) : pair?.toUpperCase();
  const isPair = Boolean(pair) && !isSearch;

  /*
   * A floor, so filtering does not collapse the page.
   *
   * The grid runs to ~1300px with a full board and this state was ~200px of centred text, so
   * picking a pair with nothing in it pulled the footer most of a screen up and picking another
   * threw it back down. A results list may change height — that is what filtering IS — but it must
   * not fall through the floor.
   */
  const SHELL =
    "flex min-h-[min(520px,60dvh)] flex-col items-center justify-center gap-3 px-6 py-16 text-center";

  /* The outage case first: it is the only one of the three that is not a statement about the
     market, and answering it with "launch the first one" would be advice about somebody else's
     server being down. */
  if (failed) {
    return (
      <div className={SHELL}>
        <div className="grid h-[52px] w-[52px] place-items-center rounded-full bg-sink text-warn-ink">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 3.6 21 19.2H3z" />
            <path d="M12 9.6v4M12 16.6h.01" />
          </svg>
        </div>

        <h2 className="font-forma text-[17px] font-medium text-ink">The board didn&apos;t load</h2>

        <p className="max-w-[42ch] text-[13px] leading-relaxed text-mute">
          The indexer did not answer, so there is no list to show. Nothing is wrong with the markets
          themselves — try again in a moment.
        </p>
      </div>
    );
  }

  return (
    <div className={SHELL}>
      {isSearch ? (
        /* The term as the reader typed it. `break-all` because a contract address is a legitimate
           search here and is longer than this panel. */
        <p className="max-w-[36ch] break-all font-numeric text-[15px] font-medium text-ash">
          &ldquo;{searched}&rdquo;
        </p>
      ) : (
        <div className="doku-well grid h-[56px] w-[56px] place-items-center rounded-doku-xl text-[24px]">
          {/* The pair's own mark when the board is filtered to one — the same object the chip
              that got you here wears, so the empty panel is visibly about THAT asset. */}
          {pairAsset ? (
            <AssetIcon asset={pairAsset} size={30} className="rounded-[9px]" />
          ) : (
            <span aria-hidden>✦</span>
          )}
        </div>
      )}

      {/* The eyebrow, the pixel title and the body are the shared status page's — see
          `status-page.tsx`. An empty grid is the same kind of moment as a 404: the page worked,
          the thing you asked for is not there, and it should be said in the product's own voice
          rather than in a 17px sentence that reads like a caption. */}
      <p className="eyebrow font-numeric text-[11px] uppercase tracking-[0.24em] text-mute">
        {onFirstPage ? "past the end" : isPair ? "no launches" : isSearch ? "no match" : "empty"}
      </p>

      <h2 className="max-w-[20ch] text-balance font-pixel text-[26px] font-medium leading-tight tracking-[0.02em] text-ink sm:text-[30px]">
        {onFirstPage
          ? "Nothing on this page"
          : isPair
            ? `Nothing paired with ${pairName} yet`
            : isSearch
              ? "Nobody has launched this one"
              : "No markets yet"}
      </h2>

      <p className="max-w-[42ch] font-ui text-[14px] leading-relaxed text-mute">
        {onFirstPage
          ? "The board does not run this far. It may have been shorter than when this link was made, or narrowed by a filter that has since changed."
          : isPair
            ? `No coin has been launched against ${pairName} so far. Being first is an advantage here.`
            : isSearch
              ? "Nothing in the launches matches that. It may not have launched yet."
              : "The first market launched here will show up on this grid."}
      </p>

      {/* No `?emojis=` any more. The picker that read it and the parameter itself are both gone —
          see the note in `ClientLaunchPage` — so it was a query string nothing on the other end
          had looked at for some time, and unencoded besides. */}
      {/* One action, and which one depends on why the grid is empty. Past the end of the board the
          answer is not "launch a coin" — it is "you are in the wrong place, here is the way back". */}
      {onFirstPage ? (
        <button
          type="button"
          onClick={onFirstPage}
          className="cta-gradient mt-2 inline-flex h-11 items-center gap-2 rounded-doku-pill px-5 font-ui text-[14px] uppercase tracking-[0.08em] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
        >
          Back to the first page
        </button>
      ) : (
        /*
          The hero's key, not a gradient pill.

          `cta-gradient` is a flat capsule, and this one sat two hundred pixels under a hero whose
          primary action is a ringed machined key. Two different objects for the same instruction —
          *launch a coin* — on the same page, one of them the product's signature control and the
          other a rounded rectangle.

          The branch above keeps the capsule and should: `Back to the first page` is a way out of a
          dead end, not the thing this product is for, and dressing it in the hero's key would make
          the two reads the same weight.

          This is `ExploreHero`'s lockup exactly: the 1.5px shell that frames the ring, a conic ring
          that only turns under the pointer, the `.doku-cta` face with its sheen, and the pixel
          arrow that steps forward on hover. Same heights, same type, same gesture.
        */
        <Link
          href={ROUTES.launch}
          className="doku-cta-shell group relative mt-2 inline-flex h-[43px] rounded-[14px] p-[1.5px]"
        >
          <span className="doku-cta relative z-10 inline-flex h-full w-full items-center justify-center gap-2.5 overflow-hidden rounded-[12.5px] px-6 font-numeric text-[12px] uppercase tracking-[0.09em]">
            <span aria-hidden className="doku-cta-sheen" />
            <span className="relative z-10">{isSearch ? "Launch it" : "Launch the first one"}</span>
            <PixelArrow
              aria-hidden
              className="relative z-10 shrink-0 transition-transform duration-200 ease-out group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            />
          </span>
        </Link>
      )}
    </div>
  );
}
