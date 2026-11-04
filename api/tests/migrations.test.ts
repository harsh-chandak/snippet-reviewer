import { afterAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import db from '../src/db/postgres';
import { migrator } from '../src/db/migrator';

// The test database was built by globalSetup with every migration. This file takes 004 down to 003
// and up again, on its own database (TEST_DATABASE_NAME), and checks the columns and CHECKs each way.
// It ends with every migration applied, so other files that run after it see the full schema.

const M004 = '004-static-analysis.ts';

const NEW_COLUMNS: Record<string, Record<string, { type: string; nullable: boolean; default: string | null }>> = {
  reviews: {
    phase: { type: 'character varying(20)', nullable: false, default: "'queued'::character varying" },
    phaseTimings: { type: 'jsonb', nullable: false, default: "'{}'::jsonb" },
    context: { type: 'character varying(20)', nullable: true, default: null },
    contextSignals: { type: 'jsonb', nullable: false, default: "'[]'::jsonb" },
    staticSupported: { type: 'boolean', nullable: true, default: null },
    duplicateCount: { type: 'integer', nullable: false, default: '0' },
    model: { type: 'character varying(80)', nullable: true, default: null },
    inputTokens: { type: 'integer', nullable: true, default: null },
    outputTokens: { type: 'integer', nullable: true, default: null },
    cacheReadTokens: { type: 'integer', nullable: true, default: null },
    cacheWriteTokens: { type: 'integer', nullable: true, default: null },
    costUsd: { type: 'double precision', nullable: true, default: null },
    costSource: { type: 'character varying(20)', nullable: true, default: null },
  },
  findings: {
    source: { type: 'character varying(10)', nullable: false, default: "'model'::character varying" },
    ruleId: { type: 'character varying(80)', nullable: true, default: null },
    fix: { type: 'jsonb', nullable: true, default: null },
    fixCheck: { type: 'character varying(20)', nullable: false, default: "'not_checked'::character varying" },
    fixCheckDetail: { type: 'jsonb', nullable: true, default: null },
  },
  snippets: {
    context: { type: 'character varying(20)', nullable: true, default: null },
  },
};

const NEW_CHECKS = [
  'reviews_phase_check',
  'reviews_context_check',
  'reviews_cost_source_check',
  'findings_source_check',
  'findings_fix_check_check',
  'snippets_context_check',
];

async function columns(table: string) {
  const rows = await db.query<{ name: string; type: string; nullable: boolean; default: string | null }>(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS default
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = :table::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    { replacements: { table }, type: QueryTypes.SELECT },
  );
  return Object.fromEntries(rows.map(({ name, ...rest }) => [name, rest]));
}

async function checkNames() {
  const rows = await db.query<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('reviews'::regclass, 'findings'::regclass, 'snippets'::regclass)`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.conname);
}

async function executed() {
  return (await migrator.executed()).map((m) => m.name);
}

// Runs `sql` inside a transaction that is always rolled back, and returns the error Postgres raised.
async function rejects(sql: string) {
  const t = await db.transaction();
  try {
    await db.query(sql, { transaction: t });
    return null;
  } catch (err) {
    return (err as { parent?: { constraint?: string } }).parent?.constraint ?? String(err);
  } finally {
    await t.rollback();
  }
}

async function expectSchemaAt004() {
  for (const [table, expected] of Object.entries(NEW_COLUMNS)) {
    const actual = await columns(table);
    for (const [name, spec] of Object.entries(expected)) {
      expect(actual[name], `${table}.${name}`).toEqual(spec);
    }
  }
  expect(await checkNames()).toEqual(expect.arrayContaining(NEW_CHECKS));
}

describe('migration 004-static-analysis', () => {
  afterAll(async () => {
    // Leave the database fully migrated whatever happened above.
    await migrator.up();
    await db.query('TRUNCATE TABLE findings, reviews, snippets RESTART IDENTITY CASCADE');
    await db.close();
  });

  it('is applied by the test setup, with the decided columns, defaults and CHECKs', async () => {
    expect((await executed()).at(-1)).toBe(M004);
    await expectSchemaAt004();
  });

  it('fills the defaults and refuses values outside the CHECKs', async () => {
    await db.query('TRUNCATE TABLE findings, reviews, snippets RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO snippets (title, language, code, "createdAt", "updatedAt") VALUES ('t', 'sql', 'SELECT 1', now(), now())`);
    await db.query(`INSERT INTO reviews ("snippetId", provider, "createdAt", "updatedAt") VALUES (1, 'fake', now(), now())`);
    await db.query(
      `INSERT INTO findings ("reviewId", "lineStart", "lineEnd", severity, category, description, "createdAt", "updatedAt")
       VALUES (1, 1, 1, 'info', 'style', 'x', now(), now())`,
    );

    const [review] = await db.query<Record<string, unknown>>('SELECT * FROM reviews', { type: QueryTypes.SELECT });
    expect(review).toMatchObject({
      phase: 'queued',
      phaseTimings: {},
      context: null,
      contextSignals: [],
      staticSupported: null,
      duplicateCount: 0,
      model: null,
      inputTokens: null,
      costUsd: null,
      costSource: null,
    });
    const [found] = await db.query<Record<string, unknown>>('SELECT * FROM findings', { type: QueryTypes.SELECT });
    expect(found).toMatchObject({ source: 'model', ruleId: null, fix: null, fixCheck: 'not_checked', fixCheckDetail: null });
    const [snippet] = await db.query<Record<string, unknown>>('SELECT * FROM snippets', { type: QueryTypes.SELECT });
    expect(snippet.context).toBeNull();

    expect(await rejects(`UPDATE reviews SET phase = 'thinking'`)).toBe('reviews_phase_check');
    expect(await rejects(`UPDATE reviews SET context = 'mobile'`)).toBe('reviews_context_check');
    expect(await rejects(`UPDATE reviews SET "costSource" = 'guess'`)).toBe('reviews_cost_source_check');
    expect(await rejects(`UPDATE findings SET source = 'human'`)).toBe('findings_source_check');
    expect(await rejects(`UPDATE findings SET "fixCheck" = 'maybe'`)).toBe('findings_fix_check_check');
    expect(await rejects(`UPDATE snippets SET context = 'mobile'`)).toBe('snippets_context_check');

    // Every allowed value goes in.
    expect(await rejects(`UPDATE reviews SET phase = 'checking', context = 'query', "costSource" = 'price-config', "costUsd" = 0.0123`)).toBeNull();
    expect(await rejects(`UPDATE findings SET source = 'rule', "ruleId" = 'sql/delete-without-where', "fixCheck" = 'passed'`)).toBeNull();
    expect(await rejects(`UPDATE snippets SET context = 'backend'`)).toBeNull();
  });

  it('goes down to 003, dropping every new column and CHECK, and keeps the rows', async () => {
    await migrator.down({ to: M004 });
    expect((await executed()).at(-1)).toBe('003-create-findings.ts');

    for (const [table, added] of Object.entries(NEW_COLUMNS)) {
      const actual = await columns(table);
      for (const name of Object.keys(added)) expect(actual[name], `${table}.${name}`).toBeUndefined();
    }
    const checks = await checkNames();
    for (const name of NEW_CHECKS) expect(checks).not.toContain(name);
    // The CHECKs from 001-003 are untouched.
    expect(checks).toEqual(
      expect.arrayContaining(['snippets_review_status_check', 'reviews_status_check', 'findings_status_check', 'findings_lines_check']),
    );

    const [counts] = await db.query<{ s: number; r: number; f: number }>(
      `SELECT (SELECT count(*)::int FROM snippets) AS s, (SELECT count(*)::int FROM reviews) AS r, (SELECT count(*)::int FROM findings) AS f`,
      { type: QueryTypes.SELECT },
    );
    expect(counts).toEqual({ s: 1, r: 1, f: 1 });
  });

  it('goes up again, and a review that had finished gets its status as its phase', async () => {
    await db.query(`UPDATE reviews SET status = 'done'`);
    await db.query(
      `INSERT INTO reviews ("snippetId", provider, status, "createdAt", "updatedAt") VALUES (1, 'fake', 'failed', now(), now())`,
    );

    await migrator.up();
    expect((await executed()).at(-1)).toBe(M004);
    await expectSchemaAt004();

    const rows = await db.query<{ status: string; phase: string }>('SELECT status, phase FROM reviews ORDER BY id', {
      type: QueryTypes.SELECT,
    });
    expect(rows).toEqual([
      { status: 'done', phase: 'done' },
      { status: 'failed', phase: 'failed' },
    ]);
  });
});
