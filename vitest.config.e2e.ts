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
      // The minute tick must not run tasks while a suite is using the shared database.
      SCHEDULER_ENABLED: 'false',
      // CACHE_ADAPTER defaults to redis, and the settings snapshot lives under one fixed key (`settings:snapshot`).
      // A suite pointed at a throwaway database would share that key with any app running on the same Redis
      // (the local Compose stack polls it every 60 s), so settings written by a test were overwritten by the
      // other app's values and suites that read settings failed at random. Keep the cache in this process.
      CACHE_ADAPTER: 'memory',
    },
    // Every e2e file boots its own app against the SAME database, so files must not run at the same time:
    // one file creating or deleting users/rows changes what another is counting or listing, and the suite
    // fails at random (see .claude/rules/testing.md). Slower (about 80 s) but deterministic.
    fileParallelism: false,
  },
});
