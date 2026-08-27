/**
 * Collateral price feed core (Issue #267).
 *
 * Pure, dependency-free logic for aggregating prices from several sources and
 * deciding what is safe to publish on-chain. Kept separate from the HTTP
 * adapters and the keeper loop so all of the decision-making is unit-testable
 * without a network.
 *
 * The safety principle throughout: **a wrong price is worse than no price.**
 * Collateral valuations drive liquidation, so this module would rather refuse
 * to publish than push a stale or implausible number that could wrongly
 * liquidate a borrower.
 */

/** Assets we track. XLM and BTC are the two the issue requires. */
export type PriceSymbol = "XLM" | "BTC";

export const TRACKED_SYMBOLS: PriceSymbol[] = ["XLM", "BTC"];

/** On-chain price precision: 7 decimals, matching PRICE_PRECISION in lending. */
export const PRICE_PRECISION = 10_000_000;

/** Default poll interval — the 5 seconds the issue asks for. */
export const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * How old a price may be before it is unusable. Beyond this the keeper halts
 * rather than publishing: during a long outage a stale price is actively
 * dangerous, because the market may have moved through a borrower's
 * liquidation threshold while the feed was frozen.
 */
export const DEFAULT_MAX_STALENESS_MS = 120_000;

/**
 * Reject any single source whose price deviates from the median of its peers
 * by more than this. Guards against one API returning a decimal-shifted or
 * zeroed value and dragging the aggregate with it.
 */
export const DEFAULT_OUTLIER_TOLERANCE_BPS = 1_000; // 10%

/** A price reported by one source at one moment. */
export interface PriceQuote {
  symbol: PriceSymbol;
  /** Price in USD as a floating point number, as returned by the source. */
  priceUsd: number;
  /** Which adapter produced this quote, for logging and alerting. */
  source: string;
  /** Epoch milliseconds at which the quote was observed. */
  observedAt: number;
}

/** Where an aggregated price ultimately came from. */
export type PriceOrigin =
  | "live" // fresh median across sources
  | "cache" // last known good price, still within staleness bounds
  | "twap" // on-chain TWAP fallback
  | "unavailable"; // nothing usable — do not publish

export interface AggregatedPrice {
  symbol: PriceSymbol;
  /** USD price, or null when origin is "unavailable". */
  priceUsd: number | null;
  origin: PriceOrigin;
  /** Sources that contributed to a "live" price. */
  contributingSources: string[];
  /** Sources that were discarded as outliers. */
  rejectedSources: string[];
  /** Age of the price in milliseconds at the time of aggregation. */
  ageMs: number;
  /** Human-readable explanation, surfaced in logs and alerts. */
  reason: string;
}

/** A previously published price, used as the cache fallback. */
export interface CachedPrice {
  priceUsd: number;
  observedAt: number;
}

export interface AggregateOptions {
  /** Current time; injected so tests are deterministic. */
  now: number;
  maxStalenessMs?: number;
  outlierToleranceBps?: number;
  /** Last known good price for this symbol, if any. */
  cached?: CachedPrice | null;
  /** On-chain TWAP, used when there is no usable cache. */
  twapUsd?: number | null;
}

// ─── Validation ─────────────────────────────────────────────────────────────

/**
 * Whether a raw quote is structurally usable.
 *
 * Rejects zero, negative, NaN and Infinity outright — every one of those has
 * been seen from a real price API during an incident, and each would produce a
 * nonsensical collateral valuation.
 */
export function isUsableQuote(quote: PriceQuote | null | undefined): quote is PriceQuote {
  if (!quote) return false;
  const { priceUsd } = quote;
  if (typeof priceUsd !== "number") return false;
  if (!Number.isFinite(priceUsd)) return false;
  if (priceUsd <= 0) return false;
  return true;
}

/** Median of a non-empty list of numbers. */
export function median(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot take the median of an empty list");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Drop quotes that deviate too far from the group median.
 *
 * With only two sources there is no majority to appeal to, so we keep both
 * and let the median (their average) stand — flagging a disagreement is the
 * caller's job via `spreadBps`.
 */
export function rejectOutliers(
  quotes: PriceQuote[],
  toleranceBps: number = DEFAULT_OUTLIER_TOLERANCE_BPS,
): { kept: PriceQuote[]; rejected: PriceQuote[] } {
  if (quotes.length <= 2) return { kept: [...quotes], rejected: [] };

  const groupMedian = median(quotes.map((q) => q.priceUsd));
  const kept: PriceQuote[] = [];
  const rejected: PriceQuote[] = [];

  for (const quote of quotes) {
    const deviationBps =
      Math.abs(quote.priceUsd - groupMedian) / groupMedian * 10_000;
    if (deviationBps > toleranceBps) {
      rejected.push(quote);
    } else {
      kept.push(quote);
    }
  }

  // If tolerance was so tight that everything was rejected, keep the original
  // set rather than returning nothing — the median is still the best estimate.
  return kept.length > 0 ? { kept, rejected } : { kept: [...quotes], rejected: [] };
}

/** Spread between the cheapest and dearest quote, in basis points. */
export function spreadBps(quotes: PriceQuote[]): number {
  if (quotes.length < 2) return 0;
  const prices = quotes.map((q) => q.priceUsd);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (min <= 0) return 0;
  return ((max - min) / min) * 10_000;
}

// ─── Aggregation ────────────────────────────────────────────────────────────

/**
 * Turn a set of raw quotes into the single price to publish, applying the
 * full fallback chain: live median → cache → TWAP → unavailable.
 */
export function aggregatePrice(
  symbol: PriceSymbol,
  quotes: PriceQuote[],
  options: AggregateOptions,
): AggregatedPrice {
  const {
    now,
    maxStalenessMs = DEFAULT_MAX_STALENESS_MS,
    outlierToleranceBps = DEFAULT_OUTLIER_TOLERANCE_BPS,
    cached = null,
    twapUsd = null,
  } = options;

  const usable = quotes.filter(
    (q) => isUsableQuote(q) && q.symbol === symbol && now - q.observedAt <= maxStalenessMs,
  );

  // ── 1. Live median across the sources that responded ──
  if (usable.length > 0) {
    const { kept, rejected } = rejectOutliers(usable, outlierToleranceBps);
    const priceUsd = median(kept.map((q) => q.priceUsd));
    const oldest = Math.min(...kept.map((q) => q.observedAt));

    return {
      symbol,
      priceUsd,
      origin: "live",
      contributingSources: kept.map((q) => q.source),
      rejectedSources: rejected.map((q) => q.source),
      ageMs: now - oldest,
      reason:
        rejected.length > 0
          ? `Median of ${kept.length} source(s); rejected ${rejected.length} outlier(s).`
          : `Median of ${kept.length} source(s).`,
    };
  }

  // ── 2. Last known good price, if it has not gone stale ──
  if (cached && isFinitePositive(cached.priceUsd)) {
    const ageMs = now - cached.observedAt;
    if (ageMs <= maxStalenessMs) {
      return {
        symbol,
        priceUsd: cached.priceUsd,
        origin: "cache",
        contributingSources: [],
        rejectedSources: [],
        ageMs,
        reason: `All sources unavailable; using cached price from ${Math.round(ageMs / 1000)}s ago.`,
      };
    }
  }

  // ── 3. On-chain TWAP ──
  if (isFinitePositive(twapUsd)) {
    return {
      symbol,
      priceUsd: twapUsd as number,
      origin: "twap",
      contributingSources: [],
      rejectedSources: [],
      ageMs: 0,
      reason: "All sources unavailable and cache is stale; falling back to on-chain TWAP.",
    };
  }

  // ── 4. Nothing usable — publishing would be dangerous ──
  return {
    symbol,
    priceUsd: null,
    origin: "unavailable",
    contributingSources: [],
    rejectedSources: [],
    ageMs: cached ? now - cached.observedAt : Number.POSITIVE_INFINITY,
    reason:
      "No live source, no fresh cache and no TWAP. Refusing to publish a price rather than risk a wrongful liquidation.",
  };
}

function isFinitePositive(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// ─── On-chain conversion ────────────────────────────────────────────────────

/**
 * Convert a USD price into the fixed-point integer the contract stores.
 *
 * The contract works in i128 with 7 decimals, so 0.1234567 USD becomes
 * 1234567. Rounds to nearest rather than truncating, so repeated conversion
 * does not bias prices downward.
 */
export function toChainPrice(priceUsd: number): bigint {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`Cannot convert non-positive price to chain units: ${priceUsd}`);
  }
  return BigInt(Math.round(priceUsd * PRICE_PRECISION));
}

/** Inverse of {@link toChainPrice}, for reading TWAP values back. */
export function fromChainPrice(chainPrice: bigint | number): number {
  return Number(chainPrice) / PRICE_PRECISION;
}

/**
 * Whether a newly aggregated price is worth writing on-chain.
 *
 * Publishing every 5 seconds regardless of movement would burn fees for no
 * benefit, so we only write when the price moved enough to matter or the
 * on-chain value has aged out.
 */
export function shouldPublish(
  next: AggregatedPrice,
  lastPublished: CachedPrice | null,
  options: { now: number; minChangeBps?: number; maxPublishIntervalMs?: number },
): boolean {
  const {
    now,
    minChangeBps = 25, // 0.25%
    maxPublishIntervalMs = 60_000,
  } = options;

  if (next.priceUsd === null) return false; // never publish "unavailable"
  if (!lastPublished) return true; // nothing on-chain yet

  const ageMs = now - lastPublished.observedAt;
  if (ageMs >= maxPublishIntervalMs) return true; // heartbeat refresh

  const changeBps =
    Math.abs(next.priceUsd - lastPublished.priceUsd) / lastPublished.priceUsd * 10_000;
  return changeBps >= minChangeBps;
}
