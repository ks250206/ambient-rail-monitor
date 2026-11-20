import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

const apiTarget = process.env.RAILFLOW_URL || 'http://127.0.0.1:4173';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: false,
      },
      '/artifacts': {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
  fmt: {
    singleQuote: true,
    semi: true,
    ignorePatterns: ['dist/**', 'artifacts/**', 'data/**', 'inbox/**', 'work/**', '.agents/**'],
  },
  lint: {
    ignorePatterns: ['dist/**', 'artifacts/**', 'data/**', 'inbox/**', 'work/**', '.agents/**'],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
