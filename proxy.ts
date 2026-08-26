import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getDashboardPath, normalizeUserRole } from "@/lib/auth/roles";
import { recordRequestMetrics } from "@/lib/monitoring/metrics";
import { enforceGlobalApiRateLimit } from "@/lib/rate-limit";

const DEV_BYPASS_ENABLED =
  process.env.NODE_ENV !== "production" &&
  process.env.ENABLE_DEV_AUTH_BYPASS === "true";

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const method = request.method;
  const start = performance.now();

  // ── ① Short-circuit for static assets — no auth check needed ────────────────
  const isStatic =
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?|ttf|otf|css|js|map)$/.test(pathname);
  if (isStatic) return NextResponse.next({ request });

  const bypassUserId = request.headers.get("x-dev-user-id")?.trim() ?? "";
  const bypassRoleRaw = request.headers.get("x-dev-role")?.trim();
  const bypassActive = DEV_BYPASS_ENABLED && !!bypassUserId && isValidUuid(bypassUserId);

  // ── ② Global rate limit on API routes ───────────────────────────────────────
  // Hard ceiling of 100 requests per minute per IP across all `/api/*` routes.
  // Per-route granular limits (lib/rate-limit.ts) remain the primary control;
  // this is the safety net against brute-force and misconfigured clients.
  if (pathname.startsWith("/api/")) {
    const rateLimited = await enforceGlobalApiRateLimit(request);

    if (rateLimited) {
      const duration = (performance.now() - start) / 1000;
      recordRequestMetrics(method, pathname, 429, duration);
      return rateLimited;
    }
  }

  // ── ③ Supabase cookie-based session check (NO NETWORK CALL) ─────────────────
  // We use getSession() here because it reads the JWT from the cookie locally.
  // getUser() makes a live Supabase network call on every request and is the
  // cause of the 10 s connect-timeout errors. Full JWT verification happens
  // inside requireAuthenticatedUser() in each protected page/API route.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  // Securely get user via Supabase Auth server to prevent session spoofing warnings
  const { data: { user } } = await supabase.auth.getUser();

  const effectiveUser = bypassActive
    ? {
        id: bypassUserId,
        user_metadata: { account_type: normalizeUserRole(bypassRoleRaw) },
      }
    : user ?? null;

  const isDashboardPath = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const isAuthEntryPath = pathname === "/auth";

  if (isDashboardPath && !effectiveUser) {
    const duration = (performance.now() - start) / 1000;
    recordRequestMetrics(method, pathname, 302, duration);
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/auth";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  if (isAuthEntryPath && effectiveUser) {
    const duration = (performance.now() - start) / 1000;
    recordRequestMetrics(method, pathname, 302, duration);
    const redirectUrl = request.nextUrl.clone();
    const role = normalizeUserRole(effectiveUser.user_metadata?.account_type);
    redirectUrl.pathname = getDashboardPath(role);
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};