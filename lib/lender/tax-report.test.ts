import { describe, expect, it } from "vitest";
import {
  CSV_COLUMNS,
  buildTaxReportRows,
  collectReportYears,
  escapeCsvCell,
  sanitizeCsvText,
  summarizeTaxReport,
  taxReportFilename,
  toCsv,
  toIsoDate,
} from "./tax-report";

// ─── Date handling ────────────────────────────────────────────────────────────

describe("toIsoDate", () => {
  it("reduces a timestamp to a UTC calendar date", () => {
    expect(toIsoDate("2026-03-14T22:31:05.123Z")).toBe("2026-03-14");
  });

  it("returns an empty string for missing or unparseable input", () => {
    expect(toIsoDate(null)).toBe("");
    expect(toIsoDate(undefined)).toBe("");
    expect(toIsoDate("")).toBe("");
    expect(toIsoDate("not a date")).toBe("");
  });
});

// ─── Pool interest ────────────────────────────────────────────────────────────

describe("buildTaxReportRows — pool positions", () => {
  const openPosition = {
    id: "pos-1",
    poolId: "pool-abcdef12",
    poolName: "Stable Yield Pool",
    asset: "XLM",
    principalAmount: 1000,
    earnedInterest: 42.5,
    openedAt: "2026-01-10T00:00:00Z",
    closedAt: null,
  };

  it("emits a row per interest-earning position", () => {
    const rows = buildTaxReportRows({ poolPositions: [openPosition] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-01-10",
      asset: "XLM",
      amount: 42.5,
      source: "Stable Yield Pool",
      principal: 1000,
      reference: "pos-1",
    });
  });

  it("marks an open position's interest as accrued, not realised", () => {
    const rows = buildTaxReportRows({ poolPositions: [openPosition] });

    expect(rows[0].category).toBe("pool_interest_accrued");
  });

  it("attributes a closed position to its closing date and marks it realised", () => {
    const rows = buildTaxReportRows({
      poolPositions: [{ ...openPosition, closedAt: "2026-06-30T12:00:00Z" }],
    });

    expect(rows[0].date).toBe("2026-06-30");
    expect(rows[0].category).toBe("pool_interest_realized");
  });

  it("skips positions that earned nothing", () => {
    const rows = buildTaxReportRows({
      poolPositions: [{ ...openPosition, earnedInterest: 0 }],
    });

    expect(rows).toHaveLength(0);
  });

  it("falls back to a pool id when the pool has no name", () => {
    const rows = buildTaxReportRows({
      poolPositions: [{ ...openPosition, poolName: null }],
    });

    expect(rows[0].source).toBe("Pool pool-abc");
  });

  it("defaults the asset to XLM when none is recorded", () => {
    const rows = buildTaxReportRows({
      poolPositions: [{ ...openPosition, asset: null }],
    });

    expect(rows[0].asset).toBe("XLM");
  });

  it("parses the string numerics PostgREST returns", () => {
    const rows = buildTaxReportRows({
      poolPositions: [
        { ...openPosition, principalAmount: "1000.000000", earnedInterest: "42.500000" },
      ],
    });

    expect(rows[0].amount).toBe(42.5);
    expect(rows[0].principal).toBe(1000);
  });
});

// ─── P2P interest ─────────────────────────────────────────────────────────────

describe("buildTaxReportRows — P2P loans", () => {
  it("treats a repayment that only returns capital as no income", () => {
    const rows = buildTaxReportRows({
      fundings: [{ loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" }],
      repayments: [{ loanId: "loan-1", amount: 100, date: "2026-02-01T00:00:00Z" }],
    });

    expect(rows).toHaveLength(0);
  });

  it("recognises only the amount above the principal as interest", () => {
    const rows = buildTaxReportRows({
      fundings: [{ loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" }],
      repayments: [{ loanId: "loan-1", amount: 110, date: "2026-02-01T00:00:00Z" }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(10);
    expect(rows[0].grossReceived).toBe(110);
    expect(rows[0].principal).toBe(100);
  });

  it("recovers capital first across several repayments", () => {
    // 100 funded, repaid 60 then 60: the first is all capital, the second
    // returns the last 40 and pays 20 of interest.
    const rows = buildTaxReportRows({
      fundings: [{ loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" }],
      repayments: [
        { loanId: "loan-1", amount: 60, date: "2026-02-01T00:00:00Z" },
        { loanId: "loan-1", amount: 60, date: "2026-03-01T00:00:00Z" },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-03-01");
    expect(rows[0].amount).toBe(20);
  });

  it("orders repayments by date before allocating, not by input order", () => {
    const outOfOrder = buildTaxReportRows({
      fundings: [{ loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" }],
      repayments: [
        { loanId: "loan-1", amount: 60, date: "2026-03-01T00:00:00Z" },
        { loanId: "loan-1", amount: 60, date: "2026-02-01T00:00:00Z" },
      ],
    });

    expect(outOfOrder).toHaveLength(1);
    expect(outOfOrder[0].date).toBe("2026-03-01");
    expect(outOfOrder[0].amount).toBe(20);
  });

  it("sums multiple fundings of the same loan into one principal", () => {
    // Partial fills mean a lender can top the same loan up twice (#269).
    const rows = buildTaxReportRows({
      fundings: [
        { loanId: "loan-1", amount: 60, date: "2026-01-01T00:00:00Z" },
        { loanId: "loan-1", amount: 40, date: "2026-01-05T00:00:00Z" },
      ],
      repayments: [{ loanId: "loan-1", amount: 115, date: "2026-02-01T00:00:00Z" }],
    });

    expect(rows[0].principal).toBe(100);
    expect(rows[0].amount).toBe(15);
  });

  it("keeps each loan's capital recovery separate", () => {
    const rows = buildTaxReportRows({
      fundings: [
        { loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" },
        { loanId: "loan-2", amount: 200, date: "2026-01-01T00:00:00Z" },
      ],
      repayments: [
        { loanId: "loan-1", amount: 110, date: "2026-02-01T00:00:00Z" },
        { loanId: "loan-2", amount: 100, date: "2026-02-02T00:00:00Z" },
      ],
    });

    // loan-1 cleared its principal and paid 10; loan-2 is still under water.
    expect(rows).toHaveLength(1);
    expect(rows[0].reference).toBe("loan-1");
    expect(rows[0].amount).toBe(10);
  });

  it("treats a repayment with no matching funding as fully income", () => {
    const rows = buildTaxReportRows({
      repayments: [{ loanId: "loan-x", amount: 50, date: "2026-02-01T00:00:00Z" }],
    });

    expect(rows[0].amount).toBe(50);
    expect(rows[0].principal).toBe(0);
  });

  it("carries the transaction hash through", () => {
    const rows = buildTaxReportRows({
      fundings: [{ loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" }],
      repayments: [
        { loanId: "loan-1", amount: 110, date: "2026-02-01T00:00:00Z", txHash: "abc123" },
      ],
    });

    expect(rows[0].txHash).toBe("abc123");
  });

  it("ignores zero and negative repayment amounts", () => {
    const rows = buildTaxReportRows({
      repayments: [
        { loanId: "loan-1", amount: 0, date: "2026-02-01T00:00:00Z" },
        { loanId: "loan-1", amount: -5, date: "2026-02-02T00:00:00Z" },
      ],
    });

    expect(rows).toHaveLength(0);
  });
});

// ─── Ordering and filtering ───────────────────────────────────────────────────

describe("buildTaxReportRows — ordering and year filter", () => {
  const input = {
    poolPositions: [
      {
        id: "pos-2025",
        poolId: "pool-1",
        poolName: "Pool One",
        principalAmount: 100,
        earnedInterest: 5,
        openedAt: "2025-05-01T00:00:00Z",
        closedAt: "2025-12-01T00:00:00Z",
      },
      {
        id: "pos-2026",
        poolId: "pool-1",
        poolName: "Pool One",
        principalAmount: 100,
        earnedInterest: 7,
        openedAt: "2026-02-01T00:00:00Z",
        closedAt: null,
      },
    ],
  };

  it("returns rows newest first", () => {
    const rows = buildTaxReportRows(input);

    expect(rows.map((row) => row.date)).toEqual(["2026-02-01", "2025-12-01"]);
  });

  it("restricts to a single calendar year", () => {
    const rows = buildTaxReportRows({ ...input, year: 2025 });

    expect(rows).toHaveLength(1);
    expect(rows[0].reference).toBe("pos-2025");
  });

  it("returns every year when no year is given", () => {
    expect(buildTaxReportRows(input)).toHaveLength(2);
    expect(buildTaxReportRows({ ...input, year: null })).toHaveLength(2);
  });

  it("returns nothing for a year with no activity", () => {
    expect(buildTaxReportRows({ ...input, year: 2019 })).toHaveLength(0);
  });

  it("handles a completely empty portfolio", () => {
    expect(buildTaxReportRows({})).toEqual([]);
  });
});

// ─── Summary ──────────────────────────────────────────────────────────────────

describe("summarizeTaxReport", () => {
  const rows = buildTaxReportRows({
    poolPositions: [
      {
        id: "pos-1",
        poolId: "pool-1",
        poolName: "Pool One",
        asset: "XLM",
        principalAmount: 1000,
        earnedInterest: 40,
        openedAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "pos-2",
        poolId: "pool-2",
        poolName: "USDC Pool",
        asset: "USDC",
        principalAmount: 500,
        earnedInterest: 25,
        openedAt: "2026-02-01T00:00:00Z",
      },
    ],
  });

  it("totals interest across every row", () => {
    expect(summarizeTaxReport(rows).totalInterest).toBe(65);
  });

  it("breaks the total down per asset", () => {
    expect(summarizeTaxReport(rows).byAsset).toEqual({ XLM: 40, USDC: 25 });
  });

  it("counts the rows", () => {
    expect(summarizeTaxReport(rows).rowCount).toBe(2);
  });

  it("counts each position's principal once", () => {
    expect(summarizeTaxReport(rows).totalPrincipalDeployed).toBe(1500);
  });

  it("does not double-count principal when a loan pays interest twice", () => {
    const multi = buildTaxReportRows({
      fundings: [{ loanId: "loan-1", amount: 100, date: "2026-01-01T00:00:00Z" }],
      repayments: [
        { loanId: "loan-1", amount: 110, date: "2026-02-01T00:00:00Z" },
        { loanId: "loan-1", amount: 10, date: "2026-03-01T00:00:00Z" },
      ],
    });

    expect(multi).toHaveLength(2);
    expect(summarizeTaxReport(multi).totalPrincipalDeployed).toBe(100);
  });

  it("summarises an empty report as zero", () => {
    expect(summarizeTaxReport([])).toEqual({
      rowCount: 0,
      totalInterest: 0,
      byAsset: {},
      totalPrincipalDeployed: 0,
    });
  });
});

// ─── CSV serialization ────────────────────────────────────────────────────────

describe("escapeCsvCell", () => {
  it("leaves a plain value alone", () => {
    expect(escapeCsvCell("XLM")).toBe("XLM");
  });

  it("quotes a value containing a comma", () => {
    expect(escapeCsvCell("Pool, Stable")).toBe('"Pool, Stable"');
  });

  it("doubles embedded quotes", () => {
    expect(escapeCsvCell('He said "hi"')).toBe('"He said ""hi"""');
  });

  it("quotes values containing newlines", () => {
    expect(escapeCsvCell("a\nb")).toBe('"a\nb"');
    expect(escapeCsvCell("a\r\nb")).toBe('"a\r\nb"');
  });
});

describe("sanitizeCsvText", () => {
  it("neutralises formula prefixes", () => {
    // Opening this in Excel unescaped would execute the formula.
    for (const dangerous of ["=cmd()", "+1+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
      expect(sanitizeCsvText(dangerous).startsWith("'")).toBe(true);
    }
  });

  it("leaves ordinary text untouched", () => {
    expect(sanitizeCsvText("Stable Yield Pool")).toBe("Stable Yield Pool");
    expect(sanitizeCsvText("")).toBe("");
  });
});

describe("toCsv", () => {
  const rows = buildTaxReportRows({
    poolPositions: [
      {
        id: "pos-1",
        poolId: "pool-1",
        poolName: "Stable Yield Pool",
        asset: "XLM",
        principalAmount: 1000,
        earnedInterest: 42.5,
        openedAt: "2026-01-10T00:00:00Z",
        closedAt: "2026-06-30T00:00:00Z",
      },
    ],
  });

  it("starts with the header row", () => {
    const csv = toCsv(rows, { bom: false });

    expect(csv.split("\r\n")[0]).toBe(CSV_COLUMNS.join(","));
  });

  it("includes date, amount and asset — the acceptance criteria", () => {
    const csv = toCsv(rows, { bom: false });
    const header = csv.split("\r\n")[0].split(",");

    expect(header).toContain("date");
    expect(header).toContain("amount");
    expect(header).toContain("asset");

    const dataRow = csv.split("\r\n")[1].split(",");
    expect(dataRow[header.indexOf("date")]).toBe("2026-06-30");
    expect(dataRow[header.indexOf("asset")]).toBe("XLM");
    expect(dataRow[header.indexOf("amount")]).toBe("42.500000");
  });

  it("uses CRLF line endings per RFC 4180", () => {
    const csv = toCsv(rows, { bom: false });

    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("prefixes a UTF-8 BOM by default so Excel reads it correctly", () => {
    expect(toCsv(rows).startsWith("﻿")).toBe(true);
    expect(toCsv(rows, { bom: false }).startsWith("﻿")).toBe(false);
  });

  it("writes amounts at full 6-decimal precision", () => {
    const precise = buildTaxReportRows({
      poolPositions: [
        {
          id: "p",
          poolId: "pool",
          principalAmount: 1,
          earnedInterest: 0.123456,
          openedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    expect(toCsv(precise, { bom: false })).toContain("0.123456");
  });

  it("quotes a pool name containing a comma so columns do not shift", () => {
    const commaNamed = buildTaxReportRows({
      poolPositions: [
        {
          id: "p",
          poolId: "pool",
          poolName: "Pool, Stable",
          principalAmount: 1,
          earnedInterest: 1,
          openedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const csv = toCsv(commaNamed, { bom: false });
    expect(csv).toContain('"Pool, Stable"');
    // Header and data row must still agree on column count.
    const [header, data] = csv.split("\r\n");
    expect(splitCsvLine(data)).toHaveLength(header.split(",").length);
  });

  it("neutralises a formula injected through a pool name", () => {
    const malicious = buildTaxReportRows({
      poolPositions: [
        {
          id: "p",
          poolId: "pool",
          poolName: "=HYPERLINK(\"http://evil\",\"click\")",
          principalAmount: 1,
          earnedInterest: 1,
          openedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const csv = toCsv(malicious, { bom: false });
    expect(csv).not.toContain(",=HYPERLINK");
    expect(csv).toContain("'=HYPERLINK");
  });

  it("emits only a header for an empty report", () => {
    const csv = toCsv([], { bom: false });

    expect(csv).toBe(`${CSV_COLUMNS.join(",")}\r\n`);
  });
});

describe("taxReportFilename", () => {
  it("names the file after the year", () => {
    expect(taxReportFilename(2026)).toBe("trustlend-tax-report-2026.csv");
  });

  it("uses 'all' when no year is selected", () => {
    expect(taxReportFilename(null)).toBe("trustlend-tax-report-all.csv");
  });

  it("supports other extensions", () => {
    expect(taxReportFilename(2026, "pdf")).toBe("trustlend-tax-report-2026.pdf");
  });
});

describe("collectReportYears", () => {
  it("always offers the current year, even with no activity", () => {
    expect(collectReportYears([], 2026)).toEqual([2026]);
  });

  it("returns every year with activity, newest first", () => {
    const years = collectReportYears(
      ["2024-03-01T00:00:00Z", "2025-07-01T00:00:00Z", "2026-01-01T00:00:00Z"],
      2026
    );

    expect(years).toEqual([2026, 2025, 2024]);
  });

  it("deduplicates repeated years", () => {
    expect(collectReportYears(["2025-01-01T00:00:00Z", "2025-09-01T00:00:00Z"], 2026)).toEqual([
      2026, 2025,
    ]);
  });

  it("ignores null and unparseable dates", () => {
    expect(collectReportYears([null, undefined, "", "nonsense"], 2026)).toEqual([2026]);
  });

  it("includes years later than the current one if data has them", () => {
    expect(collectReportYears(["2027-01-01T00:00:00Z"], 2026)).toEqual([2027, 2026]);
  });
});

/** Minimal RFC 4180 splitter, used only to assert column counts in tests. */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  cells.push(current);
  return cells;
}
