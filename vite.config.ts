// A plain object: this folder has no vite of its own (the repository's app install runs it), so nothing is imported here.
export default {
  server: { port: 5191, strictPort: true, host: '127.0.0.1' },
  preview: { port: 5191, host: '127.0.0.1' },
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
};
