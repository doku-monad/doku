"use client";

import { DockFace } from "components/ui/gradient-button-group";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "lib/utils/class-name";
import { Check, ChevronDown, Copy, LogOut, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ROUTES } from "router/routes";
import { useScramble } from "use-scramble";

import { formatDisplayName } from "@/sdk/utils/misc";

/**
 * The connected wallet: an address pill that opens a menu beneath it.
 *
 * ## Why it is not the expanding pill any more
 *
 * The version this replaces grew the pill *horizontally* on hover — the three actions slid out of
 * the control itself, animating `width`, on the argument that a menu attached to its trigger can
 * never be mis-positioned. What that shipped was a control in the top bar that changed width
 * whenever a pointer passed over it, shoving the search field and the nav dock left by a couple of
 * hundred pixels and back again. A menu should cost the layout nothing. This one costs it nothing:
 * the panel is absolutely positioned, so the bar is identical open and closed.
 *
 * It also opens on **click** rather than on hover. Hover-opening was the other half of the same
 * problem — it fired on every pointer crossing the bar on its way somewhere else, which is why the
 * old implementation needed a grace timer to be usable at all. A menu that opens only when asked
 * needs no such machinery, and click is the gesture the mobile bar has always used here.
 *
 * ## Anchoring
 *
 * Right-aligned to the pill. This control sits hard against the right edge of the viewport, so a
 * left-anchored or centred panel is one that hangs off the screen at narrow desktop widths.
 *
 * ## One component, both widths
 *
 * The phone used to render `MobileWallet` instead — a flat `rounded-full` capsule opening its own
 * copy of these three rows. It existed for one reason, stated in its own header: the desktop menu
 * expanded on hover, and a touchscreen cannot hover. Clicking to open removed that reason, so the
 * mobile bar renders *this*, and the account control is the same object at 390px as at 1440px
 * rather than two that merely resemble each other.
 *
 * The panel is right-anchored and 248px wide, which fits a 390px bar with room either side, so
 * nothing about it needs a breakpoint.
 */

/**
 * One row of the menu.
 *
 * 40px up to `md` and 36px above it — the breakpoint the header itself switches on. Since this menu
 * serves both widths, picking one number would mean either a cramped row on a phone or a menu with
 * desktop rows sized for fingers that are not there. It was 44 on the phone, which with three rows
 * and the identity band above them made the panel taller than the content needs; 40 is still well
 * clear of what a thumb hits reliably.
 *
 * `active:` alongside `hover:` for the same reason: a touchscreen never produces a hover state, so
 * a row styled only for hover gives a thumb no feedback at all.
 *
 * `[&>svg]:text-mute` with a hover step, rather than a colour on each icon at its call site. Three
 * call sites is three places to keep in step, and it is why the copy row's glyph used to brighten
 * on hover while the portfolio row's did not. Set on the row, the mark and its label answer
 * together — which is most of what makes a row feel like one object instead of two. The two rows
 * whose icon carries meaning of its own (the copied tick, the disconnect mark) override it.
 */
const ACTION = cn(
  "flex h-10 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left font-ui text-[13.5px] md:h-9",
  "transition-colors duration-150 hover:bg-[var(--film-2)] active:bg-[var(--film-3)]",
  "[&>svg]:shrink-0 [&>svg]:text-mute hover:[&>svg]:text-ash",
  "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-doku"
);

const WalletDropdownMenu = () => {
  const { address, copyAddress, disconnect } = useDokuWallet();
  const router = useRouter();
  const reduced = useReducedMotion();

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const text = useMemo(() => (address ? formatDisplayName(address) : "Connected"), [address]);

  // No hover replay: rewriting the address character by character under a passing pointer is the
  // flash of noise the bar was full of. It still scrambles when the label itself changes.
  const { ref } = useScramble({
    text: text.startsWith("0x") ? `0x${text.slice(2).toUpperCase()}` : text.toUpperCase(),
    overdrive: false,
    overflow: false,
    speed: 0.6,
    playOnMount: false,
  });

  /* Dismiss on an outside press and on Escape. A menu that can only be closed by the control that
     opened it is a menu people close by reloading the page. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    },
    []
  );

  const onCopy = useCallback(() => {
    copyAddress();
    if (copyTimer.current) clearTimeout(copyTimer.current);
    setCopied(true);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  }, [copyAddress]);

  return (
    <div ref={rootRef} className="relative flex shrink-0 items-center">
      {/*
        The button wraps the face rather than sitting inside it — the structure
        `ButtonWithConnectWalletFallback` uses, and for the same reason.

        Nested inside, the hit target is the face's inner box: 30px against the control's visible
        44, since the face is inset by the ring band and its channel. That is a third of the target
        missing on the control a thumb reaches for most, and it is invisible in a screenshot —
        the pill looks 44px tall either way. Wrapping makes the whole pill pressable.
      */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Wallet menu"
        className="flex min-w-0 items-center rounded-[14px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
      >
        {/*
          The same width the disconnected button has — see `--doku-wallet-w` in `global.css`.

          These two are one control in two states, and they used to be two sizes: `Connect` sized to
          its seven letters, this to a thirteen-character address. Connecting therefore widened the
          slot by about fifty pixels and shoved the whole dock left, which is a layout change
          announcing a state change that the control itself already announces.
        */}
        <DockFace
          tone="brand"
          className="w-[var(--doku-wallet-w)] max-w-full"
          /* The face's padding and gaps step down with the control.
             At the dock's 160px the address is ~90px of mono and the dot, gaps and chevron take 32
             of the rest, so `px-2` leaves room to spare. At the phone bar's 144 there is none to
             spare, and `px-1.5` with tighter gaps is the difference between the address reading
             whole and ellipsising mid-hex. */
          faceClassName="w-full !gap-1 !px-1.5 sm:!gap-1.5 sm:!px-2"
        >
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-doku" />

          {/* `flex-1`, where this used to carry a width measured in `ch`.

              That measurement existed to stop the pill resizing frame by frame while the scramble
              ran. The shell is a fixed width now, so nothing inside it can resize the control at
              all — and the label simply takes whatever is left between the live dot and the
              chevron, truncating rather than pushing them apart if a future label runs long. */}
          <span
            className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-center font-numeric text-[11px] leading-none text-ink sm:text-[11.5px]"
            ref={ref}
          />

          <ChevronDown
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-mute transition-transform duration-200",
              open && "rotate-180"
            )}
          />
        </DockFace>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            aria-label="Wallet actions"
            className="doku-popover absolute right-0 top-[calc(100%+8px)] z-50 w-[248px] overflow-hidden rounded-[16px]"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.97 }}
            transition={reduced ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            {/*
              The identity band.

              The menu used to open straight onto `Copy address` — three verbs in a box, with no
              statement of *which* wallet they applied to. On a product where people keep several
              and switch between them, the first thing a wallet menu has to say is which one is
              connected; "Copy address" is meaningless until you know whose.

              It is a band with a seam under it rather than a fourth row, because it is not an
              action and must not look like one: tinted ground, the live dot the button carries, the
              address in the mono face it is read character-by-character in, and a label above it.
              The same head-and-body construction as the launch step cards and the market bands.
            */}
            <div className="flex flex-col gap-1.5 bg-[var(--film-1)] px-3 pb-2.5 pt-2.5 shadow-[inset_0_-1px_0_var(--film-2)]">
              <span className="flex items-center gap-1.5 font-numeric text-[11px] uppercase leading-none tracking-[0.1em] text-mute">
                <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-doku" />
                Connected
              </span>
              <span
                className="truncate font-numeric text-[13px] leading-none text-ink"
                title={address ?? undefined}
              >
                {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"}
              </span>
            </div>

            <div className="flex flex-col p-1.5">
              {/* Copy does not close the menu: the confirmation it swaps in is the whole feedback,
                and a panel that vanishes on the same frame takes that feedback with it. */}
              <button
                type="button"
                role="menuitem"
                onClick={onCopy}
                className={cn(ACTION, "text-ash")}
              >
                {copied ? (
                  <Check className="h-4 w-4 !text-doku-ink" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                {copied ? "Copied" : "Copy address"}
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  router.push(`${ROUTES.wallet}/${address}`);
                }}
                className={cn(ACTION, "text-ash")}
              >
                <UserRound className="h-4 w-4" aria-hidden />
                Portfolio
              </button>

              {/* The seam the rest of the product divides surfaces with — a hair of shadow over a
                hair of light — rather than a single flat hairline. `-mx-1.5` runs it to the
                panel's own edges, so it reads as a division of the menu instead of a rule floating
                between two rows. */}
              <span
                aria-hidden
                className="-mx-1.5 my-1.5 block h-px bg-[var(--film-2)] shadow-[0_1px_0_0_var(--film-1)]"
              />

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  disconnect();
                }}
                className={cn(ACTION, "text-loss-ink hover:bg-loss/15")}
              >
                <LogOut className="h-4 w-4 !text-loss-ink" aria-hidden />
                Disconnect
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Wallet address copied" : ""}
      </span>
    </div>
  );
};

export default WalletDropdownMenu;
