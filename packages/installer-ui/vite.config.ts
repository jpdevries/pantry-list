import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

/**
 * The installer SPA is embedded into pantry-server via rust-embed at compile
 * time. Output lives under packages/server/static/installer/; assets are
 * served by the Rust server at `/_setup/static/*`.
 *
 * `dev` mode serves at the conventional Vite port and proxies /api/* to the
 * Rust server on 4001 so the wizard can hit real endpoints during local
 * development.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/_setup/static/',
  build: {
    outDir: path.resolve(__dirname, '../server/static/installer'),
    emptyOutDir: true,
    assetsDir: '.',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5176,
    proxy: {
      '/api': 'http://localhost:4001',
    },
  },
});
