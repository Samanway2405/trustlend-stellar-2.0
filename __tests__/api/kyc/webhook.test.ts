import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import {
  mapProviderStatus,
  extractRejectionReason,
} from "@/lib/kyc/provider";
import type { SumSubWebhookPayload } from "@/lib/kyc/types";

// ── Mock only Supabase — the real provider signature/status mapping runs ──────
const mockGetServiceRoleClient = vi.fn();
const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  getServiceRoleClient: () => mockGetServiceRoleClient(),
}));

import { POST, GET } from "@/app/api/kyc/webhook/route";

const WEBHOOK_SECRET = "test-webhook-secret";
const ORIGINAL_ENV = { ...process.env };

function digest(body: string): string {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function webhookRequest(body: string, digestHeader: string) {
  return new NextRequest("http://localhost/api/kyc/webhook", {
    method: "POST",
    headers: { "x-payload-digest": digestHeader },
    body,
  });
}

function reviewedPayload(overrides: Partial<SumSubWebhookPayload> = {}): SumSubWebhookPayload {
  return {
    applicantId: "appl-1",
    externalUserId: "user-1",
    type: "applicantReviewed",
    reviewStatus: "completed",
    reviewResult: { reviewAnswer: "GREEN" },
    ...overrides,
  };
}

/** profiles.update(...).eq(...) chain whose eq() resolves per call. */
function makeUpdateChain(results: Array<{ error: unknown }> = [{ error: null }]) {
  const queue = [...results];
  const chain = {
    update: vi.fn((_payload: Record<string, unknown>) => chain),
    eq: vi.fn(() => Promise.resolve(queue.shift() ?? { error: null })),
  };
  mockFrom.mockReturnValue(chain);
  return chain;
}

describe("POST /api/kyc/webhook", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    process.env.SUMSUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    mockGetServiceRoleClient.mockReturnValue({ from: mockFrom, rpc: mockRpc });
  });

  it("auto-updates the profile to verified on a GREEN review (AC2)", async () => {
    const body = JSON.stringify(reviewedPayload());
    const chain = makeUpdateChain();
    mockRpc.mockResolvedValue({ error: null });

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ received: true, status: "verified" });

    expect(chain.update).toHaveBeenCalledOnce();
    const payload = chain.update.mock.calls[0][0];
    expect(payload.kyc_status).toBe("verified");
    expect(payload.regulated_pool_access).toBe(true);
    expect(payload.kyc_provider_id).toBe("appl-1");
    expect(payload.kyc_verified_at).toBeTruthy();
    expect(payload.kyc_rejection_reason).toBeNull();
    // Reputation snapshot seeded on first verification
    expect(mockRpc).toHaveBeenCalledWith("seed_reputation_snapshot", {
      p_user_id: "user-1",
      p_initial_score: 100,
    });
  });

  it("marks the profile rejected with a reason on a FINAL RED review", async () => {
    const body = JSON.stringify(
      reviewedPayload({
        reviewResult: {
          reviewAnswer: "RED",
          reviewRejectType: "FINAL",
          rejectLabels: ["DOCUMENT_MISMATCH"],
          moderationComment: "ID does not match selfie",
        },
      })
    );
    const chain = makeUpdateChain();

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    const payload = chain.update.mock.calls[0][0];
    expect(payload.kyc_status).toBe("rejected");
    expect(payload.regulated_pool_access).toBe(false);
    expect(payload.kyc_rejection_reason).toContain("DOCUMENT_MISMATCH");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("keeps a RETRY rejection as submitted (resubmission allowed)", async () => {
    const body = JSON.stringify(
      reviewedPayload({
        reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY" },
      })
    );
    const chain = makeUpdateChain();

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    const payload = chain.update.mock.calls[0][0];
    expect(payload.kyc_status).toBe("submitted");
    expect(payload.regulated_pool_access).toBe(false);
  });

  it("marks pending applicants as submitted", async () => {
    const body = JSON.stringify(reviewedPayload({ type: "applicantPending" }));
    const chain = makeUpdateChain();

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    const payload = chain.update.mock.calls[0][0];
    expect(payload.kyc_status).toBe("submitted");
    expect(payload.kyc_submitted_at).toBeTruthy();
  });

  it("rejects requests with an invalid signature (401) and never touches the DB", async () => {
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, "deadbeef"));

    expect(response.status).toBe(401);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("falls back to the provider-id lookup when the user-id update fails", async () => {
    const body = JSON.stringify(reviewedPayload());
    // first eq() (by user id) errors → fallback eq() (by provider id) succeeds
    const chain = makeUpdateChain([{ error: new Error("db down") }, { error: null }]);

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    expect(chain.update).toHaveBeenCalledTimes(2);
  });

  it("returns 400 when applicantId or externalUserId is missing", async () => {
    const body = JSON.stringify({ type: "applicantReviewed" });

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("returns 400 on malformed JSON", async () => {
    const raw = "{not json";
    const response = await POST(webhookRequest(raw, digest(raw)));

    expect(response.status).toBe(400);
  });

  it("acknowledges the webhook (200) when the service client is unavailable", async () => {
    mockGetServiceRoleClient.mockReturnValue(null);
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, digest(body)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
  });

  it("accepts the webhook in dev mode when no webhook secret is configured", async () => {
    delete process.env.SUMSUB_WEBHOOK_SECRET;
    makeUpdateChain();
    const body = JSON.stringify(reviewedPayload());

    const response = await POST(webhookRequest(body, ""));

    expect(response.status).toBe(200);
  });

  it("serves a health check on GET", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, provider: "SumSub" });
  });
});

// ── Provider status mapping (pure) ────────────────────────────────────────────

describe("mapProviderStatus", () => {
  it("maps GREEN reviews to verified", () => {
    expect(mapProviderStatus(reviewedPayload())).toBe("verified");
  });

  it("maps FINAL RED reviews to rejected", () => {
    expect(
      mapProviderStatus(
        reviewedPayload({
          reviewResult: { reviewAnswer: "RED", reviewRejectType: "FINAL" },
        })
      )
    ).toBe("rejected");
  });

  it("maps RETRY RED reviews back to submitted", () => {
    expect(
      mapProviderStatus(
        reviewedPayload({
          reviewResult: { reviewAnswer: "RED", reviewRejectType: "RETRY" },
        })
      )
    ).toBe("submitted");
  });

  it("maps created/pending/onHold events to submitted", () => {
    for (const type of ["applicantCreated", "applicantPending", "applicantOnHold"] as const) {
      expect(mapProviderStatus(reviewedPayload({ type }))).toBe("submitted");
    }
  });

  it("defaults unknown events to submitted", () => {
    expect(
      mapProviderStatus({ applicantId: "a", externalUserId: "u", type: "somethingElse" as never })
    ).toBe("submitted");
  });
});

describe("extractRejectionReason", () => {
  it("returns null for non-RED reviews", () => {
    expect(extractRejectionReason(reviewedPayload())).toBeNull();
  });

  it("joins labels and comments for RED reviews", () => {
    const reason = extractRejectionReason(
      reviewedPayload({
        reviewResult: {
          reviewAnswer: "RED",
          rejectLabels: ["DOCUMENT_MISMATCH", "SELFIE_MISMATCH"],
          moderationComment: "Blurry photo",
        },
      })
    );
    expect(reason).toContain("DOCUMENT_MISMATCH");
    expect(reason).toContain("Blurry photo");
  });

  it("returns a default message when no labels or comments exist", () => {
    const reason = extractRejectionReason(
      reviewedPayload({ reviewResult: { reviewAnswer: "RED" } })
    );
    expect(reason).toBe("Document does not meet requirements");
  });
});
