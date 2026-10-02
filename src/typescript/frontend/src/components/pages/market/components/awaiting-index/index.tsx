"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Emoji } from "utils/emoji";

/**
 * A market that exists on chain but the indexer has not caught up to yet.
 *
 * This is the moment right after someone launches. The address is derived from the emoji, so the
 * app can send the creator to their market before the transaction is even mined — but the page
 * itself needs the indexer, which is a few seconds behind. The page used to render "Emoji not
 * found" in that window, telling the person who just paid gas that their market does not exist.
 *
 * Shown when the chain confirms there is a contract at the address, when the chain could not be
 * asked, and when the visitor's own browser has a launch in flight for it. Never for an address
 * that is simply absent with nobody claiming otherwise — that stays a wrong URL. It refreshes on a
 * timer until the market appears, which is what makes waiting the safe answer in all three cases.
 */
export default function AwaitingIndexPage({
  symbol,
  pending = false,
}: {
  symbol?: string;
  /**
   * True while the launch transaction may still be in flight — no code at the address yet, or the
   * chain could not be asked. The wording changes because "it is on chain already" is a claim, and
   * making it before a block has confirmed would be the same kind of guess this page exists to
   * stop: confidently wrong, to the person best placed to notice.
   */
  pending?: boolean;
}) {
  const router = useRouter();
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    // `router.refresh()` re-runs the server component, which asks the indexer again. Polling the
    // API separately would mean two ways of deciding the market is ready, which can disagree.
    const tick = window.setInterval(() => {
      setSeconds((s) => s + 2);
      router.refresh();
    }, 2_000);
    return () => window.clearInterval(tick);
  }, [router]);

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center gap-4 px-6 py-24 text-center">
      {symbol ? (
        <Emoji emojis={symbol} className="text-[56px] leading-none" />
      ) : (
        <div className="h-[56px] w-[56px] rounded-full bg-sink" />
      )}

      <h1 className="font-forma text-[22px] font-semibold tracking-[-0.01em] text-ink">
        {pending ? "Your launch is confirming" : "Your market is live"}
      </h1>
      <p className="max-w-[46ch] text-[14px] leading-relaxed text-mute">
        {pending
          ? "The transaction is on its way into a block. This page will fill in by itself the moment it lands."
          : "It is on chain already. The indexer is a few seconds behind — this page will fill in by itself as soon as the launch is picked up."}
      </p>

      <div className="mt-2 h-[3px] w-40 overflow-hidden rounded-full bg-sink">
        <div className="h-full animate-pulse rounded-full bg-doku motion-reduce:animate-none" />
      </div>

      {/* After a while this stops being "any moment now" and starts being worth saying out loud. */}
      {seconds >= 30 && (
        <p className="text-[12px] text-mute">
          Still waiting. The indexer may be behind — the market itself is unaffected.
        </p>
      )}
    </div>
  );
}
