import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { getLoanLenders } from "@/lib/loans/lenders";
import { splitRepaymentAcrossLenders } from "@/lib/loans/funding";
import { isRedirectError } from "next/dist/client/components/redirect-error";

interface RepayPayload {
  loanId: string;
  amount: number;       // total amount borrower is paying this time
  txHash: string;       // Stellar confirmed hash
  borrowerAddress: string;
}

export async function POST(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser("borrower");
    const { loanId, amount, txHash, borrowerAddress } = (await request.json()) as RepayPayload;

    if (!loanId || !amount || amount <= 0 || !Number.isFinite(amount)) {
      return NextResponse.json({ error: "Invalid request data" }, { status: 400 });
    }
    if (!txHash || txHash.trim().length < 10) {
      return NextResponse.json({ error: "A confirmed Stellar transaction hash is required for on-chain repayment" }, { status: 400 });
    }

    const supabase = await getServerSupabaseClient();
    const srClient = getServiceRoleClient();
    if (!supabase || !srClient) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    // Double-check borrower & loan
    const { data: loan, error: loanError } = await supabase
      .from("loans")
      .select("id, borrower_id, status, repaid_amount, principal_amount, apr_bps, duration_days")
      .eq("id", loanId)
      .eq("borrower_id", user.id)
      .single();

    if (loanError || !loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 });
    if (loan.status === "repaid") return NextResponse.json({ error: "Loan is already fully repaid" }, { status: 400 });
    if (loan.status === "defaulted") return NextResponse.json({ error: "Loan is in default" }, { status: 400 });

    // Prevent duplicate txHash
    const { data: existingTx } = await srClient
      .from("ledger_transactions")
      .select("id")
      .eq("ref_type", "loan_repay")
      .ilike("metadata->>txHash", txHash) // check if JSON contains this hash
      .maybeSingle();

    if (existingTx) {
      return NextResponse.json({ error: "This transaction hash has already been recorded" }, { status: 409 });
    }

    // Figure out every lender to notify. A loan can be funded by several
    // lenders (Issue #269), each owed a pro-rata slice of this repayment.
    const lenders = await getLoanLenders(srClient, loanId);
    const primaryLender = lenders[0];
    const lenderUserId = primaryLender?.lenderId ?? "";
    const lenderAddress = primaryLender?.address ?? "";
    const lenderPayouts = splitRepaymentAcrossLenders(amount, lenders);

    // Create repayment record in DB
    const { data: repayment, error: repaymentError } = await srClient
      .from("loan_repayments")
      .insert({
        loan_id: loanId,
        payer_id: user.id,
        amount: amount,
        tx_ref: txHash,
      })
      .select()
      .single();

    if (repaymentError) return NextResponse.json({ error: repaymentError.message }, { status: 500 });

    // Calculate updated balances
    const newRepaidAmount = (loan.repaid_amount || 0) + amount;
    
    // Total due calculation matches preflight
    const principal    = Number(loan.principal_amount ?? 0);
    const durationDays = Number(loan.duration_days ?? 30);
    const aprBps       = Number(loan.apr_bps ?? 0);
    const totalInterest= principal * (aprBps / 10000) * (durationDays / 365);
    const platformFee  = principal * 0.01;
    const totalDue     = principal + totalInterest + platformFee;

    let newStatus = loan.status === "funded" ? "active" : loan.status;
    // adding a small tolerance for floating point rounding issues
    if (newRepaidAmount >= totalDue - 0.0001) {
      newStatus = "repaid";
    } else if (newStatus !== "active") {
      newStatus = "active";
    }

    const { error: updateError } = await srClient
      .from("loans")
      .update({
        repaid_amount: newRepaidAmount,
        status: newStatus,
      })
      .eq("id", loanId);

    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });

    // Record on Ledger
    await srClient.from("ledger_transactions").insert({
      user_id: user.id, // the borrower
      category: "loan_repay",
      amount: amount,
      currency: "XLM",
      status: "confirmed",
      ref_type: "loan_repay",
      ref_id: repayment.id, // link to the repayment record
      metadata: JSON.stringify({
        txHash,
        borrowerAddress,
        lenderAddress,
        lenderUserId,
        // Full pro-rata breakdown so each lender's share of this repayment is
        // auditable after the fact (Issue #269).
        lenderPayouts: lenderPayouts.map((entry) => ({
          lenderUserId: entry.lenderId,
          address: entry.address,
          share: +entry.share.toFixed(7),
          payout: entry.payout,
        })),
        loanId,
        repaymentId: repayment.id,
        principalAmount: loan.principal_amount,
        repaidSoFar: newRepaidAmount,
        repaidAt: new Date().toISOString(),
      }),
    });

    // Add reputation points
    const repayPoints = newStatus === "repaid" ? 20 : 5;
    await srClient.from("reputation_events").insert({
      user_id:      user.id,
      source_type:  "loan_repayment",
      source_id:    loanId,
      points_delta: repayPoints,
      reason:       `On-chain repayment of ${amount.toFixed(2)} XLM`,
    });

    // Notifications
    const { createNotification } = await import("@/lib/notifications");
    await createNotification({
      userId: user.id,
      title: "Repayment Successful",
      message: `You successfully repaid ${amount.toFixed(2)} XLM on-chain. Status: ${newStatus}`,
      type: "loan_repaid",
    });

    // Notify every lender with the slice that reached them.
    for (const entry of lenderPayouts) {
      if (!entry.lenderId) continue;

      await createNotification({
        userId: entry.lenderId,
        title: "Loan Repayment Received",
        message:
          lenderPayouts.length > 1
            ? `The borrower repaid ${amount.toFixed(2)} XLM on-chain. Your share (${(entry.share * 100).toFixed(1)}% of this loan) is ${entry.payout.toFixed(2)} XLM.`
            : `The borrower has repaid ${amount.toFixed(2)} XLM towards their loan on-chain!`,
        type: "loan_repaid",
      });
    }

    return NextResponse.json({ repayment, loanStatus: newStatus, txHash }, { status: 201 });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("Repayment error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
