import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment — engine files use no DOM APIs
    environment: 'node',
    // Inject describe/it/expect as globals so test files need no imports
    globals: true,
    // Run the stub setup before every test file
    setupFiles: ['./tests/setup.js'],
    // Only collect files under tests/
    include: ['tests/**/*.test.js'],
  },
});
