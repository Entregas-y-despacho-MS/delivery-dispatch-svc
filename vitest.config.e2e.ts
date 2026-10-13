import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // E2E boots AppModule without a Google Cloud emulator. Keep these tests on the in-memory bus;
    // local Compose and deployed environments still select Pub/Sub through their own env config.
    env: {
      MESSAGING_ADAPTER: 'memory',
    },
    // Every e2e file boots its own app against the SAME database, so files must not run at the same time:
    // one file creating or deleting users/rows changes what another is counting or listing, and the suite
    // fails at random (see .claude/rules/testing.md). Slower (about 80 s) but deterministic.
    fileParallelism: false,
  },
});
