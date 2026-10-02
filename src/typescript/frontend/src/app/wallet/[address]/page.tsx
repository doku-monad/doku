// cspell:word situationship

import { sha3_256 } from "@noble/hashes/sha3";
import { WalletClientPage } from "components/pages/wallet/WalletClientPage";
import generateMetadataHelper from "lib/utils/generate-metadata-helper";
import type { Metadata } from "next";

import { customTruncateAddress, resolveOwnerNameCached } from "../utils";
import UserNotFound from "./error";

type Props = {
  params: { address: string };
};

const descriptions: ((owner: string) => string)[] = [
  (owner) =>
    `peep inside ${owner}'s wallet like it's a situationship. are they holding or just holding on?`,
  (owner) =>
    `watch ${owner}'s trading history like it's a red flag. are they up or emotionally down?`,
  (owner) => `${owner}'s wallet reveals everything. charts, choices, coping mechanisms.`,
  (owner) => `see what ${owner}'s holding. and maybe why they haven't texted back.`,
  (owner) => `scroll ${owner}'s wallet like a breakup playlist. no judgment. just data.`,
];

function generateDescription(owner: string) {
  // Create a deterministic index based on the hash of the owner string input.
  const hash = sha3_256(owner);
  const idx = hash[0] % descriptions.length;
  const interpolate = descriptions[idx];
  return interpolate(owner);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const input = params.address;

  const { name, address } = await resolveOwnerNameCached(input);
  const owner = name ?? (address ? customTruncateAddress(address) : input);

  const title = `${owner}'s wallet`;
  const description = generateDescription(owner);

  return generateMetadataHelper({ title, description });
}

export default async function WalletPage({ params }: Props) {
  const { address, name } = await resolveOwnerNameCached(params.address);

  if (!address) {
    return <UserNotFound />;
  }

  return (
    /*
      `w-full`, not `mx-auto`.

      `ContentWrapper` is a column flex container, and an auto margin on the cross axis *replaces*
      `align-self: stretch` — so this wrapper was shrink-to-fit and the whole portfolio was as wide
      as whatever it happened to contain. Switching the deck's tab therefore resized the page:
      1170px on holdings, 854px on liquidity, with the right rail and the masthead sliding across
      the screen on every click. It read as a dozen unrelated glitches and was one line.
    */
    <div className="w-full">
      <WalletClientPage address={address} name={name} />
    </div>
  );
}
