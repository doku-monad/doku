"use client";

import { BrandDisc, BrandWordmark } from "components/brand/BrandMark";
import SearchModal from "components/search/SearchModal";
import { PixelSearch } from "components/svg";
import { GradientButtonGroup } from "components/ui/gradient-button-group";
import { Keycap, useModifierKey } from "components/ui/keycap";
import WalletDropdownMenu from "components/wallet/WalletDropdownMenu";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { useWalletModal } from "context/wallet-context/WalletModalContext";
import Link, { type LinkProps } from "next/link";
import React, { useEffect, useMemo, useState } from "react";
import { ROUTES } from "router/routes";

import { isRouteActive, useActivePathname } from "@/lib/hooks/use-active-pathname";

import { MORE_LINKS, NAVIGATE_LINKS } from "./constants";
import { CreateButton } from "./CreateButton";
import ThemeToggle from "./ThemeToggle";
import ButtonWithConnectWalletFallback from "./wallet-button/ConnectWalletButton";

/**
 * The top bar, rebuilt to match DOKU's (`~/doku-launchpad/components/chrome/top-bar.tsx`).
 *
 * Structure, spacing and treatment are DOKU's: a sticky translucent canvas bar with a hairline
 * base, a 1240px content rail, the brand lockup on the left, an absolutely-centred pill nav so it
 * stays centred regardless of how wide the flanking clusters get, and the search + wallet cluster
 * on the right. Below `md` the bar keeps only brand, search, wallet and the drawer — navigation
 * moved to `BottomNav`, into the thumb arc.
 *
 * The previous header was a full-bleed row of 24px bracketed links in brand blue with a pixel-font
 * wordmark — the last visible piece of the original terminal theme.
 */
/**
 * What each entry behind `More` actually is.
 *
 * A one-line note under the label, because "Stats" and "Docs" are the two least self-describing
 * words in this product's navigation — one is protocol-wide numbers, the other does not exist yet.
 * A menu has room for the sentence a nav item does not.
 */
const MORE_NOTES: Record<string, string> = {
  stats: "Protocol-wide numbers",
  docs: "How DOKU works",
};

/**
 * The mark on each `More` row.
 *
 * Drawn on the same 1.8-weight grid as every other icon in the chrome and taking `currentColor`, so
 * a row's mark follows its state — lit on the page you are standing on, dim on a destination that
 * does not exist yet. They live here with the notes because both are the menu's *copy*: the icon a
 * row carries is a choice about what that row says, not about how the menu is built.
 */
const MoreGlyph = ({ children }: { children: React.ReactNode }) => (
  <svg
    width="17"
    height="17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    {children}
  </svg>
);

const MORE_ICONS: Record<string, React.ReactNode> = {
  /* Three bars on a baseline — the shape of the thing the page actually is, rather than a generic
     chart glyph with an axis and a squiggle nobody can read at 17px. */
  stats: (
    <MoreGlyph>
      <path d="M5 20V13M12 20V5M19 20v-4.5" />
    </MoreGlyph>
  ),
  docs: (
    <MoreGlyph>
      <path d="M5.5 4.5h9l5 5v10h-14z" />
      <path d="M14.5 4.5v5h5M8.5 13.5h7M8.5 16.5h4" />
    </MoreGlyph>
  ),
};

const Header = () => {
  /**
   * Active-nav state comes from `useActivePathname`, not `usePathname()`.
   *
   * The reasoning — and the `history.pushState` patch that makes it work — moved into that hook
   * when the bottom tab bar started needing the same reading. Two components each wrapping
   * `pushState` in their own effect is a live bug: the second wraps the first, and whichever
   * unmounts first restores the original and silently freezes the other's indicator. See
   * `use-active-pathname.ts`.
   */
  const { address } = useDokuWallet();
  const { openWalletModal } = useWalletModal();
  const pathname = useActivePathname();

  /*
   * The brand lockup is a plain link to the board.
   *
   * It carried `onClick: () => clear()` — the emoji picker store's reset — from the build where
   * that store held the board's filter. The filter has been in the URL for some time and nothing
   * read the store's state at all, so the handler cleared something unobservable. The store is
   * gone; the link is a link.
   *
   * The previous header also carried the active `sort` param across, which needed
   * `useSearchParams` — see the note above on why that hook is gone.
   */
  const linkProps: LinkProps = useMemo(() => ({ href: ROUTES.explore }), []);

  const isActive = (path: string) => isRouteActive(pathname, path);

  // Global search opens DOKU's command palette. The shortcut lives here so it works on every page
  // without the modal being mounted.
  const [searchOpen, setSearchOpen] = useState(false);
  const modifier = useModifierKey();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * What counts as "already typing".
       *
       * It checked `HTMLInputElement` and `HTMLTextAreaElement` only, so pressing `/` inside a
       * `contentEditable` region or a custom `role="textbox"` opened the palette over what you were
       * writing — and `preventDefault` ate the slash on the way. A dialog being open counts too:
       * the wallet modal is a focus-trapped surface and a command palette should not appear on top
       * of it.
       */
      const active = document.activeElement as HTMLElement | null;
      const typing =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        Boolean(active?.isContentEditable) ||
        active?.getAttribute("role") === "textbox";
      const inDialog = Boolean(document.querySelector('[role="dialog"]'));

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "/" && !typing && !inDialog) {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /**
   * "Portfolio" points at `/wallet/<address>`, so unlike every other nav entry its destination
   * isn't known until a wallet is connected. It stays in the bar either way — hiding it would make
   * the nav change shape on connect — and when there's no address it opens the wallet modal
   * instead, which is the step you'd have to take anyway.
   */
  const portfolioHref = address ? `${ROUTES.wallet}/${address}` : undefined;
  const portfolioActive = isActive(ROUTES.wallet);

  return (
    <>
      {/*
        Two headers, not one responsive one.

        Above `md` there is no bar at all — just the dock, floating clear of the page ground with
        the canvas showing past it above and below. The full-bleed bar it replaces was doing nothing
        a 1240px rule could not: a border, a blur, and three clusters pinned to the edges of a
        screen that is mostly empty between them. Everything that was in it — brand, nav, search,
        wallet — now sits inside the one bezel, which is the point: a single object rather than a
        strip with things arranged on it.

        The dock spans the content rail rather than shrinking to its own contents. It used to be
        951px of controls centred over a 1192px board, so the product's three horizontal
        surfaces — bar, grid, footer — had three widths and three left edges. Now the brand sits
        over the first card of the grid and the wallet over the last, and the page reads as one
        column of aligned objects. See `fluid` in `GradientButtonGroup`.

        Below `md` the bar stays. A dock carrying six controls does not fit in 390px, and turning
        it into a horizontal scroller would hide half the nav behind a swipe.
      */}
      {/* `doku-topbar` is the device's top safe-area inset — see `global.css`. It has to be a class
          rather than a padding utility: Tailwind emits an arbitrary value containing env( as an
          escaped selector Turbopack's CSS parser rejects, which fails the stylesheet and 500s every
          route. */}
      {/* `overflow-x: clip` rather than `hidden`, so this never becomes a scroll container and
          `position: sticky` on it still resolves against the viewport — the same reasoning as the
          note in `ContentWrapper`.

          It used to be load-bearing for a different reason, and that reason was a bug. Below
          1248px the rail filled the viewport exactly and the dock's rim — `-inset-[4px]`, a 1px
          stroke — floated 4px outside it. Clipping stopped the 4px of horizontal document scroll,
          and it also ate the rim's ENTIRE left and right stroke: the dock came out with a top and
          a bottom border and no sides. The rail reserves those 8px now (see below), so the clip no
          longer has anything of ours to trim and stays only as a guard. */}
      <header className="doku-topbar sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur-xl [overflow-x:clip] md:border-0 md:bg-transparent md:backdrop-blur-none">
        {/* ---- Desktop: the dock, on the page's own rail ----

            The rail is `ContentWrapper`'s box *without* its padding — `mx-auto w-full
            max-w-[1240px]` — because that is precisely the box `PageFrame` occupies: the frame
            cancels the wrapper's padding with a matching negative margin and gives it back inside,
            so the panels behind the hero and the board are the full 1240 while their contents are
            1192. Padding here too would put the bar on the *content* rail, 24px inside the panel
            edges below it — which is exactly how the bar, the board and the footer ended up as
            three different widths. The footer takes the same box from the other direction, with
            negative margins. */}
        {/* `calc(100% - 8px)`, not `w-full`, and `max-w` is what keeps it honest.

            The rim floats 4px proud on each side, so the rail has to be 8px narrower than the box
            it sits in or the rim has nowhere to land. Below 1248 the subtraction gives the rim
            precisely the room it needs instead of having it clipped away. A breakpoint would not
            do: `@media` measures the viewport INCLUDING the scrollbar while layout excludes it, so
            any threshold is wrong by the scrollbar's width on the machines that have one.

            ---- 1232, not 1240, and the 8px are the whole alignment ----

            Capped at the full 1240 the BEZEL was on the rail and the rim therefore 4px outside it,
            at 96 and 1344 on a 1440 viewport. Every other object on the page puts its outer rim ON
            the rail: `PageFrame`'s `::after` floats 5px proud of a box inset 5px (`-mx-[19px]`
            against the wrapper's 24), and the footer's rim floats 3px proud of a shell inset 3
            (`-mx-[21px]`). Both land at exactly 100 and 1340. So the bar was the one surface in the
            column whose edges were 4px wider than everything beneath it — not enough for anybody to
            name, plenty for the stack to read as slightly out of true.

            1240 minus the rim's own 4px a side is the width at which the dock's OUTER edge lands
            where the hero's and the footer's do. */}
        <div className="mx-auto hidden w-[calc(100%-8px)] max-w-[1232px] pb-2 pt-3 md:block">
          <GradientButtonGroup
            fluid
            leading={
              <Link {...linkProps} className="flex items-center gap-2" aria-label="DOKU home">
                <BrandDisc size={28} />
                <BrandWordmark className="hidden text-[15px] lg:block" />
              </Link>
            }
            trailing={
              <>
                {/*
                  Global search, as a *field* rather than as a button that says "Search".

                  What was here was a flat plate with a hairline, the same film as the bar behind it
                  and a 12px label: a control that looked like the thing you press to get a control.
                  It is the one place in the chrome a person types, and on a launchpad it is how you
                  find a coin somebody just told you about — so it now looks like somewhere to type.

                  A recess, not a plate. The field is pressed *into* the bezel — inset shadow at the
                  top, catch-light along the foot, a hairline all round — which is the inverse of
                  every other control in the dock and is precisely what makes an input read as an
                  input at a glance. The shortcut is two keycaps raised out of the same recess —
                  `⌘` `K`, or `Ctrl` `K` off a Mac — with legends a reader can actually see, so the
                  two are one object: a slot with keys sitting in it. The glyph is on the pixel grid
                  the rest of the product's arrows are drawn on.

                  Under the pointer the rim warms to the brand hue and the glyph takes it. Nothing
                  moves and nothing resizes — see `.doku-searchfield`.
                */}
                <button
                  type="button"
                  onClick={() => setSearchOpen(true)}
                  aria-label="Search markets"
                  aria-haspopup="dialog"
                  className="doku-searchfield group flex h-11 w-11 items-center justify-center gap-2.5 rounded-[14px] text-left text-mute transition-colors xl:w-[206px] xl:justify-start xl:pl-3.5 xl:pr-[10px]"
                >
                  <PixelSearch aria-hidden className="doku-search-glyph shrink-0" />
                  {/* The field is a fixed width and the words take what the keys leave, so the
                      chord changing from ⌘ to Ctrl after load cannot nudge the dock. */}
                  <span className="hidden min-w-0 flex-1 truncate font-ui text-[13px] leading-none xl:block">
                    Search markets
                  </span>
                  {/* The shortcut as the keyboard draws it: two caps, raised out of the recess.
                      24px caps 10px in from the slot's 14px ends. */}
                  <span className="hidden items-center gap-[3px] xl:flex" aria-hidden>
                    <Keycap className="h-6 min-w-6 text-[12px]">{modifier}</Keycap>
                    <Keycap className="h-6 min-w-6 text-[12px]">K</Keycap>
                  </span>
                </button>
                <ThemeToggle />
                {/* Before the wallet, deliberately — see `CreateButton`. */}
                <CreateButton />
                {/* `glow` is the dock's alone — see `ConnectWalletButton`. It is one small
                    control in a bar of nav items and the halo is what makes it the thing your eye
                    lands on; every other surface renders this component full-width and quiet. */}
                <ButtonWithConnectWalletFallback glow>
                  <WalletDropdownMenu />
                </ButtonWithConnectWalletFallback>
              </>
            }
            items={[
              ...NAVIGATE_LINKS.map((link) => ({
                label: link.title,
                href: link.path,
                soon: "soon" in link && Boolean(link.soon),
                external: link.path.startsWith("https://"),
                active: isActive(link.path),
              })),
              {
                label: "Portfolio",
                href: portfolioHref ?? "#portfolio",
                active: portfolioActive,
                onClick: portfolioHref ? undefined : openWalletModal,
              },
              /* The reference shelf. It carries the active state of whatever is inside it, so
                 standing on `/stats` still lights something in the bar. */
              {
                label: "More",
                href: "#more",
                active: MORE_LINKS.some((link) => !link.soon && isActive(link.path)),
                menu: MORE_LINKS.map((link) => ({
                  label: link.title,
                  href: link.path,
                  note: MORE_NOTES[link.title],
                  icon: MORE_ICONS[link.title],
                  soon: "soon" in link && Boolean(link.soon),
                  external: link.path.startsWith("https://"),
                  active: isActive(link.path),
                })),
              },
            ]}
          />
        </div>

        {/*
          ---- Mobile: the bar ----

          Brand, search, wallet. Three objects, and nothing else.

          The hamburger is gone, and so is the sheet behind it. Navigation lives in the floating
          dock at the bottom of the screen — in the thumb arc, always visible, four destinations
          at once — so a second navigation control at the top edge was a duplicate list to keep
          in step, and by the end it was opening a drawer whose only real entry was Stats.

          Everything that drawer carried has a better home: the account actions hang off the wallet
          control itself, and Stats, Docs and the terms are in the footer, which is where a phone
          user expects secondary links to be.

          ---- The right-hand cluster is the desktop's, not an approximation of it ----

          Search and wallet are the same two controls the dock carries above `md`, in the same two
          materials and at the same radius: a flat hairline field for search, the machined dock face
          for the wallet. They used to be neither. Search was a `rounded-full` circle and the
          connected wallet was a flat capsule, so a phone showed two objects the desktop does not
          have while the disconnected button beside them was, confusingly, the real one.

          The wallet is now literally the desktop component — `ButtonWithConnectWalletFallback`
          wrapping `WalletDropdownMenu`, exactly as the dock renders it. That became possible when
          the wallet menu stopped expanding on hover and became a dropdown that opens on click: the
          bespoke mobile chip existed because a touchscreen cannot hover, and there is no longer
          anything to hover. One component, both widths, so they cannot drift.

          Every control is 44px — the smallest target a thumb hits reliably.
        */}
        {/* `px-4`, the same gutter `ContentWrapper` uses, because this row has no surface of its
            own and its contents ARE its edges.

            It was `px-3` — eight pixels bought for the narrowest phones still in use, back when the
            wallet control was wider. What it cost was the one alignment a phone actually shows:
            the brand mark sat at x=12 and the wallet's right edge at x=W-12, while the hero panel
            below them held its content at 16 and the cards in the grid started at 16. Three
            vertical edges within four pixels of each other is the specific kind of wrongness that
            reads as sloppy without being nameable.

            The lockup keeps its `-ml-2` against its own `px-2`, which is what puts the DISC — not
            the link's padding box — on the 16px line. Measured at 360px: the row still has room to
            spare, because `--doku-wallet-w` came down to 144 when the mobile wallet stopped being
            a bespoke chip. */}
        <div className="relative mx-auto flex h-[var(--topbar-h)] w-full max-w-[1240px] items-center gap-2 px-4 sm:px-6 md:hidden">
          <Link
            {...linkProps}
            className="-ml-2 flex h-11 min-w-0 shrink-0 items-center gap-2.5 rounded-[14px] px-2"
          >
            <BrandDisc size={30} />
            <BrandWordmark className="text-[17px]" />
          </Link>

          <div className="ml-auto flex min-w-0 shrink items-center justify-end gap-2">
            {/*
              Search and the theme switch, as one machined two-key cluster.

              They were two separate 44px plates floating side by side on the bar's flat ground —
              the treatment a bootstrapped header gets, and the reason this bar read as basic: three
              unrelated rounded rectangles in a row with nothing holding them.

              This is the construction the desktop dock and the bottom bar already use, at bar
              scale: a **recessed channel** with two **raised keys** sitting in it, split by a seam.
              Two keys in one tray is one object rather than two, it gives the bar the only depth it
              had anywhere, and it is 13px narrower than the pair it replaces — which on a 390px bar
              is the difference between the wordmark fitting and not.
            */}
            <div className="doku-bar-cluster flex h-11 shrink-0 items-stretch rounded-[15px] p-[3px]">
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                aria-label="Search markets"
                aria-haspopup="dialog"
                className="doku-bar-key group grid w-[36px] place-items-center rounded-[11px] text-mute transition-transform duration-150 ease-out active:scale-[0.92]"
              >
                <PixelSearch aria-hidden />
              </button>

              <span aria-hidden className="doku-bar-seam my-1.5 w-px shrink-0" />

              <ThemeToggle
                bare
                className="doku-bar-key grid w-[36px] place-items-center rounded-[11px] transition-transform duration-150 ease-out active:scale-[0.92]"
              />
            </div>

            <ButtonWithConnectWalletFallback glow>
              <WalletDropdownMenu />
            </ButtonWithConnectWalletFallback>
          </div>
        </div>
      </header>

      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
    </>
  );
};

export default Header;
