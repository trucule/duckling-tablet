import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

// Served from parents.ducklingtablet.com (nginx root /opt/duckling/www/portal, every path falls back to index.html).
// Installable as a PWA: the app shell is cached, the API is never cached.
export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'logo.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Duckling Tablet Parents',
        short_name: 'Duckling Parents',
        description: 'Manage your family\'s Duckling tablets: children, devices, websites, apps.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f4f5f2',
        theme_color: '#f4f5f2',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,png,svg}'],
        // The API and the CDN are always live; nothing from them is cached by the service worker.
        navigateFallbackDenylist: [/^\/signin/],
        runtimeCaching: [],
      },
    }),
  ],
  build: { target: 'es2020' },
});
