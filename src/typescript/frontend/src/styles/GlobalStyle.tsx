import { createGlobalStyle } from "styled-components";

const GlobalStyle = createGlobalStyle`
html, body, div, span, applet, object, iframe,
  h1, h2, h3, h4, h5, h6, p, blockquote, pre,
  a, abbr, acronym, address, big, cite, code,
  del, dfn, em, img, ins, kbd, q, s, samp,
  small, strike, strong, sub, sup, tt, var,
  b, u, i, center,
  dl, dt, dd, ol, ul, li,
  fieldset, form, label, legend,
  table, caption, tbody, tfoot, thead, tr, th, td,
  article, aside, canvas, details, embed,
  figure, figcaption, footer, header, hgroup,
  menu, nav, output, ruby, section, summary,
  time, mark, audio, video {
    margin: 0;
    padding: 0;
    border: 0;
    font-size: 100%;
    vertical-align: baseline;
  }
  /* HTML5 display-role reset for older browsers */
  article, aside, details, figcaption, figure,
  footer, header, hgroup, menu, nav, section {
    display: block;
  }
  ol,
  ul {
    list-style: disc;
    list-style-position: inside;
  }
  blockquote,
  q {
    quotes: none;
  }
  blockquote:before,
  blockquote:after,
  q:before,
  q:after {
    content: "";
    content: none;
  }
  table {
    border-collapse: collapse;
    border-spacing: 0;
  }
  a {
    color: inherit;
    text-decoration: none;
  }
  [role="button"] {
    cursor: pointer;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  * {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  /* Number */
  input::-webkit-outer-spin-button,
  input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  input[type=number] {
    -moz-appearance: textfield;
  }

  /*
   * The document defaults.
   *
   * The face: this was the pixel display face, set on body, from when the whole app was a
   * pixel-face product. Every element that does not name a font therefore inherited a display
   * face -- paragraphs, inputs, buttons, third-party widgets, anything written without a font
   * class. That is the single largest source of "the type does not match the rest of the site",
   * and no amount of per-component tidying fixes it while the default is wrong. The default is
   * now the body face; the pixel face is still one class away (font-pixel, .pixel-heading-*,
   * --font-pixelar) and everything that asked for it still gets it. The difference is that it is
   * now asked for rather than inherited.
   *
   * The line height: 1 is a display-face value. Inherited by body copy it sets paragraphs solid,
   * with the ascenders and descenders of adjacent lines nearly touching -- the readability
   * problem underneath half of "the text is hard to read". 1.5 is the ratio the reset assumes and
   * what this app's typographic scale is drawn against; anything that needs tighter says
   * leading-none.
   *
   * The width: min-width 100vw is 100% of the viewport INCLUDING the scrollbar gutter, so on
   * every page with a vertical scrollbar the document was 14-17px wider than the space available
   * and only overflow-x hidden kept it from scrolling sideways. Hiding an overflow is not the
   * same as not having one: centred layouts sat off-centre by half a scrollbar, and 100vw
   * children inherited the error. 100% is the viewport, correctly.
   */
  body {
    line-height: 1.5;
    font-size: 16px;
    /*
     * clip, NOT hidden -- and the difference is the whole of the page shake.
     *
     * \`overflow-x: hidden\` forces the other axis to compute as \`auto\`, so body was always
     * \`overflow: hidden auto\`. That is harmless for as long as <html> is \`visible\`, because then
     * body's overflow PROPAGATES to the viewport and body itself behaves as visible. The moment a
     * HeadlessUI dialog opens it locks the page with \`html { overflow: hidden }\` -- propagation
     * stops, body becomes its own scroll container, and it renders its own scrollbar INSIDE the
     * 14px of padding-right HeadlessUI just added to <html> to compensate for the viewport
     * scrollbar it removed. The gutter is paid for twice: the content box narrows by 14px and every
     * centred thing on the page -- the header dock, the 1240px rail, the bottom dock -- jumps 7px
     * left, then 7px back when the dialog closes. Measured: header 1906 -> 1892, layout-shift
     * sources all at dx -7.
     *
     * \`clip\` is exempt from that computed-value rule, so \`overflow-y\` stays \`visible\`, body never
     * becomes a scroll container, and the lock behaves. It is the same reason the top bar and
     * ContentWrapper already say \`[overflow-x:clip]\` rather than hidden, for their rims.
     */
    overflow-x: clip;
    min-width: 100%;
    /* dvh, not vh. On a phone 100vh is the pre-toolbar height, so a body sized by it is taller
       than the screen for as long as the browser chrome is showing, and the page gains a scrollbar
       it has no content for. Everything else in this app migrated some time ago (ContentWrapper,
       Loader, global-error); these two were the last of it. The reasoning is written out at length
       in LaunchBench. No backticks: this is inside a template literal. */
    min-height: 100dvh;
    margin: 0;
    font-family: ${({ theme }) => theme.fonts.forma};
    background-color: ${({ theme }) => theme.colors.black};

    img {
      height: auto;
      max-width: 100%;
    }
  }
  /*
   * #root is a selector from the Vite/CRA era; the App Router mounts into body and no element with
   * this id exists anywhere in the tree (checked). It matched nothing, so it is deleted rather
   * than migrated to dvh alongside the rule above.
   */
`;

export default GlobalStyle;
