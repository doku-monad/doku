/**
 * @jest-environment node
 */
import sharp from "sharp";

/**
 * The route that stands between a file on somebody's disk and a 128-byte on-chain URI.
 *
 * `ImageField` read a file into a `data:` URL and handed it to React state. A `data:` URL cannot
 * go on chain — `LaunchParams.meta.logoURI` is capped at 128 BYTES, and the smallest useful data
 * URL is four orders of magnitude past that. So a launcher could fill in the whole form, choose
 * artwork, watch it render in the preview, and have the transaction refused for a field they were
 * never told about.
 *
 * Every assertion here is about a way that can still go wrong quietly.
 */

/** A real PNG, made by the same library the route re-encodes with. */
const png = (w = 900, h = 900) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .png()
    .toBuffer();

const form = async (bytes: Buffer, kind: string, name = "logo.png", type = "image/png") => {
  const fd = new FormData();
  fd.set("image", new File([new Uint8Array(bytes)], name, { type }), name);
  fd.set("kind", kind);
  return fd;
};

const post = async (fd: FormData) => {
  const { POST } = await import("../../src/app/api/uploads/image/route");
  const res = await POST(new Request("http://x/api/uploads/image", { method: "POST", body: fd }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/** What Pinata and the indexer's ledger answer, and what they were asked. */
let calls: { url: string; init: RequestInit | undefined }[];

const CID = "bafkreiabcdefghijklmnopqrstuvwxyz234567";

beforeEach(() => {
  jest.resetModules();
  calls = [];
  process.env.PINATA_JWT = "pinata-jwt";
  process.env.UPLOADS_TOKEN = "uploads-token";
  process.env.DOKU_INDEXER_URL = "http://indexer";

  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("pinata")) {
      return new Response(JSON.stringify({ IpfsHash: CID, PinSize: 1, Timestamp: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ status: "inserted" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});

describe("POST /api/uploads/image", () => {
  it("returns an ipfs:// uri, not a data: url", async () => {
    const { status, body } = await post(await form(await png(), "logo"));

    expect(status).toBe(201);
    expect(body.uri).toBe(`ipfs://${CID}`);
    expect(body.cid).toBe(CID);
    // The whole point: what the form submits must fit in 128 bytes of on-chain string.
    expect(Buffer.byteLength(String(body.uri), "utf8")).toBeLessThanOrEqual(128);
  });

  it("re-encodes a logo to 512x512 WebP and a banner to 1536x512", async () => {
    const logo = await post(await form(await png(), "logo"));
    expect(logo.body.width).toBe(512);
    expect(logo.body.height).toBe(512);

    const banner = await post(await form(await png(2000, 900), "banner"));
    expect(banner.body.width).toBe(1536);
    expect(banner.body.height).toBe(512);
  });

  /**
   * The declared type is the caller's claim, not a fact.
   *
   * `file.type` comes from the browser, which takes it from the file extension. A shell script
   * named `logo.png` arrives as `image/png`. Re-encoding is what actually neutralises a polyglot,
   * and sniffing is what stops the bytes reaching the encoder at all.
   */
  it("sniffs the magic bytes rather than trusting the declared type", async () => {
    const notAnImage = Buffer.from("#!/bin/sh\nrm -rf /\n");
    const { status, body } = await post(await form(notAnImage, "logo", "logo.png", "image/png"));

    expect(status).toBe(415);
    expect(String(body.error)).toMatch(/not an image/i);
    // Nothing was pinned. A rejected file must not reach the paid service.
    expect(calls).toHaveLength(0);
  });

  /** GIF and SVG are offered by the field and refused by the ledger, so the route rasterises. */
  it("rasterises a GIF and an SVG to WebP rather than refusing them after the form is filled", async () => {
    const gif = await sharp(await png(300, 300))
      .gif()
      .toBuffer();
    const gifResult = await post(await form(gif, "logo", "a.gif", "image/gif"));
    expect(gifResult.status).toBe(201);

    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>'
    );
    const svgResult = await post(await form(svg, "logo", "a.svg", "image/svg+xml"));
    expect(svgResult.status).toBe(201);

    // Everything reaching the ledger is WebP — its allowlist is webp, png and jpeg, and an SVG
    // served as an SVG is a script the browser will run.
    const registrations = calls.filter((c) => c.url.includes("/uploads"));
    for (const c of registrations) {
      expect(JSON.parse(String(c.init?.body)).mime).toBe("image/webp");
    }
  });

  /**
   * The ledger row describes what was PINNED, not what was uploaded.
   *
   * `sha256` and `bytes` are the re-encoded object's, because that is the object the cid addresses
   * and the object the GC will unpin. Recording the input's hash would make the ledger unable to
   * recognise its own file.
   */
  it("registers the re-encoded bytes with the indexer, bearing the uploads token", async () => {
    await post(await form(await png(), "logo"));

    const registration = calls.find((c) => c.url.includes("/uploads"));
    expect(registration).toBeDefined();

    const headers = new Headers(registration!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer uploads-token");

    const sent = JSON.parse(String(registration!.init?.body));
    expect(sent.cid).toBe(CID);
    expect(sent.mime).toBe("image/webp");
    expect(sent.width).toBe(512);
    expect(sent.height).toBe(512);
    expect(sent.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The re-encoded object, not the 900x900 PNG that arrived.
    expect(sent.bytes).toBeGreaterThan(0);
  });

  it("refuses a file over 2MB before it re-encodes anything", async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0);
    // A real PNG header, so this is rejected on SIZE and not on sniffing.
    (await png(1, 1)).copy(big, 0);

    const { status, body } = await post(await form(big, "logo"));
    expect(status).toBe(413);
    expect(String(body.error)).toMatch(/2 ?MB/i);
    expect(calls).toHaveLength(0);
  });

  /**
   * A pin that failed must not answer with a cid.
   *
   * The failure mode this forbids is the expensive one: a route that shrugs and returns a hash it
   * computed locally hands the form a URI that resolves to nothing, the launcher pays gas to write
   * it on chain, and the coin has a permanently broken image that no one can replace.
   */
  it("fails loudly when the pin fails, rather than inventing a cid", async () => {
    global.fetch = jest.fn(
      async () => new Response("nope", { status: 500 })
    ) as unknown as typeof fetch;

    const { status, body } = await post(await form(await png(), "logo"));
    expect(status).toBe(502);
    expect(body.cid).toBeUndefined();
    expect(body.uri).toBeUndefined();
  });

  it("says the deployment is not configured rather than half-working", async () => {
    delete process.env.PINATA_JWT;
    const { status, body } = await post(await form(await png(), "logo"));

    expect(status).toBe(501);
    expect(String(body.error)).toMatch(/not configured/i);
  });

  it("rejects a kind it does not have a shape for", async () => {
    const { status } = await post(await form(await png(), "avatar"));
    expect(status).toBe(400);
  });
});
