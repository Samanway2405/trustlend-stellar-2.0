import { describe, it, expect } from "vitest";
import {
  computeBorrowRateBps,
  computeSupplyRateBps,
  generateRateCurvePoints,
  validateAssetRiskConfig,
  validateInterestRateCurveConfig,
  validateProtocolFeeConfig,
  DEFAULT_INTEREST_RATE_CURVES,
  RISK_PARAMETER_BOUNDS,
  type InterestRateCurveConfig,
} from "@/lib/risk/parameters";

describe("Risk Parameters - Interest Rate Model Math", () => {
  const testCurve: InterestRateCurveConfig = {
    poolId: 1,
    poolName: "Test Pool",
    baseRateBps: 200,             // 2.00%
    multiplierPerSlopeBps: 1000,  // 10.00%
    kinkBps: 8000,                // 80.00%
    jumpMultiplierBps: 5000,      // 50.00%
    reserveFactorBps: 1000,       // 10.00%
  };

  it("calculates base borrow rate at 0% utilization", () => {
    const borrowBps = computeBorrowRateBps(testCurve, 0);
    expect(borrowBps).toBe(200); // 2.00%
  });

  it("calculates borrow rate linearly along slope 1 at 40% utilization", () => {
    // util = 4000 bps (half of 8000 bps kink)
    // slopeComponent = 4000 * 1000 / 8000 = 500 bps
    // expected = 200 + 500 = 700 bps (7.00%)
    const borrowBps = computeBorrowRateBps(testCurve, 4000);
    expect(borrowBps).toBe(700);
  });

  it("calculates borrow rate exactly at the kink (80% utilization)", () => {
    // at kink: base + slope1 = 200 + 1000 = 1200 bps (12.00%)
    const borrowBps = computeBorrowRateBps(testCurve, 8000);
    expect(borrowBps).toBe(1200);
  });

  it("calculates jump rate past kink (90% utilization)", () => {
    // excess = 9000 - 8000 = 1000 bps
    // jumpDenominator = 10000 - 8000 = 2000 bps
    // jumpComponent = 1000 * 5000 / 2000 = 2500 bps
    // expected = 200 + 1000 + 2500 = 3700 bps (37.00%)
    const borrowBps = computeBorrowRateBps(testCurve, 9000);
    expect(borrowBps).toBe(3700);
  });

  it("calculates max borrow rate at 100% utilization", () => {
    // excess = 2000 bps / 2000 bps * 5000 = 5000 bps
    // expected = 200 + 1000 + 5000 = 6200 bps (62.00%)
    const borrowBps = computeBorrowRateBps(testCurve, 10000);
    expect(borrowBps).toBe(6200);
  });

  it("calculates supply APY with reserve factor deduction", () => {
    // At 80% util, borrowRate = 1200 bps
    // reserveFactor = 10% (90% retained for suppliers)
    // supplyRate = 1200 * 8000 * 9000 / (10000 * 10000) = 864 bps (8.64%)
    const borrowBps = computeBorrowRateBps(testCurve, 8000);
    const supplyBps = computeSupplyRateBps(testCurve, 8000, borrowBps);
    expect(supplyBps).toBe(864);
  });

  it("generates points across 0% to 100% utilization for the visualizer", () => {
    const points = generateRateCurvePoints(testCurve);
    expect(points.length).toBe(21); // 0, 5, 10 ... 100
    expect(points[0].utilizationPct).toBe(0);
    expect(points[0].borrowApyPct).toBe(2.0);
    expect(points[points.length - 1].utilizationPct).toBe(100);
    expect(points[points.length - 1].borrowApyPct).toBe(62.0);
  });
});

describe("Risk Parameters - Validation Constraints", () => {
  it("accepts valid collateral factor parameters", () => {
    const res = validateAssetRiskConfig({
      collateralFactorBps: 7500,
      volatilityBps: 500,
      liquidationThresholdBps: 8000,
    });
    expect(res.valid).toBe(true);
  });

  it("rejects collateral factor below minimum threshold (10%)", () => {
    const res = validateAssetRiskConfig({ collateralFactorBps: 500 });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Collateral Factor must be between");
  });

  it("rejects collateral factor exceeding maximum threshold (95%)", () => {
    const res = validateAssetRiskConfig({ collateralFactorBps: 9800 });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Collateral Factor must be between");
  });

  it("rejects liquidation threshold lower than collateral factor (max LTV)", () => {
    const res = validateAssetRiskConfig({
      collateralFactorBps: 8000,
      liquidationThresholdBps: 7500,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toContain("Liquidation threshold cannot be lower");
  });

  it("validates interest rate curve bounds (kink, base rate, jump multiplier)", () => {
    expect(
      validateInterestRateCurveConfig({
        baseRateBps: 200,
        kinkBps: 8000,
        jumpMultiplierBps: 5000,
      }).valid
    ).toBe(true);

    expect(
      validateInterestRateCurveConfig({ kinkBps: 500 }).valid
    ).toBe(false);

    expect(
      validateInterestRateCurveConfig({ baseRateBps: 6000 }).valid
    ).toBe(false);
  });

  it("validates protocol fee safety ceilings", () => {
    expect(validateProtocolFeeConfig({ flashLoanFeeBps: 9, platformFeeBps: 100 }).valid).toBe(true);
    expect(validateProtocolFeeConfig({ flashLoanFeeBps: 600 }).valid).toBe(false);
    expect(validateProtocolFeeConfig({ platformFeeBps: 1500 }).valid).toBe(false);
  });
});
