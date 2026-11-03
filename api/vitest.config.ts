import { defineConfig } from 'vitest/config';

// The suite runs against a real Postgres database (snippets_test on the compose Postgres),
// built by the migrations in tests/globalSetup.ts. LLM_PROVIDER=fake, so no test calls a model.
export const TEST_DATABASE_URL = 'postgres://snippets:snippets@localhost:5433/snippets_test';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Set in each test worker before any app module is imported. Values already set here
    // win over the repo .env, because loadEnv's dotenv never overrides the environment.
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      LLM_PROVIDER: 'fake',
      NODE_ENV: 'test',
    },
    globalSetup: ['tests/globalSetup.ts'],
    // Every file shares the one database, so files run one at a time.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
