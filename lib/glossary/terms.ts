/**
 * Glossary of financial acronyms surfaced in the TrustLend UI (Issue #264).
 *
 * New users land on the dashboard and immediately meet acronyms like APR, LTV
 * and HF with no explanation. This module is the single source of truth for
 * those definitions so the same wording appears everywhere the term is shown,
 * and so copy edits happen in one place instead of a dozen JSX literals.
 *
 * Definitions are deliberately short (one or two sentences, plain language, no
 * jargon-defined-with-jargon) because they render inside a small tooltip.
 */

/** Canonical keys for every term we explain in the UI. */
export type GlossaryTermKey =
  | "APR"
  | "APY"
  | "LTV"
  | "HEALTH_FACTOR"
  | "TRUST_SCORE"
  | "UTILIZATION"
  | "LIQUIDATION_THRESHOLD"
  | "COLLATERAL_FACTOR"
  | "BASIS_POINTS";

export interface GlossaryTerm {
  /** Short form shown inline next to the value, e.g. "APR". */
  label: string;
  /** Expanded name, e.g. "Annual Percentage Rate". */
  full: string;
  /** Plain-language explanation, short enough to read in a tooltip. */
  description: string;
}

export const GLOSSARY: Record<GlossaryTermKey, GlossaryTerm> = {
  APR: {
    label: "APR",
    full: "Annual Percentage Rate",
    description:
      "The yearly interest rate on a loan, before compounding. On TrustLend interest is simple, so a 12% APR on 100 XLM borrowed for a full year costs 12 XLM in interest.",
  },
  APY: {
    label: "APY",
    full: "Annual Percentage Yield",
    description:
      "The yearly return once earned interest is reinvested and starts earning interest itself. APY is higher than APR whenever interest compounds; TrustLend loans pay simple interest, so returns are quoted as APR.",
  },
  LTV: {
    label: "LTV",
    full: "Loan-to-Value",
    description:
      "How much you have borrowed compared with the value of the collateral you posted, as a percentage. Borrowing 70 XLM against 100 XLM of collateral is a 70% LTV — the lower the LTV, the safer your loan.",
  },
  HEALTH_FACTOR: {
    label: "Health Factor",
    full: "Health Factor",
    description:
      "Your collateral value divided by your outstanding debt. Below 1.0 your loan can be liquidated; stay above 1.5 for a safe buffer.",
  },
  TRUST_SCORE: {
    label: "Trust Score",
    full: "Trust Score",
    description:
      "An on-chain reputation score from 0 to 750, earned by repaying loans on time. A higher score unlocks better rates and a more forgiving liquidation threshold.",
  },
  UTILIZATION: {
    label: "Utilization",
    full: "Utilization Rate",
    description:
      "The share of a pool's liquidity that is currently lent out. Higher utilization pushes interest rates up, which rewards lenders and encourages repayment.",
  },
  LIQUIDATION_THRESHOLD: {
    label: "Liquidation Threshold",
    full: "Liquidation Threshold",
    description:
      "The LTV at which your collateral can be sold to repay your debt. TrustLend raises this threshold for borrowers with a strong trust score.",
  },
  COLLATERAL_FACTOR: {
    label: "Collateral Factor",
    full: "Collateral Factor",
    description:
      "The maximum share of an asset's value you are allowed to borrow against. A 75% collateral factor means 100 XLM of collateral supports up to 75 XLM of debt.",
  },
  BASIS_POINTS: {
    label: "bps",
    full: "Basis Points",
    description:
      "One hundredth of a percent. Rates are stored in basis points to avoid rounding errors, so 1500 bps means 15.00%.",
  },
};

/** Look up a term. Returns undefined for unknown keys rather than throwing. */
export function getGlossaryTerm(key: GlossaryTermKey): GlossaryTerm | undefined {
  return GLOSSARY[key];
}

/**
 * Build the text announced to screen readers and shown in the tooltip body.
 * Keeps the "Full Name — description" shape identical across every call site.
 */
export function formatGlossaryDefinition(key: GlossaryTermKey): string {
  const term = GLOSSARY[key];
  if (!term) return "";
  // Avoid the redundant "Health Factor: Health Factor — ..." for terms whose
  // label already is the full name.
  return term.full === term.label
    ? term.description
    : `${term.full} — ${term.description}`;
}
