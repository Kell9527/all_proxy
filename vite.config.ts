import { defineConfig } from 'vite'

/**
 * 管理端构建配置。
 *
 * - `root: 'web'`：源码在 web/，产物输出到 web/dist/（由网关进程托管）；
 * - 开发态 `/api`（与 `/v1`）代理到网关进程 —— 热更新照常，数据是真实的
 *   （tasks 11.1）。端口 3877 是网关默认端口，可用 ALL_PROXY_PORT 覆盖。
 */

const gateway = `http://127.0.0.1:${process.env['ALL_PROXY_PORT'] ?? '3877'}`

export default defineConfig({
  root: 'web',
  plugins: [],
  server: {
    proxy: {
      '/api': gateway,
      '/v1': gateway,
      '/health': gateway,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 产物文件名带内容哈希：网关据此下发一年 immutable 缓存。
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
