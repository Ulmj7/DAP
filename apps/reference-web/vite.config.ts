import { defaultClientConditions, defineConfig } from "vite";

// root = this app. `@dap/source` makes the workspace package resolve to its TypeScript source, the same condition tsconfig.base.json and Vitest use.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ["@dap/source", ...defaultClientConditions] },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "dist/web", emptyOutDir: true },
});
