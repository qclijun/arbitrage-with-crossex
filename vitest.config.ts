import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/unit/helpers/setup.ts'],
        },
      },
      {
        test: {
          name: 'server',
          environment: 'node',
          include: ['tests/server/**/*.test.ts'],
          setupFiles: ['tests/server/helpers/setup.ts'],
        },
      },
    ],
  },
});
