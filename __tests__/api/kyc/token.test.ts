import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { KycApplicantResult } from "@/lib/kyc/types";

// ── Mock auth (session) ───────────────────────────────────────────────────────
const mockRequireAuthenticatedUser = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  requireAuthenticatedUser: (...args: unknown[]) => mockRequireAuthenticatedUser(...args),
}));

// ── Mock Supabase clients ──────────────────────────────────────────────────────
const mockGetServerSupabaseClient = vi.fn();
const mockGetServiceRoleClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  getServerSupabaseClient: () => mockGetServerSupabaseClient(),
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

// ── Mock the SumSub provider ───────────────────────────────────────────────────
const mockCreateApplicant = vi.fn();
const mockGetApplicantId = vi.fn();
const mockGenerateSdkToken = vi.fn();
vi.mock("@/lib/kyc/provider", () => ({
  createApplicant: (...args: unknown[]) => mockCreateApplicant(...args),
  getApplicantId: (...args: unknown[]) => mockGetApplicantId(...args),
  generateSdkToken: (...args: unknown[]) => mockGenerateSdkToken(...args),
}));

import { POST, GET } from "@/app/api/kyc/token/route";

const TOKEN_RESULT: KycApplicantResult = {
  applicantId: "appl-123",
  token: "sdk-token-abc",
  expiresAt: "2026-08-26T00:00:00.000Z",
};

function user(role: "borrower" | "lender" | "admin") {
  return { user: { id: "user-1", email: "a@b.com" }, role };
}

/** Supabase client whose profiles query resolves to `profile`. */
function makeProfilesClient(profile: Record<string, unknown> | null) {
  const chain = {
    from: vi.fn(() => chain),
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(() => Promise.resolve({ data: profile, error: null })),
  };
  mockGetServerSupabaseClient.mockReturnValue(chain);
  return chain;
}

/** Service-role client used to persist kyc_provider_id (bypasses RLS). */
function makeServiceClient() {
  const chain = {
    from: vi.fn(() => chain),
    update: vi.fn(() => chain),
    eq: vi.fn(() => Promise.resolve({ error: null })),
  };
  mockGetServiceRoleClient.mockReturnValue(chain);
  return chain;
}

function post() {
  return POST(new NextRequest("http://localhost/api/kyc/token", { method: "POST" }));
}

describe("POST /api/kyc/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("issues a KYC SDK token for a lender (issue #262 — AC1)", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("lender"));
    makeProfilesClient({ full_name: "Jane Lender", kyc_provider_id: null, kyc_status: "pending" });
    makeServiceClient();
    mockGetApplicantId.mockResolvedValue(null);
    mockCreateApplicant.mockResolvedValue("appl-lender-1");
    mockGenerateSdkToken.mockResolvedValue(TOKEN_RESULT);

    const response = await post();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(TOKEN_RESULT);
    expect(mockCreateApplicant).toHaveBeenCalledWith("user-1", "a@b.com", "Jane Lender");
    expect(mockGenerateSdkToken).toHaveBeenCalledWith("appl-lender-1", "user-1");
    // Provider id persisted via service role
    expect(mockGetServiceRoleClient().from).toHaveBeenCalledWith("profiles");
  });

  it("reuses an existing applicant found via the provider and persists it", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("borrower"));
    makeProfilesClient({ full_name: "Bob Borrower", kyc_provider_id: null, kyc_status: "submitted" });
    makeServiceClient();
    mockGetApplicantId.mockResolvedValue("appl-existing");
    mockGenerateSdkToken.mockResolvedValue(TOKEN_RESULT);

    const response = await post();

    expect(response.status).toBe(200);
    expect(mockCreateApplicant).not.toHaveBeenCalled();
    expect(mockGenerateSdkToken).toHaveBeenCalledWith("appl-existing", "user-1");
    // Persisted with the existing (non-pending) status preserved
    const persisted = mockGetServiceRoleClient().from("profiles").update.mock.calls[0][0] as Record<string, unknown>;
    expect(persisted.kyc_provider_id).toBe("appl-existing");
    expect(persisted.kyc_status).toBe("submitted");
  });

  it("redirects admins away instead of issuing a customer KYC token", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("admin"));

    await expect(post()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(mockGenerateSdkToken).not.toHaveBeenCalled();
  });

  it("returns 503 when the database client is unavailable", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("lender"));
    mockGetServerSupabaseClient.mockReturnValue(null);

    const response = await post();

    expect(response.status).toBe(503);
    expect(mockGenerateSdkToken).not.toHaveBeenCalled();
  });

  it("returns 500 when the provider fails", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("lender"));
    makeProfilesClient({ full_name: "Jane Lender", kyc_provider_id: null, kyc_status: "pending" });
    makeServiceClient();
    mockGetApplicantId.mockResolvedValue(null);
    mockCreateApplicant.mockRejectedValue(new Error("SumSub API error 401"));

    const response = await post();

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.error).toContain("SumSub API error 401");
  });
});

describe("GET /api/kyc/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the current KYC status for a lender", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("lender"));
    makeProfilesClient({
      kyc_status: "verified",
      kyc_provider_id: "appl-lender-1",
      kyc_submitted_at: "2026-08-01T00:00:00.000Z",
      kyc_verified_at: "2026-08-02T00:00:00.000Z",
      kyc_rejection_reason: null,
      regulated_pool_access: true,
    });

    const response = await GET(new NextRequest("http://localhost/api/kyc/token"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kycStatus: "verified",
      applicantId: "appl-lender-1",
      regulatedPoolAccess: true,
    });
  });

  it("defaults to pending when no profile exists", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("lender"));
    makeProfilesClient(null);

    const response = await GET(new NextRequest("http://localhost/api/kyc/token"));

    expect(response.status).toBe(200);
    expect((await response.json()).kycStatus).toBe("pending");
  });

  it("returns 401 when the status lookup fails", async () => {
    mockRequireAuthenticatedUser.mockResolvedValue(user("lender"));
    const chain = {
      from: vi.fn(() => chain),
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      maybeSingle: vi.fn(() => Promise.reject(new Error("db down"))),
    };
    mockGetServerSupabaseClient.mockReturnValue(chain);

    const response = await GET(new NextRequest("http://localhost/api/kyc/token"));

    expect(response.status).toBe(401);
  });
});
