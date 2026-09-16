import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { marked } from 'marked'
import posthog from '@posthog/rollup-plugin'

export default defineConfig(async () => {
  const plugins: PluginOption[] = [vue(), tailwindcss()]

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
    define: {
      __APP_VERSION__: JSON.stringify(
        JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8')).version
      ),
      __CHANGELOG_HTML__: JSON.stringify(
        marked.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf-8'), { async: false })
      ),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    base: '/',
    build: {
      sourcemap: Boolean(sourceMapUpload),
      outDir: 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['vue', 'vue-router', 'pinia', 'axios'],
            ui: ['reka-ui', 'lucide-vue-next', 'class-variance-authority', 'clsx', 'tailwind-merge'],
            fullcalendar: ['@fullcalendar/core', '@fullcalendar/vue3', '@fullcalendar/daygrid', '@fullcalendar/timegrid'],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api/': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true
        }
      }
    }
  }
})
