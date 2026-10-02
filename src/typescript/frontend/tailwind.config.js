// cspell:word noto
/** @type {import('tailwindcss').Config} */
import colors from "tailwindcss/colors";
import { fontFamily } from "tailwindcss/defaultTheme";
delete colors.lightBlue;
delete colors.warmGray;
delete colors.lightBlue;
delete colors.trueGray;
delete colors.coolGray;
delete colors.blueGray;

// These should only be used for test components or prototyping.
const shadCnTheme = {
  colors: {
    border: "hsl(var(--border))",
    input: "hsl(var(--input))",
    ring: "hsl(var(--ring))",
    background: "hsl(var(--background))",
    foreground: "hsl(var(--foreground))",
    primary: {
      DEFAULT: "hsl(var(--primary))",
      foreground: "hsl(var(--primary-foreground))",
    },
    secondary: {
      DEFAULT: "hsl(var(--secondary))",
      foreground: "hsl(var(--secondary-foreground))",
    },
    destructive: {
      DEFAULT: "hsl(var(--destructive))",
      foreground: "hsl(var(--destructive-foreground))",
    },
    muted: {
      DEFAULT: "hsl(var(--muted))",
      foreground: "hsl(var(--muted-foreground))",
    },
    accent: {
      DEFAULT: "hsl(var(--accent))",
      foreground: "hsl(var(--accent-foreground))",
    },
    popover: {
      DEFAULT: "hsl(var(--popover))",
      foreground: "hsl(var(--popover-foreground))",
    },
    card: {
      DEFAULT: "hsl(var(--card))",
      foreground: "hsl(var(--card-foreground))",
    },
  },
};

module.exports = {
  /*
   * `hover:` applies only where a pointer can actually hover.
   *
   * Tailwind 3 defaults this to `false`, which compiles every `hover:` utility as a bare `:hover`
   * rule. On a touch device `:hover` latches on tap and stays latched until the next tap
   * elsewhere — so a card tapped on a phone keeps `hover:-translate-y-1` and sits lifted
   * (`coin-card.tsx`), and the search field's clear key keeps its hover ink. None of those states
   * has a way out on a device with no pointer to move away.
   *
   * With this on, each becomes `@media (hover: hover) { ... }` — which is the gate this codebase
   * already applies by hand where somebody remembered (`.doku-tape:hover` in `global.css`). This
   * makes it the default rather than the exception.
   *
   * It affects every `hover:` in the app, not only the homepage's. That is the point: the failure
   * is a property of the variant, not of any one component.
   */
  future: {
    hoverOnlyWhenSupported: true,
  },
  /*
   * Class-based, and the class is always on: `<html>` carries `dark` unconditionally. Components
   * pulled from the Cult UI / shadcn registries express their dark treatment with `dark:`
   * variants, and the default `media` strategy would key those to the visitor's OS setting — so a
   * registry card would render its light half for anyone whose machine is set to light, on a page
   * that has no light mode at all.
   */
  darkMode: ["class"],
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      typography: {},
      fontFamily: {
        /*
         * Three faces, three jobs — see `styles/fonts.ts`. Plex carries display AND prose,
         * JetBrains carries every figure, and the pixel face is an ACCENT only.
         *
         * `sans` and `mono` are overridden rather than merely extended. Tailwind's defaults for
         * those two names are the OS stacks, so `font-mono` on a wallet address meant *Menlo* —
         * sitting in a table where every neighbouring figure was JetBrains. A name that resolves
         * to a font nobody chose is a trap, not a default.
         */
        sans: ["var(--font-ui)", ...fontFamily.sans],
        mono: ["var(--font-numeric)", ...fontFamily.mono],
        ui: ["var(--font-ui)", ...fontFamily.sans],
        numeric: ["var(--font-numeric)", ...fontFamily.mono],
        /* Display is a SANS now, so it falls back to one. It fell back to the mono stack while it
           was the pixel face, which meant a failed font load swapped a display headline to Menlo. */
        display: ["var(--font-display)", ...fontFamily.sans],
        pixel: ["var(--font-pixel)", ...fontFamily.mono],
        /* Legacy names, still referenced across the app. `forma-thin` is gone: it pointed at
           `--font-formaDR`, which `fonts.ts` has never defined, and it had no call sites. */
        pixelar: ["var(--font-pixelar)", ...fontFamily.mono],
        forma: ["var(--font-forma)", ...fontFamily.sans],
        "forma-bold": ["var(--font-formaM)", ...fontFamily.sans],
      },
      screens: {
        "mobile-sm": "0px",
        "mobile-md": "375px",
        "mobile-lg": "425px",
        sm: "640.1px",
        md: "768.1px", // tablet
        lg: "1024.1px", // laptop
        xl: "1440px", // laptop L
      },
      boxShadow: {
        /* Depth, as two tokens. On the dark stage both resolve to nothing — the style reference is
         * emphatic that depth there is a surface step and a hairline, and a drop shadow on
         * near-black is a grey smudge. On paper they are real, because white on white separates by
         * shadow and by nothing else. See `--elev-*` in `global.css`. */
        "doku-card": "var(--elev-1)",
        "doku-hover": "var(--elev-2)",
        "doku-lift": "var(--elev-2)",
        "doku-float": "var(--elev-2)",
        pretty: "var(--elev-2)",
        /* Was a 5px-spread blue glow, the last of the terminal theme's neon. It sat around the one
           floating surface in the app, so the picker read as if it were erroring. */
        accent: "var(--elev-2)",
      },
      dropShadow: {
        text: "0 1px 2px #000000dd",
        voltage: "1px 0 5px #fffce199",
        green: "0 0 2px #0AE448",
        red: "0 0 2px #FF4D5E",
        white: "0 0 2px #FFFCE1",
        gray: "0 0 2px #8F8F80",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        // DOKU radius scale.
        "doku-sm": "6px",
        "doku-lg": "8px",
        "doku-xl": "12px",
        "doku-2xl": "16px",
        "doku-3xl": "20px",
        "doku-pill": "9999px",
      },
    },
    colors: {
      ...colors,
      ...shadCnTheme.colors,
      /* -------------------------------------------------------------------------------------------
       * Palette — every colour is a token, and every token is a CSS variable.
       *
       * Nothing here is a literal any more, and that is the point: the app ships two themes (dark
       * and Lite Mode), and a hex compiled into a utility class cannot change when the theme does.
       * `global.css` owns the values; this file owns only the names.
       *
       * `rgb(var(--x-rgb) / <alpha-value>)` rather than `var(--x)` so Tailwind's opacity modifier
       * keeps working — `bg-doku/10` composes the alpha itself and cannot take apart a colour it
       * did not build. The composed `--doku` form still exists in `global.css` for hand-written CSS.
       *
       * The legacy role names are kept so components don't need rewriting: `black` is the page
       * ground, `white` is primary text, the grays are surfaces and muted text. The literal names
       * lie; the roles don't.
       * ----------------------------------------------------------------------------------------- */
      white: "rgb(var(--ink-rgb) / <alpha-value>)", // role: primary text -> ink
      "lighter-gray": "rgb(var(--ash-rgb) / <alpha-value>)", // role: secondary text -> ash
      "light-gray": "rgb(var(--mute-rgb) / <alpha-value>)", // role: muted text -> mute
      "medium-gray": "rgb(var(--mute-rgb) / <alpha-value>)", // role: label text -> mute
      "dark-gray": "rgb(var(--surface-rgb) / <alpha-value>)", // role: card surface -> surface
      black: "rgb(var(--canvas-rgb) / <alpha-value>)", // role: page ground -> canvas
      blue: "rgb(var(--halo-ink-rgb) / <alpha-value>)",
      green: "rgb(var(--doku-ink-rgb) / <alpha-value>)",
      pink: "rgb(var(--loss-ink-rgb) / <alpha-value>)",
      error: "rgb(var(--loss-ink-rgb) / <alpha-value>)",
      "ec-blue": "rgb(var(--doku-rgb) / <alpha-value>)", // role: brand accent
      warning: "rgb(var(--warn-ink-rgb) / <alpha-value>)",
      red: "rgb(var(--loss-ink-rgb) / <alpha-value>)",
      transparent: "transparent",
      /* Actual white. `white` above is remapped to the ink role, so `text-white` renders cream on
         the dark theme and near-black on Lite. This is the escape hatch for the rare case that
         needs a literal white in both. */
      "pure-white": "#FFFFFF",

      // Tokens under their own names.
      canvas: "rgb(var(--canvas-rgb) / <alpha-value>)", // the single stage every section sits on
      surface: "rgb(var(--surface-rgb) / <alpha-value>)", // cards and panels, one step lifted
      raise: "rgb(var(--raise-rgb) / <alpha-value>)", // chips, kbd, inset badges
      sink: "rgb(var(--sink-rgb) / <alpha-value>)", // recessed tracks and wells
      "doku-hover": "rgb(var(--doku-hover-rgb) / <alpha-value>)",
      /* The two translucent fills carry their own per-theme alpha, so unlike everything else here
         they are not composed from channels — `bg-glass/50` is not a thing anyone should write. */
      glass: "var(--glass)",
      "glass-strong": "var(--glass-strong)",
      well: "var(--well)",
      ink: "rgb(var(--ink-rgb) / <alpha-value>)",
      ash: "rgb(var(--ash-rgb) / <alpha-value>)",
      mute: "rgb(var(--mute-rgb) / <alpha-value>)",
      "mute-ink": "rgb(var(--mute-ink-rgb) / <alpha-value>)",
      faint: "rgb(var(--faint-rgb) / <alpha-value>)",
      doku: "rgb(var(--doku-rgb) / <alpha-value>)", // brand and positive
      "doku-ink": "rgb(var(--doku-ink-rgb) / <alpha-value>)",
      phos: "rgb(var(--phos-rgb) / <alpha-value>)",
      loss: "rgb(var(--loss-rgb) / <alpha-value>)",
      "loss-ink": "rgb(var(--loss-ink-rgb) / <alpha-value>)",
      warn: "rgb(var(--warn-rgb) / <alpha-value>)",
      "warn-ink": "rgb(var(--warn-ink-rgb) / <alpha-value>)",
      halo: "rgb(var(--halo-rgb) / <alpha-value>)",
      "halo-ink": "rgb(var(--halo-ink-rgb) / <alpha-value>)",
      lilac: "rgb(var(--lilac-rgb) / <alpha-value>)",
      blush: "rgb(var(--blush-rgb) / <alpha-value>)",
      line: "rgb(var(--line-rgb) / <alpha-value>)", // the hairline the whole layout is divided by
      "line-2": "rgb(var(--line-2-rgb) / <alpha-value>)",
    },
    keyframes: {
      fadeIn: {
        "0%": { opacity: "0" },
        "50%": { opacity: "1" },
        "100%": { opacity: "1" },
      },
      flicker: {
        "0%, 40%, 80%": { opacity: "1", transform: "scale(1) hue-rotate(0deg) brightness(1)" },
        "20%": { opacity: "0.8", transform: "scale(1.05) hue-rotate(40deg) brightness(1.1)" },
        "60%": { opacity: "0.9", transform: "scale(1.03) hue-rotate(-40deg) brightness(1.15)" },
        "100%": { opacity: "0.85", transform: "scale(1.02) hue-rotate(20deg) brightness(1.25)" },
      },
      carousel: {
        "0%": { transform: "translateX(0)" },
        "100%": { transform: "translateX(-66.6666%)" },
      },
      /* Cult UI's `gradient-button-group` spins its conic ring with `animate-gold-spin`, which is
         a Tailwind v4 `@utility` in that project's own stylesheet and is *not* shipped with the
         registry item. On Tailwind 3 it has to be declared here, or the ring renders and never
         turns. */
      "gold-spin": {
        from: { transform: "rotate(0deg)" },
        to: { transform: "rotate(360deg)" },
      },
      /*
       * The same spin, with the centring baked in.
       *
       * `gold-spin` above is upstream's, and it is only safe on an element positioned by `inset`.
       * `ConicRing` centres its square with `left-1/2 top-1/2` plus a translate — and a keyframe
       * that animates `transform: rotate(...)` *replaces* the element's whole transform, silently
       * dropping that translate. The result was a ring whose square sat with its top-left corner
       * at the centre of the button, so it lit the right and bottom edges and left the top and
       * left dark: exactly the symptom the geometry fix was supposed to cure, reintroduced by the
       * animation itself.
       *
       * Composing both here means the element needs no transform utilities at all, so there is
       * nothing left for the animation to clobber — and the paused state is centred too, which is
       * what the nav relies on.
       */
      "conic-spin": {
        from: { transform: "translate(-50%, -50%) rotate(0deg)" },
        to: { transform: "translate(-50%, -50%) rotate(360deg)" },
      },
      /* Same story as `gold-spin`: `cosmic-button` documents these in a header comment but the
         registry item ships no CSS, and Cult UI declares them as Tailwind v4 `@utility` tokens. */
      "cosmic-spin": {
        from: { transform: "rotate(0deg)" },
        to: { transform: "rotate(360deg)" },
      },
      "cosmic-spin-slow": {
        from: { transform: "rotate(0deg)" },
        to: { transform: "rotate(-360deg)" },
      },
    },
    animation: {
      fadeIn: "fadeIn 2s ease-in-out forwards",
      flicker: "flicker 1s infinite",
      carousel: "carousel 1s linear infinite",
      "gold-spin": "gold-spin 3s linear infinite",
      "conic-spin": "conic-spin 3s linear infinite",
      "cosmic-spin": "cosmic-spin 3s linear infinite",
      "cosmic-spin-slow": "cosmic-spin-slow 5s linear infinite",
    },
  },
  plugins: [
    require("@headlessui/tailwindcss"),
    function ({ addUtilities }) {
      const newUtilities = {
        ".pixel-display-1": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "128px",
          lineHeight: "160px",
        },
        ".pixel-display-2": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "68px",
          lineHeight: "100px",
        },
        ".display-1": {
          fontFamily: "var(--font-formaM)",
          fontSize: "95px",
          lineHeight: "96px",
        },
        ".display-2": {
          fontFamily: "var(--font-formaM)",
          fontSize: "64px",
          lineHeight: "64px",
        },
        ".display-3": {
          fontFamily: "var(--font-formaM)",
          fontSize: "48px",
          lineHeight: "65px",
        },
        ".display-4": {
          fontFamily: "var(--font-forma)",
          fontSize: "28px",
          lineHeight: "48px",
        },
        ".display-5": {
          fontFamily: "var(--font-forma)",
          fontSize: "20px",
          lineHeight: "48px",
        },
        ".display-6": {
          fontFamily: "var(--font-forma)",
          fontSize: "15px",
          lineHeight: "20px",
        },
        ".pixel-heading-1": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "64px",
          lineHeight: "48px",
        },
        ".pixel-heading-1b": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "52px",
          lineHeight: "48px",
        },
        ".pixel-heading-2": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "40px",
          lineHeight: "50px",
        },
        ".pixel-heading-3": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "32px",
          lineHeight: "40px",
        },
        ".pixel-heading-3b": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "24px",
          lineHeight: "28px",
        },
        ".pixel-heading-4": {
          fontFamily: "var(--font-pixelar)",
          fontSize: "20px",
          lineHeight: "25px",
        },
        ".heading-1": {
          fontFamily: "var(--font-formaM)",
          fontSize: "28px",
          lineHeight: "18px",
        },
        ".heading-2": {
          fontFamily: "var(--font-formaM)",
          fontSize: "20px",
          lineHeight: "18px",
        },
        ".body-lg": {
          fontFamily: "var(--font-forma)",
          fontSize: "16px",
          lineHeight: "18px",
        },
        ".body-md": {
          fontFamily: "var(--font-forma)",
          fontSize: "14px",
          lineHeight: "18px",
        },
        ".body-sm": {
          fontFamily: "var(--font-forma)",
          fontSize: "12px",
          lineHeight: "18px",
        },
        ".body-xs": {
          fontFamily: "var(--font-forma)",
          fontSize: "10px",
          lineHeight: "18px",
        },
        ".svg-icon": {
          alignSelf: "center",
          flexShrink: 0,
          transition: "all 0.3s ease",
        },
        ".ellipses": {
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        },
        ".icon-inline": {
          display: "inline-flex",
          verticalAlign: "unset",
          alignItems: "center",
          justifyContent: "center",
          height: "1.1ch",
          width: "1.1ch",
        },
        ".radii-xs": {
          borderRadius: "3px",
        },
        ".radii-sm": {
          borderRadius: "6px",
        },
        ".radii-md": {
          borderRadius: "8px",
        },
        ".radii-lg": {
          borderRadius: "16px",
        },
        ".radii-circle": {
          borderRadius: "50%",
        },
        ".no-overflow-anchoring": {
          overflowAnchor: "none",
        },
      };
      addUtilities(newUtilities, ["responsive"]);
    },
    require("tailwindcss-animate"),
  ],
};
