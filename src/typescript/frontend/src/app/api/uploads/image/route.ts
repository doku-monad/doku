import { createHash } from "node:crypto";

import { NextResponse } from "next/server";
import sharp from "sharp";

import { objectKey, publicImageUrl, putObject, readStoreConfig } from "@/lib/uploads/bucket";
import { callerOf, MAX_INPUT_PIXELS, overLimit } from "@/lib/uploads/limits";
import { publicOrigin } from "@/lib/uploads/public-origin";

/**
 * Where a launcher's artwork becomes something a transaction can carry.
 *
 * ## The problem this exists for
 *
 * `ImageField` read a chosen file into a `data:` URL and put it in React state. That renders
 * beautifully and cannot be launched: `LaunchParams.meta.logoURI` is capped at **128 bytes** on
 * chain, and the smallest useful data URL is four orders of magnitude past that. So a launcher
 * could fill in the entire form, choose artwork, watch the preview draw it, and have the
 * transaction refused for a field nothing had told them about.
 *
 * An image has to exist somewhere addressable *before* the launch is signed, and the thing that
 * goes on chain is a short URL — around eighty bytes — pointing at the stored object.
 *
 * ## Where the bytes are kept
 *
 * An S3 store — Cloudflare R2 by preference, the platform's own bucket otherwise — or IPFS through
 * Pinata when only a `PINATA_JWT` is set. A store came before pinning because pinning needed a
 * third-party account this deployment does not have: the route answered "Image upload is not
 * configured on this deployment" and every coin launched without a picture. See `uploads/bucket`
 * for why R2 wins when both are present.
 *
 * ## What happens to the bytes
 *
 * 1. **Sniffed, not trusted.** `file.type` is the browser's guess from the extension; a shell
 *    script named `logo.png` arrives as `image/png`. The magic bytes decide, and a file that is
 *    not one of the five accepted images never reaches the encoder or the paid pinning service.
 * 2. **Re-encoded**, always, to WebP at a fixed size for its kind. Re-encoding is what actually
 *    neutralises a polyglot and strips EXIF — a validated file that is passed through unchanged is
 *    still whatever it was. It also means everything the ledger sees is `image/webp`, which is
 *    inside its allowlist by construction rather than by luck.
 * 3. **Hashed and pinned.** `sha256` of the RE-ENCODED object, because that is the object the cid
 *    addresses and the object the collector will one day unpin. The input's hash would make the
 *    ledger unable to recognise its own file.
 * 4. **Registered** with the indexer's reference ledger, which is the only thing that can later
 *    tell a paid-for image from an orphan — it is the only component that sees `MetadataSet`.
 *
 * ## What it will not do
 *
 * Answer with a cid it did not get from the pinning service. That is the expensive failure: a
 * locally computed hash looks exactly like a real one, the launcher pays gas to write it on chain,
 * and the coin has a permanently broken image that nobody can replace. A pin that fails is a 502.
 */

/** Node, not Edge: `sharp` is a native module and `node:crypto` is not in the Edge runtime. */
export const runtime = "nodejs";

/**
 * Written down rather than inferred.
 *
 * A POST-only handler is never statically rendered, so this changes no behaviour — but the freshness
 * gate reads every route in the tree and the rule it enforces is that the choice is *stated*, not
 * that a particular value is chosen. A route that is correct only because of what Next infers from
 * its exports is one refactor from being wrong silently.
 */
export const dynamic = "force-dynamic";

/**
 * The input cap, matching what the field accepts.
 *
 * Checked before anything is decoded. `sharp` will happily start work on a 40 MB file, and a
 * decode bomb is a decode bomb whether or not it is a valid image.
 */
const MAX_INPUT_BYTES = 2 * 1024 * 1024;

/*
 * The two numbers that bound what an anonymous upload can cost, and the bucket that applies them,
 * live in `lib/uploads/limits` — a route file imports `sharp` and the AWS signer, which jest cannot
 * load, and logic that cannot be tested where it sits is logic nobody checks.
 */

/**
 * The two shapes, and the reason they are fixed rather than preserved.
 *
 * A card lays out a square mark and a 3:1 banner. An image at any other ratio is going to be
 * cropped by something — either here, once, deterministically, or by six different CSS rules that
 * each choose a different part of it.
 */
const SHAPES = {
  logo: { width: 512, height: 512 },
  banner: { width: 1536, height: 512 },
} as const;

type Kind = keyof typeof SHAPES;

/**
 * What the bytes actually are.
 *
 * Signatures rather than a library, because five formats is not a dependency's worth of problem
 * and because the answer here is load-bearing enough to want in front of us. WebP and JPEG are
 * checked at their real offsets — a WebP is `RIFF....WEBP`, so the first four bytes alone would
 * also accept a WAV.
 */
const sniff = (b: Buffer): "png" | "jpeg" | "webp" | "gif" | "svg" | null => {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString("ascii") === "RIFF" &&
    b.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString("ascii"))) return "gif";

  /*
   * SVG is text, so there is no signature — only a shape.
   *
   * A leading byte-order mark, whitespace, an XML declaration or a doctype may all come before the
   * root element, so the test is "an `<svg` appears near the start", bounded so a large file is not
   * scanned. It is rasterised immediately afterwards and never served as SVG: an SVG is a document
   * with script in it, and serving one from our own origin is a stored XSS.
   */
  if (/<svg[\s>]/i.test(b.subarray(0, 1024).toString("utf8"))) return "svg";

  return null;
};

interface Pinned {
  cid: string;
}

/**
 * Pin to IPFS through Pinata.
 *
 * The cid comes back from the service and is never computed here — see the note at the top.
 */
async function pin(bytes: Buffer, jwt: string): Promise<Pinned> {
  const body = new FormData();
  body.set("file", new File([new Uint8Array(bytes)], "image.webp", { type: "image/webp" }));

  const response = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}` },
    body,
  });

  if (!response.ok) {
    throw new Error(`pinata: ${response.status} ${await response.text().catch(() => "")}`);
  }

  const json = (await response.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new Error("pinata answered without a cid");
  return { cid: json.IpfsHash };
}

/**
 * Record the pin in the indexer's reference ledger.
 *
 * Not fatal. The image is pinned and the launcher can proceed; what is lost is the collector's
 * ability to tell this upload from an orphan in twenty-four hours, which costs storage rather than
 * correctness. Failing the request here would throw away a successful pin over a bookkeeping row.
 */
async function register(
  row: { cid: string; sha256: string; bytes: number; mime: string; width: number; height: number },
  indexerUrl: string,
  token: string,
): Promise<void> {
  const response = await fetch(`${indexerUrl.replace(/\/+$/, "")}/uploads`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(row),
  });
  if (!response.ok) {
    console.error(`uploads ledger refused ${row.cid}: ${response.status}`);
  }
}

export async function POST(request: Request) {
  /*
   * Before the multipart body is read, because reading it is already work — a 2MB upload is 2MB of
   * memory and a `sharp` decode behind it, and the point of a limit is to refuse before paying.
   */
  if (overLimit(callerOf(request))) {
    return NextResponse.json(
      { error: "Too many uploads from this address. Wait a minute and try again." },
      { status: 429, headers: { "retry-after": "60" } },
    );
  }

  const jwt = process.env.PINATA_JWT;
  const store = readStoreConfig();
  const uploadsToken = process.env.UPLOADS_TOKEN;
  const indexerUrl = process.env.DOKU_INDEXER_URL;

  /*
   * Said plainly, before any work.
   *
   * A deployment with nowhere to put the bytes cannot accept images, and the honest answer is
   * "this is not configured" rather than a 500 from deep inside an HTTP client — or, far worse, a
   * locally-invented address that looks like it worked.
   */
  if (!store && !jwt) {
    return NextResponse.json(
      { error: "Image upload is not configured on this deployment." },
      { status: 501 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form." }, { status: 400 });
  }

  const kind = String(form.get("kind") ?? "");
  if (!(kind in SHAPES)) {
    return NextResponse.json(
      { error: `Unknown kind "${kind}" — expected one of ${Object.keys(SHAPES).join(", ")}.` },
      { status: 400 },
    );
  }
  const shape = SHAPES[kind as Kind];

  const file = form.get("image");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No image was sent." }, { status: 400 });
  }
  if (file.size > MAX_INPUT_BYTES) {
    return NextResponse.json(
      { error: `Too large — ${(file.size / 1024 / 1024).toFixed(1)}MB, the limit is 2MB.` },
      { status: 413 },
    );
  }

  const input = Buffer.from(await file.arrayBuffer());
  const format = sniff(input);
  if (!format) {
    return NextResponse.json(
      { error: "That is not an image. PNG, JPEG, WebP, GIF and SVG are accepted." },
      { status: 415 },
    );
  }

  let output: Buffer;
  try {
    output = await sharp(input, {
      // The first frame of an animated GIF. Animation cannot survive the WebP the card renders at
      // a fixed size, and a still frame is a truthful reduction rather than a broken loop.
      animated: false,
      // Stated, not inherited. See MAX_INPUT_PIXELS.
      limitInputPixels: MAX_INPUT_PIXELS,
      // An SVG has no intrinsic pixels, so it is rasterised at a density that fills the target
      // rather than at the default 72dpi, which produces a blurred upscale of a vector.
      density: format === "svg" ? 384 : undefined,
    })
      .resize(shape.width, shape.height, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (e) {
    // Reached the decoder and failed there: a truncated file, or a format sharp was built without.
    console.error("image re-encode failed", e);
    return NextResponse.json({ error: "That image could not be read." }, { status: 415 });
  }

  /*
   * Hashed BEFORE it is stored, because the hash is the address.
   *
   * It is the digest of the RE-ENCODED object — the one that will be served — and not of the file
   * that was uploaded. The input's hash would address bytes that never exist anywhere, and would
   * make the reference ledger unable to recognise its own file.
   */
  const sha256 = createHash("sha256").update(output).digest("hex");

  /**
   * The stored address, and the URL that goes on chain.
   *
   * Never computed optimistically. If the store refuses, this answers 502 and the launcher has
   * spent nothing — the expensive failure is returning an address for bytes that were never
   * written, because it looks exactly like a real one and the launcher pays gas to put it on chain
   * before anyone discovers the image is not there.
   */
  let cid: string;
  let uri: string;
  let url: string;

  if (store) {
    const key = objectKey(sha256);
    try {
      await putObject(store, key, output, "image/webp");
    } catch (e) {
      console.error("bucket store failed", e);
      return NextResponse.json(
        { error: "The image could not be stored. Nothing was charged — try again." },
        { status: 502 },
      );
    }
    const origin = publicOrigin(request.url);
    if (!origin) {
      console.error("no public origin: refusing to write a relative image link on chain");
      return NextResponse.json(
        { error: "The image could not be stored. Nothing was charged — try again." },
        { status: 502 },
      );
    }
    cid = key;
    /* Straight at the bucket's own domain where it publishes one, so the image is served from a
       CDN edge rather than through this app. Falls back to the proxy when the bucket is private. */
    uri = publicImageUrl(store, key, origin);
    url = uri;
  } else {
    let pinned: Pinned;
    try {
      pinned = await pin(output, jwt!);
    } catch (e) {
      console.error("pinning failed", e);
      return NextResponse.json(
        { error: "The image could not be stored. Nothing was charged — try again." },
        { status: 502 },
      );
    }
    cid = pinned.cid;
    uri = `ipfs://${pinned.cid}`;
    url = `${(process.env.NEXT_PUBLIC_CDN_URL || "https://ipfs.io/ipfs").replace(/\/+$/, "")}/${pinned.cid}`;
  }

  if (uploadsToken && indexerUrl) {
    await register(
      {
        cid,
        sha256,
        bytes: output.length,
        mime: "image/webp",
        width: shape.width,
        height: shape.height,
      },
      indexerUrl,
      uploadsToken,
    ).catch((e) => console.error("uploads ledger unreachable", e));
  }

  return NextResponse.json(
    {
      cid,
      /** What goes on chain. Under 128 bytes, which is the whole reason this route exists. */
      uri,
      /** What the browser draws now. The same URL when the bucket serves it. */
      url,
      width: shape.width,
      height: shape.height,
      bytes: output.length,
      sha256,
    },
    { status: 201 },
  );
}
