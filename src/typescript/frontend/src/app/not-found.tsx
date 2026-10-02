import NotFoundComponent from "components/pages/not-found";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";

/*
 * A 404 says so in the tab, too.
 *
 * Without this it inherited `Doku | A Launchpad on Monad`, so a dead link looked in the tab strip
 * exactly like the landing page.
 *
 * The case that made it visible was the liquidity route: `middleware.ts` answers 404 there while
 * `FEATURE_FLAGS.Liquidity` is off, and it does so with an **empty body** — no HTML, so no title
 * and none of this screen either. That is a separate defect from this one and is not fixed here;
 * a bodyless 404 is correct for a crawler and a dead end for a person, and swapping it for a
 * rewrite onto this page is a behaviour change worth making on purpose.
 */
export const metadata = generateMetadataHelper({
  title: "Page not found",
  description: "That page does not exist. Launch a coin or head back to the board.",
});

const NotFoundPage = () => {
  return <NotFoundComponent />;
};

export default NotFoundPage;
