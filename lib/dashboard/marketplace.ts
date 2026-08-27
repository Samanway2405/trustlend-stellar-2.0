/**
 * Pure helpers for the lender Loan Marketplace (issue #261).
 *
 * Sorting and duration filtering for open borrower loan requests. Kept
 * dependency-free and side-effect-free so the behavior is unit-testable
 * (see `__tests__/lib/marketplace.test.ts`).
 */

export type MarketplaceSortOption =
  | "apr_desc"
  | "apr_asc"
  | "term_desc"
  | "term_asc";

/** Default marketplace view: highest interest rate (APY) first. */
export const DEFAULT_SORT: MarketplaceSortOption = "apr_desc";

/** Trust-score cutoff used by the "high reputation only" filter. */
export const HIGH_REPUTATION_THRESHOLD = 500;

/** Supported "maximum duration" filter buckets, in days. */
export const DURATION_FILTER_OPTIONS = [
  { value: "all", label: "Any duration", days: null },
  { value: "30", label: "30 days or less", days: 30 },
  { value: "90", label: "90 days or less", days: 90 },
  { value: "180", label: "180 days or less", days: 180 },
  { value: "365", label: "12 months or less", days: 365 },
] as const;

/** Coerce a `sort` search param into a known option; invalid → default. */
export function parseSortOption(
  value: string | undefined,
): MarketplaceSortOption {
  switch (value) {
    case "apr_asc":
    case "term_desc":
    case "term_asc":
      return value;
    case "apr_desc":
    default:
      return DEFAULT_SORT;
  }
}

/** Stable copy-sort of loans by the chosen option (never mutates input). */
export function sortMarketplaceLoans<
  T extends { apr_bps: number; duration_days: number },
>(loans: T[], sort: MarketplaceSortOption = DEFAULT_SORT): T[] {
  return [...loans].sort((left, right) => {
    switch (sort) {
      case "apr_asc":
        return left.apr_bps - right.apr_bps;
      case "term_desc":
        return right.duration_days - left.duration_days;
      case "term_asc":
        return left.duration_days - right.duration_days;
      case "apr_desc":
      default:
        return right.apr_bps - left.apr_bps;
    }
  });
}

/**
 * Parse a `maxDuration` search param into a day count.
 * Returns `null` for "no filter" (missing, empty, "all", or invalid input).
 */
export function parseDurationFilter(value: string | undefined): number | null {
  if (value === undefined || value === "" || value === "all") return null;
  const days = Number(value);
  if (!Number.isInteger(days) || days <= 0) return null;
  return days;
}

/**
 * Keep only loans whose duration is at most `maxDays`.
 * `maxDays === null` keeps every loan (no filter).
 */
export function filterByMaxDuration<
  T extends { duration_days: number },
>(loans: T[], maxDays: number | null): T[] {
  if (maxDays === null) return [...loans];
  return loans.filter((loan) => loan.duration_days <= maxDays);
}

export interface MarketplaceFilterOptions {
  sort?: MarketplaceSortOption;
  /** Maximum loan duration in days; null = no duration filter. */
  maxDurationDays?: number | null;
  /** Only show loans at/above the reputation threshold. */
  highReputationOnly?: boolean;
  highReputationThreshold?: number;
}

/**
 * Apply duration filter → reputation filter → sort in one pass.
 * Returns a new array; the input is never mutated.
 */
export function filterMarketplaceLoans<
  T extends { apr_bps: number; duration_days: number; trust_score: number },
>(loans: T[], options: MarketplaceFilterOptions = {}): T[] {
  const sort = options.sort ?? DEFAULT_SORT;
  const threshold = options.highReputationThreshold ?? HIGH_REPUTATION_THRESHOLD;

  const durationFiltered = filterByMaxDuration(
    loans,
    options.maxDurationDays ?? null,
  );
  const reputationFiltered = options.highReputationOnly
    ? durationFiltered.filter((loan) => loan.trust_score >= threshold)
    : durationFiltered;

  return sortMarketplaceLoans(reputationFiltered, sort);
}
