import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { sendLoanFundedEmail } from "@/lib/email/resend";
import { getFundingProgress, validateFundingAmount } from "@/lib/loans/funding";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * POST /api/loans/fund
 *
 * Direct P2P lending with partial fills (Issue #269) — one loan request can be
 * filled by several lenders, each contributing a slice.
 *
 * Flow:
 *   1. Lender signs a Stellar payment to the BORROWER's wallet (client-side)
 *   2. Client sends the confirmed txHash and the amount funded
 *   3. record_loan_funding() atomically records the contribution and, once the
 *      contributions cover the principal, flips the loan to "active"
 *
 * Body: { loanId, txHash, lenderAddress, amount? }
 *   `amount` defaults to the full remaining balance, so a client that predates
 *   partial fills keeps working unchanged.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("lender");
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const body = await request.json();
    const { loanId, txHash, lenderAddress, amount } = body as {
      loanId: string;
      txHash: string;
      lenderAddress: string;
      amount?: number | string;
    };

    if (!loanId) {
      return NextResponse.json({ error: "loanId is required" }, { status: 400 });
    }
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json(
        { error: "A confirmed Stellar transaction hash is required" },
        { status: 400 }
      );
    }

    const normalizedTxHash = txHash.trim();

    // ── Replay guard ─────────────────────────────────────────────────────────
    // Dedupe on the transaction hash, not on the loan: a loan may legitimately
    // receive many contributions, but each Stellar payment is claimable once.
    const { data: existingFunding } = await supabase
      .from("loan_fundings")
      .select("id")
      .eq("tx_hash", normalizedTxHash)
      .maybeSingle();

    if (existingFunding) {
      return NextResponse.json(
        { error: "This transaction has already been recorded" },
        { status: 409 }
      );
    }

    // ── Fetch the loan ───────────────────────────────────────────────────────
    const { data: loan, error: fetchErr } = await supabase
      .from("loans")
      .select(
        "id, status, principal_amount, funded_amount, borrower_id, pool_id, apr_bps, duration_days"
      )
      .eq("id", loanId)
      .maybeSingle();

    if (fetchErr) {
      // A database that has not had sql/08_partial_loan_fills.sql applied has
      // no funded_amount column; say so instead of reporting "Loan not found".
      if (String(fetchErr.message ?? "").includes("funded_amount")) {
        return NextResponse.json(
          {
            error:
              "Partial-fill columns are not installed in this database yet. Apply sql/08_partial_loan_fills.sql in Supabase, then retry funding.",
          },
          { status: 500 }
        );
      }

      return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    }

    if (!loan) {
      return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    }

    const fundableStatuses = ["requested", "approved"];
    if (!fundableStatuses.includes(String(loan.status))) {
      return NextResponse.json(
        { error: `Loan is not available for funding (status: ${loan.status})` },
        { status: 409 }
      );
    }

    // ── Prevent lender from funding their own loan ────────────────────────────
    if (String(loan.borrower_id) === String(user.id)) {
      return NextResponse.json(
        { error: "You cannot fund your own loan" },
        { status: 400 }
      );
    }

    // ── Resolve and validate the contribution ────────────────────────────────
    const progressBefore = getFundingProgress(
      loan.principal_amount,
      loan.funded_amount
    );

    if (progressBefore.isFullyFunded) {
      return NextResponse.json(
        { error: "This loan is already fully funded" },
        { status: 409 }
      );
    }

    // Omitting `amount` means "fill the rest", preserving the pre-#269 contract.
    const requestedAmount = amount ?? progressBefore.remaining;
    const validation = validateFundingAmount(
      requestedAmount,
      progressBefore.remaining
    );

    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Round to Stellar's 7-decimal precision before it reaches Postgres.
    // `principal - funded` in JS floats can land a fraction above the exact
    // numeric(20,6) remainder, which the RPC would reject as overfunding.
    const contribution = Number(validation.amount.toFixed(7));
    const now = new Date().toISOString();

    // ── Record the contribution atomically ───────────────────────────────────
    // The RPC locks the loan row, so concurrent lenders cannot both read the
    // same remaining balance and collectively overfund the loan.
    const { data: fundingResult, error: rpcErr } = await supabase.rpc(
      "record_loan_funding",
      {
        p_loan_id: loanId,
        p_lender_id: user.id,
        p_amount: contribution,
        p_tx_hash: normalizedTxHash,
        p_lender_address: lenderAddress ?? null,
        p_funded_at: now,
      }
    );

    if (rpcErr) {
      const message = String(rpcErr.message ?? "");

      if (message.includes("Could not find the function public.record_loan_funding")) {
        return NextResponse.json(
          {
            error:
              "Partial-fill funding RPC is not installed in this database yet. Apply sql/08_partial_loan_fills.sql in Supabase, then retry funding.",
          },
          { status: 500 }
        );
      }

      // The tx_hash unique index is the authoritative replay guard. The
      // pre-check above can miss a duplicate recorded by a *different* lender,
      // whose row RLS hides from this caller.
      if (
        message.includes("idx_loan_fundings_tx_hash") ||
        message.includes("duplicate key value")
      ) {
        return NextResponse.json(
          { error: "This transaction has already been recorded" },
          { status: 409 }
        );
      }

      // The RPC raises for the race-condition cases: another lender took the
      // remaining balance between our read and our write.
      if (
        message.includes("already fully funded") ||
        message.includes("exceeds the remaining") ||
        message.includes("not available for funding")
      ) {
        return NextResponse.json({ error: message }, { status: 409 });
      }

      return NextResponse.json({ error: message }, { status: 500 });
    }

    // The RPC returns a single-row table.
    const result = Array.isArray(fundingResult) ? fundingResult[0] : fundingResult;
    const progressAfter = getFundingProgress(
      result?.principal_amount ?? loan.principal_amount,
      result?.funded_amount ?? progressBefore.funded + contribution
    );
    const isFullyFunded = Boolean(result?.is_fully_funded ?? progressAfter.isFullyFunded);

    // ── Record in ledger with full transparency info ──────────────────────────
    await supabase.from("ledger_transactions").insert({
      user_id: user.id, // the lender
      category: "loan_fund",
      amount: contribution,
      currency: "XLM",
      status: "confirmed",
      ref_type: "loan_fund",
      ref_id: loanId,
      metadata: JSON.stringify({
        txHash: normalizedTxHash,
        lenderAddress,
        lenderUserId: user.id,
        borrowerId: String(loan.borrower_id),
        loanId,
        contributionAmount: contribution,
        principalAmount: loan.principal_amount,
        fundedAmountAfter: progressAfter.funded,
        remainingAfter: progressAfter.remaining,
        isFullyFunded,
        aprBps: loan.apr_bps,
        durationDays: loan.duration_days,
        fundedAt: now,
      }),
    });

    // ── Emit notifications ──
    const { createNotification } = await import("@/lib/notifications");
    const percentLabel = `${Math.round(progressAfter.percent)}%`;

    if (isFullyFunded) {
      // Notify Borrower — the loan is live and the money is on its way.
      await createNotification({
        userId: String(loan.borrower_id),
        title: "Loan Fully Funded!",
        message: `Great news! Your loan of ${progressAfter.principal} XLM is now 100% funded and active. The funds have been sent to your wallet.`,
        type: "loan_funded",
      });
      await sendLoanFundedEmail({
        userId: String(loan.borrower_id),
        amount: progressAfter.principal,
        loanId,
      });
    } else {
      // Partial fill — tell the borrower how far along the request is.
      await createNotification({
        userId: String(loan.borrower_id),
        title: "Loan Partially Funded",
        message: `A lender contributed ${contribution} XLM to your loan request. It is now ${percentLabel} funded — ${progressAfter.remaining.toFixed(2)} XLM still needed to activate it.`,
        type: "loan_funded",
      });
    }

    // Notify Lender
    await createNotification({
      userId: user.id,
      title: "Funding Successful",
      message: isFullyFunded
        ? `You contributed ${contribution} XLM and completed this loan's funding. View 'Loans You Funded' for details.`
        : `You contributed ${contribution} XLM. The loan is now ${percentLabel} funded.`,
      type: "investment_made",
    });

    return NextResponse.json(
      {
        loanId,
        status: String(result?.status ?? loan.status),
        txHash: normalizedTxHash,
        amountFunded: contribution,
        principalAmount: progressAfter.principal,
        fundedAmount: progressAfter.funded,
        remainingAmount: progressAfter.remaining,
        fundedPercent: progressAfter.percent,
        isFullyFunded,
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${normalizedTxHash}`,
        message: isFullyFunded
          ? "Loan fully funded and activated. The borrower will receive XLM in their wallet."
          : `Contribution recorded. This loan is now ${percentLabel} funded.`,
      },
      { status: 200 }
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Loan funding error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
