import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // CDK synth of the 8-combo matrix bundles Lambdas with esbuild; give it room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      include: ['lambda/**/*.ts', 'container/src/**/*.ts', 'infra/**/*.ts', 'shared/**/*.ts'],
    },
  },
});
