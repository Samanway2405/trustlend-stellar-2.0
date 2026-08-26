import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import type { KeeperConfig } from "@/scripts/liquidation-keeper";

// ── Mock the keeper module (no real RPC / Supabase in tests) ──────────────────
const mockLoadConfig = vi.fn();
const mockRunLiquidationKeeper = vi.fn();

vi.mock("@/scripts/liquidation-keeper", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  runLiquidationKeeper: (...args: unknown[]) => mockRunLiquidationKeeper(...args),
}));

// ── Mock the server-side signer loader ────────────────────────────────────────
const mockGetAdminKeypair = vi.fn();
vi.mock("@/lib/stellar/server-contract", () => ({
  getAdminKeypair: () => mockGetAdminKeypair(),
}));

import { POST, GET } from "@/app/api/cron/liquidation/route";

const BASE_CFG: KeeperConfig = {
  source: "chain",
  dryRun: false,
  intervalSecs: null,
  lendingContractId: "CLENDING",
  reputationContractId: "CREPUTATION",
  adminAddress: "GADMIN",
  xlmPriceUsd: 0.1,
  priceTable: {},
  defaultAssetVolatilityBps: 2000,
};

const SUMMARY = { scanned: 2, liquidated: 1, healthy: 0, skipped: 0, failed: 1 };

function authorizedRequest(token = "s3cret"): NextRequest {
  return new NextRequest("http://localhost/api/cron/liquidation", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("POST /api/cron/liquidation", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    mockLoadConfig.mockReturnValue(BASE_CFG);
    mockGetAdminKeypair.mockReturnValue({} as never);
  });

  it("runs the keeper and returns the summary (success path)", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockRunLiquidationKeeper.mockResolvedValue(SUMMARY);

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ...SUMMARY });

    expect(mockLoadConfig).toHaveBeenCalledOnce();
    expect(mockGetAdminKeypair).toHaveBeenCalledOnce();
    expect(mockRunLiquidationKeeper).toHaveBeenCalledOnce();
    expect(mockRunLiquidationKeeper).toHaveBeenCalledWith(BASE_CFG, {});
  });

  it("rejects a request with a wrong bearer token (401)", async () => {
    process.env.CRON_SECRET = "s3cret";

    const response = await POST(authorizedRequest("wrong-token"));

    expect(response.status).toBe(401);
    expect(mockRunLiquidationKeeper).not.toHaveBeenCalled();
  });

  it("rejects a request with no authorization header (401)", async () => {
    process.env.CRON_SECRET = "s3cret";

    const response = await POST(new NextRequest("http://localhost/api/cron/liquidation"));

    expect(response.status).toBe(401);
    expect(mockRunLiquidationKeeper).not.toHaveBeenCalled();
  });

  it("runs without auth when CRON_SECRET is unset (dev mode)", async () => {
    delete process.env.CRON_SECRET;
    mockRunLiquidationKeeper.mockResolvedValue(SUMMARY);

    const response = await POST(new NextRequest("http://localhost/api/cron/liquidation"));

    expect(response.status).toBe(200);
    expect(mockRunLiquidationKeeper).toHaveBeenCalledOnce();
  });

  it("returns 500 when the keeper run throws", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockRunLiquidationKeeper.mockRejectedValue(new Error("RPC down"));

    const response = await POST(authorizedRequest());

    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("RPC down");
  });

  it("supports GET invocations (Vercel cron uses GET)", async () => {
    process.env.CRON_SECRET = "s3cret";
    mockRunLiquidationKeeper.mockResolvedValue(SUMMARY);

    const response = await GET(authorizedRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, ...SUMMARY });
  });
});

// ── Acceptance criterion: the worker monitors prices every minute ──────────────
// vercel.json must schedule the liquidation cron on a 1-minute cadence.

describe("vercel.json liquidation schedule", () => {
  it("schedules /api/cron/liquidation every minute (* * * * *)", () => {
    const raw = fs.readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8");
    const crons = (JSON.parse(raw) as { crons: Array<{ path: string; schedule: string }> }).crons;

    const liquidationCron = crons.find((c) => c.path === "/api/cron/liquidation");
    expect(liquidationCron).toBeDefined();
    expect(liquidationCron?.schedule).toBe("* * * * *");
  });
});
