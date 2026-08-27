import { describe, expect, it, vi } from "vitest";
import {
  loadOracleConfig,
  runOracleCycle,
  createInitialState,
  createDryRunPublisher,
  type OracleKeeperConfig,
  type PricePublisher,
} from "@/scripts/price-oracle-keeper";
import type { PriceSource } from "@/lib/oracle/sources";
import type { PriceSymbol } from "@/lib/oracle/prices";

const NOW = 1_800_000_000_000;

function baseConfig(overrides: Partial<OracleKeeperConfig> = {}): OracleKeeperConfig {
  return {
    intervalMs: 5_000,
    once: true,
    dryRun: false,
    maxStalenessMs: 120_000,
    assetAddresses: { XLM: "CXLM...", BTC: "CBTC..." },
    lendingContractId: "CLENDING...",
    adminAddress: "GADMIN...",
    ...overrides,
  };
}

function sourceReturning(
  prices: Partial<Record<PriceSymbol, number>>,
  name = "test",
  observedAt = NOW,
): PriceSource {
  return {
    name,
    fetchPrices: async (symbols) =>
      symbols
        .filter((s) => prices[s] !== undefined)
        .map((s) => ({
          symbol: s,
          priceUsd: prices[s] as number,
          source: name,
          observedAt,
        })),
  };
}

function recordingPublisher(twap: number | null = null) {
  const published: Array<{ symbol: string; chainPrice: bigint }> = [];
  const publisher: PricePublisher = {
    async publish(symbol, _addr, chainPrice) {
      published.push({ symbol, chainPrice });
    },
    async readTwap() {
      return twap;
    },
  };
  return { publisher, published };
}

describe("loadOracleConfig", () => {
  it("defaults to the 5-second interval the issue requires", () => {
    expect(loadOracleConfig([], {}).intervalMs).toBe(5_000);
  });

  it("accepts --interval in seconds", () => {
    expect(loadOracleConfig(["--interval=15"], {}).intervalMs).toBe(15_000);
  });

  it("ignores a non-positive interval rather than busy-looping", () => {
    expect(loadOracleConfig(["--interval=0"], {}).intervalMs).toBe(5_000);
    expect(loadOracleConfig(["--interval=-5"], {}).intervalMs).toBe(5_000);
  });

  it("reads flags from the environment as well as argv", () => {
    const cfg = loadOracleConfig([], {
      ORACLE_POLL_INTERVAL_SECS: "30",
      ORACLE_DRY_RUN: "true",
      ORACLE_RUN_ONCE: "true",
    });
    expect(cfg.intervalMs).toBe(30_000);
    expect(cfg.dryRun).toBe(true);
    expect(cfg.once).toBe(true);
  });

  it("lets argv override the environment", () => {
    const cfg = loadOracleConfig(["--interval=5"], {
      ORACLE_POLL_INTERVAL_SECS: "60",
    });
    expect(cfg.intervalMs).toBe(5_000);
  });

  it("picks up the tracked asset addresses", () => {
    const cfg = loadOracleConfig([], {
      ORACLE_XLM_ASSET_ADDRESS: "CXLM",
      ORACLE_BTC_ASSET_ADDRESS: "CBTC",
    });
    expect(cfg.assetAddresses.XLM).toBe("CXLM");
    expect(cfg.assetAddresses.BTC).toBe("CBTC");
  });
});

describe("runOracleCycle — happy path (acceptance: XLM and BTC)", () => {
  it("publishes both tracked symbols", async () => {
    const { publisher, published } = recordingPublisher();
    const summary = await runOracleCycle(
      baseConfig(),
      [sourceReturning({ XLM: 0.12, BTC: 65_000 })],
      publisher,
      createInitialState(),
      NOW,
    );

    expect(summary.published).toBe(2);
    expect(published.map((p) => p.symbol).sort()).toEqual(["BTC", "XLM"]);
  });

  it("converts to 7-decimal chain units", async () => {
    const { publisher, published } = recordingPublisher();
    await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [sourceReturning({ XLM: 0.12 })],
      publisher,
      createInitialState(),
      NOW,
    );
    expect(published[0].chainPrice).toBe(1_200_000n);
  });

  it("takes the median across sources", async () => {
    const { publisher, published } = recordingPublisher();
    await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [
        sourceReturning({ XLM: 0.12 }, "a"),
        sourceReturning({ XLM: 0.13 }, "b"),
        sourceReturning({ XLM: 0.14 }, "c"),
      ],
      publisher,
      createInitialState(),
      NOW,
    );
    expect(published[0].chainPrice).toBe(1_300_000n);
  });

  it("skips publishing when the price has barely moved", async () => {
    const state = createInitialState();
    state.lastPublished.XLM = { priceUsd: 0.12, observedAt: NOW - 1_000 };

    const { publisher, published } = recordingPublisher();
    const summary = await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [sourceReturning({ XLM: 0.120001 })],
      publisher,
      state,
      NOW,
    );

    expect(published).toHaveLength(0);
    expect(summary.skipped).toBe(1);
  });

  it("skips a symbol with no configured asset address", async () => {
    const { publisher, published } = recordingPublisher();
    const summary = await runOracleCycle(
      baseConfig({ assetAddresses: {} }),
      [sourceReturning({ XLM: 0.12, BTC: 65_000 })],
      publisher,
      createInitialState(),
      NOW,
    );
    expect(published).toHaveLength(0);
    expect(summary.skipped).toBe(2);
  });
});

describe("runOracleCycle — fallbacks (acceptance: oracle down)", () => {
  it("uses the cached price when every source fails", async () => {
    const state = createInitialState();
    state.lastGood.XLM = { priceUsd: 0.119, observedAt: NOW - 10_000 };

    const { publisher, published } = recordingPublisher();
    const summary = await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [], // total outage
      publisher,
      state,
      NOW,
    );

    // XLM rides its cache through the outage and still reaches the chain.
    expect(published.find((p) => p.symbol === "XLM")?.chainPrice).toBe(1_190_000n);
    expect(summary.results.find((r) => r.symbol === "XLM")?.origin).toBe("cache");
    // BTC has no cache and no TWAP here, so it correctly reports unavailable
    // rather than being published from thin air.
    expect(summary.results.find((r) => r.symbol === "BTC")?.origin).toBe("unavailable");
  });

  it("falls back to on-chain TWAP when the cache is stale", async () => {
    const state = createInitialState();
    state.lastGood.XLM = { priceUsd: 0.119, observedAt: NOW - 999_999 };

    const { publisher, published } = recordingPublisher(0.115);
    await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [],
      publisher,
      state,
      NOW,
    );

    expect(published.find((p) => p.symbol === "XLM")?.chainPrice).toBe(1_150_000n);
  });

  it("refuses to publish when there is nothing usable at all", async () => {
    const { publisher, published } = recordingPublisher(null);
    const summary = await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [],
      publisher,
      createInitialState(),
      NOW,
    );

    // Publishing a made-up price could wrongly liquidate a borrower.
    expect(published).toHaveLength(0);
    expect(summary.unavailable).toBeGreaterThan(0);
  });

  it("survives one source throwing", async () => {
    const exploding: PriceSource = {
      name: "boom",
      fetchPrices: async () => {
        throw new Error("upstream down");
      },
    };
    const { publisher, published } = recordingPublisher();
    const summary = await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [exploding, sourceReturning({ XLM: 0.12 })],
      publisher,
      createInitialState(),
      NOW,
    );

    expect(summary.failed).toBe(0);
    expect(published).toHaveLength(1);
  });

  it("keeps going when publishing one symbol fails", async () => {
    const flaky: PricePublisher = {
      async publish(symbol) {
        if (symbol === "XLM") throw new Error("tx submission failed");
      },
      async readTwap() {
        return null;
      },
    };
    const summary = await runOracleCycle(
      baseConfig(),
      [sourceReturning({ XLM: 0.12, BTC: 65_000 })],
      flaky,
      createInitialState(),
      NOW,
    );

    expect(summary.failed).toBe(1);
    expect(summary.published).toBe(1); // BTC still got through
  });
});

describe("runOracleCycle — cache hygiene", () => {
  it("refreshes the cache only from a live price", async () => {
    const state = createInitialState();
    const { publisher } = recordingPublisher();

    await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [sourceReturning({ XLM: 0.12 })],
      publisher,
      state,
      NOW,
    );
    expect(state.lastGood.XLM).toEqual({ priceUsd: 0.12, observedAt: NOW });
  });

  it("does not let a cached price renew its own freshness", async () => {
    const state = createInitialState();
    state.lastGood.XLM = { priceUsd: 0.119, observedAt: NOW - 10_000 };

    const { publisher } = recordingPublisher();
    await runOracleCycle(
      baseConfig({ assetAddresses: { XLM: "CXLM" } }),
      [], // still down
      publisher,
      state,
      NOW,
    );

    // Otherwise a stale price would stay "fresh" forever and never age out
    // into the TWAP fallback.
    expect(state.lastGood.XLM?.observedAt).toBe(NOW - 10_000);
  });
});

describe("createDryRunPublisher", () => {
  it("does not throw and reports no TWAP", async () => {
    const publisher = createDryRunPublisher();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(publisher.publish("XLM", "CXLM", 1_200_000n)).resolves.toBeUndefined();
    await expect(publisher.readTwap("XLM", "CXLM")).resolves.toBeNull();
    spy.mockRestore();
  });
});
