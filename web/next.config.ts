import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The `@hivemoot/war-room` shared package is installed via
  // `file:../shared/war-room` and lives outside the web/ project root.
  // `outputFileTracingRoot` extends the deploy bundle's lambda input
  // scope to the monorepo root so the shared sources are uploaded
  // alongside web's output.
  outputFileTracingRoot: path.join(__dirname, ".."),
  // The shared package's source `.ts` files need the same TS transpile
  // pass that web/ source gets. Without `transpilePackages`, Next would
  // treat them as already-compiled and feed them to the runtime as-is.
  transpilePackages: ["@hivemoot/war-room"],
};

export default nextConfig;
