/**
 * Partial loan fills (Issue #269).
 *
 * A loan request can be filled by several lenders, each contributing a slice.
 * The loan stays on the marketplace until the contributions cover the full
 * principal, and only then does it activate.
 *
 * These helpers are the single source of truth for that arithmetic so the
 * marketplace table, the funding form and the API all agree on what
 * "50% funded" means.
 */

/**
 * `numeric(20, 6)` in Postgres — amounts are exact to 6 decimal places, so
 * anything smaller than this is float noise, not a real outstanding balance.
 */
export const FUNDING_EPSILON = 1e-6;

export type FundingProgress = {
  /** Total the borrower asked for. */
  principal: number;
  /** Sum of every lender contribution so far. */
  funded: number;
  /** Still needed to activate the loan. Never negative. */
  remaining: number;
  /** 0–100, clamped. Use for the progress bar width. */
  percent: number;
  /** True once contributions cover the principal — the loan can activate. */
  isFullyFunded: boolean;
  /** True when funding has started but has not reached 100%. */
  isPartiallyFunded: boolean;
};

function toSafeNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Derive funding progress for a loan.
 *
 * Tolerates the string-typed numerics PostgREST returns for `numeric` columns,
 * and treats a non-positive principal as 0% rather than dividing by zero.
 */
export function getFundingProgress(
  principalAmount: number | string | null | undefined,
  fundedAmount: number | string | null | undefined
): FundingProgress {
  const principal = Math.max(0, toSafeNumber(principalAmount));
  // A contribution total above the principal would be a data error; clamp it so
  // the bar cannot overflow and the remaining amount cannot go negative.
  const funded = Math.min(Math.max(0, toSafeNumber(fundedAmount)), principal);

  const remaining = Math.max(0, principal - funded);
  const isFullyFunded = principal > 0 && remaining < FUNDING_EPSILON;
  const percent =
    principal <= 0 ? 0 : Math.min(100, Math.max(0, (funded / principal) * 100));

  return {
    principal,
    funded,
    remaining: isFullyFunded ? 0 : remaining,
    percent: isFullyFunded ? 100 : percent,
    isFullyFunded,
    isPartiallyFunded: funded > FUNDING_EPSILON && !isFullyFunded,
  };
}

/** Percentage rounded for display — whole numbers, e.g. `50%`. */
export function formatFundingPercent(percent: number): string {
  const bounded = Math.min(100, Math.max(0, percent));

  // Never round a partially funded loan up to "100%" or down to "0%" — the
  // distinction is exactly what tells a lender there is still room to fund.
  if (bounded > 0 && bounded < 1) return "<1%";
  if (bounded > 99 && bounded < 100) return ">99%";

  return `${Math.round(bounded)}%`;
}

export type FundingAmountValidation =
  | { ok: true; amount: number }
  | { ok: false; error: string };

/**
 * Validate a lender's requested contribution against what the loan still needs.
 *
 * Overfunding is rejected rather than capped: the lender signs the Stellar
 * payment for this exact amount before we ever see it, so silently crediting
 * them less than they sent would lose them money.
 */
export function validateFundingAmount(
  requestedAmount: number | string | null | undefined,
  remainingAmount: number | string | null | undefined
): FundingAmountValidation {
  const amount = toSafeNumber(requestedAmount);
  const remaining = toSafeNumber(remainingAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Funding amount must be greater than zero" };
  }

  if (remaining < FUNDING_EPSILON) {
    return { ok: false, error: "This loan is already fully funded" };
  }

  if (amount - remaining > FUNDING_EPSILON) {
    return {
      ok: false,
      error: `Funding amount exceeds the ${remaining.toFixed(2)} XLM still needed`,
    };
  }

  // Snap a near-exact fill to the precise remainder so floating point drift in
  // the browser cannot leave a 0.0000001 XLM dust balance blocking activation.
  return { ok: true, amount: Math.min(amount, remaining) };
}

/**
 * Interest a lender earns on their slice, pro-rata to what they contributed.
 * Simple interest over the loan term, matching the marketplace's estimate.
 */
export function calculateLenderReturn(
  contribution: number,
  aprBps: number,
  durationDays: number
): { interest: number; total: number } {
  const interest = (contribution * (aprBps / 10_000) * durationDays) / 365;

  return { interest, total: contribution + interest };
}

// ─────────────────────────────────────────────────────────────────────────────
// Repayment splitting
// ─────────────────────────────────────────────────────────────────────────────

export type LenderContribution = {
  lenderId: string;
  address: string;
  contribution: number;
};

export type LenderPayout = LenderContribution & {
  /** Fraction of the loan this lender funded, 0–1. */
  share: number;
  /** XLM owed to this lender out of the repayment being made. */
  payout: number;
};

/** Stellar caps a transaction at 100 operations; we also need one for the fee. */
export const MAX_LENDERS_PER_REPAYMENT = 99;

/**
 * Split a repayment across every lender who funded the loan, pro-rata to what
 * each contributed.
 *
 * Rounds each payout to 7 decimals (Stellar's precision) and hands any
 * remainder from that rounding to the largest contributor, so the payouts sum
 * to exactly `amountToLenders` and no dust is stranded.
 */
export function splitRepaymentAcrossLenders(
  amountToLenders: number,
  contributions: LenderContribution[]
): LenderPayout[] {
  const valid = contributions.filter((entry) => entry.contribution > 0);

  if (valid.length === 0 || amountToLenders <= 0) {
    return [];
  }

  const totalContributed = valid.reduce((sum, entry) => sum + entry.contribution, 0);

  if (totalContributed <= 0) {
    return [];
  }

  const payouts: LenderPayout[] = valid.map((entry) => {
    const share = entry.contribution / totalContributed;

    return {
      ...entry,
      share,
      payout: Number((amountToLenders * share).toFixed(7)),
    };
  });

  // Reconcile rounding drift against the largest contributor.
  const distributed = payouts.reduce((sum, entry) => sum + entry.payout, 0);
  const drift = Number((amountToLenders - distributed).toFixed(7));

  if (drift !== 0) {
    const largest = payouts.reduce((best, entry) =>
      entry.contribution > best.contribution ? entry : best
    );
    largest.payout = Number((largest.payout + drift).toFixed(7));
  }

  // Drop anyone whose slice rounds away to nothing — Stellar rejects 0 payments.
  return payouts.filter((entry) => entry.payout > 0);
}
