import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React UI is built into web/dist and served by Express at /app/ (see src/server/index.ts),
// next to the classic UI at /. In `npm run web:dev`, API and run-file calls go to the local server.
export default defineConfig({
  root: __dirname,
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
      "/runs": "http://localhost:3001",
      "/style.css": "http://localhost:3001",
      "/theme.css": "http://localhost:3001",
    },
  },
});
