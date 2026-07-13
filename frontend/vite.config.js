import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxy de desenvolvimento: encaminha /api para o backend na porta 3001,
// útil quando VITE_API_URL não é definido.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
});
