import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  GLOBAL_API_POLICY,
  enforceGlobalApiRateLimit,
  enforceRouteRateLimit,
  getRequestIdentifier,
} from "@/lib/rate-limit";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createMockRequest({
  pathname = "/api/pools",
  ip = "127.0.0.1",
  authToken,
}: {
  pathname?: string;
  ip?: string;
  authToken?: string;
} = {}): NextRequest {
  const headers = new Headers();
  headers.set("x-forwarded-for", ip);
  headers.set("x-vercel-ip-address", ip);
  if (authToken) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return {
    headers,
    nextUrl: { pathname, searchParams: new URLSearchParams() },
  } as unknown as NextRequest;
}

/** Build a request carrying only the given headers — nothing is implied. */
function createRawRequest(headerEntries: Record<string, string>): NextRequest {
  return {
    headers: new Headers(headerEntries),
    nextUrl: { pathname: "/api/pools", searchParams: new URLSearchParams() },
  } as unknown as NextRequest;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("enforceRouteRateLimit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── Success path ──────────────────────────────────────────────────────────

  it("returns null when request is within the limit", async () => {
    const req = createMockRequest({ pathname: "/api/pools" });
    const result = await enforceRouteRateLimit(req);

    expect(result).toBeNull();
  });

  it("returns null for a route with no matching policy (uses default)", async () => {
    const req = createMockRequest({ pathname: "/api/nonexistent" });
    const result = await enforceRouteRateLimit(req);

    expect(result).toBeNull();
  });

  it("treats each route independently", async () => {
    const reqA = createMockRequest({ pathname: "/api/pools", ip: "1.2.3.4" });
    const reqB = createMockRequest({ pathname: "/api/analytics", ip: "1.2.3.4" });

    const resultA = await enforceRouteRateLimit(reqA);
    const resultB = await enforceRouteRateLimit(reqB);

    expect(resultA).toBeNull();
    expect(resultB).toBeNull();
  });

  // ── Rate-limited path ─────────────────────────────────────────────────────

  it("returns 429 when rate limit is exceeded", async () => {
    const req = createMockRequest({ pathname: "/api/kyc/token", ip: "10.0.0.1" });

    // First 10 requests should succeed (/api/kyc/token limit is 10 per minute)
    for (let i = 0; i < 10; i++) {
      const r = await enforceRouteRateLimit(req);
      expect(r).toBeNull();
    }

    // 11th should fail
    const rateLimited = await enforceRouteRateLimit(req);
    expect(rateLimited).not.toBeNull();
    expect(rateLimited!.status).toBe(429);
  });

  it("429 response includes proper headers", async () => {
    const req = createMockRequest({ pathname: "/api/kyc/token", ip: "10.0.0.2" });

    // Exhaust the limit
    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req);
    }

    const res = await enforceRouteRateLimit(req);
    expect(res).not.toBeNull();

    const headers = res!.headers;
    expect(headers.get("Retry-After")).toBeTruthy();
    expect(headers.get("X-RateLimit-Limit")).toBe("10");
    expect(headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(headers.get("X-RateLimit-Reset")).toBeTruthy();

    // Retry-After should be a positive integer
    const retryAfter = Number(headers.get("Retry-After"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });

  it("429 response body contains error message", async () => {
    const req = createMockRequest({ pathname: "/api/kyc/token", ip: "10.0.0.3" });

    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req);
    }

    const res = await enforceRouteRateLimit(req);
    const body = await res!.json();
    expect(body).toHaveProperty("error", "Too many requests");
  });

  it("different IPs are rate-limited independently", async () => {
    const req1 = createMockRequest({ pathname: "/api/kyc/token", ip: "1.1.1.1" });
    const req2 = createMockRequest({ pathname: "/api/kyc/token", ip: "2.2.2.2" });

    // Exhaust IP1
    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req1);
    }

    // IP1 should be blocked
    const blocked = await enforceRouteRateLimit(req1);
    expect(blocked?.status).toBe(429);

    // IP2 should still pass
    const ok = await enforceRouteRateLimit(req2);
    expect(ok).toBeNull();
  });

  // ── Admin bypass ──────────────────────────────────────────────────────────

  it("allows unlimited requests for admin bearer token", async () => {
    vi.stubEnv("ADMIN_SECRET_KEY", "super-secret-admin-key-12345");

    const req = createMockRequest({
      pathname: "/api/kyc/token",
      ip: "10.0.0.100",
      authToken: "super-secret-admin-key-12345",
    });

    // Send 20 requests (well over the 10/min limit)
    for (let i = 0; i < 20; i++) {
      const res = await enforceRouteRateLimit(req);
      expect(res).toBeNull();
    }

    vi.unstubAllEnvs();
  });

  it("rejects request with wrong bearer token", async () => {
    vi.stubEnv("ADMIN_SECRET_KEY", "real-secret");

    const req = createMockRequest({
      pathname: "/api/kyc/token",
      ip: "10.0.0.101",
      authToken: "wrong-secret",
    });

    // Exhaust the limit
    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req);
    }

    const res = await enforceRouteRateLimit(req);
    expect(res?.status).toBe(429);

    vi.unstubAllEnvs();
  });

  it("bypasses rate limit when ADMIN_SECRET_KEY env is not set (no auth check)", async () => {
    vi.stubEnv("ADMIN_SECRET_KEY", "");

    const req = createMockRequest({
      pathname: "/api/kyc/token",
      ip: "10.0.0.102",
      authToken: "some-token",
    });

    // Auth header is present but ADMIN_SECRET_KEY not set → no bypass, normal rate limit applies
    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req);
    }

    const res = await enforceRouteRateLimit(req);
    expect(res?.status).toBe(429);

    vi.unstubAllEnvs();
  });

  // ── Whitelist bypass ──────────────────────────────────────────────────────

  it("skips rate limiting for whitelisted IPs", async () => {
    vi.stubEnv("RATE_LIMIT_WHITELIST", "10.0.0.200,10.0.0.201");

    const req = createMockRequest({
      pathname: "/api/kyc/token",
      ip: "10.0.0.200",
    });

    // Send 20 requests (well over the 10/min limit)
    for (let i = 0; i < 20; i++) {
      const res = await enforceRouteRateLimit(req);
      expect(res).toBeNull();
    }

    vi.unstubAllEnvs();
  });

  it("rejects non-whitelisted IPs normally", async () => {
    vi.stubEnv("RATE_LIMIT_WHITELIST", "10.0.0.200");

    const req = createMockRequest({
      pathname: "/api/kyc/token",
      ip: "10.0.0.201", // not in whitelist
    });

    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req);
    }

    const res = await enforceRouteRateLimit(req);
    expect(res?.status).toBe(429);

    vi.unstubAllEnvs();
  });

  it("does not break when whitelist env is not set", async () => {
    vi.stubEnv("RATE_LIMIT_WHITELIST", "");

    const req = createMockRequest({ pathname: "/api/pools", ip: "10.0.0.202" });
    const res = await enforceRouteRateLimit(req);
    expect(res).toBeNull();

    vi.unstubAllEnvs();
  });

  it("skips rate limiting when both admin and whitelist bypass are active", async () => {
    vi.stubEnv("ADMIN_SECRET_KEY", "admin-789");
    vi.stubEnv("RATE_LIMIT_WHITELIST", "10.0.0.210");

    const req = createMockRequest({
      pathname: "/api/kyc/token",
      ip: "10.0.0.210",
      authToken: "admin-789",
    });

    for (let i = 0; i < 30; i++) {
      const res = await enforceRouteRateLimit(req);
      expect(res).toBeNull();
    }

    vi.unstubAllEnvs();
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("recovers after the window passes (local store pruning)", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const req = createMockRequest({ pathname: "/api/kyc/token", ip: "10.0.0.99" });

    // Exhaust limit
    for (let i = 0; i < 10; i++) {
      await enforceRouteRateLimit(req);
    }

    expect((await enforceRouteRateLimit(req))?.status).toBe(429);

    // Advance time past the 1-minute window
    vi.advanceTimersByTime(61_000);

    // Should recover
    const recovered = await enforceRouteRateLimit(req);
    expect(recovered).toBeNull();

    vi.useRealTimers();
  });

  it("handles unknown IP gracefully (falls back to 'unknown')", async () => {
    const req = createMockRequest({ pathname: "/api/pools", ip: "unknown" });
    const res = await enforceRouteRateLimit(req);
    expect(res).toBeNull();
  });

  // ── Dynamic route policies ────────────────────────────────────────────────

  it("applies the receipt policy to dynamic loan ids", async () => {
    const req = createMockRequest({
      pathname: "/api/loans/abc-123/receipt",
      ip: "10.1.0.1",
    });

    // /api/loans/[id]/receipt allows 10 per 10 minutes
    for (let i = 0; i < 10; i++) {
      expect(await enforceRouteRateLimit(req)).toBeNull();
    }

    const res = await enforceRouteRateLimit(req);
    expect(res?.status).toBe(429);
    expect(res!.headers.get("X-RateLimit-Limit")).toBe("10");
  });
});

// ─── Client IP resolution ─────────────────────────────────────────────────────

describe("getRequestIdentifier", () => {
  it("prefers the platform-injected Vercel header", () => {
    const req = createRawRequest({
      "x-vercel-ip-address": "9.9.9.9",
      "x-forwarded-for": "1.1.1.1",
    });

    expect(getRequestIdentifier(req)).toBe("9.9.9.9");
  });

  it("falls back to x-forwarded-for on self-hosted deployments", () => {
    const req = createRawRequest({ "x-forwarded-for": "203.0.113.7" });

    expect(getRequestIdentifier(req)).toBe("203.0.113.7");
  });

  it("uses x-real-ip when no forwarded-for chain is present", () => {
    const req = createRawRequest({ "x-real-ip": "198.51.100.4" });

    expect(getRequestIdentifier(req)).toBe("198.51.100.4");
  });

  it("takes the originating client from a forwarded-for chain", () => {
    const req = createRawRequest({
      "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178",
    });

    expect(getRequestIdentifier(req)).toBe("203.0.113.7");
  });

  it("falls back to 'unknown' when no IP header is present", () => {
    expect(getRequestIdentifier(createRawRequest({}))).toBe("unknown");
  });

  it("skips blank header values", () => {
    const req = createRawRequest({
      "cf-connecting-ip": "  ",
      "x-forwarded-for": "203.0.113.9",
    });

    expect(getRequestIdentifier(req)).toBe("203.0.113.9");
  });
});

// ─── Global per-IP ceiling ────────────────────────────────────────────────────

describe("enforceGlobalApiRateLimit", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("caps at 100 requests per minute per IP", () => {
    expect(GLOBAL_API_POLICY).toEqual({ limit: 100, window: "1 m" });
  });

  it("allows the first 100 requests and rejects the 101st with 429", async () => {
    const req = createMockRequest({ pathname: "/api/pools", ip: "172.16.0.1" });

    for (let i = 0; i < 100; i++) {
      expect(await enforceGlobalApiRateLimit(req)).toBeNull();
    }

    const res = await enforceGlobalApiRateLimit(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(429);
  });

  it("counts every /api route against the same per-IP bucket", async () => {
    const ip = "172.16.0.2";
    const paths = ["/api/pools", "/api/analytics", "/api/reputation", "/api/treasury"];

    // 100 requests spread across four different endpoints
    for (let i = 0; i < 100; i++) {
      const req = createMockRequest({ pathname: paths[i % paths.length], ip });
      expect(await enforceGlobalApiRateLimit(req)).toBeNull();
    }

    const res = await enforceGlobalApiRateLimit(
      createMockRequest({ pathname: "/api/pools", ip })
    );
    expect(res?.status).toBe(429);
  });

  it("429 response carries Retry-After and rate-limit headers", async () => {
    const req = createMockRequest({ pathname: "/api/pools", ip: "172.16.0.3" });

    for (let i = 0; i < 100; i++) {
      await enforceGlobalApiRateLimit(req);
    }

    const res = await enforceGlobalApiRateLimit(req);
    const headers = res!.headers;

    expect(headers.get("X-RateLimit-Limit")).toBe("100");
    expect(headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(Number(headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);

    const body = await res!.json();
    expect(body).toHaveProperty("error", "Too many requests, please slow down.");
  });

  it("rate-limits each IP independently", async () => {
    const noisy = createMockRequest({ pathname: "/api/pools", ip: "172.16.0.4" });
    const quiet = createMockRequest({ pathname: "/api/pools", ip: "172.16.0.5" });

    for (let i = 0; i < 100; i++) {
      await enforceGlobalApiRateLimit(noisy);
    }

    expect((await enforceGlobalApiRateLimit(noisy))?.status).toBe(429);
    expect(await enforceGlobalApiRateLimit(quiet)).toBeNull();
  });

  it("uses a bucket separate from the per-route limits", async () => {
    const ip = "172.16.0.6";
    const req = createMockRequest({ pathname: "/api/pools", ip });

    // Exhaust the global ceiling
    for (let i = 0; i < 100; i++) {
      await enforceGlobalApiRateLimit(req);
    }
    expect((await enforceGlobalApiRateLimit(req))?.status).toBe(429);

    // The per-route counter for this IP is untouched
    expect(await enforceRouteRateLimit(req)).toBeNull();
  });

  it("recovers once the 1-minute window elapses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now());

    const req = createMockRequest({ pathname: "/api/pools", ip: "172.16.0.7" });

    for (let i = 0; i < 100; i++) {
      await enforceGlobalApiRateLimit(req);
    }
    expect((await enforceGlobalApiRateLimit(req))?.status).toBe(429);

    vi.advanceTimersByTime(61_000);
    expect(await enforceGlobalApiRateLimit(req)).toBeNull();

    vi.useRealTimers();
  });

  it("bypasses the ceiling for the admin bearer token", async () => {
    vi.stubEnv("ADMIN_SECRET_KEY", "admin-global-key");

    const req = createMockRequest({
      pathname: "/api/pools",
      ip: "172.16.0.8",
      authToken: "admin-global-key",
    });

    for (let i = 0; i < 150; i++) {
      expect(await enforceGlobalApiRateLimit(req)).toBeNull();
    }

    vi.unstubAllEnvs();
  });

  it("bypasses the ceiling for whitelisted IPs", async () => {
    vi.stubEnv("RATE_LIMIT_WHITELIST", "172.16.0.9");

    const req = createMockRequest({ pathname: "/api/pools", ip: "172.16.0.9" });

    for (let i = 0; i < 150; i++) {
      expect(await enforceGlobalApiRateLimit(req)).toBeNull();
    }

    vi.unstubAllEnvs();
  });
});
