import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { JSDOM } from 'jsdom'
import posthog from '@posthog/rollup-plugin'
import { themeInitScript } from '@cqu-moe/theme'

export function renderChangelogHtml(markdown: string): string {
  const purify = DOMPurify(new JSDOM('').window)
  return purify.sanitize(marked.parse(markdown, { async: false }))
}

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
    define: {
      __APP_VERSION__: JSON.stringify(
        JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf-8')).version
      ),
      __CHANGELOG_HTML__: JSON.stringify(
        renderChangelogHtml(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md'), 'utf-8'))
      ),
    },
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
