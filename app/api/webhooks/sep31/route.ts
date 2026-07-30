import { NextRequest, NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { discoverSep31Anchor, verifyAnchorSignature } from "@/lib/stellar/sep31";

/**
 * POST /api/webhooks/sep31
 *
 * Webhook callback handler from the SEP-31 Anchor.
 * Automatically processes status updates, verifies the signature, and updates pool positions.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const body = JSON.parse(rawBody);

    const txPayload = body.transaction ?? body;
    const { id: anchorTxId, status, stellar_transaction_id, message } = txPayload as {
      id: string;
      status: string;
      stellar_transaction_id?: string;
      message?: string;
    };

    if (!anchorTxId || !status) {
      return NextResponse.json({ error: "Invalid webhook payload" }, { status: 400 });
    }

    const supabase = getServiceRoleClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // Find the matching pending transaction in the ledger
    const { data: ledgerTx, error: dbError } = await supabase
      .from("ledger_transactions")
      .select("id, user_id, amount, status, metadata")
      .eq("metadata->>anchorTxId", anchorTxId)
      .maybeSingle();

    if (dbError || !ledgerTx) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    }

    // Webhook signature verification
    const sigHeader =
      request.headers.get("x-stellar-signature") ||
      request.headers.get("signature") ||
      request.headers.get("X-Stellar-Signature");

    const homeDomain = process.env.NEXT_PUBLIC_SEP24_ANCHOR_HOME_DOMAIN ?? "testanchor.stellar.org";
    const isTestnet = (process.env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE ?? "").includes("Test");

    if (sigHeader) {
      try {
        let signingKey = process.env.SEP31_ANCHOR_SIGNING_KEY;
        if (!signingKey) {
          const endpoints = await discoverSep31Anchor(homeDomain);
          signingKey = endpoints.signingKey;
        }

        const isValid = await verifyAnchorSignature(rawBody, sigHeader, signingKey);
        if (!isValid) {
          return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
        }
      } catch (err) {
        console.error("Webhook signature verification failed:", err);
        return NextResponse.json({ error: "Signature verification processing failed" }, { status: 400 });
      }
    } else if (!isTestnet) {
      // In production/mainnet, require a valid signature
      return NextResponse.json({ error: "Signature header missing" }, { status: 401 });
    }

    // If transaction is already processed, return 200 OK
    if (ledgerTx.status !== "pending") {
      return NextResponse.json({ success: true, message: "Transaction already processed" });
    }

    const metadata = typeof ledgerTx.metadata === "string"
      ? JSON.parse(ledgerTx.metadata)
      : ledgerTx.metadata || {};

    const { poolId } = metadata as { poolId: string };

    // ── Handle Payment Lifecycle ──────────────────────────────────────────────────
    if (status === "completed") {
      // 1. Check if lender already has an active position in this pool
      const { data: existingPosition } = await supabase
        .from("pool_positions")
        .select("id, principal_amount")
        .eq("pool_id", poolId)
        .eq("lender_id", ledgerTx.user_id)
        .eq("status", "active")
        .maybeSingle();

      let positionId = "";
      const depositAmount = Number(ledgerTx.amount);

      if (existingPosition) {
        // Update existing position amount
        const { data: updatedPosition, error: updateError } = await supabase
          .from("pool_positions")
          .update({
            principal_amount: Number(existingPosition.principal_amount ?? 0) + depositAmount,
          })
          .eq("id", existingPosition.id)
          .select("id")
          .single();

        if (updateError) throw updateError;
        positionId = updatedPosition.id;
      } else {
        // Create new active position
        const { data: newPosition, error: insertError } = await supabase
          .from("pool_positions")
          .insert({
            pool_id: poolId,
            lender_id: ledgerTx.user_id,
            principal_amount: depositAmount,
            status: "active",
            opened_at: new Date().toISOString(),
          })
          .select("id")
          .single();

        if (insertError) throw insertError;
        positionId = newPosition.id;
      }

      // 2. Fetch current pool liquidity and update it
      const { data: pool, error: poolError } = await supabase
        .from("lending_pools")
        .select("total_liquidity, available_liquidity")
        .eq("id", poolId)
        .single();

      if (poolError) throw poolError;

      const { error: poolUpdateError } = await supabase
        .from("lending_pools")
        .update({
          total_liquidity: Number(pool.total_liquidity ?? 0) + depositAmount,
          available_liquidity: Number(pool.available_liquidity ?? 0) + depositAmount,
        })
        .eq("id", poolId);

      if (poolUpdateError) throw poolUpdateError;

      // 3. Confirm the ledger transaction and associate with the position
      const updatedMetadata = {
        ...metadata,
        stellarTxHash: stellar_transaction_id ?? null,
        anchorStatus: status,
      };

      const { error: txConfirmError } = await supabase
        .from("ledger_transactions")
        .update({
          status: "confirmed",
          ref_id: positionId,
          metadata: updatedMetadata,
        })
        .eq("id", ledgerTx.id);

      if (txConfirmError) throw txConfirmError;

    } else if (status === "error" || status === "refunded") {
      // Compliance check failed or transaction was refunded
      const updatedMetadata = {
        ...metadata,
        anchorStatus: status,
        failureMessage: message ?? "Compliance check or payment failed at anchor",
        refunded: status === "refunded",
      };

      const { error: txFailError } = await supabase
        .from("ledger_transactions")
        .update({
          status: "failed",
          metadata: updatedMetadata,
        })
        .eq("id", ledgerTx.id);

      if (txFailError) throw txFailError;
    } else {
      // For intermediate statuses (like pending_stellar, pending_sender, hold),
      // we update the anchorStatus in metadata to track live progress.
      const updatedMetadata = {
        ...metadata,
        anchorStatus: status,
      };

      await supabase
        .from("ledger_transactions")
        .update({
          metadata: updatedMetadata,
        })
        .eq("id", ledgerTx.id);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to process SEP-31 webhook:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
