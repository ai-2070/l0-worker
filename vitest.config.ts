import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load .env file and merge with process.env
  const env = loadEnv(mode, process.cwd(), "");
  Object.assign(process.env, env);

  return {
    test: {
      // Increase timeout for E2E tests with real API calls
      testTimeout: 60000,
      // Inline problematic ESM dependencies
      server: {
        deps: {
          inline: ["@ai2070/l0"],
        },
      },
    },
  };
});
