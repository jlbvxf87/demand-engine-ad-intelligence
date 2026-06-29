import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Remotion's renderer/bundler are Node-only (native deps, spawn Chromium) —
  // never pull them into Next's server bundle.
  serverExternalPackages: ["@remotion/bundler", "@remotion/renderer", "remotion"],
  // The draft renderer bundles ./remotion/* at runtime via a filesystem path, so
  // Next's tracer can't see it — include it in that route's serverless function.
  outputFileTracingIncludes: {
    "/api/renders/draft": ["./remotion/**/*"],
  },
  // Real ad images come from Meta's CDN and OpenAI; allow remote images.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.fbcdn.net" },
      { protocol: "https", hostname: "**.facebook.com" },
      { protocol: "https", hostname: "scontent.**" },
      { protocol: "https", hostname: "**.supabase.co" },
      { protocol: "https", hostname: "oaidalleapiprodscus.blob.core.windows.net" },
      { protocol: "https", hostname: "**.blob.core.windows.net" },
    ],
  },
};

export default nextConfig;
