import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // File events don't always reach containers through bind mounts
    watch: { usePolling: process.env.VITE_POLL === "true" },
    // The UI imports the shared schema types from ../src
    fs: { allow: [".."] },
  },
});
