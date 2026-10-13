/**
 * HTTP security headers for every response (next.config.ts `headers()`). PURE, so it is unit tested and
 * next.config.ts can import it by relative path.
 *
 * The CSP allows inline scripts: the App Router streams its RSC payload in inline <script> tags, and a nonce would
 * need every page to read a per-request nonce from middleware. Everything else is locked to this origin (plus
 * Supabase Storage for proof images and direct import uploads), frames are refused, and plugins, <base> and
 * cross-site form posts are off. See docs/SECURITY.md.
 */

export type HeaderOptions = {
  production: boolean;
  /** SUPABASE_URL, when files live in Supabase Storage (signed proof URLs are shown as images; imports upload there) */
  supabaseUrl?: string | null;
};

function origin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(opts: HeaderOptions): string {
  const storage = origin(opts.supabaseUrl);
  const extra = storage ? ` ${storage}` : "";
  const directives = [
    "default-src 'self'",
    // 'unsafe-eval' only in development (React Refresh); never in production
    `script-src 'self' 'unsafe-inline'${opts.production ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${extra}`,
    "font-src 'self' data:",
    `connect-src 'self'${extra}${opts.production ? "" : " ws: wss:"}`,
    "media-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(opts.production ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

export function securityHeaders(opts: HeaderOptions): { key: string; value: string }[] {
  const headers = [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(opts) },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()",
    },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
  if (opts.production) {
    headers.push({ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" });
  }
  return headers;
}
