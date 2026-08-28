"use client";

import { BorrowerReputationResult } from "@/lib/reputation/scoring";
import { formatTokenBalance } from "@/lib/utils/formatting";

interface BorrowerReputationCardProps {
  reputation: BorrowerReputationResult;
  updatedAt?: string | null;
}

const TIER_COLORS: Record<string, { primary: string; bg: string; border: string; glow: string }> = {
  None: {
    primary: "#6b7280",
    bg: "rgba(107, 114, 128, 0.08)",
    border: "rgba(107, 114, 128, 0.25)",
    glow: "rgba(107, 114, 128, 0.15)",
  },
  Beginner: {
    primary: "#d97706",
    bg: "rgba(217, 119, 6, 0.08)",
    border: "rgba(217, 119, 6, 0.25)",
    glow: "rgba(217, 119, 6, 0.15)",
  },
  Silver: {
    primary: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.12)",
    border: "rgba(148, 163, 184, 0.3)",
    glow: "rgba(148, 163, 184, 0.2)",
  },
  Gold: {
    primary: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.1)",
    border: "rgba(245, 158, 11, 0.35)",
    glow: "rgba(245, 158, 11, 0.25)",
  },
  Platinum: {
    primary: "#7e2fd0",
    bg: "rgba(126, 47, 208, 0.12)",
    border: "rgba(126, 47, 208, 0.35)",
    glow: "rgba(126, 47, 208, 0.25)",
  },
};

export function BorrowerReputationCard({
  reputation,
  updatedAt,
}: BorrowerReputationCardProps) {
  const {
    score,
    tier,
    tierLabel,
    interestRatePct,
    rateDiscountPct,
    maxLoanXlm,
    onTimePercentage,
    breakdown,
    nextTier,
  } = reputation;

  const colors = TIER_COLORS[tierLabel] ?? TIER_COLORS.None;
  const scorePct = Math.min(100, Math.max(0, (score / 1000) * 100));

  // Circular gauge parameters
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (scorePct / 100) * circumference;

  return (
    <article
      className="workspace-card workspace-card--full"
      style={{
        background: "linear-gradient(135deg, rgba(255, 255, 255, 0.95) 0%, rgba(249, 250, 251, 0.95) 100%)",
        border: `1px solid ${colors.border}`,
        borderRadius: "1rem",
        boxShadow: `0 8px 30px ${colors.glow}`,
        padding: "1.5rem",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "1rem" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span
              style={{
                fontSize: "0.75rem",
                fontWeight: 700,
                padding: "0.2rem 0.6rem",
                borderRadius: "9999px",
                background: colors.bg,
                color: colors.primary,
                border: `1px solid ${colors.border}`,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              ⭐ {tierLabel} Tier
            </span>
            <span
              style={{
                fontSize: "0.72rem",
                color: "#16a34a",
                background: "rgba(22, 163, 74, 0.08)",
                padding: "0.2rem 0.5rem",
                borderRadius: "9999px",
                fontWeight: 600,
              }}
            >
              🔄 Calculated Daily
            </span>
          </div>
          <h2 style={{ fontSize: "1.35rem", fontWeight: 800, margin: "0.4rem 0 0", color: "#111827" }}>
            Borrower Reputation Score
          </h2>
          <p style={{ fontSize: "0.85rem", color: "#6b7280", margin: "0.2rem 0 0" }}>
            Your credit score is calculated daily based on on-chain Stellar repayments to unlock better loan rates.
          </p>
        </div>

        {updatedAt && (
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
            Last computed: {new Date(updatedAt).toLocaleDateString()}
          </span>
        )}
      </div>

      <hr style={{ margin: "1.25rem 0", borderColor: "rgba(17, 24, 39, 0.06)" }} />

      {/* ── Main Score & Benefits Section ── */}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2rem", alignItems: "center" }}>
        {/* Circular Score Gauge */}
        <div style={{ position: "relative", width: "130px", height: "130px", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="130" height="130" viewBox="0 0 130 130" style={{ transform: "rotate(-90deg)" }}>
            {/* Background Track */}
            <circle
              cx="65"
              cy="65"
              r={radius}
              fill="transparent"
              stroke="#e5e7eb"
              strokeWidth="10"
            />
            {/* Progress Stroke */}
            <circle
              cx="65"
              cy="65"
              r={radius}
              fill="transparent"
              stroke={colors.primary}
              strokeWidth="10"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              strokeLinecap="round"
              style={{ transition: "stroke-dashoffset 0.8s ease" }}
            />
          </svg>
          <div style={{ position: "absolute", textAlign: "center" }}>
            <span style={{ fontSize: "1.85rem", fontWeight: 900, color: "#111827", lineHeight: 1 }}>
              {score}
            </span>
            <span style={{ display: "block", fontSize: "0.68rem", color: "#6b7280", fontWeight: 600, marginTop: "0.1rem" }}>
              / 1000 PTS
            </span>
          </div>
        </div>

        {/* Unlocked Rate & Credit Limit */}
        <div style={{ display: "grid", gap: "0.75rem" }}>
          {/* Rate Discount Highlight Box */}
          <div
            style={{
              padding: "0.85rem 1.1rem",
              borderRadius: "0.75rem",
              background: "linear-gradient(135deg, rgba(34, 207, 157, 0.1) 0%, rgba(126, 47, 208, 0.08) 100%)",
              border: "1px solid rgba(34, 207, 157, 0.3)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span style={{ fontSize: "1.1rem" }}>🎉</span>
                <strong style={{ fontSize: "0.95rem", color: "#111827" }}>
                  Your Unlocked Borrow Rate: {interestRatePct.toFixed(2)}% APR
                </strong>
              </div>
              <p style={{ margin: "0.15rem 0 0 1.5rem", fontSize: "0.78rem", color: "#059669", fontWeight: 600 }}>
                {rateDiscountPct > 0
                  ? `⚡ Includes ${rateDiscountPct.toFixed(2)}% APR Repayment Discount (Standard: 15.00%)`
                  : "Maintain on-time repayments to unlock up to 7.00% APR interest discount"}
              </p>
            </div>

            <div style={{ textAlign: "right" }}>
              <span style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
                Max Credit Limit
              </span>
              <p style={{ margin: 0, fontSize: "1.1rem", fontWeight: 800, color: "#7e2fd0" }}>
                {formatTokenBalance(maxLoanXlm)}
              </p>
            </div>
          </div>

          {/* Next Tier Upgrade Milestone */}
          {nextTier && (
            <div
              style={{
                padding: "0.65rem 0.9rem",
                borderRadius: "0.6rem",
                background: "rgba(126, 47, 208, 0.04)",
                border: "1px solid rgba(126, 47, 208, 0.15)",
                fontSize: "0.8rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span style={{ color: "#4b5563" }}>
                🎯 Earn <strong>{nextTier.pointsNeeded} more points</strong> to unlock <strong>{nextTier.tier} Tier</strong> ({nextTier.unlockedRatePct.toFixed(2)}% APR rate).
              </span>
              <span style={{ fontWeight: 700, color: "#7e2fd0", whiteSpace: "nowrap" }}>
                {nextTier.minScore} pts needed
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Score Performance & Breakdown Matrix ── */}
      <div
        style={{
          marginTop: "1.25rem",
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <div style={{ padding: "0.75rem", borderRadius: "0.6rem", background: "rgba(17, 24, 39, 0.02)", border: "1px solid rgba(17, 24, 39, 0.06)" }}>
          <span style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
            On-Time Settlement Rate
          </span>
          <p style={{ margin: "0.2rem 0 0", fontSize: "1.1rem", fontWeight: 800, color: onTimePercentage >= 90 ? "#10b981" : "#f59e0b" }}>
            {onTimePercentage}%
          </p>
          <span style={{ fontSize: "0.72rem", color: "#10b981", fontWeight: 600 }}>
            +{breakdown.onTimeBonus + breakdown.earlyPayoffBonus} pts earned
          </span>
        </div>

        <div style={{ padding: "0.75rem", borderRadius: "0.6rem", background: "rgba(17, 24, 39, 0.02)", border: "1px solid rgba(17, 24, 39, 0.06)" }}>
          <span style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
            Repaid Volume Bonus
          </span>
          <p style={{ margin: "0.2rem 0 0", fontSize: "1.1rem", fontWeight: 800, color: "#7e2fd0" }}>
            +{breakdown.volumeBonus} pts
          </p>
          <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
            Based on settled loan volume
          </span>
        </div>

        <div style={{ padding: "0.75rem", borderRadius: "0.6rem", background: "rgba(17, 24, 39, 0.02)", border: "1px solid rgba(17, 24, 39, 0.06)" }}>
          <span style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
            KYC &amp; Identity Standing
          </span>
          <p style={{ margin: "0.2rem 0 0", fontSize: "1.1rem", fontWeight: 800, color: breakdown.kycBonus > 0 ? "#10b981" : "#6b7280" }}>
            +{breakdown.kycBonus} pts
          </p>
          <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
            Government ID &amp; Email verified
          </span>
        </div>

        <div style={{ padding: "0.75rem", borderRadius: "0.6rem", background: "rgba(17, 24, 39, 0.02)", border: "1px solid rgba(17, 24, 39, 0.06)" }}>
          <span style={{ fontSize: "0.72rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>
            Deductions &amp; Penalties
          </span>
          <p style={{ margin: "0.2rem 0 0", fontSize: "1.1rem", fontWeight: 800, color: breakdown.latePenalty + breakdown.defaultPenalty > 0 ? "#ef4444" : "#10b981" }}>
            -{breakdown.latePenalty + breakdown.defaultPenalty} pts
          </p>
          <span style={{ fontSize: "0.72rem", color: "#6b7280" }}>
            {breakdown.latePenalty + breakdown.defaultPenalty === 0 ? "Clean track record" : "Late payments / defaults"}
          </span>
        </div>
      </div>
    </article>
  );
}
