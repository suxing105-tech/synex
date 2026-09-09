import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";

export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: process.env.VITEST ? { conditions: ["browser"] } : {},
  server: {
    port: 5173,
    // 显式绑 127.0.0.1，避免 Windows IPv6 优先时部分浏览器/工具走 127.0.0.1 连不上。
    // 想暴露给局域网/容器就用 --host 0.0.0.0 启动。
    host: "127.0.0.1",
    watch: {
      // src-tauri/target/ 内 .dll/.exe 频繁被 cargo 改写，触发 chokidar EBUSY
      // 用相对 frontend/ 的 glob 强制忽略
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
    proxy: {
      // uvicorn 后端默认 8765 端口（与 README quick-start 一致）。
      // 用环境变量 VITE_BACKEND_PORT 覆盖，便于开发时启用多 uvicorn 实例。
      "/api": "http://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8765"),
      "/thumbs": "http://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8765"),
      "/ws": {
        target: "ws://127.0.0.1:" + (process.env.VITE_BACKEND_PORT || "8765"),
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
