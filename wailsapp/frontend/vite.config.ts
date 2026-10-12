import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  plugins: [react(), tailwindcss()],
  define: {
    __PLATFORM__: JSON.stringify(process.env.VITE_PLATFORM ?? 'win32')
  },
  server: {
    fs: {
      // 共享类型住在 wailsapp/shared，在 frontend 根目录之外
      allow: ['..']
    }
  },
  build: {
    outDir: 'dist'
  }
})
