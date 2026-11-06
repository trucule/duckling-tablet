import { defineConfig } from 'vitest/config';

// Each test file starts its own embedded PostgreSQL (and the browser tests a Chromium), so files run one at a time:
// in parallel the six clusters plus three browsers made the portal test time out once on a loaded machine.
export default defineConfig({ test: { hookTimeout: 120_000, testTimeout: 30_000, fileParallelism: false } });
