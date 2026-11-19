import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], exclude: ['**/node_modules/**', ...(process.env.E2E ? [] : ['tests/e2e/**'])], testTimeout: 120000, hookTimeout: 120000, fileParallelism: true } });
