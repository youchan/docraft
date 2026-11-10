import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Defaults: src/main/index.ts, src/preload/index.ts, src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
