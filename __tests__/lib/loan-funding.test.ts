import { describe, expect, it } from "vitest";
import {
  MAX_LENDERS_PER_REPAYMENT,
  calculateLenderReturn,
  formatFundingPercent,
  getFundingProgress,
  splitRepaymentAcrossLenders,
  validateFundingAmount,
} from "@/lib/loans/funding";

// ─── Funding progress ─────────────────────────────────────────────────────────

describe("getFundingProgress", () => {
  it("reports 0% for an untouched loan", () => {
    const progress = getFundingProgress(1000, 0);

    expect(progress.percent).toBe(0);
    expect(progress.remaining).toBe(1000);
    expect(progress.isFullyFunded).toBe(false);
    expect(progress.isPartiallyFunded).toBe(false);
  });

  it("reports 50% for a half-filled loan", () => {
    const progress = getFundingProgress(1000, 500);

    expect(progress.percent).toBe(50);
    expect(progress.remaining).toBe(500);
    expect(progress.isFullyFunded).toBe(false);
    expect(progress.isPartiallyFunded).toBe(true);
  });

  it("reports 100% and no remainder once fully funded", () => {
    const progress = getFundingProgress(1000, 1000);

    expect(progress.percent).toBe(100);
    expect(progress.remaining).toBe(0);
    expect(progress.isFullyFunded).toBe(true);
    expect(progress.isPartiallyFunded).toBe(false);
  });

  it("parses the string numerics PostgREST returns", () => {
    const progress = getFundingProgress("1000.000000", "250.000000");

    expect(progress.percent).toBe(25);
    expect(progress.remaining).toBe(750);
  });

  it("clamps an over-funded loan rather than exceeding 100%", () => {
    const progress = getFundingProgress(1000, 1500);

    expect(progress.percent).toBe(100);
    expect(progress.remaining).toBe(0);
    expect(progress.isFullyFunded).toBe(true);
  });

  it("treats sub-precision dust as fully funded", () => {
    // numeric(20,6) cannot represent anything smaller than 1e-6.
    const progress = getFundingProgress(1000, 999.9999999);

    expect(progress.isFullyFunded).toBe(true);
    expect(progress.remaining).toBe(0);
  });

  it("does not divide by zero on a zero principal", () => {
    const progress = getFundingProgress(0, 0);

    expect(progress.percent).toBe(0);
    expect(progress.isFullyFunded).toBe(false);
  });

  it("handles null and undefined inputs", () => {
    expect(getFundingProgress(null, undefined).percent).toBe(0);
    expect(getFundingProgress(500, null).remaining).toBe(500);
  });

  it("ignores negative contributions", () => {
    expect(getFundingProgress(1000, -50).funded).toBe(0);
  });
});

// ─── Percent formatting ───────────────────────────────────────────────────────

describe("formatFundingPercent", () => {
  it("rounds to whole percentages", () => {
    expect(formatFundingPercent(50)).toBe("50%");
    expect(formatFundingPercent(33.3)).toBe("33%");
  });

  it("never rounds a barely-started loan up to 0%", () => {
    expect(formatFundingPercent(0.4)).toBe("<1%");
  });

  it("never rounds an almost-complete loan up to 100%", () => {
    // Claiming 100% would tell a lender there is nothing left to fund.
    expect(formatFundingPercent(99.6)).toBe(">99%");
  });

  it("shows exact endpoints as-is", () => {
    expect(formatFundingPercent(0)).toBe("0%");
    expect(formatFundingPercent(100)).toBe("100%");
  });
});

// ─── Contribution validation ──────────────────────────────────────────────────

describe("validateFundingAmount", () => {
  it("accepts a partial contribution", () => {
    const result = validateFundingAmount(250, 1000);

    expect(result).toEqual({ ok: true, amount: 250 });
  });

  it("accepts filling the exact remainder", () => {
    const result = validateFundingAmount(1000, 1000);

    expect(result.ok).toBe(true);
  });

  it("rejects zero and negative amounts", () => {
    expect(validateFundingAmount(0, 1000).ok).toBe(false);
    expect(validateFundingAmount(-5, 1000).ok).toBe(false);
  });

  it("rejects overfunding rather than silently capping it", () => {
    // The lender already sent this amount on-chain; crediting less loses them money.
    const result = validateFundingAmount(1500, 1000);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exceeds");
    }
  });

  it("rejects funding a loan with nothing left", () => {
    const result = validateFundingAmount(100, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("fully funded");
    }
  });

  it("rejects non-numeric input", () => {
    expect(validateFundingAmount("abc", 1000).ok).toBe(false);
  });

  it("parses numeric strings from the form input", () => {
    const result = validateFundingAmount("250.50", 1000);

    expect(result).toEqual({ ok: true, amount: 250.5 });
  });

  it("snaps a float-drifted full fill down to the exact remainder", () => {
    const result = validateFundingAmount(1000.0000001, 1000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.amount).toBe(1000);
    }
  });
});

// ─── Lender returns ───────────────────────────────────────────────────────────

describe("calculateLenderReturn", () => {
  it("prorates interest to the slice funded", () => {
    // 10% APR on 500 XLM over 365 days = 50 XLM
    const { interest, total } = calculateLenderReturn(500, 1000, 365);

    expect(interest).toBeCloseTo(50, 6);
    expect(total).toBeCloseTo(550, 6);
  });

  it("scales with the contribution", () => {
    const half = calculateLenderReturn(500, 1200, 90);
    const full = calculateLenderReturn(1000, 1200, 90);

    expect(full.interest).toBeCloseTo(half.interest * 2, 6);
  });
});

// ─── Repayment splitting ──────────────────────────────────────────────────────

describe("splitRepaymentAcrossLenders", () => {
  const twoLenders = [
    { lenderId: "a", address: "GA", contribution: 750 },
    { lenderId: "b", address: "GB", contribution: 250 },
  ];

  it("splits pro-rata to each contribution", () => {
    const payouts = splitRepaymentAcrossLenders(1000, twoLenders);

    expect(payouts).toHaveLength(2);
    expect(payouts[0].payout).toBeCloseTo(750, 6);
    expect(payouts[1].payout).toBeCloseTo(250, 6);
    expect(payouts[0].share).toBeCloseTo(0.75, 6);
  });

  it("pays the full amount out with no dust left over", () => {
    // 1/3 splits do not divide evenly at 7 decimal places.
    const thirds = [
      { lenderId: "a", address: "GA", contribution: 1 },
      { lenderId: "b", address: "GB", contribution: 1 },
      { lenderId: "c", address: "GC", contribution: 1 },
    ];

    const payouts = splitRepaymentAcrossLenders(100, thirds);
    const distributed = payouts.reduce((sum, entry) => sum + entry.payout, 0);

    expect(Number(distributed.toFixed(7))).toBe(100);
  });

  it("hands rounding drift to the largest contributor", () => {
    const payouts = splitRepaymentAcrossLenders(100, [
      { lenderId: "a", address: "GA", contribution: 999999 },
      { lenderId: "b", address: "GB", contribution: 1 },
    ]);

    const distributed = payouts.reduce((sum, entry) => sum + entry.payout, 0);
    expect(Number(distributed.toFixed(7))).toBe(100);
  });

  it("handles a single lender as a full payout", () => {
    const payouts = splitRepaymentAcrossLenders(500, [
      { lenderId: "a", address: "GA", contribution: 500 },
    ]);

    expect(payouts).toHaveLength(1);
    expect(payouts[0].payout).toBe(500);
    expect(payouts[0].share).toBe(1);
  });

  it("returns nothing when there are no lenders", () => {
    expect(splitRepaymentAcrossLenders(100, [])).toEqual([]);
  });

  it("returns nothing for a zero repayment", () => {
    expect(splitRepaymentAcrossLenders(0, twoLenders)).toEqual([]);
  });

  it("drops lenders whose slice rounds away to zero", () => {
    // Stellar rejects a payment operation of 0.
    const payouts = splitRepaymentAcrossLenders(0.0000001, [
      { lenderId: "a", address: "GA", contribution: 1_000_000 },
      { lenderId: "b", address: "GB", contribution: 1 },
    ]);

    expect(payouts.every((entry) => entry.payout > 0)).toBe(true);
  });

  it("ignores entries with no contribution", () => {
    const payouts = splitRepaymentAcrossLenders(100, [
      { lenderId: "a", address: "GA", contribution: 100 },
      { lenderId: "b", address: "GB", contribution: 0 },
    ]);

    expect(payouts).toHaveLength(1);
  });

  it("stays within Stellar's operation budget", () => {
    // One operation per lender plus one for the platform fee must fit in 100.
    expect(MAX_LENDERS_PER_REPAYMENT).toBeLessThanOrEqual(99);
  });
});

// ─── Acceptance criteria ──────────────────────────────────────────────────────

describe("Issue #269 acceptance criteria", () => {
  it("shows a funding progress bar percentage (e.g. 50% funded)", () => {
    expect(formatFundingPercent(getFundingProgress(2000, 1000).percent)).toBe("50%");
  });

  it("activates a loan only when it is 100% funded", () => {
    const filling = [100, 500, 900, 999];

    for (const funded of filling) {
      expect(getFundingProgress(1000, funded).isFullyFunded).toBe(false);
    }

    expect(getFundingProgress(1000, 1000).isFullyFunded).toBe(true);
  });

  it("lets several lenders each take a slice until the loan completes", () => {
    const principal = 1000;
    let funded = 0;

    for (const contribution of [400, 350, 250]) {
      const progress = getFundingProgress(principal, funded);
      const validation = validateFundingAmount(contribution, progress.remaining);

      expect(validation.ok).toBe(true);
      if (validation.ok) funded += validation.amount;
    }

    expect(getFundingProgress(principal, funded).isFullyFunded).toBe(true);
  });

  it("refuses a contribution that would overfill the loan", () => {
    const progress = getFundingProgress(1000, 800);

    expect(validateFundingAmount(300, progress.remaining).ok).toBe(false);
    expect(validateFundingAmount(200, progress.remaining).ok).toBe(true);
  });
});
