import { describe, it, expect } from "vitest";
import {
  computeBorrowerReputationScore,
  BorrowerRepaymentStats,
  BASE_REPUTATION_SCORE,
  MAX_REPUTATION_SCORE,
  MIN_REPUTATION_SCORE,
} from "@/lib/reputation/scoring";

describe("Borrower Reputation Scoring Algorithm", () => {
  const baseStats: BorrowerRepaymentStats = {
    totalLoans: 0,
    completedLoans: 0,
    onTimeRepayments: 0,
    earlyRepayments: 0,
    lateRepayments: 0,
    defaultedLoans: 0,
    totalBorrowedXlm: 0,
    totalRepaidXlm: 0,
    kycVerified: false,
    emailVerified: false,
    accountAgeDays: 0,
  };

  it("calculates baseline score (250 pts) for a fresh unverified borrower", () => {
    const result = computeBorrowerReputationScore(baseStats);
    expect(result.score).toBe(BASE_REPUTATION_SCORE);
    expect(result.tier).toBe("None");
    expect(result.interestRatePct).toBe(15.0);
    expect(result.rateDiscountPct).toBe(0.0);
    expect(result.maxLoanXlm).toBe(1000);
  });

  it("awards bonus points for email and government ID KYC verification", () => {
    const kycStats: BorrowerRepaymentStats = {
      ...baseStats,
      emailVerified: true,
      kycVerified: true,
    };
    const result = computeBorrowerReputationScore(kycStats);
    // 250 base + 20 email + 80 KYC = 350 pts -> Beginner Tier
    expect(result.score).toBe(350);
    expect(result.tier).toBe("Beginner");
    expect(result.interestRatePct).toBe(13.0);
    expect(result.rateDiscountPct).toBe(2.0);
    expect(result.maxLoanXlm).toBe(2000);
  });

  it("rewards consistent on-time and early repayments", () => {
    const activeStats: BorrowerRepaymentStats = {
      ...baseStats,
      emailVerified: true,
      kycVerified: true,
      totalLoans: 5,
      completedLoans: 5,
      onTimeRepayments: 3,
      earlyRepayments: 2,
      totalBorrowedXlm: 5000,
      totalRepaidXlm: 5000,
      accountAgeDays: 90,
    };
    const result = computeBorrowerReputationScore(activeStats);
    // 250 base + 100 kyc + (3 * 35 = 105) on-time + (2 * 45 = 90) early + (5 * 15 = 75) volume + (3 * 5 = 15) tenure = 635 pts -> Silver Tier
    expect(result.score).toBe(635);
    expect(result.tier).toBe("Silver");
    expect(result.interestRatePct).toBe(12.0);
    expect(result.rateDiscountPct).toBe(3.0);
    expect(result.maxLoanXlm).toBe(5000);
    expect(result.onTimePercentage).toBe(100);
  });

  it("promotes borrower to Gold & Platinum tier for extensive track record", () => {
    const primeStats: BorrowerRepaymentStats = {
      ...baseStats,
      emailVerified: true,
      kycVerified: true,
      totalLoans: 12,
      completedLoans: 12,
      onTimeRepayments: 8,
      earlyRepayments: 4,
      totalBorrowedXlm: 12000,
      totalRepaidXlm: 12000,
      accountAgeDays: 180,
    };
    const result = computeBorrowerReputationScore(primeStats);
    // 250 + 100 + (8 * 35 = 280) + (4 * 45 = 180) + (12 * 15 = 180 max 150) + (6 * 5 = 30) = 990 pts -> Platinum Tier
    expect(result.score).toBe(990);
    expect(result.tier).toBe("Platinum");
    expect(result.interestRatePct).toBe(8.0);
    expect(result.rateDiscountPct).toBe(7.0);
    expect(result.maxLoanXlm).toBe(100000);
  });

  it("deducts points for late payments and defaults", () => {
    const penalizedStats: BorrowerRepaymentStats = {
      ...baseStats,
      emailVerified: true,
      kycVerified: true,
      totalLoans: 3,
      completedLoans: 1,
      onTimeRepayments: 1,
      lateRepayments: 2,
      defaultedLoans: 1,
      totalBorrowedXlm: 3000,
      totalRepaidXlm: 1000,
    };
    const result = computeBorrowerReputationScore(penalizedStats);
    // 250 + 100 (kyc) + 35 (on-time) + 15 (volume) - 50 (2 late * 25) - 150 (1 default) = 200 pts -> None Tier
    expect(result.score).toBe(200);
    expect(result.tier).toBe("None");
    expect(result.interestRatePct).toBe(15.0);
  });

  it("clamps reputation score between 0 and 1000", () => {
    const terribleStats: BorrowerRepaymentStats = {
      ...baseStats,
      defaultedLoans: 10,
    };
    expect(computeBorrowerReputationScore(terribleStats).score).toBe(MIN_REPUTATION_SCORE);
  });
});
