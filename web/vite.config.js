import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * 产物落 web/dist，由 agent 的 HTTP 层直接当静态目录服务（src/http/server.js 的 WEB_DIR）。
 *
 * `assetsDir: 'assets'` 不是默认值凑巧对上 —— 服务端只放行 `/assets/*` 这一条通配路由
 * （其余路径一律 404，见 serveStatic 的 confineTo）。改这个名字会让所有 JS/CSS 404，
 * 而首页 HTML 还能正常返回，表现为"白屏但没报 404 页面"。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 线上是内网 http 域名，没人会去看 sourcemap；少几 MB 产物
    sourcemap: false,
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    // 本地 `npm run dev` 时把接口打到本机跑着的 agent 上，
    // 这样前端热更新与真实后端可以同时用。
    proxy: {
      '/v1': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/metrics.json': 'http://127.0.0.1:8787',
    },
  },
})
