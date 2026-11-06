import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/browser.test.ts', 'tests/access-ui.test.ts'],
    testTimeout: 40_000,
    env: { UPDATE_SCREENSHOTS: '1' },
  },
});
