import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 默认同源部署 —— 前端和后端在同一个 origin 下（Docker 模式），
 * 不需要路径前缀。如需挂在反向代理子路径下，用 VITE_BASE_PATH 和
 * VITE_API_PREFIX 覆盖。
 */
const DEFAULT_BASE_PATH = ''
const DEFAULT_API_PREFIX = ''

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const isServe = command === 'serve'

  const basePath = env.VITE_BASE_PATH ?? DEFAULT_BASE_PATH
  const apiPrefix = env.VITE_API_PREFIX ?? DEFAULT_API_PREFIX

  const backendOrigin = env.VITE_MANAGER_ORIGIN || 'http://localhost:3000'

  return {
    plugins: [vue()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    base: isServe ? '/' : (basePath ? `${basePath}/` : '/'),
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsDir: 'assets',
    },
    server: {
      port: Number(env.VITE_DEV_PORT) || 5180,
      host: true,
      allowedHosts: [
        ...(env.VITE_DEV_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
      ],
      proxy: {
        '/api': {
          target: backendOrigin,
          changeOrigin: true,
          secure: false,
          rewrite: apiPrefix
            ? (path) => path.replace(new RegExp(`^${apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
            : undefined,
        },
      },
    },
  }
})
