import { SITE_DESCRIPTION } from "configs/meta";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";

import ClientLaunchPage from "../../components/pages/launch/ClientLaunchPage";

export const dynamic = "force-static";

/*
 * The site's own sentence, because this page is what it describes.
 *
 * The line this replaced was lower-case, carried an em dash and ended in a party popper, which is
 * two characters of a search snippet spent on something no crawler indexes. It also predated the
 * sentence in `configs/meta.ts`, so the page the site's description is *about* was the one page
 * not using it.
 */
export const metadata = generateMetadataHelper({
  title: "Launch a coin",
  description: SITE_DESCRIPTION,
});

export default async function LaunchMarketPage() {
  return <ClientLaunchPage />;
}
