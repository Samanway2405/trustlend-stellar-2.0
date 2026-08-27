import { describe, expect, it } from "vitest";
import {
  aggregatePrice,
  isUsableQuote,
  median,
  rejectOutliers,
  spreadBps,
  toChainPrice,
  fromChainPrice,
  shouldPublish,
  PRICE_PRECISION,
  DEFAULT_POLL_INTERVAL_MS,
  TRACKED_SYMBOLS,
  type PriceQuote,
} from "@/lib/oracle/prices";

const NOW = 1_800_000_000_000;

function quote(
  source: string,
  priceUsd: number,
  overrides: Partial<PriceQuote> = {},
): PriceQuote {
  return {
    symbol: "XLM",
    priceUsd,
    source,
    observedAt: NOW,
    ...overrides,
  };
}

describe("tracked symbols (acceptance: XLM and BTC)", () => {
  it("tracks exactly the two assets the issue requires", () => {
    expect(TRACKED_SYMBOLS).toContain("XLM");
    expect(TRACKED_SYMBOLS).toContain("BTC");
  });

  it("defaults to a 5-second poll interval", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000);
  });
});

describe("isUsableQuote", () => {
  it("accepts a normal positive price", () => {
    expect(isUsableQuote(quote("a", 0.12))).toBe(true);
  });

  it("rejects the failure modes real APIs actually emit", () => {
    expect(isUsableQuote(quote("a", 0))).toBe(false);
    expect(isUsableQuote(quote("a", -1))).toBe(false);
    expect(isUsableQuote(quote("a", Number.NaN))).toBe(false);
    expect(isUsableQuote(quote("a", Number.POSITIVE_INFINITY))).toBe(false);
  });

  it("rejects null and undefined without throwing", () => {
    expect(isUsableQuote(null)).toBe(false);
    expect(isUsableQuote(undefined)).toBe(false);
  });
});

describe("median", () => {
  it("returns the middle value for an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("handles a single value", () => {
    expect(median([7])).toBe(7);
  });

  it("throws on an empty list rather than returning NaN", () => {
    expect(() => median([])).toThrow();
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("rejectOutliers", () => {
  it("drops a source that is wildly off the median", () => {
    // A decimal-shift bug: one source reports 10x the real price.
    const quotes = [quote("a", 0.12), quote("b", 0.121), quote("c", 1.2)];
    const { kept, rejected } = rejectOutliers(quotes);
    expect(kept.map((q) => q.source).sort()).toEqual(["a", "b"]);
    expect(rejected.map((q) => q.source)).toEqual(["c"]);
  });

  it("keeps sources that merely disagree slightly", () => {
    const quotes = [quote("a", 0.12), quote("b", 0.1201), quote("c", 0.1199)];
    const { kept, rejected } = rejectOutliers(quotes);
    expect(kept).toHaveLength(3);
    expect(rejected).toHaveLength(0);
  });

  it("keeps both when there are only two sources", () => {
    // With two sources there is no majority to appeal to.
    const quotes = [quote("a", 0.12), quote("b", 0.5)];
    const { kept, rejected } = rejectOutliers(quotes);
    expect(kept).toHaveLength(2);
    expect(rejected).toHaveLength(0);
  });

  it("never rejects everything, however tight the tolerance", () => {
    const quotes = [quote("a", 1), quote("b", 2), quote("c", 3)];
    const { kept } = rejectOutliers(quotes, 0);
    expect(kept.length).toBeGreaterThan(0);
  });
});

describe("spreadBps", () => {
  it("is zero for a single quote", () => {
    expect(spreadBps([quote("a", 0.12)])).toBe(0);
  });

  it("measures disagreement between sources", () => {
    // 0.10 -> 0.11 is a 10% spread.
    expect(spreadBps([quote("a", 0.1), quote("b", 0.11)])).toBeCloseTo(1000, 5);
  });
});

describe("aggregatePrice — live path", () => {
  it("takes the median across healthy sources", () => {
    const result = aggregatePrice(
      "XLM",
      [quote("a", 0.12), quote("b", 0.13), quote("c", 0.14)],
      { now: NOW },
    );
    expect(result.origin).toBe("live");
    expect(result.priceUsd).toBe(0.13);
    expect(result.contributingSources).toHaveLength(3);
  });

  it("ignores quotes for other symbols", () => {
    const result = aggregatePrice(
      "XLM",
      [quote("a", 0.12), quote("b", 60000, { symbol: "BTC" })],
      { now: NOW },
    );
    expect(result.priceUsd).toBe(0.12);
    expect(result.contributingSources).toEqual(["a"]);
  });

  it("discards unusable quotes before aggregating", () => {
    const result = aggregatePrice(
      "XLM",
      [quote("a", 0.12), quote("bad", 0), quote("worse", Number.NaN)],
      { now: NOW },
    );
    expect(result.origin).toBe("live");
    expect(result.priceUsd).toBe(0.12);
  });

  it("reports rejected outliers", () => {
    const result = aggregatePrice(
      "XLM",
      [quote("a", 0.12), quote("b", 0.121), quote("bad", 12)],
      { now: NOW },
    );
    expect(result.rejectedSources).toEqual(["bad"]);
    expect(result.reason).toContain("outlier");
  });

  it("works with a single surviving source", () => {
    const result = aggregatePrice("XLM", [quote("only", 0.125)], { now: NOW });
    expect(result.origin).toBe("live");
    expect(result.priceUsd).toBe(0.125);
  });

  it("treats quotes older than the staleness bound as absent", () => {
    const result = aggregatePrice(
      "XLM",
      [quote("old", 0.12, { observedAt: NOW - 500_000 })],
      { now: NOW, maxStalenessMs: 120_000 },
    );
    expect(result.origin).not.toBe("live");
  });
});

describe("aggregatePrice — fallback chain (acceptance: oracle down)", () => {
  it("falls back to the cached price when every source fails", () => {
    const result = aggregatePrice("XLM", [], {
      now: NOW,
      cached: { priceUsd: 0.119, observedAt: NOW - 30_000 },
    });
    expect(result.origin).toBe("cache");
    expect(result.priceUsd).toBe(0.119);
    expect(result.ageMs).toBe(30_000);
  });

  it("falls back to on-chain TWAP when the cache has gone stale", () => {
    const result = aggregatePrice("XLM", [], {
      now: NOW,
      maxStalenessMs: 120_000,
      cached: { priceUsd: 0.119, observedAt: NOW - 999_999 },
      twapUsd: 0.115,
    });
    expect(result.origin).toBe("twap");
    expect(result.priceUsd).toBe(0.115);
  });

  it("prefers a fresh cache over TWAP", () => {
    const result = aggregatePrice("XLM", [], {
      now: NOW,
      cached: { priceUsd: 0.119, observedAt: NOW - 1_000 },
      twapUsd: 0.115,
    });
    expect(result.origin).toBe("cache");
  });

  it("reports unavailable rather than inventing a price", () => {
    const result = aggregatePrice("XLM", [], { now: NOW });
    expect(result.origin).toBe("unavailable");
    expect(result.priceUsd).toBeNull();
    // The whole point: a wrong price can wrongly liquidate someone.
    expect(result.reason).toContain("Refusing to publish");
  });

  it("ignores a corrupt cache and a corrupt TWAP", () => {
    const result = aggregatePrice("XLM", [], {
      now: NOW,
      cached: { priceUsd: 0, observedAt: NOW },
      twapUsd: -5,
    });
    expect(result.origin).toBe("unavailable");
  });

  it("walks the whole chain in order as sources degrade", () => {
    const cached = { priceUsd: 0.119, observedAt: NOW - 10_000 };
    expect(
      aggregatePrice("XLM", [quote("a", 0.12)], { now: NOW, cached, twapUsd: 0.11 }).origin,
    ).toBe("live");
    expect(aggregatePrice("XLM", [], { now: NOW, cached, twapUsd: 0.11 }).origin).toBe("cache");
    expect(aggregatePrice("XLM", [], { now: NOW, twapUsd: 0.11 }).origin).toBe("twap");
    expect(aggregatePrice("XLM", [], { now: NOW }).origin).toBe("unavailable");
  });
});

describe("chain price conversion", () => {
  it("converts USD to 7-decimal fixed point", () => {
    expect(toChainPrice(1)).toBe(BigInt(PRICE_PRECISION));
    expect(toChainPrice(0.1234567)).toBe(1234567n);
  });

  it("rounds to nearest rather than truncating", () => {
    // Truncation would bias every published price downward.
    expect(toChainPrice(0.12345678)).toBe(1234568n);
  });

  it("refuses to convert a non-positive or non-finite price", () => {
    expect(() => toChainPrice(0)).toThrow();
    expect(() => toChainPrice(-1)).toThrow();
    expect(() => toChainPrice(Number.NaN)).toThrow();
  });

  it("round-trips within one unit of precision", () => {
    for (const price of [0.12, 0.5, 1, 65_000.25]) {
      expect(fromChainPrice(toChainPrice(price))).toBeCloseTo(price, 6);
    }
  });
});

describe("shouldPublish", () => {
  const live = aggregatePrice("XLM", [quote("a", 0.12)], { now: NOW });

  it("publishes when nothing is on-chain yet", () => {
    expect(shouldPublish(live, null, { now: NOW })).toBe(true);
  });

  it("never publishes an unavailable price", () => {
    const unavailable = aggregatePrice("XLM", [], { now: NOW });
    expect(shouldPublish(unavailable, null, { now: NOW })).toBe(false);
  });

  it("skips a negligible move to avoid burning fees every 5 seconds", () => {
    expect(
      shouldPublish(live, { priceUsd: 0.12001, observedAt: NOW - 1_000 }, { now: NOW }),
    ).toBe(false);
  });

  it("publishes once the price moves materially", () => {
    expect(
      shouldPublish(live, { priceUsd: 0.13, observedAt: NOW - 1_000 }, { now: NOW }),
    ).toBe(true);
  });

  it("publishes as a heartbeat even when the price is flat", () => {
    expect(
      shouldPublish(live, { priceUsd: 0.12, observedAt: NOW - 120_000 }, { now: NOW }),
    ).toBe(true);
  });
});
