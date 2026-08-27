import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { buildReferralLink } from "@/lib/referrals/codes";
import { resolveSiteUrl } from "@/lib/referrals/site-url";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * GET /api/referrals
 *
 * Returns the signed-in user's referral link plus their programme stats
 * (Issue #266). The code is created on demand via ensure_referral_code(), so a
 * user who predates the referral migration gets one on first visit rather than
 * seeing an empty state.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimitResponse = await enforceRouteRateLimit(request);
    if (rateLimitResponse) {
      return rateLimitResponse;
    }

    const { user } = await requireAuthenticatedUser();
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // Guarantees a code exists before we try to build a link from it.
    const { data: code, error: codeError } = await supabase.rpc(
      "ensure_referral_code",
      { p_user_id: user.id },
    );

    if (codeError || !code) {
      console.error("Referral code assignment failed:", codeError?.message);
      return NextResponse.json(
        { error: "Could not prepare your referral code" },
        { status: 500 },
      );
    }

    const { data: statsRows, error: statsError } = await supabase.rpc(
      "get_referral_stats",
      { p_user_id: user.id },
    );

    if (statsError) {
      console.error("Referral stats lookup failed:", statsError.message);
      return NextResponse.json(
        { error: "Could not load your referral stats" },
        { status: 500 },
      );
    }

    const stats = Array.isArray(statsRows) ? statsRows[0] : statsRows;

    // The invited-user list is read directly; RLS restricts it to rows where
    // the caller is the referrer.
    const { data: referrals } = await supabase
      .from("referrals")
      .select("id, status, bonus_amount, created_at, qualified_at, paid_at")
      .eq("referrer_id", user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    return NextResponse.json(
      {
        referralCode: String(code),
        referralLink: buildReferralLink(String(code), resolveSiteUrl(request)),
        stats: {
          totalInvited: Number(stats?.total_invited ?? 0),
          pending: Number(stats?.pending_count ?? 0),
          qualified: Number(stats?.qualified_count ?? 0),
          paid: Number(stats?.paid_count ?? 0),
          totalEarned: Number(stats?.total_earned ?? 0),
        },
        referrals: (referrals ?? []).map((r) => ({
          id: String(r.id),
          status: String(r.status),
          bonusAmount: Number(r.bonus_amount ?? 0),
          invitedAt: r.created_at,
          qualifiedAt: r.qualified_at,
          paidAt: r.paid_at,
        })),
      },
      { status: 200 },
    );
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }
    console.error("Referral fetch error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
