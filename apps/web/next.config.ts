import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  distDir: process.env.OUTREACH_QA_DIST_DIR ?? ".next",
  logging: false,
  // Creator Database eligibility can legitimately exceed Next's 30s external-rewrite default.
  experimental: { proxyTimeout: 180_000 },
  async rewrites() {
    const target = process.env.OUTREACH_QA_PROXY_TARGET ?? "http://localhost:4000";
    return [{ source: "/api/v1/:path*", destination: `${target}/api/v1/:path*` }];
  }
};
export default nextConfig;
