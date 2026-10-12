import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import posthog from '@posthog/rollup-plugin'
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

  const sourceMapUpload = process.env.POSTHOG_CLI_API_KEY && process.env.POSTHOG_CLI_PROJECT_ID
    ? posthog({
        personalApiKey: process.env.POSTHOG_CLI_API_KEY,
        projectId: process.env.POSTHOG_CLI_PROJECT_ID,
        host: process.env.POSTHOG_CLI_HOST || 'https://us.posthog.com',
        sourcemaps: {
          enabled: true,
          releaseName: 'schedule-web',
          releaseVersion: process.env.VITE_RELEASE || 'development',
          deleteAfterUpload: true,
        },
      })
    : null
  if (sourceMapUpload) plugins.push(sourceMapUpload)

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
      sourcemap: Boolean(sourceMapUpload),
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
