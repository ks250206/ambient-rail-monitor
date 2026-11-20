import path from 'node:path';
import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { Connect } from 'vite';
import { defineConfig } from 'vite-plus';

const root = path.dirname(fileURLToPath(import.meta.url));
const apiTarget = process.env.RAILFLOW_URL || 'http://127.0.0.1:4173';

const pageRoute: Connect.NextHandleFunction = (req, _res, next) => {
  const match = req.url?.match(/^\/(projects|workflow|jobs)\/?(\?.*)?$/);
  if (match) req.url = '/' + match[1] + '.html' + (match[2] ?? '');
  next();
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'railflow-page-routes',
      configureServer(server) {
        server.middlewares.use(pageRoute);
      },
      configurePreviewServer(server) {
        server.middlewares.use(pageRoute);
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
        projects: path.resolve(root, 'projects.html'),
        jobs: path.resolve(root, 'jobs.html'),
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
