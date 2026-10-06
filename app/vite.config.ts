import { defineConfig } from 'vite'

// base './' so the build can be served from the relay under /app/
export default defineConfig({
  base: './',
  server: { host: true, port: 5173, allowedHosts: true },
  build: { target: 'es2022' },
})
