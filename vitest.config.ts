import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default vitest excludes, plus runs/: the pipeline's runtime artifacts include
    // generated Playwright specs (runs/**/generated*.spec.ts) that vitest would otherwise
    // try to execute as its own tests and fail on (they call @playwright/test's test.afterEach).
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      "runs/**",
    ],
  },
});
