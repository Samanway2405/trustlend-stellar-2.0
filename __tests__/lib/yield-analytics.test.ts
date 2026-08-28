import { describe, expect, it } from "vitest";
import {
  calculateLenderYieldAnalytics,
  type RawPoolPosition,
  type RawLendingPool,
} from "@/lib/lender/yield-analytics";

describe("calculateLenderYieldAnalytics", () => {
  it("calculates weighted average APY and breaks down earnings by lending pool", () => {
    const pools: RawLendingPool[] = [
      { id: "pool-1", name: "High Yield XLM Pool", apr_bps: 1500, status: "active" }, // 15%
      { id: "pool-2", name: "Stable Growth Pool", apr_bps: 1000, status: "active" },   // 10%
    ];

    const positions: RawPoolPosition[] = [
      {
        id: "pos-1",
        pool_id: "pool-1",
        status: "active",
        principal_amount: 3000,
        earned_interest: 150,
        opened_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "pos-2",
        pool_id: "pool-2",
        status: "active",
        principal_amount: 1000,
        earned_interest: 50,
        opened_at: "2026-02-01T00:00:00Z",
      },
    ];

    const result = calculateLenderYieldAnalytics({
      positions,
      pools,
      currentDate: "2026-08-01T00:00:00Z",
    });

    // Total deployed: 3000 + 1000 = 4000
    expect(result.totalDeployedCapital).toBe(4000);
    // Total historical yield: 150 + 50 = 200
    expect(result.totalHistoricalYield).toBe(200);

    // Weighted APY: (3000 * 15 + 1000 * 10) / 4000 = (45000 + 10000) / 4000 = 55000 / 4000 = 13.75%
    expect(result.weightedAverageApy).toBe(13.75);

    // Projections
    // Annual: 4000 * 0.1375 = 550
    expect(result.projectedAnnualYield).toBe(550);
    // 30-day: 4000 * 0.1375 * (30/365) = 45.2054795
    expect(result.projected30DayYield).toBeCloseTo(45.2055, 3);

    // Pool Breakdown Acceptance Criteria
    expect(result.poolBreakdown).toHaveLength(2);

    const pool1 = result.poolBreakdown.find((p) => p.poolId === "pool-1");
    expect(pool1).toBeDefined();
    expect(pool1?.poolName).toBe("High Yield XLM Pool");
    expect(pool1?.apyPct).toBe(15.0);
    expect(pool1?.principalDeployed).toBe(3000);
    expect(pool1?.earnedInterest).toBe(150);
    expect(pool1?.projectedAnnualEarnings).toBe(450);
    expect(pool1?.projectedMonthlyEarnings).toBe(37.5);
    // Share of total earnings: 150 / 200 = 75%
    expect(pool1?.shareOfTotalEarningsPct).toBe(75.0);

    const pool2 = result.poolBreakdown.find((p) => p.poolId === "pool-2");
    expect(pool2).toBeDefined();
    expect(pool2?.poolName).toBe("Stable Growth Pool");
    expect(pool2?.apyPct).toBe(10.0);
    expect(pool2?.principalDeployed).toBe(1000);
    expect(pool2?.earnedInterest).toBe(50);
    expect(pool2?.projectedAnnualEarnings).toBe(100);
    expect(pool2?.shareOfTotalEarningsPct).toBe(25.0);
  });

  it("generates historical APY and projected earnings charts data points", () => {
    const pools: RawLendingPool[] = [
      { id: "pool-1", name: "Core Pool", apr_bps: 1200, status: "active" },
    ];
    const positions: RawPoolPosition[] = [
      { id: "pos-1", pool_id: "pool-1", principal_amount: 5000, earned_interest: 300, status: "active" },
    ];

    const result = calculateLenderYieldAnalytics({
      positions,
      pools,
      currentDate: "2026-08-01T00:00:00Z",
    });

    // Historical APY over time chart series
    expect(result.historicalYieldTrend).toHaveLength(6);
    for (const point of result.historicalYieldTrend) {
      expect(point.apy).toBeGreaterThan(0);
      expect(point.cumulativeYield).toBeGreaterThanOrEqual(0);
      expect(point.isProjected).toBe(false);
    }

    // Projected future earnings chart series
    expect(result.projectedYieldTrend).toHaveLength(6);
    expect(result.projectedYieldTrend[0].label).toContain("+1 Month");
    expect(result.projectedYieldTrend[5].label).toContain("+12 Months");
    expect(result.projectedYieldTrend[5].isProjected).toBe(true);
    expect(result.projectedYieldTrend[5].cumulativeYield).toBeGreaterThan(result.totalHistoricalYield);
  });

  it("handles empty positions gracefully without crashing", () => {
    const result = calculateLenderYieldAnalytics({
      positions: [],
      pools: [],
    });

    expect(result.totalDeployedCapital).toBe(0);
    expect(result.totalHistoricalYield).toBe(0);
    expect(result.weightedAverageApy).toBe(12.5); // fallback default
    expect(result.projectedAnnualYield).toBe(0);
    expect(result.poolBreakdown).toHaveLength(0);
    expect(result.historicalYieldTrend).toHaveLength(6);
    expect(result.projectedYieldTrend).toHaveLength(6);
  });

  it("aggregates multiple positions in the same pool", () => {
    const pools: RawLendingPool[] = [
      { id: "pool-alpha", name: "Alpha Pool", apr_bps: 1400, status: "active" },
    ];
    const positions: RawPoolPosition[] = [
      { id: "p1", pool_id: "pool-alpha", principal_amount: 1000, earned_interest: 50, status: "active" },
      { id: "p2", pool_id: "pool-alpha", principal_amount: 2000, earned_interest: 100, status: "active" },
    ];

    const result = calculateLenderYieldAnalytics({ positions, pools });
    expect(result.poolBreakdown).toHaveLength(1);
    expect(result.poolBreakdown[0].positionsCount).toBe(2);
    expect(result.poolBreakdown[0].principalDeployed).toBe(3000);
    expect(result.poolBreakdown[0].earnedInterest).toBe(150);
  });
});
