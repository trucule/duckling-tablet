import { defineConfig } from 'vitest/config';

// Each test file starts its own embedded PostgreSQL, which takes a few seconds the first time.
export default defineConfig({ test: { hookTimeout: 120_000, testTimeout: 30_000 } });
