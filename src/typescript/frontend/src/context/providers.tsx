"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { enableMapSet } from "immer";
import React, { Suspense, useState } from "react";
import { ThemeProvider } from "styled-components";
import { GlobalStyle } from "styles";
import StyledToaster from "styles/StyledToaster";
import darkTheme from "theme/dark";
import { WagmiProvider } from "wagmi";

import Footer from "@/components/footer";
import { GeoblockedBanner } from "@/components/geoblocking";
import Header from "@/components/header";
import BottomNav from "@/components/layout/BottomNav";
import EntranceGuard from "@/components/layout/EntranceGuard";
import PageFrame from "@/components/layout/PageFrame";
import Loader from "@/components/loader";
import PreviewBanner from "@/components/preview-banner";
import { WalletModal } from "@/components/wallet/WalletModal";
import { wagmiConfig } from "@/lib/chain/wagmi";
import { ThemeProvider as DokuThemeProvider } from "@/lib/theme/theme-context";

import ContentWrapper from "./ContentWrapper";
import { UserSettingsProvider } from "./user-settings";
import UserAgentSeed from "./UserAgentSeed";
import { DokuWalletProvider } from "./wallet-context/DokuWalletProvider";
import { useWalletModal, WalletModalContextProvider } from "./wallet-context/WalletModalContext";

enableMapSet();

/**
 * Every query here is either polled on its own cadence or invalidated by the live feed, so the two
 * TanStack defaults that fire EXTRA requests are turned off: refetch-on-focus (every tab switch
 * re-asked every mounted query — a dozen ~500 ms round trips for nothing) and a zero `staleTime`
 * (data the server just rendered into the page was re-fetched the instant it mounted). Four
 * seconds matches the market page's poll; a hook that needs fresher or staler says so itself.
 */
const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 4_000, refetchOnWindowFocus: false } },
  });

/**
 * Bridges the modal context to the presentational dialog.
 *
 * Defined here, below both, so neither the context nor the dialog imports the other — the cycle
 * that arrangement created was resolved by module evaluation order, which is not a thing to rely
 * on.
 */
const WalletModalHost = () => {
  const { isWalletModalOpen, closeWalletModal } = useWalletModal();
  return <WalletModal isOpen={isWalletModalOpen} onClose={closeWalletModal} />;
};

/**
 * Everything under the app, rendered on the server as well as in the browser.
 *
 * ## There was a mount gate here, and it cost the whole product its first paint
 *
 * This component held `const [isMounted, setIsMounted] = useState(false)` and returned
 * `isMounted && (…)`, so the server emitted an empty `<body>` and the first render in the browser
 * emitted one too. Nothing — not the header, not the footer, not any page's `children` — appeared
 * until ~550 kB of JavaScript had been fetched across 38–45 requests, parsed, hydrated, and one
 * effect had run.
 *
 * Measured on a Lighthouse mobile profile against a *localhost* origin, that put first paint at
 * 4.2–4.8 s and LCP at up to 6.2 s on every route — the whole app in the "poor" band, with FCP and
 * LCP identical on four of five routes, which is the signature of a page that appears all at once
 * after a blank.
 *
 * It also silently voided the things this codebase already pays for: RSC streaming, the
 * `revalidate = 30` static generation on `/assets`, the `<Suspense>` boundary twenty lines below,
 * and all six `loading.tsx` files — every one of which renders *inside* what the gate was hiding,
 * so a visitor got a blank page where a skeleton had been written for them.
 *
 * ## What it was protecting, and why nothing needs protecting now
 *
 * One read: `isMobile || isTablet` from `react-device-detect`, whose exports are module-level
 * constants sniffed from `navigator` at import time and therefore meaningless on the server.
 *
 * That read happens in `UserAgentSeed`, in an effect, from `navigator.userAgent`. Both sides of
 * the render start from an unknown agent — the picker's `nativePicker` is `false` and the settings
 * store's `userAgent` is `""` — so there is nothing for hydration to disagree about, and the
 * correction lands in the first effect pass. It used to come off the request header in
 * `app/layout.tsx`, which was a hydration-safe answer that made every route in the app dynamic;
 * see `lib/utils/user-agent-bootstrap` for that history and for the one decision (the emoji face)
 * that has to be made before the first paint.
 *
 * The other two candidates were checked rather than assumed: `wagmiConfig` carries `ssr: true`
 * (`lib/chain/wagmi.ts`), and `DokuThemeProvider` deliberately renders `DEFAULT_THEME` and reads
 * the real one in an effect for this exact reason — see the note in `lib/theme/theme-context`.
 *
 * If a hydration mismatch ever appears here again, fix it at the leaf that reads browser state —
 * `useSyncExternalStore`, or `suppressHydrationWarning` on the one node. Never by moving the gate
 * back to the root: that trades one component's correctness for every route's first paint.
 */
const Providers = ({ children }: React.PropsWithChildren) => {
  /*
   * One client per render tree, created in state rather than at module scope.
   *
   * At module scope there is exactly one `QueryClient` per *process*, which on the server is shared
   * by every concurrent request. `use-market-live.ts` seeds that cache with `initialData` during
   * SSR, so one visitor's server-rendered rows could be handed to another visitor's render of the
   * same route. The data here is public, so today the symptom is staleness rather than leakage —
   * but it is the documented anti-pattern and it stops being harmless the first time anything
   * user-scoped is prefetched.
   *
   * `useState` with an initialiser function, not `useMemo`: React may discard a `useMemo` value,
   * and a cache that can be silently rebuilt mid-session is its own bug.
   */
  const [queryClient] = useState(makeQueryClient);

  return (
    <DokuThemeProvider>
      <ThemeProvider theme={darkTheme}>
        <QueryClientProvider client={queryClient}>
          <UserSettingsProvider>
            <WagmiProvider config={wagmiConfig}>
              {/* Wallet state outside the modal, not inside: the modal provider renders the dialog
                  itself, and the dialog reads wallet state. Nested the other way round it throws
                  on mount and takes the whole page with it — every route rendered blank. */}
              <DokuWalletProvider>
                <WalletModalContextProvider>
                  {/* `EmojiPickerProvider` stood here. Its store held nine fields and thirteen
                      actions, of which exactly two were ever called from the app — `setNativePicker`
                      (from `UserAgentSeed`) and `clear` (from the header's home link) — and NO field
                      was ever read. A provider whose entire state is write-only is a provider whose
                      removal cannot change what anything renders. */}
                  <>
                    <UserAgentSeed />
                    <GlobalStyle />
                    <EntranceGuard />
                    <Suspense fallback={<Loader />}>
                      <StyledToaster />
                      {/* Outside the content wrapper on purpose. Inside it, the sticky bar was
                          confined to the 1240px rail, so its background painted as a floating band
                          narrower than the viewport — and its own `max-w-[1240px] px-6` stacked on
                          top of the wrapper's padding, insetting the nav and wallet button away
                          from where the page content actually sits. Out here the bar spans the full
                          width and its inner rail lines up exactly with the wrapper's. */}
                      <Header />
                      <PreviewBanner />
                      <WalletModalHost />
                      <ContentWrapper>
                        {/* The gap between the sticky bar and the first panel — see
                            `.header-spacer` in `global.css`. It had a component, a folder and a
                            stylesheet for this one div. */}
                        <div className="header-spacer" />
                        <GeoblockedBanner />
                        {/* The frame is the page's ground; the footer sits below it on the same
                            rail rather than inside it, so the two read as a document and its
                            colophon rather than as one undifferentiated column. */}
                        <PageFrame>{children}</PageFrame>
                        <Footer />
                      </ContentWrapper>
                      {/* Outside ContentWrapper: it is fixed to the viewport, not to the rail. */}
                      <BottomNav />
                    </Suspense>
                  </>
                </WalletModalContextProvider>
              </DokuWalletProvider>
            </WagmiProvider>
          </UserSettingsProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </DokuThemeProvider>
  );
};

export default Providers;
