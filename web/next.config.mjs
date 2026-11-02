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
};

export default nextConfig;
