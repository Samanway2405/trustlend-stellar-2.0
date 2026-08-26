"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { StellarSignInButton } from "@/components/auth/StellarSignInButton";
import { type UserRole } from "@/lib/auth/roles";

type AuthSelectableRole = "borrower" | "lender";

const ROLE_META: Record<UserRole, { label: string; emoji: string; tagline: string; color: string }> = {
  borrower: {
    label: "Borrower",
    emoji: "💸",
    tagline: "Access micro-loans built on your real financial behavior",
    color: "var(--purple)",
  },
  lender: {
    label: "Lender",
    emoji: "📈",
    tagline: "Earn transparent returns by funding verified borrowers",
    color: "#22cf9d",
  },
  admin: {
    label: "Admin",
    emoji: "🛡️",
    tagline: "Manage platform operations and verify users",
    color: "#ef4444",
  },
};

export function AuthPageClient() {
  const router = useRouter();
  const [role, setRole] = useState<AuthSelectableRole | null>(null);

  const meta = role ? ROLE_META[role] : null;

  return (
    <main className="auth-page-shell">
      {/* Left panel — branding */}
      <div className="auth-page-left" aria-hidden="true">
        <div className="auth-page-left-inner">
          <Link href="/" className="auth-page-logo">
            <span className="site-logo-orb" />
            <span className="font-display auth-page-logo-text">TrustLend</span>
          </Link>

          <div className="auth-page-left-body">
            {role ? (
              <>
                <div className="auth-page-role-badge" style={{ background: role === "lender" ? "rgba(34,207,157,0.12)" : "rgba(127,47,209,0.12)", borderColor: role === "lender" ? "rgba(34,207,157,0.35)" : "rgba(127,47,209,0.35)" }}>
                  <span className="auth-page-role-emoji">{meta?.emoji ?? "👤"}</span>
                  <span className="auth-page-role-badge-label" style={{ color: role === "lender" ? "#17a87a" : "#6e2fc1" }}>
                    Joining as {meta?.label}
                  </span>
                </div>
                <p className="auth-page-left-tagline">{meta?.tagline}</p>
                <ul className="auth-page-trust-list" aria-label="Platform highlights">
                  <li><span className="auth-page-trust-dot" />Behavior-based reputation score</li>
                  <li><span className="auth-page-trust-dot" />No collateral required</li>
                  <li><span className="auth-page-trust-dot" />Transparent on-chain audit trail</li>
                  <li><span className="auth-page-trust-dot" />Role dashboard from day one</li>
                </ul>
              </>
            ) : (
              <>
                <div className="auth-page-role-badge" style={{ background: "rgba(255,255,255,0.1)", borderColor: "rgba(255,255,255,0.2)" }}>
                  <span className="auth-page-role-emoji">👋</span>
                  <span className="auth-page-role-badge-label" style={{ color: "#ffffff" }}>
                    Welcome to TrustLend
                  </span>
                </div>
                <p className="auth-page-left-tagline">
                  Connect your Stellar wallet to get started. 
                </p>
                <ul className="auth-page-trust-list" aria-label="Platform highlights">
                  <li><span className="auth-page-trust-dot" />Secure Web3 authentication</li>
                  <li><span className="auth-page-trust-dot" />No emails or passwords required</li>
                </ul>
              </>
            )}
          </div>

          <div className="auth-left-orb auth-left-orb-1" />
          <div className="auth-left-orb auth-left-orb-2" />
        </div>
      </div>

      {/* Right panel — form */}
      <div className="auth-page-right">
        <div className="auth-page-form-wrap">
          <button type="button" onClick={() => router.push('/')} className="auth-page-back bg-transparent border-0 cursor-pointer text-left p-0 mb-6">
            <ArrowLeft size={14} />
            Back to home
          </button>

          <h1 className="auth-page-title font-display">Connect Wallet</h1>
          <p className="auth-page-subtitle">Choose your role, then sign in with your Stellar wallet.</p>

          <div className="auth-page-role-picker mt-8" role="group" aria-label="Choose your role">
            <p className="auth-page-section-label">I am a</p>
            <div className="auth-page-role-tabs">
              {(["borrower", "lender"] as AuthSelectableRole[]).map((r) => (
                <button
                  key={r}
                  type="button"
                  id={`role-tab-${r}`}
                  className={`auth-page-role-tab${role === r ? " auth-page-role-tab--active" : ""}`}
                  onClick={() => setRole(r)}
                  aria-pressed={role === r}
                >
                  <span className="auth-page-role-tab-emoji">{ROLE_META[r].emoji}</span>
                  {ROLE_META[r].label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-8">
            <StellarSignInButton className="auth-page-google-btn w-full" disabled={!role} role={role ?? undefined} />
          </div>

          {!role && (
            <p className="text-sm text-gray-400 mt-4 text-center">
              Please select a role to continue. <br/>(If you already have an account, selecting a role will be ignored, but you must select one to proceed).
            </p>
          )}

          <p className="auth-page-footnote mt-8">
            By continuing, you agree to TrustLend&apos;s{" "}
            <a href="#" className="auth-page-footnote-link">Terms</a> and{" "}
            <a href="#" className="auth-page-footnote-link">Privacy Policy</a>.
          </p>
        </div>
      </div>
    </main>
  );
}
