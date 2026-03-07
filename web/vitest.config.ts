import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify("2026-01-01T00:00:00.000Z"),
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary"],
      thresholds: {
        global: {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
    include: ["server/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx", "bin/**/*.test.ts"],
    environmentMatchGlobs: [
      ["src/**/*.test.ts", "jsdom"],
      ["src/**/*.test.tsx", "jsdom"],
    ],
    setupFiles: ["src/test-setup.ts"],
    // React 19.2+ only exports `act` in the development CJS build.
    // Without this, jsdom tests load react.production.js which breaks
    // @testing-library/react's act() calls.
    env: { NODE_ENV: "test" },
  },
});
