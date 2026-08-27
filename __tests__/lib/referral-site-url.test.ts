import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSiteUrl } from "@/lib/referrals/site-url";

function requestWith(headers: Record<string, string>, url?: string) {
  return {
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    url,
  };
}

const ENV_KEYS = ["NEXT_PUBLIC_SITE_URL", "VERCEL_URL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveSiteUrl", () => {
  it("prefers NEXT_PUBLIC_SITE_URL above everything else", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://trustlend.app";
    process.env.VERCEL_URL = "preview.vercel.app";
    expect(resolveSiteUrl(requestWith({ host: "localhost:3000" }))).toBe(
      "https://trustlend.app",
    );
  });

  it("strips a trailing slash so a path can be appended safely", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://trustlend.app/";
    expect(resolveSiteUrl()).toBe("https://trustlend.app");
  });

  it("adds a scheme when the configured value has none", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "trustlend.app";
    expect(resolveSiteUrl()).toBe("https://trustlend.app");
  });

  it("falls back to VERCEL_URL on preview deployments", () => {
    process.env.VERCEL_URL = "trustlend-abc123.vercel.app";
    expect(resolveSiteUrl()).toBe("https://trustlend-abc123.vercel.app");
  });

  it("uses the request host when no env var is configured", () => {
    expect(resolveSiteUrl(requestWith({ host: "staging.example.com" }))).toBe(
      "https://staging.example.com",
    );
  });

  it("honours x-forwarded-host and x-forwarded-proto behind a proxy", () => {
    expect(
      resolveSiteUrl(
        requestWith({
          host: "internal:8080",
          "x-forwarded-host": "trustlend.app",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBe("https://trustlend.app");
  });

  it("uses http for localhost so dev links are clickable", () => {
    expect(resolveSiteUrl(requestWith({ host: "localhost:3000" }))).toBe(
      "http://localhost:3000",
    );
    expect(resolveSiteUrl(requestWith({ host: "127.0.0.1:3000" }))).toBe(
      "http://127.0.0.1:3000",
    );
  });

  it("falls back to the request URL origin when there is no host header", () => {
    expect(
      resolveSiteUrl(requestWith({}, "https://fallback.example.com/api/referrals")),
    ).toBe("https://fallback.example.com");
  });

  it("returns the local default when it has nothing to work from", () => {
    expect(resolveSiteUrl()).toBe("http://localhost:3000");
    expect(resolveSiteUrl(requestWith({}))).toBe("http://localhost:3000");
  });

  it("never returns a trailing slash, whatever the source", () => {
    const cases = [
      () => resolveSiteUrl(),
      () => resolveSiteUrl(requestWith({ host: "example.com" })),
      () => resolveSiteUrl(requestWith({}, "https://example.com/x")),
    ];
    for (const run of cases) {
      expect(run().endsWith("/")).toBe(false);
    }
  });
});
