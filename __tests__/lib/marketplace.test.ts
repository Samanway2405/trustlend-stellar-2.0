import { describe, expect, it } from "vitest";
import {
  DEFAULT_SORT,
  HIGH_REPUTATION_THRESHOLD,
  parseSortOption,
  sortMarketplaceLoans,
  parseDurationFilter,
  filterByMaxDuration,
  filterMarketplaceLoans,
} from "@/lib/dashboard/marketplace";

type Loan = {
  id: string;
  apr_bps: number;
  duration_days: number;
  trust_score: number;
};

const SAMPLE_LOANS: Loan[] = [
  { id: "a", apr_bps: 1000, duration_days: 30, trust_score: 600 },
  { id: "b", apr_bps: 2000, duration_days: 90, trust_score: 400 },
  { id: "c", apr_bps: 1500, duration_days: 180, trust_score: 700 },
];

// ── parseSortOption ───────────────────────────────────────────────────────────

describe("parseSortOption", () => {
  it("defaults to apr_desc (highest APY) when no sort is given", () => {
    expect(parseSortOption(undefined)).toBe("apr_desc");
    expect(DEFAULT_SORT).toBe("apr_desc");
  });

  it("accepts every supported option", () => {
    expect(parseSortOption("apr_desc")).toBe("apr_desc");
    expect(parseSortOption("apr_asc")).toBe("apr_asc");
    expect(parseSortOption("term_desc")).toBe("term_desc");
    expect(parseSortOption("term_asc")).toBe("term_asc");
  });

  it("falls back to the default for unknown or empty values", () => {
    expect(parseSortOption("bogus")).toBe(DEFAULT_SORT);
    expect(parseSortOption("")).toBe(DEFAULT_SORT);
  });
});

// ── sortMarketplaceLoans ──────────────────────────────────────────────────────

describe("sortMarketplaceLoans", () => {
  it("sorts by highest APY first (acceptance criterion #2)", () => {
    const sorted = sortMarketplaceLoans(SAMPLE_LOANS, "apr_desc");
    expect(sorted.map((loan) => loan.id)).toEqual(["b", "c", "a"]);
  });

  it("sorts by lowest APY first", () => {
    const sorted = sortMarketplaceLoans(SAMPLE_LOANS, "apr_asc");
    expect(sorted.map((loan) => loan.id)).toEqual(["a", "c", "b"]);
  });

  it("sorts by longest duration first", () => {
    const sorted = sortMarketplaceLoans(SAMPLE_LOANS, "term_desc");
    expect(sorted.map((loan) => loan.id)).toEqual(["c", "b", "a"]);
  });

  it("sorts by shortest duration first", () => {
    const sorted = sortMarketplaceLoans(SAMPLE_LOANS, "term_asc");
    expect(sorted.map((loan) => loan.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the default apr_desc sort when omitted", () => {
    const sorted = sortMarketplaceLoans(SAMPLE_LOANS);
    expect(sorted.map((loan) => loan.id)).toEqual(["b", "c", "a"]);
  });

  it("does not mutate the input array", () => {
    const input = [...SAMPLE_LOANS];
    sortMarketplaceLoans(input, "apr_desc");
    expect(input.map((loan) => loan.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for empty input", () => {
    expect(sortMarketplaceLoans([], "apr_desc")).toEqual([]);
  });

  it("keeps equal-APY loans in a stable relative order", () => {
    const loans: Loan[] = [
      { id: "x", apr_bps: 1200, duration_days: 30, trust_score: 500 },
      { id: "y", apr_bps: 1200, duration_days: 60, trust_score: 500 },
    ];
    expect(sortMarketplaceLoans(loans, "apr_desc").map((loan) => loan.id)).toEqual(["x", "y"]);
  });
});

// ── parseDurationFilter ───────────────────────────────────────────────────────

describe("parseDurationFilter", () => {
  it("returns null for no filter (missing / empty / 'all')", () => {
    expect(parseDurationFilter(undefined)).toBeNull();
    expect(parseDurationFilter("")).toBeNull();
    expect(parseDurationFilter("all")).toBeNull();
  });

  it("parses a valid day count", () => {
    expect(parseDurationFilter("30")).toBe(30);
    expect(parseDurationFilter("90")).toBe(90);
    expect(parseDurationFilter("365")).toBe(365);
  });

  it("rejects invalid, zero, or negative values instead of guessing", () => {
    expect(parseDurationFilter("abc")).toBeNull();
    expect(parseDurationFilter("-5")).toBeNull();
    expect(parseDurationFilter("0")).toBeNull();
    expect(parseDurationFilter("30.5")).toBeNull();
  });
});

// ── filterByMaxDuration ───────────────────────────────────────────────────────

describe("filterByMaxDuration", () => {
  it("keeps every loan when no max duration is set", () => {
    expect(filterByMaxDuration(SAMPLE_LOANS, null)).toHaveLength(3);
  });

  it("filters out loans longer than the max duration (acceptance criterion #1)", () => {
    const filtered = filterByMaxDuration(SAMPLE_LOANS, 90);
    expect(filtered.map((loan) => loan.id)).toEqual(["a", "b"]);
  });

  it("includes loans whose duration equals the max exactly (boundary)", () => {
    const filtered = filterByMaxDuration(SAMPLE_LOANS, 180);
    expect(filtered.map((loan) => loan.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty list when no loan fits", () => {
    expect(filterByMaxDuration(SAMPLE_LOANS, 7)).toEqual([]);
  });
});

// ── filterMarketplaceLoans (combined) ─────────────────────────────────────────

describe("filterMarketplaceLoans", () => {
  it("sorts by highest APY by default with no filters", () => {
    const result = filterMarketplaceLoans(SAMPLE_LOANS);
    expect(result.map((loan) => loan.id)).toEqual(["b", "c", "a"]);
  });

  it("combines duration filter, reputation filter, and sort", () => {
    const result = filterMarketplaceLoans(SAMPLE_LOANS, {
      sort: "apr_desc",
      maxDurationDays: 90,
      highReputationOnly: true,
      highReputationThreshold: HIGH_REPUTATION_THRESHOLD,
    });
    // Only loan "a" (30d, trust 600) survives both filters.
    expect(result.map((loan) => loan.id)).toEqual(["a"]);
  });

  it("excludes low-reputation loans only when the flag is on", () => {
    const result = filterMarketplaceLoans(SAMPLE_LOANS, {
      maxDurationDays: 365,
      highReputationOnly: true,
    });
    expect(result.map((loan) => loan.id)).toEqual(["c", "a"]);
  });

  it("respects a custom reputation threshold", () => {
    const result = filterMarketplaceLoans(SAMPLE_LOANS, {
      highReputationOnly: true,
      highReputationThreshold: 650,
    });
    expect(result.map((loan) => loan.id)).toEqual(["c"]);
  });

  it("does not mutate the input", () => {
    const input = [...SAMPLE_LOANS];
    filterMarketplaceLoans(input, { sort: "term_desc", maxDurationDays: 365 });
    expect(input.map((loan) => loan.id)).toEqual(["a", "b", "c"]);
  });
});
