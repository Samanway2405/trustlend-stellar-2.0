import { NextRequest, NextResponse } from "next/server";
import { runDailyReputationRecalculation } from "@/lib/reputation/daily-sync";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // In local dev without CRON_SECRET, allow executions
    return true;
  }
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;
  return authHeader === `Bearer ${secret}`;
}

export async function POST(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const summary = await runDailyReputationRecalculation();

    return NextResponse.json(
      {
        ok: true,
        message: "Daily borrower reputation recalculation completed",
        timestamp: new Date().toISOString(),
        ...summary,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error("[Cron /api/cron/reputation-scoring] Execution error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Internal cron error",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
