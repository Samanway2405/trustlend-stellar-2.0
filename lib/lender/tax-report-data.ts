import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  P2pFundingInput,
  P2pRepaymentInput,
  PoolPositionInput,
} from "./tax-report";

/**
 * Gather everything a lender's tax report is built from (Issue #271).
 *
 * Two income sources, and they come from different places:
 *   * Pool positions live in `pool_positions`, readable by the lender.
 *   * P2P activity lives in `ledger_transactions`. The lender's own fundings
 *     are theirs to read, but the matching repayments were written by the
 *     *borrower*, so they need the service-role client and a metadata match.
 */

export type TaxReportData = {
  poolPositions: PoolPositionInput[];
  fundings: P2pFundingInput[];
  repayments: P2pRepaymentInput[];
};

/** Repayment rows are scanned in bulk; cap the scan so one lender cannot pull the whole ledger. */
const REPAYMENT_SCAN_LIMIT = 2000;

type LedgerMetadata = {
  lenderUserId?: string;
  lenderAddress?: string;
  loanId?: string;
  txHash?: string;
  lenderPayouts?: Array<{ lenderUserId?: string; address?: string; payout?: number }>;
};

function parseMetadata(raw: unknown): LedgerMetadata {
  if (!raw) return {};

  try {
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as LedgerMetadata;
  } catch {
    return {};
  }
}

export async function getLenderTaxReportData(
  supabase: SupabaseClient,
  srClient: SupabaseClient | null,
  userId: string,
  walletAddress?: string | null
): Promise<TaxReportData> {
  const [positionsRes, fundingsRes] = await Promise.all([
    supabase
      .from("pool_positions")
      .select(
        "id, pool_id, principal_amount, earned_interest, opened_at, closed_at, status, lending_pools ( name, currency )"
      )
      .eq("lender_id", userId),
    supabase
      .from("ledger_transactions")
      .select("ref_id, amount, currency, created_at, metadata")
      .eq("user_id", userId)
      .eq("ref_type", "loan_fund"),
  ]);

  const poolPositions: PoolPositionInput[] = (positionsRes.data ?? []).map((row) => {
    // PostgREST returns an embedded to-one relation as an object, but as an
    // array when it cannot prove the relationship is single-valued.
    const poolRaw = Array.isArray(row.lending_pools) ? row.lending_pools[0] : row.lending_pools;
    const pool = poolRaw as { name?: string; currency?: string } | null;

    return {
      id: String(row.id),
      poolId: String(row.pool_id ?? ""),
      poolName: pool?.name ?? null,
      asset: pool?.currency ?? null,
      principalAmount: row.principal_amount,
      earnedInterest: row.earned_interest,
      openedAt: row.opened_at ? String(row.opened_at) : null,
      closedAt: row.closed_at ? String(row.closed_at) : null,
    };
  });

  const fundings: P2pFundingInput[] = (fundingsRes.data ?? []).map((row) => {
    const meta = parseMetadata(row.metadata);

    return {
      loanId: String(meta.loanId ?? row.ref_id ?? ""),
      amount: row.amount,
      asset: row.currency ? String(row.currency) : null,
      date: row.created_at ? String(row.created_at) : null,
    };
  });

  const repayments = srClient
    ? await getLenderRepayments(srClient, userId, walletAddress)
    : [];

  return { poolPositions, fundings, repayments };
}

/**
 * Repayments that reached this lender.
 *
 * The ledger row is owned by the borrower, so the lender is identified from the
 * metadata the repayment route writes. Both the user id and the wallet address
 * are checked because older rows recorded only one of them.
 */
async function getLenderRepayments(
  srClient: SupabaseClient,
  userId: string,
  walletAddress?: string | null
): Promise<P2pRepaymentInput[]> {
  const { data } = await srClient
    .from("ledger_transactions")
    .select("ref_id, amount, currency, created_at, metadata")
    .eq("ref_type", "loan_repay")
    .order("created_at", { ascending: true })
    .limit(REPAYMENT_SCAN_LIMIT);

  const repayments: P2pRepaymentInput[] = [];

  for (const row of data ?? []) {
    const meta = parseMetadata(row.metadata);

    const matchesUser = meta.lenderUserId != null && String(meta.lenderUserId) === userId;
    const matchesWallet =
      Boolean(walletAddress) &&
      meta.lenderAddress != null &&
      String(meta.lenderAddress) === walletAddress;

    // A loan filled by several lenders (#269) records a per-lender payout
    // breakdown; credit this lender only with their own share.
    const payout = Array.isArray(meta.lenderPayouts)
      ? meta.lenderPayouts.find(
          (entry) =>
            (entry.lenderUserId != null && String(entry.lenderUserId) === userId) ||
            (Boolean(walletAddress) && entry.address === walletAddress)
        )
      : undefined;

    if (!payout && !matchesUser && !matchesWallet) continue;

    repayments.push({
      loanId: String(meta.loanId ?? row.ref_id ?? ""),
      amount: payout?.payout ?? row.amount,
      asset: row.currency ? String(row.currency) : null,
      date: row.created_at ? String(row.created_at) : null,
      txHash: meta.txHash ? String(meta.txHash) : null,
    });
  }

  return repayments;
}
