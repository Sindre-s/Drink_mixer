import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    assetsDir: "ui-assets"
  },
  server: {
    host: true,
    port: 5173
  }
});
