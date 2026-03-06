import { fileURLToPath, URL } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(async () => {
  const plugins: PluginOption[] = [vue(), tailwindcss()]

  if (process.env.ANALYZE === 'true') {
    const { visualizer } = await import('rollup-plugin-visualizer')
    plugins.push(visualizer({ open: true, filename: 'dist/stats.html' }))
  }

  return {
    plugins,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    base: '/',
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        output: {
          manualChunks: {
            vendor: ['vue', 'vue-router', 'pinia', 'axios'],
            ui: ['reka-ui', 'lucide-vue-next', 'class-variance-authority', 'clsx', 'tailwind-merge'],
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
