import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev-server only (no effect on the Vercel production build) - lets the
  // browser automation tooling's local connection complete the HMR handshake
  // that client hydration depends on; without it every page stays unhydrated.
  allowedDevOrigins: ["127.0.0.1"],

  turbopack: {
    // Pin the app root to web/. Without this, Turbopack walks up looking for
    // a lockfile, finds the unrelated one in the Windows home directory, and
    // warns on every dev start and build.
    root: dirname(fileURLToPath(import.meta.url)),
  },

  // Don't advertise the framework and its version in every response.
  poweredByHeader: false,

  async headers() {
    return [
      {
        // Every path, pages and /public files alike - headers are matched
        // before the filesystem.
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Both, deliberately: frame-ancestors is the one modern browsers
          // honour, X-Frame-Options is the fallback for anything that does
          // not read CSP. Clickjacking this app is not academic - the owner
          // screens carry destructive one-click actions (void a sale, delete
          // a product, deactivate a user).
          { key: "X-Frame-Options", value: "DENY" },
          // frame-ancestors ONLY. A full CSP here would need script-src
          // 'unsafe-inline' to survive Next's inline bootstrap and streaming
          // payload scripts, which buys little, or a nonce threaded through
          // the whole app, which is a separate piece of work.
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
