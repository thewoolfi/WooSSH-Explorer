import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_TARGET = process.env.SSH_EXPLORER_API ?? 'http://127.0.0.1:5178';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // xterm is by far the heaviest dependency and is only needed once a
        // terminal tab is opened, so it stays out of the initial chunk.
        manualChunks: {
          terminal: ['@xterm/xterm', '@xterm/addon-fit'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
