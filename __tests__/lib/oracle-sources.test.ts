import { describe, expect, it, vi } from "vitest";
import {
  createCoinGeckoSource,
  createBinanceSource,
  createStellarDexSource,
  collectQuotes,
  fetchJsonSafe,
  type FetchLike,
  type PriceSource,
} from "@/lib/oracle/sources";
import type { PriceQuote } from "@/lib/oracle/prices";

/** Build a fake fetch returning a fixed JSON payload. */
function jsonFetch(payload: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => payload });
}

/** A fetch that never resolves, to exercise the timeout path. */
const hangingFetch: FetchLike = () => new Promise(() => {});

describe("fetchJsonSafe", () => {
  it("returns the parsed body on success", async () => {
    expect(await fetchJsonSafe("http://x", { fetchImpl: jsonFetch({ a: 1 }) })).toEqual({
      a: 1,
    });
  });

  it("returns null on a non-OK status instead of throwing", async () => {
    expect(
      await fetchJsonSafe("http://x", { fetchImpl: jsonFetch({}, false, 503) }),
    ).toBeNull();
  });

  it("returns null when the request throws", async () => {
    const boom: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await fetchJsonSafe("http://x", { fetchImpl: boom })).toBeNull();
  });

  it("returns null when the body is not valid JSON", async () => {
    const badJson: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    });
    expect(await fetchJsonSafe("http://x", { fetchImpl: badJson })).toBeNull();
  });

  it("gives up rather than hanging the poll loop", async () => {
    const started = Date.now();
    const result = await fetchJsonSafe("http://x", {
      fetchImpl: hangingFetch,
      timeoutMs: 50,
    });
    // A hung source must not block a 5-second cycle.
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("returns null when no fetch implementation exists", async () => {
    expect(
      await fetchJsonSafe("http://x", { fetchImpl: undefined as unknown as FetchLike }),
    ).toBeNull();
  });
});

describe("CoinGecko source", () => {
  const payload = { stellar: { usd: 0.1234 }, bitcoin: { usd: 65_000 } };

  it("maps symbols onto quotes", async () => {
    const source = createCoinGeckoSource({ fetchImpl: jsonFetch(payload) });
    const quotes = await source.fetchPrices(["XLM", "BTC"]);

    expect(quotes).toHaveLength(2);
    expect(quotes.find((q) => q.symbol === "XLM")?.priceUsd).toBe(0.1234);
    expect(quotes.find((q) => q.symbol === "BTC")?.priceUsd).toBe(65_000);
    expect(quotes.every((q) => q.source === "coingecko")).toBe(true);
  });

  it("returns [] when the API is down", async () => {
    const source = createCoinGeckoSource({ fetchImpl: jsonFetch(null, false, 500) });
    expect(await source.fetchPrices(["XLM"])).toEqual([]);
  });

  it("skips a symbol whose price is missing or unusable", async () => {
    const source = createCoinGeckoSource({
      fetchImpl: jsonFetch({ stellar: { usd: 0 }, bitcoin: {} }),
    });
    expect(await source.fetchPrices(["XLM", "BTC"])).toEqual([]);
  });

  it("sends the API key header when one is configured", async () => {
    const spy = vi.fn(jsonFetch(payload));
    const source = createCoinGeckoSource({ fetchImpl: spy, apiKey: "secret" });
    await source.fetchPrices(["XLM"]);

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("simple/price"),
      expect.objectContaining({
        headers: { "x-cg-demo-api-key": "secret" },
      }),
    );
  });
});

describe("Binance source", () => {
  const payload = [
    { symbol: "XLMUSDT", price: "0.1240" },
    { symbol: "BTCUSDT", price: "65100.50" },
  ];

  it("parses string prices into numbers", async () => {
    const source = createBinanceSource({ fetchImpl: jsonFetch(payload) });
    const quotes = await source.fetchPrices(["XLM", "BTC"]);

    expect(quotes.find((q) => q.symbol === "XLM")?.priceUsd).toBe(0.124);
    expect(quotes.find((q) => q.symbol === "BTC")?.priceUsd).toBe(65_100.5);
  });

  it("returns [] when the payload is not an array", async () => {
    const source = createBinanceSource({ fetchImpl: jsonFetch({ code: -1121 }) });
    expect(await source.fetchPrices(["XLM"])).toEqual([]);
  });

  it("ignores rows with an unusable price", async () => {
    const source = createBinanceSource({
      fetchImpl: jsonFetch([{ symbol: "XLMUSDT", price: "0" }]),
    });
    expect(await source.fetchPrices(["XLM"])).toEqual([]);
  });

  it("only returns the symbols that were asked for", async () => {
    const source = createBinanceSource({ fetchImpl: jsonFetch(payload) });
    const quotes = await source.fetchPrices(["XLM"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("XLM");
  });
});

describe("Stellar DEX source", () => {
  const book = {
    bids: [{ price: "0.1230" }],
    asks: [{ price: "0.1250" }],
  };

  it("quotes the orderbook mid-price for XLM", async () => {
    const source = createStellarDexSource({ fetchImpl: jsonFetch(book) });
    const quotes = await source.fetchPrices(["XLM"]);

    expect(quotes).toHaveLength(1);
    expect(quotes[0].priceUsd).toBeCloseTo(0.124, 6);
    expect(quotes[0].source).toBe("stellar-dex");
  });

  it("does not quote BTC, whose Stellar orderbook is too thin to trust", async () => {
    const source = createStellarDexSource({ fetchImpl: jsonFetch(book) });
    expect(await source.fetchPrices(["BTC"])).toEqual([]);
  });

  it("returns [] on an empty orderbook", async () => {
    const source = createStellarDexSource({
      fetchImpl: jsonFetch({ bids: [], asks: [] }),
    });
    expect(await source.fetchPrices(["XLM"])).toEqual([]);
  });

  it("returns [] when Horizon is unreachable", async () => {
    const source = createStellarDexSource({ fetchImpl: jsonFetch(null, false, 504) });
    expect(await source.fetchPrices(["XLM"])).toEqual([]);
  });
});

describe("collectQuotes (acceptance: fallback when a source is down)", () => {
  const good: PriceSource = {
    name: "good",
    fetchPrices: async () => [
      { symbol: "XLM", priceUsd: 0.12, source: "good", observedAt: Date.now() },
    ],
  };
  const empty: PriceSource = { name: "empty", fetchPrices: async () => [] };
  const throwing: PriceSource = {
    name: "throwing",
    fetchPrices: async () => {
      throw new Error("upstream exploded");
    },
  };

  it("merges quotes from every healthy source", async () => {
    const other: PriceSource = {
      name: "other",
      fetchPrices: async () => [
        { symbol: "XLM", priceUsd: 0.13, source: "other", observedAt: Date.now() },
      ],
    };
    const { quotes, failedSources } = await collectQuotes([good, other], ["XLM"]);
    expect(quotes).toHaveLength(2);
    expect(failedSources).toEqual([]);
  });

  it("keeps working when one source throws", async () => {
    // The whole point of multiple sources: one blowing up is survivable.
    const { quotes, failedSources } = await collectQuotes([good, throwing], ["XLM"]);
    expect(quotes).toHaveLength(1);
    expect(failedSources).toEqual(["throwing"]);
  });

  it("reports a source that returns nothing as failed", async () => {
    const { quotes, failedSources } = await collectQuotes([good, empty], ["XLM"]);
    expect(quotes).toHaveLength(1);
    expect(failedSources).toEqual(["empty"]);
  });

  it("reports every source as failed when they all die", async () => {
    const { quotes, failedSources } = await collectQuotes([empty, throwing], ["XLM"]);
    expect(quotes).toEqual([]);
    expect(failedSources.sort()).toEqual(["empty", "throwing"]);
  });

  it("returns empty results for an empty source list", async () => {
    const { quotes, failedSources } = await collectQuotes([], ["XLM"]);
    expect(quotes).toEqual([]);
    expect(failedSources).toEqual([]);
  });
});
