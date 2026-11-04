import { DataTypes } from 'sequelize';
import type { Migration } from '../db/migrator';

// The allowed values as they are today, written out: a migration must keep meaning what it meant
// when it ran, even if the constants in model/constants.ts change later.
const REVIEW_PHASES = ['queued', 'static', 'model', 'checking', 'done', 'failed'];
const CODE_CONTEXTS = ['frontend', 'backend', 'script', 'test', 'query', 'unknown'];
const COST_SOURCES = ['cli', 'price-config'];
const FINDING_SOURCES = ['rule', 'model'];
const FIX_CHECKS = ['not_checked', 'passed', 'failed'];

// Static analysis: review phases, timings, the detected context, token usage and cost on reviews;
// the source, rule id and checked fix on findings; a user-set context on snippets.
// One transaction, so a failure part way leaves the tables as they were (Postgres DDL is transactional).
export const up: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const add = (table: string, column: string, spec: Parameters<typeof queryInterface.addColumn>[2]) =>
      queryInterface.addColumn(table, column, spec, { transaction });
    const check = (table: string, name: string, column: string, values: readonly string[]) =>
      queryInterface.addConstraint(table, {
        type: 'check',
        name,
        fields: [column],
        where: { [column]: [...values] },
        transaction,
      });

    // reviews
    await add('reviews', 'phase', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'queued' });
    await add('reviews', 'phaseTimings', { type: DataTypes.JSONB, allowNull: false, defaultValue: {} });
    await add('reviews', 'context', { type: DataTypes.STRING(20), allowNull: true });
    await add('reviews', 'contextSignals', { type: DataTypes.JSONB, allowNull: false, defaultValue: [] });
    await add('reviews', 'staticSupported', { type: DataTypes.BOOLEAN, allowNull: true });
    await add('reviews', 'duplicateCount', { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
    await add('reviews', 'model', { type: DataTypes.STRING(80), allowNull: true });
    for (const column of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
      await add('reviews', column, { type: DataTypes.INTEGER, allowNull: true });
    }
    await add('reviews', 'costUsd', { type: DataTypes.DOUBLE, allowNull: true });
    await add('reviews', 'costSource', { type: DataTypes.STRING(20), allowNull: true });
    await check('reviews', 'reviews_phase_check', 'phase', REVIEW_PHASES);
    await check('reviews', 'reviews_context_check', 'context', CODE_CONTEXTS);
    await check('reviews', 'reviews_cost_source_check', 'costSource', COST_SOURCES);
    // Reviews that finished before this migration: their phase is where they ended, not 'queued'.
    await queryInterface.sequelize.query(
      `UPDATE reviews SET phase = status WHERE status IN ('done', 'failed')`,
      { transaction },
    );

    // findings
    await add('findings', 'source', { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'model' });
    await add('findings', 'ruleId', { type: DataTypes.STRING(80), allowNull: true });
    await add('findings', 'fix', { type: DataTypes.JSONB, allowNull: true });
    await add('findings', 'fixCheck', { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'not_checked' });
    await add('findings', 'fixCheckDetail', { type: DataTypes.JSONB, allowNull: true });
    await check('findings', 'findings_source_check', 'source', FINDING_SOURCES);
    await check('findings', 'findings_fix_check_check', 'fixCheck', FIX_CHECKS);

    // snippets: null means "detect it"
    await add('snippets', 'context', { type: DataTypes.STRING(20), allowNull: true });
    await check('snippets', 'snippets_context_check', 'context', CODE_CONTEXTS);
  });
};

export const down: Migration = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.transaction(async (transaction) => {
    const drop = async (table: string, constraints: string[], columns: string[]) => {
      for (const name of constraints) await queryInterface.removeConstraint(table, name, { transaction });
      for (const column of columns) await queryInterface.removeColumn(table, column, { transaction });
    };
    await drop('snippets', ['snippets_context_check'], ['context']);
    await drop(
      'findings',
      ['findings_source_check', 'findings_fix_check_check'],
      ['source', 'ruleId', 'fix', 'fixCheck', 'fixCheckDetail'],
    );
    await drop(
      'reviews',
      ['reviews_phase_check', 'reviews_context_check', 'reviews_cost_source_check'],
      [
        'phase',
        'phaseTimings',
        'context',
        'contextSignals',
        'staticSupported',
        'duplicateCount',
        'model',
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'costUsd',
        'costSource',
      ],
    );
  });
};
