import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { requireKycVerified } from "@/lib/kyc/middleware";

/**
 * POST /api/pools/sep31-deposit
 *
 * Body: { poolId, amount, currency, anchorTxId, instructions, lenderAddress }
 *
 * Records an initiated SEP-31 deposit as a 'pending' transaction in the ledger.
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

    // Require KYC verification for lenders using fiat rails
    const kycCheck = await requireKycVerified(user.id, supabase, { regulatedPoolOnly: true });
    if (!kycCheck.allowed) {
      return NextResponse.json(
        { error: kycCheck.reason, kycStatus: kycCheck.kycStatus },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { poolId, amount, currency, anchorTxId, instructions, lenderAddress } = body as {
      poolId: string;
      amount: number;
      currency: string;
      anchorTxId: string;
      instructions: Record<string, unknown>;
      lenderAddress?: string;
    };

    if (!poolId || !amount || amount <= 0 || !currency || !anchorTxId || !instructions) {
      return NextResponse.json({ error: "Invalid request parameters" }, { status: 400 });
    }

    // Verify pool exists and is active
    const { data: pool, error: poolError } = await supabase
      .from("lending_pools")
      .select("id, status")
      .eq("id", poolId)
      .eq("status", "active")
      .single();

    if (poolError || !pool) {
      return NextResponse.json({ error: "Pool not found or inactive" }, { status: 404 });
    }

    // Prevent duplicate recording of the same anchor transaction
    const { data: existingTx } = await supabase
      .from("ledger_transactions")
      .select("id")
      .eq("metadata->>anchorTxId", anchorTxId)
      .maybeSingle();

    if (existingTx) {
      return NextResponse.json(
        { error: "This transaction has already been recorded" },
        { status: 409 }
      );
    }

    // Record the pending deposit ledger entry
    const { data: transaction, error: txError } = await supabase
      .from("ledger_transactions")
      .insert({
        user_id: user.id,
        category: "deposit",
        amount,
        currency,
        status: "pending",
        ref_type: "pool_position",
        ref_id: null, // pool_position is created asynchronously upon webhook confirmation
        metadata: JSON.stringify({
          anchorTxId,
          instructions,
          poolId,
          lenderAddress: lenderAddress ?? null,
          isSep31: true,
        }),
      })
      .select()
      .single();

    if (txError) {
      return NextResponse.json({ error: txError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, transaction });
  } catch (error) {
    console.error("Failed to record SEP-31 deposit:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
