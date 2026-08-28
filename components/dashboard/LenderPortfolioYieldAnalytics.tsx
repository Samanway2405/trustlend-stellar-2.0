"use client";

import { useState } from "react";
import { formatCurrency, formatXlmPrecise } from "@/lib/utils/formatting";
import type {
  LenderYieldAnalyticsResult,
  YieldDataPoint,
} from "@/lib/lender/yield-analytics";

interface Props {
  analytics: LenderYieldAnalyticsResult;
}

export function LenderPortfolioYieldAnalytics({ analytics }: Props) {
  const [activeTab, setActiveTab] = useState<"history" | "projection">("history");
  const [metricMode, setMetricMode] = useState<"apy" | "yield">("apy");
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const activePoints: YieldDataPoint[] =
    activeTab === "history"
      ? analytics.historicalYieldTrend
      : analytics.projectedYieldTrend;

  // Chart coordinate mapping
  const W = 1000;
  const H = 220;
  const paddingX = 40;
  const paddingY = 30;

  const currentValues = activePoints.map((p) =>
    metricMode === "apy" ? p.apy : p.cumulativeYield
  );
  const minVal = Math.min(...currentValues, 0);
  const maxVal = Math.max(...currentValues, metricMode === "apy" ? 20 : 100);
  const valRange = Math.max(1e-4, maxVal - minVal);

  const svgPoints = activePoints.map((p, i) => {
    const x =
      paddingX +
      (i / Math.max(1, activePoints.length - 1)) * (W - paddingX * 2);
    const v = metricMode === "apy" ? p.apy : p.cumulativeYield;
    const y =
      H - paddingY - ((v - minVal) / valRange) * (H - paddingY * 2);
    return { x, y, point: p, val: v };
  });

  let linePath = `M ${svgPoints[0]?.x ?? paddingX},${svgPoints[0]?.y ?? H / 2}`;
  for (let i = 1; i < svgPoints.length; i++) {
    const prev = svgPoints[i - 1];
    const curr = svgPoints[i];
    const cp1x = prev.x + (curr.x - prev.x) / 2;
    const cp1y = prev.y;
    const cp2x = prev.x + (curr.x - prev.x) / 2;
    const cp2y = curr.y;
    linePath += ` C ${cp1x},${cp1y} ${cp2x},${cp2y} ${curr.x},${curr.y}`;
  }

  const lastX = svgPoints[svgPoints.length - 1]?.x ?? W - paddingX;
  const firstX = svgPoints[0]?.x ?? paddingX;
  const areaPath = `${linePath} L ${lastX},${H - paddingY} L ${firstX},${H - paddingY} Z`;

  const primaryColor = activeTab === "history" ? "#22cf9d" : "#7e2fd0";

  return (
    <div className="workspace-stack" style={{ gap: "1.5rem" }}>
      {/* ── KPI Summary Cards ── */}
      <section className="workspace-grid workspace-grid--four" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem" }}>
        <article className="workspace-card" style={{ padding: "1.25rem" }}>
          <span style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280", fontWeight: 700 }}>
            Weighted Portfolio APY
          </span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, color: "#22cf9d", margin: "0.35rem 0 0.15rem" }}>
            {analytics.weightedAverageApy.toFixed(2)}%
          </p>
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
            Active capital weighted
          </span>
        </article>

        <article className="workspace-card" style={{ padding: "1.25rem" }}>
          <span style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280", fontWeight: 700 }}>
            Historical Yield Earned
          </span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, color: "#111827", margin: "0.35rem 0 0.15rem" }}>
            {analytics.totalHistoricalYield > 0 ? "+" : ""}{formatXlmPrecise(analytics.totalHistoricalYield)}
          </p>
          <span style={{ fontSize: "0.75rem", color: "#22cf9d", fontWeight: 600 }}>
            Across all pools &amp; loans
          </span>
        </article>

        <article className="workspace-card" style={{ padding: "1.25rem" }}>
          <span style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280", fontWeight: 700 }}>
            Projected 30-Day Yield
          </span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, color: "#7e2fd0", margin: "0.35rem 0 0.15rem" }}>
            +{formatCurrency(analytics.projected30DayYield)}
          </p>
          <span style={{ fontSize: "0.75rem", color: "#9ca3af" }}>
            ~{formatCurrency(analytics.projected90DayYield)} in 90 days
          </span>
        </article>

        <article className="workspace-card" style={{ padding: "1.25rem" }}>
          <span style={{ fontSize: "0.72rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#6b7280", fontWeight: 700 }}>
            Projected 1-Year Return
          </span>
          <p style={{ fontSize: "1.75rem", fontWeight: 800, color: "#111827", margin: "0.35rem 0 0.15rem" }}>
            +{formatCurrency(analytics.projectedAnnualYield)}
          </p>
          <span style={{ fontSize: "0.75rem", color: "#16a34a", fontWeight: 600 }}>
            Annualized run-rate
          </span>
        </article>
      </section>

      {/* ── Yield & APY Chart Card ── */}
      <article className="workspace-card workspace-card--full" style={{ padding: "1.5rem" }}>
        {/* Controls header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
          <div>
            <h2 className="workspace-card-title" style={{ margin: 0 }}>
              Yield &amp; APY Performance Over Time
            </h2>
            <p className="workspace-card-copy" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
              {activeTab === "history"
                ? "Historical APY performance and cumulative yield accrued across your positions."
                : "Projected cumulative earnings over the next 12 months based on your current deployment."}
            </p>
          </div>

          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            {/* Metric Mode Toggle */}
            <div style={{ display: "inline-flex", background: "#f3f4f6", padding: "0.2rem", borderRadius: "0.5rem" }}>
              <button
                type="button"
                onClick={() => setMetricMode("apy")}
                style={{
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.35rem",
                  border: "none",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: metricMode === "apy" ? "#fff" : "transparent",
                  color: metricMode === "apy" ? "#111827" : "#6b7280",
                  boxShadow: metricMode === "apy" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                APY (%)
              </button>
              <button
                type="button"
                onClick={() => setMetricMode("yield")}
                style={{
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.35rem",
                  border: "none",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: metricMode === "yield" ? "#fff" : "transparent",
                  color: metricMode === "yield" ? "#111827" : "#6b7280",
                  boxShadow: metricMode === "yield" ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}
              >
                Yield (XLM)
              </button>
            </div>

            {/* Tab Toggle */}
            <div style={{ display: "inline-flex", background: "#f3f4f6", padding: "0.2rem", borderRadius: "0.5rem" }}>
              <button
                type="button"
                onClick={() => setActiveTab("history")}
                style={{
                  padding: "0.35rem 0.85rem",
                  borderRadius: "0.35rem",
                  border: "none",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: activeTab === "history" ? "#22cf9d" : "transparent",
                  color: activeTab === "history" ? "#fff" : "#6b7280",
                  boxShadow: activeTab === "history" ? "0 1px 3px rgba(34,207,157,0.3)" : "none",
                }}
              >
                📈 Historical
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("projection")}
                style={{
                  padding: "0.35rem 0.85rem",
                  borderRadius: "0.35rem",
                  border: "none",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  cursor: "pointer",
                  background: activeTab === "projection" ? "#7e2fd0" : "transparent",
                  color: activeTab === "projection" ? "#fff" : "#6b7280",
                  boxShadow: activeTab === "projection" ? "0 1px 3px rgba(126,47,208,0.3)" : "none",
                }}
              >
                🔮 Projected
              </button>
            </div>
          </div>
        </div>

        {/* SVG Chart Area */}
        <div style={{ position: "relative", width: "100%", height: `${H}px`, marginTop: "1rem" }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            style={{ width: "100%", height: "100%", overflow: "visible" }}
            onMouseLeave={() => setHoveredIndex(null)}
          >
            <defs>
              <linearGradient id={`yield-gradient-${primaryColor}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={primaryColor} stopOpacity="0.25" />
                <stop offset="100%" stopColor={primaryColor} stopOpacity="0.0" />
              </linearGradient>
            </defs>

            {/* Grid lines */}
            {[0.25, 0.5, 0.75, 1].map((ratio) => {
              const y = paddingY + ratio * (H - paddingY * 2);
              return (
                <line
                  key={ratio}
                  x1={paddingX}
                  y1={y}
                  x2={W - paddingX}
                  y2={y}
                  stroke="#eef0f8"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
              );
            })}

            {/* Area fill */}
            <path d={areaPath} fill={`url(#yield-gradient-${primaryColor})`} />

            {/* Line curve */}
            <path
              d={linePath}
              fill="none"
              stroke={primaryColor}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Interactive Points */}
            {svgPoints.map((p, i) => (
              <g key={i}>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={16}
                  fill="transparent"
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHoveredIndex(i)}
                />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={hoveredIndex === i ? 6 : 4}
                  fill={hoveredIndex === i ? "#fff" : primaryColor}
                  stroke={primaryColor}
                  strokeWidth={hoveredIndex === i ? 3 : 2}
                  style={{ pointerEvents: "none", transition: "all 0.15s ease" }}
                />
              </g>
            ))}
          </svg>

          {/* Hover Tooltip */}
          {hoveredIndex !== null && svgPoints[hoveredIndex] && (
            <div
              style={{
                position: "absolute",
                top: "10px",
                right: "15px",
                background: "#fff",
                border: `1px solid ${primaryColor}40`,
                boxShadow: "0 6px 20px rgba(0,0,0,0.08)",
                padding: "0.6rem 0.9rem",
                borderRadius: "0.6rem",
                pointerEvents: "none",
                minWidth: "150px",
                zIndex: 10,
              }}
            >
              <p style={{ margin: "0 0 0.2rem", fontSize: "0.75rem", color: "#6b7280", fontWeight: 700 }}>
                {svgPoints[hoveredIndex].point.label}
              </p>
              <p style={{ margin: "0 0 0.15rem", fontSize: "1.05rem", fontWeight: 800, color: primaryColor }}>
                {metricMode === "apy"
                  ? `${svgPoints[hoveredIndex].point.apy.toFixed(2)}% APY`
                  : `${formatCurrency(svgPoints[hoveredIndex].point.cumulativeYield)} Yield`}
              </p>
              <p style={{ margin: 0, fontSize: "0.72rem", color: "#9ca3af" }}>
                Active Capital: {formatCurrency(svgPoints[hoveredIndex].point.deployedCapital)}
              </p>
            </div>
          )}
        </div>

        {/* X-axis labels */}
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.5rem", padding: `0 ${paddingX / 20}%` }}>
          {activePoints.map((p, idx) => (
            <span
              key={idx}
              style={{
                fontSize: "0.72rem",
                fontWeight: hoveredIndex === idx ? 700 : 500,
                color: hoveredIndex === idx ? primaryColor : "#9ca3af",
                transition: "color 0.15s ease",
              }}
            >
              {p.label.split(" ")[0]}
            </span>
          ))}
        </div>
      </article>

      {/* ── Earnings Breakdown by Lending Pool (Issue #256 Acceptance Criteria) ── */}
      <article className="workspace-card workspace-card--full" style={{ padding: "1.5rem" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.25rem", flexWrap: "wrap", gap: "0.75rem" }}>
          <div>
            <h2 className="workspace-card-title" style={{ margin: 0 }}>
              Earnings Breakdown by Lending Pool
            </h2>
            <p className="workspace-card-copy" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
              Detailed yield analysis, capital allocation, and projected earnings per individual liquidity pool.
            </p>
          </div>
          <span style={{ fontSize: "0.8rem", fontWeight: 700, color: "#22cf9d", background: "rgba(34,207,157,0.1)", padding: "0.25rem 0.75rem", borderRadius: "9999px" }}>
            {analytics.poolBreakdown.length} Pool{analytics.poolBreakdown.length !== 1 ? "s" : ""}
          </span>
        </div>

        {analytics.poolBreakdown.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem 1rem", color: "#6b7280" }}>
            <p style={{ margin: 0, fontSize: "0.9rem" }}>No active pool positions deployed yet.</p>
            <a href="/dashboard/lender/pools" style={{ display: "inline-block", marginTop: "0.75rem", color: "#22cf9d", fontWeight: 700, fontSize: "0.85rem" }}>
              Explore Available Pools →
            </a>
          </div>
        ) : (
          <div style={{ display: "grid", gap: "1rem" }}>
            {/* Pool Cards Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1rem" }}>
              {analytics.poolBreakdown.map((pool) => (
                <div
                  key={pool.poolId}
                  style={{
                    background: "rgba(255,255,255,0.7)",
                    border: "1px solid #eef0f8",
                    borderRadius: "0.75rem",
                    padding: "1.15rem",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.03)",
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "space-between",
                    gap: "0.9rem",
                  }}
                >
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.4rem" }}>
                      <div>
                        <strong style={{ fontSize: "0.95rem", color: "#111827" }}>{pool.poolName}</strong>
                        <p style={{ margin: "0.15rem 0 0", fontSize: "0.72rem", color: "#6b7280", fontFamily: "monospace" }}>
                          #{pool.poolId.slice(0, 8)}
                        </p>
                      </div>
                      <span
                        style={{
                          fontSize: "0.72rem",
                          fontWeight: 700,
                          padding: "0.15rem 0.5rem",
                          borderRadius: "9999px",
                          background: pool.status === "active" ? "rgba(34,207,157,0.12)" : "rgba(107,114,128,0.12)",
                          color: pool.status === "active" ? "#16a34a" : "#6b7280",
                        }}
                      >
                        {pool.status.toUpperCase()}
                      </span>
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem", marginTop: "0.6rem" }}>
                      <div>
                        <span style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>Pool APY</span>
                        <p style={{ margin: "0.1rem 0 0", fontWeight: 800, color: "#22cf9d", fontSize: "1.05rem" }}>
                          {pool.apyPct.toFixed(2)}%
                        </p>
                      </div>
                      <div>
                        <span style={{ fontSize: "0.7rem", color: "#6b7280", textTransform: "uppercase", fontWeight: 600 }}>Principal Deployed</span>
                        <p style={{ margin: "0.1rem 0 0", fontWeight: 800, color: "#111827", fontSize: "1.05rem" }}>
                          {formatCurrency(pool.principalDeployed)}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Earnings stats & share */}
                  <div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "0.3rem" }}>
                      <span style={{ color: "#6b7280" }}>Interest Earned:</span>
                      <strong style={{ color: "#22cf9d" }}>+{formatXlmPrecise(pool.earnedInterest)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "0.4rem" }}>
                      <span style={{ color: "#6b7280" }}>Projected Annual:</span>
                      <strong style={{ color: "#7e2fd0" }}>+{formatCurrency(pool.projectedAnnualEarnings)}/yr</strong>
                    </div>

                    {/* Progress Bar for Share of Portfolio */}
                    <div style={{ marginTop: "0.4rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.7rem", color: "#9ca3af", marginBottom: "0.2rem" }}>
                        <span>Share of Total Yield</span>
                        <span style={{ fontWeight: 700, color: "#111827" }}>{pool.shareOfTotalEarningsPct.toFixed(1)}%</span>
                      </div>
                      <div style={{ height: "6px", background: "#f3f4f6", borderRadius: "9999px", overflow: "hidden" }}>
                        <div
                          style={{
                            height: "100%",
                            width: `${Math.min(100, Math.max(5, pool.shareOfTotalEarningsPct))}%`,
                            background: "linear-gradient(90deg, #22cf9d, #7e2fd0)",
                            borderRadius: "9999px",
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Tabular summary */}
            <div className="workspace-table-wrap" style={{ marginTop: "0.75rem" }}>
              <table className="workspace-table" aria-label="Lending pool yield breakdown">
                <thead>
                  <tr>
                    <th>Pool Name</th>
                    <th>Status</th>
                    <th>Pool APY</th>
                    <th>Principal Deployed</th>
                    <th>Interest Earned</th>
                    <th>Projected Monthly</th>
                    <th>Projected Annual</th>
                    <th>Portfolio Share</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.poolBreakdown.map((pool) => (
                    <tr key={pool.poolId}>
                      <td>
                        <strong>{pool.poolName}</strong>
                        <span style={{ display: "block", fontSize: "0.72rem", color: "#6b7280", fontFamily: "monospace" }}>
                          #{pool.poolId.slice(0, 8)}
                        </span>
                      </td>
                      <td>
                        <span
                          style={{
                            padding: "0.15rem 0.5rem",
                            borderRadius: "9999px",
                            fontSize: "0.72rem",
                            fontWeight: 600,
                            background: pool.status === "active" ? "rgba(34,207,157,0.12)" : "rgba(107,114,128,0.12)",
                            color: pool.status === "active" ? "#16a34a" : "#6b7280",
                          }}
                        >
                          {pool.status.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700, color: "#22cf9d" }}>{pool.apyPct.toFixed(2)}%</td>
                      <td style={{ fontWeight: 600 }}>{formatCurrency(pool.principalDeployed)}</td>
                      <td style={{ color: "#22cf9d", fontWeight: 700 }}>+{formatXlmPrecise(pool.earnedInterest)}</td>
                      <td style={{ color: "#7e2fd0", fontWeight: 600 }}>+{formatCurrency(pool.projectedMonthlyEarnings)}</td>
                      <td style={{ fontWeight: 700 }}>+{formatCurrency(pool.projectedAnnualEarnings)}</td>
                      <td>
                        <span style={{ fontWeight: 700, color: "#111827" }}>{pool.shareOfTotalEarningsPct.toFixed(1)}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </article>
    </div>
  );
}
