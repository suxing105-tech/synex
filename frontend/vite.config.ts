import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      // uvicorn 后端默认 8000 端口。
      // 用环境变量 VITE_BACKEND_PORT 覆盖，便于开发时启用多 uvicorn 实例。
      "/api": "http://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8000"),
      "/thumbs": "http://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8000"),
      "/ws": {
        target: "ws://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8000"),
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  test: {
    environment: "happy-dom",
    globals: true,
  },
});
