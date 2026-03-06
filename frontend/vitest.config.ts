import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __CHANGELOG_HTML__: JSON.stringify('<h2>Test</h2>'),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    pool: 'vmForks',
    setupFiles: ['./src/test-setup.ts'],
  },
})
