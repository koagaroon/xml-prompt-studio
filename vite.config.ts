import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server host + port. Single source of truth — `devUrl` in
// tauri.conf.json must point to http://127.0.0.1:1420 to match.
// Don't override either side without changing the other.
const DEV_HOST = "127.0.0.1";
const DEV_PORT = 1420;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true
  }
});
