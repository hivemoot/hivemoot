import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["api/**/*.ts"],
      exclude: ["**/*.test.ts"],
      thresholds: {
        statements: 83,
        branches: 81,
        functions: 88,
        lines: 84,
      },
    },
  },
});
