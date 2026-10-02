import PreviewBanner from "components/dev/PreviewBanner";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import Link from "next/link";
import { notFound } from "next/navigation";

import { previewEnabled } from "@/lib/dev/dummy-markets";

/*
 * An internal preview route, and it gets a title for the same reason the public ones do: these are
 * opened four at a time beside the pages they mirror, and four tabs reading
 * `Doku | A Launchpad on Monad` are four tabs nobody can tell apart.
 */
export const metadata = generateMetadataHelper({
  title: "Market states preview",
  description: "Every state the market page has to survive, on one switcher.",
});

/**
 * The index of the fabricated-data routes.
 *
 * There were three of these and no way to find out, which is most of why only one of them was ever
 * used: a sandbox nobody can name is a sandbox nobody opens. One page listing them, behind the same
 * variable they are behind, with a sentence each on what the surface is *for* rather than what it
 * is called.
 *
 * Everything below is a design surface. None of it talks to the indexer, none of it needs a wallet,
 * and all of it renders the product's real components — the point is to judge the real thing with
 * the backend down, not to look at a mock of it.
 *
 * `notFound()` unless `DOKU_CARD_PREVIEW=true`; see `lib/dev/dummy-markets.ts`.
 */
export const dynamic = "force-dynamic";

const SURFACES = [
  {
    href: "/card-preview",
    name: "The board",
    what: "Twelve fabricated markets in the real grid.",
    why: "The card is the densest object in the product and the hardest to judge one at a time. This is the only way to see forty of them answer a pointer at once.",
  },
  {
    href: "/market-preview",
    name: "A coin's page",
    what: "The masthead, chart, swap widget, trade feed and holder table, on one fabricated market.",
    why: "A switcher across the top moves between the states the page has to survive — still on its curve, ready to graduate, already in a pool, with artwork and without.",
  },
  {
    href: "/launch-preview",
    name: "The launch bench",
    what: "The five steps and the rail, with a complete draft already in them.",
    why: "The filled bench is what a launcher looks at for the whole time they are deciding, and it is the half you cannot see without typing a name and pasting two image URLs first.",
  },
] as const;

export default function PreviewIndexPage() {
  if (!previewEnabled) notFound();

  return (
    <div className="flex flex-col gap-6 pb-4">
      <PreviewBanner note="Every number on the pages below is invented. They are gated behind DOKU_CARD_PREVIEW — without it each one is a 404." />

      <header className="flex flex-col gap-3">
        <span className="font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.1em] text-doku-ink">
          {"{ preview }"}
        </span>
        <h1 className="font-pixel font-medium text-[clamp(1.75rem,3.4vw,2.5rem)] uppercase leading-[1.05] tracking-[0.02em] text-ink">
          Design surfaces
        </h1>
        <p className="max-w-[68ch] font-ui text-[15px] leading-relaxed text-ash">
          The product&apos;s own pages, on fabricated data, with no indexer and no wallet. Each one
          renders the real components — so what you change here is what ships.
        </p>
      </header>

      {/* A list, not a grid: three items with two lines of prose each read as a list at any width,
          and a three-column grid of text cards would be the layout deciding it wanted to be one. */}
      <ul className="flex list-none flex-col gap-3">
        {SURFACES.map((surface) => (
          <li key={surface.href}>
            <Link
              href={surface.href}
              className="group/row flex flex-col gap-2 rounded-doku-2xl border border-solid border-line bg-[var(--film-1)] px-4 py-4 transition-colors duration-200 hover:border-line-2 hover:bg-[var(--film-2)] sm:px-5"
            >
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-ui font-semibold text-[17px] uppercase leading-none tracking-[0.04em] text-ink">
                  {surface.name}
                </span>
                <span className="font-numeric text-[12px] leading-none text-mute">
                  {surface.href}
                </span>
              </span>
              <span className="font-ui text-[14px] leading-relaxed text-ash">{surface.what}</span>
              <span className="font-ui text-[13.5px] leading-relaxed text-mute">{surface.why}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
