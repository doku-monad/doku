export const siteWidth = 1440; //px
export const breakpointMap = {
  mobileS: 320,
  mobileM: 375,
  mobileL: 425,
  tablet: 768,
  laptop: 1024,
  laptopL: 1440,
} as const;

export const breakpointsArray = ["320px", "375px", "425px", "768px", "1024px", "1440px"];

export const breakpoints = Object.assign(breakpointsArray, {
  mobileS: breakpointsArray[0],
  mobileM: breakpointsArray[1],
  mobileL: breakpointsArray[2],
  tablet: breakpointsArray[3],
  laptop: breakpointsArray[4],
  laptopL: breakpointsArray[5],
});

export const mediaQueries = {
  mobileS: `@media screen and (min-width: ${breakpointsArray[0]})`,
  mobileM: `@media screen and (min-width: ${breakpointsArray[1]})`,
  mobileL: `@media screen and (min-width: ${breakpointsArray[2]})`,
  tablet: `@media screen and (min-width: ${breakpointsArray[3]})`,
  laptop: `@media screen and (min-width: ${breakpointsArray[4]})`,
  laptopL: `@media screen and (min-width: ${breakpointsArray[5]})`,
  largeHeight: `@media screen and (min-height: ${siteWidth + 1}px)`,
} as const;

/* The style reference forbids drop shadows on the canvas; only surfaces that genuinely float above
 * the page keep one, and on a dark ground a shadow deepens rather than smudging grey. */
export const shadows = {
  tooltip: "0 20px 48px -24px var(--film-4)",
  dropdown: "0 12px 32px -18px var(--film-4)",
} as const;

export const gradients = {
  bannerSlider: "linear-gradient(90deg, #0E100F 31.11%, rgba(14, 16, 15, 0) 90.37%)",
} as const;

export const transitions = {
  default: "all 0.3s ease",
} as const;

export const radii = {
  xSmall: "3px",
  small: "6px",
  semiMedium: "8px",
  medium: "16px",
  circle: "50%",
} as const;

export const zIndices = {
  modal: 100,
  tooltip: 101,
  header: 11,
  dropdown: 10,
} as const;

export const fontWeight = {
  bold: 900,
  regular: 400,
} as const;

export const fonts = {
  pixelar: "var(--font-pixelar)",
  forma: "var(--font-forma)",
  formaM: "var(--font-formaM)",
  /* `--font-formaDR` was never defined in `styles/fonts.ts`, so this resolved to nothing and fell
     through to the generic stack. Pointed at the real body face. */
  formaDR: "var(--font-ui)",
} as const;

const theme = {
  siteWidth,
  breakpoints,
  mediaQueries,
  shadows,
  radii,
  zIndices,
  fonts,
  fontWeight,
  gradients,
  transitions,
};

export default theme;
