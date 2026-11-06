import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Served from app.ducklingtablet.com (nginx root /opt/duckling/www/app). The shells load it in a WebView.
export default defineConfig({ plugins: [preact()], build: { target: 'es2020', sourcemap: false } });
