import { afterAll, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import db from '../src/db/postgres';
import { migrator } from '../src/db/migrator';

// The test database was built by globalSetup with every migration. This file takes 004 down to 003,
// 005 down to 004, 006 down to 005, 007 down to 006 and 008 down to 007, and up again, on its own database (TEST_DATABASE_NAME), and checks the
// columns, CHECKs and views each way. It ends with every migration applied, so other files that run
// after it see the full schema.

const M004 = '004-static-analysis.ts';
const M005 = '005-review-events.ts';
const M006 = '006-event-fixes.ts';
const M007 = '007-analysis-error.ts';
const M008 = '008-review-summary.ts';
const M009 = '009-cost-source-price-table.ts';
// The last migration: every test that runs them all up again ends here.
const LATEST = M009;

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

afterAll(async () => {
  // Leave the database fully migrated whatever happened below.
  await migrator.up();
  await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
  await db.close();
});

describe('migration 004-static-analysis', () => {
  it('is applied by the test setup, with the decided columns, defaults and CHECKs', async () => {
    expect(await executed()).toContain(M004);
    expect((await executed()).at(-1)).toBe(LATEST);
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
    expect((await executed()).at(-1)).toBe(LATEST);
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

const EVENT_TYPES = [
  'review.started',
  'static.parsed',
  'static.rule_hit',
  'model.called',
  'model.failed',
  'model.finding_kept',
  'model.finding_rejected',
  'model.duplicate',
  'fix.checked',
  'review.done',
  'review.failed',
  'finding.resolved',
  'events.truncated',
];
const VIEWS = ['v_model_rejections', 'v_review_costs', 'v_rule_feedback'];

async function tableExists(name: string) {
  const [row] = await db.query<{ t: string | null }>(`SELECT to_regclass(:name)::text AS t`, {
    replacements: { name },
    type: QueryTypes.SELECT,
  });
  return row.t !== null;
}

async function views() {
  const rows = await db.query<{ name: string }>(
    `SELECT table_name AS name FROM information_schema.views WHERE table_schema = 'public' ORDER BY 1`,
    { type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.name);
}

async function viewColumns(view: string) {
  const rows = await db.query<{ name: string }>(
    `SELECT column_name AS name FROM information_schema.columns WHERE table_name = :view ORDER BY ordinal_position`,
    { replacements: { view }, type: QueryTypes.SELECT },
  );
  return rows.map((r) => r.name);
}

async function expectSchemaAt005() {
  expect(await columns('review_events')).toEqual({
    id: { type: 'integer', nullable: false, default: "nextval('review_events_id_seq'::regclass)" },
    reviewId: { type: 'integer', nullable: false, default: null },
    type: { type: 'character varying(40)', nullable: false, default: null },
    payload: { type: 'jsonb', nullable: false, default: "'{}'::jsonb" },
    createdAt: { type: 'timestamp with time zone', nullable: false, default: 'now()' },
  });
  const reviews = await columns('reviews');
  expect(reviews.promptVersion).toEqual({ type: 'character varying(40)', nullable: true, default: null });
  expect(reviews.rulesetVersion).toEqual({ type: 'character varying(40)', nullable: true, default: null });

  const [fk] = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'review_events'::regclass AND contype = 'f'`,
    { type: QueryTypes.SELECT },
  );
  expect(fk.def).toContain('REFERENCES reviews(id)');
  expect(fk.def).toContain('ON DELETE CASCADE');
  const [index] = await db.query<{ def: string }>(
    `SELECT indexdef AS def FROM pg_indexes WHERE tablename = 'review_events' AND indexname = 'review_events_review_id_id'`,
    { type: QueryTypes.SELECT },
  );
  expect(index.def).toContain('("reviewId", id)');

  expect(await views()).toEqual(expect.arrayContaining(VIEWS));
  expect(await viewColumns('v_rule_feedback')).toEqual(['ruleId', 'findings', 'accepted', 'dismissed', 'open', 'dismiss_rate']);
  expect(await viewColumns('v_review_costs')).toEqual([
    'reviewId',
    'language',
    'context',
    'model',
    'promptVersion',
    'totalInputTokens',
    'outputTokens',
    'cacheReadTokens',
    'costUsd',
    'staticMs',
    'modelMs',
    'checkingMs',
  ]);
  expect(await viewColumns('v_model_rejections')).toEqual(['reason', 'count']);
}

describe('migration 005-review-events', () => {
  it('is applied by the test setup, with the decided table, CHECK, index, version columns and views', async () => {
    expect(await executed()).toContain(M005);
    await expectSchemaAt005();
  });

  it('accepts every decided event type, fills the defaults, refuses any other type and cascades on delete', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO snippets (title, language, code, "createdAt", "updatedAt") VALUES ('t', 'sql', 'SELECT 1', now(), now())`);
    await db.query(`INSERT INTO reviews ("snippetId", provider, "createdAt", "updatedAt") VALUES (1, 'fake', now(), now())`);

    for (const type of EVENT_TYPES) {
      expect(await rejects(`INSERT INTO review_events ("reviewId", type) VALUES (1, '${type}')`), type).toBeNull();
    }
    expect(await rejects(`INSERT INTO review_events ("reviewId", type) VALUES (1, 'model.thought')`)).toBe(
      'review_events_type_check',
    );

    await db.query(`INSERT INTO review_events ("reviewId", type) VALUES (1, 'review.started')`);
    const [row] = await db.query<Record<string, unknown>>('SELECT * FROM review_events', { type: QueryTypes.SELECT });
    expect(row).toMatchObject({ reviewId: 1, type: 'review.started', payload: {} });
    expect(row.createdAt).toBeInstanceOf(Date);

    const [review] = await db.query<Record<string, unknown>>('SELECT * FROM reviews', { type: QueryTypes.SELECT });
    expect(review).toMatchObject({ promptVersion: null, rulesetVersion: null });

    const t = await db.transaction();
    try {
      await db.query('DELETE FROM reviews', { transaction: t });
      const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM review_events', {
        type: QueryTypes.SELECT,
        transaction: t,
      });
      expect(n).toBe(0);
    } finally {
      await t.rollback();
    }
  });

  it('answers the first questions from the views', async () => {
    // 005's own view definitions; 006 redefines two of them (tested below).
    await migrator.down({ to: M006 });
    expect((await executed()).at(-1)).toBe(M005);
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    await db.query(`INSERT INTO snippets (title, language, code, "createdAt", "updatedAt") VALUES ('t', 'javascript', 'x', now(), now())`);
    await db.query(
      `INSERT INTO reviews ("snippetId", provider, status, phase, context, model, "promptVersion", "inputTokens", "outputTokens",
                            "cacheReadTokens", "cacheWriteTokens", "costUsd", "phaseTimings", "createdAt", "updatedAt")
       VALUES (1, 'fake', 'done', 'done', 'backend', 'm', 'abc123def456', 2, 407, 10, 1948, 0.0089,
               '{"static": 12, "model": 5800, "checking": 3}', now(), now()),
              (1, 'fake', 'failed', 'failed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', now(), now())`,
    );
    const insertFinding = (source: string, ruleId: string | null, status: string) =>
      db.query(
        `INSERT INTO findings ("reviewId", source, "ruleId", status, "lineStart", "lineEnd", severity, category, description, "createdAt", "updatedAt")
         VALUES (1, :source, :ruleId, :status, 1, 1, 'warning', 'bug', 'x', now(), now())`,
        { replacements: { source, ruleId, status } },
      );
    await insertFinding('rule', 'js/eval', 'accepted');
    await insertFinding('rule', 'js/eval', 'dismissed');
    await insertFinding('rule', 'js/eval', 'dismissed');
    await insertFinding('rule', 'js/eval', 'open');
    await insertFinding('rule', 'js/loose-equality', 'open');
    await insertFinding('model', null, 'dismissed');

    const feedback = await db.query('SELECT * FROM v_rule_feedback ORDER BY "ruleId"', { type: QueryTypes.SELECT });
    expect(feedback).toEqual([
      { ruleId: 'js/eval', findings: 4, accepted: 1, dismissed: 2, open: 1, dismiss_rate: 2 / 3 },
      { ruleId: 'js/loose-equality', findings: 1, accepted: 0, dismissed: 0, open: 1, dismiss_rate: null },
    ]);

    const costs = await db.query('SELECT * FROM v_review_costs ORDER BY "reviewId"', { type: QueryTypes.SELECT });
    expect(costs).toEqual([
      {
        reviewId: 1,
        language: 'javascript',
        context: 'backend',
        model: 'm',
        promptVersion: 'abc123def456',
        totalInputTokens: 1960,
        outputTokens: 407,
        cacheReadTokens: 10,
        costUsd: 0.0089,
        staticMs: 12,
        modelMs: 5800,
        checkingMs: 3,
      },
      {
        reviewId: 2,
        language: 'javascript',
        context: null,
        model: null,
        promptVersion: null,
        totalInputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        costUsd: null,
        staticMs: null,
        modelMs: null,
        checkingMs: null,
      },
    ]);

    await db.query(
      `INSERT INTO review_events ("reviewId", type, payload) VALUES
         (1, 'model.finding_rejected', '{"reason": "\\"severity\\" must be one of [critical, warning, info]", "raw": "{}"}'),
         (1, 'model.finding_rejected', '{"reason": "over the 100-finding limit", "raw": "{}"}'),
         (1, 'model.finding_rejected', '{"reason": "over the 100-finding limit", "raw": "{}"}'),
         (1, 'model.duplicate', '{"reason": "not a rejection"}')`,
    );
    const rejections = await db.query('SELECT * FROM v_model_rejections', { type: QueryTypes.SELECT });
    expect(rejections).toEqual([
      { reason: 'over the 100-finding limit', count: 2 },
      { reason: '"severity" must be one of [critical, warning, info]', count: 1 },
    ]);
  });

  it('goes down to 004, dropping the table, the views and the version columns, and keeps the reviews', async () => {
    await migrator.down({ to: M005 });
    expect((await executed()).at(-1)).toBe(M004);

    expect(await tableExists('review_events')).toBe(false);
    for (const view of VIEWS) expect(await views()).not.toContain(view);
    const reviews = await columns('reviews');
    expect(reviews.promptVersion).toBeUndefined();
    expect(reviews.rulesetVersion).toBeUndefined();
    // 004's columns are untouched.
    await expectSchemaAt004();

    const [{ n }] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM reviews', { type: QueryTypes.SELECT });
    expect(n).toBe(2);
  });

  it('goes up again', async () => {
    await migrator.up();
    expect((await executed()).at(-1)).toBe(LATEST);
    await expectSchemaAt005();
  });
});

// Inserts a snippet and one review with these token columns and rejectedCount; returns the review id.
async function insertReview(cols: { inputTokens?: number | null; cacheReadTokens?: number | null; cacheWriteTokens?: number | null; rejectedCount?: number }) {
  const [{ id: snippetId }] = await db.query<{ id: number }>(
    `INSERT INTO snippets (title, language, code, "createdAt", "updatedAt") VALUES ('t', 'javascript', 'x', now(), now()) RETURNING id`,
    { type: QueryTypes.SELECT },
  );
  const [{ id }] = await db.query<{ id: number }>(
    `INSERT INTO reviews ("snippetId", provider, status, phase, "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens",
                          "rejectedCount", "createdAt", "updatedAt")
     VALUES (:snippetId, 'fake', 'done', 'done', :inputTokens, 1, :cacheReadTokens, :cacheWriteTokens, :rejectedCount, now(), now())
     RETURNING id`,
    {
      replacements: {
        snippetId,
        inputTokens: cols.inputTokens ?? null,
        cacheReadTokens: cols.cacheReadTokens ?? null,
        cacheWriteTokens: cols.cacheWriteTokens ?? null,
        rejectedCount: cols.rejectedCount ?? 0,
      },
      type: QueryTypes.SELECT,
    },
  );
  return id;
}

async function insertRejections(reviewId: number, reasons: string[]) {
  for (const reason of reasons) {
    await db.query(`INSERT INTO review_events ("reviewId", type, payload) VALUES (:reviewId, 'model.finding_rejected', :payload::jsonb)`, {
      replacements: { reviewId, payload: JSON.stringify({ reason, raw: '{}' }) },
    });
  }
}

const select = (sql: string) => db.query<Record<string, any>>(sql, { type: QueryTypes.SELECT });

describe('migration 006-event-fixes', () => {
  it('is applied by the test setup', async () => {
    expect((await executed()).at(-1)).toBe(LATEST);
  });

  it('PIPE-7: v_review_costs sums tokens as bigint, so one review past 2^31 does not break the view', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    await insertReview({ inputTokens: 2_000_000_000, cacheReadTokens: 2_000_000_000, cacheWriteTokens: 40 });
    await insertReview({ inputTokens: 2, cacheReadTokens: null, cacheWriteTokens: 1948 });
    const rows = await select('SELECT "reviewId", "totalInputTokens", pg_typeof("totalInputTokens")::text AS t FROM v_review_costs ORDER BY "reviewId"');
    expect(rows).toEqual([
      { reviewId: 1, totalInputTokens: '4000000040', t: 'bigint' },
      { reviewId: 2, totalInputTokens: '1950', t: 'bigint' },
    ]);
  });

  it('PIPE-5: v_model_rejections groups a reason with its numbers replaced by N', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    const id = await insertReview({ rejectedCount: 7 });
    await insertRejections(id, [
      ...[3, 4, 5, 6, 7, 8].map((n) => `line ${n} is past the end (2 lines)`),
      '"severity" must be one of [critical, warning, info]',
    ]);
    expect(await select('SELECT * FROM v_model_rejections')).toEqual([
      { reason: 'line N is past the end (N lines)', count: 6 },
      { reason: '"severity" must be one of [critical, warning, info]', count: 1 },
    ]);
  });

  it('PIPE-8: a truncated log counts from reviews.rejectedCount, spread over the reasons it did log', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    const flooded = await insertReview({ rejectedCount: 600 });
    await insertRejections(flooded, Array.from({ length: 493 }, () => '"severity" must be one of [critical, warning, info]'));
    await db.query(`INSERT INTO review_events ("reviewId", type, payload) VALUES (:id, 'events.truncated', '{"dropped": 107}')`, {
      replacements: { id: flooded },
    });
    // Fully logged: counted from its events. Not truncated, so rejectedCount is not used.
    const other = await insertReview({ rejectedCount: 1 });
    await insertRejections(other, ['"severity" must be one of [critical, warning, info]']);
    // Truncated before any rejection was logged: the reasons are unknown, the count is not.
    const blind = await insertReview({ rejectedCount: 5 });
    await db.query(`INSERT INTO review_events ("reviewId", type, payload) VALUES (:id, 'events.truncated', '{"dropped": 300}')`, {
      replacements: { id: blind },
    });
    expect(await select('SELECT * FROM v_model_rejections')).toEqual([
      { reason: '"severity" must be one of [critical, warning, info]', count: 601 },
      { reason: 'not logged (event log truncated)', count: 5 },
    ]);
  });

  it('goes down to 005, restoring 005\'s view definitions', async () => {
    await migrator.down({ to: M006 });
    expect((await executed()).at(-1)).toBe(M005);
    const [{ t }] = await select('SELECT pg_typeof("totalInputTokens")::text AS t FROM v_review_costs LIMIT 1');
    expect(t).toBe('integer');
    const reasons = (await select('SELECT reason FROM v_model_rejections')).map((r) => r.reason);
    expect(reasons).toEqual(['"severity" must be one of [critical, warning, info]']);
    expect(reasons).not.toContain('not logged (event log truncated)');
  });

  it('goes up again', async () => {
    await migrator.up();
    expect((await executed()).at(-1)).toBe(LATEST);
    expect((await select('SELECT * FROM v_model_rejections')).map((r) => r.count)).toEqual([601, 5]);
  });
});

describe('migration 007-analysis-error', () => {
  it('is applied by the test setup: reviews.analysisError varchar(500) null, default NULL', async () => {
    expect((await executed()).at(-1)).toBe(LATEST);
    expect((await columns('reviews')).analysisError).toEqual({ type: 'character varying(500)', nullable: true, default: 'NULL::character varying' });
  });

  it('goes down to 006, dropping the column and keeping the reviews', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    const id = await insertReview({});
    await db.query(`UPDATE reviews SET "analysisError" = 'it took longer than 5 s' WHERE id = :id`, { replacements: { id } });
    await migrator.down({ to: M007 });
    expect((await executed()).at(-1)).toBe(M006);
    expect((await columns('reviews')).analysisError).toBeUndefined();
    expect(await select('SELECT id FROM reviews')).toEqual([{ id }]);
  });

  it('goes up again, with the column null on old rows', async () => {
    await migrator.up();
    expect((await executed()).at(-1)).toBe(LATEST);
    expect(await select('SELECT "analysisError" FROM reviews')).toEqual([{ analysisError: null }]);
  });
});

describe('migration 008-review-summary', () => {
  it('is applied by the test setup: reviews.summary text null, default NULL', async () => {
    expect((await executed()).at(-1)).toBe(LATEST);
    expect((await columns('reviews')).summary).toEqual({ type: 'text', nullable: true, default: null });
  });

  it('goes down to 007, dropping the column and keeping the reviews', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    const id = await insertReview({});
    await db.query(`UPDATE reviews SET summary = 'Sums two numbers. No real risk.' WHERE id = :id`, { replacements: { id } });
    await migrator.down({ to: M008 });
    expect((await executed()).at(-1)).toBe(M007);
    expect((await columns('reviews')).summary).toBeUndefined();
    expect(await select('SELECT id FROM reviews')).toEqual([{ id }]);
  });

  it('goes up again, with the summary null on old rows', async () => {
    await migrator.up();
    expect((await executed()).at(-1)).toBe(LATEST);
    expect(await select('SELECT summary FROM reviews')).toEqual([{ summary: null }]);
  });
});

describe('migration 009-cost-source-price-table', () => {
  it('is applied by the test setup: costSource accepts price-table and still refuses a guess', async () => {
    expect((await executed()).at(-1)).toBe(M009);
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    await insertReview({});
    expect(await rejects(`UPDATE reviews SET "costSource" = 'price-table', "costUsd" = 0.0084`)).toBeNull();
    expect(await rejects(`UPDATE reviews SET "costSource" = 'guess'`)).toBe('reviews_cost_source_check');
  });

  it('goes down to 008, clearing list-priced costs and keeping the other ones', async () => {
    await db.query('TRUNCATE TABLE review_events, findings, reviews, snippets RESTART IDENTITY CASCADE');
    const listed = await insertReview({});
    const configured = await insertReview({});
    await db.query(`UPDATE reviews SET "costSource" = 'price-table', "costUsd" = 0.0084 WHERE id = :id`, { replacements: { id: listed } });
    await db.query(`UPDATE reviews SET "costSource" = 'price-config', "costUsd" = 0.01 WHERE id = :id`, { replacements: { id: configured } });
    await migrator.down({ to: M009 });
    expect((await executed()).at(-1)).toBe(M008);
    expect(await select('SELECT id, "costSource", "costUsd" FROM reviews ORDER BY id')).toEqual([
      { id: listed, costSource: null, costUsd: null },
      { id: configured, costSource: 'price-config', costUsd: 0.01 },
    ]);
    expect(await rejects(`UPDATE reviews SET "costSource" = 'price-table'`)).toBe('reviews_cost_source_check');
  });

  it('goes up again', async () => {
    await migrator.up();
    expect((await executed()).at(-1)).toBe(M009);
    expect(await rejects(`UPDATE reviews SET "costSource" = 'price-table'`)).toBeNull();
  });
});
