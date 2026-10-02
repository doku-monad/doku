"use client";

/*
 * eslint-disable @next/next/no-img-element — the mark is fetched from the issuer's own domain at
 * request time (see `assetIconUrl`). `next/image` would require every issuer's host to be
 * allow-listed in `next.config.mjs`, which is a list that grows with the registry.
 */
/* eslint-disable @next/next/no-img-element */

import { cn } from "lib/utils/class-name";
import { useState } from "react";

import { assetIconUrl, type QuoteAsset } from "@/lib/assets/quote-assets";

/**
 * A quote asset's mark.
 *
 * Twelve tickers in a row is a memory test — `SPYx`, `TBILLx` and `XAUx` mean nothing to somebody
 * who has not read the registry page, and the whole point of pairing against a real-world asset is
 * that people already recognise it. The issuer's own icon does in one glance what the ticker does
 * in a paragraph.
 *
 * ## Why it degrades rather than breaks
 *
 * The image is fetched from a third party at request time, so it can be slow, blocked by an
 * extension, or simply absent for an asset with no issuer. All three land in the same place: the
 * monogram, which is what the component renders until an image has actually loaded and what it
 * falls back to permanently if one errors. There is never a broken-image glyph and never an empty
 * square — the slot always contains something that identifies the asset.
 */
export const AssetIcon = ({
  asset,
  size = 20,
  className,
}: {
  asset: QuoteAsset;
  /**
   * A number is pixels. A string is any CSS length, which is how the hero's headline asks for
   * `0.7em` and gets a mark that tracks its own `clamp()` — the box resolves `em` against the
   * inherited size, so nothing here may set a `font-size` on it.
   */
  size?: number | string;
  className?: string;
}) => {
  const px = typeof size === "number" ? size : null;
  /* An `em` box is headline-sized, so it takes the large file. */
  const src = assetIconUrl(asset, px !== null && px <= 24 ? 32 : 64);
  const [failed, setFailed] = useState(false);

  const monogram = asset.symbol.replace(/x$/, "").slice(0, 3).toUpperCase();

  return (
    <span
      aria-hidden
      title={asset.name}
      /* The ground is for the MONOGRAM only. A real mark supplies its own — `mon.svg` is Monad's
         published logomark on a transparent ground, and a dark slab behind it is a black box around
         somebody's logo; the rest are coloured discs that fill the tile anyway. Three mute letters
         are the one case that cannot read without a surface. See `.doku-asset-tile`. */
      data-ground={!src || failed ? "true" : undefined}
      className={cn(
        "doku-asset-tile grid shrink-0 place-items-center overflow-hidden rounded-[5px]",
        className
      )}
      style={{ width: size, height: size }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          width={px ?? undefined}
          height={px ?? undefined}
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span
          className="select-none font-numeric font-semibold uppercase leading-none text-mute"
          style={{
            fontSize: px !== null ? Math.max(8, Math.round(px * 0.38)) : `calc(${size} * 0.38)`,
          }}
        >
          {monogram}
        </span>
      )}
    </span>
  );
};

export default AssetIcon;
