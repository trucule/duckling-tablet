import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served from app.ducklingtablet.com (nginx root /opt/duckling/www/app). The shells load it in a WebView; the
// service worker caches the app shell so the tablet starts without a connection. The API is never cached.
export default defineConfig({
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
