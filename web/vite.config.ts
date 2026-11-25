import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI is served by Vite in dev and by the Express server in production.
// Keeping /api on a separate port means the browser still talks to the local
// filesystem service, never uploading media through the page itself.
export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 explicitly: Vite's default (::1) leaves http://127.0.0.1 dead.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
