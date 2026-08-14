import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is overridable so the site can be served from a GitHub Pages project
// path (https://user.github.io/math-family-tree/) as well as from a domain root.
export default defineConfig({
  plugins: [react()],
  base: process.env.SITE_BASE ?? '/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
