import type { SupabaseClient } from "@supabase/supabase-js";
import type { LenderContribution } from "./funding";

/**
 * Everyone who funded a loan, and how much each put in (Issue #269).
 *
 * Reads `loan_fundings`, the per-contribution table. Loans funded before
 * partial fills existed are recorded only in `ledger_transactions`, so those
 * fall back to the ledger — the same place the single-lender code used to look.
 *
 * Requires a service-role client: contributions belong to lenders, and the
 * borrower calling repayment cannot read them under RLS.
 */
export async function getLoanLenders(
  srClient: SupabaseClient,
  loanId: string
): Promise<LenderContribution[]> {
  const { data: fundings, error } = await srClient
    .from("loan_fundings")
    .select("lender_id, lender_address, amount")
    .eq("loan_id", loanId)
    .order("amount", { ascending: false });

  if (!error && fundings && fundings.length > 0) {
    return mergeByLender(
      fundings.map((row) => ({
        lenderId: String(row.lender_id ?? ""),
        address: String(row.lender_address ?? ""),
        contribution: Number(row.amount ?? 0),
      }))
    );
  }

  // ── Legacy fallback ────────────────────────────────────────────────────────
  // Pre-#269 loans, or a database where sql/08_partial_loan_fills.sql has not
  // been applied yet.
  const { data: fundTxs } = await srClient
    .from("ledger_transactions")
    .select("user_id, amount, metadata")
    .eq("ref_type", "loan_fund")
    .eq("ref_id", loanId);

  const legacy = (fundTxs ?? []).map((row) => {
    let address = "";

    try {
      const meta =
        typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      address = String(meta?.lenderAddress ?? "");
    } catch {
      // Unparseable metadata means no wallet address; the caller filters it out.
    }

    return {
      lenderId: String(row.user_id ?? ""),
      address,
      contribution: Number(row.amount ?? 0),
    };
  });

  return mergeByLender(legacy);
}

/**
 * Collapse repeat contributions from the same wallet into one payout line, so
 * a lender who topped a loan up twice receives a single Stellar payment.
 */
function mergeByLender(entries: LenderContribution[]): LenderContribution[] {
  const merged = new Map<string, LenderContribution>();

  for (const entry of entries) {
    if (!entry.address || entry.contribution <= 0) continue;

    const existing = merged.get(entry.address);

    if (existing) {
      existing.contribution += entry.contribution;
    } else {
      merged.set(entry.address, { ...entry });
    }
  }

  return [...merged.values()].sort((a, b) => b.contribution - a.contribution);
}
