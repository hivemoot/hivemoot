import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Run shared/war-room's own tests as part of the web suite — the
    // shared package is source-only and has no separate test runner.
    include: [
      "src/**/*.test.{ts,tsx}",
      "../shared/war-room/src/**/*.test.ts",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Mirror the package name + subpath so vitest's resolver matches
      // tsc's symlink-based resolution (tsc reaches the shared sources
      // through the npm `file:` symlink + `preserveSymlinks: true`,
      // not through a tsconfig `paths` entry). vitest's resolver
      // doesn't follow the symlink the same way, so explicit aliases
      // here keep the two toolchains in sync. Order matters: the
      // `/redis-lock` subpath alias must come BEFORE the bare package
      // alias or `path.startsWith` matching will route subpath requests
      // through the index re-export.
      "@hivemoot/war-room/redis-lock": path.resolve(
        __dirname,
        "../shared/war-room/src/redis-lock.ts",
      ),
      "@hivemoot/war-room": path.resolve(
        __dirname,
        "../shared/war-room/src/index.ts",
      ),
    },
  },
});
