import { describe, expect, it } from "vitest";
import {
  GLOSSARY,
  getGlossaryTerm,
  formatGlossaryDefinition,
  type GlossaryTermKey,
} from "@/lib/glossary/terms";

const ALL_KEYS = Object.keys(GLOSSARY) as GlossaryTermKey[];

describe("glossary terms", () => {
  it("covers the acronyms called out in issue #264", () => {
    expect(GLOSSARY.APY).toBeDefined();
    expect(GLOSSARY.LTV).toBeDefined();
    // APR is what the UI actually renders, so it must be explained too.
    expect(GLOSSARY.APR).toBeDefined();
  });

  it("gives every term a label, a full name, and a description", () => {
    for (const key of ALL_KEYS) {
      const term = GLOSSARY[key];
      expect(term.label.trim(), `${key} label`).not.toBe("");
      expect(term.full.trim(), `${key} full name`).not.toBe("");
      expect(term.description.trim(), `${key} description`).not.toBe("");
    }
  });

  it("keeps descriptions short enough to read inside a tooltip", () => {
    for (const key of ALL_KEYS) {
      // The tooltip is capped at 220px wide; anything much past this starts
      // to scroll off screen on mobile.
      expect(GLOSSARY[key].description.length, `${key} description`).toBeLessThanOrEqual(300);
    }
  });

  it("expands each acronym rather than defining it with itself", () => {
    // "APR" must not be explained as "APR is the APR of the loan".
    expect(GLOSSARY.APR.full).toBe("Annual Percentage Rate");
    expect(GLOSSARY.APY.full).toBe("Annual Percentage Yield");
    expect(GLOSSARY.LTV.full).toBe("Loan-to-Value");
  });

  it("returns the requested term via getGlossaryTerm", () => {
    expect(getGlossaryTerm("LTV")?.full).toBe("Loan-to-Value");
    expect(getGlossaryTerm("APY")?.label).toBe("APY");
  });

  it("returns undefined for an unknown key instead of throwing", () => {
    expect(
      getGlossaryTerm("NOT_A_TERM" as GlossaryTermKey)
    ).toBeUndefined();
  });
});

describe("formatGlossaryDefinition", () => {
  it("prefixes the expanded name for acronyms", () => {
    const text = formatGlossaryDefinition("LTV");
    expect(text.startsWith("Loan-to-Value — ")).toBe(true);
    expect(text).toContain(GLOSSARY.LTV.description);
  });

  it("omits the prefix when the label already is the full name", () => {
    // Avoids screen readers announcing "Health Factor: Health Factor — ...".
    const text = formatGlossaryDefinition("HEALTH_FACTOR");
    expect(text).toBe(GLOSSARY.HEALTH_FACTOR.description);
    expect(text.startsWith("Health Factor —")).toBe(false);
  });

  it("produces a non-empty definition for every term", () => {
    for (const key of ALL_KEYS) {
      expect(formatGlossaryDefinition(key).length, `${key}`).toBeGreaterThan(0);
    }
  });

  it("returns an empty string for an unknown key", () => {
    expect(formatGlossaryDefinition("NOPE" as GlossaryTermKey)).toBe("");
  });
});
