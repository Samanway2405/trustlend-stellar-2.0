/**
 * lib/reputation/daily-sync.ts
 *
 * Daily reputation calculation runner. Iterates over borrower accounts,
 * aggregates on-chain loan/repayment performance, recalculates scores,
 * and updates persistent snapshots and on-chain contract state.
 */

import { getServiceRoleClient } from "@/lib/supabase/server";
import {
  computeBorrowerReputationScore,
  BorrowerRepaymentStats,
  BorrowerReputationResult,
} from "@/lib/reputation/scoring";

export interface DailyCalculationSummary {
  scanned: number;
  updated: number;
  tierUpgrades: number;
  errors: number;
  details: Array<{
    userId: string;
    walletAddress?: string;
    previousScore: number;
    newScore: number;
    tier: string;
    discountPct: number;
  }>;
}

/**
 * Runs the daily reputation recalculation for all active borrowers.
 */
export async function runDailyReputationRecalculation(): Promise<DailyCalculationSummary> {
  const supabase = getServiceRoleClient();
  if (!supabase) {
    throw new Error("Supabase service client unavailable");
  }

  // 1. Fetch all borrower profiles
  const { data: borrowers, error: borrowersError } = await supabase
    .from("profiles")
    .select("id, wallet_address, kyc_status, full_name, created_at")
    .eq("role", "borrower");

  if (borrowersError) {
    throw new Error(`Failed to fetch borrowers: ${borrowersError.message}`);
  }

  const summary: DailyCalculationSummary = {
    scanned: borrowers?.length ?? 0,
    updated: 0,
    tierUpgrades: 0,
    errors: 0,
    details: [],
  };

  if (!borrowers || borrowers.length === 0) {
    return summary;
  }

  for (const borrower of borrowers) {
    try {
      // 2. Fetch loan history
      const { data: loans } = await supabase
        .from("loans")
        .select("id, status, principal_amount, repaid_amount, due_at, created_at, metadata")
        .eq("borrower_id", borrower.id);

      // 3. Fetch repayments
      const { data: repayments } = await supabase
        .from("loan_repayments")
        .select("id, amount, paid_at, loan_id")
        .eq("payer_id", borrower.id);

      // 4. Fetch current reputation snapshot
      const { data: snapshot } = await supabase
        .from("reputation_snapshots")
        .select("score_total, tier")
        .eq("user_id", borrower.id)
        .maybeSingle();

      const previousScore = snapshot?.score_total ?? 250;
      const previousTier = snapshot?.tier ?? "None";

      // 5. Aggregate stats
      const userLoans = loans ?? [];
      const userRepayments = repayments ?? [];

      const completedLoans = userLoans.filter((l) => l.status === "repaid").length;
      const defaultedLoans = userLoans.filter((l) => l.status === "defaulted").length;

      let onTimeCount = 0;
      let earlyCount = 0;
      let lateCount = 0;

      for (const loan of userLoans) {
        if (loan.status === "repaid") {
          const dueTime = loan.due_at ? new Date(loan.due_at).getTime() : 0;
          const creationTime = loan.created_at ? new Date(loan.created_at).getTime() : 0;

          // Check repayment timing from metadata or date
          if (loan.metadata && typeof loan.metadata === "object" && (loan.metadata as { is_early?: boolean }).is_early) {
            earlyCount++;
          } else if (dueTime > 0) {
            // Find latest payment date for this loan
            const loanPayments = userRepayments.filter((r) => r.loan_id === loan.id);
            const latestPayment = loanPayments.reduce(
              (latest, r) => Math.max(latest, new Date(r.paid_at).getTime()),
              creationTime
            );

            if (latestPayment <= dueTime) {
              onTimeCount++;
            } else {
              lateCount++;
            }
          } else {
            onTimeCount++;
          }
        }
      }

      const totalBorrowed = userLoans.reduce((sum, l) => sum + Number(l.principal_amount ?? 0), 0);
      const totalRepaid = userRepayments.reduce((sum, r) => sum + Number(r.amount ?? 0), 0);

      const accountAgeDays = borrower.created_at
        ? Math.floor((Date.now() - new Date(borrower.created_at).getTime()) / (86400 * 1000))
        : 0;

      const stats: BorrowerRepaymentStats = {
        totalLoans: userLoans.length,
        completedLoans,
        onTimeRepayments: onTimeCount,
        earlyRepayments: earlyCount,
        lateRepayments: lateCount,
        defaultedLoans,
        totalBorrowedXlm: totalBorrowed,
        totalRepaidXlm: totalRepaid,
        kycVerified: borrower.kyc_status === "verified",
        emailVerified: true,
        accountAgeDays,
      };

      // 6. Compute new reputation score
      const result: BorrowerReputationResult = computeBorrowerReputationScore(stats);

      // 7. Persist snapshot
      const now = new Date().toISOString();
      const { error: upsertErr } = await supabase.from("reputation_snapshots").upsert(
        {
          user_id: borrower.id,
          score_total: result.score,
          tier: result.tier,
          score_breakdown: result.breakdown,
          updated_at: now,
        },
        { onConflict: "user_id" }
      );

      if (upsertErr) {
        console.error(`[Reputation Cron] Failed to upsert snapshot for ${borrower.id}:`, upsertErr);
        summary.errors++;
        continue;
      }

      // Check tier upgrade
      if (previousTier !== result.tier && result.score > previousScore) {
        summary.tierUpgrades++;

        // Log celebration event
        await supabase.from("reputation_events").insert({
          user_id: borrower.id,
          event_type: "tier_upgrade",
          points: result.score - previousScore,
          description: `Tier upgraded to ${result.tier}! Unlocked rate discount: ${result.rateDiscountPct}% APR.`,
          created_at: now,
        });
      }

      summary.updated++;
      summary.details.push({
        userId: borrower.id,
        walletAddress: borrower.wallet_address,
        previousScore,
        newScore: result.score,
        tier: result.tier,
        discountPct: result.rateDiscountPct,
      });
    } catch (err) {
      console.error(`[Reputation Cron] Error processing borrower ${borrower.id}:`, err);
      summary.errors++;
    }
  }

  return summary;
}
