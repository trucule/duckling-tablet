import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// Served from parents.ducklingtablet.com (nginx root /opt/duckling/www/portal, every path falls back to index.html).
export default defineConfig({ plugins: [preact()], build: { target: 'es2020' } });
