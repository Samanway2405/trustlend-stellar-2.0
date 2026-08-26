/**
 * Lender tax report (Issue #271).
 *
 * Turns a lender's positions and repayments into a flat list of interest-income
 * events they can hand to an accountant, and serializes it as CSV.
 *
 * Two income sources feed the report:
 *   * Pool positions   — interest accrued on liquidity supplied to a pool.
 *   * P2P loans        — interest on loans funded directly on the marketplace.
 *
 * The P2P side is the subtle one: a repayment is not income, it is mostly the
 * lender's own capital coming back. Interest is recognised **return-of-capital
 * first** — repayments count against the principal the lender put in, and only
 * what arrives after the principal is whole is income. That matches how the
 * gain would actually be reported.
 */

export type TaxCategory =
  /** Pool interest on a position that has been closed — realised income. */
  | "pool_interest_realized"
  /** Pool interest still accruing on an open position — not yet realised. */
  | "pool_interest_accrued"
  /** Interest received on a directly funded marketplace loan. */
  | "p2p_loan_interest";

export type TaxReportRow = {
  /** ISO calendar date (YYYY-MM-DD) the income is attributed to. */
  date: string;
  /** Asset code the income was paid in, e.g. XLM. */
  asset: string;
  /** Interest earned, in `asset`. Never negative. */
  amount: number;
  category: TaxCategory;
  /** Human-readable origin — pool name, or the loan reference. */
  source: string;
  /** Capital the lender had deployed against this row. */
  principal: number;
  /** Total received including the return of capital. 0 where not applicable. */
  grossReceived: number;
  /** Stable id of the underlying position or loan. */
  reference: string;
  /** Stellar transaction hash, where the income came from an on-chain payment. */
  txHash: string;
};

export type PoolPositionInput = {
  id: string;
  poolId: string;
  poolName?: string | null;
  asset?: string | null;
  principalAmount: number | string | null | undefined;
  earnedInterest: number | string | null | undefined;
  openedAt: string | null;
  closedAt?: string | null;
};

export type P2pFundingInput = {
  loanId: string;
  amount: number | string | null | undefined;
  asset?: string | null;
  date: string | null;
};

export type P2pRepaymentInput = {
  loanId: string;
  amount: number | string | null | undefined;
  asset?: string | null;
  date: string | null;
  txHash?: string | null;
};

export type BuildTaxReportInput = {
  poolPositions?: PoolPositionInput[];
  fundings?: P2pFundingInput[];
  repayments?: P2pRepaymentInput[];
  /** Restrict to one calendar year (UTC). Omit for every year on record. */
  year?: number | null;
};

const DEFAULT_ASSET = "XLM";

/** Amounts are numeric(20,6) in Postgres; below this is float noise. */
const AMOUNT_EPSILON = 1e-6;

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `YYYY-MM-DD` in UTC, or "" when the timestamp is missing or unparseable. */
export function toIsoDate(value: string | null | undefined): string {
  if (!value) return "";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";

  return parsed.toISOString().slice(0, 10);
}

function yearOf(isoDate: string): number | null {
  if (!isoDate) return null;

  const year = Number(isoDate.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * Build the interest-income rows for one lender.
 *
 * Rows are returned newest-first. Events that earned no interest are left out —
 * the report is about income, and a repayment that only returns capital is not
 * income.
 */
export function buildTaxReportRows({
  poolPositions = [],
  fundings = [],
  repayments = [],
  year = null,
}: BuildTaxReportInput): TaxReportRow[] {
  const rows: TaxReportRow[] = [
    ...buildPoolRows(poolPositions),
    ...buildP2pRows(fundings, repayments),
  ];

  const filtered =
    year == null ? rows : rows.filter((row) => yearOf(row.date) === year);

  // Newest first, with a stable tiebreak so the same data always exports
  // byte-identically.
  return filtered.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0;
  });
}

function buildPoolRows(positions: PoolPositionInput[]): TaxReportRow[] {
  const rows: TaxReportRow[] = [];

  for (const position of positions) {
    const interest = toNumber(position.earnedInterest);
    if (interest < AMOUNT_EPSILON) continue;

    // A closed position realised its interest on the closing date; an open one
    // is still accruing, so attribute it to when the position was opened and
    // label it accordingly.
    const isClosed = Boolean(position.closedAt);
    const date = toIsoDate(isClosed ? position.closedAt : position.openedAt);

    rows.push({
      date,
      asset: position.asset || DEFAULT_ASSET,
      amount: round6(interest),
      category: isClosed ? "pool_interest_realized" : "pool_interest_accrued",
      source: position.poolName || `Pool ${String(position.poolId).slice(0, 8)}`,
      principal: round6(toNumber(position.principalAmount)),
      grossReceived: 0,
      reference: String(position.id),
      txHash: "",
    });
  }

  return rows;
}

/**
 * Recognise P2P interest return-of-capital first, per loan.
 *
 * Repayments are walked oldest-first against the principal the lender put into
 * that loan; whatever arrives once the principal is whole is interest.
 */
function buildP2pRows(
  fundings: P2pFundingInput[],
  repayments: P2pRepaymentInput[]
): TaxReportRow[] {
  const principalByLoan = new Map<string, number>();
  const assetByLoan = new Map<string, string>();

  for (const funding of fundings) {
    const loanId = String(funding.loanId ?? "");
    if (!loanId) continue;

    principalByLoan.set(loanId, (principalByLoan.get(loanId) ?? 0) + toNumber(funding.amount));

    if (funding.asset && !assetByLoan.has(loanId)) {
      assetByLoan.set(loanId, funding.asset);
    }
  }

  const byLoan = new Map<string, P2pRepaymentInput[]>();

  for (const repayment of repayments) {
    const loanId = String(repayment.loanId ?? "");
    if (!loanId) continue;

    const list = byLoan.get(loanId);
    if (list) list.push(repayment);
    else byLoan.set(loanId, [repayment]);
  }

  const rows: TaxReportRow[] = [];

  for (const [loanId, loanRepayments] of byLoan) {
    // A lender who never funded this loan has no capital to recover, so every
    // credit is income.
    let outstandingPrincipal = principalByLoan.get(loanId) ?? 0;
    const principal = outstandingPrincipal;

    const ordered = [...loanRepayments].sort((a, b) => {
      const left = toIsoDate(a.date);
      const right = toIsoDate(b.date);
      return left < right ? -1 : left > right ? 1 : 0;
    });

    for (const repayment of ordered) {
      const received = toNumber(repayment.amount);
      if (received <= 0) continue;

      const capitalReturned = Math.min(outstandingPrincipal, received);
      outstandingPrincipal -= capitalReturned;

      const interest = received - capitalReturned;
      if (interest < AMOUNT_EPSILON) continue;

      rows.push({
        date: toIsoDate(repayment.date),
        asset: repayment.asset || assetByLoan.get(loanId) || DEFAULT_ASSET,
        amount: round6(interest),
        category: "p2p_loan_interest",
        source: `Loan ${loanId.slice(0, 8)}`,
        principal: round6(principal),
        grossReceived: round6(received),
        reference: loanId,
        txHash: String(repayment.txHash ?? ""),
      });
    }
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

export type TaxReportSummary = {
  rowCount: number;
  totalInterest: number;
  /** Interest totals keyed by asset code — a report can span several assets. */
  byAsset: Record<string, number>;
  totalPrincipalDeployed: number;
};

export function summarizeTaxReport(rows: TaxReportRow[]): TaxReportSummary {
  const byAsset: Record<string, number> = {};
  let totalInterest = 0;

  for (const row of rows) {
    byAsset[row.asset] = round6((byAsset[row.asset] ?? 0) + row.amount);
    totalInterest += row.amount;
  }

  // Principal is per position/loan, so a loan paying interest across several
  // repayments must not have its principal counted once per row.
  const seen = new Set<string>();
  let totalPrincipalDeployed = 0;

  for (const row of rows) {
    if (seen.has(row.reference)) continue;
    seen.add(row.reference);
    totalPrincipalDeployed += row.principal;
  }

  return {
    rowCount: rows.length,
    totalInterest: round6(totalInterest),
    byAsset,
    totalPrincipalDeployed: round6(totalPrincipalDeployed),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV serialization
// ─────────────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  "date",
  "asset",
  "amount",
  "category",
  "source",
  "principal",
  "gross_received",
  "reference",
  "tx_hash",
] as const;

/**
 * Characters that make a spreadsheet treat a cell as a formula.
 *
 * Source names can carry a pool name someone else chose, so a cell starting
 * with one of these has to be neutralised or opening the CSV in Excel could
 * execute it (CSV injection).
 */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

/** Neutralise a value a spreadsheet would otherwise evaluate as a formula. */
export function sanitizeCsvText(value: string): string {
  if (value.length === 0) return value;

  return FORMULA_PREFIXES.includes(value[0]) ? `'${value}` : value;
}

/** Quote and escape one cell per RFC 4180. */
export function escapeCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;

  return `"${value.replace(/"/g, '""')}"`;
}

export type ToCsvOptions = {
  /**
   * Prefix a UTF-8 BOM. Excel needs it to read non-ASCII correctly; omit it
   * when the output is going to be parsed by something else.
   */
  bom?: boolean;
};

/**
 * Serialize rows to RFC 4180 CSV: CRLF line breaks, quoted cells where needed,
 * and text columns neutralised against formula injection.
 */
export function toCsv(rows: TaxReportRow[], options: ToCsvOptions = {}): string {
  const { bom = true } = options;

  const lines = [CSV_COLUMNS.join(",")];

  for (const row of rows) {
    const cells = [
      row.date,
      sanitizeCsvText(row.asset),
      row.amount.toFixed(6),
      row.category,
      sanitizeCsvText(row.source),
      row.principal.toFixed(6),
      row.grossReceived.toFixed(6),
      sanitizeCsvText(row.reference),
      sanitizeCsvText(row.txHash),
    ];

    lines.push(cells.map(escapeCsvCell).join(","));
  }

  return (bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

/** `trustlend-tax-report-2026.csv` — stable, sortable, obvious in a downloads folder. */
export function taxReportFilename(year: number | null, extension = "csv"): string {
  return `trustlend-tax-report-${year ?? "all"}.${extension}`;
}

/**
 * Years to offer in the export picker: every year the lender has activity in,
 * newest first, always including the current year so the control is never empty
 * for a brand-new lender.
 */
export function collectReportYears(
  dates: Array<string | null | undefined>,
  currentYear = new Date().getUTCFullYear()
): number[] {
  const years = new Set<number>([currentYear]);

  for (const date of dates) {
    const year = yearOf(toIsoDate(date));
    if (year != null) years.add(year);
  }

  return [...years].sort((a, b) => b - a);
}
