/**
 * Resolve the absolute origin used to build referral links (Issue #266).
 *
 * A referral link is shared outside the app, so it must be absolute and must
 * point at the deployment the user is actually on. Preference order:
 *   1. NEXT_PUBLIC_SITE_URL — explicit, correct for production
 *   2. VERCEL_URL — set automatically on preview deployments
 *   3. the request's own origin/host — correct for local development
 */

/** Minimal shape needed from a Request; keeps this testable without Next. */
interface RequestLike {
  headers: { get(name: string): string | null };
  url?: string;
}

const LOCAL_FALLBACK = "http://localhost:3000";

function withProtocol(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  // VERCEL_URL and bare Host headers arrive without a scheme.
  return `https://${value}`;
}

/** Strip any trailing slashes so callers can append a path safely. */
function normalize(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveSiteUrl(request?: RequestLike): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return normalize(withProtocol(configured));

  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return normalize(withProtocol(vercel));

  if (request) {
    // Behind a proxy the original scheme survives in x-forwarded-proto.
    const forwardedHost = request.headers.get("x-forwarded-host");
    const host = forwardedHost ?? request.headers.get("host");
    if (host) {
      const proto =
        request.headers.get("x-forwarded-proto") ??
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      return normalize(`${proto}://${host}`);
    }

    if (request.url) {
      try {
        return normalize(new URL(request.url).origin);
      } catch {
        // Fall through to the local default.
      }
    }
  }

  return LOCAL_FALLBACK;
}
