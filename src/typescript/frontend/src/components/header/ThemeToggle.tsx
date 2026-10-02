"use client";

import { useTheme } from "@/lib/theme/theme-context";

/**
 * Lite Mode's switch.
 *
 * One control, two states, and it says which one it will *give* you rather than which one you are
 * in — a moon on the light theme, a sun on the dark one. The opposite convention (show the current
 * state) is the more common one and it is wrong for a two-state toggle: the page already tells you
 * what theme you are in, at full size, everywhere. What it cannot tell you is what the button does.
 *
 * `ready` guards the glyph, not the button. Before the stored preference has been read the app
 * reports its default, and rendering the sun on a visitor who chose Lite would flip it a frame
 * later — the same one-frame lie the bootstrap script exists to prevent, reintroduced in miniature.
 * So the mark holds at neutral until the answer is in; the button stays clickable throughout.
 */
const Sun = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.2M12 19.2v2.2M4.4 4.4l1.6 1.6M18 18l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.4 19.6l1.6-1.6M18 6l1.6-1.6" />
  </svg>
);

const Moon = () => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z" />
  </svg>
);

const ThemeToggle = ({
  className = "",
  /**
   * Render without the 44px plate.
   *
   * The mobile bar mounts this as one key of a two-key cluster, where the surface belongs to the
   * cluster's tray rather than to each control. A `className` alone could not express that: the
   * plate classes and the caller's would both be single-class Tailwind utilities, and which one won
   * would depend on their order in the generated stylesheet rather than on intent.
   */
  bare = false,
}: {
  className?: string;
  bare?: boolean;
}) => {
  const { theme, ready, toggleTheme } = useTheme();
  const goingTo = theme === "dark" ? "Lite Mode" : "dark mode";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${goingTo}`}
      title={`Switch to ${goingTo}`}
      /*
       * The same plate the search button wears.
       *
       * These two sit side by side at the same 44px, and they were built from different materials —
       * search took `--film-4` behind `[data-header-pill]` (which repaints it `--surface`), this
       * took `--film-1` with a `--line` rim and no attribute. On the paper canvas that resolved to
       * a white square next to a grey one, two controls of the same class visibly made of different
       * stuff. Matching the classes *and* carrying the attribute is what keeps them one object.
       */
      {...(bare ? {} : { "data-header-pill": "" })}
      className={
        bare
          ? `group shrink-0 text-mute transition-colors hover:text-ink ${className}`
          : `group grid h-11 w-11 shrink-0 place-items-center rounded-[14px] border border-[var(--film-2)] bg-[var(--film-4)] text-mute transition-colors hover:text-ink ${className}`
      }
    >
      <span className={ready ? "opacity-100 transition-opacity" : "opacity-0"}>
        {theme === "dark" ? <Moon /> : <Sun />}
      </span>
    </button>
  );
};

export default ThemeToggle;
