import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [
    react(),
    tailwindcss(),
  ],

  clearScreen: false,

  server: {
    port: 1431,
    strictPort: true,
    host: host || "localhost",
    hmr: {
      protocol: "ws",
      host: host || "localhost",
      port: 1431,
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));