const ContentWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <div
      id="content-wrapper"
      // `min-h` rather than a fixed `h`: the sticky bar now sits above this element rather than
      // inside it, so a hard 100dvh here would push the page past the viewport by the bar's
      // height and produce a scrollbar on pages that otherwise fit.
      /*
       * The bottom padding is the tab bar's height plus the device's own safe-area inset.
       *
       * `BottomNav` is `position: fixed`, so it is out of flow and sits *over* whatever the page
       * ends with — which on every route is the footer, and on the market page is the trade feed.
       * Reserving the space here rather than inside each page means one number to change, and it
       * only applies below `md`, where the bar exists.
       *
       * Declared as a class in `global.css` rather than a `pb-[calc(...)]` utility: Tailwind emits
       * an arbitrary value containing `env(` as an escaped selector that Turbopack's CSS parser
       * rejects outright, which fails the stylesheet and 500s every route.
       */
      /*
       * `overflow-x: clip`, not `hidden`.
       *
       * This is the bug that made `position: sticky` do nothing anywhere inside the app. Per spec,
       * `overflow-x: hidden` with `overflow-y: visible` is not a legal pair — the browser computes
       * the `visible` axis to `auto`, so this element silently became a *scroll container*. A
       * sticky descendant then positions against this box rather than the viewport, and since this
       * box grows with its content and never scrolls, the sticky element has nothing to stick to
       * and simply scrolls away with the page. The launch page's preview rail was the symptom.
       *
       * `clip` does the same job — it stops horizontal overflow from painting or scrolling — and
       * explicitly does *not* create a scroll container, so `overflow-y` stays `visible` and
       * sticky positioning works against the viewport as intended.
       */
      /*
       * `no-scrollbar` rather than a scoped `<style jsx>` block.
       *
       * This carried the app's only styled-jsx — a fifth styling system, next to Tailwind,
       * `global.css`, styled-components and CSS modules — to hide a scrollbar on an element that,
       * being `overflow-x: clip`, is not a scroll container and cannot show one. `global.css`
       * already defines `.no-scrollbar` with both halves of that rule (`scrollbar-width` for
       * Firefox as well), so the behaviour is unchanged and one mechanism is retired.
       */
      className="doku-bottomnav-gap no-scrollbar mx-auto flex min-h-[calc(100dvh-var(--topbar-h))] w-full max-w-[1240px] flex-col [overflow-x:clip] px-4 sm:px-6"
    >
      {children}
    </div>
  );
};

export default ContentWrapper;
