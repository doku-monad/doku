import { NATIVE_QUOTE_ADDRESS, type QuoteAssetWire } from "@/lib/assets/quote-assets";
import type { HolderModel, MarketModel, SwapModel } from "@/lib/models";
import type { PortfolioPosition } from "@/lib/queries/doku";
import type { TokenMetadata } from "@/lib/token-identity/metadata";

/**
 * Fabricated markets, for looking at the grid when there is no indexer to talk to.
 *
 * ## Why this exists at all
 *
 * The card and its grid are the most design-heavy surface in the product, and they are impossible
 * to evaluate against an empty state. Running the indexer to judge a hover treatment is a heavy
 * dependency for a purely visual question.
 *
 * ## Why it is quarantined
 *
 * These are **invented numbers on a page people trade from**, which is the one thing this codebase
 * is careful never to do — see the note in `TableCard` about refusing to print a `$` on a MON
 * figure. So the rule for this module is absolute: nothing here may ever render in production.
 *
 * ## The guard, and why it is not `NODE_ENV`
 *
 * The first version gated on `process.env.NODE_ENV === "development"` and **it did not work**. A
 * production `next build` folded that comparison to `true`, removed the `notFound()` as dead code,
 * and shipped the preview: `next start` answered `200` on `/card-preview`, and both the banner
 * text and the `0xdeaddead…` addresses were present in `.next/server/app/card-preview/page.js`.
 * Whatever `NODE_ENV` this app's app-router server compilation sees, it is not reliably
 * `"production"` — so it cannot be the thing standing between invented prices and a deployment.
 *
 * The guard is an **explicit opt-in** instead: a variable nobody sets by accident, absent from any
 * deployment that has not deliberately added it, and read through bracket notation so that
 * `DefinePlugin` — which only rewrites the dotted `process.env.FOO` form — leaves it as a real
 * runtime lookup no minifier can fold.
 *
 * Set `DOKU_CARD_PREVIEW=true` in `frontend/.env.local` to use it. Anywhere that variable is
 * missing the route is a 404 — not a hidden page, an absent one.
 *
 * The route additionally renders a banner saying the data is fake, because a developer three
 * months from now looking at a screenshot of it should not have to wonder.
 *
 * ## Why the *metadata* is not behind the same guard
 *
 * `PREVIEW_METADATA` below is merged into `TOKEN_METADATA` unconditionally, and that is deliberate.
 * It is keyed on the `0xdead…` addresses, which no market on any chain can have, so in production
 * it is a lookup table nothing can ever hit — while the env-var guard, which is a *server* runtime
 * read, cannot be applied to it at all: the browser would evaluate the same module with the
 * variable absent, resolve every preview coin to its fallback name, and React would report a
 * hydration mismatch on every card. The thing that had to be gated was the route that renders
 * invented prices. It still is.
 */

/**
 * Whether the preview route is switched on.
 *
 * The bracket notation is load-bearing, not style: `process.env.DOKU_CARD_PREVIEW` would be
 * inlined at build time and folded to a constant, which is precisely how the previous guard failed.
 */
export const previewEnabled = process.env["DOKU_CARD_PREVIEW"] === "true";

/** 18 decimals, as base units — the same scale the chain and the indexer use. */
const mon = (whole: number) => BigInt(Math.round(whole * 1e6)) * 1_000_000_000_000n;

const DAY = 86_400_000;

/**
 * The address the fixture belongs to.
 *
 * Any address reaches it while `DOKU_CARD_PREVIEW` is set — the routes fall back to this whenever
 * the indexer has nothing — but this is the one to visit deliberately, and the one the trades are
 * signed with so the activity feed agrees with the page it sits on.
 */
export const PREVIEW_ACCOUNT = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0001";

/** Unmistakable in a screenshot, a log line, or a URL — nobody will confuse this for real. */
/**
 * Which fixture markets the preview account launched.
 *
 * Spread across the states the launches tab has to survive: one graduated, one about to, one that
 * has barely traded. A creator with four identical rows proves nothing about the design.
 */
const PREVIEW_LAUNCHES = new Set([0, 2, 6, 10]);

const marketAddressAt = (i: number) =>
  `0xdeaddeaddeaddeaddeaddeaddeaddead${String(i).padStart(8, "0")}`;

/* ---------------------------------------------------------------------------------------------
 * Artwork
 *
 * Inline SVG as `data:` URLs rather than files under `public/`, because a fixture that needs a
 * dozen PNGs committed beside it is a fixture nobody extends. They are also the honest shape of
 * what a launcher supplies today — `ImageField` on the launch form produces exactly this.
 *
 * Only some coins get artwork, on purpose. The card has two identity paths — a supplied logo and
 * banner, or a monogram and a generated banner derived from the ticker — and a fixture where every
 * coin has images exercises the half of the card that almost no real market will use.
 * ------------------------------------------------------------------------------------------- */

const svg = (markup: string) => `data:image/svg+xml,${encodeURIComponent(markup)}`;

/** A square mark: a two-stop field with a glyph centred on it. */
const logoFor = (from: string, to: string, glyph: string) =>
  svg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><text x="32" y="43" font-size="34" text-anchor="middle" font-family="system-ui,sans-serif">${glyph}</text></svg>`
  );

/** A 3:1 band: a wash, a horizon and a low sun. Enough to judge the crop and the overlay. */
const bannerFor = (from: string, to: string, accent: string) =>
  svg(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 120"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="360" height="120" fill="url(#b)"/><circle cx="284" cy="42" r="30" fill="${accent}" opacity="0.55"/><path d="M0 92 L74 68 L138 88 L206 56 L268 80 L360 50 L360 120 L0 120 Z" fill="${accent}" opacity="0.22"/></svg>`
  );

/* ---------------------------------------------------------------------------------------------
 * The fixture
 * ------------------------------------------------------------------------------------------- */

type Seed = {
  /** The on-chain symbol. Emoji, because that is what the deployed factory records. */
  symbol: string;
  /** The name a launcher typed. Drives `identityFor`'s metadata branch. */
  name: string;
  ticker: string;
  logo?: string;
  banner?: string;
  links?: TokenMetadata["links"];
  /** Market cap in whole MON. */
  cap: number;
  /** 24h volume in whole MON. */
  volume: number;
  /** How far below its all-time high, in percent. `0` is a market at a new high. */
  drawdown: number;
  /** 0–1. Ignored when `graduated`. */
  progress: number;
  graduated?: boolean;
  /** Age in days. */
  age: number;
  holders: number;
  trades: number;
};

/*
 * Deliberately spread across every state the card has to survive:
 *
 *   - with and without a logo, with and without a banner, so both identity paths appear
 *   - a name long enough to truncate against the pair badge, and a two-character one
 *   - graduated and ungraduated, so both bottom treatments show
 *   - 0%, single-digit and 97% progress, so the meter's floor and its full state both show
 *   - caps spanning five orders of magnitude, so the compact formatter is visible at every step
 *   - one market at its high (the case that proves the green chip) and one down 74%
 *   - one market with no volume at all, so the dead-market row is legible
 *   - coins with all their links, with some, and with none, so the action band's three widths show
 */
const SEEDS: Seed[] = [
  {
    symbol: "🚀🌕",
    name: "Moonshot Protocol",
    ticker: "MOON",
    logo: logoFor("#7C5CFF", "#3A1E9E", "🚀"),
    banner: bannerFor("#2A1B5E", "#0E0A24", "#9B7CFF"),
    links: { website: "https://example.com", x: "https://x.com/example" },
    cap: 27_800_000,
    volume: 3_100_000,
    drawdown: 0,
    progress: 0.97,
    age: 8,
    holders: 4_411,
    trades: 32_889,
  },
  {
    symbol: "🐸",
    name: "Pepe Renaissance",
    ticker: "PEPER",
    logo: logoFor("#3FBF5F", "#125A26", "🐸"),
    links: { x: "https://x.com/example" },
    cap: 1_500_000,
    volume: 452_000,
    drawdown: 12,
    progress: 0.62,
    age: 3,
    holders: 1_284,
    trades: 9_413,
  },
  {
    symbol: "🦄",
    name: "Unicorn Liquidity Machine",
    ticker: "UNILM",
    banner: bannerFor("#4A1E52", "#170A1C", "#FF7CD8"),
    links: { website: "https://example.com" },
    cap: 812_400,
    volume: 96_300,
    drawdown: 31,
    progress: 1,
    graduated: true,
    age: 17 / 24,
    holders: 902,
    trades: 6_120,
  },
  {
    symbol: "🔥",
    name: "Burn Notice",
    ticker: "BURN",
    logo: logoFor("#FF8709", "#8A3D00", "🔥"),
    cap: 96_300,
    volume: 8_430,
    drawdown: 6,
    progress: 0.08,
    age: 42 / 1440,
    holders: 61,
    trades: 214,
  },
  {
    symbol: "💎🙌",
    name: "Diamond Hands",
    ticker: "DH",
    links: { website: "https://example.com", x: "https://x.com/example" },
    cap: 3_940,
    volume: 748.26,
    drawdown: 47,
    progress: 0.34,
    age: 9 / 1440,
    holders: 18,
    trades: 47,
  },
  {
    symbol: "🧊",
    name: "Cold Storage",
    ticker: "COLD",
    banner: bannerFor("#12384A", "#061219", "#5FD6F5"),
    cap: 458_900,
    /* No volume at all. A graduated market nobody is trading is the row a board must not make
       look like a live one — this is the card that proves the volume column earns its rule. */
    volume: 0,
    drawdown: 61,
    progress: 1,
    graduated: true,
    age: 2 / 1440,
    holders: 377,
    trades: 1_902,
  },
  {
    symbol: "🦈",
    name: "Shark Tank Finance",
    ticker: "SHARK",
    logo: logoFor("#2E6CA8", "#0F2740", "🦈"),
    links: { x: "https://x.com/example" },
    cap: 471.34,
    volume: 120.5,
    drawdown: 74,
    progress: 0.05,
    age: 4,
    holders: 7,
    trades: 19,
  },
  {
    symbol: "🍄",
    name: "Mycelium Network Token With A Very Long Name",
    ticker: "MYCO",
    cap: 1_700,
    volume: 640,
    drawdown: 9,
    progress: 0.46,
    age: 5,
    holders: 44,
    trades: 168,
  },
  {
    symbol: "🌊",
    name: "Tidal",
    ticker: "TIDE",
    logo: logoFor("#1E7A9E", "#08303F", "🌊"),
    banner: bannerFor("#0B3C4E", "#04161D", "#4FD6F5"),
    links: { website: "https://example.com", x: "https://x.com/example" },
    cap: 3_000,
    volume: 1_240,
    drawdown: 18,
    progress: 1,
    graduated: true,
    age: 5,
    holders: 210,
    trades: 1_115,
  },
  {
    symbol: "🦊",
    name: "Fox Den",
    ticker: "FOX",
    cap: 1_600,
    volume: 505,
    drawdown: 32,
    progress: 0.43,
    age: 1,
    holders: 33,
    trades: 121,
  },
  {
    symbol: "🐙",
    name: "Kraken Arms",
    ticker: "KRKN",
    logo: logoFor("#8A4BC4", "#2E1449", "🐙"),
    cap: 748.26,
    volume: 96,
    drawdown: 0,
    progress: 0.17,
    age: 2,
    holders: 12,
    trades: 38,
  },
  {
    symbol: "🌙",
    name: "Crescent",
    ticker: "CRSNT",
    links: { website: "https://example.com" },
    cap: 1_700,
    volume: 88,
    drawdown: 55,
    progress: 1,
    graduated: true,
    age: 1,
    holders: 155,
    trades: 806,
  },
];

/**
 * The preview coins' names, tickers and artwork, keyed by market address.
 *
 * Merged into `TOKEN_METADATA` so the preview route exercises the *metadata* branch of
 * `identityFor` — the one every real launch will take the day the form persists anything, and the
 * only one that produces a card with a chosen name and a real ticker on it. Without this the
 * fixture rendered twelve cards called "Frog Face" and "Rocket Full Moon", which tests the
 * fallback and nothing else.
 *
 * See the note at the top of this file for why this is not behind `previewEnabled`.
 */
export const PREVIEW_METADATA: Record<string, TokenMetadata> = Object.fromEntries(
  SEEDS.map((seed, i) => [
    marketAddressAt(i).toLowerCase(),
    {
      name: seed.name,
      ticker: seed.ticker,
      logo: seed.logo,
      banner: seed.banner,
      links: seed.links,
      /* One of each routing across the fixture, so all three states of the market page's rewards
         module can be looked at: holders, buyback, and — for everything else — none at all, which
         is what a market whose creator keeps their share renders. */
      feeRouting:
        i % 3 === 0 ? ("holders" as const) : i % 3 === 1 ? ("buyback" as const) : undefined,
      creatorFeePct: i % 4 === 0 ? 2 : 0,
    },
  ])
);

/**
 * Builds the dummy set.
 *
 * `now` is a parameter rather than a `Date.now()` call so a server render and the client render
 * that hydrates it agree on every age — computing it inside would produce two different values a
 * few milliseconds apart and React would report a hydration mismatch on the age column.
 */
export function dummyMarkets(now: number): MarketModel[] {
  return SEEDS.map((seed, i) => {
    const cap = mon(seed.cap);
    const target = mon(50_000);
    // Integer arithmetic throughout: these are 18-decimal base units, well past what a float holds
    // exactly, so the high is scaled by a ratio of bigints rather than by multiplying a Number.
    const ath = (cap * 100n) / BigInt(100 - seed.drawdown);
    return {
      market: {
        marketAddress: marketAddressAt(i),
        tokenAddress: `0xbeefbeefbeefbeefbeefbeefbeefbeef${String(i).padStart(8, "0")}`,
        symbol: seed.symbol,
        // The factory writes the joined symbol into `name`, so the fixture does the same — the
        // real name arrives through `PREVIEW_METADATA`, which is the path a launched coin takes.
        name: seed.symbol,
        symbolKey: `0x${String(i).padStart(64, "0")}`,
        creator: PREVIEW_LAUNCHES.has(i)
          ? PREVIEW_ACCOUNT
          : "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        launchedAt: new Date(now - seed.age * DAY),
        // The card preview shows generation-1 MON markets — the shape every market on the
        // launchpad had before the pairs contracts, and the one the fixtures were drawn against.
        // A generation-2 fixture would need real gen-2 prices, which is a different exercise.
        generation: 1,
        quote: {
          asset: "0x0000000000000000000000000000000000000000",
          decimals: 18,
          symbol: "MON",
          id: "mon",
        },
        routing: null,
        routedRecipient: null,
        creatorTaxBps: 0,
        taxRecipient: null,
        metadata: {
          ticker: null,
          logoUri: null,
          bannerUri: null,
          description: null,
          website: null,
          x: null,
          telegram: null,
        },
      },
      state: {
        quoteRaised: mon(50_000 * seed.progress),
        quoteTarget: target,
        progress: seed.progress,
        lastPrice: mon(0.0001),
        // Generation 1, so the stored figure and the resolved one are the same number.
        lastPriceQuote: mon(0.0001),
        volumeQuote: mon(seed.volume * 4),
        volume24h: mon(seed.volume),
        totalSupply: mon(1_000_000_000),
        marketCap: cap,
        athMarketCap: ath,
        athProgress: (100 - seed.drawdown) / 100,
        tradeCount: seed.trades,
        holders: seed.holders,
        readyToGraduate: seed.progress >= 1 && !seed.graduated,
        poolAddress: seed.graduated
          ? `0xf00df00df00df00df00df00df00df00d${String(i).padStart(8, "0")}`
          : null,
        /*
         * No pool key, even on a fabricated graduated market.
         *
         * The recorded key is what the graduation log wrote, and a made-up one hashes to a
         * `PoolId` for a pool that does not exist — which is worse than none: `poolKeyOf` reads
         * "no recorded key" as "fall back to the pair's own", while a fabricated one is taken as
         * authoritative. The fixture exists so the CARDS can be looked at with no indexer; it has
         * never been a chain.
         */
        poolId: null,
        poolKey: null,
        lastSwapAt: new Date(now - seed.age * DAY * 0.1),
        change24h: null,
        marketCapUsd: null,
      },
    };
  });
}

/**
 * A deterministic 24-hour price series for a preview market.
 *
 * The hero's leaderboard draws a sparkline per row from real candlesticks, and in preview there is
 * no indexer to ask — so those four rows rendered as flat, traceless strips while the grid below
 * them was fully dressed. That is the wrong half of the page to leave undrawn: the trace is the
 * component being judged.
 *
 * A seeded walk rather than `Math.random`: this is computed during a server render whose output is
 * revalidated every two seconds, and a series that changes on each pass makes the hero flicker
 * between shapes. Seeded from the address, so a market's trace is *its* trace.
 *
 * It ends at exactly `1 - drawdown/100` of its own peak, so the line agrees with the percentage
 * printed beside it. A preview whose chart and whose figure disagree teaches the reader to
 * distrust one of them, and they will pick the wrong one.
 */
export function dummySpark(seedText: string, drawdownPct: number, buckets = 96): number[] {
  let seed = 0;
  for (let i = 0; i < seedText.length; i++) seed = (seed * 31 + seedText.charCodeAt(i)) >>> 0;

  /* A 32-bit linear congruential generator — Numerical Recipes' constants. Enough randomness for a
     96-point line and cheap enough to run per row without thinking about it. */
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const closes: number[] = [];
  let value = 1;
  for (let i = 0; i < buckets; i++) {
    // A slight upward drift with noise on top: the shape of a market that ran and then gave some
    // back, which is what a drawdown figure describes.
    value = Math.max(0.05, value * (1 + (rand() - 0.46) * 0.06));
    closes.push(value);
  }

  const peak = Math.max(...closes);
  const target = peak * (1 - drawdownPct / 100);
  // Land the last point exactly on the figure the card prints, easing the final eighth into it so
  // the correction reads as a move rather than as a cut.
  const tail = Math.max(2, Math.round(buckets / 8));
  for (let i = buckets - tail; i < buckets; i++) {
    const t = (i - (buckets - tail) + 1) / tail;
    closes[i] = closes[i] * (1 - t) + target * t;
  }
  return closes;
}

/** How far below its high a preview market sits, by index — the same table the fixture builds. */
export const dummyDrawdown = (i: number) => SEEDS[i % SEEDS.length].drawdown;

/* ---------------------------------------------------------------------------------------------
 * The market page's fixture
 *
 * The board had one and the page a card links *into* did not, so `/explore` was reviewable with
 * the indexer down and the surface with the swap widget on it — the densest, most design-heavy
 * screen in the product — was a "no such market" page. Everything below exists for the same
 * reason `dummyMarkets` does, under exactly the same guard, and is subject to the same absolute
 * rule: it may never render in production. See the note at the top of this file.
 * ------------------------------------------------------------------------------------------- */

/** Looks up a fabricated market by the address in the URL. `undefined` for anything real. */
export function dummyMarketByAddress(address: string, now: number): MarketModel | undefined {
  return dummyMarkets(now).find(
    (m) => m.market.marketAddress.toLowerCase() === address.toLowerCase()
  );
}

/**
 * A fixture market for an address that is not one of the fixture's own.
 *
 * `dummyMarketByAddress` answers only for `0xdead…`, which is right for the fixture's own links and
 * useless for the situation people actually hit: the board is showing markets the indexer gave it
 * (or gave it before it went down), every card links to a real address, and every one of those
 * links lands on "this market is being indexed" the moment the indexer stops answering. The whole
 * point of the preview flag is that the product can be looked at without a backend, and half of
 * that product is the market page.
 *
 * So this seeds a fixture *from the address*: the same address always resolves to the same coin, a
 * different one to a different coin, and the row carries the seed's own name, ticker and artwork in
 * its `metadata` — the columns a launched coin fills in — so the page gets a complete identity
 * without `PREVIEW_METADATA` being asked about an address it does not own. That table stays keyed
 * to `0xdead…` addresses, which is what makes it unhittable in production; see the note at the top
 * of this file.
 */
export function dummyMarketFor(address: string, now: number): MarketModel {
  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = (seed * 31 + address.charCodeAt(i)) >>> 0;
  const i = seed % SEEDS.length;
  const base = dummyMarkets(now)[i];
  const s = SEEDS[i];
  return {
    ...base,
    market: {
      ...base.market,
      marketAddress: address,
      /* `identityFor` takes the name from the chain's `name` column when it differs from the
         symbol, and the fixture writes the symbol into both — which is what a generation-1 market
         looks like. Here the seed's real name goes in, because this row is standing in for a coin
         that was launched with metadata. */
      name: s.name,
      metadata: {
        ticker: s.ticker,
        logoUri: s.logo ?? null,
        bannerUri: s.banner ?? null,
        description: null,
        website: s.links?.website ?? null,
        x: s.links?.x ?? null,
        telegram: s.links?.telegram ?? null,
      },
    },
  };
}

/**
 * A deterministic trade feed for a preview market.
 *
 * Seeded from the address like everything else here, so a market's feed is *its* feed and two
 * server renders two seconds apart do not shuffle the rows under the reader. The figures are
 * internally consistent — the quote volume is the base volume times the price of that row, the fee
 * is one percent of it — because a feed whose own columns do not multiply out is a fixture that
 * teaches you to distrust the component rather than the data.
 */
export function dummySwaps(market: MarketModel, now: number, count = 25): SwapModel[] {
  const address = market.market.marketAddress;
  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = (seed * 31 + address.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const graduated = market.state.poolAddress !== null;
  const basePrice = Number(market.state.marketCap) / 1e18 / 1_000_000_000;

  return Array.from({ length: count }, (_, i) => {
    const isSell = rand() > 0.62;
    const price = basePrice * (1 + (rand() - 0.5) * 0.08);
    const base = 40_000 + rand() * 900_000;
    const quote = base * price;
    const toUnits = (n: number) => BigInt(Math.max(1, Math.round(n * 1e6))) * 1_000_000_000_000n;

    return {
      id: `${address}-${i}`,
      market: { marketAddress: address },
      swap: {
        trader: `0x${(seed >>> 0).toString(16).padStart(8, "0").repeat(5)}`,
        isSell,
        venue: graduated ? ("pool" as const) : ("curve" as const),
        quoteVolume: toUnits(quote),
        baseVolume: toUnits(base),
        price: toUnits(price),
        // Generation 1: identical to `price`. Written out rather than aliased so a fixture edited
        // to generation 2 has to change both, which is the point of carrying the pair.
        priceQuote: toUnits(price),
        fee: toUnits(quote / 100),
        // The anti-sniper tax only ever applies to a buy inside the launch window, so most rows
        // carry none — a feed where every row has one would misrepresent what the column is.
        tax: !isSell && i > count - 4 ? toUnits(quote / 25) : 0n,
        quoteRaised: market.state.quoteRaised,
      },
      // Newest first, which is the order the indexer returns and the order the feed renders.
      block: {
        number: BigInt(1_000_000 - i),
        txHash: `0x${(i + 1).toString(16).padStart(64, "0")}`,
        time: new Date(now - i * (90_000 + Math.round(rand() * 600_000))),
      },
    };
  });
}

/**
 * A deterministic holder list.
 *
 * Balances follow a power law rather than being uniform, because that is what a holder table looks
 * like and a flat distribution would make the column of percentages read as a rendering bug.
 */
export function dummyHolders(market: MarketModel, count = 50): HolderModel[] {
  const address = market.market.marketAddress;
  let seed = 0;
  for (let i = 0; i < address.length; i++) seed = (seed * 17 + address.charCodeAt(i)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const balances = Array.from(
    { length: count },
    (_, i) => BigInt(Math.round((3_000_000 / (i + 1)) * (0.6 + rand() * 0.8))) * 1_000_000_000_000n
  );
  // The fixture's own total, so the shares add to 1 across the list it actually renders. The
  // endpoint divides by CIRCULATING supply, which is a figure no fixture has.
  const total = balances.reduce((a, b) => a + b, 0n);

  return balances.map((balance, i) => ({
    holder: `0x${(seed % 0xffffffff).toString(16).padStart(8, "0")}${String(i).padStart(32, "0")}`,
    balance,
    share: total > 0n ? Number((balance * 1_000_000n) / total) / 1_000_000 : 0,
    // The preview has no creator, sink or hook among its holders — every row is an ordinary one.
    label: null,
  }));
}

/* ---------------------------------------------------------------------------------------------
 * A fabricated account
 *
 * The portfolio page is the second design-heavy surface in the product, and it is the harder one
 * to evaluate empty: every figure on it — average entry, unrealised, realised, the allocation
 * split, best and worst — is *derived from a trade history*, so an address with no history renders
 * a page of dashes and proves nothing about the design.
 *
 * So the fixture is a whole account rather than a bag of balances, and the two halves agree: the
 * swaps below buy exactly the tokens the positions hold, at the prices the entry column claims.
 * A fixture whose holdings and whose trades do not reconcile would exercise the *error* path in
 * `usePortfolioPnl` — the one that refuses to answer — and hide the design being reviewed.
 * ------------------------------------------------------------------------------------------- */

/** Nominal MON per whole token, the same figure `dummySwaps` prices its rows from. */
const previewPrice = (i: number) => SEEDS[i].cap / 1_000_000_000;

const tokenAddressAt = (i: number) =>
  `0xbeefbeefbeefbeefbeefbeefbeefbeef${String(i).padStart(8, "0")}`;

type Holding = {
  /** Index into `SEEDS`. */
  i: number;
  /** Whole tokens still held. */
  balance: number;
  /**
   * Average entry as a fraction of the current price — 0.4 is a position that has 2.5×'d.
   *
   * `null` means the balance arrived without a trade behind it, which is the case the page has to
   * handle honestly: no entry price, no P&L, a dash in both columns. Roughly one holding in six
   * looks like this on a real address, so exactly one does here.
   */
  entry: number | null;
  /** Whole tokens sold off along the way, at `exit` times the current price. */
  sold?: number;
  exit?: number;
};

/*
 * Chosen for spread, not for flattery: two positions well up, one well down, one flat, one with
 * no basis at all, and a market exited entirely so the realised figure has something in it. The
 * values are also within an order of magnitude of one another, because an allocation bar where one
 * holding is 97% of the total shows nothing about how the chart handles a portfolio.
 */
const HOLDINGS: Holding[] = [
  { i: 0, balance: 510_000, entry: 0.41 },
  { i: 1, balance: 6_400_000, entry: 0.58, sold: 2_000_000, exit: 1.22 },
  { i: 2, balance: 7_570_000, entry: 0.97 },
  { i: 5, balance: 7_400_000, entry: 1.46 },
  { i: 3, balance: 18_480_000, entry: 0.74, sold: 6_000_000, exit: 0.63 },
  { i: 9, balance: 59_000_000, entry: null },
];

/** A market bought and sold out completely: no holding, all of its result in `realised`. */
const EXITED: Holding = { i: 8, balance: 0, entry: 0.55, sold: 200_000_000, exit: 1.9 };

/** What the fabricated account holds. Ordered by value, as the indexer returns it. */
export function dummyPortfolio(): PortfolioPosition[] {
  return HOLDINGS.map(({ i, balance }) => {
    const lastPrice = previewPrice(i);
    return {
      tokenAddress: tokenAddressAt(i),
      marketAddress: marketAddressAt(i),
      symbol: SEEDS[i].symbol,
      balance: mon(balance),
      lastPrice,
      valueMon: balance * lastPrice,
      // The fixture's markets are all MON-quoted, generation 1. Written out rather than defaulted
      // so a fixture edited to carry a six-decimal quote has to state the decimals too.
      quoteAsset: "0x0000000000000000000000000000000000000000",
      quoteSymbol: "MON",
      quoteDecimals: 18,
      graduated: Boolean(SEEDS[i].graduated),
    };
  }).sort((a, b) => (b.valueMon ?? 0) - (a.valueMon ?? 0));
}

/**
 * The trades behind those holdings.
 *
 * Every buy is split in two, because an average-cost basis built from a single fill is arithmetic
 * that cannot go wrong, and the point of a fixture is to exercise the path that can. The fee is
 * one percent of the quote on every row and the launch tax appears only on the oldest buy of the
 * youngest market, which is the only place the real contract charges it.
 */
type DummyAccountSwap = SwapModel & {
  symbol: string;
  quoteSymbol: string | null;
  quoteDecimals: number;
};

export function dummyAccountSwaps(now: number): DummyAccountSwap[] {
  const rows: DummyAccountSwap[] = [];
  const toUnits = (n: number) => BigInt(Math.max(1, Math.round(n * 1e6))) * 1_000_000_000_000n;

  let block = 1_200_000;
  let age = 0;

  const push = (h: Holding, kind: "buy" | "sell", base: number, price: number, taxed: boolean) => {
    const quote = base * price;
    const i = h.i;
    age += 1;
    block -= 37;
    rows.push({
      id: `${marketAddressAt(i)}-${kind}-${rows.length}`,
      market: { marketAddress: marketAddressAt(i) as SwapModel["market"]["marketAddress"] },
      symbol: SEEDS[i].symbol,
      quoteSymbol: "MON",
      quoteDecimals: 18,
      swap: {
        trader: PREVIEW_ACCOUNT as SwapModel["swap"]["trader"],
        isSell: kind === "sell",
        venue: SEEDS[i].graduated ? "pool" : "curve",
        quoteVolume: toUnits(quote),
        baseVolume: toUnits(base),
        price: toUnits(price),
        // Generation 1: identical to `price`. Written out rather than aliased so a fixture edited
        // to generation 2 has to change both, which is the point of carrying the pair.
        priceQuote: toUnits(price),
        fee: toUnits(quote / 100),
        tax: taxed ? toUnits(quote / 25) : 0n,
        quoteRaised: mon(50_000 * SEEDS[i].progress),
      },
      block: {
        number: BigInt(block),
        txHash: `0x${(rows.length + 1).toString(16).padStart(64, "0")}`,
        time: new Date(now - (62 - age * 1.7) * DAY),
      },
    });
  };

  for (const h of [...HOLDINGS, EXITED]) {
    if (h.entry === null) continue;
    const price = previewPrice(h.i);
    const acquired = h.balance + (h.sold ?? 0);
    // Two fills either side of the average, so the entry column is a real mean rather than a
    // number copied from one row.
    push(h, "buy", acquired * 0.62, price * h.entry * 0.9, h.i === 3);
    push(h, "buy", acquired * 0.38, price * h.entry * 1.16, false);
    if (h.sold) push(h, "sell", h.sold, price * (h.exit ?? 1), false);
  }

  // Newest first, which is the order the indexer returns.
  return rows.sort((a, b) => b.block.time.getTime() - a.block.time.getTime());
}

/** The fixture markets the preview account launched, newest first. */
export function dummyLaunches(now: number): MarketModel[] {
  return dummyMarkets(now)
    .filter((m) => m.market.creator === PREVIEW_ACCOUNT)
    .sort((a, b) => b.market.launchedAt.getTime() - a.market.launchedAt.getTime());
}

/* ---------------------------------------------------------------------------------------------
 * The launch bench
 *
 * Same guard, same rule. A draft rather than a market: nothing here is ever submitted, and the
 * factory could not store most of it anyway — see `lib/launch/submit.ts`.
 * ------------------------------------------------------------------------------------------- */

/**
 * A launch draft with every field answered.
 *
 * The bench draws its empty state until somebody types, so the filled design — the preview card
 * with artwork in it, the rail with eleven figures instead of eleven dashes, an enabled button —
 * could only be seen by filling five steps in by hand, including two image URLs, on every reload.
 *
 * The artwork is two files out of `public/`, and that is not laziness about finding a picture: a
 * `data:` URL is what `ImageField` holds *while the upload is in flight*, so `draftProblems`
 * reports it as "the logo has not been uploaded yet" and the button stays disabled. A fixture built
 * from the fixture's own SVG helpers therefore renders the one state this page exists to avoid —
 * the filled bench still telling you two things are missing. These are same-origin paths, so they
 * need no network, and they are what a finished upload looks like: a URL the card can just load.
 *
 * A ticker of `PREVIEW` rather than something plausible: a screenshot of this page must not be
 * mistakable for a coin somebody is about to ship.
 */
export function dummyLaunchDraft() {
  return {
    identity: {
      name: "Preview Coin",
      ticker: "PREVIEW",
      /* The same file twice, cropped square by the mark and wide by the banner. `social-preview.png`
         is the other candidate in `public/` and it carries DOKU's own marketing copy — a preview
         card with the product's tagline printed across it reads as a mistake in a screenshot.

         WebP at the banner's own 1536×512, not the 1,045 kB PNG this used to point at. That file
         was the only asset over 100 kB in `public/`, it shipped to production on every deploy, and
         its only two references were these two lines. */
      logo: "/images/planet-home.webp",
      banner: "/images/planet-home.webp",
      description:
        "A fabricated draft for looking at the launch bench with every field answered. Nothing here has been deployed and nothing here can be.",
    },
    links: {
      website: "https://example.com",
      x: "https://x.com/example",
      telegram: "https://t.me/example",
    },
    /* The one field that is a real id rather than invented text: `mon` is in the chain's own quote
       registry, so the bench resolves it to a live asset and the rail prints a real symbol,
       decimals and graduation target beside the fabricated ones. */
    quoteId: "mon",
    feeRouting: "holders" as const,
    creatorFee: 2,
    creatorFeeRecipient: PREVIEW_ACCOUNT,
    devBuy: "0.5",
  };
}

/**
 * The quote registry, when the indexer cannot answer.
 *
 * `/launch`, `/assets` and the board's pair chips all read `GET /quotes`, and there is no useful
 * fallback for it in the product — an empty registry means "there is nothing to pair against",
 * which is a statement about DOKU rather than about an outage, so the route returns 502 and the
 * launch bench sits on "Reading the quote registry" forever. That is correct in production and it
 * makes the launch page impossible to design against with the indexer down.
 *
 * Two assets, both `live`, because the bench needs one to preselect and a second for the picker to
 * be a picker. The shape is `QuoteAssetWire` — the same rows `/quotes` sends — so the client parses
 * the fixture through exactly the path it parses the real thing through, decimals and all.
 *
 * MON's `address` is the ERC-20 sentinel rather than `null`: `null` means "not on the launchpad
 * yet" and the zero address is what a v4 `PoolKey` actually carries. The fixture that got this
 * wrong is the reason the field exists — see the note at the top of `lib/assets/quote-assets.ts`.
 */
const ADDRESSES: Record<string, `0x${string}`> = {
  usdt: "0xe7cd86e13ac4309349f30b3435a9d337750fc82d",
  weth: "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242",
  wbtc: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
  cbbtc: "0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b",
  xaut0: "0x01bff41798a0bcf287b996046ca68b395dbc1071",
};

export function dummyQuoteAssets(): QuoteAssetWire[] {
  return [
    {
      id: "mon",
      symbol: "MON",
      name: "Monad",
      kind: "native",
      status: "live",
      decimals: 18,
      address: NATIVE_QUOTE_ADDRESS,
      blurb: "The chain's own asset, and the default pair on DOKU",
      underlying: null,
      iconDomain: null,
      /* 1,000 MON at 18 decimals, and 10,000 USDC at 6. Written out rather than computed so the
         two are visibly different scales: a launch bench that prints the same graduation target
         for both is a bench that has lost the decimals somewhere. */
      quoteTarget: "1000000000000000000000",
      usdPrice: 2.5,
      usdPriceAt: null,
      marketCount: 16,
    },
    {
      id: "usdc",
      symbol: "USDC",
      name: "USD Coin",
      kind: "stablecoin",
      status: "live",
      decimals: 6,
      /* Real, for the reason given on `ADDRESSES` — USDC is the one non-MON pair that is live,
         so it is the row a reviewer would use to check MON funding at all. */
      address: "0x754704bc059f8c67012fed69bc8a327a5aafb603",
      blurb: "Dollar-denominated launches, so a coin's price is a price and not a MON ratio",
      underlying: null,
      iconDomain: null,
      quoteTarget: "10000000000",
      usdPrice: 1,
      usdPriceAt: null,
      marketCount: 1,
    },
    /* Mirrors `indexer/src/quotes/catalog.ts`, and must keep mirroring it — these are the same
       addresses `lib/chain/zap-routes` keys its pool graph on. */
    // usdt: 0xe7cd86e13ac4309349f30b3435a9d337750fc82d
    // weth: 0xee8c0e9f1bffb4eb878d8f15f368a02a35481242
    // wbtc: 0x0555e30da8f98308edb960aa94c0db47230d2b9c
    // cbbtc: 0xd18b7ec58cdf4876f6afebd3ed1730e4ce10414b
    // xaut0: 0x01bff41798a0bcf287b996046ca68b395dbc1071
    /*
     * The rest of the catalogue, so the pair picker can actually be REVIEWED here.
     *
     * The fixture used to stop after MON and USDC, which meant `/launch-preview` — the route that
     * exists so the bench can be looked at without a chain — drew a two-key picker, while the real
     * one draws thirteen across five categories. Every scaling and grouping problem the picker has
     * was invisible on the one route built to see it. Same failure the chart had on
     * `/market-preview`, and the same fix: make the fixture the shape of the thing.
     *
     * Mirrors `indexer/src/quotes/catalog.ts`. `status` follows the same rule the service derives
     * it by (`registered && enabled`): the two with markets are `live`, the rest of the deployed
     * ones are `listed`, and an asset with no address cannot be either, so it is `soon`.
     */
    ...(
      [
        ["usdt", "USDT0", "Tether USD", "stablecoin", "listed", 6, "tether.to"],
        ["weth", "WETH", "Wrapped Ether", "crypto", "listed", 18, "ethereum.org"],
        ["wbtc", "WBTC", "Wrapped Bitcoin", "crypto", "listed", 8, "bitcoin.org"],
        ["cbbtc", "cbBTC", "Coinbase Wrapped BTC", "crypto", "listed", 8, "coinbase.com"],
        ["xaut0", "XAUt0", "Tether Gold", "rwa", "listed", 6, "tether.to"],
        ["nvdax", "NVDAx", "NVIDIA Corporation", "stock", "soon", 18, "nvidia.com"],
        ["aaplx", "AAPLx", "Apple Inc.", "stock", "soon", 18, "apple.com"],
        ["tslax", "TSLAx", "Tesla, Inc.", "stock", "soon", 18, "tesla.com"],
        ["googlx", "GOOGLx", "Alphabet Inc.", "stock", "soon", 18, "google.com"],
        ["pfex", "PFEx", "Pfizer Inc.", "stock", "soon", 18, "pfizer.com"],
        ["tbillx", "TBILLx", "US Treasury Bills", "rwa", "soon", 18, "treasury.gov"],
      ] as const
    ).map(([id, symbol, name, kind, status, decimals, iconDomain]) => ({
      id,
      symbol,
      name,
      kind,
      status,
      decimals,
      /*
        The REAL address, and it is load-bearing — a sentinel here silently disables a feature.

        `null` is the honest value for an asset that is not on the chain yet, and it is what the
        picker reads to know it cannot be launched against. But for a deployed one the address is
        not decoration: `launchPayWithOptions` asks `candidateRoutes(address)` whether MON can be
        swapped into this asset, and that answers from the measured edge table in
        `lib/chain/zap-routes`, keyed by address. A made-up address matches no edge, so the helper
        returns a single option and the "fund the buy with MON" control silently never renders.

        Which is exactly what a fixture must not do: the preview is where this bench is reviewed,
        and it was hiding a whole funding path.
      */
      address: ADDRESSES[id] ?? null,
      blurb: `${name}. Fixture row, not a real listing.`,
      underlying: null,
      iconDomain,
      quoteTarget: null,
      usdPrice: null,
      usdPriceAt: null,
      marketCount: 0,
    })),
  ];
}
