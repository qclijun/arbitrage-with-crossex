import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Throwaway, offline host for issue 05. No API proxy or production entry.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 8795, strictPort: true },
});
