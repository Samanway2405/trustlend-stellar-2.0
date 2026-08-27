import { Suspense } from "react";
import { AuthPageClient } from "@/components/auth/AuthPageClient";
import { ReferralCodeStash } from "@/components/auth/ReferralCodeStash";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in — TrustLend",
  description: "Sign in or create your TrustLend account as a borrower or lender.",
};

export default function AuthPage() {
  return (
    <Suspense fallback={<AuthPageSkeleton />}>
      {/* Remembers an invite code across the wallet sign-in round trip. */}
      <ReferralCodeStash />
      <AuthPageClient />
    </Suspense>
  );
}

function AuthPageSkeleton() {
  return (
    <main className="auth-page-shell">
      <div className="auth-page-card auth-page-card--loading" aria-busy="true" aria-label="Loading authentication" />
    </main>
  );
}
