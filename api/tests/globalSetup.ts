import { execFileSync } from 'child_process';
import path from 'path';
import { Sequelize } from 'sequelize';
import { TEST_DATABASE_URL } from '../vitest.config';

const TEST_DB = 'snippets_test';
const apiDir = path.resolve(__dirname, '..');

// Runs once per `vitest run`, before any test file: drops and recreates snippets_test,
// then builds it with the real migrations (the same command as `npm run migrate`), never db.sync().
export default async function setup() {
  const url = new URL(TEST_DATABASE_URL);
  if (url.pathname !== `/${TEST_DB}`) {
    throw new Error(`Refusing to run tests against ${url.pathname}: the test database must be ${TEST_DB}`);
  }

  // DROP/CREATE DATABASE can't run while connected to that database, so connect to the dev one.
  // Nothing in the dev database is read or written.
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/snippets';
  const admin = new Sequelize(adminUrl.toString(), { dialect: 'postgres', logging: false });
  try {
    await admin.authenticate();
  } catch (err) {
    await admin.close();
    throw new Error(
      `Cannot reach Postgres at ${adminUrl.host}. Start it with \`docker compose up -d db\`. (${(err as Error).message})`,
    );
  }
  try {
    // WITH (FORCE) drops connections left over from an earlier run that was killed.
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.close();
  }

  const tsNode = path.join(apiDir, 'node_modules', 'ts-node', 'dist', 'bin.js');
  try {
    execFileSync(process.execPath, [tsNode, 'src/migrate.ts', 'up'], {
      cwd: apiDir,
      // Transpile only: `npx tsc --noEmit` is what typechecks the migrations.
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, TS_NODE_TRANSPILE_ONLY: 'true' },
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(`Migrations failed on ${TEST_DB}:\n${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`);
  }
}
