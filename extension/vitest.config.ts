import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The content script is nothing but DOM walking, so the tests need a real
    // Document with working Range/Selection rather than a stubbed one.
    environment: "jsdom",
    environmentOptions: {
      // `getSelectionContext` picks its adapter from `window.location.hostname`,
      // and jsdom defaults that to `localhost`, which no adapter claims — every
      // test calling it would get null for a reason that has nothing to do with
      // the code under test. Tests that want the other site either call
      // `extractContext` with an explicit adapter or override this per file with
      // `@vitest-environment-options`.
      jsdom: { url: "https://chatgpt.com/" },
    },
    include: ["src/**/*.test.ts"],
  },
});
