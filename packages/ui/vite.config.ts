import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemon = `http://127.0.0.1:${process.env.EXPRYTHING_PORT ?? 7717}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': daemon,
      '/ws': { target: daemon.replace('http', 'ws'), ws: true },
    },
  },
});
