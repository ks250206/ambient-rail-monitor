import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite-plus';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = process.env.RAILFLOW_URL || 'http://127.0.0.1:4173';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'railflow-workflow-route',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/workflow' || req.url === '/workflow/') {
            req.url = '/workflow.html';
          }
          next();
        });
      },
    },
  ],
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
    rollupOptions: {
      input: {
        main: path.resolve(root, 'index.html'),
        workflow: path.resolve(root, 'workflow.html'),
      },
    },
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
