import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // Lets several dev servers run side by side (NEXT_DIST_DIR=.next-3201 next dev -p 3201).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["exceljs", "mammoth"],
  poweredByHeader: false,
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
  // CSP, frame-ancestors 'none', nosniff, referrer and permissions policies, HSTS in production (docs/SECURITY.md)
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({ production: process.env.NODE_ENV === "production", supabaseUrl: process.env.SUPABASE_URL }),
      },
    ];
  },
};

export default nextConfig;
