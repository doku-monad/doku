"use client";

import { BrandDisc } from "components/brand/BrandMark";
import { BaseModal } from "components/modal/BaseModal";
import { useDokuWallet } from "context/wallet-context/DokuWalletProvider";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "lib/utils/class-name";
import { faviconUrl } from "lib/utils/favicon";
import { useMemo, useState } from "react";
import { type Connector, useConnect } from "wagmi";

import { FEATURED, splitWallets } from "./wallet-catalogue";

/**
 * The connect dialog.
 *
 * ## The surface is the app's, not Cult UI's
 *
 * It was `TextureCardStyled`: four concentric hairlines at 24/23/22/21px, in a stack of literal
 * Tailwind palette colours — `border-white/60`, `dark:border-neutral-950`, `from-neutral-100
 * to-white/70` — with the theme selected by a `dark:` variant rather than by this product's
 * tokens. On the dark canvas that reads as machined metal and it is a good object. In Lite Mode it
 * is four rings of white-on-white and black-at-10%-on-near-white drawn around a panel that is
 * itself near-white: a smudged double frame with no clear edge, sitting on a surface it does not
 * match, next to rows built from `--line` and `--well` that *do* match. The one dialog whose job
 * is to look trustworthy was the one surface in the product that looked like it came from
 * somewhere else — in exactly the theme where the whole page is at its most literal.
 *
 * It became a flat panel on the product's own tokens next, which was correct and thin — one
 * hairline around a list of outlined rows, which is the shape every dapp's connect modal has.
 *
 * What it is now is the product's full material stack, at dialog size: a tray, a rim floating proud
 * of it, a bezel with a lit lip, the hero's own dot lattice for a ground, and every wallet pressed
 * into a well of its own with its mark mounted in a recess. Rows are recessed at rest and lift a
 * single pixel onto a brand-lit edge under the pointer. It closes on a base rail rather than on its
 * last row, so the dialog ends deliberately.
 *
 * That is not decoration on a form. Connecting a wallet is the moment the user is asked to trust
 * this app, and a dialog that looks built is part of how that trust is earned — it is the one
 * surface where "this was made by someone who cared" is a security signal. Looking built means
 * looking like the rest of the product, in both themes, which is why every value above is a token
 * and none of it is a `dark:` variant.
 *
 * ## What you have comes first, and `FEATURED` is not the list
 *
 * This dialog used to render `FEATURED` as the list: five named wallets pinned to the top in a
 * fixed order, and everything EIP-6963 discovery actually turned up collapsed behind a "More
 * wallets" disclosure. On Monad that inverts the truth. A user whose only wallet is Phantom — or
 * OKX, or Trust, or any of the dozen not on a list of five — opened this and saw five rows for
 * wallets they do not have, MetaMask first and marked Install, and their own wallet nowhere on
 * screen. The report back was that DOKU "only has MetaMask", and from where they were sitting that
 * is exactly what it looked like.
 *
 * So the primary list is now every connector discovery found, with the name and icon each wallet
 * publishes about itself. `FEATURED` keeps two narrower jobs and loses the third:
 *
 *   - **rank** — a discovered wallet that is one of the five sorts to the top. Extensions announce
 *     in whatever order they happen to load, so without a rank the first row is a different wallet
 *     on every reload; unranked wallets sort by name for the same reason. Ranking reorders the
 *     list, it never removes a row from it.
 *   - **mark and install link** — where a wallet's own download page is, and where its logo comes
 *     from when the extension is absent and publishes none.
 *
 * The featured wallets that are *not* installed still appear, as install rows, but now below the
 * real ones and behind the disclosure: "MetaMask isn't in this list" is indistinguishable from
 * "this site is broken", and somebody with no wallet at all needs somewhere to go. They are an
 * answer to "I don't have one", which is a different question from "connect the one I have" and
 * should not be asked first.
 *
 * If discovery found nothing at all — which is every mobile browser outside a wallet's own app —
 * the dialog says so and shows the install rows inline, because an empty list is indistinguishable
 * from a broken dialog.
 */
const Chevron = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 text-mute"
    aria-hidden
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);

const ExternalGlyph = () => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0"
    aria-hidden
  >
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

/**
 * The wallet's mark, mounted in a well.
 *
 * ## Three sources, and why the second one is new
 *
 * The icon the connector published, then the wallet's own favicon, then a brand-coloured monogram.
 * The middle step is the point: a wallet that is *not installed* publishes nothing, and every row
 * on a phone is in that state, so the list used to be five coloured letters — a list you cannot
 * scan, made of the one thing a person is scanning for. `faviconUrl` resolves the wallet's domain
 * to its own mark at render time, so an absent wallet looks exactly like a present one and the
 * repository still ships nobody else's artwork.
 *
 * ## Why it is mounted rather than placed
 *
 * A well pressed into the row with the mark inside it, tinted with the wallet's own hue. An image
 * dropped onto a surface is a sticker; the same image inside a machined recess is a component of
 * the object — it is the treatment the market card gives a coin's logo, and this dialog is where
 * the product most needs to look built.
 */
const WalletMark = ({
  icon,
  label,
  domain,
  brand,
  dimmed,
}: {
  icon?: string;
  label: string;
  /** The wallet's own domain, for the mark when the connector published none. */
  domain?: string;
  /** Hex, for the well's tint and for the monogram of last resort. */
  brand?: string;
  /** Absent wallets sit back a step, so present and absent are separable without reading a word. */
  dimmed?: boolean;
}) => {
  const [failed, setFailed] = useState(false);
  const src = icon ?? (failed ? null : faviconUrl(domain, 64));

  return (
    <span
      aria-hidden
      className={cn("doku-wallet-mark grid h-10 w-10 shrink-0 place-items-center rounded-doku-lg")}
      style={
        brand
          ? {
              /* Eight-digit hex: the same hue at two alphas — a wash behind the mark and a hairline
                 around it — so the well reads as the wallet's colour without the mark sitting on a
                 coloured tile that competes with it. */
              background: `linear-gradient(180deg, ${brand}22 0%, ${brand}0D 100%)`,
              boxShadow: `inset 0 0 0 1px ${brand}47, inset 0 1px 2px var(--shade-1)`,
            }
          : undefined
      }
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt=""
          onError={() => setFailed(true)}
          className={cn("h-[22px] w-[22px] rounded-[5px] object-contain", dimmed && "opacity-80")}
        />
      ) : (
        <span
          className="font-display text-[15px] font-semibold leading-none"
          style={{ color: brand ?? "rgb(var(--mute-rgb))" }}
        >
          {label.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
};

/**
 * The shield on the base rail.
 *
 * A check inside it rather than a lock: a lock is what browsers put next to a URL and it reads as
 * "encrypted", which is not what the line beside it says. A check reads as "this is fine", which
 * is.
 */
const ShieldGlyph = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="shrink-0 text-doku"
    aria-hidden
  >
    <path d="M12 2.8 20 6v6.1c0 4.4-3.2 7.9-8 9.1-4.8-1.2-8-4.7-8-9.1V6l8-3.2Z" />
    <path d="m8.6 12.1 2.4 2.4 4.4-4.6" />
  </svg>
);

/**
 * The one-word answer to "what happens if I press this".
 *
 * It was a flat 1px outline round a 10% tint — the one construction this panel does not otherwise
 * use, beside rows and keys all built out of trays and lit lips, which is why it read as bought
 * rather than built. `.doku-wallet-tag` is that grammar instead: a ground, a hairline, a lit top
 * edge and a hair of shade at the foot.
 *
 * ## What it no longer does
 *
 * It used to be one of *three* statements of the same fact on every row — a caption under the name,
 * this pill, and a loose arrow after it — under a notice that had already said it in a sentence.
 * The caption and the loose arrow are gone; the tag stayed because on a panel that can show both
 * groups at once, `Detected` versus `Install` is the fact somebody is scanning for, and a chevron
 * alone does not say which list a row belongs to.
 *
 * "Detected", not "Ready": `Ready` is a claim about the CONNECTION, which this does not know. What
 * it knows is that the browser announced a provider.
 */
const StateTag = ({ detected }: { detected: boolean }) => (
  <span
    data-state={detected ? "detected" : "install"}
    className="doku-wallet-tag shrink-0 rounded-[7px] px-2 py-[5px] font-numeric text-[11.5px] font-semibold uppercase leading-none tracking-[0.08em]"
  >
    {detected ? "Detected" : "Install"}
  </span>
);

/** A connectable wallet. */
function ConnectRow({
  connector,
  label,
  domain,
  brand,
  disabled,
  onSelect,
}: {
  connector: Connector;
  label: string;
  domain?: string;
  brand?: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  /*
   * A row cut from the product's own material.
   *
   * A well with a hairline rim, which lifts onto a lit ground with a brand edge under the pointer —
   * the same answer a market card gives, at row scale. It replaced a `TextureButton`, whose bevel
   * is written in `dark:`-prefixed palette colours and resolved in Lite Mode to a white-on-white
   * ridge that vanished, so the connect rows and the install rows beneath them read as two
   * different lists stacked on each other.
   */
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "doku-wallet-row group/row flex h-[60px] w-full items-center gap-3 rounded-doku-xl px-3",
        "font-ui text-[15px] text-ink",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <WalletMark icon={connector.icon} label={label} domain={domain} brand={brand} />
      <span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
      <StateTag detected />
      <Chevron />
    </button>
  );
}

/**
 * A featured wallet that isn't installed.
 *
 * The same 60px row so the list is one list, and flat rather than welled — that is the whole
 * distinction, and it is deliberate: this row cannot connect anything, and dressing it in the same
 * lit well as the rows above would promise an action it will not perform. It carries the wallet's
 * real mark and a stated reason, because this is the row every phone sees: a mobile browser injects
 * no provider, so on a phone *every* featured wallet lands here.
 */
function InstallRow({
  label,
  href,
  domain,
  brand,
}: {
  label: string;
  href: string;
  domain?: string;
  brand?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Install ${label}`}
      className="doku-wallet-row doku-wallet-row--install group/row flex h-[60px] w-full items-center gap-3 rounded-doku-xl px-3 font-ui text-[15px] text-ash focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
    >
      <WalletMark label={label} domain={domain} brand={brand} dimmed />
      <span className="min-w-0 flex-1 truncate text-left font-medium text-ink">{label}</span>

      <StateTag detected={false} />
      {/* The glyph says the press leaves the site; the tag says what the press is for. Two
          different facts, so two elements — which is why this one is not inside the tag. */}
      <span className="shrink-0 text-mute transition-transform duration-200 ease-out group-hover/row:-translate-y-[1px] group-hover/row:translate-x-[1px]">
        <ExternalGlyph />
      </span>
    </a>
  );
}

/**
 * Takes its open state as props rather than reading the modal context.
 *
 * The context provider used to render this component, and this component imported the context —
 * each module importing the other, a cycle the bundler resolves by whichever it happens to
 * evaluate first. Presentational and driven from above, it cannot participate in one at all.
 */

export const WalletModal = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) => {
  const { connectors, connect, isPending, error } = useConnect();
  const { status, wrongChain, switchToMonad } = useDokuWallet();
  const [showMore, setShowMore] = useState(false);
  const reduced = useReducedMotion();

  const { detected, missing } = useMemo(() => splitWallets(connectors), [connectors]);

  const busy = isPending || status === "ready";
  const nothingDetected = detected.length === 0;

  const select = (connector: Connector) => {
    connect({ connector });
    onClose();
  };

  return (
    /* `BaseModal`'s own border and shadow are dropped — the panel below carries both, and a second
       hairline rectangle around a 24px-radius card cuts its corners off. */
    <BaseModal isOpen={isOpen} onClose={onClose} className="!border-0 !shadow-none">
      {/* 1. The tray the dialog is pressed into. The same stack as a market card, at dialog size —
             see the note at the top of this file about why this surface is the product's own. */}
      <div className="doku-wallet-shell relative w-full max-w-[440px] rounded-[23px] p-[3px] text-left">
        {/* 2. The rim, floating proud of the tray. */}
        <span
          aria-hidden
          className="doku-wallet-rim pointer-events-none absolute -inset-[3px] rounded-[26px]"
        />

        {/* 3. The bezel. Everything below lives inside it. */}
        <div className="doku-wallet-face relative overflow-hidden rounded-[20px]">
          {/* The lattice, at the same density as the hero's ground — one product, one texture. */}
          <div className="doku-hero-ground pointer-events-none absolute inset-0" aria-hidden />

          {/*
            The head: one row, not a stack.

            It carried a line of prose under the heading — "DOKU runs on Monad. Your wallet needs to
            be on that network to trade." — which is a thing to read in front of a dialog somebody
            opened in order to press a button. The wallets are named below, the wrong-network case
            already replaces the whole footer with a *Switch to Monad* control, and a chain the app
            can switch for you is not a prerequisite to explain in advance.

            Taking the sentence out left a 34px disc floating above an orphan heading with two
            stacked gaps under it. So the head became a row: the disc and the title side by side,
            reading as one object, with the close key aligned to their shared centre rather than to
            a corner they no longer reach.
          */}
          <div className="relative flex items-center gap-3 px-6 py-5">
            <BrandDisc size={34} glow />
            <h2 className="min-w-0 flex-1 truncate font-display text-[21px] font-semibold tracking-[-0.02em] text-ink">
              Connect a wallet
            </h2>

            {/*
              A close control, not only Escape and the backdrop. A dialog whose only way out is a
              keyboard shortcut is a dialog people reload the page to escape.

              An in-flow flex child, and that is load-bearing rather than tidiness. It was
              `absolute right-4 top-1/2 -translate-y-1/2`, and the app's global press affordance is
              `button:active { transform: translateY(1px) }` — one property, so pressing the key did
              not nudge it, it threw its centring away and dropped it 17px on mousedown. The pointer
              came up over the heading that had been behind it, the browser fired `click` on the row
              the two had in common, and this handler never ran: a close button that lit on hover,
              depressed on click, and could not close the dialog. `items-center` on the row does the
              same centring with no transform at all, so the press has something to move.

              `-mr-2` holds the key at the 16px from the edge it has always sat at, against the
              row's 24px rail.
            */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="doku-wallet-key -mr-2 grid h-8 w-8 shrink-0 place-items-center rounded-doku-lg text-mute transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.6"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M5 5l14 14M19 5 5 19" />
              </svg>
            </button>
          </div>

          {/* The seam: a hairline with a lit one under it, so the dialog reads as folded rather
              than as two boxes stacked. Films rather than `--line`, which is a grey stroke that
              reads as a groove on the dark theme and as nothing at all on paper. */}
          <div
            aria-hidden
            className="h-px w-full bg-[var(--film-2)]"
            style={{ boxShadow: "0 1px 0 0 var(--film-1)" }}
          />

          <div className="relative px-6 pb-6 pt-5">
            {wrongChain ? (
              <button
                type="button"
                onClick={() => {
                  switchToMonad();
                  onClose();
                }}
                className="cta-gradient h-12 w-full rounded-doku-pill px-4 font-ui text-[14px] font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
              >
                Switch to Monad
              </button>
            ) : nothingDetected ? (
              <div className="flex flex-col gap-4">
                <p className="rounded-doku-xl border border-solid border-[var(--film-2)] bg-[var(--film-1)] px-4 py-4 font-ui text-[14px] leading-relaxed text-ash">
                  No wallet detected in this browser. Install one below, then reload — or on a
                  phone, open DOKU from inside your wallet app&rsquo;s own browser.
                </p>
                <ul className="flex list-none flex-col gap-2">
                  {FEATURED.map((f) => (
                    <li key={f.key}>
                      <InstallRow
                        label={f.label}
                        href={f.install}
                        domain={f.domain}
                        brand={f.brand}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <ul className="flex list-none flex-col gap-2">
                  {detected.map(({ connector, spec }) => (
                    /* Keyed on the connector's uid, not on a featured key: an unfeatured wallet has
                       no featured key, and the uid is the one handle every connector has. */
                    <li key={connector.uid}>
                      <ConnectRow
                        connector={connector}
                        /* The wallet's own name wins over ours. A featured spec's label is the
                           fallback for a connector that announced without one, and the id is the
                           last resort — an unlabelled row is worse than an ugly one. */
                        label={connector.name || spec?.label || connector.id}
                        domain={spec?.domain}
                        brand={spec?.brand}
                        disabled={busy}
                        onSelect={() => select(connector)}
                      />
                    </li>
                  ))}
                </ul>

                {missing.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowMore((v) => !v)}
                      aria-expanded={showMore}
                      aria-controls="more-wallets"
                      className="doku-wallet-more mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-doku-xl font-ui text-[14px] font-medium text-ash focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-doku"
                    >
                      {/* Named for what is behind it. It used to say "More wallets" over a list of
                          real, connectable ones; what is under it now is the opposite — wallets
                          this browser does not have, and a person who already connected has no
                          reason to open it. */}
                      {showMore ? "Hide" : "Install another wallet"}
                      <span className="font-numeric text-[12px] text-mute">({missing.length})</span>
                      <motion.svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                        animate={{ rotate: showMore ? 180 : 0 }}
                        transition={{ duration: reduced ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
                      >
                        <path d="m6 9 6 6 6-6" />
                      </motion.svg>
                    </button>

                    {/* Height-animated rather than toggled, so the card grows into the extra rows
                      instead of jumping — a dialog that changes size in one frame reads as a new
                      dialog. `overflow-hidden` is what makes the height tween possible at all. */}
                    <AnimatePresence initial={false}>
                      {showMore && (
                        <motion.div
                          id="more-wallets"
                          initial={reduced ? false : { height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={reduced ? undefined : { height: 0, opacity: 0 }}
                          transition={{ duration: reduced ? 0 : 0.26, ease: [0.22, 1, 0.36, 1] }}
                          className="overflow-hidden"
                        >
                          <ul className="flex list-none flex-col gap-2 pt-2">
                            {missing.map((spec) => (
                              <li key={spec.key}>
                                <InstallRow
                                  label={spec.label}
                                  href={spec.install}
                                  domain={spec.domain}
                                  brand={spec.brand}
                                />
                              </li>
                            ))}
                          </ul>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                )}
              </div>
            )}

            {/* Surfaced rather than swallowed: a rejected or failed connection with no message
                looks like the button doing nothing. */}
            {error && (
              <p className="mt-3 font-ui text-[14px] leading-relaxed text-loss-ink">
                {error.message}
              </p>
            )}
          </div>

          {/*
            The base rail.

            One line of reassurance, in the one place a person reads before pressing a button that
            hands a site their wallet: connecting is a read, not a signature. It is also what gives
            the dialog a *bottom* — a panel that ends on its last list row ends because it ran out
            of rows, and this one closes deliberately, the same way the page's own footer does.
          */}
          <div className="doku-wallet-base relative flex items-center gap-2.5 px-6 py-3.5">
            <ShieldGlyph />
            <span className="font-ui text-[12.5px] leading-snug text-mute">
              Connecting only shares your address. Every trade is signed by you.
            </span>
          </div>
        </div>
      </div>
    </BaseModal>
  );
};

export default WalletModal;
