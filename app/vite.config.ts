import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dev server proxies the API to a local Host-Caster server (cd server && npm run dev).
const API = process.env.HOSTCASTER_API ?? 'http://127.0.0.1:8660';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    proxy: { '/api': API, '/auth': API, '/mcp': API },
  },
  build: {
    target: 'es2022',
    // Off for shipped builds: source maps carry the build machine's absolute paths. HOSTCASTER_SOURCEMAP=1 to debug.
    sourcemap: process.env.HOSTCASTER_SOURCEMAP === '1',
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test/setup.ts'],
  },
});
