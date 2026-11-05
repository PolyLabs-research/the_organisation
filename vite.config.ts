import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The client is served by the API server: through Vite's middleware in
// development (see src/server/main.ts) and from dist/client in production.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
