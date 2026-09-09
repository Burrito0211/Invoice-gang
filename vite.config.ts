import { defineConfig } from 'vite';

// The dashboard is a static bundle served by the Worker's assets binding.
export default defineConfig({
  root: 'web',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
});
