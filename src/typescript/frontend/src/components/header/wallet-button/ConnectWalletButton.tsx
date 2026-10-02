import Popup from "components/popup";
import { ActionKey, KEY_RADIUS_CLASS } from "components/ui/action-key";
import { DockFace } from "components/ui/gradient-button-group";
import { translationFunction } from "context/language-context";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { useWalletModal } from "context/wallet-context/WalletModalContext";
import { cn } from "lib/utils/class-name";
import { type PropsWithChildren, useMemo } from "react";

import useIsUserGeoblocked from "@/hooks/use-is-user-geoblocked";
import { formatDisplayName } from "@/sdk/utils/misc";

interface ConnectWalletProps extends PropsWithChildren<{ className?: string }> {
  /** Full width, in the mobile sheet and anywhere else the slot is a row. */
  mobile?: boolean;
  onClick?: () => void;
  forceAllowConnect?: boolean;
  /** Display the button's children regardless of whether or not the user is connected. */
  forceDisplayChildren?: boolean;
  /**
   * Fill the width of the slot.
   *
   * The market page's trade action is a full-width control; when no wallet is attached this
   * component stands in for it, and at its natural width it left a small button floating in the
   * middle of a full-width row — the one place on the page where the layout looked unfinished.
   */
  block?: boolean;
  /**
   * The soft halo outside the control. **The navigation dock only.**
   *
   * It used to be unconditional, and this component stands in for the primary action on four other
   * surfaces — the market page's trade button, the launch page's rail, the verify pages, the emoji
   * picker. In the dock the halo is doing real work: it is one small control in a bar of nav items
   * and it has to be the thing your eye lands on. Anywhere else it is a full-width button that is
   * already the only button in its panel, and a red bloom around it reads as a warning about the
   * thing it is sitting in — on the launch page it glowed through the summary rail, which is the
   * panel telling you what you are about to sign.
   *
   * Off by default, so a new call site gets the quiet treatment unless somebody decides otherwise.
   * The conic ring stays in both cases: that is the control's edge, not a light it casts.
   */
  glow?: boolean;
  /**
   * Which of the two treatments to wear.
   *
   * `dock` is the bar's own: a well with a turning conic ring in it, the same material as the
   * navigation it sits among. It is the right object *in the bar* and the wrong one everywhere
   * else, because this component stands in for the primary action on four other surfaces — and on
   * the market page it was standing in for a 48px filled key, in a panel whose other controls are
   * filled keys, wearing a ringed recess borrowed from a navigation bar two hundred pixels above
   * it. Two identical controls in one viewport, one of which navigates and one of which unblocks
   * trading, is a reading anybody has to do twice.
   *
   * `solid` is a machined key at the primary action's own footprint: the bezel face, a brand
   * hairline, a lit lip and a wallet mark — the outlined half of the pair whose filled half is the
   * `Buy` or `Launch` key this slot holds once a wallet is attached. See `.doku-key--connect` for
   * why it is not painted.
   */
  variant?: "dock" | "solid";
  /** Which slot the solid key is standing in: the trade panel's (48px) or the launch rail's (56). */
  solidSize?: "md" | "lg";
}

const CONNECT_WALLET = "Connect";

/**
 * The connect button — one design, every breakpoint.
 *
 * ## What this replaces
 *
 * Two different buttons that happened to share a component: the dock face on desktop, a flat green
 * pill on mobile. So the single most important control in the product looked like two unrelated
 * things depending on the width of the window.
 *
 * Now there is one treatment on both: the dock face — a recessed well with an animated conic ring,
 * `tone="danger"` because this is the control that blocks everything else until it is pressed. It
 * was the desktop treatment all along; the mobile bar simply renders this same component now
 * instead of its own approximation, so the two cannot drift apart.
 *
 * The halo around it is the navigation bar's alone — see `glow`.
 *
 * ## The label scrambles
 *
 * The same treatment the grid's sort control uses, and with the same settings — `use-scramble` at
 * speed 0.5 with overdrive off, replayed on pointer-enter. It is the product's signature effect,
 * and having it on the sort pill but not on the control beside it made the bar look like two
 * components from two products.
 *
 * This reverses an earlier call. The argument for taking it out was legibility: this is the one
 * control whose whole job is to be readable at a glance, and a scramble rewrites it character by
 * character while someone is trying to read it. That argument is not wrong, and it is why the
 * settings are the sort pill's calm ones rather than a longer or wilder scramble, why it fires on
 * hover — after the eye has already read the resting label — and why the button carries an
 * `aria-label`, so the accessible name is the finished word throughout. Assistive tech never sees
 * a frame of it, and neither does anyone who has not pointed at the button.
 *
 * The surface feedback it used to rely on alone is still there underneath: the conic ring turns
 * and the halo lifts. The text is now the third layer of the same response, not a replacement.
 */
const ButtonWithConnectWalletFallback = ({
  mobile,
  children,
  className,
  onClick,
  forceAllowConnect,
  forceDisplayChildren,
  block,
  glow = false,
  variant = "dock",
  solidSize = "md",
}: ConnectWalletProps) => {
  const { address, status } = useDokuWallet();
  const connected = status !== "disconnected";
  const { openWalletModal } = useWalletModal();
  const { t } = translationFunction();
  const shouldBeGeoblocked = useIsUserGeoblocked();

  const geoblocked = useMemo(
    // `forceAllowConnect` lets the verify-status page connect even from a blocked jurisdiction.
    () => !forceAllowConnect && shouldBeGeoblocked,
    [forceAllowConnect, shouldBeGeoblocked]
  );

  const label = useMemo(() => {
    // Wrong-chain is named rather than folded into "Connected": a wallet on another chain reports
    // an address and signs happily, and the transaction lands somewhere this app cannot see.
    if (!geoblocked && status === "wrong-chain") return t("Wrong network");
    if (!geoblocked && connected) return address ? formatDisplayName(address) : t("Connected");
    return t(CONNECT_WALLET);
  }, [connected, status, address, t, geoblocked]);

  /*
   * No scramble on this label.
   *
   * It rewrote the button's word character by character on mount and again on every pointer-enter —
   * the product's signature effect, applied to the one control whose entire job is to be readable
   * at a glance. On a bar that also carries a truncated address in the same slot it read as the
   * text glitching rather than as an animation, and it fired on a control people are already
   * reaching for. The surface feedback it was layered on top of has not gone anywhere: the conic
   * ring is still there and the halo still lifts.
   */

  const inner =
    // If the user is not connected, there are no children, or the user is geoblocked, show the
    // connect button — unless `forceDisplayChildren` says otherwise.
    (!connected || !children || geoblocked) && !forceDisplayChildren ? (
      <button
        type="button"
        disabled={geoblocked}
        // The resting label, as the accessible name. The visible span is empty until the scramble
        // fills it, and an unlabelled button is a worse outcome than no animation would have been.
        aria-label={label}
        onClick={(e) => {
          e.preventDefault();
          (onClick ?? openWalletModal)();
        }}
        className={cn(
          "inline-flex items-center justify-center",
          (mobile || block) && "w-full",
          /*
            The solid key's own radius and its own ring, on the host.
            --------------------------------------------------------------------------------------
            This button wraps the key rather than being it (see `variant`), and a button that asks
            for no radius gets a pill from `global.css` — so the focus ring was a pill around a
            rounded rectangle, in brand green, two pixels off a brand-green face. Closing the wallet
            dialog with Escape returns focus here, which is exactly when it was seen.

            `outline-ink` for the same reason `ActionKey` uses it: a brand ring on a brand fill reads
            as a selection mark, not as focus.
          */
          variant === "solid" &&
            cn(
              KEY_RADIUS_CLASS[solidSize],
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            ),
          geoblocked &&
            "h-9 cursor-not-allowed rounded-[12px] border border-solid border-[var(--film-2)] bg-[var(--film-4)] px-3.5 text-mute opacity-60",
          // Blocked is a state of this control too, so it keeps the control's footprint.
          geoblocked && !mobile && !block && "w-[var(--doku-wallet-w)] max-w-full",
          className
        )}
      >
        {geoblocked ? (
          /* No dock face when there is nothing to click. The treatment marks an actionable control,
             and dressing a dead one in it is an invitation the button cannot honour. */
          <span className="whitespace-nowrap font-numeric text-[13px] font-semibold uppercase tracking-[0.06em]">
            {label}
          </span>
        ) : variant === "solid" ? (
          /*
            The primary-action treatment — see `variant`.
            ----------------------------------------------------------------------------------
            The same key Buy, Sell and *Switch to Monad* are, unpainted, with a wallet mark: the
            word alone gave a full-width key nothing to look at but eight characters floating in
            its middle. `as="span"` because the click belongs to the button
            this is inside — see `ActionKey`.
          */
          <ActionKey tone="connect" size={solidSize} as="span">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="shrink-0"
            >
              <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H18a2 2 0 0 1 2 2v1" />
              <path d="M3 8.5v7A2.5 2.5 0 0 0 5.5 18H19a2 2 0 0 0 2-2v-2" />
              <path d="M21 9.5h-3.6a2.5 2.5 0 0 0 0 5H21" />
            </svg>
            {label}
          </ActionKey>
        ) : (
          <DockFace
            /*
             * Brand, not danger.
             *
             * `danger` is the coral-to-orange ring — the palette's *loss* tone, the one a failed
             * sell wears. It was the loudest thing on any screen in the app and it sat around the
             * one control that unblocks everything, so the primary invitation in the product read
             * as an error. Red also appears nowhere else in this bar, which is what made it look
             * like a warning rather than a button.
             *
             * `brand` is the mint/lime ring the rest of the product's lit controls already use, so
             * Connect now belongs to the same family as the hero's primary CTA.
             */
            /* `steady`, not `brand`: an even rim rather than a spectrum sweep, so the eye lands
               on the word instead of on the ring's bright arc. See `DOCK_RINGS.steady`. */
            tone="steady"
            glow={glow}
            /*
             * One width, every state.
             *
             * This control says four different things — `Connect`, a truncated address, `Connected`
             * and `Wrong network` — and it used to size itself to whichever was current. So
             * connecting a wallet widened the button by about fifty pixels and everything to its
             * left in the dock slid across to make room; switching to the wrong network moved it
             * again. A bar that re-flows when the thing it is reporting changes is a bar that looks
             * broken at the exact moment it has something to say.
             *
             * `--doku-wallet-w` is that width, shared with `WalletDropdownMenu` so the connected
             * pill and the button it stands in for are the same object at the same size. It is set
             * once in `global.css`, sized for the longest of the four states.
             */
            className={mobile || block ? "w-full" : "w-[var(--doku-wallet-w)] max-w-full"}
            /*
             * Wider than the nav's items, and set in the pixel face.
             *
             * This is the one control in the bar that is asking for something, and at nav-label
             * padding it read as the narrowest thing in it. The face is the in-flow child, so
             * widening only the shell would leave a content-sized plate floating in the middle of
             * it — `flex-1` on the face too, or neither.
             */
            faceClassName={cn(
              "whitespace-nowrap !px-5 font-numeric text-[11px] uppercase tracking-[0.08em]",
              // In the bar the face fills a shell of fixed width; everywhere else it sizes to its
              // label as it always did.
              mobile || block ? "flex-1" : "w-full"
            )}
          >
            {/* Solid type, not a clipped gradient — see the note by `.doku-connect-label`. */}
            <span>{label}</span>
          </DockFace>
        )}
      </button>
    ) : (
      children
    );

  /*
   * The trigger is the span, not the button, and that is the whole point.
   *
   * `global.css` gives every disabled button `pointer-events: none`, and Chrome fires no pointer
   * events on a disabled form control in any case — so a Radix trigger cloned straight onto this
   * button received nothing, and the one sentence telling a visitor why the product is dead for
   * them was rendered into a tooltip that could not open. Hovering did nothing, tapping did
   * nothing, and `cursor-not-allowed` never applied either, for the same reason. The only other
   * signal is `GeoblockedBanner`, which renders only when the block is explicit.
   *
   * A wrapper takes the pointer instead: the button is transparent to hit-testing, so the pointer
   * lands on the span, which is not disabled and can trigger. `tabIndex` because a keyboard user is
   * owed the reason too, and a disabled button is not focusable.
   */
  return geoblocked ? (
    <Popup content="not available in your jurisdiction">
      <span
        tabIndex={0}
        className={cn(
          "inline-flex rounded-[12px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
          (mobile || block) && "w-full"
        )}
      >
        {inner}
      </span>
    </Popup>
  ) : (
    inner
  );
};

export default ButtonWithConnectWalletFallback;
