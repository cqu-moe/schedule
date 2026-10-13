import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { themeInitScript } from '@cqu-moe/theme'

export default defineConfig(async () => {
  const plugins: PluginOption[] = [
    react(),
    tailwindcss(),
    {
      name: 'theme-init',
      transformIndexHtml: () => [
        { tag: 'script', children: themeInitScript, injectTo: 'head-prepend' },
      ],
    },
  ]

  if (process.env.ANALYZE === 'true') {
    const { visualizer } = await import('rollup-plugin-visualizer')
    plugins.push(visualizer({ open: true, filename: 'dist/stats.html' }))
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    base: '/',
    build: {
      sourcemap: false,
      outDir: 'dist',
      assetsDir: 'assets',
    },
    server: {
      port: 5173,
      proxy: {
        '/api/': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
        },
      },
    },
  }
})
