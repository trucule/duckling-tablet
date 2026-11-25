import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'node:child_process';

// The commit this build came from and when, for diagnostics reports (web/src/report.ts).
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return 'unknown'; } })();
const BUILD = `${commit} ${new Date().toISOString().slice(0, 16)}Z`;

// Served from app.ducklingtablet.com (nginx root /opt/duckling/www/app). The shells load it in a WebView; the
// service worker caches the app shell so the tablet starts without a connection. The API is never cached.
export default defineConfig({
  define: { __DUCKLING_BUILD__: JSON.stringify(BUILD) },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png'],
      manifest: {
        name: 'Duckling Tablet', short_name: 'Duckling', start_url: '/', scope: '/', display: 'fullscreen', orientation: 'landscape',
        background_color: '#fffdf6', theme_color: '#fffdf6',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: { navigateFallback: '/index.html', globPatterns: ['**/*.{js,css,html,png,svg}'], runtimeCaching: [] },
    }),
  ],
  build: { target: 'es2020', sourcemap: false },
});
