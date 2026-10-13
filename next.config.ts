import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lets several dev servers run side by side (NEXT_DIST_DIR=.next-3201 next dev -p 3201).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  serverExternalPackages: ["exceljs", "mammoth"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
