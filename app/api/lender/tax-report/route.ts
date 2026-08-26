import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import { NextResponse } from "next/server";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { getLenderTaxReportData } from "@/lib/lender/tax-report-data";
import {
  buildTaxReportRows,
  summarizeTaxReport,
  taxReportFilename,
  toCsv,
} from "@/lib/lender/tax-report";

export const runtime = "nodejs";

function formatXlm(value: number | string | null | undefined) {
  return `${Number(value ?? 0).toFixed(2)} XLM`;
}

/**
 * GET /api/lender/tax-report?format=csv&year=2026
 *
 * `format=csv` returns a per-event interest-income CSV (Issue #271) covering
 * both pool interest and directly funded marketplace loans.
 * `format=pdf` (the default) returns the original pool-only PDF summary.
 *
 * `year` defaults to the current year; pass `year=all` for the full history.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const yearStr = searchParams.get("year");
    const format = (searchParams.get("format") ?? "pdf").toLowerCase();

    // `year=all` lifts the filter; anything unparseable falls back to this year.
    const isAllYears = yearStr === "all";
    const parsedYear = yearStr ? parseInt(yearStr, 10) : NaN;
    const year =
      isAllYears
        ? null
        : Number.isFinite(parsedYear)
          ? parsedYear
          : new Date().getFullYear();

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (format === "csv") {
      return await buildCsvResponse(supabase, user.id, {
        walletAddress: String(user.user_metadata?.wallet_address ?? "") || null,
        year,
      });
    }

    // ── PDF summary (original behaviour) ─────────────────────────────────────
    const pdfYear = year ?? new Date().getFullYear();

    const [profileRes, positionsRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle(),
      supabase
        .from("pool_positions")
        .select(`
          id,
          principal_amount,
          earned_interest,
          opened_at,
          closed_at,
          status,
          lending_pools ( name )
        `)
        .eq("lender_id", user.id)
    ]);

    const positions = positionsRes.data ?? [];
    
    // Filter positions active or closed in the given year
    const yearPositions = positions.filter((pos) => {
      const openedAt = new Date(pos.opened_at);
      const closedAt = pos.closed_at ? new Date(pos.closed_at) : new Date();
      return openedAt.getFullYear() <= pdfYear && closedAt.getFullYear() >= pdfYear;
    });

    const totalInterest = yearPositions.reduce((acc, pos) => acc + Number(pos.earned_interest ?? 0), 0);
    const totalPrincipal = yearPositions.reduce((acc, pos) => acc + Number(pos.principal_amount ?? 0), 0);

    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    const pdfBufferPromise = new Promise<Buffer>((resolve, reject) => {
      doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);
    });

    try {
      const logoPath = path.join(process.cwd(), "public", "logo.png");
      const logo = await fs.readFile(logoPath);
      doc.image(logo, 50, 42, { width: 68 });
    } catch {
      // Logo is optional
    }

    doc
      .fillColor("#3f2a69")
      .fontSize(22)
      .text(`TrustLend Tax Report - ${pdfYear}`, 135, 50)
      .fillColor("#6b7280")
      .fontSize(10)
      .text("Annual summary of lender earnings and yield", 135, 78);

    doc
      .moveTo(50, 112)
      .lineTo(545, 112)
      .strokeColor("#e5e7eb")
      .stroke();

    doc.fillColor("#111827").fontSize(12);

    const lenderName = profileRes.data?.full_name ?? user.user_metadata?.full_name ?? "TrustLend Lender";

    const summaryRows = [
      ["Report generated", new Date().toLocaleString("en-US")],
      ["Lender name", lenderName],
      ["Lender ID", user.id],
      ["Tax Year", String(pdfYear)],
      ["Total Principal Deployed", formatXlm(totalPrincipal)],
      ["Total Interest Earned", formatXlm(totalInterest)],
    ];

    let y = 130;
    for (const [label, value] of summaryRows) {
      doc
        .fillColor("#6b7280")
        .fontSize(10)
        .text(label, 50, y, { width: 160 })
        .fillColor("#111827")
        .fontSize(11)
        .text(value, 220, y, { width: 290 });
      y += 22;
    }

    y += 10;
    doc
      .fillColor("#3f2a69")
      .fontSize(14)
      .text("Position Details", 50, y);

    y += 26;
    doc
      .fillColor("#6b7280")
      .fontSize(10)
      .text("Pool Name", 50, y, { width: 150 })
      .text("Principal", 210, y, { width: 110 })
      .text("Earned Interest", 330, y, { width: 110, align: "right" })
      .text("Status", 450, y, { width: 80, align: "right" });

    y += 14;
    doc
      .moveTo(50, y)
      .lineTo(545, y)
      .strokeColor("#d1d5db")
      .stroke();

    y += 10;
    yearPositions.forEach((pos) => {
      if (y > 730) {
        doc.addPage();
        y = 60;
      }
      
      const poolRaw = Array.isArray(pos.lending_pools) ? pos.lending_pools[0] : pos.lending_pools;
      const poolName = (poolRaw as { name?: string })?.name ?? "Unknown Pool";

      doc
        .fillColor("#111827")
        .fontSize(10)
        .text(poolName, 50, y, { width: 150 })
        .text(formatXlm(pos.principal_amount as string | number), 210, y, { width: 110 })
        .text(formatXlm(pos.earned_interest as string | number), 330, y, { width: 110, align: "right" })
        .text(String(pos.status), 450, y, { width: 80, align: "right" });
      y += 22;
    });

    doc
      .fillColor("#6b7280")
      .fontSize(9)
      .text(
        "This report is generated by TrustLend for informational purposes only and does not constitute official tax advice.",
        50,
        760,
        { width: 495, align: "center" }
      );

    doc.end();
    const pdf = await pdfBufferPromise;

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="trustlend-tax-report-${pdfYear}.pdf"`,
        "Cache-Control": "private, no-store, max-age=0",
      },
    });
  } catch (error) {
    console.error("Tax report generation error:", error);
    return NextResponse.json({ error: "Failed to generate report" }, { status: 500 });
  }
}

/**
 * Per-event interest-income CSV (Issue #271).
 *
 * Covers both income sources — pool interest and directly funded marketplace
 * loans — where the PDF summary only ever reported pool positions.
 */
async function buildCsvResponse(
  supabase: Awaited<ReturnType<typeof getServerSupabaseClient>>,
  userId: string,
  { walletAddress, year }: { walletAddress: string | null; year: number | null }
) {
  if (!supabase) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Repayment ledger rows are written by the borrower, so reading them needs
  // the service-role client. Without it the report still covers pool interest.
  const srClient = getServiceRoleClient();

  const data = await getLenderTaxReportData(supabase, srClient, userId, walletAddress);
  const rows = buildTaxReportRows({ ...data, year });
  const summary = summarizeTaxReport(rows);
  const csv = toCsv(rows);
  const filename = taxReportFilename(year);

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store, max-age=0",
      // Surfaced so the client can tell the user what it just downloaded
      // without having to parse the file back.
      "X-Report-Rows": String(summary.rowCount),
      "X-Report-Total-Interest": String(summary.totalInterest),
      // A lender with no P2P history still gets a valid pool-only report; this
      // flags when the P2P half could not be read at all.
      "X-Report-P2P-Included": String(Boolean(srClient)),
    },
  });
}
