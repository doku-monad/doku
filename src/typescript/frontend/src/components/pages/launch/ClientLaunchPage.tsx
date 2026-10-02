"use client";

import LaunchBench, { type LaunchPreset } from "./LaunchBench";

/**
 * The launch page.
 *
 * A wide bench rather than the 440px column it once was. A single narrow card made the one
 * genuinely irreversible action in the product look like a newsletter signup.
 *
 * The emoji picker that used to open this page is gone along with the `?emojis=` parameter that
 * prefilled it — a coin is a name, a ticker and a pair now, and none of those arrive in a URL.
 *
 * ## The preset
 *
 * `preset` fills the bench in on first render and is otherwise inert — it exists so
 * `/launch-preview` can render the *filled* design without anybody typing a name and uploading two
 * images first. The live route passes nothing. See `LaunchPreset`.
 *
 * ## No rail of its own
 *
 * This was `px-4 py-8 sm:px-6` around a centred `max-w-[980px]` — inside `ContentWrapper`, which is
 * already `max-w-[1240px] px-4 sm:px-6`, and inside `PageFrame`, which gives that padding back.
 * Measured at 1512px: the page frame's content edge sat at 160 and this page's heading started at
 * 266. A hundred pixels adrift of the rail every other route lands on is most of what
 * "disconnected from the rest of the application" was — the content was not styled differently so
 * much as it was standing somewhere else.
 */
const ClientLaunchPage = ({ preset }: { preset?: LaunchPreset } = {}) => (
  <div className="flex grow flex-col gap-6 pb-4">
    <header className="flex flex-col gap-3">
      <span className="font-numeric text-[12px] font-semibold uppercase leading-none tracking-[0.1em] text-doku-ink">
        {"{ new coin }"}
      </span>
      <h1 className="font-pixel font-medium text-[clamp(1.75rem,3.4vw,2.5rem)] uppercase leading-[1.05] tracking-[0.02em] text-ink">
        Launch a coin
      </h1>
      {/* One line, and only because it is the one fact the form itself cannot show: what happens
          when you press the button, and that none of it can be taken back. The paragraph this
          replaced also explained what the steps below were for, to an audience reading a form whose
          steps are numbered and titled. */}
      <p className="max-w-[68ch] font-ui text-[15px] leading-relaxed text-ash">
        One transaction mints the whole supply into a pool whose liquidity is locked forever.
        Everything below is permanent.
      </p>
    </header>

    <LaunchBench preset={preset} />
  </div>
);

export default ClientLaunchPage;
