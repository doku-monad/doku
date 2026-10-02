// cspell:word dexscreener

// @ts-check
import analyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = analyzer({
  enabled: process.env.ANALYZE === "true",
});

const DEBUG = process.env.BUILD_DEBUG === "true";
/** @type {import('next').NextConfig} */
const debugConfigOptions = {
  productionBrowserSourceMaps: true,
  outputFileTracing: true,
  swcMinify: false,
  cleanDistDir: true,
  experimental: {
    serverMinification: false,
    serverSourceMaps: true,
  },
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(DEBUG ? debugConfigOptions : {}),
  crossOrigin: "use-credentials",
  /**
   * The asset marks under `public/marks` are not content-hashed, so Next serves them with a
   * four-hour `max-age` and the CDN re-validates each one on every visit past that — measured as
   * five ~1.1 s requests on the board for five sub-kilobyte SVGs. A day fresh and a week of
   * stale-while-revalidate makes a changed mark visible within a day while never blocking a paint.
   */
  async headers() {
    return [
      /*
       * The response headers every browser security review asks for first, none of which the
       * site sent: nothing stopped another page from framing the swap widget, nothing pinned
       * HTTPS, nothing stopped content sniffing. `frame-ancestors 'self'` rather than `'none'` so
       * the site could still be loaded as an app inside a wallet's own frame later; no other CSP
       * directives here, because a script policy needs a nonce pipeline this app does not have
       * and a wrong one takes the page down.
       */
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        source: "/marks/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
        ],
      },
    ];
  },
  typescript: {
    tsconfigPath: "tsconfig.json",
    ignoreBuildErrors: process.env.IGNORE_BUILD_ERRORS === "true",
  },
  compiler: {
    styledComponents: true,
  },
  /**
   * Match the new default behavior in next 15, without opinionated caching for dynamic pages.
   * @see {@link https://nextjs.org/docs/app/api-reference/config/next-config-js/staleTimes#version-history}
   */
  experimental: {
    // Use turbo when running/building locally. Since it's experimental, avoid it in production.
    turbo: process.env.NODE_ENV === "development" ? {} : undefined,
    staleTimes: {
      /*
       * 0 disabled Next's client router cache entirely: every back/forward and every card→market
       * click re-downloaded the page payload from a us-west2 origin (~0.6 s from Asia). 30 s is
       * Next's own default; the data inside stays fresh through TanStack (4 s staleTime, live
       * socket invalidations), so what this caches is the shell, not the numbers.
       */
      dynamic: 30,
      static: 60, // Default is normally 180s.
    },
  },
  /**
   * Stop splitting the client bundle into chunks too small to be worth a round trip.
   *
   * Measured on `/explore`: 45 script requests, 20 of them under 5 kB and 10 under 2 kB. At the
   * 150 ms RTT of a mobile connection each of those costs far more in latency than in bytes, and
   * they are all on the critical path because they are all needed to hydrate.
   *
   * `minSize` is webpack's "do not bother splitting below this" floor; raising it to 24 kB lets the
   * small ones merge into their parents. `maxInitialRequests`/`maxAsyncRequests` are left at
   * Next's own values — this is a floor on chunk size, not a cap on chunk count, and capping the
   * count would start merging chunks that genuinely belong to different routes.
   *
   * Scoped to the client build: the server bundle is read off local disk, where a round trip costs
   * nothing and larger chunks only slow cold starts.
   */
  webpack: (config, { isServer, dev, webpack }) => {
    if (!isServer && !dev && config.optimization?.splitChunks) {
      config.optimization.splitChunks.minSize = 24_000;
    }

    /*
     * Ship the one Clippy agent this app asks for, not all ten.
     *
     * `clippyts` resolves its agent with `import("./agents/" + name + ".js")`. A dynamic import
     * whose path is built from a variable makes webpack emit a *context module* covering every file
     * the expression could match — so all ten agents became async chunks: Peedy 2.82 MB, Rocky
     * 2.00 MB, Merlin 1.74 MB and seven more, 16.8 MB in total and 82% of everything in
     * `static/chunks`.
     *
     * `components/pages/cult/Clippy.tsx` calls `clippy.load({ name: "Clippy" })` and has never
     * called anything else. Narrowing the context to that one file keeps the page working exactly
     * as it does today and drops the other nine from the build.
     *
     * If somebody adds a second agent, widen this regex in the same commit — otherwise the import
     * resolves to nothing and the agent silently fails to appear.
     */
    config.plugins.push(
      new webpack.ContextReplacementPlugin(/clippyts[\\/]dist[\\/]agents/, /Clippy\.js$/)
    );

    return config;
  },
  // Log full fetch URLs if we're in a specific environment.
  logging:
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test" ||
    process.env.VERCEL_ENV === "preview" ||
    process.env.VERCEL_ENV === "development"
      ? {
          fetches: {
            fullUrl: true,
          },
        }
      : undefined,
  transpilePackages: ["@/sdk"],
  /**
   * Two renames, both answered here rather than by a page.
   *
   * `/` is not a destination any more. It served a marketing landing page in front of the product;
   * everyone lands on the market grid instead, because this is a venue and the thing a visitor came
   * for is the markets. `/home` is that grid's old path — it is `/explore` now, which is what the
   * page has always been: a list you look through, not a place you start from.
   *
   * ## Why here and not `redirect()` in a page
   *
   * A `redirect()` inside an App Router page renders the root layout first and then delivers the
   * redirect inside the RSC payload, so the browser paints the app shell at the old URL and
   * navigates a moment later. Verified, not assumed: `NEXT_REDIRECT` came back in the HTML body of
   * `GET /` with a 200 beside it. A config redirect is answered before any of that — one 307, no
   * render, no flash of an empty shell at a URL nobody should see.
   *
   * ## Why `permanent: false`
   *
   * A 308 is cached by browsers and CDNs indefinitely, which means it outlives the config that
   * declared it. This project has already been bitten once: `/` pointed at `/home` through a
   * permanent redirect, and the comment left behind when it was removed notes that early visitors
   * would keep landing there until their caches cleared, with nothing server-side able to undo it.
   * A 307 is re-asked every visit, so both of these stay reversible.
   */
  redirects: async () => [
    { source: "/", destination: "/explore", permanent: false },
    // Old links and bookmarks. `/home` was the grid's path for the whole life of the app before
    // this, so dropping it would 404 every one of them.
    { source: "/home", destination: "/explore", permanent: false },
    /*
     * `/token/<address>` is what a token's own metadata document names as its `external_url`
     * (see `indexer/src/metadata/token-metadata.ts`), and what a third-party terminal will link.
     * The page lives at `/market/<token>`; the market route resolves either of a market's two
     * addresses, so this is a plain alias rather than a second page. Temporary on purpose: a
     * browser never caches a 307, so the alias can be repointed the day `/token` grows a page of
     * its own.
     */
    { source: "/token/:address", destination: "/market/:address", permanent: false },
  ],
  /**
   * One rewrite, and only because the route moved.
   *
   * `/candlesticks` is the path the charting library was configured with before every API route
   * moved under `/api`, and links to it are out in the world.
   *
   * The other seven are gone with the handlers they named. `/pools/api`, `/coingecko/*` and
   * `/dexscreener/*` all pointed into `app/api/` directories that do not exist — a rewrite to a
   * missing route is a 404 with an extra hop, and worse than a plain one because it reads in this
   * file as though the endpoint were supported. The listing feeds those served were Aptos-era; the
   * data a listing site would want now comes from the indexer directly.
   */
  rewrites: async () => [
    {
      source: "/candlesticks",
      destination: "/api/candlesticks",
    },
  ],
};

export default withBundleAnalyzer(nextConfig);
