/**
 * Live price lookup for consumers that previously used hardcoded constants
 * (Issue #267).
 *
 * The liquidation keeper valued every position with
 * `LIQUIDATION_XLM_PRICE_USD ?? 0.12` — a number that only changed when
 * someone edited an environment variable. That is exactly what this issue
 * exists to replace: a liquidation decision made against a stale constant can
 * seize collateral the market says is perfectly healthy.
 *
 * This module fetches a live aggregated price with the full fallback chain and
 * caches it briefly, so a caller polling once a minute does not hammer the
 * upstream APIs.
 */

import {
  aggregatePrice,
  TRACKED_SYMBOLS,
  type AggregatedPrice,
  type CachedPrice,
  type PriceSymbol,
} from "./prices";
import { collectQuotes, createDefaultSources, type PriceSource } from "./sources";

/** How long a fetched price is reused before going back to the sources. */
export const LIVE_PRICE_TTL_MS = 5_000;

interface CacheEntry {
  price: AggregatedPrice;
  fetchedAt: number;
}

/** Module-level cache; process-local and intentionally simple. */
const cache = new Map<PriceSymbol, CacheEntry>();
/** Last known good price per symbol, feeding the fallback chain. */
const lastGood = new Map<PriceSymbol, CachedPrice>();

/** Clear all cached state. Exposed for tests. */
export function resetLivePriceCache(): void {
  cache.clear();
  lastGood.clear();
}

export interface LivePriceOptions {
  sources?: PriceSource[];
  now?: number;
  ttlMs?: number;
  /** On-chain TWAP per symbol, used when everything else is exhausted. */
  twapUsd?: Partial<Record<PriceSymbol, number>>;
}

/**
 * Fetch live prices for the tracked symbols, applying the fallback chain.
 *
 * Never throws: a caller in a liquidation loop must be able to distinguish
 * "price unavailable" from a crash, and decide for itself whether to proceed.
 */
export async function getLivePrices(
  symbols: PriceSymbol[] = TRACKED_SYMBOLS,
  options: LivePriceOptions = {},
): Promise<Map<PriceSymbol, AggregatedPrice>> {
  const {
    sources = createDefaultSources(),
    now = Date.now(),
    ttlMs = LIVE_PRICE_TTL_MS,
    twapUsd = {},
  } = options;

  const results = new Map<PriceSymbol, AggregatedPrice>();

  // Serve whatever is still within TTL without touching the network.
  const needed = symbols.filter((symbol) => {
    const entry = cache.get(symbol);
    if (entry && now - entry.fetchedAt < ttlMs) {
      results.set(symbol, entry.price);
      return false;
    }
    return true;
  });

  if (needed.length === 0) return results;

  let quotes: Awaited<ReturnType<typeof collectQuotes>>["quotes"] = [];
  try {
    ({ quotes } = await collectQuotes(sources, needed));
  } catch (err) {
    // collectQuotes already isolates per-source failures; this only fires on
    // something pathological. Fall through to the cache/TWAP path.
    console.error(
      "[oracle] Price collection failed entirely:",
      err instanceof Error ? err.message : err,
    );
  }

  for (const symbol of needed) {
    const price = aggregatePrice(symbol, quotes, {
      now,
      cached: lastGood.get(symbol) ?? null,
      twapUsd: twapUsd[symbol] ?? null,
    });

    // Only a live reading refreshes the last-known-good value, so a cached
    // price can never renew its own freshness indefinitely.
    if (price.origin === "live" && price.priceUsd !== null) {
      lastGood.set(symbol, { priceUsd: price.priceUsd, observedAt: now });
    }

    cache.set(symbol, { price, fetchedAt: now });
    results.set(symbol, price);
  }

  return results;
}

/**
 * Convenience wrapper returning a single USD price, or null when unavailable.
 *
 * Returning null rather than a default is deliberate — the caller must decide
 * whether it is safe to continue without a price, and for liquidation the
 * answer is no.
 */
export async function getLivePriceUsd(
  symbol: PriceSymbol,
  options: LivePriceOptions = {},
): Promise<number | null> {
  const prices = await getLivePrices([symbol], options);
  return prices.get(symbol)?.priceUsd ?? null;
}
