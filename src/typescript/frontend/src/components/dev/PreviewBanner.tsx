import { Notice } from "@/components/ui/notice";

/**
 * The "this is not real" banner.
 *
 * One component rather than a copy on each surface that can render the fixture, because the whole
 * point of it is that it says the same unmissable thing in the same place every time. A screenshot
 * of a preview page will end up in a pull request or a chat sooner or later, and it has to be
 * self-evidently fake *in the screenshot* — not only to whoever typed the URL.
 *
 * The amber is the warn hue at two alphas with a hairline, which is the app's own alert material;
 * it was a literal `rgba(255,135,9,…)` pair written into the one route that used it.
 */
export const PreviewBanner = ({ note }: { note?: string }) => (
  /* The shared `Notice`, rather than a fourth hand-built alert panel. It was already the right
     material — warn at 10% with a 30% rim — assembled locally, with a `⚠️` for its mark; `Notice`
     is that construction with a drawn mark and one set of measurements, so this banner and every
     other message in the product are visibly the same object. */
  <Notice tone="warn" title="Preview data" className="mb-5">
    {note ??
      "Every market here is fabricated, including the prices. Gated behind DOKU_CARD_PREVIEW — without it this never renders."}
  </Notice>
);

export default PreviewBanner;
