import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The content script is nothing but DOM walking, so the tests need a real
    // Document with working Range/Selection rather than a stubbed one.
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
