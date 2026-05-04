import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forward API calls to the Rust backend when running `bun run dev`.
      // In production the frontend is served by the same axum server so
      // `/api/*` is already same-origin and this proxy isn't used.
      '/api': 'http://localhost:5001',
    },
  },
});
