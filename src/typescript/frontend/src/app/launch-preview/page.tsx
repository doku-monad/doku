import PreviewBanner from "components/dev/PreviewBanner";
import ClientLaunchPage from "components/pages/launch/ClientLaunchPage";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import Link from "next/link";
import { notFound } from "next/navigation";

import { dummyLaunchDraft, previewEnabled } from "@/lib/dev/dummy-markets";

/*
 * An internal preview route, and it gets a title for the same reason the public ones do: these are
 * opened four at a time beside the pages they mirror, and four tabs reading
 * `Doku | A Launchpad on Monad` are four tabs nobody can tell apart.
 */
export const metadata = generateMetadataHelper({
  title: "Launch bench preview",
  description: "The launch form with every field already filled in.",
});

/**
 * The launch bench, pre-filled.
 *
 * ## Why `/launch` is not enough to design against
 *
 * The bench has two designs and the live route only ever opens on one of them. Everything on it —
 * the preview card, the rail's eleven figures, the missing-fields list, the state of the button —
 * is drawn from a draft that starts empty, so the *filled* half can only be looked at by typing a
 * name, a ticker and a description and pasting two image URLs, on every reload. The filled half is
 * also the half that has to be right: it is what a launcher sees for the whole time they are
 * deciding.
 *
 * So this route mounts the same `ClientLaunchPage` with a complete draft handed to it, and offers
 * the empty state as the other half of a switch rather than as the only thing on offer.
 *
 * Nothing here can be submitted: the bench's `LaunchAction` needs a connected wallet, and
 * `lib/launch/submit.ts` has no transaction to send — read the note there before wiring one up.
 *
 * ## The guard
 *
 * `notFound()` unless `DOKU_CARD_PREVIEW=true`, exactly as `/card-preview` and `/market-preview`.
 * See the post-mortem in `lib/dev/dummy-markets.ts` for why it is that variable and not `NODE_ENV`.
 *
 * @see /market-preview — one coin's page, on the same fixture.
 * @see /card-preview — the board's card grid.
 */
export const dynamic = "force-dynamic";

const STATES = [
  { key: "filled", label: "Filled", note: "Every field answered" },
  { key: "empty", label: "Empty", note: "As a launcher arrives" },
] as const;

export default function LaunchPreviewPage({ searchParams }: { searchParams: { state?: string } }) {
  if (!previewEnabled) notFound();

  /* Filled by default: the empty state is one click away on `/launch` itself, and this route exists
     for the half that is not. */
  const empty = searchParams.state === "empty";

  return (
    <>
      <PreviewBanner note="The draft below is fabricated, including the artwork. Nothing here can be launched — the wallet is not connected and no transaction exists. Gated behind DOKU_CARD_PREVIEW." />

      {/* The same segmented control the app uses, as links — so either state is a URL that can be
          bookmarked or pasted into a pull request. See the note on the switcher in
          `market-preview`. */}
      <nav aria-label="Draft state" className="mb-5 flex">
        <div className="doku-seg flex shrink-0 items-center gap-1 rounded-[13px] p-1">
          {STATES.map((state) => {
            const active = (state.key === "empty") === empty;
            return (
              <Link
                key={state.key}
                href={`/launch-preview?state=${state.key}`}
                scroll={false}
                aria-current={active ? "page" : undefined}
                data-active={active}
                className="doku-seg-key inline-flex shrink-0 flex-col items-start gap-1 whitespace-nowrap rounded-[10px] px-3 py-1.5"
              >
                <span className="font-ui text-[12.5px] font-semibold leading-none">
                  {state.label}
                </span>
                <span className="font-numeric text-[11px] leading-none text-mute">
                  {state.note}
                </span>
              </Link>
            );
          })}
        </div>
      </nav>

      {/* `key` on the state, so switching remounts the bench rather than handing a new preset to a
          component whose fields are already initialised — a preset is an *initial* value, and
          without this the chip would light up and nothing else would change. */}
      <ClientLaunchPage
        key={empty ? "empty" : "filled"}
        preset={empty ? undefined : dummyLaunchDraft()}
      />
    </>
  );
}
